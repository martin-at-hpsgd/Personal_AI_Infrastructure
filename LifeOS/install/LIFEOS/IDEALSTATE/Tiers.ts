/**
 * Tiers — how loudly each bound ideal-state gap reaches the principal.
 *
 * Every bound row in a reconcile gets exactly one tier, and each tier has one path:
 *
 *   on-track     on pace, or behind the line by no more than DRIFT_TOLERANCE      → nothing
 *   drift        off pace beyond the tolerance, something is moving it           → Pulse only (/current)
 *   close-now    off pace with the deadline inside CLOSE_NOW_WINDOW_DAYS, or a
 *                sensor that read before and has been dark DEAD_SENSOR_DAYS       → one high Vigil event (a text)
 *   needs-input  the next move needs his judgment: the deadline passed, nothing
 *                moves the row and no move is proposed, the binding never read,
 *                or the binding has no measurement reason he approved           → a Review decision
 *
 * Pure: reconcile passes the readings, history and stores in; nothing here reads or writes a file.
 *
 * The windows answer the ISA's open question ("which deadline window turns off-track into
 * close-now"). They are code constants, chosen before any real pace data exists, and should be
 * revisited once 20 rows are bound:
 *   - 30 days: one monthly cycle is the shortest span in which a daily habit or a sprint can
 *     still move most targets; a closer deadline leaves too little room to act on a text.
 *   - 10% of the baseline-to-target span: a reading that noisy (a 7-day average swinging) is
 *     not a gap worth a page entry.
 *   - 3 days: a wearable or a cache that misses one daily refresh is ordinary; three in a row
 *     means the measurement is gone and every target on it is blind.
 *
 * @version 1.0.0
 */
import type { PursuitRow } from "./Pursuit";
import type { Rec } from "./Recommend";
import type { RowReport } from "./Reconcile";
import { formatMeasure, rowRef, type Row } from "./Rows";

export const TIERS = ["on-track", "drift", "close-now", "needs-input"] as const;
export type Tier = (typeof TIERS)[number];

/** Off-track with the deadline this many days out or fewer is close-now. */
export const CLOSE_NOW_WINDOW_DAYS = 30;
/** Behind the straight line by at most this fraction of the baseline-to-target span still counts as on pace. */
export const DRIFT_TOLERANCE = 0.1;
/** A sensor that read before and has not read for this many days is dead. */
export const DEAD_SENSOR_DAYS = 3;

const DAY = 86_400_000;

export type NextMove = { kind: "action" | "build" | "binding" | "decision"; text: string; ref?: string };
export type Reason = { ok: boolean; why: string };
export type TierContext = {
  now: Date;
  /** When this row last read a value (this run included); null when it never has. */
  lastGood: string | null;
  /** Whether the row's current binding carries a measurement reason he approved. */
  reason: Reason;
  pursuit?: Pick<PursuitRow, "state" | "links">;
  /** An open build recommendation that serves this row. */
  openBuild?: { id: string; title: string };
  /** An open binding recommendation for this row. */
  openBinding?: { id: string };
};
export type TierResult = { tier: Tier; why: string; next_move: NextMove | null };

const daysTo = (by: string, now: Date): number => Math.ceil((Date.parse(`${by}T00:00:00Z`) - now.getTime()) / DAY);

/** How far behind the straight line a numeric row is, as a fraction of its baseline-to-target span. Null when it cannot be computed. */
export function gapFraction(r: RowReport, now: Date): number | null {
  if (r.value === null || r.baseline === null || !r.baseline_ts || !r.by || r.question) return null;
  const span = r.target - r.baseline;
  if (span === 0) return Math.abs(r.value - r.target) / Math.max(Math.abs(r.target), 1e-9);
  const t0 = Date.parse(r.baseline_ts), t1 = Date.parse(`${r.by}T00:00:00Z`);
  const f = t1 <= t0 ? 1 : Math.max(0, Math.min(1, (now.getTime() - t0) / (t1 - t0)));
  const expected = r.baseline + span * f;
  return ((expected - r.value) * Math.sign(span)) / Math.abs(span);
}

/** The move already in hand for a row: what pursues it, an open build for it, or an open binding for it. */
export function nextMove(r: RowReport, ctx: TierContext): NextMove | null {
  const live = (ctx.pursuit?.links ?? []).filter((l) => l.live);
  if (ctx.pursuit?.state === "pursued" && live.length) return { kind: "action", text: `${live.map((l) => `${l.kind}/${l.name}`).join(", ")} is moving it`, ref: `${live[0]!.kind}/${live[0]!.name}` };
  if (ctx.openBuild) return { kind: "build", text: `proposed build waiting for a yes: ${ctx.openBuild.title}`, ref: ctx.openBuild.id };
  if (r.state === "unreadable" && ctx.openBinding) return { kind: "binding", text: "a new measurement is proposed, waiting for a yes", ref: ctx.openBinding.id };
  return null;
}

/** One tier per bound row. Close-now outranks needs-input, which outranks drift. */
export function assignTier(r: RowReport, ctx: TierContext): TierResult {
  const move = nextMove(r, ctx);
  const done = (tier: Tier, why: string): TierResult => ({ tier, why, next_move: move ?? (tier === "on-track" ? null : { kind: "decision", text: why }) });
  const days = r.by ? daysTo(r.by, ctx.now) : null;

  if (r.state === "unreadable") {
    const dark = ctx.lastGood ? (ctx.now.getTime() - Date.parse(ctx.lastGood)) / DAY : null;
    if (dark !== null && dark >= DEAD_SENSOR_DAYS) return done("close-now", `its measurement went dead: no reading since ${ctx.lastGood!.slice(0, 10)}`);
    if (dark === null) return done("needs-input", `its measurement has never read${r.error ? ` (${r.error})` : ""}`);
    return done("drift", `no reading for ${Math.floor(dark)} day(s)`);
  }
  if (!ctx.reason.ok) return done("needs-input", ctx.reason.why);
  if (r.state === "on-track") return done("on-track", "on pace");

  const gap = gapFraction(r, ctx.now);
  if (gap !== null && gap <= DRIFT_TOLERANCE) return done("on-track", `behind the line by ${Math.round(gap * 100)}%, inside the ${Math.round(DRIFT_TOLERANCE * 100)}% tolerance`);
  if (days !== null && days < 0) return done("needs-input", `its date ${r.by} passed with the target unmet`);
  if (days !== null && days <= CLOSE_NOW_WINDOW_DAYS) return done("close-now", `off pace with ${days} day(s) left`);
  if (!move) return done("needs-input", "off pace, nothing moves it and no move is proposed");
  return done("drift", gap === null ? "off pace" : `behind the line by ${Math.round(gap * 100)}% of the way to target`);
}

/**
 * The measurement reason he approved for a bound row: an accepted binding recommendation for this row
 * (Bind.ts batch or Recommend accept) with a reason, for the same measurement the row carries now.
 */
export function measurementReason(recs: Rec[], row: Row): Reason {
  if (!row.measure) return { ok: false, why: "not bound" };
  const ref = rowRef(row);
  const mine = recs.filter((r) => r.kind === "binding" && r.status === "accepted" && (r.row_key === ref || r.row_key === row.key));
  const reasoned = mine.filter((r) => (r.why ?? "").trim().length > 0);
  if (!reasoned.length) return { ok: false, why: mine.length ? "its binding was approved without a measurement reason" : "its binding has no approved measurement reason" };
  const now = formatMeasure(row.measure);
  if (reasoned.some((r) => r.measure && formatMeasure(r.measure) === now)) return { ok: true, why: reasoned.at(-1)!.why!.trim() };
  return { ok: false, why: "its approved measurement reason was for a different measurement" };
}

export type TierTally = Record<Tier, number>;
export const tally = (rows: Array<{ tier?: Tier }>): TierTally => Object.fromEntries(TIERS.map((t) => [t, rows.filter((r) => r.tier === t).length])) as TierTally;
