#!/usr/bin/env bun
/**
 * Triage4.ts — Errata v4 detection and diagnosis over every typed exchange (ISC-42, 49, 50).
 *
 * Glance caller named errata-triage (shadow). See LIFEOS/DOCUMENTATION/Assay/AssaySystem.md,
 * section The caller contract. Fail-open: a disabled engine, a missing key or a spent budget turns
 * into error rows that the next run retries; nothing else in Errata depends on this file.
 *
 *   bun LIFEOS/ERRATA/Triage4.ts detect   [--limit N] [--chunk N] [--dry-run]
 *   bun LIFEOS/ERRATA/Triage4.ts diagnose [--limit N] [--chunk N] [--dry-run]
 *   bun LIFEOS/ERRATA/Triage4.ts report                 (with the M7b sections from Act.ts appended)
 *   bun LIFEOS/ERRATA/Triage4.ts rules|cover|cluster|recommend|act   (M7b, handed to Act.ts)
 *
 * Two stages. `detect` asks the detect and blame nouls of every exchange that lacks an answer to
 * any of them, as judgeMany pools of `--chunk` items (default 1000, appended after each pool so a
 * killed run keeps its progress). `diagnose` asks the mode and cost nouls only of exchanges called
 * failures, together with the kept discriminators (Questions.ts KEPT_DISCRIMINATORS). Answers are
 * stored raw (probabilities) and keyed by the asked question id; rows merge per exchange, so when a slot switches to a reworded variant (Questions.ts KEPT_VARIANTS) the next
 * run asks only that question. Composition happens at read time with the registry's current cuts,
 * so recalibrating never needs a re-ask. When LIFEOS/ERRATA/triage-model.json is present and valid
 * the learned combiner (Combiner.ts) makes the failure call and names the primary class through
 * the model file's class source (since 2026-09-27 the composer settled by a discriminator
 * tournament); otherwise the composer does. When the model file also carries an active class tier
 * (ClassTier.ts, ISC-53), `diagnose` first asks the model the class of every exchange the head
 * flags and, with the second look on (ISC-56), of every exchange it passes; the model's class
 * then names each failure's primary class and its second look can flag a failure the head missed.
 * With no tier answer (not asked yet, or the call failed) the glance tier's class and the head's call stand.
 *
 * This is a read-only sidecar over Errata. It reads exchanges.jsonl and the ledger and writes only
 * labels.jsonl, classtier.jsonl (through ClassTier.ts) and report-*.md under LIFEOS/USER/ERRATA/v4/. It never opens an errata-*.jsonl or
 * audit/labels-v3.jsonl for writing (ISC-49). Ids and session ids are local join keys and never
 * leave in a state (ISC-50).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { judgeMany, loadCallers, thresholdRows, type CallerConfig, type ManyResult } from "../ASSAY/Assay";
import { redactForEngine, type Questions } from "../ASSAY/Engine";
import { invariant, InvariantViolation } from "../TOOLS/Invariant";
import { ErrataStore } from "./Store";
import { captureIndex, captureMatch, loadExchanges, v4Dir, type Exchange } from "./Exchanges";
import { ASKED_STAGE1, ASKED_STAGE2, KNOWN_IDS, composeDetect, composeDiagnosis, cutsFrom, prob, stageOf, toSlots, type Cuts, type Diagnosis } from "./Questions";
import { contextOf, diagnoseWithModel, failureDiagnosisWithModel, loadTriageModel, predictDetect, type TriageModel } from "./Combiner";
import { activeTier, answerFor, applyClassTier, classify, loadTier, secondLookFlags, tierPath, usageBetween, type ClassifyOptions, type ClassifyResult, type ClassTierConfig, type TierAnswer, type TierCache } from "./ClassTier";
import { openAiModelForLevel } from "../TOOLS/Inference";

export const CALLER = "errata-triage";
export const STATE_MAX = 3000;
const CALL_TIMEOUT_MS = 15_000;
const DEFAULT_CHUNK = 1000;

export type Stage = "detect" | "diagnose";
export type LabelRow = { id: string; stage: Stage; ts: string; answers?: Record<string, number>; model?: string; error?: string };

export const labelsPath = (dir = v4Dir()): string => join(dir, "labels.jsonl");

// ── State (ISC-50) ──────────────────────────────────────────────────────────

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ERRATUM_ID_RE = /\bERR-\d{8}-\d{6}-[0-9a-z]{4}\b/g;
const EXCHANGE_ID_RE = /\bX-[0-9a-f]{16}\b/g;
const HOME_RE = /\/(?:Users|home)\/[^/\s"'`]+/g;

/** Secrets, emails and phones out (redactForEngine), then ids, session ids and home paths. Pure. */
export function scrub(text: string, session = ""): string {
  let s = redactForEngine(text, Number.MAX_SAFE_INTEGER);
  const home = homedir();
  if (home.length > 1) s = s.split(home).join("~");
  s = s.replace(HOME_RE, "~");
  if (session) s = s.split(session).join("[id]");
  return s.replace(UUID_RE, "[id]").replace(ERRATUM_ID_RE, "[id]").replace(EXCHANGE_ID_RE, "[id]");
}

const head = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)} …` : s);
const tail = (s: string, n: number): string => (s.length > n ? `… ${s.slice(-n)}` : s);

/** The labeler-visible fields of one exchange, scrubbed; the same evidence Glance sees. Pure. */
export function exchangeView(ex: Exchange): { user_message: string; assistant_previous_reply_end: string; user_previous_request: string; assistant_recent_tool_calls: string } {
  return {
    user_previous_request: scrub(ex.prior_ask, ex.session) || "(none: first message of the session)",
    assistant_previous_reply_end: scrub(ex.reply_tail, ex.session) || "(none)",
    assistant_recent_tool_calls: scrub(ex.tools.map((t) => `${t.name}: ${t.summary}`).join(" · "), ex.session) || "(none)",
    user_message: scrub(ex.prompt, ex.session),
  };
}

/** JSON state for the engine, at most STATE_MAX chars: the reply end, the prior ask, the tools and then the message shrink in that order. Pure. */
export function buildExchangeState(ex: Exchange): string {
  const v = exchangeView(ex);
  const lim = { reply: 800, prior: 300, tools: 400, message: 1400 };
  for (let round = 0; round < 40; round++) {
    const out = JSON.stringify({
      user_previous_request: head(v.user_previous_request, lim.prior),
      assistant_recent_tool_calls: head(v.assistant_recent_tool_calls, lim.tools),
      assistant_previous_reply_end: tail(v.assistant_previous_reply_end, lim.reply),
      user_message: head(v.user_message, lim.message),
    });
    if (out.length <= STATE_MAX) return out;
    if (lim.reply > 100) lim.reply = Math.floor(lim.reply / 2);
    else if (lim.prior > 60) lim.prior = Math.floor(lim.prior / 2);
    else if (lim.tools > 60) lim.tools = Math.floor(lim.tools / 2);
    else lim.message = Math.floor(lim.message * 0.8);
  }
  // Escape-heavy text can still overflow: fall back to the message alone.
  return JSON.stringify({ user_message: head(v.user_message, 500) }).slice(0, STATE_MAX);
}

// ── Labels ──────────────────────────────────────────────────────────────────

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((l) => {
    if (!l.trim()) return [];
    try { return [JSON.parse(l) as T]; } catch { return []; }
  });
}

export function validLabelRow(r: unknown, stage?: Stage): r is LabelRow {
  if (!r || typeof r !== "object") return false;
  const x = r as LabelRow;
  if (!/^X-[0-9a-f]{16}$/.test(x.id) || (x.stage !== "detect" && x.stage !== "diagnose") || (stage && x.stage !== stage) || typeof x.ts !== "string") return false;
  if (typeof x.error === "string") return x.error.length > 0 && x.answers === undefined;
  if (!x.answers || typeof x.answers !== "object") return false;
  const keys = Object.keys(x.answers);
  // Any known question of the row's stage (a labeled slot, a variant of one, or a stage-2 discriminator), each a valid probability.
  const inStage = (id: string): boolean => KNOWN_IDS.includes(id) && stageOf(id) === (x.stage === "detect" ? 1 : 2);
  return keys.length > 0 && keys.every((id) => inStage(id) && prob(x.answers![id]) !== null);
}

/** Every answer per stage, merged across rows in file order (a later row adds or replaces questions), keyed by exchange id. */
export function loadAnswers(dir = v4Dir()): { detect: Map<string, Record<string, number>>; diagnose: Map<string, Record<string, number>>; errors: Map<string, string> } {
  const detect = new Map<string, Record<string, number>>();
  const diagnose = new Map<string, Record<string, number>>();
  const errors = new Map<string, string>();
  for (const r of readJsonl<LabelRow>(labelsPath(dir))) {
    if (!validLabelRow(r)) continue;
    const key = `${r.stage}:${r.id}`;
    if (r.answers) { const m = r.stage === "detect" ? detect : diagnose; m.set(r.id, { ...(m.get(r.id) ?? {}), ...r.answers }); errors.delete(key); }
    else if (!(r.stage === "detect" ? detect : diagnose).has(r.id)) errors.set(key, r.error!);
  }
  return { detect, diagnose, errors };
}

export function callerCuts(cfg: CallerConfig | undefined = loadCallers()[CALLER]): Cuts {
  invariant(cfg, `${CALLER} caller missing from the Glance registry`);
  invariant(cfg.mode === "shadow", `${CALLER} must stay shadow until ISC-44 holds`);
  const cuts = cutsFrom(thresholdRows(cfg));
  invariant(cuts, `${CALLER}: a bank question has no registered threshold`);
  return cuts;
}

/** Turn one pool result into a label row: every requested noul present and in range, or an error. Pure. */
export function toLabelRow(id: string, stage: Stage, r: ManyResult | undefined, questions: Questions, now = new Date().toISOString()): LabelRow {
  if (!r || r.error !== null || !r.result) return { id, stage, ts: now, error: r?.error || "missing Glance result" };
  const answers: Record<string, number> = {};
  let model: string | undefined;
  for (const q of Object.keys(questions)) {
    const a = r.result[q]?.answer;
    const p = prob(a);
    if (p === null) return { id, stage, ts: now, error: `invalid or missing answer for ${q}` };
    answers[q] = p;
    model ??= r.result[q]?.model;
  }
  return { id, stage, ts: now, answers, ...(model ? { model } : {}) };
}

export type RunOptions = { dir?: string; limit?: number; chunk?: number; dryRun?: boolean; judge?: typeof judgeMany; cuts?: Cuts; log?: (s: string) => void; model?: TriageModel | null; newFirst?: boolean; infer?: ClassifyOptions["infer"]; maxCalls?: number };

/** The asked questions of `bank` this exchange has no answer for yet. Pure. */
export function missingQuestions(bank: Questions, have: Record<string, number> | undefined): Questions {
  return Object.fromEntries(Object.entries(bank).filter(([id]) => have?.[id] === undefined));
}

// ── Class tier (ISC-53, ISC-56) ─────────────────────────────────────────────

/** The model class tier's answer for an exchange, or null when it has none for the exchange's current state. */
export type TierLookup = (e: Exchange) => TierAnswer | null;

const tierMemo = new Map<string, { sig: string; cache: TierCache }>();
/** A lookup over the cached answers of the model file's tier (ClassTier.ts), reloaded when the cache file changes. */
export function tierLookup(config: ClassTierConfig, dir = v4Dir()): TierLookup {
  const path = tierPath(dir);
  const sig = existsSync(path) ? `${statSync(path).mtimeMs}:${statSync(path).size}` : "none";
  const key = `${dir}|${config.level}|${config.prompt}`;
  let memo = tierMemo.get(key);
  if (!memo || memo.sig !== sig) { memo = { sig, cache: loadTier(config.level, { dir, prompt: config.prompt }) }; tierMemo.set(key, memo); }
  const cache = memo.cache;
  return (e) => (cache.answers.has(e.id) ? answerFor(cache, e.id, buildExchangeState(e)) : null);
}

/** The lookup over `dir`'s cached tier answers when the model file's tier is active, else undefined. */
export function dirLookup(model: TriageModel | null, dir: string): TierLookup | undefined {
  const config = activeTier(model?.class_tier);
  return config ? tierLookup(config, dir) : undefined;
}

/** The tier lookup to use for this model: the given one, else the cached answers when the model file's tier is active, else none. */
function lookupFor(model: TriageModel | null, tier: TierLookup | undefined): { config: ClassTierConfig | null; tier: TierLookup } {
  const config = activeTier(model?.class_tier);
  return { config, tier: tier ?? (config ? tierLookup(config) : () => null) };
}

/**
 * Is this exchange a failure? The combiner's detect head when a model is given, else the composer
 * over registry cuts; null when an answer it needs is missing. When the model file's class tier is
 * active with its second look, an exchange the head passes is a failure if the tier named a failure
 * class; with no tier answer yet (not asked, or it errored) the head's call stands.
 */
export function isFailure(e: Exchange, detectAnswers: Record<string, number>, cuts: Cuts, model: TriageModel | null, tier?: TierLookup): boolean | null {
  if (!model) return composeDetect(toSlots(detectAnswers), toSlots(cuts))?.is_failure ?? null;
  const head = predictDetect(model, detectAnswers, contextOf(e))?.is_failure ?? null;
  if (head !== false) return head;
  const t = lookupFor(model, tier);
  return t.config?.second_look ? secondLookFlags(t.config, t.tier(e)) : false;
}

/**
 * The full diagnosis, by the combiner when a model is given, else the composer. A failure's primary
 * class comes from the model class tier when the model file's tier is active and has answered this
 * exchange, else from the glance tier (the model file's class source), which stays the fallback.
 */
export function diagnosisOf(e: Exchange, answers: Record<string, number>, cuts: Cuts, model: TriageModel | null, tier?: TierLookup): Diagnosis | null {
  if (!model) return composeDiagnosis(toSlots(answers), toSlots(cuts));
  const t = lookupFor(model, tier);
  const answer = t.config ? t.tier(e) : null;
  let dx = diagnoseWithModel(model, answers, contextOf(e), cuts);
  if (dx && !dx.is_failure && t.config?.second_look && secondLookFlags(t.config, answer)) dx = failureDiagnosisWithModel(model, answers, contextOf(e), cuts);
  return dx && t.config ? applyClassTier(dx, answer) : dx;
}
/** What the class-tier pass did: the classify counts (latency as p50 ms, dollars at the flex rate when measured), or why it did not run. */
export type TierStageResult = (Omit<ClassifyResult, "latencies"> & { p50_ms: number | null; usd_flex?: number }) | { skipped: string } | { error: string };
export type RunResult = { stage: Stage; candidates: number; written: number; errors: number; example?: string; tier?: TierStageResult };

/**
 * The class-tier pass (ISC-53, ISC-56): ask the model class tier of every exchange the detect head
 * flags (for its class) and, with the second look on, of every exchange the head passes (for the
 * second look), when it has no answer for the exchange's current state. Runs only when the model
 * file carries an active tier. Bounded by `limit` (exchanges) and `maxCalls` (model calls);
 * a model or network failure comes back as `error`, never thrown; an invariant violation is thrown.
 */
export async function tierStage(opts: RunOptions = {}): Promise<TierStageResult> {
  const dir = opts.dir ?? v4Dir();
  const model = opts.model === undefined ? loadTriageModel() : opts.model;
  const config = activeTier(model?.class_tier);
  if (!model || !config) return { skipped: model?.class_tier ? "the class-tier prompt changed since the tier was chosen; the glance tier names the class until ClassTier.ts eval --write reruns" : "no class tier in the model file" };
  try {
    const { detect } = loadAnswers(dir);
    const cache = loadTier(config.level, { dir, prompt: config.prompt });
    const wanted = (e: Exchange): boolean => {
      const a = detect.get(e.id);
      const head = a ? predictDetect(model, a, contextOf(e))?.is_failure : undefined;
      return head === true || (head === false && config.second_look);
    };
    let items = loadExchanges(dir).filter(wanted).map((e) => ({ id: e.id, state: buildExchangeState(e) })).filter((i) => !answerFor(cache, i.id, i.state));
    // Never-asked exchanges before retries of errored ones, so a daily limit never starves new rows.
    if (opts.newFirst) items = [...items.filter((i) => !cache.errors.has(i.id)), ...items.filter((i) => cache.errors.has(i.id))];
    if (opts.limit !== undefined) items = items.slice(0, opts.limit);
    const since = new Date().toISOString();
    const r = await classify(items, { level: config.level, dir, batch: config.batch, serviceTier: "flex", maxCalls: opts.maxCalls, dryRun: opts.dryRun, infer: opts.infer, log: opts.log });
    const { latencies, ...rest } = r;
    const sorted = [...latencies].sort((a, b) => a - b);
    const measured = !opts.infer && !opts.dryRun && !r.refused && r.calls > 0;
    return { ...rest, p50_ms: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null, ...(measured ? { usd_flex: Number(usageBetween(openAiModelForLevel(config.level), since, new Date(Date.now() + 1000).toISOString()).usdFlex.toFixed(4)) } : {}) };
  } catch (e) {
    if (e instanceof InvariantViolation) throw e;
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** The one-time corpus pass: the class tier over every stored exchange it applies to, refused above `maxCalls` calls (default 3000). */
export function classifyCorpus(opts: RunOptions = {}): Promise<TierStageResult> {
  return tierStage({ ...opts, newFirst: true });
}

async function runStage(stage: Stage, opts: RunOptions): Promise<RunResult> {
  const dir = opts.dir ?? v4Dir();
  const log = opts.log ?? ((s: string) => process.stderr.write(`${s}\n`));
  // The class tier runs first, so the second look's failures reach stage 2 in the same pass.
  const tier = stage === "diagnose" ? await tierStage(opts) : undefined;
  const exchanges = loadExchanges(dir);
  const { detect, diagnose } = loadAnswers(dir);
  const bank = stage === "detect" ? ASKED_STAGE1 : ASKED_STAGE2;
  const lacks = (e: Exchange): boolean => Object.keys(missingQuestions(bank, (stage === "detect" ? detect : diagnose).get(e.id))).length > 0;
  let candidates: Exchange[];
  if (stage === "detect") candidates = exchanges.filter(lacks);
  else {
    const cuts = opts.cuts ?? callerCuts();
    const model = opts.model === undefined ? loadTriageModel() : opts.model;
    const tier = dirLookup(model, dir);
    candidates = exchanges.filter((e) => {
      const a = detect.get(e.id);
      return a && lacks(e) && isFailure(e, a, cuts, model, tier) === true;
    });
  }
  // Exchanges with no answer at all for this stage go first, so a daily limit never starves new rows behind a re-ask.
  if (opts.newFirst) { const stored0 = stage === "detect" ? detect : diagnose; candidates = [...candidates.filter((e) => !stored0.has(e.id)), ...candidates.filter((e) => stored0.has(e.id))]; }
  if (opts.limit !== undefined) candidates = candidates.slice(0, opts.limit);
  const example = candidates[0] ? buildExchangeState(candidates[0]) : undefined;
  const withTier = tier ? { tier } : {};
  if (opts.dryRun) return { stage, candidates: candidates.length, written: 0, errors: 0, example, ...withTier };
  if (!candidates.length) return { stage, candidates: 0, written: 0, errors: 0, ...withTier };
  if (!opts.cuts) callerCuts(); // the registry row must exist and be valid before the first call
  const stored = stage === "detect" ? detect : diagnose;
  const chunk = opts.chunk ?? DEFAULT_CHUNK;
  invariant(Number.isInteger(chunk) && chunk > 0, "chunk must be a positive integer");
  mkdirSync(dir, { recursive: true });
  let written = 0, errors = 0;
  const t0 = performance.now();
  for (let start = 0; start < candidates.length; start += chunk) {
    const slice = candidates.slice(start, start + chunk);
    // Keys are the exchange ids: local join keys that become the ledger's `turn`, never part of the state.
    // Each item asks only the questions its exchange still lacks; new exchanges ask the whole stage.
    const items = slice.map((e) => ({ key: e.id, state: buildExchangeState(e), questions: missingQuestions(bank, stored.get(e.id)) }));
    // One pool per chunk. Bounded by construction: ceil(n / 32) waves × 2 attempts × the per-call timeout.
    const results = await (opts.judge ?? judgeMany)(items, bank, { caller: CALLER, timeoutMs: CALL_TIMEOUT_MS });
    const byKey = new Map(results.map((r) => [r.key, r]));
    const rows = slice.map((e, i) => toLabelRow(e.id, stage, byKey.get(e.id), items[i]!.questions));
    for (const row of rows) invariant(validLabelRow(row, stage), `invalid ${stage} label row for ${row.id}`);
    appendFileSync(labelsPath(dir), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    written += rows.length;
    errors += rows.filter((r) => r.error).length;
    log(`${stage}: ${start + slice.length}/${candidates.length} (${errors} errors, ${Math.round((performance.now() - t0) / 1000)} s)`);
  }
  return { stage, candidates: candidates.length, written, errors, example, ...withTier };
}

export const detect = (opts: RunOptions = {}): Promise<RunResult> => runStage("detect", opts);
export const diagnose = (opts: RunOptions = {}): Promise<RunResult> => runStage("diagnose", opts);

// ── Report ──────────────────────────────────────────────────────────────────

export type Split = {
  exchanges: number;
  detected: number;
  detect_errors: number;
  failures: number;
  diagnosed: number;
  diagnose_pending: number;
  /** Failures the existing ledger already holds (hook, mine or backfill caught them). */
  reported_failures: number;
  /** Failures nobody captured: the gap v4 exists to close. */
  unreported_failures: number;
  /** Ledger captures v4 does not call failures (regex or hook fired on a non-failure, or v4 missed). */
  captured_non_failures: number;
  classes: Record<string, number>;
  unreported_classes: Record<string, number>;
  severity: Record<string, number>;
  weak: number;
  /** Diagnosed failures whose primary class the model class tier named (the rest fell back to the glance tier). */
  class_by_tier: number;
  /** Failures the detect head passed and the tier's second look flagged. */
  second_look: number;
};

/** Pure: the reported-vs-unreported split over composed answers. `captured` is recomputed through `isCaptured`. */
export function reportSplit(
  exchanges: Exchange[],
  answers: { detect: Map<string, Record<string, number>>; diagnose: Map<string, Record<string, number>>; errors: Map<string, string> },
  cuts: Cuts,
  isCaptured: (e: Exchange) => boolean = (e) => e.captured,
  model: TriageModel | null = null,
  tier?: TierLookup,
): Split & { diagnoses: Map<string, Diagnosis> } {
  const s: Split = { exchanges: exchanges.length, detected: 0, detect_errors: 0, failures: 0, diagnosed: 0, diagnose_pending: 0, reported_failures: 0, unreported_failures: 0, captured_non_failures: 0, classes: {}, unreported_classes: {}, severity: {}, weak: 0, class_by_tier: 0, second_look: 0 };
  const t = lookupFor(model, tier);
  const diagnoses = new Map<string, Diagnosis>();
  for (const e of exchanges) {
    const a = answers.detect.get(e.id);
    if (!a) { if (answers.errors.has(`detect:${e.id}`)) s.detect_errors++; continue; }
    const failed = isFailure(e, a, cuts, model, t.tier);
    if (failed === null) continue;
    s.detected++;
    const captured = isCaptured(e);
    if (!failed) { if (captured) s.captured_non_failures++; continue; }
    s.failures++;
    if (captured) s.reported_failures++; else s.unreported_failures++;
    if (model && t.config && predictDetect(model, a, contextOf(e))?.is_failure === false) s.second_look++;
    const b = answers.diagnose.get(e.id);
    const dx = b ? diagnosisOf(e, { ...a, ...b }, cuts, model, t.tier) : null;
    if (!dx) { s.diagnose_pending++; continue; }
    s.diagnosed++;
    diagnoses.set(e.id, dx);
    s.classes[dx.primary] = (s.classes[dx.primary] ?? 0) + 1;
    if (!captured) s.unreported_classes[dx.primary] = (s.unreported_classes[dx.primary] ?? 0) + 1;
    s.severity[String(dx.severity)] = (s.severity[String(dx.severity)] ?? 0) + 1;
    if (dx.weak) s.weak++;
    if (t.config && t.tier(e)) s.class_by_tier++;
  }
  return { ...s, diagnoses };
}

const pct = (a: number, b: number): string => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");

export function formatReport(s: Split, cfg: CallerConfig, examples: { ts: string; cls: string; sev: number; text: string }[]): string {
  const calibrated = Object.values(thresholdRows(cfg)).some((t) => t.calibrated);
  const sorted = (m: Record<string, number>) => Object.entries(m).sort((x, y) => y[1] - x[1]);
  const lines = [
    `# Errata v4 triage report — ${new Date().toISOString().slice(0, 10)}`,
    "",
    calibrated ? "" : "> UNCALIBRATED: every cut is the provisional registry value; ISC-44 (gold) has not run. Counts are shadow reads, not findings.",
    "",
    "## Coverage",
    `- exchanges: ${s.exchanges}; detected: ${s.detected}; detect errors pending retry: ${s.detect_errors}`,
    `- failures: ${s.failures} (${pct(s.failures, s.detected)} of detected); diagnosed: ${s.diagnosed}; diagnosis pending: ${s.diagnose_pending}`,
    `- flagged by the model tier's second look (the detect head passed them): ${s.second_look}; primary class named by the model tier: ${s.class_by_tier} of ${s.diagnosed} (the rest by the glance tier)`,
    "",
    "## Reported vs unreported",
    `- reported (already in the ledger): ${s.reported_failures} (${pct(s.reported_failures, s.failures)})`,
    `- unreported (no erratum): ${s.unreported_failures} (${pct(s.unreported_failures, s.failures)})`,
    `- captured but not a v4 failure: ${s.captured_non_failures}`,
    "",
    "## Primary class (diagnosed failures)",
    "| class | all | unreported |",
    "|---|---|---|",
    ...sorted(s.classes).map(([c, n]) => `| ${c} | ${n} | ${s.unreported_classes[c] ?? 0} |`),
    "",
    `Weak (no mode cleared its cut): ${s.weak}. Severity: ${[0, 1, 2, 3].map((k) => `${k}=${s.severity[k] ?? 0}`).join(" ")}.`,
    "",
    "## Unreported, severity 2+ (latest 15)",
    ...examples.map((e) => `- ${e.ts.slice(0, 10)} · ${e.cls} · sev ${e.sev} · ${e.text}`),
  ];
  return lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

export function report(opts: { dir?: string; store?: ErrataStore; cfg?: CallerConfig; model?: TriageModel | null; sections?: () => string[] } = {}): { path: string; split: Split } {
  const dir = opts.dir ?? v4Dir();
  const cfg = opts.cfg ?? loadCallers()[CALLER];
  const cuts = callerCuts(cfg);
  const exchanges = loadExchanges(dir);
  const idx = captureIndex((opts.store ?? new ErrataStore()).all());
  // Recompute the capture join against today's ledger; the stored flag is extraction-time.
  const bySession = new Map<string, Exchange[]>();
  for (const e of exchanges) (bySession.get(e.session) ?? bySession.set(e.session, []).get(e.session)!).push(e);
  const nextTs = new Map<string, number>();
  for (const list of bySession.values()) {
    list.sort((a, b) => a.ts.localeCompare(b.ts));
    list.forEach((e, i) => nextTs.set(e.id, list[i + 1] ? Date.parse(list[i + 1]!.ts) : Infinity));
  }
  const model = opts.model === undefined ? loadTriageModel() : opts.model;
  const split = reportSplit(exchanges, loadAnswers(dir), cuts, (e) => captureMatch(e, idx, nextTs.get(e.id)) !== null, model, dirLookup(model, dir));
  const examples = [...exchanges]
    .sort((x, y) => x.ts.localeCompare(y.ts))
    .filter((e) => { const d = split.diagnoses.get(e.id); return d && d.severity >= 2 && captureMatch(e, idx, nextTs.get(e.id)) === null; })
    .slice(-15)
    .map((e) => ({ ts: e.ts, cls: split.diagnoses.get(e.id)!.primary, sev: split.diagnoses.get(e.id)!.severity, text: scrub(e.prompt, e.session).replace(/\s+/g, " ").slice(0, 140) }));
  const { diagnoses: _diagnoses, ...plain } = split;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `report-${new Date().toISOString().slice(0, 10)}.md`);
  invariant(path.startsWith(dir), "report must land under the v4 dir");
  // M7b sections (Act.ts) append after the M7a body; a failure there never costs the report.
  let extra = "";
  if (opts.sections) {
    try { extra = `\n${opts.sections().join("\n")}\n`; } catch (e) { extra = `\n## Most-broken rules\nM7b sections unavailable: ${e instanceof Error ? e.message : String(e)}\n`; }
  }
  writeFileSync(path, formatReport(plain, cfg!, examples) + extra);
  return { path, split: plain };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function num(args: string[], flag: string): number | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const n = Number(args[i + 1]);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a nonnegative integer`);
  return n;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  if (cmd === "detect" || cmd === "diagnose") {
    const t0 = performance.now();
    const r = await (cmd === "detect" ? detect : diagnose)({ limit: num(args, "--limit"), chunk: num(args, "--chunk"), dryRun: args.includes("--dry-run") });
    if (args.includes("--dry-run") && r.example) console.log(`example state (${r.example.length} chars): ${r.example}`);
    console.log(JSON.stringify({ ...r, example: undefined, seconds: Math.round((performance.now() - t0) / 1000) }));
    return r.errors ? 1 : 0;
  }
  if (cmd === "rules" || cmd === "cover" || cmd === "cluster" || cmd === "recommend" || cmd === "act") return (await import("./Act")).main(argv);
  if (cmd === "report") {
    const { m7bSections } = await import("./Act");
    const r = report({ sections: () => m7bSections() });
    console.log(JSON.stringify({ path: r.path, ...r.split }));
    return 0;
  }
  console.error("usage: Triage4.ts detect|diagnose [--limit N] [--chunk N] [--dry-run] | report | rules|cover|cluster|recommend|act (Act.ts)");
  return 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
