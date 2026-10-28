/**
 * Keeps launchd in step with a workflow's definition: one dispatcher job evaluates every local schedule (ISA ISC-311/312),
 * so a timed workflow needs that job installed and no job of its own. Every
 * writer that can change triggers or `enabled` calls this after the save:
 * the CLI's schedule, pause, resume and put, and the Pulse page's routes
 * (ISA ISC-168). There is no second copy.
 */
import { InvariantViolation } from "../../TOOLS/Invariant.ts";
import { message } from "./format.ts";
import { definitionsDir } from "./paths.ts";
import { installSchedule, launchdOptionsFromEnv, uninstallSchedule } from "./schedule-install.ts";

export interface LaunchdSync {
  installed: boolean;
  touched: boolean;
  reason: string;
}

/**
 * The one launchd step (ISC-67, ISC-168), shared by the CLI and the Pulse page. After a schedule edit is saved it hands the
 * workflow to `engine/schedule-install.ts`: install when the definition still
 * has a cron or interval trigger, uninstall when it has none left. It never
 * runs against a test or overridden definitions home, and a launchd failure is
 * reported next to the saved triggers instead of undoing them.
 */
export async function syncLaunchd(name: string, triggers: { type: string; enabled?: boolean }[], enabled = true): Promise<LaunchdSync> {
  const opts = launchdOptionsFromEnv();
  if (opts === null) return { installed: false, touched: false, reason: "definitions home is overridden (LIFEOS_WORKFLOWS_DIR) and no launchctl is injected; launchd skipped" };
  const timed = triggers.some(t => t.enabled !== false && (t.type === "schedule" || t.type === "interval" || t.type === "once"));
  const anyTimed = triggers.some(t => t.type === "schedule" || t.type === "interval" || t.type === "once");
  if (!enabled && !anyTimed) return { installed: false, touched: false, reason: "no time trigger; nothing in launchd" };
  try {
    if (enabled && timed) {
      const result = installSchedule(name, { ...opts, defsDir: definitionsDir() });
      return { installed: result.loaded === true, touched: true, reason: result.loaded ? `scheduled by ${result.label}` : `${result.label} is not loaded; the schedule will not fire until it is` };
    }
    const result = uninstallSchedule(name, { ...opts, defsDir: definitionsDir() });
    return { installed: false, touched: true, reason: result.removedPlist ? `${enabled ? "no time trigger left" : "paused"}; the dispatcher skips it, and its leftover launchd job was removed` : `${enabled ? "no time trigger left" : "paused"}; the dispatcher skips it` };
  } catch (error) {
    if (error instanceof InvariantViolation && !/launchctl/.test(error.message)) throw error;
    return { installed: false, touched: true, reason: `launchd step failed after the change was saved: ${message(error)}` };
  }
}
