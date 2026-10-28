/**
 * WorkflowsConfig — the one place that knows where the Workflows local config lives.
 *
 * Canonical path: ~/.config/workflows/config.yaml (M-36 / Workflows ISC-40).
 * Legacy path:    WORKFLOWS_LEGACY_CONFIG, when set: an install that kept its config at a
 *                 pre-rename location names that file there (`~` expands to the home
 *                 directory). Unset means no legacy location.
 *
 * `workflowsConfigPath()` returns the canonical path when that file exists. When only
 * the legacy file exists it warns once on stderr and returns the legacy path, so a
 * machine that has not migrated yet keeps working. When neither exists it returns the
 * canonical path, so callers' "config missing" messages name the right place.
 *
 * Read-only: nothing here writes state.
 *
 * @version 1.0.2
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function workflowsConfigCanonicalPath(home: string = homedir()): string {
  return join(home, ".config", "workflows", "config.yaml");
}

export function workflowsConfigLegacyPath(home: string = homedir(), env: Record<string, string | undefined> = process.env): string | null {
  const p = env.WORKFLOWS_LEGACY_CONFIG?.trim();
  if (!p) return null;
  return p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

let warned = false;

export function workflowsConfigPath(home: string = homedir(), env: Record<string, string | undefined> = process.env): string {
  const canonical = workflowsConfigCanonicalPath(home);
  if (existsSync(canonical)) return canonical;
  const legacy = workflowsConfigLegacyPath(home, env);
  if (legacy && existsSync(legacy)) {
    if (!warned) {
      warned = true;
      console.error(`workflows config: using legacy ${legacy}; move it to ${canonical}`);
    }
    return legacy;
  }
  return canonical;
}
