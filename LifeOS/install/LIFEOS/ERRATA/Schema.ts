/**
 * @version 1.0.0
 * Schema.ts — the one Erratum shape every LifeOS system and app writes.
 *
 * An erratum is one moment a human was unhappy with a system we built, or a
 * system caught itself failing a human. Deterministic fields are written at
 * capture. Judged fields live only inside `enrichment`, which is null until a
 * model fills it and is versioned so a smarter model can redo it later.
 *
 * Lines in the ledger are either an Erratum or a Patch (`op: "patch"`) that
 * folds onto an earlier erratum by id at read time. The log is truth; nothing
 * is ever rewritten in place.
 */

export const SCHEMA_VERSION = 1 as const;
export const ENRICHMENT_VERSION = 1 as const;

import { readFileSync } from "fs";
import { join } from "path";
import { getClaudeDir } from "../TOOLS/Paths";

export function loadSystems(root = getClaudeDir()): string[] {
  let extras: unknown;
  try { extras = JSON.parse(readFileSync(join(root, "LIFEOS/USER/CONFIG/errata-systems.json"), "utf8")); }
  catch { return ["lifeos", "other"]; }
  if (!Array.isArray(extras) || !extras.every(value => typeof value === "string" && /^[a-z][a-z0-9-]*$/.test(value))) return ["lifeos", "other"];
  return [...new Set(["lifeos", ...extras, "other"])];
}
export const SYSTEMS: readonly string[] = loadSystems();
/** `detected`: a miss the evidence projector inferred from how the next prompt reacted (LIFEOS/EVIDENCE/Trigger.ts). Never a complaint rate input. */
export const SOURCES = ["principal", "team", "customer", "user", "hook", "agent", "job", "backfill", "detected"] as const;
export const CHANNELS = [
  "terminal", "er-command", "feedback-command", "hook:prompt", "hook:tool", "relay", "app-widget", "email", "github", "voice", "backfill", "workflow",
] as const;
export const KINDS = ["complaint", "bug", "feature-request", "correction", "praise", "question", "incident"] as const;
export const STATUSES = ["new", "enriched", "triaged", "upgrade-filed", "fixed", "wontfix", "duplicate"] as const;
export const TARGETS = ["instance", "lifeos-product"] as const;
export const REPORTER_ROLES = ["principal", "team", "customer", "user", "system"] as const;

export type System = string;
export type Source = (typeof SOURCES)[number];
export type Channel = (typeof CHANNELS)[number];
export type Kind = (typeof KINDS)[number];
export type Status = (typeof STATUSES)[number];
export type Target = (typeof TARGETS)[number];
export type ReporterRole = (typeof REPORTER_ROLES)[number];

/** Sources whose entries are written by code, not a human: rating must be null. */
export const MACHINE_SOURCES: ReadonlySet<Source> = new Set<Source>(["hook", "agent", "job", "detected"]);

export interface ToolCallSummary {
  name: string;
  summary: string;
}

/** One delegation made inside the judged turn: an Agent tool call or a Worker.ts leg. */
export interface DispatchSummary {
  /** subagent_type for an Agent call ("general-purpose" when unset); the capitalized lane for a Worker.ts leg. */
  agent: string;
  /** The model id the dispatch ran on. Null when it cannot be resolved — never the carrier by default. */
  model: string | null;
  vendor: "anthropic" | "openai" | "google" | "xai" | null;
  /** The Agent description, or the first 80 characters of the Worker task. */
  description: string | null;
}

export interface ErratumContext {
  /** The ask in flight when the complaint landed (last user prompt before it, or the ISA goal). */
  requested?: string | null;
  /** What the system was doing (phase, last tool calls in prose). */
  doing?: string | null;
  /** The response that drew the complaint: a preview and a content hash for exact matching. */
  response_preview?: string | null;
  response_hash?: string | null;
  session_id?: string | null;
  /** ISA slug or path when a run was active. */
  isa?: string | null;
  /** Best guess at the component complained about: a hook, skill, page, file. Free text. */
  component?: string | null;
  cwd?: string | null;
  /** Version of the system complained about (LifeOS version, app version). */
  version?: string | null;
  model?: string | null;
  tool_calls?: ToolCallSummary[];
  /** Every dispatch in the judged turn, so a rating can be traced to the models that did the work. Absent on rows before 2026-09-22. */
  dispatches?: DispatchSummary[] | null;
  /** Output-ledger ids (out_<uuid>) delivered in the same session since the previous typed prompt: ordered, at most 20. Empty when none or no ledger (assay-everywhere S10). */
  output_ids?: string[];
}

export interface Reporter {
  /** Stable id: principal, a team member id, a customer/tenant user id. Never an email in the clear for customers. */
  id: string;
  role: ReporterRole;
  name?: string | null;
  contact?: string | null;
}

export interface Enrichment {
  ts: string;
  model: string;
  enrichment_version: number;
  how_upset: 0 | 1 | 2 | 3;
  which_part: string;
  what_upset: string;
  reporter_right: boolean | null;
  reporter_right_reason: string;
  root_cause_hypothesis: string;
  /** Cluster label, snake_case, stable across entries of the same failure class. */
  class: string;
  proposed_fix: string;
  confidence: number;
}

export interface ErratumLinks {
  upgrade_id?: string;
  issue?: string;
  incident?: string;
  commit?: string;
  /** FAILURES context dir when one was captured alongside. */
  failure_dir?: string;
}

export interface Erratum {
  schema: typeof SCHEMA_VERSION;
  id: string;
  ts: string;
  system: System;
  /** Install or tenant the entry came from: a hostname hash for LifeOS, a tenant id for an app. */
  instance: string;
  /** Whether feedback is about this install or about the LifeOS product itself. */
  target: Target;
  source: Source;
  channel: Channel;
  kind: Kind;
  /** A number the human actually gave (1–10). Never inferred. */
  rating: number | null;
  /** Deterministic frustration signal at capture, 0–3. Null when not computed. */
  frustration: 0 | 1 | 2 | 3 | null;
  /** Verbatim words, secrets redacted. */
  complaint: string;
  context: ErratumContext;
  reporter: Reporter;
  attachments: string[];
  enrichment: Enrichment | null;
  status: Status;
  links: ErratumLinks;
  tags: string[];
  /** Optional idempotence key (backfill, app sync). Two lines with the same key are one erratum. */
  dedupe_key?: string;
}

export interface Patch {
  schema: typeof SCHEMA_VERSION;
  op: "patch";
  id: string;
  ts: string;
  patch: Partial<Pick<Erratum, "enrichment" | "status" | "links" | "tags" | "attachments">>;
}

export type LedgerLine = Erratum | Patch;

/** What a caller supplies; the store fills id, ts, schema, defaults. */
export type NewErratum = Omit<Erratum, "schema" | "id" | "ts" | "status" | "links" | "tags" | "attachments" | "enrichment" | "rating" | "frustration" | "instance" | "target"> &
  Partial<Pick<Erratum, "ts" | "status" | "links" | "tags" | "attachments" | "rating" | "frustration" | "instance" | "target" | "dedupe_key">>;

export const ID_RE = /^ERR-\d{8}-\d{6}-[a-z0-9]{4}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isOneOf<T extends readonly string[]>(list: T, v: unknown): v is T[number] {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

/** Returns the list of violations; empty means valid. Never throws. */
export function validateErratum(e: unknown, systems: readonly string[] = SYSTEMS): string[] {
  const errs: string[] = [];
  if (!e || typeof e !== "object") return ["not an object"];
  const x = e as Record<string, unknown>;
  if (x.schema !== SCHEMA_VERSION) errs.push(`schema must be ${SCHEMA_VERSION}`);
  if (typeof x.id !== "string" || !ID_RE.test(x.id)) errs.push("id missing or malformed");
  if (typeof x.ts !== "string" || !ISO_RE.test(x.ts)) errs.push("ts missing or not ISO-8601");
  if (!isOneOf(systems, x.system)) errs.push("system missing or unknown");
  if (typeof x.instance !== "string" || !x.instance) errs.push("instance missing");
  if (!isOneOf(TARGETS, x.target)) errs.push("target missing or unknown");
  if (!isOneOf(SOURCES, x.source)) errs.push("source missing or unknown");
  if (!isOneOf(CHANNELS, x.channel)) errs.push("channel missing or unknown");
  if (!isOneOf(KINDS, x.kind)) errs.push("kind missing or unknown");
  if (!isOneOf(STATUSES, x.status)) errs.push("status missing or unknown");
  if (typeof x.complaint !== "string" || !x.complaint.trim()) errs.push("complaint missing or empty");
  if (!(x.rating === null || (typeof x.rating === "number" && x.rating >= 1 && x.rating <= 10))) errs.push("rating must be null or 1–10");
  if (x.rating !== null && isOneOf(SOURCES, x.source) && MACHINE_SOURCES.has(x.source)) errs.push("rating must be null for a machine source (never fabricate a number)");
  if (!(x.frustration === null || [0, 1, 2, 3].includes(x.frustration as number))) errs.push("frustration must be null or 0–3");
  if (!x.context || typeof x.context !== "object") errs.push("context missing");
  else {
    errs.push(...validateDispatches((x.context as Record<string, unknown>).dispatches));
    const oi = (x.context as Record<string, unknown>).output_ids;
    if (oi !== undefined && (!Array.isArray(oi) || oi.length > 20 || !oi.every((v) => typeof v === "string" && v.length > 0))) errs.push("context.output_ids must be an array of at most 20 non-empty strings");
  }
  const r = x.reporter as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.id || !isOneOf(REPORTER_ROLES, r.role)) errs.push("reporter missing id or role");
  if (!Array.isArray(x.attachments)) errs.push("attachments must be an array");
  if (!Array.isArray(x.tags)) errs.push("tags must be an array");
  if (!x.links || typeof x.links !== "object") errs.push("links missing");
  if (x.enrichment !== null) errs.push(...validateEnrichment(x.enrichment).map((m) => `enrichment: ${m}`));
  return errs;
}

const DISPATCH_VENDORS = new Set(["anthropic", "openai", "google", "xai"]);

/** context.dispatches is optional: absent or null is valid; an array must hold well-formed summaries. */
function validateDispatches(d: unknown): string[] {
  if (d === undefined || d === null) return [];
  if (!Array.isArray(d)) return ["context.dispatches must be an array or null"];
  const errs: string[] = [];
  d.forEach((x: any, i) => {
    if (!x || typeof x !== "object" || typeof x.agent !== "string" || !x.agent) errs.push(`context.dispatches[${i}].agent missing`);
    else {
      if (!(x.model === null || typeof x.model === "string")) errs.push(`context.dispatches[${i}].model must be a string or null`);
      if (!(x.vendor === null || DISPATCH_VENDORS.has(x.vendor))) errs.push(`context.dispatches[${i}].vendor unknown`);
      if (!(x.description === null || typeof x.description === "string")) errs.push(`context.dispatches[${i}].description must be a string or null`);
    }
  });
  return errs;
}

export function validateEnrichment(en: unknown): string[] {
  const errs: string[] = [];
  if (!en || typeof en !== "object") return ["not an object"];
  const x = en as Record<string, unknown>;
  if (typeof x.model !== "string" || !x.model) errs.push("model missing (only a model run may write enrichment)");
  if (typeof x.ts !== "string" || !ISO_RE.test(x.ts)) errs.push("ts missing");
  if (typeof x.enrichment_version !== "number") errs.push("enrichment_version missing");
  if (![0, 1, 2, 3].includes(x.how_upset as number)) errs.push("how_upset must be 0–3");
  for (const k of ["which_part", "what_upset", "reporter_right_reason", "root_cause_hypothesis", "class", "proposed_fix"]) {
    if (typeof x[k] !== "string") errs.push(`${k} must be a string`);
  }
  if (typeof x.class === "string" && !/^[a-z0-9_]+$/.test(x.class)) errs.push("class must be snake_case");
  if (!(x.reporter_right === null || typeof x.reporter_right === "boolean")) errs.push("reporter_right must be boolean or null");
  if (typeof x.confidence !== "number" || x.confidence < 0 || x.confidence > 1) errs.push("confidence must be 0–1");
  return errs;
}

export function validatePatch(p: unknown): string[] {
  const errs: string[] = [];
  if (!p || typeof p !== "object") return ["not an object"];
  const x = p as Record<string, unknown>;
  if (x.schema !== SCHEMA_VERSION) errs.push(`schema must be ${SCHEMA_VERSION}`);
  if (x.op !== "patch") errs.push("op must be patch");
  if (typeof x.id !== "string" || !ID_RE.test(x.id)) errs.push("id missing or malformed");
  if (typeof x.ts !== "string" || !ISO_RE.test(x.ts)) errs.push("ts missing");
  const patch = x.patch as Record<string, unknown> | undefined;
  if (!patch || typeof patch !== "object") return [...errs, "patch missing"];
  const allowed = new Set(["enrichment", "status", "links", "tags", "attachments"]);
  for (const k of Object.keys(patch)) if (!allowed.has(k)) errs.push(`patch key not allowed: ${k}`);
  if ("status" in patch && !isOneOf(STATUSES, patch.status)) errs.push("patch.status unknown");
  if ("enrichment" in patch && patch.enrichment !== null) errs.push(...validateEnrichment(patch.enrichment).map((m) => `patch.enrichment: ${m}`));
  return errs;
}

export function isPatch(line: LedgerLine): line is Patch {
  return (line as Patch).op === "patch";
}
