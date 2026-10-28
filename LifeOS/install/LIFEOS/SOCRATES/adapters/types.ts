/**
 * Socrates adapter contract.
 *
 * An adapter is a versioned, read-only bridge from an EXISTING engine to the
 * answer store. Adapters never probe the world themselves beyond reading the
 * engine's own output (no parallel scanner — standing rule). Contract:
 *
 * - `version` stamps every answer (closer_version) so an upgrade is
 *   distinguishable from the world changing.
 * - `answers()` receives the active questions assigned to this adapter and
 *   returns one AnswerInput per question (or per instance). A question the
 *   adapter cannot answer THIS RUN comes back verdict "unknown" with the
 *   reason in evidence — never omitted, never pass.
 * - Any thrown error is caught by the runner and converted to unknown for
 *   every assigned question (fail-visible, Store invariant).
 * - computed_from declares what was read AND what bearing sources were not.
 */

import type { AnswerInput } from "../Store";
import type { Question } from "../Registry";

export interface Adapter {
  name: string;
  version: string;
  answers(questions: Question[]): Promise<AnswerInput[]>;
}

/** Uniform unknown for a whole adapter failure — the runner's safety net. */
export function allUnknown(qs: Question[], adapter: Adapter, reason: string): AnswerInput[] {
  return qs.map((q) => ({
    question_id: q.id,
    verdict: "unknown" as const,
    evidence: `adapter error: ${reason.slice(0, 200)}`,
    computed_from: { touched: [], untouched: [adapter.name] },
    closer_version: adapter.version,
  }));
}
