/**
 * @version 1.0.0
 * Trigger.ts — files the label model's confident misses into Errata as source `detected`.
 *
 * A human turn qualifies when its ds-v1 P(bad) is at or above the cut `label` chose on the gold set
 * (meta `trigger_cut`) and no Errata row of any source already judges it (Queries.judgedHumanTurn).
 * At most MAX_PER_RUN rows per run, highest P(bad) first. Each row carries dedupe key
 * `evidence:<span_id>`, so a second run appends nothing. The complaint field is a machine description
 * (which functions voted, P(bad)), never the principal's words. Writes go only to the Errata ledger and
 * to the index's meta table.
 *
 * The row's ts is placed so Errata's own join lands on the turn: the next human prompt's timestamp
 * when one exists (the reaction is the "own prompt", the judged turn is the one before it), otherwise
 * after the last turn of the stretch and more than OWN_PROMPT_WINDOW_MS after the human prompt.
 */
import type { Database } from "bun:sqlite";
import { ErrataStore } from "../ERRATA/Store";
import { invariant } from "../TOOLS/Invariant";
import { LABEL_SOURCE, errataByTurn } from "./Label";
import { OWN_PROMPT_WINDOW_MS, turnsBySession } from "./Queries";

export const MAX_PER_RUN = 10;
/** A turn is only considered once it is this old, so a live session is not judged mid-flight. */
export const MIN_AGE_MS = 60 * 60 * 1000;
export const dedupeKey = (spanId: string) => `evidence:${spanId}`;

export interface TriggerOptions { dryRun: boolean; errataDir?: string; tenantDir?: string; max?: number; now?: number }
export interface Planned { span_id: string; session_id: string; p_bad: number; ts: string; complaint: string; appended: boolean }
export interface TriggerResult {
  dry_run: boolean; cut: number | null; reason?: string; qualifying: number; already_linked: number; already_filed: number;
  too_fresh: number; no_bad_vote: number; planned: Planned[]; appended: number;
}

interface Cand { span_id: string; trace_id: string; start_time: string; p: number; has_next: number | null; next_start: string | null; act_model: string | null }

export function trigger(db: Database, o: TriggerOptions): TriggerResult {
  const max = o.max ?? MAX_PER_RUN;
  invariant(Number.isInteger(max) && max >= 0 && max <= MAX_PER_RUN, `max per run must be 0..${MAX_PER_RUN}, got ${max}`);
  const now = o.now ?? Date.now();
  const res: TriggerResult = { dry_run: o.dryRun, cut: null, qualifying: 0, already_linked: 0, already_filed: 0, too_fresh: 0, no_bad_vote: 0, planned: [], appended: 0 };
  const meta = db.query("SELECT value FROM meta WHERE key = 'trigger_cut'").get() as { value: string } | null;
  if (!meta) { res.reason = "no trigger_cut: run `Project.ts label` with the gold set present; no gold cut reached precision 0.8"; return res; }
  const cut = Number(JSON.parse(meta.value).cut);
  invariant(Number.isFinite(cut) && cut > 0 && cut <= 1, `trigger_cut ${cut} out of range`);
  res.cut = cut;

  const cands = db.query(`SELECT s.span_id, s.trace_id, s.start_time, sc.value AS p, r.has_next, n.start_time AS next_start, d.act_model
    FROM scores sc JOIN spans s USING (span_id) LEFT JOIN reactions r USING (span_id) LEFT JOIN spans n ON n.span_id = r.next_span_id LEFT JOIN decisions d ON d.span_id = s.span_id
    WHERE sc.source = ? AND sc.value >= ? AND s.origin = 'human' AND s.parent_span_id IS NULL
    ORDER BY sc.value DESC, s.start_time DESC, s.span_id`).all(LABEL_SOURCE, cut) as Cand[];
  res.qualifying = cands.length;
  if (!cands.length) return res;

  const store = o.errataDir ? new ErrataStore(o.errataDir, o.tenantDir ?? o.errataDir) : new ErrataStore();
  const sessions = turnsBySession(db);
  const linked = errataByTurn(sessions, store.all());
  const votesQ = db.query("SELECT fn, vote FROM votes WHERE span_id = ? AND vote IS NOT NULL ORDER BY fn");

  for (const c of cands) {
    if (res.planned.length >= max) break;
    if (linked.has(c.span_id)) { res.already_linked++; continue; }
    if (store.hasDedupeKey(dedupeKey(c.span_id))) { res.already_filed++; continue; }
    const start = Date.parse(c.start_time);
    if (now - start < MIN_AGE_MS) { res.too_fresh++; continue; }
    // A detection needs evidence: a turn no function voted bad on scores near the prior (silent turns do), and a prior is not a miss.
    const votes = votesQ.all(c.span_id) as Array<{ fn: string; vote: number }>;
    const bad = votes.filter((v) => v.vote === 1).map((v) => v.fn);
    if (!bad.length) { res.no_bad_vote++; continue; }
    let ts: string;
    if (c.has_next === 1 && c.next_start) ts = c.next_start;
    else {
      const stretch = (sessions.get(c.trace_id) ?? []).filter((t) => t.ms >= start);
      const last = stretch.length ? Math.max(...stretch.map((t) => t.ms)) : start;
      ts = new Date(Math.max(last, start + OWN_PROMPT_WINDOW_MS + 1000)).toISOString();
    }
    const good = votes.filter((v) => v.vote === 0).map((v) => v.fn);
    const complaint = `evidence detector: P(bad)=${c.p.toFixed(3)} (${LABEL_SOURCE}, cut ${cut.toFixed(3)}); voted bad: ${bad.join(", ") || "none"}; voted good: ${good.join(", ") || "none"}`;
    res.planned.push({ span_id: c.span_id, session_id: c.trace_id, p_bad: c.p, ts, complaint, appended: false });
  }
  invariant(res.planned.length <= max, `planned ${res.planned.length} rows, cap ${max}`);
  if (o.dryRun) return res;

  for (const pl of res.planned) {
    const e = store.append({
      system: "lifeos", source: "detected", channel: "backfill", kind: "complaint", ts: pl.ts,
      complaint: pl.complaint,
      context: { session_id: pl.session_id, model: cands.find((c) => c.span_id === pl.span_id)?.act_model ?? null, component: "evidence-projector" },
      reporter: { id: "evidence-projector", role: "system" },
      dedupe_key: dedupeKey(pl.span_id), tags: ["evidence", LABEL_SOURCE],
    });
    pl.appended = e !== null;
    if (e) res.appended++;
  }
  invariant(res.appended <= max, `appended ${res.appended} rows, cap ${max}`);
  db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_trigger', ?)").run(JSON.stringify({ ts: new Date(now).toISOString(), cut, appended: res.appended, qualifying: res.qualifying }));
  return res;
}
