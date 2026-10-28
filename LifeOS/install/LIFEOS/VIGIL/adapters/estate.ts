/**
 * Atlas's estate notices, read from the record's `observe` stream (CENSVS ISA ISC-68). Atlas writes one observe row per asset
 * that appeared, changed or expired, and one `sync` row per collector run (ATLAS/Observe.ts). This reader turns those rows into
 * the three notices the retired `atlas` adapter raised from Atlas's private snapshot, at the same severity and kind:
 *  - an asset's state moved (`Asset lifecycle: <from>-><to>`, low): a changed or expired row whose state differs from the last
 *    state the record held for that subject. An appeared asset, or a change that keeps its state, raises nothing, as before.
 *  - a collector kept failing (`Atlas collector <name> failing`, low): its second incomplete sync row in a row, and each one after.
 *  - an unregistered asset appeared (`Unregistered asset found by Atlas`, medium): an id new to a sync row's `unregistered` list.
 *    A sync row without the list leaves the known set alone, and the first list read is the baseline.
 * The cursor keeps the record position (segment offsets), each subject's last state, per-collector run counts, the known
 * unregistered set and the rows this read covered, so `diff` stays a pure function of two snapshots. The first read scans the
 * whole observe stream once to learn every subject's state and raises nothing; later reads open only segments from the day before
 * the last read on. Read-only: nothing here writes the record or reads Atlas's own files.
 * @version 1.0.0 */
import type { VigilEvent } from "../../STATVS/lib/refuse";
import { readJson, statePath } from "../../STATVS/lib/collectState";
import { scan, utcDate } from "../../STATVS/lib/record";
import { clip, clock, event, withCursor } from "./common";

/** One observe row as the cursor keeps it. */
export type Seen = { id: string; ts: string; kind: string; subject?: string; state?: string; title?: string; absent?: true; collector?: string; complete?: boolean; unregistered?: string[] };
/** A collector's sync history on the record: every run, the incomplete ones, and the current run of incomplete ones. */
export type Runs = { runs: number; incomplete: number; streak: number };
export type Snapshot = { at: string; offsets: Record<string, number>; states: Record<string, string>; collectors: Record<string, Runs>; unregistered: string[] | null; rows: Seen[] };
type Fold = Pick<Snapshot, "states" | "collectors" | "unregistered">;

const NAME = "estate", STREAM = "observe", DAY_MS = 86_400_000;
const CHANGES = new Set(["appeared", "changed", "expired"]);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** A record row as the cursor keeps it, or null for a row this reader never reads. */
export function seen(row: { id: string; ts: string; stream: string; kind?: string; subject?: string; data?: unknown }): Seen | null {
  if (row.stream !== STREAM || !row.kind) return null;
  const d = isObj(row.data) ? row.data : {};
  if (row.kind === "sync") {
    const collector = str(d.collector);
    if (!collector) return null;
    const list = Array.isArray(d.unregistered) ? d.unregistered.filter((x): x is string => typeof x === "string" && x.length > 0) : null;
    return { id: row.id, ts: row.ts, kind: "sync", collector, complete: d.complete === true, ...(list ? { unregistered: [...new Set(list)].sort() } : {}) };
  }
  const subject = str(row.subject), state = str(d.state);
  if (!CHANGES.has(row.kind) || !subject || !state) return null;
  const title = str(d.title), absent = isObj(d.data) && d.data.absent === true;
  return { id: row.id, ts: row.ts, kind: row.kind, subject, state, ...(title ? { title } : {}), ...(absent ? { absent: true as const } : {}) };
}

/** Walk `rows` in record order from `start`, returning where the walk ends and the notices it passed. */
function walk(start: Fold, rows: readonly Seen[]): Fold & { events: VigilEvent[] } {
  const states = { ...start.states }, collectors: Record<string, Runs> = Object.fromEntries(Object.entries(start.collectors).map(([k, v]) => [k, { ...v }]));
  let unregistered = start.unregistered ? [...start.unregistered] : null;
  const events: VigilEvent[] = [];
  for (const r of rows) {
    if (r.kind === "sync" && r.collector) {
      const c = (collectors[r.collector] ??= { runs: 0, incomplete: 0, streak: 0 });
      c.runs++;
      if (r.complete) c.streak = 0;
      else {
        c.incomplete++; c.streak++;
        if (c.streak >= 2) events.push(event(NAME, r.collector, "failing", "low", `Atlas collector ${r.collector} failing`, `${r.collector} ended its last ${c.streak} runs incomplete; ${c.runs} runs on the record, ${c.runs - c.incomplete} complete; last run ${clock(r.ts)}.`, "security", null, r.id));
      }
      if (r.unregistered) {
        if (unregistered) for (const id of r.unregistered.filter((x) => !unregistered!.includes(x))) events.push(event(NAME, id, "unregistered", "medium", "Unregistered asset found by Atlas", `Atlas observed unregistered asset ${id} in its ${r.collector} run at ${clock(r.ts)}; nothing in the security plane monitors it.`, "security", null, id));
        unregistered = r.unregistered;
      }
      continue;
    }
    if (!r.subject || !r.state) continue;
    const from = states[r.subject];
    states[r.subject] = r.state;
    if (r.kind === "appeared" || from === r.state) continue;
    const move = `${from ?? "unrecorded"}->${r.state}`;
    const detail = r.title ? `; detail: ${clip(r.title)}` : r.absent ? "; it is no longer in Atlas" : "; detail not on the record row";
    events.push(event(NAME, r.subject, move, "low", `Asset lifecycle: ${move}`, `Asset ${r.subject} recorded ${move} at ${clock(r.ts)}${detail}.`, "security", null, r.id));
  }
  return { states, collectors, unregistered, events };
}

export function diff(prev: Snapshot | undefined, next: Snapshot): VigilEvent[] {
  if (!prev) return [];
  return walk(prev, next.rows).events;
}

const SEGMENT_DATE = /(\d{4}-\d{2}-\d{2})/;
/** The cursor on disk, or undefined when it is missing or another shape (a fresh baseline then). */
function prior(): Snapshot | undefined {
  const s = readJson<Snapshot | undefined>(statePath("cursors", `${NAME}.json`), undefined);
  return s && typeof s.at === "string" && isObj(s.offsets) && isObj(s.states) && isObj(s.collectors) && Array.isArray(s.rows) ? s : undefined;
}

/** New observe rows since `prev`'s position, folded onto its state. With no `prev`, the whole stream, kept as the baseline only. */
export async function live(prev: Snapshot | undefined = prior(), now = new Date()): Promise<Snapshot> {
  const fromDate = prev ? utcDate(Date.parse(prev.at) - DAY_MS) : undefined;
  const since = prev ? Object.fromEntries(Object.entries(prev.offsets).filter(([rel]) => (rel.match(SEGMENT_DATE)?.[1] ?? "") >= fromDate!)) : undefined;
  const read = scan({ streams: [STREAM], classes: ["public", "system", "personal"], ...(since ? { since, fromDate } : {}) });
  const rows = read.rows.map(seen).filter((r): r is Seen => r !== null);
  const base: Fold = prev ?? { states: {}, collectors: {}, unregistered: null };
  const { states, collectors, unregistered } = walk(base, rows);
  return { at: now.toISOString(), offsets: { ...since, ...read.offsets }, states, collectors, unregistered, rows: prev ? rows : [] };
}

export const read = () => withCursor(NAME, () => live(), diff);
