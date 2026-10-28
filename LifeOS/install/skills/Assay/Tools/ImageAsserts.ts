#!/usr/bin/env bun
/**
 * ImageAsserts — deterministic image checks for the visual eval lane.
 *
 * Same philosophy as text Assertions.ts: fast, objective, reproducible, zero
 * model calls — these catch the mechanical failure classes (wrong dimensions,
 * light background where the ground must be dark, garbled AI-rendered text)
 * before any judge spends a token. All types accept `not-` negation.
 *
 * Types:
 *   dimensions      value "1280x720" — exact WxH
 *   min-width       threshold px       min-height  threshold px
 *   aspect          value "16:9", 1% tolerance
 *   format          value png|jpeg|webp (as identified, not by extension)
 *   max-bytes       threshold
 *   luminance-max   threshold 0..1 (mean gray — dark grounds score low)
 *   luminance-min   threshold 0..1
 *   ocr-contains    value string (tesseract; case-insensitive)
 *   ocr-word-ratio  threshold 0..1 — fraction of OCR'd words (≥3 chars) found in
 *                   the system dictionary; the deterministic garbled-text catch.
 *                   A signature corner is masked before OCR, as the install
 *                   sets it (or disables it with false) in `ocr_signature_mask` of
 *                   <configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Assay/config.json.
 *
 * Tool contract: magick + tesseract required — an unavailable tool is an ERROR
 * result, never a silent pass (unavailable-verifier-means-DEFER doctrine).
 */

import { existsSync, statSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssertResult } from './Assertions.ts';
import { assayUserDir } from '../../../LIFEOS/TOOLS/Paths.ts';

/** Fractions of width and height where the masked signature corner starts; `false` disables the mask. */
export type SignatureMask = { x0: number; y0: number } | false;

export function assayConfigPath(): string {
  return join(assayUserDir(), 'config.json');
}

/**
 * Reads `ocr_signature_mask` from the Assay USER config. An absent file, an absent key or a malformed
 * value is an error naming the file and key, never a silent default (the shipped template carries the key).
 */
export function signatureMask(path = assayConfigPath()): SignatureMask {
  if (!existsSync(path)) throw new Error(`${path}: missing; set ocr_signature_mask (false, or {"x0": 0..1, "y0": 0..1}) there`);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`${path}: not valid JSON (key ocr_signature_mask)`); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path}: must be a JSON object carrying key ocr_signature_mask (false, or {"x0": 0..1, "y0": 0..1})`);
  }
  const cfg = parsed as Record<string, unknown>;
  if (!('ocr_signature_mask' in cfg)) throw new Error(`${path}: key ocr_signature_mask is missing; set it to false or {"x0": 0..1, "y0": 0..1}`);
  const v = cfg.ocr_signature_mask as unknown;
  if (v === false) return false;
  const o = v as { x0?: unknown; y0?: unknown } | null;
  const ok = (n: unknown) => typeof n === 'number' && n >= 0 && n < 1;
  if (!o || typeof o !== 'object' || !ok(o.x0) || !ok(o.y0)) {
    throw new Error(`${path}: ocr_signature_mask must be false or {"x0": 0..1, "y0": 0..1}`);
  }
  return { x0: o.x0 as number, y0: o.y0 as number };
}

export interface ImageAssertion {
  type: string;
  value?: string;
  threshold?: number;
  weight?: number;
  required?: boolean; // deterministic defaults true; judged checks default false
}

const DICT = '/usr/share/dict/words';
let dictWords: Set<string> | null = null;

/**
 * The word list behind ocr-word-ratio, one word per line. A missing or empty list is an unavailable verifier, never an
 * empty set: with no words to match, every rendered word would read as garbled and the image would fail on a defect
 * it does not have. A machine without /usr/share/dict/words points LIFEOS_OCR_DICTIONARY at any such list.
 */
export function loadDictionary(path: string): Set<string> {
  if (!existsSync(path)) throw new Error(`OCR word dictionary not found at ${path}; install one or set LIFEOS_OCR_DICTIONARY to a word list`);
  const words = readFileSync(path, 'utf-8').split('\n').map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (words.length === 0) throw new Error(`OCR word dictionary at ${path} is empty`);
  return new Set(words);
}

function dict(): Set<string> {
  return (dictWords ??= loadDictionary(process.env.LIFEOS_OCR_DICTIONARY || DICT));
}

async function run(cmd: string[]): Promise<{ ok: boolean; out: string }> {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  return { ok: code === 0, out: out.trim() };
}

interface ImageMeta { width: number; height: number; format: string; bytes: number; luminance: number }

export async function imageMeta(file: string): Promise<ImageMeta> {
  if (!existsSync(file)) throw new Error(`image not found: ${file}`);
  const id = await run(['magick', 'identify', '-format', '%w %h %m', file]);
  if (!id.ok) throw new Error(`magick identify failed on ${file}`);
  const [w, h, fmt] = id.out.split(' ');
  const lum = await run(['magick', file, '-colorspace', 'gray', '-format', '%[fx:mean]', 'info:']);
  if (!lum.ok) throw new Error(`magick luminance failed on ${file}`);
  return { width: parseInt(w), height: parseInt(h), format: fmt.toLowerCase(), bytes: statSync(file).size, luminance: parseFloat(lum.out) };
}

let ocrCache = new Map<string, string>();
export async function ocrText(file: string): Promise<string> {
  if (ocrCache.has(file)) return ocrCache.get(file)!;
  const r = await run(['tesseract', file, 'stdout']);
  if (!r.ok) throw new Error(`tesseract failed on ${file}`);
  ocrCache.set(file, r.out);
  return r.out;
}

/**
 * OCR with the signature corner blanked (`signatureMask()`). A cursive
 * signature stamp reads as a non-word to tesseract, and that one non-word
 * alone zeroes the word ratio of an otherwise text-free image (2026-09-24:
 * signed images failed the gate until the corner was masked).
 */
export async function ocrTextUnsigned(file: string): Promise<string> {
  const mask = signatureMask();
  if (mask === false) return ocrText(file);
  const key = `${file}#unsigned@${mask.x0},${mask.y0}`;
  if (ocrCache.has(key)) return ocrCache.get(key)!;
  const { width, height } = await imageMeta(file);
  const masked = `${tmpdir()}/imageasserts-unsigned-${process.pid}-${ocrCache.size}.png`;
  const x0 = Math.floor(width * mask.x0), y0 = Math.floor(height * mask.y0);
  const m = await run(['magick', file, '-background', 'white', '-alpha', 'remove', '-fill', 'white', '-draw', `rectangle ${x0},${y0} ${width},${height}`, masked]);
  if (!m.ok) throw new Error(`magick signature mask failed on ${file}`);
  try {
    const r = await run(['tesseract', masked, 'stdout']);
    if (!r.ok) throw new Error(`tesseract failed on ${file}`);
    ocrCache.set(key, r.out);
    return r.out;
  } finally { rmSync(masked, { force: true }); }
}

export async function evaluateImageAssert(file: string, a: ImageAssertion): Promise<AssertResult> {
  const weight = a.weight ?? 1;
  const negated = a.type.startsWith('not-');
  const base = negated ? a.type.slice(4) : a.type;
  let passed = false;
  let reason = '';
  try {
    const m = await imageMeta(file);
    switch (base) {
      case 'dimensions': {
        const [ew, eh] = (a.value ?? '').split('x').map(Number);
        passed = m.width === ew && m.height === eh;
        reason = `${m.width}x${m.height} vs ${a.value}`;
        break;
      }
      case 'min-width': passed = m.width >= (a.threshold ?? 0); reason = `width ${m.width}`; break;
      case 'min-height': passed = m.height >= (a.threshold ?? 0); reason = `height ${m.height}`; break;
      case 'aspect': {
        const [aw, ah] = (a.value ?? '').split(':').map(Number);
        const want = aw / ah;
        const got = m.width / m.height;
        passed = Math.abs(got - want) / want <= 0.01;
        reason = `aspect ${got.toFixed(3)} vs ${want.toFixed(3)}`;
        break;
      }
      case 'format': passed = m.format === (a.value ?? '').toLowerCase().replace('jpg', 'jpeg'); reason = `format ${m.format}`; break;
      case 'max-bytes': passed = m.bytes <= (a.threshold ?? Infinity); reason = `${m.bytes} bytes`; break;
      case 'luminance-max': passed = m.luminance <= (a.threshold ?? 1); reason = `mean luminance ${m.luminance.toFixed(3)}`; break;
      case 'luminance-min': passed = m.luminance >= (a.threshold ?? 0); reason = `mean luminance ${m.luminance.toFixed(3)}`; break;
      case 'ocr-contains': {
        const t = await ocrText(file);
        passed = t.toLowerCase().includes((a.value ?? '').toLowerCase());
        reason = passed ? `OCR contains "${a.value}"` : `OCR missing "${a.value}"`;
        break;
      }
      case 'ocr-word-ratio': {
        const words = (await ocrTextUnsigned(file)).toLowerCase().match(/[a-z]{3,}/g) ?? [];
        if (words.length === 0) { passed = true; reason = 'no OCR words (no rendered text to garble)'; break; }
        const known = words.filter((w) => dict().has(w)).length;
        const ratio = known / words.length;
        passed = ratio >= (a.threshold ?? 0.7);
        reason = `word ratio ${ratio.toFixed(2)} over ${words.length} words`;
        break;
      }
      default:
        return { type: a.type, passed: false, score: 0, reason: `unknown image assert: ${base}`, weight };
    }
  } catch (e) {
    // A thrown check (missing image, magick or tesseract failure, a missing required config key) is no verdict on the
    // image: unavailable, so ImageEvalRunner reports "verifier unavailable" instead of a measured quality failure.
    return { type: a.type, passed: false, score: 0, reason: `ERROR: ${(e as Error).message}`, weight, unavailable: true };
  }
  if (negated) { passed = !passed; reason = `NOT(${reason})`; }
  return { type: a.type, passed, score: passed ? 1 : 0, reason, weight };
}

// ---- self-test on generated fixtures -----------------------------------------
// Stage 1 of the header pipeline (Art Essay Step 8): the deterministic gate one
// candidate file has to pass before any judge sees it. Exit 0 = every check passed.
if (import.meta.main && Bun.argv[2] === 'check') {
  const file = Bun.argv[3];
  const flag = (name: string, dflt: number) => { const i = Bun.argv.indexOf(name); return i > -1 ? Number(Bun.argv[i + 1]) : dflt; };
  if (!file) { console.log('ImageAsserts check <file> [--min-width 1200] [--word-ratio 0.6]'); process.exit(1); }
  const checks: ImageAssertion[] = [{ type: 'min-width', threshold: flag('--min-width', 1200) }, { type: 'ocr-word-ratio', threshold: flag('--word-ratio', 0.6) }];
  const results = await Promise.all(checks.map((a) => evaluateImageAssert(file, a)));
  for (const r of results) console.log(`  ${r.passed ? '✅' : '❌'} ${r.type}: ${r.reason}`);
  process.exit(results.every((r) => r.passed) ? 0 : 1);
}

if (import.meta.main) {
  const tmp = process.env.IMAGEASSERTS_FIXTURE_DIR ?? '/tmp/imageasserts-fixtures';
  await run(['mkdir', '-p', tmp]);
  await run(['magick', '-size', '1280x720', 'xc:#101018', '-fill', 'white', '-pointsize', '72', '-gravity', 'center', '-annotate', '0', 'HELLO WORLD', `${tmp}/dark-text.png`]);
  await run(['magick', '-size', '400x400', 'xc:white', `${tmp}/light-square.png`]);
  const cases: { f: string; a: ImageAssertion; want: boolean }[] = [
    { f: 'dark-text.png', a: { type: 'dimensions', value: '1280x720' }, want: true },
    { f: 'dark-text.png', a: { type: 'aspect', value: '16:9' }, want: true },
    { f: 'dark-text.png', a: { type: 'luminance-max', threshold: 0.4 }, want: true },
    { f: 'light-square.png', a: { type: 'luminance-max', threshold: 0.4 }, want: false },
    { f: 'dark-text.png', a: { type: 'ocr-contains', value: 'hello world' }, want: true },
    { f: 'dark-text.png', a: { type: 'ocr-word-ratio', threshold: 0.7 }, want: true },
    { f: 'light-square.png', a: { type: 'not-ocr-contains', value: 'hello' }, want: true },
    { f: 'dark-text.png', a: { type: 'format', value: 'png' }, want: true },
  ];
  let pass = 0;
  for (const c of cases) {
    const r = await evaluateImageAssert(`${tmp}/${c.f}`, c.a);
    const ok = r.passed === c.want;
    if (ok) pass++;
    console.log(`${ok ? '✅' : '❌'} ${c.a.type} on ${c.f} → ${r.passed} (want ${c.want}) — ${r.reason}`);
  }
  console.log(`\n${pass}/${cases.length} image assert self-tests passed`);
  process.exit(pass === cases.length ? 0 : 1);
}
