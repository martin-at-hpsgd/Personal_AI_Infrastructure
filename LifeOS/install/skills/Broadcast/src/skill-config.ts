/**
 * Broadcast - the skill's USER config.
 *
 * Account-bound values (Omny program and playlist ids, episode settings, the
 * newsletter-share settings) live outside the skill tree, in a release-excluded
 * Config.md under the LifeOS USER tree. The skill ships generic and reads them at
 * runtime; every caller supplies its own default for an absent key.
 *
 * Format: one `key = value` per line, anywhere in the file (first match wins).
 * Field reference: Setup.md.
 */

import { existsSync, readFileSync } from 'fs';
import { lifeosPath } from '../../../LIFEOS/TOOLS/Paths';

export const SKILL_CONFIG_PATH = lifeosPath('USER', 'CUSTOMIZATIONS', 'SKILLS', 'Broadcast', 'Config.md');

const KEY_PATTERN = /^[a-z0-9_]+$/;

/** One `key = value` line from Config.md, or undefined when the file or the key is absent. */
export function readSkillConfig(key: string, configPath: string = SKILL_CONFIG_PATH): string | undefined {
  if (!KEY_PATTERN.test(key)) throw new Error(`readSkillConfig: invalid key ${JSON.stringify(key)}`);
  if (!existsSync(configPath)) return undefined;
  const text = readFileSync(configPath, 'utf-8');
  const value = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm'))?.[1]?.trim();
  return value ? value : undefined;
}

/** A boolean key: `true`/`false` (any case). Absent → the default; anything else throws, naming the key. */
export function readSkillConfigBool(key: string, fallback: boolean, configPath: string = SKILL_CONFIG_PATH): boolean {
  const raw = readSkillConfig(key, configPath);
  if (raw === undefined) return fallback;
  const v = raw.toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`${configPath}: ${key} must be true or false (got ${JSON.stringify(raw)})`);
}

/**
 * Whether the bundled style rules are on (`house_style = true`). Off by default: a fresh install posts text as
 * written. On, `post` and `edit` refuse an unstyled LinkedIn post unless `--linkedin-plain` is passed, and the
 * intents apply their opinionated style rules (Setup.md § Fill in).
 */
export function houseStyleOn(configPath: string = SKILL_CONFIG_PATH): boolean {
  return readSkillConfigBool('house_style', false, configPath);
}

/** Whether a video-anchored broadcast gets its follow-up (X embed reply, LinkedIn link comment) without a separate ask. Off by default. */
export function videoFollowupOn(configPath: string = SKILL_CONFIG_PATH): boolean {
  return readSkillConfigBool('video_followup', false, configPath);
}
