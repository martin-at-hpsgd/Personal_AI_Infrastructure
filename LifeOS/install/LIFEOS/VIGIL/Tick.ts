#!/usr/bin/env bun
/** Vigil five-minute collect, forward, and route loop. @version 0.9.0 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"; import { dirname, join } from "node:path"; import { createHash, randomUUID } from "node:crypto";
import { invariant } from "../TOOLS/Invariant"; import { isOwnLine } from "../TOOLS/lib/SendGate"; import { emit, envKeys, forward, vigilCredentials } from "./Emit"; import { loadPolicy, type VigilPolicy } from "./Policy"; import { BUDGET_REASON, SOURCE_CAP_REASON, WATCH_CAP_REASON, budgetUsedAt, sentBySource, sourceTextCap, fixedJob, isJobEvent, jobRoute, route, shadowRoute, storyKeyOf, type Decision, type SentStory, type ShadowDecision, type TextBudget } from "./Route"; import { inQuietHours } from "../TOOLS/QuietHours"; import { ceiling } from "../TOOLS/Interruptions"; import { getClaudeDir, lifeosPath } from "../TOOLS/Paths"; import type { StateInput, VigilEvent } from "./Schema"; import { appendJson, readJson, statePath, writeJson } from "./State";
import { ADAPTER_READERS, REGISTERED_ADAPTERS } from "./adapters";
import { hasLiveness, loadLiveness, type LivenessHook } from "./Liveness";
import { abandoned } from "./adapters/common";
import { textCard } from "../TOOLS/TextFormat";
import { applyWatchlist, loadWatchlist, recordMatches } from "./WorldWatch";
type DualWrite = { decision: typeof import("./Decision"); cloud: typeof import("../STATVS/lib/cloud") };
/**
 * STATVS migration p1 (design §3 Lane D): the record-side writes, loaded only while USER/STATVS/cutover.json says
 * dual_write. They are best-effort and never touch legacy routing or sending: an engine copy without LIFEOS/STATVS
 * beside it, or a STATVS module that fails to load, simply does not dual-write.
 */
export function loadDualWrite(): DualWrite | null {
  try {
    const cutover = require("../STATVS/lib/cutover") as typeof import("../STATVS/lib/cutover");
    if (!cutover.dualWrite()) return null;
    return { decision: require("./Decision") as DualWrite["decision"], cloud: require("../STATVS/lib/cloud") as DualWrite["cloud"] };
  } catch (error) { if (!/Cannot find module/.test(String(error instanceof Error ? error.message : error))) console.error(`Vigil dual-write unavailable: ${error instanceof Error ? error.message : String(error)}`); return null; }
}
/** Send-time liveness: a source may withdraw a queued text whose intent has gone. The hooks are mapped by source in Liveness.ts, not loaded from the adapter tree. A hook that throws fails open: the text still sends, and the tick carries on for every other source. */
export async function holdSuperseded(d: Decision, load: (source: string) => Promise<LivenessHook> = loadLiveness): Promise<void> {
  if (d.action !== "text" || !hasLiveness(d.event.source)) return;
  try {
    const adapter = await load(d.event.source);
    if (adapter.stillLive?.(d.event) === false) { d.action = "held"; d.reason = "superseded at send time"; }
  } catch (error) { console.error(`Vigil liveness hook for ${d.event.source} threw; sending anyway: ${message(error)}`); }
}
import { edit, editJobs, EDITABLE_JOB_CLASSES, type Infer, type Outcome, type SentText } from "./Editor";
type Cursor = { ts: string; ids_at_ts: string[] };
export type GhRunner = (argv: string[]) => Promise<{ code: number; out: string; err: string }>;
export const ghRunner: GhRunner = async (argv) => { const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", timeout: 60_000 }); const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); return { code, out, err }; };
export async function fileWorkRepo(event: VigilEvent, repo: string, run: GhRunner): Promise<string | null> {
  const marker = `vigil:${event.dedup_key}`;
  const search = await run(["gh", "issue", "list", "--repo", repo, "--search", `"${marker}" in:body`, "--state", "all", "--json", "number", "--limit", "1"]);
  if (search.code !== 0) throw new Error(`workrepo search failed: ${search.err.slice(0, 200)}`);
  const found = JSON.parse(search.out) as Array<{ number: number }>;
  if (!Array.isArray(found)) throw new Error("workrepo search returned invalid JSON");
  if (found.length) return null;
  const labels = [event.severity === "medium" ? "Priority:P2" : "Priority:P1", "Property:internal", "Status:ready"].join(",");
  const body = [event.summary, event.url ?? "", `Source: ${event.source}`, marker].filter(Boolean).join("\n\n");
  invariant(repo.includes("/") && event.title.length > 0 && body.includes(marker), "workrepo issue has repo, title and marker");
  const created = await run(["gh", "issue", "create", "--repo", repo, "--title", event.title, "--body", body, "--label", labels]);
  if (created.code !== 0) throw new Error(`workrepo create failed: ${created.err.slice(0, 200)}`);
  const issueUrl = created.out.trim();
  if (!issueUrl) throw new Error("workrepo create returned no issue URL");
  return issueUrl;
}
async function workRepo(): Promise<string> { const base = getClaudeDir(); const { loadWorkConfig } = await import(join(base, "hooks/lib/work-config.ts")); const repo = loadWorkConfig().repo; if (!repo) throw new Error("work repo unavailable"); return repo; }
function outbox(): VigilEvent[] { return existsSync(statePath("outbox.jsonl")) ? readFileSync(statePath("outbox.jsonl"), "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x)) : []; }
/** ISC-118: a held or digest-routed event whose `meta.valid_until` has passed is dropped, never queued: the 08:00 brief must not report something that has already come and gone. Job texts carry no valid_until and are never touched. */
export function expiredAt(event: VigilEvent, now: Date): boolean { const until = Date.parse(String(event.meta?.valid_until ?? "")); return Number.isFinite(until) && until <= now.getTime(); }
const droppable = (d: Decision, now: Date): boolean => !d.job && (d.action === "held" || d.action === "digest") && expiredAt(d.event, now);
export function dropExpired(decisions: Decision[], now: Date): Decision[] { const dropped = decisions.filter((d) => droppable(d, now)); for (const d of dropped) { d.action = "pulse"; d.reason = `expired: valid_until ${String(d.event.meta?.valid_until)} has passed`; } return dropped; }
/** ISC-143: outbox entries older than this move to a dated archive file. */
export const OUTBOX_RETENTION_DAYS = 14;
/**
 * ISC-143/144: move outbox entries stamped more than 14 days before `now` into `archive/outbox-<YYYY-MM-DD>.jsonl` (the date of this rotation).
 * Only entries the reader cursor has already passed move, so a rotation never hides an unrouted event, and the cursor itself is untouched, so the next
 * tick routes nothing a second time. Lines that do not parse stay put. The outbox is rewritten by rename; if it grew while we worked, nothing moves this tick.
 */
export function rotateOutbox(tickNow: Date): { archived: number; kept: number } {
  // A tick run on a clock ahead of the real one (replays, tests) must not age out entries stamped by the real clock.
  const now = new Date(Math.min(tickNow.getTime(), Date.now())), path = statePath("outbox.jsonl"), cursorPath = statePath("reader.json");
  if (!existsSync(path) || !existsSync(cursorPath)) return { archived: 0, kept: 0 };
  const cursor = readJson<Cursor>(cursorPath, { ts: "", ids_at_ts: [] }), cutoff = new Date(now.getTime() - OUTBOX_RETENTION_DAYS * 86_400_000).toISOString();
  const raw = readFileSync(path, "utf8"), lines = raw.split("\n").filter(Boolean), old: string[] = [], keep: string[] = [];
  for (const line of lines) { let e: VigilEvent | null = null; try { e = JSON.parse(line) as VigilEvent; } catch {} if (e && typeof e.ts === "string" && e.ts < cutoff && !afterCursor(e, cursor)) old.push(line); else keep.push(line); }
  if (!old.length) return { archived: 0, kept: keep.length };
  invariant(old.length + keep.length === lines.length, "every outbox line is archived or kept");
  const tmp = `${path}.rotate.${process.pid}`, archive = statePath("archive", `outbox-${now.toISOString().slice(0, 10)}.jsonl`);
  mkdirSync(dirname(archive), { recursive: true });
  try {
    writeFileSync(tmp, keep.length ? keep.join("\n") + "\n" : "");
    if (readFileSync(path, "utf8") !== raw) { rmSync(tmp, { force: true }); return { archived: 0, kept: lines.length }; }
    appendFileSync(archive, old.join("\n") + "\n"); renameSync(tmp, path);
  } catch (error) { rmSync(tmp, { force: true }); throw error; }
  return { archived: old.length, kept: keep.length };
}
const RELAY_CONFIG = lifeosPath("USER", "RELAY", "state", "bridge-config.json"); // the same file isOwnLine reads by default (honours CLAUDE_CONFIG_DIR)
/** The principal's own number from the bridge config's `ownChannels.numbers` (the way the send gate reads it), only when `isOwnLine` accepts it. `allowFrom` is who may text in, never the principal. */
export function relayLine(configPath: string = RELAY_CONFIG): string | null {
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as { ownChannels?: { numbers?: unknown } };
    const numbers = Array.isArray(cfg.ownChannels?.numbers) ? cfg.ownChannels!.numbers.map(String) : [];
    return numbers.find((n) => isOwnLine(n, { numbers })) ?? null;
  } catch { return null; }
}
type TextSpawn = (argv: string[]) => Promise<{ code: number; err: string }>;
const spawnSend: TextSpawn = async (argv) => { const p = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" }); const err = await new Response(p.stderr).text(); return { code: await p.exited, err }; };
export async function sendText(text: string, deps: { configPath?: string; spawn?: TextSpawn } = {}): Promise<boolean> {
  if (process.env.VIGIL_SEND === "off") { console.log("VIGIL_SEND=off: text not sent"); return true; }
  const line = relayLine(deps.configPath);
  if (!line) return false;
  const { code, err } = await (deps.spawn ?? spawnSend)([process.execPath, lifeosPath("RELAY", "bridge", "send.ts"), line, text, "--origin", "vigil"]);
  if (code !== 0) console.error(`Vigil text send failed (exit ${code}): ${err.trim().slice(0, 300)}`);
  return code === 0;
}
async function sendSlackDm(text: string, policy: VigilPolicy, fetchImpl: typeof fetch = fetch): Promise<boolean | null> {
  if (!policy.dm_mirror_user_id) return null;
  const tokenEnv = policy.dm_mirror_token_env ?? "VIGIL_SLACK_BOT_TOKEN";
  const token = envKeys([tokenEnv])[tokenEnv];
  if (!token) return null;
  if (process.env.VIGIL_SEND === "off") return true;
  try {
    const response = await fetchImpl("https://slack.com/api/chat.postMessage", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ channel: policy.dm_mirror_user_id, text }) });
    return response.ok && (await response.json() as { ok?: boolean }).ok === true;
  } catch { return false; }
}
function cursorFor(events: VigilEvent[]): Cursor { const ts = events.reduce((max, e) => e.ts > max ? e.ts : max, ""); return { ts, ids_at_ts: events.filter((e) => e.ts === ts).map((e) => e.id) }; }
function afterCursor(event: VigilEvent, cursor: Cursor): boolean { return event.ts > cursor.ts || event.ts === cursor.ts && !cursor.ids_at_ts.includes(event.id); }
function input(path: string, now: Date): StateInput { try { return { read: true, age_minutes: Math.max(0, Math.round((now.getTime() - statSync(path).mtimeMs) / 60_000)) }; } catch { return { read: false, age_minutes: null }; } }
export function stateInputs(now: Date = new Date()): Record<string, StateInput> { return { mood: input(lifeosPath("USER", "STATE", "current.json"), now), health: input(lifeosPath("USER", "TELOS", "CURRENT_STATE", "HEALTH.md"), now), calendar: { read: false, age_minutes: null }, work: input(lifeosPath("MEMORY", "STATE", "work.json"), now) }; }
/** One adapter's read on one tick (ISC-65). `error` is present only when the read failed. */
export type Ping = { name: string; ok: boolean; error?: string; not_installed?: true; events: number; ms: number };
/** One line of ticks.jsonl. Lines written before ISC-65 carry only `ts`; readers treat the rest as unrecorded. */
export type TickRecord = { ts: string; duration_ms: number; collected: number; routed: number; pings: Ping[]; baseline?: true; dry_run?: true; error?: string };
const TICK_RETENTION_MS = 7 * 86_400_000, PING_ERROR_MAX = 300;
function recordRun(record: TickRecord): void {
  invariant(Number.isFinite(Date.parse(record.ts)) && record.duration_ms >= 0 && record.collected >= 0 && record.routed >= 0, "tick record carries a real ts and non-negative counts");
  invariant(record.pings.every((ping) => ping.name && ping.events >= 0 && ping.ms >= 0 && (ping.ok || typeof ping.error === "string")), "every failed ping names its error");
  const path = statePath("ticks.jsonl"), cutoff = Date.parse(record.ts) - TICK_RETENTION_MS;
  const prior = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => { try { const row = JSON.parse(line) as { ts?: string }; return row.ts && Date.parse(row.ts) >= cutoff ? [row] : []; } catch { return []; } }) : [];
  mkdirSync(statePath(), { recursive: true }); writeFileSync(path, [...prior, record].map((row) => JSON.stringify(row)).join("\n") + "\n");
}
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).trim().slice(0, PING_ERROR_MAX);
/**
 * A read that failed inside withCursor resolves with [] and records the failure in its cursor
 * outcome file instead of throwing. An adapter owns `<name>.read.json` plus any `<name>_<part>.read.json`
 * (services reads services and services_exit), so a failure written there during this read counts.
 */
function cursorFailure(name: string, since: number): { error: string; not_installed?: true } | null {
  let files: string[]; try { files = readdirSync(statePath("cursors")); } catch { return null; }
  for (const file of files.filter((f) => f === `${name}.read.json` || f.startsWith(`${name}_`) && f.endsWith(".read.json"))) {
    const outcome = readJson<{ ok?: boolean; ts?: string; error?: string; not_installed?: string }>(statePath("cursors", file), {});
    if (outcome.ok === false && typeof outcome.ts === "string" && Date.parse(outcome.ts) >= since) return { error: (outcome.not_installed ? `not installed: ${outcome.not_installed}` : outcome.error ?? `${file} read failed`).trim().slice(0, PING_ERROR_MAX), ...(outcome.not_installed ? { not_installed: true as const } : {}) };
  }
  return null;
}
/** A read with no deadline can hold the tick for as long as it hangs, and launchd never starts a second one while it runs. */
export const READ_DEADLINE_MS = 60_000;
/** Time one adapter's read. A throwing reader, or one still running at its deadline, is a failed ping, never a failed tick. */
export async function ping(adapter: { name: string; read: () => Promise<VigilEvent[]> }, deadlineMs = READ_DEADLINE_MS): Promise<{ ping: Ping; events: VigilEvent[] }> {
  const wall = Date.now() - 1, started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), deadlineMs); });
  try {
    const outcome = await Promise.race([adapter.read(), late]);
    if (outcome === "late") { abandoned.add(adapter.name); return { ping: { name: adapter.name, ok: false, error: `read still running after ${Math.round(deadlineMs / 1000)}s; abandoned`, events: 0, ms: Math.round(performance.now() - started) }, events: [] }; }
    const events = outcome, ms = Math.round(performance.now() - started), failure = cursorFailure(adapter.name, wall);
    return { ping: failure === null ? { name: adapter.name, ok: true, events: events.length, ms } : { name: adapter.name, ok: false, ...failure, events: events.length, ms }, events };
  } catch (error) {
    return { ping: { name: adapter.name, ok: false, error: message(error), events: 0, ms: Math.round(performance.now() - started) }, events: [] };
  } finally { clearTimeout(timer); }
}
type StoreStats = { rows_1h?: number; rows_24h?: number; oldest_ts?: string | null; newest_ts?: string | null; emitters?: number; by_source_24h?: Record<string, number>; db_size_bytes?: number | null; query_ms?: number | null; served_at?: string };
async function probeStore(now: Date, fetchImpl: typeof fetch = fetch): Promise<void> {
  const credentials = vigilCredentials(); if (!credentials) return;
  const started = performance.now(); let reachable = false, rows: number | null = null, stats: StoreStats | null = null;
  try {
    const res = await fetchImpl(`${credentials.url.replace(/\/$/, "")}/stats`, { headers: { Authorization: `Bearer ${credentials.token}` } });
    if (!res.ok) throw new Error(`store probe failed (${res.status})`);
    const body = await res.json() as StoreStats & { rows?: number };
    if (typeof body.rows !== "number" || !Number.isFinite(body.rows)) throw new Error("store probe returned invalid rows");
    reachable = true; rows = body.rows;
    const { rows: _rows, ...extra } = body;
    stats = Object.keys(extra).length ? extra : null;
  } catch {}
  const latency_ms = Math.round(performance.now() - started);
  invariant(Number.isFinite(Date.parse(now.toISOString())) && latency_ms >= 0 && (rows === null || Number.isFinite(rows)), "store probe state is valid");
  writeJson(statePath("cursors", "store.json"), { checked_at: now.toISOString(), reachable, rows, latency_ms, stats });
  const path = statePath("store-probes.jsonl"), prior = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-287) : [];
  writeFileSync(path, [...prior, JSON.stringify({ ts: now.toISOString(), ok: reachable, latency_ms, query_ms: stats?.query_ms ?? null, rows })].join("\n") + "\n");
}
/** A cloud row can be stamped before an earlier-stamped row commits, so each pull re-reads this window; pulled.jsonl de-duplicates (ISC-125). */
const STORE_OVERLAP_MS = 2 * 60_000, PULLED_KEEP = 5_000;
type StoreRow = VigilEvent & { emitter: string; meta?: VigilEvent["meta"] | string | null };
async function pullStore(local: VigilEvent[], fetchImpl: typeof fetch = fetch, now: Date = new Date()): Promise<{ events: VigilEvent[]; rows: StoreRow[]; next: string } | null> {
  const credentials = vigilCredentials(); if (!credentials) return null;
  const path = statePath("store-reader.json"), prior = readJson<{ since: string }>(path, { since: "" });
  try {
    const url = new URL(`${credentials.url.replace(/\/$/, "")}/events`); url.searchParams.set("since", prior.since ? new Date(Math.max(0, Date.parse(prior.since) - STORE_OVERLAP_MS)).toISOString() : prior.since); url.searchParams.set("limit", "1000");
    const response = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${credentials.token}` } });
    if (!response.ok) throw new Error(`store pull failed (${response.status})`);
    const body = await response.json() as { events?: StoreRow[]; next?: string };
    if (!Array.isArray(body.events) || typeof body.next !== "string" || !body.events.every((row) => row && typeof row.id === "string" && typeof row.emitter === "string")) throw new Error("store pull returned invalid events or cursor");
    const nowIso = now.toISOString(), settled = body.events.filter((row) => row.ts <= nowIso).reduce((max, row) => (row.ts > max ? row.ts : max), "");
    if (!existsSync(path)) { const since = body.next <= nowIso ? body.next : settled || nowIso; invariant(since <= nowIso, "store baseline cursor is not in the future"); writeJson(path, { since }); return null; }
    const cap = new Date(now.getTime() + 5 * 60_000).toISOString();
    const futureRows = body.events.filter((row) => row.ts > cap);
    if (futureRows.length > 0) console.log(`Vigil store pull skipped ${futureRows.length} future-dated rows`);
    const localIds = new Set(local.map((event) => event.id));
    const pulledIds = new Set(existsSync(statePath("pulled.jsonl")) ? readFileSync(statePath("pulled.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as VigilEvent).id) : []);
    const rows = body.events.filter((row) => row.ts <= cap && !localIds.has(row.id) && !pulledIds.has(row.id) && row.source !== "vigil"), events = rows.map(({ emitter, ...row }) => ({ ...row, ...(typeof row.meta === "string" ? { meta: JSON.parse(row.meta) as VigilEvent["meta"] } : row.meta === null ? { meta: undefined } : {}) } as VigilEvent));
    // Emitter timestamps are untrusted. The cursor moves only to the newest row stamped at or before now: a future-dated row
    // (the store holds one) would otherwise pin it ahead of the clock and every row posted just before a tick would fall behind it.
    // Rows re-read because the cursor stayed put are skipped by pulled.jsonl.
    return { events, rows, next: body.next <= nowIso ? body.next : settled > prior.since ? settled : prior.since };
  } catch (error) { console.error(`Vigil store pull failed: ${message(error)}`); return null; }
}
/** Dual-write p1 (S4): each newly pulled row also goes to STATVS stream `cloud` through Lane B's writePulled, best-effort, at the same commit point as pulled.jsonl so a crashed tick never records a row twice. */
export function recordPulled(rows: StoreRow[], dual: DualWrite | null): void {
  if (!dual) return;
  let failed = 0;
  for (const row of rows) { try { const r = dual.cloud.writePulled(row as Parameters<DualWrite["cloud"]["writePulled"]>[0]); if (!r.ok && "refused" in r) failed++; } catch (error) { failed++; console.error(`Vigil dual-write pull copy failed for ${row.id}: ${message(error)}`); } }
  if (failed) console.error(`Vigil dual-write: ${failed} of ${rows.length} pulled rows not recorded`);
}
/** pulled.jsonl only has to remember rows the overlap window can return again; keep it bounded. */
function trimPulled(): void { const path = statePath("pulled.jsonl"); if (!existsSync(path)) return; const lines = readFileSync(path, "utf8").split("\n").filter(Boolean); if (lines.length > PULLED_KEEP) writeFileSync(path, lines.slice(-PULLED_KEEP).join("\n") + "\n"); }
/** F12 shadow (ISC-143): a job text reported to Vigil, or Vigil's would-decision about one. Neither is ever texted, digested, DMed or counted as sent. */
export const isShadow = (e: VigilEvent): boolean => e.meta?.shadow === true;
/** Stories Vigil would have texted, read back from its shadow-send rows; ts is the job event's own time. */
export function shadowStories(all: VigilEvent[]): SentStory[] { return all.filter((e) => e.source === "vigil" && e.kind === "notification" && isShadow(e) && e.meta?.decision === "shadow-send" && typeof e.meta?.key === "string").map((e) => ({ key: String(e.meta!.key), ts: typeof e.meta?.event_ts === "string" ? e.meta.event_ts : e.ts, ...(typeof e.meta?.severity === "string" ? { severity: e.meta.severity as SentStory["severity"] } : {}) })); }
/** One notification row per shadow decision, beside what the job actually did (ISC-148: every hold carries its reason). */
export function shadowNote(d: ShadowDecision, now: Date): VigilEvent {
  const note: VigilEvent = { id: randomUUID(), source: "vigil", ts: new Date().toISOString(), kind: "notification", severity: "info", title: d.decision === "shadow-send" ? "Vigil shadow send" : "Vigil shadow hold", summary: `Shadow: Vigil would ${d.decision === "shadow-send" ? "send" : "hold"} (${d.reason}); the job ${String(d.event.meta?.actual ?? "unknown")}.`.slice(0, 1000), ref: d.event.id, url: null, privacy_class: "personal", dedup_key: `vigil:${d.event.id}:${d.decision}`, meta: { decision: d.decision, reason: d.reason, actual: String(d.event.meta?.actual ?? "unknown"), key: d.key, class: String(d.event.meta?.class ?? "ops"), origin: String(d.event.meta?.origin ?? d.event.source), severity: d.event.severity, event_ts: d.event.ts, shadow: true, ...(d.budget_left !== undefined ? { budget_left: d.budget_left, budget_source: d.budget_source } : {}), state_inputs: stateInputs(now) } };
  invariant(note.ref === d.event.id && d.reason.length > 0 && isShadow(d.event), "shadow note points at a shadow event and carries a reason");
  return note;
}
/**
 * F12 ISC-141: every origin's texts from the interruption ledger (send.ts records each Relay send as `relay/<origin>`), with the cap from
 * `interruptions_per_day`. Relay replies to the principal's own texts are never in it: the bridge answers inside the conversation (index.ts,
 * space.send) and only send.ts records, so nothing needs excluding. Null when the ledger cannot be read, and always under NODE_ENV=test unless
 * a test points LIFEOS_INTERRUPTIONS_LEDGER at a fixture, so no test ever depends on the live phone history. Null makes Vigil fall back to its own ceiling.
 */
export function readTextLedger(): Omit<TextBudget, "source"> | null {
  if (process.env.NODE_ENV === "test" && !process.env.LIFEOS_INTERRUPTIONS_LEDGER) return null;
  let body: string; try { body = readFileSync(process.env.LIFEOS_INTERRUPTIONS_LEDGER || lifeosPath("MEMORY", "OBSERVABILITY", "interruptions.jsonl"), "utf8"); } catch { return null; }
  const texts = body.split("\n").filter(Boolean).flatMap((line) => { try { const row = JSON.parse(line) as { ts?: unknown; kind?: unknown; source?: unknown }; return row.kind === "text" && row.source !== "relay/requested" && typeof row.ts === "string" && Number.isFinite(Date.parse(row.ts)) ? [row.ts] : []; } catch { return []; } });
  return { cap: ceiling(), texts };
}
/** The budget in force: the ledger's when readable, else Vigil's own texts against its own `text_ceiling_per_24h` (the fallback, ISC-141). */
export const textBudget = (ledger: Omit<TextBudget, "source"> | null, policy: VigilPolicy, vigilTexts: string[]): TextBudget => ledger ? { ...ledger, source: "ledger" } : { cap: policy.text_ceiling_per_24h, texts: vigilTexts, source: "vigil" };
/** Editor texts already sent, read back from Vigil's own notification events (ISC-117). */
/** Every story Vigil has texted, keyed stably. Older sent records carry no key; their event is looked up by ref. */
export function sentStories(all: VigilEvent[]): SentStory[] {
  const byId = new Map(all.filter((e) => e.source !== "vigil").map((e) => [e.id, e] as const));
  return all.filter((e) => e.source === "vigil" && e.kind === "notification" && e.meta?.decision === "sent" && !isShadow(e)).flatMap((e): SentStory[] => {
    const key = typeof e.meta?.key === "string" ? e.meta.key : (e.ref && byId.has(e.ref) ? storyKeyOf(byId.get(e.ref)!) : null);
    if (!key) return [];
    const severity = (typeof e.meta?.severity === "string" ? e.meta.severity : byId.get(e.ref ?? "")?.severity) as SentStory["severity"];
    const source = typeof e.meta?.source === "string" ? e.meta.source : byId.get(e.ref ?? "")?.source;
    return [{ key, ts: e.ts, ...(severity ? { severity } : {}), ...(source ? { source } : {}) }];
  });
}
export function sentEditorTexts(all: VigilEvent[]): SentText[] { return all.filter((e) => e.source === "vigil" && e.kind === "notification" && e.meta?.editor === true && e.meta?.decision === "sent").map((e) => ({ ts: e.ts, title: String(e.meta?.title ?? ""), why: String(e.meta?.why ?? ""), story: String(e.meta?.story ?? "") })); }
/** An editor text (F13): a 📰 card. The title in bold, why it matters to the principal on the next line, the link alone on the last, within 400 characters. */
export function editorText(event: VigilEvent, why: string): string { return textCard({ kind: "news", title: event.title, body: why, url: event.url, cap: 400 }); }
/** A floor text (F13): a 🚨 (critical) or 🔥 card; the event's title in bold, its summary, the link alone on the last line, within 400 characters. */
export function floorText(event: VigilEvent): string { return textCard({ kind: event.severity === "critical" ? "critical" : "fire", title: event.title, body: event.summary, url: event.url, cap: 400 }); }
/** The Slack DM mirror keeps the plain one-line shapes (ISC-154): Slack renders mrkdwn, not the card's markdown. */
export const slackFloorText = (event: VigilEvent): string => `${event.severity.toUpperCase()}: ${event.title} — ${event.summary}${event.url ? `\n${event.url}` : ""}`;
export function slackEditorText(event: VigilEvent, why: string): string { const tail = event.url ? ` ${event.url}` : ""; const head = `📰 ${event.title} — ${why}`; return (head.length + tail.length <= 400 ? head : head.slice(0, 399 - tail.length).trimEnd() + "…") + tail; }
/** Every job draft, shadow (AgentJob writes these) and enforce (saveDraft), lives only here: local, 0600, keyed by event id. Events carry a hash, never the words. */
export const DRAFTS_FILE = "shadow-drafts.jsonl";
export function saveDraft(event: VigilEvent, text: string): void {
  const row = { ts: event.ts, event_id: event.id, origin: String(event.meta?.origin ?? event.source), sha256: createHash("sha256").update(text).digest("hex"), text };
  invariant(text.trim().length > 0 && isJobEvent(event) && row.sha256.startsWith(String(event.meta?.text_sha256)), "a saved draft is non-empty and matches its job event");
  const path = statePath(DRAFTS_FILE); mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, JSON.stringify(row) + "\n", { mode: 0o600 }); chmodSync(path, 0o600);
}
/** The draft for a job event, only when its hash matches the one the event carries: Vigil sends the sender's words or nothing. */
export function draftLookup(): (event: VigilEvent) => string | undefined {
  const path = statePath(DRAFTS_FILE), texts = new Map<string, string>();
  if (existsSync(path)) for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) { try { const row = JSON.parse(line) as { event_id?: unknown; text?: unknown }; if (typeof row.event_id === "string" && typeof row.text === "string") texts.set(row.event_id, row.text); } catch {} }
  return (event) => { const text = texts.get(event.id); return text !== undefined && createHash("sha256").update(text).digest("hex").startsWith(String(event.meta?.text_sha256)) ? text : undefined; };
}
/** Relay texts Vigil has sent (floor, editor and job alike): the 24h ceiling's count. Shadow rows never count. */
const noticesOf = (all: VigilEvent[]): string[] => all.filter((e) => e.source === "vigil" && e.kind === "notification" && !isShadow(e) && /text sent/.test(e.summary)).map((e) => e.ts);
/** Job events already decided for real (sent, failed or held): neither --now nor the tick decides one twice. */
const jobDecided = (all: VigilEvent[]): Set<string> => new Set(all.filter((e) => e.source === "vigil" && e.kind === "notification" && !isShadow(e) && e.meta?.job === true && e.ref).map((e) => e.ref!));
/** An undecided job text is picked up for this long, whatever the cursor says, so one whose sender died mid-send is retried, not lost (ISC-148). */
const JOB_PENDING_MS = 30 * 60_000, CLAIM_STALE_MS = 10 * 60_000, CLAIM_KEEP_MS = 7 * 86_400_000;
const pendingJobs = (all: VigilEvent[], now: Date): VigilEvent[] => all.filter((e) => isJobEvent(e) && now.getTime() - Date.parse(e.ts) < JOB_PENDING_MS);
/** One sender per job text: an exclusive create, so a --now run and a tick racing on one event send it once. A claim older than ten minutes with no decision row is from a run that died mid-send, and is taken over. */
function claim(id: string, now: Date): boolean {
  const path = statePath("claims", createHash("sha256").update(id).digest("hex").slice(0, 32)); mkdirSync(dirname(path), { recursive: true });
  try { writeFileSync(path, now.toISOString(), { flag: "wx" }); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (now.getTime() - Date.parse(readFileSync(path, "utf8")) < CLAIM_STALE_MS) return false;
  invariant(Number.isFinite(now.getTime()), "a claim takeover is stamped with a real time"); writeFileSync(path, now.toISOString()); return true;
}
function pruneClaims(now: Date): void { const dir = statePath("claims"); let files: string[]; try { files = readdirSync(dir); } catch { return; } for (const f of files) { try { if (now.getTime() - statSync(join(dir, f)).mtimeMs > CLAIM_KEEP_MS) rmSync(join(dir, f)); } catch {} } }
/**
 * Send or hold one F12 job decision and record it. The words sent are the job's own draft (or the editor's checked rewording of it),
 * never an event summary. Job texts are never mirrored to Slack: the draft stays on this machine and the principal's phone. Returns "claimed"
 * when another process already owns the event.
 */
async function sendJob(d: Decision, ctx: { now: Date; textSend?: typeof sendText }): Promise<"sent" | "failed" | "held" | "claimed"> {
  const job = d.job; invariant(job !== undefined && isJobEvent(d.event) && (d.action !== "text" || job.text.trim().length > 0), "a job decision carries its class and, to send, its draft");
  if (!claim(d.event.id, ctx.now)) return "claimed";
  let state: "sent" | "failed" | "held" = "held";
  await holdSuperseded(d);
  if (d.action === "text") { let sent = false; try { sent = await (ctx.textSend ?? sendText)(job.text); } catch (error) { console.error(`Vigil job text send threw: ${message(error)}`); } state = sent ? "sent" : "failed"; }
  else { invariant(d.event.dedup_key.length > 0, "a held job event has a dedup key"); appendJson(statePath("digest.jsonl"), d.event); }
  const row: VigilEvent = { id: randomUUID(), source: "vigil", ts: new Date().toISOString(), kind: "notification", severity: "info", title: `Vigil notification ${state}`, summary: state === "held" ? `Notification held: ${d.reason}`.slice(0, 1000) : state === "sent" ? "Relay text sent." : "Relay text was not sent.", ref: d.event.id, url: null, privacy_class: "personal", dedup_key: `vigil:${d.event.id}:${state}`, meta: { decision: state, reason: d.reason, key: storyKeyOf(d.event), severity: d.event.severity, job: true, class: job.cls, ...(job.reworded ? { reworded: true } : {}), state_inputs: stateInputs(ctx.now) } };
  invariant(row.ref === d.event.id && d.reason.length > 0, "a job decision row points at its event and carries a reason");
  emitSafely(row, new Map());
  return state;
}
/**
 * F12 enforce (ISC-139, ISC-147): send the fixed-rule job texts (prep, decision, security at high or above) now. Only local state sits in
 * this path: no adapter, no store, no model. `Vigil.ts emit --now` calls it for one event; each tick calls it first, before anything that can hang.
 * In shadow mode it does nothing. Returns what this process decided; an event another process had claimed is left out.
 */
export type JobOutcome = { decision: Decision; state: "sent" | "failed" | "held" };
export async function deliverFixed(opts: { now?: Date; only?: string[]; textSend?: typeof sendText } = {}): Promise<JobOutcome[]> {
  const now = opts.now ?? new Date(), policy = loadPolicy(); if (policy.decider_mode !== "enforce") return [];
  const all = outbox(), decided = jobDecided(all), pool = opts.only ? all.filter((e) => opts.only!.includes(e.id)) : pendingJobs(all, now);
  const decisions = jobRoute(pool.filter((e) => fixedJob(e) && !decided.has(e.id)), { policy, now, recentTexts: noticesOf(all), sentStories: sentStories(all), quiet: inQuietHours(now), draftOf: draftLookup() });
  const done: JobOutcome[] = []; for (const decision of decisions) { const state = await sendJob(decision, { now, textSend: opts.textSend }); if (state !== "claimed") done.push({ decision, state }); }
  return done;
}
function refused(error: unknown): string | null { const reason = error instanceof Error ? error.message : String(error); return reason.endsWith("refused") ? reason : null; }
function emitSafely(event: VigilEvent, refusals: Map<string, number>): void { try { emit(event); } catch (error) { const reason = refused(error); if (!reason) throw error; const count = (refusals.get(event.source) ?? 0) + 1; refusals.set(event.source, count); const path = statePath("cursors", `${event.source}.read.json`), prior = readJson<Record<string, unknown>>(path, {}); writeJson(path, { ...prior, ok: true, refused: count }); console.error(`Vigil refused event from ${event.source} ref ${event.ref}: ${reason}`); } }
/**
 * The editor pass (Editor.ts): promotes at most one floor-routed event to a text and moves worthwhile pulse events to
 * the digest. Floor texts and holds are never touched. Every verdict lands in editor.jsonl; text outcomes are logged by
 * the send loop and digest outcomes here, so /vigil shows the reason for each. A model failure is a failed ping only.
 */
async function runEditor(decisions: Decision[], ctx: { policy: VigilPolicy; now: Date; all: VigilEvent[]; notices: string[]; budget?: TextBudget; infer?: Infer; pings: Ping[]; dryRun: boolean }): Promise<Outcome[]> {
  if (!ctx.policy.editor_enabled || process.env.VIGIL_EDITOR === "off") return [];
  const day = ctx.now.getTime() - 86_400_000, globalUsed = (ctx.budget ? budgetUsedAt(ctx.budget, ctx.now.getTime()) : ctx.notices.filter((ts) => Date.parse(ts) >= day).length) + decisions.filter((d) => d.action === "text").length;
  // ISC-141: the ledger budget is the only ceiling; Vigil's two ceilings bind again only when it falls back.
  const policy = ctx.budget?.source === "ledger" ? { ...ctx.policy, text_ceiling_per_24h: ctx.budget.cap, editor_text_ceiling_per_24h: ctx.budget.cap } : ctx.policy;
  const started = performance.now(), result = await edit(decisions, { policy, now: ctx.now, sent: sentEditorTexts(ctx.all), globalUsed, infer: ctx.infer });
  if (result.asked > 0 || result.error) ctx.pings.push({ name: "editor", ok: !result.error, ...(result.error ? { error: message(result.error) } : {}), events: result.asked, ms: Math.round(performance.now() - started) });
  if (result.error) console.error(`Vigil editor: ${result.error}`);
  if (ctx.dryRun) return result.outcomes;
  for (const o of result.outcomes) {
    const d = o.decision;
    appendJson(statePath("editor.jsonl"), { ts: ctx.now.toISOString(), event_id: d.event.id, ref: d.event.ref, source: d.event.source, title: d.event.title, url: d.event.url, verdict: o.verdict, action: o.action, why: o.why, story: o.story, reason: o.reason });
    if (o.action === "text") {
      // The source's own daily cap binds a promotion as it binds a routed text.
      const cap = d.event.severity === "critical" ? null : sourceTextCap(ctx.policy, d.event.source);
      if (cap !== null && sentBySource([...sentStories(ctx.all), ...decisions.filter((x) => x.action === "text").map((x) => ({ key: storyKeyOf(x.event), ts: ctx.now.toISOString(), source: x.event.source }))], d.event.source, day) >= cap) { d.reason = SOURCE_CAP_REASON; continue; }
      d.action = "text"; d.reason = o.reason; d.editor = { why: o.why, story: o.story }; continue;
    }
    if (o.action !== "digest") continue;
    if (d.action === "pulse") { d.action = "digest"; d.reason = o.reason; }
    const note: VigilEvent = { id: randomUUID(), source: "vigil", ts: new Date().toISOString(), kind: "notification", severity: "info", title: "Vigil editor digest", summary: `Editor: ${o.why || o.reason}`.slice(0, 1000), ref: d.event.id, url: null, privacy_class: "personal", dedup_key: `vigil:${d.event.dedup_key}:editor-digest`, meta: { decision: "editor-digest", reason: o.reason, editor: true, title: d.event.title.slice(0, 140), why: o.why, story: o.story, state_inputs: stateInputs(ctx.now) } };
    invariant(note.ref === d.event.id && note.dedup_key.length > 0, "editor digest note points at its event");
    emitSafely(note, new Map());
  }
  return result.outcomes;
}
/** F12 enforce (ISC-142): the editor may demote or reword news and ops job texts the rules would send. Fixed-rule classes are never handed to it; its failure sends every draft as written. */
async function runJobEditor(decisions: Decision[], ctx: { policy: VigilPolicy; now: Date; all: VigilEvent[]; notices: string[]; budget?: TextBudget; infer?: Infer; budgetMs?: number; pings: Ping[]; dryRun: boolean }): Promise<void> {
  if (!ctx.policy.editor_enabled || process.env.VIGIL_EDITOR === "off") return;
  const items = decisions.filter((d) => d.job && d.action === "text" && !fixedJob(d.event) && EDITABLE_JOB_CLASSES.includes(d.job.cls)).map((d) => ({ id: d.event.id, cls: d.job!.cls, text: d.job!.text }));
  if (!items.length) return;
  const used = (ctx.budget ? budgetUsedAt(ctx.budget, ctx.now.getTime()) : ctx.notices.filter((ts) => Date.parse(ts) >= ctx.now.getTime() - 86_400_000).length) + decisions.filter((d) => d.action === "text").length;
  const started = performance.now(), result = await editJobs(items, { infer: ctx.infer, budgetMs: ctx.budgetMs, sent: sentEditorTexts(ctx.all), textsLeft: Math.max(0, (ctx.budget?.cap ?? ctx.policy.text_ceiling_per_24h) - used), now: ctx.now });
  ctx.pings.push({ name: "editor-jobs", ok: !result.error, ...(result.error ? { error: message(result.error) } : {}), events: result.asked, ms: Math.round(performance.now() - started) });
  if (result.error) console.error(`Vigil job editor: ${result.error}`);
  const byId = new Map(decisions.map((d) => [d.event.id, d] as const));
  for (const e of result.edits) {
    const d = byId.get(e.id); if (!d?.job || fixedJob(d.event) || !EDITABLE_JOB_CLASSES.includes(d.job.cls)) continue;
    if (e.action === "digest") { d.action = "digest"; d.reason = e.reason; } else if (e.reworded) { d.job.text = e.text; d.job.reworded = true; d.reason = `${d.reason}; ${e.reason}`; }
    if (!ctx.dryRun) appendJson(statePath("editor.jsonl"), { ts: ctx.now.toISOString(), event_id: d.event.id, source: d.event.source, title: d.event.title, job: true, class: d.job.cls, verdict: e.action, action: e.action, reworded: e.reworded, reason: e.reason });
  }
}
/** F18 world watch (ISC-469..471): tag and raise watchlist matches before routing, in code. A bad watchlist is a failed ping, never a failed tick: the events route as they came. */
export function worldWatch(events: VigilEvent[], now: Date, pings: Ping[], dryRun: boolean): VigilEvent[] {
  try { const { events: out, rows } = applyWatchlist(events, loadWatchlist(), now); if (!dryRun) recordMatches(rows); return out; }
  catch (error) { pings.push({ name: "world-watch", ok: false, error: message(error), events: 0, ms: 0 }); return events; }
}
export async function tick(opts: { dryRun?: boolean; collect?: boolean; now?: Date; storeFetch?: typeof fetch; slackFetch?: typeof fetch; textSend?: typeof sendText; workrepo?: { repo: string; run: GhRunner }; editorInfer?: Infer; editorBudgetMs?: number; ledger?: () => Omit<TextBudget, "source"> | null; tickRow?: (record: TickRecord) => { ok: boolean; refused?: string } } = {}): Promise<Decision[]> {
  const now = opts.now ?? new Date(), started = performance.now(); invariant(ADAPTER_READERS.every((adapter, i) => (REGISTERED_ADAPTERS as readonly string[]).includes(adapter.name) && ADAPTER_READERS.findIndex((x) => x.name === adapter.name) === i), "every reader is a registered adapter, once");
  const run: { pings: Ping[]; collected: number; routed: number; baseline?: true } = { pings: [], collected: 0, routed: 0 };
  let failure: string | null = null;
  try { return await tickBody(now, opts, run); } catch (error) { failure = message(error); throw error; }
  finally { const record: TickRecord = { ts: now.toISOString(), duration_ms: Math.round(performance.now() - started), collected: run.collected, routed: run.routed, pings: run.pings, ...(run.baseline ? { baseline: true as const } : {}), ...(opts.dryRun ? { dry_run: true as const } : {}), ...(failure ? { error: failure } : {}) }; try { recordRun(record); } finally { logTickRow(record, opts.tickRow); } }
}
/**
 * Dual-write p1: the run's vigil-log `tick` row (Decision.writeTickRow filters every error string first, S15). Best-effort:
 * a refusal or a throw is logged and never fails the tick. last-tick.json is written by the tick body before this runs,
 * so it is fresh whatever this append returns (Vigil ISC-449).
 */
function logTickRow(record: TickRecord, write?: (record: TickRecord) => { ok: boolean; refused?: string }): void {
  const dual = loadDualWrite(); if (!dual) return;
  try { const r = (write ?? dual.decision.writeTickRow)(record) as { ok: boolean; refused?: string }; if (!r.ok && r.refused) console.error(`Vigil tick row refused by the record: ${r.refused}`); }
  catch (error) { console.error(`Vigil tick row failed: ${message(error)}`); }
}
async function tickBody(now: Date, opts: { dryRun?: boolean; collect?: boolean; storeFetch?: typeof fetch; slackFetch?: typeof fetch; textSend?: typeof sendText; workrepo?: { repo: string; run: GhRunner }; editorInfer?: Infer; editorBudgetMs?: number; ledger?: () => Omit<TextBudget, "source"> | null }, run: { pings: Ping[]; collected: number; routed: number; baseline?: true }): Promise<Decision[]> {
  // F12 enforce (ISC-147): prep, decision and high security job texts go out before any adapter, store call or model can hang this tick.
  const urgent = opts.dryRun || !existsSync(statePath("reader.json")) ? [] : await deliverFixed({ now, textSend: opts.textSend });
  const refusals = new Map<string, number>(), reads = opts.collect === false ? [] : await Promise.all(ADAPTER_READERS.map((adapter) => ping(adapter))), collected = reads.flatMap((read) => read.events);
  run.pings = reads.map((read) => read.ping); run.collected = collected.length; collected.forEach((event) => emitSafely(event, refusals));
  emitSafely({ id: randomUUID(), source: "vigil", ts: now.toISOString(), kind: "infra", severity: "info", title: "Vigil heartbeat", summary: "Vigil tick is running.", ref: null, url: null, privacy_class: "personal", dedup_key: `vigil:heartbeat:${now.toISOString().slice(0, 16)}` }, refusals); await forward({ fetchImpl: opts.storeFetch }); await probeStore(now, opts.storeFetch);
  // The store is a source like the adapters: a no-collect tick (tests, replays) never pulls it unless handed a fetch.
  const cursorPath = statePath("reader.json"), all = outbox(), store = opts.collect === false && !opts.storeFetch ? null : await pullStore(all, opts.storeFetch, now);
  // Local timestamps are untrusted too, same rule as the store pull: a future-dated event never routes and never moves the
  // reader cursor. One far-future event would otherwise pin the cursor ahead of the clock, and every later local event would
  // fall behind it unrouted.
  const localCap = new Date(now.getTime() + 5 * 60_000).toISOString(), settledLocal = all.filter((e) => e.ts <= localCap);
  if (!existsSync(cursorPath)) { const cursor = cursorFor(settledLocal); invariant(cursor.ids_at_ts.every(Boolean), "baseline cursor ids exist"); writeJson(cursorPath, cursor); run.baseline = true; if (!opts.dryRun) writeJson(statePath("last-tick.json"), { ts: now.toISOString(), collected: collected.length, routed: 0, baseline: true }); console.log(JSON.stringify({ baseline: true, seeded: all.length })); return []; }
  const stored = readJson<Cursor>(cursorPath, { ts: "", ids_at_ts: [] });
  // A cursor already pinned in the future cannot be trusted to mark what was routed; re-read the last hour and no further,
  // so recovery never floods the principal with a backlog.
  const cursor: Cursor = stored.ts > localCap ? { ts: new Date(now.getTime() - 60 * 60_000).toISOString(), ids_at_ts: [] } : stored;
  if (cursor !== stored) console.log(`Vigil reader cursor was future-dated (${stored.ts}); reset to the last hour`);
  const newer = settledLocal.filter((e) => afterCursor(e, cursor)), incoming = [...newer.filter((e) => e.source !== "vigil"), ...(store?.events ?? [])], events = incoming.filter((e) => !isShadow(e));
  const notices = noticesOf(all);
  const recentWorkRepo = all.filter((e) => e.source === "vigil" && e.kind === "notification" && !isShadow(e) && e.meta?.decision === "workrepo").map((e) => e.ts);
  const policy = loadPolicy(), enforce = policy.decider_mode === "enforce", decided = jobDecided(all);
  // ISC-141: one daily budget across every origin. Enforce routes by it; shadow only records what it had left on each shadow decision.
  const budget = textBudget((opts.ledger ?? readTextLedger)(), policy, notices), enforced = enforce ? budget : undefined;
  // F12 enforce: local job texts are decided by jobRoute, never by the severity floor; one after the cursor or still inside the pending window is picked up until it has a decision row. Shadow mode leaves them to route() exactly as before.
  const jobs = enforce ? [...new Map([...newer, ...pendingJobs(all, now)].filter((e) => isJobEvent(e) && !decided.has(e.id)).map((e) => [e.id, e] as const)).values()] : [];
  const jobDecisions = jobRoute(jobs, { policy, now, recentTexts: notices, sentStories: sentStories(all), quiet: inQuietHours(now), draftOf: draftLookup(), budget: enforced }), jobSent = jobDecisions.filter((d) => d.action === "text");
  const localJobs = new Set(enforce ? all.filter(isJobEvent).map((e) => e.id) : []), routable = worldWatch(events.filter((e) => !localJobs.has(e.id)), now, run.pings, opts.dryRun === true);
  // ISC-83: persisted supersession cannot reserve budget (or consume the per-source admission cap).
  const superseded: Decision[] = [];
  for (const event of routable) {
    const d: Decision = { event, action: "text", reason: "checking current intent" };
    await holdSuperseded(d);
    if (d.action === "held") superseded.push(d);
  }
  const supersededIds = new Set(superseded.map((d) => d.event.id));
  // Job texts count toward the 24h ceiling and the 72h story hold like any real send.
  const decisions = [...jobDecisions, ...superseded, ...route(routable.filter((e) => !supersededIds.has(e.id)), { policy, recentTexts: [...notices, ...jobSent.map(() => now.toISOString())], recentWorkRepo, now, sentStories: [...sentStories(all), ...jobSent.map((d) => ({ key: storyKeyOf(d.event), ts: now.toISOString(), severity: d.event.severity, source: d.event.source }))], quiet: inQuietHours(now), budget: enforced && { ...enforced, texts: [...enforced.texts, ...jobSent.map(() => now.toISOString())] } })];
  run.routed = routable.length + jobDecisions.length;
  // Shadow events are decided on their own and only recorded. A failure here is a failed ping, never a failed tick: the real sends below must not repeat.
  const decidedShadow = new Set(all.filter((e) => e.source === "vigil" && e.kind === "notification" && isShadow(e)).map((e) => e.ref)), pendingShadow = incoming.filter((e) => isShadow(e) && !decidedShadow.has(e.id));
  let shadow: ShadowDecision[] = []; try { shadow = shadowRoute(pendingShadow, { policy, now, recentTexts: notices, shadowSent: shadowStories(all), quietAt: (ts) => inQuietHours(new Date(ts)), budget }); } catch (error) { run.pings.push({ name: "shadow", ok: false, error: message(error), events: pendingShadow.length, ms: 0 }); }
  const expired = new Set(decisions.filter((d) => droppable(d, now))), live = decisions.filter((d) => !expired.has(d));
  const edited = await runEditor(live, { policy, now, all, notices, budget: enforced, infer: opts.editorInfer, pings: run.pings, dryRun: opts.dryRun === true });
  dropExpired([...expired], now);
  await runJobEditor(decisions, { policy, now, all, notices, budget: enforced, infer: opts.editorInfer, budgetMs: opts.editorBudgetMs, pings: run.pings, dryRun: opts.dryRun === true });
  if (opts.dryRun) { decisions.forEach((d) => console.log(JSON.stringify({ id: d.event.id, action: d.action, reason: d.reason }))); edited.forEach((o) => console.log(JSON.stringify({ editor: o.verdict, action: o.action, title: o.decision.event.title, why: o.why, reason: o.reason }))); shadow.forEach((d) => console.log(JSON.stringify({ shadow: d.decision, id: d.event.id, key: d.key, reason: d.reason, actual: d.event.meta?.actual }))); return decisions; }
  const recordSlackDm = async (d: Decision, channel: "text" | "workrepo", text: string): Promise<void> => {
    if (!policy.dm_mirror_on.includes(channel)) return;
    const sent = await sendSlackDm(text, policy, opts.slackFetch);
    if (sent === null) return;
    const decision = sent ? "slack-dm-sent" : "slack-dm-failed";
    const notification: VigilEvent = { id: randomUUID(), source: "vigil", ts: new Date().toISOString(), kind: "notification", severity: "info", title: `Vigil ${decision}`, summary: sent ? "Slack DM sent." : "Slack DM was not sent.", ref: d.event.id, url: null, privacy_class: "personal", dedup_key: `vigil:${d.event.dedup_key}:slack-dm:${channel}`, meta: { decision, state_inputs: stateInputs(now) } };
    invariant(notification.dedup_key.length > 0 && notification.ref === d.event.id, "slack notification has a source and dedup key");
    emitSafely(notification, refusals);
  };
  const releaseTextReservation = async (after: Decision) => {
    for (const d of decisions.slice(decisions.indexOf(after) + 1)) {
      if (d.job || d.action !== "held" || ![BUDGET_REASON, "rolling 24h text ceiling reached", WATCH_CAP_REASON].includes(d.reason)) continue;
      const check: Decision = { event: d.event, action: "text", reason: d.reason };
      await holdSuperseded(check);
      if (check.action === "held") { d.reason = check.reason; continue; }
      // Keep every other reservation, including earlier sends and editor/job texts. Re-route only
      // budget-held later events, preserving quiet hours, trust, story dedupe and both text caps.
      const reserved = decisions.filter((d) => d.action === "text"), times = reserved.map(() => now.toISOString());
      if (reserved.some((r) => storyKeyOf(r.event) === storyKeyOf(d.event))) { d.reason = "same story already routed to text in this batch"; continue; }
      const [retry] = route([d.event], { policy, now, recentTexts: [...notices, ...times], sentStories: [...sentStories(all), ...reserved.map((d) => ({ key: storyKeyOf(d.event), ts: now.toISOString(), severity: d.event.severity }))], quiet: inQuietHours(now), budget: enforced && { ...enforced, texts: [...enforced.texts, ...times] } });
      d.action = retry!.action; d.reason = retry!.reason;
    }
  };
  for (const d of decisions) { if (d.job) { await sendJob(d, { now, textSend: opts.textSend }); continue; } let sent = false; const body = d.editor ? editorText(d.event, d.editor.why) : floorText(d.event); const reserved = d.action === "text"; await holdSuperseded(d); if (reserved && d.action === "held") await releaseTextReservation(d); if (d.action === "text") sent = await (opts.textSend ?? sendText)(body); if (d.action === "digest" || d.action === "held") { invariant(d.event.dedup_key.length > 0, "digest event has dedup key"); appendJson(statePath("digest.jsonl"), d.event); } if (d.action === "text" || d.action === "held") { const state = d.action === "held" ? "held" : sent ? "sent" : "failed"; emitSafely({ id: randomUUID(), source: "vigil", ts: new Date().toISOString(), kind: "notification", severity: "info", title: `Vigil notification ${state}`, summary: d.action === "held" ? `Notification held: ${d.reason}` : sent ? "Relay text sent." : "Relay text was not sent.", ref: d.event.id, url: null, privacy_class: "personal", dedup_key: `vigil:${d.event.id}:${state}`, meta: { decision: state, reason: d.reason, key: storyKeyOf(d.event), severity: d.event.severity, state_inputs: stateInputs(now), ...(d.editor ? { editor: true, title: d.event.title.slice(0, 140), why: d.editor.why, story: d.editor.story } : {}) } }, refusals); }
    if (d.action === "text" && sent) await recordSlackDm(d, "text", d.editor ? slackEditorText(d.event, d.editor.why) : slackFloorText(d.event));
    if (d.workrepo) { let action: "workrepo" | "workrepo-held" | "workrepo-failed" = d.workrepo, reason = d.workrepo === "workrepo-held" ? "rolling 24h workrepo ceiling reached" : "workrepo filing complete";
      if (d.workrepo === "workrepo") try { const repo = opts.workrepo?.repo ?? await workRepo(); const issueUrl = await fileWorkRepo(d.event, repo, opts.workrepo?.run ?? ghRunner); if (issueUrl !== null) await recordSlackDm(d, "workrepo", `New work repo issue: ${d.event.title}\n${issueUrl}`); } catch (error) { action = "workrepo-failed"; reason = message(error); }
      emitSafely({ id: randomUUID(), source: "vigil", ts: new Date().toISOString(), kind: "notification", severity: "info", title: `Vigil ${action}`, summary: `Vigil ${action}: ${reason}`, ref: d.event.id, url: null, privacy_class: "personal", dedup_key: `vigil:${d.event.dedup_key}:${action}`, meta: { decision: action, reason, state_inputs: stateInputs(now) } }, refusals);
    } }
  for (const d of shadow) { try { emit(shadowNote(d, now)); } catch (error) { run.pings.push({ name: "shadow", ok: false, error: message(error), events: 1, ms: 0 }); console.error(`Vigil shadow note failed for ${d.event.id}: ${message(error)}`); } }
  const dual = loadDualWrite();
  if (store) { recordPulled(store.rows, dual); for (const event of store.events) { invariant(event.id && event.dedup_key && event.source !== "vigil", "pulled event is routable"); appendJson(statePath("pulled.jsonl"), event); } trimPulled(); invariant(typeof store.next === "string", "store cursor is valid"); writeJson(statePath("store-reader.json"), { since: store.next }); }
  if (enforce) pruneClaims(now);
  const next = cursorFor(settledLocal); invariant(next.ids_at_ts.every(Boolean), "reader cursor ids exist"); writeJson(cursorPath, next); writeJson(statePath("last-tick.json"), { ts: now.toISOString(), collected: collected.length, routed: run.routed }); rotateOutbox(now);
  // Dual-write p1 shadow pass (30 s, best-effort): decide the record's new rows with this tick's routing context, compare with what this tick did, write one vigil-log shadow-compare row and no decision rows.
  // Nothing from the pass, an InvariantViolation included, may fail a live tick: sends and last-tick.json are already done, so any throw is one failed ping.
  if (dual) try { const legacy = decisions.filter((d) => !d.job && !isShadow(d.event)), pass = await dual.decision.shadowPass({ policy, legacy, storyKey: storyKeyOf, skip: (e) => isShadow(e) || e.source === "vigil" || enforce && isJobEvent(e), decide: (evs) => route(evs, { policy, recentTexts: notices, recentWorkRepo, now, sentStories: sentStories(all), quiet: inQuietHours(now), budget: enforced }) });
    const refusedRow = pass.row && !pass.row.ok && "refused" in pass.row ? pass.row.refused : null;
    if (pass.error || refusedRow) run.pings.push({ name: "shadow-pass", ok: false, error: (pass.error ?? `shadow-compare row refused: ${refusedRow}`).slice(0, PING_ERROR_MAX), events: pass.compare?.read ?? 0, ms: pass.compare?.ms ?? 0 });
  } catch (error) { run.pings.push({ name: "shadow-pass", ok: false, error: `shadow pass threw: ${message(error)}`.slice(0, PING_ERROR_MAX), events: 0, ms: 0 }); console.error(`Vigil shadow pass threw; the tick carries on: ${message(error)}`); }
  return [...urgent.map((o) => o.decision), ...decisions];
}
/** An abandoned read can keep the event loop alive forever. Once a tick is done, whoever ran it calls this so the process exits (ISC-15c). The deadline itself covers awaited work only: a synchronous call (spawnSync, a sync file scan) blocks every timer until it returns. */
export function exitIfAbandoned(): void { if (abandoned.size) process.exit(0); }
if (import.meta.main) tick({ dryRun: process.argv.includes("--dry-run") }).then(exitIfAbandoned).catch((e) => { console.error(`Vigil tick failed: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
