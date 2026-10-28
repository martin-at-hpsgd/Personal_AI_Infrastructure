/**
 * router adapter — Router ISA R8: is heavy work actually leaving the carrier?
 *
 * refs: off-carrier[:<window-days>]   default window 7
 *
 * Reads RouteAudit over the sessions of the last N days and answers with the off-carrier
 * rate among heavy sessions (≥ TOOL_CALL_THRESHOLD tool calls that dispatched a lower
 * Claude tier or a codex lane). The ideal is the question's `expect.gte` (percent);
 * absent, 50. No heavy session in the window → unknown, never pass.
 *
 * refs: route-target[:<window-days>]   default window 7 (Router ISA R169)
 *
 * The routing target is the smartest result, never the cheapest, so neither the delegation rate nor spend is the verdict. This
 * ref compares the window with the one before it on corrections per 100 judged turns and fails only when they rose
 * past tolerance. The top-rung share of Claude output is reported beside it, as information.
 */

import { auditSessions, defaultOptions } from "../../ROUTER/RouteAudit";
import type { Adapter } from "./types";
import type { AnswerInput } from "../Store";
import type { Question } from "../Registry";

const VERSION = "1.2.0";

/** How far corrections per 100 may drift up before the target fails: noise, not a change. */
export const QUALITY_TOLERANCE = 0.5;
/** Below this many judged turns a window has no quality reading (RouteAudit's own outcome floor). */
export const MIN_JUDGED = 20;

export interface WindowStats { judged: number; corrected: number; topRungShare: number; topModel?: string }

/**
 * The week-over-week verdict, on quality alone: fail when corrections per 100 judged turns rose past QUALITY_TOLERANCE
 * (unrounded), unknown when either window judged fewer than MIN_JUDGED turns. Spend never changes the verdict; the
 * top-rung share rides in the evidence, with a note when the top model changed between windows.
 */
export function targetVerdict(cur: WindowStats, prev: WindowStats): { verdict: "pass" | "fail" | "unknown"; evidence: string } {
  if (cur.judged < MIN_JUDGED || prev.judged < MIN_JUDGED) return { verdict: "unknown", evidence: `too few judged turns (this window ${cur.judged}, previous ${prev.judged}; need ${MIN_JUDGED})` };
  const rate = (w: WindowStats) => (w.corrected / w.judged) * 100;
  const show = (n: number) => Math.round(n * 10) / 10;
  const q = rate(cur), qp = rate(prev);
  const modelNote = cur.topModel && prev.topModel && cur.topModel !== prev.topModel ? ` (top model ${prev.topModel} → ${cur.topModel})` : "";
  const evidence = `corrections/100 ${show(qp)}→${show(q)}; for information, top-rung share ${prev.topRungShare}%→${cur.topRungShare}%${modelNote}`;
  return { verdict: q > qp + QUALITY_TOLERANCE ? "fail" : "pass", evidence };
}

function statsOf(a: ReturnType<typeof auditSessions>): WindowStats {
  const d = a.outcomeByDelegation;
  return { judged: d.delegated.judged + d.notDelegated.judged, corrected: d.delegated.corrected + d.notDelegated.corrected, topRungShare: a.topRungShare, topModel: a.topModel };
}

export function windowFor(q: Question): number {
  const m = /^(?:off-carrier|route-target)(?::(\d+))?$/.exec(q.answerer?.ref ?? "off-carrier");
  return m?.[1] ? Number(m[1]) : 7;
}

export const router: Adapter = {
  name: "router",
  version: VERSION,
  async answers(questions: Question[]): Promise<AnswerInput[]> {
    return questions.map((q) => {
      const days = windowFor(q);
      const opts = defaultOptions([]);
      if ((q.answerer?.ref ?? "").startsWith("route-target")) {
        const now = Date.now(), span = days * 86_400_000;
        const cur = statsOf(auditSessions({ ...opts, sessions: undefined, sinceMs: now - span }));
        const prev = statsOf(auditSessions({ ...opts, sessions: undefined, sinceMs: now - 2 * span, untilMs: now - span }));
        const t = targetVerdict(cur, prev);
        return {
          question_id: q.id, verdict: t.verdict, value: cur.topRungShare, evidence: t.evidence,
          computed_from: { touched: [`harness transcripts and turn outcomes, last ${days}d against the ${days}d before`], untouched: ["Inference.ts helper calls (no transcript)", "sessions on other machines", "codex spend (top-rung share counts Claude output only)"] },
          closer_version: VERSION,
        };
      }
      const a = auditSessions({ ...opts, sessions: undefined, sinceMs: Date.now() - days * 86_400_000 });
      const computed_from = {
        touched: [`harness transcripts (${a.sessions} sessions, last ${days}d)`, "codex rollout logs (attributed by window)"],
        untouched: ["Inference.ts helper calls (no transcript)", "sessions on other machines"],
      };
      if (a.heavy === 0) return { question_id: q.id, verdict: "unknown", evidence: `no heavy session in the last ${days}d`, computed_from, closer_version: VERSION };
      const ideal = q.expect?.gte ?? 50;
      return {
        question_id: q.id,
        verdict: a.offCarrierRate >= ideal ? "pass" : "fail",
        value: a.offCarrierRate,
        evidence: `heavy=${a.heavy} off-carrier=${a.heavyOffCarrier} (${a.offCarrierRate}%) delegated=${a.heavyDelegated} top-rung-share=${a.topRungShare}%`,
        computed_from,
        closer_version: VERSION,
      };
    });
  },
};
