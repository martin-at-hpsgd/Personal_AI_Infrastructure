#!/usr/bin/env bun

/**
 * @version 1.9.0
 * CodexProgress.ts — supervised `codex exec` wrapper with live progress to Pulse.
 * (Named ForgeProgress.ts until 2026-09-10, when the Forge agent folded into Astra; the
 * `forge.model.*` event types and the `forge-*` artifact prefix an older run wrote stay as
 * written so CodexObserved keeps reading them.)
 *
 * Runs a cross-vendor codex carrier as a child process and turns its JSON
 * event stream into three durable artifacts under the run's slug directory,
 * prefixed by the agent name (lower-cased) so two agents on one slug never
 * clobber each other (`astra-*` for Astra, `sol-*` for Sol, …):
 *   <agent>-events.jsonl   every emitted event (plus any non-JSON stdout noise)
 *   <agent>-final.txt      the model's final message (codex writes this via -o)
 *   <agent>-codex.pid      the live child pid, used for orphan reaping
 *
 * 1.5.0 (2026-09-09): one helper for every codex-backed agent. `--lane <key>`
 * resolves the model from CROSS_VENDOR by key (advisor, max, sol,
 * forge…), `--agent <Name>` labels Pulse and the artifact files, and
 * `--codex-home isolated` runs codex in a scratch home carrying only auth.json —
 * without it the child loads the 32KB LifeOS-for-Codex mount (~/.codex/AGENTS.md)
 * and answers as the DA. Default reasoning effort is `medium`
 * (since 2026-10-04; low before that).
 *
 * WHY A WRAPPER: `codex exec` is long-running and detached-capable. Without a
 * supervisor, a hard-killed parent leaves an orphaned codex group still writing
 * to the workspace with nothing able to kill, commit, or report it. This file
 * owns that lifecycle — PID-reuse-guarded group kill, parent-death detection,
 * timeout enforcement, and a final verdict (success | error | timeout).
 *
 * The model ID is NOT a literal here: it defaults from `CROSS_VENDOR.astra` in
 * models.ts, the canonical registry. Restating it caused four-place drift on
 * every OpenAI bump (2026-07-27 audit). `--model` still overrides explicitly.
 *
 * 1.7.0 (2026-10-04): `--cwd <absolute dir>` names the directory the child runs in and may write to, so it is
 * never inherited by accident. A Sol wrapper in one project's ISAClimb wave skipped its `cd` and its codex
 * child ran workspace-write in the LifeOS install instead of the lane worktree. Without `--cwd` the helper still
 * uses its own working directory, but refuses a workspace-write run there when that directory is the LifeOS
 * install; the refusal is a `{"verdict":"refused"}` result line, the same contract `Worker.ts wait` reads.
 *
 * 1.8.0 (2026-10-04): a workspace-write run whose cwd is a git worktree also gets the worktree git dir and the common
 * objects/, refs/ and logs/ as write roots, so a lane can commit on its lane branch (worktreeGitDirs). Never the
 * common dir itself, never the LifeOS install or its USER data repo.
 *
 * 1.9.0 (2026-10-14): the slug dir is confined (a real directory directly
 * inside the real WORK root, never a symlink) before anything is written or unlinked through it; the result, pid and
 * events files are written without following a symlink at their names; a symlinked final or pid file is never read.
 * Every result line carries `session_id` and `agent_id` (runBinding) so WorkerRanGuard binds a handback to its launch.
 *
 * Usage:
 *   bun ~/.claude/LIFEOS/TOOLS/CodexProgress.ts --slug <run-slug> [--cwd <absolute task dir>] [--prompt <text>]
 *     [--lane <CROSS_VENDOR key> | --model <id>] [--agent Astra] [--reasoning-effort medium]
 *     [--sandbox workspace-write] [--codex-home mounted|isolated]
 *     [--timeout-ms 300000] [--pulse-url http://127.0.0.1:31337/notify]
 *
 * `--slug` is required and charset-restricted (letters, numbers, dot,
 * underscore, hyphen) because it becomes a directory name. Prompt is read from
 * stdin when `--prompt` is omitted.
 */

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { accessSync, constants, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, type WriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { CROSS_VENDOR } from "./models";
import { observeRun, appendRun, summarize, type CodexRun } from "./CodexObserved";
import { PULSE_BASE } from "../PULSE/endpoint";
import { homedir } from "node:os";
import { codexHomesRoot } from "./lib/CacheDir";
import { getClaudeDir, lifeosPath } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { checkBrief } from "./BriefGate";
import { reportHerdrWorker } from "../../hooks/lib/herdr-tabs";
import { agentLaneTag, laneLabel } from "../../hooks/lib/route-label";
import { invariant, InvariantViolation } from "./Invariant";
import { recordModelUse } from "./lib/ModelUse";
import { appendFileNoFollow, isRegularFile, openAppendNoFollow, UnsafeDestinationError, writeFileNoFollow } from "./lib/NoFollowWrite";

type CodexHome = "mounted" | "isolated";
type Args = { slug: string; cwd?: string; prompt?: string; model: string; lane?: string; effort: string; sandbox: string; timeoutMs: number; pulseUrl: string; agent: string; codexHome: CodexHome };
type JsonRecord = Record<string, unknown>;
type RingEntry = { raw: JsonRecord; type: string };
type RunState = { startMs: number; childAlive: boolean; timedOut: boolean; interrupted: boolean };
type ExitInfo = { code: number | null; signal: NodeJS.Signals | null; error?: Error };
type TimeoutControl = { clearNaturalExit: () => void; clearAll: () => void };
type SignalControl = { clear: () => void };
type Paths = { eventsFile: string; finalFile: string; pidFile: string; resultFile: string };
type FinalInput = { verdict: "success" | "error" | "timeout"; exitCode: number | null; eventsFile: string; finalFile: string; durationMs: number; finalMessage: string; model: string; observed?: string | null };

/**
 * The files one agent's run writes under its slug directory. `<agent>-result.json` is the helper's final JSON
 * line, written last and atomically, and removed when the next run on the slug starts, so its presence means
 * "this run is over": `Worker.ts wait` blocks on it (a wrapper inside a Workflow is never
 * re-invoked by a background completion, so it has to wait in the foreground for something it can trust).
 */
export function runFiles(slugDir: string, agent: string): Paths {
  const prefix = agent.toLowerCase(); // each agent gets its own set (astra-*, sol-*, …); a pre-2026-09-10 run's forge-* files stay readable
  return { eventsFile: join(slugDir, `${prefix}-events.jsonl`), finalFile: join(slugDir, `${prefix}-final.txt`), pidFile: join(slugDir, `${prefix}-codex.pid`), resultFile: join(slugDir, `${prefix}-result.json`) };
}

/** The run's slug directory under MEMORY/WORK. The slug is charset-checked by parseArgs before it gets here. */
export function slugDirFor(slug: string): string { return lifeosPath("MEMORY", "WORK", slug); }

/**
 * The slug directory, created if absent and proven to be a real directory directly inside the real WORK root
 *. A slug entry that is a symlink, or anything that resolves elsewhere, is
 * refused before any artifact is written or deleted through it: the codex child may write anywhere under WORK, so
 * it could plant `<slug> -> ~/somewhere` for the next run to write and unlink through. Returns the real path.
 */
export function confinedSlugDir(slug: string, workRoot: string = lifeosPath("MEMORY", "WORK")): string {
  invariant(/^[A-Za-z0-9._-]+$/.test(slug) && slug !== "." && slug !== "..", `slug must be charset-checked before it names a directory, got ${slug}`);
  mkdirSync(workRoot, { recursive: true });
  const realRoot = realpathSync(workRoot);
  const dir = join(realRoot, slug);
  try { mkdirSync(dir); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const entry = lstatSync(dir);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new UnsafeDestinationError(`slug directory ${dir} is not a real directory (symlink or other entry refused)`);
  if (realpathSync(dir) !== dir) throw new UnsafeDestinationError(`slug directory ${dir} resolves outside ${realRoot}`);
  return dir;
}

/**
 * Writes the helper's final JSON line as the run's result file: an exclusive no-follow temp file then a rename, so
 * a reader never sees half of it and a symlink planted at the result name is refused, never written through.
 */
export function writeResult(resultFile: string, line: string): void {
  invariant(basename(resultFile).endsWith("-result.json"), `result file must be <agent>-result.json, got ${resultFile}`);
  const parsed = JSON.parse(line) as JsonRecord;
  invariant(typeof parsed.verdict === "string" && parsed.verdict.length > 0, "a run result must carry a verdict");
  mkdirSync(dirname(resultFile), { recursive: true });
  writeFileNoFollow(resultFile, `${line}\n`);
}

/**
 * Removes a file the previous run on this slug left, so nothing reads it as this run's: the result a waiter
 * blocks on, and the final message, which codex writes only on a clean exit (an errored run otherwise reported
 * the last run's message as its own). Absent is fine. unlink removes a symlink itself, never its target, and the
 * directory it runs in has already been confined by confinedSlugDir.
 */
function clearStale(file: string): void {
  try { unlinkSync(file); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Who started this run, stamped into every result line so WorkerRanGuard can bind a handback to its own launch. */
export type RunBinding = { session_id: string | null; agent_id: string | null };

/** The WorkerRanGuard launch-marker directory (same default and override as the hook). */
export function workerRanDir(): string { return process.env.LIFEOS_WORKER_RAN_DIR ?? lifeosPath("MEMORY", "STATE", "worker-ran"); }

/** How far back a launch marker may sit before this run started and still be this run's launch. */
const LAUNCH_WINDOW_MS = 10 * 60_000;

/**
 * The session and agent that launched this run. The session comes from the harness
 * environment (CLAUDE_CODE_SESSION_ID, the same id hook input carries for a subagent). The harness exports no
 * agent id to a Bash child, so the agent is read from WorkerRanGuard's launch marker: the newest regular-file
 * marker for this session, slug and agent prefix written in the window before this run started. A marker is
 * named `<agent id>.json` and written by the hook at PreToolUse, before the command that started this run.
 * A main-session run (no wrapper, no marker) gets a null agent id. Reads only.
 */
export function runBinding(slug: string, agent: string, startMs: number, env: NodeJS.ProcessEnv = process.env, stateDir: string = workerRanDir()): RunBinding {
  const raw = (env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || "").trim();
  const session = /^[A-Za-z0-9_-]{1,128}$/.test(raw) ? raw : null;
  if (!session) return { session_id: null, agent_id: null };
  const prefix = agent.toLowerCase();
  let best: { id: string; ts: number } | null = null;
  let names: string[] = [];
  try { names = readdirSync(stateDir); } catch { return { session_id: session, agent_id: null }; }
  for (const name of names) {
    const m = /^([A-Za-z0-9_-]+)\.json$/.exec(name);
    if (!m) continue;
    const file = join(stateDir, name);
    try {
      const st = lstatSync(file);
      if (!st.isFile() || st.mtimeMs < startMs - LAUNCH_WINDOW_MS) continue; // cheap skip: old launches are never this run's
      const marker = JSON.parse(readFileSync(file, "utf8")) as { ts?: unknown; slug?: unknown; agent?: unknown; session_id?: unknown };
      if (marker.session_id !== session || marker.slug !== slug || marker.agent !== prefix || typeof marker.ts !== "number") continue;
      if (marker.ts > startMs || marker.ts < startMs - LAUNCH_WINDOW_MS) continue;
      if (!best || marker.ts > best.ts) best = { id: m[1]!, ts: marker.ts };
    } catch { continue; } // a torn or unreadable marker is not evidence of anything
  }
  return { session_id: session, agent_id: best?.id ?? null };
}

/** Adds the run binding to a result line, never overwriting a field the line already carries. */
export function stampBinding(line: string, binding: RunBinding | null): string {
  if (!binding) return line;
  const parsed = JSON.parse(line) as JsonRecord;
  return JSON.stringify({ ...parsed, session_id: parsed.session_id ?? binding.session_id, agent_id: parsed.agent_id ?? binding.agent_id });
}

/** Prints the final line and records it as the run's result. A result-file failure is reported, never allowed to hide the line. */
function finish(line: string, resultFile: string | null, binding: RunBinding | null = null): void {
  const stamped = stampBinding(line, binding);
  process.stdout.write(`${stamped}\n`);
  if (!resultFile) return;
  try { writeResult(resultFile, stamped); } catch (error: unknown) { if (error instanceof InvariantViolation) throw error; console.error(`CodexProgress: failed to write the result file: ${String(error)}`); }
}

/** The commit trailer that attributes a codex-built diff to the model that built it. Read by the Velocity collector; the DA carries it into any commit that lands this work. */
export const coAuthorTrailer = (model: string) => `Co-Authored-By: ${model} <noreply@openai.com>`;

/** One `codex-runs.jsonl` record. Router R67: it carries the effort the child started with, so the drawn rows show that, not the model's rank. Pure. */
export function runRecord(r: { startMs: number; agent: string; slug: string; threadId: string | null; model: string; effort: string; observed: string | null; verdict: string; durationMs: number; dispatchId?: string; summary?: string }): CodexRun {
  return { ts: new Date(r.startMs).toISOString(), agent: r.agent, slug: r.slug, thread_id: r.threadId, requested: r.model, observed: r.observed, verdict: r.verdict, duration_ms: r.durationMs, effort: r.effort, ...(r.dispatchId ? { dispatch_id: r.dispatchId } : {}), ...(r.summary ? { summary: r.summary } : {}) };
}
const RING_SIZE = 5;
const PULSE_TIMEOUT_MS = 2000;
const ESCALATE_MS = 5000;
function parseArgs(argv: string[]): Args {
  // Model defaults from the canonical registry, never a literal here (2026-07-27
  // audit: the ID was restated in prose across two agent files and this default,
  // so an OpenAI bump meant four edits and guaranteed drift). Callers may still
  // pass --model explicitly; omitting it is now the correct, rot-free path.
  const args: Partial<Args> = { model: CROSS_VENDOR.astra, effort: "medium", sandbox: "workspace-write", timeoutMs: 300000, pulseUrl: `${PULSE_BASE}/notify`, agent: "Astra", codexHome: "mounted" };
  const seen = new Set<string>();
  const valueFor = (flag: string, inline: string | undefined, index: number): [string, number] => {
    if (inline !== undefined) return [inline, index];
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return [value, index + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new Error(`unexpected positional argument: ${token}`);
    const eq = token.indexOf("="), flag = eq === -1 ? token : token.slice(0, eq), inline = eq === -1 ? undefined : token.slice(eq + 1);
    if (seen.has(flag)) throw new Error(`duplicate flag: ${flag}`);
    seen.add(flag);
    const [value, next] = valueFor(flag, inline, i); i = next;
    switch (flag) {
      case "--slug": args.slug = nonEmpty(flag, value); break;
      case "--prompt": args.prompt = nonEmpty(flag, value); break;
      case "--cwd": args.cwd = nonEmpty(flag, value); break;
      case "--model": args.model = nonEmpty(flag, value); break;
      case "--lane": { const key = nonEmpty(flag, value); args.lane = key; args.model = laneModel(key); break; }
      case "--agent": args.agent = agentName(nonEmpty(flag, value)); break;
      case "--codex-home": args.codexHome = codexHomeMode(nonEmpty(flag, value)); break;
      case "--reasoning-effort": args.effort = nonEmpty(flag, value); break;
      case "--sandbox": args.sandbox = nonEmpty(flag, value); break;
      case "--timeout-ms": args.timeoutMs = positiveInt(flag, value); break;
      case "--pulse-url": args.pulseUrl = validUrl(flag, value); break;
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (!args.slug) throw new Error("--slug is required");
  if (!/^[A-Za-z0-9._-]+$/.test(args.slug) || args.slug === "." || args.slug === "..") throw new Error("--slug must contain only letters, numbers, dot, underscore, or hyphen");
  if (seen.has("--lane") && seen.has("--model")) throw new Error("--lane and --model are mutually exclusive");
  return args as Args;
}
function nonEmpty(flag: string, value: string): string { if (value.length === 0) throw new Error(`${flag} must not be empty`); return value; }
/** Resolve a CROSS_VENDOR key to its pinned model — the rot-free path; agent files name lanes, never IDs. */
function laneModel(lane: string): string {
  const id = CROSS_VENDOR[lane];
  if (!id) throw new Error(`--lane '${lane}' is not a CROSS_VENDOR key (have: ${Object.keys(CROSS_VENDOR).join(", ")})`);
  return id;
}
/** Agent label: becomes the Pulse `agent` field and the artifact file prefix, so it must be a safe path fragment. */
function agentName(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(name)) throw new Error("--agent must be a short alphanumeric name");
  return name;
}
function codexHomeMode(value: string): CodexHome {
  if (value === "mounted" || value === "isolated") return value;
  throw new Error("--codex-home must be 'mounted' or 'isolated'");
}
function positiveInt(flag: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive safe integer`);
  return parsed;
}
function validUrl(flag: string, value: string): string {
  try { return new URL(nonEmpty(flag, value)).toString(); }
  catch (error: unknown) { throw new Error(`${flag} must be a valid URL: ${String(error)}`); }
}
function isSymlink(path: string): boolean { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } }
function homeDir(): string { const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir(); if (!home) throw new Error("HOME is not set"); return home; }
function preflightCodex(home: string): string | null {
  const codexPath = join(home, ".bun", "bin", "codex");
  try { accessSync(codexPath, constants.X_OK); return codexPath; }
  catch (_error: unknown) { return null; } // Safe: caller emits the exact unavailable JSON.
}
// Isolated codex home (mirrors CrossVendorAudit.ts): a scratch CODEX_HOME carrying only the
// auth symlink, so the child never loads ~/.codex/AGENTS.md (the LifeOS-for-Codex mount, which
// makes codex answer as the DA), its hooks, or its skills tree. Per-agent dir so parallel runs
// don't race the rm/mkdir. Under the 0700 cache root, never tmpdir(): the home holds the full
// session rollouts, and on Linux tmpdir() is the shared /tmp (round-22 audit).
// The home is rebuilt per run EXCEPT `sessions/` (2026-09-17, Router ISA R13): the rollout logs
// are the only token ground truth for the worker lanes — ModelMix, RouteAudit and CodexUsage read
// them through CodexUsage.rolloutRoots() — and wiping them every spawn is why the worker lanes never
// showed a percentage. Everything else (config, skills, hooks) is still cleared so the child never
// inherits a stale mount.
async function buildIsolatedCodexHome(home: string, agent: string): Promise<string> {
  const dir = join(codexHomesRoot(), agent.toLowerCase());
  await mkdir(dir, { recursive: true });
  for (const entry of await readdir(dir)) {
    if (entry === "sessions") continue;
    await rm(join(dir, entry), { recursive: true, force: true });
  }
  const realAuth = join(home, ".codex", "auth.json");
  if (existsSync(realAuth)) await symlink(realAuth, join(dir, "auth.json")); // absent = API-key auth via env; nothing to link
  return dir;
}
// ADDITIVE (2026-08-15): stamp the model this run was INVOKED with into the
// event stream as the first line, so a reader (a downstream attestation check,
// an auditor) can see which model codex was given from the durable events file
// alone. NOTE: this is the model PASSED to `codex exec --model`, not a value
// read back from codex — codex's event stream carries no model field — so it
// attests the invocation, not codex's internal execution. This changes nothing
// about the default model or verdict.
function stampResolvedModel(eventsFile: string, model: string, agent: string): void {
  try { // `forge.model.*` is the event-type contract CodexObserved and older artifacts share; the name predates the rename.
  appendFileNoFollow(eventsFile, `${JSON.stringify({ type: "forge.model.resolved", model, agent, ts: new Date().toISOString() })}\n`); }
  catch (error: unknown) { console.error(`CodexProgress: failed to stamp resolved model: ${String(error)}`); }
}
// Orphan-writer prevention (public PR #1520, @runnerr0): ppid watchdog + per-slug pid reaper.
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (_error: unknown) { return false; } }
function pidLooksLikeCodex(pid: number): boolean {
  // Guard against PID reuse: only group-kill a recorded pid if it is still a codex
  // process. A recycled PID belonging to an unrelated process must never be signaled.
  try { return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).toLowerCase().includes("codex"); }
  catch (_error: unknown) { return false; }
}
function reapStaleCodex(pidFile: string): void {
  // WHY: a hard-killed wrapper (SIGKILL / group teardown) cannot signal its detached codex child, leaving an
  // orphan writer loose in the workspace. Each new run reaps its slug's stale group first.
  if (!existsSync(pidFile) && !isSymlink(pidFile)) return;
  // A symlink or other entry at the pid name is never read: its numbers would choose what this run signals.
  if (!isRegularFile(pidFile)) { console.error(`CodexProgress: pid file ${pidFile} is not a regular file; removing it unread`); clearStale(pidFile); return; }
  try {
    const parsed = JSON.parse(readFileSync(pidFile, "utf8")) as { wrapperPid?: unknown; childPid?: unknown };
    const wrapperPid = typeof parsed.wrapperPid === "number" ? parsed.wrapperPid : null;
    const childPid = typeof parsed.childPid === "number" ? parsed.childPid : null;
    if (wrapperPid !== null && pidAlive(wrapperPid)) { console.error(`CodexProgress: another wrapper (pid ${wrapperPid}) is still alive on this slug; not reaping`); return; }
    if (childPid !== null && pidAlive(childPid) && pidLooksLikeCodex(childPid)) {
      console.error(`CodexProgress: reaping orphaned codex group ${childPid} left by dead wrapper ${wrapperPid ?? "unknown"}`);
      try { process.kill(-childPid, "SIGTERM"); } catch (_error: unknown) { /* group already gone */ }
      setTimeout(() => { if (pidAlive(childPid) && pidLooksLikeCodex(childPid)) { try { process.kill(-childPid, "SIGKILL"); } catch (_error: unknown) { /* gone */ } } }, ESCALATE_MS);
    }
  } catch (error: unknown) { console.error(`CodexProgress: stale pid file unreadable, removing: ${String(error)}`); }
  try { unlinkSync(pidFile); } catch (_error: unknown) { /* already gone */ }
}
function writePidFile(pidFile: string, childPid: number | undefined): void {
  if (childPid === undefined) return;
  try { writeFileNoFollow(pidFile, JSON.stringify({ wrapperPid: process.pid, childPid }), { mode: 0o600 }); }
  catch (error: unknown) { console.error(`CodexProgress: failed to write pid file: ${String(error)}`); }
}
function startOrphanWatchdog(child: ChildProcessWithoutNullStreams, state: RunState, cleanupPoller: () => void): () => void {
  // WHY: if the spawning agent/shell dies, this wrapper reparents to launchd (ppid 1). Without this check the
  // detached codex group keeps writing to the workspace with no supervisor able to kill, commit, or report it.
  let cleaned = false;
  const timer = setInterval(() => {
    if (process.ppid !== 1) return;
    cleaned = true; clearInterval(timer); cleanupPoller();
    console.error("CodexProgress: parent process died; terminating codex group to prevent an orphan writer");
    sendChildSignal(child, "SIGTERM", "orphan watchdog");
    setTimeout(() => { if (state.childAlive) sendChildSignal(child, "SIGKILL", "orphan watchdog escalation"); }, ESCALATE_MS);
    setTimeout(() => process.exit(1), ESCALATE_MS * 2);
  }, 2000);
  return () => { if (cleaned) return; cleaned = true; clearInterval(timer); };
}
async function readPrompt(prompt: string | undefined): Promise<string> {
  if (prompt !== undefined) return prompt;
  const stdin = process.stdin as typeof process.stdin & { isTTY?: boolean };
  if (stdin.isTTY) return "";
  // Bun.stdin, not the process.stdin stream: with `node:process` imported as a default, iterating
  // the stream under a heredoc (`bun CodexProgress.ts … <<'EOF'`) yielded zero bytes while a pipe
  // worked (verified on Bun 1.3.6) — every heredoc brief died as "no prompt provided", and
  // the heredoc-after-helper shape is the one the WorkerWrapperGuard accepts. Unbounded by design:
  // this CLI consumes a prompt, and the OS/process bounds the input.
  return await Bun.stdin.text();
}
/**
 * Run folders (ISAs, worker outputs) live under LIFEOS/MEMORY/WORK, which is a symlink into the
 * USER data repo, outside the workspace-write root. Without this a worker that finished its task
 * could not save it: a worker analysis could run for minutes and lose its draft. Only WORK is
 * added, never the rest of USER data. A cwd inside a git worktree also gets the git dirs a commit writes
 * (worktreeGitDirs below). Reads the filesystem and runs `git rev-parse`; writes nothing.
 */
export function extraWritableDirs(cwd: string, sandbox: string, lifeosDir = lifeosPath()): string[] {
  if (sandbox !== "workspace-write") return [];
  const dirs = [...workMemoryDirs(cwd, lifeosDir), ...worktreeGitDirs(cwd, lifeosDir)];
  return [...new Set(dirs)];
}
function workMemoryDirs(cwd: string, lifeosDir: string): string[] {
  try {
    // Trusted root: the install's own LifeOS dir, never a path found under the cwd. A cwd that plants its
    // own LIFEOS/MEMORY/WORK symlink gains nothing (Astra audit 2026-09-19, finding 10).
    const root = realpathSync(join(lifeosDir, ".."));
    const here = realpathSync(cwd);
    if (here !== root && !here.startsWith(root + "/")) return [];
    const real = realpathSync(join(lifeosDir, "MEMORY", "WORK"));
    if (real === root || real.startsWith(root + "/")) return []; // already inside the workspace
    if (!/\/MEMORY\/WORK$/.test(real)) return [];               // the target must still be a WORK dir
    return [real];
  } catch { return []; }
}

/** Git env vars that would make the probe report some other repo than the one at the cwd. */
const GIT_LOCATION_ENV = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CEILING_DIRECTORIES"];
const GIT_PROBE_TIMEOUT_MS = 5000;
function insideOrEqual(path: string, root: string): boolean { return path === root || path.startsWith(root + "/"); }
/** True when `dir` touches a protected root: equals it, sits inside it, or contains it. */
function touchesProtected(dir: string, protectedRoots: string[]): boolean {
  return protectedRoots.some(root => insideOrEqual(dir, root) || insideOrEqual(root, dir));
}
function realOrNull(path: string): string | null { try { return realpathSync(path); } catch { return null; } }

/**
 * A lane that runs in a git worktree (`<repo>/.devrun-worktrees/.../F17`, whose `.git` is a FILE pointing at
 * `<repo>/.git/worktrees/F17`) must commit on its lane branch, and every path a commit writes sits outside the
 * cwd: the index and its lock and HEAD's reflog in the per-worktree git dir, the new objects in the common
 * `objects/`, the branch tip in `refs/heads/`, and its reflog in `logs/`. Without these the sandbox denied
 * `index.lock` and every codex-built lane lost its commits. Measured under a
 * seatbelt profile holding writes to the worktree plus these four dirs: commit and `git switch -c` succeed.
 *
 * Deliberately NOT granted: the common dir itself. It holds `config` and `hooks/`, and a hook planted there runs
 * unsandboxed the next time anyone commits in that repo. The cost is one non-fatal stderr line from git, which
 * tries `packed-refs.lock` after a ref update; the commit still lands (measured, git 2.54).
 *
 * A plain repo (its `.git` already under the cwd) and a repo with a separate git dir are not worktrees and get
 * nothing, as before. The grant is refused outright when the repo is the LifeOS install or its USER data repo,
 * when the worktree's own back-pointer does not name the cwd's worktree (a planted `.git` file aimed at some other
 * repo's worktree), or when any target resolves through a symlink to outside the repo's git dirs.
 * Reads the filesystem and runs `git rev-parse` only.
 */
export function worktreeGitDirs(cwd: string, lifeosDir: string): string[] {
  const protectedRoots = [realOrNull(join(lifeosDir, "..")), realOrNull(join(lifeosDir, "USER"))].filter((p): p is string => p !== null);
  const granted = probeWorktreeGitDirs(cwd, protectedRoots);
  // The list becomes sandbox write roots, so a protected or unresolved path in it is an impossible state, never an input error.
  for (const dir of granted) {
    invariant(isAbsolute(dir) && realpathSync(dir) === dir && statSync(dir).isDirectory(), `worktree write root must be a resolved directory, got ${dir}`);
    invariant(!touchesProtected(dir, protectedRoots), `worktree write root ${dir} touches a protected LifeOS root`);
  }
  return granted;
}
function probeWorktreeGitDirs(cwd: string, protectedRoots: string[]): string[] {
  let here: string;
  try { here = realpathSync(cwd); } catch { return []; }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_LOCATION_ENV) delete env[key];
  let out: string;
  try {
    out = execFileSync("git", ["-C", here, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"], {
      encoding: "utf8", env, timeout: GIT_PROBE_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch { return []; } // not a repo, bare, unsafe owner, or git missing: no grant, same as before this existed
  const lines = out.split("\n").filter(line => line.length > 0);
  if (lines.length !== 3 || !lines.every(line => isAbsolute(line))) return [];
  const [top, gitDir, common] = lines.map(realOrNull);
  if (top === null || gitDir === null || common === null) return [];
  if (gitDir === common) return []; // a plain repo or a separate git dir, not a worktree
  if (dirname(gitDir) !== join(common, "worktrees")) return []; // worktree git dirs always live at <common>/worktrees/<name>
  // Back-pointer: git records the worktree's `.git` file path in <gitDir>/gitdir. It must be this worktree's.
  let backPointer: string;
  try { backPointer = readFileSync(join(gitDir, "gitdir"), "utf8").trim(); } catch { return []; }
  const backTop = isAbsolute(backPointer) ? realOrNull(dirname(backPointer)) : null;
  if (backTop !== top) return [];
  if (touchesProtected(common, protectedRoots)) return [];
  const granted: string[] = [gitDir];
  // objects/ and refs/ exist in every valid common dir; logs/ is absent when reflogs are off (a bare common dir), and git then writes none.
  for (const [name, required] of [["objects", true], ["refs", true], ["logs", false]] as const) {
    const real = realOrNull(join(common, name));
    if (real === null) { if (required) return []; continue; }
    if (!real.startsWith(common + "/")) return []; // a subdir symlinked out of the repo: refuse the whole grant
    if (!statSync(real).isDirectory()) return [];
    granted.push(real);
  }
  if (granted.some(dir => touchesProtected(dir, protectedRoots))) return [];
  return granted;
}
export type WorkDir = { ok: true; dir: string } | { ok: false; reason: string };

/**
 * The directory the codex child runs in (`codex --cd`), which under workspace-write is the one place it may write.
 * An explicit `--cwd` must be an absolute path to an existing directory and is used as its realpath; a relative
 * one would resolve against the inherited working directory, the accident this flag exists to end. Without it the
 * helper's own working directory is used, except that a workspace-write run whose directory is the LifeOS install
 * is refused: that is what a forgotten `cd` looks like so writing there
 * takes `--cwd` naming it. Reads the filesystem only.
 */
export function resolveWorkDir(explicit: string | undefined, sandbox: string, installDir: string = getClaudeDir(), here: string = process.cwd()): WorkDir {
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) return { ok: false, reason: `--cwd must be an absolute path, got '${explicit}'` };
    let dir: string;
    try { dir = realpathSync(explicit); } catch (error: unknown) {
      return { ok: false, reason: `--cwd '${explicit}' does not exist or cannot be resolved (${(error as NodeJS.ErrnoException).code ?? String(error)})` };
    }
    if (!statSync(dir).isDirectory()) return { ok: false, reason: `--cwd '${explicit}' is not a directory` };
    return { ok: true, dir };
  }
  const dir = realpathSync(here);
  if (sandbox === "workspace-write" && dir === realOrResolved(installDir)) {
    return { ok: false, reason: `refusing a workspace-write run in the LifeOS install (${dir}) inherited from the shell's working directory; pass --cwd with the task's directory, or --cwd '${dir}' when the task really is in the install` };
  }
  return { ok: true, dir };
}
function realOrResolved(path: string): string { try { return realpathSync(path); } catch { return resolve(path); } }

/** The `codex exec` argv for one run in `workDir`, which must already be resolved by resolveWorkDir. */
export function codexArgv(codexPath: string, args: Pick<Args, "model" | "effort" | "sandbox">, finalFile: string, workDir: string): string[] {
  // The child's write root comes from here and nowhere else, so an unresolved path is an impossible state, not an input error.
  invariant(isAbsolute(workDir) && realpathSync(workDir) === workDir && statSync(workDir).isDirectory(), `codex work dir must be a resolved absolute directory, got ${workDir}`);
  const argv = [codexPath, "exec", "--model", args.model, "-c", `model_reasoning_effort=${args.effort}`, "--sandbox", args.sandbox, "--skip-git-repo-check", "--cd", workDir, "--json", "-o", finalFile];
  for (const dir of extraWritableDirs(workDir, args.sandbox)) argv.push("--add-dir", dir);
  argv.push("-");
  return argv;
}
function spawnCodex(codexPath: string, args: Args, finalFile: string, prompt: string, codexHome: string | null, workDir: string): ChildProcessWithoutNullStreams {
  const argv = codexArgv(codexPath, args, finalFile, workDir);
  const env = { ...process.env };
  if (codexHome) {
    env.CODEX_HOME = codexHome;
    // No `--ephemeral` (ISC-53, 2026-09-09): the scratch home keeps codex's session log so the
    // model this run actually ran on can be read back by thread id after exit (CodexObserved.ts).
    // The dir is wiped by the next run of the same agent, so nothing accumulates.
    if (existsSync(join(codexHome, "auth.json"))) { delete env.OPENAI_API_KEY; delete env.OPENAI_BASE_URL; } // subscription auth wins over a stray key
  }
  const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], detached: true, env });
  child.stdin.end(prompt);
  return child;
}
async function writeLine(stream: WriteStream, line: string): Promise<void> {
  if (stream.write(line)) return; // Local log I/O is unbounded because it is the durable audit trail.
  await new Promise<void>((resolve, reject) => { stream.once("drain", resolve); stream.once("error", reject); });
}
async function endStream(stream: WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => { stream.once("error", reject); stream.end(resolve); });
}
async function wireStdout(child: ChildProcessWithoutNullStreams, eventsFile: string, ring: RingEntry[], args: Args): Promise<void> {
  // Opened O_APPEND | O_NOFOLLOW: a symlink planted at the events name fails the open instead of taking the log.
  const writer = createWriteStream("", { fd: openAppendNoFollow(eventsFile), flags: "a" });
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let warnedNoise = false, sentOpening = false;
  try {
    // Bounded by child stdout closing through normal exit, timeout, or helper signal handling.
    for await (const rawLine of rl) {
      const line = rawLine.trimEnd();
      if (line.length === 0) continue;
      await writeLine(writer, `${line}\n`);
      const parsed = parseJsonLine(line);
      if (!parsed) {
        if (!warnedNoise) console.error("CodexProgress: codex stdout included non-JSON noise; persisted to events log and skipping future parse warnings");
        warnedNoise = true; continue;
      }
      const type = eventType(parsed);
      if (!type) continue;
      ring.push({ raw: parsed, type });
      while (ring.length > RING_SIZE) ring.shift();
      if (!sentOpening && type === "thread.started") {
        sentOpening = true;
        void sendNotify(args.pulseUrl, { message: `${args.agent}: spinning up codex`, agent: args.agent, slug: args.slug, voice_enabled: false });
      }
    }
  } finally { await endStream(writer); }
}
function parseJsonLine(line: string): JsonRecord | null {
  try { return asRecord(JSON.parse(line) as unknown); }
  catch (_error: unknown) { return null; } // Safe: raw stdout noise is already persisted to JSONL.
}
function asRecord(value: unknown): JsonRecord | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : null; }
function eventType(record: JsonRecord): string | null {
  if (typeof record.type === "string") return record.type;
  const msg = asRecord(record.msg);
  if (msg && typeof msg.type === "string") return msg.type;
  return null;
}
function startProgressPoller(ring: RingEntry[], args: Args): () => void {
  let lastSummary = "", cleaned = false;
  const timer = setInterval(() => {
    try {
      const entry = [...ring].reverse().find((candidate: RingEntry) => candidate.type === "item.completed");
      if (!entry) return;
      const summary = buildSummary(entry);
      if (!summary || summary.message === lastSummary) return;
      lastSummary = summary.message;
      void sendNotify(args.pulseUrl, { message: summary.message, voice_enabled: false, agent: args.agent, slug: args.slug, phase: args.agent.toUpperCase(), item_type: summary.itemType });
    } catch (error: unknown) { console.error(`CodexProgress: progress poller failed: ${String(error)}`); }
  }, 8000);
  return () => { if (cleaned) return; cleaned = true; clearInterval(timer); };
}
function buildSummary(entry: RingEntry): { message: string; itemType: string } | null {
  if (entry.type !== "item.completed") return null;
  const item = itemRecord(entry.raw), itemType = stringField(item, ["type", "item_type", "name", "tool_name"]) ?? "item";
  const body = collapse(extractText(item) ?? extractText(asRecord(entry.raw.msg)) ?? "completed");
  return { itemType, message: truncate(`[${itemType}] ${body}`, 120) };
}
function itemRecord(record: JsonRecord): JsonRecord { const msg = asRecord(record.msg); return asRecord(msg?.item) ?? asRecord(record.item) ?? msg ?? record; }
function stringField(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) { const value = record[key]; if (typeof value === "string" && value.length > 0) return value; }
  return null;
}
function extractText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter((part: string | null): part is string => Boolean(part)).join(" ");
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["text", "summary", "content", "command", "cmd", "name", "tool_name"]) { const found = extractText(record[key]); if (found) return found; }
  return JSON.stringify(record);
}
function collapse(text: string): string { return text.replace(/\s+/g, " ").trim() || "completed"; }
function truncate(text: string, limit: number): string { return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3))}...`; }
async function sendNotify(url: string, body: JsonRecord): Promise<void> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), PULSE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, voice_enabled: false }), signal: controller.signal });
    if (!response.ok) console.error(`CodexProgress: Pulse notify failed with HTTP ${response.status}`);
  } catch (error: unknown) { console.error(`CodexProgress: Pulse notify failed: ${String(error)}`); }
  finally { clearTimeout(timer); }
}
function wireTimeout(child: ChildProcessWithoutNullStreams, state: RunState, args: Args, cleanupPoller: () => void): TimeoutControl {
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutTimer = setTimeout(() => {
    state.timedOut = true; cleanupPoller(); sendChildSignal(child, "SIGTERM", "timeout");
    killTimer = setTimeout(() => { if (state.childAlive) sendChildSignal(child, "SIGKILL", "timeout escalation"); }, ESCALATE_MS);
    void sendNotify(args.pulseUrl, { message: `${args.agent}: codex timed out after ${args.timeoutMs}ms`, voice_enabled: false, agent: args.agent, slug: args.slug });
  }, args.timeoutMs);
  return {
    clearNaturalExit: () => { if (!state.timedOut) clearTimeout(timeoutTimer); if (killTimer) clearTimeout(killTimer); },
    clearAll: () => { clearTimeout(timeoutTimer); if (killTimer) clearTimeout(killTimer); },
  };
}
function wireSignals(child: ChildProcessWithoutNullStreams, state: RunState, timeoutControl: TimeoutControl, cleanupPoller: () => void): SignalControl {
  let handled = false, killTimer: ReturnType<typeof setTimeout> | undefined, hardTimer: ReturnType<typeof setTimeout> | undefined;
  const handler = (signal: NodeJS.Signals): void => {
    if (handled) return;
    handled = true; state.interrupted = true; cleanupPoller(); timeoutControl.clearAll(); sendChildSignal(child, "SIGTERM", `helper ${signal}`);
    killTimer = setTimeout(() => { if (state.childAlive) sendChildSignal(child, "SIGKILL", `helper ${signal} escalation`); }, ESCALATE_MS);
    hardTimer = setTimeout(() => { console.error(`CodexProgress: hard exit after ${signal}; child did not reap`); process.exit(1); }, ESCALATE_MS * 2);
  };
  process.once("SIGINT", handler); process.once("SIGTERM", handler);
  return { clear: () => { process.off("SIGINT", handler); process.off("SIGTERM", handler); if (killTimer) clearTimeout(killTimer); if (hardTimer) clearTimeout(hardTimer); } };
}
function sendChildSignal(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals, context: string): void {
  if (!child.pid) { try { child.kill(signal); } catch (error: unknown) { console.error(`CodexProgress: failed to send ${signal} during ${context}: ${String(error)}`); } return; }
  try { process.kill(-child.pid, signal); }
  catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code === "ESRCH") { console.error(`CodexProgress: process group already exited while sending ${signal} during ${context}`); return; } // ESRCH means the group is already gone, not a signal failure.
    console.error(`CodexProgress: failed to send ${signal} during ${context}: ${String(error)}`);
  }
}
async function waitForChild(child: ChildProcessWithoutNullStreams): Promise<ExitInfo> {
  // Bounded by the subprocess timeout and helper signal handlers.
  return await new Promise<ExitInfo>((resolve) => {
    child.once("error", (error: Error) => resolve({ code: null, signal: null, error }));
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }));
  });
}
async function readFinalMessage(finalFile: string): Promise<string> {
  if (!existsSync(finalFile) && !isSymlink(finalFile)) return "";
  // Only a regular file is the final message; a symlink would copy some other file into the result line.
  if (!isRegularFile(finalFile)) { console.error(`CodexProgress: final file ${finalFile} is not a regular file; not reading it`); return ""; }
  return await readFile(finalFile, "utf8"); // Local final artifact read is intentionally unbounded.
}
/** What the child said, one line, for the routing surfaces (LifeOS Advisor ISA ISC-7). */
function summaryOf(finalMessage: string): string | undefined { try { return summarize(finalMessage); } catch { return undefined; } }
function formatFinalLine(input: FinalInput): string {
  return JSON.stringify({ verdict: input.verdict, exit_code: input.exitCode, events_file: input.eventsFile, final_file: input.finalFile, duration_ms: input.durationMs, final_message: input.finalMessage, model: input.model, observed_model: input.observed ?? null, co_authored_by: coAuthorTrailer(input.model) });
}
/** Output tokens across every `turn.completed` event codex --json wrote to the run's events file; 0 when none. */
export function codexOutputTokens(eventsFile: string): number {
  let total = 0;
  let text = "";
  try { text = readFileSync(eventsFile, "utf8"); } catch { return 0; }
  for (const line of text.split("\n")) {
    if (!line.includes("turn.completed")) continue;
    try { const e = JSON.parse(line) as { type?: string; usage?: { output_tokens?: number } }; if (e.type === "turn.completed") total += Number(e.usage?.output_tokens ?? 0) || 0; } catch { /* a torn line */ }
  }
  return total;
}

export default async function main(argv: string[]): Promise<number> {
  let resultFile: string | null = null; // set once the slug dir is confined; every exit after that leaves a result a waiter can read
  let binding: RunBinding | null = null;
  const startMs = Date.now();
  try {
    const args = parseArgs(argv);
    binding = runBinding(args.slug, args.agent, startMs);
    // The slug dir is confined before anything is written or deleted through it. A refused
    // dir leaves no result file: the line goes to stdout only, never through the path that was refused.
    let slugDir: string;
    try { slugDir = confinedSlugDir(args.slug); } catch (error: unknown) {
      if (!(error instanceof UnsafeDestinationError)) throw error;
      finish(JSON.stringify({ verdict: "refused", reason: error.message }), null, binding); return 2;
    }
    const paths = runFiles(slugDir, args.agent);
    resultFile = paths.resultFile;
    clearStale(paths.resultFile);
    clearStale(paths.finalFile);
    // Before anything else runs: a run with the wrong write root must never start, and the refusal is a result line a waiter reads.
    const workDir = resolveWorkDir(args.cwd, args.sandbox);
    if (workDir.ok === false) { finish(JSON.stringify({ verdict: "refused", reason: workDir.reason }), resultFile, binding); return 2; }
    const home = homeDir(), codexPath = preflightCodex(home);
    if (!codexPath) { finish('{"verdict":"unavailable","reason":"codex CLI not found at ~/.bun/bin/codex"}', resultFile, binding); return 2; }
    const prompt = await readPrompt(args.prompt);
    if (prompt.length === 0) throw new Error("no prompt provided; pass --prompt or pipe stdin data");
    // The brief gate, at the door every caller shares (Worker.ts, the Sol agent wrapper, and
    // anything else that reaches the helper). A leg below Astra goes only when the deciding arrives with
    // it; Astra is exempt, because an open question is a valid brief there. Router ISA R35.
    const refusal = checkBrief(args.lane ?? "", args.agent, args.slug, prompt, args.sandbox === "read-only");
    if (refusal) { finish(JSON.stringify({ verdict: "needs-info", reason: refusal }), resultFile, binding); return 2; }
    const state: RunState = { startMs: Date.now(), childAlive: true, timedOut: false, interrupted: false }, ring: RingEntry[] = [];
    reapStaleCodex(paths.pidFile);
    stampResolvedModel(paths.eventsFile, args.model, args.agent);
    const codexHome = args.codexHome === "isolated" ? await buildIsolatedCodexHome(home, args.agent) : null;
    const child = spawnCodex(codexPath, args, paths.finalFile, prompt, codexHome, workDir.dir);
    writePidFile(paths.pidFile, child.pid);
    // Herdr agents row: a Worker.ts leg is a background shell process the plugin roster never sees, so the
    // helper names itself on the pane. A wrapper leg (LIFEOS_DISPATCH_ID set) is already listed as a delegate.
    // The exit handler covers the hard-exit paths too; a SIGKILL is pruned by pid at the next report.
    if (!(process.env.LIFEOS_DISPATCH_ID ?? "").trim()) {
      reportHerdrWorker(agentLaneTag(args.agent, laneLabel(args.model)));
      process.once("exit", () => { reportHerdrWorker(null); });
    }
    child.stderr.pipe(process.stderr);
    const cleanupPoller = startProgressPoller(ring, args), timeoutControl = wireTimeout(child, state, args, cleanupPoller), signalControl = wireSignals(child, state, timeoutControl, cleanupPoller), cleanupWatchdog = startOrphanWatchdog(child, state, cleanupPoller);
    let stdoutError: Error | null = null;
    const stdoutTask = wireStdout(child, paths.eventsFile, ring, args).catch((error: unknown) => { stdoutError = error instanceof Error ? error : new Error(String(error)); console.error(`CodexProgress: stdout wiring failed: ${String(error)}`); sendChildSignal(child, "SIGTERM", "stdout failure"); });
    const exitInfo = await waitForChild(child);
    state.childAlive = false; timeoutControl.clearNaturalExit(); cleanupPoller(); cleanupWatchdog(); signalControl.clear(); await stdoutTask;
    try { unlinkSync(paths.pidFile); } catch (_error: unknown) { /* already gone */ }
    const durationMs = Date.now() - state.startMs;
    void sendNotify(args.pulseUrl, { message: `${args.agent}: codex complete (${durationMs}ms, exit ${exitInfo.code})`, voice_enabled: false, agent: args.agent, slug: args.slug });
    if (exitInfo.error) console.error(`CodexProgress: codex spawn failed: ${exitInfo.error.message}`);
    const finalMessage = await readFinalMessage(paths.finalFile);
    const verdict: "success" | "error" | "timeout" = state.timedOut ? "timeout" : exitInfo.code === 0 && !stdoutError && !exitInfo.error && !state.interrupted ? "success" : "error";
    const exitCode = verdict === "timeout" ? null : exitInfo.code;
    // ISC-53: what codex ran on, per process. `forge.model.resolved` is the invocation; this is
    // codex's own session log, bound by the thread id its stdout reported. Never blocks the run.
    let observed: string | null = null;
    try {
      // A mounted run writes its rollout under the real ~/.codex; an isolated run under its scratch home.
      const seen = observeRun(paths.eventsFile, codexHome ?? join(homeDir(), ".codex"));
      observed = seen.observed;
      appendFileNoFollow(paths.eventsFile, `${JSON.stringify({ type: "forge.model.observed", model: observed, thread_id: seen.threadId, rollout: seen.rollout, agent: args.agent, ts: new Date().toISOString() })}\n`);
      // ISC-58: the plugin exports LIFEOS_DISPATCH_ID into a wrapper's helper call, so this record binds to its dispatch exactly.
      const dispatchId = (process.env.LIFEOS_DISPATCH_ID ?? "").trim() || undefined;
      appendRun(lifeosPath("MEMORY", "OBSERVABILITY", "codex-runs.jsonl"), runRecord({ startMs: state.startMs, agent: args.agent, slug: args.slug, threadId: seen.threadId, model: args.model, effort: args.effort, observed, verdict, durationMs, dispatchId, summary: summaryOf(finalMessage) || undefined }));
    } catch (error: unknown) { console.error(`CodexProgress: observed-model stamp failed: ${String(error)}`); }
    // The ladder lights this model for the calling session, whether an agent or a direct Worker call started the run.
    recordModelUse(observed ?? args.model, codexOutputTokens(paths.eventsFile));
    finish(formatFinalLine({ verdict, exitCode, eventsFile: paths.eventsFile, finalFile: paths.finalFile, durationMs, finalMessage, model: args.model, observed }), resultFile, binding);
    return verdict === "success" ? 0 : 1;
  } catch (error: unknown) {
    if (error instanceof InvariantViolation) throw error; // an impossible state fails loud, never as an ordinary error verdict
    console.error(`CodexProgress: ${String(error)}`);
    if (resultFile) { try { writeResult(resultFile, stampBinding(JSON.stringify({ verdict: "error", reason: `CodexProgress: ${String(error)}` }), binding)); } catch (writeError: unknown) { if (writeError instanceof InvariantViolation) throw writeError; console.error(`CodexProgress: failed to write the result file: ${String(writeError)}`); } }
    return 1;
  }
}
if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
