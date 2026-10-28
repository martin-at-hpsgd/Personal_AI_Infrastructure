/**
 * The collection runner (migration design §1.1, §2.4, §3 Lane C).
 *
 * One run reads every registered adapter, writes each event it found through `writeEvent`, and
 * records the run as ONE `collect-run` row in stream `collect` (class `system`, writer
 * `statvs:collect`, no severity, never forwarded). The row carries counts and one ping per adapter:
 * `{ name, ok, error?, not_installed?, events, written, refused, ms }`.
 *
 * Guards, each carried over from Vigil's tick (`Tick.ts ping`, `adapters/common.ts`):
 *  - a 60 s deadline per read: a read still running then is abandoned (its name joins `abandoned`,
 *    the set `withCursor` checks so a late read never writes its cursor) and is a failed ping, never
 *    a failed run; a throwing read is a failed ping;
 *  - a read that failed inside `withCursor` resolves with [] and leaves `{ ok: false }` in its
 *    `<name>.read.json`; the runner reads that back, so silence is never mistaken for success;
 *  - the burst guard: more than `adapter_burst_max` events from one read are held as one summary
 *    event (the same event `withCursor` writes), so a changed source cannot flood the record;
 *  - the error-text filter (§2.4, S15, ISC-198): every ping error passes the record's credential and
 *    personal-content checks first, and a hit becomes "error text withheld (<rule>)". If the row is
 *    still refused, it is rewritten with every error withheld, so one bad string can never cost a
 *    run its only `collect-run` row and make a working collector look dead.
 *
 * Stage p1: the default registry is the adapters index in the STATVS adapters folder, which exists only once the
 * switch (p2) moves the adapters there. Until then `Statvs.ts collect` finds no registry and
 * collects nothing, so real adapters never run beside the legacy tick and advance their cursors
 * twice (item 7). The runner is exercised against fixture adapters only.
 *
 * Imports nothing from LIFEOS/VIGIL (S9).
 *
 * @version 1.0.0
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { invariant, InvariantViolation } from "../../TOOLS/Invariant";
import { burstMax as configuredBurstMax } from "./collectConfig";
import { readJson, statePath } from "./collectState";
import { writeEvent, type WriteEventResult } from "./event";
import { append as recordAppend, personalRefusal } from "./record";
import { credentialRefusal, type VigilEvent } from "./refuse";
import type { AppendResult, StatvsInput, StatvsRow } from "./types";

export type AdapterReader = { name: string; read: () => Promise<VigilEvent[]> };

/** One adapter's read in one run. `error` is present only when the read failed. */
export type CollectPing = { name: string; ok: boolean; error?: string; not_installed?: true; held?: number; events: number; written: number; refused: number; ms: number };

export type CollectRunData = { duration_ms: number; adapters: number; collected: number; written: number; refused: number; failed: number; pings: CollectPing[] };

export type CollectResult =
  | { ok: true; row: StatvsRow; data: CollectRunData; withheld_all?: true }
  | { ok: true; spooled: true; data: CollectRunData }
  | { ok: false; refused: string; data: CollectRunData };

export const COLLECT_STREAM = "collect";
export const COLLECT_WRITER = "statvs:collect";
export const COLLECT_RUN_KIND = "collect-run";
/** A read with no deadline can hold the run for as long as it hangs. */
export const READ_DEADLINE_MS = 60_000;
const ERROR_MAX = 300;

/**
 * Adapters whose read a run gave up on at its deadline. Such a read may still finish, but it must
 * never write its cursor: the events it found were never written, so the next read must find them again.
 * This is the ONE set: LIFEOS/VIGIL/adapters/common.ts re-exports it, its `withCursor` checks it, and
 * Vigil's tick adds to it through that re-export, so a read either runner abandons never moves its cursor.
 */
export const abandoned = new Set<string>();
/** A reader may own several cursors, `<name>` and `<name>_<part>`, so an abandoned reader silences all of them. */
export const isAbandoned = (cursor: string): boolean => [...abandoned].some((a) => cursor === a || cursor.startsWith(`${a}_`));

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Error text fit for a `system` row: the text clipped, or "error text withheld (<rule>)" when the
 * record would refuse it (a credential shape such as a 40-character git SHA, an email, money, a health value).
 */
export function filterErrorText(raw: unknown): string {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  const clipped = text.slice(0, ERROR_MAX);
  for (const t of [text, clipped]) {
    if (credentialRefusal(t, { slugs: true })) return "error text withheld (credential)";
    if (personalRefusal(t)) return "error text withheld (personal)";
  }
  return clipped || "error with no message";
}

/**
 * A failure `withCursor` recorded in the adapter's outcome file during this read. An adapter owns
 * `<name>.read.json` plus any `<name>_<part>.read.json`.
 */
function cursorFailure(name: string, since: number): { error: string; not_installed?: true } | null {
  let files: string[];
  try { files = readdirSync(statePath("cursors")); } catch { return null; }
  for (const file of files.filter((f) => f === `${name}.read.json` || (f.startsWith(`${name}_`) && f.endsWith(".read.json")))) {
    const outcome = readJson<{ ok?: boolean; ts?: string; error?: string; not_installed?: string }>(statePath("cursors", file), {});
    if (outcome.ok === false && typeof outcome.ts === "string" && Date.parse(outcome.ts) >= since) {
      return outcome.not_installed ? { error: `not installed: ${outcome.not_installed}`, not_installed: true } : { error: outcome.error ?? `${file} read failed` };
    }
  }
  return null;
}

/** Time one adapter's read. A throw, a recorded cursor failure or a read past its deadline is a failed ping, never a failed run. */
export async function readOne(adapter: AdapterReader, deadlineMs = READ_DEADLINE_MS): Promise<{ ping: CollectPing; events: VigilEvent[] }> {
  const wall = Date.now() - 1, started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const base = { name: adapter.name, written: 0, refused: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), deadlineMs); });
  try {
    const outcome = await Promise.race([adapter.read(), late]);
    if (outcome === "late") {
      abandoned.add(adapter.name);
      return { ping: { ...base, ok: false, error: `read still running after ${Math.round(deadlineMs / 1000)}s; abandoned`, events: 0, ms: ms() }, events: [] };
    }
    const events = Array.isArray(outcome) ? outcome : [];
    if (!Array.isArray(outcome)) return { ping: { ...base, ok: false, error: "read returned no event list", events: 0, ms: ms() }, events: [] };
    const failure = cursorFailure(adapter.name, wall);
    return { ping: failure === null ? { ...base, ok: true, events: events.length, ms: ms() } : { ...base, ok: false, ...failure, events: events.length, ms: ms() }, events };
  } catch (e) {
    if (e instanceof InvariantViolation) throw e;
    return { ping: { ...base, ok: false, error: message(e), events: 0, ms: ms() }, events: [] };
  } finally { clearTimeout(timer); }
}

/** The one summary event that stands in for a held burst (the event `withCursor` writes for the same case). */
export function burstEvent(name: string, events: VigilEvent[], max: number, now: Date): VigilEvent {
  invariant(events.length > max && events.length > 0, "a burst event stands in for more events than the limit");
  const ts = now.toISOString(), source = events[0]!.source, clip = (t: string) => (t.length > 60 ? `${t.slice(0, 59).trimEnd()}…` : t);
  return {
    id: randomUUID(), source, ts, kind: "infra", severity: "medium",
    title: `STATVS held ${events.length} events from ${name} in one read`.slice(0, 140),
    summary: `One read of ${name} produced ${events.length} events, over the burst limit of ${max}, so they were held. First three: ${events.slice(0, 3).map((e) => clip(String(e.title))).join("; ")}. Usually a changed source or cursor shape.`.slice(0, 1000),
    ref: `${name}:burst`, url: null, privacy_class: "personal", dedup_key: `${source}:${name}:burst:held:${ts}`,
  };
}

export interface CollectOptions {
  /** The adapters to read. Required: the CLI passes the registry, tests pass fixtures. */
  readers: AdapterReader[];
  deadlineMs?: number;
  burstMax?: number;
  now?: Date;
  /** The event writer; `writeEvent` unless a test hands another. */
  write?: (event: VigilEvent) => WriteEventResult;
  /** The record writer for the `collect-run` row; the record's `append` unless a test hands another. */
  append?: (input: StatvsInput) => AppendResult;
}

function assertRun(data: CollectRunData): void {
  invariant(data.duration_ms >= 0 && data.collected >= 0 && data.written >= 0 && data.refused >= 0 && data.written + data.refused <= data.collected, "a collect run carries non-negative counts, and writes no more than it collected");
  invariant(data.pings.every((p) => p.name && p.events >= 0 && p.ms >= 0 && (p.ok || typeof p.error === "string")), "every failed ping names its error");
  invariant(new Set(data.pings.map((p) => p.name)).size === data.pings.length && data.adapters === data.pings.length, "one ping per adapter, once");
}

function runRow(data: CollectRunData, ts: string) {
  return { writer: COLLECT_WRITER, stream: COLLECT_STREAM, class: "system" as const, kind: COLLECT_RUN_KIND, title: `collect run: ${data.adapters} adapters, ${data.failed} failed`, ts, data };
}

/** Run every reader once, write their events, and record the run as one `collect-run` row. */
export async function collect(opts: CollectOptions): Promise<CollectResult> {
  const now = opts.now ?? new Date(), started = performance.now();
  const readers = opts.readers;
  invariant(Array.isArray(readers) && readers.every((r, i) => typeof r?.name === "string" && r.name.length > 0 && typeof r.read === "function" && readers.findIndex((x) => x.name === r.name) === i), "every reader has a name and a read, once");
  const write = opts.write ?? writeEvent;
  const append = opts.append ?? ((input: StatvsInput) => recordAppend(input));
  const max = opts.burstMax ?? configuredBurstMax();

  const reads = await Promise.all(readers.map((r) => readOne(r, opts.deadlineMs)));
  let collected = 0, written = 0, refused = 0;
  for (const { ping, events } of reads) {
    collected += events.length;
    const batch = events.length > max ? [burstEvent(ping.name, events, max, now)] : events;
    if (batch !== events) ping.held = events.length;
    for (const event of batch) {
      let r: WriteEventResult;
      try { r = write(event); } catch (e) {
        if (e instanceof InvariantViolation) throw e;
        r = { ok: false, event_id: String(event?.id ?? ""), refused: message(e) };
      }
      if (r.ok) ping.written++; else ping.refused++;
    }
    written += ping.written; refused += ping.refused;
    if (ping.error !== undefined) ping.error = filterErrorText(ping.error);
  }
  // A held burst writes one event for many, so written + refused never exceeds collected.
  const pings = reads.map((r) => r.ping);
  const data: CollectRunData = {
    duration_ms: Math.round(performance.now() - started), adapters: pings.length,
    collected, written, refused, failed: pings.filter((p) => !p.ok).length, pings,
  };
  assertRun(data);

  const ts = now.toISOString();
  const first = append(runRow(data, ts));
  if (first.ok) return { ok: true, row: first.row, data };
  if ("spooled" in first) return { ok: true, spooled: true, data };
  // The filter missed a rule the record applies: withhold every error and write the row anyway.
  const bare: CollectRunData = { ...data, pings: data.pings.map((p) => (p.error === undefined ? p : { ...p, error: "error text withheld (row refused)" })) };
  assertRun(bare);
  const second = append(runRow(bare, ts));
  if (second.ok) return { ok: true, row: second.row, data: bare, withheld_all: true };
  if ("spooled" in second) return { ok: true, spooled: true, data: bare };
  return { ok: false, refused: second.refused, data: bare };
}

/** Where the adapter registry lives from the switch on. Absent in p1, by design. */
export const registryPath = (): string => join(import.meta.dir, "..", "adapters", "index.ts");

/** The registered readers, or why there are none. */
export async function loadReaders(path = registryPath()): Promise<{ readers: AdapterReader[] } | { error: string }> {
  if (!existsSync(path)) return { error: `no adapter registry at ${path}; the adapters move there at the switch (p2), and until then the legacy tick collects` };
  const mod = await import(path) as { ADAPTER_READERS?: AdapterReader[] };
  if (!Array.isArray(mod.ADAPTER_READERS)) return { error: `${path} exports no ADAPTER_READERS` };
  return { readers: mod.ADAPTER_READERS };
}

/** `bun LIFEOS/STATVS/Statvs.ts collect [--deadline-ms N]`, dispatched from Statvs.ts. */
export async function cli(command: string, args: { positional: string[]; flags: Record<string, string | true> }): Promise<number> {
  if (command !== "collect") { console.error(`collect.ts handles collect, not ${command}`); return 2; }
  const loaded = await loadReaders();
  if ("error" in loaded) { console.error(`collect: ${loaded.error}`); return 2; }
  const rawDeadline = args.flags["deadline-ms"];
  const deadlineMs = typeof rawDeadline === "string" && /^\d+$/.test(rawDeadline) ? Number(rawDeadline) : undefined;
  const r = await collect({ readers: loaded.readers, deadlineMs });
  const failed = r.data.pings.filter((p) => !p.ok).map((p) => p.name);
  console.log(JSON.stringify({ ok: r.ok, ...("row" in r ? { id: r.row.id } : "spooled" in r ? { spooled: true } : { refused: r.refused }), collected: r.data.collected, written: r.data.written, refused: r.data.refused, failed, abandoned: [...abandoned] }));
  return r.ok ? 0 : 1;
}
