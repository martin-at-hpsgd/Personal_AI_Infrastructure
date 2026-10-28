/**
 * The sampled evaluator (ISC-147, ISC-148). After a sampled run, one model
 * call scores the run against the definition's criteria file and one line is
 * appended to `evals/<workflow>.jsonl` beside the ledger.
 *
 * The evaluator is read-only by construction: it is a plain model call (no
 * tools, no sandbox, no file handles), it sees only the criteria text and the
 * run's summary, and its output schema carries scores and nothing else, so
 * no reply can carry a patch to a definition, prompt or criteria file. The
 * only write is the append this module makes.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { invariant } from "../../TOOLS/Invariant.ts";
import { readPromptFile } from "./format-rules.ts";
import type { EvaluateConfig } from "./format.ts";
import { NAME_RE } from "./paths.ts";
import { executeModelStep } from "./steps/model.ts";
import type { ModelClient, StepCost } from "./steps/types.ts";

/** Scores only: an overall 0-10 score and one 0-10 score per criterion name. */
export const EVAL_OUTPUT_SCHEMA = {
  type: "object",
  required: ["overall", "scores"],
  additionalProperties: false,
  properties: {
    overall: { type: "number", minimum: 0, maximum: 10 },
    scores: {
      type: "array",
      items: {
        type: "object",
        required: ["criterion", "score"],
        additionalProperties: false,
        properties: { criterion: { type: "string", maxLength: 80 }, score: { type: "number", minimum: 0, maximum: 10 } },
      },
    },
  },
} as const;

export const evalsPath = (ledger: string, workflow: string): string => {
  invariant(NAME_RE.test(workflow), `Not a workflow name: ${workflow}`);
  return join(dirname(ledger), "evals", `${workflow}.jsonl`);
};

export function sampled(rate: number, random: () => number): boolean {
  invariant(rate >= 0 && rate <= 1, "An evaluate sample rate is between 0 and 1");
  return rate > 0 && random() < rate;
}

export interface RunSummary {
  run_id: string;
  workflow: string;
  status: string;
  output?: unknown;
  error?: string;
}

export interface EvalLine {
  ts: string;
  run_id: string;
  workflow: string;
  lane: string;
  overall: number;
  scores: { criterion: string; score: number }[];
  cost: StepCost;
}

export async function evaluateRun(
  config: EvaluateConfig,
  run: RunSummary,
  opts: { home: string; ledger: string; client: ModelClient; now: () => Date },
): Promise<EvalLine> {
  const criteria = readPromptFile(opts.home, config.criteria);
  const prompt = `You are a read-only evaluator. Score this workflow run against the criteria below. Return scores only.\n\n${criteria}`;
  const { value, cost } = await executeModelStep(
    { lane: config.lane, prompt, input: run, output: EVAL_OUTPUT_SCHEMA, stepId: "evaluate", trigger: "evaluate" },
    opts.client,
  );
  const scored = value as { overall: number; scores: { criterion: string; score: number }[] };
  const line: EvalLine = { ts: opts.now().toISOString(), run_id: run.run_id, workflow: run.workflow, lane: config.lane, overall: scored.overall, scores: scored.scores, cost };
  const path = evalsPath(opts.ledger, run.workflow);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`);
  return line;
}
