/**
 * QuietHours — the one quiet-hours window for every system that texts the principal.
 *
 * The window lives in USER/CONFIG/heartbeat.json `quietHours` ({ start: "HH:mm", end: "HH:mm" },
 * in the principal's timezone, which follows his iPhone on a trip; LIFEOS/LOCATION). AgentJob and Vigil both read it here, so a night
 * text is held by the same rule whichever system sends it (night texts once landed
 * because only AgentJob checked).
 */
import { readFileSync } from "node:fs";
import { principalTimezone } from "./lib/Timezone";
import { lifeosPath } from "./Paths";

export const QUIET_HOURS_CONFIG = () => process.env.LIFEOS_QUIET_HOURS_CONFIG || lifeosPath("USER", "CONFIG", "heartbeat.json");

/** True when `now` falls inside the configured window. No config or an unreadable one means never quiet. */
export function inQuietHours(now = new Date(), configPath = QUIET_HOURS_CONFIG(), timeZone = principalTimezone()): boolean {
  try {
    const q = JSON.parse(readFileSync(configPath, "utf8")).quietHours as { start: string; end: string } | undefined;
    if (!q) return false;
    const hm = (s: string) => { const [h, m] = s.split(":").map(Number); return h! * 60 + m!; };
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const cur = Number(parts.find((p) => p.type === "hour")!.value) * 60 + Number(parts.find((p) => p.type === "minute")!.value);
    const a = hm(q.start), b = hm(q.end);
    return a > b ? cur >= a || cur < b : cur >= a && cur < b;
  } catch { return false; }
}
