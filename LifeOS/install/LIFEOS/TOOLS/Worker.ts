#!/usr/bin/env bun
/**
 * @version 1.4.3
 * Worker.ts — hand one task to a codex worker in ONE call, with no Claude wrapper in between.
 *
 * The router must pass work through to completion: the Sol agent is a Claude wrapper whose only
 * job is to pass the brief to CodexProgress.ts. The wrapper is an LLM, so it wandered: it tried
 * the work itself, got refused by WorkerWrapperGuard, fought the heredoc shape, read the guard's
 * source, ran part of the task itself, and hit its 20-turn cap with the codex child's finished
 * result and its own findings never handed back. This tool is the wrapper's contract as code:
 * the same brief sections, the same helper, the same lane registry, and nothing to wander.
 *
 * Usage (run it as a background Bash call so a long codex run is never killed by the 10-minute foreground cap):
 *   bun ~/.claude/LIFEOS/TOOLS/Worker.ts <sol|astra> --slug <run-slug> --cwd <absolute task dir> [--mode build|audit] [--effort medium|high|xhigh] [--timeout-ms N] [--parent-run run_<uuid>] <<'TASK'
 *
 * `--mode audit` (2026-10-12, when the OpenAI-eye lane moved to Sol) runs the child read-only and sends an open
 * question as the brief: exhaustive sweeps, security reads and second opinions. Build is the default.
 *   [the task: objective, paths, verification commands]
 *   TASK
 *
 * `--cwd` (1.3.0, 2026-10-04) is forwarded to CodexProgress.ts, which runs the codex child there. Without it the
 * child runs in this process's working directory, and the helper refuses that when it is the LifeOS install.
 *
 * Output: the helper's one JSON line (verdict, final_message, model, co_authored_by). The final
 * message also sits in MEMORY/WORK/<slug>/<name>-final.txt. The delegation meter counts this call
 * as a dispatch (Router ISA R31).
 *
 * Waiting (1.2.0, 2026-10-04): a background run re-invokes a main session when it finishes, but an agent
 * inside a Workflow is never re-invoked: the harness takes its answer as soon as it stops calling tools, so
 * the Sol wrappers in one project's lane wave handed back nothing and left their codex children orphaned.
 * The wait is a foreground call that fits under the 10-minute cap and is repeated until the run is over:
 *   bun ~/.claude/LIFEOS/TOOLS/Worker.ts wait <sol|astra> --slug <run-slug> [--max-seconds 540]
 * It blocks until the run's result file appears (CodexProgress.ts writes it last, and removes the previous
 * run's at start) or max-seconds pass, then prints one JSON line:
 *   {state: "done"|"running"|"error"|"timeout", verdict?, final_message?, co_authored_by?, reason?, …}
 * Exit 0 done, 3 still running (call it again), 1 error or codex timeout, 2 bad arguments. It reads files
 * and process ids only: it never starts, signals or deletes anything.
 */

import main, { runFiles, slugDirFor } from "./CodexProgress";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { attribution } from "../../hooks/lib/run-attribution";
import { checkBrief } from "./BriefGate";

/**
 * Luna and Terra were retired 2026-10-07 (HAI-4): the low and medium rungs are the in-session Haiku agent at its routed effort,
 * not codex workers. Asking this tool for one gets a pointer to the replacement, not "unknown worker".
 */
export const RETIRED_WORKERS: Record<string, string> = {
  luna: "the Haiku agent at medium effort (Agent subagent_type=Haiku, effort=medium)",
  terra: "the Haiku agent (Agent subagent_type=Haiku)",
};

/** Resolves the worker argument, or throws: a retired name names its Haiku replacement, any other lists the valid workers. */
function workerFor(key: unknown, prefix = ""): (typeof WORKERS)[string] {
  const k = String(key ?? "").toLowerCase();
  const worker = WORKERS[k];
  if (worker) return worker;
  if (RETIRED_WORKERS[k]) throw new Error(`${prefix}${k} is retired (2026-10-07); use ${RETIRED_WORKERS[k]} instead. Worker.ts runs only: ${Object.keys(WORKERS).join(", ")}`);
  throw new Error(`${prefix}first argument must be one of: ${Object.keys(WORKERS).join(", ")}`);
}

/** Worker name → CROSS_VENDOR lane, sandbox and default timeout. Astra is build mode here. */
export const WORKERS: Record<string, { name: string; lane: string; timeoutMs: number }> = {
  sol: { name: "Sol", lane: "sol", timeoutMs: 1_800_000 },
  astra: { name: "Astra", lane: "astra", timeoutMs: 1_800_000 },
};

/**
 * The brief a leg below Astra arrives with has to carry the deciding the caller already did. That gate
 * is `BriefGate.ts`, not this file: the agent wrappers call the helper directly, so a check that lived only
 * here was routed around (cross-vendor audit, 2026-09-20). Re-exported for the callers that had it here.
 */
export { BRIEF_GAP_HELP, briefGaps, checkBrief } from "./BriefGate";

/** The brief every worker gets — the SHARED:WORKER-CONTRACT sections, as code. Pure. */
export function buildBrief(task: string, worker = "sol", mode: Mode = "build"): string {
  const executor = mode !== "audit" && worker.toLowerCase() !== "astra";
  return [
    "# Worker task",
    "",
    ...(executor
      ? [
          "## How to read this",
          "You are executing a decision that is already made. The approach below was chosen by the caller; follow it rather than re-deciding it, and do not redesign, re-scope or improve on it.",
          "If you hit a choice this brief does not settle and the answer would change the result, stop and return `{\"verdict\":\"needs-judgment\",\"question\":\"<the one open choice>\"}` with what you completed so far. Guessing is the failure; asking is free.",
          "",
        ]
      : []),
    "## Constraints",
    "- TypeScript over anything else; bun/bunx, never npm/npx.",
    "- Edit only inside the current directory. Do not stage, commit, push, deploy, or touch .env, secrets, or credentials.",
    "- No placeholder content, no TODO/FIXME left behind, no dead code.",
    "- No hardcoded home paths; use relative paths or environment variables.",
    "- Bulk data (logs, exports, corpora, large query results) is filtered and reduced in code; only the reduced result enters the model context.",
    "",
    // The contract in Sol.md names four sections; the 1.0.0 brief emitted two and
    // dropped Objective and Verification — the two that carry the caller's thinking. Restored as
    // instructions over the task below, since the task itself is what the caller wrote.
    "## Objective",
    "The task below, restated in your own words before you start. If you cannot restate it, you do not have enough to execute: say so instead of guessing.",
    "",
    "## Verification",
    "Run the exact commands the task names and report their real output. If it names none, say what you did to convince yourself it worked.",
    "",
    "## Deliverable",
    "Return: files changed (path + one line each), the verification commands you ran with their actual output, any findings the task asked for, and anything left undone with the reason. \"Should work\" is a failure condition.",
    "",
    "---",
    "",
    task.trim(),
    "",
  ].join("\n");
}

/** The reasoning efforts a codex worker accepts: the routed range, high by default (Algorithm § Routing). */
export { EFFORTS, type Effort } from "../../hooks/lib/lane-rules";
import { DEFAULT_EFFORT, EFFORTS, type Effort } from "../../hooks/lib/lane-rules";

const PARENT_RUN_ID = /^run_[0-9a-f-]{36}$/;

/**
 * The run id a spawned child names as its parent (EventLogger reads it from LIFEOS_PARENT_RUN_ID).
 * An explicit `--parent-run` wins; else the latest run of the invoking session (the run-state EventLogger writes, found
 * through CLAUDE_SESSION_ID or CLAUDE_CODE_SESSION_ID); else null, and nothing is guessed. A malformed explicit value throws.
 */
export function parentRunId(explicit?: string | null, env: NodeJS.ProcessEnv = process.env, runStateDir?: string): string | null {
  if (explicit) {
    if (!PARENT_RUN_ID.test(explicit)) throw new Error("--parent-run must be a run id (run_<uuid>)");
    return explicit;
  }
  return attribution(env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID, { runStateDir }).run_id;
}

/** Sets LIFEOS_PARENT_RUN_ID in `env` (default: this process, which the codex child inherits) when a parent run is known. Returns it. */
export function applyParentRun(explicit?: string | null, env: NodeJS.ProcessEnv = process.env, runStateDir?: string): string | null {
  const parent = parentRunId(explicit, env, runStateDir);
  if (parent) env.LIFEOS_PARENT_RUN_ID = parent;
  return parent;
}

export type Mode = "build" | "audit";
export type WorkerArgs = { worker: (typeof WORKERS)[string]; slug: string; timeoutMs: number; effort: Effort; parentRun: string | null; cwd: string | null; mode: Mode };

/** Parse `<worker> --slug S [--cwd DIR] [--effort E] [--timeout-ms N] [--parent-run RUN_ID]`. Throws on anything else. Pure. */
export function parseWorkerArgs(argv: string[]): WorkerArgs {
  const [key, ...rest] = argv;
  const worker = workerFor(key);
  let slug = "", timeoutMs = worker.timeoutMs, effort: Effort = DEFAULT_EFFORT, parentRun: string | null = null, cwd: string | null = null, mode: Mode = "build";
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--slug") slug = value;
    else if (flag === "--timeout-ms") timeoutMs = Number(value);
    else if (flag === "--cwd") { if (!value) throw new Error("--cwd must not be empty"); cwd = value; } // CodexProgress.ts checks it is an absolute, existing directory
    else if (flag === "--parent-run") { if (!PARENT_RUN_ID.test(value)) throw new Error("--parent-run must be a run id (run_<uuid>)"); parentRun = value; }
    else if (flag === "--mode") { if (value !== "build" && value !== "audit") throw new Error("--mode must be build or audit"); mode = value; }
    else if (flag === "--effort") { if (!(EFFORTS as readonly string[]).includes(value)) throw new Error(`--effort must be one of: ${EFFORTS.join(", ")}`); effort = value as Effort; }
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!slug) throw new Error("--slug is required");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive integer");
  return { worker, slug, timeoutMs, effort, parentRun, cwd, mode };
}

/** The CodexProgress.ts argv for one parsed launch: the worker's lane and sandbox, and `--cwd` exactly as given. Pure. */
export function helperArgs(parsed: WorkerArgs, task: string): string[] {
  const { worker, slug, timeoutMs, effort, cwd, mode } = parsed;
  return [
    "--slug", slug, ...(cwd !== null ? ["--cwd", cwd] : []), "--agent", worker.name, "--lane", worker.lane,
    "--reasoning-effort", effort, "--sandbox", mode === "audit" ? "read-only" : "workspace-write", "--codex-home", "isolated",
    "--timeout-ms", String(timeoutMs), "--prompt", buildBrief(task, worker.lane, mode),
  ];
}

/** The longest single wait: under the harness's 10-minute foreground cap with room for startup and the report line. */
export const WAIT_MAX_SECONDS = 590;
export const WAIT_DEFAULT_SECONDS = 540;
const SLUG_RE = /^[A-Za-z0-9._-]+$/; // the charset CodexProgress.ts enforces, since the slug is a directory name

export type WaitArgs = { worker: (typeof WORKERS)[string]; slug: string; maxSeconds: number };

/** Parse `wait <worker> --slug S [--max-seconds N]` (argv after `wait`). Throws on anything else. Pure. */
export function parseWaitArgs(argv: string[]): WaitArgs {
  const [key, ...rest] = argv;
  const worker = workerFor(key, "wait: ");
  let slug = "", maxSeconds = WAIT_DEFAULT_SECONDS;
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (value === undefined) throw new Error(`wait: ${flag} needs a value`);
    if (flag === "--slug") slug = value;
    else if (flag === "--max-seconds") maxSeconds = Number(value);
    else throw new Error(`wait: unknown flag ${flag}`);
  }
  if (!slug) throw new Error("wait: --slug is required");
  if (!SLUG_RE.test(slug) || slug === "." || slug === "..") throw new Error("wait: --slug must contain only letters, numbers, dot, underscore, or hyphen");
  if (!Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > WAIT_MAX_SECONDS) throw new Error(`wait: --max-seconds must be an integer from 1 to ${WAIT_MAX_SECONDS}`);
  return { worker, slug, maxSeconds };
}

export type WaitState = "done" | "running" | "error" | "timeout";
export type WaitReport = {
  state: WaitState; worker: string; slug: string; waited_seconds: number;
  verdict?: string; final_message?: string; co_authored_by?: string; final_file?: string; events_file?: string; reason?: string;
};

/** What one look at a run's files shows: its result, a live helper, nothing alive, or a result that is not a run result. */
export type RunLook =
  | { kind: "result"; result: Record<string, unknown> }
  | { kind: "alive"; pid: number }
  | { kind: "absent"; why: string }
  | { kind: "corrupt"; why: string };

/** Whether a pid is a live bun process (the helper runs under bun, as CodexProgress.ts or through Worker.ts). */
export function helperAlive(pid: number): boolean {
  try { process.kill(pid, 0); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "EPERM") return false; }
  try {
    // A recycled pid that now belongs to something else must not hold the wait open for its whole budget.
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).toLowerCase().includes("bun");
  } catch {
    return false; // ps exits non-zero when the pid is gone between the two checks
  }
}

/** One read-only look at an agent's run under `slugDir`. `alive` is injectable for tests. */
export function inspectRun(slugDir: string, workerName: string, alive: (pid: number) => boolean = helperAlive): RunLook {
  const files = runFiles(slugDir, workerName);
  if (existsSync(files.resultFile)) {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(files.resultFile, "utf8")); } catch (error: unknown) {
      return { kind: "corrupt", why: `${files.resultFile} is not JSON: ${String(error)}` };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>).verdict !== "string") {
      return { kind: "corrupt", why: `${files.resultFile} carries no verdict` };
    }
    return { kind: "result", result: parsed as Record<string, unknown> };
  }
  if (!existsSync(files.pidFile)) return { kind: "absent", why: `no result and no pid file for ${workerName} under ${slugDir}` };
  let wrapperPid: unknown;
  try { wrapperPid = (JSON.parse(readFileSync(files.pidFile, "utf8")) as { wrapperPid?: unknown }).wrapperPid; } catch (error: unknown) {
    return { kind: "absent", why: `${files.pidFile} is unreadable: ${String(error)}` };
  }
  if (typeof wrapperPid !== "number" || !Number.isInteger(wrapperPid) || wrapperPid <= 0) return { kind: "absent", why: `${files.pidFile} names no helper pid` };
  return alive(wrapperPid) ? { kind: "alive", pid: wrapperPid } : { kind: "absent", why: `helper pid ${wrapperPid} is gone and left no result` };
}

/** The report for a finished run, from the helper's own result line. Pure. */
export function reportFromResult(result: Record<string, unknown>, base: Pick<WaitReport, "worker" | "slug" | "waited_seconds">): WaitReport {
  const verdict = String(result.verdict);
  const state: WaitState = verdict === "success" ? "done" : verdict === "timeout" ? "timeout" : "error";
  const text = (k: string) => (typeof result[k] === "string" ? (result[k] as string) : undefined);
  const report: WaitReport = { state, ...base, verdict };
  for (const [key, value] of [["final_message", text("final_message")], ["co_authored_by", text("co_authored_by")], ["final_file", text("final_file")], ["events_file", text("events_file")], ["reason", text("reason")]] as const) {
    if (value !== undefined) report[key] = value;
  }
  if (state !== "done" && !report.reason) report.reason = `the helper's verdict was ${verdict}`;
  return report;
}

export type WaitOptions = {
  slugDir: string; worker: string; slug: string; maxSeconds: number;
  /** Delay between looks. */
  pollMs?: number;
  /** How long nothing may be alive with no result before the run is called dead: covers the helper's own startup and its last second of bookkeeping. */
  graceMs?: number;
  /** Pause before the first look, so a helper started a moment ago has removed the previous run's result. */
  settleMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  alive?: (pid: number) => boolean;
};

/** Blocks until the run is over or `maxSeconds` pass. Reads only; bounded by maxSeconds. */
export async function waitForRun(o: WaitOptions): Promise<WaitReport> {
  const now = o.now ?? Date.now, sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const pollMs = o.pollMs ?? 2000, graceMs = o.graceMs ?? 60_000, budgetMs = o.maxSeconds * 1000;
  const start = now();
  const base = () => ({ worker: o.worker, slug: o.slug, waited_seconds: Math.round((now() - start) / 1000) });
  await sleep(o.settleMs ?? 1500);
  let absentSince: number | null = null;
  for (;;) {
    const look = inspectRun(o.slugDir, o.worker, o.alive);
    if (look.kind === "result") return reportFromResult(look.result, base());
    if (look.kind === "corrupt") return { state: "error", ...base(), reason: look.why };
    if (look.kind === "alive") absentSince = null;
    else {
      absentSince ??= now();
      if (now() - absentSince >= graceMs) {
        return { state: "error", ...base(), reason: `${look.why}. The helper never started on this slug, refused the brief, or died without finishing; its own output (the background Bash result) says which.` };
      }
    }
    const left = budgetMs - (now() - start);
    if (left <= 0) return { state: "running", ...base(), reason: "still running; call the same wait again" };
    await sleep(Math.min(pollMs, left));
  }
}

/** Exit code for a wait report: 0 done, 3 still running, 1 error or codex timeout. */
export function waitExitCode(state: WaitState): number {
  return state === "done" ? 0 : state === "running" ? 3 : 1;
}

if (import.meta.main && process.argv[2] === "wait") {
  let report: WaitReport;
  try {
    const { worker, slug, maxSeconds } = parseWaitArgs(process.argv.slice(3));
    report = await waitForRun({ slugDir: slugDirFor(slug), worker: worker.name, slug, maxSeconds });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`Worker.ts: ${reason}`);
    process.stdout.write(`${JSON.stringify({ state: "error", reason })}\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(waitExitCode(report.state));
} else if (import.meta.main) {
  try {
    const parsed = parseWorkerArgs(process.argv.slice(2));
    const { worker, slug, parentRun } = parsed;
    const task = await Bun.stdin.text();
    if (!task.trim()) throw new Error("the task arrives on stdin (quoted heredoc); it was empty");
    // A leg below Astra is execution, so the thinking has to arrive with it. The helper runs the same
    // gate, so this refusal is only the earlier, friendlier one.
    const refusal = checkBrief(worker.lane, worker.name, slug, task, parsed.mode === "audit");
    if (refusal) throw new Error(refusal);
    applyParentRun(parentRun); // the codex child inherits LIFEOS_PARENT_RUN_ID, so a run it logs names this one as its parent
    process.exit(await main(helperArgs(parsed, task)));
  } catch (e) {
    console.error(`Worker.ts: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
