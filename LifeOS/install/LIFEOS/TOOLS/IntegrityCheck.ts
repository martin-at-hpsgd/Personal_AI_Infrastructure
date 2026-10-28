#!/usr/bin/env bun
/**
 * @version 1.1.79
 * IntegrityCheck.ts — Full-system integrity orchestrator for the LifeOS system.
 *
 * The deterministic backbone behind `/ic`. Runs one fast pass across every
 * LifeOS surface and emits a single consolidated report + a single exit code.
 *
 * The check list is RUN_TABLE (near the end of this file): it decides what runs,
 * what --section accepts, and what --help prints, so --help names exactly the
 * checks a --json run reports (ISC-51, 20261009-release-rebuild).
 *
 * This is an ORCHESTRATOR. It does NOT re-implement ReferenceCheck's tree-walk —
 * it shells out to it. The expensive 13-agent deep audit is NOT run here; `--deep`
 * only prints how to run it (agents are the intent's job, not this tool's).
 *
 * Stamps (MEMORY/STATE/integrity/): a full run writes last-run.json and appends
 * runs.jsonl; an exit-0 run also writes last-pass.json, the bump gate's input.
 * HEAD is read BEFORE the checks start, and the pass stamp is refused when a core
 * path moved during the run. --no-stamp and --section runs write nothing at all
 * (no stamp, no run row, no layer-one snapshot). The previous stamp, or the last
 * v* tag under --since-tag, anchors the change window: everything committed in both
 * repos (~/.claude + ~/.config/LIFEOS/USER) since then, aggregated into touched areas.
 *
 * Usage:
 *   bun IntegrityCheck.ts                    # human report, all checks, stamps
 *   bun IntegrityCheck.ts --json             # structured JSON
 *   bun IntegrityCheck.ts --no-stamp --json  # same checks, writes nothing
 *   bun IntegrityCheck.ts --section <name>   # one check, writes nothing
 *   bun IntegrityCheck.ts --help             # flags + the generated check list
 *
 * Exit codes:
 *   0 — no blocking findings (non-blocking info stays within each check's INFO_BUDGET;
 *       info past its budget becomes one blocking finding)
 *   1 — ≥1 blocking finding (a layer-one guard-count drop included, until --accept-drop)
 *   2 — scan error, usage error, a stamping run whose core paths moved mid-run, or a
 *       stamping run whose stamp files could not be written (`stamped` reports what landed)
 */

import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, writeFileSync, appendFileSync, lstatSync, readlinkSync, realpathSync, cpSync, mkdtempSync, rmSync, type Dirent } from 'fs';
import { tmpdir } from 'os';
import { assessHooksAlive } from "./HooksAlive";
import { join, dirname, relative, resolve } from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { findRuleDuplicates } from './lib/rule-duplication';
import { ASCENT, type AscentState } from './ascent';
import { homedir } from "node:os";
// Inventory.ts, sources/validate.ts and ASSAY/Assay.ts are imported inside the one check each serves:
// together they were most of this tool's start-up, paid again by every --section run and every spawned test.
import { checkWorkflowDir, trackedWorkflowFiles } from "./WorkflowNames.ts";
import { getClaudeDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { hasRegexEndAnchor } from "./lib/RegexEndAnchor"; // class of public issue #2063, @markb0
import { findLeftoverTokens } from "./lib/DocLeftoverTokens";
import { checkTrustRootsCommitted as detectTrustRootDrift } from "./lib/TrustRootsCommitted";
import { scanIssueRepoProvenance, ISSUE_WRITE_RE } from "./lib/IssueRepoProvenance";
import { hasRealFetchCall } from "./lib/FetchCall";
import { loadVigilEmit } from "./lib/VigilOptional";
import { hasConfigRootLiteral, isZeroToleranceScope as isConfigRootZeroTolerance, compareToBaseline as compareConfigRootBaseline, parseBaseline as parseConfigRootBaseline, baselineRaises as configRootBaselineRaises, RESOLVER_FILES as CONFIG_ROOT_RESOLVER_FILES, type ConfigRootBaseline } from "./lib/ConfigRootLiteral"; // class of public issue #1974, @sabo961
import { isContained } from "../../hooks/lib/containment-zones";
import { findStatuslineEvalHazards } from "./lib/StatuslineEvalSafety"; // GHSA-r4v7-4f75-h7ch, @krish-221
import { findSchedulerParentFindings } from './lib/SchedulerParentGate';
import { scanIntentContractDrift } from './lib/IntentContractDrift';
import { lintPaths } from './IntentLint';
import { auditOverrides } from './lib/SendGate.ts';
import { invariant } from './Invariant';
import { shellSteps, programName } from '../../hooks/lib/shell-commands';
import { loadSkillDescriptions, namespaceTotals, contestedPhrases, pairwiseOverlap, hollowSkills, observableSkills, neverInvoked } from './SkillOverlap';

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
const CLAUDE_DIR = getClaudeDir();
const LIFEOS_DIR = join(CLAUDE_DIR, 'LIFEOS');
const TOOLS_DIR = join(LIFEOS_DIR, 'TOOLS');
const DOC_DIR = join(LIFEOS_DIR, 'DOCUMENTATION');
const STATE_DIR = join(LIFEOS_DIR, 'MEMORY', 'STATE', 'integrity');
const USER_REPO = join(HOME, '.config', 'LIFEOS', 'USER');

// ── Arg parsing (manual, zero deps — llcli style) ──
// --help is printed in the main block from RUN_TABLE, so the check list is generated.
const args = process.argv.slice(2);
const helpRequested = args.includes('--help') || args.includes('-h');
const jsonOutput = args.includes('--json');
const quiet = args.includes('--quiet');
const deep = args.includes('--deep');
const verbose = args.includes('--verbose');
// --no-stamp: run every check and write NOTHING — no last-run, no last-pass, no runs.jsonl row,
// no layer-one snapshot (ISC-30). The fail-fast and ratchet re-check runs use it.
const noStamp = args.includes('--no-stamp');
// --serial runs every check in this process, one after another (the parity reference for the concurrent runner).
// --run-entry <i> is the concurrent runner's worker: run RUN_TABLE[i] alone and print its records as JSON.
const serial = args.includes('--serial');
const runEntryIdx = args.indexOf('--run-entry');
const runEntry = runEntryIdx > -1 ? Number(args[runEntryIdx + 1]) : null;
// --accept-drop: on the principal's yes, the one run allowed to LOWER layer-one-counts.json (ISC-29/60).
const acceptDrop = args.includes('--accept-drop');
// --since-tag: anchor the change window on the last v* tag instead of the last run stamp (ISC-33).
const sinceTag = args.includes('--since-tag');
const sectionIdx = args.indexOf('--section');
const section = sectionIdx > -1 ? (args[sectionIdx + 1] ?? '') : null;
const runIdIdx = args.indexOf('--run-id');
// --run-id <id>: tags last-run, last-pass and the runs.jsonl row, so an RC can prove its own stamp (ISC-32).
const runId = runIdIdx > -1 ? (args[runIdIdx + 1] ?? '') : null;
/** Usage errors found in the flags; the main block prints them and exits 2 before any check runs. */
const usageErrors: string[] = [];
if (runId !== null && !/^[A-Za-z0-9][\w.:-]{0,127}$/.test(runId)) usageErrors.push('--run-id needs an id ([A-Za-z0-9][\\w.:-]{0,127})');
if (section === '') usageErrors.push('--section needs a check name (see --help)');
if (acceptDrop && noStamp) usageErrors.push('--accept-drop rewrites the layer-one snapshot; it cannot run with --no-stamp');
if (acceptDrop && section !== null && section !== 'layer-one-monotone') usageErrors.push('--accept-drop runs only on a full run or --section layer-one-monotone');
// The kebab name of a check function: checkTsVocab → ts-vocab, checkAssertCoverage → assert-coverage.
const kebabOf = (fn: Function) => fn.name.replace(/^check/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

// ── Result model ──
interface Finding {
  detail: string;
  blocking: boolean;
}
interface CheckResult {
  name: string;
  ok: boolean;            // true when no blocking findings
  blockingCount: number;
  infoCount: number;
  findings: Finding[];
  note?: string;          // one-line summary for the human report
}
interface DerivedArtifact {
  path: string;
  writer: string | null;
  maxAgeHours: number | null;
  note: string;
}
const checks: CheckResult[] = [];

// Scan errors are distinct from blocking findings: a scan error means a check could NOT
// run (missing dependency, unreadable source of truth) — the tool malfunctioned, not the
// system. Any scan error forces exit 2, never exit 1. This keeps the 0/1/2 contract honest:
// a real scan failure must never look like a clean-but-blocking result. (Forge audit 2026-07-06.)
export const scanErrors: string[] = [];
function scanError(msg: string): void { scanErrors.push(msg); }

/**
 * Read one input a security scan must cover. A read failure is a scan error naming the lane and
 * the file, and the caller skips the file: the scan's coverage shrank, so its verdict cannot be a
 * pass.
 */
function readScanInput(lane: string, path: string): string | null {
  try { return readFileSync(path, 'utf8'); }
  catch (e: any) {
    scanError(`${lane}: cannot read ${path.replace(HOME, '~')} (${e?.code ?? e?.message ?? e}) — coverage is incomplete`);
    return null;
  }
}

/**
 * The stdout of a delegated gate that failed, accepted only when the gate's own documented exit
 * status says so. The delegates (ProseInCode, BlockMessageGate, ReferenceCheck, SkillHygieneGate,
 * CodeDataBoundary) exit 0 clean, 1 findings, 2 scan error; a timeout (124), a signal (status null)
 * or any other status means the gate did not finish, so whatever JSON is on stdout is not a verdict
 *. Throws, so the caller's catch records a scan error.
 */
export function delegateFailureStdout(e: any): string {
  const status = e?.status;
  if (status !== 1) {
    const how = status === null || status === undefined ? `signal ${e?.signal ?? 'unknown'}` : `exit ${status}`;
    throw new Error(`gate did not finish (${how}${status === 124 ? ', timeout' : ''}): ${String(e?.stderr ?? e?.message ?? '').trim().split('\n')[0]}`);
  }
  return e.stdout?.toString() || '';
}
/** What a delegated gate's JSON must carry before /ic trusts it. */
export interface DelegateShape {
  /** Arrays the result must carry, each with a check every item must pass. */
  arrays: Record<string, (item: any) => boolean>;
  /** Fields that must be finite, non-negative numbers. */
  counts?: string[];
  /** How many reported findings make the gate exit 1; an exit 1 that reports none is not a verdict. */
  failing: (result: any) => number;
}

const isObj = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isLine = (x: unknown): boolean => Number.isInteger(x) && (x as number) >= 0;

export const DELEGATE_SHAPES = {
  proseInCode: {
    arrays: { hits: (h) => isObj(h) && isStr(h.file) && isLine(h.line) && isStr(h.kind) && isStr(h.why) },
    counts: ['scanned'],
    failing: (r) => r.hits.length,
  },
  blockMessages: {
    arrays: { findings: (f) => isObj(f) && isStr(f.file) && isLine(f.line) && Array.isArray(f.missing) && f.missing.length > 0 && f.missing.every(isStr) },
    failing: (r) => r.findings.length,
  },
  references: {
    arrays: {
      findings: (f) => isObj(f) && ['missing', 'stale', 'orphan'].includes(f.type) && isStr(f.file),
      scanErrors: () => false,   // ReferenceCheck exits 2 on any scan error; one under exit 0 or 1 is a contradiction
    },
    counts: ['scannedFiles', 'scannedRefs'],
    failing: (r) => r.findings.filter((f: any) => f.type === 'missing').length,
  },
  skillHygiene: {
    arrays: {
      skills: (s) => isObj(s) && isStr(s.skill) && isLine(s.count) && s.count > 0 && isLine(s.files),
      vendoredDeps: isStr,
    },
    counts: ['totalViolations'],
    failing: (r) => r.skills.length + r.vendoredDeps.length,
  },
  codeDataBoundary: {
    arrays: { findings: (f) => isObj(f) && isStr(f.check) && isStr(f.file) && isStr(f.detail) },
    failing: (r) => r.findings.filter((f: any) => !f.info).length,
  },
} satisfies Record<string, DelegateShape>;

/**
 * Parse and check one delegated gate's JSON against its shape. Throws with the reason on anything
 * short of a well-formed result: unparseable output, a reported error, a missing or malformed array
 * or count, or an exit 1 that names no failing finding. Pure.
 */
export function validateDelegateResult(raw: string, status: 0 | 1, shape: DelegateShape): Record<string, any> {
  let r: unknown;
  try { r = JSON.parse(raw); } catch (e: any) { throw new Error(`output is not JSON (${e?.message ?? e})`); }
  if (!isObj(r)) throw new Error('output is not a JSON object');
  if (r.error !== undefined && r.error !== null && r.error !== '') throw new Error(`gate reported an error: ${String(r.error).slice(0, 200)}`);
  for (const [key, ok] of Object.entries(shape.arrays)) {
    if (!Array.isArray(r[key])) throw new Error(`result has no "${key}" array`);
    const bad = (r[key] as unknown[]).findIndex(item => !ok(item));
    if (bad >= 0) throw new Error(`result "${key}[${bad}]" is malformed: ${JSON.stringify((r[key] as unknown[])[bad]).slice(0, 160)}`);
  }
  for (const key of shape.counts ?? []) {
    const v = r[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`result "${key}" is not a count`);
  }
  if (status === 1 && shape.failing(r) === 0) throw new Error('gate exited 1 but reported no failing finding');
  return r;
}

/**
 * Run a delegated gate: stdout and status for exit 0 or exit 1. Any other end throws the
 * delegateFailureStdout error, carrying the gate's own status and stderr for callers that report them.
 */
function runDelegate(tool: string, args: string[], maxBuffer: number): { raw: string; status: 0 | 1 } {
  try {
    return { raw: execFileSync('bun', [tool, ...args], { encoding: 'utf8', maxBuffer, stdio: ['pipe', 'pipe', 'pipe'] }), status: 0 };
  } catch (e: any) {
    try { return { raw: delegateFailureStdout(e), status: 1 }; }
    catch (why: any) { Object.assign(why, { status: e?.status, stderr: e?.stderr }); throw why; }
  }
}

/** A public install is a tarball with no git checkout at the config root; lanes that enumerate tracked files skip there (round-17 audit). */
/**
 * What one `git rev-parse --is-inside-work-tree` result proves. Only git's own
 * "not a git repository" answer establishes a tarball install; a missing git, a
 * timeout, a signal or any other failure is unknown, never "not a checkout"
 *. Pure.
 */
export function classifyCheckout(r: { status: number | null; stdout: string; stderr: string; error?: unknown }): 'checkout' | 'not-a-checkout' | 'error' {
  if (r.error) return 'error';
  if (r.status === 0 && r.stdout.trim() === 'true') return 'checkout';
  if (r.status === 128 && /not a git repository/i.test(r.stderr)) return 'not-a-checkout';
  return 'error';
}
let gitCheckoutCache: boolean | undefined;
function isGitCheckout(): boolean {
  if (gitCheckoutCache !== undefined) return gitCheckoutCache;
  const r = spawnSync('git', ['-C', CLAUDE_DIR, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  const verdict = classifyCheckout({ status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error });
  if (verdict === 'error') {
    scanError(`git checkout detection failed (status ${r.status ?? 'none'}${r.signal ? `, signal ${r.signal}` : ''}${r.error ? `, ${(r.error as Error).message}` : ''}); tracked-file lanes skipped without proof the root is not a checkout`);
  }
  gitCheckoutCache = verdict === 'checkout';
  return gitCheckoutCache;
}
const NOT_A_CHECKOUT = 'skipped: the config root is not a git checkout (tarball install); tracked-file lanes need one';

/**
 * Ceiling on non-blocking findings per check.
 *
 * "Non-blocking" was read as "never has to be fixed," and the pile reached 497 items —
 * 445 of them from one miscalibrated class — while the verdict still said CLEAN. Nobody
 * ignored the findings; the check was built so ignoring them was the only option. A budget
 * turns info into a ratchet: today's count is the ceiling, and growth past it fails.
 *
 * Raising a number here is a deliberate act with a reason. Absent = uncapped (yet).
 */
const INFO_BUDGET: Record<string, number> = {
  references: 0,
  hook_registration: 0,
  intents: 0,
  'skill-hygiene': 0,
  'permission-rule-shape': 0,
  'credential-registry': 1,
  'prose-in-code': 0,
  'regex-end-anchor': 0,
  'doc-leftover-tokens': 0,
  'trust-roots-committed': 0,
  'issue-repo-provenance': 0,
  // 1, not 0: the check now has exactly two non-blocking states — no pin at all
  // (fresh install) and a deliberate, matching [integrity] ack. They are mutually
  // exclusive, so one info slot is the whole allowance; a second finding here is
  // still a real regression (public issue #1854, @DRAZY).
  'model-rung-pin': 1,
  'model-sync': 1,        // the one non-blocking state: the /model carrier trailing a fresh registry bump — only the principal can move it

  'fetch-timeouts': 0,    // burned down to zero 2026-09-19 — a new fetch without a timeout now blocks
  'spinner-tips': 0,      // 2026-08-12: command coverage is complete — a new slash-command without a tip blocks
  'spinner-verbs': 0,     // 2026-10-10: a new favorite without verbs, or verbs left on a dropped book, blocks
  'standing-facts': 0,    // every-turn injection: a stale fact has no non-blocking state
  'assert-coverage': 1,   // one estate-summary line while the M3 retrofit burns down; tighten after
  'function-hooks': 0,    // the plugin either validates and matches its ISA or it does not
  'plugin-load': 0,       // the local plugins load from the folder marketplace or they do not
  'ts-vocab': 1,          // one estate-summary line (ISC-34, 20260908-universal-eval-reeval); per-ISA detail under --verbose
  'workflow-definitions': 0, // ISC-90: an invalid definition has no non-blocking state
  'intent-contract-drift': 1, // advisory census: one summary line (GROWING past INTENT_DRIFT_BASELINE); per-skill detail under --verbose
  'intent-lint': 0,       // blocking since 2026-10-10: every lint error is a per-file BLOCKING finding, so no info line remains (1 while it was advisory)
};

// ISC-34 (20260908-universal-eval-reeval): the off-vocabulary Test Strategy rows
// in the estate — rows whose `type` cell is not one of the parser's types, so
// they are dropped with a reason and never run. Non-blocking by design (the
// backlog predates the vocabulary), one summary line, per-ISA detail under
// --verbose, and the baseline recorded here so growth is visible.
const TS_VOCAB_BASELINE = { rows: 3346, at: '2026-09-09' };
async function checkTsVocab(): Promise<void> {
  try {
    const { censusData } = await import('./EvalCensus.ts');
    const c = await censusData();
    const off = c.off_vocabulary;
    const findings: Finding[] = [];
    const head = `${off.total} off-vocabulary Test Strategy rows across ${off.by_isa.length} ISAs (baseline ${TS_VOCAB_BASELINE.rows} @ ${TS_VOCAB_BASELINE.at}${off.total > TS_VOCAB_BASELINE.rows ? ', GROWING' : ''})`;
    if (off.total > 0) {
      const detail = verbose ? `${head}; top: ${off.by_isa.slice(0, 10).map((r) => `${r.isa.replace(HOME, '~')} ×${r.count} [${r.types.join('|')}]`).join('; ')}` : head;
      findings.push({ detail, blocking: false });
    }
    record('ts-vocab', findings, head);
  } catch (e) {
    scanError(`ts-vocab: ${String(e).slice(0, 120)}`);
  }
}

// Sonar ISA ISC-14 (F5): /ic reports the skill-namespace meter, SkillOverlap.ts: total description characters,
// contested phrases, pairwise overlap, hollow skills and never-invoked against observable. Report only, never a
// blocker (Sonar A6): it emits no findings, so nothing here can fail a run or make skills stop firing.
function checkSkillOverlap(): void {
  const skillsDir = join(CLAUDE_DIR, 'skills');
  const skills = loadSkillDescriptions(skillsDir);
  const totals = namespaceTotals(skills);
  const contested = contestedPhrases(skills);
  const pairs = pairwiseOverlap(skills);
  const hollow = hollowSkills(skillsDir, skills);
  const log = join(LIFEOS_DIR, 'MEMORY', 'SKILLS', 'execution.jsonl');
  const observable = observableSkills(skills, log).length;
  const never = neverInvoked(skills, log, 30).length;
  const topPhrase = contested[0] ? ` (top "${contested[0].phrase}" ×${contested[0].claimedBy.length})` : '';
  const topPair = pairs[0] ? ` (top ${pairs[0].a} ~ ${pairs[0].b} ${pairs[0].jaccard.toFixed(2)})` : '';
  record('skill-overlap', [], `${totals.skills} skills · ${totals.totalChars} description chars · ${contested.length} contested phrases${topPhrase} · ${pairs.length} overlapping pairs${topPair} · ${hollow.length} hollow · never-invoked ${never} of ${observable} observable`);
}

// ISC-3.2 (20260908-universal-eval-reeval): the six doctrine surfaces that carry
// the Test Strategy row contract agree on its vocabulary. A contradiction is a
// surface that lacks one of the contract's words (lane, stage, the three lanes,
// the judged types) — the way drift actually shows up is a file that never
// learned the new word, not one that argues with it.
function checkDoctrineVocab(): void {
  const findings: Finding[] = [];
  let algo = '';
  try { algo = readFileSync(join(LIFEOS_DIR, 'ALGORITHM', 'LATEST'), 'utf8').trim(); } catch { scanError('doctrine-vocab: LIFEOS/ALGORITHM/LATEST unreadable'); return; }
  const files = [
    join(LIFEOS_DIR, 'ALGORITHM', `v${algo}.md`),
    join(LIFEOS_DIR, 'DOCUMENTATION', 'ISA', 'ISAFormat.md'),
    join(LIFEOS_DIR, 'DOCUMENTATION', 'Testing', 'TestingDoctrine.md'),
    join(LIFEOS_DIR, 'DOCUMENTATION', 'Bunker', 'BunkerSystem.md'),
    join(CLAUDE_DIR, 'skills', 'Assay', 'SKILL.md'),
    join(CLAUDE_DIR, 'skills', 'ISA', 'SKILL.md'),
  ];
  const TERMS = ['stage', 'lane', 'liveness', 'integrity', 'build', 'eval', 'pairwise', 'manual'];
  const STALE = [
    { re: /\bmanual\b(?:(?!\bnot\b)[^.\n]){0,40}\bfourth class\b/i, why: 'calls the manual row a fourth class (it is the first rung of the attested → judged → deterministic ladder)' },
    { re: /\beval\b[^.\n]{0,30}\bliveness lane\b(?![^.\n]*(dropped|never|refus|not))/i, why: 'puts an eval row on the liveness lane' },
  ];
  for (const f of files) {
    let t = '';
    try { t = readFileSync(f, 'utf8'); } catch { findings.push({ detail: `${f.replace(HOME, '~')}: unreadable`, blocking: true }); continue; }
    const missing = TERMS.filter((term) => !new RegExp(`\\b${term}\\b`).test(t));
    if (missing.length) findings.push({ detail: `${f.replace(HOME, '~')}: never names ${missing.join(', ')}`, blocking: true });
    for (const s of STALE) if (s.re.test(t)) findings.push({ detail: `${f.replace(HOME, '~')}: ${s.why}`, blocking: true });
  }
  record('doctrine-vocab', findings, `${files.length} doctrine surfaces · ${TERMS.length} contract terms`);
}

function record(name: string, findings: Finding[], note?: string): void {
  let blockingCount = findings.filter(f => f.blocking).length;
  const infoCount = findings.length - blockingCount;
  const budget = INFO_BUDGET[name];
  if (budget !== undefined && infoCount > budget) {
    findings.push({
      detail: `${name}: ${infoCount} non-blocking findings exceeds its budget of ${budget} — fix them or raise the budget on purpose`,
      blocking: true,
    });
    blockingCount++;
  }
  checks.push({ name, ok: blockingCount === 0, blockingCount, infoCount, findings, note });
}

// ── helpers ──
/** find exits 1 when an entry vanished between its readdir and its stat (a lock or temp file the
 *  harness rotates mid-scan, e.g. history.jsonl.lock). That entry no longer exists, so nothing was
 *  left unchecked. True only when EVERY stderr line is such a vanish strictly under root and the path
 *  is still absent now; a missing root, an unreadable directory, a path that is back, or any other
 *  error stays a scan error (fail closed). */
export function vanishedMidScan(root: string, stderr: string): boolean {
  const under = root.endsWith('/') ? root : root + '/';
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => {
    const m = /^find: (.+): No such file or directory$/.exec(l);
    return !!m && m[1].startsWith(under) && !existsSync(m[1]);
  });
}

// Enumerate files via `find` (guaranteed-available, recurses at any depth, no reimplemented
// tree walker). `extraArgs` are appended to the base `find <root>` invocation.
// install-payload copies and build/cache noise are pruned so counts reflect the LIVE system.
export function findFiles(root: string, extraArgs: string[]): string[] {
  const argv = [
      root,
      '(', '-path', '*/node_modules', '-o', '-path', '*/.git', '-o', '-path', '*/install',
      '-o', '-path', '*/LIFEOS_RELEASES', '-o', '-path', '*/Backups', '-o', '-path', '*/Archive',
      '-o', '-path', '*/dist', '-o', '-path', '*/.next',
      // Third-party plugin payloads (marketplace caches) are not the live
      // system — their internal files are vendor-owned and get overwritten
      // on plugin updates, so their broken refs are not ours to fix.
      '-o', '-path', '*/Plugins/cache', '-o', '-path', '*/Plugins/marketplaces',
      // Harness-synced payloads (claude.ai skill/plugin sync since Claude Code 2.1.274:
      // skills/synced/<org>_<user>/, Plugins/synced/) are vendor-owned and rewritten on
      // every sync — never the live system, never ours to fix. Gitignored for the same reason.
      '-o', '-path', '*/synced',
      ')', '-prune', '-o',
      ...extraArgs, '-print',
    ];
  try {
    return execFileSync('find', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
  } catch (e: any) {
    // An entry deleted between find's readdir and its stat is gone, not unscanned: return the full
    // output with no gap recorded (rc-8.620.0: history.jsonl.lock vanished mid-scan and blocked /ic).
    if (e?.status === 1 && vanishedMidScan(root, String(e?.stderr ?? ''))) return String(e?.stdout ?? '').split('\n').filter(Boolean);
    // An enumeration failure is a scan error (exit 2), never an empty scope that reads as clean
    //. find exits nonzero when ANY directory is unreadable and
    // still prints the rest, so what it found is returned and the gap is recorded.
    const how = e?.status !== undefined && e?.status !== null ? `exit ${e.status}` : `signal ${e?.signal ?? e?.code ?? 'unknown'}`;
    scanError(`file enumeration under ${root.replace(HOME, '~')} failed (${how}): ${String(e?.stderr ?? e?.message ?? '').trim().split('\n')[0].slice(0, 200)} — coverage is incomplete`);
    return String(e?.stdout ?? '').split('\n').filter(Boolean);
  }
}

// ── email branding (every LifeOS email sender renders through EmailTemplate.ts) ──
// A plain-text ping once reached the inbox with none of the house branding (the rule:
// every email uses the same format). Hooks cannot see launchd jobs, so this is the enforcement
// lane: any tracked .ts file that sends via the Gmail CLI (references gmail.ts AND
// passes --subject) must import LIFEOS/TOOLS/EmailTemplate.ts. Blocking.
function checkEmailBranding(): void {
  const findings: Finding[] = [];
  let files: string[] = [];
  if (!isGitCheckout()) { record('email-branding', [], NOT_A_CHECKOUT); return; }
  try {
    // Tracked files only — rg over the working tree drags transcripts and
    // file-history snapshots into the scan (OPERATIONAL_PREFERENCES § Miscellaneous).
    files = execFileSync('git', ['-C', CLAUDE_DIR, 'ls-files', '*.ts'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      .split('\n').filter(Boolean);
  } catch (e: any) {
    scanError(`email-branding: git ls-files failed: ${e?.message ?? e}`);
    return;
  }
  for (const rel of files) {
    if (rel.endsWith('.test.ts')) continue;
    if (rel.startsWith('hooks/')) continue;                       // guards reference send commands without sending
    if (rel === 'LIFEOS/TOOLS/gmail.ts' || rel === 'LIFEOS/TOOLS/EmailTemplate.ts') continue;
    // OpenAiAgent parses a job's gmail send flags to police recipients; it composes no email (2026-10-14).
    if (rel === 'LIFEOS/TOOLS/OpenAiAgent.ts') continue;
    // OutputReconciler parses gmail send flags out of recorded tool activity to join sends to the ledger; it composes no email (2026-10-20).
    if (rel === 'LIFEOS/TOOLS/OutputReconciler.ts') continue;
    let src: string;
    try { src = readFileSync(join(CLAUDE_DIR, rel), 'utf8'); } catch { continue; }
    const isSender = src.includes('gmail.ts') && src.includes('--subject');
    if (isSender && !src.includes('EmailTemplate')) {
      findings.push({ detail: `${rel}: sends email via the Gmail CLI without rendering through LIFEOS/TOOLS/EmailTemplate.ts — every LifeOS email uses the branded template`, blocking: true });
    }
  }
  record('email-branding', findings, `${findings.length === 0 ? 'all Gmail-CLI senders use the branded template' : `${findings.length} unbranded sender(s)`}`);
}

// ── ascent vocabulary (hand-spelled state names/glyphs in consumer surfaces) ──
// The ONE table (ascent.ts) names every run state; every consumer resolves through it.
// The class has drifted four times (private vocab → 07-27 fix; lucide icon twins →
// deleted 07-28; hand-listed lanes ×2 → table policy 07-28; the board's "Done" label +
// ClimbChart's literal "🏔️ summit" → 07-29, the principal's fourth flag). This gate makes the
// fifth recurrence a blocking /ic failure: any ascent LABEL or ICON appearing as a
// literal in a consumer file (Pulse src, hooks) fails — resolve through the table.
// Colors are deliberately OUT of scope: the state hexes double as general palette
// values (#565f89 is also the muted-text color), and a gate that cries wolf gets
// demoted to non-blocking, which is how gates die. Comment lines are stripped so
// documentation may name the states.
function checkAscentVocabulary(): void {
  const findings: Finding[] = [];
  const roots = [join(LIFEOS_DIR, 'PULSE/Observability/src'), join(CLAUDE_DIR, 'hooks')];
  // 'idle' excluded: its label collides with unrelated liveness vocabulary (agent
  // idle states) and it renders on no surface (board: hidden).
  const states = (Object.keys(ASCENT) as AscentState[]).filter((s) => s !== 'idle');
  const needles: { state: string; kind: 'label' | 'icon'; re: RegExp }[] = [];
  for (const s of states) {
    const { label, icon } = ASCENT[s];
    needles.push({ state: s, kind: 'label', re: new RegExp(`["'\`>]${label}["'\`<]`) });
    if (icon) needles.push({ state: s, kind: 'icon', re: new RegExp(icon.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
  }
  let scanned = 0;
  for (const root of roots) {
    for (const f of findFiles(root, ['-type', 'f', '(', '-name', '*.ts', '-o', '-name', '*.tsx', ')'])) {
      scanned++;
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((raw, i) => {
        const trimmed = raw.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('{/*')) return;
        const line = raw.replace(/\/\/.*$/, '').replace(/\{\/\*.*?\*\/\}/g, '');
        for (const n of needles) {
          if (n.re.test(line)) {
            findings.push({
              detail: `${f.replace(HOME, '~')}:${i + 1} — hand-spelled ascent ${n.kind} for '${n.state}' — resolve through ascent.ts (LIFECYCLE_META/ASCENT)`,
              blocking: true,
            });
          }
        }
      });
    }
  }
  // DOC LANE (Astra audit 2026-07-30: the 9→6 fold landed in code while three
  // LIVING doc contracts kept teaching the retired vocabulary — the code lane
  // above is structurally blind to prose). Needles derive from
  // LEGACY_ASCENT_ALIASES, so a future fold extends this automatically. Lines
  // that mark themselves historical are exempt; only current-truth prose fails.
  let docScanned = 0;
  try {
    const { LEGACY_ASCENT_ALIASES } = require('./ascent') as { LEGACY_ASCENT_ALIASES: Record<string, string> };
    const retired = Object.keys(LEGACY_ASCENT_ALIASES);
    if (retired.length > 0) {
      const latest = readFileSync(join(LIFEOS_DIR, 'ALGORITHM/LATEST'), 'utf8').trim();
      const livingDocs = [
        join(LIFEOS_DIR, `ALGORITHM/v${latest}.md`),
        join(LIFEOS_DIR, 'DOCUMENTATION/ISA/ISAFormat.md'),
        join(LIFEOS_DIR, 'DOCUMENTATION/Pulse/TerminalTabs.md'),
        join(LIFEOS_DIR, 'DOCUMENTATION/Algorithm/AscentStates.md'),
      ];
      // Any dated line reads as historical context (a hardcoded fold date would
      // exempt nothing for future folds — Astra audit 2026-07-30). Coverage note,
      // stated honestly: needles are Capitalized-only by design — lowercase
      // mentions are usually key references in history tables, and the
      // metaphorical "marks the summit" would false-positive case-insensitively.
      // Lowercase current-truth drift is an accepted open lane.
      const historical = /legacy|folded|retired|superseded|merged|history|was\b|before\b|20\d\d-\d\d-\d\d/i;
      const needleRes = retired.map((k) => ({
        key: k,
        re: new RegExp(`\\b${k[0]!.toUpperCase()}${k.slice(1)}\\b`),
      }));
      for (const doc of livingDocs) {
        let text = '';
        try { text = readFileSync(doc, 'utf8'); } catch { continue; }
        docScanned++;
        text.split('\n').forEach((line, i) => {
          if (historical.test(line)) return;
          for (const n of needleRes) {
            if (n.re.test(line)) {
              findings.push({
                detail: `${doc.replace(HOME, '~')}:${i + 1} — retired ascent state '${n.key}' presented as current in a living doc contract — fix the prose or mark the line historical`,
                blocking: true,
              });
            }
          }
        });
      }
    }
  } catch (e: any) {
    scanError(`ascent-vocabulary doc lane: ${e.message}`);
  }
  // RETIRED-ENUM DOC LANE (Astra audit 2026-08-07, 7.32.0 cut): NotificationSystem.md
  // hand-listed the retired 8-station uppercase enum as the live /notify contract.
  // The doc lane above only knows LEGACY_ASCENT_ALIASES keys and the phase-key lane
  // is code-only, so a DOCUMENTATION page teaching the retired enum was invisible to
  // both. Needle: any single doc line naming 3+ of the retired station names in
  // ALL-CAPS (unmistakably the enum; lowercase would false-positive ordinary prose).
  // Historical-context lines are exempt via the same regex as the doc lane.
  try {
    const RETIRED_STATIONS = ['OBSERVE', 'THINK', 'PLAN', 'BUILD', 'EXECUTE', 'VERIFY', 'LEARN', 'COMPLETE'];
    const historicalLine = /legacy|folded|retired|superseded|merged|history|was\b|before\b|20\d\d-\d\d-\d\d/i;
    for (const f of findFiles(join(LIFEOS_DIR, 'DOCUMENTATION'), ['-type', 'f', '-name', '*.md'])) {
      const text = readFileSync(f, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (historicalLine.test(line)) return;
        const hits = RETIRED_STATIONS.filter((s) => new RegExp(`\\b${s}\\b`).test(line));
        if (hits.length >= 3) {
          findings.push({
            detail: `${f.replace(HOME, '~')}:${i + 1} — hand-lists ${hits.length} retired 8-station phase names (${hits.slice(0, 3).join(', ')}…) as current — the phase vocabulary lives only in LIFEOS/TOOLS/ascent.ts; fix the prose or mark the line historical`,
            blocking: true,
          });
        }
      });
    }
  } catch (e: any) {
    scanError(`ascent-vocabulary retired-enum doc lane: ${e.message}`);
  }
  // PHASE-KEY LANE (2026-07-30, 5th recurrence). The two lanes above catch
  // hand-spelled LABELS and ICONS and are structurally blind to the third
  // vocabulary the table owns: the ISA frontmatter `phase:` KEYS. That blind
  // spot is what left `AlgorithmNudge`'s run-liveness gate holding the retired
  // 8-station enum while live ISAs wrote marking/climbing — both ISA nudge rows
  // silent for a week, unnoticed because nothing fails when a nudge doesn't fire.
  // Doctrine (v8.17.2 § Telemetry): "Never hand-list phase names anywhere."
  // A literal enumerating 3+ phase keys IS a private vocabulary; resolve through
  // PHASE_TO_ASCENT / deriveAscent instead. Exempt: any literal whose statement
  // already references the table (a filter applied to derived keys is derivation,
  // not a second spelling — e.g. isa-utils' ACTIVE_LOOKUP_PHASES).
  let phaseScanned = 0;
  try {
    const { PHASE_TO_ASCENT } = require('./ascent') as { PHASE_TO_ASCENT: Record<string, string> };
    const phaseKeys = Object.keys(PHASE_TO_ASCENT);
    const derivesFromTable = /PHASE_TO_ASCENT|deriveAscent|ASCENT_STATES|ascentMeta|phaseBracket|phaseHasWorkStarted|applyAscent/;
    const phaseRoots = [join(CLAUDE_DIR, 'hooks'), join(LIFEOS_DIR, 'TOOLS'), join(LIFEOS_DIR, 'PULSE/Observability/src')];
    for (const root of phaseRoots) {
      for (const f of findFiles(root, ['-type', 'f', '(', '-name', '*.ts', '-o', '-name', '*.tsx', ')'])) {
        if (f.endsWith('/ascent.ts') || f.endsWith('.test.ts')) continue; // the table itself, and its guards
        phaseScanned++;
        const raw = readFileSync(f, 'utf8');
        const rawLines = raw.split('\n');
        const src = raw
          .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))  // block comments → blanks, line numbers preserved
          .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
        // FOUR shapes, because the class is a private vocabulary, not one syntax:
        //   [...]      array / Set literal (4 of the first 5 instances)
        //   {...}      innermost brace block — an if-chain or a function body;
        //              how the 3rd instance (in a private hook) hid, since
        //              `if (p === "verify" || p === "execute")` has no bracket
        //   'a' | 'b'  string-union type, the natural TS spelling
        //   case 'a':  switch label cluster, which brace-matching alone misses
        //              because `{[^{}]*}` only ever sees the innermost block
        // (shapes 3 and 4 from the Forge cross-vendor audit, 2026-07-30)
        //
        // CONTEXT REQUIREMENT — the thing that keeps this from crying wolf.
        // Phase keys are ordinary English (build, plan, learn, verify, complete,
        // native, idle, think), so a raw 3-key floor blocks `/ic` on any CI step
        // list or status enum that happens to use three of them. Every real
        // instance found so far names `phase` within its statement; none of the
        // synthetic false positives do. So the window must ALSO look like it is
        // about phases. Deliberate consequence: a hand-listed set that never says
        // "phase" is a documented miss, and that beats a gate that gets demoted.
        //
        // Remaining known bounds, stated rather than papered over: a list spread
        // past 600 chars, `.split(',')` / `.concat()` construction, and a literal
        // sitting one line under an unrelated table reference (exemption abuse).
        const unionRe = /(?:['"`][a-z]+['"`]\s*\|\s*){2,}['"`][a-z]+['"`]/g;
        const candidates: Array<{ 0: string; index?: number; kind?: string }> = [
          ...src.matchAll(/\[[^\]]{0,600}\]/g),
          ...src.matchAll(/\{[^{}]{0,600}\}/g),
          ...src.matchAll(unionRe),
        ];
        // Switch clusters are built by proximity, not by one regex: `case 'x': {
        // … }` bodies sit between the labels, so a consecutive-label pattern
        // never matches, and brace-matching sees only the innermost body. Labels
        // are chained from a cluster's START (not from the previous label) and
        // `i` advances past what a cluster consumed — chaining pairwise meant a
        // realistic switch, ~500 chars of body per case, reported ZERO clusters:
        // its first window never reached 3 labels and every later label was
        // skipped as mid-cluster (Forge delta audit M-D, measured).
        const labels = [...src.matchAll(/case\s+['"`][a-z]+['"`]\s*:/g)];
        for (let i = 0; i < labels.length; i++) {
          const start = labels[i].index ?? 0;
          let end = start + labels[i][0].length;
          let last = i;
          for (let j = i + 1; j < labels.length && (labels[j].index ?? 0) - (labels[j - 1].index ?? 0) <= 600; j++) {
            end = (labels[j].index ?? 0) + labels[j][0].length;
            last = j;
          }
          if (last - i + 1 >= 3) candidates.push({ 0: src.slice(start, end), index: start, kind: 'switch' });
          i = last; // consume the cluster — one switch reports once
        }
        const reported = new Set<string>();
        for (const m of candidates) {
          const hits = phaseKeys.filter((k) => new RegExp(`['"\`]${k}['"\`]`).test(m[0]));
          if (hits.length < 3) continue;
          const before = src.slice(0, m.index ?? 0);
          const line = before.split('\n').length;
          // Window = the ENCLOSING STATEMENT (back to the previous `;`/`{`/`}`)
          // plus the candidate itself. Two raw lines was too loose in both
          // directions: it let any `phase` parameter within two lines qualify an
          // unrelated literal, and it reported WorkSweep's array one line off
          // (Forge delta audit M-C). A switch also carries its `switch (…)`
          // header, which sits before the brace the statement scan stops at.
          const stmtStart = Math.max(
            before.lastIndexOf(';'), before.lastIndexOf('{'), before.lastIndexOf('}'),
          ) + 1;
          let window = src.slice(stmtStart, (m.index ?? 0) + m[0].length);
          if ((m as { kind?: string }).kind === 'switch') {
            const head = before.lastIndexOf('switch');
            if (head >= 0 && (m.index ?? 0) - head <= 600) window += src.slice(head, before.length);
          }
          if (derivesFromTable.test(window)) continue;
          if (!/phase/i.test(window)) continue;
          // One defect, one finding: the brace shape and the case-label cluster
          // both match a one-line-body switch, which produced two identical
          // blocking findings on the same line (Forge delta audit M-D).
          // ESCAPE HATCH. Some literals are genuinely indistinguishable from a
          // phase list by any text heuristic — `const deployPhase = ['build',
          // 'verify','complete']` is three phase words in a phase-named const,
          // and the two real instances were `ACTIVE_PHASES` / `COMPLETION_PHASES`,
          // so no identifier rule separates them. Rather than a cleverer proxy
          // that will be wrong in a new way, the human says so once: put
          // `ascent-gate:allow` in a comment on the line or the line above.
          // Checked against the RAW text, since the scan blanks comments.
          const pragma = /ascent-gate:allow/;
          if (pragma.test(rawLines[line - 1] ?? '') || pragma.test(rawLines[line - 2] ?? '')) continue;
          const key = `${line}:${hits.join(',')}`;
          if (reported.has(key)) continue;
          reported.add(key);
          findings.push({
            detail: `${f.replace(HOME, '~')}:${line} — hand-listed phase vocabulary [${hits.slice(0, 4).join(', ')}…] — resolve through ascent.ts (PHASE_TO_ASCENT / deriveAscent)`,
            blocking: true,
          });
        }
      }
    }
  } catch (e: any) {
    scanError(`ascent-vocabulary phase lane: ${e.message}`);
  }
  record('ascent-vocabulary', findings, `${scanned} consumer files + ${docScanned} living docs + ${phaseScanned} phase-key files scanned against ${states.length} table states`);
}

// ── prose-in-code (delegate to ProseInCode.ts) ──
// BLE exempts `.ts`, so doctrine that drifts into a source comment is invisible to every
// other check here. Budget 0: the class is at zero and stays there.
function checkProseInCode(): void {
  const findings: Finding[] = [];
  let note = '';
  try {
    const { raw, status } = runDelegate(join(TOOLS_DIR, 'ProseInCode.ts'), ['--json'], 32 * 1024 * 1024);   // exit 1 when hits exist
    const r = validateDelegateResult(raw, status, DELEGATE_SHAPES.proseInCode);
    note = `${r.scanned} source files scanned, ${r.hits.length} doctrine-prose hits`;
    for (const h of r.hits) {
      findings.push({ detail: `${h.kind}: ${h.file}:${h.line} — ${h.why}`, blocking: false });
    }
  } catch (e: any) {
    scanError(`prose-in-code: ProseInCode delegation failed — ${e.message}`);
    note = 'SCAN ERROR (delegation failed)';
  }
  record('prose-in-code', findings, note);
}

// ── no Python in LifeOS (OPERATIONAL_PREFERENCES § Miscellaneous) ──
// An ask rule on .py edits covers files I author (settings permissions.ask). This
// catches the other doors — a clone, a curl, a cp — so the invariant holds however
// the file arrived. Exempt: third-party plugins, and the two adapters into hosts
// that load Python and only Python (kitty embeds CPython for its tab bar and
// watchers; Hermes loads plugins as Python modules). Blocking: the rule had prose
// and nothing behind it for months, and the tree kept re-growing python.
// ── hooks-alive (the always-on layer is actually firing in main sessions) ──
// Every hook fails open, so a bug that silences the per-prompt hooks produces no
// error anywhere; the fork-subagent misclassification (#1911) ran twenty days on
// the public build that way. MemoryTurnStart leaves a state file per injected
// main session; recent main sessions with ZERO of them is the only shape that
// blocks. Partial coverage is normal (headless sessions never inject).
function checkHooksAlive(): void {
  const r = assessHooksAlive({
    projectsDir: join(CLAUDE_DIR, "projects"),
    injectDir: join(CLAUDE_DIR, "LIFEOS", "MEMORY", "STATE", "memory-inject"),
  });
  const findings: Finding[] = [];
  if (r.verdict === "dead" || r.verdict === "indeterminate") findings.push({ detail: r.detail, blocking: true });
  record("hooks-alive", findings, r.detail);
}

// ── hook-latency (per-event dispatcher wall time vs its registered timeout) ──
// Until 2026-09-03 the only signal of a slow hook was the harness discarding its
// output. The dispatchers (PostToolObserver, TurnStart) now log per-module timing
// to hook-timing.jsonl (hooks/lib/hook-timing.ts). This grades the last 24 h:
// p95 total_ms per event at or above HALF the event's registered timeout is a
// finding, and any module whose own p95 passes 500 ms is named. Warning, never
// blocking — a loaded machine is not a broken install. Reads the log inline:
// LIFEOS/TOOLS must not import the hooks tree (Paths.ts install-order rule).
const HOOK_LATENCY_PATH = join(CLAUDE_DIR, "LIFEOS", "MEMORY", "OBSERVABILITY", "hook-timing.jsonl");
const HOOK_LATENCY_MODULE_P95_MS = 500;
function checkHookLatency(): void {
  const findings: Finding[] = [];
  if (!existsSync(HOOK_LATENCY_PATH)) { record("hook-latency", [], "no hook-timing.jsonl yet (dispatchers log on first slow or sampled turn)"); return; }
  let settings: any = {};
  try { settings = JSON.parse(readFileSync(join(CLAUDE_DIR, "settings.json"), "utf8")); } catch { /* timeouts unknown → default below */ }
  const timeoutFor = (event: string): number => {
    for (const g of settings?.hooks?.[event] ?? []) for (const h of g?.hooks ?? []) {
      if (!h?.async && /PostToolObserver|TurnStart/.test(h?.command ?? "")) return Number(h.timeout ?? 600) * 1000;
    }
    return 600_000;
  };
  const p95 = (v: number[]): number => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(0.95 * s.length) - 1))]!; };
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const byEvent = new Map<string, number[]>();
  const byModule = new Map<string, number[]>();
  let rows = 0;
  let lines: string[] = [];
  try { lines = readFileSync(HOOK_LATENCY_PATH, "utf8").split("\n"); } catch (e: any) { scanError(`hook-latency: log unreadable: ${e?.message ?? e}`); record("hook-latency", [], "SCAN ERROR"); return; }
  for (const line of lines) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (!(Date.parse(r.ts) >= cutoff)) continue;
      rows++;
      if (!byEvent.has(r.event)) byEvent.set(r.event, []);
      byEvent.get(r.event)!.push(Number(r.total_ms) || 0);
      for (const [m, ms] of Object.entries(r.modules ?? {})) {
        const k = `${r.event}/${m}`;
        if (!byModule.has(k)) byModule.set(k, []);
        byModule.get(k)!.push(Number(ms) || 0);
      }
    } catch { /* skip malformed */ }
  }
  const summary: string[] = [];
  for (const [event, v] of byEvent) {
    const p = p95(v); const t = timeoutFor(event);
    summary.push(`${event} p95 ${p}ms/${t / 1000}s (n=${v.length})`);
    if (p >= t / 2) findings.push({ detail: `${event}: dispatcher p95 ${p} ms is at/over half its ${t / 1000}s timeout over the last 24h (n=${v.length}) — the harness will start discarding output under load`, blocking: false });
  }
  for (const [k, v] of byModule) {
    const p = p95(v);
    if (p >= HOOK_LATENCY_MODULE_P95_MS) findings.push({ detail: `${k}: module p95 ${p} ms over the last 24h (n=${v.length}) — the slowest thing on every turn`, blocking: false });
  }
  record("hook-latency", findings, rows ? summary.join("; ") : "no rows in the last 24h");
}

function checkNoPython(): void {
  const findings: Finding[] = [];
  const EXEMPT = [
    /\/Plugins\//,
    /\/synced\//,                 // harness-synced skills (claude.ai sync), vendor-owned
    /\/LIFEOS\/HERMES\/plugin\//,
    /\/LIFEOS\/DOCUMENTATION\/Terminal\/kitty\//,
    /\/LIFEOS\/MEMORY\//,
  ];
  const files = findFiles(CLAUDE_DIR, ["-name", "*.py", "-type", "f"])
    .filter((p) => !EXEMPT.some((rx) => rx.test(p)));
  for (const p of files) {
    findings.push({ detail: `Python file in the LifeOS tree: ${p.replace(CLAUDE_DIR, "~/.claude")} — rewrite as .ts`, blocking: true });
  }
  record("no-python", findings, `${files.length} non-exempt Python file(s)`);
}

/** Scheduler unit writes must create their parent in the same function/case branch. */
function checkSchedulerParentWrites(): void {
  if (!isGitCheckout()) { record('scheduler-parent-writes', [], NOT_A_CHECKOUT); return; }
  try {
    const files = findFiles(LIFEOS_DIR, ['-type', 'f', '(', '-name', '*.ts', '-o', '-name', '*.sh', ')', '!', '-name', '*.test.ts']);
    const findings = findSchedulerParentFindings(files.map((path) => ({ path, text: readFileSync(path, 'utf8') })))
      .map((f) => ({ detail: `${f.path.replace(HOME, '~')}:${f.line}: ${f.detail}`, blocking: true }));
    record('scheduler-parent-writes', findings, `${files.length} TypeScript/shell scheduler surfaces scoped`);
  } catch (e) { scanError(`scheduler-parent-writes: ${String(e).slice(0, 120)}`); }
}

/** Surface-fed derived files must retain a real producer, and bounded caches must remain fresh. */
function checkDerivedFreshness(): void {
  if (!isGitCheckout()) { record('derived-freshness', [], NOT_A_CHECKOUT); return; }
  const findings: Finding[] = [];
  try {
    const root = process.env.DERIVED_FRESHNESS_ROOT ?? CLAUDE_DIR;
    const lifeos = join(root, 'LIFEOS');
    const manifestPath = process.env.DERIVED_FRESHNESS_MANIFEST ?? join(lifeos, 'TOOLS', 'derived-artifacts.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DerivedArtifact[];
    const byPath = new Map(manifest.map((entry) => [entry.path, entry]));
    const surfaceFiles = [join(lifeos, 'LIFEOS_StatusLine.sh')];
    for (const dir of [join(root, 'hooks'), join(lifeos, 'PULSE', 'modules')]) {
      if (existsSync(dir)) surfaceFiles.push(...findFiles(dir, ['-type', 'f']));
    }
    const ephemeral = /(?:^|\/)(?:response-[^/]*\.json|jev-turn\/|router-pick\/|memory-review\/|agent-jobs\/|guard-layer-two\/)|(?:^|\/)[a-fA-F0-9]{32,}(?:\/|$)/; // jev-turn/ is the on-disk scratch dir glance-signals.ts still writes (name kept; Jev retired 2026-10-10)
    const references = new Set<string>();
    const referenceRe = /MEMORY\/STATE\/[A-Za-z0-9._-]+/g;
    for (const file of surfaceFiles.filter((p) => existsSync(p) && !p.endsWith('.test.ts') && !p.endsWith('.md'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(referenceRe)) {
        const artifact = match[0];
        if (artifact.endsWith('.') || ephemeral.test(artifact)) continue;
        const diskPath = join(lifeos, artifact);
        if (existsSync(diskPath) && statSync(diskPath).isDirectory()) continue;
        references.add(artifact);
      }
    }
    for (const artifact of [...references].sort()) {
      if (!byPath.has(artifact)) findings.push({ detail: `${artifact}: surface read absent from derived-artifacts.json`, blocking: true });
    }
    const writeCall = /\b(?:writeFileSync|appendFileSync|Bun\.write|createWriteStream)\b/;
    for (const entry of manifest) {
      const writerPath = entry.writer ? join(root, entry.writer) : '';
      let hasWriter = false;
      if (entry.writer && existsSync(writerPath) && statSync(writerPath).isFile()) {
        const source = readFileSync(writerPath, 'utf8');
        const shellRedirect = source.split('\n').some((line) => line.includes(entry.path) && /(?:^|\s)(?:>>|>)(?:\s|$)/.test(line));
        const basename = entry.path.slice(entry.path.lastIndexOf('/') + 1);
        const referencesPath = source.includes(entry.path)
          || (source.includes(basename) && source.includes('MEMORY') && source.includes('STATE'));
        hasWriter = referencesPath && (writeCall.test(source) || shellRedirect);
      }
      if (!hasWriter) findings.push({ detail: `${entry.path}: no writer in the tree`, blocking: true });
      if (entry.maxAgeHours !== null) {
        const artifactPath = join(lifeos, entry.path);
        if (existsSync(artifactPath) && statSync(artifactPath).isFile()) {
          const ageHours = (Date.now() - statSync(artifactPath).mtimeMs) / 3_600_000;
          if (ageHours > entry.maxAgeHours) findings.push({ detail: `${entry.path}: age ${ageHours.toFixed(1)}h exceeds declared max ${entry.maxAgeHours}h`, blocking: true });
        }
      }
    }
    record('derived-freshness', findings, `${references.size} surface-read artifact(s), ${manifest.length} manifest entry/entries`);
  } catch (e) { scanError(`derived-freshness: ${String(e).slice(0, 120)}`); }
}

// ── config-root literal (every tool, hook and skill resolves the root through Paths.ts) ──
// `join(homedir(), ".claude")` and its spellings hardcode the HOME profile, so an
// install placed via CLAUDE_CONFIG_DIR / LIFEOS_SKILLS_DIR had 200 files still
// reading and writing ~/.claude (public issue #1974, @sabo961 — the reported file was
// fixed on 08-19, the class reproduced). The 2026-09-03 sweep replaced every call
// site in LIFEOS/TOOLS + hooks; the 2026-09-27 pre-release audit found the class alive
// in the subsystems and skills (and against the USER data root, SchedulerWatch.ts),
// so the scan now covers every tracked .ts under LIFEOS/, skills/ and hooks/.
// LIFEOS/TOOLS + hooks stay zero-tolerance. Everywhere else is held to the checked-in
// per-file baseline (LIFEOS/TOOLS/config-root-literal.baseline.json), which may only
// shrink: a file over its ceiling blocks, and a ceiling raised against HEAD blocks.
// Detector and baseline logic: lib/ConfigRootLiteral.ts. Tracked files only.
// Exempt by name, with the reason. The resolvers define the literal; the guards are
// deny/allow boundaries on the HOME profile — swapping their literal for the resolved
// root would move the boundary with CLAUDE_CONFIG_DIR (a widening on the allow side,
// a narrowing on the deny side), so they keep the literal deliberately.
const CONFIG_ROOT_LITERAL_EXEMPT = new Set<string>([
  ...CONFIG_ROOT_RESOLVER_FILES,              // Paths.ts, LifeosConfig.ts and the paths libs
  'hooks/lib/system-file-guard-core.ts',      // same boundary, shared core + DENY_LIST path
  'hooks/lib/texting-guard-core.ts',          // LOCKED_CLIS exact-path allow-list (allow side); hermetic module — node builtins only, so it cannot import the resolver (3.1.0)
]);
const CONFIG_ROOT_BASELINE_REL = 'LIFEOS/TOOLS/config-root-literal.baseline.json';
// A path the release excludes (containment zone) is budgeted in the private aggregate,
// never by name: the baseline file ships, and a per-file key would name private code
// in the public payload (the 8.3.0 cut: G18 caught a Vigil adapter key).
const isConfigRootPrivate = (rel: string): boolean => isContained(join(CLAUDE_DIR, rel), CLAUDE_DIR);
function checkConfigRootLiteral(): void {
  const findings: Finding[] = [];
  let tracked: string[] = [];
  if (!isGitCheckout()) { record('config-root-literal', [], NOT_A_CHECKOUT); return; }
  try {
    tracked = execFileSync('git', ['-C', CLAUDE_DIR, 'ls-files', 'LIFEOS', 'skills', 'hooks'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n').filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !CONFIG_ROOT_LITERAL_EXEMPT.has(f));
  } catch (e: any) {
    scanError(`config-root-literal: git ls-files failed — ${e.message}`);
    return;
  }
  let baseline: ConfigRootBaseline;
  try {
    baseline = parseConfigRootBaseline(JSON.parse(readFileSync(join(CLAUDE_DIR, CONFIG_ROOT_BASELINE_REL), 'utf8')), isConfigRootPrivate);
  } catch (e: any) {
    scanError(`config-root-literal: baseline ${CONFIG_ROOT_BASELINE_REL} unreadable — ${String(e.message ?? e).slice(0, 160)}`);
    return;
  }
  // The baseline itself only shrinks: any ceiling above the committed one blocks.
  try {
    const headRaw = execFileSync('git', ['-C', CLAUDE_DIR, 'show', `HEAD:${CONFIG_ROOT_BASELINE_REL}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const r of configRootBaselineRaises(parseConfigRootBaseline(JSON.parse(headRaw)), baseline, isConfigRootPrivate)) {
      findings.push({ detail: `${CONFIG_ROOT_BASELINE_REL}: ceiling for ${r.scope} raised from ${r.from} to ${r.to} — the baseline may only shrink; fix the literal instead`, blocking: true });
    }
  } catch { /* no committed baseline yet (first commit of it): nothing to compare */ }
  let scanned = 0;
  const counts: Record<string, number> = {};
  for (const rel of tracked) {
    const abs = join(CLAUDE_DIR, rel);
    if (!existsSync(abs)) continue;
    scanned++;
    const zeroTolerance = isConfigRootZeroTolerance(rel);
    const lines = readFileSync(abs, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!hasConfigRootLiteral(line)) return;
      if (zeroTolerance) {
        findings.push({ detail: `${rel}:${i + 1} resolves the config root from a literal — use getClaudeDir()/getLifeosDir()/lifeosPath() from Paths.ts: ${line.trim().slice(0, 120)}`, blocking: true });
      } else {
        counts[rel] = (counts[rel] ?? 0) + 1;
      }
    });
  }
  const v = compareConfigRootBaseline(counts, baseline, isConfigRootPrivate);
  for (const o of v.over) {
    findings.push({ detail: `${o.scope}: ${o.count} config-root literal(s) over its baseline of ${o.ceiling} — new literals block; use getClaudeDir()/getLifeosDir()/lifeosPath()`, blocking: true });
  }
  const shrink = v.shrinkable.length ? `; ${v.shrinkable.length} ceiling(s) can be lowered${verbose ? `: ${v.shrinkable.map((x) => `${x.scope} ${x.ceiling}→${x.count}`).join(', ')}` : ''}` : '';
  // public issue #1974, @sabo961
  record('config-root-literal', findings, `${scanned} tracked .ts files under LIFEOS, skills + hooks; TOOLS+hooks zero-tolerance; baselined ${v.total}/${v.ceiling}${shrink}`);
}

// ── Check: issue-repo-provenance (issue writes go only to a verified-private repo) ──
// Issue bodies and comments carry private material. A tracked LIFEOS/ or hooks/ file
// that writes issues must take its repo from loadWorkConfig() (work repo, verified
// private by gh) or verifyPrivateRepo() (lib/PrivateRepo.ts), and never hand a
// literal owner/name to --repo. Class found by the 2026-09-27 pre-release audit:
// `achilles close` read work_repo.json raw; Cortex Distill filed with no visibility
// check. Detector: lib/IssueRepoProvenance.ts. Blocking. Allowlist by path, with
// the reason — a public-repo tool (community triage) or a file that only names the
// commands without running them.
const ISSUE_PROVENANCE_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  ['hooks/lib/texting-guard-core.ts', 'names the issue commands inside a user-facing hold message; hermetic guard module that runs no gh write'],
]);
function checkIssueRepoProvenance(): void {
  const findings: Finding[] = [];
  if (!isGitCheckout()) { record('issue-repo-provenance', [], NOT_A_CHECKOUT); return; }
  let tracked: string[] = [];
  try {
    tracked = execFileSync('git', ['-C', CLAUDE_DIR, 'ls-files', 'LIFEOS', 'hooks'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n').filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts'));
  } catch (e: any) {
    scanError(`issue-repo-provenance: git ls-files failed — ${e.message}`);
    return;
  }
  for (const rel of ISSUE_PROVENANCE_ALLOWLIST.keys()) {
    if (!tracked.includes(rel)) findings.push({ detail: `allowlist entry ${rel} is not a tracked file — drop it`, blocking: true });
  }
  let scanned = 0;
  let writers = 0;
  for (const rel of tracked) {
    const abs = join(CLAUDE_DIR, rel);
    if (!existsSync(abs)) continue;
    scanned++;
    const text = readFileSync(abs, 'utf8');
    for (const hit of scanIssueRepoProvenance(rel, text, ISSUE_PROVENANCE_ALLOWLIST)) {
      const why = hit.rule === 'literal-repo' ? 'hands a literal owner/name to --repo'
        : hit.rule === 'raw-work-repo-read' ? 'reads work_repo.json itself instead of calling loadWorkConfig() (the privacy-verifying loader)'
        : 'writes an issue but the file never calls loadWorkConfig() or verifyPrivateRepo()';
      findings.push({ detail: `${rel}:${hit.line} ${why} — issue writes go only to a verified-private repo: ${hit.text}`, blocking: true });
    }
    if (ISSUE_WRITE_RE.test(text)) writers++;
  }
  record('issue-repo-provenance', findings, `${scanned} tracked files under LIFEOS + hooks, ${writers} issue writer(s), ${ISSUE_PROVENANCE_ALLOWLIST.size} allowlisted`);
}

// ── Check: trust-roots-committed (trusted roots change only by commit) ──
// LIFEOS_TRUSTED_ROOTS decides what the auto-approver allows unprompted, and
// LIFEOS_PROJECT_ROOTS where new .py is refused. Both live in the settings env,
// which the DA can write. The value in force (settings.json, settings.local.json)
// and the working-tree overlay must equal HEAD of the USER repo's
// CONFIG/settings.user.json, so widening trust needs a visible commit.
// Detector: lib/TrustRootsCommitted.ts. Blocking; skips when USER is not a checkout.
function checkTrustRootsCommitted(): void {
  const r = detectTrustRootDrift(join(LIFEOS_DIR, 'USER'), [
    { label: 'settings.json', path: join(CLAUDE_DIR, 'settings.json') },
    { label: 'settings.local.json', path: join(CLAUDE_DIR, 'settings.local.json'), overrideOnly: true },
  ]);
  if (r.kind === 'skip') { record('trust-roots-committed', [], r.reason); return; }
  const shown = (v: string | undefined) => (v === undefined ? '(unset)' : JSON.stringify(v.split(HOME).join('~')));
  const findings: Finding[] = [
    ...r.errors.map((e) => ({ detail: `trust-roots-committed: ${e.replace(HOME, '~')}`, blocking: true })),
    ...r.drift.map((d) => ({
      detail: `${d.source}: ${d.key} = ${shown(d.value)} but HEAD:CONFIG/settings.user.json has ${shown(d.committed)} — commit the change in the USER repo (then MergeSettings), or revert it`,
      blocking: true,
    })),
  ];
  record('trust-roots-committed', findings, `${r.sources.length} source(s) vs HEAD · ${r.drift.length} drift`);
}

// ── Check: regex-end-anchor (no Python end anchor in a JS/TS regex) ──
// JavaScript reads backslash-Z as a literal "Z", so a lookahead ending in it cuts
// the final section at its first capital Z (or drops it). It shipped three times:
// WorkSweep goals (public issue #2063, @markb0; fixed via #1919), InterviewScan
// sections, and the poller job parser. Detector: lib/RegexEndAnchor.ts. Code
// lines only; comments and tests are skipped. Blocking.
function checkRegexEndAnchor(): void {
  const findings: Finding[] = [];
  if (!isGitCheckout()) { record('regex-end-anchor', [], NOT_A_CHECKOUT); return; }
  let tracked: string[] = [];
  try {
    tracked = execFileSync('git', ['-C', CLAUDE_DIR, 'ls-files', 'LIFEOS/TOOLS', 'LIFEOS/PULSE', 'hooks', 'skills'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n').filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'));
  } catch (e: any) {
    scanError(`regex-end-anchor: git ls-files failed — ${e.message}`);
    return;
  }
  let scanned = 0;
  for (const rel of tracked) {
    const abs = join(CLAUDE_DIR, rel);
    if (!existsSync(abs)) continue;
    scanned++;
    readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
      if (hasRegexEndAnchor(line)) {
        findings.push({ detail: `${rel}:${i + 1} uses the Python end anchor (a literal Z in JS) — use $ (no /m) or (?![\\s\\S]): ${line.trim().slice(0, 120)}`, blocking: true });
      }
    });
  }
  record('regex-end-anchor', findings, `${scanned} tracked .ts/.tsx files, ${findings.length} site(s)`);
}

// ── Check: doc-leftover-tokens (no string-replace debris in doc prose) ──
// 2026-10-02: a bulk doc edit passed a replacer example through
// String.prototype.replace as the replacement text and left the literal
// "() => b" in eleven doc spots. Scans tracked
// LIFEOS/DOCUMENTATION and skills markdown outside code fences (detector:
// lib/DocLeftoverTokens.ts). skills/_BLOGGING/Patterns is vendored pattern
// prompts, not ours, and is skipped. Blocking.
function checkDocLeftoverTokens(): void {
  const findings: Finding[] = [];
  if (!isGitCheckout()) { record('doc-leftover-tokens', [], NOT_A_CHECKOUT); return; }
  let tracked: string[] = [];
  try {
    tracked = execFileSync('git', ['-C', CLAUDE_DIR, 'ls-files', 'LIFEOS/DOCUMENTATION', 'skills'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n').filter((f) => f.endsWith('.md') && !f.startsWith('skills/_BLOGGING/Patterns/'));
  } catch (e: any) {
    scanError(`doc-leftover-tokens: git ls-files failed — ${e.message}`);
    return;
  }
  let scanned = 0;
  for (const rel of tracked) {
    const abs = join(CLAUDE_DIR, rel);
    if (!existsSync(abs)) continue;
    scanned++;
    for (const h of findLeftoverTokens(readFileSync(abs, 'utf8'))) {
      findings.push({ detail: `${rel}:${h.line} carries leftover replace debris ${JSON.stringify(h.token)} outside a code fence: ${h.text}`, blocking: true });
    }
  }
  record('doc-leftover-tokens', findings, `${scanned} tracked doc/skill .md files, ${findings.length} site(s)`);
}


// ── Check: statusline-eval-safety (no cache or API text runs as shell in the statusline) ──
// GHSA-r4v7-4f75-h7ch, @krish-221: the statusline wrote weather/tide caches into a
// sourced file inside '…' quotes and eval'd raw jq interpolations of API responses,
// so a crafted cache or response ran as shell every render. Every eval'd jq
// interpolation must pass `| numbers` or `@sh`; a sourced-file write must use
// printf %q. Detector: lib/StatuslineEvalSafety.ts. Blocking.
function checkStatuslineEvalSafety(): void {
  const rel = 'LIFEOS/LIFEOS_StatusLine.sh';
  const abs = join(CLAUDE_DIR, rel);
  if (!existsSync(abs)) { record('statusline-eval-safety', [], `${rel} not present`); return; }
  let src: string;
  try { src = readFileSync(abs, 'utf8'); } catch (e: any) {
    scanError(`statusline-eval-safety: cannot read ${rel} — ${e.message}`);
    return;
  }
  const findings: Finding[] = findStatuslineEvalHazards(src)
    .map((h) => ({ detail: `${rel}:${h.line} ${h.detail}`, blocking: true }));
  record('statusline-eval-safety', findings, `${rel}: ${findings.length} injection site(s)`);
}

// ── Check: symlink-loops (no directory symlink under the install resolves into its own ancestor) ──
// 2026-09-10: a stray \`MEMORY/MEMORY -> MEMORY\` self-loop in the USER data repo (an \`ln -sf\`
// without -n onto an existing dir symlink) made every \`bun test\` in the tree die with EMFILE
// after ~7 s — bun follows symlinks during discovery and pathIgnorePatterns filters results
// without pruning the walk, so the loop cannot be configured around; it has to not exist.
// Walks the install and the USER data root (the LIFEOS/USER symlink target) without following
// links; every directory symlink whose real target is the link's own parent or an ancestor of it
// is a blocking finding. Non-loop symlinks (LIFEOS/USER, LIFEOS/MEMORY, project links) are fine.
const SYMLINK_WALK_SKIP = new Set(['node_modules', '.git', 'LIFEOS_RELEASES', 'projects', 'file-history', 'coverage']);
function checkSymlinkLoops(): void {
  const findings: Finding[] = [];
  const roots = new Set<string>([CLAUDE_DIR]);
  try { roots.add(realpathSync(join(CLAUDE_DIR, 'LIFEOS', 'USER'))); } catch { /* no USER link on this install */ }
  let dirs = 0, links = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 24) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    dirs++;
    for (const name of entries) {
      if (SYMLINK_WALK_SKIP.has(name)) continue;
      const abs = join(dir, name);
      let st; try { st = lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) {
        links++;
        let target: string; try { target = realpathSync(abs); } catch { continue; } // dangling links are Doctor's job
        let tst; try { tst = statSync(target); } catch { continue; }
        if (!tst.isDirectory()) continue;
        const parent = realpathSync(dir);
        if (parent === target || (parent + '/').startsWith(target + '/')) {
          findings.push({ detail: `${abs} -> ${readlinkSync(abs)} resolves to its own ancestor ${target} — a symlink loop; remove it (bun test discovery follows it until EMFILE)`, blocking: true });
        }
        continue; // never descend through a link: the real tree is reached from its own root
      }
      if (st.isDirectory()) walk(abs, depth + 1);
    }
  };
  for (const r of roots) walk(r, 0);
  record('symlink-loops', findings, `${links} symlink(s) across ${dirs} dirs in ${roots.size} root(s), ${findings.length} loop(s)`);
}

// ── fetch timeouts (every outbound fetch in LIFEOS/TOOLS is bounded) ──
// A scheduled pass once died on an unbounded fetch: with no
// signal, a hung endpoint hangs the whole run. The check is file-level, not call-site —
// a signal assembled in a helper still counts, and that coarseness buys zero false
// positives on option objects built away from the call. *.test.ts is exempt because
// bun test enforces its own per-test timeout. Non-blocking with an INFO_BUDGET ratchet:
// the files predating this gate are the ceiling, so any NEW bare-fetch file breaches it.
// ── Check: risk-review (the register is reviewed, not just written) ──
// Non-blocking, uncapped: every /ic run lists what is overdue so a standing
// risk cannot quietly age past its review date.
function checkRiskReview(): void {
  const findings: Finding[] = [];
  const store = join(CLAUDE_DIR, 'LIFEOS', 'USER', 'SECURITY', 'THREATMODEL', 'risk-register.json');
  if (!existsSync(store)) { record('risk-review', [], 'skipped — no risk register on this install'); return; }
  try {
    const raw = JSON.parse(readFileSync(store, 'utf8'));
    const risks = (Array.isArray(raw) ? raw : raw.risks ?? []) as Array<{ id: string; title: string; status: string; review_by?: string; threat?: string }>;
    const today = new Date().toISOString().slice(0, 10);
    let open = 0;
    for (const r of risks) {
      if (r.status !== 'open') continue;
      open++;
      if (!r.review_by) findings.push({ detail: `${r.id} has no review date — ${r.title}`, blocking: false });
      else if (r.review_by < today) findings.push({ detail: `${r.id} review overdue since ${r.review_by} — ${r.title}`, blocking: false });
    }
    record('risk-review', findings, findings.length === 0 ? `${open} open risks, none overdue` : undefined);
  } catch { scanError('risk-review: could not read risk-register.json'); }
}

// ── Check: services-doc (BackgroundServices.md lists exactly the services `Services.ts doc` prints) ──
// public issue #2160, @tzioup: the table carries a "generated, do not hand-edit" marker,
// but nothing checked it, so it drifted from the registry (two shipped services missing,
// others unreproducible). Compares label SETS, not whole rows: the cadence column is read
// from live plists and is machine-dependent, the row membership is not. The registry is
// imported, not spawned, and filtered the way the `doc` command filters (per-instance
// services never render as rows). Some registry entries exist only where a host file does
// (Hermes home, workflows config, private skills), so like its siblings this needs the source
// checkout; SERVICES_DOC_PATH points the check at a fixture doc for the test.
async function checkServicesDoc(): Promise<void> {
  if (!isGitCheckout()) { record('services-doc', [], NOT_A_CHECKOUT); return; }
  const docPath = process.env.SERVICES_DOC_PATH ?? join(DOC_DIR, 'Services', 'BackgroundServices.md');
  if (!existsSync(docPath)) { record('services-doc', [], 'skipped — no BackgroundServices.md on this install'); return; }
  try {
    const { allServices } = await import('./Services') as typeof import('./Services');
    const generated = new Set(allServices().filter(s => !s.perInstance).map(s => s.label));
    const documented = new Set<string>();
    for (const line of readFileSync(docPath, 'utf8').split('\n')) {
      const m = line.match(/^\| \*\*[^*]*\*\* `([^`]+)`/);
      if (m) documented.add(m[1]);
    }
    const findings: Finding[] = [];
    for (const label of [...generated].sort()) {
      if (!documented.has(label)) findings.push({ detail: `${label} is in the Services.ts registry but not in the BackgroundServices.md table — regenerate with \`bun LIFEOS/TOOLS/Services.ts doc\``, blocking: true });
    }
    for (const label of [...documented].sort()) {
      if (!generated.has(label)) findings.push({ detail: `${label} is in the BackgroundServices.md table but not printed by \`Services.ts doc\` — remove the row or add the service to SERVICES`, blocking: true });
    }
    record('services-doc', findings, findings.length === 0 ? `${generated.size} services, doc table matches the registry` : undefined);
  } catch (e: any) {
    scanError(`services-doc: ${e?.message ?? String(e)}`);
    record('services-doc', [], 'SCAN ERROR');
  }
}

const BUN_FETCH_DEFAULT_TIMEOUT_MS = 300_000;

/** Longest AbortSignal.timeout(...) in `expr`, in ms, resolving `N * M` literals and consts defined in `scope`; 0 when none evaluates. */
function longestSignalMs(expr: string, scope: string = expr): number {
  const evalLiteral = (e0: string): number | null => {
    const e = e0.replace(/_/g, '').trim();
    if (!/^\d+(\s*\*\s*\d+)*$/.test(e)) return null;
    return e.split('*').reduce((n, x) => n * Number(x.trim()), 1);
  };
  let longest = 0;
  for (const m of expr.matchAll(/AbortSignal\.timeout\(\s*([^)]+?)\s*\)/g)) {
    let ms = evalLiteral(m[1]);
    if (ms === null && /^[A-Za-z_$][\w$]*$/.test(m[1])) {
      const def = scope.match(new RegExp(`\\bconst\\s+${m[1]}\\s*(?::\\s*number\\s*)?=\\s*([\\d_\\s*]+?)\\s*;`));
      if (def) ms = evalLiteral(def[1]);
    }
    if (ms !== null && ms > longest) longest = ms;
  }
  return longest;
}

/**
 * Same-length copy of `text` with comments, and string/template contents when `blankStrings`,
 * blanked to spaces (newlines kept), so structural scans see only code while offsets and line
 * numbers still index the original. A heuristic lexer: regex literals are treated as code.
 */
function maskNonCode(text: string, blankStrings = true): string {
  const out = text.split('');
  const blank = (a: number, b: number) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (c === '/' && d === '*') {
      const e = text.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end); i = end; continue;
    }
    if (c === '/' && d === '/' && text[i - 1] !== '\\' && text[i - 1] !== ':') {
      const e = text.indexOf('\n', i);
      const end = e < 0 ? n : e;
      blank(i, end); i = end; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      if (j < n && text[j] === c) { if (blankStrings) blank(i + 1, j); i = j + 1; continue; }
      i++; continue;   // no closing quote on this line: an apostrophe in a regex, not a string
    }
    if (c === '`') {
      let j = i + 1;
      while (j < n && text[j] !== '`') j += text[j] === '\\' ? 2 : 1;
      if (blankStrings) blank(i + 1, Math.min(j, n));
      i = j + 1; continue;
    }
    i++;
  }
  return out.join('');
}

/** Index of the bracket closing the one at `open` in masked code, or -1. */
function matchingClose(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** [start, end) ranges of the depth-0 comma-separated parts of masked[from, to). */
function topLevelParts(masked: string, from: number, to: number): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  let depth = 0, start = from;
  for (let i = from; i < to; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { parts.push([start, i]); start = i + 1; }
  }
  if (masked.slice(start, to).trim()) parts.push([start, to]);
  return parts.filter(([a, b]) => masked.slice(a, b).trim() !== '');
}

type FetchSignal = { signal: 'own' | 'none' | 'unknown'; signalExpr?: string; timeoutFalse: boolean };

/** The `{` of a same-file `const|let|var <id> = {` object literal, or -1. */
function objectLiteralFor(id: string, masked: string): number {
  const m = new RegExp(`\\b(?:const|let|var)\\s+${id.replace(/\$/g, '\\$')}\\s*(?::[^=;]+)?=\\s*\\{`).exec(masked);
  return m ? m.index + m[0].length - 1 : -1;
}

/**
 * Judges one request-options expression at [from, to): does it carry its own abort signal?
 * `code` is the source with comments blanked (values and quoted keys read from it); `masked`
 * also blanks strings (structure is scanned on it). Both index the original offsets.
 */
function judgeOptions(code: string, masked: string, from: number, to: number, depth = 0): FetchSignal {
  const unknown: FetchSignal = { signal: 'unknown', timeoutFalse: false };
  if (depth > 3) return unknown;
  const lead = masked.slice(from, to);
  const start = from + (lead.length - lead.trimStart().length);
  const body = masked.slice(from, to).trim();
  if (/^[A-Za-z_$][\w$]*$/.test(body)) {
    const open = objectLiteralFor(body, masked);
    if (open < 0) return unknown;   // a parameter or import: the caller decides, nothing here to judge
    const close = matchingClose(masked, open);
    return close < 0 ? unknown : judgeOptions(code, masked, open, close + 1, depth + 1);
  }
  if (!body.startsWith('{')) return unknown;   // withTimeout(opts), this.init, ...: not visible here
  const close = matchingClose(masked, start);
  if (close < 0) return unknown;
  const result: FetchSignal = { signal: 'none', timeoutFalse: false };
  let spreadUnknown = false;
  for (const [a, b] of topLevelParts(masked, start + 1, close)) {
    const part = code.slice(a, b).trim();
    const spread = /^\.\.\.\s*([A-Za-z_$][\w$]*)$/.exec(part);
    if (part.startsWith('...')) {
      const inner = spread ? judgeOptions(code, masked, a + code.slice(a, b).indexOf(spread[1]), b, depth + 1) : unknown;
      if (inner.signal === 'own') Object.assign(result, { signal: 'own', signalExpr: inner.signalExpr });
      else if (inner.signal === 'unknown') spreadUnknown = true;
      if (inner.timeoutFalse) result.timeoutFalse = true;
      continue;
    }
    const kv = /^(['"]?)([A-Za-z_$][\w$]*)\1\s*(?::\s*([\s\S]*))?$/.exec(part);
    if (!kv) continue;
    const [, , key, value] = kv;
    if (key === 'signal') {
      const v = (value ?? 'signal').trim();
      if (/^(undefined|null)$/.test(v)) Object.assign(result, { signal: 'none', signalExpr: undefined });
      else Object.assign(result, { signal: 'own', signalExpr: v });
    }
    if (key === 'timeout' && value !== undefined && /^false$/.test(value.trim())) result.timeoutFalse = true;
  }
  if (result.signal === 'none' && spreadUnknown) result.signal = 'unknown';
  return result;
}

/**
 * Every global fetch(...) call in a tool's source, each judged by its OWN request options.
 * `no-signal`: the call carries no abort signal (a signal elsewhere in the file used to excuse it).
 * `signal-never-fires`: its AbortSignal.timeout is past Bun's 300s default and that same call does
 * not pass `timeout: false`. Options the file cannot show (a parameter, a call result) are not guessed.
 */
export function fetchCallProblems(text: string): Array<{ line: number; problem: 'no-signal' | 'signal-never-fires'; seconds?: number }> {
  const masked = maskNonCode(text);
  const code = maskNonCode(text, false);
  const problems: Array<{ line: number; problem: 'no-signal' | 'signal-never-fires'; seconds?: number }> = [];
  // A bare `fetch(` and the same global reached through a global object (`globalThis.fetch(`,
  // `window.fetch(`, `self.fetch(`, `Bun.fetch(`) are all the network call; `x.fetch(` is not.
  for (const m of masked.matchAll(/(?<![.\w$])(?:(?:globalThis|global|window|self|Bun)\s*\??\.\s*)?fetch\s*\(/g)) {
    const at = m.index!;
    const open = at + m[0].length - 1;
    if (/\bfunction\s*\*?\s*$/.test(masked.slice(Math.max(0, at - 40), at))) continue;   // a local helper named fetch
    const close = matchingClose(masked, open);
    if (close < 0) continue;
    if (/^\s*[A-Za-z_$][\w$]*\s*\??\s*:/.test(masked.slice(open + 1, close))) continue;    // typed parameter list: a declaration
    if (/^\s*(?::[^;{}]*)?\{/.test(masked.slice(close + 1, close + 200))) continue; // method body follows: Bun.serve({ fetch(req) {...} })
    const line = text.slice(0, at).split('\n').length;
    const args = topLevelParts(masked, open + 1, close);
    const verdict: FetchSignal = args.length < 2 ? { signal: 'none', timeoutFalse: false } : judgeOptions(code, masked, args[1][0], args[1][1]);
    if (verdict.signal === 'none') { problems.push({ line, problem: 'no-signal' }); continue; }
    if (verdict.signal !== 'own' || !verdict.signalExpr) continue;
    let expr = verdict.signalExpr;
    if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
      const def = new RegExp(`\\b(?:const|let|var)\\s+${expr.replace(/\$/g, '\\$')}\\s*(?::[^=;]+)?=\\s*([^;\\n]+)`).exec(code);
      if (def) expr = def[1];
    }
    const ms = longestSignalMs(expr, code);
    if (ms > BUN_FETCH_DEFAULT_TIMEOUT_MS && !verdict.timeoutFalse) problems.push({ line, problem: 'signal-never-fires', seconds: Math.round(ms / 1000) });
  }
  return problems;
}

function checkFetchTimeouts(): void {
  const findings: Finding[] = [];
  const files = findFiles(TOOLS_DIR, ['-name', '*.ts', '-type', 'f']);
  let fetchFiles = 0;
  let unsignalled = 0;
  for (const f of files) {
    if (f.endsWith('.test.ts')) continue;
    const text = readScanInput('fetch-timeouts', f);
    if (text === null) continue;
    // Only a real network call counts: declarations, other APIs and comment prose are not
    // calls, and counting them sent a worker rewriting working code to dodge the scanner.
    if (!hasRealFetchCall(text)) continue;
    fetchFiles++;
    const rel = f.replace(CLAUDE_DIR + '/', '');
    // Each call is judged by its own options (LOSIntegrity security:2#9, 2026-10-13): a signal
    // anywhere in the file used to excuse every unbounded call beside it.
    for (const p of fetchCallProblems(text)) {
      if (p.problem === 'no-signal') {
        unsignalled++;
        findings.push({
          detail: `${rel}:${p.line}: this fetch() call passes no abort signal of its own — add signal: AbortSignal.timeout(ms) to its options so a hung endpoint cannot hang the run`,
          blocking: false,
        });
      } else {
        // Bun's fetch aborts at 300s on its own unless the call passes `timeout: false`, so a
        // longer AbortSignal.timeout is a bound that never fires (a long video's
        // model watch pass died at exactly 300s under a 30-minute signal).
        findings.push({
          detail: `${rel}:${p.line}: an AbortSignal.timeout of ${p.seconds}s never fires, because Bun aborts fetch at 300s by default — add \`timeout: false\` to this fetch's init`,
          blocking: false,
        });
      }
    }
  }
  record('fetch-timeouts', findings, `${fetchFiles} fetch-calling tools, ${unsignalled} fetch calls without their own abort signal, ${findings.length - unsignalled} with a signal that never fires`);
}

// ── block messages (every red box states the problem AND the fix) ──
// A gate that stops the work without naming the way out invites the cheapest
// possible response: rewording the claim until it stops firing. Contract and
// reference shape: hooks/README.md § Block messages.
function checkBlockMessages(): void {
  const findings: Finding[] = [];
  let note = '';
  try {
    const { raw, status } = runDelegate(join(TOOLS_DIR, 'BlockMessageGate.ts'), ['--json'], 8 * 1024 * 1024);   // exit 1 when violations exist
    const hits = validateDelegateResult(raw, status, DELEGATE_SHAPES.blockMessages).findings;
    note = `${hits.length} block message(s) missing a problem or fix clause`;
    for (const h of hits) {
      findings.push({ detail: `${h.file}:${h.line} — missing ${h.missing.join(' + ')}`, blocking: true });
    }
  } catch (e: any) {
    scanError(`block-messages: BlockMessageGate delegation failed — ${e.message}`);
    note = 'SCAN ERROR (delegation failed)';
  }
  record('block-messages', findings, note);
}

// ── Check 1: references (delegate to ReferenceCheck.ts) ──
function checkReferences(): void {
  const findings: Finding[] = [];
  let note = '';
  try {
    const rcPath = join(TOOLS_DIR, 'ReferenceCheck.ts');
    // No --stale. Staleness is an mtime heuristic ("target changed after the doc did")
    // and it cannot tell a description that rotted from a pointer that is simply older
    // than what it points at. Every one of the 418 findings it produced on 2026-07-27 was
    // a routing reference — "see X", "the script is at X" — that mtime can never judge.
    // A class that only emits noise does not belong in a verdict; `ReferenceCheck.ts
    // --stale` remains available for a manual look. missing/orphan stay: both are
    // deterministic and both are real. ReferenceCheck exits 1 when missing refs exist.
    const { raw, status } = runDelegate(rcPath, ['--json', '--orphans'], 64 * 1024 * 1024);
    const rc = validateDelegateResult(raw, status, DELEGATE_SHAPES.references);
    const kinds = (k: string) => rc.findings.filter((f: any) => f.type === k).length;
    note = `${rc.scannedRefs} refs across ${rc.scannedFiles} files: ${kinds('missing')} missing, ${kinds('stale')} stale, ${kinds('orphan')} orphan`;
    for (const f of rc.findings) {
      findings.push({
        detail: `${f.type}: ${f.ref ?? ''} in ${f.file}`,
        blocking: f.type === 'missing',
      });
    }
  } catch (e: any) {
    // Delegation failure = the check could not RUN (ReferenceCheck missing/unparseable output).
    // That is a scan error (exit 2), NOT a blocking finding (exit 1) — never let a broken tool
    // masquerade as a clean-but-blocking result. (Forge audit 2026-07-06.)
    scanError(`references: ReferenceCheck delegation failed — ${e.message}`);
    note = 'SCAN ERROR (delegation failed)';
  }
  record('references', findings, note);
}

// ── Check 2: version_anchors ──
function checkVersionAnchors(): void {
  const findings: Finding[] = [];
  let latest = '';
  try { latest = readFileSync(join(LIFEOS_DIR, 'ALGORITHM', 'LATEST'), 'utf8').trim(); }
  catch { scanError('version_anchors: ALGORITHM/LATEST unreadable'); record('version_anchors', [], 'SCAN ERROR (no LATEST)'); return; }

  const specRefRe = /(?:Algorithm|LIFEOS\/ALGORITHM)\/v(\d+\.\d+\.\d+)\.md/g;
  const docFiles = findFiles(DOC_DIR, ['-name', '*.md', '-type', 'f']);
  for (const file of docFiles) {
    let content = '';
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    let m: RegExpExecArray | null;
    specRefRe.lastIndex = 0;
    while ((m = specRefRe.exec(content)) !== null) {
      if (m[1] !== latest) {
        findings.push({ detail: `${file.replace(CLAUDE_DIR + '/', '')}: spec ref v${m[1]}.md ≠ LATEST v${latest}`, blocking: true });
      }
    }
  }
  // The master architecture doc's current-versions line must agree with LATEST
  // (Astra audit 2026-07-30: v8.17.1 shipped while this line said v8.17.0 — the
  // spec-file-ref regex above never sees a bare "Algorithm vX.Y.Z" mention).
  try {
    const master = readFileSync(join(DOC_DIR, 'LifeosSystemArchitecture.md'), 'utf8');
    const vLine = master.match(/\*\*Version:\*\*[^\n]*Algorithm v(\d+\.\d+\.\d+)/);
    if (vLine && vLine[1] !== latest) {
      findings.push({ detail: `LifeosSystemArchitecture.md current-versions line says Algorithm v${vLine[1]} ≠ LATEST v${latest}`, blocking: true });
    }
  } catch { scanError('version_anchors: LifeosSystemArchitecture.md unreadable'); }
  // No "(currently vX.Y.Z)" hardcodes anywhere in DOCUMENTATION (Max audit
  // 2026-08-09: the master doc's Algorithm row shipped "(currently v8.17.0"
  // one cut stale beside its own regenerated derivative saying v8.18.0 — free
  // prose restating a version is rot by construction; point at the source of
  // truth instead).
  const currentlyRe = /\(currently v\d+\.\d+\.\d+/g;
  for (const file of docFiles) {
    let content = '';
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    let c: RegExpExecArray | null;
    currentlyRe.lastIndex = 0;
    while ((c = currentlyRe.exec(content)) !== null) {
      findings.push({ detail: `${file.replace(CLAUDE_DIR + '/', '')}: hardcoded "${c[0]}…)" — point at the version's source of truth (LATEST / VERSION) instead of restating it`, blocking: true });
    }
  }
  record('version_anchors', findings, `LATEST=v${latest}; ${findings.length} drifted refs (spec files + master line + currently-hardcodes)`);
}

// ── Check 2b: master_doc_paths ──
// The master architecture doc is the recurring stale-topology offender: three
// consecutive 7.34.x cross-vendor audit rounds each found path-like prose refs
// there that resolve nowhere (RestoreContext.hook.ts, removed 2026-05-06; the
// phantom LIFEOS/Components/ dir, removed 2026-08-09; modules/voice.ts after
// the VoiceServer split). ReferenceCheck/DocCheck parse
// only their own syntactic forms, so absolute-prefixed prose paths rot unseen.
// Scoped to LifeosSystemArchitecture.md deliberately — a tree-wide version of
// this check drowns in historical mentions; the master doc claims CURRENT
// topology, so a missing path there is drift by definition. Lines carrying a
// dated removal marker are exempt (same contract as G19's removal notes).
// Extension alternation is longest-first with a trailing boundary — `js`
// before `json` once matched "user-index.js" inside "user-index.json" and
// produced this check's own first false positive.
function checkMasterDocPaths(): void {
  const findings: Finding[] = [];
  // Maintainer-tree check ONLY. The master doc names maintainer topology (test
  // files, private state, USER files created per-install), so on a shipped
  // install this check would red a fresh tree out of the box (Max audit of the
  // 7.34.7 payload: 9 false blocks by simulation). skills/_LIFEOS never ships,
  // so its absence identifies an installed tree — skip there, honestly labeled.
  if (!existsSync(join(CLAUDE_DIR, 'skills', '_LIFEOS'))) {
    record('master_doc_paths', [], 'skipped — maintainer-tree check (not applicable on an installed tree)');
    return;
  }
  const MARKER = /since removed|removed 20\d\d|deleted 20\d\d|renamed from|\(removed\)|\bREMOVED\b|no longer (?:ship|exist|used)|deprecated 20\d\d|retired 20\d\d|RETIRED \(20\d\d|— removed|historical|formerly|corrected 20\d\d|not in the release payload|maintainer tree|per-install/i;
  const PATH_RE = /(?:hooks|LIFEOS|skills|commands|agents|test)\/[A-Za-z0-9_./-]+\.(?:tsx|ts|jsonl|json|mjs|js|sh|md|yaml|toml)(?![A-Za-z0-9])/g;
  let text = '';
  try { text = readFileSync(join(DOC_DIR, 'LifeosSystemArchitecture.md'), 'utf8'); }
  catch { scanError('master_doc_paths: LifeosSystemArchitecture.md unreadable'); record('master_doc_paths', [], 'SCAN ERROR'); return; }
  const lines = text.split('\n');
  let scanned = 0;
  for (let i = 0; i < lines.length; i++) {
    if (MARKER.test(lines[i])) continue;
    PATH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PATH_RE.exec(lines[i])) !== null) {
      const p = m[0];
      if (/\{|\*|<|YYYY|\$\{|\/v\d+\.\d+\.\d+\.md/.test(p)) continue; // brace-lists, globs, placeholders, versioned spec files (version_anchors owns those)
      scanned++;
      if (!existsSync(join(CLAUDE_DIR, p))) {
        findings.push({ detail: `LifeosSystemArchitecture.md:${i + 1}: path ref \`${p}\` resolves to nothing in the live tree — fix the topology or add a dated removal marker on the line`, blocking: true });
      }
    }
  }
  record('master_doc_paths', findings, `${scanned} path refs existence-checked in the master doc; ${findings.length} dead`);
}

// ── Check 3: hook_registration (bidirectional + parse-guard + exec-bit) ──
function checkHookRegistration(): void {
  const findings: Finding[] = [];
  const hooksDir = join(CLAUDE_DIR, 'hooks');
  const settingsPath = join(CLAUDE_DIR, 'settings.json');
  let settings = '';
  try { settings = readFileSync(settingsPath, 'utf8'); }
  catch { scanError('hook_registration: settings.json unreadable'); record('hook_registration', [], 'SCAN ERROR (no settings)'); return; }

  // settings.json must be valid JSON — a malformed settings.json breaks the whole harness.
  try { JSON.parse(settings); }
  catch (e: any) { findings.push({ detail: `settings.json does not parse as JSON: ${e.message}`, blocking: true }); }

  const registered = new Set<string>();
  const re = /([A-Za-z0-9_]+\.hook\.ts)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(settings)) !== null) registered.add(m[1]);

  let onDisk = new Set<string>();
  // If the hooks dir is unreadable, onDisk stays empty and the whole
  // registered-vs-onDisk reconciliation silently degrades (it would report
  // every registered hook as "file missing" or skip dead-hook detection). A
  // scan error must surface as exit 2, never masquerade as clean (public
  // issue #1508 finding #13 — the swallowed catch that hollowed this check).
  try { onDisk = new Set(readdirSync(hooksDir).filter(f => f.endsWith('.hook.ts'))); }
  catch (e: any) { scanError(`hook_registration: hooks dir unreadable: ${e?.message ?? e}`); }

  // registered but file missing → BLOCKING
  for (const r of registered) {
    if (!onDisk.has(r)) findings.push({ detail: `registered in settings.json but file missing: hooks/${r}`, blocking: true });
    else {
      // registered hooks with a shebang are exec'd directly by the harness — a missing +x bit is a silent no-fire.
      try {
        const st = statSync(join(hooksDir, r));
        const isExec = (st.mode & 0o111) !== 0;
        if (!isExec) findings.push({ detail: `registered hook not executable (chmod +x): hooks/${r}`, blocking: false });
      } catch (e: any) {
        // A stat failure on a registered hook means the exec-bit check couldn't
        // run — surface it rather than silently drop the finding (#1508 #13).
        findings.push({ detail: `registered hook ${r} could not be stat'd (exec-bit check skipped): ${e?.message ?? e}`, blocking: false });
      }
    }
  }
  // On disk but not in settings.json is NOT dormant when an aggregator calls it. The 2026
  // consolidation moved ten guards behind StopGates / PreToolGuard / MemoryTurnStart, and this
  // check kept reporting all ten as unregistered — false positives are how a real finding gets
  // tuned out, so resolve the actual call graph before flagging.
  // hooks/lib registries count too: lib/private-gates.ts is the release-zoned home
  // of private-only members (StopGates and PostToolObserver both load it), so a
  // hook it imports is wired even though no *.hook.ts names it (2026-09-03).
  let libSource = '';
  try { libSource = readdirSync(join(hooksDir, 'lib')).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts')).map(f => { try { return readFileSync(join(hooksDir, 'lib', f), 'utf8'); } catch { return ''; } }).join('\n'); } catch { /* no lib dir */ }
  // The LifeOSHooks plugin reaches classic hooks through LIFEOS/TOOLS/HookBridge.ts (a dynamic
  // import per verb), so a hook only the bridge loads is wired, not dormant (2026-10-14:
  // SubagentGitSandbox was reported dormant while the plugin ran it on every subagent Bash call).
  let bridgeSource = '';
  try { bridgeSource = readFileSync(join(hooksDir, '..', 'LIFEOS', 'TOOLS', 'HookBridge.ts'), 'utf8'); } catch { /* no bridge on this install */ }
  const aggregatorSource = (onDisk.size
    ? [...onDisk].map(h => { try { return readFileSync(join(hooksDir, h), 'utf8'); } catch { return ''; } }).join('\n')
    : '') + '\n' + libSource + '\n' + bridgeSource;
  // A hook can also be wired from outside hooks/: a runtime that registers it through its own --settings
  // (the Relay bridge spawns text sessions with TextingGuard) or a tool that imports it as a module. Tracked
  // non-test code is searched, never docs, so a mention in prose does not count as a caller.
  const externalCallers = (stem: string): boolean => {
    const r = spawnSync('git', ['-C', join(hooksDir, '..'), 'grep', '-l', '-E', `hooks/${stem}\\.hook(\\.ts)?['"\`]`, '--', 'LIFEOS/*.ts', 'skills/*.ts', ':!*.test.ts'], { encoding: 'utf8', timeout: 30_000 });
    return r.status === 0 && r.stdout.trim().length > 0;
  };
  for (const d of onDisk) {
    if (registered.has(d)) continue;
    const stem = d.replace(/\.hook\.ts$/, '');
    // Called by another hook (import or spawn, with or without the .ts extension) → wired, just not directly registered.
    if (new RegExp(`['"\`./]${stem}(\\.hook)?(\\.ts)?['"\`]|\\b${stem}\\b\\s*\\(`).test(aggregatorSource)) continue;
    if (externalCallers(stem)) continue;
    findings.push({ detail: `on disk, not registered, and no hook calls it: hooks/${d}`, blocking: false });
  }
  record('hook_registration', findings, `${registered.size} registered, ${onDisk.size} on disk`);
}

// ── Check 3b: hook_wiring (SEMANTIC — registered event must match declared TRIGGER) ──
// ── Check: settings.json ↔ settings.system.json hook parity ──
// settings.json is what this machine runs; settings.system.json is what a fresh
// install gets. Nothing keeps the two in step, so a hook added to one and not the
// other is dead on every install that reads the other file — silently, because
// each file is internally valid and every other check reads only settings.json.
// That is the class behind public issue #1724, @waveman2020-sudo: the report was
// one missing registration, but the hole is that no gate compares the two at all.
//
// Blocking where the release is at stake (S071), info elsewhere. Legitimate divergence exists: a hook
// the release classification keeps private, or one named in PRIVATE_ONLY_HOOKS, may sit in settings.json
// alone. A hook the release ships must be registered in settings.system.json on the same events, or a
// fresh install runs without it. A guard the release registers (on a GUARD_EVENTS event) must be
// registered here too.
//
// An install without the release classifier tells its own hooks apart by where they come from: settings.json
// is merged from settings.system.json and the user overlay (USER/CONFIG/settings.user.json), so a guard-event
// registration that neither declares is a lost or hand-made one and blocks, while one the overlay declares is
// the user's own and stays info. A settings.system.json with no `hooks` block is the public-install layout,
// where InstallHooks writes the shipped hooks straight into settings.json; there nothing is compared to block on.
const GUARD_EVENTS = new Set<string>(['PreToolUse', 'PermissionRequest']);
const PRIVATE_ONLY_HOOKS = new Set<string>([
  // Syncs the maintainer's private work repo — meaningless on a public install.
  'ULWorkSync.hook.ts', // maintainer-side
]);

/**
 * What one hook registration runs, as parity keys (S071 round 2: registrations are compared by what they run,
 * not by a `*.hook.ts` filename, so a guard written as `hooks/<name>.hook.sh` or run by any interpreter is
 * compared too). A command naming files under a `hooks/` directory is keyed by each such file name, so its
 * release classification still applies; any other command by its text (quotes dropped, whitespace collapsed);
 * an http hook by its URL; any other hook type by its fields. A registration is never dropped. Pure.
 */
export function registrationKeys(h: unknown): string[] {
  if (h === null || typeof h !== 'object') return h == null ? [] : [`hook: ${JSON.stringify(h)}`];
  const rec = h as Record<string, unknown>;
  const command = typeof rec.command === 'string' ? rec.command : '';
  if (command.trim() !== '') {
    const files = [...command.matchAll(/(?:^|[\/\s'"=])hooks\/([A-Za-z0-9_.@+-]+)/g)].map(m => m[1].replace(/[.]+$/, '')).filter(Boolean);
    if (files.length > 0) return [...new Set(files)];
    return [`command: ${command.replace(/['"]/g, '').replace(/\s+/g, ' ').trim()}`];
  }
  if (typeof rec.url === 'string') return [`http: ${rec.url}`];
  const { timeout: _t, ...rest } = rec;
  return [`${String(rec.type ?? 'hook')}: ${JSON.stringify(rest)}`];
}
/**
 * The full form of one registration, for comparing a hook that both files register (S071 round 3): the group's
 * matcher and exactly what runs (the command text with whitespace collapsed, an http hook's URL, any other hook's
 * fields), timeout aside. A key names the hook files a command mentions, so `true # hooks/<name>.hook.sh` and
 * `bun hooks/<name>.hook.sh` share a key; their forms differ, as do a guard's `*` and `Read` matchers. Pure.
 */
export function registrationForm(event: string, matcher: unknown, h: unknown): string {
  const m = matcher == null ? '' : typeof matcher === 'string' ? matcher : JSON.stringify(matcher);
  let what: string;
  if (h !== null && typeof h === 'object') {
    const rec = h as Record<string, unknown>;
    if (typeof rec.command === 'string' && rec.command.trim() !== '') what = `command: ${rec.command.replace(/\s+/g, ' ').trim()}`;
    else if (typeof rec.url === 'string') what = `http: ${rec.url}`;
    else { const { timeout: _t, ...rest } = rec; what = `${String(rec.type ?? 'hook')}: ${JSON.stringify(rest)}`; }
  } else what = `hook: ${JSON.stringify(h)}`;
  return `${event} [matcher ${m === '' ? '(none)' : m}] ${what}`;
}
/** The event a registration form belongs to. Pure. */
function formEvent(form: string): string { return form.slice(0, form.indexOf(' [matcher ')); }
/** The hook file a parity key names, or null for a key that is a command, URL or other hook. Pure. */
function keyHookFile(key: string): string | null { return /^[A-Za-z0-9_.@+-]+$/.test(key) ? key : null; }
/** How a parity key reads in a finding: `hooks/<file>` for a hook file, the key itself otherwise. Pure. */
function keyLabel(key: string): string { return keyHookFile(key) !== null ? `hooks/${key}` : key; }

async function checkSettingsParity(): Promise<void> {
  const findings: Finding[] = [];
  const livePath = join(CLAUDE_DIR, 'settings.json');
  const shippedPath = join(CLAUDE_DIR, 'settings.system.json');

  // Read the contract, not a snapshot: any {event: [{hooks:[{command}]}]} shape
  // parses, so this stays correct as registrations are added on either side.
  const hookBlocks = new Map<string, boolean>();
  // Per file, per parity key: the full registration forms (event, matcher, what runs), for the form-drift check.
  const formsByFile = new Map<string, Map<string, Set<string>>>();
  // `overlay`: the user overlay may write an event as MergeSettings' `{ "__merge": "append", "values": [...] }`
  // (its values are declared) or `{ "__merge": "remove" }` (declares nothing). The two settings files keep the
  // plain array shape, and anything else there still fails the check.
  const readHooks = (p: string, overlay = false): Map<string, Set<string>> | null => {
    let parsed: any;
    try { parsed = JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
    hookBlocks.set(p, parsed?.hooks != null);
    const byHook = new Map<string, Set<string>>();
    const forms = new Map<string, Set<string>>();
    formsByFile.set(p, forms);
    for (const [event, raw] of Object.entries(parsed?.hooks ?? {})) {
      const groups = !overlay || Array.isArray(raw) ? raw : (raw as any)?.__merge === 'append' && Array.isArray((raw as any).values) ? (raw as any).values : [];
      for (const g of (groups as any[]) ?? []) {
        for (const h of g?.hooks ?? []) {
          const form = registrationForm(event, g?.matcher, h);
          for (const nm of registrationKeys(h)) {
            if (!byHook.has(nm)) byHook.set(nm, new Set());
            byHook.get(nm)!.add(event);
            if (!forms.has(nm)) forms.set(nm, new Set());
            forms.get(nm)!.add(form);
          }
        }
      }
    }
    return byHook;
  };

  const live = readHooks(livePath);
  const shipped = readHooks(shippedPath);
  if (!live || !shipped) {
    // A missing or unparseable file is a failed check, never a clean skip: parity cannot be shown, so the verdict cannot be green.
    const which = [!live ? 'settings.json' : '', !shipped ? 'settings.system.json' : ''].filter(Boolean).join(' and ');
    record('settings-parity', [{ detail: `${which} missing or unparseable — hook parity could not be checked`, blocking: true }], `UNAVAILABLE — ${which} missing or unparseable`);
    return;
  }

  // Which hook files the release ships. No release classifier on this install (or it failed to load): which
  // hooks ship is unknown, so a guard-event registration neither merge source declares blocks instead.
  const hasClassifier = existsSync(join(CLAUDE_DIR, 'skills', '_LIFEOS', 'Release', 'classify.ts'));
  const shipsPredicate = hasClassifier ? await releaseShipsPredicate('settings-parity') : null;
  // Ship status per parity key: true or false from the classifier for a hook file, null (unknown) when there is no
  // classifier or the key is a command, URL or other hook the classifier cannot place.
  const shipStatus = (hook: string): boolean | null => {
    if (PRIVATE_ONLY_HOOKS.has(hook)) return false;
    const file = keyHookFile(hook);
    return file === null || shipsPredicate === null ? null : shipsPredicate(join(CLAUDE_DIR, 'hooks', file));
  };
  const ships = (hook: string): boolean => shipStatus(hook) === true;
  const guardIn = (events: Iterable<string>): boolean => [...events].some(e => GUARD_EVENTS.has(e));
  // Live guard events that neither settings.system.json nor the user overlay declares for this hook, counted
  // only when ship status is unknown and settings.system.json is this tree's hook registry (has a hooks block).
  const overlay = readHooks(join(LIFEOS_DIR, 'USER', 'CONFIG', 'settings.user.json'), true) ?? new Map<string, Set<string>>();
  const undeclaredGuard = (hook: string, liveEvents: Set<string>): boolean => {
    if (shipStatus(hook) !== null || !hookBlocks.get(shippedPath)) return false;
    const declared = new Set([...(shipped.get(hook) ?? []), ...(overlay.get(hook) ?? [])]);
    return guardIn([...liveEvents].filter(e => !declared.has(e)));
  };

  for (const [hook, events] of live) {
    if (shipped.has(hook) || PRIVATE_ONLY_HOOKS.has(hook)) continue;
    const block = ships(hook) || undeclaredGuard(hook, events);
    const why = ships(hook) ? ' (the release ships this hook)' : block ? ' (a guard event neither settings.system.json nor the user overlay declares)' : '';
    findings.push({ detail: `${keyLabel(hook)} registered in settings.json (${[...events].sort().join(', ')}) but NOT in settings.system.json — dead on a fresh install${why}`, blocking: block });
  }
  for (const [hook, events] of shipped) {
    if (live.has(hook)) continue;
    const block = !PRIVATE_ONLY_HOOKS.has(hook) && (ships(hook) || guardIn(events));
    findings.push({ detail: `${keyLabel(hook)} registered in settings.system.json (${[...events].sort().join(', ')}) but NOT in settings.json — never fires on this machine`, blocking: block });
  }
  // Same hook, different events: registered in both, so the checks above pass
  // while the hook still fires on one event here and another on a fresh install.
  for (const [hook, liveEvents] of live) {
    const shippedEvents = shipped.get(hook);
    if (!shippedEvents) continue;
    const a = [...liveEvents].sort().join(',');
    const b = [...shippedEvents].sort().join(',');
    if (a !== b) {
      const block = !PRIVATE_ONLY_HOOKS.has(hook) && (ships(hook) || guardIn(shippedEvents) || undeclaredGuard(hook, liveEvents));
      findings.push({ detail: `${keyLabel(hook)} event drift — settings.json: [${a}] vs settings.system.json: [${b}]`, blocking: block });
    }
  }
  // Same hook, same event, different registration (S071 round 3): a changed matcher (`*` → `Read` drops every
  // other tool) or a changed command (`bun hooks/<name>.hook.sh` → `true # hooks/<name>.hook.sh`, `--enforce` →
  // `--advisory`) leaves the key and its events equal while the guard no longer runs as shipped. Compared on the
  // events both files register for the hook; an event only one side has is the event drift reported above.
  const liveForms = formsByFile.get(livePath) ?? new Map<string, Set<string>>();
  const shippedForms = formsByFile.get(shippedPath) ?? new Map<string, Set<string>>();
  const overlayForms = formsByFile.get(join(LIFEOS_DIR, 'USER', 'CONFIG', 'settings.user.json')) ?? new Map<string, Set<string>>();
  for (const [hook, liveEvents] of live) {
    const shippedEvents = shipped.get(hook);
    if (!shippedEvents) continue;
    const common = new Set([...liveEvents].filter(e => shippedEvents.has(e)));
    const lf = [...(liveForms.get(hook) ?? [])].filter(f => common.has(formEvent(f)));
    const sf = [...(shippedForms.get(hook) ?? [])].filter(f => common.has(formEvent(f)));
    const sfSet = new Set(sf), lfSet = new Set(lf);
    const onlyLive = lf.filter(f => !sfSet.has(f)).sort();
    const onlyShipped = sf.filter(f => !lfSet.has(f)).sort();
    if (onlyLive.length === 0 && onlyShipped.length === 0) continue;
    // A live form the user overlay declares is the user's own addition; every other difference on a guard event,
    // or any difference on a hook the release ships, is a guard that no longer runs as a fresh install runs it.
    const declared = overlayForms.get(hook) ?? new Set<string>();
    const undeclaredLive = onlyLive.filter(f => !declared.has(f));
    const block = !PRIVATE_ONLY_HOOKS.has(hook)
      && (((ships(hook) && (undeclaredLive.length > 0 || onlyShipped.length > 0)))
        || [...undeclaredLive, ...onlyShipped].some(f => GUARD_EVENTS.has(formEvent(f))));
    findings.push({ detail: `${keyLabel(hook)} registration drift — settings.json only: [${onlyLive.join(' | ') || 'none'}] vs settings.system.json only: [${onlyShipped.join(' | ') || 'none'}]`, blocking: block });
  }

  record('settings-parity', findings, findings.length === 0 ? `${live.size} hooks in parity` : undefined);
}

// Spinner tips (settings.spinnerTipsOverride.tips) are always-on user-facing surface that
// rots exactly like doc counts: a skill/command/hook added or removed leaves its tip stale
// or absent, and nothing noticed until the principal read a wrong tip. This makes tip freshness a
// deterministic /ic gate — the principal's 2026-08-12 directive: "clean up the custom tips
// and adjust them, add them, and remove them accordingly to adding and removing
// functionality." All anchors are structural (parity, versions, counts, _ALLCAPS/hook-file
// existence, command coverage); zero semantic matching, so it cannot cry wolf and get
// demoted. Source of truth is settings.user.json (settings.json is generated from it).
// ── standing-facts freshness ──
// The card is injected on EVERY turn, so a stale line is worse than a missing one:
// "Main loop is pinned to fable" was written 2026-08-17 and false 48h later when the
// carrier changed, and it kept asserting itself into every prompt in between.
function checkStandingFacts(): void {
  try {
    const { verifyCard } = require('./StandingFacts') as typeof import('./StandingFacts');
    // No card file at all is a public install and is skipped. A card that exists but cannot be
    // compared (unreadable or malformed settings.json, no FACTS section, a carrier claim with no
    // pinned model) is a finding, never a pass.
    if (!existsSync(join(CLAUDE_DIR, 'LIFEOS/USER/CONFIG/STANDING_FACTS.md'))) { record('standing-facts', [], 'skipped — no card on this install'); return; }
    const verdict = verifyCard();
    if (verdict.status === 'cannot_verify') {
      record('standing-facts', [{ detail: `standing-facts card cannot be verified: ${verdict.why}`, blocking: true }]);
      return;
    }
    const findings: Finding[] = verdict.status === 'stale'
      ? verdict.findings.map(f => ({ detail: `standing-facts card: ${f.why} — ${f.line}`, blocking: true }))
      : [];
    record('standing-facts', findings, verdict.status === 'agree' ? verdict.note : undefined);
  } catch (e: any) {
    scanError(`standing-facts: ${e?.message ?? String(e)}`);
    record('standing-facts', [], 'SCAN ERROR');
  }
}

function checkSpinnerTips(): void {
  const findings: Finding[] = [];
  const userPath = join(USER_REPO, 'CONFIG', 'settings.user.json');
  const livePath = join(CLAUDE_DIR, 'settings.json');
  const readTips = (p: string): string[] | null => {
    try { return JSON.parse(readFileSync(p, 'utf8'))?.spinnerTipsOverride?.tips ?? null; }
    catch { return null; }
  };
  const userTips = readTips(userPath);
  const liveTips = readTips(livePath);
  if (!userTips) { record('spinner-tips', [], 'skipped — settings.user.json has no tips (public install)'); return; }
  const tips = userTips;
  const all = tips.join('\n');

  // 1. Source→generated parity: the merged settings.json must carry the same tips.
  if (liveTips && JSON.stringify(liveTips) !== JSON.stringify(userTips)) {
    findings.push({ detail: `spinner tips in settings.json differ from settings.user.json source — regenerate via MergeSettings`, blocking: true });
  }
  // 2. Duplicates.
  const dupes = tips.filter((t, i) => tips.indexOf(t) !== i);
  for (const d of [...new Set(dupes)]) findings.push({ detail: `duplicate tip: "${d.slice(0, 60)}…"`, blocking: true });

  // 3. Version anchors — any tip naming a tracked version must match the live value.
  const versionAnchors: Array<{ label: RegExp; live: string | null; name: string }> = [];
  const liveOf = (re: RegExp, file: string): string | null => {
    try { return readFileSync(file, 'utf8').match(re)?.[1] ?? null; } catch { return null; }
  };
  const lifeosV = liveOf(/# LifeOS (\d+\.\d+\.\d+)/, join(CLAUDE_DIR, 'CLAUDE.md'));
  let algoV: string | null = null;
  try { algoV = readFileSync(join(LIFEOS_DIR, 'ALGORITHM', 'LATEST'), 'utf8').trim(); } catch {}
  const archPath = join(DOC_DIR, 'ARCHITECTURE_SUMMARY.md');
  const sysPromptV = liveOf(/System Prompt v(\d+\.\d+\.\d+)/, archPath);
  const cortexV = liveOf(/Cortex \(Memory\) v(\d+\.\d+\.\d+)/, archPath);
  if (lifeosV) versionAnchors.push({ label: /LifeOS (\d+\.\d+\.\d+)/g, live: lifeosV, name: 'LifeOS' });
  if (algoV) versionAnchors.push({ label: /Algorithm v(\d+\.\d+\.\d+)/g, live: algoV, name: 'Algorithm' });
  if (sysPromptV) versionAnchors.push({ label: /System Prompt v(\d+\.\d+\.\d+)/g, live: sysPromptV, name: 'System Prompt' });
  if (cortexV) versionAnchors.push({ label: /Cortex \(Memory\) v(\d+\.\d+\.\d+)/g, live: cortexV, name: 'Cortex' });
  for (const a of versionAnchors) {
    for (const t of tips) {
      a.label.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = a.label.exec(t)) !== null) {
        if (m[1] !== a.live) findings.push({ detail: `stale ${a.name} version in tip: "${m[0]}" — live is ${a.live}`, blocking: true });
      }
    }
  }

  // 4. Count anchors — "N skills/intents/hooks/gates" must match live reality.
  const skillDirs = existsSync(join(CLAUDE_DIR, 'skills'))
    // A skill is a directory with a SKILL.md, the same rule Pulse's wiki lists by; skills/synced (the harness sync
    // folder) is a directory but not a skill, and counting it put the tip one above what Pulse showed (2026-10-10).
    ? readdirSync(join(CLAUDE_DIR, 'skills')).filter(d => existsSync(join(CLAUDE_DIR, 'skills', d, 'SKILL.md')))
    : [];
  const publicSkills = skillDirs.filter(d => !d.startsWith('_')).length;
  const privateSkills = skillDirs.filter(d => d.startsWith('_')).length;
  const intentCount = findFiles(join(CLAUDE_DIR, 'skills'), ['-name', '*.md', '-path', '*/Intents/*', '-type', 'f']).length;
  const hookCount = existsSync(join(CLAUDE_DIR, 'hooks'))
    ? readdirSync(join(CLAUDE_DIR, 'hooks')).filter(f => f.endsWith('.hook.ts')).length : 0;
  let gateCount = 0;
  try {
    const sr = readFileSync(join(CLAUDE_DIR, 'skills', '_LIFEOS', 'Tools', 'ShadowRelease.ts'), 'utf8');
    gateCount = (sr.match(/type GateKey =[^;]+;/)?.[0].match(/"G\d+_/g) ?? []).length;
  } catch {}
  const countAnchors: Array<{ re: RegExp; live: number; unit: string }> = [
    { re: /\b(\d+) skills\b/g, live: skillDirs.length, unit: 'skills' },
    { re: /\b(\d+) public\b/g, live: publicSkills, unit: 'public skills' },
    { re: /\b(\d+) private\b/g, live: privateSkills, unit: 'private skills' },
    { re: /\b(\d+) (?:intents|procedures|workflows)\b/g, live: intentCount, unit: 'intents' },
    { re: /\b(\d+) hooks\b/g, live: hookCount, unit: 'hooks' },
  ];
  if (gateCount > 0) countAnchors.push({ re: /\b(\d+) gates\b/g, live: gateCount, unit: 'gates' });
  for (const a of countAnchors) {
    for (const t of tips) {
      a.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = a.re.exec(t)) !== null) {
        if (parseInt(m[1], 10) !== a.live) findings.push({ detail: `stale count in tip: "${m[0]}" — live is ${a.live} ${a.unit}`, blocking: true });
      }
    }
  }

  // 5. Reference existence — every _ALLCAPS skill token and *.hook.ts filename named in a
  //    tip must resolve on disk. (Slash-commands are NOT reverse-checked: Pulse routes like
  //    /atlas and /upgrades are legitimately not command files — see command coverage below.)
  const skillSet = new Set(skillDirs);
  // Standalone _ALLCAPS tokens only — the negative lookbehind rejects mid-word matches like
  // the "_SUMMARY" inside "ARCHITECTURE_SUMMARY".
  for (const tok of new Set(all.match(/(?<![A-Za-z0-9])_[A-Z][A-Z0-9_]+/g) ?? [])) {
    if (!skillSet.has(tok)) findings.push({ detail: `tip references skill "${tok}" but skills/${tok}/ does not exist`, blocking: true });
  }
  for (const hk of new Set(all.match(/[A-Z][A-Za-z0-9]*\.hook\.ts/g) ?? [])) {
    if (!existsSync(join(CLAUDE_DIR, 'hooks', hk))) findings.push({ detail: `tip references hook "${hk}" but hooks/${hk} does not exist`, blocking: true });
  }

  // 6. Command coverage — every commands/*.md must appear in ≥1 tip, so a new slash-command
  //    is not silently undiscoverable. Boundary-matched to avoid /cs matching /context-search.
  const cmdDir = join(CLAUDE_DIR, 'commands');
  if (existsSync(cmdDir)) {
    for (const cmd of readdirSync(cmdDir).filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''))) {
      const re = new RegExp('/' + cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9-])');
      if (!re.test(all)) findings.push({ detail: `command /${cmd} has no spinner tip — add one so it is discoverable`, blocking: false });
    }
  }

  // 7. Retired capabilities — a tip naming anything in the retirement registry describes a
  //    feature that no longer exists. Same tokens and allow-contexts G19 uses at release.
  const registry = join(CLAUDE_DIR, 'skills', '_LIFEOS', 'RETIRED_CAPABILITIES.json');
  if (existsSync(registry)) {
    try {
      for (const c of JSON.parse(readFileSync(registry, 'utf8')).capabilities ?? []) {
        if (!c?.token) continue;
        // A public-scope entry stays in local use and is kept out of the release only; the tips are
        // this install's own settings (the public payload's tips come from settings.public.json, which G19 scans).
        if (c.scope === 'public') continue;
        const re = new RegExp(c.token, 'i');
        const allow = (c.allow ?? []).map((a: string) => new RegExp(a, 'i'));
        for (const t of tips) {
          if (re.test(t) && !allow.some((a: RegExp) => a.test(t))) {
            findings.push({ detail: `tip names retired capability "${c.id}" (retired ${c.retired}): "${t.slice(0, 60)}…"`, blocking: true });
          }
        }
      }
    } catch (e: any) {
      findings.push({ detail: `cannot read RETIRED_CAPABILITIES.json for the tip scan: ${e?.message ?? e}`, blocking: true });
    }
  }

  record('spinner-tips', findings, findings.length === 0 ? `${tips.length} tips fresh` : undefined);
}

// Spinner verbs carry the principal's favorite books and shows. They rot the other way from
// tips: nothing in them goes false, but a new favorite never shows up and the sources drift
// apart (verbs.json → settings.user.json → settings.json). themes.json maps each work to the
// verbs drawn from it, so coverage is a structural lookup with zero semantic matching. A
// favorite is a `loved` row in the MediaTaste database or a hand-curated BOOKS.md entry
// rated 8+; each needs MIN_VERBS verbs that exist, and no verb may outlive its source.
function checkSpinnerVerbs(): void {
  const MIN_VERBS = 3;
  const findings: Finding[] = [];
  const spinnerDir = process.env.SPINNER_ASSETS_DIR ?? join(USER_REPO, 'CUSTOMIZATIONS', 'Spinner');
  const verbsPath = join(spinnerDir, 'verbs.json');
  const themesPath = join(spinnerDir, 'themes.json');
  const userPath = process.env.SPINNER_SETTINGS_USER ?? join(USER_REPO, 'CONFIG', 'settings.user.json');
  const livePath = process.env.SPINNER_SETTINGS_LIVE ?? join(CLAUDE_DIR, 'settings.json');
  const mediaPath = process.env.MEDIATASTE_DIR ? join(process.env.MEDIATASTE_DIR, 'media.jsonl') : join(USER_REPO, 'MEDIA', 'media.jsonl');
  const booksPath = process.env.SPINNER_BOOKS_PATH ?? join(USER_REPO, 'BOOKS.md');
  if (!existsSync(verbsPath)) { record('spinner-verbs', [], 'skipped — no CUSTOMIZATIONS/Spinner/verbs.json (public install)'); return; }

  let verbs: string[] = [];
  try {
    const v = JSON.parse(readFileSync(verbsPath, 'utf8'));
    if (!Array.isArray(v) || !v.every(x => typeof x === 'string' && x.trim().length > 0)) throw new Error('not an array of non-empty strings');
    verbs = v;
  } catch (e: any) {
    record('spinner-verbs', [{ detail: `verbs.json unreadable: ${e?.message ?? e}`, blocking: true }]);
    return;
  }

  // 1. Case-insensitive duplicates.
  const seen = new Map<string, string>();
  for (const v of verbs) {
    const k = v.trim().toLowerCase();
    if (seen.has(k)) findings.push({ detail: `duplicate verb: "${v}" (also "${seen.get(k)}")`, blocking: true });
    else seen.set(k, v);
  }

  // 2. Source→settings parity, both hops.
  const readVerbs = (p: string): string[] | null => {
    try { return JSON.parse(readFileSync(p, 'utf8'))?.spinnerVerbs?.verbs ?? null; } catch { return null; }
  };
  const userVerbs = readVerbs(userPath);
  const liveVerbs = readVerbs(livePath);
  if (userVerbs && JSON.stringify(userVerbs) !== JSON.stringify(verbs)) {
    findings.push({ detail: `spinnerVerbs.verbs in settings.user.json (${userVerbs.length}) differs from CUSTOMIZATIONS/Spinner/verbs.json (${verbs.length}) — copy verbs.json into the settings source`, blocking: true });
  }
  if (userVerbs && liveVerbs && JSON.stringify(liveVerbs) !== JSON.stringify(userVerbs)) {
    findings.push({ detail: `spinnerVerbs.verbs in settings.json differs from settings.user.json — regenerate via MergeSettings`, blocking: true });
  }

  // 3. themes.json: every listed verb exists.
  let themes: Record<string, string[]> = {};
  if (!existsSync(themesPath)) {
    findings.push({ detail: `CUSTOMIZATIONS/Spinner/themes.json missing — favorite coverage cannot be checked`, blocking: true });
  } else {
    try { themes = JSON.parse(readFileSync(themesPath, 'utf8')).themes ?? {}; }
    catch (e: any) { findings.push({ detail: `themes.json unreadable: ${e?.message ?? e}`, blocking: true }); }
  }
  const verbSet = new Set(verbs);
  for (const [work, list] of Object.entries(themes)) {
    for (const v of list) if (!verbSet.has(v)) findings.push({ detail: `themes.json "${work}" lists "${v}" but verbs.json has no such verb`, blocking: true });
  }
  const themeOf = new Map(Object.entries(themes).map(([k, list]) => [k.toLowerCase(), list.filter(v => verbSet.has(v))]));

  // 4. Favorites from both taste sources, and dropped works whose verbs went stale.
  const favorites = new Map<string, string>(); // lowercased title → where it came from
  const soured = new Set<string>();
  if (existsSync(mediaPath)) {
    for (const line of readFileSync(mediaPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.status === 'loved') favorites.set(String(r.title).toLowerCase(), `${r.title} (loved, media.jsonl)`);
        if (r.status === 'dropped' || r.status === 'disliked') soured.add(String(r.title).toLowerCase());
      } catch { findings.push({ detail: `media.jsonl has an unparseable line`, blocking: true }); }
    }
  }
  if (existsSync(booksPath)) {
    // Only the hand-curated part rates books; the generated Cortex block below the marker carries no ratings.
    const curated = readFileSync(booksPath, 'utf8').split('<!-- cortex:begin')[0];
    for (const entry of curated.split(/\n- title:/).slice(1)) {
      const title = entry.match(/^\s*"([^"]+)"/)?.[1];
      const rating = Number(entry.match(/\n\s*rating:\s*(\d+)/)?.[1] ?? 0);
      if (title && rating >= 8 && !favorites.has(title.toLowerCase())) favorites.set(title.toLowerCase(), `${title} (rated ${rating}, BOOKS.md)`);
    }
  }
  for (const [key, label] of favorites) {
    const have = themeOf.get(key)?.length ?? 0;
    if (have < MIN_VERBS) findings.push({ detail: `favorite ${label} has ${have} spinner verbs in themes.json — needs ${MIN_VERBS}`, blocking: false });
  }
  for (const key of soured) {
    if ((themeOf.get(key)?.length ?? 0) > 0) findings.push({ detail: `themes.json still carries verbs for "${key}", which media.jsonl marks dropped or disliked`, blocking: false });
  }

  record('spinner-verbs', findings, findings.length === 0 ? `${verbs.length} verbs, ${favorites.size} favorites covered` : undefined);
}

// Count/filename parity (check 3) provably misses a hook wired to the WRONG event or to
// NO event: AlgorithmNudge/PostToolObserver/DriftReminder each declared an event in their
// header yet shipped registered nowhere on it, silently dead on every fresh install
// (public issue #1508 findings #1/#3/#4). This check parses each hook's `TRIGGER: <Event>`
// docstring line and asserts the hook is actually registered on that event — directly, or
// indirectly via a dispatcher hook that imports it and is itself registered on that event.
function checkHookWiring(): void {
  const findings: Finding[] = [];
  const hooksDir = join(CLAUDE_DIR, 'hooks');
  let settings: any;
  const settingsText = readScanInput('hook_wiring', join(CLAUDE_DIR, 'settings.json'));
  if (settingsText === null) { record('hook_wiring', [], 'SCAN ERROR (settings unreadable)'); return; }
  try { settings = JSON.parse(settingsText); }
  catch (e: any) { scanError(`hook_wiring: settings.json unparseable — ${e?.message ?? e}`); record('hook_wiring', [], 'SCAN ERROR (settings unparseable)'); return; }

  // event -> Set<hook filename> registered DIRECTLY on that event
  const directByEvent = new Map<string, Set<string>>();
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const set = new Set<string>();
    for (const g of (groups as any[]) ?? []) {
      for (const h of g?.hooks ?? []) {
        const mm = /([A-Za-z0-9_]+\.hook\.ts)/.exec(h?.command ?? '');
        if (mm) set.add(mm[1]);
      }
    }
    directByEvent.set(event, set);
  }

  // Dispatcher expansion: a registered hook that imports "./X.hook" and runs it makes X
  // effectively registered on the dispatcher's event(s). Resolve one level (dispatchers
  // don't nest today: PostToolObserver→AlgorithmNudge/per-tool members, PreToolGuard→guards).
  // A registered hook absent from hooks/ is hook_registration's finding; any other read failure
  // hides the dispatcher's members, so it is a scan error here.
  const importsMemo = new Map<string, string[]>();
  const importsOf = (file: string): string[] => {
    const known = importsMemo.get(file);
    if (known) return known;
    const path = join(hooksDir, file);
    const src = existsSync(path) ? readScanInput('hook_wiring', path) : null;
    let members: string[] = [];
    if (src !== null) {
      // Static imports, and literal dynamic imports (PreToolGuard loads its members with `import("./X.hook")`
      // so a member that fails to load refuses the call).
      const stat = [...src.matchAll(/(?:from\s+|import\(\s*)["']\.\/([A-Za-z0-9_]+\.hook)["']/g)].map(m => `${m[1]}.ts`);
      // Members a dispatcher loads by name at runtime (PostToolObserver's MEMBERS_BY_TOOL,
      // 2026-09-21): every quoted name inside that table is a member too.
      const table = /MEMBERS_BY_TOOL\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(src);
      const dyn = table ? [...table[1].matchAll(/"([A-Za-z0-9_]+)"/g)].map(m => `${m[1]}.hook.ts`) : [];
      members = [...new Set([...stat, ...dyn])];
    }
    importsMemo.set(file, members);
    return members;
  };
  const effectiveByEvent = new Map<string, Set<string>>();
  for (const [event, set] of directByEvent) {
    const eff = new Set(set);
    for (const f of set) for (const imp of importsOf(f)) eff.add(imp);
    effectiveByEvent.set(event, eff);
  }

  let declared = 0;
  let onDisk: string[] = [];
  try { onDisk = readdirSync(hooksDir).filter(f => f.endsWith('.hook.ts')); }
  catch (e: any) { scanError(`hook_wiring: cannot list ${hooksDir.replace(HOME, '~')} (${e?.code ?? e?.message ?? e}) — no hook was checked`); }
  for (const file of onDisk) {
    const src = readScanInput('hook_wiring', join(hooksDir, file));
    if (src === null) continue;
    // TRIGGER: <Event> — first alphabetic token is the primary declared event.
    const t = /TRIGGER:\s*([A-Za-z]+)/.exec(src);
    if (!t) continue;               // no declared event → can't check, skip
    const event = t[1];
    if (event.toLowerCase() === 'na' || event.toLowerCase() === 'none') continue;
    declared++;
    const eff = effectiveByEvent.get(event);
    if (!eff || !eff.has(file)) {
      findings.push({
        detail: `hooks/${file} declares TRIGGER: ${event} but is not registered on ${event} (directly or via a dispatcher) — silently dead`,
        blocking: true,
      });
    }
  }
  record('hook_wiring', findings, `${declared} hooks declare an event; ${findings.length} mis-wired`);
}

// A leading UTF-8 BOM or CRLF line endings made `^---\n` miss, so an editor that
// writes either turned a perfectly valid unit into a BLOCKING "no frontmatter
// block" finding — the file is fine, the reader was strict. Both are invisible
// in a diff, which is what made this hard to see from the report alone.
// public issue #1732, @umair-a11y; public PR #1800, @PotatoFarmerBoat
function matchFrontmatter(content: string): RegExpMatchArray | null {
  return content.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
}

// ── Check 3b: frontmatter validation for self-describing units (commands, agents) ──
// Class-sweep sibling of the skills check: every markdown unit that registers itself
// by frontmatter must carry name + description, or it decays silently.
function checkFrontmatterUnits(name: string, dir: string, requireName: boolean): void {
  const findings: Finding[] = [];
  let files: string[] = [];
  // Every .md here is a self-registering unit and must carry frontmatter. The
  // companion-doc exclusion (*Context.md) is GONE as of 2026-07-27: agent files
  // are self-contained — content shared between agents is inlined in each and
  // held identical by checkAgentSharedBlocks() below, not split into a file the
  // agent has to remember to Read.
  try { files = readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md'); } catch {
    record(name, [], `${dir.replace(CLAUDE_DIR + '/', '')} absent`); return;
  }
  for (const f of files) {
    let content = '';
    try { content = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    const fm = matchFrontmatter(content);
    if (!fm) { findings.push({ detail: `${name}/${f}: no frontmatter block`, blocking: true }); continue; }
    if (requireName && !/^name:\s*\S/m.test(fm[1])) findings.push({ detail: `${name}/${f}: missing frontmatter 'name:'`, blocking: true });
    if (!/^description:\s*\S/m.test(fm[1])) findings.push({ detail: `${name}/${f}: missing frontmatter 'description:'`, blocking: true });
  }
  record(name, findings, `${files.length} ${name} validated`);
}

// ── Check 3c: shared agent blocks stay byte-identical ──
// Agent files are self-contained (no companion Context files). Content that MUST
// read the same across agents — today the Astra/Opus/Fable scrutiny character — is
// inlined in each file between markers and held identical by this check, so the
// guarantee costs a gate rather than a runtime Read the agent might skip.
// Marker form: <!-- SHARED:<KEY> … --> … <!-- /SHARED:<KEY> -->
// A key present in only one file is fine (a block can be introduced before its
// second home exists); two or more copies that disagree is blocking.
const SHARED_BLOCK_RE = /<!--\s*SHARED:([A-Z0-9-]+)[\s\S]*?-->\n([\s\S]*?)<!--\s*\/SHARED:\1\s*-->/g;

function checkAgentSharedBlocks(): void {
  const findings: Finding[] = [];
  const dir = join(CLAUDE_DIR, 'agents');
  let files: string[] = [];
  try { files = readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md'); } catch {
    record('agent-shared-blocks', [], 'agents/ absent'); return;
  }
  // key → [{file, sha}]
  const blocks = new Map<string, { file: string; sha: string }[]>();
  for (const f of files) {
    let content = '';
    try { content = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    for (const m of content.matchAll(SHARED_BLOCK_RE)) {
      const [, key, body] = m;
      const sha = createHash('sha256').update(body).digest('hex');
      if (!blocks.has(key)) blocks.set(key, []);
      blocks.get(key)!.push({ file: f, sha });
    }
  }
  for (const [key, copies] of blocks) {
    const shas = new Set(copies.map(c => c.sha));
    if (shas.size > 1) {
      findings.push({
        detail: `SHARED:${key} diverged across ${copies.map(c => `${c.file}=${c.sha.slice(0, 8)}`).join(', ')} — edit every copy or none`,
        blocking: true,
      });
    }
  }
  const copyCount = [...blocks.values()].reduce((n, c) => n + c.length, 0);
  // Summary states what was actually observed — a failing check must never read
  // "identical" (that inversion is exactly the clean-but-blocking masquerade the
  // exit-code precedence elsewhere in this file exists to prevent).
  const verdict = findings.length ? `${findings.length} diverged` : 'identical';
  record('agent-shared-blocks', findings, `${blocks.size} shared block(s), ${copyCount} copies, ${verdict}`);
}

// ── Check 4: claude_imports (@-imports across every CLAUDE.md) ──
function checkClaudeImports(): void {
  const findings: Finding[] = [];
  const claudeMds = findFiles(CLAUDE_DIR, ['(', '-name', 'CLAUDE.md', '-o', '-name', 'CLAUDE.user.md', ')', '-type', 'f']);
  let importCount = 0;
  for (const file of claudeMds) {
    let content = '';
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      const im = line.match(/^@([^\s]+)/);
      if (!im) continue;
      importCount++;
      // Imports resolve relative to the importing file (and `~/` to HOME), as
      // Claude Code resolves them. public issue #2242, @MatiasBarboza
      const target = resolve(dirname(file), im[1].replace(/^~(?=\/)/, HOME));
      if (!existsSync(target)) {
        findings.push({ detail: `${file.replace(CLAUDE_DIR + '/', '')}: broken @-import → ${im[1]}`, blocking: true });
      }
    }
  }
  record('claude_imports', findings, `${claudeMds.length} CLAUDE.md files, ${importCount} @-imports`);
}

// ── Check 4a: claude-routing-only (CLAUDE.md is a routing table and never holds a rule) ──
// A routing row says when to load a source and where it is. A directive word or a dated
// attribution on a row or bullet means a rule moved in; its home is OPERATIONAL_PREFERENCES, the
// source's own header, or its system doc (LIFEOS/RULES/SelfHealing.md).
function checkClaudeRoutingOnly(): void {
  const findings: Finding[] = [];
  const file = join(CLAUDE_DIR, 'CLAUDE.md');
  let content = '';
  try { content = readFileSync(file, 'utf8'); } catch { record('claude-routing-only', [{ detail: 'CLAUDE.md: unreadable', blocking: true }]); return; }
  const DATED = /\([A-Z][a-z]+, \d{4}-\d{2}-\d{2}/;
  const DIRECTIVE = /(?<![\w-])(never|always|must|do not|don't)(?![\w-])/i; // "always-on" describes, it does not direct
  let rows = 0;
  content.split('\n').forEach((line, i) => {
    const isRow = /^\|/.test(line) && !/^\|[\s|:-]+\|?\s*$/.test(line) && !/^\|\s*When needed\s*\|/.test(line);
    const isBullet = /^\s*[-*] /.test(line);
    if (DATED.test(line)) findings.push({ detail: `CLAUDE.md:${i + 1}: dated directive — move the rule to OPERATIONAL_PREFERENCES`, blocking: true });
    else if ((isRow || isBullet) && DIRECTIVE.test(line)) findings.push({ detail: `CLAUDE.md:${i + 1}: rule word "${line.match(DIRECTIVE)![1]}" in a routing entry — move the rule to its home`, blocking: true });
    if (isRow || isBullet) rows++;
  });
  record('claude-routing-only', findings, `${rows} routing entries`);
}

// ── Check 4b: header-mirror (@-import strips frontmatter; its facts must be mirrored into the body) ──
function checkHeaderMirror(): void {
  try {
    const { importedFiles, staleFiles } = require("./HeaderMirror") as typeof import("./HeaderMirror");
    const files = importedFiles();
    const findings: Finding[] = staleFiles(files).map((f) => ({
      detail: `${f.replace(CLAUDE_DIR + "/", "")}: frontmatter facts missing or stale in the body — run bun LIFEOS/TOOLS/HeaderMirror.ts`,
      blocking: true,
    }));
    record("header-mirror", findings, `${files.length} auto-loaded files`);
  } catch (e: any) {
    scanError(`header-mirror: ${e?.message ?? String(e)}`);
    record("header-mirror", [], "SCAN ERROR");
  }
}

// ── Check 5: skills (SKILL.md frontmatter name+description, all depths) ──
function checkSkills(): void {
  const findings: Finding[] = [];
  const skillsDir = join(CLAUDE_DIR, 'skills');
  const skillMds = findFiles(skillsDir, ['-name', 'SKILL.md', '-type', 'f']);
  for (const skillMd of skillMds) {
    const rel = skillMd.replace(CLAUDE_DIR + '/', '');
    let content = '';
    try { content = readFileSync(skillMd, 'utf8'); } catch { continue; }
    const fmMatch = matchFrontmatter(content);
    if (!fmMatch) { findings.push({ detail: `${rel}: no frontmatter block`, blocking: true }); continue; }
    const fm = fmMatch[1];
    if (!/^name:\s*\S/m.test(fm)) findings.push({ detail: `${rel}: missing frontmatter 'name:'`, blocking: true });
    if (!/^description:\s*\S/m.test(fm)) findings.push({ detail: `${rel}: missing frontmatter 'description:'`, blocking: true });
  }
  // Structural: an Intents/ or Tools/ dir with no sibling SKILL.md is a broken skill.
  const structureDirs = findFiles(skillsDir, ['(', '-name', 'Intents', '-o', '-name', 'Tools', ')', '-type', 'd']);
  const flagged = new Set<string>();
  for (const sd of structureDirs) {
    const skillRoot = sd.slice(0, sd.lastIndexOf('/'));
    // Only a top-level skill root (skills/<name>) must carry SKILL.md. A nested content dir that
    // merely happens to contain a Tools/ or Intents/ subdir (e.g. a Templates/Tools folder inside a skill)
    // is not a skill and is exempt.
    const afterSkills = skillRoot.split('/skills/')[1];
    if (!afterSkills || afterSkills.includes('/')) continue;
    if (flagged.has(skillRoot)) continue;
    if (!existsSync(join(skillRoot, 'SKILL.md'))) {
      flagged.add(skillRoot);
      findings.push({ detail: `${skillRoot.replace(CLAUDE_DIR + '/', '')}/: has Intents/Tools but no SKILL.md`, blocking: true });
    }
  }
  // Skill routines are intents (2026-10-08): "workflow" means only a Workflows-system definition,
  // and "procedure" told the model how instead of what. A skill-level Workflows/ or Procedures/ dir
  // is an old name coming back. The Workflows skill's own root is exempt.
  for (const d of readdirSync(skillsDir)) {
    for (const old of ['Workflows', 'Procedures']) {
      const dir = join(skillsDir, d, old);
      // A signpost left for older installs that still read the old path is allowed when every file
      // in the dir is one (H1 names it a signpost): it carries no routine, only the pointer to Intents/.
      if (existsSync(dir) && !isSignpostDir(dir)) {
        findings.push({ detail: `skills/${d}/${old}/: skill routines live in Intents/; move the files there`, blocking: true });
      }
    }
  }
  record('skills', findings, `${skillMds.length} SKILL.md validated`);
}
function isSignpostDir(dir: string): boolean {
  const files = readdirSync(dir);
  return files.length > 0 && files.every(f => f.endsWith('.md') && /^# .*\bsignpost\b/i.test(readFileSync(join(dir, f), 'utf8').split('\n', 1)[0] ?? ''));
}

// ── Check 5b (verification coverage / eval-coverage): RETIRED (assay-everywhere C13, 2026-09-30) ──
// It counted per-skill SKILL.md declarations (a runnable suite, a named command, a named manual exception), so it measured
// paperwork: it read 168/168 "declared" while 107 were manual exceptions. The output-coverage check below (18) replaces it
// with the measurement that matters: receipted outputs over reconciled outputs, from the gates' ledger and OutputReconciler.
// The declaration parser (lib/SkillVerificationCoverage.ts) stays for CreateSkill and ValidateSkill; only the /ic check is gone.

// ── Check 6: intents (referenced by their SKILL.md or Context.json, nested paths included) ──
// Intents whose MUST/NEVER lines have neither a typed `contract:` nor a matching
// SKILL.md line. Advisory census, never blocking (principal, 2026-09-23): the match is
// textual, so ordinary doctrine edits trip it, and the real enforcement is the
// contract checked at tool run time (IntentContract.verify). One info line, marked
// GROWING past the baseline so growth stays visible. Lower the baseline as intents
// migrate to contracts.
const INTENT_DRIFT_BASELINE = { intents: 429, statements: 1667, at: '2026-09-23' };
function checkIntentContractDrift(): void {
  const counts = scanIntentContractDrift(join(CLAUDE_DIR, 'skills'));
  const flagged = counts.reduce((n, c) => n + c.flagged, 0);
  const statements = counts.reduce((n, c) => n + c.unmatched, 0);
  const affected = counts.filter(c => c.flagged > 0);
  const growing = flagged > INTENT_DRIFT_BASELINE.intents || statements > INTENT_DRIFT_BASELINE.statements;
  const head = `${flagged} intents / ${statements} mandatory statements without a contract or matching SKILL.md line (baseline ${INTENT_DRIFT_BASELINE.intents} / ${INTENT_DRIFT_BASELINE.statements} @ ${INTENT_DRIFT_BASELINE.at}${growing ? ', GROWING — add a contract: block or a SKILL.md constraint to the new intent' : ''})`;
  const findings: Finding[] = [];
  if (flagged > 0) {
    const detail = verbose ? `${head}; ${affected.map(c => `${c.skill} ${c.flagged}/${c.scanned}`).join('; ')}` : head;
    findings.push({ detail, blocking: false });
  }
  record('intent-contract-drift', findings,
    `${counts.reduce((n, c) => n + c.scanned, 0)} intents across ${counts.length} skills; ${affected.length} skills affected`);
}

// ── intent-lint: every intent and SKILL.md against the intent anatomy standard ──
// SkillSystem.md § Intent anatomy; ISA 20261009-intent-ideal-state ISC-18. Blocking since
// 2026-10-10 (skill-quality run), when the migration landed and the SKILL.md summary rules
// joined: every file with a lint error is its own BLOCKING finding. Setting this back to
// false restores the advisory mode (one summary info line, per-file detail under --verbose).
export const INTENT_LINT_BLOCKING = true;
function checkIntentLint(): void {
  const skillsDir = join(CLAUDE_DIR, 'skills');
  if (!existsSync(skillsDir)) { record('intent-lint', [], 'no skills directory'); return; }
  let result: ReturnType<typeof lintPaths>;
  try {
    result = lintPaths([skillsDir]);
  } catch (e) {
    scanError(`intent-lint: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const t = result.totals;
  const failing = result.files.filter(f => f.errors.length > 0);
  const findings: Finding[] = [];
  const perFile = (f: (typeof failing)[number]) =>
    `${f.path.replace(CLAUDE_DIR + '/', '')}: ${f.errors.length} error(s) — ${[...new Set(f.errors.map(e => e.rule))].join(', ')}`;
  if (INTENT_LINT_BLOCKING) {
    for (const f of failing) findings.push({ detail: perFile(f), blocking: true });
  } else if (failing.length > 0) {
    const head = `${t.errors} intent-anatomy errors in ${failing.length} files (advisory until INTENT_LINT_BLOCKING) — bun LIFEOS/TOOLS/IntentLint.ts skills`;
    findings.push({ detail: verbose ? `${head}; ${failing.map(perFile).join('; ')}` : head, blocking: false });
  }
  record('intent-lint', findings,
    `${t.files} files, ${t.errors} errors, ${t.warnings} warnings${INTENT_LINT_BLOCKING ? '' : ' (advisory)'}`);
}

// Skills converted to section-level loading (ProgressiveContext.md) route SKILL.md to
// bundles and name their intent files in Context.json `sections[*].file`; that
// manifest is a real load target, so an intent named there is not an orphan.
function checkIntents(): void {
  const findings: Finding[] = [];
  const skillsDir = join(CLAUDE_DIR, 'skills');
  const wfFiles = findFiles(skillsDir, ['-path', '*/Intents/*', '-name', '*.md', '-type', 'f']);
  const cache = new Map<string, string>();
  for (const wf of wfFiles) {
    const rel = wf.replace(CLAUDE_DIR + '/', '');
    // The skill root is the first segment under skills/, and only an Intents/ dir
    // INSIDE the skill holds intents: a skill named Intents is not itself one.
    const [skillName, ...inner] = wf.slice(skillsDir.length + 1).split('/');
    if (!inner.slice(0, -1).includes('Intents')) continue;
    const skillRoot = join(skillsDir, skillName);
    const skillMd = join(skillRoot, 'SKILL.md');
    let sc = cache.get(skillMd);
    if (sc === undefined) {
      try { sc = readFileSync(skillMd, 'utf8'); } catch { sc = ''; }
      try { sc += '\n' + readFileSync(join(skillRoot, 'Context.json'), 'utf8'); } catch {}
      cache.set(skillMd, sc);
    }
    const bn = wf.slice(wf.lastIndexOf('/') + 1);
    const base = bn.replace(/\.md$/, '');
    // referenced if SKILL.md or Context.json mentions the filename or the bare intent name
    if (!sc.includes(bn) && !sc.includes(base)) {
      findings.push({ detail: `${rel}: not referenced by its SKILL.md or Context.json (orphan intent)`, blocking: false });
    }
  }
  record('intents', findings, `${wfFiles.length} intent files, ${findings.length} orphaned`);
}

async function checkWorkflowInventory(): Promise<void> {
  const inventoryFile = join(CLAUDE_DIR, 'LIFEOS/WORKFLOWS/Inventory.ts');
  const configDir = join(CLAUDE_DIR, 'LIFEOS/USER/CONFIG');
  if (!existsSync(inventoryFile) || !existsSync(configDir)) return;
  const findings: Finding[] = [];
  try {
    const { buildInventory } = await import('../WORKFLOWS/Inventory.ts');
    const inventory = buildInventory();
    for (const f of inventory.findings.filter(f => f.kind === 'missing' || f.kind === 'orphan')) {
      findings.push({ detail: `${f.kind}: ${f.ids.join(', ')} — ${f.sentence}`, blocking: !f.acknowledged });
    }
    record('workflow-inventory', findings, `${inventory.records.length} workflows; ${findings.filter(f => f.blocking).length} unacknowledged missing or orphan`);
  } catch (e) {
    scanError(`workflow-inventory: ${String(e).slice(0, 120)}`);
    record('workflow-inventory', findings, 'SCAN ERROR');
  }
}

// Nothing runs outside Workflows (principal directive, 2026-10-22). Every scheduled or
// event-started launchd job, agent job or Pulse cron is a blocking finding until it is a typed definition, and an
// inventory acknowledgement never silences it. Always-on services are listed, non-blocking, until their place is decided.
async function checkOutsideWorkflows(): Promise<void> {
  const inventoryFile = join(CLAUDE_DIR, 'LIFEOS/WORKFLOWS/Inventory.ts');
  if (!existsSync(inventoryFile)) return;
  const findings: Finding[] = [];
  try {
    const { buildInventory } = await import('../WORKFLOWS/Inventory.ts');
    const outside = buildInventory().findings.filter(f => f.kind === 'outside-workflows');
    for (const f of outside) findings.push({ detail: f.sentence, blocking: f.severity === 'high' });
    record('outside-workflows', findings, `${findings.filter(f => f.blocking).length} scheduled or event jobs and ${findings.filter(f => !f.blocking).length} services run outside Workflows`);
  } catch (e) {
    scanError(`outside-workflows: ${String(e).slice(0, 120)}`);
    record('outside-workflows', findings, 'SCAN ERROR');
  }
}

// Claude Code workflow scripts (workflows/*.js) are TitleCase and match their meta.name, on disk AND in the git
// index: a case-only rename landed with `git add` on a case-insensitive checkout keeps the old index name, so the
// disk looks right and the commit does not (WorkflowNames.ts; ISA 20261002-development-on-workflows-build ISC-78).
function checkWorkflowNames(): void {
  const dir = join(CLAUDE_DIR, "workflows");
  if (!existsSync(dir)) return;
  const findings: Finding[] = [];
  try {
    const tracked = isGitCheckout() ? (trackedWorkflowFiles(dir) ?? undefined) : undefined;
    const report = checkWorkflowDir(dir, { tracked });
    for (const v of report.violations) {
      findings.push({ detail: `workflows/${v.file}: ${v.problem}${v.metaName !== null ? ` (meta.name: ${v.metaName})` : ""}`, blocking: true });
    }
    if (report.checked === 0) findings.push({ detail: "workflows/: no workflow scripts found", blocking: true });
    record("workflow-names", findings, `${report.checked} workflow scripts${tracked ? `, ${tracked.length} tracked` : ", index not read"}`);
  } catch (e) {
    scanError(`workflow-names: ${String(e).slice(0, 120)}`);
    record("workflow-names", findings, "SCAN ERROR");
  }
}

// SendGate tripwire: every output-ledger line decided `overridden` must trace to a signed entry in the mint log
// (a principal prompt minted it). A mismatch means a token or a ledger line was forged; auditOverrides also emits a
// critical Vigil event. Uid is the boundary: this is the detector half of the deterrent.
async function checkSendGateOverrides(): Promise<void> {
  const findings: Finding[] = [];
  try {
    const emit = loadVigilEmit();
    const r = auditOverrides({ emit: (e) => { try { emit?.(e as never); } catch { /* the outbox is best effort */ } } });
    for (const u of r.unmatched) findings.push({ detail: `overridden send ${u.sha.slice(0, 12)} at ${u.ts} has no matching mint`, blocking: true });
    record('send-gate-overrides', findings, `${r.checked} overridden send(s); ${r.unmatched.length} without a mint`);
  } catch (e) {
    scanError(`send-gate-overrides: ${String(e).slice(0, 120)}`);
    record('send-gate-overrides', findings, 'SCAN ERROR');
  }
}

// Output coverage (assay-everywhere ISC-29, ISC-12, ISC-41): OutputReconciler builds the denominator from files in
// Downloads/Desktop, tool-activity writes, push reflogs, the deploy ledger and mail sends, never from the gates' own log,
// and matches it to the output ledger. Escapes and per-skill gaps are reported, never blocking: ISC-12 is a trend to
// zero, not a gate. The check emits the one Vigil event (escape count; medium when the DA produced an unreceipted output).
// Seams for tests: LIFEOS_RECONCILER_HOME (root holding Downloads, Desktop, Projects) and LIFEOS_RECONCILER_SINCE.
async function checkOutputCoverage(): Promise<void> {
  const findings: Finding[] = [];
  try {
    const rec = await import('./OutputReconciler.ts');
    const r = rec.reconcile({ sinceMs: rec.parseSince(process.env.LIFEOS_RECONCILER_SINCE ?? '24h'), home: process.env.LIFEOS_RECONCILER_HOME });
    try { await rec.emitVigil(r); } catch { /* the outbox is best effort */ }
    for (const skill of r.gaps) findings.push({ detail: `skill ${skill} has outputs and no receipts in the last 24h`, blocking: false });
    if (r.attributed_escapes > 0) findings.push({ detail: `${r.attributed_escapes} DA-produced output(s) reconciled with no ledger line (${r.by_channel.filter((c: { escapes: number }) => c.escapes > 0).map((c: { channel: string; escapes: number }) => `${c.channel} ${c.escapes}`).join(', ')})`, blocking: false });
    record('output-coverage', findings, `${r.reconciled} reconciled, ${r.receipted} receipted, coverage ${r.coverage === null ? 'n/a' : r.coverage + '%'}, ${r.escapes} escapes; ${rec.trendSummary(process.env.LIFEOS_RECONCILER_HOME)}`);
  } catch (e) {
    scanError(`output-coverage: ${String(e).slice(0, 120)}`);
    record('output-coverage', findings, 'SCAN ERROR');
  }
}

// Record coverage (STATVS ISA F16, step 1 dual-write): the quality loop's seven streams are written at their choke
// points, so the record can be checked against the stores it shadows. Two rules, both blocking:
//   1. every skill run in execution.jsonl in the last 7 days, after the cutover (the first skill-run row on the record),
//      has a skill-run row with the same run_id; runs from the last 5 minutes are skipped, the hook writes async;
//   2. no stream has gone longer than its expected cadence without a row while the install was active. A stream with no
//      row in the window that was written before it is measured from the day the streams were registered. A stream never
//      written at all is reported (info) as one this install has not used yet, except skill-run when execution.jsonl
//      shows skill runs: that one is measured from the later of registration and the install's first activity. Activity is any quality row on the record, any
//      skill run in execution.jsonl, and the tool-activity log, which a hook writes on every tool call outside STATVS. A
//      stream counts as silent only when that activity ran past its cadence, so a fresh install with no activity, or one
//      nobody has used since its last rows, passes, while a choke point that stops on an install still in use blocks.
// A choke point that stopped writing also writes one Vigil event per stream per day through STATVS writeEventOnce.
// Reads only the quality writers' own daily segment files and stats the tool-activity log, never the whole record.
// Seams for tests: STATVS_DIR, RECORD_COVERAGE_EXECUTION (the execution.jsonl path), RECORD_COVERAGE_ACTIVITY (the
// tool-activity log path), RECORD_COVERAGE_NOW (ISO), VIGIL_STATE_DIR.
export const QUALITY_CADENCE_HOURS: Readonly<Record<string, number>> = Object.freeze({
  'skill-run': 24, 'tool-run': 24, output: 72, errata: 72, label: 168, receipt: 168, render: 336,
});
/** The day the seven streams were registered (streams.ts 1.3.0): a stream with no row is measured from here. */
export const QUALITY_STREAMS_REGISTERED = '2026-10-25T08:00:00Z';
const RUN_WINDOW_MS = 7 * 86_400_000;
const RUN_GRACE_MS = 5 * 60_000;

export type RecordCoverage = {
  cutover: string | null; runs: number; matched: number; missing: Array<{ run_id: string; skill: string; ts: string }>;
  /** The install's first and last activity seen (quality rows, skill runs, the tool-activity log), null when there is none. */
  first_activity: string | null; last_activity: string | null;
  streams: Array<{ stream: string; last: string | null; silent_hours: number; cadence_hours: number; silent: boolean; never: boolean }>;
};

/** The record-coverage reading. Reads only; checkRecordCoverage turns it into findings and events. */
export async function recordCoverage(nowMs: number = Date.now()): Promise<RecordCoverage> {
  const { statvsDir, writerSlug } = await import('../STATVS/lib/record');
  const { QUALITY_WRITERS } = await import('../STATVS/lib/quality');
  const base = join(statvsDir(), 'personal');
  const maxCadence = Math.max(...Object.values(QUALITY_CADENCE_HOURS)) * 3_600_000;
  const fromDay = new Date(nowMs - Math.max(maxCadence, RUN_WINDOW_MS) - 86_400_000).toISOString().slice(0, 10);
  let allDays: string[] = [];
  try { allDays = readdirSync(base).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(); } catch { /* no record yet */ }
  const days = allDays.filter((d) => d >= fromDay);
  // Activity, from rows already read plus one stat: the earliest and latest moment the install did anything.
  let firstAct = Infinity, lastAct = -Infinity;
  const saw = (ms: number) => { if (Number.isFinite(ms) && ms <= nowMs) { firstAct = Math.min(firstAct, ms); lastAct = Math.max(lastAct, ms); } };
  const last: Record<string, string | null> = {};
  const skillRunIds = new Set<string>();
  let firstSkillRun: string | null = null;
  for (const [stream, writer] of Object.entries(QUALITY_WRITERS)) {
    last[stream] = null;
    for (const day of days) {
      let body: string;
      try { body = readFileSync(join(base, day, `${writerSlug(writer)}.jsonl`), 'utf8'); } catch { continue; }
      for (const line of body.split('\n')) {
        if (!line) continue;
        let row: { stream?: string; ts?: string; data?: Record<string, unknown> };
        try { row = JSON.parse(line); } catch { continue; }
        if (row.stream !== stream || typeof row.ts !== 'string') continue;
        saw(Date.parse(row.ts));
        if (!last[stream] || row.ts > last[stream]!) last[stream] = row.ts;
        if (stream === 'skill-run') {
          if (!firstSkillRun || row.ts < firstSkillRun) firstSkillRun = row.ts;
          if (typeof row.data?.run_id === 'string') skillRunIds.add(row.data.run_id);
        }
      }
    }
  }
  const cutover = firstSkillRun;
  const execPath = process.env.RECORD_COVERAGE_EXECUTION || join(LIFEOS_DIR, 'MEMORY', 'SKILLS', 'execution.jsonl');
  const missing: RecordCoverage['missing'] = [];
  let runs = 0, matched = 0;
  let skillActivity = false;
  let text = '';
  try { text = readFileSync(execPath, 'utf8'); } catch { /* no runs */ }
  const from = cutover ? Math.max(Date.parse(cutover), nowMs - RUN_WINDOW_MS) : Infinity;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let r: { ts?: string; run_id?: string; skill?: string };
    try { r = JSON.parse(line); } catch { continue; }
    const t = Date.parse(r.ts ?? '');
    if (Number.isFinite(t) && t >= nowMs - RUN_WINDOW_MS) { saw(t); if (t <= nowMs - RUN_GRACE_MS) skillActivity = true; }
    if (!Number.isFinite(t) || t < from || t > nowMs - RUN_GRACE_MS || typeof r.run_id !== 'string') continue;
    runs++;
    if (skillRunIds.has(r.run_id)) matched++;
    else missing.push({ run_id: r.run_id, skill: String(r.skill ?? '?'), ts: r.ts! });
  }
  const activityLog = process.env.RECORD_COVERAGE_ACTIVITY || join(LIFEOS_DIR, 'MEMORY', 'OBSERVABILITY', 'tool-activity.jsonl');
  try {
    const st = statSync(activityLog);
    if (st.size > 0) { saw(Math.min(st.mtimeMs, nowMs)); if (st.birthtimeMs > 0) saw(st.birthtimeMs); }
  } catch { /* no tool activity log */ }
  const active = Number.isFinite(lastAct);
  const registered = Date.parse(QUALITY_STREAMS_REGISTERED);
  const streams = Object.entries(QUALITY_WRITERS).map(([stream, writer]) => {
    const cadence_hours = QUALITY_CADENCE_HOURS[stream] ?? 24;
    // A stream with no row in the window is measured from registration when it was written before the window, or, with
    // no row ever, from the install's first activity. A stream never written at all blocks only where its own activity
    // shows: skill runs in execution.jsonl for skill-run. Any other never-written stream is one this install has not
    // used yet, so it stays info.
    const everWritten = !!last[stream] || allDays.some((d) => d < fromDay && existsSync(join(base, d, `${writerSlug(writer)}.jsonl`)));
    const since = last[stream] ? Date.parse(last[stream]!) : everWritten ? registered : Math.max(registered, active ? firstAct : registered);
    const silent_hours = Math.max(0, (nowMs - since) / 3_600_000);
    const relevant = everWritten || (stream === 'skill-run' && skillActivity);
    // Silent only while the install kept working: activity ran past the cadence after this stream's last row.
    const silent = active && relevant && (lastAct - since) / 3_600_000 > cadence_hours;
    return { stream, last: last[stream] ?? null, silent_hours: Math.round(silent_hours * 10) / 10, cadence_hours, silent, never: !last[stream] };
  });
  return { cutover, runs, matched, missing, streams, first_activity: active ? new Date(firstAct).toISOString() : null, last_activity: active ? new Date(lastAct).toISOString() : null };
}

async function checkRecordCoverage(): Promise<void> {
  const findings: Finding[] = [];
  try {
    const nowMs = process.env.RECORD_COVERAGE_NOW ? Date.parse(process.env.RECORD_COVERAGE_NOW) : Date.now();
    invariant(Number.isFinite(nowMs), 'RECORD_COVERAGE_NOW must be an ISO time');
    const c = await recordCoverage(nowMs);
    const day = new Date(nowMs).toISOString().slice(0, 10);
    const stopped: Array<{ stream: string; summary: string }> = [];
    if (c.missing.length) {
      const shown = c.missing.slice(0, 5).map((m) => `${m.skill} ${m.run_id} at ${m.ts}`).join('; ');
      findings.push({ detail: `${c.missing.length} of ${c.runs} skill run(s) in execution.jsonl since the cutover have no skill-run row on the record: ${shown}${c.missing.length > 5 ? ', …' : ''}`, blocking: true });
      stopped.push({ stream: 'skill-run', summary: `${c.missing.length} of ${c.runs} skill runs since the cutover are missing from the record's skill-run stream.` });
    }
    for (const s of c.streams) {
      if (s.silent) {
        findings.push({ detail: `stream ${s.stream} silent ${s.silent_hours} h (expected at least one row every ${s.cadence_hours} h)${s.never ? '; it has never been written' : `; last row ${s.last}`}`, blocking: true });
        stopped.push({ stream: s.stream, summary: `The ${s.stream} stream has had no row for ${s.silent_hours} hours; its choke point writes at least every ${s.cadence_hours} hours.` });
      } else if (s.never) findings.push({ detail: `stream ${s.stream} has no rows yet (${s.silent_hours} h since registration, cadence ${s.cadence_hours} h)`, blocking: false });
    }
    if (stopped.length) {
      try {
        const { writeEventOnce } = await import('../STATVS/lib/event');
        for (const st of stopped) {
          const r = writeEventOnce({ source: 'integrity', ts: new Date(nowMs).toISOString(), kind: 'infra', severity: 'medium', title: `STATVS ${st.stream} stream stopped writing`, summary: st.summary, ref: `statvs:${st.stream}`, url: null, privacy_class: 'personal', dedup_key: `statvs-choke-point:${st.stream}:${day}` });
          if (!r.ok) findings.push({ detail: `the Vigil event for ${st.stream} was refused: ${r.refused}`, blocking: false });
        }
      } catch (e) { findings.push({ detail: `the Vigil event for a stopped choke point was not written: ${String(e).slice(0, 120)}`, blocking: false }); }
    }
    const live = c.streams.filter((s) => !s.never).length;
    record('record-coverage', findings, `cutover ${c.cutover ?? 'none yet'}; ${c.matched}/${c.runs} skill runs on the record (7 d); ${live}/${c.streams.length} streams written; last activity ${c.last_activity ?? 'none'}`);
  } catch (e) {
    scanError(`record-coverage: ${String(e).slice(0, 160)}`);
    record('record-coverage', findings, 'SCAN ERROR');
  }
}

// Check: doc-related (assay-everywhere ISC-38). The quality loop's component docs all end with a `## Related` section
// whose first bullet links the concept doc (HillClimbing.md), so a reader of any component can climb to the one loop.
// A fixed list, because these are the loop's components, not every doc. Headings inside code fences do not count.
// DOC_RELATED_DIR points the check at a fixture tree for the test. Missing or malformed docs block.
const LOOP_COMPONENT_DOCS = [
  'Assay/AssaySystem.md', 'Assay/Records.md', 'ISA/ISASystem.md', 'ISA/ISAFormat.md',
  'Bunker/BunkerSystem.md', 'Testing/TestingDoctrine.md', 'Errata/ErrataSystem.md', 'Upgrades/UpgradesSystem.md',
  'Vigil/VigilSystem.md', 'Algorithm/AlgorithmSystem.md', 'LifeosSystemArchitecture.md',
];
export function relatedProblem(text: string): string | null {
  const lines = text.split('\n');
  let fenced = false;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i]!)) { fenced = !fenced; continue; }
    if (!fenced && /^## /.test(lines[i]!)) last = i;
  }
  if (last < 0) return 'has no ## section';
  if (lines[last]!.trim() !== '## Related') return `ends with "${lines[last]!.trim()}", not "## Related"`;
  const first = lines.slice(last + 1).find(l => /^\s*[-*] /.test(l));
  if (!first) return '## Related has no bullets';
  if (!first.includes('HillClimbing.md')) return 'first ## Related bullet does not link HillClimbing.md';
  return null;
}
function checkDocRelated(): void {
  const findings: Finding[] = [];
  const root = process.env.DOC_RELATED_DIR ?? DOC_DIR;
  try {
    for (const rel of LOOP_COMPONENT_DOCS) {
      const path = join(root, rel);
      if (!existsSync(path)) { findings.push({ detail: `${rel}: missing`, blocking: true }); continue; }
      const problem = relatedProblem(readFileSync(path, 'utf8'));
      if (problem) findings.push({ detail: `${rel}: ${problem}`, blocking: true });
    }
    record('doc-related', findings, findings.length === 0 ? `${LOOP_COMPONENT_DOCS.length} component docs end with ## Related linking HillClimbing.md` : undefined);
  } catch (e) {
    scanError(`doc-related: ${String(e).slice(0, 120)}`);
    record('doc-related', findings, 'SCAN ERROR');
  }
}

// ISC-90: every definition in the definitions home must validate (the same rules as
// `workflow.ts validate`). An invalid one blocks; an absent home is a clean, empty section.
async function checkWorkflowDefinitions(): Promise<void> {
  const findings: Finding[] = [];
  try {
    const { validateDefinitions } = await import('../WORKFLOWS/sources/validate.ts');
    const report = await validateDefinitions();
    for (const v of report.verdicts.filter(v => !v.valid)) {
      findings.push({ detail: `${v.file}: invalid definition — ${v.errors[0] ?? 'unknown error'}${v.errors.length > 1 ? ` (+${v.errors.length - 1} more)` : ''}`, blocking: true });
    }
    record('workflow-definitions', findings,
      report.present ? `${report.verdicts.length} definitions; ${findings.length} invalid` : 'no definitions home');
  } catch (e) {
    scanError(`workflow-definitions: ${String(e).slice(0, 120)}`);
    record('workflow-definitions', findings, 'SCAN ERROR');
  }
}

// ── Check: carrier-probe freshness (CarrierProbe --check, zero spend) ──
// The DISPATCH_EXECUTES_FABLE fact in models.ts underpins the Fable-carrier
// rule, the statusline dispatch mapping, and Algorithm §Spend. It flipped
// silently on a harness update once (2026-07-12); this gate keeps it probed.
function checkCarrierProbe(): void {
  const findings: Finding[] = [];
  try {
    execFileSync('bun', [join(CLAUDE_DIR, 'LIFEOS', 'TOOLS', 'CarrierProbe.ts'), '--check'], { encoding: 'utf8' });
  } catch (e: any) {
    const msg = (e.stderr || e.stdout || e.message || '').toString().trim().split('\n')[0];
    findings.push({ detail: msg || 'CarrierProbe --check failed', blocking: true });
  }
  record('carrier-probe', findings, findings.length === 0 ? 'fact fresh' : undefined);
}

// ── Check: model-sync freshness (ModelSync --check, zero spend) ──
// The Claude lineup (models.ts CURRENT) and price table (model-pricing.json) are
// generated from Anthropic's public docs by ModelSync — daily via
// com.lifeos.modelsync, on demand from ModelDriftGuard. This gate fails when the
// snapshot is >14d old, the registry trails the docs lineup, a CURRENT id has no
// price row, or the settings.json carrier fell behind the registry (the one pin
// only `/model` can move — reported, never rewritten).
function checkModelSync(): void {
  const findings: Finding[] = [];
  try {
    execFileSync('bun', [join(CLAUDE_DIR, 'LIFEOS', 'TOOLS', 'ModelSync.ts'), '--check'], { encoding: 'utf8' });
  } catch (e: any) {
    const lines = (e.stderr || e.stdout || e.message || '').toString().trim().split('\n').filter(Boolean);
    for (const line of lines) findings.push({ detail: line, blocking: !/^ModelSync: carrier:/.test(line) });
    if (findings.length === 0) findings.push({ detail: 'ModelSync --check failed', blocking: true });
  }
  record('model-sync', findings, findings.length === 0 ? 'lineup + prices fresh' : undefined);
}

// ── Check: rule duplication — every rule has ONE home ──
// The 2026-07-26 rule-structure consolidation gave every rule exactly one file
// (system prompt = constitution + pointers; LIFEOS/RULES/<Subject>.md = the sole
// full statement; doctrine cites incidents by ID). Multi-homed rules drift into
// contradictions the Context Hierarchy silently resolves against the newer rule
// (the 2026-07-26 role-routing outranking incident). This check keeps rules
// single-homed mechanically: any run of RULE_SHINGLE_WORDS identical words
// appearing in two different rule surfaces is a duplicate — the fix is one full
// statement + a pointer, never a second copy.
const RULE_SURFACES: readonly string[] = [
  'LIFEOS/LIFEOS_SYSTEM_PROMPT.md',
  'CLAUDE.md',
  'LIFEOS/ALGORITHM/LATEST', // sentinel — expands to the current doctrine file
  'LIFEOS/ALGORITHM/AlgorithmReference.md',
  'LIFEOS/RULES', // sentinel — expands to every .md in the dir
  'LIFEOS/USER/CONFIG/OPERATIONAL_PREFERENCES.md',
];

function ruleSurfaceFiles(): string[] {
  const out: string[] = [];
  for (const rel of RULE_SURFACES) {
    const abs = join(CLAUDE_DIR, rel);
    if (rel === 'LIFEOS/ALGORITHM/LATEST') {
      if (!existsSync(abs)) continue;
      const v = readFileSync(abs, 'utf8').trim();
      const doctrine = join(CLAUDE_DIR, 'LIFEOS', 'ALGORITHM', `v${v}.md`);
      if (existsSync(doctrine)) out.push(doctrine);
    } else if (rel === 'LIFEOS/RULES') {
      if (!existsSync(abs)) continue;
      for (const f of readdirSync(abs)) if (f.endsWith('.md')) out.push(join(abs, f));
    } else if (existsSync(abs)) {
      out.push(abs);
    }
  }
  return out;
}

function checkRuleDuplication(): void {
  const findings: Finding[] = [];
  const files = ruleSurfaceFiles().map((abs) => ({
    rel: abs.startsWith(CLAUDE_DIR) ? abs.slice(CLAUDE_DIR.length + 1) : abs,
    content: readFileSync(abs, 'utf8'),
  }));
  for (const d of findRuleDuplicates(files)) {
    findings.push({ detail: `${d.pair} — "${d.snippet.split(' ').slice(0, 16).join(' ')}…" stated in both; keep ONE home + a pointer`, blocking: true });
  }
  record('rule-duplication', findings, findings.length === 0 ? `${files.length} rule surfaces, single-homed` : undefined);
}

// ── Check: incident-replay corpus (executable immune memory) ──
// Every applied self-healing patch ships a replay fixture proving the original
// incident is still caught (test/regression/). A red fixture means a gate
// regressed on the exact failure that created it — always blocking. The gates
// rotted silently before this wire-up (the golden corpus's block-assertions
// were vacuous for an unknown period — 2026-07-13 piped-stdio finding).
function checkReplayCorpus(): void {
  const findings: Finding[] = [];
  let note: string | undefined;
  // Same reason as checkRetirementRegistry: the replay fixtures live in the
  // private source tree and are stripped from every public release. Without this
  // guard `bun test` exited non-zero with no (fail) lines on every public
  // install, recording a BLOCKING finding for a directory that is not supposed to
  // exist there — a permanently red /ic on a clean install.
  // ported from public PR #1737, @elhoim; public issue #1814, @tzioup
  if (!existsSync(join(CLAUDE_DIR, 'test', 'regression'))) {
    record('replay-corpus', [], 'skipped — replay corpus not installed');
    return;
  }
  try {
    const out = execFileSync('bun', ['test', join(CLAUDE_DIR, 'test', 'regression')], {
      encoding: 'utf8', cwd: CLAUDE_DIR, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
    });
    note = (out.match(/\d+ pass/)?.[0] ?? 'pass') + ', 0 fail';
  } catch (e: any) {
    const out = ((e.stdout || '') + (e.stderr || '')).toString();
    const fails = out.match(/^\(fail\).*$/gm) ?? [];
    if (fails.length === 0 && !/\d+ fail/.test(out)) {
      findings.push({ detail: `replay corpus could not run: ${(e.message || '').split('\n')[0]}`, blocking: true });
    }
    for (const f of fails.slice(0, 10)) {
      findings.push({ detail: `replay regression: ${f.replace(/^\(fail\)\s*/, '')}`, blocking: true });
    }
    if (findings.length === 0) findings.push({ detail: 'replay corpus failed (unparsed bun test output)', blocking: true });
  }
  record('replay-corpus', findings, note);
}

// ── Check: retired harness-API tokens (BLE capability-surfacing cleanup, 2026-07-21) ──
// Hand-maintained capability manuals rot against the live tool surface: the Delegation
// skill was still teaching Task()/TeamCreate/max_turns months after the harness retired
// them, and the routing index sent parallel-work prompts straight to it. Live doc surfaces
// must not reference retired harness APIs. History is exempt by marker, not by path list:
// a file whose first 1KB contains "RETIRED" is a history document and may describe the past.
// Add tokens here when the harness retires an API; never add live tool names (TaskList,
// TaskCreate, TaskStop are current; TaskOutput was retired by Claude Code 2.1.277 — "TeamCreate" is not a prefix collision).
// `Task({` was added 2026-07-27: the existing `Task(subagent_type` token only
// matched the single-line form, so 113 dispatches written as `Task({ subagent_type:`
// or `Task({\n  subagent_type:` sat in live intents (all six osint skill lookups, four
// Research intents, AgentSystem.md itself) teaching a tool that no longer exists.
// The `(?<![A-Za-z])` guard in the fix pass is the reason `createTask({` is not a
// collision here — indexOf is substring-based, so the token must stay this specific.
// '7-phase execution engine' and 'Relationship context' added 2026-08-17 (7.44.0
// cut, cross-vendor audit): both survived in LifeosSystemArchitecture.md as live
// descriptions of retired machinery (7-station walk retired 2026-07-14; the
// relationship-notes reader removed 2026-08-17). Zero live hits at add time.
const RETIRED_TOKENS = ['TeamCreate', 'Task(subagent_type', 'Task({', 'max_turns', 'team_name=', '7-phase execution engine', 'Relationship context', 'TaskOutput'];
// Registry pass (20261009-release-rebuild ISC-25/ISC-58, integration fix round): the harness
// tokens above are one list; the retirement registry RETIRED_CAPABILITIES.json is the other, and
// before this pass /ic never read it here. G19 read it only over the release payload, so a live
// mention of a retired intent in hooks/ or LIFEOS/TOOLS/ (which the payload filters or rewrites)
// passed every check. This pass loads every registry token and allow context and matches them
// line by line exactly as G19 does (private-maintenance-tooling-not-included/Release/scan.ts: case-sensitive token, allow
// contexts case-insensitive, the same removal-note markers), over the doc surfaces above plus
// hooks/ and LIFEOS/TOOLS/ with .ts included.
// Verbatim copy of REMOVAL_NOTE_MARKERS in private-maintenance-tooling-not-included/Release/scan.ts (G19). A line carrying
// one of these is a dated removal note, not a live reference.
const RETIRED_REMOVAL_NOTE_MARKERS = /since removed|removed 20\d\d|deleted 20\d\d|renamed from|\(removed\)|\bREMOVED\b|no longer (?:ship|exist|used)|deprecated 20\d\d|retired 20\d\d|— removed|historical/i;
// A history document says RETIRED as a word in its first 1KB. The bare substring test the harness
// pass uses also matched "RETIRED_CAPABILITIES", so a file merely citing the registry in its
// header was exempt wholesale; the registry pass takes the word form only.
const RETIRED_HISTORY_MARKER = /\bRETIRED\b/;
// Tests and fixtures plant retired names on purpose to prove the gates catch them; they are not
// live surfaces. Exempt by shape, never by listing files.
const RETIRED_TEST_FILE = /\.test\.ts$|\/tests?\//;
const RETIRED_REPORT_CAP = 40;
interface RetiredCapabilityRow { id: string; token: RegExp; allow: RegExp[]; publicOnly: boolean }
/** The retirement registry as compiled matchers; null when it cannot be read (a scan error is recorded). */
function loadRetiredCapabilities(): RetiredCapabilityRow[] | null {
  const registry = join(CLAUDE_DIR, 'skills', '_LIFEOS', 'RETIRED_CAPABILITIES.json');
  if (!existsSync(registry)) {
    // A public install ships no _LIFEOS skill and so no registry; a private tree with the skill
    // but no registry is broken, never silently clean.
    if (existsSync(join(CLAUDE_DIR, 'skills', '_LIFEOS', 'SKILL.md'))) scanError('retired-tokens: private-maintenance-tooling-not-included/RETIRED_CAPABILITIES.json is missing');
    return null;
  }
  let parsed: any;
  try { parsed = JSON.parse(readFileSync(registry, 'utf8')); }
  catch (e: any) { scanError(`retired-tokens: cannot parse RETIRED_CAPABILITIES.json: ${e?.message ?? e}`); return null; }
  if (!Array.isArray(parsed?.capabilities)) { scanError('retired-tokens: RETIRED_CAPABILITIES.json has no capabilities array'); return null; }
  const rows: RetiredCapabilityRow[] = [];
  for (const c of parsed.capabilities) {
    if (typeof c?.token !== 'string' || c.token === '') continue;
    try {
      rows.push({ id: String(c.id ?? c.token), token: new RegExp(c.token), allow: (Array.isArray(c.allow) ? c.allow : []).map((a: string) => new RegExp(a, 'i')), publicOnly: c.scope === 'public' });
    } catch (e: any) { scanError(`retired-tokens: registry entry "${c.id}" has an invalid regex: ${e?.message ?? e}`); }
  }
  if (rows.length === 0) scanError('retired-tokens: RETIRED_CAPABILITIES.json yields no tokens');
  return rows;
}
/**
 * Whether a file reaches the public payload, for registry entries with scope "public" (live here, kept
 * out of the release). Classified public by Release/classification.txt, or a RELEASE_TEMPLATES overlay
 * whose CUSTOMIZATIONS/SKILLS/<X> skill ships. A scan error, never "ships nothing", when the rules fail.
 */
async function releaseShipsPredicate(label = 'retired-tokens'): Promise<((abs: string) => boolean) | null> {
  const rel = (abs: string) => abs.replace(CLAUDE_DIR + '/', '');
  const classifier = join(CLAUDE_DIR, 'skills', '_LIFEOS', 'Release', 'classify.ts');
  // No release machinery in this tree: nothing says what ships, so every file is treated as shipping (strict).
  if (!existsSync(classifier)) return () => true;
  try {
    const mod = await import(classifier);
    const { rules, errors } = mod.loadRules(join(CLAUDE_DIR, 'skills', '_LIFEOS', 'Release', 'classification.txt'));
    if (errors.length) { scanError(`${label}: classification.txt has ${errors.length} parse error(s)`); return null; }
    const isPublic = (p: string) => mod.classify([p], rules)[0]?.verdict === 'public';
    const TEMPLATES = 'private-maintenance-tooling-not-included/RELEASE_TEMPLATES/';
    return (abs: string) => {
      const p = rel(abs);
      if (!p.startsWith(TEMPLATES)) return isPublic(p);
      const skill = p.match(/CUSTOMIZATIONS\/SKILLS\/([^/]+)\//)?.[1];
      return !skill || isPublic(`skills/${skill}/SKILL.md`) || isPublic(`skills/_${skill.toUpperCase()}/SKILL.md`);
    };
  } catch (e: any) { scanError(`${label}: cannot load the release classification: ${e?.message ?? e}`); return null; }
}
async function checkRetiredTokens(): Promise<void> {
  const findings: Finding[] = [];
  const docRoots: string[] = [
    join(CLAUDE_DIR, 'skills'),
    join(CLAUDE_DIR, 'LIFEOS', 'DOCUMENTATION'),
    join(CLAUDE_DIR, 'agents'),
    join(CLAUDE_DIR, 'commands'),
  ];
  const files: string[] = [];
  for (const root of docRoots) {
    files.push(...findFiles(root, ['-type', 'f', '(', '-name', '*.md', '-o', '-name', '*.hbs', ')']));
  }
  files.push(join(CLAUDE_DIR, 'CLAUDE.md'), join(CLAUDE_DIR, 'LIFEOS', 'LIFEOS_SYSTEM_PROMPT.md'));
  // Only the CURRENT doctrine file is live; old versions, modes/, and the changelog are history.
  try {
    const v = readFileSync(join(CLAUDE_DIR, 'LIFEOS', 'ALGORITHM', 'LATEST'), 'utf8').trim();
    if (v) files.push(join(CLAUDE_DIR, 'LIFEOS', 'ALGORITHM', `v${v}.md`));
  } catch { scanError('retired-tokens: could not read ALGORITHM/LATEST'); }

  // Harness-API tokens: doc surfaces only (unchanged).
  let scanned = 0;
  for (const f of files) {
    let text = '';
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    if (text.slice(0, 1024).includes('RETIRED')) continue; // history marker — exempt
    scanned++;
    for (const token of RETIRED_TOKENS) {
      let idx = text.indexOf(token);
      while (idx !== -1 && findings.length < 20) {
        const line = text.slice(0, idx).split('\n').length;
        findings.push({ detail: `${f.replace(CLAUDE_DIR + '/', '')}:${line} references retired harness API "${token}"`, blocking: true });
        idx = text.indexOf(token, idx + 1);
      }
    }
  }

  // Registry tokens: the doc surfaces plus hooks/ and LIFEOS/TOOLS/, code included.
  const registry = loadRetiredCapabilities();
  let regScanned = 0;
  let regHits = 0;
  if (registry) {
    const codeFiles: string[] = [];
    for (const root of [join(CLAUDE_DIR, 'hooks'), join(CLAUDE_DIR, 'LIFEOS', 'TOOLS')]) {
      codeFiles.push(...findFiles(root, ['-type', 'f', '(', '-name', '*.ts', '-o', '-name', '*.md', '-o', '-name', '*.hbs', ')']));
    }
    const regFiles = [...new Set([...files, ...codeFiles])].filter(f => !RETIRED_TEST_FILE.test(f.replace(CLAUDE_DIR, '')));
    const ships = registry.some(c => c.publicOnly) ? await releaseShipsPredicate() : null;
    for (const f of regFiles) {
      let text = '';
      try { text = readFileSync(f, 'utf8'); } catch { continue; }
      if (RETIRED_HISTORY_MARKER.test(text.slice(0, 1024))) continue;
      regScanned++;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]!;
        if (RETIRED_REMOVAL_NOTE_MARKERS.test(l)) continue;
        for (const cap of registry) {
          if (!cap.token.test(l) || cap.allow.some(a => a.test(l))) continue;
          if (cap.publicOnly && ships && !ships(f)) continue;
          regHits++;
          if (regHits <= RETIRED_REPORT_CAP) {
            findings.push({ detail: `${f.replace(CLAUDE_DIR + '/', '')}:${i + 1} names retired capability "${cap.id}" as live — add a dated removal note, repoint it, or add a narrow allow context to RETIRED_CAPABILITIES.json`, blocking: true });
          }
        }
      }
    }
    if (regHits > RETIRED_REPORT_CAP) findings.push({ detail: `…and ${regHits - RETIRED_REPORT_CAP} more retired-capability references not listed`, blocking: true });
  }
  const regNote = registry ? ` · registry: ${registry.length} capabilities over ${regScanned} files (hooks/ and LIFEOS/TOOLS/ included), ${regHits} live hits` : ' · registry: not present';
  record('retired-tokens', findings, `${scanned} live files scanned, ${RETIRED_TOKENS.length} harness tokens${regNote}`);
}

// ── Check: stop-gate-parity (HookSystem.md documents every StopGates member) ──
// Added 2026-08-17 (7.44.1 cut, Max release audit): StopGates.hook.ts ran 8
// member gates while HookSystem.md documented 6 — DeployRegistrationGate and
// IsaDeployMarkerGate had zero mentions. The import list IS the chain, so the
// doc is checked against it: every relative .hook import's member name must
// appear in HookSystem.md. This same staleness class drew three public issues
// (#1596, #1629, #1877) before it got a deterministic catch.
function checkStopGateParity(): void {
  const findings: Finding[] = [];
  // Every consolidating dispatcher, not just StopGates — the 7.44.2/7.44.3
  // audit rounds found the same staleness class on PreToolGuard (7 members in
  // code, 3 in the doc) right after StopGates was fixed. The import list IS
  // each chain; closing the class means parsing all of them.
  const DISPATCHERS = ['StopGates', 'MemoryTurnStart', 'PostToolObserver'];
  try {
    const doc = readFileSync(join(CLAUDE_DIR, 'LIFEOS', 'DOCUMENTATION', 'Hooks', 'HookSystem.md'), 'utf8');
    let members = 0;
    for (const d of DISPATCHERS) {
      let src = '';
      try { src = readFileSync(join(CLAUDE_DIR, 'hooks', `${d}.hook.ts`), 'utf8'); } catch { continue; }
      const gates = [...src.matchAll(/from ["']\.\/([A-Za-z0-9]+)\.hook["']/g)].map((m) => m[1]);
      members += gates.length;
      for (const g of gates) {
        if (!doc.includes(g)) findings.push({ detail: `HookSystem.md never mentions ${d} member "${g}" — the dispatcher doc is stale; fix its member list AND the fold-map/fire-order entries`, blocking: true });
      }
    }
    if (members === 0) { scanError('dispatcher-parity: no member imports parsed from any dispatcher'); return; }
    // Count-claim parity (a "52 on disk" literal survived two audit rounds
    // while 58 shipped). Installed-tree carve-out (Max, 7.44.3 audit): the doc
    // ships maintainer counts qualified by a "Public releases ship N" clause,
    // so a claim passes when EITHER the claimed N or the qualified shipped N
    // equals the live count — otherwise every public /ic run false-blocks on a
    // doc that is right.
    const live = findFiles(join(CLAUDE_DIR, 'hooks'), ['-maxdepth', '1', '-name', '*.hook.ts']).length;
    const shipM = doc.match(/Public releases ship (\d+)/);
    const shipped = shipM ? Number(shipM[1]) : null;
    for (const m of doc.matchAll(/(\d+) `?\.hook\.ts`? (?:files exist )?on\s*\n?disk/g)) {
      if (Number(m[1]) !== live && shipped !== live) findings.push({ detail: `HookSystem.md claims ${m[1]} .hook.ts on disk — live count is ${live}; update the count (and its dated parenthetical + "Public releases ship N" clause)`, blocking: true });
    }
    record('dispatcher-parity', findings, `${members} dispatcher members (${DISPATCHERS.join('/')}) + on-disk count claims checked against HookSystem.md`);
  } catch { scanError('dispatcher-parity: could not read HookSystem.md'); }
}

// ── Check: doc-private-note-refs (shipped docs never point at private notes) ──
// Added 2026-08-17 (7.44.5 cut, cross-vendor audit): HookSystem.md referenced a
// specific KNOWLEDGE note that never ships — MEMORY note CONTENT is private,
// while the archive's directories and schema ship as scaffold. So the class is
// a specific note-file path under a KNOWLEDGE entity dir inside DOCUMENTATION;
// directory and _schema references stay legal.
function checkDocPrivateNoteRefs(): void {
  const findings: Finding[] = [];
  const root = join(CLAUDE_DIR, 'LIFEOS', 'DOCUMENTATION');
  const re = /LIFEOS\/MEMORY\/KNOWLEDGE\/(?:Ideas|People|Companies|Research)\/[A-Za-z0-9._-]+\.md/g;
  let scanned = 0;
  for (const f of findFiles(root, ['-type', 'f', '-name', '*.md'])) {
    const text = readScanInput('doc-private-note-refs', f);
    if (text === null) continue;
    scanned++;
    for (const m of text.matchAll(re)) {
      findings.push({ detail: `${f.replace(CLAUDE_DIR + '/', '')} references private note ${m[0]} — note content never ships; inline the point or mark it private-only`, blocking: true });
    }
  }
  record('doc-private-note-refs', findings, `${scanned} docs scanned for private KNOWLEDGE note references`);
}

// ── Check: retirement-registry (G19's registry is not starved) ──
// G19 in ShadowRelease.ts blocks the cut when a RETIRED capability still reads
// as LIVE in the shipped payload. It is registry-driven: it only scans for the
// tokens listed in RETIRED_CAPABILITIES.json. On 2026-07-25 that registry held
// 4 entries while doctrine declared 49 retirements, so G19 passed three cuts in
// one night while the payload advertised a deleted CLI, agents removed
// 2026-06-10, a never-shipped command, and the whole retired mode/tier system.
// The gate never failed — it was never fed.
//
// Registration was a manual step with nothing enforcing it, so it only happened
// after an incident or a cross-vendor catch. This closes that: every
// retirement DATE that doctrine declares must appear in the registry. Date is a
// coarse but sound join key — it needs no prose parsing and cannot be gamed by
// wording. A declared retirement with no registry entry means G19 is blind to
// that whole capability, which is the exact hole this check exists to surface.
function checkRetirementRegistry(): void {
  const findings: Finding[] = [];
  const REGISTRY = join(CLAUDE_DIR, 'skills', '_LIFEOS', 'RETIRED_CAPABILITIES.json');

  // The retirement registry belongs to the private release-tooling skill, which is
  // stripped from every public release. Without this guard the catch below fired on
  // every public install and recorded a BLOCKING finding for a file that is not
  // supposed to exist there — turning a clean install into a permanent red integrity
  // check. Absent tooling is "not applicable", not "broken".
  if (!existsSync(join(CLAUDE_DIR, 'skills', '_LIFEOS'))) {
    record('retirement-registry', [], 'skipped — release tooling not installed');
    return;
  }

  const registered = new Set<string>();
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    for (const e of parsed.capabilities ?? []) if (e?.retired) registered.add(String(e.retired));
  } catch {
    record('retirement-registry', [{ detail: `cannot read ${REGISTRY.replace(CLAUDE_DIR + '/', '')} — G19 has no registry to scan`, blocking: true }], 'registry unreadable');
    return;
  }

  // Doctrine surfaces only. Archive Algorithm versions and modes/ are history by
  // construction and declare retirements that are already accounted for.
  const roots = [join(CLAUDE_DIR, 'LIFEOS', 'DOCUMENTATION'), join(CLAUDE_DIR, 'LIFEOS', 'RULES')];
  const files: string[] = [];
  for (const root of roots) files.push(...findFiles(root, ['-type', 'f', '-name', '*.md']));
  files.push(join(CLAUDE_DIR, 'CLAUDE.md'), join(CLAUDE_DIR, 'LIFEOS', 'LIFEOS_SYSTEM_PROMPT.md'));

  // date -> first place it was declared, so the finding names where to look.
  const declared = new Map<string, string>();
  const DECL = /\b[Rr]etired\s+(\d{4}-\d{2}-\d{2})/g;
  for (const f of files) {
    let text = '';
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of text.matchAll(DECL)) {
      const date = m[1];
      if (declared.has(date)) continue;
      const line = text.slice(0, m.index ?? 0).split('\n').length;
      declared.set(date, `${f.replace(CLAUDE_DIR + '/', '')}:${line}`);
    }
  }

  for (const [date, where] of [...declared].sort()) {
    if (registered.has(date)) continue;
    findings.push({
      detail: `retirement dated ${date} is declared at ${where} but has NO entry in RETIRED_CAPABILITIES.json — G19 cannot see it, so its dangling references ship silently`,
      blocking: true,
    });
  }

  // A rename retires the old name. The Tex rename (Relay ISA F30) sat in that ISA for three days while the old name shipped
  // in the payload and the release notes (2026-10-27): it never said "retired <date>", it lived in a system ISA this check
  // did not read, and its date was already registered for another retirement. Renames are joined on the old NAME,
  // across doctrine and every standing system ISA (dated task ISAs under MEMORY/WORK are history).
  const tokens: string[] = [];
  try { for (const e of JSON.parse(readFileSync(REGISTRY, 'utf8')).capabilities ?? []) if (e?.token) tokens.push(String(e.token)); } catch { /* reported above */ }
  const isaRoots = [join(CLAUDE_DIR, 'LIFEOS'), join(CLAUDE_DIR, 'skills')];
  const isas = isaRoots.flatMap((r) => findFiles(r, ['-type', 'f', '-name', 'ISA.md'])).filter((f) => !/\/MEMORY\//.test(f));
  const userDir = join(CLAUDE_DIR, 'LIFEOS', 'USER');
  if (existsSync(userDir)) isas.push(...findFiles(realpathSync(userDir), ['-type', 'f', '-name', 'ISA.md']).filter((f) => !/\/MEMORY\//.test(f)));
  const texts = [...files, ...isas].flatMap((f) => { try { return [{ path: f.replace(CLAUDE_DIR + '/', ''), text: readFileSync(f, 'utf8') }]; } catch { return []; } });
  const renames = unregisteredRenames(texts, tokens);
  for (const r of renames) findings.push({ detail: `rename of "${r.old}" to "${r.new}" is declared at ${r.where} but no RETIRED_CAPABILITIES.json token matches "${r.old}" — the old name keeps shipping until it is registered`, blocking: true });

  record('retirement-registry', findings,
    `${declared.size} retirement dates declared in doctrine, ${registered.size} registered; ${renames.length} unregistered rename(s) in doctrine and system ISAs`);
}

/** Renames declared as "X is/was renamed (to) Y" or "rename x to Y" whose old name no registry token matches. Pure. */
export function unregisteredRenames(texts: readonly { path: string; text: string }[], tokens: readonly string[]): { old: string; new: string; where: string }[] {
  const res = tokens.flatMap((t) => { try { return [new RegExp(t, 'i')]; } catch { return []; } });
  const DECLS = [/\b([A-Z][A-Za-z]{2,})\s+(?:is|was)\s+renamed\s+(?:to\s+)?([A-Z][A-Za-z]+)\b/g, /\b[Rr]ename\s+([A-Za-z]{3,})\s+to\s+([A-Z][A-Za-z]+)\b/g];
  const out = new Map<string, { old: string; new: string; where: string }>();
  for (const { path, text } of texts) {
    for (const re of DECLS) for (const m of text.matchAll(re)) {
      const old = m[1]!, nu = m[2]!;
      if (old.toLowerCase() === nu.toLowerCase() || out.has(old.toLowerCase()) || res.some((r) => r.test(old))) continue;
      out.set(old.toLowerCase(), { old, new: nu, where: `${path}:${text.slice(0, m.index ?? 0).split('\n').length}` });
    }
  }
  return [...out.values()];
}

// ── Check: x_token_ownership (single-owner X OAuth chain) ──
// The X bookmark pipeline died repeatedly
// because local code and the cloud bookmarks-summarize worker each ran a
// refresh chain of the same grant: X refresh tokens are single-use, so the
// second chain's refresh trips reuse detection and X revokes the whole family.
// The worker is the ONLY legitimate owner of the refresh chain (it lives in the
// install's own USER customization tree, outside these roots). Any local .ts that
// calls X's token endpoint with a refresh grant, or recreates the retired
// local token store, reintroduces the exact failure class — block it.
function checkXTokenOwnership(): void {
  const findings: Finding[] = [];
  const roots = [
    join(CLAUDE_DIR, 'skills'),
    join(CLAUDE_DIR, 'LIFEOS', 'TOOLS'),
    join(CLAUDE_DIR, 'hooks'),
  ];
  const files: string[] = [];
  for (const root of roots) files.push(...findFiles(root, ['-type', 'f', '-name', '*.ts']));
  // The refresh GRANT specifically — the authorize flow's authorization_code
  // exchange also touches the token endpoint and stores refresh_token, and
  // that is legitimate (it seeds the worker's KV).
  const refreshGrant = /grant_type["'\s:=,]+refresh_token/;
  const retiredStore = 'x-oauth2-tokens' + '.json'; // split so this file never self-matches
  let scanned = 0;
  for (const f of files) {
    if (f.endsWith('IntegrityCheck.ts')) continue; // the checker's own patterns
    const text = readScanInput('x_token_ownership', f);
    if (text === null) continue;
    scanned++;
    const rel = f.replace(CLAUDE_DIR + '/', '');
    if (text.includes('api.twitter.com/2/oauth2/token') && refreshGrant.test(text)) {
      findings.push({ detail: `${rel} refreshes X OAuth tokens locally — the worker owns the chain; a second refresh chain gets the whole grant revoked`, blocking: true });
    }
    if (text.includes(retiredStore)) {
      findings.push({ detail: `${rel} references the retired local X token store — tokens live only in the worker's X_TOKENS KV`, blocking: true });
    }
  }
  record('x_token_ownership', findings, `${scanned} ts files scanned`);
}

// ── Check: gate_counts (release-gate count drift) ──
// The build-gate roster (GateKey in ShadowRelease.ts) has grown three times
// (15 → 16 → 17); each growth left stale "N gates" counts in rc.md, the
// shadow-release intent (retired 2026-10-11) and SKILL.md prose with no deterministic catch.
// This check parses the GateKey union — the declared source of truth — and
// flags any live numeric "N gates" mention that disagrees. Files whose first
// 1KB contains "RETIRED" are history and exempt (same convention as
// retired-tokens). Word-form counts ("seventeen") are invisible to this
// check by design: write gate counts as digits.
function checkGateCounts(): void {
  const findings: Finding[] = [];
  let gateCount = 0;
  let gateNums: number[] = [];
  // Same reason as checkRetirementRegistry: GateKey lives in the private release
  // tooling. On a public install this raised a scan error for a file that is
  // correctly absent.
  if (!existsSync(join(CLAUDE_DIR, 'skills', '_LIFEOS'))) {
    record('gate_counts', [], 'skipped — release tooling not installed');
    return;
  }
  try {
    const src = readFileSync(join(CLAUDE_DIR, 'skills', '_LIFEOS', 'Tools', 'ShadowRelease.ts'), 'utf8');
    const typeLine = src.match(/type GateKey =[^;]+;/);
    if (!typeLine) throw new Error('GateKey type not found');
    gateNums = [...typeLine[0].matchAll(/"G(\d+)_/g)].map(m => parseInt(m[1], 10)).sort((a, b) => a - b);
    gateCount = gateNums.length;
    if (gateCount === 0) throw new Error('GateKey parsed to zero members');
  } catch (e: any) {
    scanError(`gate_counts: could not parse GateKey from ShadowRelease.ts — ${e?.message ?? e}`);
    record('gate_counts', [], 'SCAN ERROR (no GateKey)');
    return;
  }
  const roots = [
    join(CLAUDE_DIR, 'skills', '_LIFEOS'),
    join(CLAUDE_DIR, 'commands'),
    join(CLAUDE_DIR, 'LIFEOS', 'DOCUMENTATION'),
  ];
  const files: string[] = [];
  for (const root of roots) files.push(...findFiles(root, ['-name', '*.md', '-type', 'f']));
  files.push(join(CLAUDE_DIR, 'CLAUDE.md'), join(CLAUDE_DIR, 'LIFEOS', 'LIFEOS_SYSTEM_PROMPT.md'));
  // Up to two intervening lowercase words so "15 security scrub gates" is caught too.
  // Negative lookbehind kills date fragments ("2026-07-16 after both gates").
  const countRe = /(?<![\d-])\b(\d{1,2})[ -](?:[a-z-]+ ){0,2}gates?\b/g;
  let scanned = 0;
  for (const f of files) {
    let text = '';
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    if (text.slice(0, 1024).includes('RETIRED')) continue; // history marker — exempt
    scanned++;
    let m: RegExpExecArray | null;
    countRe.lastIndex = 0;
    while ((m = countRe.exec(text)) !== null) {
      const n = parseInt(m[1], 10);
      // Only build-gate-plausible numbers are gated (≥10): small counts refer to
      // other gate families (boundary gates, emit-time gates) with their own rosters.
      if (n >= 10 && n !== gateCount) {
        const line = text.slice(0, m.index).split('\n').length;
        findings.push({ detail: `${f.replace(CLAUDE_DIR + '/', '')}:${line} says "${m[0]}" but GateKey declares ${gateCount} build gates`, blocking: true });
      }
    }
  }
  // Ranges drift independently of counts. "23 gates (G1–G14 + G17–G24)" passes the
  // count check and is still wrong: the digits agree, the enumeration doesn't. Four
  // surfaces carried three different stale ranges (…G24, …G21, …G20) while every count
  // read 23 (2026-08-14, /rc contextual review). So compare the SET a range denotes
  // against the GateKey roster, not the literal string — en-dash vs hyphen is noise.
  const canonical = expandRanges(gateNums);
  const rangeRe = /\bG\d+\s*[–-]\s*G\d+(?:\s*\+\s*G\d+\s*[–-]\s*G\d+)*/g;
  for (const f of files) {
    let text = '';
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    if (text.slice(0, 1024).includes('RETIRED')) continue;
    let m: RegExpExecArray | null;
    rangeRe.lastIndex = 0;
    while ((m = rangeRe.exec(text)) !== null) {
      // Only MULTI-RUN expressions ("Gx–Gy + Gz–Gw") are checked. That shape exists
      // solely to enumerate the whole roster around its retired holes, so it is a
      // completeness claim. A single run is a legitimate subset reference — "G1–G14"
      // for the original containment gates, "G1-G3" for the boundary gates — and
      // gating those would fire on correct prose.
      const pairs = [...m[0].matchAll(/G(\d+)\s*[–-]\s*G(\d+)/g)];
      if (pairs.length < 2) continue;
      const nums = new Set<number>();
      for (const pair of pairs) {
        const [lo, hi] = [parseInt(pair[1], 10), parseInt(pair[2], 10)];
        if (hi - lo > 200) continue; // nonsense span — not a gate range
        for (let i = lo; i <= hi; i++) nums.add(i);
      }
      if (nums.size === 0) continue;
      if (nums.size !== gateNums.length || gateNums.some(n => !nums.has(n))) {
        const line = text.slice(0, m.index).split('\n').length;
        findings.push({
          detail: `${f.replace(CLAUDE_DIR + '/', '')}:${line} says "${m[0]}" but GateKey declares ${canonical}`,
          blocking: true,
        });
      }
    }
  }
  record('gate_counts', findings,
    `GateKey=${gateCount} gates (${canonical}); ${scanned} live files scanned, ${findings.length} drifted counts/ranges`);
}

// Collapse a sorted gate roster into its canonical range expression ("G1–G14 + G17–G25").
function expandRanges(nums: number[]): string {
  const runs: [number, number][] = [];
  for (const n of nums) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs.map(([lo, hi]) => (lo === hi ? `G${lo}` : `G${lo}–G${hi}`)).join(' + ');
}

// ── Change window (memory sweep anchor) ──
// Every run stamps last-run.json + appends runs.jsonl. Before overwriting, the
// previous stamp anchors a change window: everything committed in BOTH repos
// (~/.claude system + ~/.config/LIFEOS/USER data) since the last /ic run,
// aggregated into touched areas. This is the deterministic input for the
// intent's contextual review — "we just reworked Pulse" shows up here as
// LIFEOS/PULSE/... churn, telling the model where integrity drift is likeliest.
interface ChangeWindow {
  lastRun: string | null;      // ISO ts of previous run (null = first stamped run)
  commits: number;             // total commits across both repos since lastRun
  areas: { path: string; files: number }[];  // touched areas, most-churned first
  anchor?: 'run' | 'tag';      // what the window is measured from (--since-tag → 'tag')
  tag?: string;                // the last v* tag (--since-tag)
  userCommits?: number;        // --since-tag: USER-repo commits since its own copy of the tag (commits counts ~/.claude only)
}

function gitChangedFiles(repo: string, sinceIso: string): string[] {
  try {
    const out = execFileSync('git', ['-C', repo, 'log', `--since=${sinceIso}`, '--name-only', '--pretty=format:'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\n').filter(Boolean);
  } catch { return []; }
}
function gitCommitCount(repo: string, sinceIso: string): number {
  try {
    const out = execFileSync('git', ['-C', repo, 'rev-list', '--count', `--since=${sinceIso}`, 'HEAD'], { encoding: 'utf8' });
    return parseInt(out.trim(), 10) || 0;
  } catch { return 0; }
}

// 13. skill-hygiene — every skill (public AND private) is publishable-clean code:
// no deny-list identity strings, no home paths, no vendored deps tracked in git.
// Delegates to SkillHygieneGate.ts (which consumes LIFEOS/USER/SECURITY/DENY_LIST.txt —
// one pattern source of truth). Added 2026-07-23 with the private-skill
// code/data-separation doctrine: sensitive data lives under LIFEOS/USER/, skills
// reference it by path.
function checkSkillHygiene(): void {
  const gate = join(TOOLS_DIR, 'SkillHygieneGate.ts');
  if (!existsSync(gate)) { scanError('skill-hygiene: SkillHygieneGate.ts missing'); return; }
  let parsed: Record<string, any>;
  try {
    // exit 1 = violations; an error field, a malformed result, or exit 1 with none named = scan error
    const { raw, status } = runDelegate(gate, ['--json'], 256 * 1024 * 1024);
    parsed = validateDelegateResult(raw, status, DELEGATE_SHAPES.skillHygiene);
  } catch (e: any) { scanError(`skill-hygiene: gate failed: ${e.message}`); return; }
  const findings: Finding[] = [];
  for (const s of parsed.skills) {
    findings.push({ detail: `${s.skill}: ${s.count} deny-list hits in ${s.files} files (bun LIFEOS/TOOLS/SkillHygieneGate.ts --skill ${s.skill})`, blocking: true });
  }
  for (const d of parsed.vendoredDeps) {
    findings.push({ detail: `vendored deps tracked in git: ${d}`, blocking: true });
  }
  // An ok:false payload with zero extracted findings must never read as a
  // pass — fail closed on the shape (Astra landed-set review, 2026-08-14: the
  // gate's CANNOT-VERIFY branch previously recorded as CLEAN here).
  if (parsed.ok === false && findings.length === 0) { scanError('skill-hygiene: gate returned ok:false with no parseable finding — treat as cannot-verify'); return; }
  record('skill-hygiene', findings, `${parsed.totalViolations} violations, ${parsed.allowedHits ?? 0} allowlisted`);
}

// code-data-boundary — one general gate between code and the principal's data
// (LIFEOS/TOOLS/CodeDataBoundary.ts): every file under a code root is git-tracked
// or build output, tracked code carries no private identity term derived from the
// live identity files, and no absolute home path. Untracked source, sanitized public
// terms, and test fixtures come through as info. Declared runtime-debt dirs are
// reported in the note so they never vanish from view.
function checkCodeDataBoundary(): void {
  const gate = join(TOOLS_DIR, 'CodeDataBoundary.ts');
  if (!existsSync(gate)) { scanError('code-data-boundary: CodeDataBoundary.ts missing'); return; }
  if (!isGitCheckout()) { record('code-data-boundary', [], NOT_A_CHECKOUT); return; }
  let parsed: Record<string, any>;
  try {
    const { raw, status } = runDelegate(gate, ['--json'], 256 * 1024 * 1024);
    parsed = validateDelegateResult(raw, status, DELEGATE_SHAPES.codeDataBoundary);
  } catch (e: any) {
    if (e.status === 2) { scanError(`code-data-boundary: scan error: ${String(e.stderr ?? e.message).trim()}`); return; }
    scanError(`code-data-boundary: gate failed: ${e.message} — treat as cannot-verify`);
    return;
  }
  const findings: Finding[] = parsed.findings.map((f: any) => ({ detail: `[${f.check}] ${f.file}: ${f.detail}`, blocking: !f.info }));
  record('code-data-boundary', findings, `${parsed.scanned} files · ${parsed.terms?.private?.length ?? 0} private + ${parsed.terms?.public?.length ?? 0} sanitized terms · ${parsed.declaredRuntime} runtime-debt files`);
}

// function-hooks — the LifeOSHooks plugin (skills/LifeOSHooks) validates, and the events
// it hooks are exactly the ones its ISA declares (LIFEOS/FUNCTIONHOOKS/ISA.md (maintainer-side state of record, not in the release) frontmatter
// `hooked_events`). `claude plugin validate` reads the module statically and lists every
// hooked event and every engine-interface call, so a hook that stopped registering — or a
// new one the ISA never claimed — shows up here, not in a session that silently lost a line.
// The pure-core copies must also equal their sources (scripts/SyncCores.ts driftedCores).
/**
 * Why one `claude plugin validate` run is not a pass, or null when it is. Only exit 0
 * with the success marker passes: a timeout, a signal or a nonzero exit is blocking
 * even when partial output already printed "Validation passed" (LOSIntegrity
 * ), and exit 0 without the marker is incomplete output. Pure.
 */
export function pluginValidateFailure(r: { status: number | null; signal?: string | null; timedOut?: boolean; out: string; message?: string }): string | null {
  if (r.timedOut) return 'claude plugin validate timed out';
  if (r.signal) return `claude plugin validate was killed by ${r.signal}`;
  if (r.status !== 0) {
    const why = r.out.split('\n').filter(l => /✘|error/i.test(l)).slice(0, 3).join(' · ') || r.message || 'no output';
    return `claude plugin validate failed (exit ${r.status ?? 'none'}): ${why}`;
  }
  if (!/Validation passed/.test(r.out)) return 'claude plugin validate exited 0 without "Validation passed"; output incomplete';
  return null;
}

/**
 * The manifest `claude plugin validate` must see for the plugin as it actually loads (LOSIntegrity
 * integrity#10, 2026-10-14). A folder that carries `.claude-plugin/plugin.json` loads, and validates, as
 * itself (a public install). A folder the local folder marketplace loads with `strict: false` holds no
 * plugin.json since 127737f604: its manifest is the marketplace entry, so the validator is handed that entry
 * as plugin.json (the same manifest ShadowRelease writes back for a release). Anything else has no manifest
 * that loads and is a finding, never a skip. Pure: `marketplaceText` is the marketplace.json text or null.
 */
export function functionHooksManifest(
  pluginDir: string, marketplaceRoot: string, marketplaceText: string | null, folderHasManifest: boolean,
): { kind: 'folder' } | { kind: 'entry'; manifest: Record<string, unknown> } | { kind: 'none'; why: string } {
  if (folderHasManifest) return { kind: 'folder' };
  if (marketplaceText === null) return { kind: 'none', why: `${pluginDir} has no .claude-plugin/plugin.json and there is no .claude-plugin/marketplace.json to load it from` };
  let mkt: any;
  try { mkt = JSON.parse(marketplaceText); } catch (e: any) { return { kind: 'none', why: `.claude-plugin/marketplace.json is not JSON (${e.message})` }; }
  const plugins: any[] = Array.isArray(mkt?.plugins) ? mkt.plugins : [];
  const entry = plugins.find(p => typeof p?.source === 'string' && resolve(marketplaceRoot, p.source) === resolve(pluginDir));
  if (!entry) return { kind: 'none', why: `${pluginDir} has no .claude-plugin/plugin.json and no marketplace entry loads it` };
  if (entry.strict !== false) return { kind: 'none', why: `the marketplace entry ${entry.name ?? '?'} is strict, so it needs ${pluginDir}/.claude-plugin/plugin.json, which is missing` };
  const { source: _source, strict: _strict, ...rest } = entry;
  return { kind: 'entry', manifest: { $schema: 'https://anthropic.com/claude-code/plugin.schema.json', ...rest } };
}

/** One `claude plugin validate <dir>` run: its combined output and why it is not a pass (null when it is). */
function runPluginValidate(dir: string): { out: string; failure: string | null } {
  try {
    const out = execFileSync('claude', ['plugin', 'validate', dir], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });
    return { out, failure: pluginValidateFailure({ status: 0, out }) };
  } catch (e: any) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '');
    return { out, failure: pluginValidateFailure({ status: typeof e.status === 'number' ? e.status : null, signal: e.signal ?? null, timedOut: e.code === 'ETIMEDOUT', out, message: e.message }) };
  }
}

/**
 * Validate the plugin folder under the marketplace entry's manifest: a scratch copy of the folder with its
 * `.claude-plugin/` replaced by that manifest, so the source hooks module is what gets read (a broken module
 * still fails) and nothing is written into the tree. The scratch path is mapped back to `pluginDir` in the output.
 */
function validateWithEntryManifest(pluginDir: string, manifest: Record<string, unknown>): { out: string; failure: string | null } {
  const scratch = mkdtempSync(join(tmpdir(), 'ic-function-hooks-'));
  try {
    const layout = join(scratch, 'plugin');
    cpSync(pluginDir, layout, { recursive: true, filter: (src) => src !== join(pluginDir, '.claude-plugin') && !src.split('/').includes('node_modules') });
    mkdirSync(join(layout, '.claude-plugin'), { recursive: true });
    writeFileSync(join(layout, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
    const r = runPluginValidate(layout);
    return { out: r.out.split(layout).join(pluginDir), failure: r.failure && r.failure.split(layout).join(pluginDir) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function checkFunctionHooks(): void {
  checkModTypes();
  const isaPath = join(LIFEOS_DIR, 'FUNCTIONHOOKS', 'ISA.md');
  const pluginDir = join(CLAUDE_DIR, 'skills', 'LifeOSHooks');
  if (!existsSync(pluginDir)) { record('function-hooks', [], 'skipped — plugin not present'); return; }
  const findings: Finding[] = [];
  // The ISA is maintainer-side and never ships (S070): without it only the declared-vs-hooked comparison
  // is skipped. Manifest validation and core parity run on every install that has the plugin.
  const hasIsa = existsSync(isaPath);
  let declared: string[] = [];
  if (hasIsa) {
    try {
      const fm = readFileSync(isaPath, 'utf8').match(/^hooked_events:\s*(.+)$/m);
      declared = fm ? fm[1].split(',').map(s => s.trim()).filter(Boolean) : [];
    } catch (e: any) { scanError(`function-hooks: ISA unreadable: ${e.message}`); return; }
    if (declared.length === 0) findings.push({ detail: 'LIFEOS/FUNCTIONHOOKS/ISA.md (maintainer-side state of record, not in the release) has no `hooked_events:` frontmatter line', blocking: true });
  }

  const mktPath = join(CLAUDE_DIR, '.claude-plugin', 'marketplace.json');
  let mktText: string | null = null;
  if (existsSync(mktPath)) {
    try { mktText = readFileSync(mktPath, 'utf8'); } catch (e: any) { scanError(`function-hooks: ${mktPath.replace(HOME, '~')} unreadable: ${e.message}`); return; }
  }
  const target = functionHooksManifest(pluginDir, CLAUDE_DIR, mktText, existsSync(join(pluginDir, '.claude-plugin', 'plugin.json')));
  let out = '';
  let validateFailure: string | null;
  if (target.kind === 'none') { validateFailure = `no manifest loads the plugin: ${target.why}`; }
  else ({ out, failure: validateFailure } = target.kind === 'folder' ? runPluginValidate(pluginDir) : validateWithEntryManifest(pluginDir, target.manifest));
  if (validateFailure) findings.push({ detail: validateFailure, blocking: true });
  // The validator prints "./<module>.ts hooks: a, b, c"; the earlier "Validating hooks: <path>" line must not match.
  const hooked = out.match(/\.tsx? hooks:\s*([^\n]+)/);
  const actual = hooked ? hooked[1].split(',').map(s => s.trim()).filter(Boolean) : [];
  if (hooked && declared.length) {
    for (const ev of declared) if (!actual.includes(ev)) findings.push({ detail: `ISA declares hooked event ${ev} but the module does not hook it`, blocking: true });
    for (const ev of actual) if (!declared.includes(ev)) findings.push({ detail: `module hooks ${ev} but LIFEOS/FUNCTIONHOOKS/ISA.md (maintainer-side state of record, not in the release) hooked_events does not declare it`, blocking: true });
  } else if (!hooked && /Validation passed/.test(out)) {
    findings.push({ detail: 'validate passed but listed no hooked events — the hooks module registered nothing', blocking: true });
  }

  try {
    const drift = execFileSync('bun', ['-e', `import { driftedCores } from "${join(pluginDir, 'scripts', 'SyncCores.ts')}"; console.log(JSON.stringify(driftedCores()))`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 }).trim();
    for (const d of JSON.parse(drift.split('\n').pop() || '[]')) findings.push({ detail: `pure-core copy drifted from its source: ${d} (bun skills/LifeOSHooks/scripts/SyncCores.ts)`, blocking: true });
  } catch (e: any) { scanError(`function-hooks: parity check failed to run: ${e.message}`); }

  record('function-hooks', findings, hasIsa ? `${actual.length} events hooked, ${declared.length} declared` : `${actual.length} events hooked; ISA comparison skipped (maintainer-side ISA not on this install)`);
}

/**
 * Pure comparison behind the `mod-types` check (FUNCTIONHOOKS ISA ISC-128/129/133): every mod's
 * `claude-code.d.ts` must open with "// Written by Claude Code <running>." and every TYPES_BUILD
 * pin must equal `running`. Takes file contents, reads nothing, so tests can seed any build.
 */
export function modTypesDrift(
  running: string,
  declarations: { path: string; text: string }[],
  pins: { path: string; text: string }[],
): { detail: string; blocking: boolean }[] {
  const out: { detail: string; blocking: boolean }[] = [];
  const fix = "copy the running build's claude-code.d.ts from the plugin-authoring skill folder into each mod, then bump TYPES_BUILD (skills/LifeOSHooks/SKILL.md)";
  for (const d of declarations) {
    const written = (d.text.split('\n', 1)[0] ?? '').match(/^\/\/ Written by Claude Code (\d+\.\d+\.\d+)\./)?.[1];
    if (!written) out.push({ detail: `${d.path}: first line names no "Written by Claude Code <build>." — regenerate it`, blocking: true });
    else if (written !== running) out.push({ detail: `${d.path} was written by Claude Code ${written} but the running build is ${running} — ${fix}`, blocking: false });
  }
  for (const p of pins) {
    const pinned = p.text.match(/TYPES_BUILD\s*=\s*["']([^"']+)["']/)?.[1];
    if (!pinned) out.push({ detail: `${p.path} has no TYPES_BUILD`, blocking: true });
    else if (pinned !== running) out.push({ detail: `${p.path} pins TYPES_BUILD ${pinned} but the running build is ${running} — ${fix}`, blocking: false });
  }
  return out;
}

// mod-types — function-hooks mods (any skill carrying types/ or .claude/types/claude-code.d.ts)
// were typed by the Claude Code build that runs them, and a mod's own lib/build.ts TYPES_BUILD
// pin agrees. The plugin stopped pinning this above the prompt (2026-09-10), so this is where a
// Claude Code update that outran the declarations shows up. Drift is non-blocking: a stale mod
// still arms. checkFunctionHooks calls it; `--section mod-types` runs it alone. Test seams:
// IC_MOD_TYPES_ROOT (a fixture tree in place of the config root) and IC_RUNNING_BUILD (in place
// of `claude --version`).
function checkModTypes(): void {
  const root = process.env.IC_MOD_TYPES_ROOT || CLAUDE_DIR;
  const skillsDir = join(root, 'skills');
  const declarations: { path: string; text: string }[] = [];
  const pins: { path: string; text: string }[] = [];
  try {
    for (const ent of existsSync(skillsDir) ? readdirSync(skillsDir, { withFileTypes: true }) : []) {
      if (!ent.isDirectory()) continue;
      const decls = ['types', join('.claude', 'types')].map(d => join(skillsDir, ent.name, d, 'claude-code.d.ts')).filter(f => existsSync(f));
      if (decls.length === 0) continue;
      for (const f of decls) declarations.push({ path: relative(root, f), text: readFileSync(f, 'utf8') });
      const pin = join(skillsDir, ent.name, 'hooks', 'lib', 'build.ts');
      if (existsSync(pin)) pins.push({ path: relative(root, pin), text: readFileSync(pin, 'utf8') });
    }
  } catch (e: any) { scanError(`mod-types: could not read mod declarations: ${e.message}`); return; }
  if (declarations.length === 0) { record('mod-types', [], 'skipped — no function-hooks mods installed'); return; }
  let running = process.env.IC_RUNNING_BUILD ?? '';
  if (!running) {
    try {
      running = execFileSync('claude', ['--version'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000 }).match(/\d+\.\d+\.\d+/)?.[0] ?? '';
    } catch (e: any) { scanError(`mod-types: claude --version failed: ${e.message}`); return; }
    if (!running) { scanError('mod-types: claude --version printed no build'); return; }
  }
  record('mod-types', modTypesDrift(running, declarations, pins), `${declarations.length} declarations, ${pins.length} TYPES_BUILD pins vs Claude Code ${running}`);
}

// plugin-load — an install that keeps a folder marketplace at `.claude-plugin/marketplace.json`
// loads those plugins from it, never as `@skills-dir` copies. A skills-dir plugin is watched:
// every save hot-reloads every open session and prints a reload line into each transcript
// (2026-10-10). Settings drift back to the skills-dir load shows up here. Absent file → skip
// (a public install loads its plugins from skills/ on purpose).
function checkPluginLoad(): void {
  const mktPath = join(CLAUDE_DIR, '.claude-plugin', 'marketplace.json');
  if (!existsSync(mktPath)) { record('plugin-load', [], 'skipped — no local folder marketplace'); return; }
  let mkt: any, settings: any;
  try {
    mkt = JSON.parse(readFileSync(mktPath, 'utf8'));
    settings = JSON.parse(readFileSync(join(CLAUDE_DIR, 'settings.json'), 'utf8'));
  } catch (e: any) { scanError(`plugin-load: unreadable: ${e.message}`); return; }
  const findings: Finding[] = [];
  const name = String(mkt?.name ?? '');
  const enabled = settings?.enabledPlugins ?? {};
  const known = settings?.extraKnownMarketplaces?.[name]?.source;
  if (!name) findings.push({ detail: '.claude-plugin/marketplace.json has no name', blocking: true });
  else if (known?.source !== 'directory' || resolve(String(known?.path ?? '')) !== resolve(CLAUDE_DIR)) {
    findings.push({ detail: `settings.json extraKnownMarketplaces.${name} is not the directory ${CLAUDE_DIR}`, blocking: true });
  }
  const plugins: any[] = Array.isArray(mkt?.plugins) ? mkt.plugins : [];
  for (const p of plugins) {
    const folder = String(p?.source ?? '').replace(/\/+$/, '').split('/').pop() ?? '';
    if (enabled[`${p?.name}@${name}`] !== true) findings.push({ detail: `${p?.name}@${name} is not enabled in settings.json — the plugin falls back to the watched skills-dir load`, blocking: true });
    if (folder && enabled[`${folder}@skills-dir`] !== false) findings.push({ detail: `${folder}@skills-dir is not disabled in settings.json — saves to ${p?.source} would hot-reload every open session`, blocking: true });
    // A folder-marketplace install runs a cached copy that refreshes only on a version change, so a hook
    // fix committed without a bump never reaches a session.
    // A plugin.json in the folder makes the skills-dir scan name the disabled copy after the installed plugin, and
    // /plugin lists it as "failed to load" (2026-10-14). The marketplace entry carries the manifest instead (strict: false).
    if (existsSync(join(CLAUDE_DIR, String(p?.source ?? ""), ".claude-plugin", "plugin.json"))) findings.push({ detail: `${p?.source}/.claude-plugin/plugin.json exists — the disabled skills-dir copy clashes with ${p?.name}@${name} and /plugin lists it as failed; keep the manifest in the marketplace entry (strict: false)`, blocking: true });
    const stale = stalePluginFiles(join(CLAUDE_DIR, String(p?.source ?? '')), `${p?.name}@${name}`);
    if (stale.length > 0) findings.push({ detail: `${p?.name}@${name}: the cached copy sessions load differs from source (${stale.slice(0, 3).join(', ')}${stale.length > 3 ? ` +${stale.length - 3}` : ''}) — bump version in its .claude-plugin/marketplace.json entry, then \`claude plugin update ${p?.name}@${name}\``, blocking: true });
  }
  record('plugin-load', findings, `${plugins.length} plugins from ${name || '?'}`);
}

/**
 * Source files under the plugin's hooks/ that differ from, or are missing in, its installed cache copy.
 * A plugin with no hooks/ has nothing to compare. An install record that cannot be read, parsed or
 * found, or a file that cannot be read, is a scan error: the comparison never ran, so it proves nothing.
 */
function stalePluginFiles(sourceDir: string, pluginId: string): string[] {
  if (!existsSync(join(sourceDir, 'hooks'))) return [];
  const recordPath = join(CLAUDE_DIR, 'plugins', 'installed_plugins.json');
  const raw = readScanInput('plugin-load', recordPath);
  if (raw === null) return [];
  let installPath = '';
  try { installPath = String(JSON.parse(raw)?.plugins?.[pluginId]?.[0]?.installPath ?? ''); }
  catch (e: any) { scanError(`plugin-load: ${recordPath.replace(HOME, '~')} unparseable — ${e?.message ?? e}; cache parity for ${pluginId} unverified`); return []; }
  if (!installPath) { scanError(`plugin-load: ${pluginId} has no installPath in ${recordPath.replace(HOME, '~')}; cache parity unverified`); return []; }
  const out: string[] = [];
  const walk = (rel: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(join(sourceDir, rel), { withFileTypes: true }); }
    catch (e: any) { scanError(`plugin-load: cannot list ${join(sourceDir, rel).replace(HOME, '~')} (${e?.code ?? e?.message ?? e}); cache parity for ${pluginId} incomplete`); return; }
    for (const ent of entries) {
      const r = join(rel, ent.name);
      if (ent.isDirectory()) { walk(r); continue; }
      const cached = join(installPath, r);
      if (!existsSync(cached)) { out.push(r); continue; }
      try {
        if (!readFileSync(cached).equals(readFileSync(join(sourceDir, r)))) out.push(r);
      } catch (e: any) {
        scanError(`plugin-load: cannot compare ${r} for ${pluginId} (${e?.code ?? e?.message ?? e}); cache parity incomplete`);
      }
    }
  };
  walk('hooks');
  return out;
}

// 14. credential-registry — the incident-response credential registry still describes
// reality: every key in .env has a curated blast-radius classification, and the generated
// registry/orphan documents are current. Added 2026-07-24 after the hand-maintained
// registry drifted to 22 of 124 keys — an unclassified credential is one nobody has
// decided how bad losing would be, which is exactly what you don't want to discover
// mid-incident. Drift findings are non-blocking, but INFO_BUDGET caps them at 1: a second
// finding becomes a blocking one, so unbounded drift does stop a release.
function checkCredentialRegistry(): void {
  const gen = join(CLAUDE_DIR, 'skills', '_INCIDENT_RESPONSE', 'Tools', 'GenerateRegistry.ts');
  if (!existsSync(gen)) { record('credential-registry', [], 'skipped — incident-response skill not installed'); return; }
  const findings: Finding[] = [];
  let note = 'registry current';
  try {
    note = execFileSync('bun', [gen, '--check'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
      .replace(/^CLEAN — /, '').trim();
  } catch (e: any) {
    const detail = `${e.stderr ?? ''}`.split('\n').filter((l: string) => l.trim().startsWith('- ')).map((l: string) => l.trim().slice(2));
    if (detail.length === 0) { scanError(`credential-registry: ${e.message}`); return; }
    for (const d of detail) findings.push({ detail: d, blocking: false });
    note = 'drift — run GenerateRegistry.ts';
  }
  // Estate-wide leg: credentials Atlas knows about (worker secret bindings) that the registry
  // has never classified. The 2026-07-24 join found 64 of these — a credential with no
  // blast-radius decision is invisible to incident response even though it's deployed.
  const atlas = join(LIFEOS_DIR, 'ATLAS', 'Atlas.ts');
  if (existsSync(atlas)) {
    try {
      const out = execFileSync('bun', [atlas, 'sql',
        "SELECT count(*) AS n FROM asset WHERE kind='credential' AND (attrs='{}' OR attrs IS NULL)"],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const n = JSON.parse(out)[0]?.n ?? 0;
      if (n > 0) {
        findings.push({
          detail: `${n} credential(s) in the Atlas graph carry no attributes at all — not even where they live (bun LIFEOS/ATLAS/Atlas.ts sql "SELECT display_name FROM asset WHERE kind='credential' AND attrs='{}'"). A deployed-only secret should still arrive with its vendor and holder from its collector; an empty stub means some collector emitted an edge without the asset.`,
          blocking: false,
        });
        note += ` · ${n} unclassified in graph`;
      }
    } catch { /* graph unavailable — env-file leg still reported */ }
  }
  record('credential-registry', findings, note);
}

// 15. permission-rule-shape — every permission rule in the settings cascade is a shape the
// harness actually honors. File permission checks match ONLY Edit(path) rules; Edit covers
// all file-editing tools (Write included), and a Write(...)/MultiEdit(...) entry is silently
// inert. Added 2026-07-26 after the 2026-07-25 "restore the Write() rules" commit acted on an
// audit finding that Write and Edit were distinct permission surfaces, and verified it by
// COUNTING entries in the file ("deny 42, 0 Edit rules without a Write twin") rather than
// probing behavior — shipping 19 dead rules the CLI then warned about at every startup.
// A shape check is cheap; the expensive part was believing a config-shape count was evidence.
// Two legs, because the dead rule and the real hole look identical in a diff:
//   - a deny/ask path guarded ONLY by Write(...) with no Edit twin is a REAL hole
//   - a Write(...)/MultiEdit(...) entry that does have an Edit twin is dead weight
// BOTH block as of 2026-07-27. The dead-weight leg shipped as info, and info is what an
// audit ignores: on 2026-07-27 the same wrong fix landed a THIRD time (145c86cd5), from
// the same false reading of the same file, while /ic sat at exit 0 reporting 30 of them.
// The recurring half is the FINDING, not the config, so the finding has to be the thing
// that stops. MergeSettings now prunes the shape out of the generated settings.json, so a
// hit here is always a SOURCE layer someone is re-polluting — never the harness's problem.
function checkPermissionRuleShape(): void {
  const layers: Array<[string, string]> = [
    ['settings.json', join(CLAUDE_DIR, 'settings.json')],
    ['settings.system.json', join(CLAUDE_DIR, 'settings.system.json')],
    ['settings.user.json', join(LIFEOS_DIR, 'USER', 'CONFIG', 'settings.user.json')],
  ];
  const findings: Finding[] = [];
  let scanned = 0, dead = 0;
  for (const [label, path] of layers) {
    if (!existsSync(path)) continue;
    let perms: Record<string, unknown>;
    try {
      perms = (JSON.parse(readFileSync(path, 'utf8'))?.permissions ?? {}) as Record<string, unknown>;
    } catch (e: any) { scanError(`permission-rule-shape: ${label} unparseable — ${e.message}`); continue; }
    scanned++;
    for (const bucket of ['allow', 'deny', 'ask']) {
      const rules = perms[bucket];
      if (!Array.isArray(rules)) continue;
      for (const rule of rules) {
        if (typeof rule !== 'string') continue;
        const m = /^(Write|MultiEdit)\((.*)\)$/.exec(rule);
        if (!m) continue;
        dead++;
        const twin = `Edit(${m[2]})`;
        const covered = rules.includes(twin);
        findings.push({
          detail: covered
            // Carry the evidence in the finding: whoever reads this line is, on the
            // record, about to re-derive "Write and Edit are distinct surfaces" from
            // the missing twin and re-add it. Name the probe that says otherwise.
            ? `${label} ${bucket}: ${rule} is inert — file permissions match Edit(...) ONLY (live probe, commit b68b1a5c4); ${twin} already guards this path. DELETE it. Do not "restore" Write twins — that finding has been wrong 3x (07-16, 07-25, 07-27); a config-shape count is not a behavior probe.`
            : `${label} ${bucket}: ${rule} is inert and has NO ${twin} — this path is UNGUARDED; add ${twin} (not a Write rule).`,
          blocking: true,
        });
      }
    }
  }
  record('permission-rule-shape', findings,
    dead === 0
      ? `${scanned} settings layers, no inert rules`
      : `${scanned} settings layers, ${dead} inert Write/MultiEdit rule(s)`);
}

// 16. model-rung-pin — the main loop actually runs the rung doctrine claims it runs.
//
// Algorithm §Spend and OPERATIONAL_PREFERENCES § Model selection both state the main loop is
// pinned to the top rung "by config, not by election". v8.17.0 shipped the `//model`
// RATIONALE STRING into settings.json and never wrote the `model` key beside it, so every
// session since ran a rung below doctrine while both documents asserted otherwise, and
// nothing observed the gap until 2026-07-30. A comment explaining a pin is not a pin.
/**
 * `[integrity] model_rung_ack` from the user config — the principal's on-record
 * "yes, I meant this pin". Read with a light parse rather than through
 * LifeosConfig, whose loader normalizes to a typed struct and drops sections it
 * does not know about. Missing file, missing section, or malformed line all
 * read as "no ack", which keeps the check blocking.
 *
 * public issue #1854, @DRAZY
 */
function modelRungAck(): string | null {
  try {
    const text = readFileSync(join(CLAUDE_DIR, 'LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml'), 'utf8');
    const afterHeader = text.split(/^\s*\[integrity\]\s*$/m)[1];
    if (afterHeader === undefined) return null;
    const section = afterHeader.split(/^\s*\[/m)[0];
    const m = section.match(/^\s*model_rung_ack\s*=\s*["']([^"'\n]+)["']/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function checkModelRungPin(): void {
  const findings: Finding[] = [];
  const settingsPath = join(CLAUDE_DIR, 'settings.json');

  let settings: any;
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); }
  catch (e: any) { scanError(`model-rung-pin: settings.json unreadable — ${e.message}`); record('model-rung-pin', [], 'SCAN ERROR'); return; }

  // The top rung's alias, resolved from the registry so a lineup bump never edits this.
  // Anchored to the EFFORT_MODEL declaration: the file's doc comment above it contains a
  // worked example reading `max: "opus"`, and an unanchored match reads the prose instead
  // of the code — the same comment-mistaken-for-config fault this check exists to catch.
  let topRung = '';
  try {
    const models = readFileSync(join(CLAUDE_DIR, 'LIFEOS/TOOLS/models.ts'), 'utf8');
    const decl = models.split(/export const EFFORT_MODEL[^=]*=/)[1] ?? '';
    topRung = decl.split('}')[0]?.match(/\bmax:\s*"([a-z0-9-]+)"/)?.[1] ?? '';
  } catch { /* handled below */ }

  const ack = modelRungAck();

  if (!topRung) {
    findings.push({ detail: 'could not resolve EFFORT_MODEL.max from LIFEOS/TOOLS/models.ts', blocking: true });
  } else if (settings.model === undefined) {
    // Non-blocking: no pin is a legitimate starting state, not a regression. A
    // fresh install has never had a pin to lose, and blocking here opened every
    // new install red on a check about a silent DOWNGRADE (public issue #1854,
    // @DRAZY). The v8.17.0 class — a pin that disagrees with the registry —
    // still blocks below.
    findings.push({
      detail: `settings.json has no "model" key — the main loop runs the harness default, while doctrine claims the top rung (${topRung}). Pin it deliberately, or ack the choice with [integrity] model_rung_ack in LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml.`,
      blocking: false,
    });
  } else if (String(settings.model).replace(/\[[^\]]*\]$/, '') !== topRung) {
    // `fable[1m]` is still the alias — the bracket is a context-window suffix the
    // harness resolves, not a pin (verified 2026-09-01: `--model fable[1m]` ran the
    // current fable id). A mismatch is the original defect class and stays blocking — unless the
    // principal has explicitly acked THIS pin. The ack names the model, so it
    // goes stale the moment the pin changes and the check re-arms itself.
    const acked = ack !== null && ack === settings.model;
    findings.push({
      detail: acked
        ? `settings.json pins model="${settings.model}" against EFFORT_MODEL.max "${topRung}" — deliberate, acked by [integrity] model_rung_ack = "${ack}"`
        : ack !== null
          ? `settings.json pins model="${settings.model}" but EFFORT_MODEL.max is "${topRung}", and the [integrity] model_rung_ack is stale (acks "${ack}") — re-ack the current pin or fix it`
          : `settings.json pins model="${settings.model}" but EFFORT_MODEL.max is "${topRung}" — config and the rung registry disagree`,
      blocking: !acked,
    });
  }

  // A pinned ID rots on the next lineup bump; the alias auto-tracks.
  if (typeof settings.model === 'string' && /\d{6,}|claude-/.test(settings.model)) {
    findings.push({ detail: `settings.json pins a model ID ("${settings.model}") rather than a tier alias — it will rot on the next lineup bump`, blocking: true });
  }

  record('model-rung-pin', findings,
    findings.length === 0 ? `main loop pinned to "${settings.model}" (top rung)`
      : findings.some(f => f.blocking) ? 'doctrine and config disagree on the main-loop rung'
      : settings.model === undefined ? 'no main-loop pin — harness default in effect'
      : 'main-loop rung is off the top rung on purpose');
}

/** The last v* tag reachable from HEAD in a repo, or null. */
function lastVersionTag(repo: string): string | null {
  try {
    return execFileSync('git', ['-C', repo, 'describe', '--tags', '--abbrev=0', '--match', 'v*'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

/**
 * --since-tag (ISC-33): the RC change window runs from the last v* tag to HEAD, not from
 * the last /ic stamp, so a release review covers everything the release will carry.
 * `commits` is `git rev-list --count <tag>..HEAD` in ~/.claude; the USER repo is counted
 * separately against its own copy of the tag when it has one.
 */
function computeTagWindow(): ChangeWindow {
  const tag = lastVersionTag(CLAUDE_DIR);
  if (!tag) {
    scanError('--since-tag: no v* tag is reachable from HEAD in the config root — the change window has no anchor');
    return { lastRun: null, commits: 0, areas: [], anchor: 'tag' };
  }
  const range = (repo: string): { commits: number; files: string[] } | null => {
    try {
      execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${tag}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return null; }
    try {
      const commits = parseInt(execFileSync('git', ['-C', repo, 'rev-list', '--count', `${tag}..HEAD`], { encoding: 'utf8' }).trim(), 10) || 0;
      const files = execFileSync('git', ['-C', repo, 'log', `${tag}..HEAD`, '--name-only', '--pretty=format:'],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
      return { commits, files };
    } catch (e: any) { scanError(`--since-tag: log of ${tag}..HEAD failed in ${repo}: ${e?.message ?? e}`); return null; }
  };
  const sys = range(CLAUDE_DIR);
  const usr = existsSync(join(USER_REPO, '.git')) ? range(USER_REPO) : null;
  const areaCounts = new Map<string, number>();
  const bump = (prefix: string, file: string) => {
    const segs = file.split('/').filter(Boolean);
    const area = prefix + segs.slice(0, Math.min(segs.length - 1, 3)).join('/');
    areaCounts.set(area, (areaCounts.get(area) ?? 0) + 1);
  };
  for (const f of sys?.files ?? []) bump('', f);
  for (const f of usr?.files ?? []) bump('USER-repo:', f);
  const areas = [...areaCounts.entries()].map(([path, files]) => ({ path, files })).sort((a, b) => b.files - a.files).slice(0, 15);
  return { lastRun: null, commits: sys?.commits ?? 0, areas, anchor: 'tag', tag, userCommits: usr?.commits };
}

function computeChangeWindow(): ChangeWindow {
  if (sinceTag) return computeTagWindow();
  let lastRun: string | null = null;
  for (const f of ['last-run.json', 'last-pass.json']) {
    try {
      const ts = JSON.parse(readFileSync(join(STATE_DIR, f), 'utf8')).ts;
      if (typeof ts === 'string' && ts) { lastRun = ts; break; }
    } catch { /* try next */ }
  }
  if (!lastRun) return { lastRun: null, commits: 0, areas: [] };

  const areaCounts = new Map<string, number>();
  const bump = (prefix: string, file: string) => {
    const segs = file.split('/').filter(Boolean);
    const area = prefix + segs.slice(0, Math.min(segs.length - 1, 3)).join('/');
    areaCounts.set(area, (areaCounts.get(area) ?? 0) + 1);
  };
  for (const f of gitChangedFiles(CLAUDE_DIR, lastRun)) bump('', f);
  for (const f of gitChangedFiles(USER_REPO, lastRun)) bump('USER-repo:', f);
  const areas = [...areaCounts.entries()]
    .map(([path, files]) => ({ path, files }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 15);
  const commits = gitCommitCount(CLAUDE_DIR, lastRun) + gitCommitCount(USER_REPO, lastRun);
  return { lastRun, commits, areas, anchor: 'run' };
}

// ── glance-thresholds (ISC-38) ─────────────────────────────────────────────
// Every Glance system threshold lives in the caller registry (assay-callers.json,
// with jev-callers.json accepted as the one-release fallback; that file name dates from Jev, retired 2026-10-10);
// an /ic check fails on a numeric literal compared against an engine probability outside the registry.
// Finds: files under hooks/, LIFEOS/, skills/ (excluding *.test.ts, node_modules, registry-loading)
// that import the judgment layer or its engine (Assay, Engine, Glance), or that still carry an identifier
// named for the retired engine (Jev, retired 2026-10-10), and contain either:
// 1. Comparisons like `.confidence >= 0.6` (inline thresholds)
// 2. Named constants matching /(floor|threshold|cutoff|min_?conf|confidence)/i assigned to 0-1 values
/** Check Glance system thresholds are registered, not hardcoded. */
function checkGlanceThresholds(): void {
  const findings: Finding[] = [];
  const EXCLUDE = ['*.test.ts', 'node_modules', 'LIFEOS/ASSAY/Engine.ts', 'LIFEOS/TOOLS/IntegrityCheck.ts', 'LIFEOS/CODEX/Mount.ts'];
  const roots = [join(CLAUDE_DIR, 'hooks'), join(CLAUDE_DIR, 'LIFEOS'), join(CLAUDE_DIR, 'skills')];

  // Regex to detect imports of the engine (ASSAY/Engine) or of the judgment layer that fronts it (ASSAY/Assay,
  // the older Glance path), with or without a .ts suffix. judge/ask/decide come from ASSAY/Assay, so a consumer
  // can hold an engine probability without naming the engine anywhere in the file.
  const glanceImportRe = /from\s+["'](?:.*\/)?(?:\.\/)?(?:Jev|Glance|Engine|Assay)(?:\.ts)?["']/; // Jev: the engine module's name until it was retired 2026-10-10
  // Regex to detect identifiers still named for the retired engine anywhere in the file, so a stale one is scanned too
  const retiredEngineIdentifierRe = /\b[A-Z_]*JEV[A-Z_]*\b|\b[a-zA-Z_]*Jev[a-zA-Z_]*\b/; // the engine's name until it was retired 2026-10-10

  // Regex to detect threshold comparisons on answer field names (inline)
  // Matches: .confidence >= 0.6, .score > 0.5, .noul <= 0.75, etc.
  const inlineThresholdRe = /\.(?:confidence|score|noul|probabilities)\s*(?:>=|>|<=|<)\s*(\d+(?:\.\d+)?)|(?:confidenceFloor|floor)\s*(?::|\s*=)\s*(\d+(?:\.\d+)?)/;

  // Regex to detect named constants: const/export const IDENTIFIER = 0.6
  // Identifier must match threshold pattern: floor, threshold, cutoff, min_conf, min_confidence, confidence, etc.
  const namedConstantRe = /(?:export\s+)?(?:const|let)\s+([A-Z_][A-Z0-9_]*)\s*(?::\s*number)?\s*=\s*(\d+(?:\.\d+)?)/;
  const thresholdNameRe = /(floor|threshold|cutoff|min_?conf|confidence)/i;

  let scanned = 0;
  for (const root of roots) {
    for (const file of findFiles(root, ['-type', 'f', '-name', '*.ts'])) {
      // Check exclusions
      if (EXCLUDE.some(ex => {
        if (ex.includes('*')) return new RegExp(ex.replace(/\./g, '\\.').replace(/\*/g, '.*')).test(file);
        return file.includes(ex);
      })) continue;

      if (!existsSync(file)) continue;
      scanned++;

      const content = readFileSync(file, 'utf8');

      // Only check files that import the judgment layer or its engine, or carry a retired-engine identifier
      const hasGlanceImport = glanceImportRe.test(content);
      const hasRetiredEngineIdentifier = retiredEngineIdentifierRe.test(content);
      if (!hasGlanceImport && !hasRetiredEngineIdentifier) continue;

      const lines = content.split('\n');
      lines.forEach((line, i) => {
        // Check for inline threshold comparisons
        const inlineMatch = inlineThresholdRe.exec(line);
        if (inlineMatch) {
          const literal = inlineMatch[1] ?? inlineMatch[2];
          // 0 and 1 are range bounds on a probability (validity checks), never a calibrated threshold.
          if (literal && Number(literal) !== 0 && Number(literal) !== 1) {
            findings.push({
              detail: `${file.replace(CLAUDE_DIR, '~/.claude')}:${i + 1} — numeric literal threshold (${literal}) for an engine probability outside the registry — move to LIFEOS/USER/CONFIG/assay-callers.json`,
              blocking: true,
            });
          }
        }

        // Check for named constants with threshold names and 0-1 values
        const constMatch = namedConstantRe.exec(line);
        if (constMatch) {
          const constName = constMatch[1];
          const literal = constMatch[2];
          if (thresholdNameRe.test(constName) && literal) {
            const num = parseFloat(literal);
            if (num >= 0 && num <= 1) {
              findings.push({
                detail: `${file.replace(CLAUDE_DIR, '~/.claude')}:${i + 1} — named threshold constant '${constName} = ${literal}' for an engine probability outside the registry — move to LIFEOS/USER/CONFIG/assay-callers.json`,
                blocking: true,
              });
            }
          }
        }
      });
    }
  }

  record('glance-thresholds', findings, `${scanned} .ts files scanned under hooks/, LIFEOS/, skills/`);
}

// ── glance-gates (ISC-3, ISC-7) ───────────────────────────────────────────
// Outside LIFEOS/ASSAY a probability meets a cut in exactly one place: decide() or yesAt(). No code indexes a caller's
// thresholds map (measure through thresholdRows, write through writeThresholdRows) and none puts a comparison operator on
// a noul's probability or a choice's probabilities[...]. The rule is Assay.ts readsCutOutsideGlance, the same function
// LIFEOS/ASSAY/tests/ThresholdReaders.test.ts runs, so the gate and the test cannot disagree. There is no allowlist: an
// entry would be a consumer comparing a probability to a cut itself, which is the failure this check exists to prevent.

/** Check no code outside Glance reads a registry cut or compares an answer's probability to one. */
async function checkGlanceGates(): Promise<void> {
  const { readsCutOutsideGlance } = await import('../ASSAY/Assay.ts');
  const findings: Finding[] = [];
  const EXCLUDE = ['*.test.ts', 'node_modules', 'LIFEOS/ASSAY/', 'LIFEOS/TOOLS/IntegrityCheck.ts'];
  const roots = [join(CLAUDE_DIR, 'hooks'), join(CLAUDE_DIR, 'LIFEOS'), join(CLAUDE_DIR, 'skills')];

  let scanned = 0;
  for (const root of roots) {
    for (const file of findFiles(root, ['-type', 'f', '-name', '*.ts'])) {
      if (EXCLUDE.some(ex => {
        if (ex.includes('*')) return new RegExp(ex.replace(/\./g, '\\.').replace(/\*/g, '.*')).test(file);
        return file.includes(ex);
      })) continue;

      if (!existsSync(file)) continue;
      scanned++;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!readsCutOutsideGlance(line)) return;
        findings.push({
          detail: `${file.replace(CLAUDE_DIR, '~/.claude')}:${i + 1} — reads a Glance registry cut or compares an engine probability itself; branch on decide() (act / wouldAct / yes) or yesAt(), and read cuts to measure through thresholdRows()`,
          blocking: true,
        });
      });
    }
  }

  record('glance-gates', findings, `${scanned} .ts files scanned under hooks/, LIFEOS/, skills/`);
}

// ── layer-one-monotone (ISC-42) ────────────────────────────────────────────
// The count of layer-one rules and their tests per guarded surface is monotone
// non-decreasing; an /ic check fails if any count decreased. Also enforces that
// the commit-message guard refuses commits removing deterministic rules while
// citing the judgment system by any of its names, current or retired 2026-10-10.
function checkLayerOneMonotone(): void {
  const findings: Finding[] = [];
  const stateFile = join(CLAUDE_DIR, 'LIFEOS', 'MEMORY', 'STATE', 'layer-one-counts.json');


  // Count layer-one rules from the four guarded surfaces
  const counts: Record<string, number> = {};

  try {
    // 1. containment-zones.ts: count zone objects
    const zonesFile = join(CLAUDE_DIR, 'hooks', 'lib', 'containment-zones.ts');
    if (existsSync(zonesFile)) {
      const content = readFileSync(zonesFile, 'utf8');
      // Look for: export const CONTAINMENT_ZONES = [ ... ];
      const match = content.match(/export\s+const\s+CONTAINMENT_ZONES[^=]*=\s*\[([\s\S]*?)\]\s*;/);
      if (match) {
        // Count zone definitions (objects that have "name:" in them)
        const zoneBody = match[1];
        counts['containment-zones'] = (zoneBody.match(/name\s*:\s*"/g) || []).length;
      }
    }

    // 2. (PreToolGuard-deny retired 2026-10-24 with the dispatcher, ISA 20261024-native-security; the
    //    snapshot keeps its last count until an --accept-drop run on the principal's yes.)

    // 3. egress-shapes.ts: count regex entries
    const egreeFile = join(CLAUDE_DIR, 'hooks', 'lib', 'egress-shapes.ts');
    if (existsSync(egreeFile)) {
      const content = readFileSync(egreeFile, 'utf8');
      // Look for arrays/exports of regexes
      const matches = content.match(/\/[a-zA-Z]*\/g?/g) || [];
      counts['egress-shapes'] = matches.length;
    }

    // 4. settings.json permissions.deny entries
    const settingsFile = join(CLAUDE_DIR, 'settings.json');
    if (existsSync(settingsFile)) {
      try {
        const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
        const denyRules = settings.permissions?.deny || [];
        counts['settings-permissions-deny'] = Array.isArray(denyRules) ? denyRules.length : 0;
      } catch { /* malformed JSON */ }
    }

    // Check if test files exist (1/0 per surface)
    for (const surface of Object.keys(counts)) {
      let testFile: string | null = null;
      if (surface === 'containment-zones') testFile = join(CLAUDE_DIR, 'hooks', 'lib', 'containment-zones.test.ts');
      else if (surface === 'egress-shapes') testFile = join(CLAUDE_DIR, 'hooks', 'lib', 'egress-shapes.test.ts');
      if (testFile && existsSync(testFile)) counts[`${surface}:test`] = 1;
    }

  } catch (e: any) {
    scanError(`layer-one-monotone: failed to count rules — ${e.message}`);
    return;
  }

  // The previous snapshot is the baseline. Only an ENOENT read establishes there is none (a first
  // run starts from empty counts); any other read failure, bad JSON or a wrong shape stops here as
  // a scan error, so a damaged snapshot can neither disable the drop check nor be replaced by a
  // fresh baseline. Repair it from the USER repo's history.
  let previousCounts: Record<string, number> = {};
  let priorAcceptedDrops: unknown[] = [];
  let snapshotRaw: string | null = null;
  try { snapshotRaw = readFileSync(stateFile, 'utf8'); }
  catch (e: any) {
    if (e?.code !== 'ENOENT') {
      scanError(`layer-one-monotone: snapshot ${stateFile.replace(HOME, '~')} unreadable (${e?.code ?? e?.message ?? e}) — the drop check cannot run`);
      return;
    }
  }
  if (snapshotRaw !== null) {
    const parsed = parseLayerOneSnapshot(snapshotRaw);
    if (!parsed.ok) {
      scanError(`layer-one-monotone: snapshot ${stateFile.replace(HOME, '~')} is malformed (${parsed.error}) — the drop check cannot run; restore it from the USER repo's history`);
      return;
    }
    previousCounts = parsed.counts;
    priorAcceptedDrops = parsed.acceptedDrops;
  }

  // A drop is a BLOCKING finding (exit 1), never a scan error (exit 2), and the snapshot is
  // never lowered, so the next run sees the same drop and blocks again (ISC-29, ISC-60). Only
  // an --accept-drop run, on the principal's yes, rewrites the snapshot at the lower count.
  const verdict = layerOneVerdict(previousCounts, counts);
  for (const d of verdict.drops) {
    findings.push({
      detail: acceptDrop
        ? `${d.key}: count dropped from ${d.from} to ${d.to} — accepted by --accept-drop, snapshot rewritten`
        : `${d.key}: count decreased from ${d.from} to ${d.to} — deterministic guard rules cannot shrink (blocks every run until an --accept-drop run on the principal's yes)`,
      blocking: !acceptDrop,
    });
  }

  if (planLayerOneWrite({ acceptDrop, section, noStamp, verdict })) {
    try {
      writeLayerOneSnapshot(stateFile, counts, verdict, acceptDrop, priorAcceptedDrops);
    } catch (e: any) {
      scanError(`layer-one-monotone: snapshot write failed — ${e.message}`);
      return;
    }
  }

  record('layer-one-monotone', findings, verdict.drops.length > 0 && !acceptDrop
    ? `${verdict.drops.length} surface count(s) dropped; snapshot held at its previous counts`
    : `${Object.keys(counts).length} surfaces monitored, counts maintained`);
}

/** Compare a layer-one snapshot with fresh counts: which keys dropped, and whether anything changed. Pure. */
/**
 * Count PreToolGuard's exported deny guards: every top-level `export function` whose return type is
 * BlockResult (utilities such as countTeeth return something else and are not counted). A parameter
 * list may carry a default argument with its own parentheses (publishPreflightGuard's
 * `deps = defaultPreflightDeps()`), so the match balances two levels of parentheses instead of
 * ending at the first `)`. Pure.
 */
export function countBlockResultGuards(source: string): number {
  const re = /^export\s+function\s+\w+\s*\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)\s*:\s*BlockResult\b/gm;
  return (source.match(re) || []).length;
}

export function layerOneVerdict(previous: Record<string, number>, current: Record<string, number>): {
  drops: { key: string; from: number; to: number }[];
  changed: boolean;
} {
  const drops: { key: string; from: number; to: number }[] = [];
  for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    const from = previous[key] ?? 0, to = current[key] ?? 0;
    if (to < from) drops.push({ key, from, to });
  }
  const changed = JSON.stringify(Object.entries(previous).sort()) !== JSON.stringify(Object.entries(current).sort());
  return { drops, changed };
}

/**
 * Parse layer-one-counts.json strictly: a JSON object whose `counts` is an object of non-negative
 * integers, and whose optional `acceptedDrops` is an array. Anything else is an error, never an
 * empty baseline. Pure.
 */
export function parseLayerOneSnapshot(raw: string):
  | { ok: true; counts: Record<string, number>; acceptedDrops: unknown[] }
  | { ok: false; error: string } {
  let v: unknown;
  try { v = JSON.parse(raw); } catch (e: any) { return { ok: false, error: `not JSON: ${e?.message ?? e}` }; }
  if (!isObj(v)) return { ok: false, error: 'not a JSON object' };
  if (!isObj(v.counts)) return { ok: false, error: 'no counts object' };
  const counts: Record<string, number> = {};
  for (const [key, n] of Object.entries(v.counts)) {
    if (!Number.isInteger(n) || (n as number) < 0) return { ok: false, error: `counts.${key} is not a non-negative integer` };
    counts[key] = n as number;
  }
  if (v.acceptedDrops !== undefined && !Array.isArray(v.acceptedDrops)) return { ok: false, error: 'acceptedDrops is not an array' };
  return { ok: true, counts, acceptedDrops: (v.acceptedDrops as unknown[] | undefined) ?? [] };
}

/** Whether this run writes layer-one-counts.json. Pure. */
export function planLayerOneWrite(p: {
  acceptDrop: boolean;
  section: string | null;
  noStamp: boolean;
  verdict: ReturnType<typeof layerOneVerdict>;
}): boolean {
  // An --accept-drop run (full or its own section) always rewrites the snapshot (ISC-29/60).
  if (p.acceptDrop) return true;
  // Otherwise only a stamping run (full, no --no-stamp) writes, and only a drop-free change
  // (ISC-30): a drop holds the snapshot at its previous counts so the blocking finding repeats
  // on every run. Attempting the write here tripped writeLayerOneSnapshot's invariant and turned
  // the drop into a scan error that hid the finding (review 2026-10-12).
  return p.section === null && !p.noStamp && p.verdict.changed && p.verdict.drops.length === 0;
}

/** Write layer-one-counts.json. Never lowers a count unless the run carries --accept-drop. */
function writeLayerOneSnapshot(
  stateFile: string,
  counts: Record<string, number>,
  verdict: ReturnType<typeof layerOneVerdict>,
  accepted: boolean,
  priorAcceptedDrops: unknown[],
): void {
  invariant(accepted || verdict.drops.length === 0,
    `layer-one snapshot would lower ${verdict.drops.map(d => d.key).join(', ')} without --accept-drop`);
  invariant(accepted || (section === null && !noStamp), 'layer-one snapshot written by a --section or --no-stamp run');
  invariant(Object.values(counts).every(n => Number.isInteger(n) && n >= 0), 'layer-one snapshot counts must be non-negative integers');
  const acceptedDrops: unknown[] = [...priorAcceptedDrops];
  const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  if (accepted) for (const d of verdict.drops) acceptedDrops.push({ at, ...d, runId });
  const snapshot = {
    note: 'Layer-one rule counts per guarded surface — monotone non-decreasing gate; only an --accept-drop run lowers a count',
    checked: at,
    counts,
    ...(acceptedDrops.length > 0 ? { acceptedDrops } : {}),
  };
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(snapshot, null, 2) + '\n');
}

// ── estate assert coverage (M4/M5, 20260831-eval-assert-system) ─────────────
// Every ISC an assert: the estate-wide readout. Non-blocking while the M3
// retrofit burns down the backlog (blocking now would fail every /ic until
// then and manufacture nothing); the budget entry keeps it one summary line.
// Computes live via Bunker's coverageOf over live ISAs (system + project
// trees) — same population as the program's EstateCoverageSweep.
async function checkAssertCoverage(): Promise<void> {
  const findings: Finding[] = [];
  const bunkerIsaPath = join(CLAUDE_DIR, 'LIFEOS', 'PULSE', 'Bunker', 'src', 'isa.ts');
  if (!existsSync(bunkerIsaPath)) {
    record('assert-coverage', [], 'Bunker not installed — estate assert coverage not computed');
    return;
  }
  try {
    const { coverageOf } = await import(bunkerIsaPath) as { coverageOf: (p: string) => { totalClaims: number; assertedClaims: number; manualOnly: string[]; unprobed: string[] } };
    const home = homedir();
    const paths: string[] = [];
    for (const d of readdirSync(join(CLAUDE_DIR, 'LIFEOS'), { withFileTypes: true })) {
      const p = join(CLAUDE_DIR, 'LIFEOS', d.name, 'ISA.md');
      if (d.isDirectory() && existsSync(p)) paths.push(p);
    }
    for (const root of [join(home, 'Projects'), join(home, 'LocalProjects')]) {
      if (!existsSync(root)) continue;
      for (const d of readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        for (const f of ['ISA.md', 'bunker.isa.md']) {
          const p = join(root, d.name, f);
          if (existsSync(p)) paths.push(p);
        }
      }
    }
    let claims = 0, asserted = 0, unprobed = 0, manualOnly = 0, isas = 0;
    const worst: { path: string; unprobed: number }[] = [];
    for (const p of paths) {
      try {
        const c = coverageOf(p);
        isas++;
        claims += c.totalClaims; asserted += c.assertedClaims;
        unprobed += c.unprobed.length; manualOnly += c.manualOnly.length;
        if (c.unprobed.length) worst.push({ path: p.replace(home, '~'), unprobed: c.unprobed.length });
      } catch { /* malformed table — bunker test surfaces it per-app */ }
    }
    if (unprobed > 0) {
      worst.sort((a, b) => b.unprobed - a.unprobed);
      const pct = claims ? Math.round((asserted / claims) * 100) : 0;
      findings.push({
        detail: `estate assert coverage: ${asserted}/${claims} criteria asserted (${pct}%) · ${unprobed} without any assert · ${manualOnly} manual exceptions across ${isas} live ISAs — worst: ${worst.slice(0, 3).map(w => `${w.path} (${w.unprobed})`).join(', ')} · retrofit legacy ISAs by sweep (add a Test Strategy row per criterion)`,
        blocking: false,
      });
    }
    record('assert-coverage', findings, `${isas} live ISAs scanned`);
  } catch (e) {
    scanError(`assert-coverage: ${String(e).slice(0, 120)}`);
  }
}

// ── rc-workflow-safety (ISC-27, 20261009-release-rebuild; ISC-8, 20261013-losintegrity) ──
// The release workflow scripts (/rc and /losintegrity) hand prompts to unnamed agents. No agent
// may be told to push, tag, bump, ingest, preflight or publish: those stay in the main session
// behind UpdateKaiRepo's gates and the principal's yes. Both scripts are held to RC_FORBIDDEN.
// Every command-shaped string in ReleaseCandidate.mjs must be on RC_ALLOWED_HEADS; LOSIntegrity.mjs
// may also name LOSI_EXTRA_HEADS, which never widens the RC set. A missing script fails closed
// whenever the release tooling is installed (a public install has neither, and skips).
const RC_WORKFLOW_REL = 'private-maintenance-tooling-not-included/Intents/ReleaseCandidate.mjs';
const LOSI_WORKFLOW_REL = 'private-maintenance-tooling-not-included/Intents/LOSIntegrity.mjs';

/** Shapes no RC workflow agent may ever be told to run. Mirrors the ISC-27 probe, plus the bump/commit/override doors. */
export const RC_FORBIDDEN: { re: RegExp; why: string }[] = [
  { re: /\bbun\s+[^\s'"`]*UpdateKaiRepo/, why: 'runs UpdateKaiRepo (bump, tag and push belong to the main session)' },
  { re: /\bgit\s+(?:-C\s+\S+\s+)?(?:push|tag|commit|reset|stash|checkout|switch|rebase|merge|cherry-pick|revert|am|apply|clean|add|rm|mv|update-ref|update-index|notes)(?![\w-])/, why: 'a git write (push, tag, commit or a tree/index/ref change)' },
  { re: /\brelease\.ts\s+(?:preflight|publish|audit)\b/, why: 'release.ts preflight, publish or audit runs from the main session only' },
  { re: /\baudit\.ts\s+ingest\b/, why: 'verdict ingest is the main session’s deterministic step' },
  { re: /--accept(?![\w])/, why: 'an --accept flag (classify accept, --accept-drop) is the principal’s decision' },
  { re: /--confirm-(?:feature|major)\b/, why: 'a level confirmation is the principal’s decision' },
  { re: /--skip-integrity\b/, why: 'skips the integrity gate' },
  { re: /--force(?![\w-])/, why: 'a bare --force overrides a gate (--force-clean is the allowed recut flag)' },
  { re: /\bbun\s+-e\b/, why: 'inline code can run anything' },
  { re: /\b(?:sh|bash|zsh)\s+-c\b/, why: 'a shell string can run anything' },
];

/** Every command head the RC workflow may name. Anything command-shaped outside this set fails the check. */
export const RC_ALLOWED_HEADS = new Set<string>([
  // read-only checks the prepare phase runs
  'IntegrityCheck.ts', 'DenyListCheck.ts', 'ArchDecisionHarvest.ts', 'ClassifyChange.ts', 'ReferenceCheck.ts', 'trufflehog',
  // the cut phase and its advisory legacy parity
  'release.ts', 'release.ts classify', 'release.ts cut', 'ShadowRelease.ts', 'ReleaseAudit.ts', 'EmitSkill.ts',
  // bare mentions of the ingest module and the script itself
  'audit.ts', 'ReleaseCandidate.mjs',
  // the time-limit wrapper; the command it wraps sits on the same line and is scanned too
  'Deadline.ts',
  // read-only git for the pin check
  'git rev-parse', 'git ls-remote', 'git merge-base', 'git show', 'git cat-file', 'git log', 'git describe',
  'git diff', 'git rev-list', 'git status', 'git ls-tree', 'git ls-files', 'git for-each-ref',
]);

/** Heads LOSIntegrity.mjs may name beyond RC_ALLOWED_HEADS. Scanned only for that script; ReleaseCandidate.mjs never gets them. */
export const LOSI_EXTRA_HEADS: ReadonlySet<string> = new Set<string>([
  // the baseline legs /rc does not run: skill hygiene, the release and installer test suites
  'SkillHygieneGate.ts', 'bun test',
  // files the installer lane reads, named in its prompt; neither is run
  'DeployComponents.ts', 'boot.ts',
  // a bare mention of the script itself
  'LOSIntegrity.mjs',
]);

/** The workflow scripts rc-workflow-safety scans, each with the heads it may name beyond RC_ALLOWED_HEADS. */
export const RC_WORKFLOW_SCRIPTS: ReadonlyArray<{ rel: string; extraHeads: ReadonlySet<string> }> = [
  { rel: RC_WORKFLOW_REL, extraHeads: new Set<string>() },
  { rel: LOSI_WORKFLOW_REL, extraHeads: LOSI_EXTRA_HEADS },
];

const GIT_SUBCOMMANDS = new Set(['add', 'am', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'cat-file', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit', 'commit-tree', 'config', 'describe', 'diff', 'fetch', 'for-each-ref', 'gc', 'grep', 'hash-object', 'init', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge', 'merge-base', 'mv', 'notes', 'pull', 'push', 'rebase', 'reflog', 'remote', 'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'show', 'stash', 'status', 'submodule', 'switch', 'tag', 'update-index', 'update-ref', 'worktree', 'write-tree']);
/** Git subcommands that write: a push, tag or commit, or a change to the tree, index or refs. Mirrors RC_FORBIDDEN's git shape. */
const GIT_WRITE_SUBCOMMANDS = new Set(['push', 'tag', 'commit', 'reset', 'stash', 'checkout', 'switch', 'rebase', 'merge', 'cherry-pick', 'revert', 'am', 'apply', 'clean', 'add', 'rm', 'mv', 'update-ref', 'update-index', 'notes']);
/** Git global options that take the next argument (or `=value`) and change only where git looks. */
const GIT_VALUE_OPTIONS = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--attr-source']);
/** Git global options that take no argument and run nothing. */
const GIT_FLAG_OPTIONS = new Set(['--no-pager', '-P', '-p', '--paginate', '--bare', '--no-replace-objects', '--no-lazy-fetch', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-advice']);
/** Git global options that end the command without a subcommand. */
const GIT_TERMINAL_OPTIONS = new Set(['--version', '-v', '--help', '-h', '--html-path', '--man-path', '--info-path']);
/** Git global options that can run arbitrary code even under a read-only subcommand (alias.*, core.fsmonitor, core.pager, a swapped exec path). */
const GIT_CODE_OPTIONS = new Set(['-c', '--config-env', '--exec-path']);

/**
 * Read one git invocation from its words after `git`: skip its global options and name the subcommand.
 * `problem` is set for a code-running option (-c, --config-env, --exec-path), an option git would not take,
 * a value option with no value, or options followed by no subcommand. `args` are the words after the
 * subcommand. Prose such as "the git objects" reads as an unknown subcommand with no options. Pure.
 */
export function parseGitWords(words: string[]): { sub: string | null; globals: string[]; problem: string | null; args: string[] } {
  const globals: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const tok = words[i];
    if (!tok.startsWith('-')) {
      const sub = /^[a-z][a-z-]*/.exec(tok)?.[0] ?? null;
      if (sub === null && globals.length > 0) return { sub: null, globals, problem: `no subcommand after git ${globals.join(' ')}`, args: [] };
      return { sub, globals, problem: null, args: sub === null ? [] : words.slice(i + 1) };
    }
    const name = tok.split('=')[0];
    if (GIT_CODE_OPTIONS.has(name)) return { sub: null, globals: [...globals, name], problem: `git ${name} can run arbitrary code through config or the exec path`, args: [] };
    if (GIT_TERMINAL_OPTIONS.has(tok)) return { sub: null, globals: [...globals, tok], problem: null, args: [] };
    if (GIT_FLAG_OPTIONS.has(tok)) { globals.push(tok); continue; }
    if (GIT_VALUE_OPTIONS.has(name)) {
      globals.push(name);
      if (tok.includes('=') && name.startsWith('--')) continue;
      if (i + 1 >= words.length) return { sub: null, globals, problem: `git ${name} has no value`, args: [] };
      i++;
      continue;
    }
    return { sub: null, globals, problem: `unrecognized git option ${name.replace(/[`'";)]+$/, '')}`, args: [] };
  }
  return { sub: null, globals, problem: globals.length > 0 ? `no subcommand after git ${globals.join(' ')}` : null, args: [] };
}

/** A `<name>` placeholder in a prompt template. A shell reads it as two redirects, and the `>` would swallow the next word. */
const TEMPLATE_PLACEHOLDER = /<[A-Za-z][\w.:/-]*>/g;

/**
 * The git command that starts `text` (from a `git` word to the end of its source line), read through the shared
 * shell parser (hooks/lib/shell-commands), never a local tokenizer (S069): quotes, separators, pipes and
 * substitutions end or join words the way a shell does, so `git diff "HEAD" --output=x` keeps its option.
 *
 * The line is script source, not shell, so a closing string quote can turn the rest of the line into one quoted
 * word. The same text with every quote removed is parsed as a second view: `args` are the words after the
 * subcommand as written, and `argViews` holds them from both views, so an option is never hidden by the quote
 * state. Subcommand and global options come from the text as written. A parser failure or a too-deep nesting is
 * a problem: the line cannot be proven read-only. Pure.
 */
export function readGitCommand(text: string): { sub: string | null; globals: string[]; problem: string | null; args: string[]; argViews: string[][] } {
  const src = text.replace(TEMPLATE_PLACEHOLDER, 'PLACEHOLDER');
  const firstGitArgv = (view: string): string[] | null | 'deep' => {
    const walk = shellSteps(view);
    if (walk.tooDeep) return 'deep';
    const first = walk.steps.find(s => s.depth === 0 && s.argv.length > 0);
    return first && programName(first.argv[0]) === 'git' ? first.argv.slice(1) : null;
  };
  let written: string[] | null | 'deep';
  try { written = firstGitArgv(src); }
  catch (e: any) { return { sub: null, globals: [], problem: `the shell parser could not read it (${String(e?.message ?? e).split('\n')[0]})`, args: [], argViews: [] }; }
  if (written === 'deep') return { sub: null, globals: [], problem: 'it nests shells deeper than the parser follows', args: [], argViews: [] };
  if (written === null) return { sub: null, globals: [], problem: null, args: [], argViews: [] };
  const g = parseGitWords(written);
  if (g.problem || g.sub === null) return { ...g, argViews: [] };
  let unquoted: string[] | null | 'deep' = null;
  try { unquoted = firstGitArgv(src.replace(/['"`]/g, '')); } catch { unquoted = null; }
  return { ...g, argViews: Array.isArray(unquoted) ? [g.args, parseGitWords(unquoted).args] : [g.args] };
}

/** parseGitWords over the text after `git `, read by the shared shell parser. Kept for callers that pass the text. Pure. */
export function parseGitInvocation(rest: string): { sub: string | null; globals: string[]; problem: string | null } {
  const { args: _args, argViews: _views, ...invocation } = readGitCommand(`git ${rest}`);
  return invocation;
}

/**
 * Subcommand options that write a file or run a program even under a read-only git subcommand: an output
 * file, an external diff driver, a text-conversion or filter program, a remote helper or pager command.
 * Git accepts any unique prefix of a long option, down to one letter after the dashes (`git ls-remote --u=prog`
 * is --upload-pack), so every prefix of a hazard counts, unless the word is an exact option of THAT subcommand
 * that names something else (GIT_ARG_EXACT_SAFE: diff's `--text` is its own option, while on cat-file, which
 * has no --text, the same word abbreviates --textconv).
 */
const GIT_ARG_HAZARDS = ['--output', '--output-directory', '--ext-diff', '--textconv', '--filters', '--upload-pack', '--receive-pack', '--exec', '--open-files-in-pager'];
/** Per subcommand: its own exact options that are a proper prefix of a hazard but name a different, read-only option. */
const GIT_ARG_EXACT_SAFE: Readonly<Record<string, ReadonlySet<string>>> = {
  diff: new Set(['--text']), log: new Set(['--text']), show: new Set(['--text']), grep: new Set(['--text']),
  'rev-list': new Set(['--filter']),
};
/** Short spellings of the same, per subcommand (attached values and bundled flags included: `-u<prog>`, `-qu`). */
const GIT_SHORT_HAZARDS: Record<string, string[]> = { 'ls-remote': ['-u'], fetch: ['-u'], clone: ['-u'], grep: ['-O'], 'format-patch': ['-o'] };

/** Why a git argument vector can write or run code under its subcommand, or null when none of its options can. Pure. */
export function gitArgHazard(sub: string, args: string[]): string | null {
  const exactSafe = GIT_ARG_EXACT_SAFE[sub];
  for (const a of args) {
    if (a === '--') break;
    if (a.startsWith('--')) {
      // The option name only: script punctuation glued on by the source line (`--ext-diff',`) never hides it.
      const name = /^--[A-Za-z0-9][A-Za-z0-9-]*/.exec(a)?.[0] ?? a.split('=')[0];
      if (exactSafe?.has(name)) continue;
      const hit = GIT_ARG_HAZARDS.find(h => h.startsWith(name));
      if (hit) return `git ${sub} ${name} (${hit}) writes a file or runs a program`;
    } else if (a.startsWith('-') && a.length > 1) {
      // A short cluster: any hazard letter in it counts, since git bundles flags (`-qu prog` is -q -u prog).
      const short = (GIT_SHORT_HAZARDS[sub] ?? []).find(f => a.slice(1).includes(f.slice(1)));
      if (short) return `git ${sub} ${short} writes a file or runs a program`;
    }
  }
  return null;
}

/** How git reads a subcommand word. */
export type GitSubKind = 'known' | 'runnable' | 'prose';
/**
 * Whether git would run `word` as a subcommand. Git takes the whole word: a builtin when it is one exactly, else
 * an alias (alias names are letters, digits and dashes), so `log2` is an alias, never `git log`. Punctuation the
 * script source glues on (`status',`) is not part of the command. A word git could not run at all, a sentence
 * such as "from git objects.", is prose. `name` is the command or alias git would look up. Pure.
 */
export function gitSubcommandKind(word: string): { kind: GitSubKind; name: string } {
  const m = /^[A-Za-z0-9][A-Za-z0-9-]*/.exec(word);
  if (!m) return { kind: 'prose', name: '' };
  // A sentence end glued on (`branch2.`, `evil.`) does not make the word prose: git still tries to run it
  // (closing pass, S069), so it is read like any other word; prose is decided by argument position instead.
  return { kind: GIT_SUBCOMMANDS.has(m[0]) ? 'known' : 'runnable', name: m[0] };
}

/** One git step of a source line: the parsed invocation, the word git reads as its subcommand, and the text it starts at. */
export interface GitStep { sub: string | null; word: string | null; globals: string[]; problem: string | null; args: string[]; text: string; argPos?: boolean }

/** Redirect destinations that discard or pass output through and write no file. */
const HARMLESS_WRITE_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);
/** Programs that, fed a git command's output in the same pipeline or list, write a file (tee) or run it as code. */
const GIT_VIEW_WRITERS = new Set(['tee']);
// (`.` and `source` read a named file, never the piped output, and `.` is a sentence end in prompt prose.)
const GIT_VIEW_RUNNERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'eval', 'xargs', 'node', 'deno', 'python', 'python3', 'perl', 'ruby', 'php', 'osascript']);

/**
 * The git steps of one shell view, at every depth (a `$(git …)` runs too), and what the view writes or runs
 * besides: every redirect target the shared parser reports for any of its steps (S069 round 3: `git diff HEAD >
 * /tmp/x` writes a file even though git's own arguments are read-only), a `tee` destination, and any shell or
 * interpreter the output is fed to. 'deep' when it nests past the parser. Throws on a parser failure.
 */
function gitStepsOf(view: string, text: string, argPos = false): { steps: GitStep[]; writes: string[] } | 'deep' {
  const walk = shellSteps(view);
  if (walk.tooDeep) return 'deep';
  // `argPos`: the git word the view starts at is an argument of the words before it in the source line, so the
  // view's lead step is marked; the scanner reads an alias word there as prose. Writes are collected regardless.
  const lead = walk.steps.find(s => s.depth === 0 && s.argv.length > 0);
  const writes: string[] = [];
  for (const s of walk.steps) {
    // Script punctuation the source line glues on after the shell text (`2>/dev/null',`) is not part of the target.
    for (const t of s.writeTargets) if (!HARMLESS_WRITE_TARGETS.has(t.replace(/[,;)\]}'"`]+$/, ''))) writes.push(`a redirect to ${t}`);
    if (s.argv.length === 0) continue;
    const prog = programName(s.argv[0].replace(/[,;)\]}'"`]+$/, ''));
    if (GIT_VIEW_WRITERS.has(prog)) writes.push(`${prog} ${s.argv.slice(1).filter(a => !a.startsWith('-')).join(' ')}`.trim());
    if (GIT_VIEW_RUNNERS.has(prog)) writes.push(`${prog} (runs code)`);
  }
  const steps = walk.steps.filter(s => s.argv.length > 0 && programName(s.argv[0]) === 'git').map(s => {
    const words = s.argv.slice(1);
    const g = parseGitWords(words);
    const word = g.sub !== null ? words[words.length - g.args.length - 1] ?? null
      : g.problem === null && g.globals.length === 0 && words.length > 0 && !words[0].startsWith('-') ? words[0] : null;
    return { ...g, word, text, ...(argPos && s === lead ? { argPos: true } : {}) };
  });
  return { steps, writes };
}

/**
 * Whether the git word at `at` is an argument of the words before it rather than a command: prose such as "the
 * git objects are fine" names git without running it. The shared parser decides, reading from each
 * whitespace-separated word before it back to the line start: if any reading runs git anywhere (wrappers such as `env`, `sudo` or
 * `timeout 5` are the parser's to peel), git is a command. Only a git word that directly follows a plain word is
 * a candidate; one after a quote, separator or the line start is always a command. A parser failure counts as a
 * command (fail closed). Pure.
 */
// Final review round 2: the lookback runs to the line start, so a wrapper with any number of flags
// (`timeout -k 1 5`, `sudo -u root -g wheel`) is still peeled by the parser; a three-word lookback read
// `timeout -k 1 5 git branch2` as prose. Past MAX_LOOKBACK_WORDS the git word counts as a command (fail closed).
// Closing pass (S069): 256 refused harmless prose HEAD accepted ("echo" plus 255 words before "git objects");
// 1024 words covers any real source line (the workflow scripts' longest git line is 22 words) at about 50 ms
// measured per git word, and a longer line still fails closed.
const MAX_LOOKBACK_WORDS = 1024;
function gitInArgumentPosition(line: string, at: number): boolean {
  let k = at;
  let words = 0;
  while (true) {
    if (words >= MAX_LOOKBACK_WORDS) return false;
    let j = k;
    while (j > 0 && /\s/.test(line[j - 1])) j--;
    if (j === k || j === 0) return words > 0;
    if (words === 0 && !/[A-Za-z0-9]/.test(line[j - 1])) return false;
    while (j > 0 && !/\s/.test(line[j - 1])) j--;
    words++;
    // A script string's opening quote (`'env git …`) is where the shell text starts, not part of it.
    let from = j;
    while (from < at && /['"`]/.test(line[from])) from++;
    try {
      // Any step of that reading, at any depth, that runs git counts (`$(timeout 5 git …)` runs it one level down).
      const walk = shellSteps(line.slice(from).replace(TEMPLATE_PLACEHOLDER, 'PLACEHOLDER'));
      if (walk.tooDeep || walk.steps.some(s => s.argv.length > 0 && programName(s.argv[0]) === 'git')) return false;
    } catch { return false; }
    k = j;
  }
  return true;
}

/**
 * Characters before which a word, and so a git command, can start in script source: any non-word character, the
 * same set HEAD's `\bgit` matched after. A parameter-expansion word is a command position the parser does not
 * expand (`${X:-git -c …}`, `${X:+git …}`, `${X/a/git …}`), so a narrower set missed it (closing pass, S069).
 */
const WORD_BOUNDARY = /[^A-Za-z0-9_]/;
/** Longest word gitWordStarts reads in full; a longer word that mentions git is handed to the parser anyway. */
const MAX_WORD_READ = 4096;
/**
 * Every offset in a source line where a shell word that runs git can begin: the whole word up to the next
 * whitespace, with quotes and backslashes dropped as a shell drops them (`g"it"`, `"git"`, `\git`), is named by
 * the shared parser's own executable normalization (`programName`), so `/usr/bin/git` and any other path to git
 * count (S069 round 3), not just the bare word. A shell variable named for git (`$git`, `${GIT}`, `"$git_bin"`)
 * in that place runs whatever it holds, which the scanner cannot see, so it is read as git: `as` is the line with
 * that expansion replaced by `git` (final review round 2: HEAD's `\bgit\s+` refused `$git -c core.fsmonitor=…`).
 * A name that only begins with the letters (`$GITHUB_TOKEN`, `$gitDir`) is not git. Pure.
 */
const GIT_VARIABLE_WORD = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/;
const GIT_VARIABLE_NAME = /^git(?![a-z0-9])/i;
const SHELL_EXPANSION = /\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/;
function gitWordStarts(line: string): Array<{ at: number; as: string }> {
  const starts: Array<{ at: number; as: string }> = [];
  for (let i = 0; i < line.length; i++) {
    if (i > 0 && !WORD_BOUNDARY.test(line[i - 1])) continue;
    let read = '';
    let ended = false;
    let tooLong = false;
    let end = line.length;
    for (let j = i; j < line.length; j++) {
      const c = line[j];
      if (c === "'" || c === '"' || c === '`' || c === '\\') continue;
      if (/\s/.test(c)) { ended = true; end = j; break; }
      if (read.length >= MAX_WORD_READ) { tooLong = true; break; }
      read += c;
    }
    if (tooLong ? /git/i.test(read) : ended && read !== '' && programName(read) === 'git') { starts.push({ at: i, as: line }); continue; }
    if (!ended || tooLong) continue;
    const v = GIT_VARIABLE_WORD.exec(read);
    if (!v || !GIT_VARIABLE_NAME.test(v[1] ?? v[2])) continue;
    // Replace only the expansion, keeping any quotes around it (`"$git" status` reads as `"git" status`).
    const raw = line.slice(i, end);
    const m = SHELL_EXPANSION.exec(raw);
    const word = m ? raw.slice(0, m.index) + 'git' + raw.slice(m.index + m[0].length) : 'git';
    starts.push({ at: i, as: line.slice(0, i) + word + line.slice(end) });
  }
  return starts;
}

/**
 * Every git command in one script source line, read by the shared shell parser from each place a git word can
 * start, every step of each (S069 round 2: `git diff HEAD; g"it" diff --output=x` is two git commands, and the
 * second hides from a `\bgit\s+` regex). `steps` come from the text as written; `quotelessArgs` are the same
 * commands read with every quote removed, for the option check only, so a quote closed mid-line never hides an
 * option. A parser failure or too-deep nesting is a step with a problem: the line cannot be proven read-only.
 * Duplicates (the same command reached from two starts) are dropped. Pure.
 */
export function readGitCommands(line: string): { steps: GitStep[]; quotelessArgs: Array<{ sub: string; args: string[] }>; writes: string[] } {
  const steps: GitStep[] = [];
  const quotelessArgs: Array<{ sub: string; args: string[] }> = [];
  const writes = new Set<string>();
  const seen = new Set<string>();
  const seenArgs = new Set<string>();
  for (const { at, as } of gitWordStarts(line)) {
    // `as` is the line itself, or the line with a git-named variable read as git (gitWordStarts).
    const text = as.slice(at).trim().slice(0, 80);
    const src = as.slice(at).replace(TEMPLATE_PLACEHOLDER, 'PLACEHOLDER');
    let written: GitStep[];
    try {
      const r = gitStepsOf(src, text, gitInArgumentPosition(as, at));
      if (r === 'deep') written = [{ sub: null, word: null, globals: [], problem: 'it nests shells deeper than the parser follows', args: [], text }];
      else { written = r.steps; for (const w of r.writes) writes.add(w); }
    }
    catch (e: any) { written = [{ sub: null, word: null, globals: [], problem: `the shell parser could not read it (${String(e?.message ?? e).split('\n')[0]})`, args: [], text }]; }
    for (const s of written) {
      const key = JSON.stringify([s.sub, s.word, s.globals, s.problem, s.args, s.argPos === true]);
      if (!seen.has(key)) { seen.add(key); steps.push(s); }
    }
    let quoteless: ReturnType<typeof gitStepsOf> = { steps: [], writes: [] };
    try { quoteless = gitStepsOf(src.replace(/['"`]/g, ''), text); } catch { quoteless = { steps: [], writes: [] }; }
    if (quoteless === 'deep') continue;
    for (const w of quoteless.writes) writes.add(w);
    for (const s of quoteless.steps) {
      const sub = s.word !== null ? gitSubcommandKind(s.word).name : "";
      if (sub === "") continue;
      const key = JSON.stringify([sub, s.args]);
      if (!seenArgs.has(key)) { seenArgs.add(key); quotelessArgs.push({ sub, args: s.args }); }
    }
  }
  return { steps, quotelessArgs, writes: [...writes] };
}

const BUN_SUBCOMMANDS = new Set(['test', 'run', 'x', 'install', 'add', 'build', 'pm', 'link', 'update', 'remove', 'upgrade', 'create', 'init', 'exec']);
const SCRIPT_SUBCOMMANDS: Record<string, Set<string>> = {
  'release.ts': new Set(['classify', 'cut', 'audit', 'preflight', 'publish', 'status', 'export', 'scan', 'references', 'contract', 'boot', 'ingest', 'verify', 'list', 'stage']),
  'audit.ts': new Set(['ingest', 'finalize', 'stage', 'run', 'status']),
};
const OTHER_PROGRAMS = /\b(gh|curl|wget|rm|npx|bunx|ssh|scp|rsync|launchctl|osascript|wrangler|trufflehog|tee)\s+(?=\S)/g;

/** Find every command-shaped string in a workflow script and every one that is forbidden or off the allowlist
 *  (RC_ALLOWED_HEADS plus `extraHeads`, which defaults to none). Pure. */
export function scanRcWorkflow(text: string, extraHeads: ReadonlySet<string> = new Set<string>()): { heads: string[]; violations: string[] } {
  const heads: string[] = [];
  const violations: string[] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const at = `${i + 1}`;
    for (const f of RC_FORBIDDEN) {
      const m = line.match(f.re);
      if (m) violations.push(`${at}: forbidden "${m[0].trim()}" — ${f.why}`);
    }
    const found: string[] = [];
    for (const m of line.matchAll(/([A-Za-z][\w-]*\.(?:ts|mjs))(?![\w.])(?:[\s'"`]+([a-z][\w-]*))?/g)) {
      const script = m[1], next = m[2];
      found.push(next && SCRIPT_SUBCOMMANDS[script]?.has(next) ? `${script} ${next}` : script);
    }
    for (const m of line.matchAll(/\bbun\s+([-\w]+)/g)) {
      if (m[1] === '-e' || BUN_SUBCOMMANDS.has(m[1])) found.push(`bun ${m[1]}`);
    }
    // Argv-aware: global options before the subcommand cannot hide it.
    const forbiddenGitShape = RC_FORBIDDEN.some(f => f.why.startsWith('a git write') && f.re.test(line));
    // Every git command on the line, from every place a git word can start, each step of each (S069 round 2).
    const git = readGitCommands(line);
    const gitHeads = new Set<string>();
    for (const g of git.steps) {
      if (g.problem) { violations.push(`${at}: "${g.text}" — ${g.problem}; the scanner cannot prove it read-only`); continue; }
      if (g.word === null) continue;
      const { kind, name } = gitSubcommandKind(g.word);
      // A word git could not run (a sentence such as "from git objects.") is prose, not a command.
      if (kind === 'prose') continue;
      // A non-builtin word after a git that is itself an argument of the words before it ("the git objects are
      // fine") is prose, as it was before round 2; at a command position it is an alias and still fails closed.
      // An alias that extends a builtin name (`branch2`, `log-x`) is command-shaped, never prose, so it is refused
      // even behind a wrapper the parser does not peel (`ionice git branch2`); HEAD read it as the builtin.
      const builtinStem = /^[a-z][a-z-]*/.exec(name)?.[0];
      const extendsBuiltin = builtinStem !== undefined && builtinStem !== name && GIT_SUBCOMMANDS.has(builtinStem);
      if (kind === 'runnable' && g.argPos === true && g.globals.length === 0 && !extendsBuiltin) continue;
      // Argv-aware past the subcommand too: a read-only subcommand given an output file or an external program is not read-only (S069).
      const hazard = gitArgHazard(name, g.args);
      if (hazard) violations.push(`${at}: "${g.text}" — ${hazard}; the rc workflow may only read`);
      if (GIT_WRITE_SUBCOMMANDS.has(name) && !forbiddenGitShape) violations.push(`${at}: forbidden "git ${[...g.globals, name].join(' … ')}" — a git write (push, tag, commit or a tree/index/ref change)`);
      if (kind === 'runnable' && g.globals.length > 0) { violations.push(`${at}: "git ${name}" after global options is not a git subcommand (an alias?) — the scanner cannot prove it read-only`); continue; }
      // Any other word git would run, a builtin or an alias, is a head and must be on the allowlist: an unknown
      // subcommand fails closed (S069 round 2: `git format-patch` writes patch files by default).
      gitHeads.add(`git ${name}`);
    }
    for (const q of git.quotelessArgs) {
      const hazard = gitArgHazard(q.sub, q.args);
      if (hazard && !violations.some(v => v.startsWith(`${at}: `) && v.includes(hazard))) violations.push(`${at}: (read without quotes) ${hazard}; the rc workflow may only read`);
    }
    // What the shared parser says the git command line writes or runs beyond git's own arguments (S069 round 3).
    for (const w of git.writes) violations.push(`${at}: a git command line writes or runs code (${w}); the rc workflow may only read`);
    found.push(...gitHeads);
    for (const m of line.matchAll(OTHER_PROGRAMS)) found.push(m[1]);
    for (const h of found) {
      heads.push(h);
      if (!RC_ALLOWED_HEADS.has(h) && !extraHeads.has(h)) violations.push(`${at}: "${h}" is command-shaped and not on the rc-workflow allowlist`);
    }
  });
  return { heads, violations };
}

function checkRcWorkflowSafety(): void {
  if (!existsSync(join(CLAUDE_DIR, 'skills', '_LIFEOS', 'Release', 'release.ts'))) {
    record('rc-workflow-safety', [], 'skipped — release tooling not installed');
    return;
  }
  const findings: Finding[] = [];
  const notes: string[] = [];
  for (const { rel, extraHeads } of RC_WORKFLOW_SCRIPTS) {
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    const abs = join(CLAUDE_DIR, rel);
    if (!existsSync(abs)) {
      findings.push({ detail: `${rel} is missing — the workflow cannot be proven safe, so the check fails closed`, blocking: true });
      notes.push(`${name}: workflow script missing`);
      continue;
    }
    let text: string;
    try { text = readFileSync(abs, 'utf8'); }
    catch (e: any) { findings.push({ detail: `${rel} unreadable: ${e?.message ?? e}`, blocking: true }); notes.push(`${name}: workflow script unreadable`); continue; }
    const r = scanRcWorkflow(text, extraHeads);
    findings.push(...r.violations.map(v => ({ detail: `${rel}:${v}`, blocking: true })));
    if (r.heads.length === 0) findings.push({ detail: `${rel}: no command-shaped string found — the script or the scanner changed shape; fail closed until reviewed`, blocking: true });
    notes.push(`${name}: ${r.heads.length} command-shaped string(s), ${new Set(r.heads).size} distinct; ${r.violations.length} off the allowlist or forbidden`);
  }
  record('rc-workflow-safety', findings, notes.join(' · '));
}

// ── RUN_TABLE: the one list of checks ────────────────────────────────────────
// Order is run order. `names` are the check names the run reports (--json `checks[].name`);
// --help prints exactly these. `match` is what --section accepts (the reported names, the
// function's kebab name, and old aliases). `full: false` entries run only under --section.
interface RunEntry { names: string[]; match: string[]; run: () => void | Promise<void>; full: boolean }
function entry(fn: Function, names: string[], opts: { run?: () => void | Promise<void>; aliases?: string[]; full?: boolean; match?: string[] } = {}): RunEntry {
  return {
    names,
    match: opts.match ?? [...new Set([kebabOf(fn), ...names, ...(opts.aliases ?? [])])],
    run: opts.run ?? (fn as () => void | Promise<void>),
    full: opts.full ?? true,
  };
}
export const RUN_TABLE: RunEntry[] = [
  entry(checkReferences, ['references']),
  entry(checkVersionAnchors, ['version_anchors']),
  entry(checkMasterDocPaths, ['master_doc_paths']),
  entry(checkHookRegistration, ['hook_registration']),
  entry(checkSettingsParity, ['settings-parity']),
  entry(checkHookWiring, ['hook_wiring']),
  entry(checkCarrierProbe, ['carrier-probe']),
  entry(checkModelSync, ['model-sync']),
  entry(checkModelRungPin, ['model-rung-pin']),
  entry(checkRuleDuplication, ['rule-duplication']),
  entry(checkReplayCorpus, ['replay-corpus']),
  entry(checkClaudeImports, ['claude_imports']),
  entry(checkClaudeRoutingOnly, ['claude-routing-only']),
  entry(checkHeaderMirror, ['header-mirror']),
  entry(checkSkills, ['skills']),
  entry(checkIntents, ['intents'], { aliases: ['workflows'] }), // the check's name before 2026-10-08
  entry(checkWorkflowInventory, ['workflow-inventory']),
  entry(checkOutsideWorkflows, ['outside-workflows']),
  entry(checkWorkflowNames, ['workflow-names']),
  entry(checkWorkflowDefinitions, ['workflow-definitions']),
  entry(checkSendGateOverrides, ['send-gate-overrides']),
  entry(checkOutputCoverage, ['output-coverage']),
  entry(checkRecordCoverage, ['record-coverage']),
  entry(checkDocRelated, ['doc-related']),
  entry(checkIntentContractDrift, ['intent-contract-drift']),
  entry(checkIntentLint, ['intent-lint']),
  entry(checkRetiredTokens, ['retired-tokens']),
  entry(checkStopGateParity, ['dispatcher-parity']),
  entry(checkDocPrivateNoteRefs, ['doc-private-note-refs']),
  entry(checkDocLeftoverTokens, ['doc-leftover-tokens']),
  entry(checkRetirementRegistry, ['retirement-registry']),
  entry(checkGateCounts, ['gate_counts']),
  entry(checkXTokenOwnership, ['x_token_ownership']),
  entry(checkFrontmatterUnits, ['commands', 'agents'], { run: () => {
    checkFrontmatterUnits('commands', join(CLAUDE_DIR, 'commands'), true);
    checkFrontmatterUnits('agents', join(CLAUDE_DIR, 'agents'), false);
  } }),
  entry(checkAgentSharedBlocks, ['agent-shared-blocks']),
  entry(checkSkillHygiene, ['skill-hygiene']),
  entry(checkCodeDataBoundary, ['code-data-boundary']),
  entry(checkFunctionHooks, ['function-hooks', 'mod-types'], { match: ['function-hooks'] }), // also runs mod-types
  entry(checkModTypes, ['mod-types'], { full: false }),                                     // `--section mod-types` alone
  entry(checkPluginLoad, ['plugin-load']),
  entry(checkCredentialRegistry, ['credential-registry']),
  entry(checkPermissionRuleShape, ['permission-rule-shape']),
  entry(checkProseInCode, ['prose-in-code']),
  entry(checkFetchTimeouts, ['fetch-timeouts']),
  entry(checkRiskReview, ['risk-review']),
  entry(checkNoPython, ['no-python']),
  entry(checkSchedulerParentWrites, ['scheduler-parent-writes']),
  entry(checkDerivedFreshness, ['derived-freshness']),
  entry(checkHooksAlive, ['hooks-alive']),
  entry(checkHookLatency, ['hook-latency']),
  entry(checkConfigRootLiteral, ['config-root-literal']),
  entry(checkRegexEndAnchor, ['regex-end-anchor']),
  entry(checkTrustRootsCommitted, ['trust-roots-committed']),
  entry(checkIssueRepoProvenance, ['issue-repo-provenance']),
  entry(checkStatuslineEvalSafety, ['statusline-eval-safety']),
  entry(checkSymlinkLoops, ['symlink-loops']),
  entry(checkEmailBranding, ['email-branding']),
  entry(checkAscentVocabulary, ['ascent-vocabulary']),
  entry(checkBlockMessages, ['block-messages']),
  entry(checkSpinnerTips, ['spinner-tips']),
  entry(checkSpinnerVerbs, ['spinner-verbs']),
  entry(checkStandingFacts, ['standing-facts']),
  entry(checkServicesDoc, ['services-doc']),
  entry(checkGlanceThresholds, ['glance-thresholds'], { aliases: ['jev-thresholds'] }), // the alias from before Jev was retired 2026-10-10
  entry(checkGlanceGates, ['glance-gates']),
  entry(checkLayerOneMonotone, ['layer-one-monotone']),
  entry(checkRcWorkflowSafety, ['rc-workflow-safety']),
  entry(checkAssertCoverage, ['assert-coverage']),
  entry(checkTsVocab, ['ts-vocab']),
  entry(checkDoctrineVocab, ['doctrine-vocab']),
  entry(checkSkillOverlap, ['skill-overlap']),
];
/** Every check name a run can report, in run order: the --help list (ISC-51). */
export const CHECK_NAMES: string[] = [...new Set(RUN_TABLE.flatMap(e => e.names))];

function printHelp(): void {
  const wrapped: string[] = [];
  let line = '';
  for (const n of CHECK_NAMES) {
    if ((line + n).length > 96) { wrapped.push(line.trimEnd()); line = ''; }
    line += n + ', ';
  }
  if (line) wrapped.push(line.replace(/, $/, ''));
  console.log(`IntegrityCheck — full-system integrity orchestrator (the /ic backbone)

Usage: bun IntegrityCheck.ts [flags]

Flags:
  --json             Structured JSON output
  --quiet            Suppress OK lines; findings only
  --verbose          List non-blocking findings too
  --deep             Print how to run the 13-agent deep audit (does not run agents)
  --section <name>   Run ONE check by name (any name below, or its kebab form, e.g. version-anchors);
                     a section run writes nothing: no stamp, no run row, no snapshot
  --no-stamp         Run every check and write nothing: no last-run, last-pass, runs.jsonl row or snapshot
  --run-id <id>      Tag last-run, last-pass and the runs.jsonl row with this id (an RC's rcId)
  --since-tag        Anchor the change window on the last v* tag instead of the last run stamp
  --accept-drop      On the principal's yes only: accept a layer-one guard-count drop and rewrite
                     layer-one-counts.json at the lower count (full run or --section layer-one-monotone)
  --help             This message

Stamps: HEAD is read before the checks start. A full run writes last-run.json and a runs.jsonl
row; an exit-0 run also writes last-pass.json, refused when a core path moved during the run.

Checks (${CHECK_NAMES.length}, generated from RUN_TABLE; each is a --json check name):
  ${wrapped.join('\n  ')}
Exit codes: 0 clean, 1 blocking findings (a guard-count drop included), 2 scan or usage error`);
}

function gitHead(repo: string): string {
  try { return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }).trim(); }
  catch { return ''; }
}

/** A full SHA-1 or SHA-256 commit id. Pure. */
export function isCommitId(s: unknown): s is string {
  return typeof s === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s);
}

/**
 * Why the run's two HEAD reads cannot back a stamp, or null when they can. On a
 * checkout both reads must be valid commit ids; a failed read is a scan error,
 * because an empty head made the mid-run core-change check compare nothing and
 * let a pass stamp through. A confirmed tarball
 * install has no HEAD to read. Pure.
 */
export function headReadProblem(headAtStart: string, headAtEnd: string, checkout: boolean): string | null {
  if (!checkout) return null;
  const bad = [['start', headAtStart], ['end', headAtEnd]].filter(([, h]) => !isCommitId(h)).map(([w]) => w);
  return bad.length ? `HEAD could not be read at run ${bad.join(' and ')}; the mid-run core-change check cannot run, so no pass stamp` : null;
}

/**
 * Core paths changed between two commits. The core-path rule is the shared one in
 * CoreSurface.ts; if that module is absent, every changed path counts as core (fail closed).
 */
export async function coreMovedBetween(repo: string, from: string, to: string): Promise<string[]> {
  if (!from || !to || from === to) return [];
  const isCore = await loadIsCorePath();
  try {
    const out = execFileSync('git', ['-C', repo, 'diff', '--name-only', from, to], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\n').filter(p => p && isCore(p));
  } catch (e: any) {
    return [`<diff ${from.slice(0, 12)}..${to.slice(0, 12)} failed: ${(e?.message ?? String(e)).split('\n')[0]}>`];
  }
}

/** The shared core-path rule (CoreSurface.ts); when that module is absent every path counts as core (fail closed). */
async function loadIsCorePath(): Promise<(p: string) => boolean> {
  try {
    const mod = await import(join(TOOLS_DIR, 'CoreSurface.ts'));
    if (typeof mod.isCorePath === 'function') return mod.isCorePath;
  } catch { /* shared module not present yet — every path counts as core */ }
  return () => true;
}

/**
 * Paths whose working-tree content may differ from HEAD: modified, deleted or untracked (not ignored), plus
 * index entries marked assume-unchanged or skip-worktree, which git status would not report. The checks read
 * the whole working tree (settings.system.json and other files off the core surface included) while the pass
 * stamp names HEAD, so any such path means the run did not examine HEAD's content (S072). Untracked files are
 * listed one by one whatever status.showUntrackedFiles says, so a new file inside an untracked directory is
 * seen. A git failure returns a marker entry, never an empty list.
 */
export function dirtyPaths(repo: string): string[] {
  const opts = { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, timeout: 120_000 };
  let status: string;
  let index: string;
  try {
    status = execFileSync('git', ['-C', repo, 'status', '--porcelain', '-z', '--no-renames', '--untracked-files=all', '--ignore-submodules=none'], opts);
    index = execFileSync('git', ['-C', repo, 'ls-files', '-v', '-z'], opts);
  } catch (e: any) {
    return [`<git status failed in ${repo}: ${(e?.message ?? String(e)).split('\n')[0]}>`];
  }
  const changed = status.split('\0').filter(Boolean).map(entry => entry.slice(3));
  // ls-files -v tags an assume-unchanged entry with a lower-case letter and a skip-worktree entry with S.
  const hidden = index.split('\0').filter(e => /^(?:[a-z]|S) /.test(e)).map(e => ({ path: e.slice(2), skipWorktree: e.startsWith('S ') }));
  return [...new Set([...changed, ...hiddenDiffering(repo, hidden, opts)].filter(Boolean))].sort();
}

/**
 * The hidden index entries (assume-unchanged, skip-worktree) whose working-tree content differs from HEAD, by
 * content: the raw bytes on disk (no clean filters, so the bytes the checks read) hashed and compared with the
 * HEAD blob, a symlink by its link text (S072 round 2: an unchanged skip-worktree file is not dirty). A path HEAD
 * lacks, a file of the wrong type, or one git cannot hash counts as differing. A skip-worktree file absent from
 * the tree is differing too, except in a sparse checkout (core.sparseCheckout), where leaving it out is how git
 * keeps it out of the tree. Any git failure counts every entry as differing. Read-only.
 */
function hiddenDiffering(repo: string, hidden: Array<{ path: string; skipWorktree: boolean }>, opts: { encoding: 'utf8'; stdio: ['ignore', 'pipe', 'pipe']; maxBuffer: number; timeout: number }): string[] {
  if (hidden.length === 0) return [];
  const all = hidden.map(h => h.path);
  let tree: string;
  let sparse = false;
  try {
    tree = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '-z', '--full-tree', 'HEAD'], opts);
    try { sparse = execFileSync('git', ['-C', repo, 'config', '--bool', 'core.sparseCheckout'], opts).trim() === 'true'; } catch { sparse = false; }
  } catch { return all; }
  const atHead = new Map<string, { mode: string; oid: string }>();
  for (const entry of tree.split('\0')) {
    const m = /^(\d+) \w+ ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
    if (m) atHead.set(m[3], { mode: m[1], oid: m[2] });
  }
  const differing: string[] = [];
  const files: Array<{ path: string; oid: string }> = [];
  const links: Array<{ path: string; oid: string; text: string }> = [];
  for (const h of hidden) {
    const head = atHead.get(h.path);
    if (!head) { differing.push(h.path); continue; }
    let st: ReturnType<typeof lstatSync>;
    try { st = lstatSync(join(repo, h.path)); }
    catch { if (!(h.skipWorktree && sparse)) differing.push(h.path); continue; }
    if (head.mode === '120000') {
      if (!st.isSymbolicLink()) { differing.push(h.path); continue; }
      try { links.push({ path: h.path, oid: head.oid, text: readlinkSync(join(repo, h.path)) }); } catch { differing.push(h.path); }
    } else if ((head.mode === '100644' || head.mode === '100755') && st.isFile() && !h.path.includes('\n')) {
      files.push({ path: h.path, oid: head.oid });
    } else differing.push(h.path);
  }
  if (files.length > 0) {
    try {
      const out = execFileSync('git', ['-C', repo, 'hash-object', '--no-filters', '--stdin-paths'], { ...opts, stdio: ['pipe', 'pipe', 'pipe'], input: files.map(f => f.path).join('\n') + '\n' }).split('\n').filter(Boolean);
      files.forEach((f, i) => { if (out[i] !== f.oid) differing.push(f.path); });
    } catch { differing.push(...files.map(f => f.path)); }
  }
  for (const l of links) {
    try {
      const oid = execFileSync('git', ['-C', repo, 'hash-object', '--no-filters', '--stdin'], { ...opts, stdio: ['pipe', 'pipe', 'pipe'], input: l.text }).trim();
      if (oid !== l.oid) differing.push(l.path);
    } catch { differing.push(l.path); }
  }
  return differing;
}

/**
 * Which stamp files a run may write. Pure: a --section or --no-stamp run writes none; a pass needs exit 0,
 * no core move, and no path differing from HEAD (`dirty`, S072) so the stamp names what was checked.
 */
export function planStamp(p: { section: string | null; noStamp: boolean; exitCode: number; coreMoved: number; dirty?: number }): { writeRun: boolean; writePass: boolean } {
  const writeRun = p.section === null && !p.noStamp;
  return { writeRun, writePass: writeRun && p.exitCode === 0 && p.coreMoved === 0 && (p.dirty ?? 0) === 0 };
}

/** What a stamping run actually wrote: `run` is last-run.json plus its runs.jsonl row, `pass` is last-pass.json. */
export interface StampResult { run: boolean; pass: boolean; error: string | null }

/**
 * Write the stamp files the plan allows into `dir`, in order, stopping at the first failure. The result
 * reports what landed, never what was planned: a run whose stamps could not be written must not report
 * them as written (review round 3: a failed write was a warning, exit 0 and `stamped: true`).
 */
export function writeStampFiles(dir: string, plan: ReturnType<typeof planStamp>, runRecord: Record<string, unknown>, passRecord: Record<string, unknown>): StampResult {
  const result: StampResult = { run: false, pass: false, error: null };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'last-run.json'), JSON.stringify(runRecord) + '\n');
    appendFileSync(join(dir, 'runs.jsonl'), JSON.stringify(runRecord) + '\n');
    result.run = true;
    // Fully-clean runs self-stamp the pass (2026-08-12: a hand-written stamp in a pipelined
    // command shipped a bump past a 5-BLOCKING verdict — the human write is the error surface).
    if (plan.writePass) {
      writeFileSync(join(dir, 'last-pass.json'), JSON.stringify(passRecord) + '\n');
      result.pass = true;
    }
  } catch (e: any) {
    result.error = (e?.message ?? String(e)).split('\n')[0];
  }
  return result;
}

/** The exit code once stamping is done: a planned stamp that did not land is a scan error (2), whatever the checks said. Pure. */
export function exitAfterStamp(exitCode: number, plan: ReturnType<typeof planStamp>, stamped: StampResult): number {
  const missed = stamped.error !== null || (plan.writeRun && !stamped.run) || (plan.writePass && !stamped.pass);
  return missed ? Math.max(exitCode, 2) : exitCode;
}

/**
 * The whole stamping step of a run, the one path main() takes (S072 round 2): compare the tree with HEAD again
 * after the checks (`compareRepo`, null only off a checkout), plan the stamps from the checks' exit code, the
 * core move and that comparison, and write what the plan allows into `stateDir`. A pass is never written for a
 * dirty tree, a dirty-unchecked checkout, a failing run, or a --section / --no-stamp run.
 */
export function stampRun(p: {
  compareRepo: string | null; onCheckout: boolean; stateDir: string; section: string | null; noStamp: boolean;
  checksExitCode: number; coreMoved: number; dirtyAtStart: readonly string[]; runRecord: Record<string, unknown>; runId?: string | null;
}): { plan: ReturnType<typeof planStamp>; dirty: string[]; stamped: StampResult } {
  const dirty = p.compareRepo !== null ? [...new Set([...p.dirtyAtStart, ...dirtyPaths(p.compareRepo)])].sort() : [];
  const plan = planStamp({ section: p.section, noStamp: p.noStamp, exitCode: p.checksExitCode, coreMoved: p.coreMoved, dirty: dirty.length });
  if (!plan.writeRun) return { plan, dirty, stamped: { run: false, pass: false, error: null } };
  const runRecord = { ...p.runRecord, ...(dirty.length > 0 ? { dirty: dirty.length } : {}) };
  invariant(p.section === null && !p.noStamp, 'integrity stamp written by a --section or --no-stamp run');
  invariant(!plan.writePass || (p.checksExitCode === 0 && p.coreMoved === 0), 'last-pass.json written for a run that was not clean at its own head');
  invariant(!plan.writePass || dirty.length === 0, 'last-pass.json written for a run whose working tree differed from HEAD');
  invariant(!plan.writePass || p.compareRepo !== null || !p.onCheckout, 'last-pass.json written on a checkout whose tree was never compared with HEAD');
  invariant(typeof runRecord.head === 'string', 'run record carries no head');
  invariant(!plan.writePass || isCommitId(runRecord.head) || !p.onCheckout, 'last-pass.json written without a valid commit id on a checkout');
  // The pass stamp's head is the HEAD read BEFORE the checks, so it never claims a commit the run did not see.
  const stamped = writeStampFiles(p.stateDir, plan, runRecord, { ts: runRecord.ts, head: runRecord.head, critical: 0, ...(p.runId ? { runId: p.runId } : {}) });
  return { plan, dirty, stamped };
}

const DEEP_HINT = 'run the 13-agent deep audit via the release/maintenance skill\'s integrity-check intent';

// Checks that must run in the parent: layer-one-monotone may write its snapshot, which only a full run does.
const PARENT_ONLY = new Set(['layer-one-monotone']);
const WORKER_TIMEOUT_MS = 10 * 60 * 1000;

/** One RUN_TABLE entry in its own process. Its records, scan errors and time, or a scan error naming why it failed. */
async function runWorker(i: number): Promise<{ records: CheckResult[]; errors: string[]; ms: number }> {
  const t = performance.now();
  const proc = Bun.spawn([process.execPath, import.meta.path, '--run-entry', String(i), ...(verbose ? ['--verbose'] : [])], {
    stdout: 'pipe', stderr: 'pipe', timeout: WORKER_TIMEOUT_MS,
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const ms = Math.round(performance.now() - t);
  const name = RUN_TABLE[i]!.names.join('+');
  try {
    const j = JSON.parse(out);
    if (!Array.isArray(j.checks) || !Array.isArray(j.scanErrors)) throw new Error('worker output has no checks/scanErrors');
    return { records: j.checks, errors: j.scanErrors, ms };
  } catch (e: any) {
    return { records: [], errors: [`${name}: worker failed (exit ${proc.exitCode ?? proc.signalCode ?? 'none'}): ${(err.trim().split('\n').pop() ?? e.message).slice(0, 200)}`], ms };
  }
}

/**
 * Run every full-run check concurrently, each in its own process, then put the records back in RUN_TABLE order,
 * so the report reads exactly as a serial run's (a serial run took minutes, mostly in a few slow checks).
 * Isolation also keeps one check's child processes from interrupting another's file reads: a check whose only
 * scan error is EINTR is run once more before the error stands.
 */
async function runConcurrently(durations: Record<string, number>): Promise<void> {
  const entries = RUN_TABLE.map((e, i) => ({ e, i })).filter(x => x.e.full);
  const workers = entries.filter(x => !x.e.names.some(n => PARENT_ONLY.has(n)));
  let previous: Record<string, number> = {};
  try { previous = JSON.parse(readFileSync(join(STATE_DIR, 'last-run.json'), 'utf8')).durations ?? {}; } catch { /* first run */ }
  const queue = [...workers].sort((a, b) => (previous[b.e.names[0]!] ?? 0) - (previous[a.e.names[0]!] ?? 0));
  const results = new Map<number, { records: CheckResult[]; errors: string[] }>();
  const limit = Math.max(2, Math.min(navigator.hardwareConcurrency ?? 8, 12));
  const onlyEintr = (r: { errors: string[] }) => r.errors.length > 0 && r.errors.every(m => /EINTR/.test(m));
  const lane = async () => {
    for (let x = queue.shift(); x; x = queue.shift()) {
      const r = await runWorker(x.i);
      for (const n of x.e.names) durations[n] = r.ms;
      results.set(x.i, r);
    }
  };
  await Promise.all(Array.from({ length: limit }, lane));
  // EINTR comes from the load of the whole pool, never from a single check run alone (a projects directory
  // listed cleanly every time in isolation). Interrupted checks re-run one at a time once the pool is idle; a check
  // still interrupted after three tries keeps its scan error.
  for (const x of workers) {
    for (let tries = 0; tries < 3 && onlyEintr(results.get(x.i)!); tries++) {
      const r = await runWorker(x.i);
      for (const n of x.e.names) durations[n] = r.ms;
      results.set(x.i, r);
    }
  }
  for (const { e, i } of entries) {
    const r = results.get(i);
    if (r) { checks.push(...r.records); scanErrors.push(...r.errors); continue; }
    const t = performance.now();
    await e.run();
    for (const n of e.names) durations[n] = Math.round(performance.now() - t);
  }
}

async function main(): Promise<never> {
  if (helpRequested) { printHelp(); process.exit(0); }
  if (runEntry !== null) {
    const e = RUN_TABLE[runEntry];
    if (!e || !Number.isInteger(runEntry)) { console.error(`--run-entry ${args[runEntryIdx + 1]}: no such entry`); process.exit(2); }
    try { await e.run(); } catch (err: any) { scanError(`${e.names.join('+')}: ${String(err?.message ?? err).slice(0, 200)}`); }
    console.log(JSON.stringify({ checks, scanErrors }));
    process.exit(0);
  }
  if (usageErrors.length > 0) {
    for (const u of usageErrors) console.error(`usage: ${u}`);
    process.exit(2);
  }
  // A section name is checked against the table BEFORE anything runs, so a check that
  // returns early without a record is never misreported as "no such check".
  if (section !== null && !RUN_TABLE.some(e => e.match.includes(section))) {
    console.error(`--section ${section}: no such check (bun IntegrityCheck.ts --help lists them)`);
    process.exit(2);
  }

  // HEAD is read BEFORE the checks (ISC-31): a commit that lands mid-run is never stamped as covered.
  const headAtStart = gitHead(CLAUDE_DIR);
  // The pass stamp names HEAD, but the checks read the working tree: a stamping run on a checkout records
  // which paths differ from HEAD before and after the checks, and any such path withholds the pass (S072).
  // An install that is not a checkout has no HEAD to name, so there is nothing to compare.
  const stampingRun = section === null && !noStamp;
  const compareTree = stampingRun && isGitCheckout();
  const dirtyAtStart = compareTree ? dirtyPaths(CLAUDE_DIR) : [];
  const changeWindow = computeChangeWindow();

  const durations: Record<string, number> = {};
  try {
    if (section !== null || serial) {
      for (const e of RUN_TABLE) {
        if (!(section === null ? e.full : e.match.includes(section))) continue;
        const t = performance.now();
        await e.run();
        for (const n of e.names) durations[n] = Math.round(performance.now() - t);
      }
    } else {
      await runConcurrently(durations);
    }
  } catch (e: any) {
    if (jsonOutput) console.log(JSON.stringify({ error: e.message }, null, 2));
    else console.error(`SCAN ERROR: ${e.message}`);
    process.exit(2);
  }

  const headAtEnd = gitHead(CLAUDE_DIR);
  const coreMovedMidRun = await coreMovedBetween(CLAUDE_DIR, headAtStart, headAtEnd);
  const stamping = stampingRun;
  if (stamping) {
    const headProblem = headReadProblem(headAtStart, headAtEnd, isGitCheckout());
    if (headProblem) scanError(headProblem);
  }
  // ISC-61: a stamping run whose core paths moved is not a pass for any head.
  if (stamping && coreMovedMidRun.length > 0) {
    scanError(`stamp refused: ${coreMovedMidRun.length} core path(s) changed during the run (${headAtStart.slice(0, 12)}..${headAtEnd.slice(0, 12)}: ${coreMovedMidRun.slice(0, 5).join(', ')}${coreMovedMidRun.length > 5 ? ', …' : ''}) — last-pass.json not written; re-run`);
  }

  const totalBlocking = checks.reduce((n, c) => n + c.blockingCount, 0);
  const totalInfo = checks.reduce((n, c) => n + c.infoCount, 0);
  // Exit-code precedence (Forge audit 2026-07-06): scan error (2) outranks blocking (1) outranks clean (0).
  // A check that could not RUN is exit 2 — never collapsed into a blocking finding, so a broken
  // tool can never masquerade as a clean-but-blocking result.
  const checksExitCode = scanErrors.length > 0 ? 2 : totalBlocking > 0 ? 1 : 0;

  const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  // One stamping path (stampRun): the tree is compared with HEAD again, and the plan and the writes follow from it.
  const { plan, dirty, stamped } = stampRun({
    compareRepo: compareTree ? CLAUDE_DIR : null, onCheckout: isGitCheckout(), stateDir: STATE_DIR, section, noStamp,
    checksExitCode, coreMoved: coreMovedMidRun.length, dirtyAtStart, runId,
    runRecord: {
      ts, head: headAtStart, ...(headAtEnd !== headAtStart ? { headAtEnd, coreMovedMidRun: coreMovedMidRun.length } : {}),
      ...(runId ? { runId } : {}), exitCode: checksExitCode, blocking: totalBlocking, info: totalInfo, durations,
    },
  });
  // A stamp that did not land is a scan error: automation reading exit 0 or `stamped` must never
  // believe a last-pass.json that is missing or stale.
  if (plan.writeRun && stamped.error !== null) scanError(`stamp write failed (${stamped.run ? 'last-run written, last-pass.json not' : 'no stamp written'}) in ${STATE_DIR.replace(HOME, '~')}: ${stamped.error}`);
  const exitCode = exitAfterStamp(checksExitCode, plan, stamped);

  if (jsonOutput) {
    console.log(JSON.stringify({
      ok: exitCode === 0,
      exitCode,
      scanErrors,
      totalBlocking,
      totalInfo,
      head: headAtStart,
      headAtEnd,
      coreMovedMidRun,
      dirty,
      runId,
      stamped: { run: stamped.run, pass: stamped.pass, ...(stamped.error !== null ? { error: stamped.error } : {}) },
      deepRequested: deep,
      ...(deep ? { deepHint: DEEP_HINT } : {}),
      changeWindow,
      checks: checks.map(c => ({ name: c.name, ok: c.ok, blocking: c.blockingCount, info: c.infoCount, ms: durations[c.name], note: c.note, findings: c.findings })),
    }, null, 2));
  } else {
    const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', DIM = '\x1b[2m', RST = '\x1b[0m';
    console.log(`\n🔎 LifeOS Integrity Check\n${'─'.repeat(60)}`);
    if (changeWindow.anchor === 'tag') {
      console.log(`${DIM}Change window: since ${changeWindow.tag ?? 'no v* tag'} · ${changeWindow.commits} commits in ~/.claude${changeWindow.userCommits !== undefined ? `, ${changeWindow.userCommits} in USER` : ''}${RST}`);
      for (const a of changeWindow.areas) console.log(`${DIM}  ${String(a.files).padStart(4)} files  ${a.path}${RST}`);
      console.log('─'.repeat(60));
    } else if (changeWindow.lastRun) {
      console.log(`${DIM}Change window: last run ${changeWindow.lastRun} · ${changeWindow.commits} commits since (both repos)${RST}`);
      for (const a of changeWindow.areas) console.log(`${DIM}  ${String(a.files).padStart(4)} files  ${a.path}${RST}`);
      if (changeWindow.areas.length > 0) console.log(`${DIM}  → focus the contextual review on the most-churned areas above${RST}`);
      console.log('─'.repeat(60));
    } else {
      console.log(`${DIM}Change window: no prior run stamp — first stamped run, full-tree scope${RST}\n${'─'.repeat(60)}`);
    }
    for (const c of checks) {
      const icon = c.blockingCount > 0 ? `${R}✗${RST}` : c.infoCount > 0 ? `${Y}!${RST}` : `${G}✓${RST}`;
      if (quiet && c.blockingCount === 0 && c.infoCount === 0) continue;
      console.log(`${icon} ${c.name.padEnd(20)} ${DIM}${c.note ?? ''}${RST}`);
      // Blocking findings always print. Non-blocking print only with --verbose (default rolls them to the note count).
      for (const f of c.findings) {
        if (!f.blocking && !verbose) continue;
        console.log(`    ${f.blocking ? R + 'BLOCK' : Y + 'info '}${RST} ${f.detail}`);
      }
      if (!verbose && c.infoCount > 0) console.log(`    ${DIM}(${c.infoCount} non-blocking — run --verbose to list)${RST}`);
    }
    console.log(`${'─'.repeat(60)}`);
    for (const se of scanErrors) console.log(`${R}⚠ SCAN ERROR${RST} ${se}`);
    if (plan.writeRun && dirty.length > 0) console.log(`${Y}Pass stamp withheld:${RST} ${dirty.length} path(s) differ from HEAD, so the checks did not read HEAD's content (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}). Commit or set them aside, then re-run.`);
    const verdict = scanErrors.length > 0 ? `${R}SCAN ERROR (exit 2)${RST}` : totalBlocking > 0 ? `${R}${totalBlocking} BLOCKING${RST}` : `${G}CLEAN${RST}`;
    console.log(`Verdict: ${verdict}  ${DIM}(${totalInfo} non-blocking info)${RST}`);
    console.log(`${DIM}Head ${headAtStart.slice(0, 12) || 'n/a'}${runId ? ` · run ${runId}` : ''} · stamps: ${!plan.writeRun ? 'none (--section or --no-stamp)' : stamped.pass ? 'last-run + last-pass' : stamped.run ? 'last-run only' : 'none (write failed)'}${RST}`);
    console.log(`${DIM}Tier: deterministic (structural + reference integrity). Semantic drift — docs describing changed behavior — is only caught by /ic --deep.${RST}\n`);
    if (deep) console.log(`${DIM}--deep: ${DEEP_HINT}.${RST}\n`);
  }

  process.exit(exitCode);
}

// Run only as a CLI; tests import the pure helpers (planStamp, layerOneVerdict, scanRcWorkflow, CHECK_NAMES).
if (import.meta.main) await main();
