#!/usr/bin/env bun
/**
 * @version 0.4.0
 * ReviewSuite — replays a past code review on a miss and scores whether the reviewer catches it now
 * (review-miss-evals ISA, F5 and F7).
 *
 * A replay rebuilds exactly what the review read (ReviewReplay.rebuildInput), keeps only the batches that hold a
 * labelled file (each batch is an independent reviewer call in Review.ts, so the others cannot change the catch), and
 * runs up to three arms (ISC-44):
 *   - missed: the model the missing review recorded, pinned, under the prompt that missed it (ISC-17). Run once at
 *     admission at MISSED_K samples and cached by the review's recorded model, never rerun when today's reviewer moves.
 *     The review prompt has not changed since Review.ts began (one short-lived builder edit aside), so a missed arm is
 *     rebuilt only while the incumbent's prompt still equals the one that missed;
 *   - incumbent: the committed reviewer, the vendor's default model at the review's tier level, k samples;
 *   - candidate: a proposed reviewer change (`suite --candidate`), its own prompt, builder and batching used for the call.
 * Each arm has one fingerprint (ISC-24). Cells are cached by case and arm fingerprint, and two arms with one fingerprint
 * run once and share the result, so a candidate identical to the incumbent costs nothing.
 * A sample catches when any finding names a labelled file within LINE_SLACK lines of a labelled line (ISC-18). A sample
 * with any failed reviewer call is no result, never a miss or a clean pass (ISC-33). Replay calls the reviewer directly
 * and never Review.ts's review(), so no record is written and no deploy base moves (ISC-32). Every result is appended
 * to the STATVS `review-replay` stream (ISC-19) and to a local file the suite report reads.
 *
 * The morning run (F7, `suite`) replays only cells it has no result for: a cell is one case under one reviewer
 * fingerprint (ISC-24, ISC-39), so a day with no new case and no reviewer change makes zero reviewer calls. It scores
 * only admitted cases (ISC-43), spends at most --max-calls through one shared limit of SUITE_CONCURRENT (ISC-41),
 * probes the lane before spending, refuses to score a dirty Review.ts (ISC-42), and writes only its rows and one
 * event (ISC-46).
 *
 * `suite --candidate <git rev or file>` (ISC-45) scores an uncommitted reviewer change before it lands: the incumbent is
 * Review.ts at HEAD, the candidate is loaded from the rev or file as a module (its SYSTEM_PROMPT, buildUserPrompt,
 * batchDiff and parseVerdict are the ones the call uses) and nothing is edited. `unscored` is the advisory check that the
 * live reviewer fingerprint has a score; it never blocks anything.
 *
 * USAGE:
 *   bun ReviewSuite.ts replay <case id> [--k 3] [--max-calls 24] [--json]
 *   bun ReviewSuite.ts suite [--candidate <rev|path>] [--max-calls 200] [--dry-run] [--vigil] [--json]
 *   bun ReviewSuite.ts unscored [--json]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { invariant } from "./Invariant";
import { assertEvaluatorVendor } from "./lib/EvaluatorEgress";
import { redact } from "./lib/Boundary";
import { OPENAI_LANE_EFFORT, pinnedModelForEffort, UNIFORM_HARNESS_EFFORT } from "./models";
import { openAiModelForLevel } from "./Inference";
import { batchDiff, buildUserPrompt, defaultReviewStatvsWriter, DIFF_BUDGET, EXCLUDES, HIGH_PATH, ISA_BUDGET, LEVEL, MAX_BATCHES, REVIEW_VERSION, parseVerdict, stateDir, SYSTEM_PROMPT, type Finding, type ReviewRecord, type ReviewRequest, type ReviewerResult, type Tier, type Vendor, type Verdict } from "./Review";
import { casesPath, readCases, readJudgments, readLabels, type ReviewCase } from "./ReviewCases";
import { rebuildInput } from "./ReviewReplay";

export const LINE_SLACK = 3;
export const DEFAULT_K = 3;
export const DEFAULT_MAX_CALLS = 24;

/** The missed arm runs once, at admission, with this many samples; it is a historical constant, never rerun for a reviewer change (ISC-44). */
export const MISSED_K = 5;

/** One reviewer call with an optional pinned model and the verdict parser of the reviewer being scored. */
export type ReplayRequest = ReviewRequest & { model?: string; parse?: (raw: unknown) => Verdict | null };
export type ReplayCall = (req: ReplayRequest) => Promise<ReviewerResult>;

export type Sample = { caught: boolean; blocking: boolean; findings: number; fileOnly: number } | { noResult: string };
export type Arm = "missed" | "incumbent" | "candidate";
/** Arms in the order a replay runs and reports them. */
export const ARMS: readonly Arm[] = ["missed", "incumbent", "candidate"];
/** `ran: false` is an arm that could not be rebuilt (no pin, another prompt, no labelled batch): settled for its fingerprint, never unanswered.
 *  `sameAs` names the arm whose run this result is, when two arms had one fingerprint and ran once. */
export interface ArmResult { arm: Arm; ran: boolean; fingerprint: string; k: number; sameAs?: Arm; models: string[]; samples: Sample[]; scored: number; catchRate: number | null; blockingRate: number | null }
export interface ReplayResult {
  caseId: string; fix: string; at: string; k: number; vendors: Vendor[]; batches: number; promptHash: string; promptMatches: boolean | null;
  /** The primary arm's combined fingerprint (the incumbent's when it ran), kept for readers of the older row shape. */
  fingerprint: string | null; vendorFingerprints: Record<string, string>;
  /** Every distinct arm fingerprint this replay planned, including those of arms that could not run. */
  fingerprints: string[];
  planned: number; calls: number; arms: ArmResult[]; error?: string;
}
/** Rows written before the three arms named them treatment and control: the treatment is the incumbent, the control the missed arm
 *  (whose old fingerprint was no case-stable key, so it never matches and the missed arm reruns once at MISSED_K). */
const LEGACY_ARM: Record<string, Arm> = { treatment: "incumbent", control: "missed" };
function normalizeReplay(raw: ReplayResult): ReplayResult {
  const fingerprints = Array.isArray(raw.fingerprints) ? raw.fingerprints : raw.fingerprint ? [raw.fingerprint] : [];
  const arms = (raw.arms ?? []).map((a) => {
    const arm = LEGACY_ARM[a.arm as string] ?? a.arm;
    return { ...a, arm, k: a.k ?? raw.k, fingerprint: a.fingerprint ?? (arm === "missed" ? "legacy-control" : raw.fingerprint ?? "none") };
  });
  return { ...raw, fingerprints, arms };
}

// One shared import: two arms importing JudgeCall at once hit Bun 1.3's "Cannot access 'INFERENCE_DISABLED_FLAG'
// before initialization" (the same race Review.ts's judgeModule guards against; seen in the first live replay).
let judgeModule: Promise<typeof import("../ASSAY/JudgeCall")> | null = null;
const defaultCall: ReplayCall = async (req) => {
  try { assertEvaluatorVendor(req.vendor, "review"); } catch (e) { return { ok: false, error: (e as Error).message }; }
  const { judgeText } = await (judgeModule ??= import("../ASSAY/JudgeCall"));
  // Secret values never leave for a vendor: a replay rebuilds the review's diff, decrypting a secret-bearing .diff.age when there is one, so the prompt is masked here exactly as Review.ts masks the live call.
  const r = await judgeText({ systemPrompt: req.system, userPrompt: redact(req.user), level: req.level, vendor: req.vendor, ...(req.model ? { model: req.model } : {}), allowVendorFallback: false, expectJson: true, timeout: 600_000 });
  if (!r.success) return { ok: false, error: r.error ?? "reviewer failed" };
  if (r.vendor !== req.vendor) return { ok: false, error: `reviewer ran on ${r.vendor}, not ${req.vendor}` };
  // Inference falls back from the top model to the next on failure; that answer belongs to another fingerprint.
  if (r.modelDowngraded) return { ok: false, error: `model downgraded to ${r.executedModel ?? "another model"}` };
  const verdict = (req.parse ?? parseVerdict)(r.parsed);
  // The codex lane passes --model and reports it; the API refuses a model it will not serve. A transport that reports nothing is unverified.
  return verdict ? { ok: true, verdict, model: r.executedModel ?? `${req.model ?? req.vendor} (unverified)` } : { ok: false, error: "reviewer returned no valid verdict" };
};

export const promptHash = (): string => createHash("sha256").update(SYSTEM_PROMPT).digest("hex").slice(0, 16);

const PROMPT_PARTS = [/export const SYSTEM_PROMPT = `[\s\S]*?`;/, /export function buildUserPrompt[\s\S]*?\n}\n/];
/** The review prompt's source (system prompt and user-prompt builder) in one version of Review.ts. */
const promptSource = (src: string): string => PROMPT_PARTS.map((re) => re.exec(src)?.[0].replace(/^export /, "") ?? "").join("\n");
/** Did the review at `ts` run on today's prompt? Compares Review.ts as committed then with the incumbent's source (the file today by default). */
export function promptMatchesAt(ts: string, current?: string): boolean {
  const root = join(import.meta.dir, "..", "..");
  const rev = spawnSync("git", ["log", "-1", `--before=${ts}`, "--format=%H", "--", "LIFEOS/TOOLS/Review.ts"], { cwd: root, encoding: "utf8" }).stdout.trim();
  if (!rev) return false;
  const then = spawnSync("git", ["show", `${rev}:LIFEOS/TOOLS/Review.ts`], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).stdout;
  return !!then && promptSource(then) === promptSource(current ?? readFileSync(join(import.meta.dir, "Review.ts"), "utf8"));
}

/** The model a vendor's reviewer is configured to run at a level today: what ModelSync moves. */
export function servedModel(vendor: Vendor, level: ReviewRequest["level"]): string {
  return vendor === "openai" ? openAiModelForLevel(level) : pinnedModelForEffort(level);
}

/** Everything that changes what the reviewer says about one input, at one vendor and level (ISC-24): the prompt and its
 *  builder, how the diff is cut into batches and how much is read, the tier map, REVIEW_VERSION and the served model. */
const fnSource = (src: string, name: string): string => new RegExp(`export function ${name}[\\s\\S]*?\\n}\\n`).exec(src)?.[0] ?? "";
const reviewSource = (): string => readFileSync(join(import.meta.dir, "Review.ts"), "utf8");
/** The constants a reviewer reads from its own file. A candidate's come from the module loaded from its source, so a budget
 *  edit moves its fingerprint; a bare source string falls back to today's values. */
export interface ReviewerConsts { DIFF_BUDGET: number; ISA_BUDGET: number; MAX_BATCHES: number; HIGH_PATH: RegExp; EXCLUDES: string[]; LEVEL: Record<Tier, ReviewRequest["level"]>; REVIEW_VERSION: string }
const liveConsts = (): ReviewerConsts => ({ DIFF_BUDGET, ISA_BUDGET, MAX_BATCHES, HIGH_PATH, EXCLUDES, LEVEL, REVIEW_VERSION });
export function reviewerFingerprint(vendor: Vendor, level: ReviewRequest["level"], deps: { source?: string; model?: string; consts?: ReviewerConsts } = {}): string {
  const source = deps.source ?? reviewSource();
  const c = deps.consts ?? liveConsts();
  // Source text, never Function.toString(), so a runtime upgrade is no reviewer change.
  const parts = [promptSource(source), fnSource(source, "batchDiff"), fnSource(source, "parseVerdict"), c.DIFF_BUDGET, c.ISA_BUDGET, c.MAX_BATCHES, String(c.HIGH_PATH), JSON.stringify(c.EXCLUDES), JSON.stringify(c.LEVEL), c.REVIEW_VERSION, JSON.stringify(OPENAI_LANE_EFFORT), UNIFORM_HARNESS_EFFORT, vendor, level, deps.model ?? servedModel(vendor, level)];
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}
/** A reviewer slot: one vendor at one level. */
export const slot = (vendor: Vendor, level: ReviewRequest["level"]): string => `${vendor}@${level}`;
/** A case's per-slot fingerprints, from a table computed once per run. */
export type FingerprintFn = (vendors: Vendor[], level: ReviewRequest["level"]) => Record<string, string>;
export function fingerprintTable(source = reviewSource(), consts?: ReviewerConsts): FingerprintFn {
  const memo = new Map<string, string>();
  return (vendors, level) => Object.fromEntries([...vendors].sort().map((v) => {
    const key = slot(v, level);
    if (!memo.has(key)) memo.set(key, reviewerFingerprint(v, level, { source, consts }));
    return [key, memo.get(key)!];
  }));
}
const combine = (fps: Record<string, string>): string => {
  const keys = Object.keys(fps).sort();
  return keys.length ? createHash("sha256").update(keys.map((k) => `${k}=${fps[k]}`).join("+")).digest("hex").slice(0, 16) : "none";
};

/** One reviewer as a replay uses it: the pieces of Review.ts that decide what the model is asked and how it is read, plus its fingerprint. */
export interface ReviewerSpec {
  label: string; source: string;
  system: string; buildUserPrompt: typeof buildUserPrompt; batchDiff: typeof batchDiff; parseVerdict: typeof parseVerdict;
  isaBudget: number; level: Record<Tier, ReviewRequest["level"]>; fingerprint: FingerprintFn;
}
/** Review.ts as this process has it loaded: the committed reviewer whenever a scheduled run's dirty check passed. */
export function incumbentSpec(fingerprint?: FingerprintFn): ReviewerSpec {
  const source = reviewSource();
  return { label: "incumbent", source, system: SYSTEM_PROMPT, buildUserPrompt, batchDiff, parseVerdict, isaBudget: ISA_BUDGET, level: LEVEL, fingerprint: fingerprint ?? fingerprintTable(source) };
}

const REVIEW_PATH = "LIFEOS/TOOLS/Review.ts";
const repoRoot = (): string => join(import.meta.dir, "..", "..");
/** Review.ts's imports are relative to LIFEOS/TOOLS; a copy loaded from elsewhere keeps meaning the same files. */
const absolutize = (source: string): string => source.replace(/(\bfrom\s+|\bimport\s*\(\s*|\brequire\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']*)\2/g, (_m, pre: string, q: string, rel: string) => `${pre}${q}${resolve(import.meta.dir, rel)}${q}`);

/** Loads a Review.ts source as a module and takes the reviewer parts from it, so a candidate's own prompt and builder are the ones
 *  used for the call, not only hashed. The copy lives in a temp directory just long enough to be imported. */
export async function loadReviewerSpec(source: string, label: string): Promise<ReviewerSpec> {
  const dir = mkdtempSync(join(tmpdir(), "review-candidate-"));
  try {
    const file = join(dir, "Review.ts");
    writeFileSync(file, absolutize(source));
    const m = await import(file) as Partial<typeof import("./Review")>;
    if (typeof m.SYSTEM_PROMPT !== "string" || typeof m.buildUserPrompt !== "function" || typeof m.batchDiff !== "function" || typeof m.parseVerdict !== "function" || !m.LEVEL) throw new Error("it does not export the reviewer's SYSTEM_PROMPT, buildUserPrompt, batchDiff, parseVerdict and LEVEL");
    const consts: ReviewerConsts = { DIFF_BUDGET: m.DIFF_BUDGET!, ISA_BUDGET: m.ISA_BUDGET!, MAX_BATCHES: m.MAX_BATCHES!, HIGH_PATH: m.HIGH_PATH!, EXCLUDES: m.EXCLUDES!, LEVEL: m.LEVEL, REVIEW_VERSION: m.REVIEW_VERSION! };
    return { label, source, system: m.SYSTEM_PROMPT, buildUserPrompt: m.buildUserPrompt, batchDiff: m.batchDiff, parseVerdict: m.parseVerdict, isaBudget: m.ISA_BUDGET!, level: m.LEVEL, fingerprint: fingerprintTable(source, consts) };
  } catch (e) {
    throw new Error(`candidate ${label} cannot be loaded as a reviewer: ${(e as Error).message}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const gitOut = (cwd: string, args: string[]): string | null => { const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }); return r.status === 0 ? r.stdout : null; };
/** A Review.ts source from a file path or a git revision of this repo. Never writes anything. */
export function reviewerSource(spec: string, root = repoRoot()): { source: string; label: string } {
  if (existsSync(spec) && statSync(spec).isFile()) return { source: readFileSync(spec, "utf8"), label: `file ${basename(spec)}` };
  if (!/^[\w][\w./~^@{}-]*$/.test(spec)) throw new Error(`"${spec}" is neither a file nor a git revision`);
  const text = gitOut(root, ["show", `${spec}:${REVIEW_PATH}`]);
  if (text === null) throw new Error(`"${spec}" is neither a file nor a git revision holding ${REVIEW_PATH}`);
  return { source: text, label: `rev ${gitOut(root, ["rev-parse", "--short=12", spec])?.trim() || spec}` };
}
/** The committed reviewer: Review.ts at HEAD, whatever the working file holds. */
export const committedReviewerSource = (root = repoRoot()): string => reviewerSource("HEAD", root).source;

/** The missed arm's cell key: the model that missed, stable for the case, so a reviewer change never reopens it (ISC-44). */
export function missedFingerprint(readBy: Pick<ReviewRecord, "reviewerModel"> | null): string {
  return `missed:${createHash("sha256").update(["missed", readBy?.reviewerModel ?? "none"].join("\0")).digest("hex").slice(0, 12)}`;
}

/** The repo-relative paths a finding's file may mean: as given, without ./, without a diff's a/ or b/, under the scope. */
function candidates(file: string, scope: string): string[] {
  const p = file.replace(/^\.\//, "");
  const out = [p, p.replace(/^[ab]\//, "")];
  if (scope !== ".") out.push(...out.map((x) => `${scope}/${x}`));
  return out;
}
/** Does this finding name the bug the fix repaired: a labelled file, near a labelled line? (ISC-18, deterministic half) */
export function hits(f: Pick<Finding, "file" | "line">, c: Pick<ReviewCase, "label" | "scope">): boolean {
  if (!f.line || f.line < 1) return false;
  const files = new Set(candidates(f.file, c.scope));
  return c.label.some((l) => files.has(l.file) && l.lines.some((n) => Math.abs(n - f.line!) <= LINE_SLACK));
}
/** A finding on a labelled file with no usable line: counted beside the catch, never as one. */
export function fileOnly(f: Pick<Finding, "file" | "line">, c: Pick<ReviewCase, "label" | "scope">): boolean {
  const files = new Set(candidates(f.file, c.scope));
  return (!f.line || f.line < 1) && c.label.some((l) => files.has(l.file));
}

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** The ISA the reviewer read: the scope's, else the repo root's, at the reviewed head, never today's file. */
function isaAt(repo: string, head: string, scope: string, budget = ISA_BUDGET): string {
  for (const p of [scope === "." ? "ISA.md" : `${scope}/ISA.md`, "ISA.md"]) { const t = git(repo, ["show", `${head}:${p}`]); if (t !== null) return t.slice(0, budget); }
  return "";
}

function record(file: string): ReviewRecord | null {
  const p = join(stateDir(), file);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as ReviewRecord; } catch { return null; }
}

/** Recorded models per vendor, e.g. "gpt-x + claude-y" → { openai: gpt-x, anthropic: claude-y }. */
function recordedModels(rec: ReviewRecord, vendors: Vendor[]): Partial<Record<Vendor, string>> {
  const ids = (rec.reviewerModel ?? "").split(" + ").map((s) => s.trim()).filter(Boolean);
  const out: Partial<Record<Vendor, string>> = {};
  for (const id of ids) { const v: Vendor = /claude|anthropic|opus|sonnet|haiku/i.test(id) ? "anthropic" : "openai"; if (vendors.includes(v)) out[v] = id; }
  return out;
}

export function replaysPath(): string { return join(casesPath(), "..", "replays.jsonl"); }

/** At most this many reviewer calls at once, as in Review.ts. */
export const MAX_CONCURRENT = 8;
/** At most this many at once across a whole morning run, so the plan keeps headroom for live deploy reviews. */
export const SUITE_CONCURRENT = 4;
export type Gate = <T>(f: () => Promise<T>) => Promise<T>;
/** One limit shared by every call it wraps: a finished call hands its slot straight to the next waiter. */
export function limiter(n: number): Gate {
  invariant(Number.isInteger(n) && n >= 1, "a limit is a positive integer");
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(f: () => Promise<T>): Promise<T> => {
    if (active < n) active++; else await new Promise<void>((r) => waiting.push(r));
    try { return await f(); } finally { const next = waiting.shift(); if (next) next(); else active--; }
  };
}

let secretCheck: ((t: string) => string | null) | null = null;
const scrub = (t: string): string => {
  secretCheck ??= (require("../STATVS/lib/refuse") as { credentialRefusal: (t: string) => string | null }).credentialRefusal;
  if (secretCheck(t)) return "[withheld: secret-shaped text]";
  // Error text from git or a transport can carry absolute paths; they never reach a row or an event.
  return t.replace(/(?:~|\/)(?:[\w.@+-]+\/)+[\w.@+-]*/g, "[path]");
};

export interface ReplayOpts {
  /** Samples per incumbent or candidate cell. */ k?: number;
  /** Samples for the missed arm, run once at admission. */ missedK?: number;
  maxCalls?: number; call?: ReplayCall; write?: (row: object) => unknown; promptMatches?: (ts: string) => boolean; gate?: Gate;
  /** Fingerprints for the incumbent, when no incumbent spec is given. */ fingerprint?: FingerprintFn;
  incumbent?: ReviewerSpec; candidate?: ReviewerSpec;
  /** The arms to run; by default missed and incumbent, plus candidate when a candidate is given. */ arms?: Arm[];
  expectedModel?: (vendor: Vendor, level: ReviewRequest["level"]) => string | null;
}

export async function replayCase(c: ReviewCase, opts: ReplayOpts = {}): Promise<ReplayResult> {
  const incumbent = opts.incumbent ?? incumbentSpec(opts.fingerprint);
  const asked = opts.arms ?? (opts.candidate ? ARMS : ARMS.filter((a) => a !== "candidate"));
  const want = ARMS.filter((a) => asked.includes(a));
  invariant(want.length > 0, "a replay runs at least one arm");
  invariant(!want.includes("candidate") || Boolean(opts.candidate), "a candidate arm needs a candidate reviewer");
  const k = opts.k ?? DEFAULT_K, missedK = opts.missedK ?? MISSED_K;
  invariant(Number.isInteger(k) && k >= 1 && Number.isInteger(missedK) && missedK >= 1, "k is a positive integer");
  const kOf = (arm: Arm): number => (arm === "missed" ? missedK : k);
  const specOf = (arm: Arm): ReviewerSpec => (arm === "candidate" ? opts.candidate! : incumbent);
  const at = new Date().toISOString();
  const rec = record(c.review.file);
  const readBy = record(c.readBy);
  /** One arm's fingerprint (ISC-24): the incumbent's and candidate's from their own source, the missed arm's from the model that missed. */
  const fpOf = (arm: Arm): { fp: string; table: Record<string, string> } => {
    if (arm === "missed") return { fp: missedFingerprint(readBy), table: {} };
    if (rec === null) return { fp: "none", table: {} };
    const spec = specOf(arm), table = spec.fingerprint(rec.reviewerVendors, spec.level[rec.tier]);
    return { fp: combine(table), table };
  };
  const fps = new Map(want.map((a) => [a, fpOf(a)] as const));
  const primary = want.find((a) => a !== "missed") ?? "missed";
  const base: ReplayResult = { caseId: c.id, fix: c.fix, at, k, vendors: rec?.reviewerVendors ?? [], batches: 0, promptHash: promptHash(), promptMatches: null, fingerprint: rec ? fps.get(primary)!.fp : null, vendorFingerprints: fps.get(primary)!.table, fingerprints: [...new Set(want.map((a) => fps.get(a)!.fp))], planned: 0, calls: 0, arms: [] };
  const finish = (r: ReplayResult): ReplayResult => {
    if (r.error) r.error = scrub(r.error);
    mkdirSync(join(replaysPath(), ".."), { recursive: true });
    appendFileSync(replaysPath(), JSON.stringify(r) + "\n");
    try {
      const w = (opts.write ?? defaultReviewStatvsWriter)({ writer: "tool:ReviewSuite", stream: "review-replay", class: "personal", kind: "review-replay", title: `replay ${r.error ? "error" : "done"}`, data: { ...r, fix: r.fix.slice(0, 12) } });
      const refused = (w as { refused?: string } | null)?.refused;
      if (refused) process.stderr.write(`replay: the STATVS row was refused (${refused}); the result is in ${replaysPath()}\n`);
    } catch { /* the result is on disk */ }
    return r;
  };
  if (!rec || !readBy) return finish({ ...base, error: `review record missing: ${!rec ? c.review.file : c.readBy}` });

  const input = rebuildInput({ ...rec, status: "pass" });
  if (!input.ok) return finish({ ...base, error: `input not rebuilt: ${input.reason}` });
  const labelled = new Set(c.label.map((l) => l.file));
  // Each arm cuts the diff with its own reviewer's batching. Keep each labelled batch's original position, so its "part i of n" text is what that reviewer read.
  const isaFor = new Map<number, string>();
  const prompts = new Map<Arm, string[]>();
  for (const arm of want) {
    const spec = specOf(arm);
    const all = spec.batchDiff(input.text);
    const kept = all.map((b, i) => ({ b, i })).filter(({ b }) => [...labelled].some((f) => b.includes(`diff --git a/${f} b/${f}`)));
    if (!isaFor.has(spec.isaBudget)) isaFor.set(spec.isaBudget, isaAt(c.repoRoot, readBy.dirty ? rec.head : readBy.head, rec.scope, spec.isaBudget));
    prompts.set(arm, kept.map(({ b, i }) => spec.buildUserPrompt({ scope: rec.scope, tier: rec.tier, files: rec.files, diff: b, isa: isaFor.get(spec.isaBudget)!, part: all.length > 1 ? `part ${i + 1} of ${all.length}` : undefined })));
  }
  if (want.every((a) => prompts.get(a)!.length === 0)) return finish({ ...base, error: "no batch holds a labelled file" });
  const vendors = rec.reviewerVendors;
  const promptMatches = want.includes("missed") ? (opts.promptMatches ?? ((ts: string) => promptMatchesAt(ts, incumbent.source)))(readBy.ts) : null;
  const pinned = recordedModels(readBy, vendors);

  /** Why an arm cannot run at all, or null: settled for its fingerprint, never unanswered. */
  const refusal = (arm: Arm): string | null => {
    if (prompts.get(arm)!.length === 0) return "no batch holds a labelled file";
    if (arm !== "missed") return null;
    if (vendors.some((v) => pinned[v] === undefined)) return "the missing review recorded no model to pin";
    // The missed arm is the reviewer that missed: its model and its prompt (ISC-17). A changed prompt makes it no control.
    if (promptMatches !== true) return "the review's prompt differs from today's, so no control can be rebuilt";
    return null;
  };
  // Two arms with one fingerprint are one reviewer: they run once and share the result (ISC-44).
  const groups = new Map<string, Arm[]>();
  for (const arm of want) if (refusal(arm) === null) { const fp = fps.get(arm)!.fp; groups.set(fp, [...(groups.get(fp) ?? []), arm]); }
  const kOfGroup = (group: Arm[]): number => Math.max(...group.map(kOf));
  const calls = [...groups.values()].reduce((n, g) => n + kOfGroup(g) * vendors.length * prompts.get(g[0]!)!.length, 0);
  const batches = Math.max(...want.map((a) => prompts.get(a)!.length));
  const ceiling = opts.maxCalls ?? DEFAULT_MAX_CALLS;
  if (calls > ceiling) return finish({ ...base, batches, planned: calls, error: `${calls} reviewer calls would pass the ceiling of ${ceiling}; lower --k or raise --max-calls` });

  const gate = opts.gate ?? limiter(MAX_CONCURRENT);
  let used = 0;
  const raw = opts.call ?? defaultCall;
  const call: ReplayCall = (req) => gate(() => { used++; return raw(req); });
  const expected = opts.expectedModel ?? (() => null);

  const none = (arm: Arm, why: string): ArmResult => ({ arm, ran: false, fingerprint: fps.get(arm)!.fp, k: kOf(arm), models: [], samples: [{ noResult: why }], scored: 0, catchRate: null, blockingRate: null });
  const runArm = async (arm: Arm, kk: number): Promise<ArmResult> => {
    const spec = specOf(arm), level = spec.level[rec.tier];
    const models = new Set<string>();
    const samples = await Promise.all(Array.from({ length: kk }, async (): Promise<Sample> => {
      const results = await Promise.all(vendors.flatMap((vendor) => prompts.get(arm)!.map((user) => call({ system: spec.system, user, vendor, level, parse: spec.parseVerdict, ...(arm === "missed" ? { model: pinned[vendor] } : {}) }).catch((e: unknown) => ({ ok: false as const, error: String(e) })))));
      const failed = results.find((r): r is { ok: false; error: string } => !r.ok);
      if (failed) return { noResult: scrub(failed.error.slice(0, 200)) };
      const oks = results.filter((r): r is Extract<ReviewerResult, { ok: true }> => r.ok);
      // A missed sample is only the missed arm when the model that missed actually answered (ISC-30).
      const swapped = arm === "missed" ? oks.find((r) => !vendors.some((v) => pinned[v] === r.model)) : undefined;
      if (swapped) return { noResult: `pinned model not served (got ${swapped.model})` };
      // An incumbent or candidate answered by a model other than the one its fingerprint names belongs to another cell.
      const off = arm !== "missed" ? oks.find((r) => !r.model.endsWith("(unverified)") && vendors.every((v) => { const e = expected(v, level); return e !== null && e !== r.model; })) : undefined;
      if (off) return { noResult: `served ${off.model}, not the fingerprinted model` };
      for (const r of oks) models.add(r.model);
      const findings = oks.flatMap((r) => r.verdict.findings);
      const hit = findings.filter((f) => hits(f, c));
      return { caught: hit.length > 0, blocking: hit.some((f) => f.severity === "blocker"), findings: findings.length, fileOnly: findings.filter((f) => fileOnly(f, c)).length };
    }));
    const scored = samples.filter((s): s is Extract<Sample, { caught: boolean }> => "caught" in s);
    return { arm, ran: true, fingerprint: fps.get(arm)!.fp, k: kk, models: [...models].sort(), samples, scored: scored.length, catchRate: scored.length ? scored.filter((s) => s.caught).length / scored.length : null, blockingRate: scored.length ? scored.filter((s) => s.blocking).length / scored.length : null };
  };
  const ran = new Map<Arm, ArmResult>();
  for (const group of groups.values()) { // serial: one reviewer's calls finish before the next one's start
    const runner = group[0]!;
    const r = await runArm(runner, kOfGroup(group));
    for (const arm of group) ran.set(arm, arm === runner ? r : { ...r, arm, sameAs: runner });
  }
  const arms = want.map((arm) => ran.get(arm) ?? none(arm, refusal(arm) ?? "not run"));
  const out: ReplayResult = { ...base, batches, promptMatches, planned: calls, calls: used, arms };
  if (arms.every((a) => a.scored === 0) && arms.some((a) => a.ran)) out.error = "no sample in either arm returned a result";
  return finish(out);
}

/** A case counts only when {{PRINCIPAL_NAME}} called it a defect, or the judgment did at 0.5 or above while unlabelled (ISC-43). */
export function admitted(c: ReviewCase, judgments = readJudgments(), labels = readLabels()): { ok: boolean; why: string } {
  const l = labels.get(c.id);
  if (l) return l.defect ? { ok: true, why: "labelled a defect" } : { ok: false, why: "labelled not a defect" };
  const p = judgments.get(c.id)?.defect;
  if (p == null) return { ok: false, why: "not judged yet" };
  return p >= 0.5 ? { ok: true, why: `judged ${p.toFixed(2)} (provisional)` } : { ok: false, why: `judged ${p.toFixed(2)}, under 0.5` };
}

/** Errors no retry can fix under the same fingerprint: the input, the record or the labelled batch is not there. */
const SETTLED = /^(review record missing|input not rebuilt|no batch holds a labelled file|over the run ceiling)/;
export const MAX_ATTEMPTS = 3;
/** One arm's cell for one case: the fingerprint its result is cached under and the samples it needs. */
export interface ArmPlan { arm: Arm; fingerprint: string; k: number }
export interface CellState { missing: Arm[]; settled: string | null; attempts: number; seen: boolean }
/** Does this row hold a usable result for the plan (ISC-39)? Any arm entry under the plan's fingerprint counts, whatever the arm is
 *  called there, so two arms with one fingerprint share one cell. A settled `ran: false` entry counts too. */
function usable(r: ReplayResult, p: ArmPlan): ArmResult | undefined {
  const need = Math.ceil(p.k * VALID_SHARE);
  return r.arms.find((a) => a.fingerprint === p.fingerprint && (a.ran === false || (a.scored >= need && (a.k ?? r.k) >= p.k)));
}
/** What one case still needs (ISC-39): per arm, a cell under its fingerprint with enough answers, or the reason it is settled. */
export function cellState(c: ReviewCase, plans: ArmPlan[], replays = readReplays()): CellState {
  const rows = replays.filter((r) => r.caseId === c.id);
  const seen = rows.length > 0;
  // An input-level error is settled for the reviewer that hit it; the missed arm's key is shared by every reviewer, so it decides only when no other arm is planned.
  const deciding = new Set(plans.filter((p) => p.arm !== "missed").map((p) => p.fingerprint));
  const planned = new Set(plans.map((p) => p.fingerprint));
  const settledRow = rows.find((r) => r.error && SETTLED.test(r.error) && (((r.fingerprints ?? []).some((f) => deciding.has(f))) || ((r.fingerprints ?? []).length > 0 && (r.fingerprints ?? []).every((f) => f.startsWith("missed:")) && (r.fingerprints ?? []).some((f) => planned.has(f)))));
  if (settledRow) return { missing: [], settled: settledRow.error!, attempts: rows.length, seen };
  const missing: Arm[] = [];
  let attempts = 0, primaryGaveUp = false;
  for (const p of plans) {
    if (rows.some((r) => usable(r, p))) continue;
    const need = Math.ceil(p.k * VALID_SHARE);
    // A refusal for lack of budget left is no attempt; anything else that ran and fell short is.
    const tries = rows.filter((r) => !r.error?.includes("would pass the ceiling") && (r.fingerprints ?? []).includes(p.fingerprint) && (r.error || r.arms.some((a) => a.fingerprint === p.fingerprint && a.ran !== false && a.scored < need))).length;
    attempts = Math.max(attempts, tries);
    if (tries >= MAX_ATTEMPTS) { if (p.arm !== "missed") primaryGaveUp = true; } else missing.push(p.arm);
  }
  if (!missing.length && primaryGaveUp) return { missing, settled: `${attempts} attempts without enough answers`, attempts, seen };
  return { missing, settled: null, attempts, seen };
}

export const SUITE_MAX_CALLS = 200;
export const ADMITTED_FOR_VERDICT = 10;
export const VALID_SHARE = 0.9;
/** One arm over the admitted cases: only cells with enough answers count, and an arm with none says so instead of printing 0 (ISC-44). */
export interface ArmReport {
  arm: Arm;
  /** Admitted cases with an answered cell for this arm. */ cases: number;
  /** Pooled samples over those cases. */ scored: number; caught: number;
  /** Pooled catch rate, null when no sample was scored. */ catchRate: number | null;
  /** Admitted cases with no answered cell yet (not run, outage, or too few answers). */ noResult: number;
  /** Admitted cases where the arm could not be rebuilt (no pin, or another prompt). */ notRun: number;
}
export interface SuiteResult {
  at: string;
  mode: "quiet" | "rescore" | "skipped" | "blind" | "incomplete" | "planned" | "candidate";
  fingerprints: Record<string, string>; changed: boolean;
  /** Set on a `suite --candidate` run: the candidate's label and fingerprints per slot beside the incumbent's above. */
  candidate?: { label: string; fingerprints: Record<string, string> };
  cases: { total: number; admitted: number; cached: number; replayed: number; failed: number; unscorable: number; notAdmitted: Record<string, number> };
  calls: { used: number; ceiling: number };
  samples: { planned: number; answered: number }; valid: boolean;
  verdict: "insufficient-data"; reason: string; clean: "not yet measurable";
  /** Catch rate per arm over the admitted cases, read from the cache after the run. */
  arms: ArmReport[];
  /** Candidate against incumbent on the admitted cases both answered: per-case catch-rate difference, descriptive only (the verdict rule is ISC-22 and ISC-25). */
  paired?: { cases: number; candidateAhead: number; incumbentAhead: number; equal: number };
  /** Said plainly when there is nothing to score, so no zero is printed. */
  scoring: string;
  note?: string;
}

/** The latest usable answered cell for a plan: its arm result, or null. */
function cellResult(caseId: string, p: ArmPlan, replays: ReplayResult[]): ArmResult | null {
  let best: ArmResult | null = null;
  for (const r of replays) if (r.caseId === caseId) { const a = usable(r, p); if (a) best = a; }
  return best;
}
/** Catch rate per arm over admitted cases (cells already cached), and the paired candidate-against-incumbent count. */
export function scoreArms(admittedCases: Array<{ c: ReviewCase; plans: ArmPlan[] }>, replays = readReplays()): { arms: ArmReport[]; paired?: SuiteResult["paired"]; scoring: string } {
  const present = ARMS.filter((arm) => admittedCases.some(({ plans }) => plans.some((p) => p.arm === arm)));
  const arms: ArmReport[] = present.map((arm) => ({ arm, cases: 0, scored: 0, caught: 0, catchRate: null, noResult: 0, notRun: 0 }));
  const pair = { cases: 0, candidateAhead: 0, incumbentAhead: 0, equal: 0 };
  for (const { c, plans } of admittedCases) {
    const rate = new Map<Arm, number>();
    for (const p of plans) {
      const rep = arms.find((a) => a.arm === p.arm)!;
      const cell = cellResult(c.id, p, replays);
      if (!cell) rep.noResult++;
      else if (!cell.ran) rep.notRun++;
      else { rep.cases++; rep.scored += cell.scored; rep.caught += cell.samples.filter((s) => "caught" in s && s.caught).length; if (cell.catchRate !== null) rate.set(p.arm, cell.catchRate); }
    }
    if (rate.has("candidate") && rate.has("incumbent")) {
      pair.cases++;
      const d = rate.get("candidate")! - rate.get("incumbent")!;
      if (d > 0) pair.candidateAhead++; else if (d < 0) pair.incumbentAhead++; else pair.equal++;
    }
  }
  for (const a of arms) a.catchRate = a.scored ? a.caught / a.scored : null;
  const scoring = !admittedCases.length ? "nothing to score: no case is admitted yet, so no catch rate exists (a case counts once labelled a defect or judged 0.5 or more)"
    : arms.every((a) => a.scored === 0) ? `${admittedCases.length} admitted case(s) but no answered cell yet, so no catch rate exists`
    : `catch rates are over ${admittedCases.length} admitted case(s)`;
  return { arms, ...(pair.cases ? { paired: pair } : {}), scoring };
}
export function suitePath(): string { return join(casesPath(), "..", "suite.jsonl"); }
export function readSuiteRuns(): SuiteResult[] {
  if (!existsSync(suitePath())) return [];
  return readFileSync(suitePath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as SuiteResult);
}

/** The files that decide what the reviewer is shown and how it is scored. The model is read by value into the
 *  fingerprint, so models.ts and the transport are not here: ModelSync may leave them changed in a shared tree. */
export const REVIEWER_FILES = ["LIFEOS/TOOLS/Review.ts", "LIFEOS/TOOLS/ReviewReplay.ts", "LIFEOS/TOOLS/ReviewCases.ts", "LIFEOS/TOOLS/ReviewSuite.ts"];
/** Is any reviewer file changed against HEAD? A scheduled run scores only the committed reviewer (ISC-42). */
export function reviewerDirty(root = join(import.meta.dir, "..", "..")): boolean {
  const r = spawnSync("git", ["status", "--porcelain", "--", ...REVIEWER_FILES], { cwd: root, encoding: "utf8" });
  return r.status !== 0 || r.stdout.trim() !== "";
}
export const SUITE_BUDGET_MS = 25 * 60_000;

const PROBE_SYSTEM = 'Reply with exactly this JSON and nothing else: {"summary":"ok","findings":[]}';

export interface SuiteOpts {
  k?: number; missedK?: number; maxCalls?: number; dryRun?: boolean; call?: ReplayCall; write?: (row: object) => unknown;
  promptMatches?: (ts: string) => boolean; fingerprint?: FingerprintFn; dirty?: () => boolean; concurrency?: number; budgetMs?: number;
  expectedModel?: (vendor: Vendor, level: ReviewRequest["level"]) => string | null; now?: () => number;
  /** The committed reviewer, when it is not the Review.ts this process loaded (a candidate run loads it from HEAD). */
  incumbent?: ReviewerSpec;
  /** A proposed reviewer change to score beside the incumbent (ISC-45); it makes the run a candidate run. */
  candidate?: ReviewerSpec;
}

/** The three arms' cells for one case: the model that missed, the committed reviewer and, in a candidate run, the proposed one. */
function plansFor(rec: ReviewRecord | null, readBy: ReviewRecord | null, specs: { incumbent: ReviewerSpec; candidate?: ReviewerSpec }, k: number, missedK: number): ArmPlan[] {
  const fp = (s: ReviewerSpec): string => (rec ? combine(s.fingerprint(rec.reviewerVendors, s.level[rec.tier])) : "none");
  return [
    { arm: "missed", fingerprint: missedFingerprint(readBy), k: missedK },
    { arm: "incumbent", fingerprint: fp(specs.incumbent), k },
    ...(specs.candidate ? [{ arm: "candidate" as const, fingerprint: fp(specs.candidate), k }] : []),
  ];
}

/** The morning run: replay only the admitted cells with no result, under one call ceiling and one shared limit. With a candidate it
 *  scores that reviewer change beside the committed one, and edits nothing. */
export async function runSuite(opts: SuiteOpts = {}): Promise<SuiteResult> {
  const k = opts.k ?? DEFAULT_K, missedK = opts.missedK ?? MISSED_K;
  const ceiling = opts.maxCalls ?? SUITE_MAX_CALLS;
  invariant(Number.isInteger(ceiling) && ceiling >= 2, "the call ceiling covers the probe and at least one call");
  const now = opts.now ?? Date.now;
  const started = now();
  const at = new Date(started).toISOString();
  const all = readCases();
  const judgments = readJudgments(), labels = readLabels(), replays = readReplays();
  const notAdmitted: Record<string, number> = {};
  // One table per run: the source is read once, so a mid-run edit cannot mislabel a cell.
  const inc = opts.incumbent ?? incumbentSpec(opts.fingerprint);
  const cand = opts.candidate;
  const fingerprints: Record<string, string> = {}, candFingerprints: Record<string, string> = {};
  const work: Array<{ c: ReviewCase; plans: ArmPlan[]; missing: Arm[]; seen: boolean }> = [];
  const admittedCases: Array<{ c: ReviewCase; plans: ArmPlan[] }> = [];
  let cachedN = 0, unscorable = 0;
  for (const c of all) {
    // Every run row names the reviewer it saw, admitted cases or not (ISC-24).
    const rec = record(c.review.file);
    if (rec) Object.assign(fingerprints, inc.fingerprint(rec.reviewerVendors, inc.level[rec.tier]));
    const a = admitted(c, judgments, labels);
    if (!a.ok) { const key = a.why.replace(/[0-9.]+/g, "N"); notAdmitted[key] = (notAdmitted[key] ?? 0) + 1; continue; }
    if (rec && cand) Object.assign(candFingerprints, cand.fingerprint(rec.reviewerVendors, cand.level[rec.tier]));
    const plans = plansFor(rec, record(c.readBy), { incumbent: inc, candidate: cand }, k, missedK);
    admittedCases.push({ c, plans });
    const st = cellState(c, plans, replays);
    if (st.settled) unscorable++;
    else if (!st.missing.length) cachedN++;
    else work.push({ c, plans, missing: st.missing, seen: st.seen });
  }
  // New cases first, then cells a reviewer change opened; the clean sample (ISC-20) joins last once it exists.
  work.sort((a, b) => Number(a.seen) - Number(b.seen) || a.c.review.ts.localeCompare(b.c.review.ts));
  // Only a run that scored carries the fingerprints a change is measured against; a slot seen for the first time is no change.
  const last = readSuiteRuns().filter((x) => (x.mode === "quiet" || x.mode === "rescore") && x.fingerprints && !Array.isArray(x.fingerprints)).at(-1);
  const changed = !cand && !!last && Object.entries(fingerprints).some(([k2, v]) => last.fingerprints[k2] !== undefined && last.fingerprints[k2] !== v);
  const admittedN = cachedN + unscorable + work.length;
  const out: SuiteResult = {
    at, mode: "quiet", fingerprints, changed,
    ...(cand ? { candidate: { label: cand.label, fingerprints: candFingerprints } } : {}),
    cases: { total: all.length, admitted: admittedN, cached: cachedN, replayed: 0, failed: 0, unscorable, notAdmitted },
    calls: { used: 0, ceiling }, samples: { planned: 0, answered: 0 }, valid: true,
    verdict: "insufficient-data",
    reason: `${admittedN} admitted case(s); a verdict needs ${ADMITTED_FOR_VERDICT} and a clean sample`,
    clean: "not yet measurable", arms: [], scoring: "",
  };
  // The catch rates are read from the cache after the run, so a cell this run filled shows up and a quiet day shows the standing numbers.
  const scored = (r: SuiteResult): SuiteResult => ({ ...r, ...scoreArms(admittedCases) });
  const finish = (r0: SuiteResult): SuiteResult => {
    const r = scored(r0);
    if (r.mode === "planned") return r;
    if (r.note) r.note = scrub(r.note);
    mkdirSync(join(suitePath(), ".."), { recursive: true });
    appendFileSync(suitePath(), JSON.stringify(r) + "\n");
    try { (opts.write ?? defaultReviewStatvsWriter)({ writer: "tool:ReviewSuite", stream: "review-replay", class: "personal", kind: "review-suite", title: `suite ${r.mode}`, data: r }); } catch { /* the run is on disk */ }
    return r;
  };
  // A scheduled run scores the committed reviewer; a candidate run's incumbent is already HEAD's copy, so a dirty Review.ts is the point of it.
  if (!cand && (opts.dirty ?? reviewerDirty)()) return finish({ ...out, mode: opts.dryRun ? "planned" : "skipped", valid: false, note: "a reviewer file has uncommitted changes; a scheduled run scores only the committed reviewer" });
  if (opts.dryRun) return finish({ ...out, mode: "planned", note: `${work.length} cell(s) to replay` });
  if (cand) out.mode = "candidate";
  if (!work.length) return finish(out);

  const gate = limiter(opts.concurrency ?? SUITE_CONCURRENT);
  const raw = opts.call ?? defaultCall;
  const first = record(work[0]!.c.review.file);
  const probe = await raw({ system: PROBE_SYSTEM, user: "probe", vendor: first?.reviewerVendors[0] ?? "openai", level: first ? inc.level[first.tier] : "high" }).catch((e: unknown) => ({ ok: false as const, error: String(e) }));
  out.calls.used = 1;
  if (!probe.ok) return finish({ ...out, mode: "blind", valid: false, note: `lane probe failed: ${probe.error.slice(0, 160)}` });

  const budget = opts.budgetMs ?? SUITE_BUDGET_MS;
  let left = 0;
  for (const [i, w] of work.entries()) {
    if (now() - started > budget) { out.mode = "incomplete"; out.note = `stopped at the ${Math.round(budget / 60_000)}-minute budget with ${work.length - i} case(s) left`; break; }
    const r = await replayCase(w.c, { k, missedK, maxCalls: ceiling - out.calls.used, call: raw, write: opts.write, promptMatches: opts.promptMatches, gate, incumbent: inc, candidate: cand, arms: w.missing, expectedModel: opts.expectedModel ?? servedModel });
    out.calls.used += r.calls;
    if (r.error?.includes("would pass the ceiling")) {
      // A case bigger than a whole run is settled once; one that only lacks today's remainder waits, and smaller ones still run.
      if (r.planned > ceiling - 1) {
        out.cases.unscorable++;
        appendFileSync(replaysPath(), JSON.stringify({ ...r, error: `over the run ceiling: needs ${r.planned} calls, a run has ${ceiling - 1}` }) + "\n");
      } else left++;
      continue;
    }
    if (r.error) { if (SETTLED.test(r.error)) out.cases.unscorable++; else out.cases.failed++; continue; }
    out.cases.replayed++;
    // Only arms that ran count toward answered: a missed arm that could not be rebuilt is settled, not unanswered. An arm that shared another's run counts once.
    for (const a of r.arms.filter((x) => x.ran && !x.sameAs)) { out.samples.planned += a.samples.length; out.samples.answered += a.scored; }
  }
  if (left && out.mode === "quiet") { out.mode = "incomplete"; out.note = `${left} case(s) wait for tomorrow: the ${ceiling}-call ceiling was reached`; }
  if (changed && out.mode === "quiet") out.mode = "rescore";
  out.valid = (out.samples.planned === 0 || out.samples.answered / out.samples.planned >= VALID_SHARE) && !(out.cases.failed > 0 && out.cases.replayed === 0);
  return finish(out);
}

/** The advisory check (ISC-45): does the live reviewer fingerprint have a score? It reads the cache, spends no call and never blocks anything. */
export interface UnscoredReport {
  at: string; status: "scored" | "unscored" | "nothing-to-score"; flagged: boolean;
  /** The live committed reviewer's fingerprint per vendor and level slot, and all of them combined. */
  live: Record<string, string>; combined: string;
  admitted: number; total: number;
  /** Slots of admitted cases that have no answered cell under their live fingerprint. */
  unscored: string[];
  /** The working Review.ts differs from HEAD: the live fingerprint is read from the working file, and a candidate run scores the change. */
  dirty: boolean;
  message: string;
}
export function unscoredCheck(opts: { fingerprint?: FingerprintFn; incumbent?: ReviewerSpec; k?: number; dirty?: () => boolean; replays?: ReplayResult[] } = {}): UnscoredReport {
  const k = opts.k ?? DEFAULT_K;
  const inc = opts.incumbent ?? incumbentSpec(opts.fingerprint);
  const replays = opts.replays ?? readReplays();
  const vendors: Vendor[] = ["anthropic", "openai"];
  const live: Record<string, string> = {};
  for (const level of new Set(Object.values(inc.level))) Object.assign(live, inc.fingerprint(vendors, level));
  const combined = combine(live);
  const all = readCases(), judgments = readJudgments(), labels = readLabels();
  let admittedN = 0;
  const unscored = new Set<string>();
  for (const c of all) {
    if (!admitted(c, judgments, labels).ok) continue;
    admittedN++;
    const rec = record(c.review.file);
    const st = cellState(c, plansFor(rec, null, { incumbent: inc }, k, MISSED_K).filter((p) => p.arm === "incumbent"), replays);
    // A settled case can never be scored under this fingerprint; saying it is unscored would ask for something no run can do.
    if (st.missing.length && rec) for (const v of rec.reviewerVendors) unscored.add(slot(v, inc.level[rec.tier]));
  }
  const dirty = (opts.dirty ?? reviewerDirty)();
  const status: UnscoredReport["status"] = admittedN === 0 ? "nothing-to-score" : unscored.size ? "unscored" : "scored";
  const lead = `Live reviewer ${combined}`;
  const message = status === "nothing-to-score" ? `${lead}: no score. ${admittedN} of ${all.length} case(s) are admitted, so there is nothing to score yet.`
    : status === "unscored" ? `${lead}: no score for ${[...unscored].sort().join(", ")}. Run \`bun LIFEOS/TOOLS/ReviewSuite.ts suite\` (or wait for the morning run).`
    : `${lead}: scored on every admitted case (${admittedN}).`;
  return { at: new Date().toISOString(), status, flagged: status !== "scored", live, combined, admitted: admittedN, total: all.length, unscored: [...unscored].sort(), dirty, message: dirty ? `${message} Review.ts has uncommitted changes: score them with \`suite --candidate\`.` : message };
}

/** The run's one content event; the Workflows engine writes the run event beside it (ISC-23). */
export function suiteEvent(r: SuiteResult) {
  const problem = r.mode === "blind" || r.mode === "incomplete" || !r.valid;
  const severity = problem && r.mode !== "skipped" ? "medium" : "info";
  const title = r.mode === "blind" ? "Reviewer evals: lane down, nothing scored" : r.mode === "incomplete" ? "Reviewer evals: stopped at the call ceiling" : r.mode === "skipped" ? "Reviewer evals: skipped, a reviewer file has uncommitted changes" : !r.valid ? "Reviewer evals: too few samples answered" : r.mode === "rescore" ? "Reviewer evals: reviewer changed, rescored" : r.mode === "candidate" ? "Reviewer evals: candidate scored" : "Reviewer evals: morning run";
  const summary = `${r.cases.admitted} of ${r.cases.total} cases admitted, ${r.cases.replayed} replayed, ${r.cases.cached} cached, ${r.cases.unscorable} unscorable, ${r.calls.used} reviewer calls. Verdict: ${r.verdict} (${r.reason}).${r.note ? ` ${r.note}.` : ""}`;
  return {
    id: crypto.randomUUID(), source: "assay", ts: r.at, kind: "ai" as const, severity: severity as "info" | "medium",
    title, summary, ref: "LIFEOS/TOOLS/ReviewSuite.ts", url: null, privacy_class: "public" as const,
    dedup_key: `review-suite:${r.at}`,
    meta: { mode: r.mode, changed: r.changed, fingerprints: r.fingerprints, cases: r.cases, calls: r.calls, samples: r.samples, verdict: r.verdict, arms: r.arms },
  };
}

export function readReplays(): ReplayResult[] {
  if (!existsSync(replaysPath())) return [];
  return readFileSync(replaysPath(), "utf8").split("\n").filter(Boolean).map((l) => normalizeReplay(JSON.parse(l) as ReplayResult));
}

const pct = (x: number | null): string => (x === null ? "—" : `${Math.round(x * 100)}%`);
/** The run as lines of text: the headline, then each arm's catch rate, or the plain statement that there is nothing to score. */
export function formatSuite(r: SuiteResult): string[] {
  const head = `Suite ${r.mode}${r.candidate ? ` [candidate ${r.candidate.label}]` : ""}: ${r.cases.admitted}/${r.cases.total} admitted, ${r.cases.replayed} replayed, ${r.cases.cached} cached, ${r.calls.used}/${r.calls.ceiling} calls, ${r.verdict} (${r.reason})${r.note ? ` — ${r.note}` : ""}`;
  const lines = [head];
  const rated = r.arms.filter((a) => a.scored > 0);
  if (!rated.length) lines.push(`  ${r.scoring.charAt(0).toUpperCase()}${r.scoring.slice(1)}.`);
  else {
    for (const a of r.arms) lines.push(`  ${a.arm.padEnd(9)} ${a.scored ? `catch ${pct(a.catchRate)} (${a.caught}/${a.scored} samples, ${a.cases} case(s))` : "no answered cell yet"}${a.noResult ? `  no result on ${a.noResult} case(s)` : ""}${a.notRun ? `  not rebuilt on ${a.notRun}` : ""}`);
    if (r.paired) lines.push(`  paired    candidate ahead on ${r.paired.candidateAhead}, incumbent ahead on ${r.paired.incumbentAhead}, level on ${r.paired.equal} of ${r.paired.cases} case(s) both answered (descriptive, no verdict)`);
  }
  return lines;
}

if (import.meta.main) {
  const [cmd, id, ...rest] = process.argv.slice(2);
  const num = (flag: string, d: number) => { const i = rest.indexOf(flag); const n = i >= 0 ? Number(rest[i + 1]) : d; if (!(Number.isInteger(n) && n >= 1)) { console.error(`${flag} takes a positive whole number`); process.exit(2); } return n; };
  if (cmd === "suite") {
    const args = [id, ...rest].filter((x): x is string => !!x);
    const flag = (f: string, d: number) => { const i = args.indexOf(f); const n = i >= 0 ? Number(args[i + 1]) : d; if (!(Number.isInteger(n) && n >= 1)) { console.error(`${f} takes a positive whole number`); process.exit(2); } return n; };
    const ci = args.indexOf("--candidate");
    const candidateArg = ci >= 0 ? args[ci + 1] : undefined;
    if (ci >= 0 && (!candidateArg || candidateArg.startsWith("--"))) { console.error("--candidate takes a git revision or a path to a Review.ts"); process.exit(2); }
    if (candidateArg && args.includes("--vigil")) { console.error("--vigil is for the scheduled run; a candidate run never emits an event"); process.exit(2); }
    let candidate: ReviewerSpec | undefined, incumbent: ReviewerSpec | undefined;
    if (candidateArg) {
      try {
        const src = reviewerSource(candidateArg);
        // The incumbent is Review.ts at HEAD, not the working file the candidate may be an edit of.
        incumbent = await loadReviewerSpec(committedReviewerSource(), "incumbent (HEAD)");
        candidate = await loadReviewerSpec(src.source, src.label);
      } catch (e) { console.error(`suite: ${(e as Error).message}`); process.exit(2); }
    }
    const r = await runSuite({ maxCalls: flag("--max-calls", SUITE_MAX_CALLS), dryRun: args.includes("--dry-run"), incumbent, candidate });
    if (args.includes("--vigil") && r.mode !== "planned") {
      try { const sent = (await import("../STATVS/index")).writeEvent(suiteEvent(r)) as { ok: boolean; refused?: string }; if (!sent.ok) console.error(`suite: STATVS refused the event: ${sent.refused}`); }
      catch (e) { console.error(`suite: event write failed: ${(e as Error).message}`); }
    }
    if (args.includes("--json")) console.log(JSON.stringify(r));
    else for (const line of formatSuite(r)) console.log(line);
    process.exit(0); // a lane outage is the event's news, not an engine failure that escalates through a streak
  }
  if (cmd === "unscored") {
    const u = unscoredCheck();
    if ([id, ...rest].includes("--json")) console.log(JSON.stringify(u));
    else console.log(`${u.flagged ? "Unscored" : "Scored"}: ${u.message}`);
    process.exit(0); // advisory: it never blocks anything
  }
  if (cmd !== "replay" || !id) { console.error("usage: bun ReviewSuite.ts replay <case id> [--k 3] [--max-calls 24] [--json] | suite [--candidate <rev|path>] [--max-calls 200] [--dry-run] [--vigil] [--json] | unscored [--json]"); process.exit(2); }
  const c = readCases().find((x) => x.id === id);
  if (!c) { console.error(`no case ${id}; bun LIFEOS/TOOLS/ReviewCases.ts list`); process.exit(2); }
  const r = await replayCase(c, { k: num("--k", DEFAULT_K), maxCalls: num("--max-calls", DEFAULT_MAX_CALLS) });
  if (rest.includes("--json")) { console.log(JSON.stringify(r, null, 2)); process.exit(r.error ? 1 : 0); }
  if (r.error) { console.log(`Replay ${id}: ${r.error}`); process.exit(1); }
  console.log(`Replay ${id}: k=${r.k}, ${r.batches} batch(es), ${r.vendors.join(" + ")}, prompt ${r.promptHash}`);
  for (const a of r.arms) {
    const nr = a.samples.filter((s) => "noResult" in s).length;
    console.log(`  ${a.arm.padEnd(9)} catch ${a.catchRate === null ? "—" : `${Math.round(a.catchRate * 100)}% of ${a.scored}`}  blocking ${a.blockingRate === null ? "—" : `${Math.round(a.blockingRate * 100)}%`}${nr ? `  no result ${nr}/${a.samples.length}` : ""}  models ${a.models.join(", ") || "—"}`);
  }
}
