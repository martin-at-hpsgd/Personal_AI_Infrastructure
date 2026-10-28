/**
 * vigil adapter — answers "is Vigil ticking?" from the Vigil reader's own
 * last-tick record (LIFEOS/VIGIL/Heartbeat.ts) (maintainer-side; not in the public release). Read-only; the engine is the
 * tick itself. A missing record is a fail, never unknown: a reader that has
 * never run is the silent failure Vigil ISC-27 exists to make loud.
 * @version 1.0.0
 */

import type { Adapter } from "./types";
import type { AnswerInput } from "../Store";
import type { Question } from "../Registry";
import { existsSync } from "node:fs";
import { join } from "node:path";

const VERSION = "vigil/1.0.0";

export const vigil: Adapter = {
  name: "vigil",
  version: VERSION,
  async answers(questions: Question[]): Promise<AnswerInput[]> {
    const heartbeatPath = join(import.meta.dir, "../../VIGIL/Heartbeat.ts");
    const statePath = join(import.meta.dir, "../../VIGIL/State.ts");
    if (!existsSync(heartbeatPath) || !existsSync(statePath)) return questions.map(q => ({ question_id: q.id, verdict: "unknown", value: "unavailable", evidence: "Vigil private implementation is not installed", computed_from: { touched: [], untouched: ["Vigil heartbeat"] }, closer_version: VERSION }));
    const { heartbeatStale } = await import(heartbeatPath);
    const { stateDir } = await import(statePath);
    const dir = stateDir();
    const stale = heartbeatStale(new Date(), dir);
    const computed_from = { touched: [`${dir}/last-tick.json`], untouched: ["whether routed events reached the principal (delivery is Relay's record)"] };
    return questions.map((q) => ({
      question_id: q.id,
      verdict: stale ? "fail" : "pass",
      value: stale ? "stale" : "fresh",
      evidence: stale ? "no Vigil tick recorded in the last 10 minutes (2× the 5-minute cadence)" : "tick recorded within 10 minutes",
      computed_from, closer_version: VERSION,
    }));
  },
};
