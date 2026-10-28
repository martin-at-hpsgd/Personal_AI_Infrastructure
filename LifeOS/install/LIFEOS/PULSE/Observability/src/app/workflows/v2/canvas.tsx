"use client";

/**
 * Pipelines tab: the pan/zoom canvas. Read-only by design (editing
 * definitions from here is out of scope), so nodes do not drag or connect.
 *
 * Drawn the way Maestro Cue draws its pipelines (principal directive, 2026-09-29): every frame is one pipeline in its
 * own colour, carried by the frame tint, label, trigger cap, step bars,
 * handles and edges. The tab opens on All Pipelines, the whole machine fitted
 * to the pane; zoomed out, each frame's name is drawn at a fixed screen size
 * above it so every pipeline stays nameable, and a floating legend names
 * every pipeline with its count.
 * Clicking a legend entry, or a node, opens that pipeline at a readable zoom.
 */

import "@xyflow/react/dist/base.css";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import { Boxes, CircleSlash, Clock, Cloud, Hand, Infinity as InfinityIcon, Laptop, LayoutGrid, Send } from "lucide-react";
import {
  EXECUTOR_META,
  HEALTH_META,
  HealthGlyph,
  RUNTIME_META,
  hexAlpha,
  lastRunNote,
  type Finding,
  type Inventory,
  type Runtime,
  type WorkflowRecord,
} from "../shared";
import { compactPath } from "../strip";
import type { ActivityRow } from "./api";
import { RecordDrawer, SkillDrawer } from "./drawer";
import {
  DETAIL_ZOOM,
  layoutCanvas,
  type CanvasNode,
  type DestNode,
  type FrameInfo,
  type FrameNode,
  type SkillNode,
  type StepNode,
  type TriggerNode,
} from "./arrange";
import { RunButton } from "./run";
import { AppIcons } from "./app-icons";

const TRIGGER_ICON = { schedule: Clock, daemon: InfinityIcon, "on-demand": Hand } as const;
const RING_COLOR = { high: "var(--err)", medium: "var(--warn)", low: "rgba(251,191,36,0.55)" } as const;
const MAX_FRAME_ZOOM = 1.1;
/** Opening one pipeline never zooms below this: node titles stay readable. */
const FRAME_MIN_ZOOM = 0.7;
/** Below this zoom the in-frame labels are too small to read, so screen-space labels take over. */
const OVERLAY_LABEL_ZOOM = 0.55;
const VIEW_PAD = 24;
/** Top padding (px) for the fitted All Pipelines view, clear of the floating legend. */
const LEGEND_CLEARANCE = 132;
/** Same floor as the ReactFlow minZoom below; a fit never asks for less. */
const MIN_ZOOM = 0.08;
/** Below this the pane has not been laid out yet, and a fit computed from it would be garbage. */
const MIN_PANE = 120;

/** Cue's handle: a filled dot in the pipeline colour, ringed, on the ground colour. */
const handleStyle = (color: string): CSSProperties => ({ background: color, boxShadow: `0 0 0 2px ${color}` });

/** Where a workflow runs: the Cloudflare fleet (Workers, and typed workflows grouped "cloud"), or this Mac. */
export type Where = "local" | "cloud";
export function whereOf(r: WorkflowRecord): Where {
  return r.runtime === "cloud" || (r.runtime === "workflow" && r.group === "cloud") ? "cloud" : "local";
}

/* ── Node renderers ── */

const hiddenHandle = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 };

const FrameBox = memo(function FrameBox({ data }: NodeProps<FrameNode>) {
  const color = data.color;
  return (
    <div className="wf2-frame" style={{ background: hexAlpha(color, 0.08), borderColor: hexAlpha(color, 0.42) }}>
      <div className="wf2-frame-label" style={{ color, background: hexAlpha(color, 0.12), borderColor: hexAlpha(color, 0.4) }}>
        {data.label}
      </div>
      <span className="wf2-frame-sub">{data.sub} · {data.count}</span>
    </div>
  );
});

const TriggerPill = memo(function TriggerPill({ data }: NodeProps<TriggerNode>) {
  const r = data.record;
  const color = data.color;
  const Icon = TRIGGER_ICON[r.trigger.kind];
  const ring = data.ring ? RING_COLOR[data.ring] : undefined;
  const failing = data.health === "fail";
  return (
    <div
      className="wf2-pill"
      data-health={data.health}
      data-ring={data.ring ?? undefined}
      data-selected={data.selected ? "1" : undefined}
      style={{ background: hexAlpha(color, 0.1), borderColor: failing ? "var(--err)" : hexAlpha(color, data.selected ? 1 : 0.4), outlineColor: ring }}
      title={`${r.title}\n${r.trigger.display} · ${HEALTH_META[data.health].label}\n${lastRunNote(r)}`}
    >
      <span className="wf2-pill-cap" style={{ background: color }}>
        <Icon size={15} aria-hidden />
      </span>
      <span className="wf2-pill-body">
        <span className="wf2-pill-title" style={{ color }}>
          <HealthGlyph health={data.health} size={10} />
          <span className="wf2-pill-name">{r.title}</span>
          <AppIcons apps={r.apps} />
        </span>
        <span className="wf2-pill-sub">{r.trigger.display}</span>
      </span>
      <span className="nodrag nopan wf2-pill-run">
        <RunButton record={r} compact />
      </span>
      <Handle type="source" position={Position.Right} isConnectable={false} className="wf2-handle" style={handleStyle(failing ? "#f87171" : color)} />
    </div>
  );
});

const StepBox = memo(function StepBox({ data }: NodeProps<StepNode>) {
  if (data.label === null || data.executor === null) {
    return (
      <div className="wf2-node" data-empty="1" data-selected={data.selected ? "1" : undefined} title="This workflow does not declare its steps">
        <Handle type="target" position={Position.Left} isConnectable={false} style={hiddenHandle} />
        <span className="wf2-node-body">
          <span className="wf2-node-title">steps not declared</span>
        </span>
        <Handle type="source" position={Position.Right} isConnectable={false} style={hiddenHandle} />
      </div>
    );
  }
  const E = EXECUTOR_META[data.executor];
  const Icon = E.icon;
  const color = data.color;
  return (
    <div
      className="wf2-node"
      data-selected={data.selected ? "1" : undefined}
      style={data.selected ? { borderColor: color, boxShadow: `0 4px 16px ${hexAlpha(color, 0.3)}` } : undefined}
      title={`${data.label}\n${E.label}: ${E.blurb}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className="wf2-handle" style={handleStyle(color)} />
      <span className="wf2-node-bar" style={{ background: color }} aria-hidden>
        <Icon size={14} aria-hidden />
      </span>
      <span className="wf2-node-body">
        <span className="wf2-node-title mono">{data.label}</span>
        <span className="wf2-node-sub">
          <Icon size={12} style={{ color: E.color }} aria-hidden /> {E.label}
          {data.total > 1 && <> · step {data.index + 1} of {data.total}</>}
        </span>
      </span>
      <Handle type="source" position={Position.Right} isConnectable={false} className="wf2-handle" style={handleStyle(color)} />
    </div>
  );
});

const DestBox = memo(function DestBox({ data }: NodeProps<DestNode>) {
  const empty = !data.destination;
  const color = data.color;
  return (
    <div
      className="wf2-node"
      data-kind="dest"
      data-empty={empty ? "1" : undefined}
      data-selected={data.selected ? "1" : undefined}
      style={data.selected && !empty ? { borderColor: color, boxShadow: `0 4px 16px ${hexAlpha(color, 0.3)}` } : undefined}
      title={empty ? "Destination not declared" : `${data.destination}${data.output ? `\n${data.output}` : ""}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className={empty ? undefined : "wf2-handle"} style={empty ? hiddenHandle : handleStyle(color)} />
      {!empty && (
        <span className="wf2-node-bar" data-kind="dest" style={{ background: hexAlpha(color, 0.55) }} aria-hidden>
          <Send size={13} aria-hidden />
        </span>
      )}
      <span className="wf2-node-body">
        <span className="wf2-node-title">
          {empty ? "destination not declared" : compactPath(data.destination ?? "")}
        </span>
        {!empty && data.output && <span className="wf2-node-sub">{data.output}</span>}
      </span>
    </div>
  );
});

const SkillTile = memo(function SkillTile({ data }: NodeProps<SkillNode>) {
  return (
    <div className="wf2-skill" data-selected={data.selected ? "1" : undefined} title={`${data.skill}: ${data.count} on-demand intent${data.count === 1 ? "" : "s"}`}>
      <HealthGlyph health={data.health} size={10} />
      <span className="wf2-skill-title">{data.skill}</span>
      <span className="wf2-skill-count mono">{data.count}</span>
    </div>
  );
});

const NODE_TYPES: NodeTypes = { frame: FrameBox, trigger: TriggerPill, step: StepBox, dest: DestBox, skill: SkillTile };

function minimapColor(n: Node): string {
  const node = n as CanvasNode;
  switch (node.type) {
    case "frame":
      return hexAlpha(node.data.color, 0.22);
    case "trigger":
      return node.data.health === "fail" ? "#F87171" : node.data.color;
    case "step":
    case "dest":
      return hexAlpha(node.data.color, 0.75);
    case "skill":
      return node.data.health === "fail" ? "#F87171" : "rgba(148,163,184,0.6)";
    default:
      return "rgba(130,157,187,0.45)";
  }
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* ── The canvas ── */

export interface CanvasProps {
  inv: Inventory;
  records: WorkflowRecord[];
  skillRecords: WorkflowRecord[];
  findingsMap: Map<string, Finding[]>;
  runsByRecord: Map<string, ActivityRow[]>;
  now: number;
  selectedId: string | null;
  selectedSkill: string | null;
  focus: { id: string; nonce: number } | null;
  runtimeFilter: Runtime | null;
  runtimeCounts: Array<{ runtime: Runtime; count: number }>;
  where: Where;
  whereCounts: Record<Where, number>;
  onWhere: (where: Where) => void;
  showOnDemand: boolean;
  onDemandCount: number;
  onSelect: (id: string | null) => void;
  onSelectSkill: (skill: string | null) => void;
  onRuntime: (rt: Runtime) => void;
  onToggleOnDemand: () => void;
  onOpenCard: (id: string) => void;
  /** Opens a typed workflow in the Canvas tab editor. */
  onEdit?: (name: string) => void;
}

export function PipelineCanvas(props: CanvasProps) {
  const { inv, selectedId, selectedSkill, skillRecords, findingsMap, runsByRecord, now, onSelect, onSelectSkill, onOpenCard, onEdit } = props;
  const [collapsed, setCollapsed] = useState(false);
  const byId = useMemo(() => new Map(inv.records.map((r) => [r.id, r])), [inv]);
  const selected = selectedId ? byId.get(selectedId) : undefined;
  const skillList = useMemo(
    () => (selectedSkill ? skillRecords.filter((r) => r.group === selectedSkill).sort((a, b) => a.title.localeCompare(b.title)) : []),
    [selectedSkill, skillRecords],
  );

  return (
    <div className="wf2-canvas-wrap">
      <div className="wf2-canvas-bar">
        <div className="wf2-where" role="tablist" aria-label="Where the workflows run">
          {([["local", Laptop, "Local"], ["cloud", Cloud, "Cloud"]] as const).map(([w, Icon, label]) => (
            <button
              key={w}
              type="button"
              role="tab"
              aria-selected={props.where === w}
              className="wf2-where-tab"
              onClick={() => props.onWhere(w)}
              title={w === "local" ? "Workflows that run on this Mac" : "Workflows that run on the Cloudflare fleet"}
            >
              <Icon size={14} aria-hidden /> {label} <span className="mono wf2-muted">{props.whereCounts[w]}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="wf2-toggle"
          role="switch"
          aria-checked={props.showOnDemand}
          onClick={props.onToggleOnDemand}
          title="On-demand workflows: launchd services that start when asked, and skill intents collapsed to one tile per skill"
        >
          <span className="wf2-switch" data-on={props.showOnDemand ? "1" : "0"} aria-hidden />
          <Boxes size={14} aria-hidden />
          On-demand <span className="mono wf2-muted">{props.onDemandCount}</span>
        </button>
        <div className="wf2-legend" role="group" aria-label="Filter the canvas by runtime">
          {props.runtimeCounts.map(({ runtime, count }) => (
            <button
              key={runtime}
              type="button"
              className="wf2-legend-item"
              aria-pressed={props.runtimeFilter === runtime}
              data-dim={props.runtimeFilter && props.runtimeFilter !== runtime ? "1" : undefined}
              onClick={() => props.onRuntime(runtime)}
            >
              <span className="wf2-dot" style={{ background: RUNTIME_META[runtime].color }} aria-hidden />
              {RUNTIME_META[runtime].label}
              <span className="mono wf2-muted">{count}</span>
            </button>
          ))}
        </div>
        <span className="wf2-bar-hint">Scroll to zoom · pick a pipeline in the legend to open it</span>
        <a className="wf2-credit" href="https://runmaestro.ai" target="_blank" rel="noreferrer">Design: Maestro</a>
        <a className="wf2-credit" href="https://reactflow.dev" target="_blank" rel="noreferrer">React Flow</a>
      </div>

      <div className="wf2-stage">
        <ReactFlowProvider>
          <Pane {...props} byId={byId} />
        </ReactFlowProvider>

        {selected && (
          <RecordDrawer
            record={selected}
            inv={inv}
            findings={findingsMap.get(selected.id) ?? []}
            runs={runsByRecord.get(selected.id) ?? []}
            now={now}
            collapsed={collapsed}
            onToggle={() => setCollapsed((c) => !c)}
            onClose={() => { onSelect(null); onSelectSkill(null); }}
            onOpenCard={onOpenCard}
            onEdit={onEdit}
            onBack={selected.runtime === "skill" && selectedSkill ? () => onSelect(null) : undefined}
          />
        )}
        {!selected && selectedSkill && skillList.length > 0 && (
          <SkillDrawer
            skill={selectedSkill}
            records={skillList}
            findingsMap={findingsMap}
            collapsed={collapsed}
            onToggle={() => setCollapsed((c) => !c)}
            onClose={() => onSelectSkill(null)}
            onPick={(id) => onSelect(id)}
          />
        )}
      </div>
    </div>
  );
}

function Pane(props: CanvasProps & { byId: Map<string, WorkflowRecord> }) {
  const { records, skillRecords, findingsMap, selectedId, selectedSkill, focus, byId, onSelect, onSelectSkill } = props;
  const rf = useReactFlow();
  const paneW = useStore((s) => s.width);
  const paneH = useStore((s) => s.height);
  const [tx, ty, zoom] = useStore((s) => s.transform);
  const [opened, setOpened] = useState(false);
  /** The pipeline the legend marks as open, or null for All Pipelines. */
  const [openKey, setOpenKey] = useState<string | null>(null);
  /** The pane's shape when the tab opened, fixed after that so a drawer opening or closing never reshuffles the frames. */
  const [aspect, setAspect] = useState<number | null>(null);
  useEffect(() => {
    if (aspect === null && paneW >= MIN_PANE && paneH >= MIN_PANE) {
      setAspect(Math.min(4, Math.max(1, (paneW - VIEW_PAD * 2) / (paneH - Math.min(LEGEND_CLEARANCE, paneH * 0.3) - VIEW_PAD))));
    }
  }, [aspect, paneW, paneH]);
  /** The focus request last applied, when, and at what pane height (the drawer opening below resizes the pane once). */
  const handledFocus = useRef<{ nonce: number; at: number; paneH: number } | null>(null);

  const detail = useMemo(
    () => layoutCanvas({ records, skillRecords, findingsMap, selectedId, selectedSkill, aspect: aspect ?? undefined }),
    [records, skillRecords, findingsMap, selectedId, selectedSkill, aspect],
  );

  const reduced = prefersReducedMotion();

  /** All Pipelines: the whole machine fitted to the pane, clear of the legend. */
  const showAll = useCallback(
    (animate: boolean) => {
      setOpenKey(null);
      if (detail.width <= 0 || detail.height <= 0 || paneW < MIN_PANE || paneH < MIN_PANE) return;
      const topPad = Math.min(LEGEND_CLEARANCE, paneH * 0.3);
      const fit = Math.min((paneW - VIEW_PAD * 2) / detail.width, (paneH - topPad - VIEW_PAD) / detail.height);
      const z = Math.min(1, Math.max(MIN_ZOOM, fit));
      const x = (paneW - detail.width * z) / 2;
      const y = topPad;
      rf.setViewport({ x, y, zoom: z }, { duration: animate && !reduced ? 350 : 0 });
    },
    [detail.width, detail.height, paneW, paneH, rf, reduced],
  );

  /** One pipeline: centred when it fits at a readable zoom, else anchored at its top-left. */
  const showFrame = useCallback(
    (f: FrameInfo) => {
      setOpenKey(f.key);
      const fit = Math.min((paneW - VIEW_PAD * 2) / f.w, (paneH - VIEW_PAD * 2) / f.h);
      const z = Math.min(MAX_FRAME_ZOOM, Math.max(FRAME_MIN_ZOOM, fit));
      const fits = fit >= z;
      const x = fits ? (paneW - f.w * z) / 2 - f.x * z : VIEW_PAD - f.x * z;
      const y = fits ? (paneH - f.h * z) / 2 - f.y * z : VIEW_PAD - f.y * z;
      rf.setViewport({ x, y, zoom: z }, { duration: reduced ? 0 : 350 });
    },
    [paneW, paneH, rf, reduced],
  );

  // Opening view, once the pane has a size: All Pipelines, unless a focus request opens a workflow.
  useEffect(() => {
    if (opened || aspect === null || paneW < MIN_PANE || paneH < MIN_PANE) return;
    // A focus request owns the opening view whether or not it has been applied yet;
    // fitting All Pipelines here would undo a focus the effect below already set.
    if (focus) {
      const rec = byId.get(focus.id);
      if (detail.anchors.has(focus.id) || (rec && detail.skillAnchors.has(rec.group))) {
        setOpened(true);
        return;
      }
    }
    setOpened(true);
    showAll(false);
  }, [opened, aspect, paneW, paneH, focus, byId, detail, showAll]);

  // A filter change or a pane resize reshapes the view: refit All Pipelines when that is what is showing.
  useEffect(() => {
    if (opened && openKey === null && !selectedId && !selectedSkill) showAll(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.width, detail.height, paneW, paneH]);

  // Bring a workflow (or its skill tile) into view when asked. Its whole
  // pipeline is shown when it fits; otherwise the pipeline's left edge sits at
  // the pane edge and the workflow is centred vertically. Applied again once
  // if the pane resizes right after (the drawer opening below it).
  useEffect(() => {
    // Wait for the fixed aspect: the layout reshapes once it is set, and a focus applied before that lands on stale coordinates.
    if (!focus || aspect === null || paneW <= 0 || paneH <= 0) return;
    const prev = handledFocus.current;
    const again = prev?.nonce === focus.nonce;
    if (again && (prev.paneH === paneH || Date.now() - prev.at > 1500)) return;
    const rec = byId.get(focus.id);
    const anchor = detail.anchors.get(focus.id) ?? (rec ? detail.skillAnchors.get(rec.group) : undefined);
    if (!anchor) return; // not laid out yet (the page is turning a filter off); re-runs when the layout changes
    handledFocus.current = { nonce: focus.nonce, at: again && prev ? prev.at : Date.now(), paneH };
    const z = Math.max(rf.getZoom(), DETAIL_ZOOM);
    const frame = detail.frames.find((f) => anchor.x >= f.x && anchor.x <= f.x + f.w && anchor.y >= f.y && anchor.y <= f.y + f.h);
    setOpenKey(frame?.key ?? null);
    let x = paneW / 2 - anchor.x * z;
    let y = paneH / 2 - anchor.y * z;
    if (frame) {
      x = frame.w * z <= paneW - VIEW_PAD * 2 ? (paneW - frame.w * z) / 2 - frame.x * z : VIEW_PAD - frame.x * z;
      if (frame.h * z <= paneH - VIEW_PAD * 2) y = (paneH - frame.h * z) / 2 - frame.y * z;
    }
    rf.setViewport({ x, y, zoom: z }, { duration: !again && !reduced ? 400 : 0 });
  }, [focus, aspect, paneW, paneH, byId, detail, rf, reduced]);

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      const n = node as CanvasNode;
      if (n.type === "trigger") onSelect(n.data.record.id);
      else if (n.type === "step" || n.type === "dest") onSelect(n.data.recordId);
      else if (n.type === "skill") onSelectSkill(n.data.skill);
    },
    [onSelect, onSelectSkill],
  );

  const empty = records.length === 0 && skillRecords.length === 0;

  return (
    <div className="wf2-canvas" data-far={zoom < OVERLAY_LABEL_ZOOM ? "1" : undefined}>
      <ReactFlow
        nodes={detail.nodes}
        edges={detail.edges}
        nodeTypes={NODE_TYPES}
        onNodeClick={onNodeClick}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        nodesFocusable
        edgesFocusable={false}
        minZoom={MIN_ZOOM}
        maxZoom={2}
        onlyRenderVisibleElements
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
        aria-label="Workflow pipelines canvas"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#1f3656" />
        <Controls position="bottom-left" showFitView={false} showInteractive>
          <ControlButton onClick={() => showAll(true)} title="All pipelines" aria-label="Show all pipelines">
            <LayoutGrid size={13} aria-hidden />
          </ControlButton>
        </Controls>
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={minimapColor}
          nodeStrokeWidth={0}
          nodeBorderRadius={3}
          style={{ width: 200, height: 120 }}
          maskColor="rgba(5,11,23,0.72)"
          bgColor="rgba(10,21,40,0.92)"
          ariaLabel="Minimap"
        />
      </ReactFlow>
      {zoom < OVERLAY_LABEL_ZOOM && (
        <div className="wf2-flabels" aria-hidden>
          {detail.frames.map((f) => (
            <span
              key={f.key}
              className="wf2-flabel"
              style={{ left: f.x * zoom + tx, top: f.y * zoom + ty, maxWidth: Math.max(60, f.w * zoom), color: f.color, background: `color-mix(in srgb, ${f.color} 20%, #07101d)`, borderColor: hexAlpha(f.color, 0.6) }}
            >
              {f.label}
            </span>
          ))}
        </div>
      )}
      {detail.frames.length > 0 && (
        <PipelineLegend frames={detail.frames} openKey={openKey} onAll={() => showAll(true)} onPick={showFrame} />
      )}
      {empty && (
        <div className="wf2-canvas-empty" role="status">
          <CircleSlash size={18} aria-hidden />
          <span>Nothing matches the current filter.</span>
        </div>
      )}
    </div>
  );
}

/** Cue's floating legend: every pipeline by colour and count, failing counts in red. Picking one opens it. */
function PipelineLegend({ frames, openKey, onAll, onPick }: { frames: FrameInfo[]; openKey: string | null; onAll: () => void; onPick: (f: FrameInfo) => void }) {
  return (
    <nav className="wf2-plegend nodrag nopan" aria-label="Pipelines">
      <button type="button" className="wf2-plegend-item" data-all="1" aria-pressed={openKey === null} onClick={onAll}>
        All pipelines <span className="mono wf2-muted">{frames.length}</span>
      </button>
      {frames.filter((f) => openKey === null || f.key === openKey).map((f) => (
        <button
          key={f.key}
          type="button"
          className="wf2-plegend-item"
          aria-pressed={openKey === f.key}
          onClick={() => onPick(f)}
          title={`${f.label} · ${f.sub} · ${f.count} workflow${f.count === 1 ? "" : "s"}${f.failing ? ` · ${f.failing} failing` : ""}`}
        >
          <span className="wf2-dot" style={{ background: f.color }} aria-hidden />
          <span className="wf2-plegend-name">{f.label}</span>
          <span className="mono wf2-muted">({f.count})</span>
          {f.failing > 0 && <span className="wf2-plegend-fail mono">{f.failing}✕</span>}
        </button>
      ))}
    </nav>
  );
}
