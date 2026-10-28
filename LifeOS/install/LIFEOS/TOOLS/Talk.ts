#!/usr/bin/env bun
/**
 * Talk — the hand-off plumbing for a live voice conversation beside a working Claude Code session.
 *
 * STATUS: off. Every command but `progress` exits with TALK_OFF_MESSAGE unless
 * USER/CUSTOMIZATIONS/TALK/config.json sets `"enabled": true`. The voice side that used to sit on top
 * (a third-party conversational agent) is gone; Talk stays off until it is rebuilt on Fish.
 *
 * What remains is the session side: Pulse (`LIFEOS/PULSE/modules/talk.ts`) carries what the principal
 * settles out loud to the session as a message, and the session's progress back to the voice side.
 *
 *   bun Talk.ts open    [--session <id>]    raise the talk window for a session
 *   bun Talk.ts bridge  [--session <id>]    stream that session's hand-offs as JSON lines
 *   bun Talk.ts progress --session <id> --text <t>   post a progress summary
 *
 * Doc: LIFEOS/DOCUMENTATION/VoiceMode/VoiceMode.md § Talk
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PULSE_BASE } from "../PULSE/endpoint";

const LIFEOS_ROOT = resolve(import.meta.dir, "..");
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function configPath(): string {
  return process.env.LIFEOS_TALK_CONFIG ?? join(LIFEOS_ROOT, "USER", "CUSTOMIZATIONS", "TALK", "config.json");
}

/** A missing config file is an empty config; an unreadable or malformed one throws, so nothing treats it as absent. */
export function readConfig(): { enabled?: boolean } {
  let raw: string;
  try { raw = readFileSync(configPath(), "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`talk: config ${configPath()} unreadable: ${(e as Error).message}`);
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`talk: config ${configPath()} is not a JSON object`);
  return parsed as { enabled?: boolean };
}

/** Talk's voice side is gone and it is off until it is rebuilt on the Fish voice stack. */
export const TALK_OFF_MESSAGE = "Talk is off for now: its voice side is being rebuilt on Fish.";
/** Fails closed: Talk runs only when the config says `"enabled": true`; missing, unreadable or malformed config is off. */
export function talkEnabled(): boolean {
  try { return readConfig().enabled === true; } catch { return false; }
}

// ── Window, bridge, progress ─────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function sessionArg(): string {
  const s = arg("--session") ?? process.env.CLAUDE_CODE_SESSION_ID ?? "";
  if (!SAFE_ID.test(s)) { console.error("talk: no session id (pass --session or run inside Claude Code)"); process.exit(2); }
  return s;
}

function openWindow(session: string): void {
  // A second launch hands its argv to the running Pulse Desktop (single-instance lock),
  // which raises a talk window; with Pulse Desktop not running it starts with the window.
  const r = Bun.spawnSync(["open", "-n", "-a", "Pulse Desktop", "--args", `--talk=${session}`]);
  if (r.exitCode !== 0) { console.error(`talk: could not open Pulse Desktop: ${r.stderr.toString()}`); process.exit(1); }
  console.log(`talk: window opening for session ${session}`);
}

/** Stream this session's hand-offs from Pulse as JSON lines; exits when the talk ends. */
async function bridge(session: string): Promise<void> {
  // The stream is meant to stay open for the whole conversation, so a fixed timeout would cut it
  // mid-talk. Pulse sends a `: ping` every 15s; the signal fires only when nothing at all (frame or
  // ping) has arrived for INBOX_IDLE_MS, i.e. the stream stalled. `timeout: false` lifts Bun's own 300s cap.
  const INBOX_IDLE_MS = 60_000;
  const ac = new AbortController();
  let idle: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(), INBOX_IDLE_MS); };
  armIdle();
  const res = await fetch(`${PULSE_BASE}/talk/inbox?session=${session}`, { signal: ac.signal, timeout: false } as RequestInit);
  if (!res.ok || !res.body) { clearTimeout(idle); console.error(`talk: inbox ${res.status}`); process.exit(1); }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await reader.read(); } catch { console.error(`talk: inbox stalled (no data for ${INBOX_IDLE_MS / 1000}s)`); process.exit(1); }
    armIdle();
    const { value, done } = chunk;
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (\w+)/m.exec(frame)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (event === "end") process.exit(0);
      if (event === "handoff" && data) console.log(data);
    }
  }
  clearTimeout(idle);
}

async function postProgress(session: string, text: string): Promise<void> {
  await fetch(`${PULSE_BASE}/talk/progress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session, text }),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd !== "progress" && !talkEnabled()) { console.error(TALK_OFF_MESSAGE); process.exit(3); }
  if (cmd === "open") openWindow(sessionArg());
  else if (cmd === "bridge") await bridge(sessionArg());
  else if (cmd === "progress") await postProgress(sessionArg(), arg("--text") ?? "");
  else { console.error("usage: Talk.ts open | bridge | progress  [--session <id>]"); process.exit(2); }
}
