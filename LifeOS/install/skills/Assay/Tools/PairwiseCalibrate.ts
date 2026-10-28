#!/usr/bin/env bun
/**
 * PairwiseCalibrate — principal-labeled preference calibration for the
 * flipped-order Tournament judge.  This deliberately has its own record type:
 * binary rubric calibration cannot certify a pairwise preference path.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { invariant } from '../../../LIFEOS/TOOLS/Invariant.ts';
import { CROSS_VENDOR } from '../../../LIFEOS/TOOLS/models.ts';
import { judgePair, type PairLog, type PairwiseJudge, type Winner } from './Tournament.ts';
import { judgeTextPairwise, textPairwiseModel, namedPairwiseJudge } from './Judge.ts';
import { judgeModelId } from '../../../LIFEOS/ASSAY/JudgeCall.ts';
import { resolveVendors, judgeChain, chainHashOf, type CalEntry, type CalibrationRecord } from '../../../LIFEOS/TOOLS/lib/Calibration.ts';

export type PairwiseMode = 'text' | 'image';
export interface PairwiseCalibrationExample { a: string; b: string; label: Winner; note?: string; label_source?: CalEntry['label_source'] }
export interface PairwiseCalibrationSet { mode: PairwiseMode; question: string; examples: PairwiseCalibrationExample[] }
export interface PairwiseFingerprint { question_hash: string; labels_hash: string; candidates_hash: string; implementation_hash: string; configuration_hash: string }
export interface PairwiseCalibrationRecord {
  version: 1;
  mode: PairwiseMode;
  question: string;
  fingerprint: PairwiseFingerprint;
  requested_model: string;
  observed_models: string[];
  runtime_provenance: 'verified' | 'unverified';
  agreement: number;
  kappa: number;
  n: number;
  per_label: Record<Winner, number>;
  counts_ok: boolean;
  earned: boolean;
  label_basis?: CalibrationRecord['label_basis'];
  human_validated?: boolean;
  ts: string;
  disagreements: { index: number; label: Winner; judge: Winner; reason: string }[];
}
export interface PairwiseCalibrationStatus {
  earned: boolean;
  provisional: boolean;
  reason: string;
  record: PairwiseCalibrationRecord | null;
}
export interface PairwiseCalibrateOptions {
  judge: PairwiseJudge;
  requestedModel: string;
  /** Only the real text/image CLI paths may assert this. Injected test judges stay provisional by default. */
  runtimeProvenance?: 'verified' | 'unverified';
  implementationFiles?: string[];
  now?: Date;
  /** Examples judged at once (default 1). */
  concurrency?: number;
}

const SHA = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const RESULT_SUFFIX = '.pairwise.result.json';
const labels = ['A', 'B', 'tie'] as const;

export function pairwiseRecordPath(setPath: string): string { return `${setPath}${RESULT_SUFFIX}`; }

/** Exact text candidate semantics match judgeTextPairwise: an existing path is read, otherwise it is literal text. */
function candidateBytes(candidate: string, mode: PairwiseMode): Buffer {
  if (mode === 'image') {
    if (!existsSync(candidate)) throw new Error(`image calibration candidate does not exist: ${candidate}`);
    return readFileSync(candidate);
  }
  return existsSync(candidate) ? readFileSync(candidate) : Buffer.from(candidate, 'utf8');
}

function implementationHash(mode: PairwiseMode, files?: string[]): string {
  const defaults = mode === 'text'
    ? [new URL('./Tournament.ts', import.meta.url), new URL('./Judge.ts', import.meta.url), new URL('../../../LIFEOS/TOOLS/lib/JudgePrompts.ts', import.meta.url)]
    : [new URL('./Tournament.ts', import.meta.url), new URL('./VisionJudge.ts', import.meta.url), new URL('../../../LIFEOS/TOOLS/lib/JudgePrompts.ts', import.meta.url)];
  const paths = files ?? defaults.map((url) => url.pathname);
  return SHA(paths.map((path) => `${basename(path)}:${SHA(readFileSync(path))}`).join('|'));
}

function normalizedSet(value: unknown): PairwiseCalibrationSet | null {
  if (!value || typeof value !== 'object') return null;
  const set = value as PairwiseCalibrationSet;
  if ((set.mode !== 'text' && set.mode !== 'image') || typeof set.question !== 'string' || !set.question.trim() || !Array.isArray(set.examples) || set.examples.length === 0) return null;
  if (!set.examples.every((e) => e && typeof e.a === 'string' && e.a.length > 0 && typeof e.b === 'string' && e.b.length > 0 && labels.includes(e.label))) return null;
  return set;
}

export function readPairwiseCalibrationSet(path: string): { set: PairwiseCalibrationSet; labelsTs: string } | null {
  if (!existsSync(path)) return null;
  try {
    const set = normalizedSet(parseYaml(readFileSync(path, 'utf8')));
    return set ? { set, labelsTs: new Date(statSync(path).mtimeMs).toISOString() } : null;
  } catch { return null; }
}

export function validatePairwiseSet(set: PairwiseCalibrationSet): string | null {
  const counts: Record<Winner, number> = { A: 0, B: 0, tie: 0 };
  const examples = new Set<string>();
  for (const entry of set.examples) {
    const a = candidateBytes(entry.a, set.mode);
    const b = candidateBytes(entry.b, set.mode);
    if (a.equals(b)) return 'each pairwise calibration example needs two different candidate bytes';
    // A and B are an unordered example identity; a reversed duplicate is not another label.
    const pair = [SHA(a), SHA(b)].sort().join(':');
    if (examples.has(pair)) return 'pairwise calibration examples must be distinct candidate pairs';
    examples.add(pair);
    counts[entry.label]++;
  }
  return labels.some((label) => counts[label] < 2)
    ? 'pairwise calibration requires at least two labels for each of A, B, and tie'
    : null;
}

export function fingerprintPairwiseSet(set: PairwiseCalibrationSet, implementationFiles?: string[]): PairwiseFingerprint {
  const candidates = set.examples.map((entry) => ({ a: SHA(candidateBytes(entry.a, set.mode)), b: SHA(candidateBytes(entry.b, set.mode)) }));
  return {
    question_hash: SHA(set.question),
    labels_hash: SHA(JSON.stringify(set.examples.map((entry) => ({ label: entry.label, note: entry.note ?? null, label_source: entry.label_source ?? null })))),
    candidates_hash: SHA(JSON.stringify(candidates)),
    implementation_hash: implementationHash(set.mode, implementationFiles),
    configuration_hash: SHA(set.mode === 'image' ? CROSS_VENDOR.gemini : chainHashOf(judgeChain('high', resolveVendors()))),
  };
}

/** Three-class Cohen's kappa. Constant judges correctly score 0. */
export function multiclassKappa(pairs: { label: Winner; judge: Winner }[]): number {
  if (!pairs.length) return 0;
  const observed = pairs.filter((pair) => pair.label === pair.judge).length / pairs.length;
  const expected = labels.reduce((sum, label) => {
    const human = pairs.filter((pair) => pair.label === label).length / pairs.length;
    const judge = pairs.filter((pair) => pair.judge === label).length / pairs.length;
    return sum + human * judge;
  }, 0);
  return expected >= 1 ? 0 : Number.isFinite((observed - expected) / (1 - expected)) ? (observed - expected) / (1 - expected) : 0;
}

function observedModels(log: PairLog): string[] {
  return [log.forward.executed_model, log.flipped.executed_model].filter((model): model is string => typeof model === 'string' && model.trim().length > 0);
}

/** Runs the actual flipped judge for every principal-labeled pair. A failure writes nothing. */
export async function calibratePairwise(setPath: string, opts: PairwiseCalibrateOptions): Promise<{ code: 0 | 1 | 2; record?: PairwiseCalibrationRecord; error?: string }> {
  const loaded = readPairwiseCalibrationSet(setPath);
  if (!loaded) return { code: 1, error: `invalid or missing pairwise calibration set: ${setPath}` };
  let validation: string | null;
  let fingerprint: PairwiseFingerprint;
  try {
    validation = validatePairwiseSet(loaded.set);
    fingerprint = fingerprintPairwiseSet(loaded.set, opts.implementationFiles);
  } catch (error) { return { code: 1, error: (error as Error).message }; }
  if (validation) return { code: 1, error: validation };

  const verdicts: PairLog[] = [];
  try {
    // Examples run in parallel up to opts.concurrency; verdicts keep the set's order.
    const width = Math.max(1, Math.floor(opts.concurrency ?? 1));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(width, loaded.set.examples.length) }, async () => {
      while (next < loaded.set.examples.length) {
        const i = next++;
        const example = loaded.set.examples[i]!;
        verdicts[i] = await judgePair(opts.judge, example.a, example.b, loaded.set.question);
      }
    }));
  } catch (error) {
    // Unavailable evidence must preserve the prior earned record.
    return { code: 2, error: `pairwise judge unavailable: ${(error as Error).message}` };
  }
  const pairs = loaded.set.examples.map((example, index) => ({ label: example.label, judge: verdicts[index]!.result }));
  try {
    const current = readPairwiseCalibrationSet(setPath);
    if (!current || JSON.stringify(fingerprintPairwiseSet(current.set, opts.implementationFiles)) !== JSON.stringify(fingerprint)) {
      return { code: 2, error: 'pairwise evidence or judge configuration changed during calibration; no record was changed' };
    }
  } catch (error) { return { code: 2, error: `pairwise evidence unavailable after calibration: ${(error as Error).message}` }; }
  const agreement = pairs.filter((pair) => pair.label === pair.judge).length / pairs.length;
  const per_label: Record<Winner, number> = { A: 0, B: 0, tie: 0 };
  for (const example of loaded.set.examples) per_label[example.label]++;
  const counts_ok = labels.every((label) => per_label[label] >= 2);
  const observed_models = [...new Set(verdicts.flatMap(observedModels))].sort();
  const runtime_provenance = opts.runtimeProvenance ?? 'unverified';
  const kappa = multiclassKappa(pairs);
  // Provider model metadata is preserved when present; its absence stays
  // unknown. Native paths bind configuration separately from observed IDs.
  const earned = agreement >= 0.85 && kappa >= 0.4 && counts_ok && runtime_provenance === 'verified';
  const record: PairwiseCalibrationRecord = {
    version: 1, mode: loaded.set.mode, question: loaded.set.question, fingerprint,
    requested_model: opts.requestedModel, observed_models, runtime_provenance,
    agreement, kappa, n: pairs.length, per_label, counts_ok, earned,
    label_basis: loaded.set.examples.every((e) => e.label_source?.kind === 'principal') ? 'principal'
      : loaded.set.examples.every((e) => e.label_source?.kind === 'assistant') ? 'assistant'
      : loaded.set.examples.some((e) => e.label_source) ? 'mixed' : 'unspecified',
    human_validated: loaded.set.examples.every((e) => e.label_source?.kind === 'principal' || e.label_source?.principal_reviewed === true),
    ts: (opts.now ?? new Date()).toISOString(),
    disagreements: pairs.flatMap((pair, index) => pair.label === pair.judge ? [] : [{ index, label: pair.label, judge: pair.judge, reason: verdicts[index]!.forward.reason }]),
  };
  invariant(record.n === loaded.set.examples.length, 'pairwise calibration record must contain every supplied label before persistence');
  invariant(record.fingerprint.labels_hash === fingerprint.labels_hash, 'pairwise calibration record must bind its labels before persistence');
  mkdirSync(resolve(setPath, '..'), { recursive: true });
  const target = pairwiseRecordPath(setPath);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(record, null, 2));
  renameSync(temporary, target);
  return { code: 0, record };
}

export function pairwiseCalibrationStatus(setPath: string | undefined, expected: { mode: PairwiseMode; question: string; requestedModel: string; implementationFiles?: string[] }): PairwiseCalibrationStatus {
  if (!setPath) return { earned: false, provisional: true, reason: 'no pairwise calibration record supplied', record: null };
  const loaded = readPairwiseCalibrationSet(setPath);
  if (!loaded) return { earned: false, provisional: true, reason: 'pairwise calibration labels are missing or malformed', record: null };
  let validation: string | null;
  try { validation = validatePairwiseSet(loaded.set); }
  catch (error) { return { earned: false, provisional: true, reason: `pairwise calibration candidates unavailable: ${(error as Error).message}`, record: null }; }
  if (validation) return { earned: false, provisional: true, reason: validation, record: null };
  if (loaded.set.mode !== expected.mode) return { earned: false, provisional: true, reason: `pairwise calibration mode is ${loaded.set.mode}, tournament is ${expected.mode}`, record: null };
  if (loaded.set.question !== expected.question) return { earned: false, provisional: true, reason: 'pairwise calibration criterion differs from this tournament question', record: null };
  const path = pairwiseRecordPath(setPath);
  if (!existsSync(path)) return { earned: false, provisional: true, reason: 'pairwise calibration has no recorded judge run', record: null };
  let record: PairwiseCalibrationRecord;
  try { record = JSON.parse(readFileSync(path, 'utf8')) as PairwiseCalibrationRecord; }
  catch { return { earned: false, provisional: true, reason: 'pairwise calibration record is unreadable', record: null }; }
  let fingerprint: PairwiseFingerprint;
  try { fingerprint = fingerprintPairwiseSet(loaded.set, expected.implementationFiles); }
  catch (error) { return { earned: false, provisional: true, reason: `pairwise calibration candidates unavailable: ${(error as Error).message}`, record }; }
  if (!record || record.version !== 1 || !record.fingerprint || !Array.isArray(record.observed_models) || !Number.isFinite(record.agreement) || !Number.isFinite(record.kappa) || !record.per_label || record.n !== loaded.set.examples.length) {
    return { earned: false, provisional: true, reason: 'pairwise calibration record is incomplete or unsupported', record };
  }
  if (record.mode !== expected.mode || record.question !== expected.question) return { earned: false, provisional: true, reason: 'pairwise calibration record does not bind this modality and criterion', record };
  if (record.requested_model !== expected.requestedModel) return { earned: false, provisional: true, reason: 'pairwise judge configuration changed since calibration', record };
  if (Object.entries(fingerprint).some(([key, value]) => record.fingerprint[key as keyof PairwiseFingerprint] !== value)) return { earned: false, provisional: true, reason: 'pairwise labels, candidate bytes, or judge implementation changed since calibration', record };
  if (record.runtime_provenance !== 'verified') return { earned: false, provisional: true, reason: 'pairwise calibration lacks verified runtime model provenance', record };
  if (!record.earned || record.agreement < 0.85 || record.kappa < 0.4 || !record.counts_ok || labels.some((label) => record.per_label[label] < 2)) return { earned: false, provisional: true, reason: `pairwise calibration not earned (agreement ${(record.agreement * 100).toFixed(0)}%, kappa ${record.kappa.toFixed(2)})`, record };
  return { earned: true, provisional: false, reason: 'earned', record };
}

if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { calibration: { type: 'string' }, json: { type: 'boolean' }, 'allow-identity': { type: 'boolean', default: false }, public: { type: 'boolean', default: false }, judge: { type: 'string' }, concurrency: { type: 'string' } } });
  if (!values.calibration) {
    console.log('PairwiseCalibrate — labeled preference calibration for Tournament\n\n  bun PairwiseCalibrate.ts --calibration <set.yaml> [--json] [--allow-identity] [--public] [--judge <registry name>] [--concurrency <n>]\n\n  --public   consent that every image in an image set is public material; Gemini is the image judge and receives other material only if the evaluator-vendor policy approves Google (same flag as Tournament).\n  --judge picks one text judge by its registry name (JudgeCall.namedJudge), with no judgment-layer first pass.');
    process.exit(1);
  }
  const concurrency = values.concurrency ? Number(values.concurrency) : 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) { console.error('--concurrency takes a whole number of at least 1'); process.exit(1); }
  const loaded = readPairwiseCalibrationSet(values.calibration);
  if (!loaded) { console.error(`invalid or missing pairwise calibration set: ${values.calibration}`); process.exit(1); }
  const image = loaded!.set.mode === 'image';
  let judge: PairwiseJudge;
  let requestedModel: string;
  if (image) {
    const { judgeImagePairwise } = await import('./VisionJudge.ts');
    judge = (a, b, question) => judgeImagePairwise(a, b, question, values['allow-identity'], values.public);
    requestedModel = CROSS_VENDOR.gemini;
  } else if (values.judge) {
    const model = judgeModelId(values.judge);
    if (!model) { console.error(`no judge named ${values.judge} in the registry`); process.exit(1); }
    judge = namedPairwiseJudge(values.judge);
    requestedModel = model!;
  } else {
    judge = judgeTextPairwise;
    requestedModel = textPairwiseModel();
  }
  if (!image && values.public) { console.error('--public applies to image sets only'); process.exit(1); }
  if (image && values.judge) { console.error('--judge applies to text sets only'); process.exit(1); }
  const result = await calibratePairwise(values.calibration, { judge, requestedModel, runtimeProvenance: 'verified', concurrency });
  if (values.json && result.record) console.log(JSON.stringify(result.record, null, 2));
  else if (result.record) console.log(`pairwise calibration: ${result.record.earned ? 'EARNED' : 'PROVISIONAL'} · agreement ${(result.record.agreement * 100).toFixed(0)}% · kappa ${result.record.kappa.toFixed(2)} · labels ${result.record.label_basis} · human validation ${result.record.human_validated ? 'recorded' : 'not recorded'} · requested ${result.record.requested_model} · observed ${result.record.observed_models.join(', ') || 'none'}`);
  else console.error(result.error);
  process.exit(result.code);
}
