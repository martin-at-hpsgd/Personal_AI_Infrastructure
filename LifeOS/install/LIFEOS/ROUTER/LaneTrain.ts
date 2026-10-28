#!/usr/bin/env bun
/**
 * Train the learned router (lane-model.json v2) from real prompts.
 *
 *   bun LIFEOS/ROUTER/LaneTrain.ts [--engine <id>] [--write]
 *   bun LIFEOS/ROUTER/LaneTrain.ts --reask [--limit N]
 *
 * Inputs, all private under MEMORY/STATE/router/: `real-prompts.jsonl` (RealPrompts.ts),
 * the three labelers' blind lane+effort labels (`labels4/`, `labels5/`, one file per labeler), and
 * the engine's noul answers per prompt, asked with the previous reply as state. Answers are kept per
 * engine (Assay ISA ISC-64): `answers-<engine>.jsonl` holds every question the live dispatch-advisor asks,
 * collected by `--reask` through Assay judgeMany with the live state builder (FrontDoor.engineState);
 * `--engine jev-1.13.0` reads the first engine's `real-answers.jsonl` (Jev, retired 2026-10-10). The default engine is the live one, and
 * `--write` stamps it into lane-model.json as engine_model, which FrontDoor holds the heads to (ISC-63).
 * Gold is the three-labeler majority; a three-way split is left out of that head. Accuracy is
 * session-grouped 5-fold: no session is ever in both train and test, so a model cannot score by
 * recognizing a conversation. Depth words are applied after the model the way FrontDoor applies
 * them (Opus, or Astra, at xhigh). The synthetic fixtures are regression floors only (LaneEval.ts).
 *
 * Uses Assay's judgment layer (LIFEOS/DOCUMENTATION/Assay/AssaySystem.md).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lifeosPath } from "../TOOLS/Paths";
import { invariant } from "../TOOLS/Invariant";
import { judgeMany, loadRegistry, thresholdRows, type ManyItem } from "../ASSAY/Assay";
import { carriesSecretValue } from "../ASSAY/Registry";
import { QUESTIONS } from "./RouterQuestions";
import { engineState, liveEngineId, safePreviousReply, unwrapPasted } from "./FrontDoor";
import { HEAD_EFFORTS as EFFORTS } from "../../hooks/lib/lane-rules";
import { matchDepthDirective } from "./Depth";
import { LANE_QUESTIONS, LANES, PROMPT_FEATURES, featureVector, softmax, type LaneModel } from "./LaneQuestions";

export const LABELERS = ["opus", "fable", "astra"] as const;
export const LABEL_DIRS = ["labels4", "labels5"] as const;
export const FEATURES: string[] = [...Object.keys(LANE_QUESTIONS), ...PROMPT_FEATURES];
/** The registry caller whose `handoff` threshold row is the lane head's hand-off cut. */
export const HANDOFF_CALLER = "lane-train";
/**
 * The hand-off cut, read per call from the caller registry (assay-callers.json, caller `lane-train`) through loadRegistry and
 * thresholdRows, the way every registered threshold is read. A missing row fails loud: training, cross-validation and the
 * lane-model.json stamp must all use the registered cut, never a guess.
 */
export function handoffThreshold(callersPath?: string): number {
  const cfg = loadRegistry(callersPath).callers[HANDOFF_CALLER];
  invariant(cfg, `${HANDOFF_CALLER} caller missing from the Assay registry (assay-callers.json): it holds the lane hand-off cut`);
  const { handoff } = thresholdRows(cfg);
  invariant(handoff, `${HANDOFF_CALLER}: the registry needs a handoff threshold row`);
  return handoff.value;
}
const OPTIONS = { l2: 0.001, lr: 0.5, epochs: 2500 };

export type Sample = { id: string; session: string; prompt: string; x: number[]; lane: number | null; effort: number | null };

/** Softmax regression by batch gradient descent. Deterministic: zero init, fixed order. */
export function train(X: number[][], y: number[], k: number = LANES.length, opts = OPTIONS): number[][] {
  if (!X.length || X.length !== y.length) throw new Error("training needs matching nonempty X and y");
  const d = X[0].length;
  const W = Array.from({ length: k }, () => new Array<number>(d + 1).fill(0));
  for (let e = 0; e < opts.epochs; e++) {
    const grad = Array.from({ length: k }, () => new Array<number>(d + 1).fill(0));
    for (let i = 0; i < X.length; i++) {
      const x = [1, ...X[i]], p = softmax(W, X[i]);
      for (let c = 0; c < k; c++) { const g = p[c] - (y[i] === c ? 1 : 0); for (let j = 0; j <= d; j++) grad[c][j] += g * x[j]; }
    }
    for (let c = 0; c < k; c++) for (let j = 0; j <= d; j++) W[c][j] -= opts.lr * (grad[c][j] / X.length + (j ? opts.l2 * W[c][j] : 0));
  }
  return W;
}

const readJsonl = (path: string): any[] => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
const router = (...p: string[]) => lifeosPath("MEMORY", "STATE", "router", ...p);

/** The engine whose answers the first heads were fitted on; its answers live in the original files. */
export const ORIGINAL_ENGINE = "jev-1.13.0"; // Jev's stored id, retired 2026-10-10
/** One engine's answers to every live dispatch-advisor question, one row per prompt id. */
export function answersPath(engine: string): string {
  invariant(/^[a-z0-9][a-z0-9.\-]*$/.test(engine), `engine id must be a bare model id, got "${engine}"`);
  return engine === ORIGINAL_ENGINE ? router("real-answers.jsonl") : router(`answers-${engine}.jsonl`);
}
/** The caller the refit asks under: registered, offline, shadow, with a budget sized for a full pass (dispatch-advisor's 500 a day is not). */
export const REASK_CALLER = "thinking-train";

/** The majority value among the labelers, or null on a split. */
export function majority(values: (string | undefined)[]): string | null {
  const c = new Map<string, number>();
  for (const v of values) if (v) c.set(v, (c.get(v) ?? 0) + 1);
  const top = [...c.entries()].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] >= 2 ? top[0] : null;
}

export function inputsPresent(engine: string = liveEngineId()): boolean {
  return [router("real-prompts.jsonl"), answersPath(engine), ...LABEL_DIRS.flatMap(d => LABELERS.map(n => router(d, `${n}.jsonl`)))].every(existsSync);
}

export function loadSamples(engine: string = liveEngineId()): Sample[] {
  const prompts = new Map(readJsonl(router("real-prompts.jsonl")).map(r => [r.id as string, r]));
  const answers = new Map(readJsonl(answersPath(engine)).map(r => [r.id as string, r.answers as Record<string, number>]));
  const labels = LABELERS.map(n => { const m = new Map<string, any>(); for (const d of LABEL_DIRS) for (const r of readJsonl(router(d, `${n}.jsonl`))) m.set(r.id, r); return m; });
  const samples: Sample[] = [];
  for (const id of labels[0].keys()) {
    const r = prompts.get(id), a = answers.get(id);
    if (!r || !a || !labels.every(l => l.has(id))) continue;
    const typed = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, { type: "noul" as const, noul: v }]));
    const x = featureVector(FEATURES, typed, { prompt: r.prompt, hasContext: !!r.context });
    if (!x) continue;
    const lane = majority(labels.map(l => l.get(id).lane)), effort = majority(labels.map(l => l.get(id).effort));
    samples.push({ id, session: r.session, prompt: r.prompt, x, lane: lane ? LANES.indexOf(lane as never) : null, effort: effort ? EFFORTS.indexOf(effort as never) : null });
  }
  return samples.filter(s => (s.lane === null || s.lane >= 0) && (s.effort === null || s.effort >= 0));
}

/** The pick FrontDoor would make: the hand-off gate, then depth words (Opus or Astra, at xhigh). */
export function decide(pl: number[], pe: number[], prompt: string, threshold = handoffThreshold()): { lane: string; effort: string } {
  let top = 0;
  if (1 - pl[0] >= threshold) for (let i = 1; i < pl.length; i++) if (top === 0 || pl[i] > pl[top]) top = i;
  let lane: string = LANES[top], effort: string = EFFORTS[pe.indexOf(Math.max(...pe))];
  if (matchDepthDirective(prompt)) { lane = lane === "astra" ? "astra" : "opus"; effort = "xhigh"; }
  return { lane, effort };
}

const fold = (session: string): number => { let h = 0; for (const ch of session) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 5; };

export type Scores = LaneModel["cv"] & { baseline_lane: number; n_lane: number; n_effort: number; handed_off: number };
export function crossValidate(samples: Sample[], threshold = handoffThreshold()): Scores {
  let lh = 0, ln = 0, sh = 0, hx = 0, hxN = 0, eh = 0, en = 0, base = 0, handed = 0;
  for (let k = 0; k < 5; k++) {
    const tr = samples.filter(s => fold(s.session) !== k), te = samples.filter(s => fold(s.session) === k);
    const tl = tr.filter(s => s.lane !== null), tE = tr.filter(s => s.effort !== null);
    const WL = train(tl.map(s => s.x), tl.map(s => s.lane!), LANES.length), WE = train(tE.map(s => s.x), tE.map(s => s.effort!), EFFORTS.length);
    for (const s of te) {
      const d = decide(softmax(WL, s.x), softmax(WE, s.x), s.prompt, threshold);
      if (s.lane !== null) {
        const gold = LANES[s.lane]; ln++;
        if (d.lane === gold) lh++;
        if ((d.lane === "inline") === (gold === "inline")) sh++;
        if (d.lane !== "inline") handed++;
        if (gold === "inline") base++; else { hxN++; if (d.lane === gold) hx++; }
      }
      if (s.effort !== null) { en++; if (d.effort === EFFORTS[s.effort]) eh++; }
    }
  }
  return { lane: lh / ln, stay_handoff: sh / ln, handoff_model: hx / hxN, effort: eh / en, baseline_lane: base / ln, n_lane: ln, n_effort: en, handed_off: handed };
}


type Labelled = { id: string; session: string; prompt: string; context?: string };
/** Every prompt either trainer has labels for: the lane labels and the thinking labels, from the random and enrich sets. */
export function labelledPrompts(): Labelled[] {
  const ids = new Set<string>();
  for (const d of LABEL_DIRS) for (const n of LABELERS) if (existsSync(router(d, `${n}.jsonl`))) for (const r of readJsonl(router(d, `${n}.jsonl`))) ids.add(r.id);
  for (const n of ["opus", "fable", "openai"]) { const p = router("thinking-labels", `${n}.jsonl`); if (existsSync(p)) for (const r of readJsonl(p)) ids.add(r.id); }
  const out: Labelled[] = [];
  for (const f of ["real-prompts.jsonl", "enrich-prompts.jsonl"]) if (existsSync(router(f))) for (const r of readJsonl(router(f))) if (ids.has(r.id)) { out.push(r); ids.delete(r.id); }
  return out;
}

/**
 * The state the live router would send for a labelled prompt (FrontDoor.engineState): the same redaction, whitespace fold
 * and head-and-tail cut, and the previous reply through the same safety pass. RealPrompts marks a cut context with a
 * leading "… "; the live reply tail carries no such mark, so it is dropped.
 */
export function reaskState(r: Labelled): { previous_reply?: string; prompt: string } {
  return engineState(unwrapPasted(r.prompt), safePreviousReply(typeof r.context === "string" ? r.context.replace(/^… /, "") : undefined));
}

/** One answers row, checked before it is written: the live question set, every answer a probability, the engine named. */
export function answersRow(id: string, model: string, answers: Record<string, number>, ids: readonly string[] = Object.keys(QUESTIONS)): string {
  invariant(id.length > 0 && id.length <= 64, "answers row needs a bounded prompt id");
  invariant(/^[a-z0-9][a-z0-9.\-]*$/.test(model), `answers row engine must be a bare model id, got "${model}"`);
  invariant(ids.every(q => typeof answers[q] === "number" && Number.isFinite(answers[q]) && answers[q] >= 0 && answers[q] <= 1), `answers row ${id} must carry every question as a probability`);
  return JSON.stringify({ id, model, answers }) + "\n";
}

/**
 * Re-ask every labelled prompt on the live engine with the live dispatch-advisor question set, through Assay judgeMany,
 * appending to answers-<engine>.jsonl in chunks. Resumable: ids already answered are skipped. A state still carrying a
 * secret shape after redaction is never sent (the engine refuses it anyway).
 */
export async function reask(opts: { limit?: number; chunk?: number; concurrency?: number } = {}): Promise<{ asked: number; ok: number; failed: number; skipped: number; total: number }> {
  const engine = liveEngineId(), path = answersPath(engine);
  const done = new Set(existsSync(path) ? readJsonl(path).map(r => r.id as string) : []);
  const all = labelledPrompts();
  let skipped = 0;
  const todo = all.filter(r => !done.has(r.id)).flatMap(r => { const state = reaskState(r); if (carriesSecretValue(JSON.stringify(state))) { skipped++; return []; } return [{ key: r.id, state }]; }).slice(0, opts.limit ?? Infinity);
  const ids = Object.keys(QUESTIONS), chunk = opts.chunk ?? 200;
  let ok = 0, failed = 0;
  for (let i = 0; i < todo.length; i += chunk) {
    const items: ManyItem[] = todo.slice(i, i + chunk);
    const results = await judgeMany(items, QUESTIONS, { caller: REASK_CALLER, session: `router-refit-${engine}`, timeoutMs: 15_000, concurrency: opts.concurrency ?? 16, retries: 2 });
    let rows = "";
    for (const r of results) {
      if (!r.result) { failed++; console.error(`${r.key}: ${String(r.error).slice(0, 120)}`); continue; }
      const model = (Object.values(r.result)[0]?.model ?? "").split("/").pop() ?? "";
      if (model !== engine) { failed++; console.error(`${r.key}: answered by ${model}, not ${engine}`); continue; }
      const answers: Record<string, number> = {};
      for (const q of ids) { const a = r.result[q]?.answer; if (a?.type === "noul") answers[q] = a.noul; }
      rows += answersRow(r.key, model, answers, ids); ok++;
    }
    if (rows) appendFileSync(path, rows);
    console.log(`reask ${engine}: ${Math.min(i + chunk, todo.length)}/${todo.length} (ok ${ok}, failed ${failed})`);
  }
  return { asked: todo.length, ok, failed, skipped, total: done.size + ok };
}

const flag = (args: string[], name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--reask")) {
    const limit = flag(args, "--limit");
    console.log(JSON.stringify(await reask({ limit: limit ? Number(limit) : undefined })));
    process.exit(0);
  }
  const engine = flag(args, "--engine") ?? liveEngineId();
  if (args.some((a, i) => a !== "--write" && a !== "--engine" && args[i - 1] !== "--engine")) throw new Error("usage: bun LIFEOS/ROUTER/LaneTrain.ts [--engine <id>] [--write] | --reask [--limit N]");
  if (!inputsPresent(engine)) throw new Error(`missing private router inputs under MEMORY/STATE/router (real-prompts, ${answersPath(engine).split("/").pop()}, labels4, labels5); run --reask first`);
  const samples = loadSamples(engine), cv = crossValidate(samples);
  console.log(`engine: ${engine}`);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(`samples: ${samples.length} (lane gold ${cv.n_lane}, effort gold ${cv.n_effort}); features: ${FEATURES.length}`);
  console.log(`session 5-fold lane accuracy: ${cv.lane.toFixed(4)} (${pct(cv.lane)}); always-inline baseline ${pct(cv.baseline_lane)}`);
  console.log(`stay/hand-off: ${pct(cv.stay_handoff)}; right model on gold hand-offs: ${pct(cv.handoff_model)}; effort: ${pct(cv.effort)}; handed off ${cv.handed_off}`);
  if (args.includes("--write")) {
    const tl = samples.filter(s => s.lane !== null), tE = samples.filter(s => s.effort !== null);
    invariant(engine === liveEngineId(), `lane-model.json is written only from the live engine's answers (${liveEngineId()}), not ${engine}`);
    const model: LaneModel & { engine_model: string } = {
      version: 2, trained: new Date().toISOString(), engine_model: engine, features: FEATURES,
      lane: { classes: [...LANES], weights: train(tl.map(s => s.x), tl.map(s => s.lane!), LANES.length) },
      effort: { classes: [...EFFORTS], weights: train(tE.map(s => s.x), tE.map(s => s.effort!), EFFORTS.length) },
      handoff_threshold: handoffThreshold(), l2: OPTIONS.l2, epochs: OPTIONS.epochs, samples: samples.length,
      cv: { lane: cv.lane, stay_handoff: cv.stay_handoff, handoff_model: cv.handoff_model, effort: cv.effort },
    };
    writeFileSync(join(import.meta.dir, "lane-model.json"), JSON.stringify(model, null, 2) + "\n");
    console.log("wrote LIFEOS/ROUTER/lane-model.json");
  }
}
