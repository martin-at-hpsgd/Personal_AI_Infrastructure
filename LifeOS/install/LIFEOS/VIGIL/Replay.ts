/**
 * Replay — what a new text source would have done to the last N days of texts, read-only.
 *
 * Before a new source may text, the real text
 * ledger is replayed with that source's events added. The added events go through the real
 * router (Route.ts route) at their own moment, against the real daily budget (every origin's
 * texts from the interruption ledger before that moment, plus the added texts already sent),
 * the per-source cap, the 72h story hold and quiet hours. Then every text Vigil itself sent in
 * the window is checked: had the added texts been there, would the budget have been spent
 * before it, so it would have been held? That count is `displaced`, and the pass condition is
 * at most one added text in any rolling 24 hours and nothing displaced.
 *
 * The added events are synthetic and worst-case: `perDay` high events from the source in each
 * 24 hours, spaced evenly. Nothing here writes: no cursor, no outbox line, no ledger line.
 *
 * @version 1.0.0
 */
import { existsSync, readFileSync } from "node:fs";
import { route, ceilingExempt, fixedJob, storyKeyOf, type SentStory } from "./Route";
import type { VigilPolicy } from "./Policy";
import type { VigilEvent } from "./Schema";

const DAY = 86_400_000;
/** The router's own send and the ledger row Relay writes for it are stamped a moment apart; the one row this close to a send is that send. */
const SAME_SEND_MS = 2_000;

export type SentText = { ts: string; source: string };
/** One text Vigil sent: when, the event it was about (null when the outbox no longer holds it), and its story key. */
export type VigilSent = { ts: string; event: VigilEvent | null; key: string };
export type ReplayReport = {
  window: { from: string; to: string }; days: number; cap: number; source: string;
  ledger_found: boolean; unjoined_sends: number; ledger_texts: number; vigil_texts: number; budget_bound: number;
  injected: number; delta_texts: number; delta_held: Record<string, number>;
  per_day: Record<string, number>; max_per_day: number; max_rolling_24h: number;
  displaced: Array<{ ts: string; source: string; key: string }>;
  pass: boolean;
};

/** Worst-case added events: `perDay` high events from `source` in each of the last `days` 24-hour spans, evenly spaced. */
export function injectedEvents(source: string, now: Date, days: number, perDay: number): VigilEvent[] {
  const start = now.getTime() - days * DAY, out: VigilEvent[] = [];
  for (let d = 0; d < days; d++) for (let k = 0; k < perDay; k++) {
    // One minute later each day, so each day's first event falls just outside the previous day's 24 hours.
    const ts = new Date(start + d * DAY + 3_600_000 + d * 60_000 + k * Math.floor(DAY / Math.max(perDay, 1) / 2)).toISOString();
    const id = `replay-${source}-${d}-${k}`;
    out.push({ id, source, ts, kind: "life", severity: "high", title: `Replayed ${source} event`, summary: "Synthetic replay event; never emitted.", ref: id, url: null, privacy_class: "personal", dedup_key: `${source}:replay-${d}-${k}:close-now:${ts.slice(0, 10)}` });
  }
  return out;
}

/** Pure: the replay over the given ledger, Vigil's sends and the added events. */
export function replayWith(o: { now: Date; days: number; cap: number; policy: VigilPolicy; ledger: SentText[]; ledgerFound?: boolean; vigilSent: VigilSent[]; injected: VigilEvent[]; quietAt: (ts: string) => boolean }): ReplayReport {
  const from = o.now.getTime() - o.days * DAY, inWindow = (ts: string) => { const t = Date.parse(ts); return t >= from && t <= o.now.getTime(); };
  const ledger = o.ledger.filter((x) => Number.isFinite(Date.parse(x.ts)));
  const realStories: SentStory[] = o.vigilSent.map((s) => ({ key: s.key, ts: s.ts, ...(s.event ? { severity: s.event.severity, source: s.event.source } : {}) }));
  const deltaSent: string[] = [], deltaStories: SentStory[] = [], held: Record<string, number> = {};
  const source = o.injected[0]?.source ?? "";
  for (const e of [...o.injected].filter((x) => inWindow(x.ts)).sort((a, b) => a.ts.localeCompare(b.ts))) {
    const at = Date.parse(e.ts), before = (ts: string) => Date.parse(ts) <= at;
    const budget = { cap: o.cap, texts: [...ledger.filter((x) => before(x.ts)).map((x) => x.ts), ...deltaSent], source: "ledger" as const };
    const [d] = route([e], { policy: o.policy, recentTexts: [], now: new Date(at), sentStories: [...realStories.filter((s) => before(s.ts)), ...deltaStories], quiet: o.quietAt(e.ts), budget });
    if (d?.action === "text") { deltaSent.push(e.ts); deltaStories.push({ key: storyKeyOf(e), ts: e.ts, severity: e.severity, source: e.source }); }
    else { const why = d ? (d.action === "held" ? d.reason : `${d.action}: ${d.reason}`) : "dropped"; held[why] = (held[why] ?? 0) + 1; }
  }
  // Which of Vigil's own sends were budget-bound, and which of those the added texts would have pushed past the budget.
  const sends = o.vigilSent.filter((s) => inWindow(s.ts));
  const bound = sends.filter((s) => s.event && s.event.severity !== "critical" && !ceilingExempt(s.event, o.policy) && !fixedJob(s.event));
  const displaced: ReplayReport["displaced"] = [];
  for (const s of bound) {
    const t = Date.parse(s.ts), lo = t - DAY;
    // The send's own ledger row is the one row nearest it within SAME_SEND_MS; every other row before it counts, however close.
    let own = -1, ownGap = Infinity; ledger.forEach((x, i) => { const g = Math.abs(Date.parse(x.ts) - t); if (g <= SAME_SEND_MS && g < ownGap) { own = i; ownGap = g; } });
    const usedBefore = ledger.filter((x, i) => { const u = Date.parse(x.ts); return i !== own && u >= lo && u < t; }).length;
    const added = deltaSent.filter((ts) => { const u = Date.parse(ts); return u >= lo && u < t; }).length;
    if (usedBefore < o.cap && usedBefore + added >= o.cap) displaced.push({ ts: s.ts, source: s.event!.source, key: s.key });
  }
  const per_day: Record<string, number> = {};
  for (const ts of deltaSent) per_day[ts.slice(0, 10)] = (per_day[ts.slice(0, 10)] ?? 0) + 1;
  const max_rolling_24h = deltaSent.reduce((m, ts) => { const t = Date.parse(ts); return Math.max(m, deltaSent.filter((u) => { const x = Date.parse(u); return x > t - DAY && x <= t; }).length); }, 0);
  const max_per_day = Math.max(0, ...Object.values(per_day));
  return {
    window: { from: new Date(from).toISOString(), to: o.now.toISOString() }, days: o.days, cap: o.cap, source,
    ledger_found: o.ledgerFound !== false, unjoined_sends: sends.filter((s) => !s.event).length, ledger_texts: ledger.filter((x) => inWindow(x.ts)).length, vigil_texts: sends.length, budget_bound: bound.length,
    injected: o.injected.length, delta_texts: deltaSent.length, delta_held: held, per_day, max_per_day, max_rolling_24h,
    displaced, pass: o.ledgerFound !== false && sends.every((s) => s.event) && max_rolling_24h <= 1 && displaced.length === 0,
  };
}

const jsonl = <T>(path: string): T[] => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } }) : [];

/** The interruption ledger's texts, minus replies the principal asked for (the same rule as Tick.ts readTextLedger, without its test guard). */
export function readLedgerTexts(path: string): SentText[] {
  return jsonl<{ ts?: unknown; kind?: unknown; source?: unknown }>(path).flatMap((r) => r.kind === "text" && r.source !== "relay/requested" && typeof r.ts === "string" && Number.isFinite(Date.parse(r.ts)) ? [{ ts: r.ts, source: String(r.source ?? "") }] : []);
}

/** Every text Vigil itself sent, from its notification rows, each joined to the event it was about. */
export function readVigilSent(events: VigilEvent[]): VigilSent[] {
  const byId = new Map(events.filter((e) => e.source !== "vigil").map((e) => [e.id, e] as const));
  return events.filter((e) => e.source === "vigil" && e.kind === "notification" && e.meta?.decision === "sent" && e.meta?.shadow !== true).map((n) => {
    const event = n.ref ? byId.get(n.ref) ?? null : null;
    const key = typeof n.meta?.key === "string" ? n.meta.key : event ? storyKeyOf(event) : `unknown:${n.ref ?? n.id}`;
    return { ts: n.ts, event, key };
  });
}
