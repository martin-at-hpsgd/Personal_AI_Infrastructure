/**
 * Vigil's writes to STATVS (migration design §2.4, §3 Lane D; Vigil ISC-439, ISC-448, ISC-449; STATVS ISC-94).
 *
 * Stream `vigil`, writer `wf:vigil-tick`: one `decision` row per answered row. `ref` is the answered
 * row id; the row never copies its title or summary and carries no severity, so nothing re-reads or
 * forwards it. Its data is the contract `vigil-ledger` folds: { answers, event_id?, outcome, reason,
 * brief?, delivery?, key?, severity?, source?, goal?, gap?, editor?, job?, shadow?, handoff?, workrepo?,
 * dm?, advocate?, budget_left, quiet, state_inputs }. `advocate` is the advocate's verdict beside the floor's
 * outcome (Advocate.advocateField): mode, verdict, confidence, act, goal or gap id, and a filtered reason.
 *
 * Stream `vigil-log`, writer `wf:vigil-tick-log` (a different writer, so the two streams never share a
 * segment, S14): the tick row, feedback labels, editor verdicts and dual-write shadow comparisons.
 * Label and editor rows carry ids, the verdict and a SHA-256 of the words, never the words (P10); the
 * words go to the local `editor-words.jsonl` (0600) in Vigil's state dir.
 *
 * A decision row the record refuses is replaced by a minimal row { answers, event_id?, outcome, reason:
 * "reason refused by the record: …", brief?, delivery? } so the row is still answered and a sent text still
 * counts toward the ceiling. A decision row the record spools leaves a local claim for its answered id,
 * and a second decision for that id is not written while the claim stands.
 *
 * Error and reason text bound for any row passes the record's credential and personal-content checks
 * first; a hit becomes "error text withheld (<rule>)", so one string never refuses the row that carries it (S15).
 *
 * Stage p1: the live tick writes only the tick row and the shadow comparison here, and only under
 * dual-write. The legacy mirrors (appendNotification, appendDigest) are p2.
 * @version 1.0.0
 */
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { sep } from "node:path";
import { append, credentialRefusal, personalRefusal, type AppendResult, type StatvsInput, type StatvsRow } from "../STATVS/index";
import { invariant, InvariantViolation } from "../TOOLS/Invariant";
import { OUTCOMES, outcomeOf, outcomesFor, type Delivery, type Outcome, type RowOutcome } from "./Outcome";
import type { VigilPolicy } from "./Policy";
import { commitRead, readNew } from "./Reader";
import type { Decision } from "./Route";
import type { AdvocateVerdict } from "./Advocate";
import type { StateInput, VigilEvent } from "./Schema";
import { statePath } from "./State";

export const DECISION_STREAM = "vigil";
export const DECISION_WRITER = "wf:vigil-tick";
export const LOG_STREAM = "vigil-log";
export const LOG_WRITER = "wf:vigil-tick-log";
export const EDITOR_WORDS_FILE = "editor-words.jsonl";
export const DECISION_CLAIMS_DIR = "decision-claims";
/** A claim outlives any spool a healthy record drains; past this it is stale and pruned. */
export const DECISION_CLAIM_KEEP_MS = 8 * 86_400_000;
export const REFUSED_PREFIX = "reason refused by the record: ";

const ID = /^[A-Za-z0-9][A-Za-z0-9:._@+-]{0,127}$/;
const VERDICT = /^[a-z][a-z0-9_-]{0,31}$/;
const TEXT_MAX = 300;

/** Text that may enter a row: clipped, and withheld whole when the record's credential or personal-content check would refuse it. */
export function safeText(text: string, max = TEXT_MAX): string {
  const clipped = text.trim().slice(0, max);
  const rule = credentialRefusal(clipped, { slugs: true }) ?? personalRefusal(clipped);
  return rule ? `error text withheld (${rule})` : clipped;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const okId = (id: unknown): id is string => typeof id === "string" && ID.test(id) && credentialRefusal(id, { slugs: true }) === null;

export type DecisionInput = RowOutcome & {
  key?: string; severity?: string; source?: string; goal?: string; gap?: string;
  editor?: { verdict: string; words?: string }; job?: true | { cls: string }; shadow?: true;
  handoff?: string; workrepo?: string; dm?: "sent" | "failed"; advocate?: AdvocateVerdict;
  budget_left: number | null; quiet: boolean; state_inputs?: Record<string, StateInput>;
};

export type WriteDecisionResult =
  | { ok: true; row: StatvsRow; minimal?: true }
  | { ok: true; spooled: true; claimed: true }
  | { ok: false; claimed: true }
  | { ok: false; refused: string };

/** A claim file's name: 32 hex of the answered id's SHA-256, then .json. Nothing else in the claims dir is a claim. */
export const CLAIM_FILE = /^[0-9a-f]{32}\.json$/;
/** Where an answered id's spool claim lives; ids are filename-safe by the ID rule. */
const claimPath = (answers: string) => statePath(DECISION_CLAIMS_DIR, `${sha256(answers).slice(0, 32)}.json`);

/** True while a spooled decision row for this answered row has not been seen in the record. */
export function hasDecisionClaim(answers: string): boolean { return existsSync(claimPath(answers)); }

/**
 * Drop claims for rows the ledger now shows answered, and any claim older than the keep window.
 * Only claim-named regular files inside the claims dir are ever touched; any other entry is left alone.
 * Before each delete it asserts (realpath, so a symlinked component cannot move the boundary) that the file
 * sits directly in the claims dir, and that the claim is expired, or names an answered id the ledger
 * shows recorded and is that id's own claim file: a wrong delete would let a spooled row be answered twice.
 */
export function pruneDecisionClaims(opts: { now?: number; answered?: { has(id: string): boolean } } = {}): number {
  const dir = statePath(DECISION_CLAIMS_DIR), now = opts.now ?? Date.now();
  let files: string[], realDir: string; try { files = readdirSync(dir); realDir = realpathSync(dir); } catch { return 0; }
  let removed = 0;
  for (const f of files) {
    if (!CLAIM_FILE.test(f)) continue;
    const path = statePath(DECISION_CLAIMS_DIR, f);
    let claim: { answers?: unknown }, mtime: number;
    try {
      if (!lstatSync(path).isFile()) continue;
      claim = JSON.parse(readFileSync(path, "utf8")) as { answers?: unknown }; mtime = statSync(path).mtimeMs;
    } catch { continue; /* an unreadable claim is left for the age rule */ }
    const expired = now - mtime > DECISION_CLAIM_KEEP_MS;
    const answered = typeof claim.answers === "string" && opts.answered?.has(claim.answers) === true;
    if (!expired && !answered) continue;
    const real = realpathSync(path);
    invariant(real.startsWith(realDir + sep) && !real.slice(realDir.length + 1).includes(sep) && CLAIM_FILE.test(real.slice(realDir.length + 1)), `a pruned decision claim is a claim file directly inside the claims dir: ${f}`);
    invariant(expired || (okId(claim.answers) && claimPath(claim.answers) === path), `a decision claim is pruned only when expired or when its own answered row is recorded: ${f}`);
    rmSync(path, { force: true }); removed++;
  }
  return removed;
}

function writeClaim(answers: string, eventId: string): void {
  invariant(okId(answers), "a decision claim names a real answered row id");
  mkdirSync(statePath(DECISION_CLAIMS_DIR), { recursive: true });
  writeFileSync(claimPath(answers), JSON.stringify({ answers, event_id: eventId, ts: new Date().toISOString() }) + "\n", { mode: 0o600 });
}

/** The data of a decision row, words left out (P10): the editor verdict and a hash, never `why` or a reworded text. */
export function decisionData(d: DecisionInput): Record<string, unknown> {
  const data: Record<string, unknown> = { answers: d.answers, outcome: d.outcome, reason: safeText(d.reason), budget_left: d.budget_left, quiet: d.quiet };
  if (okId(d.event_id)) data.event_id = d.event_id;
  if (d.brief) data.brief = true;
  if (d.delivery) data.delivery = { state: d.delivery.state, ...(d.delivery.held_reason ? { held_reason: safeText(d.delivery.held_reason) } : {}), ...(d.delivery.deferred_to ? { deferred_to: d.delivery.deferred_to } : {}) };
  for (const k of ["key", "severity", "source", "goal", "gap", "handoff", "workrepo", "dm"] as const) if (typeof d[k] === "string" && d[k]) data[k] = safeText(d[k]!, 200);
  if (d.editor) data.editor = { verdict: d.editor.verdict, ...(d.editor.words ? { words_sha256: sha256(d.editor.words) } : {}) };
  if (d.job) data.job = d.job === true ? true : { cls: safeText(d.job.cls, 40) };
  if (d.shadow) data.shadow = true;
  if (d.state_inputs) data.state_inputs = d.state_inputs;
  if (d.advocate) data.advocate = advocateData(d.advocate);
  return data;
}

/** The advocate verdict as a decision row holds it: enums, numbers and ids, the reason filtered like any reason. */
function advocateData(v: AdvocateVerdict): Record<string, unknown> {
  invariant((v.mode === "shadow" || v.mode === "enforce") && (v.verdict === null || ADVOCATE_VERDICTS.includes(v.verdict)) && typeof v.act === "boolean" && (v.mode === "enforce" || !v.act), "an advocate verdict is a known choice, and nothing acts in shadow");
  return { mode: v.mode, floor: v.floor, verdict: v.verdict, confidence: typeof v.confidence === "number" && Number.isFinite(v.confidence) ? v.confidence : null, act: v.act, ...(okId(v.goal) ? { goal: v.goal } : {}), ...(okId(v.gap) ? { gap: v.gap } : {}), reason: safeText(v.reason, 200) };
}
const ADVOCATE_VERDICTS: readonly string[] = ["none", "research", "prepare", "background"];

/** The fields a minimal row keeps: ids, the outcome and its enums, nothing a caller wrote in words. */
function minimalData(d: DecisionInput, refusal: string): Record<string, unknown> {
  return {
    answers: d.answers, outcome: d.outcome, reason: `${REFUSED_PREFIX}${refusal.slice(0, 120)}`,
    ...(okId(d.event_id) ? { event_id: d.event_id } : {}),
    ...(d.brief ? { brief: true } : {}),
    ...(d.delivery ? { delivery: { state: d.delivery.state } } : {}),
  };
}

function decisionRow(d: DecisionInput, data: Record<string, unknown>): StatvsInput {
  return { writer: DECISION_WRITER, stream: DECISION_STREAM, class: "personal", kind: "decision", ref: d.answers, data };
}

/** Write one decision row (see the module header). Never throws except an InvariantViolation. */
export function writeDecision(d: DecisionInput, opts: { appendImpl?: (input: StatvsInput) => AppendResult } = {}): WriteDecisionResult {
  invariant(okId(d.answers), "a decision answers a real row id");
  invariant((OUTCOMES as readonly string[]).includes(d.outcome), `a decision has one of the six outcomes: ${d.outcome}`);
  invariant(d.delivery === undefined || d.outcome === "tell_now", "only a tell-now decision carries a delivery");
  invariant(d.editor === undefined || VERDICT.test(d.editor.verdict), "an editor verdict is a short label");
  invariant(typeof d.reason === "string" && d.reason.length > 0, "a decision carries its reason");
  if (hasDecisionClaim(d.answers)) return { ok: false, claimed: true };
  const put = opts.appendImpl ?? append;
  const r = put(decisionRow(d, decisionData(d)));
  if (r.ok) return { ok: true, row: r.row };
  if ("spooled" in r) { writeClaim(d.answers, d.event_id); return { ok: true, spooled: true, claimed: true }; }
  const m = put(decisionRow(d, minimalData(d, r.refused)));
  if (m.ok) return { ok: true, row: m.row, minimal: true };
  if ("spooled" in m) { writeClaim(d.answers, d.event_id); return { ok: true, spooled: true, claimed: true }; }
  return { ok: false, refused: m.refused };
}

/** One decision per answered row, in order. Two decisions for one row in a batch is an impossible state. */
export function writeDecisions(list: DecisionInput[], opts: { appendImpl?: (input: StatvsInput) => AppendResult } = {}): WriteDecisionResult[] {
  invariant(new Set(list.map((d) => d.answers)).size === list.length, "one decision row per answered row");
  return list.map((d) => writeDecision(d, opts));
}

/** Append one vigil-log row. Best-effort: the result says what happened, nothing is thrown but an InvariantViolation. */
function logRow(kind: string, title: string, data: Record<string, unknown>, ref?: string, appendImpl: (input: StatvsInput) => AppendResult = append): AppendResult {
  invariant(VERDICT.test(kind), "a vigil-log row names its kind");
  return appendImpl({ writer: LOG_WRITER, stream: LOG_STREAM, class: "personal", kind, title, data, ...(ref ? { ref } : {}) });
}

/** Keep the words local (0600) beside their hash; the row only ever holds the hash. */
function saveWords(entry: { event_id: string; words_sha256: string } & Record<string, string>): void {
  invariant(entry.words_sha256.length === 64, "editor words are keyed by their SHA-256");
  const path = statePath(EDITOR_WORDS_FILE), line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  invariant(!line.includes("\n"), "an editor-words line is one line");
  mkdirSync(statePath(), { recursive: true });
  appendFileSync(path, line + "\n", { mode: 0o600 }); chmodSync(path, 0o600);
}

/**
 * Keep any words local (0600, editor-words.jsonl) and return the SHA-256 a row carries in their place (P10, design §1.3).
 * `parts` is a flat map of short field names to text; the hash is over its JSON, so a reader joins on it with wordsByHash.
 */
export function keepWords(eventId: string, parts: Record<string, string>): string {
  const kept = Object.fromEntries(Object.entries(parts).filter(([, v]) => typeof v === "string" && v.length > 0));
  invariant(okId(eventId), "kept words are keyed by a real event or row id");
  invariant(Object.keys(kept).length > 0 && Object.keys(kept).every((k) => VERDICT.test(k) && !["ts", "event_id", "words_sha256"].includes(k)), "kept words are named text fields");
  const words_sha256 = sha256(JSON.stringify(kept));
  saveWords({ event_id: eventId, words_sha256, ...kept });
  return words_sha256;
}

/** The words a row's hash stands for, from the local editor-words.jsonl (the newest line with that hash), or null. */
export function wordsByHash(hash: string): Record<string, string> | null {
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  let text: string; try { text = readFileSync(statePath(EDITOR_WORDS_FILE), "utf8"); } catch { return null; }
  let found: Record<string, string> | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes(hash)) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (e.words_sha256 !== hash) continue;
      found = Object.fromEntries(Object.entries(e).filter(([k, v]) => !["ts", "event_id", "words_sha256"].includes(k) && typeof v === "string")) as Record<string, string>;
    } catch { /* a torn line: skip */ }
  }
  return found;
}

const wordsOf = (w: { title?: string; why?: string; reworded?: string; note?: string }): string | null => {
  const parts = Object.fromEntries((["title", "why", "reworded", "note"] as const).flatMap((k) => (typeof w[k] === "string" && w[k] ? [[k, w[k]]] : [])));
  return Object.keys(parts).length ? JSON.stringify(parts) : null;
};

/** An editor verdict on an event (ref = its decision row): ids, the verdict and a hash; the words go to editor-words.jsonl. */
export function writeEditorRow(e: { event_id: string; verdict: string; ref?: string; title?: string; why?: string; reworded?: string }, opts: { appendImpl?: (input: StatvsInput) => AppendResult } = {}): AppendResult {
  invariant(okId(e.event_id) && VERDICT.test(e.verdict) && (e.ref === undefined || okId(e.ref)), "an editor row carries an event id, a short verdict and a row ref");
  const words = wordsOf(e), data: Record<string, unknown> = { event_id: e.event_id, verdict: e.verdict };
  if (words) { data.words_sha256 = sha256(words); saveWords({ event_id: e.event_id, words_sha256: data.words_sha256 as string, ...(e.title ? { title: e.title } : {}), ...(e.why ? { why: e.why } : {}), ...(e.reworded ? { reworded: e.reworded } : {}) }); }
  return logRow("editor", "Vigil editor verdict", data, e.ref, opts.appendImpl);
}

/** A feedback label (good, noise, missed) on a decision: ids, the label and a hash of any note; the note stays local. */
export function writeLabel(l: { event_id: string; verdict: string; ref?: string; note?: string }, opts: { appendImpl?: (input: StatvsInput) => AppendResult } = {}): AppendResult {
  invariant(okId(l.event_id) && VERDICT.test(l.verdict) && (l.ref === undefined || okId(l.ref)), "a label carries an event id, a short verdict and a row ref");
  const words = wordsOf({ note: l.note }), data: Record<string, unknown> = { event_id: l.event_id, verdict: l.verdict };
  if (words) { data.words_sha256 = sha256(words); saveWords({ event_id: l.event_id, words_sha256: data.words_sha256 as string, note: l.note! }); }
  return logRow("label", "Vigil feedback label", data, l.ref, opts.appendImpl);
}

/** The tick's own run, as the vigil-log `tick` row: counts and pings, every error string filtered first. */
export type TickRowInput = { ts: string; duration_ms: number; collected: number; routed: number; pings: Array<{ name: string; ok: boolean; error?: string; not_installed?: true; events: number; ms: number }>; baseline?: true; dry_run?: true; error?: string; brief_sent?: true };
export function writeTickRow(t: TickRowInput, opts: { appendImpl?: (input: StatvsInput) => AppendResult } = {}): AppendResult {
  invariant(Number.isFinite(Date.parse(t.ts)) && t.duration_ms >= 0 && t.collected >= 0 && t.routed >= 0, "a tick row carries a real ts and non-negative counts");
  const pings = t.pings.map((p) => ({ name: safeText(p.name, 64), ok: p.ok, events: p.events, ms: p.ms, ...(p.not_installed ? { not_installed: true } : {}), ...(p.error !== undefined ? { error: safeText(p.error) } : {}) }));
  const data: Record<string, unknown> = { tick_ts: t.ts, duration_ms: t.duration_ms, collected: t.collected, routed: t.routed, pings };
  if (t.baseline) data.baseline = true;
  if (t.dry_run) data.dry_run = true;
  if (t.brief_sent) data.brief_sent = true;
  if (t.error !== undefined) data.error = safeText(t.error);
  return logRow("tick", "Vigil tick", data, undefined, opts.appendImpl);
}

/** One dual-write comparison per tick (p1): what the record-fed pass would decide against what the legacy tick did. No decision rows. */
export type ShadowCompare = {
  read: number; compared: number; agreed: number; only_shadow: number; only_legacy: number; skipped: number;
  shadow_outcomes: Partial<Record<Outcome, number>>; legacy_outcomes: Partial<Record<Outcome, number>>;
  /** `legacy->shadow` outcome pairs that differ, with counts. */
  disagreements: Record<string, number>;
  /** Shadow reasons behind the disagreements, with counts (each reason passed through safeText). */
  disagreement_reasons: Record<string, number>;
  /** 16-hex prefixes of the SHA-256 of each told story key, shadow and legacy. */
  shadow_told_hash: string[]; legacy_told_hash: string[];
  ms: number; baselined?: true; timed_out?: true; error?: string;
  /** Rows sharing an event id with an earlier row in the read (counted in `skipped` too). */
  duplicates?: number;
  /** The read stopped at SHADOW_BATCH_MAX rows; the rest are read by the next tick. */
  batch_capped?: true;
};
export const storyHash = (key: string): string => sha256(key).slice(0, 16);
export function writeShadowCompare(c: ShadowCompare, opts: { appendImpl?: (input: StatvsInput) => AppendResult } = {}): AppendResult {
  invariant([c.read, c.compared, c.agreed, c.only_shadow, c.only_legacy, c.skipped, c.ms].every((n) => Number.isInteger(n) && n >= 0) && c.agreed <= c.compared, "a shadow comparison carries non-negative counts");
  invariant([...c.shadow_told_hash, ...c.legacy_told_hash].every((h) => /^[0-9a-f]{16}$/.test(h)), "told stories are hashed, never named");
  const reasons = Object.fromEntries(Object.entries(c.disagreement_reasons).map(([r, n]) => [safeText(r, 120), n] as const));
  return logRow("shadow-compare", "Vigil shadow comparison", { ...c, disagreement_reasons: reasons, ...(c.error !== undefined ? { error: safeText(c.error) } : {}) }, undefined, opts.appendImpl);
}

/** The shadow pass reads through its own consumer, so it never moves the tick's. */
export const SHADOW_CONSUMER = "vigil-shadow";
export const SHADOW_DEADLINE_MS = 30_000;
/** The most rows one shadow pass reads. The read, decide and commit run synchronously, so this cap, not the timer, bounds the pass. */
export const SHADOW_BATCH_MAX = 2_000;
type Routed = Pick<Decision, "action" | "reason" | "event">;

/**
 * The p1 dual-write shadow pass (§3 Lane D p1): read new `event` and `cloud` rows through consumer
 * `vigil-shadow`, decide them with `decide` (the legacy tick's own routing context), compare each outcome
 * with what the legacy tick decided for the same event id, and append one `shadow-compare` row. It writes no
 * decision rows and sends nothing. Best-effort: a failure or a pass past its deadline is reported in the
 * result (and in the row when one can be written); nothing is thrown but an InvariantViolation, and the tick
 * catches even that.
 *
 * The deadline is a flag, not a cut: the comparison runs synchronously, so a pass that overruns is marked
 * `timed_out` once it finishes. What bounds its length is the read cap: at most SHADOW_BATCH_MAX rows, the
 * consumer committed at the last row read, and the rest left for the next tick.
 */
export async function shadowPass(opts: {
  policy: Pick<VigilPolicy, "read_classes">; legacy: Routed[]; decide: (events: VigilEvent[]) => Routed[];
  skip?: (event: VigilEvent) => boolean; storyKey: (event: VigilEvent) => string;
  deadlineMs?: number; batchMax?: number; consumer?: string; now?: number; appendImpl?: (input: StatvsInput) => AppendResult;
}): Promise<{ compare?: ShadowCompare; row?: AppendResult; error?: string; timed_out?: true }> {
  const deadline = opts.deadlineMs ?? SHADOW_DEADLINE_MS, started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), deadline); });
  const work = (async () => {
    await null; // yield once, so the deadline timer is armed before any synchronous read
    const compare = compareShadow(opts, started);
    const over = performance.now() - started > deadline;
    if (over) compare.timed_out = true;
    return { compare, row: writeShadowCompare(compare, { appendImpl: opts.appendImpl }), ...(over ? { timed_out: true as const } : {}) };
  })();
  try {
    const out = await Promise.race([work, late]);
    if (out === "late") return { error: `shadow pass still running after ${Math.round(deadline / 1000)}s; abandoned`, timed_out: true };
    return out;
  } catch (error) {
    if (error instanceof InvariantViolation) throw error;
    return { error: safeText(error instanceof Error ? error.message : String(error)) };
  } finally { clearTimeout(timer); }
}

function compareShadow(opts: Parameters<typeof shadowPass>[0], started: number): ShadowCompare {
  const consumer = opts.consumer ?? SHADOW_CONSUMER;
  const empty: ShadowCompare = { read: 0, compared: 0, agreed: 0, only_shadow: 0, only_legacy: 0, skipped: 0, shadow_outcomes: {}, legacy_outcomes: {}, disagreements: {}, disagreement_reasons: {}, shadow_told_hash: [], legacy_told_hash: [], ms: 0 };
  const limit = opts.batchMax ?? SHADOW_BATCH_MAX;
  invariant(Number.isInteger(limit) && limit > 0, "a shadow pass reads a bounded batch");
  const r = readNew(opts.policy, { consumer, limit, ...(opts.now !== undefined ? { now: opts.now } : {}) });
  const read = r.items.length + r.unreadable.length + r.duplicates.length;
  const c: ShadowCompare = { ...empty, read };
  if (r.baselined) c.baselined = true;
  if (read + r.skipped.length >= limit) c.batch_capped = true;
  if (r.duplicates.length) c.duplicates = r.duplicates.length;
  const items = r.items.filter((i) => !(opts.skip?.(i.event) ?? false));
  c.skipped = r.items.length - items.length + r.unreadable.length + r.duplicates.length;
  const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
  const legacy = new Map<string, Routed>();
  for (const d of opts.legacy) if (!d.event.id.startsWith("collapsed:")) legacy.set(d.event.id, d);
  for (const d of legacy.values()) { const o = outcomeOf(d).outcome; bump(c.legacy_outcomes, o); if (o === "tell_now" && d.action === "text") c.legacy_told_hash.push(storyHash(opts.storyKey(d.event))); }
  if (items.length) {
    const decisions = opts.decide(items.map((i) => i.event));
    const outcomes = outcomesFor(items.map((i) => ({ row_id: i.row.id, event_id: i.event.id })), decisions);
    const byEvent = new Map(decisions.map((d) => [d.event.id, d] as const));
    const seen = new Set<string>();
    for (const o of outcomes) {
      bump(c.shadow_outcomes, o.outcome);
      const mine = byEvent.get(o.event_id);
      if (o.outcome === "tell_now" && mine?.action === "text") c.shadow_told_hash.push(storyHash(opts.storyKey(mine.event)));
      const theirs = legacy.get(o.event_id);
      if (!theirs) { c.only_shadow++; continue; }
      seen.add(o.event_id); c.compared++;
      const lo = outcomeOf(theirs).outcome;
      if (lo === o.outcome) c.agreed++;
      else { bump(c.disagreements, `${lo}->${o.outcome}`); bump(c.disagreement_reasons, o.reason); }
    }
    c.only_legacy = [...legacy.keys()].filter((id) => !seen.has(id)).length;
  } else c.only_legacy = legacy.size;
  c.shadow_told_hash = [...new Set(c.shadow_told_hash)].sort(); c.legacy_told_hash = [...new Set(c.legacy_told_hash)].sort();
  commitRead(r.next, { consumer, ...(opts.now !== undefined ? { now: opts.now } : {}) });
  c.ms = Math.round(performance.now() - started);
  return c;
}

export type { Delivery };
