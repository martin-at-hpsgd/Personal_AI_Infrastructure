/**
 * usage adapter — answers "is automatic (unattended) work staying off the Anthropic
 * subscription?" from the durable per-day usage rollup that UsageAggregator.ts writes
 * nightly (MEMORY/OBSERVABILITY/usage-daily.jsonl, `automatic` sub-rollup: sessions the
 * LoadContext hook recorded with a non-desktop channel).
 *
 * refs: automatic-spend[:<usd-per-day>]   default ceiling 5
 *
 * Reads the engine's output only. Unknown (never pass) when the rollup is missing or
 * stale (newest row older than 2 days: the aggregator job is not running) or when the
 * session-channel registry has never been written (nothing could be classified).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "./types";
import type { AnswerInput } from "../Store";
import type { Question } from "../Registry";

const VERSION = "usage/1.0.0";
const CLAUDE = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const OBS = () => process.env.SOCRATES_USAGE_OBS_DIR ?? join(CLAUDE, "LIFEOS/MEMORY/OBSERVABILITY");
const WINDOW_DAYS = 7;
const STALE_DAYS = 2;

interface DayRow { date: string; costUsd: number; automatic?: { sessions: number; messages: number; costUsd: number } }

export function ceilingFor(q: Question): number {
  const m = /^automatic-spend(?::([0-9.]+))?$/.exec(q.answerer?.ref ?? "automatic-spend");
  const n = m?.[1] ? Number(m[1]) : 5;
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/** The last WINDOW_DAYS complete UTC days (yesterday backwards), oldest first. */
export function windowDates(now = new Date()): string[] {
  const out: string[] = [];
  for (let i = WINDOW_DAYS; i >= 1; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export const usage: Adapter = {
  name: "usage",
  version: VERSION,

  async answers(questions: Question[]): Promise<AnswerInput[]> {
    const dailyPath = join(OBS(), "usage-daily.jsonl");
    const channelsPath = join(OBS(), "session-channels.jsonl");
    const computed_from = {
      touched: ["usage-daily.jsonl (automatic sub-rollup, last 7 complete UTC days)", "session-channels.jsonl (presence)"],
      untouched: ["API-key spend (CostTracker)", "OpenAI spend (openai-usage.jsonl)", "sessions started before the channel registry existed"],
    };
    const unknown = (evidence: string): AnswerInput[] => questions.map((q) => ({ question_id: q.id, verdict: "unknown" as const, evidence, computed_from, closer_version: VERSION }));

    if (!existsSync(dailyPath)) return unknown("usage-daily.jsonl absent — UsageAggregator has never run");
    if (!existsSync(channelsPath)) return unknown("session-channels.jsonl absent — no session has been classified yet");
    if (!/"channel"\s*:\s*"(?!desktop")/.test(readFileSync(channelsPath, "utf8"))) return unknown("session-channels.jsonl holds no non-desktop session yet — nothing classified");
    const rows: DayRow[] = [];
    for (const line of readFileSync(dailyPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip */ }
    }
    if (rows.length === 0) return unknown("usage-daily.jsonl is empty");
    const sortedDates = rows.map((r) => r.date).sort();
    const newest = sortedDates[sortedDates.length - 1]!;
    const ageDays = (Date.now() - Date.parse(newest + "T00:00:00Z")) / 86_400_000;
    const fileAgeDays = (Date.now() - statSync(dailyPath).mtimeMs) / 86_400_000;
    if (fileAgeDays > STALE_DAYS) return unknown(`usage-daily.jsonl last written ${fileAgeDays.toFixed(1)}d ago — aggregator job not running`);

    const dates = windowDates();
    const byDate = new Map(rows.map((r) => [r.date, r]));
    let auto = 0, total = 0, sessions = 0, covered = 0;
    for (const d of dates) {
      const r = byDate.get(d);
      if (!r) continue; // a day with no row is a day with no usage
      covered++;
      auto += r.automatic?.costUsd ?? 0;
      total += r.costUsd ?? 0;
      sessions += r.automatic?.sessions ?? 0;
    }
    const perDay = auto / WINDOW_DAYS;
    return questions.map((q) => {
      const ceiling = ceilingFor(q);
      return {
        question_id: q.id,
        verdict: perDay < ceiling ? "pass" : "fail",
        value: Math.round(perDay * 100) / 100,
        evidence: `automatic $${auto.toFixed(2)} over ${dates[0]}..${dates[dates.length - 1]} (${covered}/${WINDOW_DAYS} days with rows, ${sessions} automatic sessions) = $${perDay.toFixed(2)}/day vs ceiling $${ceiling}; all sessions $${total.toFixed(2)}; newest row ${newest} (${ageDays.toFixed(1)}d)`,
        computed_from, closer_version: VERSION,
      };
    });
  },
};
