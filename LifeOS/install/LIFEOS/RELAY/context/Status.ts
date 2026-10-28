#!/usr/bin/env bun
/**
 * Status.ts — Tex F24 status by text (Tex ISA F24, ISC-357..363).
 *
 * "What are you doing for me", "status" or "what's open" over iMessage runs this command, and the text session answers
 * from what it prints: one text-shaped page of everything in flight and everything finished in the last 24 hours.
 *
 * It only reads, and each source is read through the code that already owns it; there is no store of its own:
 *
 *   Text task         the STATVS `relay` stream (bridge/record.ts): a principal `text_in` with no `outcome` yet
 *   Workflow runs     the run ledger's claim markers (WORKFLOWS/engine/ledger.ts readClaims)
 *   Watches           the watch kit's list (WATCHES/lib/bytext.ts listWatches), last run from the run ledger
 *   Follow-ups        the followup-* workflow definitions and their checkOn, as HeadsUp's followup gate reads them
 *   Held heads-ups    readHeld() in HeadsUp.ts
 *   Open loops        the one-pager's "Open loops" section (OnePager.ts readOnePager), the DA's unanswered questions
 *   Finished (24h)    principal text turns that ended (the relay `outcome` rows) and hand-started workflow runs (the
 *                     ledger), each with one pointer that can be opened: a link, commit or file path found in the reply
 *                     (labeled "link in reply", "commit in reply" or "file in reply", since the reply only mentioned
 *                     it; a link whose path holds a share token is withheld), or the run's artifacts folder;
 *                     otherwise the words "no proof recorded"
 *   Scheduled (24h)   the ledger's scheduled runs as one count, with the jobs that failed listed
 *
 * A source that throws is named on an "Unreadable:" line and the rest still print (ISC-360). The page stays under
 * STATUS_MAX_CHARS; a trimmed section says "+N more" (ISC-361). Every line is scrubbed: secret-shaped values and
 * one-time codes are masked, a credential-shaped line is withheld, and email addresses and phone numbers are replaced,
 * so no sender or own-channel value can appear (ISC-362). Times are 24-hour HH:mm in principalTimezone().
 *
 *   bun LIFEOS/RELAY/context/Status.ts            # the page
 *   bun LIFEOS/RELAY/context/Status.ts --json     # the same sections as JSON
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { credentialRefusal, scan, urlRefusal } from "../../STATVS/index.ts";
import { recordRows, type RecordRead, type RecordRow } from "../../STATVS/lib/cloudRead.ts";
import { principalTimezone } from "../../TOOLS/lib/Timezone.ts";
import { readClaims, readLedger, type Claim, type LedgerRecord } from "../../WORKFLOWS/engine/ledger.ts";
import { artifactsRoot, ledgerPath } from "../../WORKFLOWS/engine/paths.ts";
import { maskLine, readHeld, workflowsDir, type HeldCandidate } from "./HeadsUp.ts";
import { onePagerPath, readOnePager, scrubOnePager } from "./OnePager.ts";

export const STATUS_MAX_CHARS = 1500;
export const FINISHED_WINDOW_MS = 24 * 3_600_000;
/** A principal text with no outcome is in flight for this long; past it, record.ts closeLostTurns has closed it. */
export const TEXT_RUNNING_WINDOW_MS = 2 * 86_400_000;
const LABEL_CHARS = 48;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Item {
  label: string;
  state: string;
  /** The item's time, already formatted (24-hour HH:mm, with MM-DD when not today). */
  when: string;
  /** Finished items only: the pointer, or null for "no proof recorded". */
  proof?: string | null;
}
export type SectionKey = "text" | "runs" | "watches" | "followups" | "held" | "loops" | "finished" | "scheduled";
export interface Section { key: SectionKey; title: string; items: Item[]; note?: string }
/** One source reader. It returns the sections it fills; when it throws, every section it fills is named unreadable. */
export interface Source { name: string; fills: SectionKey[]; read: (ctx: Ctx) => Partial<Record<SectionKey, { items: Item[]; note?: string }>> }
export interface Ctx { now: Date; tz: string; when: (iso: string | number | Date) => string }
export interface StatusResult { text: string; sections: Section[]; unreadable: string[] }

export const SECTION_ORDER: readonly { key: SectionKey; title: string }[] = [
  { key: "text", title: "Text task" },
  { key: "runs", title: "Workflow runs" },
  { key: "watches", title: "Watches" },
  { key: "followups", title: "Follow-ups" },
  { key: "held", title: "Held heads-ups" },
  { key: "loops", title: "Open loops" },
  { key: "finished", title: "Finished, 24h" },
  { key: "scheduled", title: "Scheduled jobs, 24h" },
];

// ── Scrubbing ─────────────────────────────────────────────────────────────────

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?<![\w-])\+?(?:1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\w-])/g;
/** An international number: a plus, a country code, then digit groups joined by spaces, dots, dashes or brackets. */
const INTL_PHONE = /(?<![\w-])\+\d[\d\s().-]{7,}\d/g;
const maskIntl = (line: string): string => line.replace(INTL_PHONE, (m) => (m.replace(/\D/g, "").length >= 8 ? "[number]" : m));
/** Secret-shaped values, one-time codes, email addresses and phone numbers out; a credential-shaped line withheld. */
export function scrub(line: string): string {
  return maskLine(maskIntl(scrubOnePager(line)).replace(EMAIL, "[email]").replace(PHONE, "[number]"));
}
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
/** Scrubbed before it is cut, so a cut can never leave half a phone number or code that the scrub no longer sees. */
const clip = (s: string, n = LABEL_CHARS): string => { const t = oneLine(scrub(oneLine(s))); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const home = homedir();
const tildePath = (p: string): string => (p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

// ── Time ──────────────────────────────────────────────────────────────────────

const localDay = (d: Date, tz: string): string => d.toLocaleDateString("en-CA", { timeZone: tz });
const clock = (d: Date, tz: string): string => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
/** 24-hour HH:mm in the principal's zone, with MM-DD in front when the day is not today. */
export function formatWhen(at: string | number | Date, now: Date, tz: string): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return "time unknown";
  const day = localDay(d, tz);
  return day === localDay(now, tz) ? clock(d, tz) : `${day.slice(5)} ${clock(d, tz)}`;
}

// ── Proof ─────────────────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/;
const COMMIT_RE = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/;
const PATH_RE = /(?:~\/|\/Users\/[^\s/]+\/|\bLIFEOS\/|\bskills\/)[^\s"'`)\]<>,]+/;
/** The pointer in a reply's words and what kind it is: a link first, then a commit, then a file path; null when none. */
function proofParts(text: string): { kind: "link" | "commit" | "file"; value: string } | null {
  const url = URL_RE.exec(text)?.[0]?.replace(/[.,;:!?]+$/, "");
  if (url) return { kind: "link", value: url };
  const commit = COMMIT_RE.exec(text)?.[0];
  if (commit) return { kind: "commit", value: commit };
  const path = PATH_RE.exec(text)?.[0]?.replace(/[.,;:!?]+$/, "");
  return path ? { kind: "file", value: tildePath(path) } : null;
}
/** One pointer the principal can open from a reply's words: a link first, then a commit, then a file path; null when none. */
export function proofIn(text: string): string | null {
  const p = proofParts(text);
  return p ? (p.kind === "commit" ? `commit ${p.value}` : p.value) : null;
}
/**
 * The same pointer, labeled as what it is: something the reply mentioned ("link in reply: …", "commit in reply: …",
 * "file in reply: …"), never presented as the work's own artifact. Only a run's artifacts folder is unlabeled.
 */
export function replyProof(text: string): string | null {
  const p = proofParts(text);
  return p ? `${p.kind} in reply: ${p.value}` : null;
}

// ── Sources ───────────────────────────────────────────────────────────────────

export interface LiveOptions {
  /** STATVS directory; default the live record (or STATVS_DIR). */
  statvsDir?: string;
  /** The relay rows, already read: the CLI reads them from the cloud first (relayRows), since a source reads synchronously. */
  relay?: RecordRead;
  /** Run ledger file; default WORKFLOWS ledgerPath() (or LIFEOS_WORKFLOWS_LEDGER). */
  ledger?: string;
  /** The watch list; default the kit's listWatches(). */
  watches?: () => WatchRowLike[];
}
export interface WatchRowLike { name: string; source: string; origin: string; description: string; cadence: string; enabled: boolean; request?: string; requested_at?: string; problem?: string }

const dataOf = (r: RecordRow): Record<string, unknown> => (r.data && typeof r.data === "object" ? r.data as Record<string, unknown> : {});

/** Text turns from the relay stream: running ones, and principal turns that ended in the window. */
export function textTurnsSource(opts: LiveOptions = {}): Source {
  return {
    name: "text turns (STATVS relay)",
    fills: ["text", "finished"],
    read: (ctx) => {
      const from = new Date(ctx.now.getTime() - TEXT_RUNNING_WINDOW_MS).toISOString().slice(0, 10);
      const res = opts.relay ?? { rows: scan({ streams: ["relay"], classes: ["personal"], fromDate: from, ...(opts.statvsDir ? { dir: opts.statvsDir } : {}) }).rows, problems: [], from: "local" as const };
      const rows = res.rows.filter((r) => r.stream === "relay");
      const ins = new Map<string, RecordRow>(), outcomes = new Map<string, RecordRow>(), outs = new Map<string, string[]>();
      for (const r of rows) {
        const d = dataOf(r);
        const turn = typeof d.turn === "string" ? d.turn : null;
        if (!turn) continue;
        if (d.event === "text_in" && d.role === "principal") ins.set(turn, r);
        else if (d.event === "outcome") outcomes.set(turn, r);
        else if ((d.event === "text_out" || d.event === "voice_out") && typeof d.text === "string") outs.set(turn, [...(outs.get(turn) ?? []), d.text]);
      }
      const label = (r: RecordRow | undefined): string => {
        const d = r ? dataOf(r) : {};
        const t = typeof d.text === "string" && d.text.trim() ? d.text : typeof d.type === "string" ? `(${d.type})` : "(a text)";
        return `"${clip(t, 40)}"`;
      };
      const running: Item[] = [];
      for (const [turn, r] of ins) {
        if (outcomes.has(turn)) continue;
        if (ctx.now.getTime() - Date.parse(r.ts) > TEXT_RUNNING_WINDOW_MS) continue;
        running.push({ label: label(r), state: "running since", when: ctx.when(r.ts) });
      }
      const finished: (Item & { at: number })[] = [];
      for (const [turn, o] of outcomes) {
        const d = dataOf(o);
        if (d.role !== "principal" || d.outcome === "duplicate") continue;
        const at = Date.parse(o.ts);
        if (!(ctx.now.getTime() - at <= FINISHED_WINDOW_MS)) continue;
        const proof = (outs.get(turn) ?? []).map(replyProof).find((p) => p) ?? null;
        finished.push({ label: `text ${label(ins.get(turn))}`, state: String(d.outcome ?? "ended"), when: ctx.when(o.ts), proof, at });
      }
      const note = res.problems.some((p) => p.startsWith("cloud record unreachable")) ? "this Mac's texts only, the record is unreachable" : undefined;
      return { text: { items: running.reverse(), ...(note ? { note } : {}) }, finished: { items: sortNewest(finished) } };
    },
  };
}

/** The relay rows the text turns source folds, from the cloud record plus this machine's unshipped rows (STATVS migration ISA ISC-179). */
export const relayRows = (now = new Date()): Promise<RecordRead> =>
  recordRows({ streams: ["relay"], classes: ["personal"], fromDate: new Date(now.getTime() - TEXT_RUNNING_WINDOW_MS).toISOString().slice(0, 10) });

const sortNewest = <T extends Item & { at: number }>(xs: T[]): Item[] => xs.sort((a, b) => b.at - a.at).map(({ at: _at, ...i }) => i);

/** Workflow runs: claims still open, hand-started runs that finished, and the scheduled runs as a count. */
export function workflowRunsSource(opts: LiveOptions = {}, ledgerCache = ledgerReader(opts)): Source {
  return {
    name: "workflow runs (run ledger)",
    fills: ["runs", "finished", "scheduled"],
    read: (ctx) => {
      const ledger = opts.ledger ?? ledgerPath();
      const now = ctx.now.getTime();
      const running: (Item & { at: number })[] = readClaims(ledger).map((c: Claim) => {
        const started = c.started_at ?? c.at;
        const dead = c.deadline_at !== undefined && Date.parse(c.deadline_at) < now;
        return { label: c.workflow, state: dead ? "stalled, started" : "running since", when: ctx.when(started), at: Date.parse(started) || 0 };
      });
      const recent = ledgerCache().filter((r) => now - Date.parse(r.finished_at) <= FINISHED_WINDOW_MS && Date.parse(r.finished_at) <= now);
      const proofOf = (r: LedgerRecord): string | null => {
        const dir = join(artifactsRoot(ledger), r.run_id);
        return existsSync(dir) ? tildePath(dir) : null;
      };
      const group = (rs: LedgerRecord[]): Map<string, LedgerRecord[]> => {
        const m = new Map<string, LedgerRecord[]>();
        for (const r of rs) m.set(r.workflow, [...(m.get(r.workflow) ?? []), r]);
        for (const v of m.values()) v.sort((a, b) => Date.parse(b.finished_at) - Date.parse(a.finished_at));
        return m;
      };
      const manual = [...group(recent.filter((r) => r.trigger !== "schedule"))].map(([wf, rs]) => {
        const last = rs[0]!;
        return { label: `run ${wf}${rs.length > 1 ? ` ×${rs.length}` : ""}`, state: last.status, when: ctx.when(last.finished_at), proof: proofOf(last), at: Date.parse(last.finished_at) };
      });
      const scheduled = recent.filter((r) => r.trigger === "schedule");
      const failedRuns = scheduled.filter((r) => r.status !== "succeeded");
      const failed = [...group(failedRuns)].map(([wf, rs]) => {
        const last = rs[0]!;
        return { label: wf, state: `${last.status} ×${rs.length}, last`, when: ctx.when(last.finished_at), proof: proofOf(last), at: Date.parse(last.finished_at) };
      });
      const failedJobs = new Set(failedRuns.map((r) => r.workflow)).size;
      return {
        runs: { items: sortNewest(running) },
        finished: { items: sortNewest(manual) },
        scheduled: { items: sortNewest(failed), note: `${scheduled.length} runs, ${failedRuns.length} not ok in ${failedJobs} job${failedJobs === 1 ? "" : "s"}` },
      };
    },
  };
}

/** Reads the ledger once per status call; the watches and runs sources share it. */
function ledgerReader(opts: LiveOptions): () => LedgerRecord[] {
  let cached: LedgerRecord[] | null = null;
  return () => (cached ??= readLedger(opts.ledger ?? ledgerPath()).records);
}

/** Watches from the kit's list: the ones asked for by text first, then by last run. */
export function watchesSource(opts: LiveOptions = {}, ledgerCache = ledgerReader(opts)): Source {
  return {
    name: "watches (watch kit)",
    fills: ["watches"],
    read: (ctx) => {
      const rows = (opts.watches ? opts.watches() : listWatchesSync()) as WatchRowLike[];
      if (!Array.isArray(rows)) throw new Error("the watch list is not a list");
      let lastRun = new Map<string, string>();
      try {
        for (const r of ledgerCache()) {
          const prev = lastRun.get(r.workflow);
          if (!prev || Date.parse(r.finished_at) > Date.parse(prev)) lastRun.set(r.workflow, r.finished_at);
        }
      } catch { lastRun = new Map(); }
      const items = rows.map((w) => {
        const last = lastRun.get(w.source) ?? lastRun.get(w.name);
        const state = w.problem ? "cannot run" : w.enabled ? "on" : "off";
        const label = w.origin === "text" && w.request ? `${w.name} "${clip(w.request, 32)}"` : w.name;
        const [phrase, when] = last ? ["last ran", ctx.when(last)] : w.origin === "text" && w.requested_at ? ["asked", ctx.when(w.requested_at)] : ["not run yet", ""];
        const rank = (w.origin === "text" ? 2e13 : 0) + (w.problem ? 1e13 : 0) + (last ? Date.parse(last) : 0);
        return { label, state: `${state}, ${phrase}`, when, at: rank };
      });
      const on = rows.filter((w) => w.enabled && !w.problem).length;
      return { watches: { items: sortNewest(items), note: `${on} on` } };
    },
  };
}

let watchModule: { listWatches: () => WatchRowLike[] } | null = null;
function listWatchesSync(): WatchRowLike[] {
  if (!watchModule) throw new Error("watch kit not loaded");
  return watchModule.listWatches();
}
/** Loads the watch kit's list function (it is ESM-only from here, so the CLI loads it before reading). */
export async function loadWatchKit(): Promise<void> {
  watchModule = (await import("../../WATCHES/lib/bytext.ts")) as unknown as { listWatches: () => WatchRowLike[] };
}

/** Follow-ups: every followup-* workflow and its checkOn date. */
export function followupsSource(dir: () => string = workflowsDir): Source {
  return {
    name: "follow-ups (followup-* workflows)",
    fills: ["followups"],
    read: (ctx) => {
      const d = dir();
      if (!existsSync(d)) return { followups: { items: [] } };
      const today = localDay(ctx.now, ctx.tz);
      const items = readdirSync(d).filter((f) => /^followup-.*\.workflow\.ya?ml$/.test(f)).sort().map((file) => {
        const body = readFileSync(join(d, file), "utf8");
        const name = file.replace(/\.workflow\.ya?ml$/, "");
        let checkOn = "", title = "", enabled = true;
        try {
          const doc = parseYaml(body) as { title?: unknown; description?: unknown; enabled?: unknown; steps?: Record<string, { with?: { checkOn?: unknown } }> };
          if (typeof doc?.title === "string") title = doc.title;
          else if (typeof doc?.description === "string") title = doc.description;
          if (doc?.enabled === false) enabled = false;
          for (const s of Object.values(doc?.steps ?? {})) if (typeof s?.with?.checkOn === "string") checkOn = s.with.checkOn;
        } catch { /* fall back to the line reader HeadsUp uses */ }
        checkOn ||= body.match(/^\s*checkOn:\s*["']?(\d{4}-\d{2}-\d{2})["']?\s*$/m)?.[1] ?? "";
        const state = !enabled ? "paused" : !checkOn ? "waiting" : checkOn < today ? "overdue" : checkOn === today ? "due today" : "waiting";
        return { label: clip(title || name), state: checkOn ? `${state}, check on` : `${state}, no check date`, when: checkOn ? checkOn.slice(5) : "", at: checkOn ? -Date.parse(checkOn) : -Infinity };
      });
      return { followups: { items: sortNewest(items) } };
    },
  };
}

/** Held heads-ups: readHeld() in HeadsUp.ts. */
export function heldSource(read: () => HeldCandidate[] = readHeld): Source {
  return {
    name: "held heads-ups",
    fills: ["held"],
    read: (ctx) => {
      const held = read();
      if (!Array.isArray(held)) throw new Error("held heads-ups are not a list");
      return { held: { items: held.map((h) => ({ label: `"${clip(h.text, 44)}"`, state: `held (${h.heldFor === "cap" ? "daily cap" : "not now"}) until`, when: ctx.when(h.wakeAt) })) } };
    },
  };
}

const LOOP_RE = /^- .+? asked (\d{4}-\d{2}-\d{2}), no answer yet: "(.*)" \[src: thread:[^\]]+\]$/;
/** Open loops: the DA's unanswered questions in the one-pager's "Open loops" section (follow-ups have their own section). */
export function loopsSource(path: () => string = onePagerPath): Source {
  return {
    name: "open loops (one-pager)",
    fills: ["loops"],
    read: (ctx) => {
      const p = path();
      const page = readOnePager(p);
      if (page === null) throw new Error("no one-pager built");
      const lines = page.split("\n");
      const start = lines.findIndex((l) => l.trim() === "## Open loops");
      const items: Item[] = [];
      if (start >= 0) {
        for (const raw of lines.slice(start + 1)) {
          const l = raw.trim();
          if (l.startsWith("## ")) break;
          const m = LOOP_RE.exec(l);
          if (m) items.push({ label: `"${clip(m[2]!, 44)}"`, state: "no answer since", when: m[1]!.slice(5) });
        }
      }
      return { loops: { items, note: `as of ${ctx.when(statSync(p).mtime)}` } };
    },
  };
}

/** The live sources, each through the code that owns its store. */
export function liveSources(opts: LiveOptions = {}): Source[] {
  const ledger = ledgerReader(opts);
  return [textTurnsSource(opts), workflowRunsSource(opts, ledger), watchesSource(opts, ledger), followupsSource(), heldSource(), loopsSource()];
}

// ── Assembly ──────────────────────────────────────────────────────────────────

/**
 * A pointer is judged the way STATVS judges a stored path (credentialRefusal with slugs): a uuid or slug segment in a
 * path is fine, a token is not. It stays outside maskLine, whose code mask would corrupt a run id or commit.
 */
export function safeProof(p: string | null | undefined): string {
  if (!p) return "no proof recorded";
  if (credentialRefusal(p, { slugs: true }) || (p.match(new RegExp(URL_RE.source, "g")) ?? []).some(urlHoldsToken)) return "[pointer withheld: credential-shaped]";
  return maskIntl(scrubOnePager(p)).replace(EMAIL, "[email]").replace(PHONE, "[number]");
}

/**
 * True when a link carries a share token: STATVS's own url check (a 32+ character path segment that is not
 * slug-shaped), or a shorter high-entropy run in the path or a query value. A readable slug (`42-fix-login-page`) or a
 * run id (uuid groups of 12 or fewer) passes; a 16+ character run mixing letters and digits, or a 20+ character run
 * that flips from lower to upper case three times, is a token.
 */
function urlHoldsToken(url: string): boolean {
  if (urlRefusal(url)) return true;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  const runs = [...u.pathname.split("/"), ...u.searchParams.values()].flatMap((seg) => seg.split(/[-_.~+=:,]+/));
  return runs.some((r) => (r.length >= 16 && /[A-Za-z]/.test(r) && /\d/.test(r)) || (r.length >= 20 && (r.match(/[a-z][A-Z]/g) ?? []).length >= 3));
}

function renderItem(i: Item, finished: boolean): string {
  const line = scrub(`- ${i.label} · ${`${i.state} ${i.when}`.trim()}`);
  return finished && !line.startsWith("[line withheld") ? `${line} · ${safeProof(i.proof)}` : line;
}

/** Renders the sections, trimming the longest shown section one item at a time until the page fits. */
export function render(sections: Section[], unreadable: string[], max = STATUS_MAX_CHARS): string {
  const shown = new Map(sections.map((s) => [s.key, s.items.length]));
  const page = (): string => {
    const out: string[] = [];
    for (const s of sections) {
      const n = shown.get(s.key)!;
      const head = scrub(`${s.title} (${s.items.length})${s.note ? ` · ${s.note}` : ""}${s.items.length ? ":" : ": none"}`);
      out.push(head);
      const finished = s.key === "finished" || s.key === "scheduled";
      for (const i of s.items.slice(0, n)) out.push(renderItem(i, finished));
      if (n < s.items.length) out.push(`+${s.items.length - n} more`);
    }
    if (unreadable.length) out.push(scrub(`Unreadable: ${unreadable.join("; ")}`));
    return out.join("\n");
  };
  let text = page();
  while (text.length > max) {
    let pick: Section | null = null;
    for (const s of sections) if (shown.get(s.key)! > 0 && (!pick || shown.get(s.key)! >= shown.get(pick.key)!)) pick = s;
    if (!pick) break;
    shown.set(pick.key, shown.get(pick.key)! - 1);
    text = page();
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Reads every source (a failing one is named, never dropped) and renders the page. Reads only. */
export function buildStatus(sources: Source[], opts: { now?: Date; tz?: string; max?: number } = {}): StatusResult {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? principalTimezone();
  const ctx: Ctx = { now, tz, when: (at) => formatWhen(at, now, tz) };
  const filled = new Map<SectionKey, { items: Item[]; notes: string[] }>();
  const unreadable: string[] = [];
  const failed = new Set<SectionKey>();
  for (const src of sources) {
    try {
      const got = src.read(ctx);
      for (const [k, v] of Object.entries(got) as [SectionKey, { items: Item[]; note?: string }][]) {
        const cur = filled.get(k) ?? { items: [], notes: [] };
        cur.items.push(...v.items);
        if (v.note) cur.notes.push(v.note);
        filled.set(k, cur);
      }
    } catch (e) {
      const why = clip(e instanceof Error ? e.message : String(e), 60);
      unreadable.push(`${src.name} (${why})`);
      for (const k of src.fills) failed.add(k);
    }
  }
  const sections: Section[] = SECTION_ORDER.map(({ key, title }) => {
    const f = filled.get(key);
    const notes = [...(f?.notes ?? []), ...(failed.has(key) ? ["partly unreadable"] : [])];
    return { key, title, items: f?.items ?? [], ...(notes.length ? { note: notes.join(", ") } : {}) };
  });
  return { text: render(sections, unreadable, opts.max), sections, unreadable };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  let kitError: string | null = null;
  try { await loadWatchKit(); } catch (e) { kitError = e instanceof Error ? e.message : String(e); }
  const sources = liveSources({ relay: await relayRows() });
  if (kitError) {
    const i = sources.findIndex((s) => s.fills.includes("watches"));
    sources[i] = { ...sources[i]!, read: () => { throw new Error(`watch kit did not load: ${kitError}`); } };
  }
  const r = buildStatus(sources);
  console.log(process.argv.includes("--json") ? JSON.stringify({ sections: r.sections.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i, label: scrub(i.label), proof: i.proof === undefined ? undefined : safeProof(i.proof) })) })), unreadable: r.unreadable.map(scrub) }) : r.text);
}
