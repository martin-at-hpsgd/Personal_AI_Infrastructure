/**
 * The `people-history` view: the record's own answer to per-person history (conversation-memory ISA ISC-2, ISC-10).
 *
 * The history people read is a plain-text projection kept by LIFEOS/PEOPLE/History.ts (per-person JSONL shards
 * under `MEMORY/STATE/people/history/`), followed incrementally from the record. This view folds the same rows through the same rules
 * (LIFEOS/PEOPLE/HistoryFacts.ts) into plain JSON and renders a per-person digest (event count and a hash over every
 * event). `live()` brings the projection up to the record and renders the same digest from it, so
 * `Statvs.ts compare people-history` proves the projection holds exactly what the record says, and the drill proves
 * this fold rebuilds.
 *
 * The rules give the same state in any row order (see HistoryFacts.ts), so an incremental read and a rebuild agree.
 * The fold updates the state in place. The state carries no message text, only a hash of it inside the digest.
 *
 * @version 1.0.0
 */
import type { ViewDef } from "../lib/views";
import type { StatvsRow } from "../lib/types";
import { applyFact, digestOf, emptyMemory, factOf, HISTORY_STREAMS, memoryEvents, memoryStore, type MemoryState } from "../../PEOPLE/HistoryFacts.ts";

const view: ViewDef<MemoryState> = {
  name: "people-history",
  group: "people",
  streams: [...HISTORY_STREAMS],
  classes: ["personal"],
  path: "statvs-views/people-history.json",
  init: emptyMemory,
  fold(state: MemoryState, row: StatvsRow): MemoryState {
    applyFact(memoryStore(state), factOf(row));
    return state;
  },
  render: (state: MemoryState) => digestOf(memoryEvents(state)),
  async live() {
    const { openHistory } = await import("../../PEOPLE/History.ts");
    return openHistory().digest();
  },
};

export default view;
