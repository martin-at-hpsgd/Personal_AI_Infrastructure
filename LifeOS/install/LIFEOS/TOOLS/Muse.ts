#!/usr/bin/env bun
/**
 * Muse.ts — run one Muse Code turn headless on the principal's Muse Code subscription and hand back one JSON line.
 *
 * Usage:
 *   bun ~/.claude/LIFEOS/TOOLS/Muse.ts run --cwd <absolute scratch dir> [--model <id>] [--effort high] [--timeout-ms N] [--approval allowAll|denyUnmatched] <<'TASK'
 *   …prompt…
 *   TASK
 *   bun ~/.claude/LIFEOS/TOOLS/Muse.ts usage        # last observed plan windows (the statusline cache)
 *
 * Why it is shaped this way:
 * - Muse reads `~/.claude/CLAUDE.md` and `~/.claude/skills` as its own user config from ANY workspace, and walks up from
 *   the workspace for AGENTS.md/CLAUDE.md/.agents, so a turn started from the LifeOS root would send both to Meta under
 *   contributor (training) terms. So every run gets HOME = an isolated Muse home, a minimal env, and a
 *   workspace outside HOME with no instruction files above it. Meta is PUBLIC-class (egress-class-core.ts).
 * - The isolated home keeps the real OAuth token reachable by symlinking `Library/Keychains` and `auth.json` (the token
 *   lives in the login keychain, which follows HOME). HOME and the env are redirected, so default lookups find nothing
 *   else; this is not a filesystem sandbox: the agent runs as the same user, so an absolute path still reaches the real
 *   home. That is why runTurn refuses any workspace in or above HOME or under an instruction file, and why allowAll is
 *   for scratch work only.
 * - Turns go over `muse serve` (MSP v1, newline JSON-RPC) rather than `muse exec`, because only MSP reports the plan's
 *   five-hour and weekly windows (`usage/changed`), which feed the statusline's MU row.
 * - Contributor mode is asserted off in the isolated settings and forced off again on the command line.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { CROSS_VENDOR } from "./models.ts";
import { invariant } from "./Invariant.ts";
import { recordModelUse } from "./lib/ModelUse";

export const MUSE_BIN = join(homedir(), ".local", "bin", "muse");
export const museHome = (realHome = homedir()) => join(realHome, ".local", "share", "lifeos-muse-home");
export const usageCachePath = (realHome = homedir(), env = process.env) =>
  join(env.XDG_CACHE_HOME || join(realHome, ".cache"), "lifeos-statusline", "muse-usage.json");

/** Files or folders Muse treats as project instructions or config when they sit in or above the workspace. */
export const INSTRUCTION_MARKERS = ["CLAUDE.md", "AGENTS.md", ".agents", ".muse", ".claude"] as const;

const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** Why a workspace may not be handed to Muse, or null when it may. Symlinks are resolved before any boundary check. */
export function workspaceRefusal(cwd: string, realHome = homedir()): string | null {
  if (!cwd.startsWith("/")) return `--cwd must be absolute: ${cwd}`;
  if (!existsSync(cwd)) return `--cwd does not exist: ${cwd}`;
  const real = realpathSync(cwd);
  const home = realpathSync(realHome);
  if (within(real, home) || within(home, real)) return `workspace ${real} is HOME, inside HOME or above it; Muse would read private config there — use a scratch dir outside HOME`;
  for (let dir = real; ; dir = dirname(dir)) {
    for (const m of INSTRUCTION_MARKERS) if (existsSync(join(dir, m))) return `workspace ${real} has ${join(dir, m)} in or above it; Muse would send it to Meta`;
    if (dirname(dir) === dir) break;
  }
  return null;
}

export interface MuseSettings { schema_version: 1; provider: "meta"; model: string; contributor_mode_enabled: false; [k: string]: unknown }

/** The isolated home's settings. Contributor mode is off by construction. */
export function isolatedSettings(model: string): MuseSettings {
  return { schema_version: 1, provider: "meta", model, contributor_mode_enabled: false };
}

/** Throws unless settings JSON keeps contributor mode off. Called before every spawn. */
export function assertContributorOff(settingsJson: string): void {
  const s = JSON.parse(settingsJson) as Record<string, unknown>;
  invariant(s.contributor_mode_enabled === false, "Muse isolated settings must say contributor_mode_enabled: false");
  invariant(typeof s.model !== "string" || !s.model.includes("contributor"), `Muse isolated settings name a contributor model: ${String(s.model)}`);
}

/** Creates or repairs the isolated Muse home: its own settings and empty trust list, the real login reachable by symlink. */
export function ensureMuseHome(model: string, realHome = homedir()): string {
  const iso = museHome(realHome);
  const cfg = join(iso, ".config", "muse");
  mkdirSync(cfg, { recursive: true, mode: 0o700 });
  const settingsPath = join(cfg, "settings.json");
  if (!existsSync(settingsPath)) writeFileSync(settingsPath, JSON.stringify(isolatedSettings(model), null, 2) + "\n", { mode: 0o600 });
  if (!existsSync(join(cfg, "trust.json"))) writeFileSync(join(cfg, "trust.json"), JSON.stringify({ schema_version: 1, projects: {} }, null, 2) + "\n", { mode: 0o600 });
  const link = (target: string, path: string) => {
    let present = false;
    try { present = lstatSync(path).isSymbolicLink(); } catch { present = false; }
    if (!present) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); symlinkSync(target, path); }
  };
  link(join(realHome, ".config", "muse", "auth.json"), join(cfg, "auth.json"));
  link(join(realHome, "Library", "Keychains"), join(iso, "Library", "Keychains"));
  assertContributorOff(readFileSync(settingsPath, "utf8"));
  return iso;
}

/** The only env a Muse child sees: no API keys, tokens or LifeOS variables from this shell. */
export function childEnv(iso: string, env = process.env): Record<string, string> {
  const keep = ["PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL"];
  const out: Record<string, string> = { HOME: iso, MUSE_NO_AUTO_UPDATE: "1" };
  for (const k of keep) if (env[k]) out[k] = env[k]!;
  return out;
}

export interface PlanUsage { window?: { usedPercent: number; windowDurationMins: number; resetsAtMs: number }; weekly?: { usedPercent: number; resetsAtMs: number }; tier?: string; observedAtMs?: number }

/** The statusline cache, in the same shape as the Codex cache (windows labelled 5H/WK, percent used, epoch seconds). */
export function usageCache(u: PlanUsage, account: string): { email: string; tier: string | null; windows: { label: string; pct: number; reset_at: number }[]; fetched_at: number } {
  const windows: { label: string; pct: number; reset_at: number }[] = [];
  if (u.window) windows.push({ label: "5H", pct: u.window.usedPercent, reset_at: Math.floor(u.window.resetsAtMs / 1000) });
  if (u.weekly) windows.push({ label: "WK", pct: u.weekly.usedPercent, reset_at: Math.floor(u.weekly.resetsAtMs / 1000) });
  return { email: account, tier: u.tier ?? null, windows, fetched_at: Math.floor((u.observedAtMs ?? Date.now()) / 1000) };
}

export interface RunResult {
  ok: boolean; model: string; terminal: string; text: string; durationMs: number | null;
  tokens: { input: number; output: number; reasoning: number } | null; plan: PlanUsage | null; error?: string;
}

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export async function runTurn(o: { prompt: string; cwd: string; model: string; effort: string; timeoutMs: number; approval: string }): Promise<RunResult> {
  // The CLI checks this too, but runTurn is exported: an importer must not be able to start a turn in HOME or under instruction files.
  const refusal = workspaceRefusal(o.cwd);
  if (refusal) return { ok: false, model: o.model, terminal: "failed", text: "", durationMs: null, tokens: null, plan: null, error: refusal };
  const iso = ensureMuseHome(o.model);
  assertContributorOff(readFileSync(join(iso, ".config", "muse", "settings.json"), "utf8"));
  const proc = Bun.spawn([MUSE_BIN, "serve", "--no-session-log", "--model", o.model, "-c", "contributor_mode_enabled=false"], {
    cwd: o.cwd, env: childEnv(iso), stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  // One deadline governs every await in the run: each RPC call and the turn itself race
  // it, expiry kills the child at once, and process exit rejects every call still pending, so a stalled
  // `muse serve` can never hold the run (and its egress) open past timeoutMs.
  let nextId = 1;
  const pending = new Map<number, { res: (m: any) => void; rej: (e: Error) => void }>();
  let stopped: Error | null = null;
  const stopAll = (err: Error) => {
    if (stopped) return;
    stopped = err;
    for (const p of pending.values()) p.rej(err);
    pending.clear();
  };
  const write = (m: unknown) => { proc.stdin.write(JSON.stringify(m) + "\n"); proc.stdin.flush(); };
  const call = (method: string, params?: unknown) => new Promise<any>((res, rej) => {
    if (stopped) { rej(stopped); return; }
    const id = nextId++;
    pending.set(id, { res, rej });
    try { write({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }); }
    catch (e) { pending.delete(id); rej(e instanceof Error ? e : new Error(String(e))); }
  });
  const messages = new Map<string, string>();
  let tokens: RunResult["tokens"] = null, plan: PlanUsage | null = null;
  let finish!: (m: any) => void;
  const completed = new Promise<any>((r) => (finish = r));
  let expire!: (e: Error) => void;
  const deadline = new Promise<never>((_, rej) => (expire = rej));
  deadline.catch(() => { /* observed through the races below */ });
  const bounded = <T>(p: Promise<T>): Promise<T> => Promise.race([p, deadline]);
  const reader = (async () => {
    let buf = "";
    const dec = new TextDecoder();
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk);
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m: any; try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!.res(m); pending.delete(m.id); continue; }
        const p = m.params ?? {};
        if (m.method === "item/completed" && p.item?.kind === "agentMessage" && typeof p.item.text === "string") messages.set(p.item.itemId, p.item.text);
        else if (m.method === "session/tokenUsage" && p.usage) tokens = { input: p.usage.inputTokens ?? 0, output: p.usage.outputTokens ?? 0, reasoning: p.usage.reasoningTokens ?? 0 };
        else if (m.method === "usage/changed") plan = p as PlanUsage;
        else if (m.method === "turn/completed") finish(p);
      }
    }
    finish({ terminal: "failed", reason: "muse serve exited before the turn completed" });
    stopAll(new Error("muse serve exited before answering"));
  })().catch((e) => {
    finish({ terminal: "failed", reason: `muse serve output failed: ${e instanceof Error ? e.message : String(e)}` });
    stopAll(e instanceof Error ? e : new Error(String(e)));
  });
  const timer = setTimeout(() => {
    const err = new Error(`timed out after ${o.timeoutMs} ms`);
    finish({ terminal: "failed", reason: err.message });
    expire(err);
    stopAll(err);
    try { proc.kill(); } catch { /* already gone */ }
  }, o.timeoutMs);
  try {
    const init = await bounded(call("initialize", { clientInfo: { name: "lifeos_muse", version: "1.0.0" } }));
    if (init.error) throw new Error(`initialize: ${init.error.message}`);
    write({ jsonrpc: "2.0", method: "initialized" });
    const uuid = () => Bun.randomUUIDv7();
    const ss = await bounded(call("session/start", { commandId: uuid(), workspaceRoot: realpathSync(o.cwd), modelId: o.model, approvalMode: o.approval }));
    if (ss.error) throw new Error(`session/start: ${ss.error.message}`);
    const sessionId = ss.result?.session?.sessionId;
    const ts = await bounded(call("turn/start", { commandId: uuid(), sessionId, reasoningEffort: o.effort, input: [{ type: "text", text: o.prompt }] }));
    if (ts.error) throw new Error(`turn/start: ${ts.error.message}`);
    const done = await bounded(completed);
    if (stopped && done.terminal !== "completed") throw stopped; // the deadline or the child's exit ended the run
    const last = await bounded(call("usage/read"));
    plan = last.result?.usage ?? plan;
    const text = [...messages.values()].at(-1) ?? "";
    return { ok: done.terminal === "completed", model: o.model, terminal: done.terminal ?? "failed", text, durationMs: done.durationMs ?? null, tokens, plan, ...(done.terminal !== "completed" ? { error: done.reason ?? done.error?.message ?? "turn failed" } : {}) };
  } catch (e) {
    return { ok: false, model: o.model, terminal: "failed", text: "", durationMs: null, tokens, plan, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
    proc.kill();
    await Promise.race([proc.exited, Bun.sleep(3000)]);
    if (proc.exitCode === null) proc.kill(9);
    void reader;
  }
}

function account(realHome = homedir()): string {
  try { return String(JSON.parse(readFileSync(join(realHome, ".config", "muse", "auth.json"), "utf8")).providers?.meta?.user_email ?? "muse"); } catch { return "muse"; }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "usage") {
    const p = usageCachePath();
    console.log(existsSync(p) ? readFileSync(p, "utf8").trim() : JSON.stringify({ error: "no Muse run observed yet" }));
    return 0;
  }
  if (cmd !== "run") { console.error("usage: Muse.ts run --cwd <dir> [--model id] [--effort high] [--timeout-ms N] [--approval allowAll|denyUnmatched] < prompt  |  Muse.ts usage"); return 2; }
  let cwd = "", model = CROSS_VENDOR.muse, effort = "high", timeoutMs = 1_800_000, approval = "allowAll";
  for (let i = 0; i < rest.length; i += 2) {
    const [f, v] = [rest[i], rest[i + 1]];
    if (f === "--cwd") cwd = v ?? "";
    else if (f === "--model") model = v ?? model;
    else if (f === "--effort") effort = v ?? effort;
    else if (f === "--timeout-ms") timeoutMs = Number(v);
    else if (f === "--approval") approval = v ?? approval;
    else { console.error(`Muse.ts: unknown flag ${f}`); return 2; }
  }
  if (!(EFFORTS as readonly string[]).includes(effort)) { console.error(`Muse.ts: --effort must be one of ${EFFORTS.join("|")}`); return 2; }
  if (!["allowAll", "denyUnmatched"].includes(approval)) { console.error("Muse.ts: --approval must be allowAll or denyUnmatched"); return 2; }
  if (model.includes("contributor")) { console.error("Muse.ts: contributor models are refused"); return 2; }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { console.error("Muse.ts: --timeout-ms must be a positive number"); return 2; }
  const refusal = workspaceRefusal(cwd);
  if (refusal) { console.error(`Muse.ts: ${refusal}`); return 2; }
  const prompt = (await new Response(Bun.stdin.stream()).text()).trim();
  if (!prompt) { console.error("Muse.ts: empty prompt on stdin"); return 2; }
  const r = await runTurn({ prompt, cwd, model, effort, timeoutMs, approval });
  if (r.tokens) recordModelUse(model, r.tokens.output);
  if (r.plan) {
    const p = usageCachePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(usageCache(r.plan, account()), null, 2) + "\n");
  }
  console.log(JSON.stringify(r));
  return r.ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
