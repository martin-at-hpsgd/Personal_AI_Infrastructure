/**
 * Workflows V2 — deterministic canvas layout. Pure: the same records, filters
 * and findings always produce the same node positions, so the canvas never
 * reshuffles between reloads and "View in Pipeline" can centre on a known point.
 *
 * Shape (Cue's pipeline editor, mapped onto our inventory):
 *   one row per workflow:  trigger pill → step node(s) → destination node
 *   rows grouped into a tinted, labelled frame per runtime + group
 *   frames packed into columns, shortest column first
 *   on-demand skill intents, when shown, collapse to one tile per skill in a
 *   frame of their own below the columns
 *
 * Each frame carries its own pipeline colour (Maestro Cue's palette), and the
 * packing aims at the pane's shape so All Pipelines fills the canvas.
 */

import type { Edge, Node } from "@xyflow/react";
import {
  HEALTH_META,
  RUNTIME_META,
  SCHEDULED_RUNTIMES,
  SEVERITY_ORDER,
  healthOf,
  type Finding,
  type Health,
  type Runtime,
  type Severity,
  type WorkflowRecord,
} from "../shared";

export const PILL_W = 288;
export const PILL_H = 62;
export const STEP_W = 224;
export const STEP_H = 62;
export const DEST_W = 264;
export const GAP_X = 52;
export const ROW_H = 84;
export const FRAME_PAD_X = 22;
export const FRAME_PAD_TOP = 58;
export const FRAME_PAD_BOTTOM = 20;
export const FRAME_GAP_X = 64;
export const FRAME_GAP_Y = 56;
export const SKILL_W = 236;
export const SKILL_H = 52;
export const SKILL_GAP = 14;

/** Zoom a workflow opens at when it is brought into view: node titles at full size. */
export const DETAIL_ZOOM = 1;
const MAX_COLUMNS = 8;

/**
 * Pipeline palette (Maestro Cue's): every frame gets its own saturated colour,
 * carried by its label, trigger caps, step bars, handles and edges, so one
 * pipeline reads as one thing at any zoom. Picked by a hash of the frame key,
 * so a frame keeps its colour when a filter hides its neighbours.
 */
export const PIPELINE_COLORS = [
  "#06b6d4", "#8b5cf6", "#f59e0b", "#ef4444", "#22c55e", "#ec4899",
  "#3b82f6", "#f97316", "#14b8a6", "#a855f7", "#eab308", "#6366f1",
] as const;
/** Skill intents are infrastructure, not a pipeline: slate, like Cue's command nodes. */
export const SKILL_FRAME_COLOR = "#64748b";

export function pipelineColor(key: string): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return PIPELINE_COLORS[(h >>> 0) % PIPELINE_COLORS.length];
}
/** Width:height the packed frames aim for when the pane's own shape is not known yet. */
const TARGET_ASPECT = 2.6;

export type Ring = Severity | null;

export interface FrameData extends Record<string, unknown> {
  label: string;
  sub: string;
  runtime: Runtime | "skill-set";
  count: number;
  color: string;
}
export interface TriggerData extends Record<string, unknown> {
  record: WorkflowRecord;
  health: Health;
  ring: Ring;
  selected: boolean;
  color: string;
}
export interface StepData extends Record<string, unknown> {
  recordId: string;
  label: string | null;
  executor: WorkflowRecord["card"]["steps"][number]["executor"] | null;
  index: number;
  total: number;
  selected: boolean;
  color: string;
}
export interface DestData extends Record<string, unknown> {
  recordId: string;
  destination: string | null;
  output: string | null;
  selected: boolean;
  color: string;
}
export interface SkillData extends Record<string, unknown> {
  skill: string;
  count: number;
  health: Health;
  selected: boolean;
}

export type FrameNode = Node<FrameData, "frame">;
export type TriggerNode = Node<TriggerData, "trigger">;
export type StepNode = Node<StepData, "step">;
export type DestNode = Node<DestData, "dest">;
export type SkillNode = Node<SkillData, "skill">;

/** One frame as the legend and the camera see it: where it sits, its colour, and what inside it needs attention. */
export interface FrameInfo {
  key: string;
  label: string;
  sub: string;
  runtime: Runtime | "skill-set";
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
  count: number;
  /** Workflows whose health is "fail". */
  failing: number;
  /** Other workflows carrying an open (unacknowledged) finding. */
  findings: number;
  /** Worst open-finding severity among those, for the count's colour. */
  findingSeverity: Severity | null;
  /** HEALTH_META order of the worst workflow inside (0 = failing). */
  worstOrder: number;
}
export type CanvasNode = FrameNode | TriggerNode | StepNode | DestNode | SkillNode;

export interface Layout {
  nodes: CanvasNode[];
  edges: Edge[];
  /** Centre of each record's trigger pill, for "View in Pipeline". */
  anchors: Map<string, { x: number; y: number }>;
  /** Centre of each skill tile. */
  skillAnchors: Map<string, { x: number; y: number }>;
  /** Every frame in reading order, for the legend and for opening one pipeline. */
  frames: FrameInfo[];
  width: number;
  height: number;
}

/** Worst open (unacknowledged) finding severity for a record, or null. */
export function ringOf(findings: Finding[] | undefined): Ring {
  const open = (findings ?? []).filter((f) => !f.acknowledged);
  if (open.length === 0) return null;
  return open.reduce((a, b) => (SEVERITY_ORDER[b.severity] < SEVERITY_ORDER[a.severity] ? b : a)).severity;
}

interface FramePlan {
  key: string;
  runtime: Runtime;
  group: string;
  sub: string;
  rows: WorkflowRecord[];
  stepCols: number;
  width: number;
  height: number;
}

const runtimeOrder = (rt: Runtime) => {
  const i = (SCHEDULED_RUNTIMES as readonly Runtime[]).indexOf(rt);
  return i < 0 ? SCHEDULED_RUNTIMES.length : i;
};

function planFrames(records: WorkflowRecord[], findingsMap: Map<string, Finding[]>): FramePlan[] {
  const byKey = new Map<string, WorkflowRecord[]>();
  for (const r of records) {
    const onDemand = r.trigger.kind === "on-demand";
    const key = `${r.runtime}\u0000${onDemand ? "on demand" : r.group}`;
    const list = byKey.get(key);
    if (list) list.push(r);
    else byKey.set(key, [r]);
  }
  const plans: FramePlan[] = [];
  for (const [key, rows] of byKey) {
    const [runtime, group] = key.split("\u0000") as [Runtime, string];
    rows.sort((a, b) => {
      const ha = HEALTH_META[healthOf(a, findingsMap.get(a.id))].order;
      const hb = HEALTH_META[healthOf(b, findingsMap.get(b.id))].order;
      return ha - hb || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    });
    const stepCols = Math.max(1, ...rows.map((r) => r.card.steps.length));
    const width = FRAME_PAD_X * 2 + PILL_W + GAP_X + stepCols * (STEP_W + GAP_X) + DEST_W;
    const height = FRAME_PAD_TOP + rows.length * ROW_H - (ROW_H - PILL_H) + FRAME_PAD_BOTTOM;
    plans.push({ key, runtime, group, sub: RUNTIME_META[runtime].label, rows, stepCols, width, height });
  }
  plans.sort((a, b) => runtimeOrder(a.runtime) - runtimeOrder(b.runtime) || a.group.localeCompare(b.group));
  return plans;
}

export interface LayoutInput {
  /** Scheduled, daemon, and (when on-demand is shown) non-skill on-demand records. */
  records: WorkflowRecord[];
  /** Skill intents to collapse into tiles; empty when the toggle is off. */
  skillRecords: WorkflowRecord[];
  findingsMap: Map<string, Finding[]>;
  selectedId: string | null;
  selectedSkill: string | null;
  /** Width:height to pack the frames toward, normally the pane's own shape; defaults to TARGET_ASPECT. */
  aspect?: number;
}

export function layoutCanvas(input: LayoutInput): Layout {
  const { records, skillRecords, findingsMap, selectedId, selectedSkill } = input;
  const nodes: CanvasNode[] = [];
  const edges: Edge[] = [];
  const anchors = new Map<string, { x: number; y: number }>();
  const skillAnchors = new Map<string, { x: number; y: number }>();
  const frames: FrameInfo[] = [];

  // Pack frames into columns, choosing the column count whose overall shape
  // is closest to a wide screen, so "fit" shows the whole machine at the
  // largest legible zoom.
  const plans = planFrames(records, findingsMap);
  const columns = bestPacking(plans, input.aspect ?? TARGET_ASPECT);
  let colX = 0;
  let totalHeight = 0;
  for (const col of columns) {
    const colWidth = Math.max(0, ...col.map((p) => p.width));
    let y = 0;
    for (const p of col) {
      placeFrame(p, colX, y);
      y += p.height + FRAME_GAP_Y;
    }
    totalHeight = Math.max(totalHeight, y - FRAME_GAP_Y);
    colX += colWidth + FRAME_GAP_X;
  }
  let totalWidth = Math.max(0, colX - FRAME_GAP_X);

  function placeFrame(p: FramePlan, fx: number, fy: number) {
    const color = pipelineColor(p.key);
    frames.push(summarize(p.key, p.group, p.sub, p.runtime, color, { x: fx, y: fy, w: p.width, h: p.height }, p.rows, findingsMap));
    nodes.push({
      id: `frame:${p.key}`,
      type: "frame",
      position: { x: fx, y: fy },
      data: { label: p.group, sub: p.sub, runtime: p.runtime, count: p.rows.length, color },
      style: { width: p.width, height: p.height },
      width: p.width,
      height: p.height,
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: -1,
    });
    const destX = fx + FRAME_PAD_X + PILL_W + GAP_X + p.stepCols * (STEP_W + GAP_X);
    p.rows.forEach((r, i) => {
      const y = fy + FRAME_PAD_TOP + i * ROW_H;
      const selected = r.id === selectedId;
      const health = healthOf(r, findingsMap.get(r.id));
      const failing = health === "fail";
      const edgeColor = failing ? "#f87171" : color;
      const pillX = fx + FRAME_PAD_X;
      nodes.push({
        id: `t:${r.id}`,
        type: "trigger",
        position: { x: pillX, y },
        data: { record: r, health, ring: ringOf(findingsMap.get(r.id)), selected, color },
        width: PILL_W,
        height: PILL_H,
        draggable: false,
        zIndex: 2,
      });
      anchors.set(r.id, { x: pillX + PILL_W / 2, y: y + PILL_H / 2 });

      const steps = r.card.steps.length > 0 ? r.card.steps : [null];
      let prev = `t:${r.id}`;
      steps.forEach((s, si) => {
        const id = `s:${r.id}:${si}`;
        nodes.push({
          id,
          type: "step",
          position: { x: fx + FRAME_PAD_X + PILL_W + GAP_X + si * (STEP_W + GAP_X), y },
          data: { recordId: r.id, label: s?.label ?? null, executor: s?.executor ?? null, index: si, total: r.card.steps.length, selected, color },
          width: STEP_W,
          height: STEP_H,
          draggable: false,
          zIndex: 2,
        });
        edges.push(edge(prev, id, edgeColor, selected, s === null));
        prev = id;
      });
      const destId = `d:${r.id}`;
      nodes.push({
        id: destId,
        type: "dest",
        position: { x: destX, y },
        data: { recordId: r.id, destination: r.card.destination, output: r.card.output, selected, color },
        width: DEST_W,
        height: STEP_H,
        draggable: false,
        zIndex: 2,
      });
      edges.push(edge(prev, destId, edgeColor, selected, !r.card.destination));
    });
  }

  // Skill intents: one tile per skill, in one frame under the columns.
  if (skillRecords.length > 0) {
    const bySkill = new Map<string, WorkflowRecord[]>();
    for (const r of skillRecords) {
      const list = bySkill.get(r.group);
      if (list) list.push(r);
      else bySkill.set(r.group, [r]);
    }
    const skills = [...bySkill.keys()].sort((a, b) => a.localeCompare(b));
    const frameW = Math.max(totalWidth, 4 * (SKILL_W + SKILL_GAP) + FRAME_PAD_X * 2);
    const perRow = Math.max(1, Math.floor((frameW - FRAME_PAD_X * 2 + SKILL_GAP) / (SKILL_W + SKILL_GAP)));
    const rows = Math.ceil(skills.length / perRow);
    const frameH = FRAME_PAD_TOP + rows * (SKILL_H + SKILL_GAP) - SKILL_GAP + FRAME_PAD_BOTTOM;
    const fy = totalHeight > 0 ? totalHeight + FRAME_GAP_Y * 1.5 : 0;
    nodes.push({
      id: "frame:skills",
      type: "frame",
      position: { x: 0, y: fy },
      data: { label: "skill intents", sub: `${skills.length} skills, collapsed`, runtime: "skill-set", count: skillRecords.length, color: SKILL_FRAME_COLOR },
      style: { width: frameW, height: frameH },
      width: frameW,
      height: frameH,
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: -1,
    });
    skills.forEach((skill, i) => {
      const list = bySkill.get(skill) ?? [];
      const worst = list.map((r) => healthOf(r, findingsMap.get(r.id))).sort((a, b) => HEALTH_META[a].order - HEALTH_META[b].order)[0] ?? "on-demand";
      const x = FRAME_PAD_X + (i % perRow) * (SKILL_W + SKILL_GAP);
      const y = fy + FRAME_PAD_TOP + Math.floor(i / perRow) * (SKILL_H + SKILL_GAP);
      nodes.push({
        id: `k:${skill}`,
        type: "skill",
        position: { x, y },
        data: { skill, count: list.length, health: worst, selected: skill === selectedSkill },
        width: SKILL_W,
        height: SKILL_H,
        draggable: false,
        zIndex: 2,
      });
      skillAnchors.set(skill, { x: x + SKILL_W / 2, y: y + SKILL_H / 2 });
    });
    frames.push(summarize("skills", "skill intents", `${skills.length} skills`, "skill-set", SKILL_FRAME_COLOR, { x: 0, y: fy, w: frameW, h: frameH }, skillRecords, findingsMap));
    totalWidth = Math.max(totalWidth, frameW);
    totalHeight = fy + frameH;
  }

  // Reading order for the legend: the planned order (runtime, then group), skills last.
  const order = new Map(plans.map((p, i) => [p.key, i]));
  frames.sort((a, b) => (order.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.key) ?? Number.MAX_SAFE_INTEGER));
  return { nodes, edges, anchors, skillAnchors, frames, width: totalWidth, height: totalHeight };
}

function summarize(
  key: string,
  label: string,
  sub: string,
  runtime: FrameInfo["runtime"],
  color: string,
  box: { x: number; y: number; w: number; h: number },
  rows: WorkflowRecord[],
  findingsMap: Map<string, Finding[]>,
): FrameInfo {
  let failing = 0;
  let findings = 0;
  let findingSeverity: Severity | null = null;
  let worstOrder = Number.MAX_SAFE_INTEGER;
  for (const r of rows) {
    const health = healthOf(r, findingsMap.get(r.id));
    worstOrder = Math.min(worstOrder, HEALTH_META[health].order);
    if (health === "fail") {
      failing++;
      continue;
    }
    const ring = ringOf(findingsMap.get(r.id));
    if (ring) {
      findings++;
      if (!findingSeverity || SEVERITY_ORDER[ring] < SEVERITY_ORDER[findingSeverity]) findingSeverity = ring;
    }
  }
  return { key, label, sub, runtime, color, ...box, count: rows.length, failing, findings, findingSeverity, worstOrder };
}

/** Shortest-column-first packing into `n` columns. */
function pack(plans: FramePlan[], n: number): FramePlan[][] {
  const columns: FramePlan[][] = Array.from({ length: n }, () => []);
  const heights = columns.map(() => 0);
  for (const p of plans) {
    let best = 0;
    for (let i = 1; i < heights.length; i++) if (heights[i] < heights[best]) best = i;
    columns[best].push(p);
    heights[best] += p.height + FRAME_GAP_Y;
  }
  return columns;
}

/** The packing (1..MAX_COLUMNS columns) whose width:height is nearest `aspect`; ties keep fewer columns. */
function bestPacking(plans: FramePlan[], aspect: number): FramePlan[][] {
  if (plans.length === 0) return [];
  let best: { cols: FramePlan[][]; score: number } | null = null;
  for (let n = 1; n <= Math.min(MAX_COLUMNS, plans.length); n++) {
    const cols = pack(plans, n);
    const w = cols.reduce((s, c) => s + Math.max(0, ...c.map((p) => p.width)), 0) + FRAME_GAP_X * (n - 1);
    const h = Math.max(...cols.map((c) => c.reduce((s, p) => s + p.height + FRAME_GAP_Y, -FRAME_GAP_Y)));
    const score = Math.abs(Math.log(w / h / aspect));
    if (!best || score < best.score - 1e-9) best = { cols, score };
  }
  return best ? best.cols : [];
}

function edge(source: string, target: string, color: string, selected: boolean, toEmpty: boolean): Edge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    type: "default",
    selectable: false,
    focusable: false,
    style: {
      stroke: color,
      strokeWidth: selected ? 3 : 1.75,
      strokeOpacity: selected ? 1 : 0.9,
      strokeDasharray: toEmpty ? "5 5" : undefined,
    },
  };
}
