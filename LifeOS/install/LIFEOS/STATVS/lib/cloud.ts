/**
 * The cloud tier, seen from the Mac: the forwarder, the pull, the cloud-copy delete and the
 * status report (migration design §2.2, §2.3, §3 Lane B "Forwarder and pull", "Credentials guard").
 *
 * The record is the outbox. `forward()` reads consumer `cloud-forward` over every stream that
 * declares `forward: true` (only `event` today), classes public, system and personal, rows that
 * carry a severity, and POSTs their projection (§2.3) to the cloud tier in batches of 100. It
 * commits the `pos` of the last acknowledged row after each 2xx and never moves past a row the
 * cloud has not acknowledged, so an outage or a 503 on a later batch loses nothing; a replay is
 * absorbed by D1's unique `dedup_key`. A 400/403 batch is retried one row at a time and each
 * refused row becomes one `collect` row (`forward-refused`), so one bad row never blocks the rest.
 * Before anything new it retries every `cloud-delete-pending` row. Those rows and their
 * `cloud-delete-done` closes live in stream `statvs`, which prune never touches, so a retention
 * window on `collect` can never drop a cloud delete that has not happened yet (ISC-195).
 *
 * `pull()` reads `GET /events?since=` with the two-minute overlap and settled-cursor rule of
 * Vigil's tick; with no cursor it baselines at now and reads nothing older. It skips rows by
 * identity and never by emitter (§2.2: ids shaped like a record row,
 * ids and dedup keys in view `event-keys`, ids in view `cloud-ids` or the one-shot
 * `collect/pulled-seed.json`, Vigil's own rows and the sweep row), refuses `customer` rows
 * fail-closed with a `pull-refused` row, and writes everything else to stream `cloud` through
 * `writePulled`, which Vigil's legacy tick also calls during dual-write.
 *
 * The pull cursor only moves forward. The `since` a pull sends sits the overlap behind the cursor,
 * and the cloud tier answers an empty page with that `since` and a re-read page with an earlier
 * row's ts, so `next` is never taken below the cursor it started from. The pull also sends its cursor
 * (`cursor=`), which a cloud tier at 0.9.0 or later uses to the same end. One exception: a cursor
 * already past the future cap (the clock stepped back more than five minutes) is reset to now.
 *
 * Credentials guard (S8, P7, ISC-194): `statvsCredentials()` is null under `bun test`, for any
 * record or state dir other than the home one (replays, restore drills, Rewind), and while the
 * old `VIGIL_STATE_DIR` is set, unless the URL was set explicitly for this process. Bun loads the
 * install's `.env` into `process.env` on its own, so a `STATVS_URL` in the process env is no proof
 * of an explicit choice. Under test only `STATVS_CLOUD_TEST_URL` and `STATVS_CLOUD_TEST_TOKEN`
 * count, names that never live in `.env`; `STATVS_URL` and `STATVS_TOKEN` are ignored. An isolated
 * process outside a test counts a process value only when it differs from the env file's, for the
 * URL and the bearer both, so the live bearer never leaves for a fixture or a replay. The same
 * null blocks the pull, so an isolated record never receives live personal rows.
 *
 * Every string that enters a `collect` row from outside (a Worker's error text, an app's id or
 * emitter name) passes the credential and personal-content checks first; a hit is replaced by
 * "error text withheld (<rule>)", so one bad string never refuses the row that reports it (§2.4).
 *
 * Nothing here runs on a schedule in stage p1: `Statvs.ts forward | pull | cloud` dispatch here,
 * and `statvs-collect` calls them only from the switch (p2).
 *
 * @version 1.3.0
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { invariant, InvariantViolation } from "../../TOOLS/Invariant";
import { envFileValues } from "../../TOOLS/lib/EnvKeys";
import { sha256 } from "../../TOOLS/lib/LedgerCore";
import { lifeosPath } from "../../TOOLS/Paths";
import { allStreams } from "../streams";
import { commit, consumersDir, loadPos, readSince, type ConsumerRow } from "./consumer";
import { append, personalRefusal, scan, statvsDir, statvsStateDir } from "./record";
import { credentialRefusal, KINDS, validateEvent, type VigilEvent } from "./refuse";
import type { AppendResult, PrivacyClass, StatvsInput, StatvsRow } from "./types";
import { readViewDef } from "./views";
import eventKeysView, { eventKeySets } from "../views/event-keys";
import cloudIdsView, { cloudIdSet } from "../views/cloud-ids";

export const FORWARD_CONSUMER = "cloud-forward";
export const PULL_CONSUMER = "cloud-pull";
/** Classes that may leave the machine. Customer rows never forward from the Mac (§2.3). */
const FORWARD_CLASSES: PrivacyClass[] = ["public", "system", "personal"];
const BATCH_MAX = 100;
/** The forwarder baselines this many days back when its consumer file is missing; D1 absorbs the replay. */
const FORWARD_BASELINE_DAYS = 2;
const PULL_LIMIT = 1000;
/** Pages one pull may read before it stops and reports `more`. */
const PULL_PAGES = 10;
/** A cloud row can be stamped before an earlier-stamped row commits, so each pull re-reads this window (Vigil ISC-125). */
const PULL_OVERLAP_MS = 2 * 60_000;
/** Rows stamped further than this in the future are left in the cloud (emitter clocks are untrusted). */
const FUTURE_CAP_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Unfinished cloud deletes (ISC-195) stay listed until a `cloud-delete-done` row answers them. The cloud tier keeps
 * every row forever (STATVS full migration ISC-47), so a pending delete never ages out on its own.
 */
const DAY_MS = 86_400_000;
/** A row id of this record: anything shaped like it in the cloud is a row this Mac forwarded. */
const RECORD_ID = /^s[0-9a-f]{24}$/;
const EMITTER = /^[A-Za-z0-9_.:-]{1,64}$/;
const NULL_HASH = sha256("null");
const COLLECT = { stream: "collect", class: "system" as const };
/**
 * Where an unfinished cloud delete and its close live: stream `statvs`, beside the redaction tombstone it finishes.
 * Prune refuses that stream and keeps any segment holding one of its rows (record.ts prune), so no retention window
 * on `collect` can drop a pending delete before it is done (ISC-195). Rows written by an earlier build to `collect` are still read.
 */
const OBLIGATION = { stream: "statvs", class: "system" as const };
const OBLIGATION_KINDS: readonly string[] = ["cloud-delete-pending", "cloud-delete-done"];

// ── Credentials ──

export interface Credentials { url: string; token: string }

const isTest = (env: NodeJS.ProcessEnv) => env.NODE_ENV === "test";
/** The real path of p when it exists, else its resolved path. */
function realish(p: string): string {
  const r = resolve(p);
  try { return realpathSync(r); } catch { return r; }
}
/** The record and state dir an unconfigured process on this install uses. */
function homeRecord(): string { return realish(lifeosPath("MEMORY", "STATVS")); }
function homeState(): string { return realish(join(homedir(), ".local/state/lifeos/statvs")); }

/** Why this process is cut off from the live cloud tier, or null when it is the home record. */
export function isolationReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if (isTest(env)) return "under test";
  if (env.STATVS_DIR && realish(env.STATVS_DIR) !== homeRecord()) return "STATVS_DIR names another record";
  if (env.STATVS_STATE_DIR && realish(env.STATVS_STATE_DIR) !== homeState()) return "STATVS_STATE_DIR names another state dir";
  if (env.VIGIL_STATE_DIR) return "VIGIL_STATE_DIR is set";
  return null;
}

/**
 * The cloud tier's URL and the Mac's bearer, or null (ISC-194). Under test only the test-only
 * names count (STATVS_CLOUD_TEST_URL, STATVS_CLOUD_TEST_TOKEN): Bun may have loaded the live
 * STATVS_URL and STATVS_TOKEN from the env file into this very process. An isolated process
 * outside a test needs a URL and a bearer that its environment sets and the env file does not
 * hold. The home record reads the process env first, then the env file, as Vigil did.
 */
export function statvsCredentials(env: NodeJS.ProcessEnv = process.env): Credentials | null {
  if (isTest(env)) {
    const url = env.STATVS_CLOUD_TEST_URL, token = env.STATVS_CLOUD_TEST_TOKEN;
    return url && token ? { url, token } : null;
  }
  const file = envFileValues();
  if (isolationReason(env) !== null) {
    /** A process value equal to the env file's came from the file through Bun, not from a choice. */
    const explicit = (k: "STATVS_URL" | "STATVS_TOKEN") => (env[k] !== undefined && env[k] !== file[k] ? env[k] : undefined);
    const url = explicit("STATVS_URL"), token = explicit("STATVS_TOKEN");
    return url && token ? { url, token } : null;
  }
  const url = env.STATVS_URL ?? file.STATVS_URL;
  const token = env.STATVS_TOKEN ?? file.STATVS_TOKEN;
  return url && token ? { url, token } : null;
}

const base = (c: Credentials) => c.url.replace(/\/+$/, "");
function hostOf(url: string): string | null {
  try { return new URL(url).host; } catch { return null; }
}

async function request(c: Credentials, path: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
  return fetchImpl(`${base(c)}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${c.token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

// ── Text that enters a collect row ──

/** The text, clipped, or a note that it was withheld: a collect row must never be refused for the text it reports (§2.4, S15). */
export function safeText(text: unknown, max = 200): string {
  const s = String(text ?? "").slice(0, max);
  if (credentialRefusal(s) !== null) return "error text withheld (credential)";
  if (personalRefusal(s) !== null) return "error text withheld (personal)";
  return s;
}

/** Append one `collect` row; never throws for a refusal or a spool, and says why it was not written. */
function collectRow(writer: string, kind: string, title: string, data: Record<string, unknown>, ref?: string, at: { stream: string; class: "system" } = COLLECT): string | null {
  invariant(writer.startsWith("statvs:") && kind.length > 0, "collect rows come from a statvs writer and name their kind");
  invariant(at.stream === COLLECT.stream || (at.stream === OBLIGATION.stream && OBLIGATION_KINDS.includes(kind)), "only an unfinished cloud delete and its close are written outside collect");
  const input: StatvsInput = { writer, ...at, kind, title, data };
  if (ref !== undefined) input.ref = ref;
  const r = append(input);
  if (r.ok) return null;
  return "refused" in r ? `${kind} row refused: ${r.refused}` : `${kind} row spooled: ${r.reason}`;
}

// ── Projection (§2.3) ──

/** Streams whose severity rows leave the machine (ISC-191). Set only in streams.ts. */
export function forwardStreams(): string[] {
  return Object.entries(allStreams()).filter(([, d]) => d.forward === true).map(([name]) => name).sort();
}

/** A row whose data was scrubbed by a redaction (data null, data_hash of something else). */
function scrubbed(row: StatvsRow): boolean {
  return row.data === null && row.data_hash !== NULL_HASH;
}

const CLASS_MAP: Record<string, VigilEvent["privacy_class"]> = { public: "public", system: "personal", personal: "personal" };

/**
 * The D1 event for a record row, or why it may not leave. `data.cloud_class` is honoured on
 * stream `event` only; anywhere else the row's own class decides, so no writer can publish a
 * personal row by setting a field (P3). The result has passed `validateEvent`, so the Mac refuses
 * exactly what the Worker would (ISC-93).
 */
export function projectRow(row: StatvsRow): { event: VigilEvent } | { refused: string; quiet?: true } {
  if (typeof row.severity !== "string") return { refused: "row carries no severity" };
  if (row.class === "customer") return { refused: "customer rows never forward from the Mac" };
  // A redacted row never leaves, and is not a refusal worth a row: its cloud copy, if any, is deleted by redact.
  if (scrubbed(row)) return { refused: "row was redacted", quiet: true };
  const data = (row.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data : {}) as Record<string, unknown>;
  const onEvent = row.stream === "event";
  let privacy = CLASS_MAP[row.class];
  if (onEvent && data.cloud_class !== undefined) {
    if (data.cloud_class === "public" || data.cloud_class === "personal") privacy = data.cloud_class;
    else return { refused: `cloud_class ${String(data.cloud_class)} does not forward` };
  }
  if (!privacy) return { refused: `class ${row.class} does not forward` };
  const clip = (s: string, n: number) => (onEvent ? s : s.slice(0, n));
  const title = clip(typeof row.title === "string" && row.title.length > 0 ? row.title : `${row.stream} ${row.kind ?? "row"}`, 140);
  const summary = clip(typeof data.summary === "string" && data.summary.length > 0 ? data.summary : title, 1000);
  const meta = data.meta && typeof data.meta === "object" && !Array.isArray(data.meta) ? (data.meta as VigilEvent["meta"]) : undefined;
  const event: VigilEvent = {
    id: row.id,
    source: typeof data.source === "string" && data.source.length > 0 ? data.source : row.writer,
    ts: row.ts,
    kind: (KINDS as readonly string[]).includes(row.kind ?? "") ? (row.kind as VigilEvent["kind"]) : "other",
    severity: row.severity as VigilEvent["severity"],
    title,
    summary,
    ref: typeof row.ref === "string" ? row.ref : null,
    url: typeof data.url === "string" ? data.url : null,
    privacy_class: privacy,
    dedup_key: typeof data.dedup_key === "string" && data.dedup_key.length > 0 ? data.dedup_key : row.id,
    ...(meta !== undefined ? { meta } : {}),
  };
  try { validateEvent(event); } catch (e) { return { refused: (e as Error).message }; }
  return { event };
}

// ── Cloud deletes (P5, ISC-195) ──

export interface DeleteResult { ok: boolean; deleted: string[]; absent: string[]; failed: string[]; pending?: true; reason?: string }

/** Any non-empty id up to 256 characters; each is URL-encoded into its own path segment. */
const deletable = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 256;

/**
 * The STATVS route's own answer for a row it does not hold for this bearer: 404 `{ deleted: 0 }`.
 * Any other 404 (the old lifeos-vigil Worker has no DELETE route and answers `{ error: "not found" }`)
 * proves nothing about the row, so it counts as failed and the delete stays pending.
 */
async function routeSaysAbsent(res: Response): Promise<boolean> {
  try {
    const body = (await res.json()) as { deleted?: unknown } | null;
    return body !== null && typeof body === "object" && body.deleted === 0;
  } catch { return false; }
}

/** DELETE each id; 2xx is deleted, the route's own 404 is "not ours or gone" (it deletes only the caller's own rows). */
async function tryDeletes(c: Credentials, ids: string[], fetchImpl: typeof fetch): Promise<Omit<DeleteResult, "ok">> {
  const deleted: string[] = [], absent: string[] = [], failed: string[] = [];
  for (const id of ids) {
    try {
      const res = await request(c, `/events/${encodeURIComponent(id)}`, { method: "DELETE" }, fetchImpl);
      if (res.ok) deleted.push(id);
      else if (res.status === 404 && await routeSaysAbsent(res)) absent.push(id);
      else failed.push(id);
    } catch { failed.push(id); }
  }
  return { deleted, absent, failed };
}

/**
 * Delete the cloud copies of a redacted row (its row id and its event id). When the cloud is
 * unreachable or has no credentials, one `cloud-delete-pending` row names the ids that are left,
 * and the next forward run retries it before sending anything new.
 */
export async function deleteCloudCopy(ids: string[], opts: { fetchImpl?: typeof fetch; credentials?: Credentials | null } = {}): Promise<DeleteResult> {
  const list = [...new Set(ids)].filter(deletable);
  if (list.length === 0) return { ok: true, deleted: [], absent: [], failed: [] };
  const creds = opts.credentials === undefined ? statvsCredentials() : opts.credentials;
  const r = creds ? await tryDeletes(creds, list, opts.fetchImpl ?? fetch) : { deleted: [], absent: [], failed: list };
  if (r.failed.length === 0) return { ok: true, ...r };
  const reason = creds ? "cloud unreachable or refused the delete" : "no cloud credentials";
  const problem = collectRow("statvs:forward", "cloud-delete-pending", "Cloud delete pending", { ids: r.failed.map((id) => safeText(id, 256)), reason }, undefined, OBLIGATION);
  return { ok: false, ...r, pending: true, reason: problem ? `${reason}; ${problem}` : reason };
}

interface Pending { id: string; ids: string[] }

/** Every `cloud-delete-pending` row with no `cloud-delete-done` row pointing at them. `now` is kept for callers' signatures. */
export function pendingDeletes(_now = Date.now()): Pending[] {
  const rows = scan({ streams: [OBLIGATION.stream, COLLECT.stream], classes: ["system"] }).rows.filter((r) => OBLIGATION_KINDS.includes(r.kind ?? ""));
  const done = new Set(rows.filter((r) => r.kind === "cloud-delete-done" && typeof r.ref === "string").map((r) => r.ref!));
  return rows
    .filter((r) => r.kind === "cloud-delete-pending" && !done.has(r.id))
    .map((r) => ({ id: r.id, ids: ((r.data as { ids?: unknown } | null)?.ids as unknown[] | undefined ?? []).filter(deletable) }));
}

async function retryPendingDeletes(c: Credentials, fetchImpl: typeof fetch, now: number): Promise<{ retried: number; cleared: number; failed: number }> {
  let cleared = 0, failed = 0;
  const pending = pendingDeletes(now);
  for (const p of pending) {
    const r = await tryDeletes(c, p.ids, fetchImpl);
    if (r.failed.length > 0) { failed++; continue; }
    collectRow("statvs:forward", "cloud-delete-done", "Cloud delete done", { deleted: r.deleted.length, absent: r.absent.length }, p.id, OBLIGATION);
    cleared++;
  }
  return { retried: pending.length, cleared, failed };
}

// ── Forward (ISC-89, ISC-191) ──

export interface ForwardOptions { fetchImpl?: typeof fetch; credentials?: Credentials | null; batch?: number; now?: number }
export interface ForwardResult {
  skipped?: true;
  sent: number;
  refused: number;
  /** Severity rows read and not yet acknowledged by the cloud. The switch requires 0 (§4.3). */
  remaining: number;
  baselined?: true;
  /** Set when a failure other than 400/403 stopped the run; the cursor sits after the last acknowledged row. */
  stopped?: string;
  deletes?: { retried: number; cleared: number; failed: number };
  problems?: string[];
}

function readOpts(now: number) {
  return { streams: forwardStreams(), classes: FORWARD_CLASSES, severity: true as const, baselineDays: FORWARD_BASELINE_DAYS, now };
}

/** Ship every unsent severity row of a forwarding stream. See the module header. */
export async function forward(opts: ForwardOptions = {}): Promise<ForwardResult> {
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const creds = opts.credentials === undefined ? statvsCredentials() : opts.credentials;
  if (!creds) {
    // Never baseline a consumer for a run that cannot send: report the backlog only when a position exists.
    const remaining = loadPos(FORWARD_CONSUMER) ? readSince(FORWARD_CONSUMER, readOpts(now)).rows.length : 0;
    return { skipped: true, sent: 0, refused: 0, remaining };
  }
  const size = Math.min(BATCH_MAX, Math.max(1, Math.floor(opts.batch ?? BATCH_MAX)));
  const deletes = await retryPendingDeletes(creds, fetchImpl, now);
  const read = readSince(FORWARD_CONSUMER, readOpts(now));
  const rows = read.rows;
  const problems: string[] = [...(read.problems ?? [])];
  let sent = 0, refused = 0, done = 0, stopped: string | undefined;

  const ack = (row: ConsumerRow) => { commit(FORWARD_CONSUMER, row.pos, { now }); done++; };
  const refuse = (row: ConsumerRow, status: number, reason: string, quiet?: true) => {
    if (quiet) return;
    const p = collectRow("statvs:forward", "forward-refused", "Forward refused", { stream: row.stream, status, reason: safeText(reason) }, row.id);
    if (p) problems.push(p);
    refused++;
  };
  const post = (events: VigilEvent[]) => request(creds, "/events", { method: "POST", body: JSON.stringify(events) }, fetchImpl);
  const bodyText = async (res: Response) => { try { return await res.text(); } catch { return ""; } };

  outer: for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size).map((row) => ({ row, p: projectRow(row) }));
    const events = chunk.flatMap((c) => ("event" in c.p ? [c.p.event] : []));
    let status = 0;
    if (events.length > 0) {
      try {
        const res = await post(events);
        status = res.status;
        if (!res.ok && res.status !== 400 && res.status !== 403) { stopped = `cloud answered ${res.status}`; break; }
      } catch (e) { stopped = `cloud unreachable: ${safeText((e as Error)?.message ?? e)}`; break; }
    }
    if (events.length === 0 || (status >= 200 && status < 300)) {
      for (const c of chunk) { if ("refused" in c.p) refuse(c.row, 0, c.p.refused, c.p.quiet); else sent++; }
      ack(chunk[chunk.length - 1]!.row);
      done += chunk.length - 1;
      continue;
    }
    // 400/403: one row at a time, in order, so one bad row never blocks the batch (Vigil ISC-78).
    for (const c of chunk) {
      if ("refused" in c.p) { refuse(c.row, 0, c.p.refused, c.p.quiet); ack(c.row); continue; }
      try {
        const res = await post([c.p.event]);
        if (res.ok) { sent++; ack(c.row); continue; }
        if (res.status === 400 || res.status === 403) { refuse(c.row, res.status, await bodyText(res)); ack(c.row); continue; }
        stopped = `cloud answered ${res.status}`;
      } catch (e) { stopped = `cloud unreachable: ${safeText((e as Error)?.message ?? e)}`; }
      break outer;
    }
  }
  // Every wanted row handled: move past the rows the filter skipped too.
  if (!stopped) commit(FORWARD_CONSUMER, read.next, { now });
  invariant(done <= rows.length && sent + refused <= done, "the forwarder acknowledges only rows it read");
  const remaining = rows.length - done;
  const result: ForwardResult = {
    sent, refused, remaining, deletes,
    ...(read.baselined ? { baselined: true as const } : {}),
    ...(stopped ? { stopped } : {}),
  };
  const p = collectRow("statvs:forward", "forward", "Cloud forward", { sent, refused, remaining, deletes, ...(stopped ? { stopped: safeText(stopped) } : {}), ...(read.baselined ? { baselined: true } : {}) });
  if (p) problems.push(p);
  if (problems.length > 0) result.problems = problems;
  return result;
}

// ── Pull (§2.2, ISC-193) ──

/** A row as the cloud tier's `GET /events` returns it. */
export type StoreRow = Omit<VigilEvent, "meta"> & { emitter: string; meta?: VigilEvent["meta"] | string | null };

export function pullCursorPath(): string { return join(consumersDir(), `${PULL_CONSUMER}.json`); }
/** The pull's cursor, `{ since }`, the same shape as Vigil's `store-reader.json` (MoveCursors copies one into the other). */
export function readPullCursor(): { since: string } | null {
  try {
    const v = JSON.parse(readFileSync(pullCursorPath(), "utf8")) as { since?: unknown };
    return typeof v?.since === "string" ? { since: v.since } : null;
  } catch { return null; }
}
export function writePullCursor(since: string, now = Date.now()): void {
  invariant(since === "" || !Number.isNaN(Date.parse(since)), "the pull cursor is empty or a timestamp");
  // Emitter clocks are untrusted: a cursor past the clock would skip every row stamped before it (Tick.ts kept the same rule).
  invariant(since === "" || Date.parse(since) <= now + FUTURE_CAP_MS, "the pull cursor is never ahead of the clock");
  const path = pullCursorPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify({ since }) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/** Ids `MoveCursors.ts` copied out of Vigil's `pulled.jsonl` (until p3); an array or `{ ids }`. */
export function pulledSeed(): Set<string> {
  try {
    const v = JSON.parse(readFileSync(join(statvsStateDir(), "collect", "pulled-seed.json"), "utf8")) as unknown;
    const list = Array.isArray(v) ? v : Array.isArray((v as { ids?: unknown })?.ids) ? (v as { ids: unknown[] }).ids : [];
    return new Set(list.filter((x): x is string => typeof x === "string"));
  } catch { return new Set(); }
}

/** Where views this module reads keep their output: the live views dir for the home record, else the state dir. */
function viewsOutDir(): string | undefined {
  if (process.env.STATVS_VIEWS_DIR) return undefined;
  return isolationReason() !== null ? join(statvsStateDir(), "views") : undefined;
}

/** The pulled row as a validated event, or why it is refused. Identity skips that need no view are here too. */
function pulledEvent(row: StoreRow): VigilEvent | string {
  if (!row || typeof row !== "object") return "not a row";
  if (typeof row.id !== "string" || row.id.length === 0) return "row has no id";
  if (RECORD_ID.test(row.id)) return "a record row this Mac forwarded";
  if (row.source === "vigil" || row.emitter === "vigil-store") return "Vigil's own row";
  if (row.privacy_class === "customer") return "customer";
  if (typeof row.emitter !== "string" || !EMITTER.test(row.emitter)) return "emitter name is not plain";
  let meta: VigilEvent["meta"] | undefined;
  if (typeof row.meta === "string") {
    try { meta = JSON.parse(row.meta) as VigilEvent["meta"]; } catch { return "meta is not JSON"; }
  } else if (row.meta !== null && row.meta !== undefined) meta = row.meta;
  const { emitter: _emitter, meta: _meta, ...rest } = row;
  const event = { ...rest, ref: rest.ref ?? null, url: rest.url ?? null, ...(meta !== undefined && meta !== null ? { meta } : {}) } as VigilEvent;
  try { validateEvent(event); } catch (e) { return (e as Error).message; }
  return event;
}

/**
 * Write one cloud row to stream `cloud` (§2.2): writer `app:<emitter>`, class personal, the D1 id
 * as `data.cloud_id` and `data.event_id`. Refuses, fail-closed, a customer row, a row shaped like
 * one of this record's own, Vigil's own rows, and anything `validateEvent` refuses. It does not
 * de-duplicate: the pull checks view `cloud-ids` first, and Vigil's legacy tick checks `pulled.jsonl`.
 */
export function writePulled(row: StoreRow): AppendResult {
  const event = pulledEvent(row);
  if (typeof event === "string") return { ok: false, refused: event === "customer" ? "customer rows are refused on pull" : event };
  invariant(event.id === row.id && event.privacy_class !== "customer" && EMITTER.test(row.emitter), "a pulled row keeps its D1 id and is never a customer row");
  const data: Record<string, unknown> = {
    source: event.source,
    summary: event.summary,
    cloud_class: event.privacy_class,
    dedup_key: event.dedup_key,
    cloud_id: event.id,
    emitter: row.emitter,
    event_id: event.id,
  };
  if (event.url !== null) data.url = event.url;
  if (event.meta !== undefined) data.meta = event.meta;
  const input: StatvsInput = {
    writer: `app:${row.emitter}`, stream: "cloud", class: "personal",
    kind: event.kind, severity: event.severity, title: event.title, ts: event.ts, data,
  };
  if (typeof event.ref === "string") input.ref = event.ref;
  const session = event.meta?.session;
  if (typeof session === "string" && session.length > 0) input.session = session;
  return append(input);
}

export interface PullOptions { fetchImpl?: typeof fetch; credentials?: Credentials | null; now?: number }
export interface PullResult {
  skipped?: true;
  baselined?: true;
  error?: string;
  read: number;
  pulled: number;
  spooled: number;
  /** Rows refused: customer rows, and rows validation or the record refused. Each has a `pull-refused` row. */
  refused: number;
  /** Rows skipped by identity: already pulled, forwarded from here, written here, Vigil's own, future-dated. */
  skipped_rows: { self: number; local: number; seen: number; vigil: number; future: number };
  more?: true;
  since: string;
  problems?: string[];
}

/** One page of cloud rows into stream `cloud`. See the module header. */
export async function pull(opts: PullOptions = {}): Promise<PullResult> {
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const skipped_rows = { self: 0, local: 0, seen: 0, vigil: 0, future: 0 };
  const creds = opts.credentials === undefined ? statvsCredentials() : opts.credentials;
  const prior = readPullCursor();
  if (!creds) return { skipped: true, read: 0, pulled: 0, spooled: 0, refused: 0, skipped_rows, since: prior?.since ?? "" };
  const problems: string[] = [];
  const fail = (error: string): PullResult => {
    const p = collectRow("statvs:pull", "pull", "Cloud pull", { ok: false, error: safeText(error) });
    return { error, read: 0, pulled: 0, spooled: 0, refused: 0, skipped_rows, since: prior?.since ?? "", ...(p ? { problems: [p] } : {}) };
  };

  // Up to PULL_PAGES pages per pull. A full page continues from its last row by (ts, id) when the Worker answers
  // `last_id`, so an overlap holding more than a page of rows is read through instead of re-read forever.
  const rows: StoreRow[] = [];
  let lastNext = "", lastLen = 0;
  try {
    // With no cursor the request is only a probe that the bearer may read: `since` is now, so the cloud's history is never paged in.
    const since = prior?.since ? new Date(Math.max(0, Date.parse(prior.since) - PULL_OVERLAP_MS)).toISOString() : new Date(now).toISOString();
    const limit = prior ? PULL_LIMIT : 1;
    let after: StoreRow | null = null;
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ since: after ? after.ts : since, limit: String(limit), ...(prior?.since ? { cursor: prior.since } : {}), ...(after ? { after: after.id } : {}) });
      const res = await request(creds, `/events?${query}`, { method: "GET" }, fetchImpl);
      if (!res.ok) return fail(`cloud answered ${res.status}`);
      const body = (await res.json()) as { events?: StoreRow[]; next?: string; last_id?: string };
      if (!Array.isArray(body.events) || typeof body.next !== "string" || !body.events.every((r) => r && typeof r.id === "string" && typeof r.emitter === "string" && typeof r.ts === "string")) {
        return fail("cloud returned invalid events or cursor");
      }
      rows.push(...body.events);
      lastNext = body.next;
      lastLen = body.events.length;
      if (!prior || lastLen < limit || typeof body.last_id !== "string" || page >= PULL_PAGES) break;
      after = body.events.at(-1)!;
    }
  } catch (e) {
    return fail(`cloud unreachable: ${(e as Error)?.message ?? String(e)}`);
  }
  const body = { events: rows, next: lastNext };
  const nowIso = new Date(now).toISOString();
  const settled = body.events.filter((r) => r.ts <= nowIso).reduce((max, r) => (r.ts > max ? r.ts : max), "");

  if (!prior) {
    // First run: start at the cloud's present, never at its start. The probe above read only rows stamped after now,
    // so nothing older is fetched or written; the next pull reads from now less the overlap.
    const since = nowIso;
    writePullCursor(since, now);
    const p = collectRow("statvs:pull", "pull", "Cloud pull", { ok: true, baselined: true });
    return { baselined: true, read: 0, pulled: 0, spooled: 0, refused: 0, skipped_rows, since, ...(p ? { problems: [p] } : {}) };
  }

  const outDir = viewsOutDir();
  const local = eventKeySets(readViewDef(eventKeysView, { outDir }).state);
  const seen = cloudIdSet(readViewDef(cloudIdsView, { outDir }).state);
  for (const id of pulledSeed()) seen.add(id);
  const fromDate = new Date(now - 2 * DAY_MS).toISOString().slice(0, 10);
  const refusedBefore = new Set(scan({ streams: ["collect"], classes: ["system"], fromDate }).rows
    .filter((r) => r.kind === "pull-refused").map((r) => (r.data as { cloud_id?: unknown } | null)?.cloud_id).filter((x): x is string => typeof x === "string"));
  const cap = new Date(now + FUTURE_CAP_MS).toISOString();

  let pulled = 0, spooled = 0, refused = 0;
  const refuse = (row: StoreRow, reason: string) => {
    if (refusedBefore.has(row.id)) return; // re-read in the overlap: already reported
    refusedBefore.add(row.id);
    const p = collectRow("statvs:pull", "pull-refused", "Pull refused", { cloud_id: safeText(row.id, 128), emitter: safeText(row.emitter, 64), reason });
    if (p) problems.push(p);
    refused++;
  };
  for (const row of body.events) {
    if (row.ts > cap) { skipped_rows.future++; continue; }
    if (row.source === "vigil" || row.emitter === "vigil-store") { skipped_rows.vigil++; continue; }
    if (RECORD_ID.test(row.id)) { skipped_rows.self++; continue; }
    if (local.ids.has(row.id) || (typeof row.dedup_key === "string" && local.keys.has(row.dedup_key))) { skipped_rows.local++; continue; }
    if (seen.has(row.id)) { skipped_rows.seen++; continue; }
    // Customer rows fail closed whatever the bearer's ceiling says (P6); the cursor moves past them.
    if (row.privacy_class === "customer") { refuse(row, "customer"); continue; }
    let r: AppendResult;
    try { r = writePulled(row); } catch (e) {
      if (e instanceof InvariantViolation) throw e;
      r = { ok: false, refused: (e as Error).message };
    }
    if (r.ok) { pulled++; seen.add(row.id); }
    else if ("spooled" in r) { spooled++; seen.add(row.id); }
    else refuse(row, "refused by validation or the record");
  }
  // Emitter timestamps are untrusted: the cursor moves only to the newest row stamped at or before now.
  const candidate = body.next <= nowIso ? body.next : settled;
  // Never backwards: an empty page answers the overlap-adjusted since, and a re-read page an earlier row's ts.
  const forward = candidate > prior.since ? candidate : prior.since;
  // A cursor past the future cap means the clock stepped back; it cannot be kept, so it restarts at now.
  const next = forward <= cap ? forward : nowIso;
  invariant(next >= prior.since || prior.since > cap, "the pull cursor moves backwards only when the clock stepped back past it");
  writePullCursor(next, now);
  const more = lastLen >= PULL_LIMIT;
  const p = collectRow("statvs:pull", "pull", "Cloud pull", { ok: true, read: body.events.length, pulled, spooled, refused, skipped: skipped_rows, ...(more ? { more: true } : {}) });
  if (p) problems.push(p);
  return { read: body.events.length, pulled, spooled, refused, skipped_rows, since: next, ...(more ? { more: true as const } : {}), ...(problems.length ? { problems } : {}) };
}

// ── Status ──

export interface CloudStatus {
  host: string | null;
  credentials: boolean;
  isolated: string | null;
  last_forward: { ts: string; data: unknown } | null;
  last_pull: { ts: string; data: unknown } | null;
  /** Severity rows the forwarder has not sent, or null before its first run. */
  backlog: number | null;
  pending_deletes: number;
  /** The live config's D1 id equals the id in VIGIL/worker.json at `migrated_from.source_commit` (P9). */
  d1_id_unchanged: boolean;
  d1_check: string;
  source_commit: string | null;
}

export function workerConfigPath(): string {
  return process.env.STATVS_WORKER_CONFIG ? resolve(process.env.STATVS_WORKER_CONFIG) : lifeosPath("USER", "STATVS", "worker.json");
}

const COMMIT = /^[0-9a-f]{7,40}$/;

/**
 * Is the D1 id unchanged? Compares the live config's `d1.id` with the id in
 * `git -C <USER repo> show <migrated_from.source_commit>:VIGIL/worker.json`, the file as it was
 * before the migration touched anything, so a wrong id copied into both fields still fails.
 */
export function d1IdCheck(opts: { configPath?: string; userRepo?: string } = {}): { unchanged: boolean; reason: string; source_commit: string | null } {
  let cfg: { d1?: { id?: unknown }; migrated_from?: { d1_id?: unknown; source_commit?: unknown } };
  try { cfg = JSON.parse(readFileSync(opts.configPath ?? workerConfigPath(), "utf8")); } catch { return { unchanged: false, reason: "no readable USER/STATVS/worker.json", source_commit: null }; }
  const live = cfg?.d1?.id, commitId = cfg?.migrated_from?.source_commit, claimed = cfg?.migrated_from?.d1_id;
  if (typeof live !== "string" || live.length === 0) return { unchanged: false, reason: "config has no d1.id", source_commit: null };
  if (typeof commitId !== "string" || !COMMIT.test(commitId)) return { unchanged: false, reason: "config has no migrated_from.source_commit", source_commit: null };
  let before: { d1?: { id?: unknown } };
  try {
    const repo = opts.userRepo ?? realish(lifeosPath("USER"));
    const text = execFileSync("git", ["-C", repo, "show", `${commitId}:VIGIL/worker.json`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
    before = JSON.parse(text);
  } catch { return { unchanged: false, reason: `VIGIL/worker.json is not readable at ${commitId}`, source_commit: commitId }; }
  const original = before?.d1?.id;
  if (typeof original !== "string" || original.length === 0) return { unchanged: false, reason: `VIGIL/worker.json at ${commitId} has no d1.id`, source_commit: commitId };
  if (live !== original) return { unchanged: false, reason: "d1.id differs from the pre-migration config", source_commit: commitId };
  if (claimed !== undefined && claimed !== original) return { unchanged: false, reason: "migrated_from.d1_id differs from the pre-migration config", source_commit: commitId };
  return { unchanged: true, reason: "d1.id equals the pre-migration config", source_commit: commitId };
}

/** Host, last forward and pull, backlog, pending deletes and the D1 id check. Reads only. */
export function cloudStatus(opts: { configPath?: string; userRepo?: string; now?: number } = {}): CloudStatus {
  const now = opts.now ?? Date.now();
  const creds = statvsCredentials();
  const fromDate = new Date(now - 7 * DAY_MS).toISOString().slice(0, 10);
  const rows = existsSync(statvsDir()) ? scan({ streams: ["collect"], classes: ["system"], fromDate }).rows : [];
  const last = (kind: string) => {
    const r = rows.filter((x) => x.kind === kind).at(-1);
    return r ? { ts: r.ts, data: r.data } : null;
  };
  const backlog = loadPos(FORWARD_CONSUMER) ? readSince(FORWARD_CONSUMER, readOpts(now)).rows.length : null;
  const d1 = d1IdCheck(opts);
  return {
    host: creds ? hostOf(creds.url) : null,
    credentials: creds !== null,
    isolated: isolationReason(),
    last_forward: last("forward"),
    last_pull: last("pull"),
    backlog,
    pending_deletes: pendingDeletes(now).length,
    d1_id_unchanged: d1.unchanged,
    d1_check: d1.reason,
    source_commit: d1.source_commit,
  };
}

// ── CLI (Statvs.ts dispatches forward | pull | cloud here) ──

interface Args { positional: string[]; flags: Record<string, string | true> }

export async function cli(command: string, args: Args): Promise<number> {
  const json = args.flags.json === true;
  if (command === "forward") {
    const r = await forward();
    console.log(json ? JSON.stringify(r) : r.skipped ? `Cloud forward skipped: no credentials (${r.remaining} rows waiting)` : `Cloud forward: ${r.sent} sent, ${r.refused} refused, ${r.remaining} remaining${r.stopped ? `; stopped: ${r.stopped}` : ""}`);
    return r.stopped ? 1 : 0;
  }
  if (command === "pull") {
    const r = await pull();
    console.log(json ? JSON.stringify(r) : r.skipped ? "Cloud pull skipped: no credentials" : r.error ? `Cloud pull failed: ${r.error}` : `Cloud pull: ${r.pulled} pulled, ${r.refused} refused, ${r.read} read${r.baselined ? " (baselined)" : ""}`);
    return r.error ? 1 : 0;
  }
  if (command === "cloud") {
    const sub = args.positional[0] ?? "status";
    if (sub === "status") {
      const s = cloudStatus();
      console.log(json ? JSON.stringify(s) : [
        `Cloud tier: ${s.host ?? "no credentials"}${s.isolated ? ` (isolated: ${s.isolated})` : ""}`,
        `  Last forward ${s.last_forward?.ts ?? "never"}, last pull ${s.last_pull?.ts ?? "never"}`,
        `  Backlog ${s.backlog ?? "not started"}, pending deletes ${s.pending_deletes}`,
        `  D1 id unchanged: ${s.d1_id_unchanged} (${s.d1_check})`,
      ].join("\n"));
      return 0;
    }
    console.error("usage: Statvs.ts cloud status [--json]");
    return 2;
  }
  console.error(`lib/cloud.ts has no command ${command}`);
  return 2;
}

