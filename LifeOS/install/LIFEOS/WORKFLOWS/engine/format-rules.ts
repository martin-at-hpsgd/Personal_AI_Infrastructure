/**
 * Pure rules the definition format applies beyond the v1 graph checks:
 * secret-shaped literals, cloud-only resources, trigger-context references,
 * artifact-ref fields, prompt files, Glance caller and SOP lookups.
 *
 * Nothing here runs a step. The only file reads are the ones a validation has
 * to make to answer "does this exist": the Glance caller registry, the SOP
 * directories, a prompt file under the definitions home.
 *
 * Uses Assay's judgment layer (LIFEOS/DOCUMENTATION/Assay/AssaySystem.md).
 */
import { existsSync, readdirSync, realpathSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadRegistry } from "../../ASSAY/Assay.ts";

const LIFEOS_DIR = resolve(import.meta.dir, "..", "..");

/* ── Secret-shaped literals (ISC-52) ────────────────────────────────────── */

/** Provider key prefixes and private-key armor: the shapes a credential has before anyone reads its value. */
const SECRET_PREFIXES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
];
const LONG_HEX = /\b[0-9a-fA-F]{40,}\b/;
const BASE64_RUN = /[A-Za-z0-9+/_-]{40,}={0,2}/g;

/** True when a run of base64-alphabet characters looks like a token rather than a word or a path. */
function tokenShaped(run: string): boolean {
  if (run.includes("//") || (run.match(/\//g)?.length ?? 0) > 3) return false; // a path
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run);
}

/** Why a string looks like a secret, or null. The reason names the shape, never the value. */
export function secretShape(value: string): string | null {
  for (const pattern of SECRET_PREFIXES) if (pattern.test(value)) return "a provider key or private-key shape";
  if (LONG_HEX.test(value)) return "a long hex token";
  for (const run of value.match(BASE64_RUN) ?? []) if (tokenShaped(run)) return "a long base64 token";
  return null;
}

/** Every string leaf under a value, with its dotted path. `$ref` targets are references, not literals. */
export function* stringLeaves(value: unknown, at: string): Generator<{ at: string; text: string }> {
  if (typeof value === "string") yield { at, text: value };
  else if (Array.isArray(value)) for (const [i, item] of value.entries()) yield* stringLeaves(item, `${at}.${i}`);
  else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "$ref") continue;
      yield* stringLeaves(child, `${at}.${key}`);
    }
  }
}

/* ── Resources (ISC-42) ─────────────────────────────────────────────────── */

export const CLOUD_ONLY_KINDS = ["d1", "queue", "do", "r2"] as const;
const RESOURCE_RE = /^(?:(?:d1|queue|do|r2):[A-Za-z0-9][A-Za-z0-9_.-]{0,63}|[A-Z][A-Z0-9_]{1,63})$/;

/** A secret NAME as a definition declares it (ISC-33, ISC-70): upper-case env-style, never a value. */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** A resource declaration: `d1:<name>`, `queue:<name>`, `do:<class>`, `r2:<bucket>`, or a bare SECRET_NAME. */
export const isResource = (value: string): boolean => RESOURCE_RE.test(value);
export const isCloudOnly = (resource: string): boolean => CLOUD_ONLY_KINDS.some(kind => resource.startsWith(`${kind}:`));

/* ── Trigger context (ISC-56) ───────────────────────────────────────────── */

/** The fields a run's trigger context carries, by trigger kind. */
export const TRIGGER_FIELDS: Record<string, readonly string[]> = {
  manual: ["type", "occurrence_key", "run_id"],
  schedule: ["type", "scheduled_for", "occurrence_key", "run_id"],
  once: ["type", "scheduled_for", "occurrence_key", "run_id"],
  interval: ["type", "scheduled_for", "occurrence_key", "run_id"],
  event: ["type", "occurrence_key", "run_id"],
  after: ["type", "occurrence_key", "run_id", "upstream_run_id"],
  queue: ["type", "occurrence_key", "run_id"],
};
export const ALL_TRIGGER_FIELDS = ["type", "scheduled_for", "occurrence_key", "run_id", "upstream_run_id"] as const;

/** The reserved input key the compiled v1 graph reads trigger context from (`trigger.<f>` becomes `input.__trigger.<f>`). */
export const TRIGGER_INPUT_KEY = "__trigger";

export function isTriggerRef(ref: unknown): ref is string {
  return typeof ref === "string" && (ref === "trigger" || ref.startsWith("trigger."));
}

/** Each `$ref` string under a value, with the dotted path of the mapping that holds it. */
export function* refsUnder(value: unknown, at: string): Generator<{ at: string; ref: string }> {
  if (Array.isArray(value)) for (const [i, item] of value.entries()) yield* refsUnder(item, `${at}.${i}`);
  else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === "string" && Object.keys(record).length === 1) yield { at, ref: record.$ref };
    else for (const [key, child] of Object.entries(record)) yield* refsUnder(child, `${at}.${key}`);
  }
}

/** A mapping with every `trigger.<f>` reference rewritten to read the reserved input key. */
export function rewriteTriggerRefs<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => rewriteTriggerRefs(item)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === "string" && Object.keys(record).length === 1 && isTriggerRef(record.$ref)) {
      return { $ref: `input.${TRIGGER_INPUT_KEY}${record.$ref.slice("trigger".length)}` } as unknown as T;
    }
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, rewriteTriggerRefs(v)])) as T;
  }
  return value;
}

/* ── artifact-ref fields (ISC-59) ───────────────────────────────────────── */

export const ARTIFACT_REF_FORMAT = "artifact-ref";

/** Dotted paths (under an output schema's `properties`) of fields declared `format: artifact-ref`, and the ones declared with the format but a non-string type. */
export function artifactRefFields(schema: unknown, at = ""): { fields: string[]; badType: string[] } {
  const out = { fields: [] as string[], badType: [] as string[] };
  const walk = (node: unknown, path: string) => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return;
    const s = node as Record<string, unknown>;
    if (s.format === ARTIFACT_REF_FORMAT) {
      out.fields.push(path);
      const types = typeof s.type === "string" ? [s.type] : Array.isArray(s.type) ? s.type : [];
      if (types.length !== 1 || types[0] !== "string") out.badType.push(path);
    }
    if (s.properties && typeof s.properties === "object") {
      for (const [key, child] of Object.entries(s.properties as Record<string, unknown>)) walk(child, path ? `${path}.${key}` : key);
    }
    if (s.items && !Array.isArray(s.items)) walk(s.items, path ? `${path}.*` : "*");
  };
  walk(schema, at);
  return out;
}

/* ── Prompt files (ISC-66) ──────────────────────────────────────────────── */

/** Why a prompt_file value can never be valid, before any lookup; null when its shape is fine. */
export function promptFileShape(file: string): string | null {
  if (isAbsolute(file)) return "must be relative to the definitions home";
  if (file.split(/[\\/]/).includes("..")) return "must not climb out of the definitions home";
  if (!file.endsWith(".md")) return "must be a markdown (.md) file";
  return null;
}

/** The absolute path of a prompt file under the definitions home, or an error sentence. Dereferences symlinks before the boundary check. */
export function resolvePromptFile(home: string, file: string): { ok: true; path: string } | { ok: false; reason: string } {
  const bad = promptFileShape(file);
  if (bad) return { ok: false, reason: `prompt_file "${file}" ${bad}.` };
  const path = join(home, file);
  if (!existsSync(path) || !statSync(path).isFile()) return { ok: false, reason: `prompt_file "${file}" does not exist under ${home}.` };
  const inside = relative(realpathSync(home), realpathSync(path));
  if (inside.startsWith("..") || isAbsolute(inside)) return { ok: false, reason: `prompt_file "${file}" resolves outside the definitions home.` };
  return { ok: true, path };
}

export function readPromptFile(home: string, file: string): string {
  const resolved = resolvePromptFile(home, file);
  if (!resolved.ok) throw new Error(resolved.reason);
  return readFileSync(resolved.path, "utf8");
}

/* ── Glance callers (ISC-61) ────────────────────────────────────────────── */

/** The registered Glance caller names, read through Glance's own registry loader. */
export function glanceCallerNames(): Set<string> {
  return new Set(Object.keys(loadRegistry().callers));
}

/* ── SOP resolution (ISC-139) ───────────────────────────────────────────── */

/** SOP ids: the basenames (no extension) of every SOP file under the skill customizations. */
export function sopIds(customizations: string = join(LIFEOS_DIR, "USER", "CUSTOMIZATIONS", "SKILLS")): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(customizations)) return ids;
  for (const skill of readdirSync(customizations)) {
    const dir = join(customizations, skill, "SOPs");
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) ids.add(basename(file).replace(/\.[^.]+$/, ""));
  }
  return ids;
}

/**
 * True when a `sop` value names an existing SOP file (a path, relative to the
 * LifeOS tree or absolute) or the id of one. A Vector SOP id resolves only when
 * the caller supplies `resolveSop`, because validation never opens a network
 * connection.
 */
export function sopResolves(sop: string): boolean {
  const candidate = isAbsolute(sop) ? sop : resolve(LIFEOS_DIR, sop);
  if (sop.includes(sep) || sop.endsWith(".md")) {
    try { return existsSync(candidate) && statSync(candidate).isFile(); } catch { return false; }
  }
  return sopIds().has(sop);
}
