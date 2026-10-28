/**
 * EnvKeys.ts — named keys from the process env, falling back to the install's own env file
 * (LIFEOS/TOOLS/Paths getEnvPath, honours CLAUDE_CONFIG_DIR).
 *
 * For a child CLI that reads its config from process.env when the parent has no shell
 * profile (the launchd tick, the STATVS collect run). Moved out of LIFEOS/VIGIL/Emit.ts
 * (STATVS migration design §1.3) so neither STATVS nor the adapters import Vigil for it;
 * Emit.ts re-exports `envKeys` for its existing callers.
 *
 * Read-only. Values are returned to the caller and never printed.
 * @version 1.0.0
 */
import { readFileSync } from "node:fs";
import { getEnvPath } from "../Paths";

/** Every KEY=value line of the install's env file; an unreadable file is empty. */
export function envFileValues(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(getEnvPath(), "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  } catch { /* no env file: nothing to add */ }
  return out;
}

/** Named keys only, process env first, then the env file; absent keys are left out. */
export function envKeys(keys: string[]): Record<string, string> {
  const fileEnv = envFileValues();
  return Object.fromEntries(keys.flatMap((k) => {
    const v = process.env[k] ?? fileEnv[k];
    return v ? [[k, v]] : [];
  }));
}
