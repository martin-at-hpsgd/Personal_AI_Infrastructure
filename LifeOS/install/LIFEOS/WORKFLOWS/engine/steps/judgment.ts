/**
 * The `judgment` step (ISC-30, ISC-132): asks Assay's judgment layer one typed yes/no
 * question through the step's registered caller and exposes the result for a
 * downstream `when:` as `steps.<id>.output.act`.
 *
 * Glance decides whether code may act; this executor never reads a threshold
 * itself. While the caller is in shadow mode (or unregistered) the Glance
 * verdict is recorded on the output under `glance` but `act` carries the
 * step's declared fallback, so the verdict cannot gate anything until the
 * caller is switched to enforce. The fallback is the step's `fallback` key when
 * the definition format carries one, else the `default` its output schema
 * declares for `act`, else false (do not act).
 */
import { invariant } from "../../../TOOLS/Invariant.ts";
import { judge } from "../../../ASSAY/Assay.ts";
import type { JudgmentClient, JudgmentReply } from "./types.ts";

export interface JudgmentOutput {
  act: boolean;
  fallback_used: boolean;
  glance: JudgmentReply;
}

/** The fallback a shadow-mode judgment step uses for `act`. */
export function declaredFallback(step: { output?: unknown } & Record<string, unknown>): boolean {
  if (typeof step.fallback === "boolean") return step.fallback;
  const schema = step.output as { properties?: { act?: { default?: unknown } } } | undefined;
  const fromSchema = schema?.properties?.act?.default;
  return typeof fromSchema === "boolean" ? fromSchema : false;
}

export function questionIdFor(workflow: string, stepId: string): string {
  return `${workflow}.${stepId}`;
}

export async function executeJudgmentStep(
  call: { workflow: string; stepId: string; caller: string; question: string; state: unknown; fallback: boolean; signal?: AbortSignal },
  client: JudgmentClient,
): Promise<JudgmentOutput> {
  invariant(call.caller.length > 0, `Judgment step "${call.stepId}" names no Glance caller`);
  const reply = await client.judge({ caller: call.caller, questionId: questionIdFor(call.workflow, call.stepId), question: call.question, state: call.state, signal: call.signal });
  if (reply.mode === "enforce") return { act: reply.act, fallback_used: false, glance: reply };
  return { act: call.fallback, fallback_used: true, glance: reply };
}

/** The production client: Glance.judge with a noul question; decide() inside it is the only thing that can say act. */
export const liveJudgmentClient: JudgmentClient = {
  async judge(request) {
    const result = await judge(request.state as object, { [request.questionId]: { type: "noul", instructions: request.question } }, { caller: request.caller });
    const entry = result[request.questionId];
    invariant(entry !== undefined, `Glance returned no answer for ${request.questionId}`);
    const probability = entry.answer.type === "noul" ? entry.answer.noul : undefined;
    return {
      act: entry.verdict.act,
      mode: entry.verdict.mode,
      reason: entry.verdict.reason,
      ...(entry.verdict.verdict ? { verdict: entry.verdict.verdict } : {}),
      ...(probability !== undefined ? { probability } : {}),
    };
  },
};
