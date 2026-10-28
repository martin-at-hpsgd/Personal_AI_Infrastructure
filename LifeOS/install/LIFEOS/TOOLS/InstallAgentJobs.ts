#!/usr/bin/env bun
/**
 * @version 1.0.4
 * LEGACY (2026-10-22): nothing runs outside Workflows. This installer only refreshes jobs that are already
 * installed and refuses new ones; each job here is migration debt that `/ic outside-workflows` blocks on.
 *
 * InstallAgentJobs.ts — materialize one launchd plist per job in agent-jobs.json and register each
 * in the per-instance services registry so Services.ts / Pulse show them.
 *
 *   bun ~/.claude/LIFEOS/TOOLS/InstallAgentJobs.ts                 # install/refresh every enabled job
 *   bun ~/.claude/LIFEOS/TOOLS/InstallAgentJobs.ts --job <id>      # one job
 *   bun ~/.claude/LIFEOS/TOOLS/InstallAgentJobs.ts --uninstall [--job <id>]
 *   bun ~/.claude/LIFEOS/TOOLS/InstallAgentJobs.ts --status
 *
 * Schedules: `every <N>m` → StartInterval; cron `M H * * DOW[,DOW|-DOW]` → StartCalendarInterval
 * (one dict per weekday; `*` = daily). Anything else is refused loudly — never silently mis-scheduled.
 * Labels are `com.lifeos.job.<id>`; logs land in LIFEOS/USER/MEMORY/STATE/agent-jobs/<id>.launchd.log.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { invariant } from "./Invariant.ts";
import { loadJobs, STATE_DIR, type Job } from "./AgentJob.ts";
import { getClaudeDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { installVerb } from "./lib/InstallVerb";

const HOME = homedir();
const LIFEOS_ROOT = process.env.LIFEOS_ROOT || getClaudeDir();
const TOOLS = join(LIFEOS_ROOT, "LIFEOS/TOOLS");
const TEMPLATE = join(TOOLS, "com.lifeos.job.plist.template");
const LAUNCH_AGENTS = join(HOME, "Library/LaunchAgents");
const USER_SERVICES = join(LIFEOS_ROOT, "LIFEOS/USER/CONFIG/services.json");
const label = (id: string) => `com.lifeos.job.${id}`;

async function sh(cmd: string[]): Promise<{ exit: number; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { exit: await proc.exited, out };
}
const uid = (await sh(["id", "-u"])).out.trim();
const domain = `gui/${uid}`;

// ── schedule → launchd XML ────────────────────────────────────────────────
export function scheduleXml(schedule: string): string {
  const every = schedule.match(/^every (\d+)m$/);
  if (every) return `<key>StartInterval</key>\n  <integer>${Number(every[1]) * 60}</integer>`;
  const m = schedule.trim().split(/\s+/);
  invariant(m.length === 5 && m[2] === "*" && m[3] === "*", `unsupported schedule "${schedule}" (need "every Nm" or "M H * * DOW")`);
  const minute = Number(m[0]), hour = Number(m[1]);
  invariant(Number.isInteger(minute) && Number.isInteger(hour) && minute >= 0 && minute < 60 && hour >= 0 && hour < 24, `bad time in "${schedule}"`);
  const days: number[] = [];
  if (m[4] !== "*") for (const part of m[4]!.split(",")) {
    const r = part.match(/^(\d)(?:-(\d))?$/);
    invariant(!!r, `bad weekday spec "${part}" in "${schedule}"`);
    const a = Number(r[1]), b = r[2] ? Number(r[2]) : a;
    // launchd weekdays are 0–7 (0 and 7 both Sunday); a reversed range would add no day and fall through to daily.
    invariant(a <= 7 && b <= 7 && a <= b, `bad weekday spec "${part}" in "${schedule}" (weekdays 0-7, ranges low-high)`);
    for (let d = a; d <= b; d++) days.push(d);
  }
  const dict = (d?: number) => `    <dict>\n      <key>Hour</key><integer>${hour}</integer>\n      <key>Minute</key><integer>${minute}</integer>${d === undefined ? "" : `\n      <key>Weekday</key><integer>${d}</integer>`}\n    </dict>`;
  if (days.length === 0) return `<key>StartCalendarInterval</key>\n${dict().replace(/^    /gm, "  ")}`;
  return `<key>StartCalendarInterval</key>\n  <array>\n${days.map((d) => dict(d)).join("\n")}\n  </array>`;
}

/** One shell word: left bare when it is plainly safe, single-quoted otherwise. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}
const shellLine = (...argv: string[]) => argv.map(shellWord).join(" ");
const xml = (v: string) => v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function render(job: Job): string {
  const bun = process.execPath;
  return readFileSync(TEMPLATE, "utf8")
    .replaceAll("{{LABEL}}", label(job.id))
    .replaceAll("{{JOB_ID}}", job.id)
    .replaceAll("{{TITLE}}", xml(job.title))
    .replaceAll("{{BUN}}", xml(bun))
    .replaceAll("{{BUN_DIR}}", xml(dirname(bun)))
    .replaceAll("{{HOME}}", xml(HOME))
    .replaceAll("{{LIFEOS_ROOT}}", xml(LIFEOS_ROOT))
    .replaceAll("{{LOG}}", xml(join(STATE_DIR, `${job.id}.launchd.log`)))
    .replaceAll("{{SCHEDULE}}", scheduleXml(job.schedule));
}

// ── services.json registry (per-instance) ─────────────────────────────────
/**
 * The install and uninstall command strings for one job. Services.ts runs a registry string through a
 * shell, so every word is quoted: an install root with a space or a shell metacharacter reaches the
 * installer as one argument and cannot inject.
 */
export function registryCommands(jobId: string, tools: string): { install: string; uninstall: string } {
  const script = join(tools, "InstallAgentJobs.ts");
  return {
    install: shellLine("bun", script, "--job", jobId),
    uninstall: shellLine("bun", script, "--uninstall", "--job", jobId),
  };
}

function syncRegistry(jobs: Job[], remove = false) {
  const list: any[] = existsSync(USER_SERVICES) ? JSON.parse(readFileSync(USER_SERVICES, "utf8")) : [];
  invariant(Array.isArray(list), "services.json must be an array");
  const ids = new Set(jobs.map((j) => label(j.id)));
  const kept = list.filter((s) => !ids.has(s.label));
  const added = remove ? [] : jobs.map((j) => ({
    label: label(j.id), title: j.title, category: "jobs", optIn: true,
    purpose: `${j.schedule} · ${j.purpose}`,
    ...registryCommands(j.id, TOOLS),
  }));
  writeFileSync(USER_SERVICES, JSON.stringify([...kept, ...added], null, 2) + "\n");
}

// ── main ──────────────────────────────────────────────────────────────────
if (import.meta.main) {
  installVerb(process.argv, "InstallAgentJobs", { extra: ["--job"] });
  const argv = process.argv.slice(2);
  const only = argv.includes("--job") ? argv[argv.indexOf("--job") + 1] : undefined;
  const all = loadJobs();
  const jobs = all.filter((j) => (only ? j.id === only : true));
  invariant(jobs.length > 0, only ? `no job "${only}"` : "no jobs");

  if (argv.includes("--status")) {
    for (const j of jobs) {
      const target = join(LAUNCH_AGENTS, `${label(j.id)}.plist`);
      const loaded = (await sh(["launchctl", "print", `${domain}/${label(j.id)}`])).exit === 0;
      console.log(`${loaded ? "● loaded   " : existsSync(target) ? "○ installed" : "· absent   "} ${label(j.id).padEnd(34)} ${j.schedule}`);
    }
    process.exit(0);
  }

  if (argv.includes("--uninstall")) {
    for (const j of jobs) {
      const target = join(LAUNCH_AGENTS, `${label(j.id)}.plist`);
      await sh(["launchctl", "bootout", domain, target]);
      if (existsSync(target)) unlinkSync(target);
      console.log(`Uninstalled ${label(j.id)}`);
    }
    syncRegistry(jobs, true);
    process.exit(0);
  }

  mkdirSync(LAUNCH_AGENTS, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  let failed = 0;
  for (const j of jobs) {
    const target = join(LAUNCH_AGENTS, `${label(j.id)}.plist`);
    if (j.enabled === false) {
      await sh(["launchctl", "bootout", domain, target]);
      if (existsSync(target)) unlinkSync(target);
      console.log(`skipped (disabled) ${label(j.id)}`);
      continue;
    }
    // Nothing runs outside Workflows (OPERATIONAL_PREFERENCES § Workflows, 2026-10-22): this runner is migration debt, so it
    // only refreshes jobs it already runs and never installs a new one. New scheduled work is a Workflow definition.
    if (!existsSync(target)) { failed++; console.error(`refused ${label(j.id)}: agent jobs are retired for new work; write a Workflow definition (workflow new <name> --template scheduled) instead`); continue; }
    writeFileSync(target, render(j));
    const lint = await sh(["plutil", "-lint", target]);
    invariant(lint.exit === 0, `plist lint failed for ${target}: ${lint.out}`);
    await sh(["launchctl", "bootout", domain, target]); // idempotent reinstall
    const boot = await sh(["launchctl", "bootstrap", domain, target]);
    if (boot.exit !== 0) { failed++; console.error(`bootstrap failed ${label(j.id)}: ${boot.out}`); continue; }
    console.log(`Installed ${label(j.id)} (${j.schedule}) → ${target}`);
  }
  syncRegistry(jobs.filter((j) => j.enabled !== false));
  process.exit(failed ? 1 : 0);
} // end import.meta.main
