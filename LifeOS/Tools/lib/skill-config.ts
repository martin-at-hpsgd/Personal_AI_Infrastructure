/**
 * The LifeOS skill's USER extension: `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/LifeOS/Config.md`.
 * Shared by ScaffoldUser (which template tree to copy from) and PulseHealth (which tree to audit against).
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function configPath(configRoot: string): string {
  return join(configRoot, "LIFEOS", "USER", "CUSTOMIZATIONS", "SKILLS", "LifeOS", "Config.md");
}

export function expandHome(p: string, home: string): string {
  return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

/**
 * Reads one key from a Config.md table: the row whose first cell is `` `key` ``, value taken from the
 * backticked start of the column headed `Value` (`| Key | Value |` puts it second, the usual layout).
 * A table whose header has no `Value` column yields nothing, so a template that documents keys in a
 * `Meaning | Example` table is never read as configuration. Returns undefined when absent.
 */
export function readConfigKey(configMd: string, key: string): string | undefined {
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  let valueCol = -1;
  let prevWasRow = false;
  for (const line of configMd.split("\n")) {
    const isRow = line.trim().startsWith("|");
    const row = isRow ? cells(line) : [];
    const isKeyRow = /^`[^`]+`$/.test(row[0] ?? "");
    if (isRow && !prevWasRow && !isKeyRow) {
      // A new table starts with a header row: find its Value column.
      valueCol = row.findIndex((c) => c.toLowerCase() === "value");
    } else if (isRow && !prevWasRow) {
      // A headerless table of `key` | `value` rows: the value is the second cell.
      valueCol = 1;
    }
    if (isKeyRow && valueCol > 0 && row[0] === `\`${key}\``) {
      const v = row[valueCol]?.match(/^`([^`]+)`/);
      if (v) return v[1]!.trim();
    }
    prevWasRow = isRow;
  }
  return undefined;
}

/**
 * `pulse_templates_dir` from Config.md, `~`-expanded and resolved, or undefined when the file or key
 * is absent. `from` names the file and key so a caller can say where a bad value came from.
 */
export function configuredTemplatesDir(configRoot: string, home: string): { dir: string; from: string } | undefined {
  const cfg = configPath(configRoot);
  if (!existsSync(cfg)) return undefined;
  const v = readConfigKey(readFileSync(cfg, "utf8"), "pulse_templates_dir");
  return v ? { dir: resolve(expandHome(v, home)), from: `${cfg} (pulse_templates_dir)` } : undefined;
}
