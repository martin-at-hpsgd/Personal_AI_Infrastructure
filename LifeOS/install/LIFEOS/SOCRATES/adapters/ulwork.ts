/**
 * ulwork adapter — reads the WorkSweep digest's structured twin
 * (LIFEOS/MEMORY/STATE/work-attention.json, written by LIFEOS/TOOLS/WorkSweep.ts)
 * and answers:
 *   ref `stale-p1`       — overdue issues + P1 issues idle ≥ 7d (value = count)
 *   ref `stale-projects` — PROJECTS.md rows with no commit in 14d (value = count)
 * Never calls gh itself: the sweep is the engine, this reads its output.
 * A digest older than 2× the sweep cadence is unobservable → unknown.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "./types";
import type { AnswerInput } from "../Store";
import type { Question } from "../Registry";

const VERSION = "ulwork/1.0.0";
const CLAUDE = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
export const ATTENTION_PATH = process.env.SOCRATES_WORK_ATTENTION ?? join(CLAUDE, "LIFEOS/MEMORY/STATE/work-attention.json");
/** WorkSweep runs hourly; twice that is the staleness line. */
const MAX_AGE_MS = 2 * 60 * 60_000;

interface Attention {
  updated: string;
  overdue: Array<{ number: number; title: string }>;
  stale_p1?: Array<{ number: number; title: string; idle_days: number }>;
  stale_projects: string[];
}

export const ulwork: Adapter = {
  name: "ulwork",
  version: VERSION,

  async answers(questions: Question[]): Promise<AnswerInput[]> {
    if (!existsSync(ATTENTION_PATH)) throw new Error(`no work-attention.json at ${ATTENTION_PATH}`);
    const att = JSON.parse(readFileSync(ATTENTION_PATH, "utf8")) as Attention;
    const age = Date.now() - Date.parse(att.updated);
    const computed_from = {
      touched: [`worksweep:work-attention.json (updated ${att.updated})`],
      untouched: ["live gh issue state (sweep output only)", "agent-assigned lanes", "issue comments"],
    };
    return questions.map((q) => {
      if (!(age < MAX_AGE_MS)) {
        return { question_id: q.id, verdict: "unknown" as const, evidence: `digest is ${Math.round(age / 60_000)}m old — treating as unobservable`, computed_from, closer_version: VERSION };
      }
      const ref = q.answerer?.ref ?? "stale-p1";
      if (ref === "stale-p1") {
        if (!att.stale_p1) {
          return { question_id: q.id, verdict: "unknown" as const, evidence: "digest predates the stale_p1 field — wait for the next sweep", computed_from, closer_version: VERSION };
        }
        const n = att.overdue.length + att.stale_p1.length;
        const ev = [
          ...att.overdue.slice(0, 4).map((i) => `overdue #${i.number}`),
          ...att.stale_p1.slice(0, 4).map((i) => `P1 #${i.number} idle ${i.idle_days}d`),
        ];
        return { question_id: q.id, verdict: n === 0 ? ("pass" as const) : ("fail" as const), value: n, evidence: n ? ev.join(", ") : "no overdue issues, no idle P1s", computed_from, closer_version: VERSION };
      }
      if (ref === "stale-projects") {
        const n = att.stale_projects.length;
        return { question_id: q.id, verdict: n === 0 ? ("pass" as const) : ("fail" as const), value: n, evidence: n ? att.stale_projects.slice(0, 8).join(", ") : "every project committed inside 14d", computed_from, closer_version: VERSION };
      }
      return { question_id: q.id, verdict: "unknown" as const, evidence: `unrecognized ref '${ref}'`, computed_from: { touched: [], untouched: ["worksweep:work-attention.json"] }, closer_version: VERSION };
    });
  },
};
