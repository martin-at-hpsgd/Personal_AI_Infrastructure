/**
 * Workflows V2 page actions: the pure half. The Run form is generated from a
 * workflow's `input` schema (ISC-93) and the Start control stays disabled until
 * `checkInput` passes; the server re-checks with the engine's own validator
 * before any step starts (ISC-92), so this check only decides the button.
 *
 * Every write goes to a Pulse route that calls an engine module; this file
 * only shapes the request and reads the answer.
 */

import { ApiError, apiSend } from "@/lib/api";

export type FieldType = "string" | "number" | "integer" | "boolean" | "json";

export interface FormField {
  key: string;
  type: FieldType;
  required: boolean;
  description: string | null;
  enumValues: string[] | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The fields a schema asks for. An object schema gives one field per property;
 * anything else (no schema, a non-object root) gives no fields and the form
 * sends `{}`. A property whose type is not a scalar is edited as JSON text.
 */
export function fieldsOf(schema: unknown): FormField[] {
  if (!isObj(schema) || !isObj(schema.properties)) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === "string") : []);
  return Object.entries(schema.properties).map(([key, p]) => {
    const t = isObj(p) ? p.type : undefined;
    const type: FieldType = t === "string" || t === "number" || t === "integer" || t === "boolean" ? t : "json";
    const enumValues = isObj(p) && Array.isArray(p.enum) ? p.enum.map(String) : null;
    return { key, type, required: required.has(key), description: isObj(p) && typeof p.description === "string" ? p.description : null, enumValues };
  });
}

export type InputCheck = { ok: true; value: Record<string, unknown> } | { ok: false; errors: Record<string, string> };

/** The form's text values → the input object, or one plain sentence per field that is wrong. */
export function checkInput(fields: FormField[], values: Record<string, string>): InputCheck {
  const out: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const raw = (values[f.key] ?? "").trim();
    if (raw === "") {
      if (f.required) errors[f.key] = "Required.";
      continue;
    }
    switch (f.type) {
      case "string":
        if (f.enumValues && !f.enumValues.includes(raw)) errors[f.key] = `One of: ${f.enumValues.join(", ")}.`;
        else out[f.key] = raw;
        break;
      case "number":
      case "integer": {
        const n = Number(raw);
        if (!Number.isFinite(n)) errors[f.key] = "Must be a number.";
        else if (f.type === "integer" && !Number.isInteger(n)) errors[f.key] = "Must be a whole number.";
        else out[f.key] = n;
        break;
      }
      case "boolean":
        if (raw !== "true" && raw !== "false") errors[f.key] = "Must be true or false.";
        else out[f.key] = raw === "true";
        break;
      case "json":
        try { out[f.key] = JSON.parse(raw); } catch { errors[f.key] = "Must be JSON."; }
        break;
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: out };
}

export type ActionOutcome = { ok: true; body: Record<string, unknown> } | { ok: false; reason: string; body: Record<string, unknown> | null };

const ACTION_TIMEOUT_MS = 20_000;

/**
 * POST one page action. The server answers with `reason` on every refusal (the
 * validator's own message for an edit), which is what the form shows.
 */
export async function postAction(route: string, body: unknown): Promise<ActionOutcome> {
  let status = 200;
  let parsed: unknown = null;
  try {
    parsed = await apiSend(route, "POST", body, { signal: AbortSignal.timeout(ACTION_TIMEOUT_MS) });
  } catch (e) {
    if (e instanceof ApiError) {
      status = e.status;
      try { parsed = JSON.parse(e.body); } catch { return { ok: false, reason: `The server answered HTTP ${e.status} without a readable result.`, body: null }; }
    } else if (e instanceof SyntaxError) {
      return { ok: false, reason: "The server answered HTTP 200 without a readable result.", body: null };
    } else {
      return { ok: false, reason: e instanceof Error && e.name === "TimeoutError" ? "The request timed out." : "The Pulse server did not answer.", body: null };
    }
  }
  const b = isObj(parsed) ? parsed : {};
  if (status < 400 && b.ok !== false) return { ok: true, body: b };
  const reason = typeof b.reason === "string" ? b.reason : typeof b.error === "string" ? b.error : `The server answered HTTP ${status}.`;
  return { ok: false, reason, body: b };
}

export interface PendingApproval { run_id: string; workflow: string; step_id: string; prompt: string; parked_at: string }

export function parseWaiting(raw: unknown): { ok: true; value: PendingApproval[] } | { ok: false; reason: string } {
  if (!isObj(raw) || !Array.isArray(raw.waiting)) return { ok: false, reason: "the waiting response has no list" };
  return {
    ok: true,
    value: raw.waiting.filter((w): w is PendingApproval => isObj(w) && typeof w.run_id === "string" && typeof w.workflow === "string" && typeof w.step_id === "string" && typeof w.parked_at === "string")
      .map((w) => ({ ...w, prompt: typeof w.prompt === "string" ? w.prompt : "" })),
  };
}

export type PauseState = { available: boolean; paused: boolean | null; reason?: string };
export function parsePauseState(raw: unknown): PauseState {
  if (!isObj(raw)) return { available: false, paused: null, reason: "the pause-state response was not an object" };
  return { available: raw.available === true, paused: typeof raw.paused === "boolean" ? raw.paused : null, ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}) };
}
