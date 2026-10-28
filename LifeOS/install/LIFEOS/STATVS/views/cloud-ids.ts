/**
 * The `cloud-ids` view: the D1 ids of every cloud row pulled into stream `cloud`, by the UTC
 * day the record wrote them, over the last 14 days (migration design §2.2, §3 Lane B).
 *
 * The pull reads it to skip a row it already wrote, which replaces Vigil's `pulled.jsonl`.
 * The pull re-reads a two-minute overlap every run, so 14 days is far more than it needs;
 * the window only bounds the view's size. Rows come from `writePulled` (lib/cloud.ts):
 * writer `app:<emitter>`, class personal, data { cloud_id, emitter, event_id, ... }.
 *
 * Days are keyed by the row's hybrid clock (when this Mac wrote it), not the emitter's `ts`,
 * which is untrusted. The window is relative to the newest day the fold has seen, never the
 * wall clock, and each day keeps a sorted id set, so the fold gives the same state in any row
 * order (a rebuild and an incremental read agree; the drill compares them).
 *
 * The fold updates the state it is given in place and returns it, and finds an id's place in its
 * day by binary search, so a day with N ids folds in O(N log N) for the search plus the splice,
 * rather than copying and re-sorting the whole day per row (the quadratic fold event-keys had).
 * The views engine threads one state object through a fold and never reuses an earlier one; a
 * caller that needs the old state keeps its own copy.
 *
 * @version 1.1.0
 */
import type { ViewDef } from "../lib/views";
import type { StatvsRow } from "../lib/types";

export const CLOUD_IDS_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

export interface CloudIdsState {
  /** UTC day (of the row's hlc) → sorted D1 ids pulled that day. */
  days: Record<string, string[]>;
}

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** The oldest day kept when `newest` is the newest day seen. */
const floorDay = (newest: string) => new Date(dayMs(newest) - (CLOUD_IDS_WINDOW_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);

/** The newest day held, or null for an empty state. */
const newestDay = (days: CloudIdsState["days"]) => {
  const names = Object.keys(days);
  return names.length === 0 ? null : names.reduce((a, b) => (a > b ? a : b));
};

/** Drop days older than the window behind the newest day held, in place. */
function prune(days: CloudIdsState["days"]): void {
  const newest = newestDay(days);
  if (newest === null) return;
  const floor = floorDay(newest);
  for (const d of Object.keys(days)) if (d < floor) delete days[d];
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

export function foldCloudIds(state: CloudIdsState, row: StatvsRow): CloudIdsState {
  if (row.stream !== "cloud") return state;
  const data = row.data as { cloud_id?: unknown } | null;
  if (!data || typeof data !== "object") return state;
  const id = data.cloud_id;
  if (typeof id !== "string" || id.length === 0) return state;
  const ms = typeof row.hlc === "string" ? Number(row.hlc.slice(0, 13)) : NaN;
  if (!Number.isFinite(ms)) return state;
  const day = new Date(ms).toISOString().slice(0, 10);
  const ids = state.days[day];
  if (ids) { insertSorted(ids, id); return state; }
  // A day not held yet: drop the row if its day is already outside the window, else open it and prune.
  const newest = newestDay(state.days);
  if (newest !== null && day < floorDay(newest)) return state;
  state.days[day] = [id];
  prune(state.days);
  return state;
}

/** Every id the view holds. */
export function cloudIdSet(state: CloudIdsState): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(state.days)) for (const id of list) out.add(id);
  return out;
}

const cloudIds: ViewDef<CloudIdsState> = {
  name: "cloud-ids",
  group: "event",
  streams: ["cloud"],
  classes: ["personal"],
  path: "statvs-views/cloud-ids.json",
  init: () => ({ days: {} }),
  fold: foldCloudIds,
  render: (state) => ({ window_days: CLOUD_IDS_WINDOW_DAYS, days: state.days }),
};

export default cloudIds;
