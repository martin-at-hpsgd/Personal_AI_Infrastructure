/**
 * Where v2 definitions and the run ledger live, and how a name becomes a path.
 *
 * Both locations are derived from this file's own position (never a home-path
 * literal) and each can be moved by one environment variable, which is how the
 * tests keep their runs out of the real ledger:
 *   LIFEOS_WORKFLOWS_DIR     definitions home (default LIFEOS/USER/WORKFLOWS)
 *   LIFEOS_WORKFLOWS_LEDGER  run ledger file   (default LIFEOS/MEMORY/STATE/workflows/runs.jsonl)
 */
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const LIFEOS_DIR = resolve(import.meta.dir, "..", "..");

/** A definition name: lowercase words joined by hyphens, the file stem of `<name>.workflow.yaml`. */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const DEFINITION_SUFFIX = ".workflow.yaml";

export function definitionsDir(): string {
  const override = process.env.LIFEOS_WORKFLOWS_DIR;
  return override && override.trim() ? resolve(override) : join(LIFEOS_DIR, "USER", "WORKFLOWS");
}

export function ledgerPath(): string {
  const override = process.env.LIFEOS_WORKFLOWS_LEDGER;
  return override && override.trim() ? resolve(override) : join(LIFEOS_DIR, "MEMORY", "STATE", "workflows", "runs.jsonl");
}

/** The append-only rename alias map (one `{from, to, at}` line per rename), beside the ledger so it moves with it. */
export function renameAliasPath(ledger: string = ledgerPath()): string {
  return join(dirname(ledger), "renames.jsonl");
}

/**
 * Per-run payload store (`artifacts/<run_id>/`) and definition snapshots (`definitions/<hash>.workflow.yaml`).
 * Both sit beside the ledger they belong to, so moving the ledger with LIFEOS_WORKFLOWS_LEDGER moves them too:
 * by default they are LIFEOS/MEMORY/STATE/workflows/artifacts and .../definitions.
 */
export function artifactsRoot(ledger: string = ledgerPath()): string {
  return join(dirname(ledger), "artifacts");
}

export function snapshotsRoot(ledger: string = ledgerPath()): string {
  return join(dirname(ledger), "definitions");
}

/**
 * Where a v2 action name is looked up: the personal directory first, then the system one (ISC-87).
 * Tests point both at temp directories with LIFEOS_WORKFLOWS_ACTIONS_PERSONAL / LIFEOS_WORKFLOWS_ACTIONS_SYSTEM.
 */
export function personalActionsDir(): string {
  const override = process.env.LIFEOS_WORKFLOWS_ACTIONS_PERSONAL;
  return override && override.trim() ? resolve(override) : join(LIFEOS_DIR, "USER", "CUSTOMIZATIONS", "WORKFLOWS", "ACTIONS");
}

export function systemActionsDir(): string {
  const override = process.env.LIFEOS_WORKFLOWS_ACTIONS_SYSTEM;
  return override && override.trim() ? resolve(override) : join(LIFEOS_DIR, "WORKFLOWS", "v1", "Actions");
}

/** True when the argument names a file rather than a definition in the definitions home. */
export function looksLikePath(ref: string): boolean {
  return ref.includes("/") || ref.endsWith(".yaml") || ref.endsWith(".yml");
}

export function pathForName(name: string, dir: string = definitionsDir()): string {
  return join(dir, `${name}${DEFINITION_SUFFIX}`);
}

/** The stem a `<name>.workflow.yaml` file must carry as its `name:`; null for any other file name. */
export function stemOf(path: string): string | null {
  const base = basename(path);
  return base.endsWith(DEFINITION_SUFFIX) ? base.slice(0, -DEFINITION_SUFFIX.length) : null;
}

export type Resolved = { ok: true; path: string } | { ok: false; error: string };

/** Resolves a CLI argument (a definition name or a file path) to an existing file. */
export function resolveDefinition(ref: string, cwd: string = process.cwd()): Resolved {
  if (!ref) return { ok: false, error: "A workflow name or path is required." };
  if (looksLikePath(ref)) {
    const path = isAbsolute(ref) ? ref : resolve(cwd, ref);
    return existsSync(path) ? { ok: true, path } : { ok: false, error: `No workflow file at ${path}.` };
  }
  if (!NAME_RE.test(ref)) return { ok: false, error: `"${ref}" is not a workflow name (lowercase letters, digits and hyphens).` };
  const path = pathForName(ref);
  return existsSync(path) ? { ok: true, path } : { ok: false, error: `No workflow named "${ref}" in ${definitionsDir()}.` };
}
