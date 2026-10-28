#!/usr/bin/env bun
/**
 * SchedulerWatch.ts — notice when launchd stops running scheduled jobs, and keep them alive.
 *
 * The failure (2026-09-06): macOS began a scheduled software-update restart overnight,
 * an app cancelled it, and launchd left the login session in "on-demand-only mode".
 * Every StartInterval agent in the session was pended from then on — every LifeOS job
 * went silent for hours while every local alarm rode the same scheduler. Only a full
 * logout or restart clears the mode, but a demand spawn (`launchctl kickstart`)
 * still works inside it. So this tool, run from the always-on Pulse process,
 * detects the frozen state from launchd's own log line and kickstarts each pended
 * job at most once per its own interval until the human restarts.
 *
 *   bun LIFEOS/TOOLS/SchedulerWatch.ts check              # JSON; exit 0 healthy, 2 frozen, 3 a probe failed (state unknown)
 *   bun LIFEOS/TOOLS/SchedulerWatch.ts heal [--no-text]   # kick pended jobs (once per interval), text once per episode; same exits
 *
 * State: MEMORY/STATE/scheduler-watch.json — last kick per label + the open episode.
 * Texts go only to the principal's own line via LIFEOS/RELAY/bridge/send.ts.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { lifeosPath } from "./Paths.ts";
import { invariant } from "./Invariant.ts";
import { textCard } from "./TextFormat.ts";

const HOME = homedir();
const AGENTS_DIR = join(HOME, "Library/LaunchAgents");
const STATE_PATH = lifeosPath("MEMORY", "STATE", "scheduler-watch.json");
const BRIDGE_CONFIG = lifeosPath("USER", "RELAY", "state", "bridge-config.json");
const SEND_TS = lifeosPath("RELAY", "bridge", "send.ts");
const LOG_WINDOW = "6m";
const FROZEN_MARK = "domain in on-demand-only mode";

export interface IntervalJob { label: string; intervalS: number }
export interface JobState { label: string; intervalS: number; pended: boolean; runs: number | null }
export interface WatchState { lastKick: Record<string, string>; episode: { startedAt: string; texted: boolean } | null }
/** unknown: a probe failed, so "not frozen" cannot be claimed. probeErrors names each failed probe (command and exit only). */
export interface CheckReport { frozen: boolean; unknown: boolean; probeErrors: string[]; logHits: number; pended: string[]; jobs: JobState[]; checkedAt: string }
export interface ProbeResult { ok: boolean; stdout: string; detail: string }
export type Probe = (cmd: string[]) => ProbeResult;
export const EXIT_FROZEN = 2;
export const EXIT_PROBE_FAILED = 3;

// ── Pure parts (tested) ──────────────────────────────────────────────────────

/** launchd says it plainly: one "pending spawn, domain in on-demand-only mode" line per pended fire. */
export function frozenFromLog(logText: string): number {
  return logText.split("\n").filter((l) => l.includes(FROZEN_MARK)).length;
}

/** Parse the two fields we need out of `launchctl print gui/<uid>/<label>`. */
export function parseLaunchctlPrint(text: string): { pended: boolean; runs: number | null } {
  const pended = /pended nondemand spawn = interval/.test(text);
  const runs = text.match(/\bruns = (\d+)/);
  return { pended, runs: runs ? Number(runs[1]) : null };
}

/** Which pended labels may be kicked now: never inside their own interval since the last kick. */
export function dueForKick(jobs: JobState[], lastKick: Record<string, string>, nowMs: number): string[] {
  return jobs
    .filter((j) => j.pended)
    .filter((j) => {
      const last = lastKick[j.label] ? Date.parse(lastKick[j.label]) : Number.NEGATIVE_INFINITY;
      return nowMs - last >= j.intervalS * 1000;
    })
    .map((j) => j.label);
}

/** Episode bookkeeping: open on first frozen check, text exactly once, close when healthy. */
export function nextEpisode(prev: WatchState["episode"], frozen: boolean, nowIso: string): { episode: WatchState["episode"]; textNow: boolean } {
  if (!frozen) return { episode: null, textNow: false };
  if (!prev) return { episode: { startedAt: nowIso, texted: false }, textNow: true };
  return { episode: prev, textNow: !prev.texted };
}

/** The frozen-scheduler text (F13): a ⏰ card. The cause, how many jobs are stuck, what Pulse is doing, the next action, and the time in 24-hour form. */
export function composeText(kicked: string[], pendedCount: number, startedAt: string): string {
  const since = new Date(startedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return textCard({
    kind: "scheduler",
    title: "Scheduler frozen",
    body: [
      "launchd stopped starting scheduled jobs, usually after a cancelled update restart.",
      `${pendedCount} LifeOS jobs are stuck. Pulse kicks them every 5 minutes (${kicked.length} just now).`,
      "Quit Stream Deck first, then restart your Mac, or the restart cancels again.",
      `Frozen since ${since}.`,
    ],
    cap: 400,
  });
}

// ── IO ───────────────────────────────────────────────────────────────────────

function run(cmd: string[]): string {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(r.stdout);
}

/** A probe whose exit status is kept: empty output from a failed command is "unknown", never "healthy". */
export const probe: Probe = (cmd) => {
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    const stdout = new TextDecoder().decode(r.stdout);
    if (r.exitCode === 0) return { ok: true, stdout, detail: "" };
    return { ok: false, stdout, detail: `${cmd[0]} exited ${r.exitCode ?? "by signal"}` };
  } catch (e) {
    return { ok: false, stdout: "", detail: `${cmd[0]} could not run: ${e instanceof Error ? e.message.slice(0, 120) : "error"}` };
  }
};

/** Exit code for a report: frozen and a failed probe are both non-zero, and a frozen scheduler outranks an unreadable probe. */
export function exitCodeForReport(r: Pick<CheckReport, "frozen" | "probeErrors">): number {
  if (r.frozen) return EXIT_FROZEN;
  return r.probeErrors.length > 0 ? EXIT_PROBE_FAILED : 0;
}

export function intervalJobs(): IntervalJob[] {
  if (!existsSync(AGENTS_DIR)) return [];
  const out: IntervalJob[] = [];
  for (const f of readdirSync(AGENTS_DIR)) {
    if (!f.startsWith("com.lifeos.") || !f.endsWith(".plist")) continue;
    const iv = run(["plutil", "-extract", "StartInterval", "raw", "-o", "-", join(AGENTS_DIR, f)]).trim();
    if (!/^\d+$/.test(iv)) continue;
    out.push({ label: f.slice(0, -".plist".length), intervalS: Number(iv) });
  }
  return out;
}

function uid(): string {
  return String(process.getuid?.() ?? run(["id", "-u"]).trim());
}

export function check(runProbe: Probe = probe, listJobs: () => IntervalJob[] = intervalJobs): CheckReport {
  const probeErrors: string[] = [];
  const logProbe = runProbe(["log", "show", "--last", LOG_WINDOW, "--style", "compact", "--predicate", `process == "launchd" AND eventMessage CONTAINS "${FROZEN_MARK}"`]);
  if (!logProbe.ok) probeErrors.push(`log probe failed: ${logProbe.detail}`);
  const logHits = logProbe.ok ? frozenFromLog(logProbe.stdout) : 0;
  const u = uid();
  const jobs: JobState[] = listJobs().map((j) => {
    const p = runProbe(["launchctl", "print", `gui/${u}/${j.label}`]);
    if (!p.ok) {
      probeErrors.push(`launchctl probe failed for ${j.label}: ${p.detail}`);
      return { ...j, pended: false, runs: null };
    }
    return { ...j, ...parseLaunchctlPrint(p.stdout) };
  });
  const pended = jobs.filter((j) => j.pended).map((j) => j.label);
  // Frozen needs the log line; with a probe failed and no hit, the state is unknown, not healthy.
  return { frozen: logHits > 0, unknown: probeErrors.length > 0 && logHits === 0, probeErrors, logHits, pended, jobs, checkedAt: new Date().toISOString() };
}

export function readState(): WatchState {
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")) as WatchState; } catch { return { lastKick: {}, episode: null }; }
}

export function writeState(s: WatchState): void {
  invariant(s && typeof s.lastKick === "object", "scheduler-watch state must carry lastKick");
  invariant(s.episode === null || (typeof s.episode.startedAt === "string" && !Number.isNaN(Date.parse(s.episode.startedAt))), "episode.startedAt must be an ISO time");
  for (const [label, iso] of Object.entries(s.lastKick)) invariant(label.startsWith("com.lifeos.") && !Number.isNaN(Date.parse(iso)), `lastKick[${label}] must be a lifeos label with an ISO time`);
  mkdirSync(join(STATE_PATH, ".."), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + "\n");
}

export function ownNumber(): string | null {
  try {
    const cfg = JSON.parse(readFileSync(BRIDGE_CONFIG, "utf8")) as { ownChannels?: { numbers?: string[] } };
    const n = cfg.ownChannels?.numbers?.[0];
    return n && /^\+\d{8,15}$/.test(n) ? n : null;
  } catch { return null; }
}

/** Text the principal's own line. Never throws; returns what happened. */
export function sendOwnText(msg: string, origin = "scheduler-watch"): { ok: boolean; reason: string } {
  const to = ownNumber();
  if (!to) return { ok: false, reason: "no own number in bridge config" };
  const r = Bun.spawnSync(["bun", SEND_TS, to, msg, "--origin", origin], { stdout: "pipe", stderr: "pipe", cwd: join(SEND_TS, "..") });
  const out = new TextDecoder().decode(r.stdout).trim();
  return r.exitCode === 0 ? { ok: true, reason: out } : { ok: false, reason: new TextDecoder().decode(r.stderr).slice(0, 200) };
}

export function heal(opts: { text: boolean }, report: CheckReport = check()): { frozen: boolean; unknown: boolean; probeErrors: string[]; kicked: string[]; pended: string[]; texted: boolean; textResult?: string } {
  // A failed probe leaves the episode as it was: closing it on "not frozen" would re-text the next freeze as new, and kicking needs a known state.
  if (report.unknown) return { frozen: false, unknown: true, probeErrors: report.probeErrors, kicked: [], pended: report.pended, texted: false, textResult: "probe failed, state unknown" };
  const state = readState();
  const nowIso = report.checkedAt;
  const kicked = report.frozen ? dueForKick(report.jobs, state.lastKick, Date.parse(nowIso)) : [];
  const u = uid();
  for (const label of kicked) {
    invariant(label.startsWith("com.lifeos."), `refusing to kick non-lifeos label ${label}`);
    Bun.spawnSync(["launchctl", "kickstart", `gui/${u}/${label}`]);
    state.lastKick[label] = nowIso;
  }
  const ep = nextEpisode(state.episode, report.frozen, nowIso);
  state.episode = ep.episode;
  let texted = false;
  let textResult: string | undefined;
  if (ep.textNow && state.episode) {
    if (opts.text) {
      const r = sendOwnText(composeText(kicked, report.pended.length, state.episode.startedAt));
      texted = r.ok;
      textResult = r.reason;
      if (r.ok) state.episode.texted = true;
    } else {
      textResult = "text suppressed (--no-text)";
    }
  }
  writeState(state);
  return { frozen: report.frozen, unknown: false, probeErrors: report.probeErrors, kicked, pended: report.pended, texted, textResult };
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "check") {
    const r = check();
    console.log(JSON.stringify(r, null, 2));
    process.exit(exitCodeForReport(r));
  } else if (cmd === "heal") {
    const r = heal({ text: !args.includes("--no-text") });
    console.log(JSON.stringify(r));
    process.exit(exitCodeForReport(r));
  } else {
    console.error("usage: SchedulerWatch.ts check | heal [--no-text]");
    process.exit(1);
  }
}
