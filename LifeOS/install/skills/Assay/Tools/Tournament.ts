/**
 * Tournament — a bracket in code over an injected pairwise judge.
 *
 * eval re-evaluation ISA, ISC-15/45/46: the bracket, the order
 * flip, the tie rule, the shuffled rerun, and the model bookkeeping are all
 * deterministic code here; the only model call is the pairwise judge handed
 * in. Every pair is judged TWICE with the order flipped: a winner that flips
 * with the order is position bias, not preference, and counts as a tie. The
 * whole bracket then runs a second time with shuffled seeding; a different
 * winner means the result is unstable and says so.
 *
 * A pair (champion, candidate) first asks Assay's judgment layer one choice question, both orders, under caller
 * `assay-pairwise` (eval-compile ISA F10); see "First tier" below. The bracket stays the escalation and,
 * while that caller is shadow, the verdict of record.
 *
 * Usage (tool contract; the real judge is VisionJudge pairwise for images or
 * the text pairwise in Judge.ts):
 *   bun Tournament.ts --candidates a.png,b.png,c.png --question "which better recovers the argument?" [--generator <model-id>] [--json]
 * Exit 0 stable winner · 1 unstable (or every pair tied) · 2 verifier unavailable.
 */
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { parseClaudeId } from '../../../LIFEOS/TOOLS/models.ts';
import { invariant } from '../../../LIFEOS/TOOLS/Invariant.ts';
import type { PairwiseCalibrationStatus } from './PairwiseCalibrate.ts';
import { guardVisionRequest } from './OpenAIVision.ts';

export type Winner = 'A' | 'B' | 'tie';
export interface PairVerdict { winner: Winner; reason: string; executed_model?: string }
/** One pairwise call: A first, B second. The tool never sees what A and B are. */
export type PairwiseJudge = (a: string, b: string, question: string) => Promise<PairVerdict>;

export interface PairLog {
  a: string;
  b: string;
  /** verdict with (a, b) in that order */
  forward: PairVerdict;
  /** verdict with the order flipped, mapped back to a/b */
  flipped: PairVerdict;
  /** the pair's result after the flip rule: a flipped winner is a tie */
  result: Winner;
  position_bias: boolean;
}

export interface TournamentResult {
  winner: string | null;
  /** the bracket order the winner was found on */
  seeding: string[];
  log: PairLog[];
  /** ISC-45: the shuffled rerun's winner, and whether it agreed */
  rerun: { seeding: string[]; winner: string | null; log: PairLog[] } | null;
  stable: boolean;
  /** ISC-46 */
  models: { generator: string | null; judge: string; same_family: boolean };
  exit: 0 | 1 | 2;
  summary: string;
  provisional: boolean;
  provisional_reason: string;
  model_provenance: string;
  label_basis: 'principal' | 'assistant' | 'mixed' | 'unspecified';
  human_validated: boolean;
  /** F10 ISC-50..52: the judgment-layer first tier on a two-candidate pair; null when none was configured */
  first_tier: FirstTierRecord | null;
}

export const EXIT_STABLE = 0;
export const EXIT_UNSTABLE = 1;
export const EXIT_UNAVAILABLE = 2;
export const DEFAULT_CONCURRENCY = 8;

type JudgeExecutor = <T>(task: () => Promise<T>) => Promise<T>;

function concurrencyLimiter(concurrency: number): JudgeExecutor {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency must be a positive integer');
  }
  let active = 0;
  const queued: Array<() => void> = [];
  const release = () => {
    active--;
    queued.shift()?.();
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) await new Promise<void>((resolve) => queued.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

/** Judge one pair both ways. Forward and flipped must agree on a winner or the pair is a tie. */
export async function judgePair(judge: PairwiseJudge, a: string, b: string, question: string, execute: JudgeExecutor = (task) => task()): Promise<PairLog> {
  const [forward, raw] = await Promise.all([
    execute(() => judge(a, b, question)),
    execute(() => judge(b, a, question)),
  ]);
  for (const verdict of [forward, raw]) {
    if (!verdict || !['A', 'B', 'tie'].includes(verdict.winner) || typeof verdict.reason !== 'string') {
      throw new Error('pairwise judge returned a malformed verdict');
    }
  }
  // map the flipped verdict back into a/b terms
  const flipped: PairVerdict = { ...raw, winner: raw.winner === 'A' ? 'B' : raw.winner === 'B' ? 'A' : 'tie', reason: raw.reason };
  const agree = forward.winner === flipped.winner;
  const result: Winner = agree ? forward.winner : 'tie';
  const position_bias = !agree && forward.winner !== 'tie' && flipped.winner !== 'tie';
  return { a, b, forward, flipped, result, position_bias };
}

/**
 * Single-elimination over the seeding order. A tie keeps the earlier seed
 * (the incumbent) so the bracket always resolves; the tie is visible in the
 * log, and the shuffled rerun catches a winner that only won on seeding.
 */
export async function runBracket(candidates: string[], judge: PairwiseJudge, question: string, concurrency = DEFAULT_CONCURRENCY, execute = concurrencyLimiter(concurrency)): Promise<{ winner: string | null; log: PairLog[] }> {
  const log: PairLog[] = [];
  let round = [...candidates];
  while (round.length > 1) {
    const matches = [] as Array<{ a: string; b?: string }>;
    for (let i = 0; i < round.length; i += 2) {
      const a = round[i]!;
      const b = round[i + 1];
      matches.push({ a, b });
    }
    const results = await Promise.all(matches.map(async ({ a, b }) => {
      if (b === undefined) return { winner: a, log: null }; // bye
      const pair = await judgePair(judge, a, b, question, execute);
      return { winner: pair.result === 'B' ? b : a, log: pair };
    }));
    const next: string[] = [];
    for (const result of results) {
      if (result.log) log.push(result.log);
      next.push(result.winner);
    }
    round = next;
  }
  return { winner: round[0] ?? null, log };
}

/** Deterministic shuffle (mulberry32) so a rerun is reproducible from its seed. */
export function shuffled<T>(items: T[], seed: number): T[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Model family for the same-family flag: Claude ids parse to their family, everything else is its vendor prefix (`gpt-…` → gpt, `gemini-…` → gemini). */
export function familyOf(id: string | null | undefined): string | null {
  if (!id) return null;
  const c = parseClaudeId(id);
  if (c) return `claude-${c.family}`;
  const m = id.toLowerCase().match(/^([a-z]+)/);
  return m ? m[1]! : id.toLowerCase();
}

export function sameFamily(generator: string | null | undefined, judge: string): boolean {
  const g = familyOf(generator);
  return g !== null && g === familyOf(judge);
}

// ── First tier: one judgment-layer choice question before any judge model ─────────────────────────────────
//
// eval-compile ISA F10 (ISC-50..53). A side-by-side of two candidates (champion first, candidate second,
// the order Compile emits) first asks Assay's judgment layer ONE choice question, candidate / champion / same, twice
// with the order flipped, so position bias cancels the way judgePair cancels it. The engine call is injected
// (PairAsk), so nothing here imports an engine; only the CLI binds it to Assay's judge(). Whether an answer may act is
// decide()'s call, carried back in each answer's verdict: this file never reads a threshold. While the caller is shadow
// the bracket still runs and decides, and the result records both verdicts and whether they agreed (ISC-51). Once it
// enforces, two orderings that agree on candidate or champion, each cleared by decide() in enforce mode, are the
// verdict and the pairwise judge never runs (ISC-52); a split, a `same`, or an answer below threshold escalates to the
// bracket. A bracket of three or more keeps today's path. Image pairs ride as attached images (ISC-53); a pair with one
// image and one text candidate, or a format the engine does not take, has nothing the engine can compare, so the
// bracket decides.

export const PAIRWISE_CALLER = 'assay-pairwise';
export const PAIRWISE_QUESTION = 'pairwise';
export const PAIR_OPTIONS = ['candidate', 'champion', 'same'] as const;
export type PairOption = (typeof PAIR_OPTIONS)[number];
/** The engine takes at most this many images in one question (Clef-omni's limit, Assay ISA M6). */
export const MAX_PAIR_MEDIA = 4;
const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;
/** The image formats the engine accepts as attachments (Engine.ts MEDIA_LIMITS); GIF reaches the bracket only. */
const ENGINE_IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const CONTENT_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

/** An image attached to the question: bytes as base64 plus a content type. Never a path. */
export interface PairMedia { data: string; contentType: string }
export interface PairChoiceQuestion { type: 'choice'; instructions: string; criteria: Record<PairOption, string> }
/** One question's answer plus decide()'s verdict on it, the shape Assay's judge() returns per question id. */
export interface PairJudgment {
  answer: { type: string; choice?: string; confidence?: number; probabilities?: Record<string, number> };
  verdict: { act: boolean; wouldAct?: boolean | null; mode: string; effectiveMode?: string; reason: string };
  model?: string;
}
/** The injected judgment-layer call: one state, one question map, optional attached images. */
export type PairAsk = (state: string, questions: Record<string, PairChoiceQuestion>, media?: PairMedia[]) => Promise<Record<string, PairJudgment>>;

export interface FirstTierOptions {
  /** The engine call; absent with `unavailable` set when this runtime cannot ask (caller unregistered, Assay not loadable). */
  ask?: PairAsk;
  /** Why the first tier cannot run here. The bracket decides, and the JSON says so. */
  unavailable?: string;
  /** --allow-identity: image pairs pass the same identity guard every pixel egress path uses (OpenAIVision.ts). */
  allowIdentity?: boolean;
}

export interface FirstTierOrdering {
  /** which candidate the question showed first */
  first: 'champion' | 'candidate';
  choice: PairOption;
  confidence: number;
  act: boolean;
  would_act: boolean | null;
  mode: string;
  /** decide()'s effective mode for this question (caller mode narrowed by a shadow question row), when it reported one */
  effective_mode: string | null;
  reason: string;
  model: string | null;
}

export interface FirstTierRecord {
  caller: typeof PAIRWISE_CALLER;
  question: typeof PAIRWISE_QUESTION;
  /** decided: the verdict stands, no judge ran · escalated: enforcing, but split, same or below threshold · shadow:
   * observed while the bracket decides · unavailable: not asked or no usable answer · not-applicable: three or more candidates */
  status: 'decided' | 'escalated' | 'shadow' | 'unavailable' | 'not-applicable';
  /** both orderings' shared answer, `split` when they differ, null when nothing was answered */
  verdict: PairOption | 'split' | null;
  orderings: FirstTierOrdering[];
  reason: string;
  /** what the bracket decided on the same pair, when it ran: `none` is no stable winner */
  bracket_verdict: 'candidate' | 'champion' | 'none' | null;
  /** first tier and bracket agree (candidate↔candidate, champion↔champion, same or split↔none); null when either is missing */
  agreed: boolean | null;
}

export const isImageCandidate = (c: string): boolean => IMAGE_RE.test(c);

/** The one choice question both orderings ask. Pure. */
/**
 * The image pairwise judge, bound to its material policy. Gemini is the image judge and receives only public material,
 * so a bracket over private images is refused unless the caller passes `--public` (publicMaterial), exactly as
 * VisionJudge.ts pairwise does; nothing here widens that policy.
 */
export function imagePairwiseJudge(
  opts: { allowIdentity?: boolean; publicMaterial?: boolean },
  judgeImagePairwise: (a: string, b: string, question: string, allowIdentity?: boolean, publicMaterial?: boolean) => ReturnType<PairwiseJudge>,
): PairwiseJudge {
  return (a, b, q) => judgeImagePairwise(a, b, q, opts.allowIdentity ?? false, opts.publicMaterial ?? false);
}

export function pairQuestion(question: string): PairChoiceQuestion {
  return {
    type: 'choice',
    instructions: question,
    criteria: {
      candidate: `The CANDIDATE (the new version) better satisfies: ${question}`,
      champion: `The CHAMPION (the last accepted version) better satisfies: ${question}`,
      same: 'Neither is meaningfully better: too close to call',
    },
  };
}

/**
 * The state and attached images for one ordering. Image candidates travel as media in the order shown and the state
 * names them only by position, so no file path ever reaches the engine (ISC-53). Text candidates are read from disk
 * when they are files, else taken as literal text, the same rule as the text pairwise judge.
 */
export function pairStateOf(champion: string, candidate: string, question: string, first: 'champion' | 'candidate'): { state: string; media: PairMedia[] } {
  const order = first === 'champion' ? [['CHAMPION', champion], ['CANDIDATE', candidate]] as const : [['CANDIDATE', candidate], ['CHAMPION', champion]] as const;
  // An image is never read as text: a mixed pair or an image the engine cannot take is refused before any bytes move.
  const problem = pairMediaProblem(champion, candidate);
  if (problem) throw new Error(problem);
  const images = isImageCandidate(champion);
  const media: PairMedia[] = images ? order.map(([, c]) => ({ data: readFileSync(c).toString('base64'), contentType: CONTENT_TYPES[c.slice(c.lastIndexOf('.') + 1).toLowerCase()]! })) : [];
  if (media.length > MAX_PAIR_MEDIA) throw new Error(`a pairwise question carries at most ${MAX_PAIR_MEDIA} images`);
  const body = order.map(([label, c], i) => `## ${label}\n${images ? `Attached image ${i + 1}.` : existsSync(c) ? readFileSync(c, 'utf-8') : c}`).join('\n\n');
  const state = `## QUESTION\n${question}\n\nCompare the CANDIDATE (the new version) with the CHAMPION (the last accepted version). Answer candidate, champion, or same.\n\n${body}`;
  return { state, media };
}

/** Why this pair cannot reach the engine as one comparable question, or null when it can. Pure. */
export function pairMediaProblem(champion: string, candidate: string): string | null {
  const a = isImageCandidate(champion), b = isImageCandidate(candidate);
  if (a !== b) return 'one candidate is an image and the other is not, so there is nothing the engine can compare';
  if (a && !(ENGINE_IMAGE_RE.test(champion) && ENGINE_IMAGE_RE.test(candidate))) return 'the engine takes PNG, JPEG or WebP attachments, not GIF';
  return null;
}

function orderingOf(first: 'champion' | 'candidate', judged: Record<string, PairJudgment>): FirstTierOrdering {
  const j = judged?.[PAIRWISE_QUESTION];
  const a = j?.answer;
  if (!j || a?.type !== 'choice' || !PAIR_OPTIONS.includes(a.choice as PairOption) || typeof a.confidence !== 'number' || !Number.isFinite(a.confidence)
    || typeof j.verdict?.act !== 'boolean' || typeof j.verdict.mode !== 'string') {
    throw new Error('judgment layer returned a malformed pairwise answer');
  }
  return { first, choice: a.choice as PairOption, confidence: a.confidence, act: j.verdict.act, would_act: j.verdict.wouldAct ?? null, mode: j.verdict.mode, effective_mode: typeof j.verdict.effectiveMode === 'string' ? j.verdict.effectiveMode : null, reason: String(j.verdict.reason ?? ''), model: j.model ?? null };
}

/** An ordering that may decide: decide() cleared it AND it says it ran in enforce mode. An `act` from a shadow verdict is
 * a malformed answer, never a licence (defence in depth: Assay's decide() never returns that pair). */
function enforcedClear(o: FirstTierOrdering): boolean {
  return o.act && o.mode === 'enforce' && (o.effective_mode === null || o.effective_mode === 'enforce');
}

/** Ask the one choice question both ways and read the pair. Never throws: an engine failure is `unavailable`. */
export async function askFirstTier(champion: string, candidate: string, question: string, tier: FirstTierOptions): Promise<FirstTierRecord> {
  const record = (status: FirstTierRecord['status'], verdict: FirstTierRecord['verdict'], orderings: FirstTierOrdering[], reason: string): FirstTierRecord =>
    ({ caller: PAIRWISE_CALLER, question: PAIRWISE_QUESTION, status, verdict, orderings, reason, bracket_verdict: null, agreed: null });
  if (!tier.ask) return record('unavailable', null, [], tier.unavailable ?? 'no judgment-layer call supplied');
  const problem = pairMediaProblem(champion, candidate);
  if (problem) return record('unavailable', null, [], `${problem}: the bracket decides`);
  // Image bytes leave the machine here, so the vision identity guard runs before any read, exactly as VisionJudge does.
  if (isImageCandidate(champion)) {
    try {
      for (const c of [champion, candidate]) guardVisionRequest(c, tier.allowIdentity ?? false);
    } catch (e) {
      return record('unavailable', null, [], `${(e as Error).message}: the bracket decides`);
    }
  }
  const ask = tier.ask;
  const questions = { [PAIRWISE_QUESTION]: pairQuestion(question) };
  let orderings: FirstTierOrdering[];
  try {
    orderings = await Promise.all((['champion', 'candidate'] as const).map(async (first) => {
      const { state, media } = pairStateOf(champion, candidate, question, first);
      return orderingOf(first, await ask(state, questions, media.length ? media : undefined));
    }));
  } catch (e) {
    return record('unavailable', null, [], `judgment layer unavailable: ${(e as Error).message}`);
  }
  const [x, y] = orderings as [FirstTierOrdering, FirstTierOrdering];
  const verdict: PairOption | 'split' = x.choice === y.choice ? x.choice : 'split';
  if (x.mode !== 'enforce' || y.mode !== 'enforce') {
    return record('shadow', verdict, orderings, `${PAIRWISE_CALLER} is ${x.mode !== 'enforce' ? x.mode : y.mode}: observed, the bracket decides`);
  }
  if ((verdict === 'candidate' || verdict === 'champion') && enforcedClear(x) && enforcedClear(y)) {
    return record('decided', verdict, orderings, `both orderings answered ${verdict} and decide() cleared each in enforce mode`);
  }
  const why = verdict === 'split' ? `the orderings disagree (${x.choice} / ${y.choice}): position bias`
    : verdict === 'same' ? 'both orderings answered same'
    : `below threshold (${[x, y].filter((o) => !o.act).map((o) => o.reason).join('; ')})`;
  return record('escalated', verdict, orderings, `${why}: escalated to the bracket`);
}

/** The bracket's verdict on a two-candidate pair, in first-tier terms. */
function bracketVerdictOf(champion: string, candidate: string, winner: string | null): 'candidate' | 'champion' | 'none' {
  return winner === candidate ? 'candidate' : winner === champion ? 'champion' : 'none';
}

function agreementOf(tier: FirstTierRecord, bracket: 'candidate' | 'champion' | 'none'): boolean | null {
  if (tier.verdict === null) return null;
  return tier.verdict === 'candidate' || tier.verdict === 'champion' ? tier.verdict === bracket : bracket === 'none';
}

/** The media shape Assay's ask() carries to the engine (Engine.ts EngineMedia, images only here). */
export interface AssayMedia { images: { content_type: string; base64: string }[] }
/** Assay's own test seams, passed through untouched; the CLI never sets them. */
export interface AssaySeams { fetchImpl?: typeof fetch; apiKey?: string; logPath?: string; env?: NodeJS.ProcessEnv }
/**
 * The CLI's engine call: Assay's judge() under caller `assay-pairwise`, which writes the judgment-layer ledger line
 * and returns decide()'s verdict per question. Image candidates go as `media.images` in the same call, in the order
 * the state names them (ISC-53); ask() sends them to the engine and keeps them out of the ledger.
 */
export type AssayJudge = (state: string, questions: Record<string, PairChoiceQuestion>, opts: { caller: string; callersPath?: string; media?: AssayMedia } & AssaySeams) => Promise<Record<string, PairJudgment>>;
export function judgmentLayerAsk(judge: AssayJudge, opts: { callersPath?: string } & AssaySeams = {}): PairAsk {
  const { callersPath, ...seams } = opts;
  return async (state, questions, media) => {
    const attached = media?.length ? { media: { images: media.map((m) => ({ content_type: m.contentType, base64: m.data })) } } : {};
    return judge(state, questions, { caller: PAIRWISE_CALLER, callersPath, ...seams, ...attached });
  };
}

/** The `assay-pairwise` row as it is first registered: shadow, fail open, no enforce evidence. */
export function pairwiseCallerRow(): Record<string, unknown> {
  return {
    mode: 'shadow',
    note: 'First tier of a side-by-side (eval-compile ISA F10): one choice question, candidate / champion / same, asked twice with the order flipped, before any judge model runs. Shadow until principal labels earn enforce; while shadow, Tournament\'s bracket decides and the agreement is recorded in its JSON.',
    ground_truth: {},
    corrective: {},
    fail: 'open',
    budget: { calls_per_day: 1000, tokens_per_day: 2000000 },
    thresholds: {},
    enforce_evidence: null,
    enforce_bar: 0.85,
  };
}

/**
 * Register caller `assay-pairwise` and its `pairwise` question, both shadow, in the caller registry. Idempotent: a row
 * already present is left exactly as it is, and a present caller missing the question gets only the question. The
 * question row goes through Assay's registerQuestion, the sanctioned writer; this adds only the caller row it needs.
 * Never runs on import: the main session calls it, or `bun Tournament.ts --register-caller`.
 */
export async function registerPairwiseCaller(opts: { callersPath?: string } = {}): Promise<{ path: string; caller: 'added' | 'present'; question: 'added' | 'present' }> {
  const { defaultCallersPath, loadRegistry, registerQuestion, validateCallers } = await import('../../../LIFEOS/ASSAY/Assay.ts');
  const path = opts.callersPath ?? defaultCallersPath();
  // A writer must never turn a malformed or missing registry into an empty one.
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  invariant(raw && typeof raw === 'object' && !Array.isArray(raw), `${path}: the caller registry must be a JSON object`);
  const { callers } = loadRegistry(path);
  let caller: 'added' | 'present' = 'present';
  if (!Object.hasOwn(raw, PAIRWISE_CALLER)) {
    const row = pairwiseCallerRow();
    invariant(row.mode === 'shadow' && row.enforce_evidence === null, `${PAIRWISE_CALLER} is first registered in shadow, never enforce`);
    validateCallers({ ...callers, [PAIRWISE_CALLER]: row as never });
    raw[PAIRWISE_CALLER] = row;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(raw, null, 2) + '\n', { flag: 'wx', mode: statSync(path).mode & 0o777 });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
    caller = 'added';
  }
  const current = loadRegistry(path).callers[PAIRWISE_CALLER]!;
  if (Object.hasOwn(current.thresholds, PAIRWISE_QUESTION) || Object.hasOwn(current.ground_truth, PAIRWISE_QUESTION)) return { path, caller, question: 'present' };
  registerQuestion(PAIRWISE_CALLER, PAIRWISE_QUESTION, { callersPath: path });
  return { path, caller, question: 'added' };
}

export interface TournamentOptions {
  judge: PairwiseJudge;
  question: string;
  /** the model that produced the candidates, when known */
  generator?: string | null;
  /** the model behind `judge` */
  judgeModel: string;
  /** seed for the shuffled rerun; the default is fixed so runs are reproducible */
  seed?: number;
  /** Diagnostic only: omitting the rerun cannot establish verified stability. */
  rerun?: boolean;
  /** Maximum simultaneous judge requests across both brackets. */
  concurrency?: number;
  /** Status of an explicitly supplied, provenance-bound principal-label calibration record. */
  calibration?: PairwiseCalibrationStatus;
  /** Native CLI binding; injected judges do not inherit a calibration record by default. */
  calibrationRuntime?: 'text' | 'image';
  /** F10: ask the judgment layer first on a two-candidate pair (champion first, candidate second). */
  firstTier?: FirstTierOptions;
}

export async function runTournament(candidates: string[], opts: TournamentOptions): Promise<TournamentResult> {
  const models = { generator: opts.generator ?? null, judge: opts.judgeModel, same_family: sameFamily(opts.generator, opts.judgeModel) };
  const seeding = [...candidates];
  const record = opts.calibration?.record;
  const bound = opts.calibration?.earned && record?.earned && opts.calibrationRuntime === record.mode
    && record.question === opts.question && record.requested_model === opts.judgeModel;
  const evidence = {
    provisional: !bound,
    provisional_reason: bound ? 'earned' : opts.calibration?.earned ? 'calibration is not bound to this executing judge and criterion' : opts.calibration?.reason ?? 'no pairwise calibration record supplied',
    model_provenance: 'models names configured models; executed_model in each verdict is observed when available',
    label_basis: record?.label_basis ?? 'unspecified',
    human_validated: bound === true && record?.human_validated === true,
  };
  const flag = (s: string) => (models.same_family ? `${s} · SAME FAMILY: generator and judge are both ${familyOf(opts.judgeModel)}` : s);
  if (candidates.length < 2 || new Set(candidates).size !== candidates.length) {
    return { ...evidence, winner: null, seeding, log: [], rerun: null, stable: false, models, exit: EXIT_UNSTABLE, summary: flag('comparison requires at least two distinct candidates without duplicate entries'), first_tier: null };
  }
  // F10: on a pair, the judgment layer answers first. A decided first tier is the verdict and no judge runs.
  let firstTier: FirstTierRecord | null = null;
  if (opts.firstTier && candidates.length === 2) {
    const [champion, candidate] = candidates as [string, string];
    firstTier = await askFirstTier(champion, candidate, opts.question, opts.firstTier);
    if (firstTier.status === 'decided') {
      const winner = firstTier.verdict === 'candidate' ? candidate : champion;
      const engine = firstTier.orderings[0]?.model ?? `judgment layer (${PAIRWISE_CALLER})`;
      const engineModels = { generator: models.generator, judge: engine, same_family: sameFamily(opts.generator, engine) };
      const tag = engineModels.same_family ? ` · SAME FAMILY: generator and judge are both ${familyOf(engine)}` : '';
      // The evidence here is the judgment layer's, never `opts.calibration`: that record calibrates the bracket's pairwise
      // judge, which did not run. A decided first tier needs decide() to clear both orderings in enforce mode, and Assay
      // admits an enforcing question only when the label store reads it earned from principal right/wrong labels
      // (Assay.ts validateCallers on every registry read; LabelStore earnedStatus counts source "principal" only).
      return {
        winner, seeding, log: [], rerun: null, stable: true, models: engineModels, exit: EXIT_STABLE,
        summary: `winner ${winner} (first tier: ${PAIRWISE_CALLER} answered ${firstTier.verdict} in both orders, no judge ran)${tag}`,
        provisional: false,
        provisional_reason: `earned: ${PAIRWISE_CALLER}.${PAIRWISE_QUESTION} enforces, which Assay admits only on principal labels, and decide() cleared both orderings against its registered threshold`,
        model_provenance: 'models.judge names the judgment-layer model the first ordering reported; each ordering carries its own model',
        label_basis: 'principal',
        human_validated: true,
        first_tier: firstTier,
      };
    }
  } else if (opts.firstTier) {
    firstTier = { caller: PAIRWISE_CALLER, question: PAIRWISE_QUESTION, status: 'not-applicable', verdict: null, orderings: [], reason: `${candidates.length} candidates: the first tier compares a champion and one candidate, the bracket decides`, bracket_verdict: null, agreed: null };
  }
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const execute = concurrencyLimiter(concurrency);
  let rerunSeeding: string[] | null = null;
  if (opts.rerun !== false) {
    rerunSeeding = shuffled(seeding, opts.seed ?? 1);
    if (rerunSeeding.every((candidate, index) => candidate === seeding[index])) rerunSeeding = [...seeding].reverse();
  }
  let first: { winner: string | null; log: PairLog[] };
  let rerun: TournamentResult['rerun'] = null;
  try {
    const brackets = await Promise.all([
      runBracket(seeding, opts.judge, opts.question, concurrency, execute),
      rerunSeeding === null ? null : runBracket(rerunSeeding, opts.judge, opts.question, concurrency, execute),
    ]);
    first = brackets[0];
    if (rerunSeeding !== null && brackets[1] !== null) {
      rerun = { seeding: rerunSeeding, winner: brackets[1].winner, log: brackets[1].log };
    }
  } catch (e) {
    return { ...evidence, winner: null, seeding, log: [], rerun: null, stable: false, models, exit: EXIT_UNAVAILABLE, summary: `verifier unavailable: ${(e as Error).message}`, first_tier: firstTier };
  }
  const allTied = first.log.length > 0 && first.log.every((p) => p.result === 'tie');
  const decisiveWinner = (bracket: { winner: string | null; log: PairLog[] }): boolean => {
    const matches = bracket.log.filter((p) => p.a === bracket.winner || p.b === bracket.winner);
    return matches.length > 0 && matches.every((p) => p.result !== 'tie' && (p.result === 'A' ? p.a : p.b) === bracket.winner);
  };
  const stable = !allTied && rerun !== null && rerun.winner === first.winner && decisiveWinner(first) && decisiveWinner(rerun);
  const bias = first.log.filter((p) => p.position_bias).length;
  const summary = allTied
    ? 'every pair tied: the judge cannot separate these candidates'
    : rerun === null
      ? `diagnostic winner ${first.winner}; stability not verified (shuffled rerun omitted)`
    : stable
      ? `winner ${first.winner} (${first.log.length} pairs${rerun ? ', shuffled rerun agrees' : ''}${bias ? `, ${bias} position-bias tie${bias > 1 ? 's' : ''}` : ''})`
      : `unstable: ${first.winner} on seeded order, ${rerun?.winner} on shuffled order; differing winners or an undecided winner comparison`;
  if (bound && record?.observed_models.length) {
    const observed = [...first.log, ...(rerun?.log ?? [])].flatMap((p) => [p.forward.executed_model, p.flipped.executed_model]);
    if (observed.some((model) => !model || !record.observed_models.includes(model))) {
      evidence.provisional = true;
      evidence.human_validated = false;
      evidence.provisional_reason = 'executing model evidence differs from the calibrated comparison path';
    }
  }
  const winner = stable ? first.winner : null;
  // ISC-51: the bracket decided; record what it said next to the first tier, and whether they agree.
  let tierNote = '';
  if (firstTier && firstTier.status !== 'not-applicable') {
    const bracket = bracketVerdictOf(candidates[0]!, candidates[1]!, winner);
    firstTier = { ...firstTier, bracket_verdict: bracket, agreed: agreementOf(firstTier, bracket) };
    tierNote = firstTier.status === 'unavailable' ? ' · first tier unavailable'
      : ` · first tier (${firstTier.status}): ${firstTier.verdict}, ${firstTier.agreed ? 'agrees' : 'disagrees'} with the bracket`;
  }
  return { ...evidence, winner, seeding, log: first.log, rerun, stable, models, exit: stable ? EXIT_STABLE : EXIT_UNSTABLE, summary: flag(summary + tierNote), first_tier: firstTier };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      candidates: { type: 'string' },
      question: { type: 'string' },
      generator: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
      'allow-identity': { type: 'boolean', default: false },
      public: { type: 'boolean', default: false },
      'no-rerun': { type: 'boolean', default: false },
      concurrency: { type: 'string' },
      calibration: { type: 'string' },
      'register-caller': { type: 'boolean', default: false },
      callers: { type: 'string' },
    },
  });
  if (values['register-caller']) {
    // One explicit write of the caller registry (F10): never on import, never as a side effect of a comparison.
    console.log(JSON.stringify(await registerPairwiseCaller({ callersPath: values.callers })));
    process.exit(0);
  }
  if (values.help || !values.candidates || !values.question) {
    console.log('Tournament — judgment-layer first tier on a pair, then bracket + flipped pairwise + shuffled rerun\n\n  bun Tournament.ts --candidates <champion>,<candidate>[,more...] --question "..." [--generator <model-id>] [--calibration <set.yaml>] [--concurrency N] [--json] [--allow-identity] [--public] [--no-rerun]\n  bun Tournament.ts --register-caller [--callers <assay-callers.json>]   add caller assay-pairwise (shadow) to the registry\n\nWith exactly two candidates, one choice question (candidate / champion / same) goes to Assay\'s judgment layer first, twice with the order flipped; it decides alone only when assay-pairwise enforces. Concurrency defaults to 8 simultaneous judge requests. Exit 0 stable winner · 1 unstable or all tied · 2 verifier unavailable.');
    process.exit(values.help ? 0 : 1);
  }
  const candidates = values.candidates.split(',').map((s) => s.trim()).filter(Boolean);
  // Image candidates ride the vision judge; anything else is a text pairwise over Judge.ts's inference path.
  const images = candidates.every(isImageCandidate);
  let judge: PairwiseJudge;
  let judgeModel: string;
  if (images) {
    const { judgeImagePairwise } = await import('./VisionJudge.ts');
    const { CROSS_VENDOR } = await import('../../../LIFEOS/TOOLS/models.ts');
    judge = imagePairwiseJudge({ allowIdentity: values['allow-identity'], publicMaterial: values.public }, judgeImagePairwise);
    judgeModel = CROSS_VENDOR.gemini;
  } else {
    const { judgeTextPairwise, textPairwiseModel } = await import('./Judge.ts');
    judge = judgeTextPairwise;
    judgeModel = textPairwiseModel();
  }
  const { pairwiseCalibrationStatus } = await import('./PairwiseCalibrate.ts');
  const calibration = pairwiseCalibrationStatus(values.calibration, { mode: images ? 'image' : 'text', question: values.question, requestedModel: judgeModel });
  const concurrency = values.concurrency === undefined ? DEFAULT_CONCURRENCY : Number(values.concurrency);
  // F10 first tier, pairs only. Text and image pairs both go to Assay's judge(); images ride as attached media, never
  // as paths in text (ISC-53). An unregistered caller has no budget row, so it is not asked, and the JSON says why.
  let firstTier: FirstTierOptions | undefined;
  if (candidates.length === 2) {
    try {
      const assay = await import('../../../LIFEOS/ASSAY/Assay.ts');
      firstTier = assay.safeCallerConfig(PAIRWISE_CALLER)
        ? { ask: judgmentLayerAsk(assay.judge as unknown as AssayJudge), allowIdentity: values['allow-identity'] }
        : { unavailable: `caller ${PAIRWISE_CALLER} is not registered (bun Tournament.ts --register-caller), so the bracket decides` };
    } catch (e) {
      firstTier = { unavailable: `judgment layer did not load: ${(e as Error).message}` };
    }
  }
  const r = await runTournament(candidates, { judge, question: values.question, generator: values.generator ?? null, judgeModel, rerun: !values['no-rerun'], concurrency, calibration, calibrationRuntime: images ? 'image' : 'text', firstTier });
  if (values.json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`\n🏆 ${r.summary}\n`);
    console.log(`  calibration: ${r.provisional ? r.provisional_reason : 'earned'} · labels ${r.label_basis} · human validation ${r.human_validated ? 'recorded' : 'not recorded'}`);
    if (r.first_tier) console.log(`  first tier (${r.first_tier.caller}): ${r.first_tier.status} · ${r.first_tier.verdict ?? 'no answer'} · ${r.first_tier.reason}${r.first_tier.agreed === null ? '' : r.first_tier.agreed ? ' · agrees with the bracket' : ' · disagrees with the bracket'}`);
    for (const p of r.log) console.log(`  ${p.result === 'tie' ? '=' : p.result === 'A' ? '<' : '>'} ${p.a} vs ${p.b}${p.position_bias ? ' (position bias → tie)' : ''}\n      fwd: ${p.forward.reason}\n      flp: ${p.flipped.reason}`);
    if (r.rerun) console.log(`\n  rerun (shuffled): winner ${r.rerun.winner ?? 'none'}`);
  }
  process.exit(r.exit);
}
