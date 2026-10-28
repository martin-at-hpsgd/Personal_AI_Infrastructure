#!/usr/bin/env bun
/**
 * Run — the ComputerUse runner for the vision backends (Astra via codex, Claude via ClaudeLeg.ts).
 *
 * Contract (the ISA is the spec; this file implements it):
 *   - Refuses on a headless channel (exit 3). Terminal sessions only.
 *   - Refuses when the Interceptor preflight fails (exit 4): a broken evidence
 *     path is never a reason to route to the full-desktop backend.
 *   - Refuses (exit 2, naming the app) when a credential-class deny entry is
 *     RUNNING, when a communications-class deny entry is running and not hidden,
 *     or when a visible browser tab's host matches a denied domain.
 *   - Refuses without a declared verifier (exit 5). The actor never grades itself.
 *   - Spawns `codex exec` as a child process with an argument array: ephemeral,
 *     read-only sandbox in a scratch cwd, browser tools disabled by override,
 *     this skill's own instructions file, the model lane from models.ts.
 *   - Supervises the child: step cap, wall clock, and a watcher that kills it
 *     within one poll interval when a denied app becomes visible or the
 *     frontmost app leaves the run's allowlist.
 *   - Every exit path, including aborts, runs the declared verifier and writes
 *     a run record whose `verdict` comes only from the verifier.
 *   - Voice line at start and at finish.
 *   - backend "claude" spawns `bun ClaudeLeg.ts` instead of codex: a tool-less Claude
 *     actor whose actions run through Interceptor's bridge. Same supervisor, same
 *     deny scan, caps, watcher and verifier; its JSONL `cu_action` lines feed the step cap.
 *
 * Everything with machine access is injected (Providers) so the supervisor is
 * testable without a desktop. Tests: ../Tests/*.test.ts
 *
 * @version 1.0.0
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant";
import { CROSS_VENDOR } from "../../../LIFEOS/TOOLS/models";
import { getClaudeDir, lifeosPath } from "../../../LIFEOS/TOOLS/Paths";
import { getNotificationChannel } from "../../../hooks/lib/notification-channel";

// ── Paths ────────────────────────────────────────────────────────────────────

const HOME = homedir();
const CLAUDE_DIR = getClaudeDir();
export const SKILL_DIR = join(CLAUDE_DIR, "skills", "ComputerUse");
export const USER_SKILL_DIR = lifeosPath("USER", "CUSTOMIZATIONS", "SKILLS", "ComputerUse");
export const DEFAULT_CONFIG_PATH = join(USER_SKILL_DIR, "Config.md");
export const RUNS_DIR = join(USER_SKILL_DIR, "runs");
export const INSTRUCTIONS_PATH = join(SKILL_DIR, "Instructions.md");
export const CLAUDE_LEG_PATH = join(SKILL_DIR, "Tools", "ClaudeLeg.ts");

/** The two vision legs. Interceptor is not one: it is the handle path and the evidence path. */
export type VisionBackend = "astra" | "claude";
/**
 * The runner's own codex home. The user's ~/.codex carries a global AGENTS.md,
 * hooks, skills, and memories that codex sends to the model on EVERY spawn
 * regardless of model_instructions_file or project_doc_max_bytes (observed
 * 2026-09-07: the AGENTS.md text reached the model verbatim). An isolated home
 * links in only auth and the computer-use plugin; nothing else exists to send.
 */
export const CODEX_HOME_DIR = join(USER_SKILL_DIR, "codex-home");
export const CODEX_HOME_CONFIG = `# ComputerUse runner's isolated codex home. No AGENTS.md, no hooks, no skills, no memories.
model = "__MODEL__"
approval_policy = "never"

[features]
hooks = false
computer_use = true
browser_use = false
browser_use_full_cdp_access = false

[plugins."computer-use@openai-bundled"]
enabled = true

[plugins."unified-computer-use@openai-bundled"]
enabled = true
`;

/** Create the isolated codex home if missing. Links: auth.json, plugins, computer-use, .tmp. */
export function ensureCodexHome(dir = CODEX_HOME_DIR, userCodex = join(HOME, ".codex")): string {
  mkdirSync(dir, { recursive: true });
  for (const name of ["auth.json", "plugins", "computer-use", ".tmp"]) {
    const link = join(dir, name);
    if (!existsSync(link)) { try { symlinkSync(join(userCodex, name), link); } catch { /* target may not exist yet */ } }
  }
  const cfg = join(dir, "config.toml");
  if (!existsSync(cfg)) writeFileSync(cfg, CODEX_HOME_CONFIG.replace("__MODEL__", modelLane()));
  // codex creates skills/.system (its bundled review-agent, skill-creator, ...) and its own
  // sqlite state on first run; those are codex's, isolated here. What must never appear is
  // anything the user authored: a global AGENTS.md, hooks, or a non-system skill.
  const userSkills = existsSync(join(dir, "skills")) ? readdirSync(join(dir, "skills")).filter((n) => n !== ".system") : [];
  invariant(!existsSync(join(dir, "AGENTS.md")) && !existsSync(join(dir, "hooks.json")) && userSkills.length === 0,
    `isolated codex home must carry no AGENTS.md, hooks, or user skills (found: ${userSkills.join(",") || "AGENTS.md/hooks.json"})`);
  return dir;
}

// ── Exit codes (stable; the Test Strategy depends on them) ───────────────────

export const EXIT = {
  OK: 0,
  FAIL: 1,
  DENIED: 2,
  HEADLESS: 3,
  PREFLIGHT: 4,
  NO_VERIFIER: 5,
  ABORTED: 6,
} as const;

// ── Config ───────────────────────────────────────────────────────────────────

export interface Config {
  /** Must not be RUNNING at all (credential stores). */
  denyRunning: string[];
  /** Must not be running-and-visible (communications). */
  denyVisible: string[];
  /** Browser tab hosts that block the run (suffix match). */
  denyDomains: string[];
  stepCap: number;
  wallClockSeconds: number;
  pollMs: number;
  /** How long Astra has to bring an allowlisted app to the front before the run aborts. */
  graceMs: number;
  /** Shortcut names that turn Focus on/off around the run; empty disables. */
  focusOnShortcut: string;
  focusOffShortcut: string;
  /** Vision leg per task class (lowercased target app) from the bake-off scoreboard; key "default" for the rest. */
  visionPick: Record<string, VisionBackend>;
  /** Set by loadConfig when the config file does not exist: the path that was looked for. Never set by parseConfig. */
  missing?: string;
}

export const DEFAULT_CONFIG: Config = {
  denyRunning: [],
  denyVisible: [],
  denyDomains: [],
  stepCap: 60,
  wallClockSeconds: 600,
  pollMs: 1000,
  graceMs: 20000,
  focusOnShortcut: "",
  focusOffShortcut: "",
  visionPick: { default: "astra" },
};

/** Pure. `default=astra, textedit=claude` → map. Anything not astra|claude is dropped. */
export function parseVisionPick(raw: string | undefined): Record<string, VisionBackend> {
  const out: Record<string, VisionBackend> = { default: "astra" };
  for (const part of (raw ?? "").split(",")) {
    const m = part.trim().match(/^([a-z0-9 ._-]+)=(astra|claude)$/i);
    if (m) out[m[1].trim().toLowerCase()] = m[2].toLowerCase() as VisionBackend;
  }
  return out;
}

/** Pure. The vision leg for a target app: its class pick, else the default. */
export function pickFor(cfg: Pick<Config, "visionPick">, app: string): VisionBackend {
  return cfg.visionPick[app.toLowerCase()] ?? cfg.visionPick.default ?? "astra";
}

/** `key: value` lines; lists are comma-separated. Unknown keys ignored. */
export function parseConfig(raw: string): Config {
  const kv: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([a-z_]+):\s*(.*?)\s*$/i);
    if (m) kv[m[1].toLowerCase()] = m[2];
  }
  const list = (k: string) => (kv[k] ? kv[k].split(",").map((s) => s.trim()).filter(Boolean) : []);
  const num = (k: string, d: number) => (kv[k] && Number.isFinite(Number(kv[k])) ? Number(kv[k]) : d);
  return {
    denyRunning: list("deny_running"),
    denyVisible: list("deny_visible"),
    denyDomains: list("deny_domains").map((d) => d.toLowerCase()),
    stepCap: num("step_cap", DEFAULT_CONFIG.stepCap),
    wallClockSeconds: num("wall_clock_seconds", DEFAULT_CONFIG.wallClockSeconds),
    pollMs: num("poll_ms", DEFAULT_CONFIG.pollMs),
    graceMs: num("grace_seconds", DEFAULT_CONFIG.graceMs / 1000) * 1000,
    focusOnShortcut: kv["focus_on_shortcut"] ?? "",
    focusOffShortcut: kv["focus_off_shortcut"] ?? "",
    visionPick: parseVisionPick(kv["vision_pick"]),
  };
}

/** A missing file is marked `missing` rather than quietly defaulted: supervise refuses it, because empty deny lists would let the vision leg see anything. */
export function loadConfig(path = DEFAULT_CONFIG_PATH): Config {
  if (!existsSync(path)) return { ...DEFAULT_CONFIG, missing: path };
  return parseConfig(readFileSync(path, "utf8"));
}

// ── Machine-facing providers (injected) ──────────────────────────────────────

export interface AppInfo {
  name: string;
  pid: number;
  isActive: boolean;
  isHidden: boolean;
  bundleId?: string;
}
export interface TabInfo {
  url: string;
  active: boolean;
}
export interface Providers {
  /** Running apps with hidden/active state (interceptor macos inspect). */
  apps: () => Promise<AppInfo[]>;
  /** Visible browser tabs (interceptor tabs --json). */
  tabs: () => Promise<TabInfo[]>;
  /** Interceptor daemon + bridge health (interceptor status --json). */
  interceptorHealthy: () => Promise<boolean>;
  /** Voice line. */
  notify: (message: string) => Promise<void>;
  /** Spawn the vision child: `codex` for astra, `bun` for claude. */
  spawn: (argv: string[], cwd: string, backend?: VisionBackend) => ChildProcess;
  /** Run a shell verifier; resolves to its exit code. */
  runVerifier: (cmd: string) => Promise<number>;
  /** Run a Shortcut by name (Focus on/off); resolves to exit code. */
  runShortcut: (name: string) => Promise<number>;
  now: () => number;
}

// ── Deny scan ────────────────────────────────────────────────────────────────

export interface Denial {
  kind: "running" | "visible" | "tab";
  name: string;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function hostDenied(host: string, denyDomains: string[]): boolean {
  return denyDomains.some((d) => host === d || host.endsWith("." + d));
}

/** Pure: given the current machine snapshot, which deny rules fire. */
export function scanDenials(cfg: Config, apps: AppInfo[], tabs: TabInfo[]): Denial[] {
  const out: Denial[] = [];
  const byName = (n: string) => apps.filter((a) => a.name.toLowerCase() === n.toLowerCase());
  for (const n of cfg.denyRunning) if (byName(n).length) out.push({ kind: "running", name: n });
  for (const n of cfg.denyVisible) if (byName(n).some((a) => !a.isHidden)) out.push({ kind: "visible", name: n });
  for (const t of tabs) {
    const h = hostOf(t.url);
    if (h && hostDenied(h, cfg.denyDomains)) out.push({ kind: "tab", name: h });
  }
  return out;
}

export function formatDenials(d: Denial[]): string {
  return d.map((x) => `${x.kind}: ${x.name}`).join("; ");
}

// ── Spawn argv ───────────────────────────────────────────────────────────────

export interface SpawnSpec {
  prompt: string;
  scratchDir: string;
  outputFile: string;
  model: string;
  instructionsPath: string;
  /** macOS bundle ids codex may drive; mirrors the run allowlist. */
  bundleIds: string[];
}

/** Hard cap on any verifier command; a verifier that hangs is a failed verifier. */
export const VERIFIER_TIMEOUT_MS = 120_000;

export const MODEL_LANE = "computerUse";

export function modelLane(): string {
  const m = CROSS_VENDOR[MODEL_LANE];
  invariant(typeof m === "string" && m.length > 0, `models.ts CROSS_VENDOR.${MODEL_LANE} is not set`);
  return m;
}

/** The exact argument array. Every spawn goes through here; tests assert on it. */
export function buildArgv(s: SpawnSpec): string[] {
  invariant(!s.prompt.includes("\0"), "prompt contains NUL");
  return [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "-C", s.scratchDir,
    "--sandbox", "read-only",
    "-c", "features.browser_use=false",
    "-c", "features.browser_use_full_cdp_access=false",
    "-c", "features.computer_use=true",
    // The user's codex install may carry its own hooks and instructions (a whole
    // other operating contract). Both are switched off for every ComputerUse run.
    "-c", "features.hooks=false",
    // The Codex desktop app registers its own browser plugins in the user config; off for every run (ISA Q9: one browser, Interceptor).
    "-c", "plugins.\"browser@openai-bundled\".enabled=false",
    "-c", "plugins.\"sites@openai-bundled\".enabled=false",
    // codex's own app allowlist mirrors the run allowlist: deny by default.
    "-c", 'computer_use.default_app_access="deny"',
    "-c", `computer_use.macos.bundle_ids={${s.bundleIds.map((b) => `"${b}"="allow"`).join(",")}}`,
    "-c", 'approval_policy="never"',
    "-c", `model_instructions_file="${s.instructionsPath}"`,
    "-m", s.model,
    "--json",
    "-o", s.outputFile,
    s.prompt,
  ];
}

/** The Claude leg's argument array for `bun`. The target is the allowlist's first app. */
export function buildClaudeArgv(s: { app: string; taskFile: string; outputFile: string; model: string; maxSteps: number }): string[] {
  invariant(s.app.length > 0 && s.app !== "(none)", "the claude leg needs a target app");
  invariant(s.maxSteps > 0, "max steps must be positive");
  return ["run", CLAUDE_LEG_PATH, "--app", s.app, "--task-file", s.taskFile, "--out", s.outputFile, "--model", s.model, "--max-steps", String(s.maxSteps)];
}

/** Model for the Claude leg: an alias, never a pinned id (models.ts owns ids). */
export const CLAUDE_LEG_DEFAULT_MODEL = "opus";

export function argvHasBrowserDisabled(argv: string[]): boolean {
  return argv.includes("features.browser_use=false") && argv.includes("features.browser_use_full_cdp_access=false")
    && argv.includes("plugins.\"browser@openai-bundled\".enabled=false");
}
export function argvHasHooksDisabled(argv: string[]): boolean {
  return argv.includes("features.hooks=false");
}
export function argvHasReadOnlySandbox(argv: string[]): boolean {
  const i = argv.indexOf("--sandbox");
  return i >= 0 && argv[i + 1] === "read-only";
}

// ── Event stream ─────────────────────────────────────────────────────────────

/**
 * A codex --json line counts as one computer-use action when it is a tool call
 * whose name mentions computer use. The exact event vocabulary is recorded by
 * the ISC-6 probe; this matcher is deliberately generous so an undercounted
 * cap can never happen (undercounting is the unsafe direction).
 */
/** Observed 2026-09-07 (codex 0.153.4 + Codex.app 26.901): the tool is `mcp__cua_repl.js`; each call is an `item.completed` with item.type mcp_tool_call. */
export function isComputerUseEvent(line: string): boolean {
  // ClaudeLeg.ts prints one {"type":"cu_action"} line per executed action.
  if (/"type"\s*:\s*"cu_action"/.test(line)) return true;
  if (!/cua_repl|computer[_-]?use|"computer"|screenshot|click|type_text|key_press|mouse/i.test(line)) return false;
  return /"(type|kind|event|name|tool|tool_name|item_type)"\s*:\s*"[^"]*(call|tool|action|computer)[^"]*"/i.test(line)
    || /"(name|tool|tool_name)"\s*:\s*"[^"]*computer[^"]*"/i.test(line);
}
export function isBrowserEvent(line: string): boolean {
  return /browser[_-]?use|"browser"/i.test(line) && /"(name|tool|tool_name|type)"\s*:\s*"[^"]*browser[^"]*"/i.test(line);
}

// ── Run record ───────────────────────────────────────────────────────────────

export type Verdict = "unverified" | "pass" | "fail";
export type RunState = "completed" | "aborted" | "refused";

export interface RunRecord {
  id: string;
  startedAt: string;
  finishedAt?: string;
  route: VisionBackend;
  reason: "no-handle" | "escalated-after-2-failures";
  task: string;
  allowlist: string[];
  verifier: { kind: "cli" | "interceptor"; command: string };
  state: RunState;
  abortReason?: string;
  steps: number;
  browserEvents: number;
  durationMs: number;
  childExitCode: number | null;
  /** Astra's own final message. Never the verdict. */
  astraReport: string;
  verdict: Verdict;
  verifierExitCode?: number;
  argv: string[];
}

/** The only writer of `verdict`. Anything else setting it is an invariant violation. */
export function setVerdict(rec: RunRecord, verifierExitCode: number): RunRecord {
  invariant(rec.verdict === "unverified", "verdict already set; the verifier runs exactly once");
  return { ...rec, verifierExitCode, verdict: verifierExitCode === 0 ? "pass" : "fail" };
}

export function newRecord(init: {
  task: string;
  allowlist: string[];
  verifier: RunRecord["verifier"];
  reason?: RunRecord["reason"];
  argv: string[];
  now: number;
  backend?: VisionBackend;
}): RunRecord {
  invariant(init.verifier.command.trim().length > 0, "a run needs a declared verifier");
  invariant(init.allowlist.length > 0, "a run needs at least one allowlisted app");
  return {
    id: new Date(init.now).toISOString().replace(/[:.]/g, "-"),
    startedAt: new Date(init.now).toISOString(),
    route: init.backend ?? "astra",
    reason: init.reason ?? "no-handle",
    task: init.task,
    allowlist: init.allowlist,
    verifier: init.verifier,
    state: "completed",
    steps: 0,
    browserEvents: 0,
    durationMs: 0,
    childExitCode: null,
    astraReport: "",
    verdict: "unverified",
    argv: init.argv,
  };
}

export function writeRecord(rec: RunRecord, dir = RUNS_DIR): string {
  invariant(rec.verdict !== "unverified" || rec.state === "refused", "a finished run is written only after its verifier ran");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${rec.id}.json`);
  writeFileSync(p, JSON.stringify(rec, null, 2) + "\n");
  return p;
}

// ── Supervisor ───────────────────────────────────────────────────────────────

export interface RunRequest {
  task: string;
  /** Apps Astra may have frontmost. Default: the target app alone. */
  allowlist: string[];
  verifier: RunRecord["verifier"];
  reason?: RunRecord["reason"];
  stepCap?: number;
  wallClockSeconds?: number;
  pollMs?: number;
  graceMs?: number;
  scratchDir?: string;
  outputFile?: string;
  /** Test hook: skip the real machine and pretend the deny scan passed. */
  dryRun?: boolean;
  /** When set, every stdout line from the child is appended here (the JSONL event stream). */
  eventLog?: string;
  /** Which vision leg acts. Default astra. */
  backend?: VisionBackend;
  /** Claude leg model alias. Default CLAUDE_LEG_DEFAULT_MODEL. */
  claudeModel?: string;
}

export interface SuperviseResult {
  exitCode: number;
  record?: RunRecord;
  denials?: Denial[];
  message: string;
}

export async function supervise(req: RunRequest, cfg: Config, p: Providers): Promise<SuperviseResult> {
  // 1. Channel.
  if (getNotificationChannel() === "headless") {
    return { exitCode: EXIT.HEADLESS, message: "refused: headless channel; ComputerUse runs only from a terminal session" };
  }
  // 2. Verifier declared.
  if (!req.verifier || !req.verifier.command.trim()) {
    return { exitCode: EXIT.NO_VERIFIER, message: "refused: no verifier declared; the actor never grades itself" };
  }
  // 3. Interceptor preflight.
  if (!(await p.interceptorHealthy())) {
    return { exitCode: EXIT.PREFLIGHT, message: "refused: Interceptor preflight failed; a broken evidence path is not a reason to route to Astra" };
  }
  // 3b. No config file means no deny lists were ever chosen; fail closed rather than run with empty ones.
  if (cfg.missing) {
    return { exitCode: EXIT.DENIED, message: `refused: no ComputerUse Config.md at ${cfg.missing}; copy skills/ComputerUse/Config.example.md there and set the deny lists (Setup.md)` };
  }
  // 4. Deny scan.
  let apps: AppInfo[], tabs: TabInfo[];
  try {
    [apps, tabs] = await Promise.all([p.apps(), p.tabs()]);
  } catch (e) {
    return { exitCode: EXIT.PREFLIGHT, message: `refused: deny scan could not read the machine (${(e as Error).message}); an unread machine is never a clean one` };
  }
  const denials = scanDenials(cfg, apps, tabs);
  if (denials.length) {
    return { exitCode: EXIT.DENIED, denials, message: `refused: deny list — ${formatDenials(denials)}` };
  }

  const scratch = req.scratchDir ?? join(HOME, "Downloads", "computeruse-scratch");
  mkdirSync(scratch, { recursive: true });
  const out = req.outputFile ?? join(scratch, "last-message.txt");
  const bundleIds = req.allowlist.map((n) => apps.find((a) => a.name.toLowerCase() === n.toLowerCase())?.bundleId ?? n);
  const backend: VisionBackend = req.backend ?? "astra";
  const stepCap = req.stepCap ?? cfg.stepCap;
  let argv: string[];
  if (backend === "claude") {
    const taskFile = join(scratch, "task.txt");
    writeFileSync(taskFile, req.task);
    argv = buildClaudeArgv({ app: req.allowlist[0], taskFile, outputFile: out, model: req.claudeModel ?? CLAUDE_LEG_DEFAULT_MODEL, maxSteps: stepCap });
  } else {
    argv = buildArgv({ prompt: req.task, scratchDir: scratch, outputFile: out, model: modelLane(), instructionsPath: INSTRUCTIONS_PATH, bundleIds });
  }
  const label = backend === "claude" ? "Claude" : "Astra";
  const start = p.now();
  let rec = newRecord({ task: req.task, allowlist: req.allowlist, verifier: req.verifier, reason: req.reason, argv, now: start, backend });

  if (req.dryRun) {
    return { exitCode: EXIT.OK, record: rec, message: backend === "claude" ? `dry-run: would spawn bun ${argv.join(" ")}` : `dry-run: would spawn codex ${argv.slice(0, -1).join(" ")} <prompt>` };
  }

  const wall = (req.wallClockSeconds ?? cfg.wallClockSeconds) * 1000;
  const pollMs = req.pollMs ?? cfg.pollMs;
  invariant(stepCap > 0 && wall > 0 && pollMs > 0, "caps must be positive");

  let child: ChildProcess | undefined;
  let abortReason: string | undefined;
  let killed = false;
  const kill = (why: string) => {
    if (killed) return;
    killed = true;
    abortReason = why;
    if (!child) return;
    if (child.pid) killTree(child.pid);
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  };

  let buf = "";
  let exitCode: number | null = null;
  let wallTimer: ReturnType<typeof setTimeout> | undefined;
  let watcher: ReturnType<typeof setInterval> | undefined;
  const onLine = (line: string) => {
    if (req.eventLog) { try { appendFileSync(req.eventLog, line + "\n"); } catch { /* best-effort log */ } }
    if (isBrowserEvent(line)) rec.browserEvents++;
    if (isComputerUseEvent(line)) {
      rec.steps++;
      if (rec.steps >= stepCap) kill(`step cap ${stepCap} reached`);
    }
  };
  // A supervisor exception (ensureCodexHome's invariant, a spawn that throws, an unwritable
  // event log) is an abort: it still falls through to the verifier, the record and Focus off.
  try {
    if (cfg.focusOnShortcut) await p.runShortcut(cfg.focusOnShortcut);
    await p.notify(`${label} is taking the screen for: ${req.task.slice(0, 80)}. Hands off.`);

    const spawned = p.spawn(argv, scratch, backend);
    child = spawned;
    if (req.eventLog) writeFileSync(req.eventLog, "");
    spawned.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });

    wallTimer = setTimeout(() => kill(`wall clock ${wall / 1000}s reached`), wall);
    // The allowlist check arms the first time an allowlisted app is frontmost:
    // at spawn the front app is whatever the principal was using.
    let armed = false;
    const inAllow = (name: string) => req.allowlist.some((n) => n.toLowerCase() === name.toLowerCase());
    watcher = setInterval(async () => {
      try {
        const [a, t] = await Promise.all([p.apps(), p.tabs()]);
        const d = scanDenials(cfg, a, t);
        if (d.length) return kill(`deny list mid-run — ${formatDenials(d)}`);
        const front = a.find((x) => x.isActive);
        if (front && inAllow(front.name)) armed = true;
        // Observed 2026-09-07: the Codex Computer Use service drives apps through AX
        // without foregrounding them, so the target may never become frontmost. Not
        // arming is fine; the frontmost rule only binds once the target has been front.
        if (!armed) return;
        if (front && !inAllow(front.name)) return kill(`frontmost app left the allowlist: ${front.name}`);
      } catch (e) {
        kill(`watcher error: ${(e as Error).message}`);
      }
    }, pollMs);

    exitCode = await new Promise((res) => {
      spawned.on("exit", (code) => res(code));
      spawned.on("error", () => res(null));
    });
  } catch (e) {
    kill(`supervisor error: ${(e as Error).message}`);
  } finally {
    clearTimeout(wallTimer);
    clearInterval(watcher);
  }
  if (buf.length) onLine(buf);

  rec.childExitCode = exitCode;
  rec.durationMs = p.now() - start;
  rec.state = killed ? "aborted" : "completed";
  rec.abortReason = abortReason;
  try { rec.astraReport = existsSync(out) ? readFileSync(out, "utf8").slice(0, 4000) : ""; } catch { rec.astraReport = ""; }

  // Every exit path runs the verifier. The verifier alone sets the verdict.
  // A verifier that throws is a failed verifier, and Focus goes off either way.
  let vcode: number;
  try { vcode = await p.runVerifier(req.verifier.command); } catch { vcode = 1; }
  rec = setVerdict(rec, vcode);
  rec.finishedAt = new Date(p.now()).toISOString();

  if (cfg.focusOffShortcut) { try { await p.runShortcut(cfg.focusOffShortcut); } catch { /* best-effort; the record still returns */ } }
  await p.notify(
    rec.state === "aborted"
      ? `${label} run aborted: ${abortReason}. Verifier ${rec.verdict}.`
      : `${label} finished. Verifier ${rec.verdict}.`,
  );

  const code = rec.state === "aborted" ? EXIT.ABORTED : rec.verdict === "pass" ? EXIT.OK : EXIT.FAIL;
  return { exitCode: code, record: rec, message: `${rec.state}; steps=${rec.steps}; verdict=${rec.verdict}${abortReason ? `; abort=${abortReason}` : ""}` };
}

// ── Process tree ─────────────────────────────────────────────────────────────

function childPids(pid: number): number[] {
  const r = Bun.spawnSync(["pgrep", "-P", String(pid)], { stdout: "pipe", stderr: "ignore" });
  return r.stdout.toString().split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Kills `pid` and every descendant. Killing only the actor left the Claude leg's
 * `claude` and in-flight `interceptor` children running past an abort. Each process is
 * stopped before its children are listed, so nothing in the tree can fork a new one
 * between the walk and the kill.
 */
export function killTree(pid: number): void {
  const seen = new Set<number>();
  const freeze = (p: number) => {
    if (seen.has(p)) return;
    seen.add(p);
    try { process.kill(p, "SIGSTOP"); } catch { /* already gone */ }
    for (const c of childPids(p)) freeze(c);
  };
  freeze(pid);
  for (const p of seen) { try { process.kill(p, "SIGKILL"); } catch { /* already gone */ } }
}

// ── Real providers ───────────────────────────────────────────────────────────

async function sh(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, out };
}

function jsonTail(s: string): unknown {
  const i = s.indexOf("{"); const j = s.lastIndexOf("}");
  const k = s.indexOf("["); const l = s.lastIndexOf("]");
  const start = i >= 0 && (k < 0 || i < k) ? i : k;
  const end = start === i ? j : l;
  if (start < 0 || end < 0) throw new Error("no JSON in output");
  return JSON.parse(s.slice(start, end + 1));
}

/**
 * Pure: the bridge is usable for the deny scan only when Accessibility is granted.
 * A re-signed bridge (rebuild, identity change) silently loses its TCC grants: `macos inspect`
 * then returns no apps, the deny scan sees nothing, and the Astra leg would run blind
 * (2026-09-06). Refusing here keeps a TCC reset a "tool broken" exit 4, never a bypass.
 */
export function bridgeTrusted(trust: unknown): boolean {
  const t = trust as { permissions?: { name?: string; granted?: boolean }[] } | null;
  return !!t?.permissions?.some((p) => p?.name === "Accessibility" && p?.granted === true);
}

export const realProviders: Providers = {
  // A failed or malformed inspection throws rather than returning []: an empty list would
  // pass the deny scan, so supervise refuses and the watcher aborts instead.
  async apps() {
    const { code, out } = await sh("interceptor", ["macos", "inspect"]);
    const j = jsonTail(out) as { apps?: AppInfo[] };
    if (code !== 0 || !Array.isArray(j.apps)) throw new Error(`interceptor macos inspect gave no app list (exit ${code})`);
    return j.apps.map((a) => ({ name: a.name, pid: a.pid, isActive: !!a.isActive, isHidden: !!a.isHidden, bundleId: a.bundleId }));
  },
  async tabs() {
    const { code, out } = await sh("interceptor", ["tabs", "--json"]);
    const j = jsonTail(out) as { success?: boolean; data?: TabInfo[] };
    if (code !== 0 || j.success === false || !Array.isArray(j.data)) throw new Error(`interceptor tabs gave no tab list (exit ${code})`);
    return j.data.map((t) => ({ url: t.url, active: !!t.active }));
  },
  async interceptorHealthy() {
    try {
      const { out } = await sh("interceptor", ["status", "--json"]);
      const j = jsonTail(out) as { daemon?: boolean; bridge?: boolean };
      if (!j.daemon || !j.bridge) return false;
      const { out: trust } = await sh("interceptor", ["macos", "trust", "--json"]);
      return bridgeTrusted(jsonTail(trust));
    } catch {
      return false;
    }
  },
  async notify(message) {
    try {
      await fetch("http://localhost:31337/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
    } catch { /* voice is best-effort */ }
  },
  spawn(argv, cwd, backend = "astra") {
    if (backend === "claude") {
      return nodeSpawn("bun", argv, { cwd, stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, LIFEOS_NOTIFICATION_CHANNEL: "headless" } });
    }
    const codexHome = ensureCodexHome();
    return nodeSpawn("codex", argv, { cwd, stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, LIFEOS_NOTIFICATION_CHANNEL: "headless", CODEX_HOME: codexHome } });
  },
  async runVerifier(cmd) {
    // A verifier that never returns (e.g. `shortcuts run` behind a locked screen,
    // 2026-09-07) must not pin the runner forever: cap it and count a timeout as fail.
    // The cap kills the whole tree: killing only bash would leave a hung `shortcuts` child running.
    const proc = Bun.spawn(["bash", "-lc", cmd], { stdout: "inherit", stderr: "inherit" });
    const timer = setTimeout(() => { killTree(proc.pid); try { proc.kill("SIGKILL"); } catch { /* gone */ } }, VERIFIER_TIMEOUT_MS);
    const code = await proc.exited;
    clearTimeout(timer);
    return code;
  },
  async runShortcut(name) {
    const { code } = await sh("shortcuts", ["run", name]);
    return code;
  },
  now: () => Date.now(),
};

// ── CLI ──────────────────────────────────────────────────────────────────────

function usage(): never {
  console.error(`usage: bun Run.ts --task "<what Astra should do>" --app <TargetApp> [--app <Other>] --verify "<shell cmd>" [--verify-kind cli|interceptor]
       [--backend astra|claude] [--model <alias>] [--config <path>] [--step-cap N] [--wall-clock SECONDS] [--poll-ms N] [--scratch DIR] [--dry-run] [--print-prompt] [--hold SECONDS]
exit codes: 0 pass · 1 verifier failed · 2 deny list · 3 headless · 4 interceptor preflight · 5 no verifier · 6 aborted`);
  process.exit(64);
}

function parseArgs(argv: string[]) {
  const a: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) continue;
    const k = t.slice(2);
    const v = argv[i + 1];
    if (k === "app") { (a.app as string[] | undefined) ? (a.app as string[]).push(v) : (a.app = [v]); i++; continue; }
    if (v === undefined || v.startsWith("--")) { a[k] = true; continue; }
    a[k] = v; i++;
  }
  return a;
}

if (import.meta.main) {
  const a = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(typeof a.config === "string" ? resolve(a.config as string) : DEFAULT_CONFIG_PATH);
  const task = typeof a.task === "string" ? a.task : "";
  const apps = (a.app as string[] | undefined) ?? [];
  const verify = typeof a.verify === "string" ? a.verify : "";
  if (a.hold && typeof a.hold === "string") {
    // Focus assertion probe: turn Focus on, hold, turn it off.
    if (cfg.focusOnShortcut) await realProviders.runShortcut(cfg.focusOnShortcut);
    await Bun.sleep(Number(a.hold) * 1000);
    if (cfg.focusOffShortcut) await realProviders.runShortcut(cfg.focusOffShortcut);
    process.exit(0);
  }
  if (a["print-prompt"]) {
    console.log(task);
    console.log(existsSync(INSTRUCTIONS_PATH) ? readFileSync(INSTRUCTIONS_PATH, "utf8") : "");
    process.exit(0);
  }
  if (!task && !a["dry-run"]) usage();
  const req: RunRequest = {
    task: task || "(dry run)",
    allowlist: apps.length ? apps : ["(none)"],
    verifier: { kind: (a["verify-kind"] as "cli" | "interceptor") ?? "cli", command: verify || (a["dry-run"] ? "true" : "") },
    stepCap: typeof a["step-cap"] === "string" ? Number(a["step-cap"]) : undefined,
    wallClockSeconds: typeof a["wall-clock"] === "string" ? Number(a["wall-clock"]) : undefined,
    pollMs: typeof a["poll-ms"] === "string" ? Number(a["poll-ms"]) : undefined,
    scratchDir: typeof a.scratch === "string" ? resolve(a.scratch as string) : undefined,
    dryRun: !!a["dry-run"],
    // No --backend: the scoreboard's pick for the target app (Config vision_pick).
    backend: a.backend === "claude" || a.backend === "astra" ? (a.backend as VisionBackend) : pickFor(cfg, apps[0] ?? ""),
    claudeModel: typeof a.model === "string" ? a.model : undefined,
  };
  invariant(a.backend === undefined || a.backend === "astra" || a.backend === "claude", "--backend must be astra or claude");
  const r = await supervise(req, cfg, realProviders);
  if (r.record && !req.dryRun) {
    const path = writeRecord(r.record);
    console.error(`record: ${path}`);
  }
  console.log(r.message);
  process.exit(r.exitCode);
}
