/**
 * Suite-scoped pixel rubric routing. Absence means the two-vendor panel (OpenAI + Anthropic), never Google:
 * the principal ruled on 2026-10-08 that Google never judges art. Google is a trusted vendor for private material
 * since 2026-10-10, so an explicit `google` entry passes the egress guard like Anthropic and OpenAI.
 * Configuration is never egress consent.
 */
import { readFileSync } from 'node:fs';
import { lifeosPath } from '../Paths.ts';

export type VisionRubricConfig =
  | { provider: 'panel' }
  | { provider: 'anthropic' }
  | { provider: 'openai'; level: 'medium'; fallback?: 'google' }
  | { provider: 'google' };
export interface VisionJudgeConfig { version: 1; suites: Record<string, VisionRubricConfig> }

/** What every suite without an entry gets: OpenAI and Anthropic both judge, and a case passes only when both pass. */
export const DEFAULT_VISION_JUDGE: VisionRubricConfig = Object.freeze({ provider: 'panel' }) as VisionRubricConfig;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseVisionJudgeConfig(value: unknown): VisionJudgeConfig {
  if (!object(value) || value.version !== 1 || !object(value.suites) || Object.keys(value).some((k) => !['version', 'suites'].includes(k))) throw new Error('invalid vision judge config: expected version 1 and suites');
  for (const [suite, entry] of Object.entries(value.suites)) {
    if (!suite.trim() || !object(entry)) throw new Error('invalid vision judge suite config');
    const only = (...keys: string[]) => Object.keys(entry).every((k) => keys.includes(k));
    if ((entry.provider === 'panel' || entry.provider === 'anthropic' || entry.provider === 'google') && only('provider')) continue;
    if (entry.provider === 'openai' && entry.level === 'medium' && (entry.fallback === undefined || entry.fallback === 'google') && only('provider', 'level', 'fallback')) continue;
    throw new Error('invalid vision judge provider: panel, anthropic, OpenAI medium (optional Google fallback), or Google required');
  }
  return value as unknown as VisionJudgeConfig;
}

export function resolveVisionJudge(suite?: string, path = lifeosPath('USER', 'CONFIG', 'vision-judge.json')): VisionRubricConfig {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_VISION_JUDGE };
    throw new Error('vision judge configuration unavailable');
  }
  const config = parseVisionJudgeConfig(JSON.parse(text));
  const entry = suite && Object.hasOwn(config.suites, suite) ? config.suites[suite] : undefined;
  return entry ?? { ...DEFAULT_VISION_JUDGE };
}
