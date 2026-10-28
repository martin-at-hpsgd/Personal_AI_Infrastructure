/**
 * CalibrateTaste — the principal's taste profile for one Calibrate target.
 *
 * Calibrate sessions collect like/dislike labels with the principal's own
 * notes; the Distill intent turns them into Taste.json, where every
 * principle cites the label ids that support it. Judges read the rendered
 * profile: ArtDirection's Critique adds it to the rubric prompt when a brief
 * names `calibration: <target>`. Shared here because two skills consume it.
 *
 * Store: <USER>/CUSTOMIZATIONS/SKILLS/Calibrate/Targets/<target>/Taste.json
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lifeosUserDir } from '../LifeosConfig.ts';

export interface TastePrinciple { principle: string; evidence: string[] }
export interface Taste {
  target: string;
  updated: string;
  labels_hash: string;
  label_count: number;
  summary: string;
  likes: TastePrinciple[];
  dislikes: TastePrinciple[];
}

const TARGET_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function calibrateRoot(): string {
  return process.env.LIFEOS_CALIBRATE_DIR ?? join(lifeosUserDir(), 'CUSTOMIZATIONS', 'SKILLS', 'Calibrate');
}

export function assertTargetName(target: string): string {
  if (!TARGET_RE.test(target)) throw new Error(`Invalid target name "${target}": lowercase letters, digits and dashes`);
  return target;
}

export function targetDir(target: string): string { return join(calibrateRoot(), 'Targets', assertTargetName(target)); }
export function tastePath(target: string): string { return join(targetDir(target), 'Taste.json'); }

const nonempty = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;

/** Validates shape; with `knownIds`, every cited id must be a real label. */
export function parseTaste(x: unknown, knownIds?: Set<string>): Taste {
  if (typeof x !== 'object' || x === null) throw new Error('Taste must be an object');
  const t = x as Record<string, unknown>;
  if (!nonempty(t.target) || !nonempty(t.updated) || !nonempty(t.labels_hash) || !nonempty(t.summary)) throw new Error('Taste needs target, updated, labels_hash, summary');
  if (typeof t.label_count !== 'number' || !Number.isInteger(t.label_count) || t.label_count < 1) throw new Error('Taste label_count must be a positive integer');
  for (const side of ['likes', 'dislikes'] as const) {
    const list = t[side];
    if (!Array.isArray(list)) throw new Error(`Taste ${side} must be an array`);
    for (const p of list) {
      if (typeof p !== 'object' || p === null || !nonempty((p as TastePrinciple).principle)) throw new Error(`Taste ${side} entry needs a principle`);
      const ev = (p as TastePrinciple).evidence;
      if (!Array.isArray(ev) || ev.length === 0 || !ev.every(nonempty)) throw new Error(`Taste principle "${(p as TastePrinciple).principle}" cites no label ids`);
      if (knownIds) for (const id of ev) if (!knownIds.has(id)) throw new Error(`Taste principle "${(p as TastePrinciple).principle}" cites unknown label ${id}`);
    }
  }
  if ((t.likes as unknown[]).length + (t.dislikes as unknown[]).length === 0) throw new Error('Taste has no principles');
  return x as Taste;
}

export function loadTaste(target: string): Taste | null {
  const path = tastePath(target);
  if (!existsSync(path)) return null;
  return parseTaste(JSON.parse(readFileSync(path, 'utf8')));
}

/** A target's taste, or null when the name is not a valid target or has no profile. */
export function tasteFor(target: string | undefined): Taste | null {
  if (!target || !TARGET_RE.test(target)) return null;
  return loadTaste(target);
}

/** Text judges read taste appended to each judged assertion's instruction. */
export function withTasteValue(value: string, taste: Taste | null): string {
  return taste ? `${value}\n\n${renderTaste(taste)}` : value;
}

/** The block a judge reads. Label ids stay out: they mean nothing to a judge. */
export function renderTaste(taste: Taste): string {
  const lines = [
    `Principal taste, distilled from ${taste.label_count} artifacts the principal personally labeled (target ${taste.target}, ${taste.updated.slice(0, 10)}).`,
    'Where this conflicts with generic art-director taste, the principal\'s taste wins. It does not excuse visible craft defects.',
    `Summary: ${taste.summary}`,
  ];
  if (taste.likes.length) lines.push('The principal likes:', ...taste.likes.map(p => `- ${p.principle}`));
  if (taste.dislikes.length) lines.push('The principal dislikes:', ...taste.dislikes.map(p => `- ${p.principle}`));
  return lines.join('\n');
}
