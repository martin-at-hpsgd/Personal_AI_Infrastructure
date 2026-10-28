/**
 * What the CLI does besides editing definitions: list runs (ISC-72), stop one
 * (ISC-73), test a definition against fixtures (ISC-75) and emit a named event
 * (ISC-71). None of these writes a definition file; that is definitions.ts.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse, parseDocument } from "yaml";
import { invariant } from "../../TOOLS/Invariant.ts";
import { parseDefinitionText, type DefinitionV2, type StepV2 } from "./format.ts";
import { message } from "./format.ts";
import { readClaims, readLedger, RUN_STATUSES, appendRecord, stopMarkerPath, writeFileAtomic, type Claim, type LedgerRecord, type LedgerStep } from "./ledger.ts";
import { definitionsDir, DEFINITION_SUFFIX, ledgerPath, NAME_RE, pathForName } from "./paths.ts";
import { resolveActions, runDefinition } from "./runner.ts";

/* ── Events (ISC-71) ────────────────────────────────────────────────────── */

export const EVENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface EventRecord {
  schema: 1;
  id: string;
  name: string;
  input: unknown;
  emitted_at: string;
}

/** Where emitted events wait for the dispatcher: `events/` beside the ledger. */
export const eventsDir = (ledger: string = ledgerPath()): string => join(dirname(ledger), "events");

/** Writes one event file. The dispatcher reads `events/*.event.json` and starts every enabled workflow with a matching event trigger. */
export function emitEvent(name: string, input: unknown, opts: { ledger?: string; now?: Date } = {}): { event: EventRecord; path: string } {
  invariant(EVENT_NAME_RE.test(name), `"${name}" is not an event name`);
  const now = opts.now ?? new Date();
  const event: EventRecord = { schema: 1, id: randomUUID(), name, input, emitted_at: now.toISOString() };
  const dir = eventsDir(opts.ledger);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${event.emitted_at.replace(/[:.]/g, "-")}-${event.id}.event.json`);
  writeFileAtomic(path, `${JSON.stringify(event)}\n`);
  return { event, path };
}

export function pendingEvents(ledger: string = ledgerPath()): EventRecord[] {
  const dir = eventsDir(ledger);
  if (!existsSync(dir)) return [];
  const out: EventRecord[] = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith(".event.json")).sort()) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as EventRecord;
      if (parsed.schema === 1 && typeof parsed.name === "string" && typeof parsed.id === "string") out.push(parsed);
    } catch {
      /* a half-written event is not an event yet */
    }
  }
  return out;
}

/** The enabled workflows in the home whose enabled event triggers match this event name. */
export function eventTargets(name: string, home: string = definitionsDir()): string[] {
  if (!existsSync(home)) return [];
  const out: string[] = [];
  for (const file of readdirSync(home).filter(f => f.endsWith(DEFINITION_SUFFIX)).sort()) {
    try {
      const def = parseDefinitionText(readFileSync(join(home, file), "utf8"), join(home, file));
      if (def.enabled === false) continue;
      if (def.triggers.some(t => t.type === "event" && t.name === name && t.enabled !== false)) out.push(def.name);
    } catch {
      /* an invalid definition receives nothing */
    }
  }
  return out;
}

/* ── Runs (ISC-72) ──────────────────────────────────────────────────────── */

export interface ActiveRun {
  run_id: string;
  workflow: string;
  occurrence_key: string;
  started_at: string;
  deadline_at: string | null;
  /** True once the claim's deadline has passed with no ledger line; the sweep will close it as abandoned. */
  overdue: boolean;
}

export interface QueuedOccurrence {
  event_id: string;
  event: string;
  workflow: string;
  emitted_at: string;
}

/** In-flight runs: a claim with no ledger line. */
export function activeRuns(ledger: string = ledgerPath(), workflow?: string, now: number = Date.now()): ActiveRun[] {
  const { records } = readLedger(ledger);
  const done = new Set(records.map(r => r.run_id));
  const occurrences = new Set(records.map(r => `${r.workflow}\0${r.occurrence_key}`));
  return readClaims(ledger)
    .filter(c => !done.has(c.run_id) && !occurrences.has(`${c.workflow}\0${c.occurrence_key}`) && (!workflow || c.workflow === workflow))
    .map(c => ({
      run_id: c.run_id,
      workflow: c.workflow,
      occurrence_key: c.occurrence_key,
      started_at: c.started_at ?? c.at,
      deadline_at: c.deadline_at ?? null,
      overdue: c.deadline_at !== undefined && Date.parse(c.deadline_at) <= now,
    }))
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
}

/** Occurrences waiting to start: an emitted event no dispatcher has consumed, per enabled workflow it would start. */
export function queuedOccurrences(ledger: string = ledgerPath(), home: string = definitionsDir(), workflow?: string): QueuedOccurrence[] {
  const out: QueuedOccurrence[] = [];
  for (const event of pendingEvents(ledger)) {
    for (const target of eventTargets(event.name, home)) {
      if (!workflow || target === workflow) out.push({ event_id: event.id, event: event.name, workflow: target, emitted_at: event.emitted_at });
    }
  }
  return out;
}

export interface RunSummary {
  run_id: string;
  workflow: string;
  status: string;
  trigger: string;
  occurrence_key: string;
  started_at: string;
  finished_at: string;
}

/** `--since` takes an ISO time or a duration back from now (`90m`, `6h`, `2d`); null when it is neither. */
export function parseSince(value: string, now: number = Date.now()): number | null {
  const rel = value.trim().match(/^(\d{1,6})([mhd])$/);
  if (rel) return now - Number(rel[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 } as Record<string, number>)[rel[2]];
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export function listRuns(ledger: string, filter: { workflow?: string; status?: string; since?: number; limit?: number }): RunSummary[] {
  const { records } = readLedger(ledger);
  const rows = records
    .filter(r => (!filter.workflow || r.workflow === filter.workflow) && (!filter.status || r.status === filter.status) && (filter.since === undefined || Date.parse(r.finished_at) >= filter.since))
    .map(r => ({ run_id: r.run_id, workflow: r.workflow, status: r.status as string, trigger: r.trigger, occurrence_key: r.occurrence_key, started_at: r.started_at, finished_at: r.finished_at }));
  return rows.slice(-(filter.limit ?? 50)).reverse();
}

/* ── Stop (ISC-73) ──────────────────────────────────────────────────────── */

const STOPPED_ERROR = "The run was stopped before it finished.";
const STOPPED_STEP_ERROR = "Skipped: the run was stopped.";

/** The ledger line a stopped run gets: status `stopped`, unfinished steps `skipped`. */
export function stoppedRecord(claim: Claim, now: Date): LedgerRecord | string {
  if (typeof claim.definition_hash !== "string" || !/^[0-9a-f]{64}$/.test(claim.definition_hash)) return "the claim carries no definition hash";
  if (!claim.data_class) return "the claim carries no data class";
  const steps: Record<string, LedgerStep> = {};
  for (const id of claim.steps && claim.steps.length ? claim.steps : ["run"]) {
    steps[id] = { status: "skipped", attempts: 0, started_at: null, duration_ms: 0, error: STOPPED_STEP_ERROR };
  }
  return {
    schema: 1,
    run_id: claim.run_id,
    workflow: claim.workflow,
    definition_path: claim.definition_path ?? "",
    definition_hash: claim.definition_hash,
    trigger: ((claim.trigger as LedgerRecord["trigger"] | undefined) ?? "manual"),
    occurrence_key: claim.occurrence_key,
    data_class: claim.data_class,
    runs_on: "local",
    started_at: claim.started_at ?? claim.at,
    finished_at: now.toISOString(),
    status: "stopped" as LedgerRecord["status"],
    steps,
    output_digest: null,
    error: STOPPED_ERROR,
  };
}

export interface StopResult {
  ok: boolean;
  run_id: string;
  workflow?: string;
  /** A stop request marker was written beside the claim for the running process. */
  requested: boolean;
  /** The ledger line was written with status `stopped`. */
  closed: boolean;
  error?: string;
}

/**
 * Stops an in-flight local run. Refuses a run that is unknown or already
 * finished. It writes a stop request beside the claim, then closes the run in
 * the ledger as `stopped` when the ledger accepts that status. A ledger that
 * does not yet know `stopped` leaves the run open and says so.
 */
/** How long `workflow stop` waits for a live runner to close its own run. */
export const STOP_WAIT_MS = 5_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function stopRun(runId: string, ledger: string = ledgerPath(), now: Date = new Date()): StopResult {
  const { records } = readLedger(ledger);
  const finished = records.find(r => r.run_id === runId);
  if (finished) return { ok: false, run_id: runId, workflow: finished.workflow, requested: false, closed: false, error: `Run ${runId} already finished (${finished.status}); there is nothing to stop.` };
  const claim = readClaims(ledger).find(c => c.run_id === runId);
  // A run that finished between the two reads has written its line and removed its claim.
  const late = claim ? undefined : readLedger(ledger).records.find(r => r.run_id === runId);
  if (late) return { ok: false, run_id: runId, workflow: late.workflow, requested: false, closed: false, error: `Run ${runId} already finished (${late.status}); there is nothing to stop.` };
  if (!claim) return { ok: false, run_id: runId, requested: false, closed: false, error: `No in-flight run ${runId}. Find one with: workflow runs --active` };
  writeFileAtomic(stopMarkerPath(ledger, runId), `${JSON.stringify({ run_id: runId, requested_at: now.toISOString() })}\n`);
  if (!(RUN_STATUSES as readonly string[]).includes("stopped")) {
    return { ok: false, run_id: runId, workflow: claim.workflow, requested: true, closed: false, error: "Stop requested, but the ledger does not accept status `stopped` yet, so the run is still open." };
  }
  // ISC-73: a live runner polls the marker, kills its process group and writes the stopped line itself; give it a moment before closing the run from the claim.
  if (claim.pid !== undefined && claim.pid !== process.pid && pidAlive(claim.pid)) {
    const until = Date.now() + STOP_WAIT_MS;
    while (Date.now() < until) {
      if (readLedger(ledger).records.some(r => r.run_id === runId)) return { ok: true, run_id: runId, workflow: claim.workflow, requested: true, closed: true };
      Bun.sleepSync(50);
    }
  }
  if (readLedger(ledger).records.some(r => r.run_id === runId)) return { ok: true, run_id: runId, workflow: claim.workflow, requested: true, closed: true };
  const record = stoppedRecord(claim, now);
  if (typeof record === "string") return { ok: false, run_id: runId, workflow: claim.workflow, requested: true, closed: false, error: `Stop requested, but the run cannot be closed: ${record}.` };
  appendRecord(ledger, record);
  return { ok: true, run_id: runId, workflow: claim.workflow, requested: true, closed: true };
}

/* ── Test with fixtures (ISC-75) ────────────────────────────────────────── */

export interface Fixture {
  name: string;
  input?: unknown;
  /** Stubbed step results by step id: `output`, or `error` for a step that fails. */
  steps?: Record<string, { output?: unknown; error?: string }>;
  expect: { status?: "succeeded" | "failed"; output?: unknown; steps?: Record<string, string>; error_contains?: string };
}

export const fixturesPath = (name: string, home: string = definitionsDir()): string => join(home, `${name}.fixtures.yaml`);

export function loadFixtures(name: string, home: string = definitionsDir()): { path: string; fixtures: Fixture[] } | { path: string; error: string } {
  const path = fixturesPath(name, home);
  if (!existsSync(path)) return { path, error: `${name} declares no fixtures (expected ${path}).` };
  let doc: unknown;
  try {
    doc = parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { path, error: `${path} is not readable YAML: ${message(error)}` };
  }
  const list = (doc as { fixtures?: unknown } | null)?.fixtures;
  if (!Array.isArray(list) || list.length === 0) return { path, error: `${path} must hold a non-empty fixtures: list.` };
  for (const [i, f] of list.entries()) {
    const ok = f && typeof f === "object" && typeof (f as Fixture).name === "string" && (f as Fixture).expect && typeof (f as Fixture).expect === "object";
    if (!ok) return { path, error: `${path} fixtures[${i}] needs a name and an expect block.` };
  }
  return { path, fixtures: list as Fixture[] };
}

const GATED = ["outbound", "money", "deploy"];

/** Steps a test never runs for real: any with an outbound, money or deploy effect, and every kind other than action and command (model, agent, human, judgment, workflow). */
export function stubbedSteps(def: DefinitionV2): StepV2[] {
  return Object.values(def.steps).filter(s => s.side_effects.some(e => GATED.includes(e)) || (s.kind !== "action" && s.kind !== "command"));
}

export interface FixtureResult {
  fixture: string;
  passed: boolean;
  failures: string[];
  stubbed: string[];
  status?: string;
}

const stubArgv = (fixture: { output?: unknown; error?: string }): string[] =>
  fixture.error !== undefined
    ? [process.execPath, "-e", `process.stderr.write(${JSON.stringify(fixture.error)}); process.exit(1)`]
    : [process.execPath, "-e", `process.stdout.write(${JSON.stringify(JSON.stringify(fixture.output ?? {}))})`];

/** The definition text with every stubbed step replaced by a command that prints the fixture's value. */
function stubbedText(text: string, def: DefinitionV2, fixture: Fixture, contracts: Map<string, { input?: unknown; output?: unknown }>): { text: string; stubbed: string[]; missing: string[] } {
  const doc = parseDocument(text);
  const stubbed: string[] = [];
  const missing: string[] = [];
  for (const step of stubbedSteps(def)) {
    const stub = fixture.steps?.[step.id];
    if (!stub) {
      missing.push(step.id);
      continue;
    }
    const contract = step.kind === "action" ? contracts.get(step.uses as string) ?? {} : { input: step.input, output: step.output };
    // The stub only prints the fixture's value, so it touches nothing.
    const replacement: Record<string, unknown> = { kind: "command", side_effects: ["none"], argv: stubArgv(stub) };
    if (step.needs.length) replacement.needs = step.needs;
    if (step.with !== undefined) replacement.with = step.with;
    if (step.when) replacement.when = step.when;
    if (contract.input !== undefined) replacement.input = contract.input;
    if (contract.output !== undefined) replacement.output = contract.output;
    doc.setIn(["steps", step.id], doc.createNode(replacement));
    stubbed.push(step.id);
  }
  return { text: doc.toString(), stubbed, missing };
}

/**
 * Runs the definition once per fixture in a throwaway directory and ledger
 * (the real ledger is never written). Steps that could reach outside the
 * machine are replaced by the fixture's stub; a stubbed step with no fixture
 * value fails the fixture instead of running.
 */
export async function testDefinition(name: string, home: string = definitionsDir()): Promise<{ ok: boolean; error?: string; fixtures_path: string; results: FixtureResult[] }> {
  const path = pathForName(name, home);
  if (!existsSync(path)) return { ok: false, error: `No workflow named "${name}" in ${home}.`, fixtures_path: fixturesPath(name, home), results: [] };
  const loaded = loadFixtures(name, home);
  if ("error" in loaded) return { ok: false, error: loaded.error, fixtures_path: loaded.path, results: [] };
  const text = readFileSync(path, "utf8");
  let def: DefinitionV2;
  try {
    def = parseDefinitionText(text, path);
  } catch (error) {
    return { ok: false, error: message(error), fixtures_path: loaded.path, results: [] };
  }
  const actions = await resolveActions(def);
  const results: FixtureResult[] = [];
  const scratch = mkdtempSync(join(tmpdir(), "workflow-test-"));
  try {
    for (const [i, fixture] of loaded.fixtures.entries()) {
      const built = stubbedText(text, def, fixture, actions.contracts);
      const failures: string[] = [];
      if (built.missing.length) {
        failures.push(`Step(s) ${built.missing.join(", ")} could reach outside or need a person or a model; a test never runs them, and the fixture gives no value for them.`);
        results.push({ fixture: fixture.name, passed: false, failures, stubbed: built.stubbed });
        continue;
      }
      const dir = join(scratch, `f${i}`);
      mkdirSync(dir, { recursive: true });
      const stubPath = join(dir, `${name}${DEFINITION_SUFFIX}`);
      await Bun.write(stubPath, built.text);
      const report = await runDefinition(stubPath, { input: fixture.input, ledger: join(dir, "runs.jsonl"), definitions: home, occurrenceKey: `test-${i}` });
      const status = report.success ? "succeeded" : "failed";
      const want = fixture.expect.status ?? "succeeded";
      if (report.refused) failures.push(`The run was refused (${report.refused}): ${report.error}`);
      else if (status !== want) failures.push(`Expected status ${want}, got ${status}${report.error ? ` (${report.error})` : ""}.`);
      if (fixture.expect.output !== undefined && !Bun.deepEquals(report.output, fixture.expect.output, true)) {
        failures.push(`Expected output ${JSON.stringify(fixture.expect.output)}, got ${JSON.stringify(report.output)}.`);
      }
      for (const [id, expected] of Object.entries(fixture.expect.steps ?? {})) {
        const got = report.steps[id]?.status;
        if (got !== expected) failures.push(`Expected step ${id} to be ${expected}, got ${got ?? "not run"}.`);
      }
      if (fixture.expect.error_contains !== undefined && !(report.error ?? "").includes(fixture.expect.error_contains)) {
        failures.push(`Expected the error to contain "${fixture.expect.error_contains}", got "${report.error ?? ""}".`);
      }
      results.push({ fixture: fixture.name, passed: failures.length === 0, failures, stubbed: built.stubbed, status });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { ok: results.length > 0 && results.every(r => r.passed), fixtures_path: loaded.path, results };
}

export { NAME_RE };
