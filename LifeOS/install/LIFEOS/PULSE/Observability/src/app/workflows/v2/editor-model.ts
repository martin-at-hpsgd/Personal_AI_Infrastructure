/**
 * Canvas editor (ISA F17) — the pure half. What the inspector shows for each
 * step kind, how a form's values become the smallest field patch, how the
 * editor read is shape-checked, and how Undo is remembered. The server
 * (LIFEOS/PULSE/modules/workflows.ts) and the engine's validator decide what
 * is allowed; nothing here judges a definition.
 */

export const STEP_KINDS = ["action", "command", "model", "agent", "judgment", "human", "workflow"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export type FieldShape = "text" | "long" | "list" | "schema" | "lane";
export interface FieldSpec { key: string; shape: FieldShape; label: string; required?: boolean; readOnly?: boolean }

const F = {
  description: { key: "description", shape: "text", label: "description" },
  uses: { key: "uses", shape: "text", label: "action", required: true },
  argv: { key: "argv", shape: "list", label: "argv", readOnly: true },
  env: { key: "env", shape: "list", label: "env", readOnly: true },
  lane: { key: "lane", shape: "lane", label: "lane", required: true },
  prompt: { key: "prompt", shape: "long", label: "prompt", required: true },
  question: { key: "question", shape: "long", label: "question", required: true },
  workflow: { key: "workflow", shape: "text", label: "runs workflow", required: true },
  side_effects: { key: "side_effects", shape: "list", label: "side effects" },
  recipient: { key: "recipient", shape: "text", label: "recipient" },
  output: { key: "output", shape: "schema", label: "output schema", required: true },
  outputOptional: { key: "output", shape: "schema", label: "output schema" },
} satisfies Record<string, FieldSpec>;

/** The fields each kind uses, in the order the inspector shows them (ISC-158). */
export const FIELDS_BY_KIND: Record<StepKind, FieldSpec[]> = {
  action: [F.description, F.uses, F.side_effects, F.recipient],
  command: [F.description, F.argv, F.env, F.side_effects, F.recipient],
  model: [F.description, F.lane, F.prompt, F.output, F.side_effects],
  agent: [F.description, F.lane, F.prompt, F.output, F.side_effects],
  judgment: [F.description, F.question, F.output],
  human: [F.description, F.prompt, F.outputOptional, F.side_effects, F.recipient],
  workflow: [F.description, F.workflow, F.side_effects],
};

export const fieldsFor = (kind: string): FieldSpec[] => FIELDS_BY_KIND[kind as StepKind] ?? [F.description];

/** A field's stored value as the text a form input holds. Lists are one item per line; schemas are pretty JSON. */
export function toFormText(shape: FieldShape, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (shape === "list") return Array.isArray(value) ? value.map(String).join("\n") : typeof value === "object" ? Object.keys(value as object).join("\n") : String(value);
  if (shape === "schema") return JSON.stringify(value, null, 2);
  return String(value);
}

export type PatchResult = { ok: true; patch: Record<string, unknown> } | { ok: false; errors: Record<string, string> };

/**
 * The smallest patch that turns the stored step into the form's values:
 * unchanged fields are left out, a cleared optional field is null (remove),
 * read-only fields never appear. Shape errors stay on the page; meaning is the
 * validator's call.
 */
export function stepPatch(kind: string, stored: Record<string, unknown>, form: Record<string, string>): PatchResult {
  const patch: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of fieldsFor(kind)) {
    if (f.readOnly || !(f.key in form)) continue;
    const raw = form[f.key];
    if (raw === toFormText(f.shape, stored[f.key])) continue;
    const blank = raw.trim() === "";
    if (blank) {
      if (f.required) errors[f.key] = `A ${kind} step needs ${f.label}.`;
      else patch[f.key] = null;
      continue;
    }
    if (f.shape === "list") patch[f.key] = raw.split("\n").map((x) => x.trim()).filter(Boolean);
    else if (f.shape === "schema") {
      try {
        const v: unknown = JSON.parse(raw);
        if (typeof v !== "object" || v === null || Array.isArray(v)) errors[f.key] = "The schema must be a JSON object.";
        else patch[f.key] = v;
      } catch (e) {
        errors[f.key] = `Not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
      }
    } else patch[f.key] = raw;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, patch };
}

/** The one text a new step of this kind cannot start without (the page asks for it in the Add form). */
export const ADD_REQUIRES: Partial<Record<StepKind, { key: "uses" | "workflow"; label: string }>> = {
  action: { key: "uses", label: "action to use" },
  workflow: { key: "workflow", label: "workflow to run" },
};

/** Kinds the page adds; a command step comes from the CLI (ISC-172). */
export const PAGE_ADD_KINDS: StepKind[] = STEP_KINDS.filter((k) => k !== "command");

/** Starting fields for Add step, so a new step of any kind validates as added and is refined in the inspector (ISC-159). */
export function newStepFields(kind: StepKind, lane: string, required = ""): Record<string, unknown> {
  const answer = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };
  switch (kind) {
    case "action": return { uses: required.trim() };
    case "command": return {};
    case "model":
    case "agent": return { lane, prompt: "Describe what this step should produce.", output: answer };
    case "judgment": return { question: "Should this go ahead?", output: { type: "object", properties: { act: { type: "boolean" } }, required: ["act"] } };
    case "human": return { prompt: "Approve this?" };
    case "workflow": return { workflow: required.trim() };
  }
}

/* ── The editor read: GET /api/workflows/definition?name= ── */

export type DeployDrift = { state: "never-deployed" } | { state: "current"; deployed_at: string } | { state: "changed"; deployed_at: string };

export interface TemplateInfo { kind: string; summary: string; requires: string[] }

export interface EditorDoc {
  name: string;
  path: string;
  hash: string;
  text: string;
  runsOn: string | null;
  steps: Record<string, Record<string, unknown>>;
  parseError: string | null;
  deploy: DeployDrift | null;
  options: { kinds: string[]; sideEffects: string[]; lanes: string[]; templates: TemplateInfo[] };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function parseDeploy(v: unknown): DeployDrift | null {
  if (!isObj(v)) return null;
  if (v.state === "never-deployed") return { state: "never-deployed" };
  if ((v.state === "current" || v.state === "changed") && typeof v.deployed_at === "string") return { state: v.state, deployed_at: v.deployed_at };
  return null;
}

export function parseEditorDoc(raw: unknown): { ok: true; value: EditorDoc } | { ok: false; reason: string } {
  if (!isObj(raw)) return { ok: false, reason: "the editor read was not an object" };
  if (raw.ok === false) return { ok: false, reason: typeof raw.reason === "string" ? raw.reason : "the server refused the read" };
  if (typeof raw.name !== "string" || typeof raw.hash !== "string" || typeof raw.text !== "string") return { ok: false, reason: "the editor read has no name, hash or text" };
  const steps: Record<string, Record<string, unknown>> = {};
  if (isObj(raw.steps)) for (const [id, s] of Object.entries(raw.steps)) if (isObj(s)) steps[id] = s;
  const o = isObj(raw.options) ? raw.options : {};
  return {
    ok: true,
    value: {
      name: raw.name,
      path: typeof raw.path === "string" ? raw.path : "",
      hash: raw.hash,
      text: raw.text,
      runsOn: typeof raw.runs_on === "string" ? raw.runs_on : null,
      steps,
      parseError: typeof raw.parse_error === "string" ? raw.parse_error : null,
      deploy: parseDeploy(raw.deploy),
      options: {
        kinds: strs(o.kinds).length ? strs(o.kinds) : [...STEP_KINDS],
        sideEffects: strs(o.side_effects),
        lanes: strs(o.lanes),
        templates: (Array.isArray(o.templates) ? o.templates : []).filter(isObj).filter((t) => typeof t.kind === "string")
          .map((t) => ({ kind: t.kind as string, summary: typeof t.summary === "string" ? t.summary : "", requires: strs(t.requires) })),
      },
    },
  };
}

/** The label a cloud workflow carries on the canvas (ISC-174). Null when there is nothing to say. */
export function deployLabel(d: DeployDrift | null | undefined): { text: string; tone: "warn" | "muted" } | null {
  if (!d) return null;
  if (d.state === "changed") return { text: "changed since deploy", tone: "warn" };
  if (d.state === "never-deployed") return { text: "never deployed", tone: "muted" };
  return null;
}

/* ── Undo (ISC-163) ── */

/** One step back: put the previous text over the hash the edit produced, or remove what New created. */
export type UndoEntry =
  | { kind: "put"; name: string; text: string; hash: string; label: string }
  | { kind: "new"; name: string; hash: string; label: string };

export const UNDO_DEPTH = 20;

export function pushUndo(stack: UndoEntry[], e: UndoEntry): UndoEntry[] {
  return [...stack, e].slice(-UNDO_DEPTH);
}

/** The request that undoes an entry. Both routes carry the hash, so an Undo over someone else's later edit is refused as stale. */
export function undoRequest(e: UndoEntry): { route: string; body: Record<string, unknown> } {
  return e.kind === "put"
    ? { route: "/api/workflows/definition", body: { name: e.name, text: e.text, base_hash: e.hash } }
    : { route: "/api/workflows/remove", body: { name: e.name, base_hash: e.hash } };
}

/** An edit response's reason plus any validator issues, verbatim (ISC-156, ISC-158). */
export function refusalText(body: Record<string, unknown> | null, reason: string): string {
  const issues = body && Array.isArray(body.issues)
    ? body.issues.filter(isObj).map((i) => (typeof i.message === "string" ? i.message : "")).filter((m) => m && !reason.includes(m))
    : [];
  return [reason, ...issues].join(" ");
}

export const STEP_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
