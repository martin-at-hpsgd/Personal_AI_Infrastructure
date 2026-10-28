/**
 * The `work` view: work.json rebuilt from the STATVS `work` stream (STATVS ISA F4).
 *
 * Rows come from hooks/lib/work-events.ts (writer `lib:work-events`):
 *  - kind `seed`      data { registry }      replaces the state (the reset that opens a seed)
 *  - kind `seed-row`  data { slug, row }     sets one session wholesale (the seed, one row per session)
 *  - kind `event`     data <WorkEvent>       applied with the same reducer work.json uses (foldEvents)
 * A payload over 64 KB lives in objects/ (row.obj, data null) and is read from there.
 * A redacted row (data null, no object) folds to nothing.
 *
 * render() and live() return the same shape, { sessions }, so `Statvs.ts compare work`
 * can diff the fold against the live registry (ISC-84).
 *
 * @version 1.0.0
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ViewDef } from "../lib/views";
import type { StatvsRow } from "../lib/types";
import { statvsDir } from "../lib/record";
import { foldEvents, readLiveRegistry, type Registry, type WorkEvent } from "../../../hooks/lib/work-events";

/** The row's payload: inline data, or the content-addressed object it points at. */
function payload(row: StatvsRow): unknown {
  if (row.data !== null && row.data !== undefined) return row.data;
  if (typeof row.obj !== "string" || !/^[a-f0-9]{64}$/.test(row.obj)) return null;
  try {
    return JSON.parse(readFileSync(join(statvsDir(), "objects", row.obj.slice(0, 2), `${row.obj}.json`), "utf8"));
  } catch {
    return null;
  }
}

function cloneSessions(sessions: Record<string, unknown> | undefined): Registry {
  return { sessions: JSON.parse(JSON.stringify(sessions ?? {})) };
}

export function foldWorkRow(state: Registry, row: StatvsRow): Registry {
  if (row.stream !== "work") return state;
  const data = payload(row) as Record<string, any> | null;
  if (!data || typeof data !== "object") return state;
  switch (row.kind) {
    case "seed": {
      const reg = data.registry;
      return reg && typeof reg === "object" ? cloneSessions(reg.sessions) : state;
    }
    case "seed-row": {
      if (typeof data.slug !== "string" || data.slug.length === 0 || !data.row || typeof data.row !== "object") return state;
      return { sessions: { ...state.sessions, [data.slug]: JSON.parse(JSON.stringify(data.row)) } };
    }
    case "event":
      return foldEvents(state, [data as WorkEvent]);
    default:
      return state;
  }
}

const work: ViewDef<Registry> = {
  name: "work",
  group: "work",
  streams: ["work"],
  classes: ["personal"],
  path: "statvs-views/work.json",
  init: () => ({ sessions: {} }),
  fold: foldWorkRow,
  render: (state) => ({ sessions: state.sessions }),
  live: () => ({ sessions: readLiveRegistry().sessions }),
};

export default work;
