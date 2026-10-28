#!/usr/bin/env bun
/**
 * EvalRound — one command for one image eval round, every independent call in parallel.
 *
 * Stage 1 (asserts) runs on every candidate at once. For the survivors, the
 * meaning ladder (blind describe + rung, one VisionJudge `ladder` call per
 * candidate, which returns the description too), the cross-vendor ArtDirection
 * Critique, and the flipped Tournament all start together; the tournament never
 * waits for the ladder. Each stage runs as its own CLI subprocess with a hard
 * timeout that kills its process group, so one slow or failed call marks that
 * candidate's stage UNKNOWN and the round still finishes.
 *
 * This is a speed change only: every judge is invoked through its own CLI with
 * its own prompt and bar. EvalRound never rewrites what a judge is asked.
 *
 * Winner rule (pickWinner, in code):
 *   eligible = assert gate passed AND ladder rung >= 3 AND critique has no critical defect
 *   then rank eligible candidates by, in order:
 *     1. critique verdict pass
 *     2. critique overall median
 *     3. stable tournament winner
 *     4. tournament pair wins (both brackets)
 *     5. ladder rung
 *   a full tie keeps the incumbent: a challenger has to beat it, not match it.
 *
 *   bun EvalRound.ts --candidates a.png,b.png|'<glob>' --reference "<argument summary>" \
 *     --brief Brief.json --question "<tournament question>" --out <dir> [--incumbent last.png] [--json]
 * Exit 0 winner clears the bar (critique pass, rung >= 3) · 1 no candidate clears it · 2 no judge produced a result.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash, randomInt } from 'node:crypto';
import { invariant } from '../../../LIFEOS/TOOLS/Invariant.ts';
import { getClaudeDir } from '../../../LIFEOS/TOOLS/Paths.ts';
import { parseBrief } from '../../ArtDirection/Tools/Critique.ts';
import { LADDER_REFERENCE_MIN_WORDS } from '../../Assay/Tools/VisionJudge.ts';
import { mean, pairedDiff } from '../../Assay/Tools/Stats.ts';

// ── tool paths ───────────────────────────────────────────────────────────────
const SKILLS = resolve(import.meta.dir, '..', '..');
export const TOOLS = {
  asserts: join(SKILLS, 'Assay', 'Tools', 'ImageAsserts.ts'),
  vision: join(SKILLS, 'Assay', 'Tools', 'VisionJudge.ts'),
  tournament: join(SKILLS, 'Assay', 'Tools', 'Tournament.ts'),
  critique: join(SKILLS, 'ArtDirection', 'Tools', 'Critique.ts'),
  deliver: join(SKILLS, 'ArtDirection', 'Tools', 'Deliver.ts'),
};

// ── stage result types ───────────────────────────────────────────────────────
export type Rung = 1 | 2 | 3 | 4;
interface StageBase { ms: number; error?: string }
export interface Skipped { status: 'skipped'; reason: string; ms: 0 }
export interface AssertStage extends StageBase { status: 'pass' | 'fail' | 'UNKNOWN'; lines: string[] }
export interface LadderStage extends StageBase { status: 'ok' | 'UNKNOWN'; rung: Rung | null; description: string | null; reason: string }
export interface CritiqueDefect { severity: 'critical' | 'major' | 'minor'; what: string; count: number }
export interface CritiqueStage extends StageBase {
  status: 'ok' | 'UNKNOWN';
  verdict: 'pass' | 'fail' | 'unavailable' | null;
  median: number | null;
  perVendorMedian: { google: number | null; openai: number | null };
  topDefects: CritiqueDefect[];
  /** the Critique.json Deliver.ts pairs with the artifact (--critique <report>) */
  report: string | null;
}
export interface TournamentStage extends StageBase {
  status: 'ok' | 'UNKNOWN' | 'skipped';
  winner: string | null;
  stable: boolean;
  summary: string;
  /** pair wins per candidate across the seeded bracket and the shuffled rerun */
  wins: Record<string, number>;
  /** every judged pair, both brackets, so a round record can be audited later */
  pairs?: { bracket: 'seeded' | 'rerun'; a: string; b: string; result: string; position_bias: boolean }[];
}
export interface CandidateRow {
  /** Original candidate supplied to the round, retained for audit. */
  originalFile: string;
  /** File the stages actually saw (the original unless alpha was flattened). */
  judgedFile: string;
  file: string;
  name: string;
  incumbent: boolean;
  assert: AssertStage;
  ladder: LadderStage | Skipped;
  critique: CritiqueStage | Skipped;
  tournament: { wins: number; stableWinner: boolean };
}

export interface StageOptions { allowIdentity: boolean; minWidth: number; wordRatio: number; generator: string; critiqueRepeats: number }
/** The four stage calls. Defaults spawn the real CLIs; tests inject fakes. Each must honor the abort signal. */
export interface StageDeps {
  assert(file: string, opts: StageOptions, signal: AbortSignal): Promise<AssertStage>;
  ladder(file: string, reference: string, opts: StageOptions, signal: AbortSignal): Promise<LadderStage>;
  critique(file: string, briefPath: string, outDir: string, opts: StageOptions, signal: AbortSignal): Promise<CritiqueStage>;
  tournament(files: string[], question: string, opts: StageOptions, signal: AbortSignal): Promise<TournamentStage>;
}

// ── subprocess runner with a real kill ───────────────────────────────────────
export interface ProcResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; ms: number }
/**
 * Run one CLI in its own process group. On abort the whole group gets SIGKILL
 * and the promise resolves at once, without waiting on pipes a grandchild may hold.
 */
export function runProcess(cmd: string[], signal: AbortSignal): Promise<ProcResult> {
  const started = Date.now();
  return new Promise((accept) => {
    if (signal.aborted) { accept({ code: null, stdout: '', stderr: 'aborted before start', timedOut: true, ms: 0 }); return; }
    const child = spawn(cmd[0]!, cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: process.env });
    let stdout = '', stderr = '', settled = false;
    child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    const settle = (r: Omit<ProcResult, 'ms'>) => { if (settled) return; settled = true; signal.removeEventListener('abort', onAbort); accept({ ...r, ms: Date.now() - started }); };
    const onAbort = () => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
      child.stdout!.destroy(); child.stderr!.destroy(); child.unref();
      settle({ code: null, stdout, stderr, timedOut: true });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => settle({ code: null, stdout, stderr: `${stderr}${e.message}`, timedOut: false }));
    child.on('close', (code) => settle({ code, stdout, stderr, timedOut: false }));
  });
}

const tail = (s: string, n = 240) => s.trim().split('\n').slice(-3).join(' | ').slice(-n);
function procError(label: string, r: ProcResult): string {
  return r.timedOut ? `${label} timed out after ${Math.round(r.ms / 1000)}s` : `${label} exit ${r.code}: ${tail(r.stderr || r.stdout) || 'no output'}`;
}

// ── parsers (pure, exported for tests) ───────────────────────────────────────
/** ImageAsserts `check` prints one ✅/❌ line per check; an ERROR reason means a verifier was unavailable. */
export function parseAssertOutput(code: number | null, stdout: string): Pick<AssertStage, 'status' | 'lines'> {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => /ERROR:/.test(l)) || code === null || lines.length === 0) return { status: 'UNKNOWN', lines };
  return { status: code === 0 ? 'pass' : 'fail', lines };
}

/** First balanced top-level JSON object in a CLI's stdout (the CLIs print one; a stray log line before it is skipped). */
export function firstJson(text: string): Record<string, unknown> | null {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
      if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { const v = JSON.parse(text.slice(start, i + 1)); if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>; } catch { /* next start */ }
        break;
      }
    }
  }
  return null;
}

/** VisionJudge `ladder` JSON → rung. The four-rung scale normalizes as (rung-1)/3; an unavailable or UNKNOWN verdict has no rung. */
export function parseLadderOutput(stdout: string): Omit<LadderStage, 'ms'> {
  const j = firstJson(stdout);
  if (!j || typeof j.score !== 'number' || typeof j.reason !== 'string') return { status: 'UNKNOWN', rung: null, description: null, reason: 'ladder printed no parseable result', error: 'unparseable ladder output' };
  const description = typeof j.description === 'string' ? j.description : null;
  if (j.unavailable === true || /^unknown:/i.test(j.reason.trim())) return { status: 'UNKNOWN', rung: null, description, reason: j.reason, error: 'ladder judge unavailable or UNKNOWN' };
  const rung = Math.round(Math.max(0, Math.min(1, j.score)) * 3) + 1;
  invariant(rung >= 1 && rung <= 4, 'ladder rung is on the four-rung scale');
  return { status: 'ok', rung: rung as Rung, description, reason: j.reason };
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
/** A Critique.json report → the fields a round needs. Shape is checked; anything off is UNKNOWN, never a zero. */
export function parseCritiqueReport(x: unknown, reportPath: string): Omit<CritiqueStage, 'ms'> {
  const r = x as Record<string, unknown> | null;
  const verdict = r?.verdict;
  if (!r || typeof r !== 'object' || (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'unavailable') || !Array.isArray(r.defects) || typeof r.perVendorMedian !== 'object' || r.perVendorMedian === null) {
    return { status: 'UNKNOWN', verdict: null, median: null, perVendorMedian: { google: null, openai: null }, topDefects: [], report: null, error: 'Critique.json has an unexpected shape' };
  }
  const pv = r.perVendorMedian as Record<string, unknown>;
  const topDefects = (r.defects as Record<string, unknown>[])
    .filter((d) => d && typeof d.what === 'string' && ['critical', 'major', 'minor'].includes(String(d.severity)))
    .map((d) => ({ severity: d.severity as CritiqueDefect['severity'], what: String(d.what), count: num(d.count) ?? 1 }));
  return { status: 'ok', verdict, median: num(r.median), perVendorMedian: { google: num(pv.google), openai: num(pv.openai) }, topDefects, report: reportPath };
}

/** Tournament `--json` → winner, stability, and pair wins per candidate across both brackets. */
export function parseTournamentOutput(code: number | null, stdout: string, files: string[]): Omit<TournamentStage, 'ms'> {
  const j = firstJson(stdout);
  const wins: Record<string, number> = Object.fromEntries(files.map((f) => [f, 0]));
  if (!j || !Array.isArray(j.log) || code === 2) {
    return { status: 'UNKNOWN', winner: null, stable: false, summary: typeof j?.summary === 'string' ? j.summary : 'tournament printed no parseable result', wins, error: code === 2 ? 'tournament verifier unavailable' : 'unparseable tournament output' };
  }
  type RawPair = { a?: unknown; b?: unknown; result?: unknown; position_bias?: unknown };
  const rerunLog = (j.rerun as { log?: unknown } | null)?.log;
  const tagged = [
    ...(j.log as RawPair[]).map((p) => ({ bracket: 'seeded' as const, p })),
    ...(Array.isArray(rerunLog) ? (rerunLog as RawPair[]).map((p) => ({ bracket: 'rerun' as const, p })) : []),
  ];
  const pairs: NonNullable<TournamentStage['pairs']> = [];
  for (const { bracket, p } of tagged) {
    if (!p || typeof p.a !== 'string' || typeof p.b !== 'string' || typeof p.result !== 'string') continue;
    pairs.push({ bracket, a: p.a, b: p.b, result: p.result, position_bias: p.position_bias === true });
    const w = p.result === 'A' ? p.a : p.result === 'B' ? p.b : undefined;
    if (w !== undefined && w in wins) wins[w]!++;
  }
  const winner = typeof j.winner === 'string' ? j.winner : null;
  return { status: 'ok', winner, stable: j.stable === true && winner !== null, summary: typeof j.summary === 'string' ? j.summary : '', wins, pairs };
}

// ── real stages (each is one CLI subprocess) ─────────────────────────────────
const bun = process.execPath;
const identity = (o: StageOptions) => (o.allowIdentity ? ['--allow-identity'] : []);

/**
 * The ground transparent candidates are flattened onto: the destination page colour, ArtConfig.json
 * "thumbnailGround" in <configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/ (LIFEOS_ART_USER_DIR
 * overrides the directory), the same key Generate.ts uses for listing thumbnails. File absent: the
 * shipped neutral ground. File present without the key: the shipped ground and a warning naming both.
 */
const SHIPPED_JUDGE_GROUND = "#F5F5F0";
export function judgeGround(): string {
  const dir = process.env.LIFEOS_ART_USER_DIR
    || resolve(getClaudeDir(), "LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art");
  const file = join(dir, "ArtConfig.json");
  if (!existsSync(file)) return SHIPPED_JUDGE_GROUND;
  let cfg: unknown;
  try { cfg = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new Error(`${file} is not valid JSON: ${(e as Error).message}`); }
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) throw new Error(`${file} must hold a JSON object of Art settings, got ${cfg === null ? "null" : Array.isArray(cfg) ? "an array" : typeof cfg}`);
  const g = (cfg as { thumbnailGround?: unknown }).thumbnailGround;
  if (g === undefined) { console.warn(`[EvalRound] ${file} has no "thumbnailGround" key; flattening onto ${SHIPPED_JUDGE_GROUND}.`); return SHIPPED_JUDGE_GROUND; }
  if (typeof g !== "string" || !/^#[0-9a-fA-F]{6}$/.test(g)) throw new Error(`${file}: "thumbnailGround" must be #RRGGBB, got ${String(g)}`);
  return g;
}

export interface NormalizedCandidate { originalFile: string; judgedFile: string; flattened: boolean }

/** Flatten only real transparency before a stage can see a candidate. */
export function normalizeCandidates(files: string[], out: string): NormalizedCandidate[] {
  const names = candidateNames(files);
  const ground = judgeGround();
  return files.map((file, i) => {
    const opaque = spawnSync('magick', [file, '-format', '%[opaque]', 'info:'], { encoding: 'utf8' });
    if (opaque.status !== 0) throw new Error(`magick could not inspect alpha for ${file}: ${(opaque.stderr || opaque.stdout).trim()}`);
    if (opaque.stdout.trim().toLowerCase() === 'true') return { originalFile: file, judgedFile: file, flattened: false };
    const target = join(resolve(out), 'judged', `${names[i]}${extname(file) || '.png'}`);
    mkdirSync(dirname(target), { recursive: true });
    const flatten = spawnSync('magick', [file, '-background', ground, '-alpha', 'remove', '-alpha', 'off', target], { encoding: 'utf8' });
    if (flatten.status !== 0) throw new Error(`magick could not flatten ${file}: ${(flatten.stderr || flatten.stdout).trim()}`);
    return { originalFile: file, judgedFile: target, flattened: true };
  });
}

/** Critique de-duplicates paths, so distinct copies make each repeat a real panel sample. */
export function createCritiqueRepeatFiles(file: string, out: string, repeats: number): string[] {
  invariant(Number.isInteger(repeats) && repeats >= 1, 'critique repeats must be a positive integer');
  if (repeats === 1) return [];
  const dir = join(out, 'repeat-samples');
  mkdirSync(dir, { recursive: true });
  const extension = extname(file) || '.png';
  return Array.from({ length: repeats - 1 }, (_, i) => {
    const target = join(dir, `sample-${String(i + 2).padStart(2, '0')}${extension}`);
    copyFileSync(file, target);
    return target;
  });
}

export const realStages: StageDeps = {
  async assert(file, o, signal) {
    const r = await runProcess([bun, TOOLS.asserts, 'check', file, '--min-width', String(o.minWidth), '--word-ratio', String(o.wordRatio)], signal);
    const parsed = parseAssertOutput(r.timedOut ? null : r.code, r.stdout);
    return { ...parsed, ms: r.ms, ...(parsed.status === 'UNKNOWN' ? { error: procError('asserts', r) } : {}) };
  },
  async ladder(file, reference, o, signal) {
    const r = await runProcess([bun, TOOLS.vision, 'ladder', '--image', file, '--reference', reference, ...identity(o)], signal);
    if (r.timedOut) return { status: 'UNKNOWN', rung: null, description: null, reason: '', ms: r.ms, error: procError('ladder', r) };
    return { ...parseLadderOutput(r.stdout), ms: r.ms };
  },
  async critique(file, briefPath, outDir, o, signal) {
    const report = join(outDir, 'Critique.json');
    const before = existsSync(report) ? statSync(report).mtimeMs : 0;
    const repeats = createCritiqueRepeatFiles(file, outDir, o.critiqueRepeats);
    const images = repeats.length ? ['--images', join(outDir, 'repeat-samples', `*${extname(file) || '.png'}`)] : [];
    const r = await runProcess([bun, TOOLS.critique, '--image', file, ...images, '--brief', briefPath, '--out', outDir, ...identity(o)], signal);
    const fresh = existsSync(report) && statSync(report).mtimeMs > before;
    if (r.timedOut || !fresh) return { status: 'UNKNOWN', verdict: null, median: null, perVendorMedian: { google: null, openai: null }, topDefects: [], report: null, ms: r.ms, error: fresh ? procError('critique', r) : `${procError('critique', r)}; no fresh Critique.json` };
    return { ...parseCritiqueReport(JSON.parse(readFileSync(report, 'utf8')), report), ms: r.ms };
  },
  async tournament(files, question, o, signal) {
    const r = await runProcess([bun, TOOLS.tournament, '--candidates', files.join(','), '--question', question, '--generator', o.generator, '--json', ...identity(o)], signal);
    if (r.timedOut) return { status: 'UNKNOWN', winner: null, stable: false, summary: '', wins: Object.fromEntries(files.map((f) => [f, 0])), ms: r.ms, error: procError('tournament', r) };
    return { ...parseTournamentOutput(r.code, r.stdout, files), ms: r.ms };
  },
};

// ── orchestration ────────────────────────────────────────────────────────────
/** Run fn under a deadline. On timeout the signal aborts (the real stages kill their process group) and the fallback stands in. */
export async function guarded<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>, fallback: (error: string, elapsed: number) => T): Promise<T> {
  const controller = new AbortController();
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((accept) => {
    timer = setTimeout(() => { controller.abort(); accept(fallback(`timed out after ${Math.round(ms / 1000)}s`, Date.now() - started)); }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal).catch((e: unknown) => fallback(e instanceof Error ? e.message : String(e), Date.now() - started)), deadline]);
  } finally { clearTimeout(timer); }
}

/** A counting semaphore, so a large round does not open every connection at once. */
export function limiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  invariant(Number.isInteger(max) && max >= 1, 'concurrency must be a positive integer');
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>) => {
    if (active >= max) await new Promise<void>((go) => queue.push(go));
    active++;
    try { return await fn(); } finally { active--; queue.shift()?.(); }
  };
}

/** Unique, filesystem-safe names so each candidate's Critique.json gets its own directory. Uniqueness is checked against
 * every name already handed out, case-folded for case-insensitive volumes, so stems a, a, a-2 never share a path. */
export function candidateNames(files: string[]): string[] {
  const used = new Set<string>();
  return files.map((f) => {
    const stem = basename(f, extname(f)).replace(/[^A-Za-z0-9._-]/g, '_') || 'candidate';
    let name = stem;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem}-${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

export const WINNER_RULE = 'eligible = assert pass AND ladder rung >= 3 AND no critical critique defect; rank by critique pass, then critique median, then stable tournament winner, then tournament pair wins, then rung; a full tie keeps the incumbent';
const KEY_NAMES = ['eligibility', 'critique pass', 'critique median', 'stable tournament winner', 'tournament pair wins', 'ladder rung'] as const;

export function rankKey(row: CandidateRow): number[] {
  const rung = row.ladder.status === 'ok' ? row.ladder.rung ?? 0 : 0;
  const crit = row.critique.status === 'ok' ? row.critique : null;
  const critical = crit?.topDefects.some((d) => d.severity === 'critical') ?? false;
  return [
    row.assert.status === 'pass' && rung >= 3 && !critical ? 1 : 0,
    crit?.verdict === 'pass' ? 1 : 0,
    crit?.median ?? -1,
    row.tournament.stableWinner ? 1 : 0,
    row.tournament.wins,
    rung,
  ];
}
const compareKeys = (a: number[], b: number[]) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i]! - a[i]!; return 0; };

export interface WinnerPick { winner: CandidateRow | null; carryForward: CandidateRow | null; why: string; clearsBar: boolean }
/** The winner rule. Pure. `carryForward` is the best candidate even when none is eligible: next round's --incumbent. */
export function pickWinner(rows: CandidateRow[]): WinnerPick {
  const ranked = rows
    .map((row, i) => ({ row, i, key: rankKey(row) }))
    .sort((x, y) => compareKeys(x.key, y.key) || Number(y.row.incumbent) - Number(x.row.incumbent) || x.i - y.i);
  const top = ranked[0];
  if (!top) return { winner: null, carryForward: null, why: 'no candidates', clearsBar: false };
  if (top.key[0] !== 1) {
    // Nobody is eligible: carry forward the one closest to it, an assert pass with the highest known rung, then the same order.
    const closest = rows
      .map((row, i) => ({ row, i, key: [row.assert.status === 'pass' ? 1 : 0, row.ladder.status === 'ok' ? row.ladder.rung ?? 0 : 0, ...rankKey(row).slice(1)] }))
      .sort((x, y) => compareKeys(x.key, y.key) || Number(y.row.incumbent) - Number(x.row.incumbent) || x.i - y.i)[0]!;
    return { winner: null, carryForward: closest.row, clearsBar: false, why: `no candidate reached ladder rung 3 with a passing assert gate and no critical critique defect; closest is ${closest.row.name} (carry it forward as --incumbent and change the brief)` };
  }
  const next = ranked[1];
  let why: string;
  if (!next || next.key[0] !== 1) why = `${top.row.name} is the only candidate at rung >= 3`;
  else {
    const d = top.key.findIndex((v, i) => v !== next.key[i]);
    why = d >= 0
      ? `${top.row.name} beats ${next.row.name} on ${KEY_NAMES[d]} (${top.key[d]} vs ${next.key[d]})`
      : top.row.incumbent
        ? `${top.row.name} ties ${next.row.name} on every criterion and is the incumbent, so it holds`
        : `${top.row.name} ties ${next.row.name} on every criterion and was listed first`;
  }
  const crit = top.row.critique.status === 'ok' ? top.row.critique : null;
  const clearsBar = crit?.verdict === 'pass';
  const rung = top.row.ladder.status === 'ok' ? top.row.ladder.rung : null;
  return { winner: top.row, carryForward: top.row, clearsBar, why: `${why}. ${clearsBar ? `Clears the critique bar${rung === 4 ? ' at rung 4 (ship rung)' : ' at rung 3 (pass rung; rung 4 is the ship rung)'}` : 'Does not clear the critique bar yet: fix its named defects next round'}.` };
}

export interface RoundOptions {
  candidates: string[];
  reference: string;
  briefPath: string;
  question: string;
  out: string;
  incumbent?: string;
  generator?: string;
  allowIdentity?: boolean;
  minWidth?: number;
  wordRatio?: number;
  critiqueRepeats?: number;
  assertTimeoutMs?: number;
  judgeTimeoutMs?: number;
  concurrency?: number;
}
export interface RoundResult {
  elapsedSec: number;
  rule: string;
  rows: CandidateRow[];
  tournament: TournamentStage;
  winner: string | null;
  carryForward: string | null;
  why: string;
  clearsBar: boolean;
  deliver: string | null;
  exit: 0 | 1 | 2;
  record?: string;
}

const skipped = (reason: string): Skipped => ({ status: 'skipped', reason, ms: 0 });

export async function runRound(o: RoundOptions, deps: StageDeps = realStages): Promise<RoundResult> {
  const started = Date.now();
  const words = o.reference.trim().split(/\s+/).filter(Boolean).length;
  if (words < LADDER_REFERENCE_MIN_WORDS) throw new Error(`--reference must be the 2–4 sentence argument summary (>= ${LADDER_REFERENCE_MIN_WORDS} words), never the title: got ${words}`);
  parseBrief(JSON.parse(readFileSync(o.briefPath, 'utf8')));
  if (!o.question.trim()) throw new Error('--question is required');
  const incumbent = o.incumbent ? resolve(o.incumbent) : undefined;
  // The incumbent is seeded first: the bracket keeps the earlier seed on a tie, and so does pickWinner.
  const files = [...new Set([...(incumbent ? [incumbent] : []), ...o.candidates.map((c) => resolve(c))])];
  if (files.length === 0) throw new Error('no candidates');
  for (const f of files) if (!existsSync(f) || !statSync(f).isFile()) throw new Error(`candidate is not a file: ${f}`);
  const names = candidateNames(files);
  const stageOpts: StageOptions = { allowIdentity: o.allowIdentity ?? false, minWidth: o.minWidth ?? 1200, wordRatio: o.wordRatio ?? 0.6, generator: o.generator ?? 'nano-banana-pro', critiqueRepeats: o.critiqueRepeats ?? 3 };
  invariant(Number.isInteger(stageOpts.critiqueRepeats) && stageOpts.critiqueRepeats >= 1, 'critique repeats must be a positive integer');
  const assertMs = o.assertTimeoutMs ?? 30_000, judgeMs = o.judgeTimeoutMs ?? 105_000;
  const limit = limiter(o.concurrency ?? 16);
  const out = resolve(o.out);
  const normalized = normalizeCandidates(files, out);
  const judgedFiles = normalized.map((candidate) => candidate.judgedFile);

  const asserts = await Promise.all(judgedFiles.map((f) => limit(() => guarded<AssertStage>(assertMs, (s) => deps.assert(f, stageOpts, s), (error, ms) => ({ status: 'UNKNOWN', lines: [], ms, error })))));
  const survivors = judgedFiles.filter((_, i) => asserts[i]!.status === 'pass');

  const unknownLadder = (error: string, ms: number): LadderStage => ({ status: 'UNKNOWN', rung: null, description: null, reason: '', ms, error });
  const unknownCritique = (error: string, ms: number): CritiqueStage => ({ status: 'UNKNOWN', verdict: null, median: null, perVendorMedian: { google: null, openai: null }, topDefects: [], report: null, ms, error });
  const zeroWins = () => Object.fromEntries(survivors.map((f) => [f, 0]));
  const tournamentRun: Promise<TournamentStage> = survivors.length < 2
    ? Promise.resolve({ status: 'skipped', winner: survivors[0] ?? null, stable: false, summary: survivors.length ? 'one survivor: no comparison to run' : 'no survivors', wins: zeroWins(), ms: 0 })
    : limit(() => guarded<TournamentStage>(judgeMs, (s) => deps.tournament(survivors, o.question, stageOpts, s), (error, ms) => ({ status: 'UNKNOWN', winner: null, stable: false, summary: '', wins: zeroWins(), ms, error })));
  const ladderRuns = judgedFiles.map((f, i) => asserts[i]!.status === 'pass'
    ? limit(() => guarded<LadderStage>(judgeMs, (s) => deps.ladder(f, o.reference, stageOpts, s), unknownLadder))
    : Promise.resolve(skipped('assert gate did not pass')));
  const critiqueRuns = judgedFiles.map((f, i) => asserts[i]!.status === 'pass'
    ? limit(() => guarded<CritiqueStage>(judgeMs, (s) => deps.critique(f, o.briefPath, join(out, 'critique', names[i]!), stageOpts, s), unknownCritique))
    : Promise.resolve(skipped('assert gate did not pass')));
  const [tournament, ladders, critiques] = await Promise.all([tournamentRun, Promise.all(ladderRuns), Promise.all(critiqueRuns)]);

  const rows: CandidateRow[] = judgedFiles.map((file, i) => ({
    originalFile: normalized[i]!.originalFile, judgedFile: file, file, name: names[i]!, incumbent: normalized[i]!.originalFile === incumbent,
    assert: asserts[i]!, ladder: ladders[i]!, critique: critiques[i]!,
    tournament: { wins: tournament.wins[file] ?? 0, stableWinner: tournament.stable && tournament.winner === file },
  }));
  const pick = pickWinner(rows);
  const judged = rows.some((r) => r.ladder.status === 'ok' || r.critique.status === 'ok') || tournament.status === 'ok';
  const exit: 0 | 1 | 2 = pick.clearsBar ? 0 : survivors.length > 0 && !judged ? 2 : 1;
  const winnerCritique = pick.winner?.critique.status === 'ok' ? pick.winner.critique : null;
  return {
    elapsedSec: Math.round((Date.now() - started) / 100) / 10,
    rule: WINNER_RULE, rows, tournament,
    winner: pick.winner?.file ?? null, carryForward: pick.carryForward?.file ?? null, why: pick.why, clearsBar: pick.clearsBar,
    deliver: pick.clearsBar && winnerCritique?.report ? `bun ${TOOLS.deliver} --artifact ${pick.winner!.file} --critique ${winnerCritique.report} --to <destination>` : null,
    exit,
  };
}

/** Persist the round next to its critiques: EvalRound.json (latest) plus a timestamped copy. */
export function writeRecord(out: string, result: RoundResult): string {
  invariant(result.rows.length > 0, 'a round record needs at least one candidate');
  invariant(result.winner === null || result.rows.some((r) => r.file === result.winner), 'the winner is one of the round candidates');
  invariant(result.carryForward === null || result.rows.some((r) => r.file === result.carryForward), 'carry-forward is one of the round candidates');
  const dir = resolve(out);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `EvalRound-${stamp}.json`);
  const text = JSON.stringify({ ...result, record: path }, null, 2) + '\n';
  writeFileSync(path, text, { flag: 'wx' });
  writeFileSync(join(dir, 'EvalRound.json'), text);
  return path;
}

// ── table ────────────────────────────────────────────────────────────────────
const cell = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s.padEnd(w));
export function renderTable(r: RoundResult): string {
  const lines: string[] = [];
  const head = `${cell('candidate', 34)} ${cell('assert', 7)} ${cell('rung', 5)} ${cell('critique (G/O)', 22)} ${cell('tourn', 9)}`;
  lines.push(head, '-'.repeat(head.length));
  for (const row of r.rows) {
    const rung = row.ladder.status === 'ok' ? String(row.ladder.rung) : row.ladder.status === 'skipped' ? '-' : '?';
    const c = row.critique;
    const crit = c.status === 'ok' ? `${c.verdict} ${c.median ?? '?'} (${c.perVendorMedian.google ?? '?'}/${c.perVendorMedian.openai ?? '?'})` : c.status === 'skipped' ? '-' : 'UNKNOWN';
    const tourn = r.tournament.status === 'ok' ? `${row.tournament.wins}w${row.tournament.stableWinner ? ' WIN' : ''}` : r.tournament.status === 'skipped' ? '-' : '?';
    lines.push(`${cell(`${row.incumbent ? '* ' : ''}${row.name}`, 34)} ${cell(row.assert.status, 7)} ${cell(rung, 5)} ${cell(crit, 22)} ${cell(tourn, 9)}`);
  }
  lines.push('');
  for (const row of r.rows) {
    const bits: string[] = [];
    if (row.originalFile !== row.judgedFile) bits.push(`original: ${row.originalFile}; judged (alpha flattened on the page ground): ${row.judgedFile}`);
    if (row.assert.status !== 'pass') bits.push(`assert ${row.assert.status}: ${row.assert.error ?? row.assert.lines.filter((l) => l.startsWith('❌')).join('; ')}`);
    if (row.ladder.status === 'ok' && row.ladder.description) bits.push(`sees: "${row.ladder.description.replace(/\s+/g, ' ').slice(0, 180)}${row.ladder.description.length > 180 ? '…' : ''}"`);
    if (row.ladder.status === 'UNKNOWN') bits.push(`ladder UNKNOWN: ${row.ladder.error}`);
    if (row.critique.status === 'ok') for (const d of row.critique.topDefects.slice(0, 2)) bits.push(`${d.severity} (${d.count}): ${d.what}`);
    if (row.critique.status === 'UNKNOWN') bits.push(`critique UNKNOWN: ${row.critique.error}`);
    if (bits.length) lines.push(`${row.name}`, ...bits.map((b) => `  ${b}`));
  }
  lines.push('', `tournament: ${r.tournament.status === 'ok' ? r.tournament.summary : r.tournament.status === 'skipped' ? r.tournament.summary : `UNKNOWN (${r.tournament.error})`}`);
  lines.push(`rule: ${r.rule}`);
  lines.push(`WINNER: ${r.winner ?? 'none'} — ${r.why}`);
  if (!r.winner && r.carryForward) lines.push(`carry forward: ${r.carryForward}`);
  if (r.deliver) lines.push(`deliver: ${r.deliver}`);
  lines.push(`elapsed: ${r.elapsedSec}s`);
  if (r.record) lines.push(`record: ${r.record}`);
  return lines.join('\n');
}

// ── video round (--video) ────────────────────────────────────────────────────
// One command scores a whole round of HyperFrames films: code gates first on every film at once, then k Critique
// readings per surviving film and the incumbent with ONE shared sample seed, then the paired keep rule
// (mean per-sample difference vs the incumbent, 95% CI from Assay/Tools/Stats.ts, keep when the lower bound > 0).
// Contract: Tools/EvalRound.help.md § Film rounds (--video).

export const VIDEO_TOOLS = {
  filmStats: join(SKILLS, 'HyperFrames', 'Tools', 'FilmStats.ts'),
  textFit: join(SKILLS, 'HyperFrames', 'Tools', 'TextFit.ts'),
  hyperframes: resolve(SKILLS, '..', 'LIFEOS', 'TOOLS', 'HyperFrames', 'HyperFrames.ts'),
  proof: join(SKILLS, 'Assay', 'Tools', 'Proof.ts'),
  critique: TOOLS.critique,
};

/** The film gates an earlier hand-rolled per-film score.ts applied, now in one place. */
export const FILM_GATES = { width: 1920, height: 1080, fps: 30, durationToleranceS: 0.5, minBeatsPer10s: 3.0, minMotion: 0.015 } as const;
/** HillClimb's pairing rule: paired samples must sit at the same time in both films. */
export const PAIR_T_TOLERANCE_S = 0.05;
export const VIDEO_KEEP_RULE = 'gates first (ffprobe, FilmStats, TextFit, seam check, beat grid, Proof when proof.json exists, TextFit layout every 0.5 s, then two-vendor layout QA on the hit frames of films whose code gates passed); survivors and the incumbent get k Critique readings with one shared sample seed; each sample is averaged over the k readings per vendor, paired with the incumbent by sample index and vendor, and a candidate is kept only when the 95% CI lower bound of the mean paired difference is above zero';

export type GateStatus = 'pass' | 'fail' | 'error' | 'skipped';
export interface Gate { status: GateStatus; evidence: string; ms: number }
export const GATE_NAMES = ['probe', 'filmStats', 'textFit', 'seam', 'beatGrid', 'proof', 'layout', 'layoutQa'] as const;
export type GateName = (typeof GATE_NAMES)[number];
export type Gates = Record<GateName, Gate>;

// ── layout gates L and Q ─────────────────────────────────────────────────────
// Contract (2026-10-10): the layout gates. L is TextFit over the whole film every 0.5 s;
// Q is Critique --layout-qa, two vendors asked plain layout questions on each hit frame (both say yes = exit 1).

/** Gate L samples the whole film at this step, so text that collides between hits is still measured. */
export const LAYOUT_EVERY_S = 0.5;
/** TextFit kinds gate L fails on. covered, truncated and optout stay gate T's, on the hit times. */
export const LAYOUT_KINDS: readonly string[] = ['occluded', 'canvas-text', 'connector', 'align', 'clipped', 'frame'];

/** TextFit argv for gate L. */
export function layoutArgs(dir: string): string[] {
  return [bun, VIDEO_TOOLS.textFit, '--project', dir, '--every', String(LAYOUT_EVERY_S), '--json'];
}
/**
 * Critique argv for gate Q; outDir sits in the round directory, never in the film directory. Layout QA asks plain
 * questions of each hit frame and reads no brief, and its strict parseArgs refuses --brief, so none is passed
 * (the brief path stays in the signature because gate Q's caller hands it to every Critique-based gate).
 */
export function layoutQaArgs(master: string, _briefPath: string, hits: string, outDir: string): string[] {
  return [bun, VIDEO_TOOLS.critique, '--video', master, '--out', outDir, '--layout-qa', '--hits', hits];
}
/** Whether the installed Critique.ts accepts --layout-qa (strict parseArgs refuses an unknown flag). */
export function critiqueHasLayoutQa(source: string): boolean {
  return /['"]layout-qa['"]\s*:/.test(source);
}

interface LayoutFinding { time: number; text: string; selector: string; kinds: string[]; detail: string[] }
/**
 * Gate L verdict from TextFit --every 0.5 --json. Any finding of a LAYOUT_KINDS kind fails. An exit 0 or 1 without a
 * findings array, an exit 1 with no findings, or any other exit is an error: an unmeasured film is not a passed one.
 */
export function judgeLayout(r: ProcResult): Omit<Gate, 'ms'> {
  if (r.timedOut) return { status: 'error', evidence: procError('TextFit layout', r) };
  if (r.code !== 0 && r.code !== 1) return { status: 'error', evidence: `TextFit layout exit ${r.code}: ${tail(r.stderr || r.stdout, 400) || 'no output'}` };
  const j = firstJson(r.stdout);
  const raw = j && Array.isArray(j.findings) ? (j.findings as unknown[]) : null;
  if (!j || !raw) return { status: 'error', evidence: `TextFit layout exit ${r.code} printed no findings JSON: ${tail(r.stdout || r.stderr) || 'no output'}` };
  const findings: LayoutFinding[] = [];
  for (const f of raw) {
    const o = f as Record<string, unknown> | null;
    if (!o || typeof o.time !== 'number' || !Array.isArray(o.kinds) || !o.kinds.every((k) => typeof k === 'string')) {
      return { status: 'error', evidence: `TextFit layout finding has no time or kinds: ${JSON.stringify(f).slice(0, 200)}` };
    }
    findings.push({ time: o.time, text: String(o.text ?? ''), selector: String(o.selector ?? ''), kinds: o.kinds as string[], detail: Array.isArray(o.detail) ? o.detail.map(String) : [] });
  }
  if (r.code === 1 && findings.length === 0) return { status: 'error', evidence: 'TextFit layout exit 1 with no findings' };
  const span = `${Array.isArray(j.checked) ? j.checked.length : '?'} times checked every ${LAYOUT_EVERY_S} s`;
  const layout = findings.filter((f) => f.kinds.some((k) => LAYOUT_KINDS.includes(k)));
  const others = findings.length - layout.length;
  if (!layout.length) {
    const otherKinds = [...new Set(findings.flatMap((f) => f.kinds))].sort().join(', ');
    return { status: 'pass', evidence: `${span}, no layout finding${others ? `; ${others} finding(s) of other kinds (${otherKinds}; gate T owns them)` : ''}` };
  }
  const first = [...layout].sort((a, b) => a.time - b.time).slice(0, 5)
    .map((f) => `${f.time.toFixed(2)} s [${f.kinds.filter((k) => LAYOUT_KINDS.includes(k)).join(',')}] "${f.text.slice(0, 60)}" ${f.selector}${f.detail[0] ? ` — ${f.detail[0].slice(0, 140)}` : ''}`);
  return { status: 'fail', evidence: `TextFit ${layout.length} layout finding(s) over ${span}: ${first.join('; ')}${layout.length > 5 ? `; +${layout.length - 5} more` : ''}` };
}

// ── beat grid (pure) ─────────────────────────────────────────────────────────
const TIME_HEADER = /^(?:t|s|time|times|sec|secs|seconds|at)\b|\b(?:time|sec|secs|seconds)\b/i;
const NUMERIC_CELL = /^(\d+(?:\.\d+)?)\s*s?$/i;
/** Units a header or note line puts after a number. A "120 BPM" line is a tempo, never a hit time. */
const NOT_A_TIME = /^(?:bpm|fps|hits?|beats?|bars?|%|hz|khz|db|lufs|px|x\b|frames?)/i;

const splitRow = (line: string): string[] => {
  const cells = line.trim().split('|').map((c) => c.trim());
  if (cells[0] === '') cells.shift();
  if (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
};

/**
 * Hit times from a hits.md. A markdown table is read by its time column (the header cell naming time or seconds,
 * e.g. `s (sec)`), so a number in a heading or note line is never a hit. With no table, lines of the form
 * `<time>[s] <label>` are read, and a line whose number carries a unit such as BPM is skipped. Throws when a table
 * has no time column or a time cell is not a number: the grid gate reports that as an error, never a pass.
 */
export function parseHitTimes(md: string): number[] {
  const lines = md.split('\n');
  const tables: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.trim().startsWith('|')) continue;
    const block: string[] = [];
    while (i < lines.length && lines[i]!.trim().startsWith('|')) block.push(lines[i++]!);
    tables.push(block);
  }
  const isSeparator = (l: string) => splitRow(l).every((c) => /^:?-{2,}:?$/.test(c));
  const times: number[] = [];
  let timeTables = 0;
  for (const block of tables) {
    if (block.length < 2 || !isSeparator(block[1]!)) continue;
    const header = splitRow(block[0]!);
    const col = header.findIndex((h) => TIME_HEADER.test(h));
    if (col < 0) continue;
    timeTables++;
    for (const [n, row] of block.slice(2).entries()) {
      const cell = splitRow(row)[col] ?? '';
      const m = cell.match(NUMERIC_CELL);
      if (!m) throw new Error(`hits table row ${n + 1}: time cell "${cell}" under "${header[col]}" is not a number of seconds`);
      times.push(Number(m[1]));
    }
  }
  if (tables.length > 0) {
    if (timeTables === 0) throw new Error('hits.md has a table but no column header names the time (expected e.g. "s (sec)" or "time")');
    return times;
  }
  for (const line of lines) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*(?:[-*]\s+)?(\d+(?:\.\d+)?)(\s*s\b)?\s*[-–—:]?\s*(\S.*)$/);
    if (!m) continue;
    if (!m[2] && NOT_A_TIME.test(m[3]!)) continue;
    times.push(Number(m[1]));
  }
  return times;
}

export interface GridResult { pass: boolean; hits: number; stepS: number; toleranceS: number; offGrid: number[] }
/** Every hit within one frame of the grid: a beat (60/bpm) or an eighth note (30/bpm). No hits is a fail. */
export function checkBeatGrid(times: number[], bpm: number, grid: 'beat' | 'eighth', fps: number = FILM_GATES.fps): GridResult {
  invariant(Number.isFinite(bpm) && bpm > 0, 'bpm must be a positive number');
  const stepS = (grid === 'beat' ? 60 : 30) / bpm, toleranceS = 1 / fps + 1e-6;
  const offGrid = times.filter((t) => { const r = ((t % stepS) + stepS) % stepS; return Math.min(r, stepS - r) > toleranceS; });
  return { pass: times.length > 0 && offGrid.length === 0, hits: times.length, stepS, toleranceS, offGrid };
}

/** How a film's hits are checked: a music grid (beat, eighth), the voiceover's word starts (words), or not at all (none). */
export type GridMode = 'beat' | 'eighth' | 'words' | 'none';
export const GRID_MODES: readonly GridMode[] = ['beat', 'eighth', 'words', 'none'];
export const WORD_TOLERANCE_FRAMES = 2;

export interface VoWord { t: string; s: number }
/** A voiceover words file: an array of `{t, s}` (word text, start seconds); extra keys are ignored. Returned sorted by start. */
export function parseVoWords(x: unknown): VoWord[] {
  if (!Array.isArray(x)) throw new Error('vo words file must be a JSON array of {t, s}');
  if (x.length === 0) throw new Error('vo words file has no words');
  const words = x.map((w: unknown, i): VoWord => {
    const o = w as { t?: unknown; s?: unknown } | null;
    if (!o || typeof o !== 'object' || typeof o.t !== 'string' || typeof o.s !== 'number' || !Number.isFinite(o.s) || o.s < 0) {
      throw new Error(`vo words file word ${i + 1}: expected {t: string, s: seconds >= 0}, got ${JSON.stringify(w)}`);
    }
    return { t: o.t, s: o.s };
  });
  return words.sort((a, b) => a.s - b.s);
}

export interface WordMiss { row: number; t: number; word: string; wordS: number; errorFrames: number }
export interface WordGridResult { pass: boolean; hits: number; words: number; fps: number; toleranceFrames: number; maxErrorFrames: number; misses: WordMiss[] }
/**
 * Every hit within `toleranceFrames` frames of some word start. `row` is the hit's 1-based order in hits.md.
 * Misses are listed worst first. No hits is a fail.
 */
export function checkWordGrid(times: number[], words: VoWord[], fps: number = FILM_GATES.fps, toleranceFrames: number = WORD_TOLERANCE_FRAMES): WordGridResult {
  invariant(words.length > 0, 'word grid needs at least one word');
  invariant(words.every((w, i) => i === 0 || w.s >= words[i - 1]!.s), 'words are sorted by start (parseVoWords sorts them)');
  invariant(Number.isFinite(fps) && fps > 0, 'fps must be a positive number');
  invariant(Number.isFinite(toleranceFrames) && toleranceFrames >= 0, 'tolerance frames must be a non-negative number');
  const nearest = (t: number): VoWord => {
    let lo = 0, hi = words.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (words[mid]!.s < t) lo = mid + 1; else hi = mid; }
    const after = words[lo]!, before = words[Math.max(0, lo - 1)]!;
    return Math.abs(t - before.s) <= Math.abs(after.s - t) ? before : after;
  };
  const rows = times.map((t, i) => { const w = nearest(t); return { row: i + 1, t, word: w.t, wordS: w.s, errorFrames: Math.abs(t - w.s) * fps }; });
  const misses = rows.filter((r) => r.errorFrames > toleranceFrames + 1e-6).sort((a, b) => b.errorFrames - a.errorFrames);
  const maxErrorFrames = rows.reduce((m, r) => Math.max(m, r.errorFrames), 0);
  return { pass: times.length > 0 && misses.length === 0, hits: times.length, words: words.length, fps, toleranceFrames, maxErrorFrames, misses };
}

/** Gate B evidence for --grid words: the count, then the worst rows by name (up to 8). */
export function judgeWordGrid(g: WordGridResult): Omit<Gate, 'ms'> {
  if (g.hits === 0) return { status: 'fail', evidence: 'no hit times found' };
  const f = (x: number) => x.toFixed(1);
  if (g.pass) return { status: 'pass', evidence: `${g.hits} hits within ±${g.toleranceFrames} frames of a word start (${g.words} words, worst ${g.maxErrorFrames.toFixed(2)} frames)` };
  const worst = g.misses.slice(0, 8).map((m) => `row ${m.row} at ${m.t} s is ${f(m.errorFrames)} frames from "${m.word}" (${m.wordS} s)`).join('; ');
  return { status: 'fail', evidence: `${g.misses.length} of ${g.hits} hits off the words; worst: ${worst}${g.misses.length > 8 ? `; +${g.misses.length - 8} more` : ''} (tolerance ±${g.toleranceFrames} frames at ${g.fps} fps)` };
}

// ── gate judges (pure) ───────────────────────────────────────────────────────
export interface ProbeInfo { width: number; height: number; fps: number; durationS: number; audioStreams: number }
export function parseProbe(x: unknown): ProbeInfo {
  const j = x as { streams?: Record<string, unknown>[]; format?: { duration?: unknown } } | null;
  const streams = Array.isArray(j?.streams) ? j!.streams : null;
  if (!streams) throw new Error('ffprobe printed no streams');
  const v = streams.find((s) => s.codec_type === 'video');
  if (!v) throw new Error('no video stream');
  const [num, den] = String(v.r_frame_rate ?? '').split('/').map(Number);
  const fps = den ? num! / den : Number(num);
  const durationS = Number(j?.format?.duration);
  if (!Number.isFinite(fps) || !Number.isFinite(durationS)) throw new Error(`ffprobe gave fps ${v.r_frame_rate} and duration ${j?.format?.duration}`);
  return { width: Number(v.width), height: Number(v.height), fps, durationS, audioStreams: streams.filter((s) => s.codec_type === 'audio').length };
}

export function judgeProbe(p: ProbeInfo, expectDurationS: number, fps: number = FILM_GATES.fps): Omit<Gate, 'ms'> {
  const problems: string[] = [];
  if (p.width !== FILM_GATES.width || p.height !== FILM_GATES.height) problems.push(`${p.width}x${p.height} is not ${FILM_GATES.width}x${FILM_GATES.height}`);
  if (Math.abs(p.fps - fps) > 0.01) problems.push(`${p.fps.toFixed(3)} fps is not ${fps}`);
  if (Math.abs(p.durationS - expectDurationS) > FILM_GATES.durationToleranceS) problems.push(`${p.durationS.toFixed(2)} s is not ${expectDurationS.toFixed(2)} ±${FILM_GATES.durationToleranceS} s`);
  if (p.audioStreams !== 1) problems.push(`${p.audioStreams} audio streams, need exactly 1`);
  const facts = `${p.width}x${p.height} ${+p.fps.toFixed(3)}fps ${p.durationS.toFixed(2)}s audio=${p.audioStreams}`;
  return problems.length ? { status: 'fail', evidence: `${facts}: ${problems.join('; ')}` } : { status: 'pass', evidence: facts };
}

export function judgeFilmStats(stdout: string): Omit<Gate, 'ms'> {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? ''); } catch { return { status: 'error', evidence: `FilmStats printed no JSON: ${tail(stdout)}` }; }
  const s = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | undefined;
  const beats = num(s?.beatsPer10s), motion = num(s?.motion);
  if (beats === null || motion === null) return { status: 'error', evidence: 'FilmStats JSON has no beatsPer10s or motion' };
  const facts = `beatsPer10s=${beats} motion=${motion} luma=${s?.lumaMin}-${s?.lumaMax} lufs=${s?.lufs}`;
  const pass = beats >= FILM_GATES.minBeatsPer10s && motion >= FILM_GATES.minMotion;
  return { status: pass ? 'pass' : 'fail', evidence: pass ? facts : `${facts} (need beatsPer10s >= ${FILM_GATES.minBeatsPer10s}, motion >= ${FILM_GATES.minMotion})` };
}

/** A gate CLI whose exit code is the verdict: 0 pass, 1 a finding; anything else (usage, unmeasurable, unavailable) is an error. */
export function judgeExit(label: string, r: ProcResult): Omit<Gate, 'ms'> {
  if (r.timedOut) return { status: 'error', evidence: procError(label, r) };
  const out = tail(r.stdout || r.stderr, 400);
  if (r.code === 0) return { status: 'pass', evidence: `${label} exit 0` };
  if (r.code === 1) return { status: 'fail', evidence: `${label} exit 1: ${out || 'no output'}` };
  return { status: 'error', evidence: `${label} exit ${r.code}: ${out || 'no output'}` };
}

/** Proof run --json: exit 0 pass, 1 code-tier failure, 2 unavailable (an error here: an unchecked film is not a passed one). */
export function judgeProof(r: ProcResult): Omit<Gate, 'ms'> {
  const base = judgeExit('proof', r);
  const j = firstJson(r.stdout);
  const receipt = (j?.receipt ?? j) as { verdict?: unknown; counts?: unknown; findings?: { check?: string; severity?: string; message?: string }[] } | null;
  if (!receipt || receipt.verdict === undefined) return base;
  const fails = (receipt.findings ?? []).filter((f) => f.severity === 'fail').slice(0, 3).map((f) => `${f.check}: ${String(f.message).slice(0, 120)}`);
  return { status: base.status, evidence: `proof ${receipt.verdict} ${JSON.stringify(receipt.counts ?? {})}${fails.length ? ` · ${fails.join(' · ')}` : ''}` };
}

// ── critique readings and the paired verdict (pure) ─────────────────────────
export interface ReadingSample { id: string; t: number | null; scores: Record<string, number | null> }
export interface Reading { path: string; sampleSeed: number | null; sampleSpan: number | null; median: number | null; verdict: string | null; perVendorMedian: Record<string, number | null>; samples: ReadingSample[] }

/** One Critique.json → the numbers pairing needs. Unknown vendor scores stay null; a bad shape throws. */
export function parseReading(x: unknown, path: string): Reading {
  const r = x as Record<string, unknown> | null;
  if (!r || !Array.isArray(r.samples) || typeof r.perVendorMedian !== 'object' || r.perVendorMedian === null) throw new Error(`${path}: Critique.json has no samples or perVendorMedian`);
  const samples = (r.samples as Record<string, unknown>[]).map((s, i) => {
    if (!s || typeof s.id !== 'string' || typeof s.scores !== 'object' || s.scores === null) throw new Error(`${path}: sample ${i} has no id or scores`);
    const scores: Record<string, number | null> = {};
    for (const [vendor, score] of Object.entries(s.scores as Record<string, unknown>)) scores[vendor] = num((score as { overall?: unknown } | null)?.overall);
    return { id: s.id, t: num(s.t), scores };
  });
  const perVendorMedian: Record<string, number | null> = {};
  for (const [vendor, m] of Object.entries(r.perVendorMedian as Record<string, unknown>)) perVendorMedian[vendor] = num(m);
  return { path, sampleSeed: num(r.sampleSeed), sampleSpan: num(r.sampleSpan), median: num(r.median), verdict: typeof r.verdict === 'string' ? r.verdict : null, perVendorMedian, samples };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const round2 = (x: number) => Math.round(x * 100) / 100;
const round4 = (x: number) => Math.round(x * 10000) / 10000;

/** Per-vendor median across a film's readings (the median of each reading's own vendor median). */
export function vendorMedians(readings: Reading[]): Record<string, number | null> {
  const vendors = [...new Set(readings.flatMap((r) => Object.keys(r.perVendorMedian)))].sort();
  return Object.fromEntries(vendors.map((v) => { const m = median(readings.map((r) => r.perVendorMedian[v]).filter((x): x is number => x !== null && x !== undefined)); return [v, m === null ? null : round2(m)]; }));
}

export interface PairedVerdict { status: 'keep' | 'revert' | 'error'; n: number; mean: number | null; ci95: [number, number] | null; vendors: string[]; reason: string }

/**
 * HillClimb's paired rule, applied to a film round. Each sample is averaged across k readings per vendor, then paired
 * with the incumbent's same sample index and vendor. Refused (error) when the films' sample counts differ or any
 * paired sample's time differs by more than 0.05 s. Keep only when the 95% CI lower bound of mean(candidate − incumbent) > 0.
 */
export function pairedVerdict(candidate: Reading[], incumbent: Reading[], tolS: number = PAIR_T_TOLERANCE_S): PairedVerdict {
  const fail = (reason: string): PairedVerdict => ({ status: 'error', n: 0, mean: null, ci95: null, vendors: [], reason });
  if (!candidate.length) return fail('candidate has no critique readings');
  if (!incumbent.length) return fail('incumbent has no critique readings');
  const all = [...candidate, ...incumbent];
  const len = all[0]!.samples.length;
  if (all.some((r) => r.samples.length !== len)) return fail(`readings differ in sample count (${all.map((r) => r.samples.length).join(', ')}); pairing needs the same samples`);
  for (let i = 0; i < len; i++) {
    for (const c of candidate) for (const inc of incumbent) {
      const a = c.samples[i]!, b = inc.samples[i]!;
      if (a.id !== b.id) return fail(`sample ${i}: ids differ (${a.id} vs ${b.id})`);
      if ((a.t === null) !== (b.t === null) || (a.t !== null && b.t !== null && Math.abs(a.t - b.t) > tolS)) return fail(`sample ${a.id}: times differ (${a.t} s vs ${b.t} s, tolerance ${tolS} s); the readings did not share one sample seed`);
    }
  }
  const vendors = [...new Set(all.flatMap((r) => r.samples.flatMap((s) => Object.keys(s.scores))))].sort();
  const cand: number[] = [], inc: number[] = [];
  const avg = (rs: Reading[], i: number, v: string) => { const xs = rs.map((r) => r.samples[i]!.scores[v]).filter((x): x is number => typeof x === 'number'); return xs.length ? mean(xs) : null; };
  for (const v of vendors) for (let i = 0; i < len; i++) {
    const c = avg(candidate, i, v), b = avg(incumbent, i, v);
    if (c !== null && b !== null) { cand.push(c); inc.push(b); }
  }
  if (cand.length < 2) return fail(`only ${cand.length} paired sample(s) with a score on both sides; need 2 or more`);
  const p = pairedDiff(inc, cand);
  // Exact bounds, so the keep rule and every later check read the same number; rounding is for display only.
  const ci95: [number, number] = [p.ci95_lo, p.ci95_hi];
  const keep = p.ci95_lo > 0;
  return { status: keep ? 'keep' : 'revert', n: p.n, mean: round2(p.mean_diff), ci95, vendors, reason: keep ? `95% CI lower bound ${round4(ci95[0])} > 0` : `95% CI lower bound ${round4(ci95[0])} <= 0: not distinguishable from the incumbent` };
}

/** Whether the installed Critique.ts accepts lane 2's flags (strict parseArgs refuses an unknown one). */
export function critiqueFlagSupport(source: string): { seed: boolean; vendors: boolean; span: boolean } {
  return { seed: /['"]sample-seed['"]\s*:/.test(source), span: /['"]sample-span['"]\s*:/.test(source), vendors: /\bvendors\s*:\s*\{\s*type\s*:/.test(source) || /['"]vendors['"]\s*:\s*\{/.test(source) };
}

// ── video stages (real CLIs; tests inject fakes) ─────────────────────────────
export interface VideoDeps {
  probe(master: string, signal: AbortSignal): Promise<ProbeInfo>;
  filmStats(master: string, signal: AbortSignal): Promise<ProcResult>;
  textFit(dir: string, hits: string, signal: AbortSignal): Promise<ProcResult>;
  seam(dir: string, signal: AbortSignal): Promise<ProcResult>;
  proof(dir: string, master: string, hits: string | null, signal: AbortSignal): Promise<ProcResult>;
  /** Gate L: TextFit --every 0.5 --json over the whole composition. */
  layout(dir: string, signal: AbortSignal): Promise<ProcResult>;
  /** Gate Q: Critique --layout-qa on the hit frames; exit 0 pass, 1 both vendors saw a layout defect, else error. */
  layoutQa(master: string, briefPath: string, hits: string, outDir: string, signal: AbortSignal): Promise<ProcResult>;
  /** One Critique reading into its own fresh out dir; returns the parsed Critique.json and its path. */
  critique(master: string, briefPath: string, outDir: string, extraArgs: string[], signal: AbortSignal): Promise<{ json: unknown; path: string }>;
}

export const realVideoDeps: VideoDeps = {
  async probe(master, signal) {
    const r = await runProcess(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', master], signal);
    if (r.code !== 0) throw new Error(procError('ffprobe', r));
    return parseProbe(JSON.parse(r.stdout));
  },
  filmStats: (master, signal) => runProcess([bun, VIDEO_TOOLS.filmStats, '--json', master], signal),
  textFit: (dir, hits, signal) => runProcess([bun, VIDEO_TOOLS.textFit, '--project', dir, '--hits', hits], signal),
  seam: (dir, signal) => runProcess([bun, VIDEO_TOOLS.hyperframes, 'check', '--project', dir], signal),
  proof: (dir, master, hits, signal) => runProcess([bun, VIDEO_TOOLS.proof, 'run', '--artifact', master, '--project', dir, '--checks', join(dir, 'proof.json'), ...(hits ? ['--hits', hits] : []), '--json'], signal),
  layout: (dir, signal) => runProcess(layoutArgs(dir), signal),
  async layoutQa(master, briefPath, hits, outDir, signal) {
    if (!critiqueHasLayoutQa(readFileSync(VIDEO_TOOLS.critique, 'utf8'))) {
      return { code: 2, stdout: '', stderr: 'the installed Critique.ts has no --layout-qa, so gate Q cannot run (pass --no-layout-qa to skip it on purpose)', timedOut: false, ms: 0 };
    }
    invariant(!existsSync(join(outDir, 'LayoutQA.json')), `a layout QA directory is fresh: ${outDir}`);
    mkdirSync(outDir, { recursive: true });
    return runProcess(layoutQaArgs(master, briefPath, hits, outDir), signal);
  },
  async critique(master, briefPath, outDir, extraArgs, signal) {
    const report = join(outDir, 'Critique.json');
    invariant(!existsSync(report), `a reading directory is fresh: ${outDir}`);
    mkdirSync(outDir, { recursive: true });
    const r = await runProcess([bun, VIDEO_TOOLS.critique, '--video', master, '--brief', briefPath, '--out', outDir, ...extraArgs], signal);
    if (!existsSync(report)) throw new Error(`${procError('critique', r)}; no Critique.json`);
    return { json: JSON.parse(readFileSync(report, 'utf8')), path: report };
  },
};

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest('hex');
}

// ── video orchestration ──────────────────────────────────────────────────────
export interface VideoRoundOptions {
  candidates: string[];
  incumbent: string;
  briefPath: string;
  out: string;
  bpm?: number;
  /** beat/eighth need --bpm; words needs `words`; none skips gate B. Default eighth. */
  grid?: GridMode;
  /** voiceover words file (`[{t, s}]`, s = word start seconds) for --grid words */
  words?: string;
  /** --grid words tolerance in frames at `fps`; default WORD_TOLERANCE_FRAMES (2) */
  toleranceFrames?: number;
  k?: number;
  seed?: number;
  vendors?: string;
  fps?: number;
  /** Expected film length; default the incumbent's own duration. */
  durationS?: number;
  concurrency?: number;
  /**
   * Concurrent runs of the hyperframes-backed gates (TextFit, seam check, Proof). Default 1: run side by side, the
   * hyperframes CLI races on its own package install and browser (live round 2026-10-09: "could not determine
   * executable to run for package hyperframes", "lint printed no JSON"), which turns a good film into a gate error.
   */
  hyperframesConcurrency?: number;
  gateTimeoutMs?: number;
  critiqueTimeoutMs?: number;
  /** Gate Q (two-vendor layout QA on the hit frames). Default true; false is --no-layout-qa and skips Q for every film. */
  layoutQa?: boolean;
  /** Which lane-2 Critique flags to pass; default detected from the installed Critique.ts source. span absent = false. */
  critiqueFlags?: { seed: boolean; vendors: boolean; span?: boolean };
}
export type FilmVerdict = 'incumbent' | 'keep' | 'revert' | 'gated' | 'error';
export interface FilmRow {
  rank: number;
  dir: string;
  name: string;
  incumbent: boolean;
  master: string;
  sha256: string;
  gates: Gates;
  gatesPass: boolean;
  readings: string[];
  readingErrors: string[];
  perVendorMedian: Record<string, number | null>;
  paired: PairedVerdict | null;
  verdict: FilmVerdict;
}
export interface VideoRoundResult {
  mode: 'video';
  elapsedSec: number;
  rule: string;
  seed: number;
  seedApplied: boolean;
  /** The --sample-span every reading of every film was sampled over (the expected duration), or null when Critique.ts lacks it. */
  sampleSpan: number | null;
  vendors: string | null;
  vendorsApplied: boolean;
  k: number;
  bpm: number | null;
  grid: GridMode;
  /** resolved voiceover words file when grid is words, else null */
  words: string | null;
  /** word count in that file when grid is words, else null */
  wordCount: number | null;
  toleranceFrames: number | null;
  /** false when --no-layout-qa skipped gate Q for every film */
  layoutQa: boolean;
  fps: number;
  expectDurationS: number;
  brief: string;
  /** where this round's readings live: <out>/rounds/<stamp>/<film>/reading-<i>/Critique.json */
  runDir: string;
  rows: FilmRow[];
  notes: string[];
  exit: 0 | 1 | 2;
  record?: string;
}

const gateFallback = (error: string, ms: number): Gate => ({ status: 'error', evidence: error, ms });
const timed = async (fn: () => Promise<Omit<Gate, 'ms'>>): Promise<Gate> => { const t0 = Date.now(); const g = await fn(); return { ...g, ms: Date.now() - t0 }; };
const gatePasses = (g: Gate) => g.status === 'pass' || g.status === 'skipped';

export async function runVideoRound(o: VideoRoundOptions, deps: VideoDeps = realVideoDeps): Promise<VideoRoundResult> {
  const started = Date.now();
  const k = o.k ?? 3, grid = o.grid ?? 'eighth', fps = o.fps ?? FILM_GATES.fps;
  invariant(Number.isInteger(k) && k >= 1, '--k must be a positive integer');
  if (o.bpm !== undefined && !(Number.isFinite(o.bpm) && o.bpm > 0)) throw new Error('--bpm must be a positive number');
  if (!GRID_MODES.includes(grid)) throw new Error(`--grid must be ${GRID_MODES.slice(0, -1).join(', ')} or ${GRID_MODES.at(-1)}`);
  if (!(Number.isFinite(fps) && fps > 0)) throw new Error('--fps must be a positive number');
  if (grid !== 'words' && o.words !== undefined) throw new Error('--words only applies to --grid words');
  if (grid !== 'words' && o.toleranceFrames !== undefined) throw new Error('--tolerance-frames only applies to --grid words');
  if (o.toleranceFrames !== undefined && !(Number.isFinite(o.toleranceFrames) && o.toleranceFrames >= 0)) throw new Error('--tolerance-frames must be a non-negative number');
  if (grid === 'words' && o.words === undefined) throw new Error('--grid words needs --words <vo-words.json>');
  const wordsPath = o.words === undefined ? null : resolve(o.words);
  const toleranceFrames = grid === 'words' ? o.toleranceFrames ?? WORD_TOLERANCE_FRAMES : null;
  let voWords: VoWord[] | null = null;
  if (wordsPath) {
    try { voWords = parseVoWords(JSON.parse(readFileSync(wordsPath, 'utf8'))); }
    catch (e) { throw new Error(`--words ${wordsPath}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  parseBrief(JSON.parse(readFileSync(o.briefPath, 'utf8')));
  const briefPath = resolve(o.briefPath);
  const incumbent = resolve(o.incumbent);
  const candidates = o.candidates.map((c) => resolve(c));
  if (!candidates.length) throw new Error('no --candidates');
  const dirs = [incumbent, ...candidates];
  if (new Set(dirs).size !== dirs.length) throw new Error('a film directory is listed twice (the incumbent is never also a candidate)');
  for (const d of dirs) if (!existsSync(d) || !statSync(d).isDirectory() || !existsSync(join(d, 'master.mp4'))) throw new Error(`not a film directory with master.mp4: ${d}`);
  const seed = o.seed ?? randomInt(1, 2 ** 31 - 1);
  invariant(Number.isInteger(seed) && seed >= 0, '--seed must be a non-negative integer');
  const flags = o.critiqueFlags ?? critiqueFlagSupport(readFileSync(VIDEO_TOOLS.critique, 'utf8'));
  const notes: string[] = [];
  if (!flags.seed) notes.push(`Critique.ts has no --sample-seed yet: every reading used its fixed sample times; seed ${seed} recorded, not applied`);
  if (o.vendors && !flags.vendors) notes.push(`Critique.ts has no --vendors yet: --vendors ${o.vendors} not applied; each reading ran its default panel`);
  if (!flags.span) notes.push('Critique.ts has no --sample-span yet: each film was sampled over its own duration, so films of different lengths may not pair');
  const names = candidateNames(dirs.map((d) => `${basename(d)}.dir`));
  const out = resolve(o.out);
  for (const d of dirs) invariant(!(out + '/').startsWith(d + '/'), `--out must not be inside a film directory: ${d}`);
  const runDir = join(out, 'rounds', new Date().toISOString().replace(/[:.]/g, '-'));
  invariant(!existsSync(runDir), `round directory is fresh: ${runDir}`);
  const limit = limiter(o.concurrency ?? 8);
  const hfLimit = limiter(o.hyperframesConcurrency ?? 1);
  const gateMs = o.gateTimeoutMs ?? 300_000, critiqueMs = o.critiqueTimeoutMs ?? 900_000;
  const masters = dirs.map((d) => join(d, 'master.mp4'));

  // 1. hashes and probes (cheap) for every film; the incumbent's duration sets the expected length.
  const [hashes, probes] = await Promise.all([
    Promise.all(masters.map((m) => sha256File(m))),
    Promise.all(masters.map((m) => limit(() => guarded<ProbeInfo | Error>(gateMs, (s) => deps.probe(m, s), (error) => new Error(error))))),
  ]);
  const incProbe = probes[0]!;
  if (incProbe instanceof Error && o.durationS === undefined) throw new Error(`incumbent could not be probed: ${incProbe.message}`);
  const expectDurationS = o.durationS ?? (incProbe as ProbeInfo).durationS;
  invariant(Number.isFinite(expectDurationS) && expectDurationS > 0, `expected duration is a positive number of seconds: ${expectDurationS}`);
  // One span for every reading of every film, so sample i lands at the same time in each (EvalRound pairs within 0.05 s).
  const sampleSpan = flags.span ? expectDurationS : null;
  const extraArgs = [...(flags.seed ? ['--sample-seed', String(seed)] : []), ...(sampleSpan !== null ? ['--sample-span', String(sampleSpan)] : []), ...(o.vendors && flags.vendors ? ['--vendors', o.vendors] : [])];

  // 2. every code gate, every film at once; gate Q (vision, paid) follows on the films the code gates kept.
  const gateRuns = dirs.map(async (dir, i): Promise<Omit<Gates, 'layoutQa'>> => {
    const master = masters[i]!, hits = join(dir, 'hits.md'), hasHits = existsSync(hits), p = probes[i]!;
    const probe: Gate = p instanceof Error ? { status: 'error', evidence: p.message, ms: 0 } : { ...judgeProbe(p, expectDurationS, fps), ms: 0 };
    const beatGrid: Gate = await timed(async () => {
      if (grid === 'none') return { status: 'skipped', evidence: '--grid none' };
      if (grid === 'words') {
        invariant(voWords !== null && toleranceFrames !== null, '--grid words has its words parsed before the gates run');
        if (!hasHits) return { status: 'fail', evidence: 'no hits.md' };
        try { return judgeWordGrid(checkWordGrid(parseHitTimes(readFileSync(hits, 'utf8')), voWords, fps, toleranceFrames)); }
        catch (e) { return { status: 'error', evidence: e instanceof Error ? e.message : String(e) }; }
      }
      if (o.bpm === undefined) return { status: 'skipped', evidence: 'no --bpm' };
      if (!hasHits) return { status: 'fail', evidence: 'no hits.md' };
      try {
        const g = checkBeatGrid(parseHitTimes(readFileSync(hits, 'utf8')), o.bpm, grid, fps);
        return { status: g.pass ? 'pass' : 'fail', evidence: `${g.hits} hits on the ${grid} grid (${+g.stepS.toFixed(4)} s ±1 frame)${g.offGrid.length ? `; off grid: ${g.offGrid.slice(0, 8).join(', ')}` : g.hits ? '' : '; no hit times found'}` };
      } catch (e) { return { status: 'error', evidence: e instanceof Error ? e.message : String(e) }; }
    });
    const [filmStats, textFit, seam, proof, layout] = await Promise.all([
      limit(() => guarded<Gate>(gateMs, (s) => timed(async () => { const r = await deps.filmStats(master, s); return r.code === 0 ? judgeFilmStats(r.stdout) : judgeExit('FilmStats', r); }), gateFallback)),
      hasHits ? hfLimit(() => guarded<Gate>(gateMs, (s) => timed(async () => judgeExit('TextFit', await deps.textFit(dir, hits, s))), gateFallback)) : Promise.resolve<Gate>({ status: 'fail', evidence: 'no hits.md to pick TextFit times', ms: 0 }),
      hfLimit(() => guarded<Gate>(gateMs, (s) => timed(async () => judgeExit('seam check', await deps.seam(dir, s))), gateFallback)),
      existsSync(join(dir, 'proof.json'))
        ? hfLimit(() => guarded<Gate>(gateMs, (s) => timed(async () => judgeProof(await deps.proof(dir, master, hasHits ? hits : null, s))), gateFallback))
        : Promise.resolve<Gate>({ status: 'skipped', evidence: 'no proof.json', ms: 0 }),
      hfLimit(() => guarded<Gate>(gateMs, (s) => timed(async () => judgeLayout(await deps.layout(dir, s))), gateFallback)),
    ]);
    return { probe, filmStats, textFit, seam, beatGrid, proof, layout };
  });
  const codeGates = await Promise.all(gateRuns);
  const codeFailed = codeGates.map((g) => GATE_NAMES.filter((n): n is Exclude<GateName, 'layoutQa'> => n !== 'layoutQa').filter((n) => !gatePasses(g[n])));
  // Q runs on the incumbent (recorded, never removes it) and on every film its code gates kept.
  const layoutQaOn = o.layoutQa ?? true;
  if (!layoutQaOn) notes.push('--no-layout-qa: gate Q (two-vendor layout QA) was skipped for every film');
  const qaGates = await Promise.all(dirs.map((dir, i): Promise<Gate> => {
    if (!layoutQaOn) return Promise.resolve({ status: 'skipped', evidence: '--no-layout-qa', ms: 0 });
    if (i !== 0 && codeFailed[i]!.length) return Promise.resolve({ status: 'skipped', evidence: `code gate failed: ${codeFailed[i]!.join(', ')}, not asked`, ms: 0 });
    const hits = join(dir, 'hits.md');
    if (!existsSync(hits)) return Promise.resolve({ status: 'fail', evidence: 'no hits.md to pick layout-QA frames', ms: 0 });
    const qaDir = join(runDir, names[i]!, 'layout-qa');
    return limit(() => guarded<Gate>(critiqueMs, (s) => timed(async () => {
      const g = judgeExit('layout QA', await deps.layoutQa(masters[i]!, briefPath, hits, qaDir, s));
      const report = join(qaDir, 'LayoutQA.json');
      return existsSync(report) ? { ...g, evidence: `${g.evidence} · ${report}` } : g;
    }), gateFallback));
  }));
  const gates: Gates[] = codeGates.map((g, i) => ({ ...g, layoutQa: qaGates[i]! }));
  const gatesPass = gates.map((g) => GATE_NAMES.every((n) => gatePasses(g[n])));

  // 3. k readings for the incumbent and every survivor, all at once, one shared seed.
  const judged = dirs.map((_, i) => i === 0 || gatesPass[i]!);
  const readingRuns = dirs.map((_, i) => !judged[i] ? Promise.resolve([] as (Reading | Error)[]) : Promise.all(Array.from({ length: k }, (_, r) =>
    limit(() => guarded<Reading | Error>(critiqueMs, async (s) => {
      const res = await deps.critique(masters[i]!, briefPath, join(runDir, names[i]!, `reading-${r + 1}`), extraArgs, s);
      return parseReading(res.json, res.path);
    }, (error) => new Error(error))))));
  const readingResults = await Promise.all(readingRuns);
  const readings = readingResults.map((rs) => rs.filter((r): r is Reading => !(r instanceof Error)));
  const readingErrors = readingResults.map((rs) => rs.filter((r): r is Error => r instanceof Error).map((e) => e.message));
  if (flags.seed) for (const [i, rs] of readings.entries()) for (const r of rs) if (r.sampleSeed !== seed) notes.push(`${names[i]} ${r.path}: Critique recorded sampleSeed ${r.sampleSeed}, round seed is ${seed}`);
  if (sampleSpan !== null) for (const [i, rs] of readings.entries()) for (const r of rs) if (r.sampleSpan !== sampleSpan) notes.push(`${names[i]} ${r.path}: Critique recorded sampleSpan ${r.sampleSpan}, round span is ${sampleSpan}`);

  // 4. paired verdict per survivor vs the incumbent, then rank.
  const rows: FilmRow[] = dirs.map((dir, i) => {
    const paired = i === 0 || !gatesPass[i] ? null : pairedVerdict(readings[i]!, readings[0]!);
    const verdict: FilmVerdict = i === 0 ? 'incumbent' : !gatesPass[i] ? 'gated' : paired!.status;
    return { rank: 0, dir, name: names[i]!, incumbent: i === 0, master: masters[i]!, sha256: hashes[i]!, gates: gates[i]!, gatesPass: gatesPass[i]!, readings: readings[i]!.map((r) => r.path), readingErrors: readingErrors[i]!, perVendorMedian: vendorMedians(readings[i]!), paired, verdict };
  });
  const order: Record<FilmVerdict, number> = { keep: 0, incumbent: 1, revert: 2, error: 3, gated: 4 };
  const ranked = [...rows].sort((a, b) => order[a.verdict] - order[b.verdict]
    || (b.paired?.ci95?.[0] ?? -Infinity) - (a.paired?.ci95?.[0] ?? -Infinity)
    || (b.paired?.mean ?? -Infinity) - (a.paired?.mean ?? -Infinity)
    || dirs.indexOf(a.dir) - dirs.indexOf(b.dir));
  ranked.forEach((r, i) => { r.rank = i + 1; });
  const survivors = rows.filter((r) => !r.incumbent && r.gatesPass);
  if (readings[0]!.length === 0) notes.push(`incumbent has no critique reading: ${readingErrors[0]!.join(' | ') || 'none ran'}`);
  const anyKeep = rows.some((r) => r.verdict === 'keep');
  const exit: 0 | 1 | 2 = anyKeep ? 0 : readings[0]!.length === 0 || (survivors.length > 0 && survivors.every((r) => r.verdict === 'error')) ? 2 : 1;
  return {
    mode: 'video', elapsedSec: Math.round((Date.now() - started) / 100) / 10, rule: VIDEO_KEEP_RULE,
    seed, seedApplied: flags.seed, sampleSpan, vendors: o.vendors ?? null, vendorsApplied: Boolean(o.vendors && flags.vendors), k, bpm: o.bpm ?? null, grid, words: wordsPath, wordCount: voWords?.length ?? null, toleranceFrames, layoutQa: layoutQaOn, fps, expectDurationS, brief: briefPath, runDir,
    rows: ranked, notes, exit,
  };
}

/** round.json at <out> (latest) and inside the timestamped round directory beside its readings. */
export function writeVideoRecord(out: string, result: VideoRoundResult): string {
  invariant(result.rows.length >= 2, 'a video round has an incumbent and at least one candidate');
  invariant(result.rows.filter((r) => r.incumbent).length === 1, 'a video round has exactly one incumbent');
  invariant(result.rows.every((r) => /^[0-9a-f]{64}$/.test(r.sha256)), 'every row is bound to its master.mp4 sha256');
  invariant(result.rows.every((r) => r.verdict !== 'keep' || (r.paired?.ci95 !== null && r.paired!.ci95![0] > 0)), 'a keep always has a CI lower bound above zero');
  const dir = resolve(out);
  const runCopy = join(result.runDir, 'round.json');
  mkdirSync(result.runDir, { recursive: true });
  const text = JSON.stringify({ ...result, record: runCopy }, null, 2) + '\n';
  writeFileSync(runCopy, text, { flag: 'wx' });
  writeFileSync(join(dir, 'round.json'), text);
  return runCopy;
}

export function renderVideoTable(r: VideoRoundResult): string {
  const vendors = [...new Set(r.rows.flatMap((row) => Object.keys(row.perVendorMedian)))].sort();
  const gateMark = (g: Gate) => (g.status === 'pass' ? '+' : g.status === 'skipped' ? '.' : g.status === 'fail' ? 'x' : '?');
  const head = `${cell('#', 3)} ${cell('film', 18)} ${cell('gates PFTSBRLQ', 15)} ${vendors.map((v) => cell(v.slice(0, 7), 8)).join(' ')} ${cell('paired mean [95% CI]', 24)} ${cell('n', 4)} verdict`;
  const lines = [head, '-'.repeat(head.length)];
  for (const row of r.rows) {
    const g = GATE_NAMES.map((n) => gateMark(row.gates[n])).join('');
    const p = row.paired;
    const paired = p && p.mean !== null ? `${p.mean >= 0 ? '+' : ''}${p.mean} [${round2(p.ci95![0])}, ${round2(p.ci95![1])}]` : row.incumbent ? 'baseline' : '-';
    lines.push(`${cell(String(row.rank), 3)} ${cell(`${row.incumbent ? '* ' : ''}${row.name}`, 18)} ${cell(g, 15)} ${vendors.map((v) => cell(String(row.perVendorMedian[v] ?? '-'), 8)).join(' ')} ${cell(paired, 24)} ${cell(p ? String(p.n) : '-', 4)} ${row.verdict}`);
  }
  lines.push('', `gates: P probe · F FilmStats · T TextFit · S seam check · B beat grid · R Proof · L layout (TextFit every ${LAYOUT_EVERY_S} s) · Q layout QA (+ pass, x fail, ? error, . skipped)${r.layoutQa ? '' : '; layout QA off (--no-layout-qa): Q skipped for every film'}`);
  for (const row of r.rows) {
    const bits = GATE_NAMES.filter((n) => !gatePasses(row.gates[n])).map((n) => `${n} ${row.gates[n].status}: ${row.gates[n].evidence}`);
    if (row.paired && row.paired.status === 'error') bits.push(`paired: ${row.paired.reason}`);
    for (const e of row.readingErrors) bits.push(`reading error: ${e}`);
    if (bits.length) lines.push(row.name, ...bits.map((b) => `  ${b.replace(/\s+/g, ' ').slice(0, 300)}`));
  }
  lines.push('', `seed ${r.seed}${r.seedApplied ? '' : ' (recorded, not applied)'} · span ${r.sampleSpan === null ? 'none' : `${r.sampleSpan} s`} · k ${r.k} · grid ${r.grid}${r.grid === 'words' ? ` (${r.wordCount} words, ±${r.toleranceFrames} frames at ${r.fps} fps)` : r.grid !== 'none' && r.bpm ? ` @ ${r.bpm} BPM` : ''} · expected ${r.expectDurationS.toFixed(2)} s`);
  for (const n of r.notes) lines.push(`note: ${n}`);
  lines.push(`exit ${r.exit} · elapsed ${r.elapsedSec}s${r.record ? ` · record ${r.record}` : ''}`);
  return lines.join('\n');
}

/** argv after --video: `--candidates a b c` takes every value up to the next flag; commas also split. */
export function parseVideoArgs(argv: string[]): Record<string, string | string[] | boolean> {
  const out: Record<string, string | string[] | boolean> = {};
  const known = new Set(['video', 'candidates', 'incumbent', 'brief', 'bpm', 'grid', 'words', 'tolerance-frames', 'k', 'seed', 'out', 'vendors', 'fps', 'duration', 'concurrency', 'hf-concurrency', 'timeout', 'critique-timeout', 'no-layout-qa', 'json', 'help']);
  const booleans = new Set(['video', 'no-layout-qa', 'json', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const name = a.slice(2);
    if (!known.has(name)) throw new Error(`unknown option --${name}`);
    if (booleans.has(name)) { out[name] = true; continue; }
    if (name === 'candidates') {
      const vals: string[] = [];
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) vals.push(...argv[++i]!.split(',').map((s) => s.trim()).filter(Boolean));
      if (!vals.length) throw new Error('--candidates needs at least one directory');
      out[name] = vals;
      continue;
    }
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
    out[name] = v;
  }
  return out;
}

export const VIDEO_USAGE = 'EvalRound --video — one parallel film round against an incumbent\n\n  bun EvalRound.ts --video --candidates <dir> [<dir> ...] --incumbent <dir> --brief <Brief.json> --out <dir>\n    [--grid beat|eighth|words|none] [--bpm n] [--words <vo-words.json>] [--tolerance-frames 2]\n    [--k 3] [--seed n] [--vendors openai,anthropic] [--fps 30] [--duration <s>]\n    [--concurrency 8] [--hf-concurrency 1] [--timeout 300] [--critique-timeout 900] [--no-layout-qa] [--json]\n\nEach dir holds master.mp4, index.html, hits.md and optionally proof.json. Writes <out>/round.json.\nGates PFTSBRLQ: L is TextFit every 0.5 s (occluded, canvas-text, connector, align, clipped, frame fail);\nQ is Critique --layout-qa on the hit frames (both vendors yes = fail). --no-layout-qa skips Q.\nExit 0 a candidate clears the paired keep rule · 1 none does · 2 error.';

async function videoMain(argv: string[]): Promise<number> {
  try {
    const v = parseVideoArgs(argv);
    if (v.help) { console.log(VIDEO_USAGE); return 0; }
    if (!v.candidates || !v.incumbent || !v.brief || !v.out) { console.error(VIDEO_USAGE); return 2; }
    const n = (key: string, int = false): number | undefined => {
      if (v[key] === undefined) return undefined;
      const x = Number(v[key]);
      if (!Number.isFinite(x) || x < 0 || (int && !Number.isInteger(x))) throw new Error(`--${key} must be a ${int ? 'non-negative integer' : 'non-negative number'}`);
      return x;
    };
    const grid = String(v.grid ?? 'eighth') as GridMode;
    if (!GRID_MODES.includes(grid)) throw new Error(`--grid must be ${GRID_MODES.slice(0, -1).join(', ')} or ${GRID_MODES.at(-1)}`);
    const timeout = n('timeout'), critiqueTimeout = n('critique-timeout');
    const result = await runVideoRound({
      candidates: v.candidates as string[], incumbent: String(v.incumbent), briefPath: String(v.brief), out: String(v.out),
      bpm: n('bpm'), grid, words: v.words === undefined ? undefined : String(v.words), toleranceFrames: n('tolerance-frames'), k: n('k', true), seed: n('seed', true), vendors: v.vendors === undefined ? undefined : String(v.vendors),
      fps: n('fps'), durationS: n('duration'), concurrency: n('concurrency', true), hyperframesConcurrency: n('hf-concurrency', true), layoutQa: v['no-layout-qa'] !== true,
      gateTimeoutMs: timeout === undefined ? undefined : timeout * 1000, critiqueTimeoutMs: critiqueTimeout === undefined ? undefined : critiqueTimeout * 1000,
    });
    result.record = writeVideoRecord(String(v.out), result);
    console.log(v.json ? JSON.stringify(result, null, 2) : renderVideoTable(result));
    return result.exit;
  } catch (error) {
    console.error(`EvalRound --video: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

export function expandCandidates(spec: string): string[] {
  if (/[*?[]/.test(spec)) {
    const files = [...new Bun.Glob(spec).scanSync({ cwd: spec.startsWith('/') ? '/' : process.cwd(), absolute: true, onlyFiles: true })].sort();
    if (!files.length) throw new Error(`no candidates match ${spec}`);
    return files;
  }
  return spec.split(',').map((s) => s.trim()).filter(Boolean);
}

if (import.meta.main && Bun.argv.slice(2).includes('--video')) {
  // Exit explicitly: a killed stage's orphaned grandchild must not hold the round open.
  process.exit(await videoMain(Bun.argv.slice(2)));
}

if (import.meta.main) {
  const usage = 'EvalRound — one parallel image eval round\n\n  bun EvalRound.ts --candidates a.png,b.png|"<glob>" --reference "<argument summary>" --brief Brief.json \\\n    --question "<tournament question>" --out <dir> [--incumbent last-winner.png] [--generator nano-banana-pro]\n    [--timeout 105] [--concurrency 16] [--min-width 1200] [--word-ratio 0.6] [--allow-identity] [--json]\n\nExit 0 winner clears the bar · 1 no candidate clears it · 2 no judge produced a result.';
  try {
    const { values: v } = parseArgs({ args: Bun.argv.slice(2), strict: true, options: {
      candidates: { type: 'string' }, reference: { type: 'string' }, brief: { type: 'string' }, question: { type: 'string' },
      incumbent: { type: 'string' }, out: { type: 'string' }, generator: { type: 'string' }, timeout: { type: 'string' },
      concurrency: { type: 'string' }, 'critique-repeats': { type: 'string' }, 'min-width': { type: 'string' }, 'word-ratio': { type: 'string' },
      'allow-identity': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean' },
    } });
    if (v.help || !v.candidates || !v.reference || !v.brief || !v.question || !v.out) { console.log(usage); process.exit(v.help ? 0 : 1); }
    const positive = (s: string | undefined, name: string) => { if (s === undefined) return undefined; const n = Number(s); if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`); return n; };
    const ratio = (s: string | undefined) => { if (s === undefined) return undefined; const n = Number(s); if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error('--word-ratio must be between 0 and 1'); return n; };
    const timeout = positive(v.timeout, 'timeout');
    const result = await runRound({
      candidates: expandCandidates(v.candidates), reference: v.reference, briefPath: v.brief, question: v.question, out: v.out,
      incumbent: v.incumbent, generator: v.generator, allowIdentity: v['allow-identity'],
      judgeTimeoutMs: timeout === undefined ? undefined : timeout * 1000, concurrency: positive(v.concurrency, 'concurrency'), critiqueRepeats: positive(v['critique-repeats'], 'critique-repeats'),
      minWidth: positive(v['min-width'], 'min-width'), wordRatio: ratio(v['word-ratio']),
    });
    result.record = writeRecord(v.out, result);
    console.log(v.json ? JSON.stringify(result, null, 2) : renderTable(result));
    // Exit explicitly: a killed stage's orphaned grandchild must not hold the round open.
    process.exit(result.exit);
  } catch (error) {
    console.error(`EvalRound: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
