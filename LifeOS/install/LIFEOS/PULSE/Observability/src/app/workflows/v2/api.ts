/**
 * Workflows V2 — client side of the two V2 endpoints and the run action.
 * Every response is shape-checked before the page trusts it; a bad answer
 * becomes a sentence the page shows, never a crash.
 *
 * Server contract: LIFEOS/PULSE/modules/workflowsV2.ts.
 */

import { ApiError, apiFetch, apiSend } from "@/lib/api";
import type {
  ActivityResponse,
  ActivityStep,
  RunValues,
  StepValueView,
  ActivityRow,
  ActivityStatus,
  LiveState,
  RunEligibility,
} from "../../../../../modules/workflowsV2";
import type { WorkflowApp } from "../../../../../../WORKFLOWS/types";

export type { ActivityStep, RunValues, StepValueView, WorkflowApp };
export type { ActivityResponse, ActivityRow, ActivityStatus, LiveState, RunEligibility };

export const FETCH_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 20_000;
export const ACTIVITY_LIMIT = 2000;

/** The API could not be reached at all (network, timeout, non-2xx). Distinct from a bad answer. */
export class Unreachable extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const STATUSES: readonly ActivityStatus[] = ["ok", "error", "running", "incomplete", "skipped", "unknown"];

export async function getJson(url: string): Promise<unknown> {
  try {
    return await apiFetch<unknown>(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error("the API answered with something that is not JSON");
    throw new Unreachable(describeFailure(e));
  }
}

/** A read failed before the API gave a usable body (network, timeout, non-2xx), as opposed to a body that is not JSON. */
export const isUnreachable = (e: unknown): boolean => !(e instanceof SyntaxError);

/** One plain sentence fragment for a failed read, in the wording the page has always shown. */
export function describeFailure(e: unknown): string {
  if (e instanceof ApiError) return `the API answered HTTP ${e.status}`;
  if (e instanceof SyntaxError) return "the API answered with something that is not JSON";
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return "the request timed out";
  return "the Pulse server did not answer";
}

export function parseActivity(raw: unknown): { ok: true; value: ActivityResponse; dropped: number } | { ok: false; reason: string } {
  if (!isObj(raw) || !Array.isArray(raw.rows)) return { ok: false, reason: "the activity response has no rows array" };
  let dropped = 0;
  const rows: ActivityRow[] = [];
  for (const r of raw.rows) {
    if (
      isObj(r) && typeof r.key === "string" && typeof r.recordId === "string" && typeof r.at === "string" &&
      Number.isFinite(Date.parse(r.at)) && typeof r.status === "string" && (STATUSES as readonly string[]).includes(r.status)
    ) {
      rows.push({
        key: r.key,
        recordId: r.recordId,
        at: r.at,
        startedAt: typeof r.startedAt === "string" ? r.startedAt : null,
        endedAt: typeof r.endedAt === "string" ? r.endedAt : null,
        durationMs: typeof r.durationMs === "number" && Number.isFinite(r.durationMs) ? r.durationMs : null,
        status: r.status as ActivityStatus,
        origin: r.origin === "run-log" ? "run-log" : "evidence",
        source: typeof r.source === "string" ? r.source : null,
        detail: typeof r.detail === "string" ? r.detail : null,
        events: Array.isArray(r.events) ? r.events.filter((x): x is string => typeof x === "string") : [],
        dryRun: r.dryRun === true,
        runId: typeof r.runId === "string" ? r.runId : null,
        trigger: typeof r.trigger === "string" ? r.trigger : null,
        timedOut: r.timedOut === true,
        dataClass: typeof r.dataClass === "string" ? r.dataClass : null,
        steps: Array.isArray(r.steps)
          ? r.steps.filter(isObj).filter((x) => typeof x.id === "string").map((x) => ({
              id: x.id as string,
              status: typeof x.status === "string" ? x.status : "unknown",
              attempts: typeof x.attempts === "number" ? x.attempts : 0,
              startedAt: typeof x.startedAt === "string" ? x.startedAt : null,
              durationMs: typeof x.durationMs === "number" && Number.isFinite(x.durationMs) ? x.durationMs : null,
              error: typeof x.error === "string" ? x.error : null,
              timedOut: x.timedOut === true,
            }))
          : [],
      });
    } else dropped++;
  }
  return {
    ok: true,
    dropped,
    value: {
      generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : "",
      rows,
      total: typeof raw.total === "number" ? raw.total : rows.length,
      truncated: raw.truncated === true,
      logs: Array.isArray(raw.logs) ? (raw.logs as ActivityResponse["logs"]).filter((l) => isObj(l) && typeof l.path === "string") : [],
      errors: Array.isArray(raw.errors)
        ? (raw.errors as unknown[]).filter((e): e is { source: string; message: string } => isObj(e) && typeof e.source === "string" && typeof e.message === "string")
        : [],
    },
  };
}

export function parseLive(raw: unknown): { ok: true; value: LiveState } | { ok: false; reason: string } {
  if (!isObj(raw) || !isObj(raw.runnable) || !Array.isArray(raw.running)) return { ok: false, reason: "the live-state response is missing its runnable map or running list" };
  const runnable: Record<string, RunEligibility> = {};
  for (const [id, e] of Object.entries(raw.runnable)) {
    if (isObj(e) && e.allowed === true && typeof e.label === "string") runnable[id] = { allowed: true, label: e.label };
    else if (isObj(e) && e.allowed === false && typeof e.reason === "string") runnable[id] = { allowed: false, reason: e.reason };
  }
  return {
    ok: true,
    value: {
      generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : "",
      runnable,
      defaultReason: typeof raw.defaultReason === "string" ? raw.defaultReason : "Not startable from this page.",
      running: (raw.running as unknown[]).filter(
        (x): x is LiveState["running"][number] => isObj(x) && typeof x.id === "string" && typeof x.label === "string" && typeof x.pid === "number",
      ),
      launchctlRead: raw.launchctlRead === true,
    },
  };
}

export type RunOutcome = { ok: true; label: string; startedAt: string } | { ok: false; reason: string };

/** POST /api/workflows/run. The server re-checks everything; this only reports what it said. */
export async function postRun(id: string): Promise<RunOutcome> {
  let body: unknown = null;
  try {
    body = await apiSend("/api/workflows/run", "POST", { id }, { signal: AbortSignal.timeout(RUN_TIMEOUT_MS) });
  } catch (e) {
    if (e instanceof ApiError) {
      // A refusal still carries the server's own reason in its JSON body.
      try { body = JSON.parse(e.body); } catch { return { ok: false, reason: `The server answered HTTP ${e.status} without a readable result.` }; }
    } else if (e instanceof SyntaxError) {
      return { ok: false, reason: "The server answered HTTP 200 without a readable result." };
    } else {
      return { ok: false, reason: e instanceof Error && e.name === "TimeoutError" ? "The request timed out. It may still have started; check Activity." : "The Pulse server did not answer." };
    }
  }
  if (isObj(body) && body.ok === true && typeof body.label === "string" && typeof body.startedAt === "string") {
    return { ok: true, label: body.label, startedAt: body.startedAt };
  }
  return { ok: false, reason: isObj(body) && typeof body.reason === "string" ? body.reason : "The server answered HTTP 200." };
}

/** GET /api/workflows/run-values?run=<id>, shape-checked. */
export function parseRunValues(raw: unknown): { ok: true; value: RunValues } | { ok: false; reason: string } {
  if (!isObj(raw) || typeof raw.runId !== "string" || !Array.isArray(raw.steps)) {
    return { ok: false, reason: isObj(raw) && typeof raw.error === "string" ? raw.error : "the run-values response has no steps array" };
  }
  const steps: StepValueView[] = [];
  for (const x of raw.steps) {
    if (!isObj(x) || typeof x.id !== "string") continue;
    if (x.stored === true && typeof x.input === "string" && typeof x.output === "string") steps.push({ id: x.id, stored: true, input: x.input, output: x.output, truncated: x.truncated === true });
    else steps.push({ id: x.id, stored: false, reason: typeof x.reason === "string" ? x.reason : "The server gave no reason." });
  }
  return { ok: true, value: { runId: raw.runId, workflow: typeof raw.workflow === "string" ? raw.workflow : "", dataClass: typeof raw.dataClass === "string" ? raw.dataClass : null, steps } };
}

const APP_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A record's `apps` field (the applications it serves), shape-checked: anything
 * that is not a list of {slug, name, url} with a safe slug and an http(s) url is
 * dropped, and each slug appears once. Missing or malformed → [].
 */
export function parseApps(raw: unknown): WorkflowApp[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkflowApp[] = [];
  const seen = new Set<string>();
  for (const a of raw) {
    if (!isObj(a) || typeof a.slug !== "string" || !APP_SLUG_RE.test(a.slug) || seen.has(a.slug)) continue;
    if (typeof a.name !== "string" || !a.name.trim() || typeof a.url !== "string" || !/^https?:\/\//i.test(a.url)) continue;
    seen.add(a.slug);
    out.push({ slug: a.slug, name: a.name.trim(), url: a.url });
  }
  return out;
}

/** Where the page loads an app's icon: the Pulse server's copy, never the live site. */
export const appIconUrl = (slug: string): string => `/api/workflows/app-icon/${encodeURIComponent(slug)}`;
