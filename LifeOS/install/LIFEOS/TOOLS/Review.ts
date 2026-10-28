#!/usr/bin/env bun
/**
 * @version 1.5.0
 * Review — the independent code review every change gets before it goes live.
 *
 * A model that did not write the change reads the diff since the last passing
 * review (plus the repo's ISA) and reports defects. A blocker stops the deploy
 * the way a failing test does. No PR, no branch, no waiting: deploy commands
 * call this directly (`CfEnv.ts deploy` does it for every Cloudflare deploy).
 *
 * USAGE:
 *   bun Review.ts [dir] [--allow-dirty "<reason>"] [--waive-blockers "<reason>"] [--json]
 *                                                        review dir's changes; exit 0 pass, 1 blocked, 2 error
 *   bun Review.ts status [dir] [--json]                  the latest record for dir
 *   bun Review.ts audit [--json]                         every PROJECTS.md deploy script reaches the review; exit 1 on a gap
 *
 * - Base: the commit of the last pass for this repo+scope (if still an ancestor of HEAD),
 *   else the upstream branch, else where HEAD left the remote main (origin/HEAD|main|master),
 *   else HEAD~1. The diff runs base → working tree, untracked
 *   files included, scoped to `dir`. A skipped or blocked review since the last pass keeps
 *   its base, so the span it did not clear is reviewed again.
 *   The first review in a repo starts at the upstream branch: code already pushed before
 *   this tool existed is the baseline, not a backlog.
 * - Reviewer: the other vendor from the commits' Co-Authored-By trailers (Claude-written
 *   code goes to OpenAI; code only OpenAI wrote goes to Anthropic; uncommitted work counts
 *   as Claude's). A diff both vendors wrote gets one review from each. Never falls back
 *   to the author's vendor. When the other vendor cannot answer, Google (the third trusted
 *   vendor, which wrote none of the code) reviews instead, and only an answer from a
 *   Google model is accepted.
 * - Size: a large diff is split into batches and every batch is reviewed, at most
 *   8 reviewer calls at a time; under the ceiling nothing passes unread. Past
 *   64 batches (a runaway diff) the review blocks; --waive-blockers ships it with a
 *   `waived` record marked `unreviewed`.
 * - Tier: decided here from paths and size, never by a model. low → medium level,
 *   standard → high, high (auth, payments, migrations, secrets, deploy config) → max.
 * - Records: one JSON file per review under MEMORY/STATE/reviews/<repo>/, where <repo> is
 *   `root-<sha>` from the repo's oldest root commit, so every worktree and clone of one repo
 *   shares one record set (a repo with no commits keeps the old path key; records under old
 *   path keys are still read). Never writes into the reviewed repo.
 * - Coverage: no model call when an earlier pass already reviewed this state: an identical diff
 *   or state, or a clean pass (at this scope or a parent scope such as the repo root) whose head
 *   is an ancestor of HEAD with nothing in scope changed since. Each reuse writes a `covered`
 *   record naming the pass in `reusedFrom`, and `covered` counts as a pass for the next base.
 * - Reviewer unreachable: records `skipped` and exits 1, so the deploy stops (fail closed,
 *   2026-09-30). `--waive-blockers "<reason>"` deploys unreviewed; either way the base does not
 *   advance, so the next deploy reviews the whole unreviewed span.
 * - Uncommitted paths in scope (linguist-generated build outputs aside) block before any model
 *   call: a deploy ships committed code only, so the reviewed commit is the deployed one.
 *   `--allow-dirty "<reason>"` lifts only that block; the model review still runs and its
 *   blockers still stop the deploy.
 * - Waivers: `--waive-blockers "<reason>"` lets model blockers, a reviewer outage or an
 *   over-ceiling diff through, never uncommitted files. A `waived` record never moves the
 *   base and is never reused, so the waived span is reviewed again next time. The old
 *   `--accept` (one reason for both blocks) is retired: it exits 2 naming the two flags
 *   (2026-10-11). Legacy `accepted` records are read and treated the same as `waived`.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { effectiveProgram, programName, shellSteps, simpleCommands, type SimpleCommand } from "../../hooks/lib/shell-commands.ts";
import { invariant } from "./Invariant";
import { lifeosPath } from "./Paths";
import { redact } from "./lib/Boundary";
import { calibrationStatus } from "./lib/Calibration";
import { assertEvaluatorVendor } from "./lib/EvaluatorEgress";
import { ASSAY_RECEIPT_SCHEMA, deriveVerdict, receiptDir, writeReceipt, type AssayReceipt, type IdealStateRef, type ProofFinding } from "./lib/ProofReceipt";

export type Vendor = "openai" | "anthropic";
export type Tier = "low" | "standard" | "high";
export type Severity = "blocker" | "major" | "minor";
/**
 * `covered`: no model call ran because an earlier pass already reviewed this exact state; the record names it in `reusedFrom`.
 * `waived`: shipped past a blocker, an outage or the batch ceiling on --waive-blockers; never a base, never reused.
 * `accepted`: the retired --accept status, read from old records and treated as `waived`; never written.
 */
export type Status = "pass" | "blocked" | "waived" | "skipped" | "covered" | "accepted";

export interface Finding { severity: Severity; file: string; line?: number; summary: string; failure_scenario: string }
export interface Verdict { summary: string; findings: Finding[] }
export interface ReviewRequest { system: string; user: string; vendor: Vendor; level: "medium" | "high" | "max" }
export type ReviewerResult = { ok: true; verdict: Verdict; model: string } | { ok: false; error: string };
export type Reviewer = (req: ReviewRequest) => Promise<ReviewerResult>;

export interface ReviewRecord {
  version: 1; ts: string; repoRoot: string; scope: string; base: string; head: string; dirty: boolean;
  fingerprint: string; stateFingerprint: string; tier: Tier; files: string[]; linesChanged: number; authors: Vendor[];
  reviewerVendors: Vendor[]; reviewerModel?: string; status: Status; summary?: string;
  findings: Finding[]; error?: string; reusedFrom?: string;
  /** --waive-blockers reason: why a blocker, outage or over-ceiling diff shipped. */
  waiveReason?: string;
  /** --allow-dirty reason: why uncommitted files in scope shipped (the model still reviewed them). */
  dirtyReason?: string;
  /** Set on a waived record no model read (the diff was over the batch ceiling). */
  unreviewed?: true;
  /** The retired --accept reason, on old records only. */
  acceptReason?: string;
  /** Which model review of this span this was: 1 for the first since the last pass (or since the last --past-round-cap). */
  round?: number;
  /** Set on a record that blocked at the round cap without calling a model. */
  roundCap?: true;
  /** --past-round-cap reason: the principal let a span past the round cap be reviewed again. */
  pastRoundCap?: string;
  /** Head of the last blocked round, when this later round kept majors and minors only in the files changed since it. */
  focusSince?: string;
  /** The span files changed since `focusSince`. */
  changedFiles?: string[];
  /** Major and minor findings dropped because they were in code unchanged since the last round. */
  droppedFindings?: number;
  /** Changed lines at this span's first blocked round and now, when review fixes grew the change past GROWTH_RATIO. */
  growth?: { from: number; to: number };
}

export interface ReviewOutcome { code: 0 | 1 | 2; message: string; record?: ReviewRecord; /** The assay-receipt/1 written for this run, when one was written. */ receipt?: string; receiptError?: string }

/** Recorded in every Review receipt's evaluators: this file's own `@version` header, the line the bumper moves, so the two cannot drift (8.635.0 audit). */
export const REVIEW_VERSION = readFileSync(import.meta.path, "utf8").match(/@version (\S+)/)?.[1] ?? "unknown";
/** The suite name of the reviewer lane. The lane is earned only when LabelStore.earnedStatus says so for its judge (check_id `calibration:code-review`): the principal's right/wrong labels at the registry's floor and bar, the one definition of earned. Until then a blocker is a flag, never a receipt fail; the deploy exit code is unchanged either way. */
export const REVIEWER_CALIBRATION = "code-review";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const DIFF_BUDGET = 150_000;
/** The ceiling on one review: a diff past it is a runaway, not a deploy, and blocks unless waived. */
export const MAX_BATCHES = 64;
/** At most this many reviewer calls run at once. */
const MAX_CONCURRENT = 8;
/** Characters of ISA one reviewer call reads. A larger ISA is sliced per batch (isaForBatch); until 2026-10-23 it was cut at 20,000, which showed the reviewer 5% of a large app ISA. */
export const ISA_BUDGET = 100_000;
/** Characters of an out-of-scope ISA's own diff shown with the change. */
const ISA_DIFF_BUDGET = 20_000;
/** Blocked model reviews of one span before the next one needs --past-round-cap (Anthropic's code-review post steps back after three; ours is four because, over our 142 blocked spans to 2026-10-23, three would have stopped 30 and 11 of those passed on the next try). */
export const ROUND_CAP = 4;
/**
 * Review loops grow a change one cheap-looking fix at a time (harvest of tstack's sol-loop, 2026-10-26: "If review grew
 * the diff, cut first"). A later round whose change is this much larger than the span's first blocked round, by at least
 * GROWTH_MIN_LINES, is flagged to the reviewer and in the output. It never changes pass or block.
 */
export const GROWTH_RATIO = 1.25;
export const GROWTH_MIN_LINES = 40;

/** The growth to flag, or null: `to` changed lines now against `from` at the first blocked round. Pure. */
export function reviewGrowth(from: number | undefined, to: number): { from: number; to: number } | null {
  if (!from || from <= 0) return null;
  return to >= from * GROWTH_RATIO && to - from >= GROWTH_MIN_LINES ? { from, to } : null;
}
// Lockfile bodies are noise to a reviewer; a changed lockfile is still named in the diff so it is never invisible.
export const EXCLUDES = ["bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "*.map"];
export const HIGH_PATH = /(auth|login|logout|session|oauth|token|secret|passw|crypto|permission|rbac|admin|stripe|payment|checkout|billing|invoice|webhook|migration|schema|\.sql$|wrangler\.(toml|json|jsonc)$|middleware|cors|csp|_headers$|\.env|deploy|dockerfile|\.tf$|\.github\/|package\.json$|cfenv|\.config\.(ts|mts|cts|js|mjs|cjs)$)/i;
const LOW_PATH = /\.(md|mdx|txt|css|scss|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf)$/i;
const OPENAI_AUTHOR = /openai|codex|gpt|\bsol\b|\bterra\b|\bluna\b|astra/i;
const ANTHROPIC_AUTHOR = /anthropic|claude|opus|sonnet|fable|haiku/i;
export const LEVEL: Record<Tier, ReviewRequest["level"]> = { low: "medium", standard: "high", high: "max" };

function git(cwd: string, args: string[], allowFail = false): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    if (allowFail) return "";
    throw new Error(`git ${args.join(" ")}: ${(r.stderr || "").trim()}`);
  }
  return r.stdout;
}
const gitOk = (cwd: string, args: string[]) => spawnSync("git", args, { cwd }).status === 0;

export function stateDir(): string {
  return process.env.LIFEOS_REVIEW_STATE_DIR ?? lifeosPath("MEMORY", "STATE", "reviews");
}

/** The legacy record key: the checkout's path. Every worktree got its own, so records were never shared. Still read. */
export function repoKey(root: string): string {
  return `${basename(root)}-${createHash("sha1").update(root).digest("hex").slice(0, 8)}`;
}

/** The repo's oldest root commit (earliest commit time, then lowest sha when tied), or "" for a repo with no commits. */
export function rootCommit(root: string): string {
  const roots = git(root, ["log", "--max-parents=0", "--format=%ct %H", "HEAD"], true).split("\n").filter(Boolean)
    .map((l) => { const [t, h] = l.split(" "); return { t: Number(t), h: h ?? "" }; })
    .filter((r) => /^[0-9a-f]{40,64}$/.test(r.h))
    .sort((a, b) => a.t - b.t || (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  return roots[0]?.h ?? "";
}

/** The record key for a repo: its root commit, so a worktree and the main checkout read one record set. */
export function repoIdentity(root: string): string {
  const c = rootCommit(root);
  return c ? `root-${c.slice(0, 16)}` : repoKey(root);
}

/** Where this repo's records are written (its identity) and every directory they are read from (identity plus each worktree's legacy path key). */
export function recordDirs(root: string): { write: string; read: string[] } {
  const write = join(stateDir(), repoIdentity(root));
  const paths = new Set([root]);
  for (const l of git(root, ["worktree", "list", "--porcelain"], true).split("\n")) {
    if (!l.startsWith("worktree ")) continue;
    const p = l.slice("worktree ".length);
    try { paths.add(realpathSync(p)); } catch { paths.add(p); }
  }
  return { write, read: [...new Set([write, ...[...paths].map((p) => join(stateDir(), repoKey(p)))])] };
}

export function classifyTier(files: string[], linesChanged: number): Tier {
  if (files.some((f) => HIGH_PATH.test(f)) || linesChanged > 1500) return "high";
  if (files.length > 0 && files.every((f) => LOW_PATH.test(f)) && linesChanged < 400) return "low";
  return "standard";
}

export function authorVendors(messages: string): Vendor[] {
  const out = new Set<Vendor>();
  for (const m of messages.matchAll(/^co-authored-by:\s*(.+)$/gim)) {
    if (OPENAI_AUTHOR.test(m[1])) out.add("openai");
    else if (ANTHROPIC_AUTHOR.test(m[1])) out.add("anthropic");
  }
  return [...out].sort();
}

/** Reviewers are the vendors that did NOT write the code; when both wrote it, each reviews it. Claude is the default author. */
export function reviewersFor(authors: Vendor[]): Vendor[] {
  if (authors.includes("openai") && authors.includes("anthropic")) return ["anthropic", "openai"];
  return authors.length > 0 && authors.every((a) => a === "openai") ? ["anthropic"] : ["openai"];
}

/** Every record across `dirs`, oldest first (file names start with the ISO timestamp). */
function readRecords(dirs: string[]): Array<ReviewRecord & { _file: string }> {
  const out: Array<ReviewRecord & { _file: string }> = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      try { out.push({ ...(JSON.parse(readFileSync(join(dir, f), "utf8")) as ReviewRecord), _file: f }); } catch { /* unreadable record is skipped */ }
    }
  }
  return out.sort((a, b) => (a._file < b._file ? -1 : a._file > b._file ? 1 : 0));
}

/** A record that moves the base. A waived record (or a legacy accepted one) never does: its span was not cleared. */
const passed = (r: ReviewRecord) => r.status === "pass" || r.status === "covered";
/** A record whose span is still owed a review: a skip, a block, or a waiver since the last pass. */
const uncleared = (r: ReviewRecord) => r.status === "skipped" || r.status === "blocked" || r.status === "waived" || r.status === "accepted";
/** A record whose state a model actually reviewed and passed (directly, or through the pass a `covered` record reused). Only these are reused, so a waived span never becomes coverage. */
const reviewedPass = (r: ReviewRecord) => r.status === "pass" || r.status === "covered";

const reachable = (root: string, c: string) => c === EMPTY_TREE || gitOk(root, ["merge-base", "--is-ancestor", c, "HEAD"]);

/** Index in `mine` of the last pass on HEAD's own line, or -1. Records are shared across worktrees, so a newer pass on another branch must not end the search: it would hide a waiver this branch still owes. */
function lastPassIndex(root: string, mine: ReviewRecord[]): number {
  return mine.findLastIndex((r) => passed(r) && reachable(root, r.dirty ? r.base : r.head));
}

export function pickBase(root: string, scope: string, records: ReviewRecord[]): string {
  const mine = records.filter((r) => r.scope === scope);
  const lastPassIdx = lastPassIndex(root, mine);
  // A skip, block or waiver since the last pass left its span uncleared; start from its base.
  const pending = mine.slice(lastPassIdx + 1).find((r) => uncleared(r) && reachable(root, r.base));
  if (pending) return pending.base;
  const last = lastPassIdx >= 0 ? mine[lastPassIdx] : undefined;
  // A pass over uncommitted work cleared that tree, not HEAD; only a clean pass moves the base to HEAD.
  if (last && !last.dirty && reachable(root, last.head)) return last.head;
  if (last && last.dirty && reachable(root, last.base)) return last.base;
  const up = git(root, ["rev-parse", "--verify", "-q", "@{upstream}"], true).trim();
  if (up) return up;
  // A local branch or fresh worktree with no upstream: review everything since it left the
  // remote's main line. HEAD~1 alone passed a multi-commit branch after reading only its last commit.
  const head = git(root, ["rev-parse", "HEAD"], true).trim();
  for (const ref of ["origin/HEAD", "origin/main", "origin/master"]) {
    if (!git(root, ["rev-parse", "--verify", "-q", ref], true).trim()) continue;
    const fork = git(root, ["merge-base", "HEAD", ref], true).trim();
    if (fork && fork !== head) return fork;
  }
  const prev = git(root, ["rev-parse", "--verify", "-q", "HEAD~1"], true).trim();
  return prev || EMPTY_TREE;
}

/**
 * The model reviews that blocked this span (same scope and base) since the last pass on HEAD's line, counted from the
 * latest --past-round-cap review when there is one, which starts a fresh count. Over-ceiling and round-cap records
 * called no model, so they are not rounds.
 */
export function blockedRounds<R extends ReviewRecord>(root: string, scope: string, base: string, records: R[]): R[] {
  const mine = records.filter((r) => r.scope === scope);
  // Only rounds on HEAD's own line: records are shared across worktrees, and a sibling branch blocked at the same base
  // must not cap this one (2026-10-23 checker).
  let span = mine.slice(lastPassIndex(root, mine) + 1).filter((r) => r.base === base && reachable(root, r.head));
  const lift = span.findLastIndex((r) => !!r.pastRoundCap);
  if (lift >= 0) span = span.slice(lift);
  return span.filter((r) => r.status === "blocked" && !r.roundCap && !!r.reviewerModel);
}

const MAX_COVER_HEADS = 20;

/**
 * The latest clean reviewed pass, at `scope` or a parent of it (the repo root covers every subdirectory), whose head is
 * an ancestor of HEAD and from whose head nothing in `scope` has changed, working tree included. That state was already
 * reviewed, so no model call is needed. A pass over uncommitted work reviewed that tree, not its head, so it never covers.
 */
export function coveringPass<R extends ReviewRecord>(root: string, scope: string, records: R[]): R | undefined {
  const covers = (s: string) => s === scope || s === "." || scope.startsWith(`${s}/`);
  const seen = new Set<string>();
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    if (!reviewedPass(r) || r.dirty || !covers(r.scope) || r.head === EMPTY_TREE || seen.has(r.head)) continue;
    if (seen.size >= MAX_COVER_HEADS) break;
    seen.add(r.head);
    if (!reachable(root, r.head)) continue;
    if (!collectDiff(root, scope, r.head).text.trim()) return r;
  }
  return undefined;
}

/**
 * Changed files the repo marks `linguist-generated` in .gitattributes: build outputs such as a
 * search index or a compiled redirect map, often one multi-megabyte line. They get the lockfile
 * treatment: named with a hash, body not shown. The .gitattributes line that marks them is
 * ordinary source, so marking a file generated is itself reviewed.
 */
function generatedPaths(root: string, scope: string, base: string): string[] {
  const changed = [...new Set([
    ...git(root, ["diff", "--name-only", base, "--", scope], true).split("\n"),
    ...git(root, ["ls-files", "--others", "--exclude-standard", "--", scope], true).split("\n"),
  ])].filter(Boolean);
  if (changed.length === 0) return [];
  const marker = ": linguist-generated: ";
  return git(root, ["check-attr", "linguist-generated", "--", ...changed], true).split("\n")
    .filter((l) => l.endsWith(`${marker}set`) || l.endsWith(`${marker}true`))
    .map((l) => l.slice(0, l.lastIndexOf(marker)));
}

/**
 * Uncommitted paths under `scope` (modified, staged, deleted or untracked), minus files
 * .gitattributes marks linguist-generated: those are build outputs the deploy script
 * regenerates, so they differ after every build. A deploy ships committed code only, so
 * anything else here blocks it (2026-09-30: the review and cf both read the working tree,
 * which let a peer session's half-written files ship inside another session's deploy).
 */
export function uncommittedPaths(root: string, scope: string): string[] {
  const paths = git(root, ["status", "--porcelain", "--untracked-files=all", "--", scope]).split("\n").filter(Boolean)
    .map((l) => l.slice(3).split(" -> ").at(-1)!.replace(/^"(.*)"$/, "$1"));
  if (paths.length === 0) return [];
  const marker = ": linguist-generated: ";
  const generated = new Set(git(root, ["check-attr", "linguist-generated", "--", ...paths], true).split("\n")
    .filter((l) => l.endsWith(`${marker}set`) || l.endsWith(`${marker}true`))
    .map((l) => l.slice(0, l.lastIndexOf(marker))));
  return paths.filter((p) => !generated.has(p));
}

/** The exact text the reviewer reads: base to the working tree, scoped. Exported so a past review's input can be rebuilt (review-miss-evals F3). */
export function collectDiff(root: string, scope: string, base: string) {
  const generated = generatedPaths(root, scope, base);
  const spec = ["--", scope, ...EXCLUDES.map((e) => `:(exclude,glob)**/${e}`), ...generated.map((g) => `:(exclude,literal)${g}`)];
  const tracked = git(root, ["diff", "--no-color", "--no-ext-diff", "-U5", base, ...spec]);
  const names = git(root, ["diff", "--name-only", base, ...spec]).split("\n").filter(Boolean);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", ...spec]).split("\n").filter(Boolean);
  let extra = "";
  for (const f of untracked) {
    const p = join(root, f);
    const st = lstatSync(p);
    // A symlink is reviewed as the link git would commit, never by reading its target (which may be a secret outside the repo).
    if (st.isSymbolicLink()) { extra += `\ndiff --git a/${f} b/${f}\nnew symlink (untracked) → ${readlinkSync(p)}\n`; continue; }
    if (!st.isFile()) continue;
    const raw = readFileSync(p);
    const body = raw.toString("utf8");
    if (body.includes("\u0000")) { extra += `\ndiff --git a/${f} b/${f}\nnew binary file (untracked), sha256 ${createHash("sha256").update(raw).digest("hex").slice(0, 16)}\n`; continue; }
    extra += `\ndiff --git a/${f} b/${f}\nnew file (untracked)\n+++ b/${f}\n${body.split("\n").map((l) => `+${l}`).join("\n")}\n`;
  }
  let lines = 0;
  for (const l of git(root, ["diff", "--numstat", base, ...spec]).split("\n")) {
    const [a, d] = l.split("\t");
    lines += (Number(a) || 0) + (Number(d) || 0);
  }
  for (const f of untracked) { try { if (lstatSync(join(root, f)).isFile()) lines += readFileSync(join(root, f), "utf8").split("\n").length; } catch { /* unreadable counts as zero */ } }
  const lockSpec = ["--", ...EXCLUDES.map((e) => `:(glob)${scope === "." ? "" : scope + "/"}**/${e}`)];
  const locks = [...new Set([
    ...git(root, ["diff", "--name-only", base, ...lockSpec], true).split("\n"),
    ...git(root, ["ls-files", "--others", "--exclude-standard", ...lockSpec], true).split("\n"),
  ])].filter(Boolean);
  const lockHash = (l: string) => existsSync(join(root, l)) ? createHash("sha256").update(readFileSync(join(root, l))).digest("hex").slice(0, 16) : "deleted";
  const lockNote = locks.map((l) => `\ndiff --git a/${l} b/${l}\n(dependency lockfile changed, now ${lockHash(l)}; body not shown. Check the matching package.json change.)\n`).join("");
  const genNote = generated.map((g) => `\ndiff --git a/${g} b/${g}\n(generated file per .gitattributes, now ${lockHash(g)}; body not shown. Review the source that generates it.)\n`).join("");
  return { text: tracked + extra + lockNote + genNote, files: [...names, ...untracked, ...locks, ...generated], lines };
}

/** Splits the diff into batches under the budget, high-risk files first; a file too big for one batch is split by lines with its header repeated. Nothing is dropped. */
export function batchDiff(text: string, budget = DIFF_BUDGET): string[] {
  const chunks = text.split(/(?=^diff --git )/m).filter(Boolean);
  chunks.sort((a, b) => Number(HIGH_PATH.test(b.split("\n")[0])) - Number(HIGH_PATH.test(a.split("\n")[0])));
  const pieces: string[] = [];
  for (const c of chunks) {
    if (c.length <= budget) { pieces.push(c); continue; }
    const [header, ...lines] = c.split("\n");
    let cur = "", part = 1;
    const flush = () => { if (cur) pieces.push(`${header} (part ${part++})\n${cur}`); cur = ""; };
    const room = budget - header.length - 20;
    for (const whole of lines) {
      for (let i = 0; i === 0 || i < whole.length; i += room) {
        const l = whole.slice(i, i + room);
        if (cur.length + l.length + 1 > room) flush();
        cur += l + "\n";
      }
    }
    flush();
  }
  const batches: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (cur && cur.length + p.length > budget) { batches.push(cur); cur = ""; }
    cur += p;
  }
  if (cur) batches.push(cur);
  return batches;
}

function isaPath(root: string, scope: string): string | null {
  for (const p of [join(root, scope, "ISA.md"), join(root, "ISA.md")]) if (existsSync(p)) return p;
  return null;
}

export interface IsaSource { path: string; text: string; fromBase: boolean; diff: string }

/**
 * The ISA the change is judged by: its copy at `base`, so a change cannot rewrite the rules it is checked against.
 * Its own edits reach the reviewer as part of the change: inside the scope they are already in the diff; outside it
 * they ride along as `diff`. An ISA new in this span has no base copy, so the working tree copy is read.
 */
export function isaAt(root: string, scope: string, base: string): IsaSource | null {
  // Every candidate is tried at the base first, so a change cannot shadow the base ISA by adding a closer one, and a
  // deleted ISA still judges the change that deleted it (2026-10-23 checker). Only an ISA new in the span reads the tree.
  const rels = [...new Set([join(scope, "ISA.md"), "ISA.md"].map((p) => p.replace(/^\.\//, "")))];
  const outOfScope = rels.filter((r) => !(scope === "." || r.startsWith(`${scope}/`)));
  for (const rel of base === EMPTY_TREE ? [] : rels) {
    // A blob, never a symlink: `git show` of a link prints its target path, not an ISA.
    if (git(root, ["cat-file", "-t", `${base}:${rel}`], true).trim() !== "blob" || git(root, ["ls-tree", base, "--", rel], true).startsWith("120000")) continue;
    const text = git(root, ["show", `${base}:${rel}`], true);
    if (!text) continue;
    let diff = outOfScope.map((r) => git(root, ["diff", "--no-color", "--no-ext-diff", "-U3", base, "--", r], true)).join("");
    if (diff.length > ISA_DIFF_BUDGET) diff = `${diff.slice(0, ISA_DIFF_BUDGET)}\n(ISA diff cut at ${ISA_DIFF_BUDGET} characters)`;
    return { path: join(root, rel), text, fromBase: true, diff };
  }
  const path = isaPath(root, scope);
  return path ? { path, text: readFileSync(path, "utf8"), fromBase: false, diff: "" } : null;
}

export interface IsaSection { heading: string; text: string }

/** Splits an ISA at its `##` and `###` headings (outside code fences). The text before the first heading is the "" section. */
export function isaSections(md: string): IsaSection[] {
  const out: IsaSection[] = [];
  let cur: { heading: string; lines: string[] } = { heading: "", lines: [] };
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^#{2,3} /.test(line)) {
      out.push({ heading: cur.heading, text: cur.lines.join("\n") });
      cur = { heading: line.replace(/^#+\s*/, ""), lines: [line] };
      continue;
    }
    cur.lines.push(line);
  }
  out.push({ heading: cur.heading, text: cur.lines.join("\n") });
  return out.filter((s) => s.text.trim());
}

/** Size past which a section is cut into pieces that are chosen one by one, so one huge section is never all or nothing. */
const SECTION_PIECE = 5_000;

/** A section over SECTION_PIECE becomes line-aligned pieces under its heading, each marked as a continuation. */
function pieces(s: IsaSection): IsaSection[] {
  if (s.text.length <= SECTION_PIECE) return [s];
  const out: IsaSection[] = [];
  let cur = "";
  const flush = () => { if (cur) out.push({ heading: s.heading, text: out.length ? `(${s.heading || "preamble"}, continued)\n${cur}` : cur }); cur = ""; };
  for (const line of s.text.split("\n")) {
    if (cur && cur.length + line.length + 1 > SECTION_PIECE) flush();
    cur += (cur ? "\n" : "") + line.slice(0, SECTION_PIECE);
  }
  flush();
  return out;
}

/**
 * Sections every batch gets from an ISA too big to send whole. ISAFormat § "Who reads an ISA at deploy" lists the same
 * names, and a test fails when the two differ, so changing what the reviewer reads changes the ISA system with it.
 */
export const ALWAYS_SENT_SECTIONS = ["Ideal State", "L3", "L2", "Vision", "Out of scope", "Anti-criteria"] as const;
// Built from the list, so the list is what the code sends. Headings match exactly; the ladder rungs match
// `L3 · One sentence`, never `L2.10 · …` (Vector numbers criteria that way).
export const ALWAYS_SENT = new RegExp(`^(?:${ALWAYS_SENT_SECTIONS.map((n) => /^L\d$/.test(n) ? `${n}\\s*(?:[·:—-]|$)` : `${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`).join("|")})`, "i");
const GENERIC_SEGMENTS = new Set(["src", "lib", "app", "apps", "packages", "components", "component", "test", "tests", "index", "utils", "util", "public", "dist", "scripts", "pages", "routes", "types", "main", "readme", "assets", "static", "styles"]);

/** What ties an ISA section to a batch: its changed file paths and path segments, and the code identifiers on its +/- lines. */
export function diffTerms(diffPart: string): { paths: string[]; idents: string[] } {
  const paths = new Set<string>();
  for (const m of diffPart.matchAll(/^diff --git a\/(.+?) b\//gm)) {
    const f = m[1]!;
    paths.add(f.toLowerCase());
    for (const seg of f.split("/")) for (const t of [seg, seg.replace(/\.[^.]+$/, "")]) if (t.length >= 4 && !GENERIC_SEGMENTS.has(t.toLowerCase())) paths.add(t.toLowerCase());
  }
  const counts = new Map<string, number>();
  for (const l of diffPart.split("\n")) {
    if (!/^[+-]/.test(l) || /^(?:\+\+\+|---) /.test(l)) continue;
    // camelCase, PascalCase with two words, or snake_case: names, not prose words
    for (const m of l.matchAll(/[A-Za-z_$][\w$]{4,}/g)) if (/[a-z0-9][A-Z]|[A-Za-z]_[A-Za-z]/.test(m[0])) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  }
  const idents = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 200).map(([w]) => w);
  return { paths: [...paths], idents };
}

/**
 * The ISA text one batch's reviewer reads. An ISA within `budget` goes whole. A larger one goes as the always-sent
 * sections plus the sections that name this batch's files or identifiers, best match first, within the budget, in
 * document order, under a note saying it is an excerpt.
 */
export function isaForBatch(isa: string, diffPart: string, budget = ISA_BUDGET): string {
  if (isa.length <= budget) return isa;
  const whole = isaSections(isa);
  const sections = whole.flatMap((s, i) => pieces(s).map((p) => ({ ...p, preamble: i === 0 && s.heading === "" && s.text.length <= 4000 })));
  const { paths, idents } = diffTerms(diffPart);
  // The note and the joins come out of the budget, so the excerpt never runs past it.
  const room = budget - 600;
  const scored = sections.map((s, i) => {
    const always = ALWAYS_SENT.test(s.heading) || s.preamble;
    const low = s.text.toLowerCase();
    const score = 5 * paths.filter((p) => low.includes(p)).length + idents.filter((w) => s.text.includes(w)).length;
    return { i, s, always, score };
  });
  const order = [...scored.filter((x) => x.always), ...scored.filter((x) => !x.always && x.score > 0).sort((a, b) => b.score - a.score || a.i - b.i)];
  const keep = new Set<number>();
  let used = 0;
  for (const x of order) {
    if (used + x.s.text.length + 2 > room) continue;
    keep.add(x.i);
    used += x.s.text.length + 2;
  }
  const kept = scored.filter((x) => keep.has(x.i));
  const n = (v: number) => v.toLocaleString("en-US");
  const note = `(Excerpt: this ISA is ${n(isa.length)} characters, more than the ${n(budget)} a review reads, so this is ${n(used)} characters of it: the ladder, Vision, Out of scope and Anti-criteria, then the passages that name this part's changed files or code. Criteria not shown were not checked against this part.)`;
  return [note, ...kept.map((x) => x.s.text)].join("\n\n");
}

const sha256 = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");

/** Whether the reviewer lane has earned the right to fail an artifact on its own judgment: calibrationStatus derives `earned` from LabelStore.earnedStatus (principal labels only). Never throws; unknown reads as not earned. */
function reviewerLaneEarned(): boolean {
  try {
    return calibrationStatus(REVIEWER_CALIBRATION).earned === true;
  } catch { return false; }
}

/**
 * The review as an assay-receipt/1 (ISC-1): bound to the sha256 of the reviewed diff, which is kept as a 0600 file under
 * the receipt store's artifacts area so the receipt's artifact path names real bytes. destination "deploy".
 * A blocker is a judge-tier fail only when the reviewer lane is earned; otherwise a flag. Either way the deploy gate
 * is the review's exit code, unchanged: this receipt records the review and never decides it. A diff too large to review
 * is a code-tier fail (deterministic); a reviewer outage is an unavailable finding.
 */
export function writeReviewReceipt(o: {
  rec: ReviewRecord; diffText: string; isaFile: string | null; /** The ISA text the reviewer was given (the base copy); its hash is the receipt's revision. Defaults to the file on disk. */ isaText?: string; earned?: boolean; passedBatches: number; outage?: string; tooLarge?: string; durationMs?: number;
}): string {
  const { rec } = o;
  const earned = o.earned ?? reviewerLaneEarned();
  const dir = join(receiptDir(), "artifacts");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const artifact = join(dir, `review-${rec.fingerprint}.diff`);
  writeFileSync(artifact, o.diffText, { mode: 0o600 });
  chmodSync(artifact, 0o600);
  invariant(sha256(readFileSync(artifact)) === rec.fingerprint, "the stored diff must hash to the review fingerprint");
  const findings: ProofFinding[] = [];
  if (o.tooLarge) findings.push({ check: "review:diff-size", tier: "code", severity: "fail", message: o.tooLarge });
  if (o.outage) findings.push({ check: "review:reviewer", tier: "judge", severity: "unavailable", message: `reviewer unavailable: ${o.outage}` });
  for (const f of rec.findings) {
    if (o.tooLarge && f.summary === o.tooLarge) continue;
    const where = `${f.file}${f.line ? `:${f.line}` : ""}`;
    const blocker = f.severity === "blocker";
    const message = `${f.severity} at ${where}: ${f.summary} (${f.failure_scenario})${blocker ? ` — deploy ${rec.status === "waived" ? "waived with a reason" : "blocked"} by Review.ts${earned ? "" : "; reviewer lane not earned, recorded as a flag"}` : ""}`;
    findings.push({ check: `review:${f.severity}:${where}`, tier: "judge", severity: blocker && earned ? "fail" : "flag", earned: blocker && earned, message });
  }
  const { verdict, counts } = deriveVerdict(findings, o.passedBatches, ASSAY_RECEIPT_SCHEMA);
  const ideal_state: IdealStateRef = o.isaFile
    ? { kind: "isa", path: o.isaFile, revision: sha256(o.isaText ?? readFileSync(o.isaFile)) }
    : { kind: "none", reason: "no ISA found for this project" };
  const evaluators: Record<string, string> = { review: REVIEW_VERSION };
  if (rec.reviewerModel) evaluators.reviewer = rec.reviewerModel;
  else evaluators.reviewer_vendors = rec.reviewerVendors.join("+");
  const receipt: AssayReceipt = {
    schema: ASSAY_RECEIPT_SCHEMA, artifact, sha256: rec.fingerprint, size: Buffer.byteLength(o.diffText), mtimeMs: Date.now(), kind: "text",
    ran_at: rec.ts, run_id: randomUUID(), duration_ms: o.durationMs ?? 0, checks_file: null, profile: ["review"],
    verdict, counts, findings, opt_outs: [],
    ideal_state, check_set: { version: sha256(SYSTEM_PROMPT + "\n" + REVIEW_VERSION), source: null },
    evaluators, destination: "deploy", verdict_at_boundary: { verdict, counts, findings: findings.length, at: rec.ts },
  };
  return writeReceipt(receipt);
}

/** A receipt is a record, never the deploy decision: a failure to write one is reported and never changes the exit code. */
function recordReceipt(o: Parameters<typeof writeReviewReceipt>[0]): { receipt?: string; receiptError?: string } {
  try { return { receipt: writeReviewReceipt(o) }; }
  catch (e) { const receiptError = e instanceof Error ? e.message : String(e); console.error(`review: receipt not written — ${receiptError}`); return { receiptError }; }
}

export const SYSTEM_PROMPT = `You are the independent reviewer for a change that is about to deploy to production. You did not write it.

Report only defects a real user, caller, or operator would hit if this deployed now: wrong behavior, crashes, security exposure, data loss or corruption, broken builds or deploys, and code that contradicts the project's ISA criteria when an ISA is given. Style, naming, and taste are not findings.

Severity:
- blocker: deploying this now would ship the defect. You can name the input or state that triggers it.
- major: a likely defect or a clear contract violation, but you cannot show it triggering.
- minor: worth knowing; at most five.

Every finding names the file, the line in the new version when you can, and a concrete failure scenario (input or state → wrong result). If you are unsure a blocker is real, call it major. An empty findings list is a valid answer.

When a defect is one instance of a pattern, report it once as a class: the file and line of the first instance, and every other place in the diff it occurs listed in the summary, so it is fixed everywhere in one pass.

Return JSON only: {"summary": "<one sentence>", "findings": [{"severity": "blocker|major|minor", "file": "...", "line": 0, "summary": "...", "failure_scenario": "..."}]}`;

export function buildUserPrompt(o: { scope: string; tier: Tier; files: string[]; diff: string; isa: string; part?: string; isaFromBase?: boolean; isaDiff?: string; prior?: { rounds: number; findings: Finding[] }; focus?: { since: string; changed: string[] }; growth?: { from: number; to: number } }): string {
  const isaHead = o.isaFromBase
    ? "## Project ISA as it stood before this change (what the software must do)\n\nIf the change edits the ISA, judge that edit as part of the change: a criterion loosened or removed so the new code passes it is a finding."
    : "## Project ISA (what the software must do)";
  const prior = o.prior && o.prior.findings.length
    ? `## Earlier rounds on this span\n\nThis span was reviewed and blocked ${o.prior.rounds} time(s) before. Those reviews reported the findings below. Report one again only if this diff still has it, and when one was an instance of a wider class, find every instance now.\n\n${o.prior.findings.map((f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""} — ${f.summary}`).join("\n")}`
    : "";
  return [
    `Risk tier: ${o.tier}. Scope: ${o.scope}. Files changed (${o.files.length}): ${o.files.join(", ")}${o.part ? `\nThis is ${o.part} of the diff; the other parts are reviewed separately, so judge only what is shown.` : ""}`,
    o.isa ? `${isaHead}\n\n${o.isa}` : "No ISA found for this project.",
    o.isaDiff ? `## ISA changes in this span (the ISA sits outside the deploy scope)\n\n${o.isaDiff}` : "",
    prior,
    o.growth ? `## The change grew under review\n\nThe first blocked round on this span reviewed ${o.growth.from} changed lines; this one has ${o.growth.to}. Report as a major any code, test, guard or option added since then that the intent does not need, with the smaller fix that would do instead.` : "",
    o.focus ? `## Changed since the last round\n\nEarlier rounds read this whole span. Since the last round (${o.focus.since.slice(0, 7)}) these files changed: ${o.focus.changed.length ? o.focus.changed.join(", ") : "none"}. Report majors and minors only in those files. Everywhere in the diff, report a blocker: an earlier finding still present, another instance of its class, or any defect that ships if this deploys now.` : "",
    `## Diff (base → working tree)\n\n${o.diff}`,
  ].filter(Boolean).join("\n\n");
}

/**
 * Anthropic's fix for its 50-round PR (59% of what its reviewer kept re-flagging was code present since the first pass):
 * after the first round, new findings come only from what changed. Every round still reads the whole span, so a pass
 * still means no blocker anywhere in it; a later round keeps a blocker wherever it is, and keeps majors and minors only
 * in the span files changed since the last blocked round. Returns null, meaning keep everything, when there is no
 * earlier round, when any round had a reviewer error or ran on uncommitted work (its head is not what it read), or when
 * the last head is not on this line.
 */
export function changedSinceLastRound(root: string, scope: string, rounds: ReviewRecord[], spanFiles: string[]): { files: string[]; since: string } | null {
  const last = rounds.at(-1);
  if (!last || last.head === EMPTY_TREE || rounds.some((r) => !!r.error || r.dirty) || !reachable(root, last.head)) return null;
  const changed = new Set([
    ...git(root, ["diff", "--name-only", "--no-renames", last.head, "--", scope], true).split("\n"),
    ...git(root, ["ls-files", "--others", "--exclude-standard", "--", scope], true).split("\n"),
  ].filter(Boolean));
  return { files: spanFiles.filter((f) => changed.has(f)), since: last.head };
}

/** A reviewer may name a file relative to the scope rather than the repo root; match either way. */
const samePath = (f: string, g: string) => g === f || f.endsWith(`/${g}`) || g.endsWith(`/${f}`);

/** The blocker and major findings earlier rounds reported, each once, at most 40. */
function priorFindings(rounds: ReviewRecord[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const r of rounds) for (const f of r.findings) {
    const key = `${f.severity}|${f.file}|${f.summary}`;
    if (f.severity === "minor" || seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out.slice(0, 40);
}

export function parseVerdict(raw: unknown): Verdict | null {
  const v = raw as Verdict;
  if (!v || typeof v !== "object" || !Array.isArray(v.findings)) return null;
  const sev = new Set(["blocker", "major", "minor"]);
  const findings = v.findings.filter((f) => f && sev.has(f.severity) && typeof f.file === "string" && typeof f.summary === "string");
  if (findings.length !== v.findings.length) return null;
  return { summary: typeof v.summary === "string" ? v.summary : "", findings };
}

// The reviewer is a judge, so its model call goes through Assay's one judge transport (AssaySystem.md
// § One judge transport). One shared import: batches review in parallel, and concurrent dynamic imports
// of the transport (Inference underneath is an async module graph since HAI-5) hand every caller but the
// first a module still evaluating, so each threw "Cannot access 'INFERENCE_DISABLED_FLAG' before
// initialization" (Bun 1.3, 2026-10-08).
let judgeModule: Promise<typeof import("../ASSAY/JudgeCall")> | null = null;

export const defaultReviewer: Reviewer = async (req) => {
  try { assertEvaluatorVendor(req.vendor, "review"); } catch (e) { return { ok: false, error: (e as Error).message }; }
  const { judgeText } = await (judgeModule ??= import("../ASSAY/JudgeCall"));
  // Secret values never leave for a vendor: the diff can carry an uncommitted credential file (--allow-dirty), so the prompt is masked here, at the one place it is sent.
  const r = await judgeText({ systemPrompt: req.system, userPrompt: redact(req.user), level: req.level, vendor: req.vendor, allowVendorFallback: false, expectJson: true, timeout: 600_000 });
  let error: string;
  if (!r.success) error = r.error ?? "reviewer failed";
  else if (r.vendor !== req.vendor) error = `reviewer ran on ${r.vendor}, not ${req.vendor}`;
  else {
    const verdict = parseVerdict(r.parsed);
    if (verdict) return { ok: true, verdict, model: r.executedModel ?? req.vendor };
    error = "reviewer returned no valid verdict";
  }
  // The non-author vendor could not answer (out of plan, down, unparseable). Google is the third trusted vendor and wrote
  // none of the code either, so the review runs there instead of stopping (principal directive, 2026-10-16: fall back to a different model).
  return thirdVendorReview(req, error);
};

async function thirdVendorReview(req: ReviewRequest, firstError: string): Promise<ReviewerResult> {
  try { assertEvaluatorVendor("google", "review"); } catch (e) { return { ok: false, error: `${req.vendor}: ${firstError}; google: ${(e as Error).message}` }; }
  const { judgeText, strongestJudge, vendorOf } = await (judgeModule ??= import("../ASSAY/JudgeCall"));
  const r = await judgeText({ systemPrompt: req.system, userPrompt: redact(req.user), level: req.level, model: strongestJudge("google"), allowVendorFallback: false, expectJson: true, timeout: 600_000 });
  if (!r.success) return { ok: false, error: `${req.vendor}: ${firstError}; google: ${r.error ?? "failed"}` };
  // The record names the model that answered, so it must be a Google model: an answer from the author's vendor
  // (a transport that fell back) is refused, the same rule the primary path holds.
  if (!r.executedModel || vendorOf(r.executedModel) !== "google" || r.modelDowngraded) return { ok: false, error: `${req.vendor}: ${firstError}; google: reviewer ran on ${r.executedModel ?? r.vendor ?? "an unknown model"}, not google` };
  const text = r.output.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "");
  let parsed: unknown = r.parsed;
  if (parsed === undefined) { try { parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { parsed = undefined; } }
  const verdict = parseVerdict(parsed);
  return verdict ? { ok: true, verdict, model: `google:${r.executedModel ?? "gemini"}` } : { ok: false, error: `${req.vendor}: ${firstError}; google: no valid verdict` };
}

function writeRecord(dir: string, rec: ReviewRecord): string {
  // `accepted` is the retired --accept status: read from old records, never written.
  invariant(["pass", "blocked", "waived", "skipped", "covered"].includes(rec.status), `review status ${rec.status}`);
  invariant(rec.acceptReason === undefined, "the retired --accept reason is never written");
  invariant(rec.status !== "covered" || (!!rec.reusedFrom && rec.reusedFrom.endsWith(".json")), "a covered review names the record file it reused");
  invariant(/^[0-9a-f]{64}$/.test(rec.fingerprint) && /^[0-9a-f]{64}$/.test(rec.stateFingerprint), "review fingerprints must be sha256 hex");
  invariant(rec.base.length > 0 && rec.head.length > 0, "review base and head are required");
  invariant(rec.status !== "waived" || !!rec.waiveReason?.trim(), "a waived review carries its reason");
  invariant(rec.unreviewed === undefined || rec.status === "waived", "only a waived review can be unreviewed");
  invariant(rec.status !== "pass" || !rec.findings.some((f) => f.severity === "blocker"), "a pass carries no blocker");
  invariant(rec.roundCap === undefined || (rec.status === "blocked" && !rec.reviewerModel), "a round-cap record blocks without a model call");
  invariant(rec.pastRoundCap === undefined || rec.pastRoundCap.trim().length > 0, "--past-round-cap carries a reason");
  invariant(rec.round === undefined || (Number.isInteger(rec.round) && rec.round >= 1), "a review round is a positive integer");
  invariant(rec.focusSince === undefined || (/^[0-9a-f]{40}$/.test(rec.focusSince) && (rec.round ?? 0) > 1), "a focused round names its predecessor's commit and is not a first round");
  invariant((rec.changedFiles === undefined && rec.droppedFindings === undefined) || rec.focusSince !== undefined, "changed files and dropped findings belong to a focused round");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${rec.ts.replace(/[:.]/g, "-")}-${rec.head.slice(0, 7)}-${rec.status}.json`);
  writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
  recordToStatvs(dir, rec, file);
  return file;
}

// ── the STATVS review stream (review-miss-evals ISA F1) ─────────────────────────
// Every record is also one row in stream `review`, written after the decision, so a later miss can be joined to the
// review that passed it and that review replayed. The row carries finding metadata and a pointer to the record, never
// diff text: a credential-shaped string in a diff would get the whole row refused by the STATVS writer.

type StatvsAppend = (input: { writer: string; stream: string; class: string; kind: string; title: string; data: unknown }) => unknown;
let statvsAppend: StatvsAppend | null = null;
let statvsWriter: StatvsAppend | null = null;

/** The default writer: appends to STATVS. Under `bun test` it reaches a record only through an explicit STATVS_DIR (ISC-4). */
export const defaultReviewStatvsWriter: StatvsAppend = (input) => {
  if (process.env.NODE_ENV === "test" && !process.env.STATVS_DIR) return false;
  statvsAppend ??= (require("../STATVS/lib/record") as { append: StatvsAppend }).append;
  return statvsAppend(input);
};

/** Swap the row writer. Test use; null restores the default. */
export function setReviewStatvsWriter(fn: StatvsAppend | null): void { statvsWriter = fn; }

let secretCheck: ((text: string, opts?: { slugs?: boolean }) => string | null) | null = null;
/** One field the STATVS writer would refuse is withheld, so the rest of the review is still recorded. Prose gets the strict check; a path gets the record's own slug-aware one (a record can carry a long path segment). */
const withheld = (text: string, path = false): string => {
  secretCheck ??= (require("../STATVS/lib/refuse") as { credentialRefusal: (t: string, o?: { slugs?: boolean }) => string | null }).credentialRefusal;
  return secretCheck(text, { slugs: path }) ? "[withheld: secret-shaped text]" : text;
};

// STATVS refuses any 40+ hex run as credential-shaped, and a full commit id or sha256 is one, so the row carries git's
// short form: 12 hex resolves with `git rev-parse` in the repo, 16 hex finds the receipt's `review-<fingerprint>.diff`.
const shortId = (h: string): string => h.slice(0, 12);
const shortPrint = (h: string): string => h.slice(0, 16);

/** Never throws and never changes the review's outcome (ISC-3). */
function recordToStatvs(dir: string, rec: ReviewRecord, file: string): void {
  try {
    const data = {
      status: rec.status, recordKey: basename(dir), repoName: withheld(basename(rec.repoRoot), true), repoRoot: withheld(rec.repoRoot, true), scope: withheld(rec.scope, true), base: shortId(rec.base), head: shortId(rec.head), dirty: rec.dirty,
      tier: rec.tier, files: rec.files.length, linesChanged: rec.linesChanged, authors: rec.authors, reviewerVendors: rec.reviewerVendors,
      reviewerModel: rec.reviewerModel ?? null, reviewVersion: REVIEW_VERSION, fingerprint: shortPrint(rec.fingerprint), stateFingerprint: shortPrint(rec.stateFingerprint),
      record: basename(file), ...(rec.reusedFrom ? { reusedFrom: basename(rec.reusedFrom) } : {}),
      ...(rec.unreviewed ? { unreviewed: true } : {}), ...(rec.error ? { error: withheld(rec.error).slice(0, 300) } : {}),
      findings: rec.findings.map((f) => ({ severity: f.severity, file: withheld(f.file, true), ...(f.line ? { line: f.line } : {}), summary: withheld(f.summary).slice(0, 300) })),
    };
    const r = (statvsWriter ?? defaultReviewStatvsWriter)({ writer: "tool:Review", stream: "review", class: "personal", kind: "review", title: `review ${rec.status} ${rec.tier}`, data });
    // A refused row is the one loss STATVS counts but nobody sees; say it on stderr, which no deploy gate reads. A spooled row lands on the next append.
    const refused = (r as { ok?: boolean; refused?: string } | null)?.refused;
    if (refused) process.stderr.write(`review: the STATVS review row was refused (${refused}); the record file ${basename(file)} is unaffected\n`);
  } catch { /* the review stands */ }
}

/** Records a reuse: this state was covered by `from`, a reviewed pass, so no model ran. Carries the pass's reviewer for traceability. */
function writeCovered(recDir: string, from: ReviewRecord & { _file: string }, s: Pick<ReviewRecord, "repoRoot" | "scope" | "base" | "head" | "dirty" | "fingerprint" | "stateFingerprint" | "files" | "linesChanged"> & Pick<Partial<ReviewRecord>, "dirtyReason">): { rec: ReviewRecord; file: string } {
  invariant(reviewedPass(from), `only a reviewed pass can cover a state, not ${from.status}`);
  const rec: ReviewRecord = {
    version: 1, ts: new Date().toISOString(), ...s, tier: from.tier, authors: from.authors, reviewerVendors: from.reviewerVendors,
    ...(from.reviewerModel ? { reviewerModel: from.reviewerModel } : {}), status: "covered", summary: `covered by ${from._file}`, findings: [], reusedFrom: from._file,
  };
  return { rec, file: writeRecord(recDir, rec) };
}

/** Printed (prefixed by the caller's name) when anyone passes the retired --accept; the Review CLI and CfEnv both exit 2 on it. */
export const RETIRED_ACCEPT = `--accept is retired. Use --allow-dirty "<reason>" to ship uncommitted files in the deploy dir (the model review still runs), or --waive-blockers "<reason>" to ship past model blockers, a reviewer outage or an over-limit diff (never uncommitted files).`;

export type ReviewFlags = { ok: true; allowDirty?: string; waiveBlockers?: string; pastRoundCap?: string; rest: string[] } | { ok: false; error: string };

/**
 * Takes the review's own flags out of an argv and returns the rest untouched: `--allow-dirty <reason>` and
 * `--waive-blockers <reason>` (or `--flag=<reason>`), each with a non-blank reason that is not flag-shaped, each at
 * most once. The retired `--accept` in any form is an error naming both flags. One parser for the Review CLI and
 * every deploy wrapper that forwards these flags (CfEnv), so the flags and the refusal read the same everywhere.
 */
export function parseReviewFlags(argv: string[]): ReviewFlags {
  const rest: string[] = [];
  const got: { "--allow-dirty"?: string; "--waive-blockers"?: string; "--past-round-cap"?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (name === "--accept") return { ok: false, error: RETIRED_ACCEPT };
    if (name !== "--allow-dirty" && name !== "--waive-blockers" && name !== "--past-round-cap") { rest.push(a); continue; }
    const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (value === undefined || !value.trim() || value.startsWith("-")) return { ok: false, error: `${name} needs a reason, e.g. ${name} "peer session's files, not part of this deploy"` };
    if (got[name] !== undefined) return { ok: false, error: `${name} given twice` };
    got[name] = value;
  }
  return { ok: true, rest, ...(got["--allow-dirty"] !== undefined ? { allowDirty: got["--allow-dirty"] } : {}), ...(got["--waive-blockers"] !== undefined ? { waiveBlockers: got["--waive-blockers"] } : {}), ...(got["--past-round-cap"] !== undefined ? { pastRoundCap: got["--past-round-cap"] } : {}) };
}

/** Runs `jobs` with at most `limit` in flight; results keep the jobs' order. Each job must not reject. */
async function inRounds<T>(jobs: Array<() => Promise<T>>, limit = MAX_CONCURRENT): Promise<T[]> {
  const out = new Array<T>(jobs.length);
  let next = 0;
  const worker = async () => { while (next < jobs.length) { const i = next++; out[i] = await jobs[i]!(); } };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return out;
}

function formatFindings(fs: Finding[]): string {
  return fs.map((f) => `  [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""} — ${f.summary}\n      ${f.failure_scenario}`).join("\n");
}

export interface ReviewOptions {
  dir: string;
  /** --allow-dirty reason: lifts only the uncommitted-files block. The model review still runs and its blockers still stop the deploy. */
  allowDirty?: string;
  /** --waive-blockers reason: ships past model blockers, a reviewer outage or an over-ceiling diff. Never lifts the uncommitted-files block. */
  waiveBlockers?: string;
  /** --past-round-cap reason: the principal's go-ahead to review a span already blocked ROUND_CAP times. Starts a fresh count. */
  pastRoundCap?: string;
  reviewer?: Reviewer;
  /** Characters per batch; tests shrink it to exercise batching and the ceiling without megabyte fixtures. */
  batchBudget?: number;
}

export async function review(opts: ReviewOptions): Promise<ReviewOutcome> {
  const startedAt = Date.now();
  invariant(opts.allowDirty === undefined || opts.allowDirty.trim().length > 0, "--allow-dirty carries a reason");
  invariant(opts.waiveBlockers === undefined || opts.waiveBlockers.trim().length > 0, "--waive-blockers carries a reason");
  invariant(opts.pastRoundCap === undefined || opts.pastRoundCap.trim().length > 0, "--past-round-cap carries a reason");
  const waive = opts.waiveBlockers;
  const dir = realpathSync(resolve(opts.dir));
  const rootRaw = git(dir, ["rev-parse", "--show-toplevel"], true).trim();
  if (!rootRaw) return { code: 2, message: `review: ${dir} is not inside a git repo; nothing reviewed` };
  const root = realpathSync(rootRaw);
  const scope = relative(root, dir) || ".";
  const dirs = recordDirs(root);
  const recDir = dirs.write;
  const records = readRecords(dirs.read);
  const hasHead = gitOk(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  const head = hasHead ? git(root, ["rev-parse", "HEAD"]).trim() : EMPTY_TREE;
  const uncommitted = uncommittedPaths(root, scope);
  // Only --allow-dirty lifts this block; --waive-blockers never does (ISC-21/22).
  if (uncommitted.length > 0 && !opts.allowDirty) {
    const list = uncommitted.slice(0, 10).map((p) => `  ${p}`).join("\n") + (uncommitted.length > 10 ? `\n  …and ${uncommitted.length - 10} more` : "");
    return { code: 1, message: `review: BLOCKED — ${uncommitted.length} uncommitted path(s) in ${scope === "." ? "the repo" : scope}. A deploy ships committed code only, so the reviewed commit is the deployed one.\n${list}\nCommit your own changes and deploy again. Files that are not yours belong to another session: leave them. To ship the working tree anyway, rerun with --allow-dirty "<reason>"; the model review still runs and its blockers still stop the deploy.` };
  }
  const dirtyNote = uncommitted.length > 0 && opts.allowDirty ? { dirtyReason: opts.allowDirty } : {};
  // Coverage (ISC-18/19): a reviewed pass whose head this tree matches in scope, at this scope or the repo root, already reviewed this state.
  const cover = hasHead ? coveringPass(root, scope, records) : undefined;
  if (cover) {
    const coveredText = collectDiff(root, scope, cover.head).text;
    const { rec, file } = writeCovered(recDir, cover, {
      repoRoot: root, scope, base: cover.head, head, dirty: git(root, ["status", "--porcelain", "--", scope]).trim().length > 0,
      fingerprint: createHash("sha256").update(coveredText).digest("hex"),
      stateFingerprint: createHash("sha256").update(head + "\n" + collectDiff(root, scope, head).text).digest("hex"),
      files: [], linesChanged: 0, ...dirtyNote,
    });
    return { code: 0, record: rec, message: `review: COVERED — nothing changed in ${scope} since the ${cover.status} review at ${cover.head.slice(0, 7)}${cover.scope !== scope ? ` (scope ${cover.scope})` : ""} (${cover._file}); no new review. Record: ${file}` };
  }
  const base = hasHead ? pickBase(root, scope, records) : EMPTY_TREE;
  const diff = collectDiff(root, scope, base);
  if (!diff.text.trim()) return { code: 0, message: `review: nothing changed in ${scope} since ${base.slice(0, 7)}` };

  const fingerprint = createHash("sha256").update(diff.text).digest("hex");
  // The reviewed state is HEAD plus the uncommitted tree; a pass over the same state, or over the same diff, is reused.
  // Only a reviewed pass is reused: a waived record never becomes coverage (ISC-25).
  const stateFingerprint = createHash("sha256").update(head + "\n" + (hasHead ? collectDiff(root, scope, head).text : diff.text)).digest("hex");
  const prior = records.filter((r) => r.scope === scope && reviewedPass(r) && (r.fingerprint === fingerprint || r.stateFingerprint === stateFingerprint)).at(-1);
  if (prior) {
    const { rec, file } = writeCovered(recDir, prior, {
      repoRoot: root, scope, base, head, dirty: git(root, ["status", "--porcelain", "--", scope]).trim().length > 0,
      fingerprint, stateFingerprint, files: diff.files, linesChanged: diff.lines, ...dirtyNote,
    });
    return { code: 0, record: rec, message: `review: this exact diff already ${prior.status} (${prior._file}); no new review. Record: ${file}` };
  }

  const dirty = git(root, ["status", "--porcelain", "--", scope]).trim().length > 0;
  const committedAuthors = hasHead ? authorVendors(git(root, ["log", "--format=%B", base === EMPTY_TREE ? "HEAD" : `${base}..HEAD`, "--", scope], true)) : [];
  // Uncommitted work carries no trailer; the local session wrote it, and that is Claude.
  const authors = dirty && !committedAuthors.includes("anthropic") ? [...committedAuthors, "anthropic" as Vendor].sort() : committedAuthors;
  const tier = classifyTier(diff.files, diff.lines);
  const vendors = reviewersFor(authors);
  const base_rec = { version: 1 as const, ts: new Date().toISOString(), repoRoot: root, scope, base, head, dirty, fingerprint, stateFingerprint, tier, files: diff.files, linesChanged: diff.lines, authors, reviewerVendors: vendors, ...dirtyNote };
  // The round cap (ISC-32/36): a span blocked ROUND_CAP times gets no further model review until the principal lifts it.
  // The author is patching findings one at a time; another round finds a few more instead of converging. A waiver
  // already has the principal in the loop, so it is not capped.
  const rounds = hasHead ? blockedRounds(root, scope, base, records) : [];
  if (rounds.length >= ROUND_CAP && !opts.pastRoundCap && !waive) {
    const finding: Finding = { severity: "blocker", file: scope, summary: `round cap: blocked ${rounds.length} times since ${base.slice(0, 7)} without a pass`, failure_scenario: "another fix-and-review round on the same span; each round has found more instead of converging" };
    const rec: ReviewRecord = { ...base_rec, status: "blocked", roundCap: true, findings: [finding] };
    const file = writeRecord(recDir, rec);
    const lastBlockers = rounds.at(-1)!.findings.filter((f) => f.severity === "blocker");
    return { code: 1, record: rec, message: `review: ROUND CAP — ${scope === "." ? "this repo" : scope} has been blocked ${rounds.length} times since ${base.slice(0, 7)} without a pass, so no new review ran.\nStop fixing findings one at a time. Step back, rethink the approach, and bring it to the principal; their go-ahead runs the next review with --past-round-cap "<reason>".${lastBlockers.length ? `\nThe last round's blockers:\n${formatFindings(lastBlockers)}` : ""}\nRecord: ${file}` };
  }
  const round = opts.pastRoundCap ? 1 : rounds.length + 1;
  // Later rounds read the whole span; majors and minors count only in files changed since the last round (ISC-40/41/44).
  const focus = round > 1 ? changedSinceLastRound(root, scope, rounds, diff.files) : null;
  const growth = round > 1 ? reviewGrowth(rounds[0]?.linesChanged, diff.lines) : null;
  const roundNote = { round, ...(opts.pastRoundCap ? { pastRoundCap: opts.pastRoundCap } : {}), ...(focus ? { focusSince: focus.since, changedFiles: focus.files } : {}), ...(growth ? { growth } : {}) };
  const batches = batchDiff(diff.text, opts.batchBudget);

  // The ceiling bounds a runaway diff (ISC-27). Under it everything is read; over it nothing is, so a waiver is recorded as unreviewed.
  if (batches.length > MAX_BATCHES) {
    const finding: Finding = { severity: "blocker", file: scope, summary: `diff too large to review (${batches.length} batches, limit ${MAX_BATCHES})`, failure_scenario: `${diff.lines} changed lines would deploy without a full review` };
    const rec: ReviewRecord = waive
      ? { ...base_rec, status: "waived", unreviewed: true, waiveReason: waive, findings: [finding] }
      : { ...base_rec, status: "blocked", findings: [finding] };
    const file = writeRecord(recDir, rec);
    const r = recordReceipt({ rec, diffText: diff.text, isaFile: isaPath(root, scope), passedBatches: 0, tooLarge: finding.summary, durationMs: Date.now() - startedAt });
    if (waive) return { code: 0, record: rec, ...r, message: `review: WAIVED UNREVIEWED — ${finding.summary}; no model read it. Shipping on --waive-blockers: ${waive}. The record is marked unreviewed and the next review covers this span again. Record: ${file}` };
    return { code: 1, record: rec, ...r, message: `review: BLOCKED — ${finding.summary}.\nDeploy a smaller change, or rerun with --waive-blockers "<reason>" to ship it unreviewed; it is recorded as unreviewed and the next review covers it again. Record: ${file}` };
  }

  // The base copy of the ISA (ISC-29/38), whole or sliced per batch (ISC-30/34/39).
  const isa = isaAt(root, scope, base);
  const isaParts = batches.map((part) => (isa ? isaForBatch(isa.text, part) : ""));
  const earlier = rounds.length ? { rounds: rounds.length, findings: priorFindings(rounds) } : undefined;
  for (const v of vendors) assertEvaluatorVendor(v, "review");
  const reviewer = opts.reviewer ?? defaultReviewer;
  // Every batch is read, at most MAX_CONCURRENT calls at a time (ISC-26).
  const jobs = vendors.flatMap((vendor) => batches.map((diffPart, i) => async (): Promise<ReviewerResult> => {
    try {
      return await reviewer({
        system: SYSTEM_PROMPT, vendor, level: LEVEL[tier],
        user: buildUserPrompt({ scope, tier, files: diff.files, diff: diffPart, isa: isaParts[i]!, isaFromBase: isa?.fromBase, isaDiff: isa?.diff, prior: earlier, focus: focus ? { since: focus.since, changed: focus.files } : undefined, growth: growth ?? undefined, part: batches.length > 1 ? `part ${i + 1} of ${batches.length}` : undefined }),
      });
    } catch (e: unknown) { return { ok: false, error: String(e) }; }
  }));
  const results = await inRounds(jobs);
  invariant(results.length === vendors.length * batches.length && results.every((r) => r !== undefined), "every batch got a reviewer result");
  const failed = results.find((r): r is { ok: false; error: string } => !r.ok);
  const anyBlocker = results.some((r) => r.ok && r.verdict.findings.some((f) => f.severity === "blocker"));

  if (failed && !anyBlocker) {
    const error = failed.error;
    // A reviewer outage stops the deploy (2026-09-30: fail closed). --waive-blockers lets it through
    // unreviewed; the record stays `skipped`, so the base holds and the next review covers this span.
    // The principal's --past-round-cap stays on the record, so an outage does not spend their go-ahead.
    const rec: ReviewRecord = { ...base_rec, status: "skipped", findings: [], error, ...(waive ? { waiveReason: waive } : {}), ...(opts.pastRoundCap ? { pastRoundCap: opts.pastRoundCap } : {}) };
    writeRecord(recDir, rec);
    const r = recordReceipt({ rec, diffText: diff.text, isaFile: isa?.path ?? null, isaText: isa?.text, passedBatches: 0, outage: error, durationMs: Date.now() - startedAt });
    if (waive) return { code: 0, record: rec, ...r, message: `review: NOT RUN — reviewer unavailable (${error}). Deploying unreviewed on --waive-blockers: ${waive}. The next review covers this span.` };
    return { code: 1, record: rec, ...r, message: `review: NOT RUN — reviewer unavailable (${error}). Deploy stopped: an unreviewed change does not ship by default.\nRetry, or rerun with --waive-blockers "<reason>" to deploy unreviewed; the next review still covers this span.` };
  }
  const oks = results.filter((r): r is { ok: true; verdict: Verdict; model: string } => r.ok);
  const all = oks.flatMap((r) => r.verdict.findings);
  const findings = focus ? all.filter((f) => f.severity === "blocker" || focus.files.some((c) => samePath(c, f.file))) : all;
  const dropped = all.length - findings.length;
  const model = [...new Set(oks.map((r) => r.model))].join(" + ");
  const summary = oks.map((r) => r.verdict.summary).filter(Boolean).join(" ");
  const blockers = findings.filter((f) => f.severity === "blocker");
  const status: Status = blockers.length === 0 ? "pass" : waive ? "waived" : "blocked";
  const rec: ReviewRecord = { ...base_rec, ...roundNote, ...(focus ? { droppedFindings: dropped } : {}), reviewerModel: model, status, summary, findings, ...(status === "waived" ? { waiveReason: waive } : {}), ...(failed ? { error: failed.error } : {}) };
  const file = writeRecord(recDir, rec);
  const rr = recordReceipt({ rec, diffText: diff.text, isaFile: isa?.path ?? null, isaText: isa?.text, passedBatches: oks.length, durationMs: Date.now() - startedAt });
  const head_line = `review: ${status.toUpperCase()} — ${tier} tier, ${diff.files.length} files${focus ? ` (round ${round}: ${focus.files.length} changed since the last round${dropped ? `, ${dropped} major/minor finding(s) on unchanged code dropped` : ""})` : ""}${batches.length > 1 ? ` in ${batches.length} parts` : ""}, reviewed by ${model} (${vendors.join(" + ")})`;
  const growthNote = growth ? `\n⚠ Review fixes grew this change from ${growth.from} to ${growth.to} changed lines since round 1. Cut what the intent does not need before the next fix.` : "";
  const body = (findings.length ? `\n${formatFindings(findings)}` : "") + growthNote;
  if (status === "blocked") {
    const capNote = round >= ROUND_CAP ? `\nThis was round ${round} on this span, the last before the round cap. Before another fix, step back and rethink the approach; the next review needs the principal's --past-round-cap "<reason>".` : "";
    return { code: 1, record: rec, ...rr, message: `${head_line}${body}\n\nDeploy blocked. Fix the blockers, or rerun with --waive-blockers "<reason>" if one is wrong.${capNote} Record: ${file}` };
  }
  if (status === "waived") {
    return { code: 0, record: rec, ...rr, message: `${head_line}${body}\n\nShipping past the blockers on --waive-blockers: ${waive}. The next review covers this span again. Record: ${file}` };
  }
  return { code: 0, record: rec, ...rr, message: `${head_line}${summary ? `\n  ${summary}` : ""}${body}` };
}

export function status(dirArg: string): ReviewRecord | null {
  const dir = realpathSync(resolve(dirArg));
  const rootRaw = git(dir, ["rev-parse", "--show-toplevel"], true).trim();
  if (!rootRaw) return null;
  const root = realpathSync(rootRaw);
  const scope = relative(root, dir) || ".";
  return readRecords(recordDirs(root).read).filter((r) => r.scope === scope).at(-1) ?? null;
}

// ── Review coverage (LOSIntegrity S100) ─────────────────────────────────────
// A deploy text covers the review only when the review really RUNS and its failure STOPS every later ship. A mention is
// not a call, and a call whose failure is ignored is not coverage. Proof is by shape, never by search: the audit knows a
// small set of forms whose meaning is fixed, reads the text in run order, and counts anything else as not covered, a
// GAP its owner closes by writing one of the known forms. Two rounds of review showed that searching a text for signs
// of enforcement always leaves another way to write a bypass; a closed set of shapes does not.
//
// Shell is read through the one shell parser (hooks/lib/shell-commands) for WHAT runs. That parser does not report the
// control operators between commands, so how a failure travels is read from the raw text with one rule: an operator
// character counts as an operator even inside quotes. Quoting can only add a boundary, so a misread is always a GAP.
//
// TypeScript is read with comments removed, every string held as an opaque placeholder and every regex literal as an
// opaque value (maskTs, a lexer that knows regex literals and nested templates), then cut into statements in run order.
// A spawn's argv is evaluated from literals, consts and path joins (an array whose name is changed anywhere in the
// file is unknown), and a same-file helper is followed by binding its parameters to the call's arguments; a generator,
// an un-awaited async helper, or a helper reassigned anywhere is not followed. The gates are: an uncaught throwing spawn
// (execFileSync / execSync, namespaced or not), a sync spawn whose OWN unchanged result is tested for failure by a
// later statement that stops the script before any ship (a throw, Node's own process.exit, or a sync invariant /
// assert), an awaited Bun `$` shell, and any of these inside a try with no finally whose catch always rethrows or exits
// nonzero. Once a statement may return early, nothing after it in that body gates. A text the lexer cannot close is
// not analysed at all.

/** A deploy text's language: a shell line or script, or a TypeScript deploy script. */
export type DeployTextKind = "shell" | "ts";

// ── Shell ──

/** The control operator (or opening bracket) right before `start`, and the words between it and `start`. */
function leadIn(t: string, start: number): { op: string; tail: string } {
  const m = t.slice(0, start).match(/(\|\||&&|[;\n|&({])([^;\n|&({]*)$/);
  return m ? { op: m[1]!, tail: m[2]! } : { op: "", tail: t.slice(0, start) };
}

/** Only env assignments may stand between an operator and the review: no `!`, `if`, `then`, wrapper or other word. */
const PLAIN_LEAD = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"'`;&|]*)\s+)*$/;

/** True when nothing before `start` is left open: no subshell, group, function body, `$(` or backtick around it. */
function atTopLevel(t: string, start: number): boolean {
  const head = t.slice(0, start);
  const n = (re: RegExp) => (head.match(re) ?? []).length;
  return n(/\(/g) === n(/\)/g) && n(/\{/g) === n(/\}/g) && n(/`/g) % 2 === 0;
}

/**
 * True when a shell compound (`if`, `case`, a loop) may still be open at the end of `head`, so a command after it may
 * never run (`if false; then` review `fi`). Read to fail closed: an opener counts wherever its word appears outside
 * quotes (`echo "if needed"` opens nothing; final round 2), and everywhere, quoted or not, when the quoting is the
 * kind this scanner may misread (`$'…'` escapes, a `$(…)` or backtick inside double quotes, a `#`, a quote left open); a
 * closer (`fi`, `esac`, `done`) counts only unquoted at a command position; and a heredoc, whose body can hold any
 * word, leaves it open.
 */
function unquotedView(head: string): string | null {
  // A comment the strip missed (`cmd;# it's`) holds a quote the shell never reads, which would pair with a real one
  // and hide the keywords between them; so any `#` leaves the count as it was.
  if (head.includes("$'") || head.includes("#")) return null;
  let out = "", q = "";
  for (let i = 0; i < head.length; i++) {
    const c = head[i]!;
    if (q) {
      if (c === q) { q = ""; out += " "; continue; }
      if (q === '"' && (c === "`" || (c === "$" && head[i + 1] === "("))) return null;
      if (c === "\\" && q === '"') { out += " "; i++; }
      out += c === "\n" ? "\n" : " ";
      continue;
    }
    if (c === "'" || c === '"') { q = c; out += " "; continue; }
    if (c === "\\") { out += c + (head[i + 1] ?? ""); i++; continue; }
    out += c;
  }
  return q ? null : out;
}

function compoundOpen(head: string): boolean {
  if (head.includes("<<")) return true;
  const openers = ((unquotedView(head) ?? head).match(/(?:^|[^\w$.\/-])(?:if|case|while|until|for|select)(?=[\s;(]|$)/g) ?? []).length;
  let closers = 0, q = "", cmdPos = true;
  for (let i = 0; i < head.length; i++) {
    const c = head[i]!;
    if (q) { if (c === q) q = ""; else if (c === "\\" && q === '"') i++; continue; }
    if (c === "'" || c === '"') { q = c; cmdPos = false; continue; }
    if (c === "\\") { i++; cmdPos = false; continue; }
    if (/[;\n&|()]/.test(c)) { cmdPos = true; continue; }
    if (c === " " || c === "\t") continue;
    if (cmdPos && /^(?:fi|esac|done)(?=[\s;&|)]|$)/.test(head.slice(i))) closers++;
    cmdPos = false;
  }
  return openers > closers;
}

/**
 * True when `set -e` (errexit) is in force at `start`: set at the start of a top-level line before it (not inside a
 * function, subshell or compound), and never switched off before it anywhere, on the same line, nested or quoted.
 */
function errexitAt(t: string, start: number): boolean {
  const head = t.slice(0, start);
  if (/\bset\b[^\n;&|]*\s\+[A-Za-z]*e|\bset\b[^\n;&|]*\+o\s+errexit|\bshopt\b[^\n;&|]*errexit/.test(head)) return false;
  let on = false;
  for (const m of head.matchAll(/^[ \t]*set[ \t]+([^\n;&|]*)/gm)) {
    if (!atTopLevel(t, m.index!) || compoundOpen(t.slice(0, m.index!))) continue;
    if (/(?:^|\s)-[A-Za-z]*e|-o\s+errexit\b/.test(m[1]!)) on = true;
  }
  return on;
}

/**
 * True when the review command that runs from `start` to `end` stops every later command when it fails
 *. Presence is not enforcement: `review || true && deploy`, `review; deploy`,
 * `review | tee log && deploy` and `review && echo ok; deploy` all ship past a failed review. The four gating forms:
 * - the rest of the text is one `&&` chain (no `;`, newline, `|`, `||` or lone `&` after it), so nothing later runs;
 * - `|| exit N` (nonzero, or `$?`) follows at top level, so a failure ends the script;
 * - it is a whole top-level statement under `set -e`;
 * - the text is run by a throwing API (`endPropagates`: Bun `$`, execSync) and the review is its last command.
 * Before any of them: the review must really run (`x || review` skips it when x passes) and keep its own status
 * (`! review` inverts it), so only env assignments may stand between the previous operator and the command.
 */
function reviewGates(t: string, start: number, end: number, endPropagates: boolean): boolean {
  const lead = leadIn(t, start);
  if (lead.op === "||" || !PLAIN_LEAD.test(lead.tail)) return false;
  const rest = t.slice(end).replace(/\s+$/, "");
  // After `&&` or `||` the shell reads newlines as plain space, so `review &&⏎ deploy` is one chain (final round 2:
  // HEAD gated it). Only newlines right after one of those operators are joined, and only in what follows the review.
  const joined = rest.replace(/(&&|\|\|)[ \t]*\n[ \t\n]*/g, (m) => m.replace(/\n/g, " "));
  if (/^[ \t]*&&/.test(joined) && !/[;\n|]/.test(joined) && !joined.replace(/&&/g, "").includes("&")) return true;
  if (!atTopLevel(t, start) || compoundOpen(t.slice(0, start))) return false;
  if (/^[ \t]*\|\|[ \t]*exit[ \t]+(?:[1-9]\d*|"?\$\?"?)[ \t]*(?:$|[;\n])/.test(joined)) return true;
  if ((lead.op === "" || lead.op === ";" || lead.op === "\n") && /^[ \t]*(?:[;\n]|$)/.test(rest) && errexitAt(t, start)) return true;
  return endPropagates && rest.trim() === "";
}

/**
 * Kept for importers of the earlier export, unchanged from it (closing pass): true when a shell `Review.ts` invocation
 * at `end` (the index just past its arguments) gates what follows: the next control operator is `&&`, or `||` straight
 * into a nonzero `exit` / `return`, or the text runs under `set -e` at end of line. The audit itself uses reviewGates.
 */
export function reviewExitEnforced(text: string, end: number): boolean {
  const rest = text.slice(end);
  const op = rest.match(/^[^\n;&|]*?(&&|\|\||\||;|&|\n|$)/); // String.match keeps the spawn-hygiene scan free of RegExp method calls
  const tok = op?.[1] ?? "";
  if (tok === "&&") return true;
  if (tok === "||") return /^\s*(?:exit|return)\s+(?:[1-9]\d*|"?\$\?"?)\b/.test(rest.slice(op!.index + op![0].length));
  if (tok === "\n" || tok === "") return /^\s*set\s+(?:-[A-Za-z]*e[A-Za-z]*|-o\s+errexit)\b/m.test(text) && !/^\s*set\s+\+e\b/m.test(text);
  return false;
}

function shellShips(text: string): boolean {
  try { return simpleCommands(text).commands.some((c) => commandShips(c.argv, new Set())); } catch { return /\b(?:cf|wrangler)\b[^\n]{0,40}\b(?:deploy|versions upload)\b/.test(text); }
}

/**
 * True when a parsed shell command may be a provider deploy: cf / wrangler deploy, the same CLI with an interpolated
 * word (a verb held in a variable may be the deploy verb), or a program the parser cannot name given a deploy verb or
 * an interpolated word. The review and CfEnv are never ships here. The one ship test for every shell check.
 */
function commandShips(argv: string[], cfVars: Set<string>): boolean {
  if (isProviderShip(argv)) return true;
  const ep = effectiveProgram(argv);
  if ((ep.program === "cf" || ep.program === "wrangler") && ep.args.some((a) => /[$`]/.test(a))) return true;
  // CfEnv, by name or through a variable that only ever names it, runs its own review before any deploy.
  const v = ep.word.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)?.[1];
  if (programName(ep.word) === "cfenv.ts" || (v && cfVars.has(v))) return false;
  return !reviewVerb(argv, cfVars) && unnamedShip(argv);
}

/** A provider CLI deploy (cf / wrangler deploy, pages deploy, versions upload), never CfEnv. */
function isProviderShip(argv: string[]): boolean {
  const ep = effectiveProgram(argv);
  if (ep.program !== "cf" && ep.program !== "wrangler") return false;
  return ep.args.includes("deploy") || (ep.args.includes("versions") && ep.args.includes("upload"));
}

/** A command whose program the parser cannot name (`$W deploy`) given a deploy verb: it may be a provider deploy. */
function unnamedShip(argv: string[]): boolean {
  const ep = effectiveProgram(argv);
  return /[$`]/.test(ep.word) && (ep.args.includes("deploy") || ep.args.includes("upload"));
}

/** What a parsed shell command runs: the review, CfEnv with its verb, or nothing this audit counts. */
function reviewVerb(argv: string[], cfVars: Set<string>): { kind: "review" } | { kind: "cfenv"; verb: string } | null {
  const ep = effectiveProgram(argv);
  const prog = programName(ep.word);
  if (prog === "review.ts") return { kind: "review" };
  const v = ep.word.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)?.[1];
  if (prog !== "cfenv.ts" && !(v && cfVars.has(v))) return null;
  const verb = ep.args[0] === "pages" ? ep.args[1] : ep.args[0];
  return verb === "deploy" || verb === "review" ? { kind: "cfenv", verb } : null;
}

/** True when a shell text runs `CfEnv.ts deploy` (read by the shell parser, so printed text does not count). */
function shellRunsCfDeploy(text: string): boolean {
  try { return simpleCommands(text).commands.some((c) => { const r = reviewVerb(c.argv, new Set()); return r?.kind === "cfenv" && r.verb === "deploy"; }); } catch { return false; }
}

/**
 * Shell: "gated" when the text runs the review (or CfEnv, which runs it) so that its failure stops every later ship
 * (reviewGates); "cfenv" when it runs `CfEnv.ts deploy` and nothing else in it ships, since CfEnv refuses its own
 * deploy on a failed review; else null. Each candidate `bun …` command is confirmed by the shell parser: it must be a
 * command the line runs (not text a printf prints or a quoted argument), and the parse up to the candidate's end must
 * give the same argv as the whole line, so an operator inside its own quoted argument is never read as the one after it.
 */
function shellCoverage(raw: string, endPropagates = false): "gated" | "cfenv" | null {
  // Comments are not calls (2026-10-09 review: `# Review.ts later` counted); the parser does not read `#`, so they go
  // first. A cut inside a quoted `#` can only leave more text quoted, never less.
  const t = raw.split("\n").map((l) => l.replace(/(^|\s)(#|\/\/).*$/, "")).join("\n");
  let walk: ReturnType<typeof shellSteps>;
  try { walk = shellSteps(t); } catch { return null; }
  if (walk.tooDeep) return null;
  // A variable names CfEnv only when every assignment to it does (a later `CF_ENV=<other>` undoes it). A per-command
  // prefix (`CF_ENV=… cmd`) never sets it for the shell, and read / for / unset / printf -v / ${V:=…} change it.
  const cfAssign = new Map<string, boolean>();
  const isCf = (val: string) => /CfEnv(?:\.ts)?["']?$/.test(val);
  const setCf = (k: string, cf: boolean) => cfAssign.set(k, (cfAssign.get(k) ?? true) && cf);
  for (const s of walk.steps) {
    if (s.argv.length === 0) { for (const [k, val] of Object.entries(s.env)) setCf(k, isCf(val)); continue; }
    for (const k of Object.keys(s.env)) setCf(k, false);
    if (!["export", "readonly", "declare", "local", "typeset"].includes(programName(s.argv[0]))) continue;
    for (const w of s.argv.slice(1)) { const m = w.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s); if (m) setCf(m[1]!, isCf(m[2]!)); }
  }
  const cfVars = new Set<string>();
  for (const [k, cf] of cfAssign) {
    const changed = new RegExp(`\\b(?:read|for|select|unset|getopts|mapfile|readarray)\\b[^\\n;&|]*\\b${k}\\b|\\bprintf\\s+-v\\s*${k}\\b|\\$\\{${k}:?=`).test(t);
    if (cf && !changed) cfVars.add(k);
  }
  const runs = (text: string): SimpleCommand[] | null => {
    try { const w = simpleCommands(text); return w.tooDeep ? null : w.commands.filter((c) => reviewVerb(c.argv, cfVars)); } catch { return null; }
  };
  const all = runs(t);
  if (!all?.length) return null;
  const otherShip = walk.commands.some((c) => commandShips(c.argv, cfVars));
  for (const m of t.matchAll(/\b(?:bun|bunx|node)\s+[^\n;&|]*/g)) {
    const start = m.index!, end = start + m[0].length;
    const before = runs(t.slice(0, start)), upto = runs(t.slice(0, end));
    if (!before || !upto || upto.length !== before.length + 1) continue;
    const k = upto.length - 1;
    if (JSON.stringify(upto[k]!.argv) !== JSON.stringify(all[k]?.argv)) continue;
    const what = reviewVerb(upto[k]!.argv, cfVars)!;
    // A review that runs after something already shipped stops nothing.
    let shippedBefore = true;
    try { shippedBefore = simpleCommands(t.slice(0, start)).commands.some((c) => commandShips(c.argv, cfVars)); } catch { /* unreadable: stays true */ }
    if (!shippedBefore && reviewGates(t, start, end, endPropagates)) return "gated";
    if (what.kind === "cfenv" && what.verb === "deploy" && !otherShip) return "cfenv";
  }
  return null;
}

// ── TypeScript ──

const PH = /\u0000(\d+)\u0000/g;
const PH_ONE = /^\u0000(\d+)\u0000$/;
/** A word whose value the audit cannot read. */
const UNKNOWN = "\u0001";
const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** child_process APIs: the throwing pair stops the caller on a nonzero exit unless caught; spawnSync returns a status. */
const THROWING_SPAWN = new Set(["execFileSync", "execSync"]);
const NODE_SPAWN = new Set(["execFileSync", "execSync", "spawnSync", "spawn", "execFile", "exec"]);
const CHILD_PROCESS = /^(?:node:)?child_process$/;
/** Bun shell result methods that keep its throw on a nonzero exit (`.nothrow()` and `.catch()` drop it). */
const SHELL_CHAIN_OK = new Set(["quiet", "text", "json", "lines", "cwd", "env", "arrayBuffer", "blob", "bytes"]);

/** Same-length view of `code` with each placeholder blanked to spaces, for bracket matching. */
function flat(code: string): string { return code.replace(PH, (m) => " ".repeat(m.length)); }

/** Index of the bracket matching the opener at `open` in `f` (a flat view), or -1. */
function matchForward(f: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < f.length; i++) {
    const ch = f[i]!;
    if (pairs[ch]) stack.push(pairs[ch]!);
    else if (ch === ")" || ch === "]" || ch === "}") { if (stack.pop() !== ch) return -1; if (!stack.length) return i; }
  }
  return -1;
}

/** `s` cut at every depth-0 `sep` (`,`, `||`, `&&`), strings and brackets respected. */
function splitTop(s: string, sep: string): string[] {
  const f = flat(s);
  const out: string[] = [];
  let depth = 0, last = 0;
  for (let i = 0; i < f.length; i++) {
    const ch = f[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0 && f.startsWith(sep, i)) { out.push(s.slice(last, i)); last = i + sep.length; i += sep.length - 1; }
  }
  out.push(s.slice(last));
  return out;
}

/** `s` without whitespace runs and enclosing parentheses, for matching a condition against a fixed form. */
function norm(s: string): string {
  let x = s.trim();
  while (x.startsWith("(") && matchForward(flat(x), 0) === x.length - 1) x = x.slice(1, -1).trim();
  return x.replace(/\s+/g, " ");
}

const esc = (name: string) => name.replace(/\$/g, "\\$");

/**
 * The TypeScript lexer the audit reads with: comments removed, every string and template held whole as a placeholder
 * (`\0N\0`, its source in `literals`), and every regex literal replaced by RE_TOKEN, an opaque value that is never a
 * string. Unlike a quote-blind mask it knows regex literals (a `/` after an operator, an opening bracket, a keyword or
 * the `)` of `if (…)` opens one; after a value it divides) and templates nested in `${…}`, so a regex holding a quote
 * or `//` is read as the compiler reads it. Anything it cannot close (a string, template, regex or block comment that
 * runs off its line or the file) returns null: the text is not analysed, so it is not covered.
 */
/** A template literal with ${…} expressions: their masked code, and the fixed text after the last one. */
interface Template { exprs: string[]; tail: string; /** The fixed text around the expressions, one more than `exprs`. */ quasis: string[] }
const REGEX_KEYWORD = /^(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await|instanceof)$/;
const RE_TOKEN = "\u0002";

function maskTs(src: string): { code: string; literals: string[]; tmpl: Map<number, Template> } | null {
  const literals: string[] = [];
  const tmpl = new Map<number, Template>();
  const lex = (start: number, inExpr: boolean, out: { code: string }): number => {
    const parens: boolean[] = [];
    let closeKw = false, depth = 0, brackets = 0, i = start;
    // "maybe" where the grammar needs more than the previous token (after `}`, a block or an object; after `++` / `--`).
    const regexAllowed = (): boolean | "maybe" => {
      const c = out.code.match(/(\S)\s*$/)?.[1];
      if (c === undefined) return true;
      if (c === ")") return closeKw;
      if (c === "]" || c === RE_TOKEN || c === "\u0000") return false;
      if (/[\w$]/.test(c)) return REGEX_KEYWORD.test(out.code.match(/([A-Za-z_$][\w$]*)\s*$/)?.[1] ?? "");
      if (c === "}" || /(?:\+\+|--)\s*$/.test(out.code)) return "maybe";
      return true;
    };
    while (i < src.length) {
      const ch = src[i]!, nx = src[i + 1];
      if (ch === "/" && nx === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (ch === "/" && nx === "*") { const e = src.indexOf("*/", i + 2); if (e < 0) return -1; i = e + 2; out.code += " "; continue; }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        for (; j < src.length && src[j] !== ch; j++) { if (src[j] === "\\") j++; else if (src[j] === "\n") return -1; }
        if (j >= src.length) return -1;
        literals.push(src.slice(i, j + 1));
        out.code += `\u0000${literals.length - 1}\u0000`;
        i = j + 1;
        continue;
      }
      if (ch === "`") {
        // Each ${…} is code that runs when the template is evaluated: its masked text is kept (final round 2: a ship
        // inside one was invisible), and so is the fixed tail after the last one, the only part of its value known.
        let j = i + 1, tailStart = j;
        const exprs: string[] = [], quasis: string[] = [];
        for (; j < src.length && src[j] !== "`"; j++) {
          if (src[j] === "\\") j++;
          else if (src[j] === "$" && src[j + 1] === "{") { quasis.push(src.slice(tailStart, j)); const sub = { code: "" }; const e = lex(j + 2, true, sub); if (e < 0) return -1; exprs.push(sub.code); j = e; tailStart = e + 1; }
        }
        if (j >= src.length) return -1;
        literals.push(src.slice(i, j + 1));
        if (exprs.length) tmpl.set(literals.length - 1, { exprs, tail: src.slice(tailStart, j), quasis: [...quasis, src.slice(tailStart, j)] });
        out.code += `\u0000${literals.length - 1}\u0000`;
        i = j + 1;
        continue;
      }
      const re = ch === "/" ? regexAllowed() : false;
      if (re === "maybe") return -1; // a misread here could hide code as regex or regex as code: not analysed
      if (re) {
        let j = i + 1, inClass = false;
        for (; j < src.length; j++) {
          const c = src[j]!;
          if (c === "\\") { j++; continue; }
          if (c === "\n") return -1;
          if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          else if (c === "/" && !inClass) break;
        }
        if (j >= src.length) return -1;
        j++;
        while (j < src.length && /[A-Za-z]/.test(src[j]!)) j++;
        out.code += RE_TOKEN;
        i = j;
        continue;
      }
      // Brackets must balance: source that does not close (an unmatched `(` at the end) is not what the compiler runs.
      if (ch === "(") parens.push(/(?:^|[^\w$.])(?:if|while|for|with)\s*$/.test(out.code));
      else if (ch === ")") { if (!parens.length) return -1; closeKw = parens.pop()!; }
      else if (ch === "[") brackets++;
      else if (ch === "]") { if (!brackets) return -1; brackets--; }
      else if (ch === "{") depth++;
      else if (ch === "}") { if (depth === 0) return inExpr && !parens.length && !brackets ? i : -1; depth--; }
      // Raw NUL and the two marker characters are not valid TypeScript source; dropping them keeps markers unforgeable.
      if (ch !== "\u0000" && ch !== "\u0001" && ch !== RE_TOKEN) out.code += ch;
      i++;
    }
    return inExpr || parens.length || brackets || depth ? -1 : i;
  };
  const out = { code: "" };
  return lex(0, false, out) < 0 ? null : { code: out.code, literals, tmpl };
}

const BLOCK_STMT = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\b|^(?:if|for|while|try|switch|do)\b|^\{/;

/** True when a newline at `i` ends the statement that began at `start` (JavaScript's automatic semicolon rule, closely). */
function endsStatement(f: string, start: number, i: number): boolean {
  const s = f.slice(start, i).trim();
  if (!s) return false;
  if (/[,([{=+\-*/%&|^?:<>!~.]$/.test(s)) return false;
  const head = s.match(/^(?:\}\s*)?(?:else\s+)?(?:if|for|while)\s*\(/);
  if (head && matchForward(s, head[0].length - 1) === s.length - 1) return false; // `if (…)` with its body on the next line
  if (/\b(?:else|do|try|finally)$/.test(s)) return false;
  if (/^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\b/.test(s) && !s.endsWith("}")) return false;
  const nx = f.slice(i + 1).match(/^\s*([\w$]+|\S)?/)?.[1] ?? "";
  if (/^[.?:+\-*/%&|^=,)\]}([`<>]/.test(nx) || /^(?:else|catch|finally|instanceof|in|as|satisfies)$/.test(nx)) return false;
  return true;
}

/** `src` (masked) cut into statements in run order: at `;`, at a newline that ends a statement, and after a block statement. */
function statementsOf(src: string): string[] {
  const f = flat(src);
  const out: string[] = [];
  let depth = 0, start = 0;
  const cut = (end: number, next = end + 1) => { const s = src.slice(start, end).trim(); if (s) out.push(s); start = next; };
  const nextTok = (i: number) => f.slice(i + 1).match(/^\s*([\w$]+|\S)?/)?.[1] ?? "";
  for (let i = 0; i < f.length; i++) {
    const ch = f[i]!;
    if (ch === "(" || ch === "[" || ch === "{") { depth++; continue; }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
      if (ch === "}" && depth === 0) {
        const s = f.slice(start, i + 1).trim();
        const nx = nextTok(i);
        if (BLOCK_STMT.test(s) && !/^(?:else|catch|finally)$/.test(nx) && !(/^do\b/.test(s) && nx === "while")) cut(i + 1, i + 1);
      }
      continue;
    }
    if (depth !== 0) continue;
    if (ch === ";" && !/^(?:else|catch|finally)$/.test(nextTok(i))) cut(i);
    else if (ch === "\n" && endsStatement(f, start, i)) cut(i);
  }
  cut(f.length);
  return out;
}

interface Fn { params: string[]; body: string; block: boolean; async: boolean; generator: boolean; scope: Scope }
interface Binding { expr: string; scope: Scope }
/** A lexical scope: bindings (null = a name whose value is unknown, such as a `let`) and same-file functions. */
interface Scope { vars: Map<string, Binding | null>; fns: Map<string, Fn>; parent: Scope | null }
/**
 * What the audit knows about the whole file. `cpTampered`: some binding of node:child_process (or `require(…)` of it)
 * has a member replaced, so no child_process API is trusted to be the real one; `processTampered`: the same for
 * node:process (`require("node:process").exit = …`), so `process.exit` is not trusted; `globalTampered`: a global object is
 * changed or code is built at run time (`eval`, `Function`), so no global (Bun, process, an unbound name) is trusted;
 * `rebound`: names whose binding may be replaced (reboundNames).
 */
interface Ctx { lits: string[]; tmpl: Map<number, Template>; imports: Map<string, { module: string; imported: string }>; declared: Set<string>; mutated: Set<string>; byRef: Map<Fn, { ship: boolean; cf: boolean } | null>; rebound: Set<string>; cpTampered: boolean; processTampered: boolean; globalTampered: boolean }

const ID_SRC = "[A-Za-z_$][\\w$]*";
const MEMBER_SRC = "(?:\\s*\\??\\.\\s*[A-Za-z_$][\\w$]*|\\s*\\[[^\\]]*\\])";
const MUTATOR_METHODS = "push|pop|shift|unshift|splice|reverse|sort|fill|copyWithin|set|add|delete|clear";
/** Callees that only read an argument: a name handed to one of these keeps its value. */
const READ_ONLY_CALLEE = /^(?:console\.\w+|JSON\.stringify|String|Number|Boolean|(?:(?:path|posix|nodePath)\.)?(?:join|resolve)|Bun\.spawn(?:Sync)?)$/;

/**
 * Names whose array or object value may change after its declaration, so the audit never trusts what it was declared
 * as (an argv rewritten before it runs, a spawn result whose exitCode is overwritten). Read by name over the whole
 * file, so a name changed anywhere, in any scope, is distrusted everywhere: an assignment to it or a member, `++`/`--`,
 * a mutating method, `delete`, Object.assign / defineProperty / Reflect; an escape, where another name may come to
 * hold the same value and be changed through it; or an argument to a call the audit does not follow, a same-file
 * function counting through what it does with the parameter.
 */
function mutatedNames(code: string, imports: Ctx["imports"]): Set<string> {
  const f = flat(code);
  const out = new Set<string>();
  const add = (n: string | undefined) => { if (n) out.add(n); };
  for (const m of f.matchAll(new RegExp(`(?<![\\w$.])(${ID_SRC})(${MEMBER_SRC}*)\\s*(?:\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?|[-+*/%&|^])?=(?![=>])`, "g"))) {
    const before = f.slice(0, m.index).match(/([A-Za-z_$][\w$]*)\s*$/)?.[1];
    if (!m[2] && before && /^(?:const|let|var|type)$/.test(before)) continue; // the declaration itself
    add(m[1]);
  }
  for (const m of f.matchAll(new RegExp(`(?<![\\w$.])(${ID_SRC})(?:${MEMBER_SRC})*\\s*(?:\\+\\+|--)`, "g"))) add(m[1]);
  for (const m of f.matchAll(new RegExp(`(?:\\+\\+|--)\\s*(${ID_SRC})`, "g"))) add(m[1]);
  for (const m of f.matchAll(new RegExp(`(?<![\\w$.])(${ID_SRC})(?:${MEMBER_SRC})*\\s*\\.\\s*(?:${MUTATOR_METHODS})\\s*\\(`, "g"))) add(m[1]);
  for (const m of f.matchAll(new RegExp(`\\bdelete\\s+(${ID_SRC})`, "g"))) add(m[1]);
  for (const m of f.matchAll(new RegExp(`\\b(?:Object|Reflect)\\s*\\.\\s*(?:assign|defineProperty|defineProperties|setPrototypeOf|set|deleteProperty)\\s*\\(\\s*(${ID_SRC})`, "g"))) add(m[1]);
  // Escapes: a name read as a whole value where another name may come to hold it (an assignment's right side, a
  // return / yield / arrow body, a ternary or `||` arm, an array element, an object value or shorthand, a grouping
  // paren). Member reads, calls, spreads (copies), declarations, conditions and call arguments are not escapes.
  const enclosing = (at: number): number => {
    let depth = 0;
    for (let k = at - 1; k >= 0; k--) { const c = f[k]!; if (c === ")" || c === "]" || c === "}") depth++; else if (c === "(" || c === "[" || c === "{") { if (!depth) return k; depth--; } }
    return -1;
  };
  const paramList = (open: number): boolean => {
    if (/\bfunction\b[^(]*$/.test(f.slice(0, open))) return true;
    const close = matchForward(f, open);
    return close > 0 && /^\s*(?::[^=;{()]*)?(?:=>|\{)/.test(f.slice(close + 1));
  };
  for (const m of f.matchAll(new RegExp(`(?<![\\w$])${ID_SRC}(?![\\w$])`, "g"))) {
    const at = m.index!, pre = f.slice(0, at).trimEnd(), post = f.slice(at + m[0].length).trimStart();
    if (/^(?:\.|\?\.|\[|\(|=(?![=>]))/.test(post) || /(?:\.\.\.|\.|\?\.)$/.test(pre)) continue;
    const kw = pre.match(/([A-Za-z_$][\w$]*)$/)?.[1];
    if (kw) { if (/^(?:return|yield)$/.test(kw)) add(m[0]); continue; }
    const c = pre.at(-1) ?? "";
    if ((c === "=" && !/[=!<>]=$/.test(pre)) || (c === ">" && pre.endsWith("=>")) || c === "?" || c === ":" || /(?:\|\||&&|\?\?)$/.test(pre)) { add(m[0]); continue; }
    if (c !== "(" && c !== "," && c !== "[" && c !== "{") continue;
    const open = enclosing(at);
    if (open < 0) continue;
    const ob = f[open]!, before = f.slice(0, open).trimEnd();
    if (ob === "[") { if (!/[\w$)\]]$/.test(before)) add(m[0]); continue; } // an element, not an index
    if (ob === "{") { if (/^[,}]/.test(post)) add(m[0]); continue; } // a shorthand value, not a key
    if (paramList(open)) continue;
    const callee = before.match(/([A-Za-z_$][\w$]*)\s*(?:<[^<>]*>)?$/)?.[1];
    if (callee && !/^(?:if|while|for|switch|catch|return|typeof|await|yield|void|delete|in|of)$/.test(callee)) continue; // a call argument
    if (/[)\]]$/.test(before)) continue; // a call on a call result: an argument
    if (!callee || /^(?:return|yield|await)$/.test(callee)) add(m[0]); // a grouping paren around a value
  }
  // Call arguments: a name handed to a call the audit does not follow may be changed there. A same-file function's
  // parameter is linked to the argument it receives, so a parameter changed (or escaping) inside distrusts the argument.
  const fnParams = new Map<string, string[]>();
  for (const m of f.matchAll(new RegExp(`\\bfunction\\s*\\*?\\s*(${ID_SRC})\\s*(?:<[^>]*>)?\\s*\\(|\\b(?:const|let|var)\\s+(${ID_SRC})\\s*(?::[^=]*?)?=\\s*(?:async\\s+)?(?:function\\b[^(]*)?\\(`, "g"))) {
    const open = m.index! + m[0].length - 1, close = matchForward(f, open);
    if (close > open && (m[1] || paramList(open))) fnParams.set((m[1] ?? m[2])!, paramNames(code.slice(open + 1, close)));
  }
  for (const m of f.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(${ID_SRC})\\s*=\\s*(?:async\\s+)?(${ID_SRC})\\s*=>`, "g"))) fnParams.set(m[1]!, [m[2]!]);
  const spawnCallee = (callee: string): boolean => {
    const parts = callee.split(".");
    if (parts.length === 1) return NODE_SPAWN.has(callee) && !fnParams.has(callee);
    if (callee === "Bun.spawn" || callee === "Bun.spawnSync") return true;
    const imp = imports.get(parts[0]!);
    return parts.length === 2 && NODE_SPAWN.has(parts[1]!) && !!imp && CHILD_PROCESS.test(imp.module);
  };
  const links: Array<[string, string]> = [];
  for (const c of callsIn(code)) {
    const params = c.callee.includes(".") ? undefined : fnParams.get(c.callee);
    if (!params && (READ_ONLY_CALLEE.test(c.callee) || spawnCallee(c.callee))) continue;
    c.args.forEach((a, i) => {
      const id = flat(a).trim();
      if (!new RegExp(`^${ID_SRC}$`).test(id)) return;
      if (!params) add(id);
      else if (params[i]) links.push([params[i]!, id]);
      else add(id); // past the declared parameters: `arguments` or a rest the audit does not read
    });
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [p, a] of links) if (out.has(p) && !out.has(a)) { out.add(a); changed = true; }
  }
  return out;
}
/**
 * Names whose binding itself may be replaced (`execFileSync = () => {}`, `$ += …`, `x++`), read over a flat view of the
 * whole file: a function binding is judged by this, not by mutatedNames, since handing a function to another call or
 * naming it in an import list cannot change what it does. A `let` / `var` destructuring counts whole, since a later
 * destructuring assignment may rebind any name in it.
 */
function reboundNames(f: string): Set<string> {
  const out = new Set<string>();
  for (const m of f.matchAll(new RegExp(`(?<![\\w$.])(${ID_SRC})\\s*(?:\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?|[-+*/%&|^])?=(?![=>])`, "g"))) {
    const before = f.slice(0, m.index).match(/([A-Za-z_$][\w$]*)\s*$/)?.[1];
    if (before && /^(?:const|let|var|type)$/.test(before)) continue;
    out.add(m[1]!);
  }
  for (const m of f.matchAll(new RegExp(`(?<![\\w$.])(${ID_SRC})\\s*(?:\\+\\+|--)|(?:\\+\\+|--)\\s*(${ID_SRC})`, "g"))) out.add((m[1] ?? m[2])!);
  for (const m of f.matchAll(/\b(?:let|var)\s*[{[]([^=]*)[}\]]\s*=/g)) for (const n of m[1]!.matchAll(/[A-Za-z_$][\w$]*/g)) out.add(n[0]);
  return out;
}

type Val = { s: string } | { arr: string[]; open: boolean } | null;
type Pending = "sync" | "async" | "code";
/** What a walk saw, in run order: a gate (a review whose failure stops the script) or a ship; plus whether CfEnv deploy runs. */
interface Walk { events: Array<"gate" | "ship">; cfDeploy: boolean }

function lookupVar(sc: Scope | null, name: string): Binding | null | undefined {
  for (let s = sc; s; s = s.parent) if (s.vars.has(name)) return s.vars.get(name);
  return undefined;
}
function lookupFn(sc: Scope | null, name: string): Fn | undefined {
  for (let s = sc; s; s = s.parent) { if (s.vars.has(name)) return undefined; if (s.fns.has(name)) return s.fns.get(name); }
  return undefined;
}

/** Parameter names in order (a destructured or unnamed one is ""), from the masked text inside a parameter list. */
function paramNames(list: string): string[] {
  if (!list.trim()) return [];
  return splitTop(list, ",").map((p) => p.trim().match(/^(?:\.\.\.)?([A-Za-z_$][\w$]*)/)?.[1] ?? "");
}

/** A same-file function definition: `function f(…) {…}`, `const f = (…) => …`, `const f = function (…) {…}`. */
function fnDef(s: string, scope: Scope): { name: string; fn: Fn } | null {
  const f = flat(s);
  const block = (name: string, async: boolean, pOpen: number, generator = false): { name: string; fn: Fn } | null => {
    const close = matchForward(f, pOpen);
    if (close < 0) return null;
    const b = f.slice(close + 1).match(/^\s*(?::[^{]*)?\{/);
    if (!b) return null;
    const open = close + b[0].length;
    const end = matchForward(f, open);
    return end < 0 ? null : { name, fn: { params: paramNames(s.slice(pOpen + 1, close)), body: s.slice(open + 1, end), block: true, async, generator, scope } };
  };
  const d = f.match(/^(?:export\s+(?:default\s+)?)?(async\s+)?function\s*(\*)?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/);
  if (d) return block(d[3]!, !!d[1], d[0].length - 1, !!d[2]);
  // Matched on the masked text, not the flat view: a blanked string initializer is not whitespace to skip.
  const c = s.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*?)?=\s*(async\s+)?/);
  if (!c) return null;
  const name = c[1]!, async = !!c[2];
  let at = c[0].length;
  const fe = f.slice(at).match(/^function\b\s*(\*)?[^(]*\(/);
  if (fe) return block(name, async, at + fe[0].length - 1, !!fe[1]);
  let params: string[];
  if (f[at] === "(") {
    const close = matchForward(f, at);
    if (close < 0) return null;
    params = paramNames(s.slice(at + 1, close));
    at = close + 1;
  } else {
    const id = f.slice(at).match(/^([A-Za-z_$][\w$]*)\s*(?==>)/);
    if (!id) return null;
    params = [id[1]!];
    at += id[0].length;
  }
  const arrow = f.slice(at).match(/^\s*(?::[^=]*?)?=>\s*/);
  if (!arrow) return null;
  at += arrow[0].length;
  if (f[at] === "{") {
    const end = matchForward(f, at);
    return end < 0 ? null : { name, fn: { params, body: s.slice(at + 1, end), block: true, async, generator: false, scope } };
  }
  return { name, fn: { params, body: s.slice(at), block: false, async, generator: false, scope } };
}

/** Names the file binds by import: local name → its module and the name it imports (`*` namespace, `default`). */
function importsOf(code: string, lits: string[]): Ctx["imports"] {
  const out: Ctx["imports"] = new Map();
  for (const m of code.matchAll(/\bimport\s+(?:type\s+)?([^;\n]*?)\s+from\s+\u0000(\d+)\u0000/g)) {
    const mod = lits[Number(m[2])]!.slice(1, -1);
    const spec = m[1]!.trim();
    const ns = spec.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (ns) out.set(ns[1]!, { module: mod, imported: "*" });
    const def = spec.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/);
    if (def) out.set(def[1]!, { module: mod, imported: "default" });
    const named = spec.match(/\{([^}]*)\}/);
    if (named) for (const part of named[1]!.split(",")) {
      const pm = part.trim().match(/^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (pm) out.set(pm[2] ?? pm[1]!, { module: mod, imported: pm[1]! });
    }
  }
  // CommonJS: `const cp = require("node:child_process")`, `const { execFileSync: run } = require(…)`.
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*\u0000(\d+)\u0000\s*\)/g)) out.set(m[1]!, { module: lits[Number(m[2])]!.slice(1, -1), imported: "*" });
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*\u0000(\d+)\u0000\s*\)/g)) {
    for (const part of m[1]!.split(",")) {
      const pm = part.trim().match(/^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/);
      if (pm) out.set(pm[2] ?? pm[1]!, { module: lits[Number(m[2])]!.slice(1, -1), imported: pm[1]! });
    }
  }
  return out;
}

/** Every name the file declares itself (const/let/var/function/class, destructuring included): it shadows a global. */
function declaredNames(code: string): Set<string> {
  const f = flat(code);
  const out = new Set<string>();
  for (const m of f.matchAll(/\b(?:const|let|var|function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]!);
  for (const m of f.matchAll(/\b(?:const|let|var)\s+[{[]([^=]*)[}\]]\s*=/g)) for (const n of m[1]!.matchAll(/([A-Za-z_$][\w$]*)\s*(?=[,}\]]|$)/g)) out.add(n[1]!);
  return out;
}

/** The value of an expression when the audit can read it: a string, an array of words, or null. */
function evalExpr(e: string, sc: Scope, ctx: Ctx, depth = 0): Val {
  if (depth > 8) return null;
  let x = norm(e).replace(/\s+as\s+const$/, "").replace(/\s+(?:as|satisfies)\s+[\w$.<>[\]| ]+$/, "").replace(/!$/, "");
  x = norm(x);
  const lit = x.match(PH_ONE);
  if (lit) {
    const t = ctx.tmpl.get(Number(lit[1]));
    if (!t) return { s: ctx.lits[Number(lit[1])]!.slice(1, -1) };
    // Every ${…} read to a plain string (no escape, nothing unknown): the template's value is known (closing pass:
    // `wrangler ${"deploy"}` and `bun Review.ts ${dir} && …` were read as unknown).
    const vals = t.exprs.map((ex) => evalExpr(ex, sc, ctx, depth + 1));
    const known = vals.map((v) => (v && "s" in v && !/[\\\u0001]/.test(v.s) ? v.s : null));
    if (known.every((v) => v !== null) && !t.quasis.some((q) => q.includes("\\"))) return { s: t.quasis.map((q, i) => q + (known[i] ?? "")).join("") };
    // `${dir}/Review.ts` names Review.ts whatever dir is; any other template with an unread expression is unknown.
    return t.tail.startsWith("/") ? { s: `${UNKNOWN}${t.tail}` } : null;
  }
  if (x.startsWith("[") && matchForward(flat(x), 0) === x.length - 1) {
    const arr: string[] = [];
    for (const part of splitTop(x.slice(1, -1), ",")) {
      const p = part.trim();
      if (!p) continue;
      if (p.startsWith("...")) {
        const v = evalExpr(p.slice(3), sc, ctx, depth + 1);
        if (v && "arr" in v) { arr.push(...v.arr); if (v.open) return { arr, open: true }; continue; }
        return { arr, open: true };
      }
      const v = evalExpr(p, sc, ctx, depth + 1);
      arr.push(v && "s" in v ? v.s : UNKNOWN);
    }
    return { arr, open: false };
  }
  if (/^[A-Za-z_$][\w$]*$/.test(x)) {
    const b = lookupVar(sc, x);
    const v = b ? evalExpr(b.expr, b.scope, ctx, depth + 1) : null;
    // A string cannot change after its const declaration; an array can (`argv[0] = …`), so a changed name's array is unknown.
    return v && "arr" in v && ctx.mutated.has(x) ? null : v;
  }
  // A path join or resolve: only its last segment matters to which program it names.
  const call = x.match(/^(?:(path|posix|nodePath)\s*\.\s*)?(join|resolve)\s*\(/);
  if (call && matchForward(flat(x), call[0].length - 1) === x.length - 1 && pathHelper(call[1], call[2]!, sc, ctx)) {
    const args = splitTop(x.slice(call[0].length, -1), ",").filter((a) => a.trim());
    const last = args.length ? evalExpr(args.at(-1)!, sc, ctx, depth + 1) : null;
    return last && "s" in last ? { s: `${UNKNOWN}/${last.s}` } : null;
  }
  return null;
}

/**
 * True when `join` / `resolve` (or `path.join`, `posix.resolve`) here is node:path's: imported from it, or unbound and
 * never declared (calling it unbound throws, so it stops the script either way). A same-file function, a local object
 * or a changed binding of that name is not the path helper (closing pass: `function join() { return "--version" }`).
 */
function pathHelper(ns: string | undefined, name: string, sc: Scope, ctx: Ctx): boolean {
  const id = ns ?? name;
  const b = lookupVar(sc, id);
  // A function binding is judged by rebinding (naming it in an import list changes nothing); a namespace object also
  // by member changes (`path.join = …`).
  if ((b !== undefined && !(b && /^require\s*\(/.test(norm(b.expr)))) || lookupFn(sc, id) || ctx.rebound.has(id) || (ns !== undefined && ctx.mutated.has(id))) return false;
  const imp = ctx.imports.get(id);
  if (imp) return /^(?:node:)?path(?:\/posix)?$/.test(imp.module) && (ns ? ["*", "default", "posix"].includes(imp.imported) : imp.imported === name);
  return !ctx.declared.has(id) && !ctx.globalTampered;
}

/**
 * The spawn API a callee names, or null: a child_process import (bare, aliased or through a namespace / default
 * import), Bun.spawn / Bun.spawnSync, or a bare API name the file never declares (calling it unbound throws, so it
 * stops the script either way). A local function or object with the same name is not a spawn.
 */
function spawnApi(callee: string, sc: Scope, ctx: Ctx): string | null {
  const parts = callee.split(".");
  if (parts.length === 2) {
    const [ns, api] = parts as [string, string];
    if (ns === "Bun") return (api === "spawn" || api === "spawnSync") && !ctx.declared.has("Bun") && !ctx.mutated.has("Bun") && !ctx.globalTampered ? `Bun.${api}` : null;
    // A replaced member (`cp.execFileSync = () => {}`) is not the API: the review call may do nothing (final round 2).
    if (ctx.cpTampered) return null;
    const imp = ctx.imports.get(ns);
    const b = lookupVar(sc, ns);
    // A binding other than the module's own `require(…)` (a parameter, a local object) shadows the import.
    if (b !== undefined && !(b && /^require\s*\(/.test(norm(b.expr)))) return null;
    if (!imp || !CHILD_PROCESS.test(imp.module) || (imp.imported !== "*" && imp.imported !== "default")) return null;
    return NODE_SPAWN.has(api) ? api : null;
  }
  if (parts.length !== 1 || lookupVar(sc, callee) !== undefined || lookupFn(sc, callee) || ctx.rebound.has(callee) || ctx.cpTampered) return null;
  const imp = ctx.imports.get(callee);
  if (imp) return CHILD_PROCESS.test(imp.module) && NODE_SPAWN.has(imp.imported) ? imp.imported : null;
  // Unbound, the call throws, unless a global was given that name (`globalThis.execFileSync = …`).
  return NODE_SPAWN.has(callee) && !ctx.declared.has(callee) && !ctx.globalTampered ? callee : null;
}

/** What a spawn call runs: its argv (UNKNOWN for words the audit cannot read; `open` when more may follow) or a shell text. */
function spawnSpec(api: string, args: string[], sc: Scope, ctx: Ctx): { argv: string[]; open: boolean } | { shell: string } | null {
  if (!args.length) return null;
  const a0 = evalExpr(args[0]!, sc, ctx);
  if (api === "execSync" || api === "exec") return a0 && "s" in a0 ? { shell: a0.s } : null;
  if (api.startsWith("Bun.")) return a0 && "arr" in a0 ? { argv: a0.arr, open: a0.open } : null;
  const prog = a0 && "s" in a0 ? a0.s : UNKNOWN;
  const a1 = args[1]?.trim();
  if (!a1 || flat(a1).startsWith("{")) return { argv: [prog], open: false };
  const v1 = evalExpr(a1, sc, ctx);
  return v1 && "arr" in v1 ? { argv: [prog, ...v1.arr], open: v1.open } : { argv: [prog], open: true };
}

function isReviewArgv(argv: string[]): boolean { return effectiveProgram(argv).program === "review.ts"; }
function cfVerbOf(argv: string[]): string | null {
  const ep = effectiveProgram(argv);
  if (ep.program !== "cfenv.ts") return null;
  return (ep.args[0] === "pages" ? ep.args[1] : ep.args[0]) ?? null;
}
/** A spawn that may be a provider deploy: cf / wrangler with a deploy verb or any word the audit cannot read, `sh -c`, or an unnamed program given a deploy verb. */
function shipArgv(argv: string[], open: boolean): boolean {
  if (SHELL_PROGRAMS.has(programName(argv[0]))) {
    const c = argv.indexOf("-c");
    if (c > 0) return argv[c + 1] === undefined || argv[c + 1] === UNKNOWN || shellShips(argv[c + 1]!);
  }
  const ep = effectiveProgram(argv);
  if (ep.program === "cf" || ep.program === "wrangler") return open || ep.args.includes(UNKNOWN) || ep.args.includes("deploy") || (ep.args.includes("versions") && ep.args.includes("upload"));
  return ep.word === UNKNOWN && (ep.args.includes("deploy") || ep.args.includes("upload"));
}

/** Calls in `s` (masked): every `callee(` with its argument texts and span. */
function callsIn(s: string): Array<{ callee: string; args: string[]; start: number; close: number }> {
  const f = flat(s);
  const out: Array<{ callee: string; args: string[]; start: number; close: number }> = [];
  for (const m of f.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchForward(f, open);
    if (close < 0) continue;
    const callee = m[2]!.replace(/\s*\??\.\s*/g, ".");
    if (/^(?:if|for|while|switch|catch|function|return|typeof|await|new|void)$/.test(callee)) continue;
    out.push({ callee, args: splitTop(s.slice(open + 1, close), ",").filter((a) => a.trim()), start: m.index! + m[1]!.length, close });
  }
  return out;
}

/** Bun `$` templates in `s`: the shell text of each `$\`…\``. */
function shellTemplatesIn(s: string, ctx: Ctx): string[] {
  const out: string[] = [];
  for (const p of s.matchAll(PH)) {
    const lit = ctx.lits[Number(p[1])]!;
    if (lit.startsWith("`") && /(?:^|[^\w$.])\$\s*$/.test(s.slice(0, p.index!))) out.push(lit.slice(1, -1));
  }
  return out;
}

/** True when `$` names Bun's shell: imported from "bun", or never declared (unbound, it throws). */
function bunShell(ctx: Ctx): boolean {
  const imp = ctx.imports.get("$");
  return imp ? imp.module === "bun" && imp.imported === "$" && !ctx.rebound.has("$") : !ctx.declared.has("$") && !ctx.rebound.has("$") && !ctx.globalTampered;
}

/** Literal co-occurrence: a cf / wrangler word and a deploy verb in one statement is a ship, whatever builds the argv. */
function literalShip(s: string, ctx: Ctx): boolean {
  const vals = [...s.matchAll(PH)].map((p) => ctx.lits[Number(p[1])]!.slice(1, -1));
  const prov = vals.some((v) => !/\s/.test(v) && (programName(v) === "cf" || programName(v) === "wrangler"));
  return prov && (vals.includes("deploy") || (vals.includes("versions") && vals.includes("upload")));
}

/** Ships and CfEnv deploys a statement may run, never a gate: spawns, shell texts, and the helpers it calls or passes. */
function unit(s: string, sc: Scope, ctx: Ctx, depth: number, w: Walk): void {
  if (literalShip(s, ctx)) w.events.push("ship");
  for (const t of shellTemplatesIn(s, ctx)) {
    if (shellShips(t)) w.events.push("ship");
    if (shellRunsCfDeploy(t)) w.cfDeploy = true;
  }
  // The code inside each template's ${…} runs where the template is evaluated (nested templates through the recursion).
  for (const p of s.matchAll(PH)) for (const e of ctx.tmpl.get(Number(p[1]))?.exprs ?? []) unit(e, sc, ctx, depth, w);
  for (const c of callsIn(s)) {
    // For ships every spawn-shaped call counts, trusted or not (a method of the same name may still run a process).
    const fn = c.callee.includes(".") ? undefined : lookupFn(sc, c.callee);
    const last = c.callee.split(".").pop()!;
    const trusted = spawnApi(c.callee, sc, ctx);
    const api = trusted ?? (c.callee === "Bun.spawn" || c.callee === "Bun.spawnSync" ? c.callee : !fn && NODE_SPAWN.has(last) ? last : null);
    if (api) {
      const spec = spawnSpec(api, c.args, sc, ctx);
      if (spec && "shell" in spec) { if (shellShips(spec.shell)) w.events.push("ship"); if (shellRunsCfDeploy(spec.shell)) w.cfDeploy = true; }
      else if (spec) { if (shipArgv(spec.argv, spec.open)) w.events.push("ship"); if (cfVerbOf(spec.argv) === "deploy") w.cfDeploy = true; }
      // A shell text the audit cannot read may be anything, a deploy included (closing pass). A method merely named
      // `exec` (a RegExp's) is not a shell unless it resolves to child_process.
      else if (api === "execSync" || trusted === "exec") w.events.push("ship");
      continue;
    }
    if (fn && depth < 4) unit(fn.body, bindParams(fn, c.args, sc), ctx, depth + 1, w);
  }
  // A helper passed by name (`items.forEach(deployOne)`) may run with arguments the audit cannot see: its ships count.
  for (const m of flat(s).matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)(?![\w$])(?!\s*\()/g)) {
    const fn = lookupFn(sc, m[2]!);
    if (!fn) continue;
    if (!ctx.byRef.has(fn)) {
      ctx.byRef.set(fn, null); // in progress: a helper that names itself adds nothing more
      const sub: Walk = { events: [], cfDeploy: false };
      unit(fn.body, bindParams(fn, [], sc), ctx, depth + 1, sub);
      ctx.byRef.set(fn, { ship: sub.events.includes("ship"), cf: sub.cfDeploy });
    }
    const r = ctx.byRef.get(fn);
    if (r?.ship) w.events.push("ship");
    if (r?.cf) w.cfDeploy = true;
  }
}

function bindParams(fn: Fn, args: string[], caller: Scope): Scope {
  const vars = new Map<string, Binding | null>();
  fn.params.forEach((p, i) => { if (p) vars.set(p, args[i] !== undefined ? { expr: args[i]!, scope: caller } : null); });
  return { vars, fns: new Map(), parent: fn.scope };
}

/** True when `invariant` / `assert` throws on a false argument: the LifeOS helper, node:assert, or a same-file `if (!c) throw`. */
function trustedAssert(name: string, sc: Scope, ctx: Ctx): boolean {
  const base = name.split(".")[0]!;
  if (ctx.mutated.has(base)) return false; // reassigned or changed somewhere: not the function it was declared as
  const fn = lookupFn(sc, base);
  if (fn) {
    // An async or generator `invariant` does not throw at the call: the rejection lands after the next statements ran.
    if (fn.async || fn.generator) return false;
    // The body's first statement must be `if (!<first parameter>) throw …`.
    const first = norm(statementsOf(fn.body)[0] ?? "");
    const p = fn.params[0];
    return !!p && name === base && new RegExp(`^if ?\\( ?! ?\\(? ?${esc(p)} ?\\)? ?\\) ?\\{? ?throw\\b`).test(first);
  }
  const imp = ctx.imports.get(base);
  if (!imp) return !ctx.declared.has(base) && !ctx.globalTampered && lookupVar(sc, base) === undefined; // unbound: calling it throws
  return /(?:^|\/)(?:Invariant(?:\.ts)?|tiny-invariant|invariant)$/.test(imp.module) || (/^(?:node:)?assert(?:\/strict)?$/.test(imp.module));
}

/** The failure and success tests a gate accepts on a pending spawn result `v`. Bare truthiness is not one: Bun reports a signal kill as exitCode null. */
function failTest(d: string, v: string, k: Pending): boolean {
  const V = esc(v);
  const P = `${V} ?\\??\\. ?(?:exitCode|status)`;
  const forms = k === "code" ? [`^${V} ?!==? ?0$`, `^0 ?!==? ?${V}$`] : [`^${P} ?!==? ?0$`, `^0 ?!==? ?${P}$`, `^! ?${V} ?\\??\\. ?success$`];
  return forms.some((r) => new RegExp(r).test(norm(d)));
}
function okTest(d: string, v: string, k: Pending): boolean {
  const V = esc(v);
  const P = `${V} ?\\??\\. ?(?:exitCode|status)`;
  const forms = k === "code" ? [`^${V} ?===? ?0$`, `^0 ?===? ?${V}$`] : [`^${P} ?===? ?0$`, `^0 ?===? ?${P}$`, `^${V} ?\\??\\. ?success$`];
  return forms.some((r) => new RegExp(r).test(norm(d)));
}

/** True when the statements of `body` stop the script before anything can return past them: a throw, or an exit `exitOk` accepts. */
function stopsAlways(body: string, exitOk: (arg: string) => boolean, exitTrusted: boolean): boolean {
  let b = body.trim();
  if (b.startsWith("{")) {
    const end = matchForward(flat(b), 0);
    if (end < 0) return false;
    b = b.slice(1, end);
  } else {
    // A single-statement body ends at its first depth-0 `;`, newline or `else`.
    const f = flat(b);
    let depth = 0, n = 0;
    for (; n < f.length; n++) {
      const ch = f[n]!;
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      else if (depth === 0 && (ch === ";" || ch === "\n" || /^else\b/.test(f.slice(n)))) break;
    }
    b = b.slice(0, n);
  }
  for (const st of statementsOf(b)) {
    const s = norm(st);
    // A return, break or continue anywhere before the stop (`if (x) return;`) may leave before it.
    if (/\b(?:return|break|continue)\b/.test(withoutFnBodies(flat(s)))) return false;
    if (/^throw\b/.test(s)) return true;
    const ex = s.match(/^process ?\. ?exit ?\((.*)\)$/);
    if (ex) return exitTrusted && exitOk(norm(ex[1]!));
  }
  return false;
}

/**
 * `f` (a flat view) with the bodies of nested function expressions and method definitions (`{ f() { … } }`) blanked,
 * so their `return` is not read as the caller's. A method is `name(…) {` on one line with a name that is no control
 * keyword; a call followed by a block on the next line is two statements and stays as it is.
 */
function withoutFnBodies(f: string): string {
  let out = f;
  const blank = (open: number) => {
    const end = matchForward(f, open);
    if (end > open) out = out.slice(0, open + 1) + " ".repeat(end - open - 1) + out.slice(end);
  };
  for (const m of f.matchAll(/=>\s*\{|\bfunction\b[^{]*\{/g)) blank(m.index! + m[0].length - 1);
  for (const m of f.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)[ \t]*\(/g)) {
    if (/^(?:if|for|while|switch|catch|with|function|return|typeof|await|new|void|yield|delete|in|of|do|else|throw|case)$/.test(m[1]!)) continue;
    const pClose = matchForward(f, m.index! + m[0].length - 1);
    const b = pClose > 0 ? f.slice(pClose + 1).match(/^[ \t]*(?::[^{};\n]*)?\{/) : null;
    if (b) blank(pClose + b[0].length);
  }
  return out;
}

/** True when `process.exit` here is Node's: `process` is not declared, bound in scope, changed, or imported from elsewhere. */
function exitTrusted(sc: Scope, ctx: Ctx): boolean {
  const imp = ctx.imports.get("process");
  return !ctx.declared.has("process") && !ctx.mutated.has("process") && !ctx.processTampered && !ctx.globalTampered && lookupVar(sc, "process") === undefined && (!imp || /^(?:node:)?process$/.test(imp.module));
}

const NONZERO = /^[1-9]\d*$/;
/** `x || 1` is never 0; `x ?? 1` still is when x is 0, so only the pending result's own code may use `??`. */
const OR_NONZERO = /\|\| ?[1-9]\d*$/;

/**
 * A statement that acts on a pending spawn result: binds its exit code (`const code = await p.exited`), or stops the
 * script on its failure before anything else runs: `if (<failure>) <stop>`, `process.exit(<its code>)`, or a
 * trusted `invariant` / `assert` of its success. Returns "gate", "bound" or null.
 */
function checkStmt(s: string, pending: Map<string, Pending>, sc: Scope, ctx: Ctx): "gate" | "bound" | null {
  const n = norm(s);
  const b = n.match(/^const ([A-Za-z_$][\w$]*)(?: ?: ?number)? ?= ?(await )?([A-Za-z_$][\w$]*) ?\??\. ?(exited|exitCode|status)(?: ?\?\? ?[1-9]\d*)?$/);
  if (b && pending.has(b[3]!)) {
    const k = pending.get(b[3]!)!;
    const ok = k === "async" ? b[4] === "exited" && !!b[2] : k === "sync" && b[4] !== "exited";
    if (ok && !ctx.mutated.has(b[1]!)) { pending.set(b[1]!, "code"); return "bound"; }
  }
  for (const [v, k] of pending) {
    if (k === "async") continue;
    // An exit code that is nonzero whenever the review failed: a nonzero literal, the result's own code, or `x || N`.
    const own = (a: string) => NONZERO.test(a) || OR_NONZERO.test(a) || new RegExp(`^${k === "code" ? esc(v) : `${esc(v)} ?\\??\\. ?(?:exitCode|status)`}(?: ?(?:\\?\\?|\\|\\|) ?[1-9]\\d*)?$`).test(a);
    // `process.exit(r.exitCode ?? 1)` ends the script whatever the review returned, with its failure as the status.
    const ex = n.match(/^process ?\. ?exit ?\((.*)\)$/);
    if (ex && own(norm(ex[1]!)) && exitTrusted(sc, ctx)) return "gate";
    const iff = n.match(/^if ?\(/);
    if (iff) {
      const fs = flat(n);
      const close = matchForward(fs, iff[0].length - 1);
      if (close > 0 && splitTop(n.slice(iff[0].length, close), "||").some((d) => failTest(d, v, k)) && stopsAlways(n.slice(close + 1), own, exitTrusted(sc, ctx))) return "gate";
    }
    const as = n.match(/^((?:invariant|assert)(?: ?\. ?ok)?) ?\(/);
    if (as) {
      const close = matchForward(flat(n), as[0].length - 1);
      const first = close > 0 ? splitTop(n.slice(as[0].length, close), ",")[0] ?? "" : "";
      if (close === n.length - 1 && splitTop(first, "&&").some((d) => okTest(d, v, k)) && trustedAssert(as[1]!.replace(/ /g, ""), sc, ctx)) return "gate";
    }
  }
  return null;
}

/**
 * Walk the statements of `src` in run order, recording gates and ships (see the section note). Function definitions
 * are hoisted and run only where called; `if (import.meta.main)` runs its body; a try runs its body as part of the
 * walk only when its catch always rethrows or exits nonzero; every other compound statement is a unit that may ship
 * but never gates.
 */
/** Run `fn` on a scratch walk and carry its ships (one "ship" event) and CfEnv deploys into `w`, ahead of what follows. */
function first(w: Walk, fn: (x: Walk) => void): void {
  const x: Walk = { events: [], cfDeploy: false };
  fn(x);
  if (x.events.includes("ship")) w.events.push("ship");
  if (x.cfDeploy) w.cfDeploy = true;
}

function walkSeq(src: string, sc: Scope, ctx: Ctx, depth: number, w: Walk): void {
  const stmts = statementsOf(src);
  for (const s of stmts) { const d = fnDef(s, sc); if (d) sc.fns.set(d.name, d.fn); }
  const pending = new Map<string, Pending>();
  // Once a statement may return early (`if (x) return;` in a helper), nothing after it is sure to run: it may still
  // ship, but it never gates.
  let mayReturn = false;
  for (const raw of stmts) {
    const s = raw.replace(/^export\s+(?!default\b)/, "");
    const fs = flat(s);
    if (fnDef(s, sc) || /^(?:import|type|interface|declare|enum)\b/.test(fs)) continue;
    if (/^return\b/.test(fs)) { unit(s.slice(6), sc, ctx, depth, w); break; }
    if (mayReturn) { unit(s, sc, ctx, depth, w); continue; }
    if (/\breturn\b/.test(withoutFnBodies(fs))) { unit(s, sc, ctx, depth, w); mayReturn = true; continue; }
    const reassigned = fs.match(/^([A-Za-z_$][\w$]*)\s*=[^=]/)?.[1];
    if (reassigned) pending.delete(reassigned);
    const chk = checkStmt(s, pending, sc, ctx);
    // A ship anywhere in a checking statement runs before its stop or while failing toward it (the condition, the
    // exit code, the assert message, the body before `throw`): it counts before the gate.
    if (chk === "gate") { first(w, (x) => unit(s, sc, ctx, depth, x)); w.events.push("gate"); continue; }
    if (chk === "bound") continue;
    const child = (): Scope => ({ vars: new Map(), fns: new Map(), parent: sc });
    // `if (import.meta.main) { … }`: the body runs when the script runs.
    const main = fs.match(/^if\s*\(\s*import\s*\.\s*meta\s*\.\s*main\s*\)\s*/);
    if (main && depth < 6) {
      const at = main[0].length;
      const end = fs[at] === "{" ? matchForward(fs, at) : -1;
      if (end > 0) { walkSeq(s.slice(at + 1, end), child(), ctx, depth + 1, w); unit(s.slice(end + 1), sc, ctx, depth, w); continue; }
      if (fs[at] !== "{" && !/\belse\b/.test(fs.slice(at))) { walkSeq(s.slice(at), child(), ctx, depth + 1, w); continue; }
    }
    // try { A } catch { B } finally { C }: A is part of the walk only when B always stops the script.
    if (/^try\s*\{/.test(fs)) {
      const tOpen = fs.indexOf("{"), tEnd = matchForward(fs, tOpen);
      if (tEnd > 0) {
        const cm = fs.slice(tEnd + 1).match(/^\s*catch\s*(?:\(([^)]*)\))?\s*\{/);
        const cOpen = cm ? tEnd + cm[0].length : -1, cEnd = cm ? matchForward(fs, cOpen) : -1;
        const catchBody = cm && cEnd > 0 ? s.slice(cOpen, cEnd + 1) : "";
        // A finally runs after a failed review before the failure travels on. One that may ship, or may leave by
        // return / break / continue (dropping the failure), is never a gate; one that only logs keeps it travelling
        // (final round 2: refusing every finally broke a sound gate HEAD covered). An unreadable finally counts as unsafe.
        const fAt = (cm ? cEnd : tEnd) + 1;
        const fm = fs.slice(fAt).match(/^\s*finally\s*\{/);
        const fEnd = fm ? matchForward(fs, fAt + fm[0].length - 1) : -1;
        let finallySafe = !fm;
        if (fm && fEnd > 0) {
          const fBody = s.slice(fAt + fm[0].length, fEnd);
          const probe: Walk = { events: [], cfDeploy: false };
          unit(fBody, sc, ctx, depth, probe);
          finallySafe = !probe.events.length && !probe.cfDeploy && !/\b(?:return|break|continue)\b/.test(withoutFnBodies(flat(fBody)));
        }
        const transparent = finallySafe && (!cm || (cEnd > 0 && stopsAlways(catchBody, (a) => NONZERO.test(a) || OR_NONZERO.test(a), exitTrusted(sc, ctx))));
        if (transparent && depth < 6) walkSeq(s.slice(tOpen + 1, tEnd), child(), ctx, depth + 1, w);
        else unit(s.slice(tOpen + 1, tEnd), sc, ctx, depth, w);
        unit(s.slice(tEnd + 1), sc, ctx, depth, w);
        continue;
      }
    }
    // `[const v =] [await|void] <expr>`
    // Matched on the masked text, not the flat view: a blanked string initializer is not whitespace to skip.
    const bm = s.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*?)?=\s*/);
    const bind = bm?.[1];
    let at = bm ? bm[0].length : 0;
    const aw = s.slice(at).match(/^(await|void)\s+/);
    const awaited = aw?.[1] === "await";
    if (aw) at += aw[0].length;
    const expr = s.slice(at);
    const fe = flat(expr);
    if (bm) sc.vars.set(bind!, /^const\b/.test(fs) ? { expr, scope: sc } : null);
    // An awaited Bun shell: it throws on a nonzero exit unless `.nothrow()` or `.catch()` drops it.
    const tag = expr.match(/^\$\s*\u0000(\d+)\u0000/);
    if (tag && ctx.lits[Number(tag[1])]!.startsWith("`") && awaited && bunShell(ctx)) {
      const chain = expr.slice(tag[0].length);
      const methods = [...flat(chain).matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]!);
      const clean = /^(?:\s*\.\s*[A-Za-z_$][\w$]*\s*\([^()]*\))*\s*$/.test(flat(chain)) && methods.every((m) => SHELL_CHAIN_OK.has(m));
      // The template's ${…} and the chain's arguments run before the shell text, so their ships count before its gate;
      // the shell text's own order is shellCoverage's.
      const ph = `\u0000${tag[1]}\u0000`;
      first(w, (x) => { unit(s.split(ph).join("0"), sc, ctx, depth, x); for (const e of ctx.tmpl.get(Number(tag[1]))?.exprs ?? []) unit(e, sc, ctx, depth, x); });
      if (clean && shellCoverage(ctx.lits[Number(tag[1])]!.slice(1, -1), true) === "gated") w.events.push("gate");
      unit(s, sc, ctx, depth, w);
      continue;
    }
    const call = fe.match(/^([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)?)\s*\(/);
    const close = call ? matchForward(fe, call[0].length - 1) : -1;
    const tailOk = close > 0 && /^(?:\s*\.\s*(?:toString|trim)\s*\(\s*\))*\s*$/.test(fe.slice(close + 1));
    if (call && tailOk) {
      const callee = call[1]!.replace(/\s+/g, "");
      const args = splitTop(expr.slice(call[0].length, close), ",").filter((a) => a.trim());
      const api = spawnApi(callee, sc, ctx);
      if (api) {
        const spec = spawnSpec(api, args, sc, ctx);
        const reviewish = (sp: typeof spec) => !!sp && "argv" in sp && (isReviewArgv(sp.argv) || cfVerbOf(sp.argv) === "deploy" || cfVerbOf(sp.argv) === "review");
        if (THROWING_SPAWN.has(api)) {
          // Its arguments are evaluated before the review runs: a ship in them counts before the gate.
          first(w, (x) => { for (const a of args) unit(a, sc, ctx, depth, x); });
          if (spec && "shell" in spec ? shellCoverage(spec.shell, true) === "gated" : reviewish(spec)) w.events.push("gate");
        } else if (bind && !ctx.mutated.has(bind) && fe.slice(close + 1).trim() === "" && reviewish(spec) && (api === "spawnSync" || api === "Bun.spawnSync" || (api === "Bun.spawn" && !awaited))) {
          pending.set(bind, api === "Bun.spawn" ? "async" : "sync");
        }
        unit(s, sc, ctx, depth, w);
        continue;
      }
      // A same-file helper: its body runs here with its parameters bound to the arguments. An async helper's gates
      // count only when it is awaited; un-awaited it runs beside the next statement.
      const fn = callee.includes(".") ? undefined : lookupFn(sc, callee);
      // A generator call runs nothing until iterated; a reassigned helper is not the body declared under its name.
      if (fn && depth < 4 && !fn.generator && !ctx.mutated.has(callee) && (!fn.async || awaited) && fe.slice(close + 1).trim() === "") {
        if (literalShip(s, ctx)) w.events.push("ship");
        // The arguments run before the helper's body.
        for (const a of args) unit(a, sc, ctx, depth, w);
        walkSeq(fn.body, bindParams(fn, args, sc), ctx, depth + 1, w);
        continue;
      }
    }
    unit(s, sc, ctx, depth, w);
  }
}

/**
 * TypeScript: true when the script reaches a gate (a review, or CfEnv deploy / review, whose failure stops the script)
 * before anything ships, or when it runs `CfEnv.ts deploy` and nothing else in it can ship (CfEnv refuses its own
 * deploy when its review fails). A text the masked reader may misread is not analysed: not covered.
 */
function tsCovers(raw: string): boolean {
  const masked = maskTs(raw);
  if (!masked) return false;
  const { code, literals, tmpl } = masked;
  // Template expressions are code too: what they declare, change or let escape counts like any other line.
  const all = [code, ...[...tmpl.values()].flatMap((t) => t.exprs)].join("\n;\n");
  const imports = importsOf(code, literals);
  const mutated = mutatedNames(all, imports);
  const fa = flat(all);
  // A module object is changed for every binding of it when a `require(…)` of it is used as anything but a plain
  // declaration's value or a direct method call (`require(m).x = …`, `Object.assign(require(m), …)`; closing pass), or
  // when a module-object binding (namespace, default, `const cp = require(…)`) is changed or handed away. A named
  // function binding changed only rebinds itself, which spawnApi checks by name.
  const moduleTampered = (mod: RegExp): boolean =>
    [...all.matchAll(/\brequire\s*\(\s*\u0000(\d+)\u0000\s*\)/g)].some((m) => {
      if (!mod.test(literals[Number(m[1])]!.slice(1, -1))) return false;
      const pre = all.slice(0, m.index), post = all.slice(m.index! + m[0].length);
      const declared = /(?:^|[^\w$.])(?:const|let|var)\s+(?:[A-Za-z_$][\w$]*|\{[^{}]*\})\s*(?::[^=]*?)?=\s*$/.test(pre) && /^\s*(?:;|\n|$)/.test(post);
      return !declared && !/^\s*\??\.\s*[A-Za-z_$][\w$]*\s*\(/.test(post);
    }) || [...imports].some(([name, v]) => mod.test(v.module) && (v.imported === "*" || v.imported === "default") && mutated.has(name));
  const cpTampered = moduleTampered(CHILD_PROCESS);
  const processTampered = moduleTampered(/^(?:node:)?process$/);
  const globalTampered = ["globalThis", "global", "self", "window"].some((n) => mutated.has(n)) || /(?<![\w$.])(?:eval|Function)\s*\(/.test(fa);
  const ctx: Ctx = { lits: literals, tmpl, imports, declared: declaredNames(all), mutated, byRef: new Map(), rebound: reboundNames(fa), cpTampered, processTampered, globalTampered };
  const w: Walk = { events: [], cfDeploy: false };
  walkSeq(code, { vars: new Map(), fns: new Map(), parent: null }, ctx, 0, w);
  const gate = w.events.indexOf("gate"), ship = w.events.indexOf("ship");
  if (gate >= 0 && (ship < 0 || gate < ship)) return true;
  return w.cfDeploy && ship < 0;
}

/** The language of a deploy text when the caller does not say: TypeScript markers, else shell. */
function guessKind(text: string): DeployTextKind {
  return /\b(?:const|let|var|function|import)\s|=>|\bBun\.|\b(?:spawnSync|execFileSync|execSync)\s*\(/.test(text) ? "ts" : "shell";
}

/**
 * True when a deploy text (a PROJECTS.md deploy command, a package.json script, a deploy script) runs the review so
 * that a failed review stops the ship (LOSIntegrity S100). Shell (`kind: "shell"`): `Review.ts` or `CfEnv.ts review`
 * counts when its exit gates the rest (reviewGates); `CfEnv.ts deploy` also counts when nothing else in the
 * text ships, since CfEnv refuses its own deploy on a failed review. TypeScript (`kind: "ts"`): the same, through a
 * call that really runs and whose failure propagates (tsCovers).
 */
export function reviewCallEnforced(raw: string, kind: DeployTextKind = guessKind(raw)): boolean {
  return kind === "ts" ? tsCovers(raw) : shellCoverage(raw) !== null;
}

/** The commands a PROJECTS.md deploy cell names: its `code` spans, each read as its own shell line. */
function cellCommands(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
}

/** Every package.json deploy script under a PROJECTS.md path reaches the review, directly or through CfEnv. */
export function audit(projectsMd = lifeosPath("USER", "PROJECTS.md")): Array<{ path: string; ok: boolean; how: string }> {
  const out: Array<{ path: string; ok: boolean; how: string }> = [];
  const seen = new Set<string>();
  for (const line of readFileSync(projectsMd, "utf8").split("\n")) {
    const cells = line.split("|");
    if (cells.length < 6 || !cells[2]) continue;
    const m = cells[2].match(/`(~\/[^`]+)`/);
    if (!m) continue;
    const path = m[1].replace(/^~/, homedir());
    if (seen.has(path)) continue;
    seen.add(path);
    // The row's deploy cell says whether the project ships to Cloudflare. A Cloudflare deploy with
    // no package.json script is a gap, never a silent skip (2026-10-09 audit).
    const cell = cells[4] ?? "";
    const cfDeploy = /\bcf\b[^|]*deploy|CfEnv|deploy\.sh|wrangler|bun run deploy/i.test(cell);
    const pkg = join(path, "package.json");
    let script: string | undefined;
    try { script = existsSync(pkg) ? JSON.parse(readFileSync(pkg, "utf8")).scripts?.deploy : undefined; } catch { script = undefined; }
    // Each text is read in its own language: a deploy cell's `code` spans and a package.json script are shell, a
    // script file is TypeScript when it is a .ts file (LOSIntegrity S100).
    const calls = (t: string, kind: DeployTextKind = "shell") => reviewCallEnforced(t, kind);
    // A code deploy, not any Cloudflare call: a backup's `wrangler r2 object put` is not a deploy.
    const shipsToCf = (t: string) => /\b(?:cf|wrangler)\b[^\n]{0,40}\b(?:deploy|versions upload)\b|CfEnv(?:\.ts)?[^\n]{0,60}\bdeploy\b/.test(t);
    if (cellCommands(cell).some((c) => calls(c))) { out.push({ path: m[1], ok: true, how: "deploy cell calls it" }); continue; }
    const shell = cell.match(/`(bash|bun)\s+(?:\.\/)?([\w./-]+\.(?:sh|ts))/);
    const source = script ?? (shell ? `${shell[1]} ${shell[2]}` : undefined);
    if (!source) {
      if (cfDeploy) out.push({ path: m[1], ok: false, how: `missing: deploy cell names a Cloudflare deploy but no package.json deploy script or deploy.sh resolves (${cell.trim().slice(0, 60)})` });
      continue;
    }
    const direct = calls(source);
    const file = source.match(/(?:bun|bash)\s+(?:\.\/)?([\w./-]+\.(?:ts|sh))/)?.[1];
    // A row may name several directories (engine · cloud fleet); the script can live in any of them.
    // A worker under a fleet runs the fleet's script, so parent directories count too (up to three).
    const named = [path, ...[...cells[2].matchAll(/`(~\/[^`]+)`/g)].map((x) => x[1]!.replace(/^~/, homedir()))];
    const roots = named.flatMap((r) => [r, dirname(r), dirname(dirname(r)), dirname(dirname(dirname(r)))]);
    const found = file ? roots.map((r) => join(r, file)).find((p) => existsSync(p)) : undefined;
    const text = found ? readFileSync(found, "utf8") : "";
    // A deploy script that never reaches Cloudflare (a local install, a backup) is not this rule's business.
    if (!direct && !shipsToCf(source) && !shipsToCf(text) && !cfDeploy) continue;
    // A covered script counts only when the text that runs it does not ship on its own: in
    // `bun scripts/deploy.ts && wrangler deploy` the second deploy never passes through the script's review.
    const viaScript = !!text && !shellShips(source) && calls(text, /\.ts$/.test(found ?? "") ? "ts" : "shell");
    const why = file && !text ? `script not found: ${file} (stale PROJECTS.md row?)` : `no review call in: ${source.slice(0, 80)}`;
    out.push({ path: m[1], ok: direct || viaScript, how: direct ? "direct" : viaScript ? `${file}` : `missing: ${why}` });
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const flags = parseReviewFlags(argv);
  if (!flags.ok) { console.error(`review: ${flags.error}`); process.exit(2); }
  const pos = flags.rest.filter((a) => !a.startsWith("--"));
  if (pos[0] === "audit") {
    const rows = audit();
    if (json) console.log(JSON.stringify(rows, null, 2));
    else for (const r of rows) console.log(`${r.ok ? "ok  " : "GAP "} ${r.path}  (${r.how})`);
    process.exit(rows.every((r) => r.ok) ? 0 : 1);
  }
  if (pos[0] === "status") {
    const rec = status(pos[1] ?? ".");
    console.log(json ? JSON.stringify(rec, null, 2) : rec ? `${rec.status} ${rec.ts} ${rec.head.slice(0, 7)} ${rec.tier} ${rec.reviewerModel ?? rec.reviewerVendors.join("+")} findings=${rec.findings.length}` : "no review recorded");
    process.exit(0);
  }
  try {
    const o = await review({ dir: pos[0] ?? ".", allowDirty: flags.allowDirty, waiveBlockers: flags.waiveBlockers, pastRoundCap: flags.pastRoundCap });
    if (json) console.log(JSON.stringify({ code: o.code, message: o.message, record: o.record ?? null }, null, 2));
    else (o.code === 1 ? console.error : console.log)(o.message);
    process.exit(o.code);
  } catch (e) {
    console.error(`review: error — ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
