#!/usr/bin/env bun
/**
 * @version 0.1.2
 * ReviewCases — turns a bug the code review let through into a case the reviewer can be replayed on
 * (review-miss-evals ISA, F4).
 *
 * A miss is a later commit that undoes or repairs earlier work:
 *   - a revert ("This reverts commit <id>") names the commit it undoes (ISC-11);
 *   - a fix commit (subject "fix…", "Area: fix…") is blamed line by line to the commits that wrote what it changed (ISC-12).
 * Each introducing commit is joined to the earliest model-read pass whose span (base..head) and scope held it (ISC-28:
 * covered, waived, skipped and blocked records never count). The case's label is the fix itself: the lines it changed,
 * mapped to the reviewed head's line numbers, so a replay finding can be matched to them (ISC-14). The fix never enters
 * the replayed input; it is only the label (ISC-26). Cases are a view: rebuilt from the review records and git, never edited.
 *
 * Two more sources name a commit or a deploy instead of being one (ISC-13): an Errata entry (`links.commit`, or a
 * keyed sha such as "commit 1a2b3c4" in its words) and a Vigil incident event (`source: incident`; `meta.commit`, or the
 * same keyed sha). A named commit is joined the same way: the pass that held it, labelled by the fix that later repaired
 * its lines. An entry that names a deploy ("deploy" plus a deploy target or domain, or `meta.deploy`) resolves through the
 * deploy ledger (MEMORY/SYSTEMUPDATES/deploys.jsonl) to the latest deploy of that target at or before the report, and
 * names every commit that deploy shipped (the span since the target's previous deploy of the same repo). The fix is
 * never taken from the entry: a named commit nothing later repaired is reported with its reason, never a case without a
 * label (ISC-26). A named commit that is itself a fix or revert is read as the fix. `kind` is the case's source:
 * revert | fix | errata | vigil; for the last two `via` says how the fix was found and `named` lists the entries.
 *
 * Whether a case is a real defect, rather than a refactor, a new requirement or a wording change, is asked of Assay's
 * judgment layer (ISC-15, ISC-29). Judgment caller: `review-case-defect`, shadow until {{PRINCIPAL_NAME}}'s labels earn it
 * (LIFEOS/DOCUMENTATION/Assay/AssaySystem.md § Judgment layer). The answer is recorded on the case and decides nothing.
 *
 * USAGE:
 *   bun ReviewCases.ts build [--json]   rebuild the case file from every review record, repo, Errata entry and Vigil incident; prints counts per source and skip reasons
 *   bun ReviewCases.ts judge [--json]   ask the judgment layer about every case not yet judged
 *   bun ReviewCases.ts label <id> y|n   {{PRINCIPAL_NAME}}'s verdict: is this case a real defect the review missed
 *   bun ReviewCases.ts list [--json]    the current cases, with each judgment and label
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "./Invariant";
import { lifeosPath } from "./Paths";
import { EMPTY_TREE } from "./Review";
import { allRecords, rebuildInput, type ReviewRef } from "./ReviewReplay";

export interface LabelSpan { file: string; lines: number[] }
export type CaseSource = "revert" | "fix" | "errata" | "vigil";
/** An Errata entry or a Vigil incident that named the commit or deploy; `how` is what it named. */
export interface NamedRef { source: "errata" | "vigil"; id: string; how: "commit" | "deploy" }
export interface ReviewCase {
  /** `kind` is the case's source. For errata and vigil, `via` is how the fix that labels it was found. */
  id: string; kind: CaseSource; via?: "revert" | "fix"; named?: NamedRef[]; repoRoot: string; scope: string;
  review: { file: string; base: string; head: string; ts: string; fingerprint: string };
  /** The model-read pass whose reading this is: the review itself, or the pass a same-diff covered record reused. Replay's control arm is its reviewer. */
  readBy: string;
  introducing: string; fix: string; fixSubject: string;
  /** The lines the fix changed, as line numbers in the reviewed head's version of each file. */
  label: LabelSpan[];
}
/** What one named source did: entries read, how many named a commit or a deploy, how many linked to a case. */
export interface SourceStats { entries: number; namingCommit: number; namingDeploy: number; linked: number }
export interface BuildResult { cases: ReviewCase[]; skipped: Record<string, number>; sources: { errata: SourceStats; vigil: SourceStats } }

// ── entries that name a commit or a deploy (ISC-13) ───────────────────────────
/** One Errata entry or Vigil incident reduced to what can name a commit or a deploy. */
export interface NamingEntry { source: "errata" | "vigil"; id: string; ts: string; texts: string[]; commits: string[]; deploys: string[] }
/** One row of the deploy ledger (MEMORY/SYSTEMUPDATES/deploys.jsonl, written by LedgerDeployEvent.ts). */
export interface DeployRow { ts: string; project: string; target: string; domain: string | null; repo: string | null; sha: string | null; ok: boolean }
/** Where the entries come from. Every reader is optional: with none, a build reads only the review records and git. */
export interface NamedSources {
  /** Folded Errata entries (ErrataStore.all()). */
  errata?: () => ErrataLike[];
  /** Vigil events; `fromDate` is YYYY-MM-DD, the day of the earliest reviewed pass. */
  vigil?: (fromDate: string) => VigilLike[];
  deploys?: () => DeployRow[];
}
export interface ErrataLike { id: string; ts: string; kind: string; complaint: string; links?: { commit?: string }; context?: { doing?: string | null; component?: string | null }; tags?: string[] }
export interface VigilLike { id: string; source: string; ts: string; title: string; summary: string; ref: string | null; dedup_key: string; meta?: Record<string, unknown> }

const HEXID = /^[0-9a-f]{7,40}$/i;
/** "commit 1a2b3c4", "sha: 1a2b3c4d5e6f": a sha counts in free text only when a keyword names it and it holds a digit (a word such as "defaced" is not one). */
const KEYED_SHA = /\b(?:commit|sha|revision|rev)\b[\s:#=@"'`(\[]*([0-9a-f]{7,40})\b/gi;
export function shasIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(KEYED_SHA)) if (/\d/.test(m[1]!)) out.add(m[1]!.toLowerCase());
  return [...out];
}
/** Errata kinds that can describe a defect; praise, a question and a feature request describe none (ISC-29). */
const DEFECT_KINDS = new Set(["complaint", "bug", "correction", "incident"]);

export function errataEntries(list: ErrataLike[]): NamingEntry[] {
  return list.filter((e) => DEFECT_KINDS.has(e.kind)).map((e) => {
    const texts = [e.complaint, e.context?.doing ?? "", e.context?.component ?? "", ...(e.tags ?? [])];
    const commits = new Set(texts.flatMap(shasIn));
    if (typeof e.links?.commit === "string" && HEXID.test(e.links.commit)) commits.add(e.links.commit.toLowerCase());
    const deploys = (e.tags ?? []).filter((t) => t.startsWith("deploy:")).map((t) => t.slice(7)).filter(Boolean);
    return { source: "errata" as const, id: e.id, ts: e.ts, texts, commits: [...commits], deploys };
  });
}

/** Vigil incidents: events from source `incident` (Incident.ts), one entry per incident id however many states it moved through. */
export function vigilEntries(events: VigilLike[]): NamingEntry[] {
  const byId = new Map<string, NamingEntry>();
  for (const v of events) {
    if (v.source !== "incident" && !v.dedup_key.startsWith("incident:")) continue;
    const meta = v.meta ?? {};
    const id = typeof meta.incident === "string" ? meta.incident : v.ref ?? v.id;
    const texts = [v.title, v.summary];
    const e = byId.get(id) ?? { source: "vigil" as const, id, ts: v.ts, texts: [], commits: [], deploys: [] };
    e.texts.push(...texts);
    if (v.ts < e.ts) e.ts = v.ts;
    for (const s of texts.flatMap(shasIn)) if (!e.commits.includes(s)) e.commits.push(s);
    for (const k of ["commit", "sha"]) { const x = meta[k]; if (typeof x === "string" && HEXID.test(x) && !e.commits.includes(x.toLowerCase())) e.commits.push(x.toLowerCase()); }
    if (typeof v.ref === "string" && HEXID.test(v.ref) && /\d/.test(v.ref) && !e.commits.includes(v.ref.toLowerCase())) e.commits.push(v.ref.toLowerCase());
    if (typeof meta.deploy === "string" && meta.deploy && !e.deploys.includes(meta.deploy)) e.deploys.push(meta.deploy);
    byId.set(id, e);
  }
  return [...byId.values()];
}

/** Deploy ledger rows, oldest first. Torn lines are skipped. */
export function readDeployLedger(path = process.env.LIFEOS_DEPLOY_LEDGER ?? lifeosPath("MEMORY", "SYSTEMUPDATES", "deploys.jsonl")): DeployRow[] {
  if (!existsSync(path)) return [];
  const rows: DeployRow[] = [];
  for (const l of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    try { const r = JSON.parse(l) as DeployRow; if (r && typeof r.ts === "string" && typeof r.target === "string") rows.push(r); } catch { /* torn line */ }
  }
  return rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/** The live readers the CLI passes to buildCases: Errata's own store, the STATVS `event` stream read through Vigil's own row mapping, the deploy ledger. */
export async function liveSources(): Promise<NamedSources> {
  // Imported here, not at the top: the Errata store loads with a top-level await, and a module that cannot load must
  // leave its source unread and reported (buildCases says so), never take the whole build down.
  const failed = (e: unknown) => () => { throw e; };
  const errata = await import("../ERRATA/Store").then((m) => (() => new m.ErrataStore().all() as ErrataLike[]), failed);
  const vigil = await Promise.all([import("../STATVS/index"), import("../VIGIL/Reader")]).then(([s, v]) => (fromDate: string) =>
    s.scan({ streams: ["event"], fromDate }).rows.flatMap((r) => { const e = v.toEvent(r); return e ? [{ ...e, meta: e.meta as Record<string, unknown> | undefined }] : []; }), failed);
  return { errata, vigil, deploys: () => readDeployLedger() };
}

type Pass = ReviewRef & { file: string; ts: string; readBy: string };

const FIX_SUBJECT = /^(?:[\w./-]+:\s*)?(?:hot|bug)?fix(?:es|ed)?\b|^fix\(/i;
/** Conventional types that never carry a defect fix (ISC-29): "docs: fix link", "chore: fix lint". */
const NOT_A_DEFECT_TYPE = /^(?:docs|chore|style|refactor|test|tests|ci|build|lint|format)(?:\([^)]*\))?!?:/i;
const REVERTS = /This reverts commit ([0-9a-f]{7,40})/;

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}
const isAncestor = (repo: string, a: string, b: string) => spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: repo }).status === 0;
/** Prose files: a changed line there is a wording change, never a code defect the reviewer missed (ISC-29). */
const PROSE = /\.(?:md|mdx|txt|rst)$/i;
const inScope = (scope: string, file: string) => scope === "." || file === scope || file.startsWith(scope + "/");

export function casesPath(): string {
  return process.env.LIFEOS_REVIEW_CASES ?? lifeosPath("MEMORY", "STATE", "review-cases", "cases.jsonl");
}

/** Commits in base..head (head included, base excluded); base may be the empty tree. */
function inSpan(repo: string, commit: string, base: string, head: string): boolean {
  if (!isAncestor(repo, commit, head)) return false;
  if (base !== EMPTY_TREE && spawnSync("git", ["cat-file", "-e", `${base}^{commit}`], { cwd: repo }).status !== 0) return false;
  return base === EMPTY_TREE || !isAncestor(repo, commit, base);
}

/** The path in a ---/+++ header: git appends a TAB to a path with a space, and quotes one it cannot print plainly. */
function headerPath(line: string, prefix: string): string {
  let p = line.replace(/\t$/, "");
  if (p.startsWith(prefix.slice(0, 4) + '"')) { try { p = prefix.slice(0, 4) + (JSON.parse(p.slice(4)) as string); } catch { return ""; } }
  return p.startsWith(prefix) ? p.slice(prefix.length) : "";
}

/** Files the commit changed, with the line numbers it added in its own version of each file. */
function addedLines(repo: string, commit: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const diff = git(repo, ["show", "--no-color", "--no-ext-diff", "--format=", "-U0", "--no-renames", commit]) ?? "";
  let file = "";
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) { file = headerPath(l, "+++ b/"); continue; }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m && file) { const a = Number(m[1]), n = m[2] === undefined ? 1 : Number(m[2]); const arr = out.get(file) ?? []; for (let i = 0; i < n; i++) arr.push(a + i); out.set(file, arr); }
  }
  return out;
}

/** The lines a fix removed or rewrote, in its parent's version: file → line numbers. A pure addition has none. */
// A line that is only a comment or blank: slash-slash, slash-star, a star continuation or close, hash and HTML forms.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*(?:\s|\/|$)|#(?:\s|!|$)|--\s|<!--|-->|$)/;

function changedParentLines(repo: string, fix: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const diff = git(repo, ["diff", "--no-color", "--no-ext-diff", "-U0", "--no-renames", `${fix}^`, fix]) ?? "";
  let file = "";
  const codeChanged = new Set<string>();
  for (const l of diff.split("\n")) {
    if (l.startsWith("--- ")) { file = headerPath(l, "--- a/"); continue; }
    if (l.startsWith("+++ ")) continue;
    // A file counts only when the fix changed a line of code in it, on either side.
    if (file && (l.startsWith("-") || l.startsWith("+")) && !COMMENT_LINE.test(l.slice(1))) codeChanged.add(file);
    const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(l);
    if (m && file) { const a = Number(m[1]), n = m[2] === undefined ? 1 : Number(m[2]); if (n === 0) continue; const arr = out.get(file) ?? []; for (let i = 0; i < n; i++) arr.push(a + i); out.set(file, arr); }
  }
  for (const k of [...out.keys()]) if (!codeChanged.has(k)) out.delete(k);
  return out;
}

/** Blame lines of `file` at `rev`: final line → { commit, origLine }. */
function blame(repo: string, rev: string, file: string, lines?: number[]): Map<number, { commit: string; orig: number }> {
  const out = new Map<number, { commit: string; orig: number }>();
  const ranges = lines?.length ? lines.map((n) => ["-L", `${n},${n}`]).flat() : [];
  const txt = git(repo, ["blame", "--porcelain", ...ranges, rev, "--", file]);
  if (!txt) return out;
  for (const l of txt.split("\n")) {
    const m = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(l);
    if (m) out.set(Number(m[3]), { commit: m[1]!, orig: Number(m[2]) });
  }
  return out;
}

/** The introducing commit's lines (in its own numbering) mapped to the reviewed head's numbering. */
function toHeadLines(repo: string, head: string, file: string, introducing: string, origLines: Set<number>): number[] {
  const at = blame(repo, head, file);
  const out: number[] = [];
  for (const [final, b] of at) if (b.commit === introducing && origLines.has(b.orig)) out.push(final);
  return out.sort((a, b) => a - b);
}

/** Per repo: the commits entries named as the bug's home (`intro`) or as the fix itself (`fix`). */
interface NamedMap { intro: Map<string, NamedRef[]>; fix: Map<string, NamedRef[]> }
interface Outcome { ref: NamedRef; linked: boolean; reason: string | null; lastSkip: string | null; fixSeen: boolean }
const refKey = (r: NamedRef) => `${r.source}:${r.id}:${r.how}`;
const SHIPPED_SPAN_CAP = 500;
/** A report names the latest deploy of the target within this long before it; an older deploy is not the one a person means. */
const DEPLOY_WINDOW_MS = 7 * 86_400_000;

export function buildCases(sources: NamedSources = {}): BuildResult {
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  const stats = { errata: { entries: 0, namingCommit: 0, namingDeploy: 0, linked: 0 }, vigil: { entries: 0, namingCommit: 0, namingDeploy: 0, linked: 0 } };
  // A pass over uncommitted work read a tree that git never held, so its label could not be blamed at its head; the clean
// pass that follows re-reads the same span (Review.ts keeps the base until a clean pass) and takes the case instead.
const all = allRecords().recs;
const byFile = new Map(all.map((r) => [r.file, r]));
// A covered record whose diff is byte-identical to the pass it reused is that pass's reading, placed on committed history;
// one reused by state alone read a different diff and takes nothing (ISC-28).
const readingOf = (r: (typeof all)[number]): string | null => {
  if (r.status === "pass") return r.file;
  const from = r.status === "covered" && r.reusedFrom ? byFile.get(r.reusedFrom) : undefined;
  return from && from.status === "pass" && from.fingerprint === r.fingerprint ? from.file : null;
};
const passes: Pass[] = all.flatMap((r) => { const by = readingOf(r); return by && !r.dirty && r.ts && /^[0-9a-f]{40}$/.test(r.head) ? [{ ...r, ts: r.ts, readBy: by }] : []; });
  const byRepo = new Map<string, Pass[]>();
  for (const p of passes) { if (!existsSync(p.repoRoot)) continue; const a = byRepo.get(p.repoRoot) ?? []; a.push(p); byRepo.set(p.repoRoot, a); }
  const cases = new Map<string, ReviewCase>();
  const rebuildable = new Map<string, boolean>();
  for (const ps of byRepo.values()) ps.sort((a, b) => (a.ts < b.ts ? -1 : 1));

  // Entries that name a commit or a deploy, placed in the reviewed repos they resolve in.
  const named = new Map<string, NamedMap>();
  const outcomes = new Map<string, Outcome>();
  {
    const repos = [...byRepo.keys()];
    const realOf = new Map<string, string>();
    for (const r of repos) { try { realOf.set(realpathSync(r), r); } catch { /* a repo that vanished has no passes to join */ } }
    const earliest = [...byRepo.values()].map((ps) => ps[0]!.ts).sort()[0] ?? "";
    const entries: NamingEntry[] = [];
    const read = <T>(label: "errata" | "vigil", f: (() => T[]) | undefined, map: (x: T[]) => NamingEntry[]) => {
      if (!f) return;
      try { entries.push(...map(f())); } catch (e) { skip(`${label}: the source could not be read (${(e as Error).message.slice(0, 60)})`); }
    };
    read("errata", sources.errata, errataEntries);
    read("vigil", sources.vigil && earliest ? () => sources.vigil!(earliest.slice(0, 10)) : undefined, vigilEntries);
    let ledger: DeployRow[] = [];
    try { ledger = sources.deploys ? sources.deploys() : []; } catch (e) { skip(`deploy ledger could not be read (${(e as Error).message.slice(0, 60)})`); }
    const okRows = ledger.filter((r) => r.ok && r.sha && r.repo);
    const targets = [...new Set(okRows.flatMap((r) => [r.target, r.domain ?? ""]).filter((t) => t.length >= 4))];

    const slot = (repo: string) => { let m = named.get(repo); if (!m) { m = { intro: new Map(), fix: new Map() }; named.set(repo, m); } return m; };
    const add = (repo: string, commit: string, ref: NamedRef) => {
      for (const side of [slot(repo).intro, slot(repo).fix]) { const a = side.get(commit) ?? []; if (!a.some((x) => refKey(x) === refKey(ref))) a.push(ref); side.set(commit, a); }
    };
    const outcome = (ref: NamedRef) => { const k = refKey(ref); let o = outcomes.get(k); if (!o) { o = { ref, linked: false, reason: null, lastSkip: null, fixSeen: false }; outcomes.set(k, o); } return o; };
    const resolveIn = (repo: string, id: string) => git(repo, ["rev-parse", "--verify", "--quiet", `${id}^{commit}`])?.trim() || null;

    for (const e of entries) {
      const st = stats[e.source]; st.entries++;
      // A deploy is named by a structured reference, or by the word "deploy" beside a ledger target or domain.
      const text = e.texts.join("\n");
      const needles = new Set(e.deploys);
      if (/\bdeploy/i.test(text)) for (const t of targets) if (new RegExp(`(?<![\\w.-])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(text)) needles.add(t);
      if (e.commits.length) {
        st.namingCommit++;
        const ref: NamedRef = { source: e.source, id: e.id, how: "commit" };
        const o = outcome(ref);
        let placed = false;
        for (const sha of e.commits) for (const repo of repos) { const full = resolveIn(repo, sha); if (full) { add(repo, full, ref); placed = true; } }
        if (!placed) o.reason = "names a commit in no repo that has a model-read pass";
      }
      if (needles.size) {
        st.namingDeploy++;
        const ref: NamedRef = { source: e.source, id: e.id, how: "deploy" };
        const o = outcome(ref);
        const rows = new Map<string, DeployRow>();
        for (const n of needles) {
          // The latest deploy of that target (or domain, or project when the entry named it structurally) at or before the report.
          const hit = okRows.filter((r) => r.ts <= e.ts && Date.parse(e.ts) - Date.parse(r.ts) <= DEPLOY_WINDOW_MS && (r.target === n || r.domain === n || (e.deploys.includes(n) && r.project === n))).at(-1);
          if (hit) rows.set(`${hit.target}@${hit.ts}`, hit);
        }
        if (!rows.size) { o.reason = "names a deploy with no ledger row in the week before the report"; continue; }
        let placed = false;
        for (const row of rows.values()) {
          let repo: string | undefined;
          try { repo = realOf.get(realpathSync(row.repo!)); } catch { /* the deploy's repo is gone */ }
          const tip = repo ? resolveIn(repo, row.sha!) : null;
          if (!repo || !tip) continue;
          // What the deploy shipped: the commits since the same target's previous deploy of the same repo, else the deployed commit alone.
          const prev = okRows.filter((r) => r.target === row.target && r.repo === row.repo && r.ts < row.ts && r.sha !== row.sha).at(-1);
          const prevSha = prev ? resolveIn(repo, prev.sha!) : null;
          let span = [tip];
          if (prevSha && prevSha !== tip && isAncestor(repo, prevSha, tip)) {
            const l = git(repo, ["rev-list", `-n${SHIPPED_SPAN_CAP}`, `${prevSha}..${tip}`]);
            if (l) span = l.split("\n").filter(Boolean);
          }
          for (const c of span) add(repo, c, ref);
          placed = true;
        }
        if (!placed) o.reason = "names a deploy whose commit is in no repo that has a model-read pass";
      }
    }
  }

  for (const [repo, ps] of byRepo) {
    const since = ps[0]!.ts;
    const log = git(repo, ["log", "--no-merges", `--since=${since}`, "--format=%H%x1f%s%x1f%b%x1e", "HEAD"]) ?? "";
    for (const entry of log.split("\x1e")) {
      const [fix, subject = "", body = ""] = entry.trim().split("\x1f");
      if (!fix || !/^[0-9a-f]{40}$/.test(fix)) continue;
      const reverted = REVERTS.exec(body)?.[1];
      const kind: "revert" | "fix" | null = reverted ? "revert" : FIX_SUBJECT.test(subject) && !NOT_A_DEFECT_TYPE.test(subject) ? "fix" : null;
      if (!kind) continue;

      // introducing commit → (file → its own line numbers the fix touched)
      const intro = new Map<string, Map<string, Set<number>>>();
      if (kind === "revert") {
        const full = git(repo, ["rev-parse", "--verify", "--quiet", `${reverted}^{commit}`])?.trim();
        if (!full) { skip("revert names a commit not in the repo"); continue; }
        const m = new Map<string, Set<number>>();
        for (const [f, ls] of addedLines(repo, full)) m.set(f, new Set(ls));
        intro.set(full, m);
      } else {
        const changed = changedParentLines(repo, fix);
        if (changed.size === 0) { skip("fix only adds lines or only changes comments: nothing to blame"); continue; }
        for (const [f, ls] of changed) {
          for (const b of blame(repo, `${fix}^`, f, ls).values()) {
            const m = intro.get(b.commit) ?? new Map<string, Set<number>>();
            const set = m.get(f) ?? new Set<number>(); set.add(b.orig); m.set(f, set); intro.set(b.commit, m);
          }
        }
      }

      const nm = named.get(repo);
      for (const [c, files] of intro) {
        // Entries that named this introducing commit, or this fix itself, give the case its source; they never give its label (ISC-26).
        const refs = [...new Map([...(nm?.intro.get(c) ?? []), ...(nm?.fix.get(fix) ?? [])].map((r) => [refKey(r), r])).values()].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
        const miss = (why: string) => { skip(why); for (const r of refs) { const o = outcomes.get(refKey(r))!; o.fixSeen = true; o.lastSkip = why; } };
        // The earliest model-read pass whose span and scope held the introducing commit, and whose head the fix is not already in.
        const pass = ps.find((p) => [...files.keys()].some((f) => inScope(p.scope, f)) && inSpan(repo, c, p.base, p.head) && !isAncestor(repo, fix, p.head));
        if (!pass) { miss(kind === "revert" ? "reverted commit was in no reviewed pass" : "introducing commit was in no reviewed pass"); continue; }
        if (!rebuildable.has(pass.file)) rebuildable.set(pass.file, rebuildInput({ ...pass, status: "pass" }).ok); // a same-diff covered record rebuilds as the reading it is
        if (!rebuildable.get(pass.file)) { miss("the pass that held it cannot be rebuilt"); continue; }
        const label: LabelSpan[] = [];
        for (const [f, orig] of files) {
          if (!inScope(pass.scope, f) || PROSE.test(f)) continue;
          const lines = toHeadLines(repo, pass.head, f, c, orig);
          if (lines.length) label.push({ file: f, lines });
        }
        if (!label.length) { miss([...files.keys()].every((f) => PROSE.test(f)) ? "only prose lines changed" : "introducing lines were rewritten before the reviewed head"); continue; }
        // The label is part of the id: a judgment or label belongs to exactly the content it was given, never a relabelled case.
        const id = createHash("sha256").update(`${pass.file}\0${fix}\0${c}\0${JSON.stringify(label)}`).digest("hex").slice(0, 16);
        invariant(!label.some((l) => l.lines.some((n) => !Number.isInteger(n) || n < 1)), "label lines are positive line numbers");
        for (const r of refs) { const o = outcomes.get(refKey(r))!; o.fixSeen = true; o.linked = true; }
        cases.set(id, { id, kind: refs[0]?.source ?? kind, ...(refs.length ? { via: kind, named: refs } : {}), repoRoot: repo, scope: pass.scope, review: { file: pass.file, base: pass.base, head: pass.head, ts: pass.ts, fingerprint: pass.fingerprint }, readBy: pass.readBy, introducing: c, fix, fixSubject: subject.slice(0, 200), label });
      }
    }
  }
  // Each entry that named something and linked to no case says why, once per entry (ISC-13: never a case without a label).
  for (const o of outcomes.values()) {
    if (o.linked) { stats[o.ref.source].linked++; continue; }
    skip(`${o.ref.source} entry: ${o.reason ?? (o.fixSeen ? `a fix for the ${o.ref.how} it named took no case (${o.lastSkip ?? "no label"})` : `no later fix or revert repaired the ${o.ref.how} it named`)}`);
  }
  return { cases: [...cases.values()].sort((a, b) => (a.review.ts < b.review.ts ? -1 : a.review.ts > b.review.ts ? 1 : a.id < b.id ? -1 : 1)), skipped, sources: stats };
}

/** Rewrites the case file whole (it is a view of the records and git). */
export function writeCases(cases: ReviewCase[]): string {
  const p = casesPath();
  invariant(new Set(cases.map((c) => c.id)).size === cases.length, "case ids are unique");
  mkdirSync(join(p, ".."), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, cases.map((c) => JSON.stringify(c)).join("\n") + (cases.length ? "\n" : ""));
  renameSync(tmp, p);
  return p;
}

// ── is it a real defect? (ISC-15) ─────────────────────────────────────────────
export const DEFECT_CALLER = "review-case-defect";
export const DEFECT_QUESTION = {
  defect: {
    type: "noul" as const,
    instructions: "reviewed_change is a code change that passed code review. later_change is a later commit that rewrote some of its lines. Is it likely that reviewed_change contained a real defect (a bug, a security gap, broken or missing behaviour the change claimed to deliver) that later_change repaired, rather than a refactor, a new requirement, a rename, a wording change or a style change?",
    criteria: { true: "the reviewed change was wrong and the later change repairs it", false: "the later change is a refactor, new requirement, rename, wording or style change" },
  },
};
export interface CaseJudgment { id: string; defect: number | null; wouldAct: boolean | null; model: string | null; error: string | null; at: string }
type JudgeManyFn = (items: Array<{ key: string; state: object }>, questions: typeof DEFECT_QUESTION, opts: { caller: string }) => Promise<Array<{ key: string; result: Record<string, { answer: { type: string; noul?: number }; verdict: { wouldAct: boolean }; model?: string }> | null; error: string | null }>>;

export function judgmentsPath(): string { return join(casesPath(), "..", "judgments.jsonl"); }

export function readJudgments(): Map<string, CaseJudgment> {
  const p = judgmentsPath();
  const m = new Map<string, CaseJudgment>();
  if (!existsSync(p)) return m;
  for (const l of readFileSync(p, "utf8").split("\n").filter(Boolean)) { try { const j = JSON.parse(l) as CaseJudgment; m.set(j.id, j); } catch { /* a torn line is re-asked */ } }
  return m;
}

const clip = (t: string, n = 6000) => (t.length > n ? `${t.slice(0, n)}\n…[clipped]` : t);

/** The state a judgment reads: the labelled files' diffs in the reviewed commit and in the fix, nothing else. */
export function caseState(c: ReviewCase): { fix_subject: string; reviewed_change: string; later_change: string } {
  const files = c.label.map((l) => l.file);
  invariant(files.length > 0, "a case carries a label, so its state is only the labelled files");
  const show = (rev: string) => git(c.repoRoot, ["show", "--no-color", "--no-ext-diff", "--format=", "-U3", rev, "--", ...files]) ?? "";
  return { fix_subject: c.fixSubject, reviewed_change: clip(show(c.introducing)), later_change: clip(show(c.fix)) };
}

/** Judge every case without a judgment; failures are recorded with their error and asked again next time. */
export async function judgeCases(cases: ReviewCase[], run?: JudgeManyFn): Promise<CaseJudgment[]> {
  const done = readJudgments();
  const todo = cases.filter((c) => !(done.get(c.id)?.defect != null));
  if (!todo.length) return [];
  const judgeMany = run ?? ((await import("../ASSAY/Assay")).judgeMany as unknown as JudgeManyFn);
  const res = await judgeMany(todo.map((c) => ({ key: c.id, state: caseState(c) })), DEFECT_QUESTION, { caller: DEFECT_CALLER });
  const at = new Date().toISOString();
  const out = res.map((r): CaseJudgment => {
    const a = r.result?.defect;
    const p = a?.answer.type === "noul" && typeof a.answer.noul === "number" ? a.answer.noul : null;
    return { id: r.key, defect: p, wouldAct: a ? a.verdict.wouldAct : null, model: a?.model ?? null, error: r.error ?? (p === null ? "no noul answer" : null), at };
  });
  invariant(out.every((j) => j.defect === null || (j.defect >= 0 && j.defect <= 1)), "a defect answer is a probability");
  mkdirSync(join(judgmentsPath(), ".."), { recursive: true });
  appendFileSync(judgmentsPath(), out.map((j) => JSON.stringify(j)).join("\n") + "\n");
  return out;
}

export interface CaseLabel { id: string; defect: boolean; by: "principal"; at: string }
export function labelsPath(): string { return join(casesPath(), "..", "labels.jsonl"); }
export function readLabels(): Map<string, CaseLabel> {
  const m = new Map<string, CaseLabel>();
  if (!existsSync(labelsPath())) return m;
  for (const l of readFileSync(labelsPath(), "utf8").split("\n").filter(Boolean)) { try { const x = JSON.parse(l) as CaseLabel; m.set(x.id, x); } catch { /* torn line */ } }
  return m;
}
/** Record {{PRINCIPAL_NAME}}'s verdict on whether a case is a real defect. Appended; the latest verdict per case stands. */
export function labelCase(id: string, defect: boolean): CaseLabel {
  invariant(readCases().some((c) => c.id === id), `no case ${id}`);
  const x: CaseLabel = { id, defect, by: "principal", at: new Date().toISOString() };
  mkdirSync(join(labelsPath(), ".."), { recursive: true });
  appendFileSync(labelsPath(), JSON.stringify(x) + "\n");
  return x;
}
/** How often the judgment's reading (at 0.5) matches {{PRINCIPAL_NAME}}'s labels. */
export function agreement(): { labelled: number; agree: number } {
  const js = readJudgments(); let labelled = 0, agree = 0;
  for (const l of readLabels().values()) { const p = js.get(l.id)?.defect; if (p == null) continue; labelled++; if ((p >= 0.5) === l.defect) agree++; }
  return { labelled, agree };
}

export function readCases(): ReviewCase[] {
  const p = casesPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ReviewCase);
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const json = rest.includes("--json");
  if (cmd === "build") {
    const r = buildCases(await liveSources());
    const p = writeCases(r.cases);
    const kinds = r.cases.reduce<Record<string, number>>((a, c) => ((a[c.kind] = (a[c.kind] ?? 0) + 1), a), { revert: 0, fix: 0, errata: 0, vigil: 0 });
    if (json) { console.log(JSON.stringify({ path: p, cases: r.cases.length, bySource: kinds, sources: r.sources, skipped: r.skipped })); process.exit(0); }
    console.log(`Review cases: ${r.cases.length} (${Object.entries(kinds).map(([k, v]) => `${v} ${k}`).join(", ")}) → ${p}`);
    for (const [s, st] of Object.entries(r.sources)) console.log(`  ${s}: read ${st.entries}, ${st.namingCommit} name a commit, ${st.namingDeploy} name a deploy, ${st.linked} linked`);
    for (const [k, v] of Object.entries(r.skipped).sort((a, b) => b[1] - a[1])) console.log(`  skipped ${v} × ${k}`);
  } else if (cmd === "judge") {
    const out = await judgeCases(readCases());
    if (json) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
    console.log(`Judged ${out.length} case(s) (caller ${DEFECT_CALLER}, shadow)`);
    for (const j of out) console.log(`  ${j.id}  defect=${j.defect === null ? "—" : j.defect.toFixed(2)}${j.error ? `  error: ${j.error}` : ""}`);
  } else if (cmd === "label") {
    const [id, v] = rest;
    if (!id || (v !== "y" && v !== "n")) { console.error("usage: bun ReviewCases.ts label <case id> y|n   (y: a real defect the review missed)"); process.exit(2); }
    const x = labelCase(id, v === "y");
    const a = agreement();
    console.log(`Labelled ${x.id} ${x.defect ? "defect" : "not a defect"}. Judgment agrees on ${a.agree} of ${a.labelled} labelled cases.`);
  } else if (cmd === "list") {
    const cs = readCases();
    const js = readJudgments();
    if (json) { console.log(JSON.stringify(cs.map((c) => ({ ...c, judgment: js.get(c.id) ?? null })), null, 2)); process.exit(0); }
    for (const c of cs) console.log(`${c.id}  ${c.kind.padEnd(6)} ${c.review.ts.slice(0, 10)}  defect=${js.get(c.id)?.defect?.toFixed(2) ?? "—"}  ${c.label.map((l) => `${l.file}:${l.lines[0]}${l.lines.length > 1 ? `-${l.lines[l.lines.length - 1]}` : ""}`).join(", ").slice(0, 90)}  ← ${c.fixSubject.slice(0, 60)}`);
  } else { console.error("usage: bun ReviewCases.ts build|judge|label|list [--json]"); process.exit(2); }
}
