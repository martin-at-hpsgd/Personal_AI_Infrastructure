import { existsSync, openSync, readFileSync, readSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildInventory } from "../../WORKFLOWS/Inventory.ts";
import { attachApps, loadAppConfig, resolveIcon } from "./workflowApps.ts";
import type { Inventory, WorkflowRecord } from "../../WORKFLOWS/types.ts";
import { invariant } from "../../TOOLS/Invariant.ts";
import { principalTimezone } from "../../TOOLS/lib/Timezone.ts";
import { buildActivity, buildLiveState, decideRun, describeRunValues, kickstartArgv, LABEL_RE, ledgerRows, type LedgerRunLike, type RunLogReader } from "./workflowsV2.ts";
import { readdirSync } from "node:fs";
import { DEFINITION_SUFFIX, artifactsRoot, definitionsDir, ledgerPath } from "../../WORKFLOWS/engine/paths.ts";
import { LANES, loadDefinitionFile, parseDefinitionText, SIDE_EFFECTS, STEP_KINDS } from "../../WORKFLOWS/engine/format.ts";
import { readLedger } from "../../WORKFLOWS/engine/ledger.ts";
import { DEFAULT_RETENTION_DAYS, isStorable, readStepValues } from "../../WORKFLOWS/engine/store.ts";
import { randomUUID } from "node:crypto";
import { checkText, commandLineChanges, confinedPath, createDefinition, editDefinition, launchdChanged, readDefinitionText, removeWorkflow, replaceDefinition, textHash, type EditDone, type EditRefused, type Mutator } from "../../WORKFLOWS/engine/definitions.ts";
import { addAfterLink, addStep, changeSchedule, connectSteps, disconnectSteps, EDITABLE_STEP_FIELDS, linkSchemas, parseMinutes, removeStep, setEnabled, setRunsOn, setStepFields, type ScheduleChange, type StepFieldPatch } from "../../WORKFLOWS/engine/definition-edits.ts";
import { syncLaunchd as engineSyncLaunchd, type LaunchdSync } from "../../WORKFLOWS/engine/launchd-sync.ts";
import { renderTemplate, TEMPLATE_CATALOG, isTemplateKind } from "../../WORKFLOWS/engine/templates.ts";
import { deployDrift, lastDeploys } from "../../WORKFLOWS/engine/deploy-record.ts";
import { stopRun } from "../../WORKFLOWS/engine/workflow-ops.ts";
import { answerHumanStep, readAnswer, readWaiting } from "../../WORKFLOWS/engine/human.ts";
import { readPendingApprovals } from "../../WORKFLOWS/engine/human-queue.ts";
import { definitionResolver, resumeRun, runDefinition } from "../../WORKFLOWS/engine/runner.ts";
import {
  deployState,
  editDeployState,
  parseAnswerBody,
  parseDefinitionBody,
  parseNewBody,
  parseRemoveBody,
  parseStepBody,
  type StepEdit,
  parseLinkBody,
  parseNameBody,
  parseRunsOnBody,
  parseScheduleBody,
  parseStopBody,
  parseV2RunBody,
  sameOrigin,
  type ScheduleBody,
} from "./workflowsV2.ts";

// Routes:
//   GET  /api/workflows            the inventory (V1 and V2)
//   GET  /api/workflows/summary    its summary
//   GET  /api/workflows/activity   real runs, newest first (V2 Activity tab)   ?limit=1..5000
//   GET  /api/workflows/live       Run Now eligibility + what launchd has running (V2)
//   GET  /api/workflows/run-values ?run=<run_id>  one typed run's step inputs/outputs from the value store, or why not stored
//   GET  /api/workflows/graphs     every v2 definition as the CLI describes it (graph + next), for the Canvas and Scheduled tabs
//   POST /api/workflows/run {id}   start one scheduled launchd / agent-job record now (V2 Run Now)
//   POST /api/workflows/run {workflow, input}  start a typed workflow through the CLI run module (input checked first)
//   POST /api/workflows/{link,pause,resume,schedule,runs-on,stop,answer}  page edits, each through its engine module
//   GET  /api/workflows/waiting    runs parked on a human step (engine/human-queue.ts)
//   GET  /api/workflows/pause-state whether workflow pause --all is engaged (engine/pause.ts, when installed)
//   GET  /api/workflows/app-icon/<slug>  an app's favicon from the USER-zone app map (workflowApps.ts)
// pulse.ts routes every /api/workflows* path here, after its cross-site write guard.

const CACHE_MS = 30_000;
const SPAWN_TIMEOUT_MS = 10_000;
/** A second Run Now for the same label inside this window is refused rather than queued. */
export const RUN_COOLDOWN_MS = 30_000;
const MAX_BODY_BYTES = 4096;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const DEFAULT_ACTIVITY_LIMIT = 2000;
const MAX_ACTIVITY_LIMIT = 5000;
const AGENT_JOB_STATE_DIR = join(import.meta.dir, "../../USER/MEMORY/STATE/agent-jobs");
const JOB_ID_RE = /^[A-Za-z0-9._-]+$/;

const state: { running: boolean; cache: { value: Inventory; until: number } | null } = { running: false, cache: null };
export function start(): void { state.running = true; console.log("[workflows] Started — serving /api/workflows"); }
export function health(): { running: boolean } { return { running: state.running }; }

/** The USER-zone map of which applications each workflow serves, and the icons it names. */
const APP_MAP_PATH = join(import.meta.dir, "../../USER/CONFIG/workflow-apps.json");
const APP_ICONS_DIR = join(import.meta.dir, "../../USER/CONFIG/workflow-app-icons");
const APP_ICON_PREFIX = "/api/workflows/app-icon/";

function inventory(): Inventory {
  if (!state.cache || state.cache.until <= Date.now()) state.cache = { value: attachApps(buildInventory(), loadAppConfig(APP_MAP_PATH)), until: Date.now() + CACHE_MS };
  return state.cache.value;
}

/** GET /api/workflows/app-icon/<slug>: the app's own favicon, read from the USER-zone icons directory (confined, never fetched from the live site). */
function appIcon(slug: string): Response {
  const got = resolveIcon(slug, loadAppConfig(APP_MAP_PATH).apps, APP_ICONS_DIR);
  if (!got.ok) return new Response(got.reason, { status: got.status, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(Bun.file(got.path), {
    headers: {
      "content-type": got.contentType,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      // An SVG opened directly is a document; this keeps it inert.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

const tilde = (p: string) => { const h = homedir(); return p === h || p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p; };

/** Reads an agent job's `<id>.jsonl`, tail-bounded so a runaway log cannot stall the request. */
const readAgentRunLog: RunLogReader = (r: WorkflowRecord) => {
  if (!JOB_ID_RE.test(r.name)) return null;
  const path = join(AGENT_JOB_STATE_DIR, `${r.name}.jsonl`);
  if (!existsSync(path)) return null;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - MAX_LOG_BYTES);
    const buf = Buffer.alloc(size - start);
    const fd = openSync(path, "r");
    try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
    let text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
    return { text, path: tilde(path) };
  } catch (e) {
    return { error: String(e), path: tilde(path) };
  }
};

function launchctlList(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const r = Bun.spawnSync(["launchctl", "list"], { stdout: "pipe", stderr: "pipe", timeout: SPAWN_TIMEOUT_MS });
    return r.exitCode === 0 ? r.stdout.toString() : null;
  } catch {
    return null;
  }
}

/* ── Run Now ── */

export type Spawner = (argv: string[]) => Promise<{ exitCode: number | null; stderr: string }>;

const spawnWithTimeout: Spawner = async (argv) => {
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), SPAWN_TIMEOUT_MS);
  try {
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    return { exitCode: proc.signalCode ? null : exitCode, stderr: proc.signalCode ? `launchctl timed out after ${SPAWN_TIMEOUT_MS / 1000}s` : stderr };
  } finally {
    clearTimeout(timer);
  }
};

export interface RunDeps {
  inventory: () => Inventory;
  spawn: Spawner;
  uid: () => string;
  now: () => number;
  platform: NodeJS.Platform;
}

const refuse = (status: number, reason: string) => Response.json({ ok: false, reason }, { status });

/**
 * POST /api/workflows/run. Starting a launchd job is the one state change this
 * page can make, so the handler asserts its invariants right before the spawn:
 * the label came from the current inventory, matches com.lifeos.*, and the
 * argv is a three-element array with no `-k`.
 */
export function createRunHandler(deps: RunDeps): (req: Request) => Promise<Response> {
  const lastStart = new Map<string, number>();
  return async (req) => {
    if (req.method !== "POST") return refuse(405, "Use POST.");
    if (deps.platform !== "darwin") return refuse(501, "Run Now needs macOS launchd.");
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return refuse(415, "The request body must be JSON.");
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return refuse(413, "The request body is too large.");
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return refuse(400, "The request body is not valid JSON."); }
    const id = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).id : undefined;

    const decision = decideRun(deps.inventory(), id);
    if (!decision.ok) return refuse(decision.status, decision.reason);
    const { record, label } = decision;

    const now = deps.now();
    const prev = lastStart.get(label);
    if (prev !== undefined && now - prev < RUN_COOLDOWN_MS) {
      return refuse(429, `It was started ${Math.round((now - prev) / 1000)}s ago. Wait before starting it again.`);
    }

    const argv = kickstartArgv(deps.uid(), label);
    invariant(deps.inventory().records.some((r) => r.id === record.id), "run target is in the current inventory");
    invariant(LABEL_RE.test(label), "run label is a com.lifeos.* label");
    invariant(argv.length === 3 && argv[0] === "launchctl" && argv[1] === "kickstart", "argv is launchctl kickstart <target>");
    invariant(!argv.includes("-k") && !argv.includes("-p") && argv[2].endsWith(`/${label}`), "argv never kills an in-flight run");

    lastStart.set(label, now);
    const result = await deps.spawn(argv);
    const startedAt = new Date(now).toISOString();
    if (result.exitCode !== 0) {
      lastStart.delete(label);
      const why = result.stderr.trim().slice(0, 300) || `exit ${result.exitCode ?? "(killed)"}`;
      console.warn(`[workflows] run ${record.id}: launchctl kickstart ${label} failed: ${why}`);
      return Response.json({ ok: false, id: record.id, label, reason: `launchctl refused: ${why}` }, { status: 502 });
    }
    console.log(`[workflows] run ${record.id}: kickstarted ${label}`);
    state.cache = null; // the next inventory read picks up the new run's evidence
    return Response.json({ ok: true, id: record.id, title: record.title, label, startedAt });
  };
}

const handleRun = createRunHandler({
  inventory,
  spawn: spawnWithTimeout,
  uid: () => String(process.getuid?.() ?? ""),
  now: () => Date.now(),
  platform: process.platform,
});

/* ── Page writes: every one goes through an engine module, never the disk directly (ISC-153) ── */

export interface WriteDeps {
  /** Definitions home; the engine's own default in production, a scratch dir in tests. */
  home: () => string;
  ledger: () => string;
  /** The engine's one launchd step (engine/launchd-sync.ts, ISC-168), after any save that changes triggers or enabled. */
  syncLaunchd: (name: string, triggers: Array<{ type: string; enabled?: boolean }>, enabled: boolean) => Promise<LaunchdSync | { installed: boolean; reason: string }>;
  /** Starts a validated run without waiting for it; the page follows it in Activity. */
  startRun: (path: string, input: unknown, occurrenceKey: string) => void;
  /** Continues a parked run once its answer is written. */
  resume: (runId: string) => void;
  /** Called after any successful write so the next read is fresh. */
  invalidate: () => void;
}

const WRITE_ROUTES = new Set(["/api/workflows/link", "/api/workflows/pause", "/api/workflows/resume", "/api/workflows/schedule", "/api/workflows/runs-on", "/api/workflows/stop", "/api/workflows/answer", "/api/workflows/step", "/api/workflows/definition", "/api/workflows/new", "/api/workflows/remove"]);

async function readJsonBody(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; res: Response }> {
  if (req.method !== "POST") return { ok: false, res: refuse(405, "Use POST.") };
  if (!sameOrigin(req)) return { ok: false, res: refuse(403, "Writes are accepted from this page's own origin only.") };
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return { ok: false, res: refuse(415, "The request body must be JSON.") };
  const raw = await req.text();
  if (raw.length > MAX_WRITE_BODY_BYTES) return { ok: false, res: refuse(413, "The request body is too large.") };
  try { return { ok: true, body: JSON.parse(raw) }; } catch { return { ok: false, res: refuse(400, "The request body is not valid JSON.") }; }
}

/** 64 KiB: a run input can carry more than the 4 KiB a launchd id needs. */
const MAX_WRITE_BODY_BYTES = 64 * 1024;

const EDIT_STATUS: Record<EditRefused["refused"], number> = { invalid: 422, "not-found": 404, "not-editable": 409, exists: 409, unsupported: 422, stale: 409 };

/**
 * Every edit's answer. A success carries the new hash (the page's base for its
 * next edit) and, when the file changed, the previous text for Undo (ISC-163)
 * and, for a cloud workflow, that the deploy waits for "y" (ISC-165).
 */
function editResponse(result: EditDone | EditRefused, extra: Record<string, unknown> = {}): Response {
  if (!result.ok) return Response.json({ ok: false, refused: result.refused, reason: result.error, issues: result.issues, ...extra }, { status: EDIT_STATUS[result.refused] });
  const changed = result.detail.changed === true;
  return Response.json({
    ok: true, name: result.name, detail: result.detail, warnings: result.warnings, hash: result.hash,
    ...(changed && result.previous !== undefined ? { previous: result.previous } : {}),
    deploy: editDeployState(result.definition.runs_on, changed),
    ...extra,
  });
}

/** The engine mutator for one step edit from the page. */
function stepMutator(edit: StepEdit): Mutator {
  switch (edit.op) {
    case "add": return addStep(edit.id, edit.kind, edit.fields as StepFieldPatch, edit.needs);
    case "set": return setStepFields(edit.id, edit.fields as StepFieldPatch);
    case "remove": return removeStep(edit.id);
    case "connect": return connectSteps(edit.from, edit.to);
    case "disconnect": return disconnectSteps(edit.from, edit.to);
  }
}

/** Runs the launchd step after a save that changed triggers or enabled (ISC-168). */
async function launchdAfter(deps: WriteDeps, result: EditDone): Promise<Record<string, unknown>> {
  if (!launchdChanged(result)) return {};
  return { launchd: await launchdSafely(deps, result.name, result.definition.triggers, result.definition.enabled !== false) };
}

/** The file is already written when this runs, so a launchd failure is reported with the success, not as a failed write. */
async function launchdSafely(deps: WriteDeps, ...args: Parameters<WriteDeps["syncLaunchd"]>): Promise<Record<string, unknown>> {
  try {
    return { ...(await deps.syncLaunchd(...args)) };
  } catch (e) {
    return { installed: false, touched: false, error: `The definition was saved, but its launchd job was not updated: ${e instanceof Error ? e.message : String(e)}. Its launchd job (com.lifeos.wf.${args[0]}) may still follow the old schedule.` };
  }
}

/** The schedule form's body → the ScheduleChange the CLI's flags build, with the CLI's own refusals. */
export function scheduleChangeOf(body: ScheduleBody): { ok: true; change: ScheduleChange } | { ok: false; reason: string } {
  switch (body.action) {
    case "cron": return { ok: true, change: { action: "cron", cron: body.cron, timezone: body.timezone } };
    case "every": {
      const minutes = parseMinutes(body.every);
      return minutes === null ? { ok: false, reason: `"${body.every}" is not a number of minutes (or 90m, 2h, 1d).` } : { ok: true, change: { action: "every", minutes } };
    }
    case "at": return Number.isFinite(Date.parse(body.at)) ? { ok: true, change: { action: "at", at: body.at } } : { ok: false, reason: `"${body.at}" is not an ISO time.` };
    case "in": {
      const minutes = parseMinutes(body.in);
      return minutes === null ? { ok: false, reason: `"${body.in}" is not a duration (20m, 2h, 1d).` } : { ok: true, change: { action: "in", minutes } };
    }
    case "remove": return { ok: true, change: { action: "remove", target: body.target } };
  }
}

/** POST /api/workflows/run with `{workflow, input}`: the CLI's run module, input checked by a dry run before anything starts (ISC-92). */
export async function handleV2Run(body: unknown, deps: WriteDeps): Promise<Response | null> {
  const parsed = parseV2RunBody(body);
  if (parsed === null) return null;
  if (!parsed.ok) return refuse(400, parsed.reason);
  const { workflow, input } = parsed.value;
  const path = confinedPath(workflow, deps.home());
  if (!existsSync(path)) return refuse(404, `No workflow named "${workflow}".`);
  const dry = await runDefinition(path, { input, dryRun: true, definitions: deps.home(), ledger: deps.ledger() });
  if (!dry.success) {
    const status = dry.refused === "input" ? 422 : dry.refused === "not-runnable" ? 409 : 422;
    return Response.json({ ok: false, refused: dry.refused ?? "invalid", reason: dry.error ?? "The run was refused.", workflow }, { status });
  }
  const occurrenceKey = `pulse-${randomUUID()}`;
  invariant(dry.dry_run === true && Object.keys(dry.steps).length === 0, "the input check ran no step");
  deps.startRun(path, input, occurrenceKey);
  return Response.json({ ok: true, workflow, occurrence_key: occurrenceKey, startedAt: new Date().toISOString() }, { status: 202 });
}

export function createWriteHandler(deps: WriteDeps): (req: Request, pathname: string) => Promise<Response> {
  return async (req, pathname) => {
    const got = await readJsonBody(req);
    if (!got.ok) return got.res;
    const body = got.body;
    const done = (res: Response): Response => { if (res.ok) deps.invalidate(); return res; };
    switch (pathname) {
      case "/api/workflows/link": {
        const p = parseLinkBody(body);
        if (!p.ok) return refuse(400, p.reason);
        const { upstream, downstream, status } = p.value;
        const result = await editDefinition(downstream, addAfterLink(upstream, status), { home: deps.home(), origin: "page" });
        const mismatch = !result.ok && result.issues.some((i) => i.code === "type-mismatch");
        return done(editResponse(result, { upstream, downstream, status, ...(mismatch ? linkSchemas(upstream, downstream, deps.home()) : {}) }));
      }
      case "/api/workflows/pause":
      case "/api/workflows/resume": {
        const p = parseNameBody(body);
        if (!p.ok) return refuse(400, p.reason);
        const enabled = pathname.endsWith("/resume");
        const result = await editDefinition(p.value.name, setEnabled(enabled), { home: deps.home(), origin: "page" });
        if (!result.ok) return editResponse(result);
        const launchd = await launchdSafely(deps, result.name, result.definition.triggers, enabled);
        return done(editResponse(result, { launchd }));
      }
      case "/api/workflows/schedule": {
        const p = parseScheduleBody(body);
        if (!p.ok) return refuse(400, p.reason);
        const c = scheduleChangeOf(p.value.change);
        if (!c.ok) return refuse(422, c.reason);
        const result = await editDefinition(p.value.name, changeSchedule(c.change), { home: deps.home(), origin: "page" });
        if (!result.ok) return editResponse(result);
        const launchd = await launchdSafely(deps, p.value.name, result.definition.triggers, result.definition.enabled !== false);
        return done(editResponse(result, { launchd }));
      }
      case "/api/workflows/runs-on": {
        const p = parseRunsOnBody(body);
        if (!p.ok) return refuse(400, p.reason);
        const result = await editDefinition(p.value.name, setRunsOn(p.value.runsOn), { home: deps.home(), origin: "page" });
        if (!result.ok) return editResponse(result);
        return done(editResponse(result, { deploy: deployState(p.value.runsOn, result.detail.changed === true) }));
      }
      case "/api/workflows/stop": {
        const p = parseStopBody(body);
        if (!p.ok) return refuse(400, p.reason);
        const r = stopRun(p.value.runId, deps.ledger());
        return done(Response.json(r, { status: r.ok ? 200 : r.requested ? 202 : 409 }));
      }
      case "/api/workflows/answer": {
        const p = parseAnswerBody(body);
        if (!p.ok) return refuse(400, p.reason);
        const { runId, stepId, approved, note } = p.value;
        const ledger = deps.ledger();
        const waiting = readWaiting(ledger, runId);
        if (!waiting) return refuse(404, `Run ${runId} is not waiting on a human step.`);
        if (!waiting.waiting_on.includes(stepId)) return refuse(404, `Run ${runId} is not waiting on step "${stepId}".`);
        if (readAnswer(ledger, runId, stepId) !== null) return refuse(409, `Step "${stepId}" of run ${runId} is already answered.`);
        answerHumanStep(runId, stepId, { approved, ...(note !== undefined ? { note } : {}) }, { ledger });
        deps.resume(runId);
        return done(Response.json({ ok: true, runId, stepId, approved, resumed: true }));
      }
      case "/api/workflows/step": {
        const p = parseStepBody(body);
        if (!p.ok) return refuse(400, p.reason);
        const result = await editDefinition(p.value.name, stepMutator(p.value.edit), { home: deps.home(), origin: "page", ...(p.value.baseHash ? { baseHash: p.value.baseHash } : {}) });
        return done(editResponse(result, { op: p.value.edit.op }));
      }
      case "/api/workflows/definition": {
        const p = parseDefinitionBody(body);
        if (!p.ok) return refuse(400, p.reason);
        const { name, text, baseHash, dryRun } = p.value;
        if (dryRun) {
          const path = confinedPath(name, deps.home());
          const checked = await checkText(text, path, deps.home());
          let renamed: string | null = null;
          let commandIds: string[] = [];
          try {
            const d = parseDefinitionText(text, path);
            if (d.name !== name) renamed = d.name;
            const current = readDefinitionText(name, deps.home());
            let before: ReturnType<typeof parseDefinitionText> | undefined;
            try { before = current ? parseDefinitionText(current.text, current.path) : undefined; } catch { before = undefined; }
            commandIds = commandLineChanges(before, d);
          } catch { renamed = null; }
          const issues = [
            ...checked.issues,
            ...(renamed ? [{ path: "name", code: "name-changed", message: `name must stay "${name}"` }] : []),
            ...commandIds.map((id) => ({ path: `steps.${id}.argv`, code: "command-line-page", message: `The page does not change command lines (step "${id}"); make that change from the terminal: workflow step set ${name} ${id} --fields '{"argv": [...]}'.` })),
          ];
          return Response.json({ ok: true, dry_run: true, valid: checked.valid && !renamed && commandIds.length === 0, issues, warnings: checked.warnings });
        }
        const result = await replaceDefinition(name, text, { home: deps.home(), origin: "page", ...(baseHash ? { baseHash } : {}) });
        if (!result.ok) return editResponse(result);
        return done(editResponse(result, await launchdAfter(deps, result)));
      }
      case "/api/workflows/new": {
        const p = parseNewBody(body, TEMPLATE_CATALOG.map((t) => t.kind));
        if (!p.ok) return refuse(400, p.reason);
        const { name, template, after } = p.value;
        if (!isTemplateKind(template)) return refuse(400, "Unknown template.");
        let text: string;
        let upstreamOutput: unknown;
        if (after) {
          const upstream = definitionResolver(deps.home())(after);
          if (!upstream) return refuse(404, `No workflow named "${after}" to run after.`);
          upstreamOutput = upstream.output;
        }
        try { text = renderTemplate(template, name, after ? { after, upstreamOutput } : {}); }
        catch (e) { return refuse(422, String(e instanceof Error ? e.message : e)); }
        const result = await createDefinition(name, text, { home: deps.home(), origin: "page" });
        return done(editResponse(result, { template }));
      }
      case "/api/workflows/remove": {
        const p = parseRemoveBody(body);
        if (!p.ok) return refuse(400, p.reason);
        const result = await removeWorkflow(p.value.name, { home: deps.home(), origin: "page", baseHash: p.value.baseHash });
        if (!result.ok) return editResponse(result);
        const launchd = await launchdSafely(deps, result.name, result.before?.triggers ?? [], false);
        return done(Response.json({ ok: true, name: result.name, removed: true, previous: result.previous, launchd }));
      }
      default:
        return refuse(404, "Unknown workflows write route.");
    }
  };
}


const writeDeps: WriteDeps = {
  home: definitionsDir,
  ledger: ledgerPath,
  syncLaunchd: engineSyncLaunchd,
  startRun: (path, input, occurrenceKey) => {
    runDefinition(path, { input, occurrenceKey })
      .then((r) => console.log(`[workflows] run ${r.workflow} ${r.run_id ?? ""}: ${r.status ?? (r.success ? "succeeded" : `refused ${r.refused ?? ""}`)}`))
      .catch((e) => console.warn(`[workflows] run of ${path} failed: ${String(e)}`))
      .finally(() => { state.cache = null; });
  },
  resume: (runId) => {
    resumeRun(runId)
      .then((r) => console.log(`[workflows] resumed ${runId}: ${r ? r.status ?? (r.success ? "succeeded" : "failed") : "not resumable yet"}`))
      .catch((e) => console.warn(`[workflows] resume of ${runId} failed: ${String(e)}`));
  },
  invalidate: () => { state.cache = null; graphState.cache = null; },
};
const handleWrite = createWriteHandler(writeDeps);

/** GET /api/workflows/pause-state: whether `workflow pause --all` is engaged (engine/pause.ts), or that the module is not there yet. */
async function globalPauseState(): Promise<{ available: boolean; paused: boolean | null; reason?: string }> {
  const modPath = join(import.meta.dir, "../../WORKFLOWS/engine/pause.ts");
  if (!existsSync(modPath)) return { available: false, paused: null, reason: "engine/pause.ts is not installed yet" };
  try {
    const mod = (await import(modPath)) as { isGloballyPaused?: (ledger?: string) => boolean };
    if (typeof mod.isGloballyPaused !== "function") return { available: false, paused: null, reason: "engine/pause.ts has no isGloballyPaused export" };
    return { available: true, paused: mod.isGloballyPaused(ledgerPath()) === true };
  } catch (e) {
    return { available: false, paused: null, reason: `engine/pause.ts could not be read: ${String(e).slice(0, 200)}` };
  }
}

export async function handleRequest(req: Request, pathname: string): Promise<Response | null> {
  if (pathname.startsWith(APP_ICON_PREFIX)) {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
    try { return appIcon(decodeURIComponent(pathname.slice(APP_ICON_PREFIX.length))); }
    catch (e) { return new Response(String(e).slice(0, 200), { status: 400 }); }
  }
  if (pathname === "/api/workflows/run") {
    try {
      if (req.method === "POST" && (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
        const peek = await req.clone().text();
        let body: unknown = null;
        try { body = JSON.parse(peek); } catch { body = null; }
        if (parseV2RunBody(body) !== null) {
          if (!sameOrigin(req)) return refuse(403, "Writes are accepted from this page's own origin only.");
          if (peek.length > MAX_WRITE_BODY_BYTES) return refuse(413, "The request body is too large.");
          return (await handleV2Run(body, writeDeps)) as Response;
        }
      }
      return await handleRun(req);
    }
    catch (e) { return Response.json({ ok: false, reason: String(e) }, { status: 500 }); }
  }
  if (pathname === "/api/workflows/definition" && req.method === "GET") {
    try { return definitionForEditor(new URL(req.url).searchParams.get("name") ?? ""); }
    catch (e) { return Response.json({ ok: false, reason: String(e) }, { status: 500 }); }
  }
  if (WRITE_ROUTES.has(pathname)) {
    try { return await handleWrite(req, pathname); }
    catch (e) { return Response.json({ ok: false, reason: String(e) }, { status: 500 }); }
  }
  if (pathname === "/api/workflows/waiting") {
    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
    try { return Response.json({ generatedAt: new Date().toISOString(), waiting: readPendingApprovals(ledgerPath()) }); }
    catch (e) { return Response.json({ error: String(e) }, { status: 500 }); }
  }
  if (pathname === "/api/workflows/pause-state") {
    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
    return Response.json(await globalPauseState());
  }
  if (pathname === "/api/workflows/graphs") {
    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
    try { return Response.json(await graphs()); }
    catch (e) { return Response.json({ error: String(e) }, { status: 500 }); }
  }
  if (pathname === "/api/workflows/run-values") {
    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
    try {
      const runId = new URL(req.url).searchParams.get("run") ?? "";
      if (!RUN_ID_RE.test(runId)) return Response.json({ error: "The request needs a run id." }, { status: 400 });
      const values = runValues(runId);
      return values ? Response.json(values) : Response.json({ error: `No run ${runId} is in the ledger.` }, { status: 404 });
    } catch (e) { return Response.json({ error: String(e) }, { status: 500 }); }
  }
  if (pathname !== "/api/workflows" && pathname !== "/api/workflows/summary" && pathname !== "/api/workflows/activity" && pathname !== "/api/workflows/live") return null;
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  try {
    const inv = inventory();
    if (pathname === "/api/workflows/activity") {
      const asked = Number(new URL(req.url).searchParams.get("limit") ?? DEFAULT_ACTIVITY_LIMIT);
      const limit = Number.isFinite(asked) ? Math.min(MAX_ACTIVITY_LIMIT, Math.max(1, Math.floor(asked))) : DEFAULT_ACTIVITY_LIMIT;
      return Response.json(buildActivity(inv, readAgentRunLog, new Date(), limit, ledgerActivity()));
    }
    if (pathname === "/api/workflows/live") return Response.json(buildLiveState(inv, launchctlList(), new Date()));
    // The page's clocks read the principal's configured zone, not the browser's (ISC-107).
    return Response.json(pathname.endsWith("/summary") ? inv.summary : { ...inv, timezone: principalTimezone() });
  } catch (e) { return Response.json({ error: String(e) }, { status: 500 }); }
}

/* ── Typed-workflow runs: the v2 ledger and its value store (Activity tab) ── */

/** Same shape the store accepts (engine/store.ts RUN_ID_RE); anything else never reaches the filesystem. */
const RUN_ID_RE = /^[A-Za-z0-9-]{8,128}$/;

function ledgerRecords(): LedgerRunLike[] {
  return readLedger(ledgerPath()).records as unknown as LedgerRunLike[];
}

/** Ledger runs as Activity rows; null (not an empty list) when the ledger cannot be read, so the page is told. */
function ledgerActivity(): { rows: ReturnType<typeof ledgerRows>["rows"]; path: string; skipped: number } | null {
  const path = ledgerPath();
  try {
    const { rows, skipped } = ledgerRows(ledgerRecords(), tilde(path));
    return { rows, path: tilde(path), skipped };
  } catch (e) {
    console.warn(`[workflows] ledger unreadable at ${tilde(path)}: ${String(e)}`);
    return null;
  }
}

/** GET /api/workflows/run-values?run=<id>: one run's step values through the store's own reader. */
function runValues(runId: string) {
  const run = ledgerRecords().find((r) => r.run_id === runId);
  if (!run) return null;
  const root = artifactsRoot();
  return describeRunValues(run, isStorable, (id, step) => readStepValues(root, id, step), DEFAULT_RETENTION_DAYS);
}

/* ── The canvas editor's read (ISA F17) ── */

const EDITOR_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** GET /api/workflows/definition?name=: text and hash (the base for every edit), parsed steps, and the choices the editor offers. */
function definitionForEditor(name: string): Response {
  if (!EDITOR_NAME_RE.test(name)) return Response.json({ ok: false, reason: "The request needs a workflow name." }, { status: 400 });
  const got = readDefinitionText(name, definitionsDir());
  if (!got) return Response.json({ ok: false, reason: `No workflow named "${name}".` }, { status: 404 });
  let steps: unknown = null;
  let runsOn: string | null = null;
  let parseError: string | null = null;
  try {
    const def = parseDefinitionText(got.text, got.path);
    steps = def.steps;
    runsOn = def.runs_on;
  } catch (e) { parseError = e instanceof Error ? e.message : String(e); }
  return Response.json({
    ok: true, name, path: tilde(got.path), hash: got.hash, text: got.text, runs_on: runsOn, steps, parse_error: parseError,
    deploy: runsOn === "cloud" ? deployDrift(name, got.hash, lastDeploys()) : null,
    options: { kinds: STEP_KINDS, side_effects: SIDE_EFFECTS, lanes: LANES, fields: Object.keys(EDITABLE_STEP_FIELDS), templates: TEMPLATE_CATALOG },
  });
}

/* ── Definitions graph (Canvas and Scheduled tabs) ── */

const WORKFLOW_CLI = join(import.meta.dir, "../../WORKFLOWS/workflow.ts");
const GRAPH_CACHE_MS = 15_000;
const MAX_DEFINITIONS = 200;
const graphState: { cache: { value: unknown; until: number } | null; pending: Promise<unknown> | null } = { cache: null, pending: null };

/** Runs one read-only CLI verb (graph | next) with an argv array and a timeout; returns its parsed JSON or an error sentence. */
async function cliJson(verb: "graph" | "next", path: string): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string }> {
  const proc = Bun.spawn([process.execPath, WORKFLOW_CLI, verb, path, "--json"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LIFEOS_NOTIFICATION_CHANNEL: "headless" } });
  const timer = setTimeout(() => proc.kill(), SPAWN_TIMEOUT_MS);
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (proc.signalCode) return { ok: false, error: `workflow ${verb} timed out after ${SPAWN_TIMEOUT_MS / 1000}s` };
    try {
      const parsed: unknown = JSON.parse(out);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return { ok: true, value: parsed as Record<string, unknown> };
    } catch { /* fall through to the error below */ }
    return { ok: false, error: (err.trim() || out.trim() || `workflow ${verb} printed no JSON`).slice(0, 400) };
  } finally {
    clearTimeout(timer);
  }
}

/** Step fields the graph verb leaves out but the canvas detail panel shows: prompt, question, input and output schemas. */
function stepExtras(path: string): Record<string, Record<string, unknown>> {
  try {
    const { def } = loadDefinitionFile(path);
    const out: Record<string, Record<string, unknown>> = {};
    for (const s of Object.values(def.steps)) {
      out[s.id] = {
        ...(s.prompt ? { prompt: s.prompt } : {}),
        ...(s.question ? { question: s.question } : {}),
        ...(s.input !== undefined ? { input: s.input } : {}),
        ...(s.output !== undefined ? { output: s.output } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

async function describeOne(path: string, stem: string): Promise<Record<string, unknown>> {
  const [g, n] = await Promise.all([cliJson("graph", path), cliJson("next", path)]);
  if (!g.ok || typeof g.value.steps !== "object") {
    // An unparseable definition still gets a row: its errors are the point of showing it.
    const errors = g.ok ? (Array.isArray(g.value.errors) ? g.value.errors : [String(g.value.error ?? "the definition could not be read")]) : [g.error];
    return { name: stem, path: tilde(path), description: null, runs_on: "local", valid: false, errors, warnings: [], triggers: [], steps: {}, connections: [], links: [], handoffs: [], next: null };
  }
  const extras = stepExtras(path);
  const steps: Record<string, unknown> = {};
  for (const [id, s] of Object.entries(g.value.steps as Record<string, Record<string, unknown>>)) steps[id] = { ...s, ...(extras[id] ?? {}) };
  let description: string | null = null;
  let input: unknown = null;
  let enabled = true;
  try {
    const { def } = loadDefinitionFile(path);
    description = def.description ?? null;
    input = def.input ?? null;
    enabled = (def as { enabled?: boolean }).enabled !== false;
  } catch { description = null; }
  const nextTriggers = n.ok && Array.isArray(n.value.triggers) ? (n.value.triggers as Array<Record<string, unknown>>) : null;
  const triggers = Array.isArray(g.value.triggers)
    ? (g.value.triggers as Array<Record<string, unknown>>).map((t, i) => ({ ...t, next: nextTriggers && typeof nextTriggers[i]?.next === "string" ? nextTriggers[i].next : null }))
    : [];
  let hash: string | null = null;
  try { hash = textHash(readFileSync(path, "utf8")); } catch { hash = null; }
  const deploy = g.value.runs_on === "cloud" && hash ? deployDrift(typeof g.value.name === "string" ? g.value.name : stem, hash, lastDeploys()) : null;
  return {
    name: typeof g.value.name === "string" ? g.value.name : stem,
    path: tilde(path),
    hash,
    deploy,
    description,
    input,
    enabled,
    runs_on: g.value.runs_on,
    valid: g.value.valid === true,
    errors: g.value.errors ?? [],
    warnings: g.value.warnings ?? [],
    triggers,
    steps,
    connections: g.value.connections ?? [],
    links: g.value.links ?? [],
    handoffs: g.value.handoffs ?? [],
    next: n.ok && typeof n.value.next === "string" ? n.value.next : null,
  };
}

async function buildGraphs(): Promise<unknown> {
  const dir = definitionsDir();
  const errors: Array<{ source: string; message: string }> = [];
  let files: string[] = [];
  try {
    files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(DEFINITION_SUFFIX)).sort() : [];
  } catch (e) {
    errors.push({ source: tilde(dir), message: String(e) });
  }
  if (files.length > MAX_DEFINITIONS) {
    errors.push({ source: tilde(dir), message: `${files.length} definitions; only the first ${MAX_DEFINITIONS} are drawn` });
    files = files.slice(0, MAX_DEFINITIONS);
  }
  const definitions = await Promise.all(files.map((f) => describeOne(join(dir, f), f.slice(0, -DEFINITION_SUFFIX.length))));
  return { generatedAt: new Date().toISOString(), dir: tilde(dir), definitions, errors };
}

/** Cached for GRAPH_CACHE_MS; concurrent callers share one build. */
async function graphs(): Promise<unknown> {
  if (graphState.cache && graphState.cache.until > Date.now()) return graphState.cache.value;
  if (!graphState.pending) {
    graphState.pending = buildGraphs()
      .then((value) => { graphState.cache = { value, until: Date.now() + GRAPH_CACHE_MS }; return value; })
      .finally(() => { graphState.pending = null; });
  }
  return graphState.pending;
}
