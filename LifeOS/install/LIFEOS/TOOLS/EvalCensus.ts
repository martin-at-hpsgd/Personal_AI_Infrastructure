#!/usr/bin/env bun
/**
 * EvalCensus — the estate-wide read of every ISA's Test Strategy through the
 * one parser (LIFEOS/TOOLS/lib/IsaTestStrategy.ts).
 *
 * Born in 20260908-universal-eval-reeval (ISC-9 parser parity, ISC-35 census).
 * The parser drops a large share of the rows on disk today; a parser change that
 * moved that number silently would be a coverage regression nobody sees. So:
 *
 *   bun LIFEOS/TOOLS/EvalCensus.ts --dropped-baseline capture <file.json>
 *   bun LIFEOS/TOOLS/EvalCensus.ts --dropped-baseline compare <file.json> [--allow <regex>]
 *   bun LIFEOS/TOOLS/EvalCensus.ts                      # census table by type × lane × stage, then `repaired: N invalid: M`
 *   bun LIFEOS/TOOLS/EvalCensus.ts --format-strict      # same, exit 1 while repaired or invalid > 0 (ISC-36)
 *   bun LIFEOS/TOOLS/EvalCensus.ts --calibration-coverage [--json]   # every judged suite: earned or provisional (exit 1 while any is provisional)
 *   bun LIFEOS/TOOLS/EvalCensus.ts --without-eval [--scope projects,recent:14d] [--json]   # criteria with no eval, plus pairwise gaps (exit 1 while any lacks an eval)
 *   bun LIFEOS/TOOLS/EvalCensus.ts --pairwise-gaps [--scope projects,recent:14d] [--json]  # pairwise gaps only (exit 1 while any is open)
 *
 * `compare` exits 0 only when every file's probe and dropped counts match the
 * baseline, or differ by exactly the rows whose drop reason matches --allow
 * (the rule a change deliberately introduced), each listed by ISA and id.
 * Files whose ISA changed on disk since capture are reported and skipped,
 * never counted as drift. A baseline that is malformed, or of which no entry
 * could be inspected at all, exits 2 (incomplete), never 0.
 *
 * Uses Assay's judgment layer (LIFEOS/DOCUMENTATION/Assay/AssaySystem.md).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, statSync, realpathSync, readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getClaudeDir, lifeosPath } from "./Paths.ts";
import { BARE_WORD_TOOL, coverageOf, isJudgedType, parseClaimIds, parseTestStrategyDiagnostic, probeCwdOf, type Probe } from "./lib/IsaTestStrategy.ts";
import { calibrationCoverage, seedSummaries, seedsDir, parseCalibrationSet } from "./lib/Calibration.ts";
import { loadCallers, loadRegistry, thresholdRows, type CallerRegistry, type CallersConfig } from "../ASSAY/Assay.ts";
import { loadGlanceQuestion } from "./lib/GlanceQuestion.ts";

interface FileRow { probes: number; dropped: number; sha: string }
interface Baseline { capturedAt: string; files: number; probes: number; dropped: number; perFile: Record<string, FileRow> }

// The config root comes from Paths.ts (never a literal); the project trees are
// the two conventional homes for <project>/ISA.md; MEMORY is the task-ISA home.
const HOME = homedir();
const DEFAULT_ROOTS = [getClaudeDir(), join(HOME, "Projects"), join(HOME, "LocalProjects"), lifeosPath("USER")];
/** The ISA roots, overridable per call (LIFEOS_EVAL_CENSUS_ROOTS, colon-separated) so a test runs on fixtures. */
export function censusRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const o = env.LIFEOS_EVAL_CENSUS_ROOTS;
  return o ? o.split(":").filter(Boolean) : DEFAULT_ROOTS;
}

export async function isaFiles(roots: string[] = censusRoots()): Promise<string[]> {
  const found = new Set<string>();
  // Session transcripts, file-history snapshots and backup copies are copies, never live ISAs.
  const copies = new Set([join(getClaudeDir(), "projects"), join(getClaudeDir(), "backups")]);
  // Excluded trees are pruned before they are entered: a glob that filtered them afterwards walked every
  // node_modules under a large projects tree, most of the time the vocabulary check took in /ic.
  const PRUNE = new Set(["node_modules", "LIFEOS_RELEASES", "_ephemeral", "file-history"]);
  const walk = (dir: string): void => {
    let entries: Dirent[] = [];
    for (let tries = 0; ; tries++) {
      try { entries = readdirSync(dir, { withFileTypes: true }); break; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "EINTR" && tries < 3) continue; return; }
    }
    for (const d of entries) {
      if (d.name.startsWith(".")) continue;
      const p = join(dir, d.name);
      if (d.isDirectory()) { if (!PRUNE.has(d.name) && !copies.has(p)) walk(p); }
      else if (d.isFile() && d.name === "ISA.md") found.add(p);
    }
  };
  for (const root of roots) if (existsSync(root)) walk(resolve(root));
  // One ISA reached through two roots (the USER tree is a symlink) is one ISA.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of [...found].sort()) {
    let real: string;
    try { real = realpathSync(f); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(f);
  }
  return out;
}

// ── Format debt (20261010-evals-in-the-isa ISC-36) ────────────────────────────
// Rows the parser had to coerce (`repaired`: a type read from the tool cell, a
// case variant, a folded pipe) and rows it could not read at all (`invalid`).
// Every invalid row is also listed in `repaired`, so `repaired >= invalid`.
// ISC-36 is met when both are 0; the deterministic ISA row repair tool is the fix (maintainer-side; not in the public release).
export interface FormatDebt { repaired: number; invalid: number; worst: { isa: string; repaired: number; invalid: number }[] }
export function formatDebt(files: string[], top = 10): FormatDebt {
  const per: FormatDebt["worst"] = [];
  let repaired = 0, invalid = 0;
  for (const f of files) {
    const r = parseTestStrategyDiagnostic(f);
    const rep = r.repaired?.length ?? 0, inv = r.invalid?.length ?? 0;
    repaired += rep; invalid += inv;
    if (rep || inv) per.push({ isa: f, repaired: rep, invalid: inv });
  }
  per.sort((a, b) => b.repaired - a.repaired || b.invalid - a.invalid || a.isa.localeCompare(b.isa));
  return { repaired, invalid, worst: per.slice(0, top) };
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 12);

async function capture(): Promise<Baseline> {
  const perFile: Record<string, FileRow> = {};
  let probes = 0, dropped = 0;
  for (const f of await isaFiles()) {
    const r = parseTestStrategyDiagnostic(f);
    perFile[f] = { probes: r.probes.length, dropped: r.dropped.length, sha: sha(f) };
    probes += r.probes.length; dropped += r.dropped.length;
  }
  return { capturedAt: new Date().toISOString(), files: Object.keys(perFile).length, probes, dropped, perFile };
}

/**
 * Parse a baseline file strictly: a non-empty `perFile` map whose rows carry
 * integer probe and dropped counts. Anything else is null, so a truncated or
 * hand-mangled baseline can never compare as clean.
 */
export function parseBaseline(text: string): Baseline | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const perFile = (raw as { perFile?: unknown }).perFile;
  if (perFile === null || typeof perFile !== "object" || Array.isArray(perFile)) return null;
  const rows = Object.entries(perFile as Record<string, unknown>);
  if (rows.length === 0) return null;
  for (const [, row] of rows) {
    if (row === null || typeof row !== "object") return null;
    const r = row as Partial<FileRow>;
    if (!Number.isInteger(r.probes) || !Number.isInteger(r.dropped)) return null;
    if (r.sha !== undefined && typeof r.sha !== "string") return null;
  }
  return raw as Baseline;
}

/**
 * Exit 0 clean, 1 drift, 2 incomplete. Incomplete means the baseline could not be
 * read or not one of its entries was actually inspected (every file moved or
 * edited since capture): a comparison that looked at nothing proves nothing.
 */
export async function compare(path: string, allow: RegExp | null): Promise<number> {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) {
    console.error(`INCOMPLETE: baseline ${path} cannot be read: ${(e as Error).message}`);
    return 2;
  }
  const base = parseBaseline(text);
  if (!base) {
    console.error(`INCOMPLETE: baseline ${path} is malformed or has no per-file rows`);
    return 2;
  }
  // A baseline without per-file hashes (the first one, captured 2026-09-08 by
  // hand) falls back to its own mtime as the capture instant: an ISA edited
  // after that is another session's work, not parser drift.
  const capturedMs = base.capturedAt ? Date.parse(base.capturedAt) : statSync(path).mtimeMs;
  let same = 0, changedOnDisk = 0, explained = 0, drift = 0;
  const lines: string[] = [];
  for (const [f, was] of Object.entries(base.perFile)) {
    if (!existsSync(f)) { changedOnDisk++; lines.push(`  moved   ${f}`); continue; }
    if (was.sha ? sha(f) !== was.sha : statSync(f).mtimeMs > capturedMs) { changedOnDisk++; lines.push(`  edited-since-capture (skipped) ${f}`); continue; }
    const r = parseTestStrategyDiagnostic(f);
    if (r.probes.length === was.probes && r.dropped.length === was.dropped) { same++; continue; }
    const newDrops = r.dropped.filter((d) => allow?.test(d.reason));
    const delta = r.dropped.length - was.dropped;
    if (allow && delta === newDrops.length && r.probes.length === was.probes - delta) {
      explained++;
      for (const d of newDrops) lines.push(`  allowed ${f} :: ${d.raw.split("|")[1]?.trim() ?? "?"} :: ${d.reason}`);
      continue;
    }
    drift++;
    lines.push(`  DRIFT   ${f} probes ${was.probes}→${r.probes.length} dropped ${was.dropped}→${r.dropped.length}`);
    for (const d of r.dropped) lines.push(`            ${d.reason}`);
  }
  console.log(`baseline ${base.capturedAt ?? new Date(capturedMs).toISOString()}: ${base.files} files, ${base.probes} probes, ${base.dropped} dropped`);
  console.log(`same ${same} · changed-on-disk (skipped) ${changedOnDisk} · explained-by-rule ${explained} · DRIFT ${drift}`);
  for (const l of lines) console.log(l);
  if (drift > 0) return 1;
  if (same + explained === 0) {
    console.error(`INCOMPLETE: none of the ${Object.keys(base.perFile).length} baseline entries was inspected (all moved or edited since capture); recapture the baseline`);
    return 2;
  }
  return 0;
}

// ── ISC-35: the estate as data ────────────────────────────────────────────────
export type VerifierClass = "deterministic" | "judged" | "attested";
export function classOf(type: string): VerifierClass {
  return type === "manual" ? "attested" : isJudgedType(type) ? "judged" : "deterministic";
}
export interface CensusRow { isa: string; isc: string; type: string; class: VerifierClass; lane: string; stage: number; suite: string | null; calibration: "earned" | "provisional" | null }
export interface CensusData {
  isas: number; probes: number; dropped: number;
  cells: { type: string; lane: string; stage: number; count: number }[];
  rows: CensusRow[];
  dropped_reasons: { reason: string; count: number }[];
  off_vocabulary: { total: number; by_isa: { isa: string; count: number; types: string[] }[] };
}
const normalizeReason = (r: string) => r.replace(/"[^"]*"/g, '"…"').replace(/\(\d+ < \d+;/, "(N < M;");

/** Every ISA's rows by class, lane, stage, and (for eval rows naming a suite) calibrated or provisional. */
export async function censusData(roots: string[] = censusRoots(), coverage = calibrationCoverage()): Promise<CensusData> {
  const files = await isaFiles(roots);
  const cell = new Map<string, number>();
  const reasons = new Map<string, number>();
  const rows: CensusRow[] = [];
  const offByIsa = new Map<string, Set<string>>();
  const offCount = new Map<string, number>();
  const earned = new Map(coverage.rows.map((r) => [r.suite, r.earned] as const));
  let probes = 0, dropped = 0;
  for (const f of files) {
    const r = parseTestStrategyDiagnostic(f);
    probes += r.probes.length; dropped += r.dropped.length;
    for (const p of r.probes as Probe[]) {
      cell.set(`${p.type}\t${p.lane}\t${p.stage}`, (cell.get(`${p.type}\t${p.lane}\t${p.stage}`) ?? 0) + 1);
      const suite = p.type === "eval" ? (p.tool.match(/^suite:\s*([A-Za-z0-9._-]+)$/)?.[1] ?? null) : null;
      const calibration = suite === null ? null : earned.get(suite) === true ? "earned" : "provisional";
      rows.push({ isa: f, isc: p.isc, type: p.type, class: classOf(p.type), lane: p.lane, stage: p.stage, suite, calibration });
    }
    for (const d of r.dropped) {
      reasons.set(normalizeReason(d.reason), (reasons.get(normalizeReason(d.reason)) ?? 0) + 1);
      const m = d.reason.match(/^unknown probe type "([^"]*)"/);
      if (m) {
        offCount.set(f, (offCount.get(f) ?? 0) + 1);
        if (!offByIsa.has(f)) offByIsa.set(f, new Set());
        offByIsa.get(f)!.add(m[1]!.slice(0, 40));
      }
    }
  }
  const by_isa = [...offCount.entries()].map(([isa, count]) => ({ isa, count, types: [...offByIsa.get(isa)!].slice(0, 6) })).sort((a, b) => b.count - a.count);
  return {
    isas: files.length, probes, dropped,
    cells: [...cell.entries()].map(([k, count]) => { const [type, lane, stage] = k.split("\t"); return { type: type!, lane: lane!, stage: Number(stage), count }; }).sort((a, b) => b.count - a.count),
    rows,
    dropped_reasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    off_vocabulary: { total: by_isa.reduce((s, r) => s + r.count, 0), by_isa },
  };
}

export type GlanceBudgetLine = { caller: string; calls: number; budget: number | null; over: boolean };

/** Count the Glance calls one complete cycle would issue, grouped by the question file's caller. */
export async function glanceBudgetLines(files?: string[], callers: CallersConfig = loadCallers()): Promise<GlanceBudgetLine[]> {
  const counts = new Map<string, number>();
  for (const isa of files ?? await isaFiles()) {
    for (const probe of parseTestStrategyDiagnostic(isa).probes) {
      if (probe.type !== "glance") continue;
      const caller = loadGlanceQuestion(isa, probe.tool).caller;
      counts.set(caller, (counts.get(caller) ?? 0) + 1);
    }
  }
  return [...new Set([...Object.keys(callers), ...counts.keys()])].sort().map((caller) => {
    const calls = counts.get(caller) ?? 0;
    const budget = callers[caller]?.budget.calls_per_day ?? null;
    return { caller, calls, budget, over: budget !== null && calls > budget };
  });
}

export async function glanceBudgetReport(files?: string[], callers?: CallersConfig): Promise<number> {
  const lines = await glanceBudgetLines(files, callers);
  for (const line of lines) console.log(`${line.over ? "over-budget " : ""}${line.caller}: ${line.calls} calls/cycle · budget ${line.budget ?? "unregistered"} calls/day`);
  return lines.some((line) => line.over) ? 1 : 0;
}

export interface PairingViolation { isa: string; claim: string; caller: string; question: string; labels: number; floor: number }

/** Keep the human attest rung beside a glance row until its canonical criterion seed reaches the registry floor. */
export async function pairingViolations(files?: string[], registry: CallerRegistry = loadRegistry(), seedDir = seedsDir()): Promise<PairingViolation[]> {
  const summaries = seedSummaries(seedDir);
  const labelsFor = (isa: string, claim: string) => {
    const summary = summaries.find(s => resolve(s.isa) === resolve(isa) && s.claim === claim);
    return summary ? parseCalibrationSet(readFileSync(summary.path, "utf8")).entries.filter(entry => entry.expected === undefined).length : 0;
  };
  const out: PairingViolation[] = [];
  for (const isa of files ?? await isaFiles()) {
    const probes = parseTestStrategyDiagnostic(isa).probes;
    for (const glance of probes.filter((p) => p.type === "glance")) {
      const question = loadGlanceQuestion(isa, glance.tool);
      const floor = thresholdRows(registry.callers[question.caller])[question.id]?.min_labels ?? registry.defaults.min_labels ?? 10;
      const labels = question.kind === "noul" ? labelsFor(isa, glance.isc) : 0;
      if (labels >= floor || probes.some((p) => p.isc === glance.isc && p.type === "manual")) continue;
      out.push({ isa, claim: glance.isc, caller: question.caller, question: question.id, labels, floor });
    }
  }
  return out;
}

export async function pairingReport(files?: string[], registry?: CallerRegistry, seedDir?: string): Promise<number> {
  const violations = await pairingViolations(files, registry, seedDir);
  for (const v of violations) console.log(`pairing violation ${v.isa} ${v.claim}: ${v.caller}.${v.question} has ${v.labels}/${v.floor} labels and no manual row`);
  return violations.length > 0 ? 1 : 0;
}

async function census(): Promise<FormatDebt> {
  const files = await isaFiles();
  const cell = new Map<string, number>();
  let probes = 0, dropped = 0;
  const reasons = new Map<string, number>();
  const debt: FormatDebt = { repaired: 0, invalid: 0, worst: [] };
  for (const f of files) {
    const r = parseTestStrategyDiagnostic(f);
    probes += r.probes.length; dropped += r.dropped.length;
    const rep = r.repaired?.length ?? 0, inv = r.invalid?.length ?? 0;
    debt.repaired += rep; debt.invalid += inv;
    if (rep || inv) debt.worst.push({ isa: f, repaired: rep, invalid: inv });
    for (const p of r.probes as Probe[]) {
      const k = `${p.type}\t${p.lane}\t${p.stage}`;
      cell.set(k, (cell.get(k) ?? 0) + 1);
    }
    for (const d of r.dropped) {
      const k = d.reason.replace(/"[^"]*"/g, '"…"').replace(/\(\d+ < \d+;/, "(N < M;");
      reasons.set(k, (reasons.get(k) ?? 0) + 1);
    }
  }
  console.log(`ISAs ${files.length} · probes ${probes} · dropped ${dropped} (${Math.round((dropped / (probes + dropped)) * 100)}% of rows)\n`);
  console.log("type\tlane\tstage\tcount");
  for (const [k, n] of [...cell.entries()].sort((a, b) => b[1] - a[1])) console.log(`${k}\t${n}`);
  console.log("\ndropped-row reasons:");
  for (const [k, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
  debt.worst.sort((a, b) => b.repaired - a.repaired || b.invalid - a.invalid || a.isa.localeCompare(b.isa));
  const isasWithDebt = debt.worst.length;
  debt.worst = debt.worst.slice(0, 10);
  console.log(`\nformat (ISC-36; repaired includes invalid; fix: the ISA row repair tool, maintainer-side):`);
  for (const w of debt.worst) console.log(`  ${String(w.repaired).padStart(5)} repaired ${String(w.invalid).padStart(5)} invalid  ${w.isa}`);
  console.log(`repaired: ${debt.repaired} invalid: ${debt.invalid} isas: ${isasWithDebt}`);
  return debt;
}

// ISC-22 / ISC-27 (20260908-universal-eval-reeval): the judged suites and whether
// each runs on an earned calibration record. The Socrates `evals` adapter reads
// the --json form; the ISC-27 row reads the exit code (0 only when every judged
// suite is earned).
function coverageReport(asJson: boolean): number {
  const c = calibrationCoverage();
  if (asJson) {
    console.log(JSON.stringify(c, null, 1));
  } else {
    console.log(`judged suites ${c.total} · earned ${c.earned} · provisional ${c.provisional}\n`);
    for (const r of c.rows) console.log(`  ${r.earned ? "🟢 earned     " : r.red ? "🔴 provisional" : "🟠 provisional"}  ${r.suite.padEnd(36)} ${String(r.judged).padStart(2)} judged/${String(r.asserts).padEnd(3)} ${r.earned ? "" : `${r.age_days !== null ? `${r.age_days}d · ` : ""}${r.reason}`}`);
  }
  return c.provisional === 0 ? 0 : 1;
}

export type BacklogBucket = "no-row" | "row-dropped" | "row-unanchored" | "manual-only" | "unrunnable" | "unfailable";
export interface UnrunnableFinding { isc: string; path: string; resolved_against: string }
export interface BucketReport { isa: string; total: number; buckets: Record<BacklogBucket, number>; unrunnable_findings: UnrunnableFinding[] }

const EMPTY_BUCKETS = (): Record<BacklogBucket, number> => ({ "no-row": 0, "row-dropped": 0, "row-unanchored": 0, "manual-only": 0, "unrunnable": 0, "unfailable": 0 });
const anchorId = (value: string): string => value.replace(/^(?:derived|cross)\s*:\s*/i, "").trim();
const rawFirstCell = (raw: string): string => raw.trim().replace(/^\|/, "").split(/(?<!\\)\|/, 1)[0]!.trim();
const PATH_CHECK_TYPES = new Set(["bash", "bun-test", "bun-property"]);
const COVERAGE_TYPES = new Set(["bash", "bun-test", "bun-property", "curl"]);

/** A known-bad app-relative path, or null when the command is outside this deliberately narrow check. */
function unrunnablePath(probe: Probe, isa: string): UnrunnableFinding | null {
  if (!PATH_CHECK_TYPES.has(probe.type) || /^cd\s/.test(probe.tool)) return null;
  if (/\$HOME|\$\{LIFEOS|~\/|(?:^|\s)\//.test(probe.tool)) return null;
  const against = probeCwdOf(resolve(isa));
  // A pathless `bun test` from the config root runs every suite in the tree:
  // it proves nothing about this criterion and can run for many minutes.
  if (against === getClaudeDir() && /^bun\s+test(?:\s+-t\s+(?:"[^"]*"|'[^']*'|\S+))?\s*$/.test(probe.tool.trim())) {
    return { isc: probe.isc, path: "(no path: whole-tree bun test)", resolved_against: against };
  }
  for (const match of probe.tool.matchAll(/(?:^|\s)(\.\/[^\s'"`|;&()<>]+)/g)) {
    const path = match[1]!;
    if (!existsSync(resolve(against, path))) return { isc: probe.isc, path, resolved_against: against };
  }
  return null;
}

/** Split runnable-coverage debt into remediation jobs before estimating its volume. */
export async function bucketReports(files: string[]): Promise<BucketReport[]> {
  return files.map((isa) => {
    const cov = coverageOf(isa);
    const { probes, dropped } = parseTestStrategyDiagnostic(isa);
    const rowsByClaim = new Map<string, Probe[]>();
    for (const p of probes) {
      for (const id of [p.isc, anchorId(p.anchors_to)].filter(Boolean)) rowsByClaim.set(id, [...(rowsByClaim.get(id) ?? []), p]);
    }
    const droppedIds = new Set(dropped.map((d) => rawFirstCell(d.raw)));
    const buckets = EMPTY_BUCKETS();
    const unrunnable_findings: UnrunnableFinding[] = [];
    const uncovered = new Set(cov.uncovered);
    const rowsFor = (claim: string) => rowsByClaim.get(claim) ?? [];
    for (const claim of parseClaimIds(isa).filter((id) => !uncovered.has(id))) {
      const coverageRows = rowsFor(claim).filter((p) => COVERAGE_TYPES.has(p.type) && Boolean(p.tool));
      const failures = coverageRows.map((p) => unrunnablePath(p, isa)).filter((f): f is UnrunnableFinding => f !== null);
      // A criterion has runnability debt only if every row that currently earns its
      // coverage credit is known broken. Rows we cannot prove broken stay as
      // coverage, deliberately preferring a false negative to a false positive.
      if (coverageRows.length > 0 && failures.length === coverageRows.length) {
        buckets.unrunnable++;
        unrunnable_findings.push(...failures);
      } else if (coverageRows.length > 0 && coverageRows.every((p) => BARE_WORD_TOOL(p.tool, p.type))) {
        // Every row credited to this criterion is a bare command name (`bash`, `bun`),
        // which runs and exits without looking at anything: covered on paper only.
        buckets.unfailable++;
      }
    }
    for (const claim of cov.uncovered) {
      const rows = rowsByClaim.get(claim) ?? [];
      if (rows.length && rows.every((r) => r.type === "manual")) buckets["manual-only"]++;
      else if (droppedIds.has(claim)) buckets["row-dropped"]++;
      else if (rows.length === 0) {
        // A Test Strategy may have many rows, but none tied to this criterion: that
        // is an anchoring job, not an invitation to write a duplicate probe.
        if (probes.length > 0 || dropped.length > 0) buckets["row-unanchored"]++;
        else buckets["no-row"]++;
      } else {
        // Non-runnable parsed rows (for example eval/screenshot) are not a
        // manual-only debt; their row is present but needs an explicit runnable
        // anchor before coverage can credit it.
        buckets["row-unanchored"]++;
      }
    }
    return { isa, total: cov.uncovered.length, buckets, unrunnable_findings };
  });
}

async function buckets(isaArg: string | undefined, asJson: boolean): Promise<void> {
  const reports = await bucketReports(isaArg ? [isaArg] : await isaFiles());
  const total = EMPTY_BUCKETS();
  for (const report of reports) for (const bucket of Object.keys(total) as BacklogBucket[]) total[bucket] += report.buckets[bucket];
  if (asJson) { console.log(JSON.stringify({ isas: reports, total }, null, 1)); return; }
  for (const report of reports) {
    console.log(`${report.isa}: ${report.total} uncovered · no-row ${report.buckets["no-row"]} · row-dropped ${report.buckets["row-dropped"]} · row-unanchored ${report.buckets["row-unanchored"]} · manual-only ${report.buckets["manual-only"]} · unrunnable ${report.buckets.unrunnable} · unfailable ${report.buckets.unfailable}`);
    for (const finding of report.unrunnable_findings) console.log(`  unrunnable ${finding.isc}: ${finding.path} resolved against ${finding.resolved_against}`);
  }
  console.log(`estate total: no-row ${total["no-row"]} · row-dropped ${total["row-dropped"]} · row-unanchored ${total["row-unanchored"]} · manual-only ${total["manual-only"]} · unrunnable ${total.unrunnable} · unfailable ${total.unfailable}`);
}

// ── --without-eval (20261010-evals-in-the-isa ISC-37) ─────────────────────────
// Criteria in scope with no eval: no valid row whose type is not manual, and no
// `## Evals` block. Scope is IsaScope's, the one definition CompileEstate reads.
// The same pass counts pairwise gaps (ISC-55): criteria judged by a rubric over a
// file, page or screenshot output with no pairwise stage against
// champion:last-accepted after it, plus the other problems the same rule names
// (champion, no-rubric, misplaced, and a stale or wrongly captured candidate,
// ISC-57), by the rule Compile refuses with
// (lib/PairwiseGap.ts). Gaps never change the counts above.
export interface PairwiseGapEntry { isa: string; isc: string; problem: import("./lib/PairwiseGap.ts").PairwiseProblem; outputs: string[]; detail?: string[] }
export interface WithoutEvalReport {
  scope: string; isas: number; criteria: number; missing: { isa: string; isc: string }[]; unresolved: string[];
  pairwise_gaps: PairwiseGapEntry[];
  /** Per ISA with at least one gap, most gaps first. */
  pairwise_gaps_by_isa: { isa: string; count: number }[];
}
export async function withoutEval(scope: string, opts: import("./lib/IsaScope.ts").ResolveOptions = {}): Promise<WithoutEvalReport> {
  const { idsWithEval, resolveScope } = await import("./lib/IsaScope.ts");
  const { isaBody, parseIsaClaimsText } = await import("./lib/IsaClaims.ts");
  const { pairwiseGaps } = await import("./lib/PairwiseGap.ts");
  const { entries, unresolved } = await resolveScope(scope, opts);
  const out: WithoutEvalReport = { scope, isas: entries.length, criteria: 0, missing: [], unresolved: unresolved.map((u) => `${u.project}: ${u.raw}`), pairwise_gaps: [], pairwise_gaps_by_isa: [] };
  for (const e of entries) {
    const text = readFileSync(e.real, "utf8");
    const ts = parseTestStrategyDiagnostic(e.real);
    // The one "has an eval" definition, shared with Compile's planCriteria.
    const has = idsWithEval(ts.probes, ts.evals?.evals.keys() ?? []);
    const body = isaBody(text).split(/\r?\n/);
    for (const c of parseIsaClaimsText(text, { path: e.real }).claims) {
      if (/\[DROPPED\b/.test(body[c.line - 1] ?? "")) continue; // tombstones carry no eval, same as Compile
      out.criteria++;
      if (!has.has(c.id)) out.missing.push({ isa: e.path, isc: c.id });
    }
    const gaps = pairwiseGaps(e.real, text, ts);
    for (const g of gaps) out.pairwise_gaps.push({ isa: e.path, isc: g.isc, problem: g.problem, outputs: g.outputs, ...(g.detail ? { detail: g.detail } : {}) });
    if (gaps.length) out.pairwise_gaps_by_isa.push({ isa: e.path, count: gaps.length });
  }
  out.pairwise_gaps_by_isa.sort((a, b) => b.count - a.count || a.isa.localeCompare(b.isa));
  return out;
}

/** The pairwise-gap lines of a report: one per criterion, one per ISA, then the total. */
export function pairwiseGapLines(r: WithoutEvalReport): string[] {
  return [
    ...r.pairwise_gaps.map((g) => `pairwise-gap ${g.isa} ${g.isc} ${g.problem} (${g.detail?.[0] ?? g.outputs[0] ?? "no captured output"})`),
    ...r.pairwise_gaps_by_isa.map((x) => `pairwise-gaps ${String(x.count).padStart(3)}  ${x.isa}`),
    `${r.pairwise_gaps.length} pairwise gaps in ${r.pairwise_gaps_by_isa.length} of ${r.isas} in-scope ISAs: criteria judged by a rubric over a file, page or screenshot output with no pairwise stage against champion:last-accepted after it, a misplaced or rubric-less one, or a candidate no earlier stage writes or a page captured without the sanctioned tool (${r.scope})`,
  ];
}
/** `--without-eval` (exit 1 while any criterion lacks an eval) or, with `gapsOnly`, `--pairwise-gaps` (exit 1 while any gap is open). */
export async function withoutEvalReport(args: string[], gapsOnly = false, opts: import("./lib/IsaScope.ts").ResolveOptions = {}): Promise<number> {
  const flag = gapsOnly ? "--pairwise-gaps" : "--without-eval";
  const i = args.indexOf("--scope");
  const scope = i >= 0 ? args[i + 1] : "projects,recent:14d";
  if (!scope) { console.error(`usage: EvalCensus.ts ${flag} [--scope projects,recent:14d] [--json]`); return 2; }
  let r: WithoutEvalReport;
  try { r = await withoutEval(scope, opts); } catch (e) { console.error(`EvalCensus: ${(e as Error).message}`); return 2; }
  if (args.includes("--json")) console.log(JSON.stringify(r, null, 1));
  else if (gapsOnly) for (const l of pairwiseGapLines(r)) console.log(l);
  else {
    for (const m of r.missing) console.log(`no-eval ${m.isa} ${m.isc}`);
    for (const u of r.unresolved) console.log(`unresolved PROJECTS.md ${u}`);
    console.log(`${r.missing.length} of ${r.criteria} criteria in ${r.isas} in-scope ISAs have no eval (${r.scope})`);
    for (const l of pairwiseGapLines(r)) console.log(l);
  }
  // An in-scope project whose ISA cannot be resolved contributes no criteria, so a clean count
  // proves nothing about it: fail closed until every scope entry resolves and is inspected.
  if (r.unresolved.length > 0) {
    console.error(`EvalCensus: ${r.unresolved.length} in-scope project ISA(s) unresolved; coverage is not certified`);
    return 1;
  }
  if (gapsOnly) return r.pairwise_gaps.length > 0 ? 1 : 0;
  return r.missing.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--without-eval")) process.exit(await withoutEvalReport(args));
  if (args.includes("--pairwise-gaps")) process.exit(await withoutEvalReport(args, true));
  if (args.includes("--glance-budget")) process.exit(await glanceBudgetReport());
  if (args.includes("--tiers")) {
    const totals = { code: 0, glance: 0, judge: 0, human: 0 };
    for (const isa of await isaFiles()) {
      for (const p of parseTestStrategyDiagnostic(isa).probes) {
        if (!Object.hasOwn(totals, p.tier)) console.log(`no-tier ${isa} ${p.isc}`);
        else totals[p.tier]++;
      }
    }
    console.log("tier\tcount");
    for (const [tier, count] of Object.entries(totals)) console.log(`${tier}\t${count}`);
    process.exit(args.includes("--pairing") ? await pairingReport() : 0);
  }
  if (args.includes("--pairing")) process.exit(await pairingReport());
  if (args[0] === "buckets") {
    const i = args.indexOf("--isa");
    if (i >= 0 && !args[i + 1]) { console.error("usage: EvalCensus.ts buckets [--isa <path>] [--json]"); process.exit(2); }
    await buckets(i >= 0 ? args[i + 1] : undefined, args.includes("--json"));
    process.exit(0);
  }
  if (args.includes("--calibration-coverage")) process.exit(coverageReport(args.includes("--json")));
  const i = args.indexOf("--dropped-baseline");
  if (i >= 0) {
    const mode = args[i + 1];
    const file = args[i + 2];
    if (!file || (mode !== "capture" && mode !== "compare")) {
      console.error("usage: EvalCensus.ts --dropped-baseline capture|compare <file.json> [--allow <regex>]");
      process.exit(2);
    }
    if (mode === "capture") {
      const b = await capture();
      writeFileSync(file, JSON.stringify(b, null, 1));
      console.log(`captured ${b.files} files, ${b.probes} probes, ${b.dropped} dropped → ${file}`);
      process.exit(0);
    }
    const a = args.indexOf("--allow");
    process.exit(await compare(file, a >= 0 && args[a + 1] ? new RegExp(args[a + 1]!) : null));
  }
  if (args.includes("--json")) { console.log(JSON.stringify(await censusData(), null, 1)); process.exit(0); }
  const debt = await census();
  // ISC-36 probe: --format-strict exits 1 while any row is repaired or invalid.
  if (args.includes("--format-strict")) process.exit(debt.repaired > 0 || debt.invalid > 0 ? 1 : 0);
}
