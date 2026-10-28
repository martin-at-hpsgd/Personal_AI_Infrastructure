"use client";

/**
 * Dashboard tab: four stat tiles, then every scheduled and daemon workflow as
 * one row with its row actions, then what is running right now. Cue's
 * dashboard shape over our inventory.
 */

import { Activity, CalendarClock, ExternalLink, Infinity as InfinityIcon, Network, TriangleAlert } from "lucide-react";
import { EmptyState, StatTile } from "@/components/ui/chrome";
import {
  HEALTH_META,
  HealthGlyph,
  RUNTIME_META,
  clock24,
  hhmm,
  lastRunNote,
  relativeAgo,
  type Health,
  type WorkflowRecord,
} from "../shared";
import type { ActivityRow, LiveState } from "./api";
import { RunButton } from "./run";
import { AppIcons } from "./app-icons";
import { StatusMark } from "./status";

/** Short status words for the table column; the full sentence stays in the tooltip. */
const SHORT_HEALTH: Record<Health, string> = { fail: "failing", warn: "open finding", unknown: "unknown", ok: "ok", "on-demand": "on demand", off: "disabled" };

export interface DashboardStats {
  scheduled: number;
  daemons: number;
  daemonsRunning: number | null;
  attention: number;
  runs24h: number | null;
  failed24h: number | null;
  /** True when the loaded history is truncated inside the last 24 hours, so runs24h is a minimum. */
  runsFloor: boolean;
}

export function Dashboard({
  rows,
  healthMap,
  stats,
  live,
  liveProblem,
  runningRuns,
  byId,
  now,
  onView,
  onOpenCard,
  filtered,
}: {
  rows: WorkflowRecord[];
  healthMap: Map<string, Health>;
  stats: DashboardStats;
  live: LiveState | null;
  liveProblem: string | null;
  runningRuns: ActivityRow[];
  byId: Map<string, WorkflowRecord>;
  now: number;
  onView: (id: string) => void;
  onOpenCard: (id: string) => void;
  filtered: boolean;
}) {
  const running = (live?.running ?? []).filter((x) => byId.get(x.id)?.trigger.kind !== "daemon");
  const runningIds = new Set(running.map((x) => x.id));
  const logRunning = runningRuns.filter((a) => !runningIds.has(a.recordId));

  return (
    <div className="wf2-dash">
      <div className="wf2-tiles">
        <StatTile icon={CalendarClock} label="Scheduled" value={stats.scheduled} sub={`plus ${stats.daemons} daemons`} />
        <StatTile
          icon={InfinityIcon}
          label="Running daemons"
          value={stats.daemonsRunning ?? "—"}
          unit={`of ${stats.daemons}`}
          dim={stats.daemonsRunning != null && stats.daemonsRunning < stats.daemons ? "warn" : undefined}
          sub={stats.daemonsRunning == null ? (liveProblem ?? "launchd could not be read") : stats.daemonsRunning < stats.daemons ? `${stats.daemons - stats.daemonsRunning} not running` : "all up"}
        />
        <StatTile
          icon={TriangleAlert}
          label="Needs attention"
          value={stats.attention}
          dim={stats.attention > 0 ? "err" : "ok"}
          sub="failing, or an open finding"
        />
        <StatTile
          icon={Activity}
          label="Last 24h runs"
          value={stats.runs24h == null ? "—" : stats.runsFloor ? `≥${stats.runs24h}` : stats.runs24h}
          dim={stats.failed24h ? "warn" : undefined}
          sub={
            stats.runs24h == null
              ? "activity not loaded"
              : `${stats.failed24h ? `${stats.failed24h} failed` : "none failed"}${stats.runsFloor ? " · history truncated" : ""}`
          }
        />
      </div>

      <div className="wf2-section-title">
        Scheduled and daemon workflows <span className="mono wf2-muted">{rows.length}</span>
        {filtered && <span className="wf2-muted"> · filtered</span>}
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={Network} title="No workflow matches" hint="Nothing scheduled matches the search or runtime filter." />
      ) : (
        <div className="wf2-table" role="table" aria-label="Scheduled and daemon workflows">
          <div className="wf2-tr wf2-th" role="row">
            <span role="columnheader" />
            <span role="columnheader">Workflow</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Trigger</span>
            <span role="columnheader">Last run</span>
            <span role="columnheader" className="wf2-num">Runs</span>
            <span role="columnheader" className="wf2-sr">Actions</span>
          </div>
          {rows.map((r) => {
            const h = healthMap.get(r.id) ?? "unknown";
            const ev = r.evidence;
            return (
              <div key={r.id} className="wf2-tr" role="row" data-health={h}>
                <span role="cell">
                  <span className="wf2-dot" style={{ background: RUNTIME_META[r.runtime].color }} title={RUNTIME_META[r.runtime].label} aria-label={RUNTIME_META[r.runtime].label} />
                </span>
                <span role="cell" className="wf2-td-name">
                  <span className="wf2-name-row">
                    <button type="button" className="wf2-name" onClick={() => onOpenCard(r.id)} title="Open the card">{r.title}</button>
                    <AppIcons apps={r.apps} />
                  </span>
                  <span className="wf2-muted wf2-sub">{RUNTIME_META[r.runtime].label} · {r.group}</span>
                </span>
                <span role="cell" className="wf2-td-status" title={HEALTH_META[h].label}>
                  <HealthGlyph health={h} />
                  <span style={{ color: h === "fail" ? "var(--err)" : h === "warn" ? "var(--warn)" : undefined }}>{SHORT_HEALTH[h]}</span>
                </span>
                <span role="cell" className="wf2-td-trigger">{r.trigger.display || "—"}</span>
                <span role="cell" className="wf2-td-last" title={ev.lastRunAt ? clock24(ev.lastRunAt) : lastRunNote(r)}>
                  {ev.lastRunAt ? (
                    <>
                      {ev.lastStatus === "ok" || ev.lastStatus === "error" ? (
                        <span className="wf2-last-outcome" style={{ color: ev.lastStatus === "error" ? "var(--err)" : "var(--ok)" }}>{ev.lastStatus === "ok" ? "succeeded" : "failed"}</span>
                      ) : (
                        <span className="wf2-muted">outcome unknown</span>
                      )}{" "}
                      <span className="mono">{hhmm(ev.lastRunAt)}</span> <span className="wf2-muted">{relativeAgo(ev.lastRunAt, now)}</span>
                    </>
                  ) : (
                    <span className="wf2-muted">—</span>
                  )}
                </span>
                <span role="cell" className="wf2-num mono">{ev.runs != null ? ev.runs.toLocaleString("en-US") : "—"}</span>
                <span role="cell" className="wf2-row-actions">
                  <RunButton record={r} />
                  <button type="button" className="wf2-iconact" onClick={() => onView(r.id)} title="View in Pipeline" aria-label={`View ${r.title} in Pipeline`}>
                    <Network size={15} aria-hidden />
                  </button>
                  <button type="button" className="wf2-iconact" onClick={() => onOpenCard(r.id)} title="Open card" aria-label={`Open the card for ${r.title}`}>
                    <ExternalLink size={15} aria-hidden />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="wf2-section-title">Active runs</div>
      {!live ? (
        <div className="wf2-muted wf2-pad">{liveProblem ?? "Reading launchd…"}</div>
      ) : !live.launchctlRead ? (
        <div className="wf2-muted wf2-pad">launchd could not be read, so what is running now is unknown.</div>
      ) : running.length === 0 && logRunning.length === 0 ? (
        <div className="wf2-muted wf2-pad">No scheduled workflow is running right now.</div>
      ) : (
        <ul className="wf2-active">
          {running.map((x) => {
            const r = byId.get(x.id);
            return (
              <li key={x.id}>
                <span className="wf2-dot" style={{ background: r ? RUNTIME_META[r.runtime].color : "var(--ink-3)" }} aria-hidden />
                <span>{r?.title ?? x.id}</span>
                <span className="mono wf2-muted">{x.label} · pid {x.pid}</span>
                <button type="button" className="wf2-act" data-tone="view" onClick={() => onView(x.id)}>View in Pipeline</button>
              </li>
            );
          })}
          {logRunning.map((a) => {
            const r = byId.get(a.recordId);
            return (
              <li key={a.key}>
                <span className="wf2-dot" style={{ background: r ? RUNTIME_META[r.runtime].color : "var(--ink-3)" }} aria-hidden />
                <span>{r?.title ?? a.recordId}</span>
                <StatusMark status="running" />
                <span className="mono wf2-muted">since {hhmm(a.at)} (run log)</span>
                <button type="button" className="wf2-act" data-tone="view" onClick={() => onView(a.recordId)}>View in Pipeline</button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
