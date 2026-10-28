#!/usr/bin/env bun
/**
 * test-baseline — records which tests already fail in the suites the Arbol → Workflows
 * rename touches, so a rename lane is judged on the failures it adds, never on ones it
 * inherited (Workflows ISA ISC-221, ISC-222).
 *
 *   bun LIFEOS/WORKFLOWS/engine/test-baseline.ts record [suite ...]   run suites, write their failing tests
 *   bun LIFEOS/WORKFLOWS/engine/test-baseline.ts check <suite> [...]  exit 1 when any named suite has a failure outside its baseline
 *   bun LIFEOS/WORKFLOWS/engine/test-baseline.ts list                 print the suites and their baseline counts
 *   --baseline <file>  move the baseline file (default USER/Workflows/migration/rename-test-baseline.json)
 *   --system <dir> / --user <dir> / --fleet <dir>  move the three roots (tests use temp dirs)
 *   --timeout <seconds>  per-suite limit (default 900); a suite that runs out fails the command
 *   --json  machine output
 *
 * The baseline file describes each suite (root + path) as well as its failures, so `check`
 * runs exactly what `record` ran. Tests run with a `./`-prefixed path: Bun 1.3.6 drops child
 * output for a bare relative path. `record` runs suites one at a time: a test that only fails
 * under parallel load is a flake, never a baseline failure.
 *
 * A failure is new when it is a failing test name the baseline does not list, or when it has no
 * name at all: bun reports a test file that cannot load (a moved module, a broken import) as
 * "1 fail / 1 error" with no "(fail)" line, so nameless failures and errors are compared as counts
 * against the baseline. A suite that suddenly runs no tests, or exits non-zero with nothing
 * failing, fails the check too. A suite that had no tests when recorded and still has none
 * passes, and is reported as vacuous (`vacuous: true` in --json) so it never reads as proof.
 *
 * Exit codes: 0 clean, 1 a new failure (or a suite that could not run), 2 usage.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { invariant } from "../../TOOLS/Invariant.ts";
// release-allow: private-skill-names (suite registry rows; a missing suite path throws a named error before any spawn)

export type SuiteRoot = "system" | "user" | "fleet";
export interface SuiteDef { root: SuiteRoot; path: string }
export interface SuiteRecord extends SuiteDef { failing: string[]; passed: number; failed: number; errors: number; recorded_at: string; note?: string }
export interface Baseline { version: 1; purpose: string; suites: Record<string, SuiteRecord> }
export interface Roots { system: string; user: string; fleet: string }

/**
 * The nine suites the rename lanes touch (ISC-221). `path` is relative to its root; "." runs the
 * whole root. The ids are the ones the lanes' rows name (ISC-190, ISC-194, ISC-200, ISC-204).
 */
export const SUITES: Record<string, SuiteDef> = {
  fleet: { root: "fleet", path: "." },
  "pulse-modules": { root: "system", path: "LIFEOS/PULSE/modules" },
  bunker: { root: "system", path: "LIFEOS/PULSE/Bunker" },
  socrates: { root: "system", path: "LIFEOS/SOCRATES" },
  "lifeos-tools": { root: "system", path: "LIFEOS/TOOLS" },
  hooks: { root: "system", path: "hooks" },
  "lifeos-skill-tools": { root: "system", path: "private-maintenance-tooling-not-included/Tools" },
  harvest: { root: "system", path: "skills/Harvest" },
  "lifeos-install": { root: "system", path: "skills/LifeOS" },
};

export function defaultRoots(): Roots {
  const system = resolve(import.meta.dir, "..", "..", "..");
  const link = join(system, "LIFEOS", "USER");
  const user = existsSync(link) ? realpathSync(link) : link;
  return { system, user, fleet: join(user, "CUSTOMIZATIONS", "WORKFLOWS") };
}

export const baselinePath = (roots: Roots): string => join(roots.user, "Workflows", "migration", "rename-test-baseline.json");

export interface SuiteRun { failing: string[]; passed: number; failed: number; errors: number; errorLines: string[]; noTests: boolean; exitCode: number | null; timedOut: boolean }

/**
 * Failing test names from bun test output. Bun prints one `(fail) <describe> > <name> [12.34ms]`
 * line per failure; the timing suffix varies run to run, so it is dropped.
 */
export function parseFailures(output: string): string[] {
  const names = new Set<string>();
  for (const raw of output.split("\n")) {
    const m = raw.replace(/\x1b\[[0-9;]*m/g, "").match(/^\s*\(fail\)\s+(.*?)(?:\s+\[[\d.]+\s*m?s\])?\s*$/);
    if (m && m[1]) names.add(m[1]);
  }
  return [...names].sort();
}

/** The first `error:` lines bun prints outside any test (a file that failed to load), for the report. */
function errorLines(output: string): string[] {
  return output.split("\n").map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim()).filter((l) => l.startsWith("error:")).slice(0, 5);
}

/** The `N pass` / `N fail` / `N error` totals bun prints at the end of a run; 0 when absent. */
function total(output: string, word: "pass" | "fail" | "error"): number {
  const m = output.match(new RegExp("^\\s*(\\d+)\\s+" + word + "\\s*$", "m"));
  return m ? Number(m[1]) : 0;
}

export function runSuite(def: SuiteDef, roots: Roots, timeoutSec: number): SuiteRun {
  const base = roots[def.root];
  const target = def.path === "." ? [] : [`./${def.path.replace(/^\.\//, "")}`];
  if (!existsSync(join(base, def.path))) throw new Error(`suite path missing: ${def.root}:${def.path}`);
  const r = Bun.spawnSync(["bun", "test", ...target], { cwd: base, stdout: "pipe", stderr: "pipe", timeout: timeoutSec * 1000, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } });
  const output = `${r.stdout.toString()}\n${r.stderr.toString()}`;
  const timedOut = r.exitCode === null;
  const noTests = total(output, "pass") === 0 && total(output, "fail") === 0 && parseFailures(output).length === 0;
  return { failing: parseFailures(output), passed: total(output, "pass"), failed: total(output, "fail"), errors: total(output, "error"), errorLines: errorLines(output), noTests, exitCode: r.exitCode, timedOut };
}

export function readBaseline(path: string): Baseline {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Baseline>;
  if (raw.version !== 1 || typeof raw.suites !== "object" || raw.suites === null) throw new Error(`${path}: not a version-1 baseline with suites`);
  for (const [name, s] of Object.entries(raw.suites)) {
    if (!s || !["system", "user", "fleet"].includes(s.root) || typeof s.path !== "string" || !Array.isArray(s.failing)) throw new Error(`${path}: suite ${name} is malformed`);
    for (const k of ["passed", "failed", "errors"] as const) if (!Number.isInteger(s[k]) || s[k] < 0) throw new Error(`${path}: suite ${name}: ${k} must be a non-negative integer`);
  }
  return raw as Baseline;
}

/**
 * Failures in a run that the baseline does not account for: unknown failing names, plus one
 * entry per kind of nameless failure beyond the baseline's count (see the header).
 */
export function newFailures(run: SuiteRun, record: SuiteRecord): string[] {
  const known = new Set(record.failing);
  const fresh = run.failing.filter((f) => !known.has(f));
  const why = run.errorLines.length ? ` (${run.errorLines.join(" | ")})` : "";
  const unnamed = Math.max(0, run.failed - run.failing.length);
  const baselineUnnamed = Math.max(0, record.failed - record.failing.length);
  if (unnamed > baselineUnnamed) fresh.push(`${unnamed - baselineUnnamed} failure(s) with no test name, such as a test file that could not load${why}`);
  if (run.errors > record.errors) fresh.push(`${run.errors - record.errors} error(s) outside any test beyond the baseline's ${record.errors}${why}`);
  const baselineRan = record.passed + record.failed;
  if (run.noTests && baselineRan > 0) fresh.push(`the suite ran no tests; the baseline ran ${baselineRan}`);
  if (!run.noTests && run.exitCode !== 0 && run.failed === 0 && run.errors === 0) fresh.push(`bun test exited ${run.exitCode} with nothing failing`);
  return fresh;
}

export function writeBaseline(path: string, baseline: Baseline): void {
  for (const [name, s] of Object.entries(baseline.suites)) {
    invariant(Array.isArray(s.failing) && s.failing.every((f) => typeof f === "string" && f.length > 0), `baseline suite ${name}: failing must be non-empty strings`);
    invariant(s.failed >= 0 && s.passed >= 0 && s.errors >= 0, `baseline suite ${name}: negative totals`);
    invariant(s.failed >= s.failing.length, `baseline suite ${name}: fewer failures than failing names`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
}

/* ── CLI ────────────────────────────────────────────────────────────────── */

const USAGE = "usage: test-baseline.ts record [suite ...] | check <suite> [suite ...] | list [--baseline <file>] [--system|--user|--fleet <dir>] [--timeout <s>] [--json]";

export function main(argv: string[]): number {
  const positional: string[] = [];
  const values = new Map<string, string>();
  let json = false;
  for (let k = 0; k < argv.length; k += 1) {
    const a = argv[k]!;
    if (a === "--json") json = true;
    else if (["--baseline", "--system", "--user", "--fleet", "--timeout"].includes(a)) {
      const v = argv[k + 1];
      if (values.has(a) || v === undefined || v.startsWith("--")) { console.error(USAGE); return 2; }
      values.set(a, v); k += 1;
    } else if (a.startsWith("--")) { console.error(USAGE); return 2; }
    else positional.push(a);
  }
  const [cmd, ...names] = positional;
  const d = defaultRoots();
  const roots: Roots = {
    system: resolve(values.get("--system") ?? d.system),
    user: resolve(values.get("--user") ?? d.user),
    fleet: resolve(values.get("--fleet") ?? d.fleet),
  };
  const file = resolve(values.get("--baseline") ?? baselinePath(roots));
  const timeout = Number(values.get("--timeout") ?? 900);
  if (!Number.isFinite(timeout) || timeout <= 0) { console.error(USAGE); return 2; }

  try {
    if (cmd === "list") {
      const b = readBaseline(file);
      if (json) console.log(JSON.stringify(b, null, 2));
      else for (const [n, s] of Object.entries(b.suites)) console.log(`${n.padEnd(22)} ${s.root}:${s.path}  ${s.failing.length} baseline failure(s)  recorded ${s.recorded_at}`);
      return 0;
    }
    if (cmd === "record") {
      const unknown = names.filter((n) => !SUITES[n]);
      if (unknown.length) { console.error(`unknown suite(s): ${unknown.join(", ")}`); return 2; }
      // With no suite named, record every registered suite this install carries. A suite whose path is absent (a
      // maintainer-side tree a public install does not ship) is skipped and said so; naming it still fails loudly.
      const chosen = names.length ? names : Object.keys(SUITES).filter((n) => {
        const def = SUITES[n]!;
        if (existsSync(join(roots[def.root], def.path))) return true;
        console.log(`${n}: skipped, ${def.root}:${def.path} is not in this install`);
        return false;
      });
      const baseline: Baseline = existsSync(file) ? readBaseline(file) : { version: 1, purpose: "Failing tests per suite before the Arbol → Workflows rename lanes edit (Workflows ISA ISC-221).", suites: {} };
      let bad = 0;
      for (const n of chosen) {
        const run = runSuite(SUITES[n]!, roots, timeout);
        if (run.timedOut) { console.error(`${n}: timed out after ${timeout}s; not recorded`); bad += 1; continue; }
        const note = run.noTests ? "no test files in this suite" : undefined;
        baseline.suites[n] = { ...SUITES[n]!, failing: run.failing, passed: run.passed, failed: run.failed, errors: run.errors, recorded_at: new Date().toISOString(), ...(note ? { note } : {}) };
        console.log(`${n}: ${run.passed} pass, ${run.failed} fail, ${run.errors} error${note ? ` (${note})` : ""}`);
      }
      writeBaseline(file, baseline);
      return bad ? 1 : 0;
    }
    if (cmd === "check") {
      if (names.length === 0 || new Set(names).size !== names.length) { console.error(USAGE); return 2; }
      const suites = readBaseline(file).suites;
      const missing = names.filter((n) => !suites[n]);
      if (missing.length) { console.error(`no baseline in ${file} for suite(s): ${missing.join(", ")} (known: ${Object.keys(suites).join(", ")})`); return 1; }
      const results = names.map((name) => {
        const record = suites[name]!;
        const run = runSuite(record, roots, timeout);
        const fresh = run.timedOut ? [`timed out after ${timeout}s`] : newFailures(run, record);
        const fixed = run.timedOut ? [] : record.failing.filter((f) => !run.failing.includes(f));
        // A suite with no tests then and now passes, but proves nothing; the report says so instead of reading as green.
        const vacuous = !run.timedOut && run.noTests && record.passed + record.failed === 0;
        return { suite: name, ok: fresh.length === 0, vacuous, new_failures: fresh, baseline_failures: record.failing.length, fixed, passed: run.passed, failed: run.failed, errors: run.errors };
      });
      const ok = results.every((r) => r.ok);
      if (json) console.log(JSON.stringify({ ok, suites: results }, null, 2));
      else for (const r of results) {
        for (const f of r.new_failures) console.log(`  ✗ ${r.suite}: new failure: ${f}`);
        console.log(!r.ok ? `${r.suite}: ${r.new_failures.length} failure(s) outside the baseline`
          : r.vacuous ? `${r.suite}: vacuous: the suite has no test files, then or now, so this check proves nothing about it`
          : `${r.suite}: no failure outside the baseline (${r.failed} fail, ${r.baseline_failures} in baseline, ${r.fixed.length} fixed)`);
      }
      return ok ? 0 : 1;
    }
  } catch (e) {
    if ((e as Error).name === "InvariantViolation") throw e;
    console.error(`test-baseline: ${(e as Error).message}`);
    return 1;
  }
  console.error(USAGE);
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
