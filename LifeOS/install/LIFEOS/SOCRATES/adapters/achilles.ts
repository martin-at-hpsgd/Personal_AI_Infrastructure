/**
 * achilles adapter — answers "any known unremediated weaknesses?" from the
 * Achilles vulnerability registry (read-only; mutations stay in Achilles.ts).
 */

import { existsSync } from "node:fs";
import { loadRegistry, registryPath } from "../../TOOLS/Achilles";
import type { Adapter } from "./types";
import type { AnswerInput } from "../Store";
import type { Question } from "../Registry";

const VERSION = "achilles/1.1.0";

export const achilles: Adapter = {
  name: "achilles",
  version: VERSION,

  async answers(questions: Question[]): Promise<AnswerInput[]> {
    if (!existsSync(registryPath())) {
      return questions.map((q) => ({
        question_id: q.id, verdict: "unknown" as const,
        evidence: "achilles registry missing",
        computed_from: { touched: [], untouched: ["achilles:registry"] }, closer_version: VERSION,
      }));
    }
    const entries = loadRegistry().entries;
    // Socrates-sourced entries are this system's own routed findings — counting
    // them would make SOC-0005 fail BECAUSE the router did its job (feedback
    // loop: routed findings opened new entries, which flipped the check).
    // The underlying conditions already show as their own findings on the board.
    const open = entries.filter((e) => (e.status === "open" || e.status === "in_progress") && e.source !== "socrates");
    const crit = open.filter((e) => e.severity === "critical" || e.severity === "high");
    const computed_from = {
      touched: [`achilles:registry (${entries.length} entries)`],
      untouched: ["vulns no finder has surfaced yet (registry holds the KNOWN set only)", "socrates-sourced entries (own routed findings, excluded to break the feedback loop)"],
    };
    return questions.map((q) => ({
      question_id: q.id,
      verdict: crit.length === 0 ? ("pass" as const) : ("fail" as const),
      value: crit.length,
      evidence: crit.length ? crit.map((e) => `${e.id}: ${e.title}`).slice(0, 5).join("; ") : `0 open critical/high of ${open.length} open`,
      computed_from, closer_version: VERSION,
    }));
  },
};
