#!/usr/bin/env bun
/**
 * Heartbeat.ts — report a local watcher's successful run to the cloud dead-man switch.
 *
 * Every local watcher rides launchd on one Mac. If launchd stops running jobs,
 * the Mac sleeps, or the watcher itself dies, every local alarm goes quiet at
 * once — and quiet looks like healthy. So a watcher calls `sendHeartbeat()` at
 * the END of a successful full run, and the cloud site-health worker (its own
 * machine, its own 5-min cron) pages when a heartbeat is older than its max age.
 *
 *   bun LIFEOS/TOOLS/Heartbeat.ts send <job> --max-age <seconds>
 *   bun LIFEOS/TOOLS/Heartbeat.ts check <job>        # exit 1 unless the cloud shows it green
 *   bun LIFEOS/TOOLS/Heartbeat.ts retire <job>       # stop the cloud from paging for it
 *   bun LIFEOS/TOOLS/Heartbeat.ts list
 *
 * Config: ~/.config/workflows/config.yaml (subdomain, auth_token, site_health_worker) —
 * the same file every Workflows consumer reads. Nothing install-specific lives here.
 *
 * Contract for callers: sendHeartbeat NEVER throws. A dead heartbeat endpoint
 * must not break the monitor that would otherwise be paging for real outages.
 */
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { workflowsConfigPath } from "./WorkflowsConfig";

export interface HeartbeatConfig { url: string; token: string }

/** One DNS label: 1-63 of [a-z0-9-], not starting or ending with a hyphen. */
const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * The site-health origin for a worker name and account subdomain, or null. Both
 * come from a config file and are interpolated into the host that receives the
 * bearer token, so each must be a single DNS label and the parsed origin must be
 * exactly `https://<worker>.<subdomain>.workers.dev`.
 */
export function heartbeatOrigin(worker: string, subdomain: string): string | null {
  if (!DNS_LABEL.test(worker) || !DNS_LABEL.test(subdomain)) return null;
  const expectedHost = `${worker}.${subdomain}.workers.dev`;
  let u: URL;
  try { u = new URL(`https://${expectedHost}`); } catch { return null; }
  if (u.protocol !== "https:" || u.hostname !== expectedHost || u.port || u.username || u.password) return null;
  return u.origin;
}

/** Parse the workflows config text into a heartbeat target, or null when it is incomplete or unsafe. */
export function parseHeartbeatConfig(y: string): HeartbeatConfig | null {
  const subdomain = y.match(/^subdomain:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
  const token = y.match(/^auth_token:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
  const worker = y.match(/^site_health_worker:\s*"?([^"\n]+)"?/m)?.[1]?.trim() || "site-health";
  if (!subdomain || !token) return null;
  const url = heartbeatOrigin(worker.toLowerCase(), subdomain.toLowerCase());
  return url ? { url, token } : null;
}

export function heartbeatConfig(): HeartbeatConfig | null {
  // Test seam: lets a test point the beats at a local server. It never carries the
  // configured auth token: only LIFEOS_HEARTBEAT_TOKEN, which a test sets itself.
  if (process.env.LIFEOS_HEARTBEAT_URL) return { url: process.env.LIFEOS_HEARTBEAT_URL, token: process.env.LIFEOS_HEARTBEAT_TOKEN ?? "test" };
  try {
    return parseHeartbeatConfig(readFileSync(workflowsConfigPath(), "utf8"));
  } catch {
    return null;
  }
}

export interface HeartbeatSendResult { ok: boolean; reason: string }

/** Waits between send attempts. One dropped POST used to cost a whole monitor
 * cycle and page as a dead monitor,
 * so a transient network error or a 5xx/429 is retried; a 4xx is our own fault
 * and is not. */
export const HEARTBEAT_RETRY_DELAYS_MS = [5_000, 30_000];

/** Report in. Never throws; the caller logs the reason and moves on. */
export async function sendHeartbeat(
  job: string,
  maxAgeS: number,
  cfg = heartbeatConfig(),
  opts: { fetchImpl?: typeof fetch; delaysMs?: number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<HeartbeatSendResult> {
  if (!cfg) return { ok: false, reason: "no workflows config (~/.config/workflows/config.yaml) — heartbeat not sent" };
  const doFetch = opts.fetchImpl ?? fetch;
  const delays = opts.delaysMs ?? HEARTBEAT_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let reason = "";
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1]!);
    try {
      const r = await doFetch(`${cfg.url}/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({ job, max_age_s: maxAgeS, host: hostname().split(".")[0] }),
        redirect: "error", // a redirect would carry the bearer token elsewhere
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) return { ok: true, reason: `heartbeat sent for ${job} (max ${maxAgeS}s)${attempt ? ` on attempt ${attempt + 1}` : ""}` };
      reason = `heartbeat HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`;
      if (r.status < 500 && r.status !== 429) break;
    } catch (err) {
      reason = `heartbeat failed: ${String(err)}`;
    }
  }
  return { ok: false, reason };
}

/** A heartbeat that does not depend on the caller's event loop. The Bunker
 * monitor runs probes with spawnSync, so one app blocking for 30–108 min
 * starved every in-process beat and paged "NOT WORKING" about four times a
 * day while the monitor and every site were fine (2026-10-09 to 10-12). This
 * runs the beats in a child process (never detached) that sends one every
 * `everyMs` while the parent is alive, and stops after `capMs` so a truly
 * wedged monitor still stops beating and pages. */
export const PULSE_EVERY_MS = 10 * 60_000;
export const PULSE_CAP_MS = 4 * 3_600_000;

export function startHeartbeatPulse(
  job: string,
  maxAgeS: number,
  opts: { everyMs?: number; capMs?: number } = {},
): { stop: () => void } {
  const everyS = Math.round((opts.everyMs ?? PULSE_EVERY_MS) / 1000);
  const capS = Math.round((opts.capMs ?? PULSE_CAP_MS) / 1000);
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  const child = spawn(process.execPath, [import.meta.path, "pulse", job, "--max-age", String(maxAgeS), "--every", String(everyS), "--cap", String(capS), "--parent", String(process.pid)], { stdio: ["ignore", "inherit", "inherit"] });
  child.unref();
  const stop = () => { if (child.exitCode === null && !child.killed) child.kill("SIGTERM"); };
  process.once("exit", stop);
  return { stop };
}

function parentAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function retireHeartbeat(job: string, cfg = heartbeatConfig()): Promise<HeartbeatSendResult> {
  if (!cfg) return { ok: false, reason: "no workflows config" };
  try {
    const r = await fetch(`${cfg.url}/heartbeat`, {
      method: "DELETE",
      headers: { "content-type": "application/json", Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ job }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok ? { ok: true, reason: `retired ${job}` } : { ok: false, reason: `HTTP ${r.status}: ${(await r.text()).slice(0, 160)}` };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

interface CloudApp { name: string; type?: string; state: string; checks?: Array<{ label: string }>; updated_at?: string }

/** What the cloud currently believes about every heartbeat (or one job). */
export async function cloudHeartbeats(cfg = heartbeatConfig()): Promise<CloudApp[]> {
  if (!cfg) throw new Error("no workflows config (~/.config/workflows/config.yaml)");
  const r = await fetch(`${cfg.url}/status`, { headers: { Authorization: `Bearer ${cfg.token}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`site-health /status HTTP ${r.status}`);
  const j = (await r.json()) as { apps?: CloudApp[] };
  return (j.apps ?? []).filter((a) => a.type === "heartbeat");
}

if (import.meta.main) {
  const [cmd, job, ...rest] = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === "send" && job) {
    const maxAge = Number(flag("--max-age"));
    if (!Number.isFinite(maxAge) || maxAge < 60) { console.error("usage: Heartbeat.ts send <job> --max-age <seconds ≥ 60>"); process.exit(2); }
    const r = await sendHeartbeat(job, maxAge);
    console.log(`${r.ok ? "🟢" : "🟠"} ${r.reason}`);
    process.exit(0); // never fail the caller
  }
  if (cmd === "pulse" && job) {
    const maxAge = Number(flag("--max-age")), every = Number(flag("--every")), cap = Number(flag("--cap")), parent = Number(flag("--parent"));
    if (![maxAge, every, cap, parent].every(Number.isFinite) || maxAge < 60 || every < 1 || every * 1000 >= maxAge * 1000) {
      console.error("usage: Heartbeat.ts pulse <job> --max-age <s> --every <s < max-age> --cap <s> --parent <pid>"); process.exit(2);
    }
    const started = Date.now();
    while (Date.now() - started < cap * 1000) {
      await new Promise((r) => setTimeout(r, every * 1000));
      if (!parentAlive(parent)) process.exit(0);
      if (Date.now() - started >= cap * 1000) break;
      const r = await sendHeartbeat(job, maxAge);
      console.log(`${r.ok ? "💓" : "🟠"} pulse: ${r.reason}`);
    }
    console.log(`🟠 pulse: ${job} still running after ${Math.round(cap / 60)}m — beats stopped so the dead-man switch can page`);
    process.exit(0);
  }
  if (cmd === "retire" && job) {
    const r = await retireHeartbeat(job);
    console.log(`${r.ok ? "🟢" : "🔴"} ${r.reason}`);
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === "check" && job) {
    const apps = await cloudHeartbeats();
    const a = apps.find((x) => x.name === `heartbeat:${job}`);
    if (!a) { console.log(`🔴 the cloud has never seen a heartbeat for ${job}`); process.exit(1); }
    console.log(`${a.state === "green" ? "🟢" : "🔴"} ${a.name}: ${a.state} — ${a.checks?.[0]?.label ?? ""} (judged ${a.updated_at ?? "?"})`);
    process.exit(a.state === "green" ? 0 : 1);
  }
  if (cmd === "list") {
    const apps = await cloudHeartbeats();
    if (apps.length === 0) console.log("no heartbeats registered in the cloud yet");
    for (const a of apps) console.log(`${a.state === "green" ? "🟢" : "🔴"} ${a.name.padEnd(36)} ${a.checks?.[0]?.label ?? ""}`);
    process.exit(0);
  }
  console.error("usage: Heartbeat.ts send <job> --max-age <s> | check <job> | retire <job> | list");
  process.exit(2);
}
