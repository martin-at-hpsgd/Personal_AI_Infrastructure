/**
 * state adapter — reads the state-logging skill journal (LIFEOS/TOOLS/State.ts data) and
 * answers two question shapes:
 *   ref `freshness` — W/K days-since vs each dimension's targetDays (one instance per dim)
 *   ref `slope`     — 14-day slope of M/E/S ratings (one instance per dim); unknown below 4 points
 * Reads current.json + log.jsonl only. Self-report data: a dimension never
 * logged is `unknown`, never pass.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "./types";
import type { AnswerInput } from "../Store";
import type { Question } from "../Registry";
import { DIMENSIONS } from "../../TOOLS/State";

const VERSION = "state/1.0.0";
const CLAUDE = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
export const STATE_DIR = process.env.SOCRATES_STATE_DIR ?? join(CLAUDE, "LIFEOS/USER/STATE");

const FRESHNESS_DIMS = ["W", "K"] as const;
const SLOPE_DIMS = ["M", "E", "S"] as const;
const SLOPE_WINDOW_DAYS = 14;
const SLOPE_MIN_POINTS = 4;
/** Ratings are 1–5; a drop steeper than this per week is the alarm. */
const SLOPE_FAIL_PER_WEEK = -0.5;

interface Current { updated: string; dims: Record<string, { value: number | null; ts: string }> }
interface Entry { ts: string; dim: string; value?: number | null }

/** Least-squares slope in rating-points per week. Exported for tests. */
export function slopePerWeek(points: Array<{ t: number; v: number }>): number {
  const n = points.length;
  const mt = points.reduce((s, p) => s + p.t, 0) / n;
  const mv = points.reduce((s, p) => s + p.v, 0) / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.t - mt) * (p.v - mv); den += (p.t - mt) ** 2; }
  if (den === 0) return 0;
  return (num / den) * 7 * 86_400_000; // per-ms → per-week
}

export const state: Adapter = {
  name: "state",
  version: VERSION,

  async answers(questions: Question[]): Promise<AnswerInput[]> {
    const curPath = join(STATE_DIR, "current.json");
    const logPath = join(STATE_DIR, "log.jsonl");
    if (!existsSync(curPath)) throw new Error(`no current.json at ${curPath}`);
    const cur = JSON.parse(readFileSync(curPath, "utf8")) as Current;
    const now = Date.now();
    const out: AnswerInput[] = [];

    for (const q of questions) {
      const ref = q.answerer?.ref ?? "freshness";
      if (ref === "freshness") {
        const computed_from = { touched: ["state:current.json"], untouched: ["device data (Apple Health, PJ3)", "log.jsonl history"] };
        for (const dim of FRESHNESS_DIMS) {
          const target = DIMENSIONS[dim].targetDays ?? 1;
          const row = cur.dims[dim];
          if (!row?.ts) {
            out.push({ question_id: q.id, instance_key: dim, verdict: "unknown", evidence: `${DIMENSIONS[dim].name} never logged`, computed_from, closer_version: VERSION });
            continue;
          }
          const days = (now - Date.parse(row.ts)) / 86_400_000;
          const pass = days <= target;
          out.push({
            question_id: q.id, instance_key: dim,
            verdict: pass ? "pass" : "fail", value: Math.round(days * 10) / 10,
            evidence: `${DIMENSIONS[dim].name}: ${days.toFixed(1)}d since last (target ${target}d)`,
            computed_from, closer_version: VERSION,
          });
        }
      } else if (ref === "slope") {
        const computed_from = { touched: ["state:log.jsonl (last 14d)"], untouched: ["device data (Apple Health, PJ3)", "notes text"] };
        const entries: Entry[] = existsSync(logPath)
          ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Entry)
          : [];
        const since = now - SLOPE_WINDOW_DAYS * 86_400_000;
        for (const dim of SLOPE_DIMS) {
          const pts = entries
            .filter((e) => e.dim === dim && typeof e.value === "number" && Date.parse(e.ts) >= since)
            .map((e) => ({ t: Date.parse(e.ts), v: e.value as number }));
          if (pts.length < SLOPE_MIN_POINTS) {
            out.push({ question_id: q.id, instance_key: dim, verdict: "unknown", value: pts.length, evidence: `${DIMENSIONS[dim].name}: ${pts.length} points in ${SLOPE_WINDOW_DAYS}d (need ${SLOPE_MIN_POINTS})`, computed_from, closer_version: VERSION });
            continue;
          }
          const s = slopePerWeek(pts);
          const pass = s > SLOPE_FAIL_PER_WEEK;
          out.push({
            question_id: q.id, instance_key: dim,
            verdict: pass ? "pass" : "fail", value: Math.round(s * 100) / 100,
            evidence: `${DIMENSIONS[dim].name}: slope ${s.toFixed(2)}/week over ${pts.length} points (fail below ${SLOPE_FAIL_PER_WEEK})`,
            computed_from, closer_version: VERSION,
          });
        }
      } else {
        out.push({ question_id: q.id, verdict: "unknown", evidence: `unrecognized ref '${ref}'`, computed_from: { touched: [], untouched: ["state:current.json"] }, closer_version: VERSION });
      }
    }
    return out;
  },
};
