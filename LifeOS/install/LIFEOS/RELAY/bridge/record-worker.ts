/**
 * record-worker.ts — the thread that writes Relay's STATVS rows for the bridge (Relay ISA F21 ISC-282). STATVS
 * appends take a kernel lock and can wait on it; here that wait never stalls a text. Messages are handled in order.
 * A row STATVS refuses is replaced by its refusal row, as record.ts does on the direct path.
 * @version 1.0.0
 */
import { append, writeEventOnce } from "../../STATVS/index.ts";
import type { EventInput, StatvsInput } from "../../STATVS/index.ts";
import { refusalRow } from "./record.ts";

declare const self: Worker;
self.onmessage = (e: MessageEvent<{ kind: "append"; row: StatvsInput } | { kind: "alert"; event: EventInput }>) => {
  try {
    if (e.data.kind === "append") {
      const r = append(e.data.row);
      if (!r.ok && "refused" in r) append(refusalRow(e.data.row, r.refused));
    } else writeEventOnce(e.data.event);
  } catch (err) {
    console.error(`[relay-record worker] ${String(err).slice(0, 160)}`);
  }
};
