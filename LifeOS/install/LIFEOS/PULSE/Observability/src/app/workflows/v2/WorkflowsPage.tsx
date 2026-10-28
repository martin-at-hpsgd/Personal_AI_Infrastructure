"use client";
import { fmtDateTime } from "@/lib/time";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, CalendarClock, Cloud, GitFork, LayoutDashboard, Network, RefreshCw, Search, TriangleAlert, Workflow, X } from "lucide-react";
import { EmptyState, PageHeader, PageShell, Panel, TabBar, type TabSpec } from "@/components/ui/chrome";
import { WorkflowCard } from "../card";
import {
  ALL_RUNTIMES,
  HEALTH_META,
  RUNTIME_META,
  findingsByRecord,
  healthOf,
  hhmm,
  matchesQuery,
  parseInventory,
  relativeAgo,
  type Health,
  type Inventory,
  type Runtime,
  type WorkflowRecord,
} from "../shared";
import { WorkflowsStyles } from "../styles";
import { CloudWorkers, SecurityScanStrip } from "../cloud";
import { ActivityLog, ActivityStyles } from "./activity";
import { parseOutcomes, type Outcome } from "./activity-model";
import { useApi } from "@/lib/api";
import { ACTIVITY_LIMIT, describeFailure, isUnreachable, parseActivity, parseLive, type ActivityResponse, type ActivityRow, type LiveState } from "./api";
import { PipelineCanvas, whereOf, type Where } from "./canvas";
import { Dashboard, type DashboardStats } from "./dashboard";
import { RunProvider } from "./run";
import { V2Styles } from "./styles";
import { ControlsStyles, GlobalPauseIndicator, LinkPanel, WaitingPanel } from "./controls";
import { EditorStyles } from "./editor";
import { DefinitionCanvas, DefinitionList, DefsEmpty, DefsLoading, DefsRetry, DefsStyles, UntypedScheduled, type DefRowFacts, type DefsLoad } from "./defs";
import { HEALTH_FILTERS, deriveHealth, parseGraphs, type DefHealth, type HealthFilter } from "./defs-model";
import { setPrincipalTz } from "../principal-tz";

// Workflows — every piece of work LifeOS runs, shown the way Maestro Cue
// shows its pipelines (UI design credit: the Maestro project,
// https://runmaestro.ai): a Dashboard of every scheduled workflow with row
// actions, a Pipelines canvas split Local / Cloud (trigger pill → steps →
// destination, one coloured frame per pipeline), an Activity log of real
// runs, and Workers: the attack-surface scan and the Cloudflare Worker source
// browser that used to be the separate Cloud Workflows page. Served at /workflows (the V1 table page was
// retired 2026-09-29; /workflows/v2 redirects here).
//
// Reads GET /api/workflows, /api/workflows/live and /api/workflows/activity;
// writes only through POST /api/workflows/run, behind a confirmation.
// State lives in the query string (?tab= ?wf= ?skill= ?q= ?rt= ?od= ?card=),
// never a hash, so a reload lands on the same view.

const INVENTORY_REFRESH_MS = 5 * 60_000;
const LIVE_REFRESH_MS = 60_000;
const AFTER_RUN_REFRESH_MS = 5_000;
const DAY_MS = 24 * 3_600_000;
const DEFS_REFRESH_MS = 30_000;

type Tab = "dashboard" | "canvas" | "scheduled" | "pipelines" | "activity" | "workers";
const TABS: readonly Tab[] = ["dashboard", "canvas", "scheduled", "pipelines", "activity", "workers"];

const SEARCH_PLACEHOLDER: Record<Tab, string> = {
  dashboard: "Search workflows…",
  canvas: "Search names, triggers, steps, prompts…",
  scheduled: "Search names, triggers, steps, prompts…",
  pipelines: "Search workflows…",
  activity: "Search runs: workflow, run id, step, error…",
  workers: "Search workflows…",
};

type Load = { state: "loading" } | { state: "ready" } | { state: "error"; message: string };

interface ViewState {
  tab: Tab;
  wf: string | null;
  skill: string | null;
  q: string;
  rt: Runtime | null;
  od: boolean;
  /** Where the canvas's workflows run: this Mac, or the Cloudflare fleet. */
  where: Where;
  /** The Cloudflare Worker open in the Workers tab. */
  name: string | null;
  card: string | null;
  /** Selected canvas node within ?wf= (a step id, "trigger" or "output"). */
  node: string | null;
  /** Health filter on the typed-workflow lists. */
  hf: HealthFilter;
  /** Activity outcome filter, comma-joined (empty = all). */
  st: string;
  /** Activity trigger-kind filter. */
  tk: string | null;
}

const DEFAULT_VIEW: ViewState = { tab: "dashboard", wf: null, skill: null, q: "", rt: null, od: false, where: "local", name: null, card: null, node: null, hf: "all", st: "", tk: null };

function readView(): ViewState {
  const p = new URLSearchParams(window.location.search);
  const tab = p.get("tab");
  const rt = p.get("rt");
  // Links from the retired V1 page: ?tab=cloud&name=<worker> (the old Cloud Workflows page) opens that worker; ?tab=cloud alone opens the Cloud pipelines.
  const legacyCloud = tab === "cloud";
  return {
    tab: TABS.includes(tab as Tab) ? (tab as Tab) : legacyCloud ? (p.get("name") ? "workers" : "pipelines") : "dashboard",
    wf: p.get("wf") || null,
    skill: p.get("skill") || null,
    q: (p.get("q") ?? "").slice(0, 200),
    rt: rt && (ALL_RUNTIMES as readonly string[]).includes(rt) ? (rt as Runtime) : null,
    od: p.get("od") === "1",
    where: p.get("where") === "cloud" || legacyCloud ? "cloud" : "local",
    name: p.get("name") || null,
    card: p.get("card") || null,
    node: p.get("node") || null,
    hf: (HEALTH_FILTERS as readonly string[]).includes(p.get("hf") ?? "") ? (p.get("hf") as HealthFilter) : "all",
    st: [...parseOutcomes(p.get("st"))].join(","),
    tk: (p.get("tk") ?? "").slice(0, 40) || null,
  };
}

function writeView(v: ViewState) {
  const url = new URL(window.location.href);
  const set = (k: string, val: string | null) => (val ? url.searchParams.set(k, val) : url.searchParams.delete(k));
  set("tab", v.tab === "dashboard" ? null : v.tab);
  set("wf", v.wf);
  set("skill", v.skill);
  set("q", v.q || null);
  set("rt", v.rt);
  set("od", v.od ? "1" : null);
  set("where", v.where === "cloud" ? "cloud" : null);
  set("name", v.tab === "workers" ? v.name : null);
  set("card", v.card);
  set("node", v.node);
  set("hf", v.hf === "all" ? null : v.hf);
  set("st", v.st || null);
  set("tk", v.tk);
  const next = url.pathname + url.search;
  if (next !== window.location.pathname + window.location.search) window.history.replaceState(null, "", next);
}

export default function WorkflowsPage() {
  const [inv, setInv] = useState<Inventory | null>(null);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [sample, setSample] = useState(false);
  const [dropped, setDropped] = useState(0);
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [activityProblem, setActivityProblem] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [liveProblem, setLiveProblem] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [view, setView] = useState<ViewState>(DEFAULT_VIEW);
  const [hydrated, setHydrated] = useState(false);
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  const [defs, setDefs] = useState<DefsLoad>({ state: "loading" });
  const barRef = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);

  const patch = useCallback((p: Partial<ViewState>) => setView((v) => ({ ...v, ...p })), []);

  /* ── Data ── */

  const invQ = useApi("/api/workflows", { refetchInterval: INVENTORY_REFRESH_MS });
  const actQ = useApi(`/api/workflows/activity?limit=${ACTIVITY_LIMIT}`, { refetchInterval: INVENTORY_REFRESH_MS });
  const liveQ = useApi("/api/workflows/live", { refetchInterval: LIVE_REFRESH_MS });
  const defsQ = useApi("/api/workflows/graphs", { refetchInterval: DEFS_REFRESH_MS });
  const refreshing = invQ.isFetching;

  // Inventory: parse each answer; a bad answer or a failed read keeps the last good inventory on screen.
  useEffect(() => {
    if (invQ.data === undefined) return;
    const raw = invQ.data;
    setPrincipalTz((raw as { timezone?: unknown } | null)?.timezone);
    const parsed = parseInventory(raw);
    if (!parsed.ok) {
      setLoad({ state: "error", message: `the API answered, but ${parsed.reason}` });
    } else {
      setInv(parsed.inv);
      setDropped(parsed.dropped);
      setSample(false);
      setLoad({ state: "ready" });
    }
    setNow(Date.now());
  }, [invQ.data, invQ.dataUpdatedAt]);

  useEffect(() => {
    const e = invQ.error;
    if (!invQ.errorUpdatedAt || !e) return;
    const message = describeFailure(e);
    // Development only: `next dev` has no Pulse API behind it. The production
    // build drops this branch (and the fixture) at compile time.
    if (process.env.NODE_ENV !== "production" && isUnreachable(e)) {
      import("../sample").then(({ SAMPLE_INVENTORY }) => {
        setInv(SAMPLE_INVENTORY);
        setDropped(0);
        setSample(true);
        setLoad({ state: "ready" });
      }).catch((fixtureErr) => {
        setLoad({ state: "error", message: `${message}, and the development fixture failed to load (${String(fixtureErr)})` });
      });
    } else {
      setLoad({ state: "error", message });
    }
    setNow(Date.now());
  }, [invQ.errorUpdatedAt, invQ.error]);

  useEffect(() => {
    if (actQ.data === undefined) return;
    const parsed = parseActivity(actQ.data);
    if (!parsed.ok) {
      setActivityProblem(`The page asked /api/workflows/activity and the API answered, but ${parsed.reason}.`);
      return;
    }
    setActivity(parsed.value);
    setActivityProblem(null);
  }, [actQ.data, actQ.dataUpdatedAt]);

  useEffect(() => {
    if (!actQ.errorUpdatedAt || !actQ.error) return;
    setActivityProblem(`The page asked /api/workflows/activity and ${describeFailure(actQ.error)}.`);
  }, [actQ.errorUpdatedAt, actQ.error]);

  useEffect(() => {
    if (liveQ.data === undefined) return;
    const parsed = parseLive(liveQ.data);
    if (!parsed.ok) {
      setLiveProblem(`Run Now is unavailable: /api/workflows/live gave a bad answer (the API answered, but ${parsed.reason}).`);
      return;
    }
    setLive(parsed.value);
    setLiveProblem(null);
  }, [liveQ.data, liveQ.dataUpdatedAt]);

  useEffect(() => {
    if (!liveQ.errorUpdatedAt || !liveQ.error) return;
    setLiveProblem(`Run Now is unavailable: /api/workflows/live ${isUnreachable(liveQ.error) ? "could not be reached" : "gave a bad answer"} (${describeFailure(liveQ.error)}).`);
  }, [liveQ.errorUpdatedAt, liveQ.error]);

  useEffect(() => {
    if (defsQ.data === undefined) return;
    const parsed = parseGraphs(defsQ.data);
    if (parsed.ok) setDefs({ state: "ready", value: parsed.value });
    else setDefs((d) => (d.state === "ready" ? d : { state: "error", message: `The page asked /api/workflows/graphs and the API answered, but ${parsed.reason}.` }));
  }, [defsQ.data, defsQ.dataUpdatedAt]);

  useEffect(() => {
    if (!defsQ.errorUpdatedAt || !defsQ.error) return;
    const message = `The page asked /api/workflows/graphs and ${describeFailure(defsQ.error)}.`;
    setDefs((d) => (d.state === "ready" ? d : { state: "error", message }));
  }, [defsQ.errorUpdatedAt, defsQ.error]);

  const refetchInv = invQ.refetch, refetchAct = actQ.refetch, refetchLive = liveQ.refetch, refetchDefs = defsQ.refetch;
  // A read already in flight is left alone, as the old in-flight guard did.
  const fetchGraphs = useCallback(() => { void refetchDefs({ cancelRefetch: false }); }, [refetchDefs]);
  const fetchLive = useCallback(() => { void refetchLive({ cancelRefetch: false }); }, [refetchLive]);
  const fetchActivity = useCallback(() => { void refetchAct({ cancelRefetch: false }); }, [refetchAct]);
  const fetchInventory = useCallback(() => { void refetchInv({ cancelRefetch: false }); }, [refetchInv]);

  /** Changes every 30 s: the waiting list and the global-pause indicator re-read on it. */
  const pollTick = Math.floor(now / 30_000);

  const reloadAll = useCallback(() => {
    fetchGraphs();
    fetchInventory();
    fetchActivity();
    fetchLive();
  }, [fetchInventory, fetchActivity, fetchLive, fetchGraphs]);

  useEffect(() => {
    setView(readView());
    setHydrated(true);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000); // not-data: relative-time clock tick
    const tick = window.setInterval(() => setNow(Date.now()), 60_000); // not-data: coarse clock tick that drives the 30 s poll counter
    const pending = timers.current;
    return () => {
      window.clearInterval(tick);
      window.clearInterval(clock);
      pending.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  // Focus the workflow named in the URL once the canvas can place it.
  const initialFocusDone = useRef(false);
  useEffect(() => {
    if (!hydrated || !inv || initialFocusDone.current) return;
    initialFocusDone.current = true;
    if (view.tab === "pipelines" && view.wf) setFocus({ id: view.wf, nonce: Date.now() });
  }, [hydrated, inv, view.tab, view.wf]);

  useEffect(() => {
    if (hydrated) writeView(view);
  }, [view, hydrated]);

  // Esc order (ISC-115): the search input clears itself first and stops the
  // event; only an Esc that reaches the window closes the canvas detail.
  const detailOpen = view.tab === "canvas" && !!view.node;
  useEffect(() => {
    if (!detailOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      patch({ node: null });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailOpen, patch]);

  // The canvas fills the viewport below the tab bar, so on the Pipelines tab
  // the tab bar is brought to the top of the screen.
  const hasInv = !!inv;
  useEffect(() => {
    if (!hydrated || !hasInv || view.tab !== "pipelines") return;
    const id = requestAnimationFrame(() => barRef.current?.scrollIntoView({ block: "start", behavior: "auto" }));
    return () => cancelAnimationFrame(id);
  }, [hydrated, hasInv, view.tab]);

  const onStarted = useCallback(() => {
    fetchLive();
    timers.current.push(window.setTimeout(() => { fetchActivity(); fetchInventory(); fetchLive(); }, AFTER_RUN_REFRESH_MS));
  }, [fetchActivity, fetchInventory, fetchLive]);

  /* ── Derived ── */

  const records = inv?.records ?? [];
  const findingsMap = useMemo(() => findingsByRecord(inv?.findings ?? []), [inv]);
  const byId = useMemo(() => new Map(records.map((r) => [r.id, r])), [records]);
  const healthMap = useMemo(() => new Map<string, Health>(records.map((r) => [r.id, healthOf(r, findingsMap.get(r.id))])), [records, findingsMap]);

  const scheduledAndDaemon = useMemo(() => records.filter((r) => r.runtime !== "skill" && r.trigger.kind !== "on-demand"), [records]);
  const otherOnDemand = useMemo(() => records.filter((r) => r.runtime !== "skill" && r.trigger.kind === "on-demand"), [records]);
  const skills = useMemo(() => records.filter((r) => r.runtime === "skill"), [records]);

  const q = view.q.trim();
  const passes = useCallback((r: WorkflowRecord) => (!view.rt || r.runtime === view.rt) && matchesQuery(r, q), [view.rt, q]);

  const onSide = useCallback((r: WorkflowRecord) => whereOf(r) === view.where, [view.where]);
  const canvasRecords = useMemo(
    () => [...scheduledAndDaemon, ...(view.od ? otherOnDemand : [])].filter((r) => onSide(r) && passes(r)),
    [scheduledAndDaemon, otherOnDemand, view.od, passes, onSide],
  );
  const canvasSkills = useMemo(() => (view.od ? skills.filter((r) => onSide(r) && passes(r)) : []), [skills, view.od, passes, onSide]);
  /** Pipelines on each side, under the current on-demand toggle and search. */
  const whereCounts = useMemo(() => {
    const pool = [...scheduledAndDaemon, ...(view.od ? [...otherOnDemand, ...skills] : [])].filter((r) => matchesQuery(r, q));
    return { local: pool.filter((r) => whereOf(r) === "local").length, cloud: pool.filter((r) => whereOf(r) === "cloud").length };
  }, [scheduledAndDaemon, otherOnDemand, skills, view.od, q]);

  const countRuntimes = useCallback((sideOnly: boolean) => {
    const pool = [...scheduledAndDaemon, ...(view.od ? [...otherOnDemand, ...skills] : [])].filter((r) => matchesQuery(r, q) && (!sideOnly || onSide(r)));
    return ALL_RUNTIMES.map((runtime) => ({ runtime, count: pool.filter((r) => r.runtime === runtime).length })).filter((x) => x.count > 0 || x.runtime === view.rt);
  }, [scheduledAndDaemon, otherOnDemand, skills, view.od, view.rt, q, onSide]);
  /** Every source, for the page-wide chips. */
  const runtimeCounts = useMemo(() => countRuntimes(false), [countRuntimes]);
  /** Only the sources on the canvas's current side (Local or Cloud). */
  const canvasRuntimeCounts = useMemo(() => countRuntimes(true), [countRuntimes]);

  const dashboardRows = useMemo(
    () =>
      scheduledAndDaemon
        .filter(passes)
        .sort((a, b) => HEALTH_META[healthMap.get(a.id) ?? "unknown"].order - HEALTH_META[healthMap.get(b.id) ?? "unknown"].order || a.title.localeCompare(b.title)),
    [scheduledAndDaemon, passes, healthMap],
  );

  // Activity applies only the runtime filter here; the search and the outcome
  // and trigger chips run inside ActivityLog over the runs themselves (ISC-104).
  const activityRows = useMemo(() => {
    if (!activity) return [];
    return activity.rows.filter((a) => {
      const r = byId.get(a.recordId);
      return r ? !view.rt || r.runtime === view.rt : !view.rt;
    });
  }, [activity, byId, view.rt]);
  const activityOutcomes = useMemo(() => parseOutcomes(view.st), [view.st]);

  const runsByRecord = useMemo(() => {
    const m = new Map<string, ActivityRow[]>();
    for (const a of activity?.rows ?? []) {
      const list = m.get(a.recordId);
      if (list) list.push(a);
      else m.set(a.recordId, [a]);
    }
    return m;
  }, [activity]);

  const stats = useMemo<DashboardStats>(() => {
    const daemons = scheduledAndDaemon.filter((r) => r.trigger.kind === "daemon");
    const daemonIds = new Set(daemons.map((r) => r.id));
    const attention = scheduledAndDaemon.filter((r) => {
      const h = healthMap.get(r.id);
      return h === "fail" || h === "warn";
    }).length;
    let runs24h: number | null = null;
    let failed24h: number | null = null;
    let runsFloor = false;
    if (activity) {
      const since = now - DAY_MS;
      const recent = activity.rows.filter((a) => a.status !== "skipped" && Date.parse(a.at) >= since);
      runs24h = recent.length;
      failed24h = recent.filter((a) => a.status === "error").length;
      const oldest = activity.rows[activity.rows.length - 1];
      runsFloor = activity.truncated && !!oldest && Date.parse(oldest.at) >= since;
    }
    return {
      scheduled: scheduledAndDaemon.filter((r) => r.trigger.kind === "schedule").length,
      daemons: daemons.length,
      daemonsRunning: live && live.launchctlRead ? live.running.filter((x) => daemonIds.has(x.id)).length : null,
      attention,
      runs24h,
      failed24h,
      runsFloor,
    };
  }, [scheduledAndDaemon, healthMap, activity, live, now]);

  const defList = defs.state === "ready" ? defs.value.definitions : [];
  const defFacts = useMemo(() => {
    const m = new Map<string, DefRowFacts>();
    for (const d of defList) {
      const r = byId.get(`workflow:${d.name}`);
      const open = r ? (findingsMap.get(r.id) ?? []).filter((f) => !f.acknowledged && f.severity !== "low").length : 0;
      const running = (runsByRecord.get(`workflow:${d.name}`) ?? []).some((a) => a.status === "running");
      const lastStatus = r?.evidence.lastStatus ?? null;
      const health: DefHealth = deriveHealth(
        { valid: d.valid, enabled: r ? r.enabled : true, running, lastStatus: lastStatus === "ok" || lastStatus === "error" ? lastStatus : lastStatus ? "unknown" : null, lastRunAt: r?.evidence.lastRunAt ?? null, openFindings: open },
        now,
      );
      m.set(d.name, { health, lastAt: r?.evidence.lastRunAt ?? null, lastStatus, now });
    }
    return m;
  }, [defList, byId, findingsMap, runsByRecord, now]);
  const defHealth = useMemo(() => new Map([...defFacts].map(([k, v]) => [k, v.health])), [defFacts]);

  const runningRuns = useMemo(() => (activity?.rows ?? []).filter((a) => a.status === "running"), [activity]);

  /* ── Actions ── */

  const viewInPipeline = useCallback(
    (id: string) => {
      const r = byId.get(id);
      if (!r) return;
      setView((v) => ({
        ...v,
        tab: "pipelines",
        wf: id,
        skill: r.runtime === "skill" ? r.group : null,
        od: v.od || r.trigger.kind === "on-demand",
        where: whereOf(r),
        rt: v.rt && v.rt !== r.runtime ? null : v.rt,
        q: v.q && !matchesQuery(r, v.q.trim()) ? "" : v.q,
      }));
      setFocus({ id, nonce: Date.now() });
    },
    [byId],
  );

  const openCard = useCallback((id: string) => patch({ card: id }), [patch]);
  const closeCard = useCallback(() => patch({ card: null }), [patch]);
  const toggleRuntime = useCallback((rt: Runtime) => setView((v) => ({ ...v, rt: v.rt === rt ? null : rt })), []);

  const cardRecord = view.card ? byId.get(view.card) : undefined;

  const tabs: TabSpec<Tab>[] = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "canvas", label: "Canvas", icon: GitFork, hint: defs.state === "ready" ? defList.length : undefined },
    { id: "scheduled", label: "Scheduled", icon: CalendarClock },
    { id: "pipelines", label: "Pipelines", icon: Workflow, hint: canvasRecords.length + (canvasSkills.length > 0 ? ` + ${canvasSkills.length}` : "") },
    { id: "activity", label: "Activity", icon: Activity, hint: activity ? activityRows.length : undefined },
    { id: "workers", label: "Workers", icon: Cloud },
  ];

  const collectorErrors = inv?.errors ?? [];

  return (
    <PageShell className="wf wf2">
      <WorkflowsStyles />
      <V2Styles />
      <DefsStyles />
      <EditorStyles />
      <ControlsStyles />
      <ActivityStyles />
      <PageHeader
        className="wf-header"
        icon={Network}
        title="Workflows"
        subtitle="Every scheduled workflow as a pipeline: what triggers it, who does each step, where the output goes, and what ran."
        actions={
          <>
            <GlobalPauseIndicator tick={pollTick} />
            {inv && (
              <span className="wf-muted wf-generated" title={inv.generatedAt ? `Inventory built ${fmtDateTime(inv.generatedAt)}` : undefined}>
                inventory {hhmm(inv.generatedAt || null)} · {relativeAgo(inv.generatedAt || null, now)}
              </span>
            )}
            <button type="button" className="wf-refresh" onClick={reloadAll} disabled={refreshing} aria-label="Reload the inventory, activity and live state">
              <RefreshCw size={14} className={refreshing ? "wf-spin" : undefined} aria-hidden />
              <span>Reload</span>
            </button>
          </>
        }
      />

      {sample && (
        <div className="wf-notice" data-tone="info" role="status">
          <TriangleAlert size={14} aria-hidden />
          <span>Sample data. The workflows API is not reachable from <code>next dev</code>, so this page is showing a synthetic inventory with no activity and no Run Now.</span>
        </div>
      )}
      {load.state === "error" && inv && (
        <div className="wf-notice" data-tone="err" role="alert">
          <TriangleAlert size={14} aria-hidden />
          <span>Could not reload the workflow inventory: {load.message}. Showing the last inventory that loaded.</span>
        </div>
      )}
      {(collectorErrors.length > 0 || dropped > 0) && (
        <div className="wf-notice" data-tone="warn">
          <TriangleAlert size={14} aria-hidden />
          <span>
            {collectorErrors.length > 0 && `${collectorErrors.length} collector${collectorErrors.length === 1 ? "" : "s"} reported an error (${collectorErrors.map((e) => e.source).join(", ")}), so the inventory may be incomplete. `}
            {dropped > 0 && `${dropped} malformed record${dropped === 1 ? "" : "s"} skipped.`}
          </span>
        </div>
      )}

      {!inv && load.state === "loading" && (
        <Panel>
          <div className="wf-loading" role="status">
            <span className="wf-skeleton" style={{ width: "38%" }} />
            <span className="wf-skeleton" style={{ width: "72%" }} />
            <span className="wf-muted">Reading the workflow inventory…</span>
          </div>
        </Panel>
      )}
      {!inv && load.state === "error" && (
        <Panel>
          <EmptyState
            icon={Network}
            title={<span className="wf2-state-title">No inventory to show</span>}
            hint={<span className="wf2-state-hint">The page asked /api/workflows and {load.message}. Nothing can be drawn without it.</span>}
          />
          <div className="wf-center">
            <button type="button" className="wf-refresh" onClick={reloadAll} disabled={refreshing}>
              <RefreshCw size={14} className={refreshing ? "wf-spin" : undefined} aria-hidden />
              <span>Try again</span>
            </button>
          </div>
        </Panel>
      )}

      <WaitingPanel tick={pollTick} />

      {inv && (
        <RunProvider live={live} liveProblem={sample ? "Run Now needs the Pulse API." : liveProblem} onStarted={onStarted}>
          <div className="wf2-bar" ref={barRef}>
            <TabBar
              tabs={tabs}
              active={view.tab}
              onChange={(tab) => patch({ tab })}
              right={
                <label className="wf2-search">
                  <Search size={14} aria-hidden />
                  <input
                    type="search"
                    value={view.q}
                    placeholder={SEARCH_PLACEHOLDER[view.tab]}
                    aria-label={view.tab === "activity" ? "Search runs" : "Search workflows"}
                    onChange={(e) => patch({ q: e.target.value.slice(0, 200) })}
                    onKeyDown={(e) => {
                      // Esc clears the search before anything else (ISC-115); the
                      // canvas detail panel only closes on an Esc with no search.
                      if (e.key === "Escape" && view.q) { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); patch({ q: "" }); }
                    }}
                  />
                  {view.q && (
                    <button type="button" onClick={() => patch({ q: "" })} aria-label="Clear the search">
                      <X size={13} aria-hidden />
                    </button>
                  )}
                </label>
              }
            />
            {view.tab !== "pipelines" && (
              <div className="wf2-chips" role="group" aria-label="Filter by runtime">
                {runtimeCounts.filter((x) => x.runtime !== "skill").map(({ runtime, count }) => (
                  <button
                    key={runtime}
                    type="button"
                    className="wf2-legend-item"
                    aria-pressed={view.rt === runtime}
                    data-dim={view.rt && view.rt !== runtime ? "1" : undefined}
                    onClick={() => toggleRuntime(runtime)}
                  >
                    <span className="wf2-dot" style={{ background: RUNTIME_META[runtime].color }} aria-hidden />
                    {RUNTIME_META[runtime].label}
                    <span className="mono wf2-muted">({count})</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {view.tab === "dashboard" && (
            <Dashboard
              rows={dashboardRows}
              healthMap={healthMap}
              stats={stats}
              live={live}
              liveProblem={sample ? "Needs the Pulse API." : liveProblem}
              runningRuns={runningRuns}
              byId={byId}
              now={now}
              onView={viewInPipeline}
              onOpenCard={openCard}
              filtered={!!view.rt || !!q}
            />
          )}

          {(view.tab === "canvas" || view.tab === "scheduled") && (
            defs.state === "loading" ? <DefsLoading /> :
            defs.state === "error" ? <DefsRetry message={defs.message} onRetry={fetchGraphs} /> :
            defList.length === 0 ? <DefsEmpty dir={defs.value.dir} /> :
            <>
              {view.tab === "canvas" && (
                <DefinitionCanvas
                  defs={defList}
                  health={defHealth}
                  selected={view.wf && view.node && defList.some((d) => d.name === view.wf) ? { wf: view.wf, node: view.node } : null}
                  onSelect={(s) => patch({ wf: s?.wf ?? null, node: s?.node ?? null })}
                  onChanged={fetchGraphs}
                />
              )}
              {view.tab === "canvas" && <LinkPanel defs={defList} onChanged={fetchGraphs} />}
              <DefinitionList
                defs={defList}
                facts={defFacts}
                q={view.q}
                f={view.hf}
                setF={(hf) => patch({ hf })}
                scheduled={view.tab === "scheduled"}
                onChanged={fetchGraphs}
                onCanvas={(name) => patch({ tab: "canvas", wf: name, node: "trigger" })}
                appsOf={(name) => byId.get(`workflow:${name}`)?.apps}
              />
              {view.tab === "scheduled" && <UntypedScheduled records={inv.records} q={view.q} now={now} />}
            </>
          )}

          {view.tab === "pipelines" && (
            <PipelineCanvas
              inv={inv}
              records={canvasRecords}
              skillRecords={canvasSkills}
              findingsMap={findingsMap}
              runsByRecord={runsByRecord}
              now={now}
              selectedId={view.wf}
              selectedSkill={view.skill}
              focus={focus}
              runtimeFilter={view.rt}
              runtimeCounts={canvasRuntimeCounts}
              where={view.where}
              whereCounts={whereCounts}
              onWhere={(where) => setView((v) => (v.where === where ? v : { ...v, where, wf: null, skill: null, rt: null }))}
              showOnDemand={view.od}
              onDemandCount={otherOnDemand.length + skills.length}
              onSelect={(id) => patch({ wf: id })}
              onSelectSkill={(skill) => patch({ skill, wf: null })}
              onRuntime={toggleRuntime}
              onToggleOnDemand={() => setView((v) => ({ ...v, od: !v.od, skill: v.od ? null : v.skill, wf: v.od && v.wf && byId.get(v.wf)?.trigger.kind === "on-demand" ? null : v.wf }))}
              onOpenCard={openCard}
              onEdit={(name) => patch({ tab: "canvas", wf: name, node: "trigger", skill: null })}
            />
          )}

          {view.tab === "workers" && (
            <>
              <SecurityScanStrip />
              <CloudWorkers worker={view.name} onPick={(name) => patch({ name })} />
            </>
          )}

          {view.tab === "activity" && (
            <ActivityLog
              activity={activity}
              problem={activityProblem}
              rows={activityRows}
              byId={byId}
              q={view.q}
              outcomes={activityOutcomes}
              setOutcomes={(o: Set<Outcome>) => patch({ st: [...o].join(",") })}
              trigger={view.tk}
              setTrigger={(tk) => patch({ tk })}
              onView={viewInPipeline}
              onOpenCard={openCard}
            />
          )}

          {view.card && !cardRecord && (
            <div className="wf-notice" data-tone="warn" role="status">
              <TriangleAlert size={14} aria-hidden />
              <span>No workflow with id <code>{view.card}</code> is in the current inventory.</span>
              <button type="button" className="wf-linkbtn" onClick={closeCard}>Dismiss</button>
            </div>
          )}
          {cardRecord && (
            <WorkflowCard
              record={cardRecord}
              inv={inv}
              findings={findingsMap.get(cardRecord.id) ?? []}
              health={healthMap.get(cardRecord.id) ?? "unknown"}
              now={now}
              onClose={closeCard}
              onOpen={openCard}
            />
          )}
        </RunProvider>
      )}
    </PageShell>
  );
}
