/**
 * The edits the CLI and the Pulse page make to a definition (ISA ISC-67 to ISC-70).
 *
 * Each edit is a Mutator: it changes the parsed YAML document and nothing else.
 * It never touches the disk. `editDefinition` in definitions.ts validates the
 * changed document and is the only place a file is written.
 */
import { definitionsDir } from "./paths.ts";
import { Refusal, type Mutator } from "./definitions.ts";
import { definitionResolver } from "./runner.ts";
import { STEP_KINDS, type DefinitionV2 } from "./format.ts";

/** pause / resume: flips the workflow-level `enabled` (ISC-69). */
export const setEnabled = (enabled: boolean): Mutator => doc => {
  doc.set("enabled", enabled);
  return { enabled };
};

/** set runs_on (ISC-70). The validator's cross-checks decide whether the target is allowed. */
export const setRunsOn = (target: "local" | "cloud"): Mutator => (doc, def) => {
  doc.set("runs_on", target);
  return { runs_on: target, was: def.runs_on };
};

/** link: an `after:` trigger on the downstream (ISC-68). A repeat of the same link is refused, not duplicated. */
export const addAfterLink = (upstream: string, status: "succeeded" | "failed" | "completed"): Mutator => (doc, def) => {
  if (def.triggers.some(t => t.type === "after" && t.workflow === upstream && t.status === status)) {
    throw new Refusal(`${def.name} already runs after ${upstream} (${status}).`);
  }
  const trigger = { type: "after", workflow: upstream, status };
  doc.addIn(["triggers"], doc.createNode(trigger));
  return { trigger };
};

/** A duration like `20m`, `2h`, `1d`, or a bare number of minutes; null when it is not one. */
export function parseMinutes(value: string): number | null {
  const m = value.trim().match(/^(\d{1,7})([mhd]?)$/);
  if (!m) return null;
  const n = Number(m[1]) * ({ "": 1, m: 1, h: 60, d: 1440 } as Record<string, number>)[m[2]];
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

export type ScheduleChange =
  | { action: "cron"; cron: string; timezone: string }
  | { action: "every"; minutes: number }
  | { action: "at"; at: string }
  | { action: "in"; minutes: number; now?: Date }
  | { action: "remove"; target: string };

/** The trigger a schedule change writes. `--cron` replaces the schedule trigger, `--every` the interval, `--at` and `--in` the one-time trigger. */
export function scheduleTrigger(change: Exclude<ScheduleChange, { action: "remove" }>): Record<string, unknown> {
  switch (change.action) {
    case "cron": return { type: "schedule", cron: change.cron, timezone: change.timezone };
    case "every": return { type: "interval", minutes: change.minutes };
    case "at": return { type: "once", at: change.at };
    case "in": return { type: "once", at: new Date((change.now ?? new Date()).getTime() + change.minutes * 60_000).toISOString() };
  }
}

/** schedule (ISC-67): adds, replaces or removes a time trigger. Changes `triggers` and nothing else. */
export const changeSchedule = (change: ScheduleChange): Mutator => (doc, def) => {
  if (change.action === "remove") {
    const asIndex = /^\d+$/.test(change.target) ? Number(change.target) : null;
    let index: number;
    if (asIndex !== null) {
      if (asIndex >= def.triggers.length) throw new Refusal(`${def.name} has no trigger ${asIndex} (it has ${def.triggers.length}).`);
      index = asIndex;
    } else {
      const matches = def.triggers.flatMap((t, i) => (t.type === change.target ? [i] : []));
      if (!matches.length) throw new Refusal(`${def.name} has no ${change.target} trigger to remove.`);
      if (matches.length > 1) throw new Refusal(`${def.name} has ${matches.length} ${change.target} triggers; name one by position (${matches.join(", ")}).`);
      index = matches[0];
    }
    const removed = def.triggers[index];
    doc.deleteIn(["triggers", index]);
    return { removed, index };
  }
  const trigger = scheduleTrigger(change);
  const existing = def.triggers.findIndex(t => t.type === trigger.type);
  if (existing >= 0) {
    doc.setIn(["triggers", existing], doc.createNode(trigger));
    return { trigger, replaced: def.triggers[existing] };
  }
  if (doc.has("triggers")) doc.addIn(["triggers"], doc.createNode(trigger));
  else doc.set("triggers", doc.createNode([trigger]));
  return { trigger };
};

/** The schemas an after-link is judged on, for a refusal message that names both. */
export function linkSchemas(upstream: string, downstream: string, home: string = definitionsDir()): { upstream_output: unknown; downstream_input: unknown } {
  const find = definitionResolver(home);
  return { upstream_output: find(upstream)?.output ?? null, downstream_input: find(downstream)?.input ?? null };
}

/* ── Step edits (ISA F17: the canvas editor and `workflow step`) ─────────── */

/** A step id the editor accepts: a letter, then letters, digits, `_` or `-` (at most 64). */
export const STEP_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * The fields the step editor may set, by value shape. Which of them a kind may
 * carry, and which it needs, is the validator's call (KIND_KEYS in format.ts),
 * so an edit that puts `prompt` on a command step is refused there, verbatim.
 */
export const EDITABLE_STEP_FIELDS = {
  description: "text",
  uses: "text",
  lane: "text",
  prompt: "text",
  question: "text",
  workflow: "text",
  recipient: "text",
  argv: "list",
  env: "list",
  side_effects: "list",
  /** A JSON Schema object; model, agent and judgment steps must declare one. */
  output: "schema",
} as const;
export type EditableStepField = keyof typeof EDITABLE_STEP_FIELDS;
/** A field's new value; null removes the field. */
export type StepFieldPatch = Partial<Record<EditableStepField, string | string[] | Record<string, unknown> | null>>;

const MAX_FIELD_CHARS = 20_000;
const MAX_LIST_ITEMS = 200;

/** Checks a patch's shape; the validator judges the meaning after it is applied. */
export function checkStepPatch(patch: unknown): StepFieldPatch {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Refusal("The step fields must be an object of field names to values.");
  const out: StepFieldPatch = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in EDITABLE_STEP_FIELDS)) throw new Refusal(`"${key}" is not a step field the editor sets (${Object.keys(EDITABLE_STEP_FIELDS).join(", ")}).`);
    const shape = EDITABLE_STEP_FIELDS[key as EditableStepField];
    if (value === null) { out[key as EditableStepField] = null; continue; }
    if (shape === "text") {
      if (typeof value !== "string" || value.trim().length === 0) throw new Refusal(`${key} must be non-empty text (send null to remove it).`);
      if (value.length > MAX_FIELD_CHARS || value.includes("\0")) throw new Refusal(`${key} is too long or contains a NUL byte.`);
      out[key as EditableStepField] = value;
    } else if (shape === "schema") {
      if (typeof value !== "object" || value === null || Array.isArray(value) || JSON.stringify(value).length > MAX_FIELD_CHARS) throw new Refusal(`${key} must be a JSON Schema object (send null to remove it).`);
      out[key as EditableStepField] = value as Record<string, unknown>;
    } else {
      if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS || !value.every(v => typeof v === "string" && v.length <= MAX_FIELD_CHARS && !v.includes("\0"))) {
        throw new Refusal(`${key} must be a list of text items (send null to remove it).`);
      }
      out[key as EditableStepField] = value as string[];
    }
  }
  return out;
}

const hasStep = (def: DefinitionV2, id: string): boolean => Object.prototype.hasOwnProperty.call(def.steps, id);
const requireStep = (def: DefinitionV2, id: string): void => {
  if (!hasStep(def, id)) throw new Refusal(`${def.name} has no step "${id}".`);
};

/** The steps (and the result) that depend on `id`: by `needs`, or by a `$ref` into its output. */
export function dependentsOf(def: DefinitionV2, id: string): string[] {
  const ref = new RegExp(`"steps\\.${id.replace(/[-]/g, "\\-")}(\\.|")`);
  const reads = (v: unknown): boolean => v !== undefined && ref.test(JSON.stringify(v));
  const out: string[] = [];
  for (const [other, step] of Object.entries(def.steps)) {
    if (other === id) continue;
    if (step.needs.includes(id) || reads(step.with) || reads(step.when)) out.push(other);
  }
  if (reads(def.result)) out.push("result");
  return out;
}

/** connect: `from` must finish before `to` starts (adds `from` to `to.needs`). Cycles are the validator's refusal. */
export const connectSteps = (from: string, to: string): Mutator => (doc, def) => {
  requireStep(def, from);
  requireStep(def, to);
  if (from === to) throw new Refusal(`Step "${from}" cannot depend on itself.`);
  const needs = def.steps[to].needs;
  if (needs.includes(from)) throw new Refusal(`Step "${to}" already runs after "${from}".`);
  doc.setIn(["steps", to, "needs"], doc.createNode([...needs, from]));
  return { from, to, needs: [...needs, from] };
};

/** disconnect: drops `from` from `to.needs`. A `$ref` that still reads `from` makes the validator refuse it. */
export const disconnectSteps = (from: string, to: string): Mutator => (doc, def) => {
  requireStep(def, to);
  const needs = def.steps[to].needs;
  if (!needs.includes(from)) throw new Refusal(`Step "${to}" does not run after "${from}".`);
  const left = needs.filter(n => n !== from);
  if (left.length) doc.setIn(["steps", to, "needs"], doc.createNode(left));
  else doc.deleteIn(["steps", to, "needs"]);
  return { from, to, needs: left };
};

/** step set: writes or removes the given fields on one step; kind and dependencies are not touched. */
export const setStepFields = (id: string, patch: StepFieldPatch): Mutator => (doc, def) => {
  requireStep(def, id);
  const fields = checkStepPatch(patch);
  if (Object.keys(fields).length === 0) throw new Refusal("The edit names no fields.");
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) doc.deleteIn(["steps", id, key]);
    else doc.setIn(["steps", id, key], doc.createNode(value));
  }
  return { step: id, fields: Object.keys(fields) };
};

/** step add: a new step of `kind`, with its fields and the steps it runs after. */
export const addStep = (id: string, kind: string, patch: StepFieldPatch = {}, needs: string[] = []): Mutator => (doc, def) => {
  if (!STEP_ID_RE.test(id)) throw new Refusal(`"${id}" is not a step id (a letter, then letters, digits, _ or -, at most 64).`);
  if (hasStep(def, id)) throw new Refusal(`${def.name} already has a step "${id}".`);
  if (!(STEP_KINDS as readonly string[]).includes(kind)) throw new Refusal(`"${kind}" is not a step kind (${STEP_KINDS.join(", ")}).`);
  const fields = checkStepPatch(patch);
  for (const n of needs) requireStep(def, n);
  if (new Set(needs).size !== needs.length) throw new Refusal(`Step "${id}" lists a dependency more than once.`);
  const node: Record<string, unknown> = { kind };
  for (const [key, value] of Object.entries(fields)) if (value !== null) node[key] = value;
  if (needs.length) node.needs = needs;
  doc.setIn(["steps", id], doc.createNode(node));
  return { step: id, kind, needs };
};

/** step remove: refused while any step or the result depends on it, naming them. */
export const removeStep = (id: string): Mutator => (doc, def) => {
  requireStep(def, id);
  const dependents = dependentsOf(def, id);
  if (dependents.length) {
    const names = dependents.map(d => (d === "result" ? "the result" : `"${d}"`));
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    throw new Refusal(`Step "${id}" cannot be removed: ${list} depend${dependents.length === 1 ? "s" : ""} on it.`);
  }
  if (Object.keys(def.steps).length === 1) throw new Refusal(`"${id}" is the only step; a workflow needs at least one.`);
  doc.deleteIn(["steps", id]);
  return { step: id };
};
