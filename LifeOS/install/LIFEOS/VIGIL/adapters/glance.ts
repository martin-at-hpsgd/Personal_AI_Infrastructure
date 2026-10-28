/** Assay judgment-layer outage alert starts and clears, keyed by caller: the alert line is parsed into its rate, counts and floor, so a moving rate never reads as an outage clearing and restarting. @version 0.3.0 */
import { lifeosPath } from "../../TOOLS/Paths";
import { join } from "node:path"; import type { VigilEvent } from "../../STATVS/lib/refuse"; import { clip, clock, event, requireSource, withCursor } from "./common";
export type Alert = { caller: string; rate: string; errors: number; calls: number; floor: string };
/** `alerts` holds caller names; `detail` the parsed line per caller. A cursor from before 0.3.0 holds whole lines, which parse back to callers. */
export type Snapshot = { alerts: string[]; at: string; detail?: Record<string, Alert> };
/** Parses Glance's formatAlert() line: `ALERT: <caller> error rate <r>% over floor <f>% (<e>/<c> calls, 24h)`. */
export function parseAlert(line: string): Alert | null { const m = line.match(/^ALERT:\s+(\S+)\s+error rate\s+([\d.]+)%\s+over floor\s+([\d.]+)%\s+\((\d+)\/(\d+) calls/); return m ? { caller: m[1]!, rate: m[2]!, floor: m[3]!, errors: Number(m[4]), calls: Number(m[5]) } : null; }
const callers = (s: Snapshot) => s.alerts.map((x) => parseAlert(x)?.caller ?? x);
const look = "Look: bun LIFEOS/ASSAY/Assay.ts report --caller";
export function diff(prev: Snapshot | undefined, next: Snapshot): VigilEvent[] {
  if (!prev) return [];
  const before = callers(prev), now = callers(next);
  const started = now.filter((c) => !before.includes(c)).map((c) => { const d = next.detail?.[c]; return event("glance", c, "alert", "medium", `Glance outage alert: ${c}`, d ? `${c} failed ${d.errors} of ${d.calls} calls in the last 24h, a ${d.rate}% error rate against a ${d.floor}% floor. Observed ${clock(next.at)}. ${look} ${c}` : `Alert on ${c}; the alert line did not parse: ${clip(next.alerts.find((x) => x.includes(c)) ?? c, 160)}. Observed ${clock(next.at)}. ${look} ${c}`, "ai", null, next.at); });
  const cleared = before.filter((c) => !now.includes(c)).map((c) => { const d = prev.detail?.[c]; return event("glance", c, "clear", "info", `Glance outage cleared: ${c}`, `${c} is back under its error floor as of ${clock(next.at)}.${d ? ` When it alerted: ${d.errors} of ${d.calls} calls failed (${d.rate}%).` : " Its rate at alert time was not recorded."} ${look} ${c}`, "ai", null, next.at); });
  return [...started, ...cleared];
}
export async function live(): Promise<Snapshot> {
  const assay = lifeosPath("ASSAY", "Assay.ts"); requireSource(assay, `the Assay CLI ${assay}`);
  const p = Bun.spawn([process.execPath, assay, "alerts"], { stdout: "pipe", stderr: "pipe" }); const timeout = setTimeout(() => p.kill(), 60000);
  try {
    const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    if (code !== 0 && code !== 1) throw new Error(`glance exited ${code}: ${stderr.slice(0, 200)}`);
    const lines = stdout.split("\n").map((x) => x.trim()).filter((x) => x && !/drift/i.test(x) && !/^no alerts/i.test(x)), parsed = lines.map(parseAlert);
    return { alerts: parsed.map((a, i) => a?.caller ?? lines[i]!), at: new Date().toISOString(), detail: Object.fromEntries(parsed.flatMap((a) => a ? [[a.caller, a]] : [])) };
  } finally { clearTimeout(timeout); }
}
export const read = () => withCursor("glance", live, diff);
