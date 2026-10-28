#!/usr/bin/env bun
/**
 * @version 1.0.0
 * Bridge.ts — one Codex lifecycle event → the Claude hook registrations of THIS install.
 *
 * Codex registers exactly one command per event in `$CODEX_HOME/hooks.json`:
 *
 *   bun <install>/LIFEOS/CODEX/Bridge.ts <CodexEvent>
 *
 * The bridge reads Codex's stdin payload, shapes it the way Claude Code hooks
 * expect, selects the registrations for that event from the install's
 * `settings.json` AT RUNTIME (so a hook added for Claude fires in Codex on its
 * next turn, with no Codex-side edit and no re-trust), runs them, and folds
 * their answers into one Codex decision.
 *
 * Contract, in order of what matters:
 *   - Fail open on adapter faults, fail closed on decisions. A hook that
 *     crashes, times out or prints garbage is logged and skipped; only an
 *     explicit deny/block from a hook propagates. `stop_hook_active` short-
 *     circuits every Stop path.
 *   - The bridge never emits `allow` on its own. Allow is the absence of deny,
 *     so a silent hook can never widen Codex's sandbox.
 *   - Never set CLAUDE_CONFIG_DIR (it outranks LIFEOS_DIR in Paths.ts and
 *     would redirect writes into a phantom profile).
 *   - Telemetry is metadata only: event, tool, hooks run, decision, ms. Never
 *     prompt text, tool input or tool output.
 *
 * Tool vocabulary: Codex already reports its shell as `Bash` with
 * `tool_input.command`. `apply_patch` carries a whole patch, so it is fanned
 * out into one synthetic `Write` / `Edit` / `Bash rm` input per file — the
 * file guards, ISASync and the checkpoint hook key on `file_path`, and would
 * otherwise never see a Codex edit. Everything else (webrun, collaboration*,
 * update_plan, view_image) passes through under its own name.
 *
 * Install-generic: no home paths, no identity. The install root is derived
 * from this file's location; CODEX_HOME wins when set.
 */

import { existsSync, mkdirSync, appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";

export const INSTALL_ROOT = resolve(import.meta.dir, "..", "..");
export const LIFEOS_DIR = join(INSTALL_ROOT, "LIFEOS");
export const SETTINGS_PATH = join(INSTALL_ROOT, "settings.json");
export const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
export const STATE_DIR = join(LIFEOS_DIR, "USER", "CODEX");

export const CODEX_EVENTS = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse",
  "PermissionRequest", "PreCompact", "PostCompact", "SubagentStart", "SubagentStop", "Stop",
] as const;
export type CodexEvent = (typeof CODEX_EVENTS)[number];

/** Seconds the whole bridge may take per event — mirrored into hooks.json by Mount.ts. */
export const EVENT_BUDGET_S: Record<CodexEvent, number> = {
  // Codex clamps SessionEnd hooks to 3 s (observed 2026-09-08: "warning: clamping SessionEnd hook
  // timeout to 3s"), so the bridge fires every SessionEnd registration detached and returns at once.
  SessionStart: 30, SessionEnd: 3, UserPromptSubmit: 45, PreToolUse: 20, PostToolUse: 20,
  PermissionRequest: 10, PreCompact: 10, PostCompact: 15, SubagentStart: 10, SubagentStop: 20, Stop: 60,
};

/** Events whose plain stdout (or additionalContext) reaches the model. */
const CONTEXT_EVENTS = new Set<CodexEvent>(["SessionStart", "UserPromptSubmit", "PostToolUse", "SubagentStart", "PostCompact"]);
/** Events where a hook may say `decision: block`. */
const BLOCK_EVENTS = new Set<CodexEvent>(["UserPromptSubmit", "PostToolUse", "SubagentStop", "Stop"]);

/**
 * Claude hooks that exist to maintain Claude's own settings or terminal. They
 * have no meaning under Codex and are skipped BY NAME, with the reason here:
 *   SettingsBackport / MergeSettings — regenerate settings.json (Claude-only file)
 *   HookHealer                        — repairs Claude's hook registrations
 *   KittyEnvPersist / TabState        — kitty tab titles keyed on the Claude session
 *   ContextReduction                  — rewrites the Bash command via updatedInput; deferred
 *                                       until that contract is verified against Codex (ISA fog)
 */
// The maintainer-side model-router hook is skipped for good (2026-10-16, native-unblock): Codex runs no model router.
export const SKIP_LIST = /(SettingsBackport|MergeSettings|HookHealer|KittyEnvPersist|TabState\.hook|ContextReduction|DispatchAdvisor)/; // DispatchAdvisor is a maintainer-side hook, not shipped in the public release

export interface HookEntry { type: "command" | "http"; command?: string; url?: string; timeout?: number; async?: boolean; onFailure?: "continue" | "block" }

export interface Registration { matcher?: string; hooks: HookEntry[] }
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Input = Record<string, unknown>;

export interface HookResult {
  name: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export interface Decision {
  deny?: string;          // PreToolUse / PermissionRequest
  block?: string;         // block-capable events
  stop?: string;          // continue:false
  contexts: string[];
  systemMessages: string[];
  updatedInput?: Json;
}

// ── settings ─────────────────────────────────────────────────────────────────

export interface Settings { env: Record<string, string>; hooks: Record<string, Registration[]>; allowedHttpHookUrls: string[]; permissions: { deny: string[]; ask: string[] }; loadError?: string }

export function loadSettings(path = SETTINGS_PATH): Settings {
  try {
    const text = readFileSync(path, "utf8");
    const raw = (text.trim() ? JSON.parse(text) : {}) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("settings must be an object");
    if (raw.permissions !== undefined) {
      const permissions = raw.permissions as Record<string, unknown>;
      if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) throw new Error("invalid permissions");
      for (const key of ["deny", "ask"]) {
        const value = permissions[key];
        if (value !== undefined && (!Array.isArray(value) || value.some((r) => typeof r !== "string"))) throw new Error(`invalid permissions.${key}`);
      }
    }
    return {
      env: (raw.env as Record<string, string>) ?? {},
      hooks: (raw.hooks as Record<string, Registration[]>) ?? {},
      allowedHttpHookUrls: (raw.allowedHttpHookUrls as string[]) ?? [],
      permissions: {
        deny: ((raw.permissions as Record<string, unknown>)?.deny as string[]) ?? [],
        ask: ((raw.permissions as Record<string, unknown>)?.ask as string[]) ?? [],
      },
    };
  } catch (e) {
    // Codex keeps its adapter-fault contract.
    return { env: {}, hooks: {}, allowedHttpHookUrls: [], permissions: { deny: [], ask: [] },
      ...((e as NodeJS.ErrnoException).code === "ENOENT" ? {} : { loadError: "settings.json unreadable or invalid" }) };
  }
}

/** The field a Claude matcher is tested against, per event. */
export function matcherSubject(event: CodexEvent, input: Input): string {
  switch (event) {
    case "PreToolUse": case "PostToolUse": case "PermissionRequest": return String(input.tool_name ?? "");
    case "SessionStart": return String(input.source ?? "");
    case "PreCompact": case "PostCompact": return String(input.trigger ?? "");
    case "SubagentStart": case "SubagentStop": return String(input.agent_type ?? "");
    case "SessionEnd": return String(input.reason ?? "");
    default: return "";
  }
}

/** Claude semantics: an absent/empty matcher matches everything; otherwise a full-match regex. */
export function matcherHits(matcher: string | undefined, subject: string): boolean {
  if (!matcher || matcher === "*" || matcher === ".*") return true;
  try { return new RegExp(`^(?:${matcher})$`).test(subject); } catch { return matcher === subject; }
}

export function hookName(h: HookEntry): string {
  if (h.type === "http") return h.url ?? "http";
  const cmd = h.command ?? "";
  const m = /([A-Za-z0-9_.-]+\.(?:hook\.ts|hook\.sh|ts|sh))\b/.exec(cmd);
  return m?.[1] ?? cmd.slice(0, 60);
}

export function selectRegistrations(settings: Settings, event: CodexEvent, input: Input): HookEntry[] {
  const regs = settings.hooks[event] ?? [];
  const subject = matcherSubject(event, input);
  const out: HookEntry[] = [];
  for (const reg of regs) {
    if (!matcherHits(reg.matcher, subject)) continue;
    for (const h of reg.hooks ?? []) {
      if (h.type === "command" && SKIP_LIST.test(h.command ?? "")) {
        // Pulse has a native tab-state destination; preserve Kitty-only skips elsewhere.
        const pulse = /^pulse-[a-f0-9]{32}$/.test(process.env.PULSE_TERMINAL_ID ?? '') || /\/pulse-desktop,\d+,\d+$/.test(process.env.TMUX ?? '');
        if (!(pulse && /TabState\.hook/.test(h.command ?? ""))) continue;
      }
      out.push(h);
    }
  }
  return out;
}

// ── input shaping ────────────────────────────────────────────────────────────

export interface PatchOp { op: "add" | "update" | "delete" | "move"; path: string; body: string; to?: string }

/** Parse the apply_patch envelope into per-file operations. */
export function parseApplyPatch(patch: string): PatchOp[] {
  const ops: PatchOp[] = [];
  let cur: PatchOp | null = null;
  for (const line of patch.split("\n")) {
    const head = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (head) {
      cur = { op: head[1].toLowerCase() as PatchOp["op"], path: head[2].trim(), body: "" };
      ops.push(cur);
      continue;
    }
    const mv = /^\*\*\* Move to: (.+)$/.exec(line);
    if (mv && cur) { cur.to = mv[1].trim(); continue; }
    if (/^\*\*\* (Begin|End) Patch/.test(line)) { cur = null; continue; }
    if (cur) cur.body += (cur.body ? "\n" : "") + line;
  }
  return ops;
}

function patchText(input: Input): string | null {
  const ti = input.tool_input as Record<string, unknown> | undefined;
  for (const k of ["command", "patch", "input"]) {
    const v = ti?.[k];
    if (typeof v === "string" && v.includes("*** Begin Patch")) return v;
  }
  if (Array.isArray(ti?.command)) {
    const joined = (ti!.command as unknown[]).map(String).join("\n");
    if (joined.includes("*** Begin Patch")) return joined;
  }
  return null;
}

/** Strip patch hunk markers so the guards see the authored text, not the diff syntax. */
function hunkToText(body: string): string {
  return body.split("\n").filter((l) => !l.startsWith("@@") && !l.startsWith("-")).map((l) => l.replace(/^\+/, "")).join("\n");
}

/**
 * Build the Claude-shaped input(s) for a Codex payload. One input for every
 * tool but `apply_patch`, which fans out per file. Returns [] only for an
 * `apply_patch` with no file operations, which is nothing the guards can judge.
 */
export function buildClaudeInputs(event: CodexEvent, codex: Input, cwd: string): Input[] {
  const base: Input = { ...codex, hook_event_name: event, cwd: codex.cwd ?? cwd, codex_transcript_path: codex.transcript_path ?? null };
  if (codex.tool_name !== "apply_patch") return [base];
  const patch = patchText(codex);
  if (!patch) return [base];
  const ops = parseApplyPatch(patch);
  const abs = (p: string) => resolve(String(base.cwd), p);
  return ops.map((o) => {
    if (o.op === "add") return { ...base, tool_name: "Write", tool_input: { file_path: abs(o.path), content: hunkToText(o.body) }, codex_tool_name: "apply_patch" };
    // A delete, and the source of a move, removes a file: `codex_patch_removes` names it so the
    // permission mirror judges it under Edit rules, as Claude's file tools would be.
    if (o.op === "delete") return { ...base, tool_name: "Bash", tool_input: { command: `rm ${abs(o.path)}` }, codex_tool_name: "apply_patch", codex_patch_removes: abs(o.path) };
    const target = o.to ? abs(o.to) : abs(o.path);
    return { ...base, tool_name: "Edit", tool_input: { file_path: target, old_string: "", new_string: hunkToText(o.body) }, codex_tool_name: "apply_patch", ...(o.to ? { codex_patch_removes: abs(o.path) } : {}) };
  });
}

/**
 * Claude hooks refuse input without a string `transcript_path` (hook-io.ts).
 * Codex's is nullable and, when present, not in Claude's JSONL shape. The
 * bridge keeps a Claude-shaped shadow transcript per session in the state
 * dir — the user prompt on UserPromptSubmit, the assistant text on Stop — and
 * points every hook at it. Mode 0600; the state dir is 0700.
 */
export function shadowTranscriptPath(sessionId: string, stateDir = STATE_DIR): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "unknown";
  return join(stateDir, "transcripts", `${safe}.jsonl`);
}

export function appendShadowTranscript(event: CodexEvent, input: Input, stateDir = STATE_DIR): string {
  const path = shadowTranscriptPath(String(input.session_id ?? "unknown"), stateDir);
  ensureStateDir(stateDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let line: string | null = null;
  const ts = new Date().toISOString();
  if (event === "UserPromptSubmit" && typeof input.prompt === "string") {
    line = JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "text", text: input.prompt }] } });
  } else if ((event === "Stop" || event === "SubagentStop") && typeof input.last_assistant_message === "string") {
    line = JSON.stringify({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: input.last_assistant_message }] } });
  }
  if (line) appendFileSync(path, line + "\n", { mode: 0o600 });
  else if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return path;
}

export function ensureStateDir(stateDir = STATE_DIR): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try { chmodSync(stateDir, 0o700); } catch { /* best effort */ }
}

// ── running hooks ────────────────────────────────────────────────────────────

export function childEnv(settings: Settings, cwd: string, input?: Input): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const [k, v] of Object.entries(settings.env)) if (k !== "CLAUDE_CONFIG_DIR") env[k] = v;
  env.LIFEOS_DIR ??= LIFEOS_DIR;
  // every Claude hook is `#!/usr/bin/env bun`; a Codex.app session may carry no bun on PATH
  env.PATH = `${dirname(process.execPath)}:${env.PATH ?? "/usr/bin:/bin"}`;
  env.CLAUDE_PROJECT_DIR = cwd;
  env.LIFEOS_HARNESS = "codex";
  env.LIFEOS_SESSION_PROVIDER = "Codex";
  const model = typeof input?.model === "string"
    ? input.model
    : input?.model && typeof input.model === "object" && typeof (input.model as Record<string, unknown>).id === "string"
      ? (input.model as Record<string, string>).id
      : undefined;
  if (model?.trim()) env.LIFEOS_SESSION_MODEL = model.trim();
  env.CODEX_HOME = CODEX_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

/**
 * Claude Code's `onFailure: "block"` (2.1.295): a hook that cannot start, times out or exits
 * with a code other than 0 or 2 blocks the action instead of letting it through. Both bridges
 * run hooks through the two runners below, so the field means the same thing on every door.
 */
export function applyOnFailure(h: HookEntry, r: HookResult): HookResult {
  if (h.onFailure !== "block") return r;
  const failed = r.error || r.timedOut || (r.exitCode !== 0 && r.exitCode !== 2);
  if (!failed) return r;
  const why = r.timedOut ? "timed out" : `failed (${r.error ?? `exit ${r.exitCode}`})`;
  return { ...r, exitCode: 2, error: undefined, timedOut: false, stderr: `${r.name} ${why}; blocking because onFailure is "block"\n${r.stderr}`.trim() };
}

export function runCommandHook(h: HookEntry, input: Input, env: Record<string, string>, timeoutMs: number): Promise<HookResult> {
  const name = hookName(h);
  return new Promise((done) => {
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const finish = (r: HookResult) => { if (!settled) { settled = true; done(applyOnFailure(h, r)); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/bin/sh", ["-c", h.command ?? "true"], { cwd: String(input.cwd ?? process.cwd()), env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return finish({ name, exitCode: null, stdout: "", stderr: "", timedOut: false, error: String(e) });
    }
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); finish({ name, exitCode: null, stdout, stderr, timedOut, error: String(e) }); });
    child.on("close", (code) => { clearTimeout(timer); finish({ name, exitCode: code, stdout, stderr, timedOut }); });
    try { child.stdin?.end(JSON.stringify(input)); } catch { /* hook closed stdin early */ }
  });
}

export function spawnDetached(h: HookEntry, input: Input, env: Record<string, string>): void {
  try {
    const child = spawn("/bin/sh", ["-c", h.command ?? "true"], { cwd: String(input.cwd ?? process.cwd()), env, stdio: ["pipe", "ignore", "ignore"], detached: true });
    child.stdin?.end(JSON.stringify(input));
    child.unref();
  } catch { /* async hooks are best effort */ }
}

export async function runHttpHook(h: HookEntry, input: Input, allowed: string[], timeoutMs: number): Promise<HookResult> {
  const name = hookName(h);
  const url = h.url ?? "";
  const ok = allowed.some((pat) => pat.endsWith("*") ? url.startsWith(pat.slice(0, -1)) : url === pat);
  if (!ok) return applyOnFailure(h, { name, exitCode: null, stdout: "", stderr: "", timedOut: false, error: "url not in allowedHttpHookUrls" });
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    return applyOnFailure(h, { name, exitCode: res.ok ? 0 : 1, stdout: text, stderr: "", timedOut: false });
  } catch (e) {
    return applyOnFailure(h, { name, exitCode: null, stdout: "", stderr: "", timedOut: /timeout|abort/i.test(String(e)), error: String(e) });
  }
}

// ── merging ──────────────────────────────────────────────────────────────────

function parseJsonObject(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { /* fall through */ }
  const last = t.split("\n").reverse().find((l) => l.trim().startsWith("{"));
  if (!last) return null;
  try { const v = JSON.parse(last); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
}

export function mergeResults(event: CodexEvent, results: HookResult[]): Decision {
  const d: Decision = { contexts: [], systemMessages: [] };
  for (const r of results) {
    if (r.error || r.timedOut || r.exitCode === null) continue;            // adapter fault: fail open
    if (r.exitCode === 2) {                                                // Claude's block-by-exit contract
      const reason = r.stderr.trim() || `${r.name} blocked`;
      if (event === "PreToolUse" || event === "PermissionRequest") d.deny ??= reason;
      else if (BLOCK_EVENTS.has(event)) d.block ??= reason;
      continue;
    }
    if (r.exitCode !== 0) continue;                                        // other non-zero: logged upstream, ignored
    const json = parseJsonObject(r.stdout);
    if (!json) {
      if (CONTEXT_EVENTS.has(event) && r.stdout.trim()) d.contexts.push(r.stdout.trim());
      continue;
    }
    const hso = json.hookSpecificOutput as Record<string, unknown> | undefined;
    if (typeof hso?.additionalContext === "string" && hso.additionalContext.trim()) d.contexts.push(hso.additionalContext.trim());
    if (hso?.permissionDecision === "deny") d.deny ??= String(hso.permissionDecisionReason ?? `${r.name} denied`);
    if (hso?.updatedInput && typeof hso.updatedInput === "object") d.updatedInput ??= hso.updatedInput as Json;
    if (json.decision === "block") d.block ??= String(json.reason ?? `${r.name} blocked`);
    if (json.continue === false) d.stop ??= String(json.stopReason ?? `${r.name} stopped the turn`);
    if (typeof json.systemMessage === "string") d.systemMessages.push(json.systemMessage);
  }
  return d;
}

export function toCodexOutput(event: CodexEvent, d: Decision): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (event === "PreToolUse" && d.deny) {
    out.hookSpecificOutput = { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: d.deny };
  } else if (event === "PermissionRequest" && d.deny) {
    out.hookSpecificOutput = { hookEventName: event, decision: { behavior: "deny", message: d.deny } };
  } else if (BLOCK_EVENTS.has(event) && d.block) {
    out.decision = "block";
    out.reason = d.block;
  }
  if (!out.hookSpecificOutput && d.contexts.length) {
    out.hookSpecificOutput = { hookEventName: event, additionalContext: d.contexts.join("\n\n") };
  }
  if (event === "PreToolUse" && d.updatedInput && !d.deny) {
    out.hookSpecificOutput = { ...(out.hookSpecificOutput as object ?? { hookEventName: event }), updatedInput: d.updatedInput };
  }
  if (d.stop) { out.continue = false; out.stopReason = d.stop; }
  if (d.systemMessages.length) out.systemMessage = d.systemMessages.join("\n");
  return out;
}

// ── the built-in Stop check ──────────────────────────────────────────────────

/** The DA's display name, read from the install's identity file; "{{DA_NAME}}"-shaped default only when the file is absent. */
export function daName(lifeosDir = LIFEOS_DIR): string {
  try {
    const t = readFileSync(join(lifeosDir, "USER", "DIGITAL_ASSISTANT", "DA_IDENTITY.md"), "utf8");
    const m = /\*\*Name:\*\*\s*([A-Za-z][A-Za-z0-9_-]*)/.exec(t);
    if (m) return m[1];
  } catch { /* absent identity file */ }
  return "DA";
}

/**
 * The harness-independent frame check: closer last, CHANGE paired
 * with VERIFY. The banner is not required since system prompt v3.16.0 (2026-10-01).
 */
export function builtinStopCheck(input: Input, name: string): string | null {
  if (input.stop_hook_active) return null;
  const msg = typeof input.last_assistant_message === "string" ? input.last_assistant_message.trim() : "";
  if (!msg) return null;
  const problems: string[] = [];
  if (!new RegExp(`(?:^|\\n)🗣️ ${name}: [^\\n]+$`).test(msg)) problems.push(`end with a one-line 🗣️ ${name}: closer`);
  if (msg.includes("🔧 CHANGE:") && !msg.includes("✅ VERIFY:")) problems.push("pair CHANGE with concrete VERIFY evidence");
  return problems.length ? `Re-emit the response in the LifeOS output format: ${problems.join("; ")}. Keep the substance, fix the frame.` : null;
}

// ── the built-in prompt check ────────────────────────────────────────────────

/**
 * A raw credential pasted into a Codex prompt leaves the machine in Codex's
 * transcript and request logs. The previous Codex port blocked these shapes
 * at prompt submit; the Claude Safety hook does not (it frames external
 * content), so the bridge keeps the check. It runs before the shadow
 * transcript and the hooks, so nothing about the match is echoed or logged —
 * the block reason names the shape, never the value.
 */
const SECRET_SHAPES: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i,
  /\b(?:sk|rk|pk)-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abpr]-[A-Za-z0-9-]{20,}\b/,
  /\b(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_KEY|PASSWORD)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i,
];

export function containsLikelySecret(text: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(text));
}

export function builtinPromptCheck(input: Input): string | null {
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (!prompt || !containsLikelySecret(prompt)) return null;
  return "The prompt looks like it contains a raw credential (private key, API key or token shape). Codex transcripts and request logs would carry it. Remove the secret — reference it by name or env var instead — and resend.";
}

// ── permission mirror ────────────────────────────────────────────────────────
//
// Claude's `permissions.deny` / `permissions.ask` rules are not hooks: they are
// what stops `cat ~/.claude/.env` and a file-tool write under /etc. Codex has no
// reader for them, so a hooks-only bridge would leave a Codex session freer than
// Claude on exactly the deterministic controls. The bridge applies the same
// rules to every Claude-shaped PreToolUse input, with Claude's own scope: Write/Edit
// rules judge the file tools (and apply_patch, which fans out to them), while a
// shell command is judged by Bash rules and by Read rules on the paths it names.
// An Edit(/etc/**) rule does not see `echo x > /etc/y` in Claude either, so a
// shell write to such a path needs its own Bash deny rule. A shell Read of an ask-listed
// path becomes a deny with the rule named: Codex sessions run auto-approved,
// so "ask" has no one to ask.

export interface PermissionRule { tool: string; pattern: string; source: string }

export function parsePermissionRule(rule: string): PermissionRule | null {
  const m = /^([A-Za-z]+)\((.*)\)$/.exec(rule.trim());
  return m ? { tool: m[1], pattern: m[2], source: rule } : null;
}

function tildeForm(s: string): string {
  const home = homedir();
  return s.replaceAll("$HOME", "~").replaceAll(home, "~");
}

/** Claude rule glob → regex over the tilde-normalized subject. */
export function ruleRegex(pattern: string, kind: "path" | "command"): RegExp {
  const esc = (t: string) => t.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  let out = "";
  const p = tildeForm(pattern);
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "*" && p[i + 1] === "*") { out += ".*"; i++; continue; }
    if (p[i] === "*") { out += kind === "path" ? "[^/]*" : ".*"; continue; }
    out += esc(p[i]);
  }
  // a Bash rule without a wildcard binds the whole simple command; trailing args are still that command.
  // Paths match case-insensitively: the default APFS volume is case-insensitive, so ~/.claude/.ENV opens .env.
  return new RegExp(kind === "command" ? `^${out}(?:\\s.*)?$` : `^${out}$`, kind === "path" ? "i" : "");
}

/**
 * Does a path rule cover anything strictly below a directory? For content-
 * reading search tools (Grep) whose subject is a directory: grepping ~/.ssh
 * reads every key under it. Deep-glob rules (a `**` segment) are not folded in;
 * they would deny every search of the install for `~/.claude/**` + `.env`, and
 * the direct-path match plus rg's own ignore rules cover that case.
 */
export function ruleCoversBelow(pattern: string, subjectDir: string): boolean {
  const rs = tildeForm(pattern).split("/").filter(Boolean);
  const ss = tildeForm(subjectDir).replace(/\/+$/, "").split("/").filter(Boolean);
  if (rs.includes("**") || rs.length <= ss.length) return false;
  for (let i = 0; i < ss.length; i++) if (!ruleRegex(rs[i], "path").test(ss[i])) return false;
  return true;
}

/** Simple commands inside one shell line: split on ; && || | newlines and subshell edges (backtick, `$(`, `)`). Quotes are not parsed; over-matching is the safe error. */
export function shellSegments(command: string): string[] {
  return command.split(/\s*(?:;|&&|\|\||\||\n|`|\$\(|\))\s*/).map((s) => s.trim()).filter(Boolean);
}

/**
 * The argument tokens of one shell segment, normalised the way a rule path is:
 * quotes, backticks and brackets stripped, `VAR=` and `if=` prefixes dropped (an
 * assignment or a dd operand still names the file), backslash escapes removed.
 * A token carrying an unquoted glob comes back as a regex so `~/.claude/.en?` (runtime glob example; not shipped)
 * is tested against the rule's literal path.
 */
export function pathTokens(segment: string): Array<string | RegExp> {
  const out: Array<string | RegExp> = [];
  // every word, the command word included: `f=~/x` is a one-word segment whose only token is the path
  for (const raw of segment.split(/[\s<>]+/)) {
    let t = raw.replace(/^[`"'([]+|[`"')\],;]+$/g, "").replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "").replace(/\\(.)/g, "$1");
    t = tildeForm(t);
    if (!t) continue;
    if (/[?*[]/.test(t)) {
      const esc = t.replace(/[.+^$(){}|\\[\]]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
      try { out.push(new RegExp(`^${esc}$`, "i")); continue; } catch { /* fall through as literal */ }
    }
    out.push(t);
  }
  return out;
}

const SEARCH_TOOLS = new Set(["Grep", "Glob", "LS"]);
const KNOWN_TOOLS = new Set(["Bash", "Write", "Edit", "Read", ...SEARCH_TOOLS]);

/** Commands that read or copy file CONTENTS of everything under a directory they're pointed at
 *  (an archive, a recursive copy), OR relocate/alias a path out from under itself (`mv`, `ln`,
 *  `ditto` — moving or symlinking a Read-ruled directory out is itself a read of it). A directory
 *  operand under one of these is treated the same as a Grep of that directory — a Read-ruled path
 *  strictly below it makes the whole call deny. A names-only command (`ls`, `find` with no
 *  `-exec`/`-execdir`/`-delete`) never triggers this: it reveals filenames, not contents, and the
 *  pre-existing "ls lists names, never folds a below-rule" contract holds. */
const ARCHIVE_OR_RECURSIVE_COPY_TOOLS = new Set(["tar", "zip", "7z", "7za", "gzip", "bzip2", "xz", "zstd", "cp", "scp", "rsync", "cpio", "dd", "mv", "ln", "ditto"]);

/** grep-family tools read file CONTENTS below whatever directory they're pointed at, the same as
 *  an archive command — folded the same way, wherever the word appears on the line (not just as
 *  the command word: `git -C ~/.ssh grep -r . --no-index` carries "grep" as a later word). */
const CONTENT_READER_CMDS = new Set(["grep", "egrep", "fgrep", "rg", "ag"]);
/** `find`'s content-touching actions: each visits (and for `-exec`/`-execdir`, reads or runs
 *  arbitrary commands against) every file below the search root, unlike a plain `find` listing. */
const FIND_CONTENT_ACTIONS = new Set(["-exec", "-execdir", "-delete"]);

/** One level of brace expansion (`{a,b}` → two words, comma required — bash never expands a
 *  single bare `{x}`). No nesting: a Read-ruled directory reached through nested braces is still
 *  caught by the archive/content-reader fold, which does not need the operand itself expanded. */
export function expandBraces(word: string): string[] {
  const m = /^([^{}]*)\{([^{}]*,[^{}]*)\}([^{}]*)$/.exec(word);
  if (!m) return [word];
  const [, pre, body, post] = m;
  return body.split(",").map((part) => `${pre}${part}${post}`);
}

const SEG_WILD = /[*?[]/;
function segRegex(seg: string): RegExp {
  let out = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") { const end = seg.indexOf("]", i + 1); if (end > i) { out += "[" + seg.slice(i + 1, end).replace(/\\/g, () => "\\\\") + "]"; i = end; } else out += "\\["; }
    else out += c.replace(/[.+^${}()|\]\\]/g, (m) => "\\" + m);
  }
  return new RegExp("^" + out + "$", "i");
}
/** Could these two single path segments name the same entry? Exact when either is literal;
 *  when both carry wildcards, conservative on their fixed prefixes. */
function segOverlap(a: string, b: string): boolean {
  // First argument is the shell operand. A leading wildcard never expands to a dotfile (bash and
  // zsh both leave dotglob off), so `*.md` cannot name `.env.md`.
  if (/^[*?[]/.test(a) && b.startsWith(".")) return false;
  const aw = SEG_WILD.test(a), bw = SEG_WILD.test(b);
  if (!aw && !bw) return a.toLowerCase() === b.toLowerCase();
  if (!aw) return segRegex(b).test(a);
  if (!bw) return segRegex(a).test(b);
  const ap = a.split(SEG_WILD, 1)[0].toLowerCase(), bp = b.split(SEG_WILD, 1)[0].toLowerCase();
  return ap.startsWith(bp) || bp.startsWith(ap);
}
/** Could a shell glob operand expand to a path this rule covers? Segment-wise, so a glob under
 *  the install no longer collides with every rule that merely shares the install prefix.
 *  `below`: the operand is a directory whose whole subtree is read (archive tools). */
export function globMayMatchRule(operand: string, rulePattern: string, below = false): boolean {
  const op = tildeForm(operand).split("/"), rule = tildeForm(rulePattern).split("/");
  const first = rule.indexOf("**"), last = rule.lastIndexOf("**");
  if (first < 0) {
    if (below ? op.length >= rule.length : op.length !== rule.length) return false;
    return op.every((s, i) => segOverlap(s, rule[i]));
  }
  const head = rule.slice(0, first), tail = rule.slice(last + 1);
  // Deep-glob rules never fold below a directory, exactly as ruleCoversBelow decides for a plain
  // operand: otherwise every archive or grep of a glob anywhere under the rule head would match.
  if (below) return false;
  if (op.length < head.length + tail.length) return false;
  return head.every((s, i) => segOverlap(op[i], s)) && tail.every((s, i) => segOverlap(op[op.length - tail.length + i], s));
}

export function builtinPermissionCheck(input: Input, permissions: Settings["permissions"]): { deny: string; rule: string; effect: "deny" | "ask" } | null {
  const tool = String(input.tool_name ?? "");
  const ti = (input.tool_input ?? {}) as Record<string, unknown>;
  const rules = [
    ...permissions.deny.map((r) => ({ r, effect: "deny" as const })),
    ...permissions.ask.map((r) => ({ r, effect: "ask" as const })),
  ];
  // Codex has no one to ask, so both effects deny there. `effect` is kept so a harness with a UI
  // could open a confirm dialog on "ask" instead of refusing outright.
  const reason = (rule: string, effect: "deny" | "ask") =>
    effect === "deny"
      ? `Denied by the install's permission rule \`${rule}\` (settings.json permissions.deny), mirrored into Codex by the LifeOS bridge.`
      : `This needs the principal's yes in Claude (settings.json permissions.ask rule \`${rule}\`); Codex sessions are auto-approved, so the bridge refuses instead. Do it from Claude Code, or reference the value by name.`;

  // An apply_patch delete or move removes a file the synthetic input does not name as its
  // file_path; the removed path answers to Edit rules before the input's own check.
  if (typeof input.codex_patch_removes === "string") {
    const hit = builtinPermissionCheck({ tool_name: "Edit", tool_input: { file_path: input.codex_patch_removes } }, permissions);
    if (hit) return hit;
  }

  if (tool === "Bash" && typeof ti.command === "string") {
    const whole = tildeForm(ti.command);
    const segs = [whole, ...shellSegments(whole)]; // a rule with its own pipe (curl * | sh) matches the whole line
    // Keep the original subjects as well: this can only add denials. A cd changes
    // subsequent relative operands, even when no filesystem entry exists yet.
    let cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
    const CURRENT_USER = userInfo().username;
    // `${HOME}`/`$HOME` and, for the current user only, `~user` are resolved to the literal home
    // directory (or plain `~`) BEFORE resolve(), same as the bare `~`/`~/` forms already were —
    // resolve() only recognizes a leading `/`, so these spellings would otherwise be treated as
    // relative to cwd instead of absolute.
    const expandHome = (p: string) => {
      let s = p.replace(/\$\{HOME\}/g, homedir()).replace(/\$HOME\b/g, homedir());
      if (CURRENT_USER) {
        const esc = CURRENT_USER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        s = s.replace(new RegExp(`^~${esc}(?=/|$)`), "~");
      }
      return s === "~" ? homedir() : s.startsWith("~/") ? join(homedir(), s.slice(2)) : s;
    };
    const operands: string[] = [];
    const archiveOperands: string[] = []; // operands of an archive/recursive-copy/content-reader/relocation command — see ARCHIVE_OR_RECURSIVE_COPY_TOOLS, CONTENT_READER_CMDS, FIND_CONTENT_ACTIONS
    for (const segment of shellSegments(whole)) {
      const words = segment.split(/[\s<>]+/).map((w) => w.replace(/^["']|["']$/g, () => ""));
      // `cd`/`pushd` as the first word of a segment, or right after a subshell's leading `(` (shell
      // splitting already breaks `(cd ~/.ssh; cat id_ed25519)` into segments "(cd ~/.ssh" and "cat
      // id_ed25519" at the `;`/`)` boundaries).
      const cdWord = (words[0] ?? "").replace(/^\(+/, "");
      if ((cdWord === "cd" || cdWord === "pushd") && words[1]) cwd = resolve(expandHome(cwd), expandHome(words[1].replace(/^\(+/, "")));
      let cmdIdx = 0;
      while (cmdIdx < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[cmdIdx] ?? "")) cmdIdx++;
      const cmdWord = words[cmdIdx]?.replace(/^.*\//, ""); // basename: /usr/bin/tar → tar
      const hasContentReaderWord = words.some((w) => CONTENT_READER_CMDS.has(w.replace(/^.*\//, "")));
      const hasFindContentAction = cmdWord === "find" && words.some((w) => FIND_CONTENT_ACTIONS.has(w));
      const isArchiveCmd = (cmdWord ? ARCHIVE_OR_RECURSIVE_COPY_TOOLS.has(cmdWord) : false) || hasContentReaderWord || hasFindContentAction;
      // A copy/move/link tool's last operand is where it writes (or the new link name), and an
      // extracting tar reads the archive, not the target directory: neither reads the subtree, so
      // neither folds (`cp notes.md ~` is ordinary). `mv`/`ln`/`ditto` relocate or alias their
      // FIRST operand(s) instead — the destination is excluded the same way a copy's is.
      const pathWords = words.filter((w) => w && !w.startsWith("-") && !/^\[{1,2}$|^\]{1,2}$/.test(w) && !w.includes("://"));
      const copyDest = cmdWord && ["cp", "scp", "rsync", "mv", "ln", "ditto"].includes(cmdWord) ? pathWords[pathWords.length - 1] : undefined;
      const tarExtract = cmdWord === "tar" && /^-?[A-Za-z]*x/.test(words[cmdIdx + 1] ?? "") && !/^-?[A-Za-z]*c/.test(words[cmdIdx + 1] ?? "");
      for (const rawWord of pathWords) {
        for (const word of expandBraces(rawWord)) {
          const abs = tildeForm(resolve(expandHome(cwd), expandHome(word)));
          operands.push(abs);
          if (isArchiveCmd && !tarExtract && rawWord !== copyDest) archiveOperands.push(abs);
        }
      }
    }
    for (const { r, effect } of rules) {
      const pr = parsePermissionRule(r);
      if (!pr) continue;
      if (pr.tool === "Bash") {
        const re = ruleRegex(pr.pattern, "command");
        if (segs.some((s) => re.test(s))) return { deny: reason(r, effect), rule: r, effect };
      } else if (pr.tool === "Read") {
        // a Read-ruled path named anywhere on the line. The reader is not enumerated (cat, dd if=, $f after
        // f=…, a backtick subshell all read it): any token that is the path, or a glob that could be, denies.
        // Over-matching (ls -la of the path) is the safe error.
        const re = ruleRegex(pr.pattern, "path");
        const literal = tildeForm(pr.pattern);
        for (const operand of operands) {
          if (re.test(operand)) return { deny: reason(r, effect), rule: r, effect };
          // Glob/rule overlap is conservatively denied by their fixed prefixes.
          // No expansion reads private directory entries; wildcard rules are not exempt.
          if (SEG_WILD.test(operand) && globMayMatchRule(operand, pr.pattern)) return { deny: reason(r, effect), rule: r, effect };
        }
        // An archive/recursive-copy command pointed at a directory reads everything below it,
        // the same as a Grep of that directory (ISC-25 W2: `tar cf - ~/.ssh`). A names-only
        // command (ls, plain find) is never in ARCHIVE_OR_RECURSIVE_COPY_TOOLS, so this never
        // fires for those — see the constant's own comment.
        for (const operand of archiveOperands) {
          if (SEG_WILD.test(operand) ? globMayMatchRule(operand, pr.pattern, true) : ruleCoversBelow(pr.pattern, operand)) return { deny: reason(r, effect), rule: r, effect };
        }
        for (const s of segs) {
          for (const t of pathTokens(s)) {
            const hit = t instanceof RegExp ? (!/[*?]/.test(literal) && t.test(literal)) : re.test(t);
            if (hit) return { deny: reason(r, effect), rule: r, effect };
          }
        }
      }
    }
    return null;
  }

  if ((tool === "Write" || tool === "Edit" || tool === "Read") && typeof ti.file_path === "string") {
    const subject = tildeForm(ti.file_path);
    for (const { r, effect } of rules) {
      const pr = parsePermissionRule(r);
      if (!pr) continue;
      const applies = pr.tool === tool || (pr.tool === "Edit" && tool === "Write");
      if (!applies) continue;
      if (ruleRegex(pr.pattern, "path").test(subject)) return { deny: reason(r, effect), rule: r, effect };
    }
    return null;
  }

  // search tools: the subject is a path under Read rules; a Grep of a directory reads everything
  // below it (content), so a Read-ruled path strictly under the grepped directory denies. Glob
  // (find) and LS are names-only — they never read file contents — so `ruleCoversBelow` stays
  // Grep-only; the direct-path match above still catches a Glob/LS pointed AT the ruled path itself.
  if (SEARCH_TOOLS.has(tool) && typeof ti.path === "string") {
    const subject = tildeForm(ti.path);
    for (const { r, effect } of rules) {
      const pr = parsePermissionRule(r);
      if (!pr || pr.tool !== "Read") continue;
      if (ruleRegex(pr.pattern, "path").test(subject)) return { deny: reason(r, effect), rule: r, effect };
      if (tool === "Grep" && ruleCoversBelow(pr.pattern, subject)) return { deny: reason(r, effect), rule: r, effect };
    }
    return null;
  }

  // any other tool (extension-registered, MCP): a command-shaped input is judged as Bash, a path-shaped one as a Grep
  if (!KNOWN_TOOLS.has(tool)) {
    if (typeof ti.command === "string") return builtinPermissionCheck({ ...input, tool_name: "Bash" }, permissions);
    const path = typeof ti.file_path === "string" ? ti.file_path : typeof ti.path === "string" ? ti.path : null;
    if (path !== null) return builtinPermissionCheck({ ...input, tool_name: "Grep", tool_input: { ...ti, path } }, permissions);
  }
  return null;
}

// ── telemetry ────────────────────────────────────────────────────────────────

export interface EventRecord {
  at: string; event: string; session_id: string | null; turn_id: string | null; tool_name: string | null;
  hooks: string[]; decision: "allow" | "deny" | "block" | "stop" | "context" | "none"; ms: number; faults: string[];
  /** number of Claude-shaped inputs the payload became (apply_patch fans out per file; 1 otherwise) */
  fanout: number;
  /** Actual added context bytes; not a tokenizer count or subscription charge. */
  context_bytes?: number;
}

export function recordEvent(rec: EventRecord, stateDir = STATE_DIR): void {
  try {
    ensureStateDir(stateDir);
    const p = join(stateDir, "events.jsonl");
    appendFileSync(p, JSON.stringify(rec) + "\n", { mode: 0o600 });
    chmodSync(p, 0o600);
  } catch { /* telemetry never blocks */ }
}

// ── the bridge ───────────────────────────────────────────────────────────────

export interface BridgeDeps {
  settings?: Settings;
  runCommand?: typeof runCommandHook;
  runHttp?: typeof runHttpHook;
  stateDir?: string;
  now?: () => number;
  resync?: () => void;
}

export async function bridge(event: CodexEvent, codexInput: Input, deps: BridgeDeps = {}): Promise<Record<string, unknown>> {
  const t0 = (deps.now ?? Date.now)();
  const settings = deps.settings ?? loadSettings();
  const stateDir = deps.stateDir ?? STATE_DIR;
  const runCmd = deps.runCommand ?? runCommandHook;
  const runHttp = deps.runHttp ?? runHttpHook;
  const cwd = String(codexInput.cwd ?? process.cwd());
  const faults: string[] = [];

  if (event === "PostCompact") {
    try {
      const { resetMemoryDelivery } = await import("../../hooks/lib/memory-reset");
      resetMemoryDelivery(String(codexInput.session_id ?? ""));
    } catch (error) { faults.push(`memory-reset: ${String(error)}`); }
  }

  // A SessionEnd that is the first event its session ever sent never started a session:
  // `codex debug prompt-input` (the mount's catalog probe) fires only SessionEnd. Claude's
  // SessionEnd hooks (work sync, integrity, learning) must not run for it. Keyed on the
  // shadow transcript, which every earlier event of the session creates.
  if (event === "SessionEnd" && !existsSync(shadowTranscriptPath(String(codexInput.session_id ?? "unknown"), stateDir))) {
    recordEvent({
      at: new Date().toISOString(), event, session_id: str(codexInput.session_id), turn_id: str(codexInput.turn_id),
      tool_name: null, hooks: ["Bridge.neverStarted"], decision: "none", ms: (deps.now ?? Date.now)() - t0, faults, fanout: 0,
    }, stateDir);
    return {};
  }

  // A prompt carrying a raw credential is refused before anything stores or forwards it:
  // the shadow transcript gets no line for it and no Claude hook receives the text.
  if (event === "UserPromptSubmit") {
    const problem = builtinPromptCheck(codexInput);
    if (problem) {
      appendShadowTranscript(event, { ...codexInput, prompt: undefined }, stateDir);
      recordEvent({
        at: new Date().toISOString(), event, session_id: str(codexInput.session_id), turn_id: str(codexInput.turn_id),
        tool_name: null, hooks: ["Bridge.builtinPromptCheck"], decision: "block", ms: (deps.now ?? Date.now)() - t0, faults, fanout: 0,
      }, stateDir);
      return toCodexOutput(event, { contexts: [], systemMessages: [], block: problem });
    }
  }

  const transcript = appendShadowTranscript(event, codexInput, stateDir);
  const inputs = buildClaudeInputs(event, { ...codexInput, transcript_path: transcript }, cwd);
  // Preserve native metadata separately from the Claude-shaped shadow transcript.
  for (const input of inputs) input.codex_transcript_path = codexInput.transcript_path ?? null;
  const env = childEnv(settings, cwd, codexInput);
  const budgetMs = EVENT_BUDGET_S[event] * 1000;

  const results: HookResult[] = [];
  const names = new Set<string>();
  for (const input of inputs) {
    if (event === "PreToolUse") {
      const perm = builtinPermissionCheck(input, settings.permissions ?? { deny: [], ask: [] });
      // The metadata record names the mirror whenever it judged an input, matched or not, so telemetry proves a fan-out was evaluated.
      names.add("Bridge.permissionMirror");
      if (perm) { results.push({ name: "Bridge.permissionMirror", exitCode: 2, stdout: "", stderr: perm.deny, timedOut: false }); continue; }
    }
    const entries = selectRegistrations(settings, event, input);
    const jobs: Promise<HookResult>[] = [];
    for (const h of entries) {
      names.add(hookName(h));
      const timeoutMs = Math.min((h.timeout ?? 30) * 1000, Math.max(budgetMs - 2000, 1000));
      if (h.type === "http") { jobs.push(runHttp(h, input, settings.allowedHttpHookUrls, Math.min(timeoutMs, 5000))); continue; }
      if (h.async || event === "SessionEnd") { spawnDetached(h, input, env); continue; }
      jobs.push(runCmd(h, input, env, timeoutMs));
    }
    const settled = await Promise.allSettled(jobs);
    for (const s of settled) {
      if (s.status === "fulfilled") {
        results.push(s.value);
        if (s.value.error) faults.push(`${s.value.name}: ${s.value.error}`);
        else if (s.value.timedOut) faults.push(`${s.value.name}: timeout`);
        else if (s.value.exitCode !== 0 && s.value.exitCode !== 2) faults.push(`${s.value.name}: exit ${s.value.exitCode}`);
      } else faults.push(String(s.reason));
    }
  }

  const decision = mergeResults(event, results);
  if (event === "Stop" && !decision.block) {
    const problem = builtinStopCheck(codexInput, daName());
    if (problem) { decision.block = problem; names.add("Bridge.builtinStopCheck"); }
  }
  if (event === "SessionStart") (deps.resync ?? defaultResync)();

  const out = toCodexOutput(event, decision);
  recordEvent({
    at: new Date().toISOString(), event, session_id: str(codexInput.session_id), turn_id: str(codexInput.turn_id),
    tool_name: str(codexInput.tool_name), hooks: [...names],
    decision: decision.deny ? "deny" : decision.block ? "block" : decision.stop ? "stop" : decision.contexts.length ? "context" : "none",
    ms: (deps.now ?? Date.now)() - t0, faults, fanout: inputs.length,
    context_bytes: Buffer.byteLength(decision.contexts.join("\n\n"), "utf8"),
  }, stateDir);
  return out;
}

function str(v: unknown): string | null { return typeof v === "string" ? v : null; }

/** Keep AGENTS.md, hooks.json and config.toml converged for the NEXT session; never blocks this one. */
function defaultResync(): void {
  try {
    const child = spawn("bun", [join(import.meta.dir, "Mount.ts"), "--sync", "--quiet"], { stdio: "ignore", detached: true, env: process.env });
    child.unref();
  } catch { /* best effort */ }
}

async function readStdin(timeoutMs = 3000): Promise<string> {
  return new Promise((res) => {
    let data = "";
    const t = setTimeout(() => res(data), timeoutMs);
    process.stdin.on("data", (c: Buffer) => { data += c.toString(); });
    process.stdin.on("end", () => { clearTimeout(t); res(data); });
    process.stdin.on("error", () => { clearTimeout(t); res(data); });
  });
}

if (import.meta.main) {
  const event = process.argv[2] as CodexEvent;
  if (!CODEX_EVENTS.includes(event)) {
    process.stderr.write(`Bridge.ts: unknown event ${JSON.stringify(event)}; expected one of ${CODEX_EVENTS.join(", ")}\n`);
    process.exit(0); // never block Codex on a misregistration
  }
  let input: Input = {};
  try { const raw = await readStdin(); if (raw.trim()) input = JSON.parse(raw) as Input; } catch { input = {}; }
  try {
    const out = await bridge(event, input);
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch (e) {
    recordEvent({ at: new Date().toISOString(), event, session_id: str(input.session_id), turn_id: str(input.turn_id), tool_name: str(input.tool_name), hooks: [], decision: "none", ms: 0, faults: [`bridge: ${String(e)}`], fanout: 0 });
    process.stdout.write("{}\n");
  }
  process.exit(0);
}
