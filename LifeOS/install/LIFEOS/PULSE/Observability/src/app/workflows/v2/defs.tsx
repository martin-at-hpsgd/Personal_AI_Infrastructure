"use client";

// Canvas and Scheduled tabs for typed (v2) workflow definitions. Everything
// drawn here comes from GET /api/workflows/graphs, which is the CLI's own
// `graph` and `next` output, so the page and the CLI cannot disagree.
// Edits (run, schedule, runs_on, pause) post through controls.tsx, and the
// canvas editor (connect, disconnect, the step inspector, YAML, New, Undo)
// through editor.tsx, to routes that call the CLI's own engine modules;
// nothing here writes a file.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { EditBar, StepInspector, YamlEditor, useEditor } from "./editor";
import { deployLabel } from "./editor-model";
import { X } from "lucide-react";
import { PauseButton, RunForm, RunsOnControl, ScheduleForm } from "./controls";
import {
  DEF_HEALTH_META,
  HEALTH_FILTERS,
  NODE_H,
  NODE_W,
  countdown,
  edgeFieldLabel,
  edgeName,
  edgeStyle,
  filterDefinitions,
  hhmmTz,
  dayTz,
  isScheduled,
  layoutAll,
  nodeName,
  stepEdges,
  triggerText,
  workflowEdges,
  type Box,
  type DefHealth,
  type Definition,
  type GraphsResponse,
  type HealthFilter,
} from "./defs-model";
import type { ConnectionClass } from "./defs-model";
import { principalTzLabel } from "../principal-tz";
import type { Executor, WorkflowApp, WorkflowRecord } from "../../../../../../WORKFLOWS/types";
import { AppIcons } from "./app-icons";

export type DefsLoad = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; value: GraphsResponse };

const EMPTY_HINT = "bun LIFEOS/WORKFLOWS/workflow.ts new <name>";

function Retry({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="wfd-state" role="alert">
      <strong>Could not load the workflow definitions.</strong>
      <span>{message}</span>
      <button type="button" className="wf-refresh" onClick={onRetry}>Try again</button>
    </div>
  );
}

function Loading() {
  return (
    <div className="wfd-state" role="status" aria-live="polite">
      <span className="wf-skeleton" style={{ width: "40%" }} />
      <span className="wf-skeleton" style={{ width: "70%" }} />
      <span className="wf-muted">Reading the workflow definitions…</span>
    </div>
  );
}

function Empty({ dir }: { dir: string }) {
  // Only a home-relative path is shown; an absolute path outside home names the env override instead.
  const where = dir.startsWith("~") ? <code>{dir}</code> : <>the folder <code>LIFEOS_WORKFLOWS_DIR</code> names</>;
  return (
    <div className="wfd-state wfd-empty" role="status">
      <strong>No typed workflows yet</strong>
      <span>Create one with <code>{EMPTY_HINT}</code></span>
      <span className="wf-muted">It appears here within about 30 seconds. Definitions live in {where}.</span>
    </div>
  );
}

function Badge({ h }: { h: DefHealth }) {
  const m = DEF_HEALTH_META[h];
  return <span className="wfd-badge" data-h={h} style={{ borderColor: m.color, color: m.color }}>{m.label}</span>;
}

/* ── Work list (shared by both tabs) ── */

export interface DefRowFacts { health: DefHealth; lastAt: string | null; lastStatus: string | null; now: number }

function ago(iso: string | null, now: number): string {
  if (!iso) return "never run";
  const s = Math.floor((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "—";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** Health filter chips. The one search box is the page's, above the tabs. */
function Toolbar({ f, setF, counts }: { f: HealthFilter; setF: (f: HealthFilter) => void; counts: Record<HealthFilter, number> }) {
  return (
    <div className="wfd-toolbar">
      <div className="wfd-filters" role="group" aria-label="Filter by health">
        {HEALTH_FILTERS.map((x) => (
          <button key={x} type="button" aria-pressed={f === x} onClick={() => setF(x)}>
            {x === "all" ? "All" : x === "attention" ? "Attention" : x === "running" ? "Running" : "Quiet"} <span className="mono wf2-muted">{counts[x]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Stage strip: the typed pipeline, inline on every row ── */

const WORST_RANK: Record<ConnectionClass, number> = { mismatch: 0, runtime: 1, checked: 2 };
const KIND_GLYPH: Record<string, string> = { code: "■", command: "■", model: "●", agent: "●", judgment: "◆", human: "▲", workflow: "○" };

/** trigger ◇, then one glyph per step by kind, each hop coloured by the worst class of the edges into it, then result □. */
export function StageStrip({ d }: { d: Definition }) {
  const ids = Object.keys(d.steps);
  const into = new Map<string, ConnectionClass>();
  for (const e of stepEdges(d)) {
    const prev = into.get(e.to);
    if (!prev || WORST_RANK[e.cls] < WORST_RANK[prev]) into.set(e.to, e.cls);
  }
  const hop = (to: string) => {
    const cls = into.get(to) ?? "checked";
    return <span className="wfs-hop" data-cls={cls} title={edgeStyle(cls).label} aria-hidden />;
  };
  return (
    <span className="wfs-strip" role="img" aria-label={`pipeline: trigger, ${ids.map((id) => `${id} (${d.steps[id].kind})`).join(", ")}, result`}>
      <span className="wfs-glyph" data-kind="trigger" aria-hidden>◇</span>
      {ids.map((id) => (
        <span key={id} className="wfs-stage">
          {hop(id)}
          <span className="wfs-glyph" data-kind={d.steps[id].kind} aria-hidden>{KIND_GLYPH[d.steps[id].kind] ?? "■"}</span>
          <span className="wfs-step mono">{id}</span>
          <span className="wfs-type">{d.steps[id].kind}</span>
        </span>
      ))}
      {hop("output")}
      <span className="wfs-glyph" data-kind="output" aria-hidden>□</span>
    </span>
  );
}

const EXEC_GLYPH: Record<Executor, string> = { code: "■", model: "●", judgment: "◆", human: "▲", unknown: "·" };

/** Scheduled jobs that are not typed workflows, so the Scheduled view shows every schedule; each is marked untyped. */
export function UntypedScheduled({ records, q, now }: { records: WorkflowRecord[]; q: string; now: number }) {
  const needle = q.trim().toLowerCase();
  const rows = records
    .filter((r) => r.trigger.kind === "schedule" && r.runtime !== "workflow")
    .filter((r) => !needle || `${r.title} ${r.name} ${r.trigger.display}`.toLowerCase().includes(needle))
    .sort((a, b) => a.title.localeCompare(b.title));
  if (rows.length === 0) return null;
  return (
    <section className="wfu-list" aria-label="Other scheduled jobs, not yet typed">
      <header className="wfu-head">
        <span className="wfu-title">Other scheduled jobs</span>
        <span className="wfu-sub">{rows.length} not yet typed</span>
        <span className="wfu-legend" aria-label="Stage key">
          <span><i data-kind="trigger">◇</i> trigger</span><span><i data-kind="code">■</i> code</span><span><i data-kind="model">●</i> model</span>
          <span><i data-kind="judgment">◆</i> judgment</span><span><i data-kind="human">▲</i> human</span><span><i data-kind="output">□</i> result</span>
        </span>
      </header>
      {rows.map((r) => (
        <div key={r.id} className="wfu-row">
          <span className="wfu-namecell">
            <span className="wfu-name">{r.title}</span>
            <AppIcons apps={r.apps} />
          </span>
          <span className="wfs-strip" data-untyped="1" role="img" aria-label={`untyped job, ${r.card.steps.length} steps`}>
            <span className="wfs-glyph" data-kind="trigger" aria-hidden>◇</span>
            {r.card.steps.map((st) => (
              <span key={st.id} className="wfs-stage">
                <span className="wfs-hop" data-cls="untyped" aria-hidden />
                <span className="wfs-glyph" data-kind={st.executor} aria-hidden>{EXEC_GLYPH[st.executor]}</span>
              </span>
            ))}
            <span className="wfs-hop" data-cls="untyped" aria-hidden />
            <span className="wfs-glyph" data-kind="output" aria-hidden>□</span>
            <span className="wfu-tag">untyped</span>
          </span>
          <span className="wfu-trig">{r.trigger.display}</span>
          <span className="wfd-last" title={r.evidence.lastRunAt ? `${dayTz(r.evidence.lastRunAt)} ${hhmmTz(r.evidence.lastRunAt)} ${principalTzLabel()}` : undefined}>
            {r.evidence.lastRunAt ? <span data-s={r.evidence.lastStatus}>{r.evidence.lastStatus === "ok" ? "succeeded" : r.evidence.lastStatus === "error" ? "failed" : "ran"}</span> : null} {ago(r.evidence.lastRunAt, now)}
          </span>
        </div>
      ))}
    </section>
  );
}

function DefRow({ d, facts, extra, open, onToggle, onCanvas, onChanged, apps }: { d: Definition; facts: DefRowFacts; extra?: React.ReactNode; open: boolean; onToggle: () => void; onCanvas: () => void; onChanged: () => void; apps?: WorkflowApp[] }) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); }
  };
  return (
    <div className="wfd-row" data-open={open ? "1" : undefined}>
      <div className="wfd-row-head" role="button" tabIndex={0} aria-expanded={open} onClick={onToggle} onKeyDown={onKey}>
        <Badge h={facts.health} />
        <span className="wfd-namecell">
          <span className="wfd-name mono">{d.name}</span>
          <AppIcons apps={apps} />
        </span>
        <StageStrip d={d} />
        <span className="wfd-trig">{d.triggers.map(triggerText).join(" · ") || "no trigger"}</span>
        {extra}
        <span className="wfd-last" title={facts.lastAt ? `${dayTz(facts.lastAt)} ${hhmmTz(facts.lastAt)} ${principalTzLabel()}` : undefined}>
          {facts.lastStatus ? <span data-s={facts.lastStatus}>{facts.lastStatus === "ok" ? "succeeded" : facts.lastStatus === "error" ? "failed" : facts.lastStatus}</span> : null} {ago(facts.lastAt, facts.now)}
        </span>
      </div>
      {!d.valid && d.errors.length > 0 && (
        <ul className="wfd-errors" aria-label={`Validation errors for ${d.name}`}>
          {d.errors.map((e, i) => <li key={i} className="mono">{e}</li>)}
        </ul>
      )}
      {open && (
        <div className="wfd-row-body">
          {d.description && <p>{d.description}</p>}
          <p className="wf-muted mono">{d.path} · runs {d.runs_on} · {Object.keys(d.steps).length} steps</p>
          <button type="button" className="wf-linkbtn" onClick={onCanvas}>Show on canvas</button>
          <div className="wfc-actions">
            <RunForm d={d} />
            <ScheduleForm d={d} onChanged={onChanged} />
            <RunsOnControl d={d} onChanged={onChanged} />
          </div>
        </div>
      )}
    </div>
  );
}

export function DefinitionList({ defs, facts, q, f, setF, onCanvas, scheduled, onChanged, appsOf }: {
  defs: Definition[];
  /** The applications a typed workflow serves, from its inventory record; absent → no icons. */
  appsOf?: (name: string) => WorkflowApp[] | undefined;
  facts: Map<string, DefRowFacts>;
  /** The page search, applied to names, triggers, steps and prompts. */
  q: string;
  f: HealthFilter; setF: (f: HealthFilter) => void;
  onCanvas: (name: string) => void;
  scheduled?: boolean;
  /** Reload the definitions after an edit. */
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const pool = scheduled ? defs.filter(isScheduled) : defs;
  const health = useMemo(() => new Map([...facts].map(([k, v]) => [k, v.health])), [facts]);
  const shown = useMemo(() => filterDefinitions(pool, health, q, f), [pool, health, q, f]);
  const counts = useMemo(() => Object.fromEntries(HEALTH_FILTERS.map((x) => [x, filterDefinitions(pool, health, q, x).length])) as Record<HealthFilter, number>, [pool, health, q]);
  const now = facts.values().next().value?.now ?? Date.now();
  const toggle = (n: string) => setOpen((s) => { const c = new Set(s); if (c.has(n)) c.delete(n); else c.add(n); return c; });
  return (
    <section className="wfd-list" aria-label={scheduled ? "Scheduled typed workflows" : "Typed workflows"}>
      <Toolbar f={f} setF={setF} counts={counts} />
      {shown.length === 0 && <p className="wf-muted wfd-none">{pool.length === 0 ? (scheduled ? "No typed workflow has a schedule, interval or one-off time yet." : "No typed workflows.") : "Nothing matches this search and filter."}</p>}
      {shown.map((d) => {
        const fx = facts.get(d.name) ?? { health: "quiet" as DefHealth, lastAt: null, lastStatus: null, now };
        const extra = scheduled ? (
          <>
            <span className="wfd-next mono" title={d.next ? `${dayTz(d.next)} ${hhmmTz(d.next)} ${principalTzLabel()}` : undefined}>
              {d.next ? `next ${dayTz(d.next)} ${hhmmTz(d.next)} · ${countdown(d.next, fx.now)}` : "no next run"}
            </span>
            <PauseButton d={d} onChanged={onChanged} />
          </>
        ) : null;
        return <DefRow key={d.name} d={d} facts={fx} extra={extra} open={open.has(d.name)} onToggle={() => toggle(d.name)} onCanvas={() => onCanvas(d.name)} onChanged={onChanged} apps={appsOf?.(d.name)} />;
      })}
    </section>
  );
}

/* ── Canvas ── */

type Sel = { wf: string; node: string } | null;

function edgePath(a: Box, b: Box): string {
  const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

function Schema({ label, value }: { label: string; value: unknown }) {
  if (value === undefined) return <div><dt>{label}</dt><dd className="wf-muted">not declared</dd></div>;
  return <div><dt>{label}</dt><dd><pre className="mono wfd-pre">{JSON.stringify(value, null, 2)}</pre></dd></div>;
}

function Detail({ def, node, onClose }: { def: Definition; node: string; onClose: () => void }) {
  if (node === "trigger") {
    return (
      <aside className="wfd-detail" aria-label={`Trigger of ${def.name}`}>
        <header><strong>Trigger · {def.name}</strong><button type="button" onClick={onClose} aria-label="Close detail"><X size={14} aria-hidden /></button></header>
        <dl>
          {def.triggers.map((t, i) => <div key={i}><dt>{t.type}</dt><dd>{triggerText(t)}{t.next ? ` · next ${dayTz(t.next)} ${hhmmTz(t.next)}` : ""}</dd></div>)}
          {def.triggers.length === 0 && <div><dt>trigger</dt><dd>none declared</dd></div>}
        </dl>
      </aside>
    );
  }
  if (node === "output") {
    return (
      <aside className="wfd-detail" aria-label={`Result of ${def.name}`}>
        <header><strong>Result · {def.name}</strong><button type="button" onClick={onClose} aria-label="Close detail"><X size={14} aria-hidden /></button></header>
        <dl><div><dt>runs on</dt><dd>{def.runs_on}</dd></div></dl>
      </aside>
    );
  }
  const s = def.steps[node];
  if (!s) return null;
  return (
    <aside className="wfd-detail" aria-label={`Step ${node} of ${def.name}`}>
      <header><strong>{node}</strong><button type="button" onClick={onClose} aria-label="Close detail"><X size={14} aria-hidden /></button></header>
      <dl>
        <div><dt>kind</dt><dd>{s.kind}</dd></div>
        <div><dt>executor</dt><dd>{s.executor}</dd></div>
        {(s.kind === "model" || s.kind === "agent") && <div><dt>lane</dt><dd>{s.lane ?? "not declared"}</dd></div>}
        {s.uses && <div><dt>action</dt><dd className="mono">{s.uses}</dd></div>}
        {s.workflow && <div><dt>runs workflow</dt><dd className="mono">{s.workflow}</dd></div>}
        <div><dt>side effects</dt><dd>{s.side_effects.length ? s.side_effects.join(", ") : "none"}</dd></div>
        {s.description && <div><dt>does</dt><dd>{s.description}</dd></div>}
        {(s.prompt || s.question) && <div><dt>{s.question ? "question" : "prompt"}</dt><dd><pre className="wfd-pre">{s.prompt ?? s.question}</pre></dd></div>}
        <Schema label="input schema" value={s.input} />
        <Schema label="output schema" value={s.output} />
      </dl>
    </aside>
  );
}

type EdgeSel = { wf: string; from: string; to: string } | null;
type Drag = { wf: string; from: string; x0: number; y0: number; x: number; y: number; over: string | null } | null;

/** Hand-offs (`feeds:`) are drawn apart from `after:` links: work waiting in a table or queue, not one run starting another (ISC-273). */
const HANDOFF_STYLE = { color: "#2DD4BF", dash: "2 5", label: "hands work to" } as const;

export function DefinitionCanvas({ defs, selected, onSelect, health, onChanged }: { defs: Definition[]; selected: Sel; onSelect: (s: Sel) => void; health: Map<string, DefHealth>; onChanged: () => void }) {
  const layout = useMemo(() => layoutAll(defs), [defs]);
  const lanesByName = useMemo(() => new Map(layout.lanes.map((l) => [l.name, l])), [layout]);
  const crossEdges = useMemo(() => workflowEdges(defs), [defs]);
  const selDef = selected ? defs.find((d) => d.name === selected.wf) : undefined;
  const openWf = useCallback((name: string | null) => onSelect(name ? { wf: name, node: "trigger" } : null), [onSelect]);
  const ed = useEditor(selDef ? selDef.name : null, onChanged, openWf, selDef?.hash);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [edgeSel, setEdgeSel] = useState<EdgeSel>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // Opening a workflow (a deep link, Edit from Pipelines, a New) brings its lane into view.
  const openName = selDef?.name ?? null;
  useEffect(() => {
    if (!openName) return;
    const t = setTimeout(() => {
      // Scroll the canvas box only, so the edit bar and the page stay where they are.
      const box = svgRef.current?.parentElement;
      const lane = svgRef.current?.querySelector(`[data-lane="${CSS.escape(openName)}"]`);
      if (!box || !lane) return;
      const top = lane.getBoundingClientRect().top - box.getBoundingClientRect().top;
      box.scrollTop += top - 48;
    }, 60);
    return () => clearTimeout(t);
  }, [openName, layout]);
  const editable = (wf: string) => !!ed.doc && ed.doc.name === wf && !ed.busy;

  const at = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const stepUnder = (e: { clientX: number; clientY: number }, wf: string): string | null => {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-step]");
    return el && el.getAttribute("data-wf") === wf ? el.getAttribute("data-step") : null;
  };
  const startDrag = (e: ReactPointerEvent, wf: string, from: string, x0: number, y0: number) => {
    if (!editable(wf)) {
      if (!ed.doc || ed.doc.name !== wf) onSelect({ wf, node: from });
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    try { svgRef.current?.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer has no capture; move and up still reach the svg */ }
    const p = at(e);
    setDrag({ wf, from, x0, y0, x: p.x, y: p.y, over: null });
  };
  const moveDrag = (e: ReactPointerEvent) => {
    if (!drag) return;
    const p = at(e);
    const over = stepUnder(e, drag.wf);
    setDrag({ ...drag, x: p.x, y: p.y, over: over && over !== drag.from ? over : null });
  };
  const endDrag = (e: ReactPointerEvent) => {
    if (!drag) return;
    const to = stepUnder(e, drag.wf);
    const from = drag.from;
    setDrag(null);
    if (to && to !== from) void ed.edit("/api/workflows/step", { op: "connect", from, to }, `Connect ${from} → ${to}`);
  };
  const disconnect = (x: NonNullable<EdgeSel>) => {
    setEdgeSel(null);
    void ed.edit("/api/workflows/step", { op: "disconnect", from: x.from, to: x.to }, `Disconnect ${x.from} → ${x.to}`);
  };
  const stepSelected = selDef && selected && selDef.steps[selected.node] ? selected.node : null;
  const inspect = selDef && selected && stepSelected && ed.doc?.name === selDef.name && ed.doc.steps[selected.node];

  return (
    <div className="wfd-canvas-wrap">
      <EditBar ed={ed} defs={defs} selected={selDef ? selDef.name : null} yamlOpen={yamlOpen && !!ed.doc} setYamlOpen={setYamlOpen} selectedStep={stepSelected} />
      {yamlOpen && ed.doc && selDef && ed.doc.name === selDef.name && <YamlEditor ed={ed} onClose={() => setYamlOpen(false)} />}
      <div className="wfd-legend" aria-label="Connection classes">
        {crossEdges.some((e) => e.kind === "handoff") && (
          <span className="wfd-legend-item">
            <svg width="34" height="10" aria-hidden><line x1="2" y1="5" x2="32" y2="5" stroke={HANDOFF_STYLE.color} strokeWidth="2" strokeDasharray={HANDOFF_STYLE.dash} /></svg>
            {HANDOFF_STYLE.label}
          </span>
        )}
        {(["checked", "runtime", "mismatch"] as const).map((c) => {
          const st = edgeStyle(c);
          return (
            <span key={c} className="wfd-legend-item">
              <svg width="34" height="10" aria-hidden><line x1="2" y1="5" x2="32" y2="5" stroke={st.color} strokeWidth="2" strokeDasharray={st.dash ?? undefined} />{st.cross && <text x="17" y="9" textAnchor="middle" fontSize="11" fill={st.color}>✕</text>}</svg>
              {st.label}
            </span>
          );
        })}
      </div>
      <div className="wfd-canvas-body" data-detail={selDef && selected ? "1" : undefined}>
      <div className="wfd-canvas-scroll">
        <svg ref={svgRef} className="wfd-canvas" width={layout.width + 120} height={layout.height} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={() => setDrag(null)} onClick={(e) => { if (e.target === e.currentTarget) setEdgeSel(null); }} role="group" aria-label={`Canvas of ${defs.length} typed workflow${defs.length === 1 ? "" : "s"}`}>
          {layout.lanes.map((lane) => {
            const def = defs.find((d) => d.name === lane.name)!;
            const boxes = new Map<string, Box>([["trigger", lane.trigger], ["output", lane.output], ...lane.steps.map((b) => [b.id, b] as [string, Box])]);
            const edges = stepEdges(def);
            const h = health.get(def.name) ?? "quiet";
            return (
              <g key={lane.name} data-lane={lane.name} role="group" aria-label={`workflow ${def.name}, ${DEF_HEALTH_META[h].label}`}>
                <text x={lane.trigger.x} y={lane.y - 12} className="wfd-lane-title">{def.name}<tspan className="wfd-lane-sub" dx="10">{DEF_HEALTH_META[h].label}{def.valid ? "" : ` · ${def.errors.length} validation error${def.errors.length === 1 ? "" : "s"}`}</tspan>{deployLabel(def.deploy)?.tone === "warn" && <tspan className="wfd-lane-drift" dx="10">{deployLabel(def.deploy)!.text}</tspan>}</text>
                {edges.map((e) => {
                  const a = boxes.get(e.from), b = boxes.get(e.to === "output" ? "output" : e.to);
                  if (!a || !b) return null;
                  const st = edgeStyle(e.cls);
                  const fromName = e.from === "trigger" ? "trigger" : e.from;
                  const toName = e.to === "output" ? "result" : e.to;
                  const label = edgeFieldLabel(e);
                  const mx = (a.x + a.w + b.x) / 2, my = (a.y + a.h / 2 + b.y + b.h / 2) / 2;
                  const name = edgeName(fromName, toName, e.cls, e.fields);
                  const isNeed = e.from !== "trigger" && e.to !== "output" && !!def.steps[e.from] && def.steps[e.to]?.needs.includes(e.from);
                  const eSel = isNeed && edgeSel?.wf === def.name && edgeSel.from === e.from && edgeSel.to === e.to;
                  const pick = () => { if (!isNeed) return; if (!ed.doc || ed.doc.name !== def.name) onSelect({ wf: def.name, node: e.to }); setEdgeSel(eSel ? null : { wf: def.name, from: e.from, to: e.to }); };
                  return (
                    <g key={`${e.from}-${e.to}`} className="wfd-edge" data-cls={e.cls} data-editable={isNeed ? "1" : undefined} data-sel={eSel ? "1" : undefined} tabIndex={0}
                      role={isNeed ? "button" : "img"} aria-pressed={isNeed ? eSel : undefined} aria-label={isNeed ? `${name}. Enter selects it; Delete disconnects.` : name}
                      onClick={(ev) => { ev.stopPropagation(); pick(); }}
                      onKeyDown={(ev) => {
                        if (!isNeed) return;
                        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(); }
                        if ((ev.key === "Delete" || ev.key === "Backspace") && editable(def.name)) { ev.preventDefault(); disconnect({ wf: def.name, from: e.from, to: e.to }); }
                      }}>
                      <title>{`${st.label}${e.reasons.length ? ` — ${e.reasons.join("; ")}` : ""}`}</title>
                      <path d={edgePath(a, b)} fill="none" stroke={st.color} strokeWidth={2} strokeDasharray={st.dash ?? undefined} />
                      <path d={edgePath(a, b)} fill="none" stroke="transparent" strokeWidth={12} />
                      {st.cross && <text x={mx} y={my + 4} textAnchor="middle" className="wfd-cross" fill={st.color}>✕</text>}
                      <text x={mx} y={my - 8} textAnchor="middle" className="wfd-edge-label">{label}</text>
                      <text x={mx} y={my + 18} textAnchor="middle" className="wfd-edge-class">{st.label}</text>
                      {eSel && editable(def.name) && (
                        <g className="wfd-unlink" role="button" tabIndex={0} aria-label={`Disconnect ${e.from} from ${e.to}`}
                          onClick={(ev) => { ev.stopPropagation(); disconnect({ wf: def.name, from: e.from, to: e.to }); }}
                          onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); disconnect({ wf: def.name, from: e.from, to: e.to }); } }}>
                          <rect x={mx - 42} y={my + 8} width={84} height={22} rx={11} />
                          <text x={mx} y={my + 23} textAnchor="middle">Disconnect</text>
                        </g>
                      )}
                    </g>
                  );
                })}
                {[...boxes.values()].map((b) => {
                  const isStep = b.id !== "trigger" && b.id !== "output";
                  const s = isStep ? def.steps[b.id] : undefined;
                  const title = b.id === "trigger" ? def.triggers.map(triggerText).join(" · ") || "no trigger" : b.id === "output" ? "result" : b.id;
                  const sub = s ? `${s.kind} · ${s.executor}${s.lane ? ` · ${s.lane}` : ""}` : b.id === "trigger" ? "trigger" : `runs ${def.runs_on}`;
                  const aria = s ? nodeName(s.kind, b.id, s.executor) : b.id === "trigger" ? `trigger of ${def.name}: ${title}` : `result of ${def.name}`;
                  const isSel = selected?.wf === def.name && selected.node === b.id;
                  const act = () => onSelect(isSel ? null : { wf: def.name, node: b.id });
                  return (
                    <g
                      key={b.id}
                      className="wfd-node"
                      data-kind={s ? s.kind : b.id}
                      data-sel={isSel ? "1" : undefined}
                      data-wf={isStep ? def.name : undefined}
                      data-step={isStep ? b.id : undefined}
                      data-drop={drag && drag.wf === def.name && drag.over === b.id ? "1" : undefined}
                      tabIndex={0}
                      role="button"
                      aria-pressed={isSel}
                      aria-label={aria}
                      onClick={act}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(); } }}
                    >
                      <rect x={b.x} y={b.y} width={NODE_W} height={NODE_H} rx={b.id === "trigger" ? NODE_H / 2 : 10} />
                      <text x={b.x + 14} y={b.y + 26} className="wfd-node-title">{title.length > 24 ? `${title.slice(0, 23)}…` : title}</text>
                      <text x={b.x + 14} y={b.y + 46} className="wfd-node-sub">{sub}</text>
                      {isStep && <circle className="wfd-port-in" cx={b.x} cy={b.y + NODE_H / 2} r={4.5} aria-hidden />}
                      {isStep && (
                        <circle className="wfd-port" cx={b.x + NODE_W} cy={b.y + NODE_H / 2} r={6}
                          onPointerDown={(ev) => startDrag(ev, def.name, b.id, b.x + NODE_W, b.y + NODE_H / 2)}
                          onClick={(ev) => ev.stopPropagation()}>
                          <title>{`Drag to another step of ${def.name} to make it run after ${b.id}`}</title>
                        </circle>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
          {crossEdges.map((e) => {
            const a = lanesByName.get(e.from), b = lanesByName.get(e.to);
            if (!a || !b) return null;
            const st = e.kind === "handoff" ? HANDOFF_STYLE : edgeStyle(e.cls);
            const x = layout.width + 40;
            const y1 = a.output.y + NODE_H / 2, y2 = b.trigger.y + NODE_H / 2;
            const d = `M${a.output.x + NODE_W},${y1} C${x + 60},${y1} ${x + 60},${y2} ${b.trigger.x + NODE_W / 2},${b.trigger.y}`;
            return (
              <g key={`${e.kind}-${e.from}-${e.to}`} className="wfd-edge wfd-xedge" tabIndex={0} role="img" aria-label={`${e.kind === "after" ? "after link" : e.kind === "handoff" ? `hand-off ${e.label}` : "sub-workflow"} from ${e.from} to ${e.to}, ${st.label}`}>
                <title>{`${e.label} · ${st.label}${e.reason ? ` — ${e.reason}` : ""}`}</title>
                <path d={d} fill="none" stroke={st.color} strokeWidth={2} strokeDasharray={st.dash ?? undefined} markerEnd="url(#wfd-arrow)" />
                <text x={x + 50} y={(y1 + y2) / 2} className="wfd-edge-label">{e.label}</text>
              </g>
            );
          })}
          {drag && (() => { const mx = (drag.x0 + drag.x) / 2; return <path className="wfd-drag" d={`M${drag.x0},${drag.y0} C${mx},${drag.y0} ${mx},${drag.y} ${drag.x},${drag.y}`} />; })()}
          <defs><marker id="wfd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor" /></marker></defs>
        </svg>
      </div>
      {selDef && selected && (inspect
        ? <StepInspector key={`${selDef.name}/${selected.node}`} ed={ed} stepId={selected.node} onClose={() => onSelect(null)} onRemoved={() => onSelect({ wf: selDef.name, node: "trigger" })} />
        : <Detail def={selDef} node={selected.node} onClose={() => onSelect(null)} />)}
      </div>
    </div>
  );
}

export { Loading as DefsLoading, Empty as DefsEmpty, Retry as DefsRetry };

export function DefsStyles() {
  return (
    <style>{`
.wfd-state{display:flex;flex-direction:column;gap:10px;align-items:flex-start;padding:28px;border:1px dashed var(--line,#333);border-radius:12px;margin:12px 0}
.wfd-state code{font-size:12px;overflow-wrap:anywhere}
.wfd-state>strong{display:block;font-size:16px;line-height:1.35;white-space:nowrap}
.wfd-state>span{display:block;line-height:1.6;max-width:72ch}
.wfd-state .wf-refresh{white-space:nowrap}
.wfd-toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:10px 0}
.wfd-filters{display:flex;gap:6px}
.wfd-filters button{border:1px solid var(--line,#333);background:transparent;color:inherit;border-radius:999px;padding:4px 10px;font-size:12px;cursor:pointer}
.wfd-filters button[aria-pressed="true"]{background:var(--ink-1,#eee);color:var(--bg,#111)}
.wfd-row{border:1px solid var(--line,#2a2a2a);border-radius:10px;margin:6px 0;background:var(--panel,transparent)}
.wfd-row-head{display:flex;gap:12px;align-items:center;padding:10px 12px;cursor:pointer;flex-wrap:wrap}
.wfd-row-head:focus-visible,.wfd-node:focus-visible,.wfd-edge:focus-visible{outline:2px solid #3b82f6;outline-offset:2px}
.wfd-name{font-weight:600}
.wfd-trig,.wfd-last,.wfd-next{font-size:12px;color:#94a3b8;white-space:nowrap}
.wfd-filters button,.wfu-title,.wfd-name{white-space:nowrap}
.wfs-strip{justify-self:start}
.wfd-last{margin-left:auto}
.wfd-last [data-s="error"]{color:var(--err)}
.wfd-last [data-s="ok"]{color:var(--ok)}
.wfd-badge{font-size:11px;border:1px solid;border-radius:999px;padding:2px 8px;white-space:nowrap}
.wfd-errors{margin:0 12px 10px 12px;padding:8px 12px 8px 26px;border-left:3px solid var(--err);font-size:12px;background:rgba(239,68,68,.06)}
.wfd-row-body{padding:0 12px 12px 12px;font-size:13px}
.wfd-pause{display:inline-flex;gap:4px;align-items:center;font-size:12px;padding:3px 8px;border-radius:6px;border:1px solid var(--line,#333);background:transparent;color:inherit;opacity:.5;cursor:not-allowed}
.wfd-canvas-wrap{position:relative;margin-top:10px}
.wfd-legend{display:flex;gap:16px;font-size:12px;margin:6px 0 10px}
.wfd-legend-item{display:inline-flex;gap:6px;align-items:center}
.wfd-canvas-scroll{overflow:auto;max-height:min(74vh,960px);border:1px solid var(--line,#2a2a2a);border-radius:12px;background:radial-gradient(circle,rgba(127,127,127,.18) 1px,transparent 1px) 0 0/22px 22px}
.wfd-canvas{display:block;color:#94a3b8}
.wfd-node rect{fill:#111a2b;stroke:#334155;stroke-width:1.5}
.wfd-node[data-kind="trigger"] rect{stroke:#3b82f6}
.wfd-node[data-kind="output"] rect{stroke-dasharray:4 3}
.wfd-node[data-kind="model"] rect,.wfd-node[data-kind="agent"] rect{stroke:#a855f7}
.wfd-node[data-kind="judgment"] rect{stroke:#f59e0b}
.wfd-node[data-kind="human"] rect{stroke:#ec4899}
.wfd-node[data-sel="1"] rect{stroke:#3b82f6;stroke-width:3}
.wfd-node{cursor:pointer}
.wfd-node-title{font-size:13px;font-weight:600;fill:#e6edf7}
.wfd-node-sub{font-size:11px;fill:#94a3b8}
.wfd-lane-title{font-size:13px;font-weight:700;fill:#e6edf7}
.wfd-lane-sub{font-size:11px;font-weight:400;fill:#94a3b8}
.wfd-edge-label{font-size:11px;fill:#e2e8f0;paint-order:stroke;stroke:#070d1a;stroke-width:4px}
.wfd-edge-class{font-size:10px;fill:#94a3b8;opacity:0;paint-order:stroke;stroke:#070d1a;stroke-width:4px}
.wfd-edge:hover .wfd-edge-class,.wfd-edge:focus .wfd-edge-class{opacity:1}
.wfd-cross{font-size:14px;font-weight:700}
.wfd-canvas-body{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;align-items:start}
.wfd-canvas-body[data-detail="1"]{grid-template-columns:minmax(0,1fr) 288px}
@media (max-width:900px){.wfd-canvas-body[data-detail="1"]{grid-template-columns:minmax(0,1fr)}}
.wfd-detail{position:sticky;top:12px;max-height:min(74vh,960px);overflow:auto;background:var(--panel,#10131a);border:1px solid var(--line,#333);border-radius:12px;padding:12px;font-size:12px;min-width:0}
.wfd-detail header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.wfd-detail header button{background:none;border:none;color:inherit;cursor:pointer}
.wfd-detail dl{display:flex;flex-direction:column;gap:8px;margin:0}
.wfd-detail dt{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8}
.wfd-detail dd{margin:2px 0 0}
.wfd-pre{white-space:pre-wrap;word-break:break-word;font-size:11px;margin:0;padding:6px;border-radius:6px;background:rgba(127,127,127,.08)}
.wfd-none{padding:12px}
.wfs-strip{display:inline-flex;align-items:center;font-size:12px;line-height:1;min-width:0;flex-wrap:nowrap;overflow:hidden}
.wfs-stage{display:inline-flex;align-items:center;gap:5px}
.wfs-glyph{font-size:11px;width:12px;text-align:center;color:#94a3b8}
.wfs-glyph[data-kind="trigger"]{color:#60a5fa}
.wfs-glyph[data-kind="model"],.wfs-glyph[data-kind="agent"]{color:#c084fc}
.wfs-glyph[data-kind="judgment"]{color:#fbbf24}
.wfs-glyph[data-kind="human"]{color:#f472b6}
.wfs-glyph[data-kind="code"],.wfs-glyph[data-kind="command"]{color:#cbd5e1}
.wfs-step{font-size:12px;color:#e2e8f0}
.wfs-type{font-size:11px;color:#94a3b8;padding:2px 5px;border-radius:4px;background:rgba(148,163,184,.1)}
.wfs-hop{display:inline-block;width:18px;height:0;border-top:2px solid #34d399;margin:0 6px;position:relative}
.wfs-hop[data-cls="runtime"]{border-top-style:dashed;border-top-color:#f59e0b}
.wfs-hop[data-cls="mismatch"]{border-top-style:dotted;border-top-color:#f87171}
.wfs-hop[data-cls="mismatch"]::after{content:"✕";position:absolute;left:5px;top:-8px;font-size:10px;color:#f87171}
.wfs-hop[data-cls="untyped"]{width:12px;border-top:1px solid #475569;margin:0 3px}
.wfu-list{margin-top:20px;border-top:1px solid var(--line-1,#1e293b);padding-top:14px}
.wfu-head{display:grid;grid-template-columns:max-content max-content 1fr;column-gap:20px;align-items:baseline;margin:0 0 8px;padding:0 12px}
.wfu-legend{justify-self:end;display:flex;gap:14px;font-size:11px;color:#94a3b8;white-space:nowrap}
.wfu-legend i{font-style:normal;margin-right:4px}
.wfu-legend i[data-kind="trigger"]{color:#60a5fa}.wfu-legend i[data-kind="code"]{color:#cbd5e1}.wfu-legend i[data-kind="model"]{color:#c084fc}.wfu-legend i[data-kind="judgment"]{color:#fbbf24}.wfu-legend i[data-kind="human"]{color:#f472b6}
.wfd-next{padding-left:8px}
.wfu-title{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#cbd5e1}
.wfu-sub{font-size:12px;color:#94a3b8}
.wfu-row{display:grid;grid-template-columns:minmax(180px,1.3fr) minmax(170px,1fr) minmax(140px,.9fr) auto;gap:14px;align-items:center;padding:9px 12px;border-bottom:1px solid rgba(148,163,184,.08);font-size:13px}
.wfu-row:hover{background:rgba(148,163,184,.04)}
.wfu-name{color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.wfu-namecell,.wfd-namecell{display:inline-flex;align-items:center;gap:6px;min-width:0}
.wfu-trig{font-size:12px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wfu-tag{font-size:10.5px;color:#94a3b8;border:1px dashed #475569;border-radius:4px;padding:2px 5px;margin-left:8px;letter-spacing:.04em}
.wfu-row .wfd-last{margin-left:0;text-align:right}
`}</style>
  );
}
