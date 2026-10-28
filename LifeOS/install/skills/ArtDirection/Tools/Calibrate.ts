#!/usr/bin/env bun
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { invariant } from '../../../LIFEOS/TOOLS/Invariant.ts';
import { lifeosUserDir } from '../../../LIFEOS/TOOLS/LifeosConfig.ts';
import { addLabel } from '../../../LIFEOS/TOOLS/lib/LabelStore.ts';
import { artDirectionUserDir } from './Critique.ts';

export interface CalibrationOptions { artifact: string; verdict: string | number; note: string }
export interface Label { artifact: string; sha256: string; mtime: string; verdict: number; note: string; date: string; medianAtLabel: unknown }
/** The install's keeper bar: a 1-10 verdict at or above it reads "pass" on the one label store. It is the
 * `keeper_verdict: N` line in the USER extension's Config.md; a missing file or key is an error naming both,
 * never a silent default bar. */
export function keeperVerdict(dir: string = artDirectionUserDir()): number {
  const file = join(dir, 'Config.md');
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`ArtDirection config missing: ${file} must carry the keeper_verdict key (for example "keeper_verdict: 7")`);
    throw error;
  }
  const match = text.match(/^keeper_verdict:[ \t]*(\S*)[ \t]*$/m);
  if (!match) throw new Error(`ArtDirection config ${file} has no keeper_verdict key (for example "keeper_verdict: 7")`);
  const bar = Number(match[1]);
  if (match[1] === '' || !Number.isInteger(bar) || bar < 1 || bar > 10) throw new Error(`keeper_verdict in ${file} must be an integer 1–10, got "${match[1]}"`);
  return bar;
}
export function calibrate(options: CalibrationOptions, deps: { labelsFile?: string; labelStore?: string; configDir?: string } = {}): Label {
  const verdict = typeof options.verdict === 'string' && options.verdict.trim() === '' ? NaN : Number(options.verdict);
  if (!Number.isInteger(verdict) || verdict < 1 || verdict > 10) throw new Error('Verdict must be an integer 1–10');
  if (typeof options.note !== 'string') throw new Error('Note must be a string');
  const artifact = resolve(options.artifact), info = statSync(artifact);
  if (!info.isFile()) throw new Error(`Artifact is not a file: ${artifact}`);
  const passAt = keeperVerdict(deps.configDir);
  const sha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex');
  let medianAtLabel: unknown = null;
  try {
    const critique: unknown = JSON.parse(readFileSync(join(dirname(artifact), 'Critique.json'), 'utf8'));
    if (typeof critique === 'object' && critique !== null && 'median' in critique) medianAtLabel = critique.median ?? null;
  } catch (error) { if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const label: Label = { artifact, sha256, mtime: info.mtime.toISOString(), verdict, note: options.note, date: new Date().toISOString(), medianAtLabel };
  const labelsFile = resolve(deps.labelsFile ?? join(lifeosUserDir(), 'CUSTOMIZATIONS', 'SKILLS', 'ArtDirection', 'labels.jsonl'));
  invariant(Number.isInteger(verdict) && verdict >= 1 && verdict <= 10, 'Calibration requires an integer verdict 1–10');
  mkdirSync(dirname(labelsFile), { recursive: true });
  invariant(Number.isInteger(label.verdict) && label.verdict >= 1 && label.verdict <= 10, 'Calibration label verdict is valid');
  appendFileSync(labelsFile, JSON.stringify(label) + '\n');
  // S6: the principal's verdict is a principal artifact label on the one label store (the old file stays readable, no longer the only copy).
  addLabel({ source: 'principal', kind: 'artifact', artifact_sha256: sha256, verdict: verdict >= passAt ? 'pass' : 'fail', note: `score ${verdict}/10${options.note.trim() ? `: ${options.note.trim()}` : ''}`, by: 'principal' }, deps.labelStore ? { path: deps.labelStore } : {});
  return label;
}
if (import.meta.main) {
  try {
    const { values: v } = parseArgs({ args: Bun.argv.slice(2), strict: true, options: { artifact: { type: 'string' }, verdict: { type: 'string' }, note: { type: 'string' } } });
    if (!v.artifact || v.verdict === undefined || v.note === undefined) throw new Error('Use --artifact <file> --verdict <1-10> --note "<principal\'s words>"');
    console.log(JSON.stringify(calibrate({ artifact: v.artifact, verdict: v.verdict, note: v.note })));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
