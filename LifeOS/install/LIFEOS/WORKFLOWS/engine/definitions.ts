/**
 * The definition writer (ISA ISC-77, ISC-78, ISC-153).
 *
 * This is the ONE code path that writes, replaces, renames or removes a
 * `<name>.workflow.yaml` file. The CLI and the Pulse page both call it, so a
 * change made by talking to {{DA_NAME}} and a change made by clicking the page go
 * through the same checks:
 *
 *   - the name is a definition name and the target sits inside the definitions
 *     home once every symlink is resolved (`realpathSync`), never merely
 *     lexically under it;
 *   - the text validates as a v2 definition whose `name` is the file's stem,
 *     checked as an `invariant()` right before the write (an edit that fails
 *     validation is refused earlier, as a typed result, and writes nothing);
 *   - the bytes go to a temp file beside the target and are moved into place
 *     by rename (replace) or hard link (create, which cannot overwrite), so a
 *     reader never sees half a file and a crash leaves the old file intact.
 *
 * Edits mutate a parsed YAML document, so comments and key order survive.
 */
import { appendFileSync, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join, sep } from "node:path";
import { isDocument, parseDocument, type Document } from "yaml";
import { invariant } from "../../TOOLS/Invariant.ts";
import { checkDefinitionText, message, parseDefinitionText, type DefinitionV2, type Verdict } from "./format.ts";
import { issueOfError, type Issue } from "./format-issues.ts";
import { cloudSecretCheck, type CloudCheckOptions } from "../cloud/secret-check.ts";
import { DEFINITION_SUFFIX, definitionsDir, ledgerPath, NAME_RE, pathForName, renameAliasPath } from "./paths.ts";
import { emitToVigil, type VigilEvent } from "./vigil-emit.ts";
import { definitionResolver, resolveActions } from "./runner.ts";

/* ── Confinement ────────────────────────────────────────────────────────── */

/** The definitions home, created if needed, as its real path (symlinks resolved). */
export function realHome(home: string = definitionsDir()): string {
  mkdirSync(home, { recursive: true });
  return realpathSync(home);
}

/**
 * The path a definition of this name must have. Refuses (throws) a name that is
 * not a definition name; the path is built from the RESOLVED home, so a
 * symlinked home or a symlinked parent cannot move it.
 */
export function confinedPath(name: string, home: string = definitionsDir()): string {
  invariant(NAME_RE.test(name), `"${name}" is not a definition name`);
  const real = realHome(home);
  const path = pathForName(name, real);
  invariant(path.startsWith(real + sep) && basename(path) === `${name}${DEFINITION_SUFFIX}`, `Definition path escapes the definitions home: ${path}`);
  return path;
}

/** lstat without following: the entry at the path, or null. A dangling symlink still counts as an entry. */
function entryAt(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class DefinitionWriteRefused extends Error {
  constructor(readonly reason: "exists" | "missing" | "symlink" | "outside-home", text: string) {
    super(text);
    this.name = "DefinitionWriteRefused";
  }
}

/* ── The writer ─────────────────────────────────────────────────────────── */

export type WriteMode = "create" | "replace";

export interface WriteOptions {
  home?: string;
  mode: WriteMode;
}

/**
 * Writes `text` as the definition `name`. Typed refusals (DefinitionWriteRefused)
 * for expected trouble: creating over an existing file, replacing a missing one,
 * a symlink at the target. Impossible states (a bad name, a path outside the
 * home, text that is not a valid v2 definition of that name) are invariants.
 */
export function writeDefinition(name: string, text: string, opts: WriteOptions): string {
  const home = opts.home ?? definitionsDir();
  const path = confinedPath(name, home);
  const real = realHome(home);
  invariant(typeof text === "string" && text.length > 0 && !text.includes("\0"), "A definition to write must be non-empty text");
  let parsed: DefinitionV2 | null = null;
  try {
    parsed = parseDefinitionText(text, path);
  } catch (error) {
    invariant(false, `Refusing to write ${name}: the text is not a valid definition (${message(error)})`);
  }
  invariant(parsed !== null && parsed.version === 2 && parsed.name === name, `Refusing to write ${name}: the text must be a version 2 definition named "${name}"`);

  const existing = entryAt(path);
  if (existing?.isSymbolicLink()) throw new DefinitionWriteRefused("symlink", `Refused: ${path} is a symlink; the writer never writes through one.`);
  if (opts.mode === "create" && existing) throw new DefinitionWriteRefused("exists", `Refused: ${path} already exists; it is never overwritten.`);
  if (opts.mode === "replace" && !existing) throw new DefinitionWriteRefused("missing", `Refused: no definition at ${path} to replace.`);
  if (existing) invariant(realpathSync(path) === path, `An existing definition resolves outside its own path: ${path}`);

  const temp = join(real, `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  invariant(realpathSync(real) === real && temp.startsWith(real + sep), `Temp file escapes the definitions home: ${temp}`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (opts.mode === "create") {
      // link() fails with EEXIST if anything appeared at the path since the check: create can never overwrite.
      try {
        linkSync(temp, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new DefinitionWriteRefused("exists", `Refused: ${path} already exists; it is never overwritten.`);
        throw error;
      }
      unlinkSync(temp);
    } else {
      renameSync(temp, path);
    }
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* already moved or never created */
    }
    throw error;
  }
  return path;
}

/** Removes a definition file (used by rename). Same confinement and symlink rules as a write. */
export function removeDefinition(name: string, home: string = definitionsDir()): string {
  const path = confinedPath(name, home);
  const existing = entryAt(path);
  if (!existing) throw new DefinitionWriteRefused("missing", `Refused: no definition at ${path} to remove.`);
  if (existing.isSymbolicLink()) throw new DefinitionWriteRefused("symlink", `Refused: ${path} is a symlink; the writer never removes through one.`);
  unlinkSync(path);
  return path;
}

/* ── Validation ─────────────────────────────────────────────────────────── */

export interface Checked {
  valid: boolean;
  issues: Issue[];
  warnings: Issue[];
  verdict: Verdict;
}

/**
 * The verdict for a definition text with the same context the CLI's `validate`
 * uses: action contracts from the manifests, sibling definitions from the home,
 * and, for a local workflow, an error for every action that cannot run here.
 */
export async function checkText(text: string, source: string, home: string = definitionsDir(), cloud: CloudCheckOptions = {}): Promise<Checked> {
  let def: DefinitionV2;
  try {
    def = parseDefinitionText(text, source);
  } catch (error) {
    const verdict = checkDefinitionText(text, source);
    return { valid: false, issues: verdict.errors.length ? verdict.errors : [issueOfError(error)], warnings: verdict.warnings, verdict };
  }
  const actions = await resolveActions(def);
  const verdict = checkDefinitionText(text, source, { contracts: actions.contracts, resolveWorkflow: definitionResolver(home), home });
  const issues = [...verdict.errors];
  if (def.runs_on === "local") {
    for (const [name, why] of actions.missing) {
      issues.push({ path: "steps", code: "action-unavailable", message: `Action ${name} is not available locally: ${why}` });
    }
  }
  issues.push(...quotedScriptArgs(def));
  if (issues.length === 0) issues.push(...workflowCycles(def, definitionResolver(home)));
  const warnings = [...verdict.warnings];
  // ISC-33 (cloud half): a cloud workflow's declared secret names must be on its runner Worker. Names only.
  if (def.runs_on === "cloud") {
    const secrets = await cloudSecretCheck(def, cloud);
    if (secrets.status === "missing") {
      for (const name of secrets.missing) issues.push({ path: "secrets", code: "secret-absent-cloud", message: `Secret ${name} is not held by the runner Worker for ${def.name}, so this workflow cannot run in the cloud; set it on the Worker first.` });
    } else if (secrets.status === "unverified" && secrets.note) {
      warnings.push({ path: "runs_on", code: "cloud-unverified", message: secrets.note });
    }
  }
  return { valid: issues.length === 0, issues, warnings, verdict };
}

/**
 * A command step whose shell string quotes a script path together with its arguments
 * (`exec bun "$HOME/x.ts --json"`) hands the runtime one path containing spaces, so every run fails
 * with module-not-found. Caught for any script extension (several schedules once shipped this way).
 */
export function quotedScriptArgs(def: DefinitionV2): { path: string; code: string; message: string }[] {
  const out: { path: string; code: string; message: string }[] = [];
  const re = /"([^"\s]*\.(?:ts|js|mjs|cjs|sh|go))\s+[^"]+"/;
  for (const [id, step] of Object.entries(def.steps ?? {})) {
    for (const arg of step.argv ?? []) {
      const m = arg.match(re);
      if (m) out.push({ path: `steps.${id}.argv`, code: "quoted-script-args", message: `Step ${id} quotes the script path ${m[1]} together with its arguments, so the runtime gets one path with spaces in it. Close the quote after the path.` });
    }
  }
  return out;
}

/**
 * Cycles across definitions (ISA ISC-169). The format check refuses a workflow
 * that names itself; this follows the home's other definitions too. Two graphs,
 * each checked from the definition being written (its new text stands in for
 * the file on disk):
 *   - calls: a `workflow` step runs its child in the same run, so a path back
 *     to this definition recurses without end;
 *   - after: `after` triggers start each other, so a loop back ping-pongs a
 *     new run every dispatcher tick.
 */
export function workflowCycles(def: DefinitionV2, resolve: (name: string) => DefinitionV2 | null): Issue[] {
  const lookup = (name: string): DefinitionV2 | null => (name === def.name ? def : resolve(name));
  const callsOf = (d: DefinitionV2): string[] => Object.values(d.steps).filter(s => s.kind === "workflow" && s.workflow).map(s => s.workflow as string);
  const upstreamsOf = (d: DefinitionV2): string[] => d.triggers.filter(t => t.type === "after").map(t => (t as { workflow?: string }).workflow).filter((w): w is string => typeof w === "string");
  const pathBack = (next: (d: DefinitionV2) => string[]): string[] | null => {
    const seen = new Set<string>();
    const walk = (name: string, trail: string[]): string[] | null => {
      if (name === def.name && trail.length > 1) return trail;
      if (seen.has(name)) return null;
      seen.add(name);
      const d = lookup(name);
      if (!d) return null;
      for (const n of next(d)) {
        const found = walk(n, [...trail, n]);
        if (found) return found;
      }
      return null;
    };
    return walk(def.name, [def.name]);
  };
  const issues: Issue[] = [];
  const calls = pathBack(callsOf);
  if (calls) issues.push({ path: "steps", code: "workflow-cycle", message: `Workflow steps call back into ${def.name}: ${calls.join(" → ")}. A run would never end.` });
  const after = pathBack(upstreamsOf);
  if (after) issues.push({ path: "triggers", code: "after-cycle", message: `after: triggers loop back to ${def.name}: ${[...after].reverse().join(" → ")} → …, so each finished run would start the next forever.` });
  return issues;
}

/* ── Editing ────────────────────────────────────────────────────────────── */

/** The content hash an editor sends back to prove it edited the text on disk (ISC-166). */
export const textHash = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;

export interface EditRefused {
  ok: false;
  /**
   * "invalid" (the edit fails validation), "not-found", "not-editable", "exists",
   * "unsupported", or "stale" (the caller's copy is not the text on disk).
   */
  refused: "invalid" | "not-found" | "not-editable" | "exists" | "unsupported" | "stale";
  error: string;
  issues: Issue[];
  path?: string;
}

export interface EditDone {
  ok: true;
  path: string;
  name: string;
  definition: DefinitionV2;
  warnings: Issue[];
  /** What the mutator reports back (the trigger it added, the value it set...). */
  detail: Record<string, unknown>;
  /** Hash of the text now on disk; an editor sends it back as its base for the next edit. */
  hash: string;
  /** The text before this edit, when the edit changed the file (the page's Undo puts it back). */
  previous?: string;
  /** The definition before this edit, when there was one (callers compare triggers and enabled). */
  before?: DefinitionV2;
}

/** Options every edit takes: a test home, cloud-check overrides, and the hash of the copy the caller edited. */
export interface EditOptions {
  home?: string;
  cloud?: CloudCheckOptions;
  /** When set, the edit is refused as stale unless the file's text still has this hash (ISC-166). */
  baseHash?: string;
  /** Who is writing: the CLI (and {{DA_NAME}}) or the Pulse page. The page may not change command lines (ISC-172). Defaults to cli. */
  origin?: EditOrigin;
  /** How long to wait for another writer's lock on the same definition (ISC-171). */
  lockTimeoutMs?: number;
  /** Where the edit trail's Vigil event goes; tests pass a recorder. Defaults to Vigil for the real home and nowhere for any other. */
  onEvent?: (event: VigilEvent) => void;
}

export type EditOrigin = "cli" | "page";

/* ── Lock, edit trail and the page's command-line rule (ISA ISC-171 to ISC-173) ── */

const LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_WAIT_MS = 10_000;

/**
 * Holds `.<name>.lock` in the definitions home for the whole read-validate-write
 * of one edit, so two writers on the same base cannot both pass the hash check:
 * the second waits, then reads the first one's text and is refused as stale.
 * A lock older than LOCK_STALE_MS is a crashed writer's and is taken over.
 */
async function withDefinitionLock<T>(name: string, home: string, waitMs: number, fn: () => Promise<T>): Promise<T | EditRefused> {
  const lock = join(realHome(home), `.${name}.lock`);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { unlinkSync(lock); continue; }
      } catch { continue; /* released between the open and the stat */ }
      if (Date.now() > deadline) return refusal("not-editable", `Another edit to ${name} is in progress; try again. Nothing was written.`, [], pathForName(name, home));
      await new Promise(r => setTimeout(r, 15));
    }
  }
  try {
    return await fn();
  } finally {
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

const isRealHome = (home: string): boolean => {
  if (process.env.LIFEOS_WORKFLOWS_DIR) return false;
  try { return realHome(home) === realHome(definitionsDir()); } catch { return false; }
};

/** The edit trail: beside the run ledger for the real home, inside any other home (tests, overrides) so it never mixes. */
export function editLogPath(home: string = definitionsDir()): string {
  return isRealHome(home) ? join(dirname(ledgerPath()), "edits.jsonl") : join(realHome(home), ".edits.jsonl");
}

export interface EditLogLine {
  at: string;
  name: string;
  action: string;
  origin: EditOrigin;
  before_hash: string | null;
  after_hash: string | null;
}

/** One line per successful write, and one Vigil event (ISC-173). Names and hashes only, never definition text. */
function recordEdit(home: string, line: Omit<EditLogLine, "at">, onEvent: EditOptions["onEvent"]): void {
  const full: EditLogLine = { at: new Date().toISOString(), ...line };
  const path = editLogPath(home);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(full) + "\n", { mode: 0o600 });
  const sink = onEvent ?? (isRealHome(home) ? (e: VigilEvent) => { emitToVigil(e); } : undefined);
  if (!sink) return;
  // Vigil refuses any hex run of 40+ as credential-shaped, so the event carries a 16-hex prefix; edits.jsonl keeps the full hash.
  const short = (h: string | null) => (h ? h.slice(0, 23) : null);
  // The file is already written: a telemetry failure is logged, never turned into a failed edit.
  try {
  sink({
    id: crypto.randomUUID(), source: "workflows", ts: full.at, kind: "infra", severity: "info",
    title: `${line.name}: definition ${line.action}`.slice(0, 140),
    summary: `The ${line.name} workflow definition was changed (${line.action}) from the ${line.origin === "page" ? "Pulse page" : "CLI"}.`,
    ref: null, url: null, privacy_class: "personal",
    dedup_key: `workflows:definition:${line.name}:${short(line.after_hash) ?? "removed"}:${full.at}`,
    meta: { workflow: line.name, action: line.action, origin: line.origin, before_hash: short(line.before_hash), after_hash: short(line.after_hash) },
  });
  } catch (e) {
    console.error(`workflows: the Vigil event for ${line.name} (${line.action}) was not sent: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The command steps whose command line a write adds or changes: a new command
 * step, a step that became one, or a different argv or env (ISC-172). The page
 * may not make these changes; the CLI makes them.
 */
export function commandLineChanges(before: DefinitionV2 | undefined, after: DefinitionV2): string[] {
  const out: string[] = [];
  for (const [id, step] of Object.entries(after.steps)) {
    if (step.kind !== "command") continue;
    const was = before?.steps[id];
    if (!was || was.kind !== "command" || JSON.stringify(was.argv) !== JSON.stringify(step.argv) || JSON.stringify(was.env ?? null) !== JSON.stringify(step.env ?? null)) out.push(id);
  }
  return out;
}

const commandRefusal = (name: string, ids: string[], path: string): EditRefused =>
  refusal("invalid", `The page does not change command lines (step ${ids.map(i => `"${i}"`).join(", ")}); make that change from the terminal: workflow step set ${name} ${ids[0]} --fields '{"argv": [...]}'. Nothing was written.`, [{ path: `steps.${ids[0]}.argv`, code: "command-line-page", message: "command lines change from the CLI only" }], path);

const staleRefusal = (name: string, path: string): EditRefused =>
  refusal("stale", `${name} changed on disk since this copy was read; reload it and make the edit again. Nothing was written.`, [], path);

/** A mutator changes the parsed document and returns detail for the caller, or throws Refusal to stop with a reason. */
export class Refusal extends Error {}
export type Mutator = (doc: Document, def: DefinitionV2) => Record<string, unknown> | void;

const refusal = (refused: EditRefused["refused"], error: string, issues: Issue[] = [], path?: string): EditRefused => ({ ok: false, refused, error, issues, ...(path ? { path } : {}) });

const summary = (issues: Issue[]): string => issues.map(i => i.message).join("; ");

/**
 * Reads the definition, applies the mutator to its YAML document, validates the
 * result, and writes only when it validates. On any refusal nothing is written.
 */
export async function editDefinition(name: string, mutate: Mutator, opts: EditOptions = {}): Promise<EditDone | EditRefused> {
  const home = opts.home ?? definitionsDir();
  const path = confinedPath(name, home);
  if (!entryAt(path)) return refusal("not-found", `No workflow named "${name}" in ${home}.`, [], path);
  return withDefinitionLock(name, home, opts.lockTimeoutMs ?? DEFAULT_LOCK_WAIT_MS, () => editLocked(name, mutate, opts, home, path));
}

async function editLocked(name: string, mutate: Mutator, opts: EditOptions, home: string, path: string): Promise<EditDone | EditRefused> {
  const existing = entryAt(path);
  if (!existing) return refusal("not-found", `No workflow named "${name}" in ${home}.`, [], path);
  if (existing.isSymbolicLink()) return refusal("not-editable", `${path} is a symlink; the writer never writes through one.`, [], path);
  const before = readFileSync(path, "utf8");
  if (opts.baseHash !== undefined && opts.baseHash !== textHash(before)) return staleRefusal(name, path);
  let def: DefinitionV2;
  try {
    def = parseDefinitionText(before, path);
  } catch (error) {
    return refusal("not-editable", `${name} does not validate as it stands (${message(error)}); fix it before editing.`, [issueOfError(error)], path);
  }
  if (def.version !== 2) return refusal("unsupported", `${name} is a version ${def.version} definition; only version 2 definitions are edited by the CLI.`, [], path);
  const doc = parseDocument(before);
  if (doc.errors.length) return refusal("not-editable", `${name} is not readable YAML: ${doc.errors[0].message}`, [], path);
  let detail: Record<string, unknown> = {};
  try {
    detail = mutate(doc, def) ?? {};
  } catch (error) {
    if (error instanceof Refusal) return refusal("invalid", error.message, [], path);
    throw error;
  }
  const after = doc.toString();
  const checked = await checkText(after, path, home, opts.cloud);
  if (!checked.valid) return refusal("invalid", summary(checked.issues), checked.issues, path);
  if (opts.origin === "page") {
    const changed = commandLineChanges(def, checked.verdict.definition as DefinitionV2);
    if (changed.length) return commandRefusal(name, changed, path);
  }
  if (after === before) return { ok: true, path, name, definition: checked.verdict.definition as DefinitionV2, warnings: checked.warnings, detail: { ...detail, changed: false }, hash: textHash(before), before: def };
  writeDefinition(name, after, { home, mode: "replace" });
  recordEdit(home, { name, action: "edit", origin: opts.origin ?? "cli", before_hash: textHash(before), after_hash: textHash(after) }, opts.onEvent);
  return { ok: true, path, name, definition: checked.verdict.definition as DefinitionV2, warnings: checked.warnings, detail: { ...detail, changed: true }, hash: textHash(after), previous: before, before: def };
}

/**
 * Replaces a definition's whole text (the page's definition editor, the page's
 * Undo, and `workflow put`). The text must validate exactly as `validate`
 * would judge it, be a version 2 definition, and keep the file's name; a
 * rename goes through renameDefinition so after: triggers are repointed.
 */
export async function replaceDefinition(name: string, text: string, opts: EditOptions = {}): Promise<EditDone | EditRefused> {
  const home = opts.home ?? definitionsDir();
  const path = confinedPath(name, home);
  if (!entryAt(path)) return refusal("not-found", `No workflow named "${name}" in ${home}.`, [], path);
  return withDefinitionLock(name, home, opts.lockTimeoutMs ?? DEFAULT_LOCK_WAIT_MS, () => replaceLocked(name, text, opts, home, path));
}

async function replaceLocked(name: string, text: string, opts: EditOptions, home: string, path: string): Promise<EditDone | EditRefused> {
  const existing = entryAt(path);
  if (!existing) return refusal("not-found", `No workflow named "${name}" in ${home}.`, [], path);
  if (existing.isSymbolicLink()) return refusal("not-editable", `${path} is a symlink; the writer never writes through one.`, [], path);
  const before = readFileSync(path, "utf8");
  if (opts.baseHash !== undefined && opts.baseHash !== textHash(before)) return staleRefusal(name, path);
  if (typeof text !== "string" || text.trim().length === 0 || text.includes("\0")) return refusal("invalid", "The definition text is empty or not text.", [], path);
  const checked = await checkText(text, path, home, opts.cloud);
  if (!checked.valid) return refusal("invalid", summary(checked.issues), checked.issues, path);
  const def = checked.verdict.definition as DefinitionV2;
  if (def.version !== 2) return refusal("unsupported", `The text is a version ${def.version} definition; only version 2 definitions are written.`, [], path);
  if (def.name !== name) return refusal("invalid", `The text names "${def.name}", but this file is "${name}"; a definition keeps its name here (rename it with \`workflow rename\`).`, [{ path: "name", code: "name-changed", message: `name must stay "${name}"` }], path);
  let beforeDef: DefinitionV2 | undefined;
  try {
    beforeDef = parseDefinitionText(before, path);
  } catch {
    beforeDef = undefined; // the file on disk was broken; replacing it with valid text is the fix
  }
  if (opts.origin === "page") {
    const changed = commandLineChanges(beforeDef, def);
    if (changed.length) return commandRefusal(name, changed, path);
  }
  if (text === before) return { ok: true, path, name, definition: def, warnings: checked.warnings, detail: { changed: false }, hash: textHash(before), ...(beforeDef ? { before: beforeDef } : {}) };
  writeDefinition(name, text, { home, mode: "replace" });
  recordEdit(home, { name, action: "put", origin: opts.origin ?? "cli", before_hash: textHash(before), after_hash: textHash(text) }, opts.onEvent);
  return { ok: true, path, name, definition: def, warnings: checked.warnings, detail: { changed: true }, hash: textHash(text), previous: before, ...(beforeDef ? { before: beforeDef } : {}) };
}

/** Whether a replace changed what launchd runs: the triggers or the enabled flag. */
export function launchdChanged(done: EditDone): boolean {
  if (done.detail.changed !== true) return false;
  if (!done.before) return true;
  return JSON.stringify(done.before.triggers) !== JSON.stringify(done.definition.triggers) || (done.before.enabled !== false) !== (done.definition.enabled !== false);
}

/** A definition's text and hash, for an editor to show and to send back as its base. Reading only. */
export function readDefinitionText(name: string, home: string = definitionsDir()): { path: string; text: string; hash: string } | null {
  const path = confinedPath(name, home);
  const existing = entryAt(path);
  if (!existing || existing.isSymbolicLink()) return null;
  const text = readFileSync(path, "utf8");
  return { path, text, hash: textHash(text) };
}

/** Writes a brand-new definition after validating it; refuses an existing name and writes nothing when invalid. */
export async function createDefinition(name: string, text: string, opts: Omit<EditOptions, "baseHash" | "lockTimeoutMs"> = {}): Promise<EditDone | EditRefused> {
  const home = opts.home ?? definitionsDir();
  const path = confinedPath(name, home);
  if (entryAt(path)) return refusal("exists", `Refused: ${path} already exists; new never overwrites a definition.`, [], path);
  const checked = await checkText(text, path, home, opts.cloud);
  if (!checked.valid) return refusal("invalid", summary(checked.issues), checked.issues, path);
  try {
    writeDefinition(name, text, { home, mode: "create" });
  } catch (error) {
    if (error instanceof DefinitionWriteRefused) return refusal("exists", error.message, [], path);
    throw error;
  }
  recordEdit(home, { name, action: "create", origin: opts.origin ?? "cli", before_hash: null, after_hash: textHash(text) }, opts.onEvent);
  return { ok: true, path, name, definition: checked.verdict.definition as DefinitionV2, warnings: checked.warnings, detail: { changed: true }, hash: textHash(text) };
}

/* ── Remove (ISA ISC-175) ───────────────────────────────────────────────── */

export interface RemoveDone {
  ok: true;
  name: string;
  path: string;
  /** The removed text, so an Undo can create it again. */
  previous: string;
  /** The removed definition, so the caller can unload its launchd job. */
  before: DefinitionV2 | null;
}

/** Every other definition in the home that names `name` in an after: trigger or a workflow step. */
export function referencesTo(name: string, home: string = definitionsDir()): string[] {
  const out: string[] = [];
  let files: string[] = [];
  try { files = readdirSync(realHome(home)).filter(f => f.endsWith(DEFINITION_SUFFIX)); } catch { return out; }
  for (const file of files) {
    const other = file.slice(0, -DEFINITION_SUFFIX.length);
    if (other === name) continue;
    let def: DefinitionV2;
    try { def = parseDefinitionText(readFileSync(join(realHome(home), file), "utf8"), file); } catch { continue; }
    const byAfter = def.triggers.some(t => t.type === "after" && (t as { workflow?: string }).workflow === name);
    const byStep = Object.values(def.steps).some(s => s.kind === "workflow" && s.workflow === name);
    if (byAfter || byStep) out.push(other);
  }
  return out.sort();
}

/**
 * Removes a definition only when nothing else names it (ISC-175). The caller
 * unloads its launchd job with engine/launchd-sync.ts after a success.
 */
export async function removeWorkflow(name: string, opts: EditOptions = {}): Promise<RemoveDone | EditRefused> {
  const home = opts.home ?? definitionsDir();
  const path = confinedPath(name, home);
  if (!entryAt(path)) return refusal("not-found", `No workflow named "${name}" in ${home}.`, [], path);
  return withDefinitionLock(name, home, opts.lockTimeoutMs ?? DEFAULT_LOCK_WAIT_MS, async () => {
    const existing = entryAt(path);
    if (!existing) return refusal("not-found", `No workflow named "${name}" in ${home}.`, [], path);
    if (existing.isSymbolicLink()) return refusal("not-editable", `${path} is a symlink; the writer never removes through one.`, [], path);
    const text = readFileSync(path, "utf8");
    if (opts.baseHash !== undefined && opts.baseHash !== textHash(text)) return staleRefusal(name, path);
    const refs = referencesTo(name, home);
    if (refs.length) return refusal("invalid", `${name} cannot be removed: ${refs.join(", ")} ${refs.length === 1 ? "names" : "name"} it in an after: trigger or a workflow step. Nothing was removed.`, [], path);
    let before: DefinitionV2 | null = null;
    try { before = parseDefinitionText(text, path); } catch { before = null; }
    removeDefinition(name, home);
    recordEdit(home, { name, action: "remove", origin: opts.origin ?? "cli", before_hash: textHash(text), after_hash: null }, opts.onEvent);
    return { ok: true, name, path, previous: text, before };
  });
}

export interface RenameDone {
  ok: true;
  from: string;
  to: string;
  path: string;
  /** Definitions whose `after:` triggers or `workflow` steps were repointed. */
  rewritten: string[];
}

/**
 * Renames a definition: the file, its `name:`, and every `after:` trigger and
 * `workflow:` step in the home that pointed at the old name. Every changed
 * document is validated before the first write; the old file is removed last.
 * Ledger lines keep the old name (they record what ran, under the name it had).
 */
export async function renameDefinition(from: string, to: string, opts: { home?: string; cloud?: CloudCheckOptions; aliasFile?: string } = {}): Promise<RenameDone | EditRefused> {
  const home = opts.home ?? definitionsDir();
  const fromPath = confinedPath(from, home);
  const toPath = confinedPath(to, home);
  if (from === to) return refusal("invalid", "The new name is the old name.", [], fromPath);
  const source = entryAt(fromPath);
  if (!source) return refusal("not-found", `No workflow named "${from}" in ${home}.`, [], fromPath);
  if (source.isSymbolicLink()) return refusal("not-editable", `${fromPath} is a symlink; the writer never writes through one.`, [], fromPath);
  if (entryAt(toPath)) return refusal("exists", `Refused: ${toPath} already exists; rename never overwrites a definition.`, [], toPath);

  const renamedText = (() => {
    const doc = parseDocument(readFileSync(fromPath, "utf8"));
    doc.set("name", to);
    return doc;
  })();
  if (renamedText.errors.length) return refusal("not-editable", `${from} is not readable YAML: ${renamedText.errors[0].message}`, [], fromPath);
  if (renamedText.get("version") !== 2) return refusal("unsupported", `${from} is not a version 2 definition.`, [], fromPath);

  /** Every other definition with a reference to `from`, rewritten in memory. */
  const others: Array<{ name: string; text: string }> = [];
  for (const file of readdirSync(realHome(home)).filter(f => f.endsWith(DEFINITION_SUFFIX)).sort()) {
    const other = file.slice(0, -DEFINITION_SUFFIX.length);
    if (other === from || !NAME_RE.test(other)) continue;
    const p = join(realHome(home), file);
    if (entryAt(p)?.isSymbolicLink()) continue;
    const doc = parseDocument(readFileSync(p, "utf8"));
    if (doc.errors.length || doc.get("version") !== 2) continue;
    let touched = false;
    const triggers = doc.get("triggers");
    if (triggers && typeof triggers === "object" && "items" in triggers) {
      for (const item of (triggers as { items: unknown[] }).items) {
        if (isMap(item) && item.get("type") === "after" && item.get("workflow") === from) {
          item.set("workflow", to);
          touched = true;
        }
      }
    }
    const steps = doc.get("steps");
    if (steps && typeof steps === "object" && "items" in steps) {
      for (const pair of (steps as { items: Array<{ value: unknown }> }).items) {
        const step = pair.value;
        if (isMap(step) && step.get("kind") === "workflow" && step.get("workflow") === from) {
          step.set("workflow", to);
          touched = true;
        }
      }
    }
    if (touched) others.push({ name: other, text: doc.toString() });
  }

  // Validate every result against a home that already holds the new name, before writing anything.
  const newText = renamedText.toString();
  const first = await checkText(newText, toPath, home, opts.cloud);
  if (!first.valid) return refusal("invalid", summary(first.issues), first.issues, toPath);
  writeDefinition(to, newText, { home, mode: "create" });
  const rewritten: string[] = [];
  const originals = new Map<string, string>();
  try {
    for (const other of others) {
      originals.set(other.name, readFileSync(confinedPath(other.name, home), "utf8"));
      writeDefinition(other.name, other.text, { home, mode: "replace" });
      rewritten.push(other.name);
    }
  } catch (error) {
    // Put every rewritten neighbour back and drop the new file, so nothing is half-renamed.
    for (const [name, text] of originals) writeDefinition(name, text, { home, mode: "replace" });
    removeDefinition(to, home);
    throw error;
  }
  removeDefinition(from, home);
  recordRenameAlias(from, to, opts.aliasFile ?? renameAliasPath());
  return { ok: true, from, to, path: toPath, rewritten };
}

/**
 * Appends one line to the rename alias map so the inventory can show runs recorded
 * under the old name beneath the new one. The ledger is never rewritten; this side
 * file is append-only and read by the inventory (ISC-76, inventory half).
 */
export function recordRenameAlias(from: string, to: string, file: string): void {
  invariant(NAME_RE.test(from) && NAME_RE.test(to) && from !== to, `A rename alias needs two distinct definition names (${from} -> ${to})`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ from, to, at: new Date().toISOString() })}\n`);
}

const isMap = (value: unknown): value is { get(key: string): unknown; set(key: string, value: unknown): void } =>
  typeof value === "object" && value !== null && "get" in value && "set" in value && !isDocument(value);
