/**
 * CompileEstate — runs Compile --write across the in-scope ISAs
 * (eval-compile ISA, F9 M4, ISC-37). Scope comes from
 * LIFEOS/TOOLS/lib/IsaScope.ts, the same resolver EvalCensus --without-eval reads.
 *
 * Per ISA: skipped when it carries uncommitted changes (somebody's in-flight
 * work), when an Evals.proposed.md already waits for merge, or when Compile's
 * own incremental state says every eval is current. Otherwise compiled and its
 * proposal written beside it. It never merges: merging is `Compile.ts merge`,
 * a separate main-session step.
 *
 * Usage: bun CompileEstate.ts [--scope projects,recent:14d] [--dry-run] [--concurrency N] [--json]
 * Exit 0 done · 1 some ISA had refusals or errors · 2 usage or scope error.
 */
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_SCOPE, gitState, resolveScope, type ResolveOptions } from "../../../LIFEOS/TOOLS/lib/IsaScope.ts";
import { compile, NEEDS_COMPILE, writeProposed, type CompileOptions } from "./Compile.ts";
import { proposalPending } from "./CompileMerge.ts";

export const DEFAULT_CONCURRENCY = 4;

export type EstateStatus = "compiled" | "would-compile" | "current" | "dirty" | "pending-merge" | "error";
export interface EstateRow {
  isa: string;
  sources: string[];
  status: EstateStatus;
  /** Criteria (plus inherited library checks) that need compiling. */
  todo: number;
  compiled: number;
  splits: number;
  refusals: number;
  calls: number;
  written: string | null;
  error?: string;
}
export interface EstateResult {
  scope: string;
  dryRun: boolean;
  rows: EstateRow[];
  unresolved: string[];
  summary: {
    isas: number; compiled: number; criteria: number; splits: number; refusals: number; calls: number; skipped: Record<string, number>; wallMs: number;
    /** Criteria in dirty ISAs: never compiled this run, compiled after their owners commit. */
    deferred: { dirtyIsas: number; dirtyCriteria: number };
  };
}

export interface EstateOptions {
  scope?: string;
  dryRun?: boolean;
  concurrency?: number;
  /** Passed to every compile (tests inject `infer`, `reference`, `suites`). */
  compile?: CompileOptions;
  resolve?: ResolveOptions;
  /** Uncommitted-change probe; default git status on the file. */
  gitState?: (path: string) => "clean" | "dirty" | "no-repo";
}

async function pool<T>(items: T[], n: number, work: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

export async function compileEstate(opts: EstateOptions = {}): Promise<EstateResult> {
  const started = Date.now();
  const scope = opts.scope ?? DEFAULT_SCOPE;
  const dryRun = !!opts.dryRun;
  const probe = opts.gitState ?? gitState;
  const { entries, unresolved } = await resolveScope(scope, opts.resolve);
  const rows: EstateRow[] = [];
  await pool(entries, Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY), async (entry) => {
    const row: EstateRow = { isa: entry.path, sources: entry.sources, status: "current", todo: 0, compiled: 0, splits: 0, refusals: 0, calls: 0, written: null };
    rows.push(row);
    try {
      if (proposalPending(dirname(entry.real))) { row.status = "pending-merge"; return; }
      const plan = await compile(entry.real, { ...opts.compile, dryRun: true });
      row.todo = plan.criteria.filter((c) => NEEDS_COMPILE.has(c.state)).length + plan.inherited.compiled.length;
      // A dirty ISA is never compiled (somebody's in-flight work), but its todo is counted,
      // so the criteria it leaves without an eval are reported, never lost.
      if (probe(entry.real) === "dirty") { row.status = "dirty"; return; }
      if (row.todo === 0 && !plan.inherited.errors.length) { row.status = "current"; return; }
      if (dryRun) { row.status = "would-compile"; return; }
      const r = await compile(entry.real, { ...opts.compile, dryRun: false });
      row.compiled = r.compiled.length + r.inherited.compiled.length;
      row.splits = r.split.length;
      row.refusals = r.failed.length + r.inherited.errors.length;
      row.calls = r.calls;
      if (row.compiled || row.splits || row.refusals) row.written = writeProposed(entry.real, r.proposed);
      row.status = "compiled";
    } catch (e) {
      row.status = "error";
      row.error = (e as Error).message;
    }
  });
  rows.sort((a, b) => a.isa.localeCompare(b.isa));
  const skipped: Record<string, number> = {};
  for (const r of rows) if (r.status !== "compiled" && r.status !== "would-compile") skipped[r.status] = (skipped[r.status] ?? 0) + 1;
  const done = rows.filter((r) => r.status === "compiled");
  return {
    scope, dryRun, rows, unresolved: unresolved.map((u) => `${u.project}: ${u.raw}`),
    summary: {
      isas: rows.length,
      compiled: done.length,
      criteria: done.reduce((n, r) => n + r.compiled, 0),
      splits: done.reduce((n, r) => n + r.splits, 0),
      refusals: done.reduce((n, r) => n + r.refusals, 0),
      calls: done.reduce((n, r) => n + r.calls, 0),
      skipped,
      wallMs: Date.now() - started,
      deferred: {
        dirtyIsas: rows.filter((r) => r.status === "dirty" && r.todo > 0).length,
        dirtyCriteria: rows.reduce((n, r) => n + (r.status === "dirty" ? r.todo : 0), 0),
      },
    },
  };
}

export function estateText(r: EstateResult): string {
  const out: string[] = [];
  for (const row of r.rows) {
    const detail = row.status === "compiled" ? ` ${row.compiled} compiled, ${row.splits} split, ${row.refusals} refused, ${row.calls} call(s)`
      : row.status === "would-compile" ? ` ${row.todo} criteria to compile`
      : row.status === "dirty" ? ` ${row.todo} criteria deferred until its uncommitted changes land`
      : row.error ? ` ${row.error}` : "";
    out.push(`${row.status.padEnd(13)} ${row.isa} [${row.sources.join("+")}]${detail}`);
  }
  for (const u of r.unresolved) out.push(`unresolved    PROJECTS.md ${u}`);
  const s = r.summary;
  const skipped = Object.entries(s.skipped).map(([k, v]) => `${v} ${k}`).join(", ") || "none";
  const actOn = r.dryRun ? "" : `${s.splits} split(s) and ${s.refusals} refusal(s) for the main session, `;
  const left = `left without an eval: ${actOn}${s.deferred.dirtyCriteria} criteria in ${s.deferred.dirtyIsas} dirty ISA(s) to compile after their owners commit`;
  out.push(r.dryRun
    ? `estate (dry run, ${r.scope}): ${s.isas} ISAs in scope, ${r.rows.filter((x) => x.status === "would-compile").length} would compile (${r.rows.reduce((n, x) => n + (x.status === "would-compile" ? x.todo : 0), 0)} criteria); skipped ${skipped}; no model call; ${left}`
    : `estate (${r.scope}): ${s.compiled} ISAs compiled, ${s.criteria} criteria compiled, ${s.splits} splits, ${s.refusals} refusals, ${s.calls} model call(s), ${(s.wallMs / 1000).toFixed(1)} s wall; skipped ${skipped}; ${left}`);
  return out.join("\n");
}

async function main(argv: string[]): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({ args: argv, options: {
      scope: { type: "string" }, "dry-run": { type: "boolean" }, concurrency: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
    } }));
  } catch (e) { console.error(`compile-estate: ${(e as Error).message}`); return 2; }
  if (values.help) { console.log(await Bun.file(join(import.meta.dir, "CompileEstate.help.md")).text()); return 0; }
  const concurrency = values.concurrency ? Number(values.concurrency) : DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) { console.error("compile-estate: --concurrency takes a positive integer"); return 2; }
  let r: EstateResult;
  try { r = await compileEstate({ scope: values.scope as string | undefined, dryRun: !!values["dry-run"], concurrency }); }
  catch (e) { console.error(`compile-estate: ${(e as Error).message}`); return 2; }
  console.log(values.json ? JSON.stringify(r, null, 2) : estateText(r));
  return r.summary.refusals || r.rows.some((x) => x.status === "error") ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
