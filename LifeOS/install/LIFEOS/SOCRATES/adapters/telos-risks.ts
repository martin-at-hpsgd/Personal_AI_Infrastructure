/**
 * telos-risks adapter — answers register-health questions from the TELOS
 * `## Risks (RN)` section, the principal's top-ten life risks (system of record:
 * TELOS.md, parsed by LIFEOS/TOOLS/TelosRisks.ts). Read-only; never rescores,
 * never edits TELOS.
 *
 * refs:
 *   overdue-review  — risks whose review_by is missing or ≤ today (value = count)
 *   unwatched       — risks whose detect state is `none` or `unknown` AND that link no
 *                     ACTIVE Socrates question, i.e. nothing in the system would notice
 *                     them happening (value = count). Unanswerable questions and Achilles
 *                     entries do not count as watching.
 *   broken-links    — parse errors plus link tokens that no longer resolve to a
 *                     register row, question, finding, incident, posture id, TELOS
 *                     id, runbook, or doc (value = count). A register whose links
 *                     rot is a register nobody can act from.
 *
 * Overrides (tests): LIFEOS_TELOS_PATH plus the TelosRisks resolver overrides
 * (THREATMODEL_DATA_DIR, SOCRATES_QUESTIONS_DIR, ACHILLES_REGISTRY_PATH,
 * LIFEOS_INCIDENTS_DIR, SECURITY_POSTURE_PATH, PRINCIPAL_TELOS_PATH).
 */

import type { Adapter } from "./types";
import type { AnswerInput } from "../Store";
import type { Question } from "../Registry";
import { readTelosRisks, liveResolvers, resolveLinks, overdue, unwatched, telosPath } from "../../TOOLS/TelosRisks";

const VERSION = "telos-risks/1.0.0";

export const telosRisks: Adapter = {
  name: "telos-risks",
  version: VERSION,

  async answers(questions: Question[]): Promise<AnswerInput[]> {
    const parsed = readTelosRisks();
    const touched = `telos:${telosPath()}#Risks (${parsed.risks.length} rows)`;
    const unknown = (q: Question, evidence: string, untouched: string[]): AnswerInput => ({
      question_id: q.id, verdict: "unknown", evidence, computed_from: { touched: [], untouched }, closer_version: VERSION,
    });
    if (parsed.sectionLine === null) return questions.map((q) => unknown(q, `TELOS has no \`## Risks\` section (${telosPath()})`, ["telos:Risks"]));

    return questions.map((q) => {
      const ref = q.answerer?.ref ?? "overdue-review";
      if (ref === "overdue-review") {
        const due = overdue(parsed.risks);
        return {
          question_id: q.id, verdict: due.length === 0 ? "pass" : "fail", value: due.length,
          evidence: due.length ? due.map((r) => `${r.id}${r.review_by ? `(${r.review_by})` : "(no date)"}`).join(", ") : "every risk carries a future review date",
          computed_from: { touched: [touched], untouched: ["whether the review actually rescored anything (this checks the discipline, not the judgment)"] },
          closer_version: VERSION,
        };
      }
      if (ref === "unwatched") {
        const bad = unwatched(parsed.risks, liveResolvers().socratesActive);
        return {
          question_id: q.id, verdict: bad.length === 0 ? "pass" : "fail", value: bad.length,
          evidence: bad.length ? bad.map((r) => `${r.id}(detect ${r.detect.state}, no active SOC link)`).join(", ") : "every risk with no detection of its own is linked to an active standing question",
          computed_from: { touched: [touched, "socrates:questions/*.json (status)"], untouched: ["whether the active question actually observes the scenario (semantic fit is the human review)"] },
          closer_version: VERSION,
        };
      }
      if (ref === "broken-links") {
        const res = liveResolvers();
        const errors = [...parsed.errors, ...res.missing.map((m) => `link source unavailable: ${m}`), ...resolveLinks(parsed.risks, res)];
        return {
          question_id: q.id, verdict: errors.length === 0 ? "pass" : "fail", value: errors.length,
          evidence: errors.length ? errors.slice(0, 6).join("; ") + (errors.length > 6 ? `; +${errors.length - 6} more` : "") : "section parses clean and every link resolves",
          computed_from: {
            touched: [touched, "threatmodel:risk-register.json", "socrates:questions/*.json", "achilles:registry.json", "incidents/", "security-posture § 9", "principal-telos ids"],
            untouched: ["whether a resolved link still describes the same risk (semantic drift is the human review)"],
          },
          closer_version: VERSION,
        };
      }
      return unknown(q, `unrecognized ref '${ref}'`, ["telos:Risks"]);
    });
  },
};
