#!/usr/bin/env bun
/**
 * Health — one deterministic read of whether the Hermes sidecar is actually up.
 *
 * The sidecar is a separate process tree with its own supervisor, so "is it
 * running" has three independent answers that can disagree, and the disagreement
 * is the interesting part:
 *
 *   1. the supervisor (launchd/systemd) thinks it has a job
 *   2. `gateway_state.json` says a pid was running as of some timestamp
 *   3. that pid is, right now, alive
 *
 * A gateway in a crash loop satisfies (1) and (2) continuously while being down
 * essentially all the time — which is exactly how it went unnoticed on
 * 2026-07-30, when a leftover `launchctl submit` restarter (KeepAlive defaults
 * to true for submitted jobs) SIGTERM'd the gateway every ~30s for hours. So
 * this probe reads the start log and reports FLAPPING as its own state rather
 * than letting a momentary "running" pid pass for health, and it names the
 * looping restarter directly, because that is the known cause.
 *
 * Read-only: it inspects state files and asks the supervisor. It never starts,
 * stops, or restarts anything — remediation is a human's call.
 *
 * Install-generic: no home paths, no usernames. `HERMES_HOME` wins when set.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const GATEWAY_LABEL = "ai.hermes.gateway";
/** The one-shot restarter that ships with a KeepAlive footgun; see header. */
export const RESTARTER_LABEL = "ai.hermes.gateway-restarter";

/** Starts within this window that exceed FLAP_THRESHOLD mean a crash loop. */
const FLAP_WINDOW_MS = 10 * 60 * 1000;
const FLAP_THRESHOLD = 4;

/** Beyond this, `gateway_state.json` is describing a world that no longer exists. */
const STATE_STALE_MS = 15 * 60 * 1000;

export type HermesStatus =
  | "absent" // not installed on this machine
  | "down" // installed, no live gateway process
  | "flapping" // restarting repeatedly — up only between kills
  | "restarting" // recorded pid is stale, but the supervisor is holding a live one
  | "degraded" // process alive, but a platform or the state file is unhealthy
  | "up";

export interface PlatformHealth {
  name: string;
  state: string;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface HermesHealth {
  status: HermesStatus;
  /** One line fit for a status card or a menu row. */
  summary: string;
  installed: boolean;
  home: string | null;
  /** Supervisor's view: is a job loaded, and does it hold a pid? */
  supervised: boolean;
  pid: number | null;
  pidAlive: boolean;
  uptimeSeconds: number | null;
  activeAgents: number | null;
  platforms: PlatformHealth[];
  /** Gateway launches inside FLAP_WINDOW_MS. */
  recentStarts: number;
  /** Everything wrong right now, most structural first. */
  problems: string[];
  /** True-but-benign observations. Never degrades status; see `notes` uses below. */
  notes: string[];
  stateUpdatedAt: string | null;
  checkedAt: string;
}

function hermesHome(): string {
  return process.env.HERMES_HOME || join(homedir(), ".hermes");
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Seconds the process has actually been alive, from `ps -o etime` (macOS has no
 * `etimes`). This has to come from the process, not from how recently the state
 * file was written: a gateway that is killed and relaunched every 30s keeps
 * rewriting state, so state age reads as healthy uptime forever.
 *
 * etime format: `[[dd-]hh:]mm:ss`.
 */
function processUptimeSeconds(pid: number): number | null {
  try {
    const out = Bun.spawnSync(["ps", "-o", "etime=", "-p", String(pid)]).stdout.toString().trim();
    if (!out) return null;
    const [days, clock] = out.includes("-") ? out.split("-") : ["0", out];
    const parts = clock.split(":").map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return null;
    const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
    return Number(days) * 86400 + h * 3600 + m * 60 + s;
  } catch {
    return null;
  }
}

/**
 * Ask the platform supervisor whether a labelled job is loaded. macOS is the
 * primary path; the systemd branch is additive so a Linux install reports
 * something better than "unknown" without touching the macOS path.
 */
function supervisorHasJob(label: string): boolean {
  try {
    if (process.platform === "darwin") {
      const out = Bun.spawnSync(["launchctl", "list"]).stdout.toString();
      return out.split("\n").some((line) => line.endsWith(`\t${label}`) || line.trim().endsWith(label));
    }
    if (process.platform === "linux") {
      const r = Bun.spawnSync(["systemctl", "--user", "is-enabled", `${label}.service`]);
      return r.exitCode === 0;
    }
  } catch {
    /* supervisor absent or unreadable — treated as no job */
  }
  return false;
}

/**
 * The pid the supervisor is holding right now, which can be newer than the one
 * `gateway_state.json` recorded: a gateway that has just been relaunched is live
 * under a fresh pid for the seconds before it rewrites its state file. Reading
 * only the recorded pid calls that window "down" (public issue #1861, @hjbrandt).
 */
function supervisorPid(label: string): number | null {
  try {
    if (process.platform === "darwin") {
      const out = Bun.spawnSync(["launchctl", "print", `gui/${process.getuid?.() ?? 0}/${label}`])
        .stdout.toString();
      const m = out.match(/^\s*pid\s*=\s*(\d+)/m);
      return m ? Number(m[1]) : null;
    }
    if (process.platform === "linux") {
      const out = Bun.spawnSync(["systemctl", "--user", "show", "-p", "MainPID", "--value", `${label}.service`])
        .stdout.toString()
        .trim();
      const n = Number(out);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
  } catch {
    /* supervisor absent or unreadable — no live pid to report */
  }
  return null;
}

/** Gateway launches recorded in the last FLAP_WINDOW_MS, from the start log. */
function countRecentStarts(home: string): number {
  const log = join(home, "gateway-starts.log");
  if (!existsSync(log)) return 0;
  const cutoffSeconds = (Date.now() - FLAP_WINDOW_MS) / 1000;
  return readFileSync(log, "utf8")
    .split("\n")
    .map((line) => Number.parseFloat(line.trim()))
    .filter((ts) => Number.isFinite(ts) && ts >= cutoffSeconds).length;
}

function readPlatforms(state: Record<string, unknown> | null): PlatformHealth[] {
  const raw = state?.platforms;
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, Record<string, unknown>>).map(([name, p]) => ({
    name,
    state: String(p?.state ?? "unknown"),
    errorCode: (p?.error_code as string) ?? null,
    errorMessage: (p?.error_message as string) ?? null,
  }));
}

export function checkHermesHealth(): HermesHealth {
  const checkedAt = new Date().toISOString();
  const home = hermesHome();

  // public issue #2064, @0bsolescence: a bare home directory is not an install.
  // Omarchy's own Hermes CLI (omarchy-install-hermes-cli) creates ~/.hermes/skills
  // on every Omarchy box, and that alone reported the LifeOS sidecar as "down — gateway down"
  // on every Linux perch (2026-09-04). Installed means the sidecar has left one of its own marks:
  // gateway state, a start log, or its cron dir.
  const sidecarMarks = ["gateway_state.json", "gateway-starts.log", "cron"];
  const installed = existsSync(home) && sidecarMarks.some((m) => existsSync(join(home, m)));

  if (!installed) {
    return {
      status: "absent",
      summary: "Hermes sidecar not installed",
      installed: false,
      home: null,
      supervised: false,
      pid: null,
      pidAlive: false,
      uptimeSeconds: null,
      activeAgents: null,
      platforms: [],
      recentStarts: 0,
      problems: [],
      notes: [],
      stateUpdatedAt: null,
      checkedAt,
    };
  }

  const state = readJson(join(home, "gateway_state.json"));
  const pid = typeof state?.pid === "number" ? (state.pid as number) : null;
  const pidAlive = pid !== null && isAlive(pid);
  const supervised = supervisorHasJob(GATEWAY_LABEL);
  const recentStarts = countRecentStarts(home);
  const platforms = readPlatforms(state);
  const stateUpdatedAt = (state?.updated_at as string) ?? null;
  const activeAgents = typeof state?.active_agents === "number" ? (state.active_agents as number) : null;

  const stateAgeMs = stateUpdatedAt ? Date.now() - Date.parse(stateUpdatedAt) : null;
  const uptimeSeconds = pidAlive && pid !== null ? processUptimeSeconds(pid) : null;

  // A dead recorded pid while the supervisor still holds a live one is a
  // relaunch in progress, not an outage (public issue #1861, @hjbrandt). The
  // recent-start evidence is what separates that from a state file left behind
  // by a different gateway instance, which reads identically from the pids
  // alone and is a real fault. Above FLAP_THRESHOLD this is a crash loop, and
  // that branch wins below.
  const relaunched = recentStarts > 0;
  const livePid = !pidAlive && supervised && relaunched ? supervisorPid(GATEWAY_LABEL) : null;
  const restarting = livePid !== null && isAlive(livePid);

  const problems: string[] = [];
  const notes: string[] = [];
  if (supervisorHasJob(RESTARTER_LABEL)) {
    problems.push(
      `${RESTARTER_LABEL} is loaded — it kills the gateway on a loop; remove it with \`launchctl remove ${RESTARTER_LABEL}\``,
    );
  }
  if (!supervised) problems.push(`no ${GATEWAY_LABEL} job registered with the supervisor`);
  if (restarting) {
    notes.push(`recorded pid ${pid} is stale — supervisor is running pid ${livePid}`);
  } else if (!pidAlive) {
    problems.push(pid === null ? "no gateway pid recorded" : `recorded pid ${pid} is not running`);
  }
  if (recentStarts >= FLAP_THRESHOLD) problems.push(`${recentStarts} gateway starts in the last 10 minutes`);
  if (pidAlive && stateAgeMs !== null && stateAgeMs > STATE_STALE_MS) {
    // Informational while the pid is live: a busy gateway can go a long stretch
    // without rewriting state, and paging on that mutes the monitor for the
    // cases that matter (public issue #1861, @hjbrandt).
    notes.push(`gateway_state.json last written ${Math.round(stateAgeMs / 60000)}m ago`);
  }
  for (const p of platforms) {
    if (p.state === "fatal") problems.push(`${p.name}: ${p.errorMessage || p.errorCode || "fatal"}`);
  }

  const connected = platforms.filter((p) => p.state === "connected");
  const status: HermesStatus =
    recentStarts >= FLAP_THRESHOLD
      ? "flapping"
      : restarting
        ? "restarting"
        : !pidAlive
          ? "down"
          : platforms.some((p) => p.state === "fatal") || problems.length > 0
            ? "degraded"
            : "up";

  const channels = platforms.length ? `${connected.length}/${platforms.length} channels` : "no channels";
  const summary =
    status === "up"
      ? `gateway up · ${channels}`
      : status === "flapping"
        ? `gateway crash-looping · ${recentStarts} starts/10m`
        : status === "restarting"
          ? `gateway restarting · supervisor pid ${livePid}`
          : status === "down"
            ? "gateway down"
            : `gateway up · ${channels} · ${problems.length} issue${problems.length === 1 ? "" : "s"}`;

  return {
    status,
    summary,
    installed: true,
    home,
    supervised,
    pid,
    pidAlive,
    uptimeSeconds,
    activeAgents,
    platforms,
    recentStarts,
    problems,
    notes,
    stateUpdatedAt,
    checkedAt,
  };
}

/**
 * States that mean "the sidecar is doing its job." `degraded` is in the set on
 * purpose: it is usually a standing config gap (a channel that was never given
 * credentials), and paging on a condition nobody intends to fix today is how a
 * monitor gets muted. `absent` passes too, so a LifeOS install with no sidecar
 * is green rather than permanently red. `restarting` is a relaunch caught
 * mid-flight, which a repeated probe resolves on its own.
 */
export const LIVE_STATUSES: ReadonlySet<HermesStatus> = new Set<HermesStatus>([
  "up",
  "degraded",
  "absent",
  "restarting",
]);

if (import.meta.main) {
  const health = checkHermesHealth();

  // Assertion modes for Bunker's ISA Test Strategy: silent, exit code is the
  // whole result. Kept as flags rather than shell-grepping the JSON so the
  // pass/fail rule lives here, next to the states it names.
  // --strict (with --assert-live): only `up` passes. degraded, absent and restarting
  // are not proof the gateway is serving, so a post-update check uses this form.
  if (process.argv.includes("--assert-live")) {
    const strict = process.argv.includes("--strict");
    if (strict ? health.status === "up" : LIVE_STATUSES.has(health.status)) process.exit(0);
    console.error(`hermes ${health.status}: ${health.summary}`);
    process.exit(1);
  }
  if (process.argv.includes("--assert-no-restarter")) {
    const looping = health.problems.find((p) => p.startsWith(RESTARTER_LABEL));
    if (!looping) process.exit(0);
    console.error(looping);
    process.exit(1);
  }

  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify(health, null, 2) + "\n");
  } else {
    const icon = { up: "🟢", degraded: "🟡", flapping: "🟠", restarting: "🔵", down: "🔴", absent: "⚪" }[
      health.status
    ];
    console.log(`${icon} Hermes — ${health.summary}`);
    if (health.pid) console.log(`   pid ${health.pid}${health.pidAlive ? "" : " (dead)"}`);
    for (const p of health.platforms) console.log(`   ${p.name}: ${p.state}`);
    for (const problem of health.problems) console.log(`   ! ${problem}`);
    for (const note of health.notes) console.log(`   · ${note}`);
  }
  process.exit(health.status === "up" || health.status === "absent" ? 0 : 1);
}
