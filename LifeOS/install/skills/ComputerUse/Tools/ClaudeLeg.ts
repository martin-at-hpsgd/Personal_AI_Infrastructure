#!/usr/bin/env bun
/**
 * ClaudeLeg — the Claude vision actor for pixel-only GUI work.
 *
 * Shape: a per-step loop. Each step the runner screenshots ONE allowlisted app's
 * window through Interceptor's bridge, asks a tool-less Claude (`claude --print`,
 * subscription billing, Read limited to that one screenshot) for exactly one JSON
 * action, and executes it through `interceptor macos <verb> --app <app>`. The model
 * never touches a shell, a file, a browser, or any app but the target.
 *
 * It is spawned by Run.ts `supervise()` like the codex child, so the deny scan,
 * watcher, caps, headless refusal and verifier are shared. It prints one JSONL
 * line per executed action (`{"type":"cu_action",...}`) for the step counter and
 * writes its final message to --out. Its own "done" is a report, never a verdict.
 *
 * Usage (normally via Run.ts --backend claude):
 *   bun ClaudeLeg.ts --app <AppName> --task-file <path> --out <path> [--model opus] [--max-steps 60]
 *
 * @version 1.0.0
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { windowBounds, type WindowFrame } from "./WindowBounds";

// ── Action contract ──────────────────────────────────────────────────────────

export const VERBS = ["click", "double_click", "right_click", "type", "keys", "scroll", "drag", "wait", "done"] as const;
export type Verb = (typeof VERBS)[number];

export interface Action {
  action: Verb;
  /** Screenshot pixel coordinates (as seen in the image). */
  x?: number; y?: number; x2?: number; y2?: number;
  text?: string;
  /** Key combo in Interceptor syntax, e.g. "Meta+S", "Return", "Meta+Shift+G". */
  combo?: string;
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
  /** done: one paragraph on what was done and where it stopped. */
  summary?: string;
}

export type ParseResult = { ok: true; action: Action; note: string } | { ok: false; error: string };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Pure. Accepts the model's reply text; returns exactly one validated action or an error. */
export function parseAction(reply: string): ParseResult {
  const i = reply.indexOf("{"); const j = reply.lastIndexOf("}");
  if (i < 0 || j <= i) return { ok: false, error: "no JSON object in reply" };
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(reply.slice(i, j + 1)); } catch { return { ok: false, error: "reply JSON does not parse" }; }
  const a = (typeof raw.action === "object" && raw.action !== null ? raw.action : raw) as Record<string, unknown>;
  const note = typeof raw.thought === "string" ? raw.thought.slice(0, 300) : "";
  const verb = a.action ?? a.type;
  if (typeof verb !== "string" || !(VERBS as readonly string[]).includes(verb)) {
    return { ok: false, error: `unknown action verb: ${String(verb)}` };
  }
  const act: Action = { action: verb as Verb };
  switch (act.action) {
    case "click": case "double_click": case "right_click":
      if (!isNum(a.x) || !isNum(a.y)) return { ok: false, error: `${verb} needs numeric x,y` };
      act.x = a.x; act.y = a.y; break;
    case "drag":
      if (![a.x, a.y, a.x2, a.y2].every(isNum)) return { ok: false, error: "drag needs x,y,x2,y2" };
      Object.assign(act, { x: a.x, y: a.y, x2: a.x2, y2: a.y2 }); break;
    case "type":
      if (typeof a.text !== "string" || !a.text.length) return { ok: false, error: "type needs text" };
      act.text = a.text.slice(0, 2000); break;
    case "keys":
      if (typeof a.combo !== "string" || !/^[A-Za-z0-9+_ ]{1,40}$/.test(a.combo)) return { ok: false, error: "keys needs a combo like Meta+S" };
      act.combo = a.combo; break;
    case "scroll": {
      const d = a.direction;
      if (d !== "up" && d !== "down" && d !== "left" && d !== "right") return { ok: false, error: "scroll needs direction" };
      act.direction = d; act.amount = isNum(a.amount) ? Math.min(Math.round(a.amount), 20) : 3; break;
    }
    case "wait": break;
    case "done": act.summary = typeof a.summary === "string" ? a.summary.slice(0, 2000) : ""; break;
  }
  return { ok: true, action: act, note };
}

// ── Coordinates ──────────────────────────────────────────────────────────────

export interface ShotGeometry { shotWidth: number; shotHeight: number; window: Pick<WindowFrame, "x" | "y" | "width" | "height"> }

/** Pure. Screenshot pixels → global display points (the space `macos click X,Y --app` posts into). */
export function toScreenPoint(px: number, py: number, g: ShotGeometry): { x: number; y: number } {
  const sx = g.shotWidth / g.window.width;
  const sy = g.shotHeight / g.window.height;
  return { x: Math.round(g.window.x + px / sx), y: Math.round(g.window.y + py / sy) };
}

/** Pure. One action → the interceptor argv that performs it, always scoped to `app`. Null for wait/done. */
export function bridgeArgv(a: Action, app: string, g: ShotGeometry): string[] | null {
  const pt = (x: number, y: number) => { const p = toScreenPoint(x, y, g); return `${p.x},${p.y}`; };
  switch (a.action) {
    case "click": return ["macos", "click", pt(a.x!, a.y!), "--app", app];
    case "double_click": return ["macos", "click", pt(a.x!, a.y!), "--double", "--app", app];
    case "right_click": return ["macos", "click", pt(a.x!, a.y!), "--right", "--app", app];
    case "drag": return ["macos", "drag", pt(a.x!, a.y!), pt(a.x2!, a.y2!), "--app", app];
    case "type": return ["macos", "type", a.text!, "--app", app];
    case "keys": return ["macos", "keys", a.combo!, "--app", app];
    case "scroll": return ["macos", "scroll", a.direction!, String(a.amount ?? 3), "--app", app];
    default: return null;
  }
}

// ── The claude child ─────────────────────────────────────────────────────────

/** Pure. Subscription billing and no nested-session guard, mirroring LIFEOS/TOOLS/Inference.ts. */
export function claudeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.CLAUDECODE;
  env.LIFEOS_NOTIFICATION_CHANNEL = "headless";
  return env;
}

export const SYSTEM_PROMPT = `You operate one macOS application for the user by looking at a screenshot of its window and choosing ONE next action.

Reply with a single JSON object and nothing else:
{"thought": "<one short sentence>", "action": {"action": "<verb>", ...}}

Verbs:
- click / double_click / right_click: {"x": N, "y": N} in screenshot pixels
- drag: {"x": N, "y": N, "x2": N, "y2": N}
- type: {"text": "..."} types into the focused element
- keys: {"combo": "Meta+S"} (Meta=Cmd, Shift, Alt, Control; Return, Escape, Tab, Delete, ArrowDown, ...)
- scroll: {"direction": "down", "amount": 3}
- wait: {} when the UI is still changing
- done: {"summary": "..."} when the task's end condition is visibly met, or you must stop

Rules: stay inside this application. Never send, publish, purchase, delete or confirm anything the task does not name as its end condition; choose done and explain instead. Prefer keyboard shortcuts when they are reliable. Do not claim success beyond what the screenshot shows; a separate verifier checks the result.`;

/** Pure. The claude argv: one tool (Read), one readable directory, no MCP, no user settings. */
export function claudeArgv(model: string, shotDir: string, effort = "medium"): string[] {
  return [
    "--print",
    "--model", model,
    "--effort", effort,
    "--tools", "Read",
    "--allowedTools", "Read",
    "--add-dir", shotDir,
    "--output-format", "json",
    "--safe-mode",
    // Confines Read to the cwd and --add-dir (the one screenshot dir) and drops code-running tools.
    "--restricted",
    "--strict-mcp-config",
    "--settings", '{"verbose":false}',
    "--system-prompt", SYSTEM_PROMPT,
  ];
}

function runClaude(argv: string[], prompt: string, cwd: string, timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("claude", argv, { cwd, env: claudeEnv(process.env), stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; let err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("claude step timed out")); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
      try {
        const env = JSON.parse(out) as { result?: string; is_error?: boolean };
        if (env.is_error) return reject(new Error(`claude error: ${String(env.result).slice(0, 300)}`));
        resolve(String(env.result ?? ""));
      } catch { resolve(out); }
    });
    p.stdin.end(prompt);
  });
}

async function sh(args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["interceptor", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, out };
}

function jsonIn(s: string): any {
  const i = s.indexOf("{"); const j = s.lastIndexOf("}");
  return i >= 0 && j > i ? JSON.parse(s.slice(i, j + 1)) : null;
}

async function pidOf(app: string): Promise<number | null> {
  const { out } = await sh(["macos", "inspect"]);
  const j = jsonIn(out) as { apps?: { name: string; pid: number }[] } | null;
  return j?.apps?.find((a) => a.name.toLowerCase() === app.toLowerCase())?.pid ?? null;
}

/** Screenshot the app's window and pair it with the window frame it came from. */
async function shoot(app: string, pid: number, dir: string): Promise<{ path: string; geom: ShotGeometry } | { error: string }> {
  const { out } = await sh(["macos", "screenshot", "--app", app, "--save", "--format", "png"], dir);
  const j = jsonIn(out) as { filePath?: string; width?: number; height?: number } | null;
  if (!j?.filePath || !j.width || !j.height) return { error: `screenshot failed: ${out.slice(0, 200)}` };
  const wins = windowBounds(pid);
  // The capture is the app's front window; match it by aspect ratio, falling back to the first.
  const r = j.width / j.height;
  const w = wins.find((x) => Math.abs(x.width / x.height - r) < 0.02) ?? wins[0];
  if (!w) return { error: "no on-screen window for the app" };
  return { path: j.filePath, geom: { shotWidth: j.width, shotHeight: j.height, window: w } };
}

// ── CLI loop ─────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (k: string, d = "") => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  const app = get("app");
  const taskFile = get("task-file");
  const outFile = get("out");
  const model = get("model", "opus");
  const maxSteps = Number(get("max-steps", "60"));
  if (!app || !taskFile || !outFile || !existsSync(taskFile)) {
    console.error("usage: bun ClaudeLeg.ts --app <App> --task-file <path> --out <path> [--model opus] [--max-steps N]");
    process.exit(2);
  }
  const task = readFileSync(taskFile, "utf8");
  const emit = (o: object) => process.stdout.write(JSON.stringify(o) + "\n");
  const finish = (summary: string, code: number) => { writeFileSync(outFile, summary); emit({ type: "cu_finish", summary: summary.slice(0, 500) }); process.exit(code); };

  const pid = await pidOf(app);
  if (!pid) finish(`Stopped: ${app} is not running.`, 1);
  const history: string[] = [];
  let parseFailures = 0;

  for (let step = 1; step <= maxSteps; step++) {
    const dir = mkdtempSync(join(tmpdir(), "cu-claude-"));
    const shot = await shoot(app, pid!, dir);
    if ("error" in shot) finish(`Stopped: ${shot.error}`, 1);
    const { path, geom } = shot as { path: string; geom: ShotGeometry };
    const prompt = [
      `Task: ${task}`,
      history.length ? `Actions so far (oldest first):\n${history.slice(-15).join("\n")}` : "No actions yet.",
      `Current screenshot of the ${app} window (${geom.shotWidth}x${geom.shotHeight} px): @${path}`,
      "Choose the next single action.",
    ].join("\n\n");

    let reply: string;
    try { reply = await runClaude(claudeArgv(model, dir), prompt, dir); }
    catch (e) { finish(`Stopped: ${(e as Error).message}`, 1); }
    const parsed = parseAction(reply!);
    if (!parsed.ok) {
      emit({ type: "cu_parse_error", step, error: parsed.error });
      if (++parseFailures >= 3) finish(`Stopped: three unparseable replies (${parsed.error}).`, 1);
      history.push(`${step}. (reply rejected: ${parsed.error})`);
      continue;
    }
    const a = parsed.action;
    if (a.action === "done") finish(a.summary || "Claude reports done.", 0);
    const argv = bridgeArgv(a, app, geom);
    let result = "waited";
    if (argv) {
      const r = await sh(argv);
      result = r.code === 0 ? "ok" : `bridge error ${r.code}`;
    } else {
      await Bun.sleep(1500);
    }
    emit({ type: "cu_action", step, action: a.action, result, thought: parsed.note });
    history.push(`${step}. ${JSON.stringify(a)} → ${result}${parsed.note ? ` (${parsed.note})` : ""}`);
    await Bun.sleep(400);
  }
  finish(`Stopped: step budget ${maxSteps} reached without done.`, 1);
}
