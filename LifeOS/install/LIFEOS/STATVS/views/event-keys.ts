/**
 * The `event-keys` view: dedup keys and event ids of local events, by UTC day, over the
 * last 14 days of stream `event` (migration design §2.1, §3 Lane A item 6).
 *
 * `writeEventOnce` reads it to skip a key already written, replacing the 65 MB outbox read
 * behind `outboxHas` and `outboxKeys`; the cloud pull (Lane B) reads it to skip rows this
 * Mac wrote. Rows come from `writeEvent` (writer = the event's source, class personal):
 * data { event_id, dedup_key, ... }.
 *
 * The window is relative to the newest day the fold has seen, never the wall clock, and each
 * key keeps a sorted set of ids, so the fold gives the same state in any row order (a rebuild
 * and an incremental read agree; the drill compares them).
 *
 * The fold updates the state it is given in place and returns it, so a day with N keys folds in
 * O(N log N) rather than copying the whole day per row (9,254 keys took 1.5 s that way). The
 * views engine threads one state object through a fold and never reuses an earlier one; a caller
 * that needs the old state keeps its own copy.
 *
 * @version 1.1.0
 */
import type { ViewDef } from "../lib/views";
import type { StatvsRow } from "../lib/types";

export const EVENT_KEYS_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

export interface EventKeysState {
  /** UTC day → dedup key → sorted event ids written under it that day. */
  days: Record<string, Record<string, string[]>>;
}

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** The oldest day kept when `newest` is the newest day seen. */
const floorDay = (newest: string) => new Date(dayMs(newest) - (EVENT_KEYS_WINDOW_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);

/** Drop days older than the window behind the newest day held, in place. */
function prune(days: EventKeysState["days"]): void {
  const names = Object.keys(days);
  if (names.length === 0) return;
  const floor = floorDay(names.reduce((a, b) => (a > b ? a : b)));
  for (const d of names) if (d < floor) delete days[d];
}

/** Insert `id` into the sorted list, unless it is already there. Returns false when it was. */
function insertSorted(ids: string[], id: string): boolean {
  let lo = 0, hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ids[mid]! < id) lo = mid + 1; else hi = mid;
  }
  if (ids[lo] === id) return false;
  ids.splice(lo, 0, id);
  return true;
}

export function foldEventKeys(state: EventKeysState, row: StatvsRow): EventKeysState {
  if (row.stream !== "event") return state;
  const data = row.data as { event_id?: unknown; dedup_key?: unknown } | null;
  if (!data || typeof data !== "object") return state;
  const key = data.dedup_key, id = data.event_id;
  if (typeof key !== "string" || key.length === 0 || typeof id !== "string" || id.length === 0) return state;
  const day = typeof row.ts === "string" ? row.ts.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return state;
  let keys = state.days[day];
  if (!keys) {
    // A day not held yet: drop it if it is already outside the window, else open it and prune.
    const held = Object.keys(state.days);
    if (held.length > 0 && day < floorDay(held.reduce((a, b) => (a > b ? a : b)))) return state;
    keys = state.days[day] = {};
    prune(state.days);
  }
  // Own properties only: a dedup key such as "constructor" or "__proto__" is a plain key here.
  const ids = Object.hasOwn(keys, key) ? keys[key] : undefined;
  if (!ids) Object.defineProperty(keys, key, { value: [id], enumerable: true, writable: true, configurable: true });
  else insertSorted(ids, id);
  return state;
}

/** Dedup keys and event ids held for days on or after `now - windowDays` (UTC days). */
export function eventKeySets(state: EventKeysState, windowDays = EVENT_KEYS_WINDOW_DAYS, now = Date.now()): { keys: Map<string, string[]>; ids: Set<string> } {
  const floor = new Date(now - (Math.max(1, windowDays) - 1) * DAY_MS).toISOString().slice(0, 10);
  const keys = new Map<string, string[]>();
  const ids = new Set<string>();
  for (const [day, byKey] of Object.entries(state.days)) {
    if (day < floor) continue;
    for (const [key, list] of Object.entries(byKey)) {
      keys.set(key, [...(keys.get(key) ?? []), ...list]);
      for (const id of list) ids.add(id);
    }
  }
  return { keys, ids };
}

const eventKeys: ViewDef<EventKeysState> = {
  name: "event-keys",
  group: "event",
  streams: ["event"],
  classes: ["personal"],
  path: "statvs-views/event-keys.json",
  init: () => ({ days: {} }),
  fold: foldEventKeys,
  render: (state) => ({ window_days: EVENT_KEYS_WINDOW_DAYS, days: state.days }),
};

export default eventKeys;
