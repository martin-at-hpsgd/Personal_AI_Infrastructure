/**
 * Part of the Glance system. Chain shapes compose the low API lane's prose work with
 * judgment-layer answers; see LIFEOS/DOCUMENTATION/Assay/AssaySystem.md.
 *
 * Glance caller: callers pass their registered caller name to every shape.
 */
import { decide, judge, judgeMany, type AskOptions } from "./Assay";
import { inference } from "../TOOLS/Inference";
import type { Answer, Questions } from "./Engine";

type ChainOptions = AskOptions;
export type Ranked<T> = { item: T; relevance: number | null; answer: Answer | null; error: string | null };
export type Filtered<T> = { items: T[]; wouldDrop: T[]; errors: Array<{ item: T; error: string }> };

function value(answer: Answer): number | null {
  if (answer.type === "noul") return answer.noul;
  if (answer.type === "choice") return answer.probabilities?.[answer.choice] ?? answer.confidence ?? null;
  return answer.confidence ?? null;
}

function questionMap(questionId: string, question: string): Questions {
  return { [questionId]: { type: "noul", instructions: question } };
}

/** Ranking is non-actionable: all candidates remain, ordered by engine probability. */
export async function rank<T>(items: T[], questionId: string, question: string, opts: ChainOptions): Promise<Ranked<T>[]> {
  const results = await judgeMany(items.map((item, i) => ({ key: String(i), state: item as object })), questionMap(questionId, question), opts);
  return results.map((result, index) => {
    const judged = result.result?.[questionId];
    return { item: items[index]!, relevance: judged ? value(judged.answer) : null, answer: judged?.answer ?? null, error: result.error };
  }).sort((a, b) => a.error ? (b.error ? 0 : 1) : b.error ? -1 : (b.relevance ?? -Infinity) - (a.relevance ?? -Infinity));
}

/**
 * Keep-direction gate over already-ranked rows: an item is kept when its answer clears the
 * registry threshold with a positive verdict (decide().act && verdict === "yes"). Only an enforce caller drops anything; a shadow or
 * unregistered caller keeps every row and reports in wouldDrop the rows enforce would drop.
 * Errored rows are always kept (fail open) and listed in errors.
 */
export function keepWhere<T>(ranked: Ranked<T>[], questionId: string, opts: Pick<ChainOptions, "caller" | "callersPath">): Filtered<T> {
  const items: T[] = [], wouldDrop: T[] = [], errors: Array<{ item: T; error: string }> = [];
  for (const row of ranked) {
    if (row.error || !row.answer) { items.push(row.item); if (row.error) errors.push({ item: row.item, error: row.error }); continue; }
    const verdict = decide(opts.caller, questionId, row.answer, opts.callersPath);
    if (verdict.mode === "enforce") { if (verdict.act && verdict.verdict !== "no") items.push(row.item); else wouldDrop.push(row.item); continue; }
    items.push(row.item);
    // Shadow: record what enforce would drop. A question with no registry row records nothing.
    // The pre-S1b bar is relevance >= cut, read as decide().yes (null relevance or an unscorable answer counts as below).
    if (verdict.effectiveMode !== "unregistered" && verdict.yes !== true) wouldDrop.push(row.item);
  }
  return { items, wouldDrop, errors };
}

/** rank() then keepWhere(): one judgment-layer question per item, kept when it clears the registry threshold. */
export async function filter<T>(items: T[], questionId: string, question: string, opts: ChainOptions): Promise<Filtered<T>> {
  return keepWhere(await rank(items, questionId, question, opts), questionId, opts);
}

export async function generateThenRank(args: { prompt: string; n: number; questionId: string; question: string; caller: string; generate?: (prompt: string, n: number) => Promise<string[]> }, opts: Omit<ChainOptions, "caller"> = {}): Promise<Ranked<string>[]> {
  const generate = args.generate ?? (async (prompt, n) => {
    const result = await inference({ vendor: "openai", level: "low", expectJson: true, systemPrompt: "Return only a JSON array of candidate strings.", userPrompt: `${prompt}\nGenerate exactly ${n} candidates.`, allowVendorFallback: false });
    if (!result.success || !Array.isArray(result.parsed) || result.parsed.length !== n || !result.parsed.every((x) => typeof x === "string")) throw new Error(result.error ?? "the low API lane did not return the requested JSON string array");
    return result.parsed as string[];
  });
  const candidates = await generate(args.prompt, args.n);
  return rank(candidates, args.questionId, args.question, { ...opts, caller: args.caller });
}

export async function judgeThenEscalate<T>(state: object, questions: Questions, primaryQuestionId: string, opts: ChainOptions & { escalate: () => Promise<T> }): Promise<{ path: "judged"; judgment: Awaited<ReturnType<typeof judge>> } | { path: "escalated"; result: T; judgment: Awaited<ReturnType<typeof judge>> }> {
  const judgment = await judge(state, questions, opts);
  if (judgment[primaryQuestionId]?.verdict.act && judgment[primaryQuestionId].verdict.verdict !== "no") return { path: "judged", judgment };
  return { path: "escalated", result: await opts.escalate(), judgment };
}
