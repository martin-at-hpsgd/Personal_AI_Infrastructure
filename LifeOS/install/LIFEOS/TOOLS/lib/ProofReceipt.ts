/**
 * ProofReceipt — the one contract between Proof (skills/Assay/Tools/Proof.ts), which checks an
 * artifact and writes a receipt, and everything that refuses an unchecked artifact (the
 * ProofGate hook (maintainer-side; not in the public release), ArtDirection Deliver.ts). Readers never import the engine; they read this.
 *
 * Two schemas, one store:
 *   - `proof-receipt/1` (RECEIPT_SCHEMA): the original shape. Still read, verified and accepted from legacy writers.
 *   - `assay-receipt/1` (ASSAY_RECEIPT_SCHEMA): a superset. It adds what the receipt was checked AGAINST (the ideal
 *     state: an ISA path + revision, or the ask's sha256), the check-set version, the evaluator versions, the destination
 *     class, and `verdict_at_boundary` — the verdict frozen at the moment the check ran, kept apart from findings
 *     appended later (appendFindings), so a later catch reads as a false pass instead of rewriting history.
 *
 * Freshness is by sha256, always (receiptFreshness / shaFreshness): size and mtime can match bytes that changed.
 * Receipts live in one store keyed by the sha256 of the artifact's absolute path, so artifacts never grow sidecar files.
 *
 * Verdict rule (mayPresent), ISA 20260930-assay-everywhere Decisions (2026-09-30): a code-tier fail, a missing,
 * stale or hand-edited receipt, an unmeasured check, or a "no" from an EARNED check blocks. A flag from an unearned check
 * (a Glance question not in effective enforce, a judge whose calibration is not earned) is recorded and named, and never
 * blocks.
 *
 * mayPresentSha is the same rule for bytes not on disk yet (a Write's content, an Edit's computed post-state), and
 * receiptId is the output ledger's join key to a receipt (S4, hand-off gate and OutputRecord). (maintainer-side; not in the public release)
 *
 * Doc: skills/Assay/Intents/Proof.md
 */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { invariant } from "../Invariant.ts";
import { getClaudeDir, getLifeosDir } from "../Paths.ts";
import { gateEnvProblem } from "./RenderProvenance.ts";

/** The original receipt schema id. Existing receipts carry it; legacy writers may still write it. */
export const RECEIPT_SCHEMA = "proof-receipt/1";
/** The unified receipt (ISC-1): proof-receipt/1 plus its binding and an append-only finding history. */
export const ASSAY_RECEIPT_SCHEMA = "assay-receipt/1";
export type ReceiptSchema = typeof RECEIPT_SCHEMA | typeof ASSAY_RECEIPT_SCHEMA;

export type ProofKind = "video" | "image" | "audio" | "text" | "page" | "doc";
export type ProofTier = "code" | "glance" | "judge";
/**
 * pass = at least one ideal-state check passed and nothing blocked; admitted-flagged = nothing blocked, no ideal-state check
 * passed, unearned flags carry the run; unmeasured = nothing blocked, no flags, and no ideal-state check passed (only the
 * always-on safety scan, or nothing). Neither of the last two is ever a pass (ISA 20261010-evals-in-the-isa ISC-24).
 */
export type ProofVerdict = "pass" | "admitted-flagged" | "unmeasured" | "fail" | "unavailable" | "reference";

/**
 * The boundaries an output crosses (Design §6), spelled once for both the receipt's destination and the output ledger's
 * boundary (OutputLedger.ts re-exports this constant). "handoff" is handed to the principal.
 */
export const BOUNDARIES = ["handoff", "send", "publish", "deploy", "isa-close"] as const;
export type Boundary = (typeof BOUNDARIES)[number];
/** Where the checked artifact was headed when it was checked: a boundary, or "none" for a check with no destination yet. */
export const DESTINATION_CLASSES = [...BOUNDARIES, "none"] as const;
export type DestinationClass = (typeof DESTINATION_CLASSES)[number];

export type ProofFinding = {
  check: string;
  tier: ProofTier;
  /**
   * fail = blocks: a code-tier defect, or a "no" from an earned check (`earned: true`, assay-receipt/1 only);
   * flag = an unearned judged signal, recorded and named, never blocking; unavailable = could not measure.
   */
  severity: "fail" | "flag" | "unavailable";
  message: string;
  t?: number | null;
  bbox?: [number, number, number, number] | null;
  crop?: string | null;
  derived_from?: string | null;
  probability?: number | null;
  /** True only when the check that produced this finding has earned the right to decide (Glance effective enforce, or a judge calibrated earned against principal labels). */
  earned?: boolean;
  /** Set on findings appended after the boundary run: when, and by what. */
  added_at?: string;
  source?: string;
  /** A Glance check whose answers were not confident either way (decide() wouldAct false): a flag, never a pass. */
  unsure?: boolean;
  /** Glance tier: the registry caller that asked (ISC-41), so the label join keys its labels caller.question. */
  caller?: string;
  /** Glance tier: the registry question id the check was asked under (ISC-41). */
  question?: string;
  /** Set when this finding was served from the finding memo (ISC-27): when the answer it repeats was first made. */
  memo?: string;
};

export type ProofOptOut = { selector: string; kind: string; reason: string };

/** Why an unearned flag does not apply. A record for the label store, never a gate key: unearned flags do not block. */
export type ProofDismissal = { check: string; reason: string; at: string; by: string };

/**
 * `passed` counts every check that passed. `safety_passed` is the share of it the always-on safety scan contributed: the
 * scan says nothing leaked, never that the output came out as asked, so it is not an ideal-state check. A receipt written
 * before ISC-24 has no `safety_passed` and keeps the verdict it was written with (see verdictAgrees).
 */
export type ReceiptCounts = { passed: number; code_fail: number; flags: number; unavailable: number; earned_fail?: number; safety_passed?: number };

/** What the check was measured against: an ISA revision (with the criteria it covers), the ask's sha256, or neither with a reason. */
export type IdealStateRef =
  | { kind: "isa"; path: string; revision: string; criteria?: string[]; /** id -> wording revision each listed criterion was measured against (ISAGate binds receipts to it). */ criterion_revisions?: Record<string, string> }
  | { kind: "ask"; sha256: string }
  | { kind: "none"; reason: string };

/** The check set that ran: `version` is the sha256 of the checks as run; `source` is the checks file, or null for the standing profile alone. */
export type CheckSetRef = { version: string; source: string | null };

/** The verdict as it stood when the boundary run finished; `findings` is how many of the receipt's findings existed then. */
export type BoundaryVerdict = { verdict: ProofVerdict; counts: ReceiptCounts; findings: number; at: string };

type ReceiptCore = {
  artifact: string;
  sha256: string;
  size: number;
  mtimeMs: number;
  kind: ProofKind;
  ran_at: string;
  /** One boundary run. Two runs of the same bytes can share a millisecond, so ran_at alone cannot tell them apart. */
  run_id?: string;
  duration_ms: number;
  checks_file: string | null;
  profile: string[];
  verdict: ProofVerdict;
  counts: ReceiptCounts;
  findings: ProofFinding[];
  opt_outs: ProofOptOut[];
  /** required when verdict is "reference": why this file is not a produced output */
  reason?: string;
  /** what the run was bound to, so a hand-edited check set or a one-frame run is visible (Fable H4) */
  brief_sha256?: string | null;
  checks_sha256?: string | null;
  sampled_times?: number[];
  dismissals?: ProofDismissal[];
  /** B1: which composition a film's frames came from */
  composition_sha256?: string;
};

export type ProofReceiptV1 = ReceiptCore & { schema: typeof RECEIPT_SCHEMA };
export type AssayReceipt = ReceiptCore & {
  schema: typeof ASSAY_RECEIPT_SCHEMA;
  ideal_state: IdealStateRef;
  check_set: CheckSetRef;
  /** evaluator name → version, e.g. { proof: "2.0.0", glance: "clef-omni" } */
  evaluators: Record<string, string>;
  destination: DestinationClass;
  verdict_at_boundary: BoundaryVerdict;
  /**
   * Where the bytes came from, as VideoEval measured them: the DA essay avatar badge's template match. A record only:
   * every gate re-measures the bytes (VideoEval.badgeOrigin) and never trusts this field.
   */
  origin?: ReceiptOrigin;
};
export type ReceiptOrigin = { badge_ncc: number | null; badge_present: boolean | null };
export type ProofReceipt = ProofReceiptV1 | AssayReceipt;

const HEX64 = /^[0-9a-f]{64}$/;

export function receiptDir(): string {
  if (process.env.LIFEOS_PROOF_RECEIPTS) return process.env.LIFEOS_PROOF_RECEIPTS;
  // Under `bun test` with no override the receipt store is a per-process temp dir, so a test can never write the real one (same rule as OutputLedger.ledgerDir).
  if (process.env.NODE_ENV === "test") return join(tmpdir(), `lifeos-proof-receipts-test-${process.pid}`);
  return join(getLifeosDir(), "MEMORY", "STATE", "Proof", "receipts");
}

/** One identity per file: a symlinked path and its target share one receipt (Fable M8). */
function canonicalPath(artifact: string): string {
  const abs = resolve(artifact);
  try { return realpathSync(abs); } catch { return abs; }
}

export function receiptPath(artifact: string): string {
  const abs = canonicalPath(artifact);
  return join(receiptDir(), createHash("sha256").update(abs).digest("hex") + ".json");
}

/** A receipt file in the store: `<key>.json`, where the key is the sha256 of the artifact's path. */
export const RECEIPT_NAME = /^[0-9a-f]{64}\.json$/;

/**
 * The sha index (ISC-43): receipts are keyed by path, so finding every receipt for some bytes meant reading the whole
 * store (2026-10-20: 5,131 receipts, ~1 GB, past the send gate's 8 s budget on every send). Each receipt also leaves
 * two empty files, written before the receipt itself: `by-sha/<bytes sha256>/<key>`, which finds it by content, and
 * `by-key/<key>`, which says it is indexed. A receipt with no `by-key` entry (restored, copied, or written by code that
 * predates the index) is unindexed, and readers read it in full; listing names is cheap, reading receipts is not.
 */
export function shaIndexDir(dir: string = receiptDir()): string {
  return join(dir, "by-sha");
}

export function keyIndexDir(dir: string = receiptDir()): string {
  return join(dir, "by-key");
}

function writeIndexEntry(dir: string, sha: string | null, key: string): void {
  invariant(HEX64.test(key), "an index entry needs the receipt's store key");
  invariant(sha === null || HEX64.test(sha), "a sha pointer needs the bytes' sha256");
  if (sha !== null) {
    mkdirSync(join(shaIndexDir(dir), sha), { recursive: true });
    writeFileSync(join(shaIndexDir(dir), sha, key), "");
  }
  // by-key last: a key is called indexed only once its sha pointer exists.
  mkdirSync(keyIndexDir(dir), { recursive: true });
  writeFileSync(join(keyIndexDir(dir), key), "");
}

/** Receipt files in the store with no `by-key` entry: the ones a sha lookup cannot see and must read in full. */
export function unindexedReceipts(dir: string = receiptDir()): string[] {
  if (!existsSync(dir)) return [];
  const indexed = new Set(existsSync(keyIndexDir(dir)) ? readdirSync(keyIndexDir(dir)) : []);
  return readdirSync(dir).filter((x) => RECEIPT_NAME.test(x) && !indexed.has(x.slice(0, -".json".length)));
}

/** The top-level `sha256` of a pretty-printed receipt, read from its first 8 KB; null when the head does not show one. */
export function receiptHeadSha(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const m = buf.subarray(0, n).toString("utf8").match(/^\{\n(?: {2}"[^"\n]+": [^\n]*\n){0,8}? {2}"sha256": "([0-9a-f]{64})",?\n/);
    return m ? m[1] : null;
  } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
}

/**
 * Index every unindexed receipt in the store. A receipt whose sha cannot be read (torn, unparseable) stays unindexed,
 * because it might be the one record of an earned failure for some bytes, so readers keep reading it in full.
 * Idempotent: run it again after repairing or removing those.
 */
export function indexReceiptStore(dir: string = receiptDir()): { indexed: number; unreadable: string[] } {
  let indexed = 0;
  const unreadable: string[] = [];
  for (const n of unindexedReceipts(dir)) {
    const key = n.slice(0, -".json".length);
    let sha = receiptHeadSha(join(dir, n));
    if (sha === null) {
      try {
        const raw = JSON.parse(readFileSync(join(dir, n), "utf8")) as { sha256?: unknown };
        sha = typeof raw?.sha256 === "string" && HEX64.test(raw.sha256) ? raw.sha256 : null; // no sha: no send can match it
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // replaced between listing and read
        unreadable.push(key);
        continue;
      }
    }
    writeIndexEntry(dir, sha, key);
    indexed++;
  }
  return { indexed, unreadable };
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  await new Promise<void>((ok, fail) => {
    const s = createReadStream(path);
    s.on("data", (d) => h.update(d));
    s.on("end", () => ok());
    s.on("error", fail);
  });
  return h.digest("hex");
}

export function isAssayReceipt(r: ProofReceipt): r is AssayReceipt {
  return r.schema === ASSAY_RECEIPT_SCHEMA;
}

export type LoadedReceipt = { receipt: ProofReceipt | null; problem: string | null };

/**
 * Read and validate the stored receipt. No file: { receipt: null, problem: null }. A file that does not parse or fails
 * receiptProblem (the same validator writeReceipt runs): { receipt: null, problem }. Never throws.
 */
export function loadReceipt(artifact: string): LoadedReceipt {
  try {
    const p = receiptPath(artifact);
    if (!existsSync(p)) return { receipt: null, problem: null };
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(p, "utf8")); } catch { return { receipt: null, problem: "receipt is not valid JSON" }; }
    const problem = receiptProblem(raw);
    return problem ? { receipt: null, problem } : { receipt: raw as ProofReceipt, problem: null };
  } catch (e) {
    return { receipt: null, problem: `receipt could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** A valid receipt of either schema; a missing, foreign, corrupt or invalid file reads as no receipt. */
export function readReceipt(artifact: string): ProofReceipt | null {
  return loadReceipt(artifact).receipt;
}

/** Superseded boundary runs for one artifact, oldest first (writeReceipt appends one line per replaced receipt). */
export function historyPath(artifact: string): string {
  return receiptPath(artifact).replace(/\.json$/, ".history.jsonl");
}

export function readHistory(artifact: string): unknown[] {
  try {
    const p = historyPath(artifact);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8").split("\n").flatMap((l) => {
      if (!l.trim()) return [];
      try { return [JSON.parse(l) as unknown]; } catch { return []; }
    });
  } catch { return []; }
}

/**
 * Counts are derived from findings, never authored, so a receipt cannot claim a pass its findings contradict.
 * proof-receipt/1 counts keep their original four keys; assay-receipt/1 adds `earned_fail`, the earned checks that said no.
 */
export function deriveVerdict(findings: ProofFinding[], passed: number, schema: ReceiptSchema = RECEIPT_SCHEMA, safetyPassed?: number): { verdict: Exclude<ProofVerdict, "reference">; counts: ReceiptCounts } {
  const code_fail = findings.filter((f) => f.severity === "fail" && f.tier === "code").length;
  const flags = findings.filter((f) => f.severity === "flag").length;
  const unavailable = findings.filter((f) => f.severity === "unavailable").length;
  // ISC-24: a pass needs an ideal-state check that passed. Safety passes are not ideal-state checks; an unknown share counts as none.
  const ideal = passed - Math.min(passed, Math.max(0, safetyPassed ?? 0));
  const clear = (): "pass" | "admitted-flagged" | "unmeasured" => (ideal > 0 ? "pass" : flags > 0 ? "admitted-flagged" : "unmeasured");
  const safety = safetyPassed === undefined ? {} : { safety_passed: safetyPassed };
  if (schema === RECEIPT_SCHEMA) {
    const verdict = code_fail > 0 ? "fail" : unavailable > 0 ? "unavailable" : clear();
    return { verdict, counts: { passed, code_fail, flags, unavailable, ...safety } };
  }
  const earned_fail = findings.filter((f) => f.severity === "fail" && f.tier !== "code" && f.earned === true).length;
  const verdict = code_fail + earned_fail > 0 ? "fail" : unavailable > 0 ? "unavailable" : clear();
  return { verdict, counts: { passed, code_fail, earned_fail, flags, unavailable, ...safety } };
}

/**
 * Does a stored verdict agree with the one its findings derive? Exactly, for a receipt that records `safety_passed`. A
 * receipt written before ISC-24 (no `safety_passed`) also agrees when it says "pass" where the honest rule says
 * admitted-flagged or unmeasured: that was the rule it was written under, and readers take effectiveVerdict instead.
 */
function verdictAgrees(stored: unknown, derived: ProofVerdict, counts: ReceiptCounts): boolean {
  if (stored === derived) return true;
  return counts.safety_passed === undefined && stored === "pass" && (derived === "admitted-flagged" || derived === "unmeasured");
}

/**
 * The verdict every reader acts on and counts: the stored one re-derived under the ISC-24 rule, so a pre-ISC-24 receipt
 * that says "pass" with no check passed reads as admitted-flagged or unmeasured, never as a pass, in gates, stats and earning.
 */
export function effectiveVerdict(r: Pick<ProofReceipt, "schema" | "verdict" | "findings" | "counts">): ProofVerdict {
  if (r.verdict === "reference") return "reference";
  return deriveVerdict(r.findings, r.counts.passed, r.schema, r.counts.safety_passed).verdict;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const KIND_SET: ReadonlySet<string> = new Set<ProofKind>(["video", "image", "audio", "text", "page", "doc"]);
const TIER_SET: ReadonlySet<string> = new Set<ProofTier>(["code", "glance", "judge"]);
const SEVERITY_SET: ReadonlySet<string> = new Set(["fail", "flag", "unavailable"]);
const VERDICT_SET: ReadonlySet<string> = new Set<ProofVerdict>(["pass", "admitted-flagged", "unmeasured", "fail", "unavailable", "reference"]);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === "string";
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isCount = (x: unknown): boolean => Number.isInteger(x) && (x as number) >= 0;
const isTime = (x: unknown): boolean => isStr(x) && Number.isFinite(Date.parse(x));

function findingProblem(f: unknown, i: number): string | null {
  if (!isObj(f)) return `finding ${i} is not an object`;
  if (!isStr(f.check) || f.check.length === 0) return `finding ${i} has no check id`;
  if (!isStr(f.tier) || !TIER_SET.has(f.tier)) return `finding ${i} has an unknown tier`;
  if (!isStr(f.severity) || !SEVERITY_SET.has(f.severity)) return `finding ${i} has an unknown severity`;
  if (!isStr(f.message)) return `finding ${i} has no message`;
  if (f.earned !== undefined && typeof f.earned !== "boolean") return `finding ${i} earned must be a boolean`;
  if (f.unsure !== undefined && typeof f.unsure !== "boolean") return `finding ${i} unsure must be a boolean`;
  for (const k of ["caller", "question"] as const) { const v = f[k]; if (v !== undefined && !(isStr(v) && v.length > 0)) return `finding ${i} ${k} must be a non-empty string`; }
  if (f.memo !== undefined && !isTime(f.memo)) return `finding ${i} memo must be the time its answer was first made`;
  return null;
}

function idealStateProblem(ref: unknown): string | null {
  if (!isObj(ref)) return "assay receipt has no ideal_state";
  if (ref.kind === "isa") {
    if (!isStr(ref.path) || !isAbsolute(ref.path)) return "ideal_state isa path must be absolute";
    if (!isStr(ref.revision) || !HEX64.test(ref.revision)) return "ideal_state isa revision must be the sha256 of the ISA bytes";
    if (ref.criteria !== undefined && !(Array.isArray(ref.criteria) && ref.criteria.every((c) => isStr(c) && c.length > 0))) return "ideal_state criteria must be non-empty ids";
    if (ref.criterion_revisions !== undefined && !(isObj(ref.criterion_revisions) && Object.values(ref.criterion_revisions).every(isStr))) return "ideal_state criterion_revisions must map ids to revision strings";
    return null;
  }
  if (ref.kind === "ask") return isStr(ref.sha256) && HEX64.test(ref.sha256) ? null : "ideal_state ask sha256 must be a hex digest";
  if (ref.kind === "none") return isStr(ref.reason) && ref.reason.trim().length >= 8 ? null : "ideal_state none needs a reason (8+ characters)";
  return "ideal_state kind must be isa|ask|none";
}

function assayFieldsProblem(r: Record<string, unknown>, findings: ProofFinding[], counts: ReceiptCounts): string | null {
  const ideal = idealStateProblem(r.ideal_state);
  if (ideal) return ideal;
  const cs = r.check_set;
  if (!isObj(cs) || !isStr(cs.version) || !HEX64.test(cs.version)) return "check_set.version must be the sha256 of the checks as run";
  if (!(cs.source === null || (isStr(cs.source) && isAbsolute(cs.source)))) return "check_set.source must be an absolute path or null";
  if (!isObj(r.evaluators)) return "evaluators must name at least one evaluator with a version";
  const ev = Object.entries(r.evaluators);
  if (!(ev.length > 0 && ev.every(([k, v]) => k.length > 0 && isStr(v) && v.length > 0))) return "evaluators must name at least one evaluator with a version";
  if (!isStr(r.destination) || !(DESTINATION_CLASSES as readonly string[]).includes(r.destination)) return `destination must be one of ${DESTINATION_CLASSES.join("|")}`;
  const b = r.verdict_at_boundary;
  if (!isObj(b)) return "assay receipt has no verdict_at_boundary";
  if (!(Number.isInteger(b.findings) && (b.findings as number) >= 0 && (b.findings as number) <= findings.length)) return "verdict_at_boundary.findings must count a prefix of the findings";
  if (b.at !== r.ran_at) return "verdict_at_boundary.at is the boundary run's ran_at";
  if (r.verdict === "reference") {
    if (b.verdict !== "reference") return "a reference receipt has a reference boundary verdict";
  } else {
    if (!isObj(b.counts)) return "verdict_at_boundary must be derived from the boundary findings";
    const bc = b.counts as unknown as ReceiptCounts;
    const atBoundary = deriveVerdict(findings.slice(0, b.findings as number), counts.passed, ASSAY_RECEIPT_SCHEMA, counts.safety_passed);
    if (!(verdictAgrees(b.verdict, atBoundary.verdict, bc) && sameJson(atBoundary.counts, b.counts))) return "verdict_at_boundary must be derived from the boundary findings";
  }
  if (!findings.slice(b.findings as number).every((f) => isStr(f.added_at) && isStr(f.source) && f.source.length > 0)) return "a finding added after the boundary carries added_at and source";
  if (r.origin !== undefined) {
    const o = r.origin;
    if (!isObj(o) || !(o.badge_ncc === null || isNum(o.badge_ncc)) || !(o.badge_present === null || typeof o.badge_present === "boolean")) return "origin must be { badge_ncc: number|null, badge_present: boolean|null }";
  }
  // An earned "no" is a fail, never a flag; a judged fail must be earned. Only code and earned checks block.
  if (findings.some((f) => f.severity === "flag" && f.earned === true)) return "an earned check's no is a fail, never a flag";
  if (findings.some((f) => f.tier !== "code" && f.severity === "fail" && f.earned !== true)) return "a glance or judge finding may fail only when its check is earned";
  return null;
}

/**
 * The ONE receipt validator (schema + semantics), run by writeReceipt before a write and by loadReceipt on every read, so
 * a receipt the writer would refuse never reads as presentable. Returns the first problem, or null. Never throws, whatever
 * shape it is handed. It catches a hurried hand edit, not an attacker with write access to the store (S2b).
 */
export function receiptProblem(raw: unknown): string | null {
  try {
    if (!isObj(raw)) return "receipt is not an object";
    const r = raw;
    if (r.schema !== RECEIPT_SCHEMA && r.schema !== ASSAY_RECEIPT_SCHEMA) return `receipt schema must be ${RECEIPT_SCHEMA} or ${ASSAY_RECEIPT_SCHEMA}`;
    const schema = r.schema as ReceiptSchema;
    if (!isStr(r.artifact) || r.artifact !== resolve(r.artifact)) return "receipt artifact must be an absolute path";
    if (!isStr(r.sha256) || !HEX64.test(r.sha256)) return "receipt sha256 must be a hex digest";
    if (!isCount(r.size) || !isNum(r.mtimeMs)) return "receipt size and mtimeMs must be numbers";
    if (!isStr(r.kind) || !KIND_SET.has(r.kind)) return "receipt kind is unknown";
    if (!isTime(r.ran_at)) return "receipt ran_at must be a timestamp";
    if (!isNum(r.duration_ms)) return "receipt duration_ms must be a number";
    if (!(r.checks_file === null || isStr(r.checks_file))) return "receipt checks_file must be a path or null";
    if (!Array.isArray(r.profile) || !r.profile.every(isStr)) return "receipt profile must be a list of names";
    if (!isStr(r.verdict) || !VERDICT_SET.has(r.verdict)) return "receipt verdict is unknown";
    if (!Array.isArray(r.findings)) return "receipt findings must be a list";
    for (let i = 0; i < r.findings.length; i++) { const p = findingProblem(r.findings[i], i); if (p) return p; }
    if (!Array.isArray(r.opt_outs)) return "receipt opt_outs must be a list";
    const c = r.counts;
    if (!isObj(c) || !isCount(c.passed) || !isCount(c.code_fail) || !isCount(c.flags) || !isCount(c.unavailable)) return "receipt counts must be non-negative integers";
    const findings = r.findings as ProofFinding[];
    const counts = c as unknown as ReceiptCounts;
    if (c.safety_passed !== undefined && !(isCount(c.safety_passed) && (c.safety_passed as number) <= (c.passed as number))) return "receipt counts.safety_passed must be a count no larger than passed";
    if (r.dismissals !== undefined && !(Array.isArray(r.dismissals) && r.dismissals.every((d) => isObj(d) && isStr(d.check) && d.check.length > 0 && isStr(d.reason) && d.reason.trim().length >= 8))) return "a dismissal needs a check id and a reason";
    if (r.verdict === "reference") {
      if (!(isStr(r.reason) && r.reason.trim().length >= 8)) return "a reference receipt needs a reason";
      if (findings.length > 0) return "a reference receipt has no findings";
      if (!sameJson(deriveVerdict([], 0, schema).counts, counts)) return "a reference receipt has zero counts";
    } else {
      const d = deriveVerdict(findings, counts.passed, schema, counts.safety_passed);
      if (!verdictAgrees(r.verdict, d.verdict, counts)) return `receipt verdict ${r.verdict} does not match its findings (${d.verdict})`;
      if (!sameJson(d.counts, counts)) return "receipt counts do not match its findings";
    }
    if (schema === ASSAY_RECEIPT_SCHEMA) return assayFieldsProblem(r, findings, counts);
    // proof-receipt/1: only code blocks; no judged tier may fail, and nothing is earned.
    if (findings.some((f) => f.tier !== "code" && f.severity === "fail")) return "a proof-receipt/1 glance or judge finding may flag, never fail (only code blocks)";
    if (findings.some((f) => f.earned !== undefined)) return "only an assay-receipt/1 carries earned findings";
    return null;
  } catch (e) {
    return `receipt could not be validated: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Append-only: rewriting the same boundary run (same bytes, same ran_at) may only add findings and dismissals.
 * Returns true when the stored receipt is a different boundary run that this write supersedes (it goes to history).
 */
function assertAppendOnly(r: ProofReceipt, prevRaw: string | null): boolean {
  if (prevRaw === null) return false;
  let prev: ProofReceipt;
  try { prev = JSON.parse(prevRaw) as ProofReceipt; } catch { return true; }
  const sameRun = r.run_id !== undefined || prev.run_id !== undefined ? prev.run_id === r.run_id : prev.ran_at === r.ran_at;
  if (!isObj(prev) || prev.sha256 !== r.sha256 || !sameRun) return true; // a new boundary run replaces the old one
  invariant(prev.schema === r.schema, "a receipt's schema never changes within one run");
  invariant(Array.isArray(prev.findings) && r.findings.length >= prev.findings.length && sameJson(r.findings.slice(0, prev.findings.length), prev.findings), "findings are append-only: earlier findings never change");
  const pd = prev.dismissals ?? [], nd = r.dismissals ?? [];
  invariant(nd.length >= pd.length && sameJson(nd.slice(0, pd.length), pd), "dismissals are append-only");
  if (isAssayReceipt(prev) && isAssayReceipt(r)) invariant(sameJson(prev.verdict_at_boundary, r.verdict_at_boundary), "verdict_at_boundary never changes after the boundary");
  return false;
}

export function writeReceipt(r: ProofReceipt): string {
  const problem = receiptProblem(r);
  invariant(problem === null, problem ?? "");
  const p = receiptPath(r.artifact);
  const prevRaw = existsSync(p) ? readFileSync(p, "utf8") : null;
  const superseded = assertAppendOnly(r, prevRaw);
  mkdirSync(dirname(p), { recursive: true });
  // A new boundary run never erases the old one: the replaced receipt, with any findings appended after its boundary,
  // is kept as one line of the artifact's history in the store (F-W4 / A3).
  if (superseded && prevRaw !== null) {
    let line: string;
    try { line = JSON.stringify(JSON.parse(prevRaw)); } catch { line = JSON.stringify({ unparseable_receipt: prevRaw.slice(0, 4096) }); }
    appendFileSync(p.replace(/\.json$/, ".history.jsonl"), line + "\n", { mode: 0o600 });
  }
  // The index entries go in before the receipt, so this writer never leaves a receipt the sha index cannot find (ISC-43).
  writeIndexEntry(dirname(p), HEX64.test(r.sha256) ? r.sha256 : null, basename(p, ".json"));
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(r, null, 2));
  renameSync(tmp, p);
  mirrorReceipt(r, basename(p, ".json"));
  return p;
}

type QualityWriters = typeof import("../../STATVS/lib/quality.ts");
let QW: QualityWriters | null = null;
/**
 * Step 1 of the STATVS migration (dual-write): after a receipt file landed, the same boundary run goes to the record's
 * `receipt` stream as counts and ids (never a finding's text). The file stays authoritative. The STATVS writer loads on
 * the first write only (a sync require), so a hook that imports this file never pays for the record engine. Never
 * throws: a refused, spooled or failed append is logged and the caller carries on.
 */
export function mirrorReceipt(r: ProofReceipt, key: string): void {
  try {
    QW ??= createRequire(import.meta.url)("../../STATVS/lib/quality.ts") as QualityWriters;
    const assay = isAssayReceipt(r);
    QW.recordReceipt({
      key, sha256: r.sha256, verdict: r.verdict,
      evaluators: assay && Object.keys(r.evaluators ?? {}).length ? r.evaluators : { proof: r.schema },
      ...(assay ? { destination: r.destination, ideal_state: r.ideal_state } : {}),
      counts: { ...r.counts }, ...(r.run_id ? { run_id: r.run_id } : {}),
    });
  } catch (e) {
    try { process.stderr.write(`statvs receipt mirror: ${e instanceof Error ? e.message : String(e)}\n`); } catch { /* stderr closed */ }
  }
}

/**
 * Append findings found after the boundary (a post-delivery judge, a principal catch) to an artifact's fresh
 * assay-receipt/1. The boundary findings and verdict_at_boundary are untouched; the top-level verdict and counts move.
 */
export async function appendFindings(artifact: string, added: ProofFinding[], source: string): Promise<{ path: string; receipt: AssayReceipt }> {
  invariant(added.length > 0, "appendFindings needs at least one finding");
  invariant(source.trim().length > 0, "appendFindings needs a source");
  const f = await receiptFreshness(artifact);
  if (!f.fresh || !f.receipt) throw new Error(`cannot append: ${f.reason}`);
  const r = f.receipt;
  if (!isAssayReceipt(r)) throw new Error(`cannot append to a ${RECEIPT_SCHEMA} receipt; re-run Proof to write ${ASSAY_RECEIPT_SCHEMA}`);
  if (r.verdict === "reference") throw new Error("cannot append findings to a reference receipt");
  const at = new Date().toISOString();
  const findings = [...r.findings, ...added.map((x) => ({ ...x, added_at: at, source: source.trim() }))];
  const { verdict, counts } = deriveVerdict(findings, r.counts.passed, ASSAY_RECEIPT_SCHEMA, r.counts.safety_passed);
  const next: AssayReceipt = { ...r, findings, verdict, counts };
  invariant(next.verdict_at_boundary === r.verdict_at_boundary && next.sha256 === r.sha256, "appending never changes the boundary verdict or the bytes");
  return { path: writeReceipt(next), receipt: next };
}

export type Freshness = { fresh: boolean; receipt: ProofReceipt | null; reason: string };

/**
 * The one freshness rule: does this file still hold the bytes a record names? Always hashes; size and mtime are never
 * trusted (a same-size rewrite with a restored mtime is stale). Critique.json switches to this when
 * its records carry a sha256 (Design C8).
 */
export async function shaFreshness(artifact: string, expectedSha256: string): Promise<{ fresh: boolean; reason: string }> {
  if (!existsSync(artifact)) return { fresh: false, reason: "artifact missing" };
  return (await sha256File(artifact)) === expectedSha256 ? { fresh: true, reason: "sha256 match" } : { fresh: false, reason: "artifact changed since its receipt" };
}

/** Fresh = a receipt exists and still describes these exact bytes, by sha256. */
export async function receiptFreshness(artifact: string): Promise<Freshness> {
  const { receipt: r, problem } = loadReceipt(artifact);
  if (problem) return { fresh: false, receipt: null, reason: `receipt invalid (edited by hand?): ${problem}` };
  if (!r) return { fresh: false, receipt: null, reason: "no receipt" };
  const s = await shaFreshness(artifact, r.sha256);
  return { fresh: s.fresh, receipt: r, reason: s.reason };
}

/** Unearned flags with no dismissal record for their check: shown to the principal at handoff, never a block. */
export function openFlags(r: ProofReceipt): ProofFinding[] {
  const dismissed = new Set((r.dismissals ?? []).map((d) => d.check));
  return r.findings.filter((f) => f.severity === "flag" && !dismissed.has(f.check));
}

/** One line naming a file's open unearned flags, the shape ProofGate and Deliver both print (maintainer-side; not in the public release). */
export function formatOpenFlags(name: string, flags: readonly ProofFinding[]): string {
  return `${name}: ${flags.length} unearned flag(s), not blocking: ${flags.map((f) => `${f.check} (${f.message.replace(/\s+/g, " ").slice(0, 160)})`).join("; ")}`;
}

/** `unmeasured` is true when the receipt is admitted with no ideal-state check passed and no flag: the gate must say so (ISC-24). */
export type PresentVerdict = { ok: boolean; reason: string; receipt: ProofReceipt | null; flags: ProofFinding[]; unmeasured?: boolean };

/** The line a gate prints for an admitted unmeasured receipt; the assistant says it when presenting, like UNPROOFED. */
export function formatUnmeasured(name: string, r: Pick<ProofReceipt, "counts">): string {
  const safety = r.counts.safety_passed ?? 0;
  return `UNMEASURED: ${name} has a fresh receipt but no ideal-state check passed${safety > 0 ? ` (only ${safety} always-on safety check(s) ran clean)` : ""}; nothing measured it against what was asked`;
}

/**
 * What a gate asks: may this artifact be shown? No for a missing, stale or hand-edited receipt, a code-tier fail, an
 * earned check's no, or an unmeasured check. Yes otherwise, with every open unearned flag returned in `flags` and named
 * in `reason`, so the gate can say them: an unproven probability is never a veto (2026-09-30).
 */
export async function mayPresent(artifact: string): Promise<PresentVerdict> {
  try {
    return presentVerdict(await receiptFreshness(artifact));
  } catch (e) {
    // A gate that fails open on a throw must never receive one from here: anything unexpected reads as not proofed.
    return { ok: false, reason: `could not verify the receipt: ${e instanceof Error ? e.message : String(e)}`, receipt: null, flags: [] };
  }
}

/**
 * mayPresent for bytes that are not on disk yet (a Write's content, an Edit's computed post-state, a file about to be
 * copied): same verdict rule, with freshness decided by comparing the receipt's sha256 to the sha256 the caller computed
 * from the post-state, never by reading the file. The receipt is still looked up by the artifact's path.
 */
export async function mayPresentSha(artifact: string, expectedSha256: string): Promise<PresentVerdict> {
  try {
    invariant(HEX64.test(expectedSha256), "mayPresentSha needs a sha256 hex digest");
    const { receipt: r, problem } = loadReceipt(artifact);
    let f: Freshness;
    if (problem) f = { fresh: false, receipt: null, reason: `receipt invalid (edited by hand?): ${problem}` };
    else if (!r) f = { fresh: false, receipt: null, reason: "no receipt" };
    else f = r.sha256 === expectedSha256 ? { fresh: true, receipt: r, reason: "sha256 match" } : { fresh: false, receipt: r, reason: "artifact changed since its receipt" };
    return presentVerdict(f);
  } catch (e) {
    return { ok: false, reason: `could not verify the receipt: ${e instanceof Error ? e.message : String(e)}`, receipt: null, flags: [] };
  }
}

/** The most receipt files a by-sha lookup reads: a store this large is already far past the gate's budget. */
export const SHA_LOOKUP_MAX_FILES = 2000;

/**
 * Find a receipt anywhere in the store whose sha256 equals `sha`, and that passes receiptProblem. Receipts are keyed by
 * path, so a file that was proofed under one name and lands under another (a Write or Edit into Downloads, a rename)
 * has no receipt at its own path; this finds the receipt that describes exactly those bytes. Read-only, newest receipt
 * first, bounded by `budgetMs` and SHA_LOOKUP_MAX_FILES (past either it returns null, which reads as "no receipt").
 * Only the receipts the sha index points at for these bytes, plus any unindexed ones, are read (ISC-43, as
 * earnedFailuresBySha reads them): the whole store was read per lookup before, ~70 ms a landed file at 5,600 receipts,
 * and the 2,000-file cap took names in directory order, so a newer receipt past it was never found.
 * Never throws. `key` is the store key (the receipt file's name), the same value receiptId() gives for its artifact.
 */
export function findReceiptBySha(sha: string, opts: { budgetMs?: number; dir?: string; now?: () => number } = {}): { receipt: ProofReceipt; key: string } | null {
  try {
    invariant(HEX64.test(sha), "findReceiptBySha needs a sha256 hex digest");
    const dir = opts.dir ?? receiptDir();
    const clock = opts.now ?? (() => performance.now());
    const deadline = clock() + (opts.budgetMs ?? 1000);
    if (!existsSync(dir)) return null;
    const pointed = join(shaIndexDir(dir), sha);
    const names = [...new Set([
      ...(existsSync(pointed) ? readdirSync(pointed).filter((x) => HEX64.test(x)).map((x) => `${x}.json`) : []),
      ...unindexedReceipts(dir),
    ])];
    if (names.length > SHA_LOOKUP_MAX_FILES) return null;
    const files = names
      .map((n) => { try { return { n, m: statSync(join(dir, n)).mtimeMs }; } catch { return { n, m: 0 }; } })
      .sort((a, b) => b.m - a.m);
    for (const { n } of files) {
      if (clock() > deadline) return null;
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(join(dir, n), "utf8")); } catch { continue; }
      if (!raw || typeof raw !== "object" || (raw as { sha256?: unknown }).sha256 !== sha) continue;
      if (receiptProblem(raw) !== null) continue;
      return { receipt: raw as ProofReceipt, key: n.replace(/\.json$/, "") };
    }
    return null;
  } catch { return null; }
}

/**
 * mayPresent for bytes identified only by their sha256: the verdict of a receipt that describes exactly these bytes,
 * wherever it is filed. Not found reads as "no receipt for these bytes". `key` names the receipt found.
 */
export function mayPresentBySha(sha: string, opts: { budgetMs?: number; dir?: string } = {}): PresentVerdict & { key: string | null } {
  const found = findReceiptBySha(sha, opts);
  if (!found) return { ok: false, reason: "no receipt for these bytes", receipt: null, flags: [], key: null };
  return { ...presentVerdict({ fresh: true, receipt: found.receipt, reason: "sha256 match (by content)" }), key: found.key };
}

/** The output ledger's receipt_id: the store key of the artifact's receipt (sha256 of its canonical absolute path). */
export function receiptId(artifact: string): string {
  return createHash("sha256").update(canonicalPath(artifact)).digest("hex");
}

function presentVerdict(f: Freshness): PresentVerdict {
  if (!f.fresh) return { ok: false, reason: f.reason, receipt: f.receipt, flags: [] };
  const r = f.receipt!;
  // loadReceipt already ran receiptProblem: the verdict and counts are derived from the findings (Fable M2), a reference
  // receipt has a reason and no findings, and only code or earned checks fail.
  if (r.verdict === "reference") return { ok: true, reason: `reference: ${r.reason}`, receipt: r, flags: [] };
  if (r.counts.passed + r.findings.length === 0) return { ok: false, reason: "receipt checked nothing", receipt: r, flags: [] };
  if (r.verdict === "fail") {
    const earned = r.findings.filter((x) => x.severity === "fail" && x.tier !== "code");
    const parts = [r.counts.code_fail ? `${r.counts.code_fail} code finding(s) open` : "", earned.length ? `${earned.length} earned check(s) said no: ${[...new Set(earned.map((x) => x.check))].join(", ")}` : ""].filter(Boolean);
    return { ok: false, reason: parts.join("; "), receipt: r, flags: [] };
  }
  if (r.verdict === "unavailable") return { ok: false, reason: `${r.counts.unavailable} check(s) could not be measured`, receipt: r, flags: [] };
  // ISC-24: admitted-flagged reads exactly as pass-with-flags did; unmeasured is admitted (as it was) but named, never as proofed.
  if (effectiveVerdict(r) === "unmeasured") return { ok: true, reason: `unmeasured ${r.ran_at}: no ideal-state check passed (${r.counts.safety_passed ?? 0} safety check(s) passed)`, receipt: r, flags: [], unmeasured: true };
  const open = openFlags(r);
  const dismissed = r.counts.flags - open.length;
  const flagNote = open.length ? `, ${open.length} unearned flag(s) open, not blocking: ${[...new Set(open.map((x) => x.check))].join(", ")}` : "";
  return { ok: true, reason: `proofed ${r.ran_at}: ${r.counts.passed} passed${flagNote}${dismissed > 0 ? `, ${dismissed} flag(s) dismissed` : ""}`, receipt: r, flags: open };
}

// ── Release admission (principal directive, 2026-10-24: every video carries its eval set, and nothing leaves without it) ──
// The ONE rule a hand-off (ArtDirection Deliver.ts), an upload and a publish (YouTubeUpload.ts) apply to a receipt.
// Callers never restate it: they hand over the bytes' sha256 and where they are going, and print what comes back.

/** The evaluator name VideoEval writes; a video is admitted only on a receipt that carries it. */
export const VIDEO_EVAL_EVALUATOR = "video-eval";
/** File extensions that make an artifact a video for this rule (a receipt of kind "video" counts too). */
export const VIDEO_EXTENSION = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
/**
 * Where the bytes are going. handoff: shown to the principal. upload-private: a private YouTube upload (unmeasured is
 * admitted with a printed line). public: an upload or publish to public or unlisted (unmeasured is refused).
 */
export type ReleaseBoundary = "handoff" | "upload-private" | "public";

/** The animation-quantity checks of the video eval set. */
export const ANIMATION_QUANTITY_CHECKS = ["motion-share", "motion-max-still", "visual-cadence", "visual-variety"] as const;
/** A check an intent may switch off only from the allowlist below: animation quantity, any watermark check, voice identity. */
export function isProtectedVideoCheck(id: string): boolean {
  return (ANIMATION_QUANTITY_CHECKS as readonly string[]).includes(id) || id.startsWith("watermark-") || id === "voice-identity";
}
/**
 * The pipeline an intent belongs to: camera footage (the video pipeline skill), a VideoEssay run (rendered, DA-narrated), a
 * HyperFrames animation, or a StoryFilm reading. Only a VideoEssay intent may be measured on a VideoEssay render.
 */
export type VideoPipeline = "camera" | "videoessay" | "hyperframes" | "storyfilm";
/** The DA essay intents: the only ones a video wearing the DA essay badge may be evaluated or admitted under (VideoRecheck). */
export const DA_ESSAY_INTENTS: readonly string[] = ["skills/VideoEssay/Intents/Full.md", "skills/VideoEssay/Intents/Explainer.md"];
/** The motion checks no intent outside camera footage may ever switch off. */
export const MOTION_CHECKS: readonly string[] = ["motion-share", "motion-max-still", "visual-cadence"];
// release-allow: private-skill-names (the camera-footage intent keys below are inert data on an install without the video pipeline skill: no intent path ever equals one, so no allowance is granted)
const CAMERA_FOOTAGE_INTENTS = ["Augment", "Clips", "Conversation", "Edit", "Enhance", "ExportReliably", "RegularRun", "SponsoredIntro", "SponsoredVideo", "Teaser", "TightCut"];
/** What only a VideoEssay run has (script, timeline, the badge, the channel mark, the DA voice): a HyperFrames or StoryFilm intent may switch these off. */
const NEEDS_VIDEOESSAY_RUN: readonly string[] = ["duration", "voice-identity", "voice-wer", "voice-pace", "script-length", "script-intent", "visual-variety", "detail", "card-corners", "watermark-brand", "watermark-badge", "watermark-zone", "type-rendered"];
/** VideoEssay Voice.md holds the page still while the author reads, wears the reader badge and reads the author's voice. */
const VOICE_RUN_OFF: readonly string[] = ["watermark-badge", "watermark-zone", "voice-identity", "voice-pace", "motion-share", "motion-max-still", "visual-variety"];
type Allowance = { pipeline: VideoPipeline; allows: (id: string) => boolean };
/**
 * The only intents whose `## Evals` switch-offs may turn off a protected check, keyed by path relative to ~/.claude.
 * Camera footage has no authored animation, no DA badge or composed channel mark, and the principal's own voice, so a
 * camera-footage intent may switch off animation quantity, watermark and voice identity (VideoRecheck admits it only on bytes
 * with no DA essay badge). Voice.md may switch off what VOICE_RUN_OFF names; visual-cadence still blocks there. VideoEssay
 * Full and Explainer switch off no protected check. HyperFrames and StoryFilm intents (videoSwitchOffAllowance) may switch
 * off only what needs a VideoEssay run, never the motion checks.
 */
export const VIDEO_SWITCH_OFF_ALLOWLIST: Readonly<Record<string, Allowance>> = Object.freeze({
  ...Object.fromEntries(CAMERA_FOOTAGE_INTENTS.map((n) => [`skills/_VIDEO/Intents/${n}.md`, { pipeline: "camera" as const, allows: (id: string) => (ANIMATION_QUANTITY_CHECKS as readonly string[]).includes(id) || id.startsWith("watermark-") || id === "voice-identity" }])),
  "skills/VideoEssay/Intents/Voice.md": { pipeline: "videoessay" as const, allows: (id: string) => VOICE_RUN_OFF.includes(id) },
});
/** The allowance an intent (relative to ~/.claude) carries: the allowlist entry, or a HyperFrames / StoryFilm intent's. Null: none. */
export function videoSwitchOffAllowance(intent: string | null): Allowance | null {
  if (!intent) return null;
  if (VIDEO_SWITCH_OFF_ALLOWLIST[intent]) return VIDEO_SWITCH_OFF_ALLOWLIST[intent];
  const m = intent.match(/^skills\/(HyperFrames|StoryFilm)\/Intents\/[^/]+\.md$/);
  if (!m) return null;
  return { pipeline: m[1] === "HyperFrames" ? "hyperframes" : "storyfilm", allows: (id: string) => NEEDS_VIDEOESSAY_RUN.includes(id) && !MOTION_CHECKS.includes(id) };
}
/** The install root this file lives in (…/.claude), so intent paths normalize the same under any HOME. */
const CODE_ROOT = resolve(import.meta.dir, "..", "..", "..");
/** An intent path, absolute or under a `~/.claude/` prefix or relative, as a path relative to ~/.claude; null when it is outside it. */
export function intentRelPath(p: string): string | null {
  let s = p.trim();
  if (s.startsWith("~/.claude/")) return s.slice("~/.claude/".length);
  for (const root of [CODE_ROOT, getClaudeDir()]) if (s.startsWith(root + "/")) return s.slice(root.length + 1);
  if (isAbsolute(s)) return null;
  s = s.replace(/^\.\//, "");
  return s.startsWith("../") ? null : s;
}

/** True when `path` is a render inside a VideoEssay run's Out/ (the run dir beside it holds Script.json or run.json). */
export function inVideoEssayRun(path: string | null | undefined): boolean {
  if (!path) return false;
  const out = dirname(resolve(path));
  return basename(out) === "Out" && (existsSync(join(dirname(out), "Script.json")) || existsSync(join(dirname(out), "run.json")));
}

/** The intent an opt_out reason names (`<intent path relative to ~/.claude>: <reason>`), normalized; null when none. */
export function optOutIntent(reason: string): string | null {
  const m = reason.match(/^(\S+?\.md):\s/);
  return m ? intentRelPath(m[1]) : null;
}

/**
 * Why a video receipt's opt_outs may not cross `boundary`, or null. Every switch-off of a protected check must name an
 * allowlisted intent whose pipeline matches the artifact (a VideoEssay render may use only VideoEssay intents, camera
 * footage only camera-footage intents); a judges-off opt_out is refused at every upload and public publish; an opt_out of a kind
 * the receipt contract does not define is refused. `paths` are the gate's artifact and the receipt's own artifact.
 */
export function videoOptOutProblem(r: Pick<ProofReceipt, "opt_outs">, paths: (string | null | undefined)[], boundary: ReleaseBoundary): string | null {
  const essay = paths.some((p) => inVideoEssayRun(p));
  for (const o of r.opt_outs ?? []) {
    const sel = String(o?.selector ?? ""), kind = String(o?.kind ?? ""), reason = String(o?.reason ?? "");
    if (kind === "judges-off") {
      if (boundary !== "handoff") return `${sel} was skipped with judges off (${reason}); nothing goes to YouTube with its judged checks unrun`;
      continue;
    }
    if (kind !== "intent-switch-off") return `opt_out ${sel} has kind "${kind}", which no receipt may carry`;
    if (!isProtectedVideoCheck(sel)) continue;
    const intent = optOutIntent(reason);
    const allowed = videoSwitchOffAllowance(intent);
    if (!allowed || !allowed.allows(sel)) return `${sel} was switched off by ${intent ?? "an unnamed intent"}, which may not switch it off (allowlist: ProofReceipt VIDEO_SWITCH_OFF_ALLOWLIST and videoSwitchOffAllowance)`;
    if (allowed.pipeline !== "videoessay" && essay) return `${sel} was switched off by the ${allowed.pipeline === "camera" ? "camera-footage" : allowed.pipeline} intent ${intent}, but this is a VideoEssay render`;
    if (allowed.pipeline === "videoessay" && !essay) return `${sel} was switched off by the VideoEssay intent ${intent}, but this file is not a VideoEssay render`;
  }
  return null;
}

/** The command that writes a video's eval receipt: Run.ts eval on the exact file, with the intent it was made for. */
export function videoEvalCommand(file: string, intent?: string | null): string {
  const q = (s: string) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.split("'").join(`'\\''`)}'`);
  return `bun ~/.claude/skills/VideoEssay/Tools/Run.ts eval --video ${q(resolve(file))} --intent ${intent ? q(intent) : "<intent.md>"}`;
}

/** The intent a receipt was measured against, when it names one (VideoEval records it as its ideal state). */
export function receiptIntent(r: ProofReceipt | null): string | null {
  return r && isAssayReceipt(r) && r.ideal_state?.kind === "isa" ? r.ideal_state.path : null;
}

/** The switch-offs an intent file declares: VideoEval's intent parser (intentFileDisables), handed in by the caller. */
export type IntentDisablesParser = (intent: string) => { id: string; reason: string }[];
/** VideoEval's own intent parser, loaded on demand (VideoEval imports this file, so it is never a static import here). */
export async function loadIntentDisablesParser(): Promise<IntentDisablesParser> {
  const VE = await import("../../../skills/Assay/Tools/VideoEval.ts");
  return VE.intentFileDisables;
}

/**
 * Why a video receipt's intent binding fails, or null. The intent file named in ideal_state.path is read now: its sha256
 * must equal ideal_state.revision, and the receipt's intent-switch-off opt_outs must be exactly the switch-offs that file
 * declares (each naming that intent). A receipt with no intent may switch nothing off. The parser is VideoEval's; with
 * none handed in, a receipt that names an intent cannot be checked and is refused.
 */
export function intentBindingProblem(r: ProofReceipt, parse?: IntentDisablesParser): string | null {
  const offs = (r.opt_outs ?? []).filter((o) => o?.kind === "intent-switch-off");
  const intent = receiptIntent(r);
  if (!intent) return offs.length ? `the receipt switches off ${offs.map((o) => o.selector).join(", ")} but names no intent that declares it` : null;
  if (!existsSync(intent)) return `the intent the receipt was measured against is gone: ${intent}`;
  const now = createHash("sha256").update(readFileSync(intent)).digest("hex");
  if (isAssayReceipt(r) && r.ideal_state.kind === "isa" && now !== r.ideal_state.revision) return `the intent ${intent} changed since the receipt was written (revision ${r.ideal_state.revision.slice(0, 12)}… ≠ now ${now.slice(0, 12)}…); re-run the eval`;
  if (!parse) return `the switch-offs ${intent} declares could not be read (no intent parser), so the receipt's switch-offs cannot be checked`;
  let declared: string[];
  try { declared = parse(intent).map((d) => d.id); } catch (e) { return `the intent ${intent} does not parse: ${e instanceof Error ? e.message : String(e)}`; }
  const sorted = (xs: string[]) => [...xs].sort().join(",");
  const claimed = offs.map((o) => String(o.selector));
  if (sorted(claimed) !== sorted(declared)) {
    const extra = claimed.filter((x) => !declared.includes(x)), missing = declared.filter((x) => !claimed.includes(x));
    return `the receipt's switch-offs are not the ones ${intentRelPath(intent) ?? intent} declares${extra.length ? `; never declared: ${extra.join(", ")}` : ""}${missing.length ? `; declared but not recorded: ${missing.join(", ")}` : ""}`;
  }
  const rel = intentRelPath(intent);
  const foreign = offs.find((o) => optOutIntent(String(o.reason ?? "")) !== rel);
  if (foreign) return `${foreign.selector} is switched off in the name of ${optOutIntent(String(foreign.reason ?? "")) ?? "an unnamed intent"}, not the receipt's intent ${rel ?? intent}`;
  return null;
}

export interface ReleaseAdmission {
  ok: boolean;
  reason: string;
  /** The line to print and say when admitted with open flags, an unmeasured receipt, or switched-off checks. */
  line: string | null;
  receipt: ProofReceipt | null;
  /** Open unearned flags (never blocking), named in `line`. */
  flags: ProofFinding[];
  /** Whether the bytes were judged as a video (the refusal must then print videoEvalCommand, never Proof.ts). */
  video: boolean;
  /** For a video: the exact command that writes the receipt this rule wants. Null for other kinds (the caller names its Proof command). */
  fix: string | null;
}

/**
 * The release rule over one receipt verdict. Refused: a verdict mayPresent refuses; a reference receipt (a released
 * file is a produced output); a receipt no code tier wrote (evaluators name neither "proof" nor "video-eval"); for a
 * video, any receipt without the "video-eval" evaluator, an intent binding intentBindingProblem refuses (the intent
 * changed, or switch-offs it never declared), or opt_outs videoOptOutProblem refuses; an unmeasured receipt at the
 * public boundary. Admitted with a line: open unearned flags, an unmeasured receipt below public, switch-offs.
 * Gates call releaseAdmission, which hands in VideoEval's intent parser; this rule never re-measures bytes (VideoRecheck does).
 */
export function admitReceipt(v: PresentVerdict, o: { name: string; artifact: string | null; boundary: ReleaseBoundary; video?: boolean; intentDisables?: IntentDisablesParser }): ReleaseAdmission {
  const r = v.receipt;
  const video = o.video ?? (VIDEO_EXTENSION.test(o.artifact ?? o.name) || r?.kind === "video");
  const fix = video ? videoEvalCommand(o.artifact ?? o.name, receiptIntent(r)) : null;
  const no = (reason: string): ReleaseAdmission => ({ ok: false, reason, line: null, receipt: r, flags: [], video, fix });
  if (!v.ok) return no(v.reason);
  if (r?.verdict === "reference") return no(`the receipt is a reference receipt (${r.reason ?? "not a produced output"}); a released file is a produced output and needs its checks run`);
  const evaluators = r && isAssayReceipt(r) ? Object.keys(r.evaluators ?? {}) : null; // null: proof-receipt/1, which only Proof writes
  if (video) {
    if (!r || evaluators === null || !evaluators.includes(VIDEO_EVAL_EVALUATOR)) return no(`a video is released only on its VideoEval receipt; this one (${evaluators ? `evaluators: ${evaluators.join(", ") || "none"}` : r?.schema ?? "none"}) checked none of watermark, voice or animation`);
    const bind = intentBindingProblem(r, o.intentDisables);
    if (bind) return no(bind);
    const opt = videoOptOutProblem(r, [o.artifact, r.artifact], o.boundary);
    if (opt) return no(opt);
  } else if (evaluators !== null && !evaluators.includes("proof") && !evaluators.includes(VIDEO_EVAL_EVALUATOR)) {
    return no("the receipt came from the critique alone; no code-tier check ran on these bytes");
  }
  if (v.unmeasured && o.boundary === "public") return no("the receipt is unmeasured: no ideal-state check passed, and nothing unmeasured goes public or unlisted");
  const off = (r?.opt_outs ?? []).filter((x) => x?.kind === "intent-switch-off").map((x) => x.selector);
  const base = v.flags.length ? formatOpenFlags(o.name, v.flags) : v.unmeasured && r ? formatUnmeasured(o.name, r) : null;
  const line = off.length ? `${base ? `${base}; ` : `${o.name}: `}switched off by its intent: ${off.join(", ")}` : base;
  return { ok: true, reason: v.reason, line, receipt: r, flags: v.flags, video, fix };
}

/**
 * Every valid receipt in the store for these bytes, current (`receipts`) and superseded (`history`: lines of a
 * `<key>.history.jsonl`, replaced by a newer run at the same path), or why the scan could not cover the store.
 */
type KeyedReceipt = { key: string; receipt: ProofReceipt };
export type ShaScan = { receipts: KeyedReceipt[]; history: KeyedReceipt[]; complete: true } | { receipts: KeyedReceipt[]; history: KeyedReceipt[]; complete: false; why: string };
/** How long a release may spend reading the receipt store before it refuses as incomplete. */
export const RELEASE_SCAN_BUDGET_MS = 8000;
const HISTORY_NAME = /^([0-9a-f]{64})\.history\.jsonl$/;

/**
 * Read every receipt the sha index points at for `sha`, plus every unindexed one, with no file cap, and every line of
 * every history file that names the sha (a history line predating the sha index has no pointer, so all history files
 * are searched; they are small). A receipt or history line that holds this sha but cannot be parsed or validated ends
 * the scan incomplete, since it may be the one record of a failure for these bytes; so do the time budget and an
 * unreadable store. Read-only, never throws.
 */
export function receiptsBySha(sha: string, opts: { dir?: string; budgetMs?: number; now?: () => number } = {}): ShaScan {
  const out: KeyedReceipt[] = [];
  const history: KeyedReceipt[] = [];
  const incomplete = (why: string): ShaScan => ({ receipts: out, history, complete: false, why });
  try {
    if (!HEX64.test(sha)) return incomplete("the bytes have no valid sha256");
    const dir = opts.dir ?? receiptDir();
    if (!existsSync(dir)) return { receipts: out, history, complete: true };
    const clock = opts.now ?? (() => performance.now());
    const budget = opts.budgetMs ?? RELEASE_SCAN_BUDGET_MS, deadline = clock() + budget;
    const pointed = join(shaIndexDir(dir), sha);
    const listing = readdirSync(dir);
    const indexed = new Set(existsSync(keyIndexDir(dir)) ? readdirSync(keyIndexDir(dir)) : []);
    const names = [...new Set([
      ...(existsSync(pointed) ? readdirSync(pointed).filter((x) => HEX64.test(x)).map((x) => `${x}.json`) : []),
      ...listing.filter((x) => RECEIPT_NAME.test(x) && !indexed.has(x.slice(0, -".json".length))),
    ])];
    for (const n of listing) {
      const m = n.match(HISTORY_NAME);
      if (!m) continue;
      if (clock() > deadline) return incomplete(`the receipt scan ran past its ${budget} ms budget`);
      let text: string;
      try { text = readFileSync(join(dir, n), "utf8"); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        return incomplete(`receipt history ${n.slice(0, 8)} is unreadable`);
      }
      // History lines are JSON.stringify output, which never escapes a hex digest: a line without the sha cannot name it.
      if (!text.includes(sha)) continue;
      for (const line of text.split("\n")) {
        if (!line.includes(sha)) continue;
        let raw: unknown;
        try { raw = JSON.parse(line); } catch { if (line.includes(sha)) return incomplete(`a history line in ${n.slice(0, 8)} holds these bytes' sha but cannot be parsed`); continue; }
        if (!isObj(raw) || raw.sha256 !== sha) {
          if (line.includes(sha) && isObj(raw) && "unparseable_receipt" in raw) return incomplete(`a history line in ${n.slice(0, 8)} kept an unparseable receipt that names these bytes`);
          continue;
        }
        const problem = receiptProblem(raw);
        if (problem !== null) return incomplete(`a superseded receipt in ${n.slice(0, 8)} for these bytes is invalid: ${problem}`);
        history.push({ key: m[1], receipt: raw as ProofReceipt });
      }
    }
    for (const n of names) {
      if (clock() > deadline) return incomplete(`the receipt scan ran past its ${budget} ms budget`);
      const headSha = receiptHeadSha(join(dir, n));
      if (headSha !== null && headSha !== sha) continue;
      let text: string;
      try { text = readFileSync(join(dir, n), "utf8"); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        return incomplete(`receipt ${n.slice(0, 8)} is unreadable`);
      }
      if (!text.includes(sha) && !text.includes("\\u")) continue;
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { return incomplete(`receipt ${n.slice(0, 8)} holds these bytes' sha but cannot be parsed`); }
      if (!isObj(raw) || raw.sha256 !== sha) {
        if (headSha === sha) return incomplete(`receipt ${n.slice(0, 8)} names these bytes in its head but parses as other bytes`);
        continue;
      }
      const problem = receiptProblem(raw);
      if (problem !== null) return incomplete(`receipt ${n.slice(0, 8)} for these bytes is invalid: ${problem}`);
      out.push({ key: n.slice(0, -".json".length), receipt: raw as ProofReceipt });
    }
    return { receipts: out, history, complete: true };
  } catch (e) {
    return incomplete(`the receipt store could not be read: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** A receipt that records a blocking check for its bytes: a code-tier fail or an earned no. */
export function recordsFailure(r: ProofReceipt): boolean {
  return r.counts.code_fail > 0 || (r.counts.earned_fail ?? 0) > 0;
}

/**
 * May these exact bytes cross `boundary`? Every receipt in the store for the sha is read first, and any one that records
 * a code fail or an earned no refuses, however new a passing receipt beside it is; a scan that cannot finish refuses.
 * Then the verdict comes from the receipt filed for `artifact` when it describes these bytes (and, for a video, carries
 * the VideoEval evaluator), else the newest such receipt anywhere in the store, and admitReceipt decides.
 */
export async function releaseAdmission(o: { artifact: string | null; sha256: string; boundary: ReleaseBoundary; name?: string; video?: boolean; dir?: string; budgetMs?: number }): Promise<ReleaseAdmission> {
  const artifact = o.artifact ? resolve(o.artifact) : null;
  const name = o.name ?? (artifact ? basename(artifact) : o.sha256.slice(0, 12));
  const video = o.video ?? (VIDEO_EXTENSION.test(artifact ?? name));
  const refuse = (reason: string, receipt: ProofReceipt | null = null) => admitReceipt({ ok: false, reason, receipt, flags: [] }, { name, artifact, boundary: o.boundary, video });
  try {
    invariant(HEX64.test(o.sha256), "releaseAdmission needs the bytes' sha256");
    // Outside tests a gate never reads a redirected store: a planted receipt or memo could admit anything.
    const envBad = gateEnvProblem();
    if (envBad) return refuse(envBad);
    if (o.dir !== undefined && process.env.NODE_ENV !== "test") return refuse("the release gate reads only its own receipt store; a dir override is for tests");
    const scan = receiptsBySha(o.sha256, { dir: o.dir, budgetMs: o.budgetMs });
    if (!scan.complete) return refuse(`the receipt store could not be fully checked for failures on these bytes (${scan.why})`);
    // A superseded receipt (moved to history when a newer run replaced it at the same path) refuses exactly as a current one does.
    const failing = [...scan.receipts.map((x) => ({ ...x, superseded: false })), ...scan.history.map((x) => ({ ...x, superseded: true }))]
      .filter((x) => recordsFailure(x.receipt)).sort((a, b) => b.receipt.ran_at.localeCompare(a.receipt.ran_at));
    if (failing.length) {
      const f = failing[0].receipt;
      const earned = f.findings.filter((x) => x.severity === "fail" && x.tier !== "code");
      const what = [f.counts.code_fail ? `${f.counts.code_fail} code finding(s) open` : "", earned.length ? `${earned.length} earned check(s) said no` : ""].filter(Boolean).join("; ");
      const ids = [...new Set(f.findings.filter((x) => x.severity === "fail").map((x) => x.check))].join(", ");
      const under = receiptIntent(f);
      return refuse(`a ${failing[0].superseded ? "superseded " : ""}receipt for these exact bytes records a failure: ${what} (${ids}) in ${f.artifact} at ${f.ran_at}${under ? ` under ${intentRelPath(under) ?? under}` : ""}${failing.length > 1 ? `, and ${failing.length - 1} more receipt(s) fail` : ""}; a newer passing receipt never clears it`, f);
    }
    const wanted = (r: ProofReceipt) => !video || (isAssayReceipt(r) && VIDEO_EVAL_EVALUATOR in (r.evaluators ?? {}));
    const own = artifact ? await mayPresentSha(artifact, o.sha256) : null;
    let v: PresentVerdict | null = own && own.receipt && own.receipt.sha256 === o.sha256 && wanted(own.receipt) ? own : null;
    if (!v) {
      const pick = scan.receipts.filter((x) => wanted(x.receipt)).sort((a, b) => b.receipt.ran_at.localeCompare(a.receipt.ran_at))[0];
      if (pick) v = presentVerdict({ fresh: true, receipt: pick.receipt, reason: "sha256 match (by content)" });
    }
    v ??= own ?? { ok: false, reason: "no receipt for these bytes", receipt: null, flags: [] };
    // VideoEval's intent parser, only when the receipt has an intent binding to check (it is a heavy module).
    const needsParser = video && v.ok && v.receipt !== null && (receiptIntent(v.receipt) !== null || (v.receipt.opt_outs ?? []).some((x) => x?.kind === "intent-switch-off"));
    const intentDisables = needsParser ? await loadIntentDisablesParser() : undefined;
    return admitReceipt(v, { name, artifact, boundary: o.boundary, video, intentDisables });
  } catch (e) {
    return refuse(`could not verify the receipt: ${e instanceof Error ? e.message : String(e)}`);
  }
}
