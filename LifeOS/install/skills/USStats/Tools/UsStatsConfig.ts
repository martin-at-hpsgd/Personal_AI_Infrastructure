/**
 * UsStatsConfig.ts — reads the install's USStats extension:
 * <configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/USStats/Config.md
 *
 * Format: `key: value` lines (inside or outside a fenced block). Read-only.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getClaudeDir } from "../../../LIFEOS/TOOLS/Paths.ts";

export const CONFIG_PATH = join(getClaudeDir(), "LIFEOS/USER/CUSTOMIZATIONS/SKILLS/USStats/Config.md");

export function parseConfig(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.+?)\s*$/);
    if (m && !(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

export function readConfig(path: string = CONFIG_PATH): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseConfig(readFileSync(path, "utf8"));
}

/** Optional key: returns the configured value or the given fallback. */
export function configValue(key: string, fallback: string): string {
  return readConfig()[key] ?? fallback;
}

/** The almanac endpoint. Env USSTATS_DATA_URL wins; otherwise Config.md `data_url`. Fails loud when neither is set. */
export function dataUrl(): string {
  const env = process.env.USSTATS_DATA_URL;
  if (env) return env;
  const v = readConfig().data_url;
  if (!v) {
    throw new Error(
      `USStats: no almanac endpoint configured. Set key \`data_url\` in ${CONFIG_PATH} ` +
        `(or export USSTATS_DATA_URL). See skills/USStats/Setup.md.`,
    );
  }
  return v;
}
