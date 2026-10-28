#!/usr/bin/env bun
/**
 * @version 1.1.0
 * WatchOrder — follow a submitted DoorDash order to a terminal state and text
 * the principal at the moments that matter.
 *
 * Polls `dd-cli order status` and sends one SMS per meaningful transition via
 * `LIFEOS/TOOLS/NotifyPrincipal.ts` (destination-locked to the principal; this
 * tool cannot address anyone else). Runs in the foreground and ends with the terminal that started it; run it as a tracked background task or in a second terminal, never detached. Exits on a terminal status or after
 * --max-minutes. Every poll and send is logged.
 *
 * Usage:
 *   bun skills/Order/Tools/WatchOrder.ts --order-uuid <uuid> --label "two burritos from Example Taqueria" [--interval 60] [--max-minutes 180]
 *
 * Notifies on: picked_up ("on the way", with ETA), dasher_nearby ("about to
 * arrive"), completed, and every terminal problem (action_required,
 * order_declined, cancelled). A long silence after submit reads as "the
 * watcher is broken", so the on-the-way text is not optional.
 */

import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { principalTimezone } from "../../../LIFEOS/TOOLS/lib/Timezone";
import { getClaudeDir } from "../../../LIFEOS/TOOLS/Paths.ts";

const run = promisify(execFile);
const HOME = process.env.HOME ?? "";
const CLAUDE_DIR = getClaudeDir();
const LOG_DIR = join(CLAUDE_DIR, "LIFEOS", "MEMORY", "OBSERVABILITY");
const LOG_FILE = join(LOG_DIR, "order-watch.jsonl");
const DD_CLI = join(HOME, ".local", "bin", "dd-cli");
const NOTIFY = join(CLAUDE_DIR, "LIFEOS", "TOOLS", "NotifyPrincipal.ts");

const TERMINAL = new Set(["completed", "cancelled", "order_declined", "action_required"]);
const PROBLEM = new Set(["cancelled", "order_declined", "action_required"]);

type Status = {
  status: string;
  status_message?: string;
  merchant_name?: string;
  quoted_delivery_time?: string | null;
  delivery_window_end?: string | null;
  late_reason?: string | null;
  cancellation_reason?: string | null;
};

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function log(entry: Record<string, unknown>): void {
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

function localTime(iso?: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: principalTimezone() });
}

async function status(orderUuid: string, intent: string): Promise<Status | null> {
  try {
    const { stdout } = await run(DD_CLI, ["--json-output", "order", "status", "--order-uuid", orderUuid, "--intent", intent], {
      timeout: 60_000,
    });
    const j = JSON.parse(stdout) as { structuredContent?: { result?: Status; success?: boolean } };
    return j.structuredContent?.result ?? null;
  } catch (e) {
    log({ event: "poll_error", error: String(e).slice(0, 300) });
    return null;
  }
}

async function notify(type: string, message: string): Promise<void> {
  try {
    const { stdout } = await run("bun", [NOTIFY, "--type", type, message], { timeout: 30_000 });
    log({ event: "notified", type, message, result: stdout.trim().slice(0, 120) });
  } catch (e) {
    log({ event: "notify_error", type, message, error: String(e).slice(0, 300) });
  }
}

async function main(): Promise<number> {
  const orderUuid = arg("--order-uuid");
  const label = arg("--label", "your DoorDash order")!;
  const interval = Number(arg("--interval", "60")) * 1000;
  const maxMinutes = Number(arg("--max-minutes", "180"));
  if (!orderUuid) {
    console.error("usage: WatchOrder.ts --order-uuid <uuid> [--label <text>] [--interval <sec>] [--max-minutes <n>]");
    return 2;
  }
  const intent = `Summary: Keep the account owner informed about their delivery's progress\nuser prompt/purpose: "text me when it's about to arrive"`;
  const deadline = Date.now() + maxMinutes * 60_000;
  let last = "";
  log({ event: "start", orderUuid, label, interval, maxMinutes });

  while (Date.now() < deadline) {
    const s = await status(orderUuid, intent);
    if (s && s.status !== last) {
      log({ event: "transition", from: last || null, to: s.status, message: s.status_message ?? null, eta: s.quoted_delivery_time ?? null });
      const eta = localTime(s.quoted_delivery_time);
      if (s.status === "dasher_nearby") {
        await notify("update", `${label} is about to arrive${eta ? ` (ETA ${eta})` : ""}. Dasher is nearby.`);
      } else if (s.status === "completed") {
        await notify("success", `${label} was delivered.`);
      } else if (PROBLEM.has(s.status)) {
        const why = s.cancellation_reason ?? s.late_reason ?? s.status_message ?? "";
        await notify("warning", `${label}: ${s.status.replace(/_/g, " ")}${why ? ` — ${why}` : ""}. Check the DoorDash app.`);
      } else if (s.status === "picked_up") {
        await notify("info", `${label} is on the way${eta ? `, ETA ${eta}` : ""}. I will text again when the Dasher is nearby.`);
      }
      last = s.status;
      if (TERMINAL.has(s.status)) {
        log({ event: "done", status: s.status });
        return 0;
      }
    }
    await Bun.sleep(interval);
  }
  log({ event: "timeout", last });
  await notify("warning", `Stopped watching ${label} after ${maxMinutes} min; last status was ${last || "unknown"}. Check the DoorDash app.`);
  return 1;
}

process.exit(await main());
