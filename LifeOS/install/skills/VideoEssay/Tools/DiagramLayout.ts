/**
 * DiagramLayout.ts — lays a diagram insert out from its graph as an information designer would.
 *
 *   layers    longest-path layers over the forward edges (a cycle's closing edge is routed as a back edge), node
 *             order within a layer from two barycentre passes (Sugiyama, Tagawa and Toda 1981). Layers run left to
 *             right in columns c = (W − 128·(L−1)) / L with a 128 px gutter.
 *   nodes     typographic, never boxed: the label in the sentence face (sources and sinks bold), left-aligned in its
 *             column, at most three lines, and a 2 px shelf `shelfDrop` px under the last baseline that connectors attach to.
 *   edges     cubic Béziers with horizontal tangents, control points at 45% of the run, leaving the shelf's right end
 *             and arriving at ports on the target's left edge; open 12 × 10 px chevrons that stop 14 px short of the
 *             text. A back edge runs under the graph and rises into the target's shelf.
 *   labels    on the line (with a paper halo) when no wider than the gutter less 24 px, otherwise joined to the target
 *             as a small-caps line directly above its text, so a paused frame still carries the condition.
 *   states    a graph with more than 4 nodes, more than 4 layers, or anything that does not fit builds in states: each
 *             state adds at most 4 nodes from a range of layers, and the previous state's new nodes stay as dimmed
 *             context. The fewest states that fit win; among those, the most even split.
 *
 * Every width comes from `measure`, which the page backs with the embedded faces (canvas measureText), so the layout
 * is fitted to the rendered strings. Pure and browser-safe.
 */

export interface DiagramNodeIn { id: string; label: string }
export interface DiagramEdgeIn { from: string; to: string; label?: string }
export interface Box { x: number; y: number; w: number; h: number }

/** The type a diagram sets: node labels (regular or bold) and edge labels (small caps). */
export type DiagramText = "node" | "nodeBold" | "edge";
/** Advance width in px of a string as rendered in a role (the string already carries the role's case). */
export type Measure = (text: string, role: DiagramText) => number;

/** Diagram type and spacing, px at 1080p (sizes mirror Theme TYPE.sentence and TYPE.edge). */
export const DIAGRAM = {
  gutter: 128,
  nodeSize: 56,
  nodeLeading: 1.2,
  /** Edge labels: the small-caps face (Theme FACES.caps) at the smallest size whose small-cap height (about 0.5 em) clears the 22 px label floor. */
  edgeSize: 44,
  edgeLeading: 1.05,
  edgeTracking: 0.05,
  /** Joined label lines sit this far above the node's first line. */
  kickerGap: 10,
  maxLines: 3,
  /** At most this many labels join one node; more go onto their connectors. */
  maxJoined: 2,
  /** A shelf runs the width of its label's ink plus this tail, never wider than its column. */
  shelfTail: 40,
  /** Leader labels sit in rows above the graph: the lowest row's foot this far over the graph's top. */
  leaderGap: 40,
  /** Horizontal air between two leader labels in one row, and around a leader line. */
  leaderPad: 32,
  /** A leader line stops this short of its connector; its label starts this far beside it. */
  leaderInset: 8,
  leaderFlag: 12,
  maxLeaderRows: 4,
  /** A back edge's label sits this far under its run. */
  runLabelGap: 14,
  stackGap: 72,
  /** A column of two or more nodes spreads (gap up to `maxStackGap`) until its ink is at least this tall: the 40% fill floor, with margin. */
  minColumnHeight: 410,
  maxStackGap: 168,
  /** Clear of descenders: a body serif's descenders can reach 0.26 em (14.6 px at 56), so a 14 px shelf would cut every g, p and y. */
  shelfDrop: 20,
  shelf: 2,
  sinkShelf: 4,
  portOut: 14,
  portSpread: 24,
  fan: 12,
  tipGap: 14,
  chevron: { length: 12, width: 10 },
  control: 0.45,
  maxNew: 4,
  maxLayers: 4,
  backDrop: 88,
} as const;

/** The alphabetic baseline of a line inside its line box, as a fraction of the box height from its top. */
const BASELINE = 0.78;
const nodeLine = DIAGRAM.nodeSize * DIAGRAM.nodeLeading;
const edgeLine = DIAGRAM.edgeSize * DIAGRAM.edgeLeading;

export interface PlacedNode {
  id: string;
  /** Index in the input, for stable ordering. */
  i: number;
  layer: number;
  column: number;
  /** Carried from the previous state as dimmed context. */
  carried: boolean;
  bold: boolean;
  /** The one sink of the whole graph: its shelf turns accent when it arrives. */
  sink: boolean;
  x: number;
  width: number;
  top: number;
  /** Joined edge labels (lowercase, set in small caps), one line each, above the node's text. */
  kicker: string[];
  kickerTop: number;
  lines: string[];
  labelTop: number;
  /** Baseline y of each label line. */
  baselines: number[];
  shelfY: number;
  /** The shelf's length: the label's ink plus `shelfTail`, at most the column width. Connectors leave from its end. */
  shelf: number;
  bottom: number;
}
/**
 * An edge label placed off its target: `line` rides the connector's midpoint on a paper halo, `run` sits under a back
 * edge's run, `leader` sits in a row above the graph with a hairline from (x, y0) down to (x, y1) on the connector.
 * `x`, `y` are the label's centre.
 */
export interface OnLineLabel { text: string; x: number; y: number; width: number; kind: "line" | "run" | "leader"; leader?: { x: number; y0: number; y1: number } }
export interface PlacedEdge {
  from: string;
  to: string;
  /** Index in the input edges. */
  order: number;
  back: boolean;
  d: string;
  length: number;
  /** The chevron: its tip and the direction it points. */
  tip: { x: number; y: number; dir: "right" | "up" };
  chevron: string;
  label?: OnLineLabel;
}
export interface DiagramState { nodes: PlacedNode[]; edges: PlacedEdge[]; box: Box; fits: boolean; problems: string[] }
export interface DiagramLayout { states: DiagramState[]; layers: number; sink?: string; /** Why each smaller split was rejected. */ rejected: string[] }

export interface DiagramFrame { left: number; right: number; centerY: number; maxHeight: number; measure: Measure }

/** Edges that close a cycle (found by DFS in input order); layering ignores them and routes them as back edges. */
export function backEdges(ids: readonly string[], edges: readonly DiagramEdgeIn[]): Set<number> {
  const state = new Map<string, 0 | 1 | 2>(ids.map((id) => [id, 0]));
  const back = new Set<number>();
  const visit = (id: string) => {
    state.set(id, 1);
    edges.forEach((e, k) => {
      if (e.from !== id) return;
      const s = state.get(e.to);
      if (s === 1) back.add(k);
      else if (s === 0) visit(e.to);
    });
    state.set(id, 2);
  };
  for (const id of ids) if (state.get(id) === 0) visit(id);
  return back;
}

/** Longest-path layer of every node over the forward edges. */
export function layerOf(ids: readonly string[], edges: readonly DiagramEdgeIn[], back: Set<number>): Map<string, number> {
  const fwd = edges.filter((_, k) => !back.has(k));
  const layer = new Map(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let moved = false;
    for (const e of fwd) {
      const want = layer.get(e.from)! + 1;
      if (layer.get(e.to)! < want) { layer.set(e.to, want); moved = true; }
    }
    if (!moved) break;
  }
  return layer;
}

/** Order within each layer: input order, then a downward barycentre pass (by predecessors) and an upward one (by successors). */
export function orderLayers(ids: readonly string[], edges: readonly DiagramEdgeIn[], layer: Map<string, number>, back: Set<number>): string[][] {
  const L = Math.max(0, ...layer.values()) + 1;
  const index = new Map(ids.map((id, i) => [id, i]));
  const cols: string[][] = Array.from({ length: L }, () => []);
  for (const id of ids) cols[layer.get(id)!].push(id);
  const fwd = edges.filter((_, k) => !back.has(k));
  const pos = new Map<string, number>();
  const setPos = () => cols.forEach((c) => c.forEach((id, r) => pos.set(id, r - (c.length - 1) / 2)));
  setPos();
  const sweep = (c: number, neighbours: (id: string) => string[]) => {
    const bary = (id: string) => { const n = neighbours(id).filter((x) => pos.has(x)); return n.length ? n.reduce((a, x) => a + pos.get(x)!, 0) / n.length : pos.get(id)!; };
    const b = new Map(cols[c].map((id) => [id, bary(id)]));
    cols[c].sort((x, y) => b.get(x)! - b.get(y)! || index.get(x)! - index.get(y)!);
    cols[c].forEach((id, r) => pos.set(id, r - (cols[c].length - 1) / 2));
  };
  for (let c = 1; c < L; c++) sweep(c, (id) => fwd.filter((e) => e.to === id).map((e) => e.from));
  for (let c = L - 2; c >= 0; c--) sweep(c, (id) => fwd.filter((e) => e.from === id).map((e) => e.to));
  return cols;
}

const longestWord = (text: string, role: DiagramText, measure: Measure) => Math.max(0, ...text.trim().split(/\s+/).map((w) => measure(w, role)));

/** The narrowest width (to a pixel) at which `ok` holds, searching up to `max`; `max` when nothing narrower works. */
function minWidth(ok: (w: number) => boolean, max: number): number {
  if (!ok(max)) return max;
  let lo = 0, hi = max;
  while (hi - lo > 1) { const mid = (lo + hi) / 2; if (ok(mid)) hi = mid; else lo = mid; }
  return Math.ceil(hi);
}

/** Greedy word wrap to `width`; a single word wider than the line stays on its own line (the caller reports it). */
export function wrap(text: string, width: number, role: DiagramText, measure: Measure): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (!cur || measure(next, role) <= width) { cur = next; continue; }
    lines.push(cur);
    cur = w;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Split layer sizes into consecutive ranges of at most `max` nodes each, using exactly `n` ranges; among the splits
 * that work, the one whose largest range is smallest, ties going to the split whose later ranges are larger.
 * Undefined when no split into n ranges exists.
 */
export function splitLayers(sizes: readonly number[], n: number, max: number = DIAGRAM.maxNew): number[][] | undefined {
  let best: { ranges: number[][]; worst: number; key: string } | undefined;
  const go = (from: number, left: number, acc: number[][]) => {
    if (left === 0) {
      if (from !== sizes.length) return;
      const totals = acc.map((r) => r.reduce((a, l) => a + sizes[l], 0));
      const worst = Math.max(...totals);
      const key = totals.map((t) => String(100 - t).padStart(3, "0")).join(",");
      if (!best || worst < best.worst || (worst === best.worst && key > best.key)) best = { ranges: acc.map((r) => [...r]), worst, key };
      return;
    }
    let total = 0;
    for (let to = from; to < sizes.length - (left - 1); to++) {
      total += sizes[to];
      if (total > max) break;
      acc.push(Array.from({ length: to - from + 1 }, (_, k) => from + k));
      go(to + 1, left - 1, acc);
      acc.pop();
    }
  };
  go(0, n, []);
  return best?.ranges;
}

/** A point and tangent on a cubic Bézier at t. */
function bezierAt(p: number[], t: number): { x: number; y: number } {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = p;
  const u = 1 - t;
  return { x: u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, y: u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3 };
}
function bezierLength(p: number[]): number {
  let len = 0, prev = bezierAt(p, 0);
  for (let k = 1; k <= 32; k++) { const q = bezierAt(p, k / 32); len += Math.hypot(q.x - prev.x, q.y - prev.y); prev = q; }
  return len;
}
const f1 = (v: number) => Math.round(v * 10) / 10;
const chevronRight = (x: number, y: number) => `M${f1(x - DIAGRAM.chevron.length)},${f1(y - DIAGRAM.chevron.width / 2)} L${f1(x)},${f1(y)} L${f1(x - DIAGRAM.chevron.length)},${f1(y + DIAGRAM.chevron.width / 2)}`;
const chevronUp = (x: number, y: number) => `M${f1(x - DIAGRAM.chevron.width / 2)},${f1(y + DIAGRAM.chevron.length)} L${f1(x)},${f1(y)} L${f1(x + DIAGRAM.chevron.width / 2)},${f1(y + DIAGRAM.chevron.length)}`;

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Lay out one state: the layers it spans, its new nodes and its carried context. */
function layoutState(
  graph: { nodes: readonly DiagramNodeIn[]; edges: readonly DiagramEdgeIn[]; back: Set<number>; layer: Map<string, number>; order: string[][]; sources: Set<string>; sinks: Set<string>; sink?: string },
  members: { id: string; carried: boolean }[],
  frame: DiagramFrame,
): DiagramState {
  const { measure } = frame;
  const problems: string[] = [];
  const inState = new Map(members.map((m) => [m.id, m.carried]));
  const layersUsed = [...new Set(members.map((m) => graph.layer.get(m.id)!))].sort((a, b) => a - b);
  const L = layersUsed.length;
  const W = frame.right - frame.left;
  const colOf = new Map(layersUsed.map((l, k) => [l, k]));
  const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const edges = graph.edges.map((e, order) => ({ ...e, order, back: graph.back.has(order) })).filter((e) => inState.has(e.from) && inState.has(e.to));
  const gap = DIAGRAM.gutter - 24;
  // Edge labels, never dropped, placed by preference: a label that fits the gutter rides its line; a back edge's label
  // sits under its run; otherwise it joins its target as one small-caps line when it fits the column in one line and
  // the target takes at most two; anything else is set above the graph on a leader to its connector.
  const joinable = new Map<string, { order: number; text: string }[]>();
  const onLine = new Map<number, string>();
  const offLine = new Map<number, string>();
  for (const e of edges) {
    const text = e.label?.trim().toLowerCase();
    if (!text) continue;
    if (e.back) { offLine.set(e.order, text); continue; }
    if (measure(text, "edge") <= gap) { onLine.set(e.order, text); continue; }
    const list = joinable.get(e.to) ?? [];
    list.push({ order: e.order, text });
    joinable.set(e.to, list);
  }
  for (const [to, list] of joinable) {
    if (new Set(list.map((j) => j.text)).size <= DIAGRAM.maxJoined) continue;
    for (const j of list) offLine.set(j.order, j.text);
    joinable.delete(to);
  }
  // Equal columns when every label fits them in three lines; otherwise columns sized to what their
  // labels need, the slack shared in proportion, before the graph is split into states.
  const roleOf = (id: string): DiagramText => (graph.sources.has(id) || graph.sinks.has(id) ? "nodeBold" : "node");
  const labelOf = (id: string) => graph.nodes[index.get(id)!].label;
  const members0 = (l: number) => graph.order[l].filter((id) => inState.has(id));
  const fitsIn = (id: string, w: number) => wrap(labelOf(id), w, roleOf(id), measure).length <= DIAGRAM.maxLines && longestWord(labelOf(id), roleOf(id), measure) <= w;
  const equal = (W - DIAGRAM.gutter * (L - 1)) / L;
  let widths = layersUsed.map(() => equal);
  if (!layersUsed.every((l) => members0(l).every((id) => fitsIn(id, equal)))) {
    const need = layersUsed.map((l) => Math.max(...members0(l).map((id) => minWidth((w) => fitsIn(id, w), W))));
    const total = need.reduce((a, b) => a + b, 0);
    const room = W - DIAGRAM.gutter * (L - 1);
    if (total <= room) widths = need.map((n) => n + ((room - total) * n) / total);
  }
  const colX = widths.map((_, k) => frame.left + widths.slice(0, k).reduce((a, b) => a + b, 0) + k * DIAGRAM.gutter);
  const placed = new Map<string, PlacedNode>();
  const columns: PlacedNode[][] = Array.from({ length: L }, () => []);
  for (const l of layersUsed) {
    for (const id of graph.order[l]) {
      if (!inState.has(id)) continue;
      const col = colOf.get(l)!;
      const c = widths[col];
      const bold = graph.sources.has(id) || graph.sinks.has(id);
      const label = graph.nodes[index.get(id)!].label;
      const role: DiagramText = bold ? "nodeBold" : "node";
      const lines = wrap(label, c, role, measure);
      if (lines.length > DIAGRAM.maxLines) problems.push(`node "${label}" needs ${lines.length} lines in a ${Math.round(c)} px column`);
      for (const line of lines) if (measure(line, role) > c + 0.5) problems.push(`node "${label}": "${line}" is wider than its ${Math.round(c)} px column`);
      // One line per joined label: a label wider than the column goes onto its connector instead.
      const kicker: string[] = [];
      for (const j of joinable.get(id) ?? []) {
        if (kicker.includes(j.text)) continue;
        if (measure(j.text, "edge") <= c) kicker.push(j.text); else offLine.set(j.order, j.text);
      }
      const ink = Math.max(...lines.map((line) => measure(line, role)), ...kicker.map((k) => measure(k, "edge")));
      const shelf = Math.min(c, ink + DIAGRAM.shelfTail);
      const node: PlacedNode = { id, i: index.get(id)!, layer: l, column: col, carried: inState.get(id)!, bold, sink: graph.sink === id, x: colX[col], width: c, top: 0, kicker, kickerTop: 0, lines, labelTop: 0, baselines: [], shelfY: 0, shelf, bottom: 0 };
      columns[col].push(node);
      placed.set(id, node);
    }
  }
  const heightOf = (n: PlacedNode) => (n.kicker.length ? n.kicker.length * edgeLine + DIAGRAM.kickerGap : 0) + n.lines.length * nodeLine + DIAGRAM.shelfDrop - (1 - BASELINE) * nodeLine + DIAGRAM.shelf;
  for (const col of columns) {
    const own = col.reduce((a, n) => a + heightOf(n), 0);
    const gap = col.length < 2 ? 0 : Math.min(DIAGRAM.maxStackGap, Math.max(DIAGRAM.stackGap, (DIAGRAM.minColumnHeight - own) / (col.length - 1)));
    const total = own + gap * (col.length - 1);
    let y = frame.centerY - total / 2;
    for (const n of col) {
      n.top = y;
      n.kickerTop = y;
      n.labelTop = y + (n.kicker.length ? n.kicker.length * edgeLine + DIAGRAM.kickerGap : 0);
      n.baselines = n.lines.map((_, k) => n.labelTop + k * nodeLine + BASELINE * nodeLine);
      n.shelfY = n.baselines[n.baselines.length - 1] + DIAGRAM.shelfDrop;
      n.bottom = n.shelfY + DIAGRAM.shelf;
      y = n.bottom + gap;
    }
  }
  const pos = (id: string) => placed.get(id)!;
  // Outbound fan: a source's forward edges leave its shelf end spread ±fan px, in target order down the frame.
  const outOffset = new Map<number, number>();
  const inPort = new Map<number, number>();
  for (const n of placed.values()) {
    const outs = edges.filter((e) => e.from === n.id && !e.back).sort((a, b) => pos(a.to).labelTop - pos(b.to).labelTop);
    outs.forEach((e, k) => outOffset.set(e.order, outs.length === 1 ? 0 : -DIAGRAM.fan + (2 * DIAGRAM.fan * k) / (outs.length - 1)));
    const ins = edges.filter((e) => e.to === n.id && !e.back).sort((a, b) => pos(a.from).shelfY - pos(b.from).shelfY);
    const mid = (n.labelTop + n.labelTop + n.lines.length * nodeLine) / 2;
    ins.forEach((e, k) => inPort.set(e.order, mid + (k - (ins.length - 1) / 2) * DIAGRAM.portSpread));
  }
  const curves = new Map<number, number[]>();
  const graphBottom = Math.max(...[...placed.values()].map((n) => n.bottom));
  const placedEdges: PlacedEdge[] = edges.map((e) => {
    const a = pos(e.from), b = pos(e.to);
    if (e.back) {
      // Down from under the source's shelf, back along the foot of the graph, up into the target's shelf: inside the grid.
      const x1 = a.x + Math.max(24, a.shelf - 48), y1 = a.shelfY + DIAGRAM.shelf + DIAGRAM.tipGap / 2;
      const yb = graphBottom + DIAGRAM.backDrop;
      const xt = b.x + 48;
      const tipY = b.shelfY + DIAGRAM.shelf + DIAGRAM.tipGap / 2;
      const r = 32;
      const d = `M${f1(x1)},${f1(y1)} L${f1(x1)},${f1(yb - r)} Q${f1(x1)},${f1(yb)} ${f1(x1 - r)},${f1(yb)} L${f1(xt + r)},${f1(yb)} Q${f1(xt)},${f1(yb)} ${f1(xt)},${f1(yb - r)} L${f1(xt)},${f1(tipY)}`;
      const length = (yb - r - y1) + (x1 - xt - 2 * r) + 2 * r * 1.57 + (yb - r - tipY);
      const text = offLine.get(e.order);
      const width = text ? measure(text, "edge") : 0;
      const cx = Math.min(frame.right - width / 2, Math.max(frame.left + width / 2, (x1 + xt) / 2));
      const label = text ? { text, x: cx, y: yb + DIAGRAM.runLabelGap + edgeLine / 2, width, kind: "run" as const } : undefined;
      if (text) offLine.delete(e.order);
      return { from: e.from, to: e.to, order: e.order, back: true, d, length, tip: { x: xt, y: tipY, dir: "up" as const }, chevron: chevronUp(xt, tipY), ...(label ? { label } : {}) };
    }
    const x1 = a.x + a.shelf + DIAGRAM.portOut, y1 = a.shelfY + (outOffset.get(e.order) ?? 0);
    const x2 = b.x - DIAGRAM.tipGap, y2 = inPort.get(e.order)!;
    const dx = x2 - x1;
    const p = [x1, y1, x1 + DIAGRAM.control * dx, y1, x2 - DIAGRAM.control * dx, y2, x2, y2];
    curves.set(e.order, p);
    const d = `M${f1(x1)},${f1(y1)} C${f1(p[2])},${f1(p[3])} ${f1(p[4])},${f1(p[5])} ${f1(x2)},${f1(y2)}`;
    const text = onLine.get(e.order);
    const mid = bezierAt(p, 0.5);
    const label = text ? { text, x: mid.x, y: mid.y, width: measure(text, "edge"), kind: "line" as const } : undefined;
    return { from: e.from, to: e.to, order: e.order, back: false, d, length: bezierLength(p), tip: { x: x2, y: y2, dir: "right" as const }, chevron: chevronRight(x2, y2), ...(label ? { label } : {}) };
  });
  // Leaders: each remaining label flies as a flag from a vertical hairline that rises out of its connector inside the
  // gutter before its target (clear of every column) to a row above the graph, the label set just right of the line
  // (left of it only when no row fits it on the right; over it, the line starting under the label, when a label is too
  // wide to fly either way inside the frame). Leaders are set from the rightmost gutter leftward; each takes
  // the lowest row and the rightmost of three lines in its gutter where it clears the labels already set, no line
  // crosses it, and its own line crosses none. Labels that converge on one node step up and to the left, clear of the
  // flags below them.
  const graphTop = Math.min(...[...placed.values()].map((n) => n.top));
  const rowFoot = (k: number) => graphTop - DIAGRAM.leaderGap - k * (edgeLine + 12);
  const set: { x0: number; x1: number; row: number; lx: number }[] = [];
  const pad = DIAGRAM.leaderPad;
  const leaders = placedEdges.filter((pe) => !pe.back && offLine.has(pe.order)).sort((x, y) => pos(y.to).x - pos(x.to).x || x.order - y.order);
  for (const pe of leaders) {
    const text = offLine.get(pe.order)!;
    const b = pos(pe.to);
    const p = curves.get(pe.order)!;
    const width = measure(text, "edge");
    type Side = "right" | "left" | "over";
    const flag = (lx: number, side: Side) => side === "right" ? lx + DIAGRAM.leaderFlag : side === "left" ? lx - DIAGRAM.leaderFlag - width
      : Math.min(frame.right - width, Math.max(frame.left, lx - width / 2));
    const inFrame = (x0: number) => x0 >= frame.left - 0.5 && x0 + width <= frame.right + 0.5;
    const clash = (row: number, lx: number, side: Side) => {
      const x0 = flag(lx, side), x1 = x0 + width;
      if (!inFrame(x0)) return true;
      return set.some((o) => (o.row === row && x0 < o.x1 + pad && o.x0 < x1 + pad)
        || (o.row > row && o.lx > x0 - pad && o.lx < x1 + pad)
        || (o.row < row && lx > o.x0 - pad && lx < o.x1 + pad)
        || Math.abs(o.lx - lx) < pad);
    };
    let pick: { row: number; lx: number; side: Side } | undefined;
    for (const side of ["right", "left", "over"] as const) {
      for (let row = 0; row < DIAGRAM.maxLeaderRows && !pick; row++) {
        for (let k = 0; k < 3 && !pick; k++) {
          const lx = b.x - DIAGRAM.tipGap - 10 - k * ((DIAGRAM.gutter - 2 * DIAGRAM.tipGap - 20) / 2);
          if (!clash(row, lx, side)) pick = { row, lx, side };
        }
      }
    }
    if (!pick) { problems.push(`edge label "${text}" finds no clear row above the graph`); pick = { row: DIAGRAM.maxLeaderRows - 1, lx: b.x - DIAGRAM.gutter / 2, side: "over" }; }
    let best = { t: 0.5, dx: Infinity };
    for (let k = 0; k <= 64; k++) { const q = bezierAt(p, k / 64); const dx = Math.abs(q.x - pick.lx); if (dx < best.dx) best = { t: k / 64, dx }; }
    const on = bezierAt(p, best.t);
    const x0 = flag(pick.lx, pick.side);
    set.push({ x0, x1: x0 + width, row: pick.row, lx: pick.lx });
    // A lone leader drops to just over what lies under its own span (nodes and connectors), not the graph's highest
    // point, so its line stays short. With several, the shared rows keep their lines from crossing each other's flags.
    let foot = rowFoot(pick.row);
    if (leaders.length === 1) {
      const lo = Math.min(x0, pick.lx) - pad, hi = Math.max(x0 + width, pick.lx) + pad;
      const under = [...placed.values()].filter((n) => n.x < hi && lo < n.x + n.width).map((n) => n.top);
      for (const c of curves.values()) for (let k = 0; k <= 32; k++) { const q = bezierAt(c, k / 32); if (q.x > lo && q.x < hi) under.push(q.y); }
      const local = Math.min(...under) - DIAGRAM.leaderGap;
      if (local > foot && local < on.y - 2 * DIAGRAM.leaderInset) foot = local;
    }
    pe.label = { text, x: x0 + width / 2, y: foot - edgeLine / 2, width, kind: "leader", leader: { x: pick.lx, y0: pick.side === "over" ? foot + DIAGRAM.leaderInset : foot - edgeLine * 0.8, y1: on.y - DIAGRAM.leaderInset } };
  }
  const nodes = [...placed.values()].sort((a, b) => a.i - b.i);
  const boxes = nodes.map((n) => ({ x: n.x, y: n.top, w: n.width, h: n.bottom - n.top }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlaps(boxes[i], boxes[j])) problems.push(`nodes ${nodes[i].id} and ${nodes[j].id} overlap`);
  const leaderTop = placedEdges.filter((e) => e.label?.kind === "leader").map((e) => e.label!.y - edgeLine / 2);
  const top = Math.min(...boxes.map((b) => b.y), ...leaderTop);
  const runBottom = placedEdges.filter((e) => e.back).map((e) => graphBottom + DIAGRAM.backDrop + 2 + (e.label ? DIAGRAM.runLabelGap + edgeLine : 0));
  const bottom = Math.max(graphBottom, ...runBottom);
  if (bottom - top > frame.maxHeight) problems.push(`state is ${Math.round(bottom - top)} px tall, over the ${frame.maxHeight} px it may use`);
  return { nodes, edges: placedEdges, box: { x: frame.left, y: top, w: W, h: bottom - top }, fits: problems.length === 0, problems };
}

/**
 * Lay a diagram out as one state, or as the fewest states that fit. A graph that cannot fit in any split is laid out
 * in its best split with `fits: false` and the reasons in `problems`, never dropped.
 */
export function layoutDiagram(nodes: readonly DiagramNodeIn[], edges: readonly DiagramEdgeIn[], frame: DiagramFrame): DiagramLayout {
  const ids = nodes.map((n) => n.id);
  if (new Set(ids).size !== ids.length) throw new Error(`diagram node ids must be unique: ${ids.join(", ")}`);
  for (const e of edges) if (!ids.includes(e.from) || !ids.includes(e.to)) throw new Error(`diagram edge ${e.from}→${e.to} names a node that does not exist`);
  if (nodes.length === 0) throw new Error("a diagram needs at least one node");
  const back = backEdges(ids, edges);
  const layer = layerOf(ids, edges, back);
  const order = orderLayers(ids, edges, layer, back);
  const fwd = edges.filter((_, k) => !back.has(k));
  const sources = new Set(ids.filter((id) => !fwd.some((e) => e.to === id)));
  const sinkSet = new Set(ids.filter((id) => !fwd.some((e) => e.from === id)));
  // The sink's accent shelf is the diagram's one accent: the one node that ends the longest path, when exactly one does.
  const deepest = Math.max(...layer.values());
  const ends = ids.filter((id) => sinkSet.has(id) && layer.get(id) === deepest);
  const sink = ends.length === 1 && nodes.length > 1 ? ends[0] : undefined;
  const graph = { nodes, edges, back, layer, order, sources, sinks: nodes.length > 1 ? sinkSet : new Set<string>(), sink };
  const sizes = order.map((c) => c.length);
  const mustSplit = nodes.length > DIAGRAM.maxNew || order.length > DIAGRAM.maxLayers;
  let fallback: DiagramState[] | undefined;
  const rejected: string[] = [];
  for (let n = mustSplit ? 2 : 1; n <= order.length; n++) {
    const ranges = splitLayers(sizes, n);
    if (!ranges) continue;
    const states: DiagramState[] = [];
    let prevNew: string[] = [];
    for (const r of ranges) {
      const fresh = r.flatMap((l) => order[l]);
      const members = [...prevNew.map((id) => ({ id, carried: true })), ...fresh.map((id) => ({ id, carried: false }))];
      states.push(layoutState(graph, members, frame));
      prevNew = fresh;
    }
    if (states.every((s) => s.fits)) return { states, layers: order.length, ...(sink ? { sink } : {}), rejected };
    rejected.push(`${n} state(s): ${states.flatMap((s) => s.problems).join("; ")}`);
    fallback ??= states;
  }
  // Nothing fits: every layer its own state (or the one split tried), reported through `fits` and `problems`.
  if (!fallback) {
    let prevNew: string[] = [];
    fallback = order.map((col) => { const s = layoutState(graph, [...prevNew.map((id) => ({ id, carried: true })), ...col.map((id) => ({ id, carried: false }))], frame); prevNew = col; return s; });
  }
  return { states: fallback, layers: order.length, ...(sink ? { sink } : {}), rejected };
}

/**
 * A stand-in for the page's canvas measure, for tests and for anything laid out off the page: a body serif runs about
 * 0.47 em a character (bold 0.5), a small-caps sans about 0.62 em plus tracking. The page never uses it.
 */
export const estimateMeasure: Measure = (text, role) => {
  const em = role === "edge" ? DIAGRAM.edgeSize * (0.62 + DIAGRAM.edgeTracking) : DIAGRAM.nodeSize * (role === "nodeBold" ? 0.5 : 0.47);
  return text.length * em;
};
