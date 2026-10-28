#!/usr/bin/env bun
/**
 * NarrationMatch — judges a narrated video shot by shot against what is being said over it.
 *
 * Born from the LifeOS 8.439 release film (2026-10-15): the ArtDirection critique judged ~12 sampled stills for
 * look, nothing paired a frame with the words spoken over it, and nothing compared shots to each other, so a
 * HillClimb line played over the Review page and Today appeared in shot after shot.
 *
 * Code tier (no model, runs first): blank or dead frames (a short fade at the film's first or last frame is a note),
 * repeated shots across narration beats (perceptual dHash confirmed by an edge-map overlap, plus repeated asset paths),
 * and coverage (every sentence under a shot, no long silent shot).
 * Judged tier: EVERY shot's rest frame plus the words spoken over it goes to Assay's vision panel
 * (VisionJudge.judgeImageRubric, OpenAI + Anthropic). Unearned, so its misses are recorded as PROVISIONAL flags
 * on the receipt; the tool's own exit still reports them as a fail.
 *
 * Flags and calibration evidence: NarrationMatch.help.md.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { invariant } from '../../../LIFEOS/TOOLS/Invariant.ts';
import { ASSAY_RECEIPT_SCHEMA, deriveVerdict, sha256File, writeReceipt, type AssayReceipt, type ProofFinding } from '../../../LIFEOS/TOOLS/lib/ProofReceipt.ts';
import { judgeImageRubric } from './VisionJudge.ts';
import type { AssertResult } from './Assertions.ts';

export const NARRATION_MATCH_VERSION = '1.1.0';

// ── Thresholds (calibrated 2026-10-15 on the r3 and r4 films and the v3 slice; evidence in NarrationMatch.help.md) ──
export const THRESHOLDS = {
  /** A frame is blank when luma stddev AND edge density are both under their floors. */
  blankStdFloor: 6,
  blankEdgeFloor: 0.004,
  /** A blank run that touches the film's first or last frame is a fade, noted only, while the stretch from that edge to its farthest blank sample is at most this many seconds. */
  fadeMax: 0.6,
  /** Gradient magnitude (|dx|+|dy| on 0-255 luma) that counts as an edge pixel. */
  edgeGradient: 24,
  /** dHash: 16x16 bits = 256. Two frames are near-duplicates at or under this many differing bits. */
  repeatHamming: 40,
  /** A dHash hit fails only when the shots' binary edge maps (edgeMapW×edgeMapH, 1-px tolerant, symmetric) overlap at or over this. */
  repeatEdgeOverlap: 0.57,
  edgeMapW: 160,
  edgeMapH: 90,
  /** Shot detection: ffmpeg scene score above this starts a shot; shots shorter than mergeUnder fold into the previous. */
  sceneThreshold: 0.1,
  mergeUnder: 0.6,
  splitOver: 4,
  /** A shot may sit under silence this long (seconds) unless it is the opening or closing card. */
  maxSilence: 2,
  /** Words this far either side of a shot count as spoken over it. */
  wordPad: 0.75,
  /** The judged pass bar on the 0-1 anchored scale. */
  judgePass: 0.7,
  /** Blank sweep step in seconds. */
  sweepStep: 0.5,
} as const;

export type Word = { text: string; start: number; end: number; beat?: string };
export type Sentence = { text: string; start: number; end: number; beat: string };
/**
 * `feature` is the feature the narration is about during the shot; `shows` is the feature its asset actually
 * shows (from the asset audit). When both are given and differ, the shot borrows another feature's screen, which
 * no judge can see from pixels alone (2026-10-15: both vendors scored HillClimb narration over the Review page 1.0).
 */
export type Shot = { start: number; end: number; label?: string; asset?: string; rest?: number; beat?: string; feature?: string; shows?: string };
export type Frame = { w: number; h: number; data: Uint8Array };

export class UsageError extends Error {}

// ── Narration adapters ─────────────────────────────────────────

/** SRT timestamps to seconds. */
function srtTime(s: string): number {
  const m = /^(\d+):(\d+):(\d+)[,.](\d+)$/.exec(s.trim());
  if (!m) throw new UsageError(`bad SRT timestamp: ${s}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

/** An SRT file to words; each cue's words share its span evenly, and each cue is its own beat. */
export function wordsFromSrt(text: string): Word[] {
  const words: Word[] = [];
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  blocks.forEach((block, i) => {
    const lines = block.split('\n');
    const timeLine = lines.findIndex((l) => l.includes('-->'));
    if (timeLine < 0) return;
    const [a, b] = lines[timeLine].split('-->');
    const start = srtTime(a), end = srtTime(b);
    const tokens = lines.slice(timeLine + 1).join(' ').replace(/<[^>]+>/g, '').split(/\s+/).filter(Boolean);
    const step = tokens.length ? (end - start) / tokens.length : 0;
    tokens.forEach((t, k) => words.push({ text: t, start: start + k * step, end: start + (k + 1) * step, beat: `cue${i + 1}` }));
  });
  return words;
}

type ManifestRow = { segmentId?: unknown; timestampsFile?: unknown; trim?: { startMs?: unknown } };

/**
 * A words JSON: a flat list of {word|w|text, start|s, end|e}, or a narration manifest ({rows:[{segmentId,
 * timestampsFile, trim}]}) whose segment-relative words are placed on the film by `offsets` (segment id → seconds).
 * Only segments with an offset are placed; the film plays each segment's trimmed audio from its offset.
 */
export function wordsFromJson(raw: unknown, baseDir: string, offsets?: Record<string, number>): Word[] {
  const flat = (list: unknown[], shift = 0, beat?: string): Word[] => list.map((x, i) => {
    const o = x as Record<string, unknown>;
    const text = [o.display, o.word, o.w, o.text].find((v) => typeof v === 'string') as string | undefined;
    const start = [o.start, o.s].find((v) => typeof v === 'number') as number | undefined;
    const end = [o.end, o.e].find((v) => typeof v === 'number') as number | undefined;
    if (text === undefined || start === undefined || end === undefined) throw new UsageError(`word ${i} needs word/start/end (or w/s/e)`);
    return { text, start: start + shift, end: end + shift, ...(beat ? { beat } : {}) };
  });
  if (Array.isArray(raw)) return flat(raw);
  const o = raw as { rows?: ManifestRow[]; words?: unknown[] };
  if (Array.isArray(o?.words)) return flat(o.words);
  if (!Array.isArray(o?.rows)) throw new UsageError('--words must be a list of {word,start,end}, {words:[...]}, or a manifest with rows');
  if (!offsets) throw new UsageError('a narration manifest needs segment offsets on the film: pass --offsets, or a --shots file with an "offsets" map');
  const out: Word[] = [];
  for (const row of o.rows) {
    if (typeof row.segmentId !== 'string' || typeof row.timestampsFile !== 'string') continue;
    const offset = offsets[row.segmentId];
    if (typeof offset !== 'number') continue;
    const file = resolve(baseDir, row.timestampsFile);
    if (!existsSync(file)) throw new UsageError(`manifest segment ${row.segmentId}: ${file} not found`);
    const seg = JSON.parse(readFileSync(file, 'utf8')) as { words?: unknown[] };
    if (!Array.isArray(seg.words)) throw new UsageError(`manifest segment ${row.segmentId}: no words list`);
    const trimStart = typeof row.trim?.startMs === 'number' ? row.trim.startMs / 1000 : 0;
    out.push(...flat(seg.words, offset - trimStart, row.segmentId));
  }
  if (!out.length) throw new UsageError('no manifest segment matched an offset');
  return out.sort((a, b) => a.start - b.start);
}

/** Words to sentences: a sentence ends on . ? ! or a pause over 0.8 s, and never crosses a beat. */
export function sentencesOf(words: Word[]): Sentence[] {
  const out: Sentence[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ text: cur.map((w) => w.text).join(' '), start: cur[0].start, end: cur[cur.length - 1].end, beat: cur[0].beat ?? `s${out.length + 1}` });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > 0.8 || w.beat !== prev.beat)) flush();
    cur.push(w);
    if (/[.?!]["')\]]*$/.test(w.text)) flush();
  }
  flush();
  return out;
}

// ── Shots ──────────────────────────────────────────────────────

const ASSET_IN_LABEL = /\(([^()\s]+\.(?:png|jpe?g|webp|gif|mp4|mov|webm))\)/i;

/** A shots file: a list, or a builder timing file ({shots, shotSegments?, offsets?}). Accepts start/end or from/to. */
export function shotsFromJson(raw: unknown): { shots: Shot[]; offsets?: Record<string, number> } {
  const o = raw as { shots?: unknown[]; shotSegments?: unknown[]; offsets?: Record<string, number> };
  const list = Array.isArray(raw) ? raw : Array.isArray(o?.shots) ? o.shots : null;
  if (!list) throw new UsageError('--shots must be a list of {start,end,...} or an object with a "shots" list');
  const beats = !Array.isArray(raw) && Array.isArray(o.shotSegments) ? o.shotSegments : [];
  const shots = list.map((x, i) => {
    const s = x as Record<string, unknown>;
    const start = [s.start, s.from].find((v) => typeof v === 'number') as number | undefined;
    const end = [s.end, s.to].find((v) => typeof v === 'number') as number | undefined;
    if (start === undefined || end === undefined || !(end > start)) throw new UsageError(`shot ${i} needs start < end (or from < to)`);
    const label = typeof s.label === 'string' ? s.label : undefined;
    const asset = typeof s.asset === 'string' ? s.asset : label ? ASSET_IN_LABEL.exec(label)?.[1] : undefined;
    const beat = typeof s.beat === 'string' ? s.beat : typeof beats[i] === 'string' ? beats[i] as string : undefined;
    const feature = typeof s.feature === 'string' ? s.feature : undefined;
    const shows = typeof s.shows === 'string' ? s.shows : undefined;
    return { start, end, ...(label ? { label } : {}), ...(asset ? { asset } : {}), ...(typeof s.rest === 'number' ? { rest: s.rest } : {}), ...(beat ? { beat } : {}), ...(feature ? { feature } : {}), ...(shows ? { shows } : {}) };
  }).sort((a, b) => a.start - b.start);
  const offsets = !Array.isArray(raw) && o.offsets && typeof o.offsets === 'object' ? o.offsets : undefined;
  return { shots, ...(offsets ? { offsets } : {}) };
}

/** Scene-change times to shots: cuts under mergeUnder apart fold together, shots over splitOver split evenly. */
export function shotsFromCuts(cuts: number[], duration: number, t = THRESHOLDS): Shot[] {
  const bounds = [0, ...cuts.filter((c) => c > 0 && c < duration).sort((a, b) => a - b), duration];
  const merged: number[] = [0];
  for (const b of bounds.slice(1)) {
    if (b - merged[merged.length - 1] < t.mergeUnder && b !== duration) continue;
    if (b === duration && b - merged[merged.length - 1] < t.mergeUnder && merged.length > 1) merged.pop();
    merged.push(b);
  }
  const shots: Shot[] = [];
  for (let i = 0; i + 1 < merged.length; i++) {
    const [a, b] = [merged[i], merged[i + 1]];
    const parts = Math.max(1, Math.ceil((b - a) / t.splitOver));
    for (let k = 0; k < parts; k++) shots.push({ start: a + ((b - a) * k) / parts, end: a + ((b - a) * (k + 1)) / parts, label: `shot ${shots.length + 1}` });
  }
  return shots;
}

/** Each shot takes the beat of the sentence it overlaps most, unless it already names one. */
export function assignBeats(shots: Shot[], sentences: Sentence[]): Shot[] {
  return shots.map((s) => {
    if (s.beat) return s;
    let best: Sentence | null = null, bestOverlap = 0;
    for (const x of sentences) {
      const ov = Math.min(s.end, x.end) - Math.max(s.start, x.start);
      if (ov > bestOverlap) { bestOverlap = ov; best = x; }
    }
    return { ...s, beat: best ? best.beat : '(silence)' };
  });
}

export const restOf = (s: Shot): number => s.rest ?? (s.start + s.end) / 2;

/** The words spoken over a shot, padded either side. */
export function wordsOver(shot: Shot, words: Word[], pad = THRESHOLDS.wordPad): string {
  return words.filter((w) => w.end > shot.start - pad && w.start < shot.end + pad).map((w) => w.text).join(' ');
}

// ── Pure frame metrics ─────────────────────────────────────────

export function frameDetail(f: Frame, edgeGradient = THRESHOLDS.edgeGradient): { std: number; edges: number } {
  const { w, h, data } = f;
  invariant(data.length === w * h, 'frame data must be w*h luma bytes');
  let sum = 0, sq = 0;
  for (let i = 0; i < data.length; i++) { sum += data[i]; sq += data[i] * data[i]; }
  const mean = sum / data.length;
  const std = Math.sqrt(Math.max(0, sq / data.length - mean * mean));
  let edges = 0, n = 0;
  for (let y = 0; y + 1 < h; y++) for (let x = 0; x + 1 < w; x++) {
    const p = data[y * w + x];
    if (Math.abs(data[y * w + x + 1] - p) + Math.abs(data[(y + 1) * w + x] - p) > edgeGradient) edges++;
    n++;
  }
  return { std, edges: n ? edges / n : 0 };
}

export function isBlank(f: Frame, t = THRESHOLDS): boolean {
  const d = frameDetail(f, t.edgeGradient);
  return d.std < t.blankStdFloor && d.edges < t.blankEdgeFloor;
}

/** Difference hash: box-average to (size+1)×size, one bit per horizontal neighbour pair. */
export function dHash(f: Frame, size = 16): Uint8Array {
  const gw = size + 1, gh = size;
  const grid = new Float64Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const x0 = Math.floor((gx * f.w) / gw), x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * f.w) / gw));
    const y0 = Math.floor((gy * f.h) / gh), y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * f.h) / gh));
    let s = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += f.data[y * f.w + x];
    grid[gy * gw + gx] = s / ((x1 - x0) * (y1 - y0));
  }
  const bits = new Uint8Array(size * size);
  for (let y = 0; y < gh; y++) for (let x = 0; x < size; x++) bits[y * size + x] = grid[y * gw + x + 1] > grid[y * gw + x] ? 1 : 0;
  return bits;
}

export function hamming(a: Uint8Array, b: Uint8Array): number {
  invariant(a.length === b.length, 'hashes must be the same length');
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/**
 * Binary edge map: box-average to w×h, one bit per pixel whose |dx|+|dy| is over edgeGradient. At 160×90 it keeps
 * the shape of text lines, which dHash averages away, so two screens sharing one layout come apart here.
 */
export function edgeMap(f: Frame, w = THRESHOLDS.edgeMapW, h = THRESHOLDS.edgeMapH, edgeGradient = THRESHOLDS.edgeGradient): Uint8Array {
  invariant(f.data.length === f.w * f.h, 'frame data must be w*h luma bytes');
  const small = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor((x * f.w) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * f.w) / w));
    const y0 = Math.floor((y * f.h) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * f.h) / h));
    let s = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += f.data[yy * f.w + xx];
    small[y * w + x] = s / ((x1 - x0) * (y1 - y0));
  }
  const map = new Uint8Array(w * h);
  for (let y = 0; y + 1 < h; y++) for (let x = 0; x + 1 < w; x++) {
    const p = small[y * w + x];
    if (Math.abs(small[y * w + x + 1] - p) + Math.abs(small[(y + 1) * w + x] - p) > edgeGradient) map[y * w + x] = 1;
  }
  return map;
}

function dilate(m: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!m[y * w + x]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy;
      if (X >= 0 && Y >= 0 && X < w && Y < h) out[Y * w + X] = 1;
    }
  }
  return out;
}

/**
 * Edge overlap 0–1: the share of each map's edge pixels that land within 1 px of the other's, taking the lower of
 * the two directions. The 1-px tolerance absorbs scroll and scale jitter; plain IoU did not (help file).
 * Two maps with no edges are identical (1); one empty map against edges is 0.
 */
export function edgeOverlap(a: Uint8Array, b: Uint8Array, w = THRESHOLDS.edgeMapW, h = THRESHOLDS.edgeMapH): number {
  invariant(a.length === w * h && b.length === w * h, 'edge maps must both be w*h');
  const da = dilate(a, w, h), db = dilate(b, w, h);
  let na = 0, ha = 0, nb = 0, hb = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i]) { na++; if (db[i]) ha++; }
    if (b[i]) { nb++; if (da[i]) hb++; }
  }
  return Math.min(na ? ha / na : 1, nb ? hb / nb : 1);
}

// ── Code tier (pure over frames) ───────────────────────────────

export type CodeFinding = { check: 'blank' | 'repeat' | 'repeat-asset' | 'borrowed' | 'coverage' | 'silence'; severity: 'fail' | 'note'; t: number | null; message: string; shots?: number[] };

/** Borrowed screens: a shot whose asset shows a different feature than the one being narrated. */
export function borrowedFindings(shots: Shot[]): CodeFinding[] {
  return shots.flatMap((s, i) => s.feature && s.shows && s.feature !== s.shows
    ? [{ check: 'borrowed' as const, severity: 'fail' as const, t: s.start, shots: [i], message: `shot ${i + 1} ${s.start.toFixed(2)}–${s.end.toFixed(2)} s narrates "${s.feature}" over an asset showing "${s.shows}"${s.asset ? ` (${s.asset})` : ''}` }]
    : []);
}

/**
 * Blank frames: consecutive blank sample times merge into one finding. A run that starts at the first sample (a
 * fade-in from black) or, given `duration`, ends at the last one (a fade-out) is a note while the stretch from that
 * film edge to its farthest blank sample is at most fadeMax. A longer edge run, a run covering the whole film, and any
 * run inside the film fail.
 */
export function blankFindings(samples: { t: number; frame: Frame }[], t = THRESHOLDS, duration?: number): CodeFinding[] {
  const out: CodeFinding[] = [];
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const firstT = sorted[0]?.t, lastT = sorted[sorted.length - 1]?.t;
  let run: number[] = [];
  const flush = () => {
    if (!run.length) return;
    const a = run[0], b = run[run.length - 1];
    const d = run.length === 1 ? `${a.toFixed(2)} s` : `${a.toFixed(2)}–${b.toFixed(2)} s (${run.length} samples)`;
    const opening = a === firstT && a < t.sweepStep;
    const closing = duration !== undefined && b === lastT && duration - b <= t.sweepStep + 1e-9;
    const edge = opening && !closing ? { kind: 'opening fade-in', length: b } : closing && !opening ? { kind: 'closing fade-out', length: duration - a } : null;
    if (edge && edge.length <= t.fadeMax + 1e-9) {
      out.push({ check: 'blank', severity: 'note', t: a, message: `${edge.kind}: blank at ${d}, ${edge.length.toFixed(2)} s from the film's edge ≤ ${t.fadeMax} s — noted only` });
    } else {
      out.push({ check: 'blank', severity: 'fail', t: a, message: `blank or dead frame at ${d}${edge ? ` (${edge.kind} runs ${edge.length.toFixed(2)} s from the film's edge > ${t.fadeMax} s)` : ''}` });
    }
    run = [];
  };
  for (const s of sorted) {
    if (isBlank(s.frame, t)) run.push(s.t);
    else flush();
  }
  flush();
  return out;
}

/**
 * Repeats across beats. `hashes[i]` holds shot i's sample hashes; the pair distance is the closest pair of samples.
 * With `edges` (shot i's sample edge maps), a dHash hit fails only when the best-matching sample pair's edge overlap
 * reaches repeatEdgeOverlap; below it the shots share a layout but not content (different terminal screens), a note.
 * The first-and-last pair (an opening and closing card) is a note, never a fail.
 */
export function repeatFindings(shots: Shot[], hashes: Uint8Array[][], t = THRESHOLDS, edges?: Uint8Array[][]): CodeFinding[] {
  invariant(!edges || edges.length === shots.length, 'edge maps must be given for every shot');
  const out: CodeFinding[] = [];
  const last = shots.length - 1;
  const name = (i: number) => `shot ${i + 1} ${shots[i].start.toFixed(2)}–${shots[i].end.toFixed(2)} s${shots[i].label ? ` "${shots[i].label}"` : ''} [${shots[i].beat}]`;
  for (let i = 0; i < shots.length; i++) for (let j = i + 1; j < shots.length; j++) {
    if (shots[i].beat === shots[j].beat) continue;
    const bookend = i === 0 && j === last;
    let min = Infinity;
    for (const a of hashes[i] ?? []) for (const b of hashes[j] ?? []) min = Math.min(min, hamming(a, b));
    if (min <= t.repeatHamming) {
      let overlap: number | null = null;
      if (edges) {
        overlap = 0;
        for (const a of edges[i]) for (const b of edges[j]) overlap = Math.max(overlap, edgeOverlap(a, b, t.edgeMapW, t.edgeMapH));
      }
      const confirmed = overlap === null || overlap >= t.repeatEdgeOverlap;
      const evidence = `dHash distance ${min}/256 ≤ ${t.repeatHamming}${overlap === null ? '' : `, edge overlap ${overlap.toFixed(2)} ${confirmed ? '≥' : '<'} ${t.repeatEdgeOverlap}`}`;
      const why = bookend ? ' — opening/closing card pair, noted only' : !confirmed ? ' — same layout, different content, noted only' : '';
      out.push({ check: 'repeat', severity: bookend || !confirmed ? 'note' : 'fail', t: shots[j].start, shots: [i, j], message: `${name(j)} ${confirmed ? 'repeats' : 'resembles'} ${name(i)} (${evidence})${why}` });
    }
    const ai = shots[i].asset, aj = shots[j].asset;
    if (ai && aj && ai === aj) out.push({ check: 'repeat-asset', severity: bookend ? 'note' : 'fail', t: shots[j].start, shots: [i, j], message: `asset ${ai} is used under two beats: ${name(i)} and ${name(j)}` });
  }
  return out;
}

/** Coverage: every sentence overlaps a shot; no shot (except the first and last) sits under silence over maxSilence. */
export function coverageFindings(shots: Shot[], sentences: Sentence[], words: Word[], t = THRESHOLDS): CodeFinding[] {
  const out: CodeFinding[] = [];
  for (const s of sentences) {
    if (!shots.some((x) => Math.min(x.end, s.end) - Math.max(x.start, s.start) > 0)) out.push({ check: 'coverage', severity: 'fail', t: s.start, message: `sentence at ${s.start.toFixed(2)} s has no shot under it: "${s.text}"` });
  }
  shots.forEach((shot, i) => {
    if (i === 0 || i === shots.length - 1) return;
    const spans = words.filter((w) => w.end > shot.start && w.start < shot.end).map((w) => [Math.max(w.start, shot.start), Math.min(w.end, shot.end)] as const);
    let cursor = shot.start, longest = 0, at = shot.start;
    for (const [a, b] of spans) { if (a - cursor > longest) { longest = a - cursor; at = cursor; } cursor = Math.max(cursor, b); }
    if (shot.end - cursor > longest) { longest = shot.end - cursor; at = cursor; }
    if (longest > t.maxSilence) out.push({ check: 'silence', severity: 'fail', t: at, shots: [i], message: `shot ${i + 1}${shot.label ? ` "${shot.label}"` : ''} sits under ${longest.toFixed(2)} s of silence from ${at.toFixed(2)} s (max ${t.maxSilence} s)` });
  });
  return out;
}

// ── Judged tier ────────────────────────────────────────────────

/** The brief's 0–1 scale, carried on the judge's 1–5 integer scale. Score 4 maps to 0.7, so the pass bar is score ≥ 4. */
export const JUDGE_ANCHORS: Record<string, string> = {
  '1': '0.0 — unrelated or generic: nothing on screen is what the words describe (a different product, a blank or decorative frame)',
  '2': '0.4 — same product, different feature: a page or screen of the same app, but not the one the words name',
  '3': '0.55 — adjacent: a related screen that touches the topic, but the specific thing named is not the subject of the frame',
  '4': '0.7 — the right feature or page, but the specific element named is not visible or not legible at this framing',
  '5': '1.0 — the specific thing the words name (feature, page, command or result) is clearly shown and legible',
};
export const SCORE_TO_SCALE: Record<number, number> = { 1: 0, 2: 0.4, 3: 0.55, 4: 0.7, 5: 1 };

export function judgeRubric(words: string, brief: string | undefined): string {
  return [
    'This is one frame from a narrated product video, taken while the narrator says the words below.',
    `NARRATION OVER THIS SHOT: "${words}"`,
    ...(brief ? [`PRODUCT CONTEXT: ${brief}`] : []),
    'Question: does this frame visibly show the specific thing the narration is describing at this moment (a feature, page, command or result), or is it unrelated or generic? Name what the frame actually shows (page title, visible headings) and what the narration names, then compare. A frame from the same product that shows a different page or feature is NOT a match.',
    'Begin the reason with "LEGIBLE: yes", "LEGIBLE: no" or "LEGIBLE: n/a" for whether the named element can be read at this framing, then "SHOWS: <what the frame shows>". Do not use the shot label; it may be wrong.',
  ].join('\n');
}

export type ShotJudgment = { score: number | null; passed: boolean; unavailable: boolean; legible: 'yes' | 'no' | 'n/a' | 'unknown'; reason: string; seats: { provider: string; score: number; passed: boolean }[] };
export type JudgeFn = (png: string, rubric: string, anchors: Record<string, string>, threshold: number) => Promise<AssertResult>;

/** The production judge: Assay's vision panel (OpenAI + Anthropic), both vendors must pass. */
export const panelJudge: JudgeFn = (png, rubric, anchors, threshold) => judgeImageRubric(png, rubric, anchors, { threshold, suite: 'narration-match' });

/** One panel result to the 0–1 anchored scale. The shot score is the lowest seat's; a shot passes only when every seat passes. */
export function aggregateJudgment(r: AssertResult, pass = THRESHOLDS.judgePass): ShotJudgment {
  if (r.unavailable) return { score: null, passed: false, unavailable: true, legible: 'unknown', reason: r.reason, seats: [] };
  const panel = (r.judge as { panel?: { provider: string; score: number; reason?: string }[] } | undefined)?.panel;
  const seats = (panel ?? [{ provider: String((r.judge as { provider?: string } | undefined)?.provider ?? 'judge'), score: r.score }]).map((p) => {
    const raw = Math.round(p.score * 4 + 1);
    const scaled = SCORE_TO_SCALE[raw] ?? p.score;
    return { provider: p.provider, score: scaled, passed: scaled >= pass };
  });
  const legibles = [...r.reason.matchAll(/LEGIBLE:\s*(yes|no|n\/a)/gi)].map((m) => m[1].toLowerCase() as 'yes' | 'no' | 'n/a');
  const legible = legibles.length === 0 ? 'unknown' : legibles.includes('no') ? 'no' : legibles.every((l) => l === 'n/a') ? 'n/a' : 'yes';
  const score = Math.min(...seats.map((s) => s.score));
  return { score, passed: seats.every((s) => s.passed), unavailable: false, legible, reason: r.reason, seats };
}

// ── ffmpeg plumbing ────────────────────────────────────────────

const FFMPEG_MS = 300_000;

async function run(cmd: string[], timeoutMs = FFMPEG_MS): Promise<{ stdout: Uint8Array; stderr: string }> {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}: ${stderr.trim().split('\n').slice(-2).join(' ')}`);
  return { stdout: new Uint8Array(stdout), stderr };
}

export async function videoDuration(video: string): Promise<number> {
  const { stdout } = await run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], 30_000);
  const d = Number(new TextDecoder().decode(stdout).trim());
  if (!(d > 0)) throw new Error(`ffprobe could not read a duration from ${video}`);
  return d;
}

const GW = 320, GH = 180;

/** Every frame at `fps` as 320×180 luma, in one ffmpeg pass. Frame i sits at i / fps seconds. */
export async function gridFrames(video: string, fps: number): Promise<{ t: number; frame: Frame }[]> {
  const { stdout } = await run(['ffmpeg', '-v', 'error', '-i', video, '-vf', `fps=${fps},scale=${GW}:${GH},format=gray`, '-f', 'rawvideo', '-']);
  const size = GW * GH, n = Math.floor(stdout.length / size);
  return Array.from({ length: n }, (_, i) => ({ t: i / fps, frame: { w: GW, h: GH, data: stdout.subarray(i * size, (i + 1) * size) } }));
}

export async function sceneCuts(video: string, threshold: number): Promise<number[]> {
  const { stderr } = await run(['ffmpeg', '-v', 'info', '-i', video, '-vf', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-']);
  return [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
}

async function extractPng(video: string, t: number, out: string): Promise<void> {
  await run(['ffmpeg', '-v', 'error', '-y', '-ss', t.toFixed(3), '-i', video, '-frames:v', '1', '-vf', 'scale=1600:-2', out], 60_000);
}

function nearest(grid: { t: number; frame: Frame }[], t: number): Frame {
  invariant(grid.length > 0, 'frame grid is empty');
  const i = Math.max(0, Math.min(grid.length - 1, Math.round(t * (grid.length > 1 ? 1 / (grid[1].t - grid[0].t) : 1))));
  return grid[i].frame;
}

// ── The run ────────────────────────────────────────────────────

export type ShotReport = Shot & { index: number; words: string; judgment?: ShotJudgment };
export type Verdict = 'pass' | 'fail' | 'unavailable';
export type Report = {
  video: string; sha256: string; duration: number; verdict: Verdict; exit: 0 | 1 | 2;
  shots: ShotReport[]; code: CodeFinding[]; judged: boolean; receipt: string | null;
};

export type RunOptions = {
  video: string; words: Word[]; shots?: Shot[]; brief?: string; codeOnly?: boolean;
  judge?: JudgeFn; concurrency?: number; writeReceiptFile?: boolean; thresholds?: typeof THRESHOLDS;
  onProgress?: (msg: string) => void;
};

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

export async function narrationMatch(o: RunOptions): Promise<Report> {
  const t = o.thresholds ?? THRESHOLDS;
  const video = resolve(o.video);
  if (!existsSync(video)) throw new UsageError(`video not found: ${o.video}`);
  const started = performance.now();
  const duration = await videoDuration(video);
  const sentences = sentencesOf(o.words);
  const rawShots = o.shots ?? shotsFromCuts(await sceneCuts(video, t.sceneThreshold), duration, t);
  const shots = assignBeats(rawShots.map((s) => ({ ...s, end: Math.min(s.end, duration) })).filter((s) => s.end > s.start), sentences);
  o.onProgress?.(`${shots.length} shots, ${sentences.length} sentences, ${duration.toFixed(1)} s`);

  // Code tier: one 4 fps luma pass feeds the blank sweep (every sweepStep, and every frame near the film's edges so a
  // fade is measured to the quarter second), each shot's rest, and its hash and edge-map samples.
  const grid = await gridFrames(video, 4);
  const edgeZone = t.fadeMax + t.sweepStep;
  const sweep = grid.filter((g) => Math.abs(g.t / t.sweepStep - Math.round(g.t / t.sweepStep)) < 1e-6 || g.t < edgeZone || g.t > duration - edgeZone);
  const restSamples = shots.map((s) => ({ t: restOf(s), frame: nearest(grid, restOf(s)) }));
  const blanks = blankFindings([...sweep, ...restSamples.filter((r) => !sweep.some((g) => Math.abs(g.t - r.t) < 0.13))], t, duration);
  const shotFrames = shots.map((s) => [0.25, 0.5, 0.75].map((f) => nearest(grid, s.start + (s.end - s.start) * f)));
  const hashes = shotFrames.map((fs) => fs.map((f) => dHash(f)));
  const edges = shotFrames.map((fs) => fs.map((f) => edgeMap(f, t.edgeMapW, t.edgeMapH, t.edgeGradient)));
  const code = [...blanks, ...repeatFindings(shots, hashes, t, edges), ...borrowedFindings(shots), ...coverageFindings(shots, sentences, o.words, t)];

  const reports: ShotReport[] = shots.map((s, index) => ({ ...s, index, words: wordsOver(s, o.words, t.wordPad) }));
  let judged = false;
  if (!o.codeOnly) {
    judged = true;
    const judge = o.judge ?? panelJudge;
    const work = mkdtempSync(join(tmpdir(), 'narration-match-'));
    try {
      await pool(reports, o.concurrency ?? 6, async (r) => {
        if (!r.words.trim()) return;
        const png = join(work, `shot-${String(r.index + 1).padStart(3, '0')}.png`);
        await extractPng(video, restOf(r), png);
        // The threshold handed to the panel is the normalized integer bar: score 4 of 5 = 0.75.
        const res = await judge(png, judgeRubric(r.words, o.brief), JUDGE_ANCHORS, 0.75);
        r.judgment = aggregateJudgment(res, t.judgePass);
        o.onProgress?.(`shot ${r.index + 1}/${reports.length}: ${r.judgment.unavailable ? 'unavailable' : `${r.judgment.score} ${r.judgment.passed ? 'pass' : 'MISS'}`}`);
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  const codeFail = code.some((f) => f.severity === 'fail');
  const judgedFail = reports.some((r) => r.judgment && !r.judgment.unavailable && !r.judgment.passed);
  const judgedUnavailable = reports.some((r) => r.judgment?.unavailable);
  const verdict: Verdict = codeFail || judgedFail ? 'fail' : judgedUnavailable ? 'unavailable' : 'pass';
  const sha256 = await sha256File(video);
  const receipt = o.writeReceiptFile === false ? null : writeNarrationReceipt({ video, sha256, shots: reports, code, judged, words: o.words, brief: o.brief, thresholds: t, durationMs: performance.now() - started });
  return { video, sha256, duration, verdict, exit: verdict === 'fail' ? 1 : verdict === 'unavailable' ? 2 : 0, shots: reports, code, judged, receipt };
}

/** The receipt: code fails block; judged misses are PROVISIONAL flags (the judge is not calibrated against labels). */
export function buildNarrationReceipt(a: { video: string; sha256: string; size: number; mtimeMs: number; shots: ShotReport[]; code: CodeFinding[]; judged: boolean; words: Word[]; brief?: string; thresholds: typeof THRESHOLDS; durationMs: number }): AssayReceipt {
  const findings: ProofFinding[] = [];
  for (const f of a.code) if (f.severity === 'fail') findings.push({ check: `narration-match:${f.check}`, tier: 'code', severity: 'fail', message: f.message, t: f.t });
  let passed = 0;
  for (const check of ['blank', 'repeat', 'borrowed', 'coverage'] as const) {
    const hit = a.code.some((f) => f.severity === 'fail' && (f.check === check || (check === 'repeat' && f.check === 'repeat-asset') || (check === 'coverage' && f.check === 'silence')));
    if (!hit) passed++;
  }
  for (const s of a.shots) {
    const j = s.judgment;
    if (!j) continue;
    const at = `shot ${s.index + 1} ${s.start.toFixed(2)}–${s.end.toFixed(2)} s`;
    if (j.unavailable) findings.push({ check: `narration-match:shot-${s.index + 1}`, tier: 'judge', severity: 'unavailable', message: `${at}: ${j.reason}`, t: restOf(s) });
    else if (!j.passed) findings.push({ check: `narration-match:shot-${s.index + 1}`, tier: 'judge', severity: 'flag', earned: false, probability: j.score, message: `PROVISIONAL ${at} score ${j.score} legible ${j.legible} — words "${s.words}" — ${j.reason}`.slice(0, 2000), t: restOf(s) });
    else passed++;
  }
  const { verdict, counts } = deriveVerdict(findings, passed, ASSAY_RECEIPT_SCHEMA, 0);
  const ran_at = new Date().toISOString();
  const narrationText = a.words.map((w) => `${w.start.toFixed(3)}:${w.text}`).join(' ');
  return {
    schema: ASSAY_RECEIPT_SCHEMA, artifact: a.video, sha256: a.sha256, size: a.size, mtimeMs: a.mtimeMs, kind: 'video',
    ran_at, run_id: randomUUID(), duration_ms: Math.round(a.durationMs), checks_file: null,
    profile: ['narration-match:code', ...(a.judged ? ['narration-match:judge(provisional)'] : ['narration-match:code-only'])],
    verdict, counts, findings, opt_outs: [], sampled_times: a.shots.map(restOf),
    brief_sha256: a.brief ? createHash('sha256').update(a.brief).digest('hex') : null,
    ideal_state: { kind: 'ask', sha256: createHash('sha256').update(narrationText + (a.brief ?? '')).digest('hex') },
    check_set: { version: createHash('sha256').update(JSON.stringify({ t: a.thresholds, shots: a.shots.map(({ start, end, label, asset, beat, feature, shows }) => ({ start, end, label, asset, beat, feature, shows })) })).digest('hex'), source: null },
    evaluators: { 'narration-match': NARRATION_MATCH_VERSION, ...(a.judged ? { judge: 'VisionJudge panel (openai+anthropic), unearned' } : {}) },
    destination: 'none', verdict_at_boundary: { verdict, counts, findings: findings.length, at: ran_at },
  };
}

function writeNarrationReceipt(a: Omit<Parameters<typeof buildNarrationReceipt>[0], 'size' | 'mtimeMs'>): string {
  const st = statSync(a.video);
  return writeReceipt(buildNarrationReceipt({ ...a, size: st.size, mtimeMs: st.mtimeMs }));
}

// ── CLI ────────────────────────────────────────────────────────

export function formatReport(r: Report): string {
  const lines = [`NarrationMatch ${NARRATION_MATCH_VERSION} — ${r.video}`, `verdict: ${r.verdict.toUpperCase()} (exit ${r.exit})${r.judged ? ' · judged tier PROVISIONAL (uncalibrated)' : ' · code tier only'}`, ''];
  lines.push('Code tier:');
  if (!r.code.length) lines.push('  (no findings)');
  for (const f of r.code) lines.push(`  ${f.severity === 'fail' ? 'FAIL' : 'note'} ${f.check.padEnd(12)} ${f.message}`);
  lines.push('', 'Shots:', '  #   time            score  leg  ok    label / words');
  for (const s of r.shots) {
    const j = s.judgment;
    const score = !j ? '  -  ' : j.unavailable ? ' n/a ' : j.score!.toFixed(2).padStart(5);
    const ok = !j ? (s.words ? '-' : 'silent') : j.unavailable ? 'UNAV' : j.passed ? 'pass' : 'MISS';
    lines.push(`  ${String(s.index + 1).padStart(2)}  ${s.start.toFixed(2).padStart(6)}–${s.end.toFixed(2).padEnd(6)}  ${score}  ${(j?.legible ?? '-').padEnd(4)} ${ok.padEnd(5)} ${s.label ?? ''} [${s.beat}]`);
    if (s.words) lines.push(`        words: "${s.words}"`);
    if (j && !j.passed) lines.push(`        why: ${j.reason.slice(0, 400)}`);
  }
  if (r.receipt) lines.push('', `receipt: ${r.receipt}`);
  return lines.join('\n');
}

const USAGE = `NarrationMatch — judge a narrated video shot by shot against its narration

  bun skills/Assay/Tools/NarrationMatch.ts --video <mp4> (--srt <file> | --words <json>) [--shots <json>] [--offsets <json>]
      [--brief <text|file>] [--code-only] [--concurrency N] [--json]

Exit 0 pass · 1 fail · 2 judge unavailable · 64 usage. See NarrationMatch.help.md.`;

export async function main(argv: string[]): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({ args: argv, options: {
      video: { type: 'string' }, srt: { type: 'string' }, words: { type: 'string' }, shots: { type: 'string' }, offsets: { type: 'string' },
      brief: { type: 'string' }, 'code-only': { type: 'boolean' }, json: { type: 'boolean' }, concurrency: { type: 'string' }, help: { type: 'boolean' },
    } }));
  } catch (e) { console.error(`${(e as Error).message}\n\n${USAGE}`); return 64; }
  if (values.help) { console.log(USAGE); return 0; }
  try {
    if (typeof values.video !== 'string') throw new UsageError('--video is required');
    if ((typeof values.srt === 'string') === (typeof values.words === 'string')) throw new UsageError('give exactly one of --srt or --words');
    const readJson = (f: string) => { if (!existsSync(f)) throw new UsageError(`not found: ${f}`); return JSON.parse(readFileSync(f, 'utf8')); };
    const shotsIn = typeof values.shots === 'string' ? shotsFromJson(readJson(values.shots)) : undefined;
    let offsets: Record<string, number> | undefined = shotsIn?.offsets;
    if (typeof values.offsets === 'string') { const j = readJson(values.offsets); offsets = j && typeof j.offsets === 'object' ? j.offsets : j; }
    const words = typeof values.srt === 'string'
      ? wordsFromSrt(readFileSync(values.srt, 'utf8'))
      : wordsFromJson(readJson(values.words as string), dirname(resolve(values.words as string)), offsets);
    if (!words.length) throw new UsageError('narration has no words');
    const brief = typeof values.brief === 'string' ? (existsSync(values.brief) ? readFileSync(values.brief, 'utf8') : values.brief) : undefined;
    const concurrency = typeof values.concurrency === 'string' ? Number(values.concurrency) : undefined;
    if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency > 0)) throw new UsageError('--concurrency must be a positive integer');
    const r = await narrationMatch({ video: values.video, words, shots: shotsIn?.shots, brief, codeOnly: values['code-only'] === true, concurrency,
      onProgress: values.json ? undefined : (m) => console.error(m) });
    console.log(values.json ? JSON.stringify(r, null, 2) : formatReport(r));
    return r.exit;
  } catch (e) {
    if (e instanceof UsageError || e instanceof SyntaxError) { console.error(`${e.message}\n\n${USAGE}`); return 64; }
    console.error(`NarrationMatch failed: ${(e as Error).message}`);
    return 2;
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
