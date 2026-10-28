/**
 * scheduled — unified view of every recurring job LifeOS runs, wherever it runs.
 *
 * Scheduled work had two partial homes and no single one: `Services.ts` knew the
 * launchd registry but only from a CLI, and the cloud workflows' cron triggers lived in
 * worker configs nobody reads. A job that silently stopped looked exactly like
 * a healthy one. This module is the union.
 *
 * Three executors, one ledger:
 *
 *   local   — launchd on this machine. Registry from `LIFEOS/TOOLS/Services.ts`
 *             (imported, never copied) joined against live `launchctl` state, so
 *             the response reports reality rather than intent.
 *   workflows — Cloudflare Workers. Cron expressions parsed from each worker's own
 *             worker config (cloudflare.config.ts), which is the deploy source of truth.
 *   hermes  — the sidecar's scheduler, where delivered agent work lives
 *             (a scheduled text or brief).
 *
 * Read-only by construction: it reports state and never installs, starts, or
 * stops anything. Mutating a service stays with `Services.ts` (launchd) and the
 * Assistant module's cron CRUD, each behind its own confirmations.
 *
 * These are COLLECTORS, not an HTTP surface. `/assistant` already owns the
 * scheduled-task view and its source model; this feeds `aggregateTasks()` there.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { allServices, cadenceOf, findPlist, loadedLabels } from "../../TOOLS/Services.ts";
import { checkHermesHealth, type HermesHealth } from "../../HERMES/Health.ts";
import { cloudCronJobsAt } from "../../WORKFLOWS/sources/cloud.ts";
import { parseJsonc, describeCron } from "../../WORKFLOWS/sources/shared.ts";

const HOME = homedir();
const CLOUD_WORKERS = join(HOME, ".claude/LIFEOS/USER/CUSTOMIZATIONS/WORKFLOWS/Workers");
const HERMES_HOME = process.env.HERMES_HOME || join(HOME, ".hermes");

export type Executor = "local" | "workflows" | "hermes";
export type JobState = "running" | "installed" | "available" | "unknown";

export interface ScheduledJob {
  id: string;
  title: string;
  executor: Executor;
  cadence: string;
  state: JobState;
  purpose?: string;
  category?: string;
  /** Last observed activity, when the executor exposes one. */
  lastRun?: string;
}

// ── local (launchd) ──────────────────────────────────────────────────────────

function localJobs(): ScheduledJob[] {
  const loaded = loadedLabels();
  return allServices().map((svc) => {
    const plist = findPlist(svc.label);
    // Three genuinely different conditions, and collapsing them is what made a
    // dead job indistinguishable from a healthy one:
    //   running   — loaded in launchd right now
    //   installed — plist on disk but not loaded (it stopped, or never started)
    //   available — known to the registry, never installed (an opt-in)
    const jobState: JobState = loaded.has(svc.label)
      ? "running"
      : plist?.installed
        ? "installed"
        : "available";
    return {
      id: svc.label,
      title: svc.title,
      executor: "local" as const,
      cadence: plist ? cadenceOf(plist.path) : "—",
      state: jobState,
      purpose: svc.purpose,
      category: svc.category,
    };
  });
}

// ── cloud (Cloudflare) ───────────────────────────────────────────────────────

function cloudJobs(): ScheduledJob[] {
  return cloudCronJobsAt(CLOUD_WORKERS);
}

// ── hermes (sidecar) ─────────────────────────────────────────────────────────

function hermesJobs(): ScheduledJob[] {
  const jobsFile = join(HERMES_HOME, "cron", "jobs.json");
  if (!existsSync(jobsFile)) return [];
  try {
    const raw = parseJsonc(readFileSync(jobsFile, "utf8")) as
      | { jobs?: Record<string, unknown>[] }
      | Record<string, unknown>[];
    const list = Array.isArray(raw) ? raw : (raw.jobs ?? []);
    return list.map((j) => {
      const job = j as {
        id?: string; name?: string; prompt?: string;
        // Hermes ≥2026-07 stores schedule as {kind, expr?, minutes?, display};
        // older installs stored a bare cron string. Handle both — an object
        // reaching describeCron() threw, and the catch degraded EVERY hermes
        // job to an empty list (found 2026-08-08, Heartbeat wiring).
        schedule?: string | { display?: string; expr?: string; minutes?: number };
        schedule_display?: string; interval?: string; enabled?: boolean;
        no_agent?: boolean;
      };
      const cadence =
        typeof job.schedule === "string"
          ? describeCron(job.schedule)
          : job.schedule_display || job.schedule?.display ||
            (job.schedule?.expr ? describeCron(job.schedule.expr) : "") ||
            (job.schedule?.minutes ? `every ${job.schedule.minutes}m` : job.interval ?? "—");
      return {
        id: job.id || job.name || "job",
        title: job.name || job.prompt?.slice(0, 60) || "scheduled agent turn",
        executor: "hermes" as const,
        cadence,
        state: (job.enabled === false ? "installed" : "running") as JobState,
        purpose: job.prompt?.slice(0, 160),
        category: job.no_agent ? "script" : "agent",
      };
    });
  } catch {
    return [];
  }
}

/**
 * Health of the sidecar PROCESS, distinct from both the jobs it holds and the
 * scheduler tick. Listing a sidecar's cron jobs while saying nothing about
 * whether the gateway behind them is alive is how a crash loop once went
 * unnoticed (2026-07-30) — the surface looked covered.
 *
 * Best-effort: any failure degrades to null so a broken sidecar can never take
 * the dashboard down with it.
 */
function hermesHealth(): HermesHealth | null {
  try {
    return checkHermesHealth();
  } catch {
    return null;
  }
}

/** Liveness of the sidecar scheduler itself, distinct from the jobs it holds. */
function hermesTicker(): { present: boolean; lastBeat?: string } {
  const beat = join(HERMES_HOME, "cron", "ticker_last_success");
  if (!existsSync(beat)) return { present: existsSync(join(HERMES_HOME, "cron")) };
  try {
    return { present: true, lastBeat: statSync(beat).mtime.toISOString() };
  } catch {
    return { present: true };
  }
}

// ── collector exports ────────────────────────────────────────────────────────
//
// This file is a LIBRARY, not a Pulse module. The scheduled-task surface lives
// at /assistant (Tasks tab), which already owns cron CRUD and a source model.
// Standing up a second endpoint here would have re-created the fragmentation
// this work exists to remove, so these collectors feed `aggregateTasks()`.

export { localJobs, cloudJobs, hermesJobs, hermesTicker, hermesHealth };
export type { HermesHealth };
