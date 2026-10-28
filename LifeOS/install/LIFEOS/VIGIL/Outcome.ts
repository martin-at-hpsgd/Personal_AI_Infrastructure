/**
 * The six outcomes (Vigil ISC-438, migration design §2.4, Lane D).
 *
 * Every row the tick reads ends in exactly one outcome: let be, Pulse, research, prepare,
 * background, or tell now. Today's routing actions map onto them:
 *   text            → tell_now, delivery.state sent | failed (when the send result is known)
 *   held            → tell_now, delivery.state held, held_reason = the routing reason
 *   pulse           → pulse
 *   digest          → pulse with brief: true (Q-4: medium goes to Pulse and the morning brief)
 *   let_be          → let_be
 *   collapsed rows  → let_be (the source's event cap folded them into one Pulse summary; the
 *                     summary itself is not a read row and gets no outcome)
 * Research, prepare and background come only from the advocate's judgment (Advocate.ts), which
 * runs in shadow until {{PRINCIPAL_NAME}} promotes it (Q-7), so the floor never produces them.
 * @version 1.0.0
 */
import { invariant } from "../TOOLS/Invariant";
import type { Decision } from "./Route";

export const OUTCOMES = ["let_be", "pulse", "research", "prepare", "background", "tell_now"] as const;
export type Outcome = typeof OUTCOMES[number];

export type Delivery = { state: "sent" | "failed" | "held"; held_reason?: string; deferred_to?: string };

/** One read row's outcome: the row it answers (record row id), its event id, the outcome and why. */
export type RowOutcome = { answers: string; event_id: string; outcome: Outcome; reason: string; brief?: true; delivery?: Delivery };

/** A row the tick read: the record row id and the event id routing saw for it. */
export type ReadRef = { row_id: string; event_id: string };

/** The action a routing decision ended on, including the `let_be` route value a policy may set. */
type Action = Decision["action"] | "let_be";

export const COLLAPSED_REASON = "source event cap exceeded; folded into one Pulse summary";

/** The outcome of one routing decision. `sent` is the send result for a text, when known. */
export function outcomeOf(d: Pick<Decision, "action" | "reason">, sent?: boolean): Pick<RowOutcome, "outcome" | "reason" | "brief" | "delivery"> {
  const action = d.action as Action;
  switch (action) {
    case "text": return { outcome: "tell_now", reason: d.reason, ...(sent === undefined ? {} : { delivery: { state: sent ? "sent" : "failed" } }) };
    case "held": return { outcome: "tell_now", reason: d.reason, delivery: { state: "held", held_reason: d.reason } };
    case "digest": return { outcome: "pulse", reason: d.reason, brief: true };
    case "pulse": return { outcome: "pulse", reason: d.reason };
    case "let_be": return { outcome: "let_be", reason: d.reason };
    default: throw new Error(`no outcome for routing action ${String(action)}`);
  }
}

/**
 * One outcome per read row, in read order. A row with a decision gets that decision's outcome; a row with
 * none (the source cap collapsed it) is let be. A decision for a synthetic event (a collapse summary) answers
 * no read row and is dropped. Two decisions for one row is an impossible state and fails loud.
 */
export function outcomesFor(read: ReadRef[], decisions: Array<Pick<Decision, "action" | "reason" | "event">>, sent: ReadonlyMap<string, boolean> = new Map()): RowOutcome[] {
  const byEvent = new Map<string, Pick<Decision, "action" | "reason" | "event">>();
  for (const d of decisions) {
    if (d.event.id.startsWith("collapsed:")) continue;
    invariant(!byEvent.has(d.event.id), `one routing decision per event: ${d.event.id}`);
    byEvent.set(d.event.id, d);
  }
  const seen = new Set<string>();
  const out = read.map((r): RowOutcome => {
    invariant(!seen.has(r.row_id), `a row is read once per tick: ${r.row_id}`);
    seen.add(r.row_id);
    const d = byEvent.get(r.event_id);
    const o = d ? outcomeOf(d, sent.get(r.event_id)) : { outcome: "let_be" as const, reason: COLLAPSED_REASON };
    return { answers: r.row_id, event_id: r.event_id, ...o };
  });
  invariant(out.length === read.length && out.every((o) => (OUTCOMES as readonly string[]).includes(o.outcome)), "every read row ends in exactly one of the six outcomes");
  return out;
}
