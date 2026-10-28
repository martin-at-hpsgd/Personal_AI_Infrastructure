/**
 * The cloud runner Worker (F10): one Worker per cloud workflow, built by
 * build.ts from the engine source as it is at build time (ISC-32).
 *
 * Routes:
 *   GET  /health       unauthenticated; `{"ok":true}` and nothing else (ISC-133)
 *   POST /run          bearer only, 401 otherwise; runs the workflow once
 *   GET  /outbox       bearer only; pending ledger records for the local puller (ISC-34)
 *   POST /outbox/ack   bearer only; deletes records the puller has appended
 * Cron: every minute; the matcher (match.ts) decides whether a schedule is due. Every 15th minute the
 * cron first sweeps in-flight markers past their deadline and closes each dead run with an `abandoned`
 * record, so a run Cloudflare killed shows in the ledger instead of vanishing.
 *
 * Every run reads the global pause from KV first and starts nothing while it is
 * engaged (ISC-137), then takes its occurrence in the shared D1 claims database
 * (claims.ts, ISC-276). Only `action` steps run in the cloud: each calls its
 * action Worker through a service binding with the v1 action envelope. A definition
 * with any other step kind, or a step naming a host `authority:`, is refused before a step runs.
 */
import { normalizeActionSchema, runWorkflow, type ActionRegistry, type V1Result } from "../engine/v1.ts";
import { parseDefinitionText, toV1, compiledUses, type DefinitionV2, type TriggerV2 } from "../engine/format.ts";
import { isTriggerRef, refsUnder, TRIGGER_INPUT_KEY } from "../engine/format-rules.ts";
import { assertRecord, digest, type LedgerRecord, type LedgerStep } from "../engine/ledger.ts";
import { bearerAuthorized } from "./auth.ts";
import { dueOccurrences } from "./match.ts";
import { claimOccurrence, pruneClaims, type D1Like } from "./claims.ts";
import { ackOutbox, clearInflight, markInflight, pauseEngaged, readInflight, readOutbox, writeOutbox, type CloudLedgerRecord, type InflightMarker, type KvLike } from "./outbox.ts";

export interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}

export interface CloudActionManifest {
  /** Env binding name of the action Worker's service binding. */
  binding: string;
  /** The deployed action Worker's script name (read-only preflight checks it exists). */
  script: string;
  input: unknown;
  output: unknown;
}

/** Everything build.ts bakes into a runner. */
export interface RunnerManifest {
  definition: string;
  /** sha256 hex of `definition`. */
  definitionHash: string;
  actions: Record<string, CloudActionManifest>;
}

export interface RunnerEnv {
  RUNNER_TOKEN?: string;
  /** Pause flag, in-flight markers and the ledger outbox. */
  STATE: KvLike;
  /** The shared `wf-claims` D1 database: occurrence claims (ISC-276). */
  CLAIMS: D1Like;
  /** Bearer the action Workers expect, when they check one. */
  ACTION_TOKEN?: string;
  [binding: string]: unknown;
}

export type RunVerdict =
  | { status: "paused" }
  | { status: "disabled" }
  | { status: "duplicate"; occurrence_key: string }
  | { status: "ran"; record: CloudLedgerRecord };

const LEDGER_ERROR_CHARS = 300;
/** Cloudflare ends a scheduled run at 15 minutes; an HTTP run gets the same budget with room to spare. */
export const RUN_DEADLINE_MS = 60 * 60_000;
const SWEEP_EVERY_MINUTES = 15;
const MAX_BARE_URL = 4096;

/** A manual trigger's `body: url`: exactly one http(s) URL with a host, no inner whitespace, at most 4 KiB; null otherwise. */
export function bareUrl(body: string): string | null {
  const text = body.trim();
  if (!text || text.length > MAX_BARE_URL || /\s/.test(text)) return null;
  try {
    const u = new URL(text);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname ? text : null;
  } catch {
    return null;
  }
}
const ABANDONED_ERROR = "The cloud run stopped before it wrote its ledger line (Cloudflare ends a scheduled run at 15 minutes, or it crashed); its deadline passed with no record.";
const STEP_ERROR = "Run died before recording this step.";
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, LEDGER_ERROR_CHARS);

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Parses the baked definition and refuses anything the cloud cannot run. Throws; the build calls this too. */
export function cloudDefinition(manifest: RunnerManifest): DefinitionV2 {
  const def = parseDefinitionText(manifest.definition);
  if (def.runs_on !== "cloud") throw new Error(`Workflow ${def.name} is runs_on: ${def.runs_on}, not cloud`);
  for (const step of Object.values(def.steps)) {
    if (step.kind !== "action") throw new Error(`Step ${step.id} is a ${step.kind} step; the cloud runner runs action steps only`);
    if (!step.uses || !Object.hasOwn(manifest.actions, step.uses)) throw new Error(`Step ${step.id} uses ${step.uses ?? "(nothing)"}, which has no cloud action in the manifest`);
    // The cloud has no host to ask, so a step that names one is refused rather than run unchecked (ISC-254).
    if (step.authority !== undefined) throw new Error(`Step ${step.id} names authority ${step.authority.join(", ")}; the cloud runner registers no host authority to check it`);
  }
  return def;
}

function registryFor(def: DefinitionV2, manifest: RunnerManifest, env: RunnerEnv): ActionRegistry {
  const registry: ActionRegistry = Object.create(null);
  for (const step of Object.values(def.steps)) {
    const action = manifest.actions[step.uses as string];
    const binding = Object.hasOwn(env, action.binding) ? env[action.binding] as ServiceBinding : undefined;
    if (!binding || typeof binding.fetch !== "function") throw new Error(`Missing service binding ${action.binding} for action ${step.uses}`);
    registry[compiledUses(step.id)] = {
      input: normalizeActionSchema(action.input),
      output: normalizeActionSchema(action.output),
      async execute(input, context) {
        const response = await binding.fetch(new Request("https://workflows.internal/", {
          method: "POST",
          headers: { "content-type": "application/json", ...(env.ACTION_TOKEN ? { authorization: `Bearer ${env.ACTION_TOKEN}` } : {}) },
          body: JSON.stringify(input),
          signal: context.signal,
        }));
        if (!response.ok) throw new Error(`Action ${step.uses} returned HTTP ${response.status}`);
        const envelope = await response.json() as { success?: unknown; output?: unknown };
        if (envelope === null || typeof envelope !== "object" || envelope.success !== true || !Object.hasOwn(envelope, "output")) {
          throw new Error(`Action ${step.uses} returned an invalid or unsuccessful envelope`);
        }
        return envelope.output;
      },
    };
  }
  return registry;
}

/** Same rule as the local runner: the reserved trigger key is added only when a step or the result reads it. */
function graphInput(def: DefinitionV2, input: unknown, trigger: Record<string, unknown>): unknown {
  const reads = Object.values(def.steps).some(s => [...refsUnder(s.with, "")].some(r => isTriggerRef(r.ref)) || (s.when !== undefined && isTriggerRef(s.when.ref)))
    || [...refsUnder(def.result, "")].some(r => isTriggerRef(r.ref));
  if (!reads || input === null || typeof input !== "object" || Array.isArray(input)) return input;
  return { ...(input as Record<string, unknown>), [TRIGGER_INPUT_KEY]: trigger };
}

/** The ledger record for one finished cloud run, checked by the engine's own assertRecord before it goes anywhere. */
export function cloudRecord(args: {
  def: DefinitionV2; hash: string; runId: string; trigger: TriggerV2["type"]; occurrenceKey: string;
  startedAt: string; finishedAt: string; result: V1Result;
}): CloudLedgerRecord {
  const steps: Record<string, LedgerStep> = {};
  for (const id of Object.keys(args.def.steps)) {
    const s = args.result.steps[id];
    const step: LedgerStep = { status: s?.status ?? "skipped", attempts: s?.attempts ?? 0 };
    if (s?.output !== undefined) step.output_digest = digest(s.output);
    if (s?.error) step.error = oneLine(s.error);
    if (s?.timed_out) step.timed_out = true;
    steps[id] = step;
  }
  const record: CloudLedgerRecord = {
    schema: 1,
    run_id: args.runId,
    workflow: args.def.name,
    definition_path: `cloud:${args.def.name}`,
    definition_hash: args.hash,
    trigger: args.trigger,
    occurrence_key: args.occurrenceKey,
    data_class: args.def.data_class,
    runs_on: "cloud",
    started_at: args.startedAt,
    finished_at: args.finishedAt,
    status: args.result.success ? "succeeded" : "failed",
    steps,
    output_digest: args.result.output === undefined ? null : digest(args.result.output),
  };
  if (!args.result.success && args.result.error) record.error = oneLine(args.result.error);
  // ledger.ts types runs_on as "local" only; assertRecord checks the shape, not that field.
  assertRecord(record as unknown as LedgerRecord);
  return record;
}

/** The ledger record for a run whose in-flight marker outlived its deadline. */
export function abandonedCloudRecord(marker: InflightMarker, now: Date): CloudLedgerRecord {
  const steps: Record<string, LedgerStep> = {};
  for (const id of marker.steps.length ? marker.steps : ["run"]) steps[id] = { status: "skipped", attempts: 0, started_at: null, duration_ms: 0, error: STEP_ERROR };
  const record: CloudLedgerRecord = {
    schema: 1,
    run_id: marker.run_id,
    workflow: marker.workflow,
    definition_path: `cloud:${marker.workflow}`,
    definition_hash: marker.definition_hash,
    trigger: marker.trigger,
    occurrence_key: marker.occurrence_key,
    data_class: marker.data_class,
    runs_on: "cloud",
    started_at: marker.started_at,
    finished_at: now.toISOString(),
    status: "abandoned",
    steps,
    output_digest: null,
    error: ABANDONED_ERROR,
  };
  assertRecord(record as unknown as LedgerRecord);
  return record;
}

export function createRunner(manifest: RunnerManifest, clock: () => Date = () => new Date()) {
  const def = cloudDefinition(manifest);

  async function runOnce(env: RunnerEnv, trigger: TriggerV2["type"], occurrenceKey: string, input: unknown, scheduledFor?: string): Promise<RunVerdict> {
    if (def.enabled === false) return { status: "disabled" }; // a disabled workflow starts nothing, as in the embedded runtime
    if (await pauseEngaged(env.STATE)) return { status: "paused" };
    const runId = crypto.randomUUID();
    if (!(await claimOccurrence(env.CLAIMS, def.name, occurrenceKey, runId, clock()))) return { status: "duplicate", occurrence_key: occurrenceKey };
    const hash = await sha256Hex(manifest.definition);
    if (hash !== manifest.definitionHash) throw new Error("The baked definition does not match its build-time hash");
    const started = clock();
    const startedAt = started.toISOString();
    await markInflight(env.STATE, {
      run_id: runId, workflow: def.name, occurrence_key: occurrenceKey, trigger, definition_hash: hash, data_class: def.data_class,
      steps: Object.keys(def.steps), started_at: startedAt, deadline_at: new Date(started.getTime() + RUN_DEADLINE_MS).toISOString(),
    });
    let result: V1Result;
    try {
      const registry = registryFor(def, manifest, env);
      const triggerCtx = { type: trigger, occurrence_key: occurrenceKey, run_id: runId, ...(scheduledFor ? { scheduled_for: scheduledFor } : {}) };
      result = await runWorkflow(toV1(def), graphInput(def, input, triggerCtx), registry);
    } catch (error) {
      result = { success: false, error: error instanceof Error ? error.message : String(error), steps: {} };
    }
    const record = cloudRecord({ def, hash, runId, trigger, occurrenceKey, startedAt, finishedAt: clock().toISOString(), result });
    await writeOutbox(env.STATE, record);
    await clearInflight(env.STATE, runId);
    return { status: "ran", record };
  }

  /** Closes every in-flight run past its deadline with an `abandoned` outbox record; returns their run ids. */
  async function sweepInflight(env: RunnerEnv): Promise<string[]> {
    const now = clock();
    const swept: string[] = [];
    for (const { key, marker } of await readInflight(env.STATE)) {
      if (marker === null) { await env.STATE.delete(key); continue; }
      if (!(Date.parse(marker.deadline_at) <= now.getTime())) continue;
      await writeOutbox(env.STATE, abandonedCloudRecord(marker, now));
      await clearInflight(env.STATE, marker.run_id);
      swept.push(marker.run_id);
    }
    return swept;
  }

  return {
    definition: def,
    runOnce,
    sweepInflight,
    async fetch(request: Request, env: RunnerEnv): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
        return Response.json({ ok: true });
      }
      const routes = new Set(["/run", "/outbox", "/outbox/ack"]);
      if (!routes.has(url.pathname)) return new Response("Not found", { status: 404 });
      if (!(await bearerAuthorized(request.headers.get("authorization"), env.RUNNER_TOKEN))) return new Response("Unauthorized", { status: 401 });

      if (url.pathname === "/outbox") {
        if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
        const limit = Number(url.searchParams.get("limit") ?? "100");
        return Response.json({ entries: await readOutbox(env.STATE, Number.isFinite(limit) ? limit : 100) });
      }
      if (url.pathname === "/outbox/ack") {
        if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
        let body: { keys?: unknown };
        try {
          body = await request.json() as { keys?: unknown };
          return Response.json({ acked: await ackOutbox(env.STATE, body?.keys) });
        } catch (error) {
          return new Response(error instanceof Error ? error.message : "Invalid ack", { status: 400 });
        }
      }
      // /run
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      if (!def.triggers.some(t => t.type === "manual" && t.enabled !== false)) return new Response("This workflow has no manual trigger", { status: 409 });
      let payload: { input?: unknown };
      const urlBody = def.triggers.some(t => t.type === "manual" && t.enabled !== false && t.body === "url");
      const text = await request.text();
      // Decided by the body, never the Content-Type: fetch labels a string body text/plain either way.
      if (urlBody && !text.trimStart().startsWith("{")) {
        // A plain webhook caller: the whole body is one http(s) URL (manual trigger `body: url`).
        const url = bareUrl(text);
        if (url === null) return new Response("Body must be one http(s) URL or a JSON {input} payload", { status: 400 });
        payload = { input: { url } };
      } else {
        try {
          payload = JSON.parse(text) as { input?: unknown };
          if (payload === null || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).some(k => k !== "input")) throw new Error("bad payload");
        } catch {
          return new Response("Invalid JSON payload", { status: 400 });
        }
      }
      const now = clock();
      const verdict = await runOnce(env, "manual", `manual:${now.toISOString()}:${crypto.randomUUID()}`, payload.input ?? {});
      if (verdict.status === "paused") return Response.json({ status: "paused" }, { status: 423 });
      if (verdict.status === "duplicate") return Response.json(verdict, { status: 409 });
      if (verdict.status === "disabled") return Response.json({ status: "disabled" }, { status: 409 });
      return Response.json({ status: verdict.record.status, run_id: verdict.record.run_id }, { status: verdict.record.status === "succeeded" ? 200 : 502 });
    },
    async scheduled(controller: { scheduledTime: number }, env: RunnerEnv): Promise<RunVerdict[]> {
      const verdicts: RunVerdict[] = [];
      if (new Date(controller.scheduledTime).getUTCMinutes() % SWEEP_EVERY_MINUTES === 0) {
        // A sweep failure never stops this minute's runs; it retries in 15 minutes and shows in Workers logs.
        try { await sweepInflight(env); } catch (error) { console.error("in-flight sweep failed:", error instanceof Error ? error.message : String(error)); }
        try { await pruneClaims(env.CLAIMS, def.name, clock()); } catch (error) { console.error("claim prune failed:", error instanceof Error ? error.message : String(error)); }
      }
      for (const occurrence of dueOccurrences(def.triggers, controller.scheduledTime)) {
        verdicts.push(await runOnce(env, "schedule", occurrence.key, { scheduled_at: occurrence.at.toISOString() }, occurrence.at.toISOString()));
      }
      return verdicts;
    },
  };
}
