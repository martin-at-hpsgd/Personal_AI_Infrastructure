#!/usr/bin/env bun
/**
 * @version 1.1.0
 * 1.1.0 (2026-10-24, ISA 20261024-native-security ISC-7): SubagentShipGuard is deleted. PlanDeps loses loadGuard; the
 *   Seatbelt wrap is the only boundary for a subagent's Bash, and its fallback reasons no longer name a guard floor.
 * @version 0.2.0 (2026-10-12: wired through the LifeOSHooks plugin; this file's classic-hook entry
 * point stays UNREGISTERED)
 *
 * HOW IT RUNS: the plugin's `tool.call` hook asks HookBridge `subagent-sandbox` (op "plan") for each
 * subagent Bash call. `pluginPlan` below answers the inline-profile wrap, or a fallback
 * with a before-snapshot of the `.git` integrity surface. The plugin's `classic.PreToolUse` hook
 * hands the classic hooks the UNWRAPPED command and its `tool.check` hook judges the permission rules
 * on it, so no guard or rule ever reads the wrapper (a wrapped `cat ~/.claude/.env` or inline python
 * passed PreToolGuard, measured 2026-10-12). `surfaceAfter` (op "after") is the fallback's detector.
 *
 * WHAT IS NOT WRAPPED: a lane whose contract runs codex (Astra, Sol, CodexResearcher, found from
 * agents/*.md, never listed here). Codex applies its own Seatbelt sandbox, and macOS refuses a
 * sandbox inside a sandbox (`sandbox_apply: Operation not permitted`, measured), so wrapping would
 * break every codex child command. Those calls get the fallback detector instead.
 *
 * SubagentGitSandbox — the shell-free guarantee for the private trees' git internals (HookSystem.md § Native
 * enforcement).
 *
 * A static parser (SubagentShipGuard, retired 2026-10-24) once protected the private trees' git internals by modelling which directory a shell
 * command runs in. That model had a fail-open found in three review rounds running, and three
 * remained open after 2.4.4 (a cd an `&&`/`||`/`if` may skip, a commented-out cd, a redirect to a
 * computed path). Static shell parsing cannot be made complete. This hook stops parsing and lets
 * the OS decide: a subagent's Bash command is re-run under a macOS `sandbox-exec` deny-write
 * profile that refuses every write under each private tree's `.git` except `objects` and the
 * index, so a write to config/hooks/refs/HEAD cannot land however the command is spelled.
 *
 * SAFETY CONTRACT (why this cannot hurt the main session):
 *   - It acts ONLY on a subagent (non-empty agent_id) running Bash. A main-session command (no
 *     agent_id) and the principal's own terminal are passed through untouched — never wrapped.
 *   - As a classic PreToolUse hook it runs in PARALLEL with the other hooks and sees the ORIGINAL
 *     command, so the permission rules judge the original (no loosening). This hook never
 *     returns `allow`, only `updatedInput`, so it does not skip any permission prompt; the wrapped
 *     command is re-checked against deny/ask rules as usual.
 *   - It never restores or overwrites a file. A write is PREVENTED by the OS, not undone.
 *   - Fail-closed-for-protected-paths-only: if sandbox-exec is missing, or the `.git` dirs cannot
 *     be resolved, or anything throws, it passes the command through with a loud notice on stderr
 *     and leaves the native deny rules as the floor. It never blocks
 *     unrelated lane work and never fails the call on its own error.
 *
 * COMPOSITION: the retired ContextReduction.hook.sh also returned `updatedInput` (rtk rewrite; the plugin does it now). Two parallel
 * hooks that both rewrite the same Bash command is an unresolved merge. Do NOT register this hook
 * as a second parallel rewriter without the contract in sandbox-wiring.md. The recommended wiring
 * is the LifeOSHooks plugin `tool.call` seam (a single sequential rewrite), or the before/after
 * detector, which rewrites nothing.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gitDirs, sandboxAvailable, sandboxProfile, wrapUnderSandbox } from "./lib/subagent-git-sandbox-core";
import { wrapInline } from "./lib/subagent-sandbox-wrap";
import { getClaudeDir } from "../LIFEOS/TOOLS/Paths";

type HookInput = {
  agent_id?: unknown;
  tool_name?: unknown;
  tool_input?: { command?: unknown };
  session_id?: unknown;
};

function isSubagent(input: HookInput): boolean {
  const id = input?.agent_id;
  return typeof id === "string" && id.length > 0;
}

/** Write the profile to a stable per-content file in LifeOS state (never the shared temp dir, where a fixed name invites a planted symlink) and return its path. */
function writeProfile(profile: string): string {
  const dir = join(getClaudeDir(), "LIFEOS", "MEMORY", "STATE", "subagent-git-sandbox");
  mkdirSync(dir, { recursive: true });
  const name = createHash("sha256").update(profile).digest("hex").slice(0, 16) + ".sb";
  const path = join(dir, name);
  writeFileSync(path, profile, { mode: 0o600 });
  return path;
}

export type Decision =
  | { kind: "passthrough"; reason: string }
  | { kind: "wrap"; command: string; profilePath: string };

/** Pure decision: what to do with this hook input. Exported for tests. */
export function decide(input: HookInput): Decision {
  if (!isSubagent(input)) return { kind: "passthrough", reason: "main session (no agent_id)" };
  if (input?.tool_name !== "Bash") return { kind: "passthrough", reason: "not a Bash call" };
  const command = input?.tool_input?.command;
  if (typeof command !== "string" || command.length === 0) return { kind: "passthrough", reason: "no command" };
  if (!sandboxAvailable()) return { kind: "passthrough", reason: "sandbox-exec unavailable — the native deny rules are the only floor" };
  const dirs = gitDirs();
  if (dirs.length === 0) return { kind: "passthrough", reason: "no private .git resolved — the native deny rules are the only floor" };
  const profilePath = writeProfile(sandboxProfile(dirs));
  return { kind: "wrap", command: wrapUnderSandbox(command, profilePath), profilePath };
}

// --- The plugin path (HookBridge `subagent-sandbox`) ----------------------------------------------

/** A snapshot of the integrity surface as JSON can carry it: [path, sha256] pairs. */
export type SurfaceEntries = Array<[string, string]>;

export type PluginPlanRequest = {
  agent_id?: unknown;
  agent_type?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  /** Every form the command took before the wrap (as the model wrote it, as the plugin rewrote it). */
  commands?: unknown;
  /** The one form that runs: the last rewrite. */
  wrap?: unknown;
};

export type PluginPlan =
  | { kind: "deny"; reason: string }
  | { kind: "wrap"; command: string; profile: string }
  | { kind: "fallback"; reason: string; surface: SurfaceEntries | null };

type Core = typeof import("./lib/subagent-git-sandbox-core");
type VigilEmit = (event: Record<string, unknown>) => Promise<void>;

/** What the plan and the detector load or touch, injectable so a test can force each failure. */
export type PlanDeps = {
  loadCore: () => Promise<Core>;
  readContract: (agentType: string) => string | null;
  emit: VigilEmit;
  now: () => Date;
};

const VIGIL_EMIT = new URL("../LIFEOS/VIGIL/Emit.ts", import.meta.url).pathname;

export const defaultPlanDeps: PlanDeps = {
  loadCore: async () => import("./lib/subagent-git-sandbox-core"),
  readContract: (agentType) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentType)) return null;
    try {
      return readFileSync(join(getClaudeDir(), "agents", `${agentType}.md`), "utf8");
    } catch {
      return null;
    }
  },
  emit: async (event) => {
    const { emit } = await import(VIGIL_EMIT);
    emit(event as never);
  },
  now: () => new Date(),
};

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 200);

/** A contract line that starts codex, directly or through the helpers that spawn it. */
const RUNS_CODEX = /^\s*(?:echo\s+"\$\w+"\s*\|\s*)?(?:bun\s+\S*\/(?:CodexProgress|CrossVendorAudit)\.ts\b|codex\s+exec\b)/m;

/**
 * Why this lane's Bash is not wrapped, or null when it is. A lane whose contract starts codex runs
 * its work under codex's own Seatbelt sandbox, which cannot be applied inside this one.
 */
export function selfSandboxingLane(agentType: string, read: (t: string) => string | null): string | null {
  if (!agentType) return null;
  const contract = read(agentType);
  return contract && RUNS_CODEX.test(contract)
    ? `${agentType} runs codex, whose own sandbox cannot start inside this one`
    : null;
}

function snapshotWith(core: Core): SurfaceEntries | null {
  try {
    return [...core.hashIntegritySurface(core.gitDirs())];
  } catch {
    return null;
  }
}

/**
 * The plan for one subagent Bash call. Never throws: every failure is a fallback, which leaves the
 * command unwrapped (today's path, every classic guard still judging it) with a before-snapshot for
 * the detector when one could be taken.
 */
export async function pluginPlan(req: PluginPlanRequest, deps: PlanDeps = defaultPlanDeps): Promise<PluginPlan> {
  const agentId = typeof req?.agent_id === "string" ? req.agent_id : "";
  const agentType = typeof req?.agent_type === "string" ? req.agent_type : "";
  const cwd = typeof req?.cwd === "string" && req.cwd ? req.cwd : process.cwd();
  const wrap = typeof req?.wrap === "string" ? req.wrap : "";
  const commands = [
    ...new Set([...(Array.isArray(req?.commands) ? req.commands : []), wrap].filter((c): c is string => typeof c === "string" && c.length > 0)),
  ];

  let core: Core | null = null;
  let coreError = "";
  try {
    core = await deps.loadCore();
  } catch (err) {
    coreError = errText(err);
  }
  const fallback = (reason: string): PluginPlan => ({ kind: "fallback", reason, surface: core ? snapshotWith(core) : null });

  if (!agentId || !wrap) return fallback("not a subagent Bash call");

  // The wrap is the whole check (2026-10-24, ISA 20261024-native-security): the kernel judges the
  // write, so no text parser judges the command first. `commands` and `cwd` stay in the request shape.
  void commands; void cwd;

  // The wrap, unless anything it needs is missing.
  if (!core) return fallback(`sandbox core failed to load (${coreError})`);
  const lane = selfSandboxingLane(agentType, deps.readContract);
  if (lane) return fallback(lane);
  try {
    if (!core.sandboxAvailable()) return fallback("sandbox-exec unavailable");
    const dirs = core.gitDirs();
    if (dirs.length === 0) return fallback("no private .git resolved");
    const profile = core.sandboxProfile(dirs);
    return { kind: "wrap", command: wrapInline(wrap, profile), profile };
  } catch (err) {
    return fallback(`profile build failed (${errText(err)})`);
  }
}

/** A snapshot for the detector when the plan did not take one. */
export async function surfaceNow(deps: PlanDeps = defaultPlanDeps): Promise<{ surface: SurfaceEntries | null; error?: string }> {
  try {
    const core = await deps.loadCore();
    const surface = snapshotWith(core);
    return surface ? { surface } : { surface: null, error: "snapshot failed" };
  } catch (err) {
    return { surface: null, error: errText(err) };
  }
}

/**
 * Integrity paths a peer session's ordinary commit or auto-gc also moves (refs, reflogs,
 * packed-refs). A change there alone is reported, never alarmed: with a dozen sessions committing,
 * an alarm on it would fire on most long lane commands. config, HEAD, hooks/, info/ are the alarm set.
 */
export function isCommitTrail(relPath: string): boolean {
  return relPath === "packed-refs" || relPath.startsWith("refs/") || relPath.startsWith("logs/");
}

/** `<tree>/.git: <path inside .git>` for a surface path, from the git dirs it belongs to. */
function labelFor(path: string, dirs: string[]): { label: string; rel: string } {
  const g = dirs.find((d) => path === d || path.startsWith(d + "/"));
  if (!g) return { label: basename(path), rel: basename(path) };
  const rel = path.slice(g.length + 1).replace(/\0<unstat>$/, "");
  return { label: `${basename(dirname(g))}/.git/${rel}`, rel };
}

export type SurfaceAfter = { changed: string[]; alarm: string[]; emitted: boolean; error?: string };

/**
 * The detector's second half: compare the surface now with the before-snapshot. An alarm-set change
 * raises one Vigil security event (no auto-restore, ever). Never throws.
 */
export async function surfaceAfter(
  req: { before?: unknown; agent_id?: unknown; agent_type?: unknown },
  deps: PlanDeps = defaultPlanDeps,
): Promise<SurfaceAfter> {
  try {
    if (!Array.isArray(req?.before)) return { changed: [], alarm: [], emitted: false, error: "no before-snapshot" };
    const before = new Map<string, string>(
      (req.before as unknown[]).filter((x): x is [string, string] => Array.isArray(x) && typeof x[0] === "string" && typeof x[1] === "string"),
    );
    const core = await deps.loadCore();
    const dirs = core.gitDirs();
    const changedPaths = core.diffSurface(before, core.hashIntegritySurface(dirs));
    const labelled = changedPaths.map((p) => labelFor(p, dirs));
    const changed = labelled.map((l) => l.label);
    const alarm = labelled.filter((l) => !isCommitTrail(l.rel)).map((l) => l.label);
    let emitted = false;
    if (alarm.length > 0) {
      const now = deps.now();
      const agentType = typeof req.agent_type === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(req.agent_type) ? req.agent_type : "a subagent";
      const names = alarm.slice(0, 4).join(", ") + (alarm.length > 4 ? ` and ${alarm.length - 4} more` : "");
      try {
        await deps.emit({
          id: randomUUID(),
          source: "hook:SubagentGitSandbox",
          ts: now.toISOString(),
          kind: "security",
          severity: "critical",
          title: "A private .git changed while a subagent's command ran unsandboxed",
          summary: `${names} changed during a Bash call by ${agentType}. A lane must never write there; check git config and hooks. Nothing was restored.`,
          ref: null,
          url: null,
          privacy_class: "public",
          dedup_key: `subagent-git-sandbox:${createHash("sha256").update(alarm.join("\n")).digest("hex").slice(0, 16)}:${Math.floor(now.getTime() / 3_600_000)}`,
        });
        emitted = true;
      } catch {
        /* the alarm still reaches the plugin's log and the model; a Vigil failure never changes the answer */
      }
    }
    return { changed, alarm, emitted };
  } catch (err) {
    return { changed: [], alarm: [], emitted: false, error: errText(err) };
  }
}

async function main(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    process.exit(0); // open on bad stdin, like every guard here
  }

  let decision: Decision;
  try {
    decision = decide(input);
  } catch (err) {
    // Fail closed for the protected paths only: we cannot guarantee prevention, so say so loudly,
    // but do not block the call; the native deny rules still apply to this command.
    process.stderr.write(`SubagentGitSandbox: internal error, not wrapping (${(err as Error)?.message ?? err}). The native deny rules still apply.\n`);
    process.exit(0);
  }

  if (decision.kind === "passthrough") {
    if (!/main session|not a Bash|no command/.test(decision.reason)) {
      process.stderr.write(`SubagentGitSandbox: ${decision.reason}.\n`);
    }
    process.exit(0);
  }

  // Rewrite only; no permissionDecision, so no prompt is skipped and the wrapped command is still
  // checked against deny/ask rules.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { ...(input.tool_input as object), command: decision.command },
      },
    }),
  );
  process.exit(0);
}

if (import.meta.main) void main();
