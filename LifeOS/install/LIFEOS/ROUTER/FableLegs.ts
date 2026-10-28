/**
 * FableLegs.ts — how much Fable the sessions actually ran, and how much of it ran in series (Router ISA F9, R139).
 *
 * Read-only telemetry behind `Router.ts fable`. A Fable leg is one Agent dispatch whose agent is Fable (or a retired
 * Fable variant). It ends at its tool result or at the `<task-notification>` naming its tool-use id (a top-level
 * `queue-operation` record), whichever comes last: in this harness an Agent call usually returns at launch and the agent finishes later. A leg is in series when it
 * starts after another Fable leg of the same session finished, within SERIES_GAP_MS of it: work handed from one Fable
 * leg straight to the next, the pattern rule 26 exists to stop. Rule 7 says one leg per run, so a session with more
 * than one is listed.
 */
import { readFileSync, statSync } from "node:fs";
import { baseAgentOf } from "../TOOLS/models";
import { listSessions } from "./RouteAudit";

export const SERIES_GAP_MS = 10 * 60_000;
export interface FableLeg { start: number; end: number | null }
export interface FableLegReport { days: number; sessions: number; legs: number; legMinutes: number; seriesLegs: number; seriesMinutes: number; multiLegSessions: Array<{ session: string; legs: number }> }

type Line = { type?: string; timestamp?: string; content?: unknown; message?: { content?: unknown } };
type Block = { type?: string; id?: string; name?: string; tool_use_id?: string; text?: string; input?: { subagent_type?: unknown } };

/** The Fable legs in one transcript's text, in dispatch order. */
export function legsIn(text: string): FableLeg[] {
  const legs = new Map<string, FableLeg>();
  const finish = (id: string, at: number) => { const l = legs.get(id); if (l && Number.isFinite(at)) l.end = Math.max(l.end ?? at, at); };
  for (const raw of text.split("\n")) {
    if (!raw.includes("Fable") && !raw.includes("tool_result") && !raw.includes("tool-use-id")) continue;
    let l: Line; try { l = JSON.parse(raw); } catch { continue; }
    const at = l.timestamp ? Date.parse(l.timestamp) : NaN;
    // A completion notification is a top-level queue-operation record whose content is the <task-notification> text.
    const content = l.type === "queue-operation" ? l.content : l.message?.content;
    const blocks: Block[] = Array.isArray(content) ? content as Block[] : typeof content === "string" ? [{ type: "text", text: content }] : [];
    for (const b of blocks) {
      if (b.type === "tool_use" && (b.name === "Agent" || b.name === "Task") && typeof b.input?.subagent_type === "string" && baseAgentOf(b.input.subagent_type) === "Fable" && b.id && Number.isFinite(at)) legs.set(b.id, { start: at, end: null });
      else if (b.type === "tool_result" && b.tool_use_id) finish(b.tool_use_id, at);
      else if (b.type === "text" && b.text?.includes("<task-notification>")) for (const m of b.text.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>/g)) finish(m[1]!, at);
    }
  }
  return [...legs.values()].sort((a, b) => a.start - b.start);
}

/** Legs that started after an earlier leg had finished, within SERIES_GAP_MS of it. */
export function seriesOf(legs: FableLeg[]): FableLeg[] {
  return legs.filter((l, i) => legs.slice(0, i).some((p) => p.end !== null && p.end <= l.start && l.start - p.end <= SERIES_GAP_MS));
}

const minutes = (legs: FableLeg[]) => legs.reduce((s, l) => s + (l.end !== null ? l.end - l.start : 0), 0) / 60_000;

export function fableLegs(projectsDir: string, days = 7, now = Date.now()): FableLegReport {
  const since = now - days * 86_400_000;
  const r: FableLegReport = { days, sessions: 0, legs: 0, legMinutes: 0, seriesLegs: 0, seriesMinutes: 0, multiLegSessions: [] };
  let all = 0, series = 0;
  for (const s of listSessions(projectsDir)) {
    if (s.mtime < since) break; // newest first
    let text: string; try { if (statSync(s.file).size > 200 * 1024 * 1024) continue; text = readFileSync(s.file, "utf8"); } catch { continue; }
    r.sessions++;
    const legs = legsIn(text).filter((l) => l.start >= since);
    if (legs.length === 0) continue;
    const chained = seriesOf(legs);
    r.legs += legs.length; r.seriesLegs += chained.length;
    all += minutes(legs); series += minutes(chained);
    if (legs.length > 1) r.multiLegSessions.push({ session: s.id.slice(0, 8), legs: legs.length });
  }
  r.legMinutes = Math.round(all * 10) / 10; r.seriesMinutes = Math.round(series * 10) / 10;
  r.multiLegSessions.sort((a, b) => b.legs - a.legs);
  return r;
}

export function formatFableLegs(r: FableLegReport): string {
  const multi = r.multiLegSessions.length ? r.multiLegSessions.slice(0, 10).map((m) => `${m.session} ×${m.legs}`).join(", ") : "none";
  return `Fable legs, last ${r.days} day(s), ${r.sessions} session(s): ${r.legs} legs ran ${r.legMinutes} min; ${r.seriesLegs} started right after another Fable leg (${r.seriesMinutes} min in series)\nSessions over one leg (rule 7): ${multi}`;
}
