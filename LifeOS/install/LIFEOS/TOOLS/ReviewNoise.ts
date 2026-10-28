#!/usr/bin/env bun
/**
 * @version 0.1.0
 * ReviewNoise — how noisy the pre-deploy reviewer is in production, measured from what happened to each of its blocks
 * (review-miss-evals ISA, F6 ISC-36 and F6b ISC-37). The way Anthropic measures its reviewer's noise: by what people do
 * with each comment, fixed it or dismissed it. No reviewer call, no model call, no network: review records plus git.
 *
 * GROUPING KEY ("fingerprint" for production records). Review records do not store ReviewSuite's reviewer fingerprint,
 * so a record is keyed by what it does carry or what git can establish for the moment it ran:
 *     <reviewerModel> · src <hash8>
 *   - reviewerModel: the model string the record stored, exactly ("gpt-6-astra", "a + b" when two vendors reviewed).
 *     The served model is the one input of a reviewer's behavior that the record holds itself.
 *   - src: sha256 (8 hex) of Review.ts's prompt source as committed when the record ran (the SYSTEM_PROMPT, buildUserPrompt,
 *     batchDiff and parseVerdict text, found with `git log` on Review.ts up to the record's `ts`). It is the historical twin of
 *     ReviewSuite.reviewerFingerprint's source parts; it leaves out the constants that file reads from the *current* Review.ts
 *     (budgets, tier map, REVIEW_VERSION), which would be wrong for an old record. REVIEW_VERSION is left out on purpose:
 *     it moves on every patch bump while the prompt is unchanged, which would split one reviewer into many keys.
 *   A record with no Review.ts commit before its `ts` gets `src unknown`.
 * The prompt-source regexes (PROMPT_PARTS, fnSource) are copied from ReviewSuite.ts, which does not export them.
 * The record walker is copied from ReviewReplay.allRecords for the same reason: that one keeps only the replay fields,
 * and this needs the findings, model and waiver fields.
 *
 * CHAINS. A record joins the chain of its repoRoot. The "next pass" of a block is the first later record in that chain whose
 * scope is the block's scope or a parent of it (the repo root covers every subdirectory), as Review.ts's coveringPass does.
 *
 * WHAT COUNTS (ISC-36)
 *   model read      pass, blocked, waived or accepted with a reviewerModel, not roundCap. covered called no model, skipped none.
 *   blocking review a model read with at least one blocker finding: status blocked, or waived/accepted (a waiver is a block
 *                   a human shipped past). blockRate = blocking / model reads.
 *   blocker waiver  a waived/accepted record that a model read with at least one blocker. `unreviewed` waivers (over the batch
 *                   ceiling) and outage waivers called no model and are not waivers of a model's block.
 *   excluded        roundCap blocks, blocks with no reviewerModel and over-ceiling blocks ("diff too large") are no model
 *                   block and appear only as counts in `excluded`.
 * Each blocked record then gets one outcome, by its next terminal record:
 *   waived      a waiver (above) came first: a human overrode the block.
 *   pending     no later pass yet: neither acted on nor dismissed.
 *   acted       the next clean model-read pass exists, and at least one blocker's file and lines (±LINE_SLACK) changed between
 *               the blocked review's head and that pass's head: someone fixed what it flagged (ISC-37 retention case).
 *   dismissed   the next clean model-read pass exists and every blocker's file and lines were unchanged: it was passed
 *               without a change at what it flagged. A flag with no line is the whole file.
 *   unmeasurable the outcome needs a diff git cannot give: the block ran on uncommitted work (no commit holds its state), or
 *               a commit or file is missing. Counted and reported, never folded into acted or dismissed.
 * A dirty pass is skipped when looking for the next pass: it cleared a working tree, not a commit, and Review.ts's own base
 * only moves on a clean pass.
 *
 * RETENTION CASES (ISC-37): one per acted block, labelled with the changed blockers' own file and line in the blocked
 * review's numbering (the numbering of the diff the reviewer read), so ReviewSuite.hits() scores a replay finding against it.
 * Written to `retention.jsonl` beside the cases file as a view: rewritten whole on every run, never hand-edited.
 *
 * USAGE:
 *   bun ReviewNoise.ts signals [--json]     per-key block rate, waivers, acted/dismissed/pending (zero reviewer calls, writes nothing)
 *   bun ReviewNoise.ts retention [--json]   rebuild the retention-case view from the records and git, and print it
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "./Invariant";
import { stateDir, type Finding, type ReviewRecord } from "./Review";
import { casesPath, type LabelSpan } from "./ReviewCases";
import { rebuildInput } from "./ReviewReplay";
import { LINE_SLACK } from "./ReviewSuite";

export type NoiseRecord = ReviewRecord & { file: string };
export type Outcome = "waived" | "pending" | "acted" | "dismissed" | "unmeasurable";

/** Maps one record to its grouping key (see the header). Injectable so tests need no Review.ts history. */
export type ReviewerKeyFn = (rec: Pick<ReviewRecord, "ts" | "reviewerModel">) => string;

// ── records ────────────────────────────────────────────────────────────────────

/** Every readable record under the review state dir, oldest first, with its `<repo dir>/<file>` name. */
export function readNoiseRecords(): NoiseRecord[] {
  const root = stateDir();
  const out: NoiseRecord[] = [];
  if (!existsSync(root)) return out;
  for (const repo of readdirSync(root)) {
    const d = join(root, repo);
    try { if (!statSync(d).isDirectory()) continue; } catch { continue; }
    for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) {
      try { out.push({ ...(JSON.parse(readFileSync(join(d, f), "utf8")) as ReviewRecord), file: `${repo}/${f}` }); } catch { /* an unreadable record is skipped, as Review.ts does */ }
    }
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

// ── the grouping key ───────────────────────────────────────────────────────────

const PROMPT_PARTS = [/export const SYSTEM_PROMPT = `[\s\S]*?`;/, /export function buildUserPrompt[\s\S]*?\n}\n/];
const fnSource = (src: string, name: string): string => new RegExp(`export function ${name}[\\s\\S]*?\\n}\\n`).exec(src)?.[0] ?? "";
/** The reviewer's behavior-bearing source in one version of Review.ts: prompt, user-prompt builder, batch cutter, verdict parser. */
export function reviewerSource(src: string): string {
  return [...PROMPT_PARTS.map((re) => re.exec(src)?.[0] ?? ""), fnSource(src, "batchDiff"), fnSource(src, "parseVerdict")].join("\n");
}
const hash8 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);

/** Review.ts's own commit history as { rev, epoch }, newest first; computed once. */
let history: Array<{ rev: string; at: number }> | null = null;
const srcByRev = new Map<string, string>();
const configRoot = () => join(import.meta.dir, "..", "..");

/** The prompt identity of Review.ts as committed when a record ran, or "unknown". */
export function sourceIdAt(ts: string): string {
  const root = configRoot();
  if (!history) {
    const r = spawnSync("git", ["log", "--format=%H %ct", "--", "LIFEOS/TOOLS/Review.ts"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    history = r.status === 0 ? r.stdout.split("\n").filter(Boolean).map((l) => { const [rev, at] = l.split(" "); return { rev: rev!, at: Number(at) }; }) : [];
  }
  const at = Date.parse(ts) / 1000;
  if (!Number.isFinite(at)) return "unknown";
  const hit = history.find((h) => h.at <= at);
  if (!hit) return "unknown";
  let id = srcByRev.get(hit.rev);
  if (id === undefined) {
    const r = spawnSync("git", ["show", `${hit.rev}:LIFEOS/TOOLS/Review.ts`], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    id = r.status === 0 && r.stdout ? hash8(reviewerSource(r.stdout)) : "unknown";
    srcByRev.set(hit.rev, id);
  }
  return id;
}

export const reviewerKey: ReviewerKeyFn = (rec) => `${rec.reviewerModel ?? "no model"} · src ${sourceIdAt(rec.ts)}`;

// ── classification ─────────────────────────────────────────────────────────────

const blockersOf = (r: ReviewRecord): Finding[] => r.findings.filter((f) => f.severity === "blocker");
const isOverCeiling = (r: ReviewRecord) => r.findings.some((f) => f.severity === "blocker" && /^diff too large/.test(f.summary));
/** A review a model read and found at least one blocker in: blocked, or shipped past on a waiver. */
const isModelBlocking = (r: ReviewRecord) => !!r.reviewerModel && !r.roundCap && !r.unreviewed && !isOverCeiling(r) && blockersOf(r).length > 0 && (r.status === "blocked" || r.status === "waived" || r.status === "accepted");
const isWaiver = (r: ReviewRecord) => isModelBlocking(r) && r.status !== "blocked";
const isModelBlock = (r: ReviewRecord) => isModelBlocking(r) && r.status === "blocked";
const isModelRead = (r: ReviewRecord) => !!r.reviewerModel && !r.roundCap && !r.unreviewed && !isOverCeiling(r) && (r.status === "pass" || r.status === "blocked" || r.status === "waived" || r.status === "accepted");
const scopeCovers = (passScope: string, blockScope: string) => passScope === blockScope || passScope === "." || blockScope.startsWith(`${passScope}/`);
const FULL = /^[0-9a-f]{40}$/;

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}
const existsAt = (repo: string, rev: string, path: string) => spawnSync("git", ["cat-file", "-e", `${rev}:${path}`], { cwd: repo }).status === 0;

/** The repo-relative paths a finding's file may mean: as given, without ./, without a diff's a/ or b/, under the scope (as ReviewSuite). */
function candidates(file: string, scope: string): string[] {
  const p = file.replace(/^\.\//, "");
  const out = [p, p.replace(/^[ab]\//, "")];
  if (scope !== ".") out.push(...out.map((x) => `${scope}/${x}`));
  return [...new Set(out)];
}

/**
 * Did `path` change between `from` and `to` within LINE_SLACK lines of `line` (lines numbered as in `from`)? A flag with no
 * line asks whether the file changed at all. A deleted file changed. null means git could not say.
 */
export function changedBetween(repo: string, from: string, to: string, path: string, line: number | undefined, slack = LINE_SLACK): boolean | null {
  if (!existsAt(repo, to, path)) return existsAt(repo, from, path) ? true : null;
  const diff = git(repo, ["diff", "--no-color", "--no-ext-diff", "-U0", "--no-renames", from, to, "--", path]);
  if (diff === null) return null;
  const hunks = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)].map((m) => ({ a: Number(m[1]), n: m[2] === undefined ? 1 : Number(m[2]) }));
  if (line === undefined || line < 1) return hunks.length > 0;
  const lo = line - slack, hi = line + slack;
  // A removed range [a, a+n-1] meets the window; an insertion (n = 0) goes after old line a, so it lands in the window when lo-1 <= a <= hi.
  return hunks.some((h) => (h.n > 0 ? h.a <= hi && h.a + h.n - 1 >= lo : h.a >= lo - 1 && h.a <= hi));
}

export interface BlockerCheck { file: string; line?: number; summary: string; changed: boolean }
export interface BlockOutcome { block: NoiseRecord; key: string; outcome: Outcome; reason?: string; pass?: NoiseRecord; blockers?: BlockerCheck[] }

/** One outcome per model-blocked record (no git is touched for waived, pending or uncommitted ones). */
export function classifyBlocks(recs: NoiseRecord[], key: ReviewerKeyFn = reviewerKey): BlockOutcome[] {
  const byRepo = new Map<string, NoiseRecord[]>();
  for (const r of recs) { const a = byRepo.get(r.repoRoot) ?? []; a.push(r); byRepo.set(r.repoRoot, a); }
  const out: BlockOutcome[] = [];
  for (const chain of byRepo.values()) {
    chain.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.file < b.file ? -1 : 1));
    for (const [i, block] of chain.entries()) {
      if (!isModelBlock(block)) continue;
      const k = key(block);
      let terminal: NoiseRecord | undefined;
      for (const r of chain.slice(i + 1)) {
        if (!scopeCovers(r.scope, block.scope)) continue;
        if (isWaiver(r)) { terminal = r; break; }
        if (r.status === "pass" && isModelRead(r) && !r.dirty && FULL.test(r.head)) { terminal = r; break; }
      }
      if (!terminal) { out.push({ block, key: k, outcome: "pending" }); continue; }
      if (terminal.status !== "pass") { out.push({ block, key: k, outcome: "waived", pass: terminal }); continue; }
      const unmeasurable = (reason: string): BlockOutcome => ({ block, key: k, outcome: "unmeasurable", reason, pass: terminal });
      if (block.dirty) { out.push(unmeasurable("the block ran on uncommitted work")); continue; }
      if (!FULL.test(block.head)) { out.push(unmeasurable("the blocked review has no commit head")); continue; }
      if (!existsSync(block.repoRoot)) { out.push(unmeasurable("repo not on this machine")); continue; }
      if (spawnSync("git", ["cat-file", "-e", `${block.head}^{commit}`], { cwd: block.repoRoot }).status !== 0 || spawnSync("git", ["cat-file", "-e", `${terminal.head}^{commit}`], { cwd: block.repoRoot }).status !== 0) { out.push(unmeasurable("a reviewed commit is not in the repo")); continue; }
      const checks: BlockerCheck[] = [];
      let bad: string | null = null;
      for (const f of blockersOf(block)) {
        const path = candidates(f.file, block.scope).find((p) => existsAt(block.repoRoot, block.head, p));
        if (!path) { bad = "a flagged file is not in the blocked commit"; break; }
        const changed = changedBetween(block.repoRoot, block.head, terminal.head, path, f.line);
        if (changed === null) { bad = "git could not compare the two commits"; break; }
        checks.push({ file: path, ...(f.line ? { line: f.line } : {}), summary: f.summary, changed });
      }
      if (bad) { out.push(unmeasurable(bad)); continue; }
      out.push({ block, key: k, outcome: checks.some((c) => c.changed) ? "acted" : "dismissed", pass: terminal, blockers: checks });
    }
  }
  return out;
}

// ── ISC-36: signals ────────────────────────────────────────────────────────────

export interface KeySignals {
  key: string;
  /** Model reads: the denominator of the block rate. */
  reviews: number;
  /** Model reads with at least one blocker: blocked, or waived past. */
  blocking: number;
  blockRate: number | null;
  /** Blocks a human shipped past: waived or accepted records a model read with a blocker. */
  waivers: number;
  /** Status-blocked model blocks, split by outcome. */
  blocks: number;
  waived: number; pending: number; acted: number; dismissed: number; unmeasurable: number;
  /** dismissed / (acted + dismissed): the share of resolved blocks passed without a change at the flagged lines. */
  dismissedRate: number | null;
}
export interface Signals {
  keys: KeySignals[];
  total: KeySignals;
  /** Records that are no model block, counted so none is silently dropped. */
  excluded: { roundCap: number; noModel: number; overCeiling: number; covered: number };
  unmeasurableReasons: Record<string, number>;
  records: number;
}

const rate = (n: number, d: number) => (d > 0 ? n / d : null);
const blank = (key: string): KeySignals => ({ key, reviews: 0, blocking: 0, blockRate: null, waivers: 0, blocks: 0, waived: 0, pending: 0, acted: 0, dismissed: 0, unmeasurable: 0, dismissedRate: null });
function seal(s: KeySignals): KeySignals {
  s.blockRate = rate(s.blocking, s.reviews);
  s.dismissedRate = rate(s.dismissed, s.acted + s.dismissed);
  return s;
}

/** Production precision signals per reviewer key. Pure: records and git in, numbers out; no model call. */
export function computeSignals(recs: NoiseRecord[] = readNoiseRecords(), opts: { key?: ReviewerKeyFn; outcomes?: BlockOutcome[] } = {}): Signals {
  const key = opts.key ?? reviewerKey;
  const by = new Map<string, KeySignals>();
  const row = (k: string) => { let s = by.get(k); if (!s) { s = blank(k); by.set(k, s); } return s; };
  const excluded = { roundCap: 0, noModel: 0, overCeiling: 0, covered: 0 };
  for (const r of recs) {
    if (r.status === "covered") { excluded.covered++; continue; }
    if (r.status === "blocked") {
      if (r.roundCap) { excluded.roundCap++; continue; }
      if (!r.reviewerModel) { excluded.noModel++; continue; }
      if (isOverCeiling(r)) { excluded.overCeiling++; continue; }
    }
    if (!isModelRead(r)) continue;
    const s = row(key(r));
    s.reviews++;
    if (isModelBlocking(r)) s.blocking++;
    if (isWaiver(r)) s.waivers++;
  }
  const unmeasurableReasons: Record<string, number> = {};
  for (const o of opts.outcomes ?? classifyBlocks(recs, key)) {
    const s = row(o.key);
    s.blocks++;
    s[o.outcome]++;
    if (o.outcome === "unmeasurable") unmeasurableReasons[o.reason ?? "unknown"] = (unmeasurableReasons[o.reason ?? "unknown"] ?? 0) + 1;
  }
  const keys = [...by.values()].map(seal).sort((a, b) => b.reviews - a.reviews || (a.key < b.key ? -1 : 1));
  const total = blank("all");
  for (const s of keys) for (const f of ["reviews", "blocking", "waivers", "blocks", "waived", "pending", "acted", "dismissed", "unmeasurable"] as const) total[f] += s[f];
  return { keys, total: seal(total), excluded, unmeasurableReasons, records: recs.length };
}

// ── ISC-37: retention cases ────────────────────────────────────────────────────

/** Structurally a ReviewCase for scoring: ReviewSuite.hits(finding, case) reads only `label` and `scope`. */
export interface RetentionCase {
  id: string; kind: "retention"; repoRoot: string; scope: string;
  review: { file: string; base: string; head: string; ts: string; fingerprint: string };
  /** The blocked review itself: replay reads its rebuilt input. */
  readBy: string;
  /** The pass that followed, after the flagged lines changed. */
  nextPass: string;
  reviewerKey: string;
  /** The changed blockers' own file and line, in the numbering of the diff the reviewer read. */
  label: LabelSpan[];
  blockers: Array<{ file: string; line: number; summary: string }>;
}
export interface RetentionResult { cases: RetentionCase[]; skipped: Record<string, number> }

export function retentionPath(): string { return join(casesPath(), "..", "retention.jsonl"); }

export function buildRetention(recs: NoiseRecord[] = readNoiseRecords(), opts: { key?: ReviewerKeyFn; outcomes?: BlockOutcome[]; rebuild?: (r: NoiseRecord) => boolean } = {}): RetentionResult {
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  const rebuild = opts.rebuild ?? ((r: NoiseRecord) => rebuildInput({ ...r, status: "blocked" }).ok);
  const cases = new Map<string, RetentionCase>();
  for (const o of opts.outcomes ?? classifyBlocks(recs, opts.key)) {
    if (o.outcome !== "acted") continue;
    const changed = (o.blockers ?? []).filter((b) => b.changed && b.line !== undefined);
    if (!changed.length) { skip("the changed blocker named no line to label"); continue; }
    if (!rebuild(o.block)) { skip("the blocked review's input cannot be rebuilt"); continue; }
    const byFile = new Map<string, number[]>();
    for (const b of changed) byFile.set(b.file, [...(byFile.get(b.file) ?? []), b.line!]);
    const label: LabelSpan[] = [...byFile].map(([file, lines]) => ({ file, lines: [...new Set(lines)].sort((a, b) => a - b) }));
    const id = createHash("sha256").update(`${o.block.file}\0${o.pass!.file}\0${JSON.stringify(label)}`).digest("hex").slice(0, 16);
    cases.set(id, {
      id, kind: "retention", repoRoot: o.block.repoRoot, scope: o.block.scope,
      review: { file: o.block.file, base: o.block.base, head: o.block.head, ts: o.block.ts, fingerprint: o.block.fingerprint },
      readBy: o.block.file, nextPass: o.pass!.file, reviewerKey: o.key, label,
      blockers: changed.map((b) => ({ file: b.file, line: b.line!, summary: b.summary.slice(0, 200) })),
    });
  }
  return { cases: [...cases.values()].sort((a, b) => (a.review.ts < b.review.ts ? -1 : a.review.ts > b.review.ts ? 1 : a.id < b.id ? -1 : 1)), skipped };
}

/** Rewrites the retention view whole (it is rebuilt from the records and git, never edited). */
export function writeRetention(cases: RetentionCase[]): string {
  invariant(new Set(cases.map((c) => c.id)).size === cases.length, "retention case ids are unique");
  for (const c of cases) {
    invariant(c.kind === "retention" && c.label.length > 0, "a retention case carries a label");
    invariant(c.label.every((l) => l.file.length > 0 && l.lines.length > 0 && l.lines.every((n) => Number.isInteger(n) && n >= 1)), "label lines are positive line numbers in a named file");
    invariant(c.readBy === c.review.file && c.nextPass !== c.review.file, "a retention case reads the blocked review and names a different pass");
  }
  const p = retentionPath();
  mkdirSync(join(p, ".."), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, cases.map((c) => JSON.stringify(c)).join("\n") + (cases.length ? "\n" : ""));
  renameSync(tmp, p);
  return p;
}

export function readRetention(): RetentionCase[] {
  const p = retentionPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as RetentionCase);
}

// ── CLI ────────────────────────────────────────────────────────────────────────

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const json = rest.includes("--json");
  if (cmd === "signals") {
    const s = computeSignals();
    if (json) { console.log(JSON.stringify(s, null, 2)); process.exit(0); }
    console.log(`Reviewer noise signals: ${s.records} records, zero reviewer calls`);
    for (const k of [...s.keys, s.total]) {
      console.log(`  ${k.key}`);
      console.log(`    reviews ${k.reviews}  blocking ${k.blocking} (${pct(k.blockRate)})  waivers ${k.waivers}`);
      console.log(`    blocks ${k.blocks}: acted ${k.acted}, dismissed ${k.dismissed} (${pct(k.dismissedRate)} of resolved), waived ${k.waived}, pending ${k.pending}, unmeasurable ${k.unmeasurable}`);
    }
    console.log(`  excluded (no model block): ${s.excluded.roundCap} round-cap, ${s.excluded.noModel} no model, ${s.excluded.overCeiling} over-ceiling; ${s.excluded.covered} covered (no model read)`);
    for (const [why, n] of Object.entries(s.unmeasurableReasons).sort((a, b) => b[1] - a[1])) console.log(`  unmeasurable: ${n} × ${why}`);
  } else if (cmd === "retention") {
    const r = buildRetention();
    const p = writeRetention(r.cases);
    if (json) { console.log(JSON.stringify({ path: p, cases: r.cases.length, skipped: r.skipped, view: r.cases }, null, 2)); process.exit(0); }
    console.log(`Retention cases: ${r.cases.length} → ${p}`);
    for (const c of r.cases) console.log(`  ${c.id}  ${c.review.ts.slice(0, 10)}  ${c.label.map((l) => `${l.file}:${l.lines.join(",")}`).join("; ").slice(0, 100)}  [${c.reviewerKey}]`);
    for (const [why, n] of Object.entries(r.skipped).sort((a, b) => b[1] - a[1])) console.log(`  skipped ${n} × ${why}`);
  } else { console.error("usage: bun ReviewNoise.ts signals|retention [--json]"); process.exit(2); }
}
