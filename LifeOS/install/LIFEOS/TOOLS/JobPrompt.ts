import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { principalTimezone } from "./lib/Timezone.ts";
import { utcOffset } from "./lib/ZonedSchedule.ts";

/** Resolve install paths before a model sees a job brief. A model must never
 * guess what a template token or a directory called LifeOS means. */
/** The runner's clock, as the model must see it: the UTC instant plus the local date, time and UTC
 * offset in the principal's current timezone (LIFEOS_TZ, else principalTimezone(), which follows the
 * location service). A job that stamps a deliverable — a subject line, an idempotency key, a
 * "generated_at" — derives it from this line and never guesses: the 16:00 customer brief carried a
 * date one day ahead for three days because nothing told the model what day it was. The machine's
 * zone is never the default: launchd runs in the Mac's home zone, so while the principal
 * was traveling every job was told the home time and a morning brief arrived hours late. */
export function clockLine(now: Date = new Date(), tz: string = process.env.LIFEOS_TZ || principalTimezone()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  const localDate = `${get("year")}-${get("month")}-${get("day")}`;
  const hh = String(Number(get("hour")) % 24).padStart(2, "0");
  return `Now: ${now.toISOString()} (UTC) = ${get("weekday")} ${localDate} ${hh}:${get("minute")} ${tz} (UTC${utcOffset(now, tz)}). Local date: ${localDate}. Use these for every date, subject, timestamp, or "since yesterday" window, and give every clock time in this zone; never infer the date.`;
}

export function buildJobPrompt(prompt: string, brief: string | undefined, root: string, stateDir: string, scripts: readonly string[], now: Date = new Date()): string {
  const expand = (value: string) => value.replaceAll("{{LIFEOS_ROOT}}", root).replaceAll("{{STATE}}", stateDir);
  const tools = scripts.map(script => {
    const path = isAbsolute(script) ? script : join(root, script);
    return `${existsSync(path) ? "AVAILABLE" : "MISSING"}: ${JSON.stringify(path)}`;
  });
  return `${expand(prompt)}\n\n## TOOL CONTRACT\n${clockLine(now)}\nJob state directory (read/write): ${stateDir}\nInstallation root: ${root}\nAllowed script inventory (paths checked on disk):\n${tools.join("\n")}\n${expand(brief ?? "Use each available script with no arguments for its usage.")}\nA missing path is a path error, not proof a capability is unavailable. Use the verified inventory above. Respect any authorization refusal; never route around it. Report completion only after reading back the result.`;
}
