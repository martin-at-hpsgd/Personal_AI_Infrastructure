/**
 * The event writer: every event in LifeOS goes through `writeEvent` (migration design §2.1).
 *
 * `input` is Vigil's event shape with `id` optional. Vigil's `validateEvent` runs first,
 * unchanged, so every guarantee emitters had still holds at write time. Then:
 *  - `source: "vigil"` is refused: only Vigil's own tick writes those rows (P1, ISC-190);
 *  - `privacy_class: "customer"` is refused: customer events come from apps through the cloud tier;
 *  - the row is appended to stream `event`, class `personal`, writer = the source, with the
 *    cloud class in `data.cloud_class` (Q-2), `ref: null` dropped and `url: null` left out.
 *
 * Stage p1: the legacy outbox (lib/legacyOutbox.ts) gets every accepted event, and the record
 * gets it too only while USER/STATVS/cutover.json says `"dual_write": true`. Under dual-write the
 * order is: ask the record whether it would take the row (rowRefusal, no row written, the refusal
 * counted in the record's `refused` counter as append() would count it), then append the outbox,
 * then append the record. So a row the record refuses reaches neither store;
 * a failed outbox write is a refusal with nothing in the record, which a caller may retry without
 * ever putting a second record row under the same event_id; and both stores grow by exactly one
 * for every accepted event. The record append runs once, last, and its failure after the outbox
 * took the event is reported as ok with a `problem` (the event reached the live tick), never as a
 * refusal that would invite a retry.
 *
 * Never throws for an operational failure or a refusal; only an InvariantViolation escapes.
 * The `event_id` is returned in every outcome, including a refusal and a spool.
 *
 * @version 1.1.1
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { invariant, InvariantViolation } from "../../TOOLS/Invariant";
import { dualWrite } from "./cutover";
import * as legacyOutbox from "./legacyOutbox";
import { append, rowRefusal, statvsStateDir } from "./record";
import { validateEvent, type VigilEvent } from "./refuse";
import type { StatvsInput, StatvsRow } from "./types";
import { readViewDef } from "./views";
import eventKeysView, { eventKeySets, EVENT_KEYS_WINDOW_DAYS } from "../views/event-keys";

/** Vigil's event shape; `id` optional (a UUID is minted), `ref` and `url` may be omitted for null. */
export type EventInput = Omit<VigilEvent, "id" | "ref" | "url"> & { id?: string; ref?: string | null; url?: string | null };

export type WriteEventResult =
  | { ok: true; event_id: string; row: StatvsRow }
  | { ok: true; event_id: string; spooled: true }
  /**
   * p1 only: the event reached the legacy outbox and not the record, because dual_write is false,
   * or (with `problem`) because the record refused it after the outbox had taken it.
   */
  | { ok: true; event_id: string; legacy: true; problem?: string }
  | { ok: false; event_id: string; refused: string };

export type WriteEventOnceResult = WriteEventResult | { ok: true; event_id: string; skipped: true };

export const VIGIL_RESERVED = "source vigil is reserved for Vigil's own rows";
export const CUSTOMER_REFUSED = "customer events come from apps through the cloud tier";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The validated legacy-shape event, or the refusal reason. */
function normalize(input: EventInput, eventId: string): VigilEvent | string {
  if (!input || typeof input !== "object") return "Vigil event must be an object";
  if (input.source === "vigil") return VIGIL_RESERVED;
  const event = { ...input, id: eventId, ref: input.ref ?? null, url: input.url ?? null } as VigilEvent;
  try { validateEvent(event); } catch (e) { return message(e); }
  if (event.privacy_class === "customer") return CUSTOMER_REFUSED;
  return event;
}

/** The record row for an accepted event (§2.1 mapping table). */
export function eventRow(event: VigilEvent): StatvsInput {
  const data: Record<string, unknown> = {
    source: event.source,
    event_id: event.id,
    summary: event.summary,
    cloud_class: event.privacy_class,
    dedup_key: event.dedup_key,
  };
  if (event.url !== null) data.url = event.url;
  if (event.meta !== undefined) data.meta = event.meta;
  const row: StatvsInput = {
    writer: event.source, stream: "event", class: "personal",
    kind: event.kind, severity: event.severity, title: event.title, ts: event.ts, data,
  };
  if (typeof event.ref === "string") row.ref = event.ref;
  const session = event.meta?.session;
  if (typeof session === "string" && session.length > 0) row.session = session;
  return row;
}

/** Write one event. See the module header; never throws except an InvariantViolation. */
export function writeEvent(input: EventInput): WriteEventResult {
  const event_id = typeof input?.id === "string" && input.id.length > 0 ? input.id : randomUUID();
  const event = normalize(input, event_id);
  if (typeof event === "string") return { ok: false, event_id, refused: event };
  invariant(event.id === event_id && event.dedup_key.length > 0 && event.source !== "vigil", "an accepted event keeps its id and dedup key");

  const row = dualWrite() ? eventRow(event) : null;
  if (row) {
    // Counted: append() would have bumped `refused` for this row, and the drill reads that counter.
    const why = rowRefusal(row, { count: true });
    if (why) return { ok: false, event_id, refused: why };
  }
  try {
    legacyOutbox.append(event);
  } catch (e) {
    if (e instanceof InvariantViolation) throw e;
    // Nothing reached the record: a retry with the same id writes exactly one row.
    return { ok: false, event_id, refused: `legacy outbox append failed: ${message(e)}` };
  }
  if (!row) return { ok: true, event_id, legacy: true };
  invariant((row.data as { event_id?: unknown }).event_id === event_id, "the record row carries the event id the outbox line has");
  const r = append(row);
  if (r.ok) return { ok: true, event_id, row: r.row };
  if ("refused" in r) return { ok: true, event_id, legacy: true, problem: `record refused after the legacy outbox took the event: ${r.refused}` };
  return { ok: true, event_id, spooled: true };
}

/** Where writeEventOnce keeps the view's output: the live views dir, or under `bun test` the temp state dir. */
function viewsOutDir(): string | undefined {
  if (process.env.STATVS_VIEWS_DIR) return undefined;
  return process.env.NODE_ENV === "test" ? join(statvsStateDir(), "views") : undefined;
}

/**
 * Write the event unless its dedup key was already written in the last `windowDays` days
 * (view `event-keys`, and while the legacy outbox exists, the outbox too, since events written
 * before dual-write reach only the outbox). Replaces `outboxHas` and `outboxKeys`.
 */
export function writeEventOnce(input: EventInput, opts: { windowDays?: number; now?: number } = {}): WriteEventOnceResult {
  const windowDays = Math.max(1, Math.min(EVENT_KEYS_WINDOW_DAYS, opts.windowDays ?? EVENT_KEYS_WINDOW_DAYS));
  const now = opts.now ?? Date.now();
  const key = input?.dedup_key;
  if (typeof key === "string" && key.length > 0) {
    try {
      const { state } = readViewDef(eventKeysView, { outDir: viewsOutDir() });
      const ids = eventKeySets(state, windowDays, now).keys.get(key);
      if (ids && ids.length > 0) return { ok: true, event_id: ids[ids.length - 1]!, skipped: true };
    } catch (e) {
      if (e instanceof InvariantViolation) throw e;
      /* view unreadable: the outbox check below still guards */
    }
    const seen = legacyOutbox.keyEventId(key, now - windowDays * 86_400_000);
    if (seen) return { ok: true, event_id: seen, skipped: true };
  }
  return writeEvent(input);
}
