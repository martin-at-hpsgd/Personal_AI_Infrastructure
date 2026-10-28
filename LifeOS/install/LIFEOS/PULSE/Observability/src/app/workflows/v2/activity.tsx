"use client";

/**
 * Activity tab: every real run the sources record, newest first, one dense
 * line each, grouped under a day header in the principal's zone. A line expands to the
 * run's detail; a typed-workflow run also shows each step's actual input and
 * output from the value store, or "not stored" with the reason (ISC-23).
 * Nothing here is synthesized: typed workflows contribute their ledger runs,
 * agent jobs their per-run log, every other workflow at most its last run.
 *
 * Filtering (ISC-104): the page's one search box searches runs; the chips
 * filter by outcome and by trigger kind. Both live in the query string.
 */

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, History, Network } from "lucide-react";
import { EmptyState } from "@/components/ui/chrome";
import { RUNTIME_META, clock24, dayKeyTz, dayLabelTz, hhmm, type WorkflowRecord } from "../shared";
import { PathText } from "../strip";
import { getJson, parseRunValues, type ActivityResponse, type ActivityRow, type RunValues } from "./api";
import { AppIcons } from "./app-icons";
import {
  CORE_OUTCOMES,
  OUTCOMES,
  OUTCOME_LABEL,
  facetCounts,
  filterRuns,
  outcomeOf,
  triggerKey,
  triggerLabel,
  type Outcome,
} from "./activity-model";
import { StatusMark, formatDuration } from "./status";

const PAGE = 300;
const STAGE_GLYPH: Record<WorkflowRecord["card"]["steps"][number]["executor"], string> = { code: "■", model: "●", judgment: "◆", human: "▲", unknown: "·" };

type ValuesLoad = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; value: RunValues };

/** One typed run's steps: ledger status and timing, plus the stored values fetched on open. */
function RunSteps({ row }: { row: ActivityRow }) {
  const [load, setLoad] = useState<ValuesLoad>({ state: "loading" });
  const runId = row.runId;
  useEffect(() => {
    if (!runId) return;
    let live = true;
    getJson(`/api/workflows/run-values?run=${encodeURIComponent(runId)}`)
      .then((raw) => {
        const p = parseRunValues(raw);
        if (live) setLoad(p.ok ? { state: "ready", value: p.value } : { state: "error", message: p.reason });
      })
      .catch((e: unknown) => { if (live) setLoad({ state: "error", message: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [runId]);

  const steps = row.steps ?? [];
  const byId = load.state === "ready" ? new Map(load.value.steps.map((s) => [s.id, s])) : null;
  return (
    <div className="wf2-steps" aria-label={`Steps of run ${runId}`}>
      <div className="wf2-steps-head">
        Steps <span className="wf2-muted">· data class {row.dataClass ?? "unknown"}</span>
        {load.state === "loading" && <span className="wf2-muted"> · reading stored values…</span>}
        {load.state === "error" && <span className="wf2-steps-err"> · stored values could not be loaded: {load.message}</span>}
      </div>
      {steps.length === 0 && <p className="wf2-muted">The ledger lists no steps for this run.</p>}
      <ol>
        {steps.map((s) => {
          const v = byId?.get(s.id);
          return (
            <li key={s.id} className="wf2-step" data-status={s.status}>
              <div className="wf2-step-line">
                <span className="mono wf2-step-id">{s.id}</span>
                <span className="wf2-step-status" data-status={s.status}>{s.timedOut ? "timed out" : s.status}</span>
                <span className="mono wf2-muted">{s.startedAt ? hhmm(s.startedAt) : "not started"} · {formatDuration(s.durationMs)}{s.attempts > 1 ? ` · ${s.attempts} attempts` : ""}</span>
              </div>
              {s.error && <div className="wf2-log-note wf2-step-error">{s.error}</div>}
              {v && v.stored && (
                <div className="wf2-step-values">
                  <div><span className="wf2-step-k">input</span><pre className="mono">{v.input}</pre></div>
                  <div><span className="wf2-step-k">output</span><pre className="mono">{v.output}</pre></div>
                </div>
              )}
              {v && !v.stored && <div className="wf2-step-absent"><strong>not stored</strong> · {v.reason}</div>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Chip({ on, count, onClick, children, label }: { on: boolean; count: number; onClick: () => void; children: React.ReactNode; label: string }) {
  return (
    <button type="button" className="wf2-fchip" aria-pressed={on} aria-label={`${label}, ${count} run${count === 1 ? "" : "s"}`} onClick={onClick} data-zero={count === 0 && !on ? "1" : undefined}>
      {children} <span className="mono wf2-muted">{count.toLocaleString("en-US")}</span>
    </button>
  );
}

export function ActivityLog({
  activity,
  problem,
  rows,
  byId,
  q,
  outcomes,
  setOutcomes,
  trigger,
  setTrigger,
  onView,
  onOpenCard,
}: {
  activity: ActivityResponse | null;
  problem: string | null;
  /** Rows after the page's runtime filter; search and the chips apply here. */
  rows: ActivityRow[];
  byId: Map<string, WorkflowRecord>;
  q: string;
  outcomes: ReadonlySet<Outcome>;
  setOutcomes: (o: Set<Outcome>) => void;
  trigger: string | null;
  setTrigger: (t: string | null) => void;
  onView: (id: string) => void;
  onOpenCard: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [allOpen, setAllOpen] = useState(false);
  const [shown, setShown] = useState(PAGE);

  const titleOf = useMemo(() => (id: string) => byId.get(id)?.title, [byId]);
  const filter = useMemo(() => ({ q, outcomes, trigger }), [q, outcomes, trigger]);
  const visible = useMemo(() => filterRuns(rows, titleOf, filter), [rows, titleOf, filter]);
  const facets = useMemo(() => facetCounts(rows, titleOf, filter), [rows, titleOf, filter]);
  const page = visible.slice(0, shown);

  if (!activity) {
    return (
      <EmptyState
        icon={History}
        title={problem ? "Activity could not be loaded" : "Reading the run history…"}
        hint={problem ?? "Asking /api/workflows/activity for every recorded run."}
      />
    );
  }

  const toggle = (key: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const isOpen = (key: string) => (allOpen ? !expanded.has(key) : expanded.has(key));
  const flipOutcome = (o: Outcome) => {
    const next = new Set(outcomes);
    if (next.has(o)) next.delete(o);
    else next.add(o);
    setOutcomes(next);
  };
  const shownOutcomes = OUTCOMES.filter((o) => CORE_OUTCOMES.includes(o) || (facets.outcomes.get(o) ?? 0) > 0 || outcomes.has(o));
  const triggerKinds = [...new Set([...facets.triggers.keys(), ...(trigger ? [trigger] : [])])].sort((a, b) => triggerLabel(a).localeCompare(triggerLabel(b)));
  const filtered = outcomes.size > 0 || trigger !== null || q.trim() !== "";

  let lastDay = "";
  return (
    <div className="wf2-log">
      <div className="wf2-log-head">
        <span className="wf2-section-title wf2-flat">
          Activity log <span className="mono wf2-muted">{visible.length.toLocaleString("en-US")} entries</span>
        </span>
        {activity.truncated && (
          <span className="wf2-muted">newest {activity.rows.length.toLocaleString("en-US")} of {activity.total.toLocaleString("en-US")} recorded runs</span>
        )}
        <span className="wf2-log-tools">
          <button type="button" className="wf2-act" onClick={() => { setAllOpen(!allOpen); setExpanded(new Set()); }}>
            {allOpen ? <ChevronsDownUp size={13} aria-hidden /> : <ChevronsUpDown size={13} aria-hidden />}
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        </span>
      </div>

      <div className="wf2-facets">
        <div className="wf2-facet" role="group" aria-label="Filter runs by outcome">
          <span className="wf2-facet-k">Outcome</span>
          <button type="button" className="wf2-fchip" aria-pressed={outcomes.size === 0} onClick={() => setOutcomes(new Set())}>All</button>
          {shownOutcomes.map((o) => (
            <Chip key={o} on={outcomes.has(o)} count={facets.outcomes.get(o) ?? 0} onClick={() => flipOutcome(o)} label={OUTCOME_LABEL[o]}>
              <span className="wf2-fdot" data-o={o} aria-hidden />{OUTCOME_LABEL[o]}
            </Chip>
          ))}
        </div>
        <div className="wf2-facet" role="group" aria-label="Filter runs by trigger kind">
          <span className="wf2-facet-k">Trigger</span>
          <button type="button" className="wf2-fchip" aria-pressed={trigger === null} onClick={() => setTrigger(null)}>All</button>
          {triggerKinds.map((t) => (
            <Chip key={t} on={trigger === t} count={facets.triggers.get(t) ?? 0} onClick={() => setTrigger(trigger === t ? null : t)} label={triggerLabel(t)}>
              {triggerLabel(t)}
            </Chip>
          ))}
        </div>
      </div>

      {activity.errors.length > 0 && (
        <div className="wf-notice" data-tone="warn">
          {activity.errors.length} run log{activity.errors.length === 1 ? "" : "s"} could not be read: {activity.errors.map((e) => e.source).join(", ")}. Those workflows show only their last recorded run.
        </div>
      )}

      {visible.length === 0 ? (
        <EmptyState
          icon={History}
          title={activity.rows.length === 0 ? "No run is recorded anywhere yet" : "No run matches"}
          hint={
            activity.rows.length === 0
              ? "None of the workflows' sources records a run with a time. Nothing is shown rather than guessed."
              : filtered
                ? "Nothing in the recorded runs matches the search, outcome or trigger filter."
                : "Nothing in the recorded runs matches the runtime filter."
          }
        />
      ) : (
        <ol className="wf2-log-list">
          {page.flatMap((a) => {
            const r = byId.get(a.recordId);
            const day = dayKeyTz(a.at);
            const header = day !== lastDay ? <li key={`day:${day}`} className="wf2-log-day">{dayLabelTz(a.at)}</li> : null;
            lastDay = day;
            const open = isOpen(a.key);
            const outcome = outcomeOf(a);
            return [
              header,
              <li key={a.key} className="wf2-log-row" data-open={open ? "1" : undefined} data-status={a.status}>
                <button type="button" className="wf2-log-line" aria-expanded={open} onClick={() => toggle(a.key)}>
                  {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                  <span className="mono wf2-log-time">{hhmm(a.at)}</span>
                  <span className="wf2-dot" style={{ background: r ? RUNTIME_META[r.runtime].color : "var(--ink-3)" }} aria-hidden />
                  <span className="wf2-log-titlecell">
                    <span className="wf2-log-title">“{r?.title ?? a.recordId}”</span>
                    <AppIcons apps={r?.apps} />
                  </span>
                  <span className="wf2-muted wf2-log-trigger">
                    {a.origin === "run-log" ? "ran" : "last ran"} ({r?.trigger.display ?? triggerLabel(a.trigger)}){a.dryRun ? " · dry run" : ""}
                    {outcome === "timed_out" ? " · timed out" : outcome === "stopped" ? " · stopped" : ""}
                  </span>
                  <span className="wf2-log-stages" aria-hidden title={r ? r.card.steps.map((s) => `${s.label} (${s.executor})`).join(" → ") : undefined}>
                    {r && r.card.steps.length > 0 && (
                      <>
                        <i data-x="trigger">◇</i>
                        {r.card.steps.map((s) => <span key={s.id}><b /><i data-x={s.executor}>{STAGE_GLYPH[s.executor]}</i></span>)}
                        <b /><i data-x="output">□</i>
                      </>
                    )}
                  </span>
                  <StatusMark status={a.status} />
                  <span className="mono wf2-muted wf2-log-dur">{formatDuration(a.durationMs)}</span>
                </button>
                {open && (
                  <div className="wf2-log-detail">
                    <dl>
                      <div><dt>Started</dt><dd className="mono">{a.startedAt ? clock24(a.startedAt) : a.origin === "evidence" ? clock24(a.at) : "not in the log"}</dd></div>
                      <div><dt>Ended</dt><dd className="mono">{a.endedAt ? clock24(a.endedAt) : "—"}</dd></div>
                      <div><dt>Duration</dt><dd className="mono">{formatDuration(a.durationMs)}</dd></div>
                      <div><dt>Outcome</dt><dd>{OUTCOME_LABEL[outcome]}</dd></div>
                      <div><dt>Trigger</dt><dd>{triggerLabel(triggerKey(a) === "unknown" ? null : a.trigger)}</dd></div>
                      <div><dt>Workflow</dt><dd className="mono">{a.recordId}</dd></div>
                      {a.runId && <div><dt>Run id</dt><dd className="mono">{a.runId}</dd></div>}
                      <div><dt>Source</dt><dd className="mono">{a.source ? <PathText value={a.source} /> : "—"}</dd></div>
                      {a.events.length > 0 && <div><dt>Events</dt><dd className="mono">{a.events.join(" → ")}</dd></div>}
                      {a.detail && <div><dt>{a.status === "error" ? "Error" : "Note"}</dt><dd className="wf2-log-note">{a.detail}</dd></div>}
                    </dl>
                    {a.runId && <RunSteps row={a} />}
                    <div className="wf2-log-actions">
                      <button type="button" className="wf2-act" data-tone="view" onClick={() => onView(a.recordId)}>
                        <Network size={13} aria-hidden /> View in Pipeline
                      </button>
                      <button type="button" className="wf2-act" onClick={() => onOpenCard(a.recordId)}>Open card</button>
                    </div>
                  </div>
                )}
              </li>,
            ];
          })}
        </ol>
      )}
      {visible.length > shown && (
        <div className="wf-center">
          <button type="button" className="wf-refresh" onClick={() => setShown((n) => n + PAGE)}>
            Show {Math.min(PAGE, visible.length - shown)} more of {(visible.length - shown).toLocaleString("en-US")}
          </button>
        </div>
      )}
    </div>
  );
}

export function ActivityStyles() {
  return (
    <style>{`
.wf2-facets{display:flex;flex-direction:column;gap:6px;margin:4px 0 12px}
.wf2-facet{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.wf2-facet-k{font-size:11px;text-transform:uppercase;letter-spacing:.06em;opacity:.6;min-width:64px}
.wf2-fchip{display:inline-flex;gap:6px;align-items:center;border:1px solid var(--line,#333);background:transparent;color:inherit;border-radius:999px;padding:3px 10px;font-size:12px;cursor:pointer}
.wf2-fchip[aria-pressed="true"]{background:var(--ink-1,#eee);color:var(--bg,#111)}
.wf2-fchip[data-zero="1"]{opacity:.55}
.wf2-fchip:focus-visible{outline:2px solid #3b82f6;outline-offset:2px}
.wf2-fdot{width:8px;height:8px;border-radius:50%;background:var(--ink-3,#888)}
.wf2-fdot[data-o="succeeded"]{background:var(--ok,#22c55e)}
.wf2-fdot[data-o="failed"]{background:var(--err,#ef4444)}
.wf2-fdot[data-o="timed_out"]{background:#f97316}
.wf2-fdot[data-o="abandoned"]{background:var(--warn,#f59e0b)}
.wf2-fdot[data-o="stopped"]{background:#94a3b8}
.wf2-fdot[data-o="running"]{background:#3b82f6}
.wf2-steps{margin:10px 0;border-top:1px solid var(--line,#2a2a2a);padding-top:10px}
.wf2-steps-head{font-size:12px;font-weight:600;margin-bottom:6px}
.wf2-steps-err{color:var(--err)}
.wf2-steps ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.wf2-step{border:1px solid var(--line,#2a2a2a);border-radius:8px;padding:8px 10px}
.wf2-step-line{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;font-size:12px}
.wf2-step-id{font-weight:600}
.wf2-step-status{font-size:11px;border-radius:999px;padding:1px 8px;border:1px solid var(--line,#333)}
.wf2-step-status[data-status="succeeded"]{color:var(--ok);border-color:currentColor}
.wf2-step-status[data-status="failed"]{color:var(--err);border-color:currentColor}
.wf2-step-values{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px;margin-top:6px}
.wf2-step-values pre{white-space:pre-wrap;word-break:break-word;font-size:11px;margin:2px 0 0;padding:6px;border-radius:6px;background:rgba(127,127,127,.08);max-height:240px;overflow:auto}
.wf2-step-k{font-size:10px;text-transform:uppercase;letter-spacing:.06em;opacity:.6}
.wf2-step-absent{font-size:12px;margin-top:6px;opacity:.85}
.wf2-step-error{margin-top:4px;font-size:12px}
`}</style>
  );
}
