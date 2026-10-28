#!/usr/bin/env bun
/**
 * AnimatedDiagram.ts — a TechnicalDiagrams diagram that draws itself, delivered as a looping GIF.
 *
 *   bun AnimatedDiagram.ts build --spec <diagram.json> --dir <project> [--force]
 *   bun AnimatedDiagram.ts gif   --dir <project> [--name <slug>] [--width 1200] [--fps 15]
 *
 * `build` turns a diagram spec (nodes, edges, insights, each on a numbered step) into a
 * HyperFrames composition: hand-drawn SVG strokes generated here with a seeded jitter (so the
 * same spec gives the same bytes and nothing random runs in the page), drawn on in step order by
 * one paused GSAP timeline, with flowing dashes on `flow` edges, the install palette and the
 * configured fonts embedded. The final frames hold the complete diagram, then fade to the ground
 * so the GIF loops without a hard cut.
 *
 * `gif` renders through the HyperFrames seam (checks, probe, motion validation) to
 * Out/<slug>.mp4, then encodes Out/<slug>.gif (two-pass palette, loops forever) and
 * Out/<slug>-poster.png (the complete diagram, for places a GIF cannot go).
 *
 * Fonts: <configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/DiagramFonts.json, roles
 * title | subtitle | label | insight | signature → { path, weight?, style? }. A missing role
 * falls back to a generic family, which needs no embedding.
 *
 * Palette: <configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/DiagramTheme.json, any subset of the
 * PALETTE keys below; absent, the shipped neutral palette applies. A spec `theme` overrides both.
 *
 * Exit codes: 0 done, 1 refused or failed, 2 usage error.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getDAName } from "../../../hooks/lib/identity";
import { getClaudeDir } from "../../../LIFEOS/TOOLS/Paths.ts";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { bundledFaces, embedFonts, injectFonts, registerAfterFonts, roleFaces, type FontFaceSpec, type RoleOptions } from "../../../LIFEOS/TOOLS/HyperFrames/fonts.ts";
import { render, stageGsap } from "../../../LIFEOS/TOOLS/HyperFrames/HyperFrames.ts";

// ── Spec ────────────────────────────────────────────────────────────────────

export type Tone = "ink" | "purple" | "teal";
export type Shape = "box" | "pill" | "circle" | "cylinder" | "diamond" | "none";
export type Route = "curve" | "hv" | "vh";

export interface DiagramNode { id: string; label: string; sub?: string; x: number; y: number; w: number; h: number; shape?: Shape; tone?: Tone; step: number; fontSize?: number; /** "top" heads a container node so child nodes can sit inside it. */ labelAlign?: "center" | "top" }
export interface DiagramEdge { from: string; to: string; label?: string; tone?: Tone; flow?: boolean; dashed?: boolean; bend?: number; route?: Route; step: number }
export interface DiagramInsight { text: string; x: number; y: number; maxWidth?: number; tone?: Exclude<Tone, "ink">; step: number }
export interface DiagramSpec {
  /** The wedge-serif title and subtitle tiers. Required unless `untitled` names why the image carries none. */
  title?: string;
  subtitle?: string;
  /** Why there is no title block: a blog header whose page carries the title, or a deck slide whose slide does. */
  untitled?: "blog-header" | "deck";
  width?: number;
  height?: number;
  fps?: number;
  /** Seconds the complete diagram holds before the loop fade. */
  hold?: number;
  nodes: DiagramNode[];
  edges?: DiagramEdge[];
  insights?: DiagramInsight[];
  /** Sign with the DA name, bottom-right inside the art. Default true. */
  signature?: boolean;
  /** Multiplies every stroke width and arrowhead (deck diagrams read from the back of a room at about 1.6). Default 1. */
  strokeScale?: number;
  /** Multiplies label, edge-label and insight type sizes. Default 1. */
  typeScale?: number;
  /** A node's `sub` line size as a share of its label size (0.5–1). Default 0.62; a figure shown small, such as a page figure, wants about 0.75. */
  subScale?: number;
  /** Palette overrides, so a diagram can sit on a page's own colors (a dark site, a brand). Keys: ground, ink, charcoal (sub lines), purple, teal, paper (box fill), purpleFill, tealFill, signature. Default: DiagramTheme.json over the shipped neutral palette. */
  theme?: Partial<Palette>;
  /** Opacity of the underdrawing: a faint copy of the finished diagram the ink draws over, so no frame is ever blank (first frame, exports, loop seam). 0 turns it off. Default 0.13. */
  ghost?: number;
}

export class DiagramError extends Error {
  constructor(message: string, readonly usage = false) {
    super(message);
    this.name = "DiagramError";
  }
}

/**
 * The shipped neutral palette. An install's own palette lives in
 * <configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/DiagramTheme.json (same keys, any subset);
 * `build` layers it under the spec's own `theme`. `purple` and `teal` name the two accent
 * tones a spec can use (primary and secondary), whatever colours the install gives them.
 */
export const PALETTE = {
  ground: "#F5F5F0",
  ink: "#111111",
  charcoal: "#2D2D2D",
  purple: "#2B4C7E",
  teal: "#3A7D44",
  paper: "#FBFBF7",
  purpleFill: "rgba(43, 76, 126, 0.10)",
  tealFill: "rgba(58, 125, 68, 0.10)",
  signature: "rgba(55, 45, 38, 0.6)",
};
export type Palette = typeof PALETTE;
const COLOR = /^(#[0-9a-fA-F]{6}|rgba?\([\d\s.,]+\))$/;
const ID_RE = /^[a-z][a-z0-9-]{0,47}$/;

/** Timing, seconds. One place, so the workflow's pacing claims trace to code. */
export const PACE = { titleIn: 1.1, nodeStagger: 0.28, strokeDraw: 0.75, secondPass: 0.18, fillIn: 0.45, edgeDraw: 0.65, arrowDraw: 0.22, insightWrite: 0.9, stepGap: 0.35, flowPeriod: 1.1, fadeOut: 0.7 } as const;

export function validateSpec(raw: unknown): Required<Pick<DiagramSpec, "width" | "height" | "fps" | "hold" | "signature">> & DiagramSpec {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new DiagramError("spec must be a JSON object");
  const s = raw as DiagramSpec;
  const width = s.width ?? 1920, height = s.height ?? 1080, fps = s.fps ?? 30, hold = s.hold ?? 3, signature = s.signature ?? true;
  const problems: string[] = [];
  if (!Number.isInteger(width) || !Number.isInteger(height) || width % 2 || height % 2 || width < 320 || height < 180) problems.push(`width/height must be even integers ≥ 320x180, got ${width}x${height}`);
  if (width / height < 1.4) problems.push(`aspect ${width}x${height} is below 1.4; technical diagrams span the full page width (16:9 or 21:9)`);
  if (!Number.isInteger(fps) || fps < 12 || fps > 60) problems.push(`fps must be 12..60, got ${fps}`);
  if (!(hold >= 1.5 && hold <= 15)) problems.push(`hold must be 1.5..15 s, got ${hold}`);
  for (const k of ["strokeScale", "typeScale"] as const) if (s[k] !== undefined && !(s[k]! >= 0.5 && s[k]! <= 3)) problems.push(`${k} must be 0.5..3, got ${s[k]}`);
  for (const [key, value] of Object.entries(s.theme ?? {})) {
    if (!(key in PALETTE)) problems.push(`theme.${key} is not a palette key (${Object.keys(PALETTE).join(", ")})`);
    else if (typeof value !== "string" || !COLOR.test(value)) problems.push(`theme.${key} must be #rrggbb or rgb()/rgba(), got ${value}`);
    else if (key === "ground") {
      // `gif` pins the ground into the palette through colourToHex; refuse here what it would refuse there.
      try { colourToHex(value); } catch (e) { problems.push(`theme.ground: ${(e as Error).message}`); }
    }
  }
  // The three type tiers are the TechnicalDiagrams look; a diagram without its title block reads as a bare flowchart
  // (principal directive, 2026-10-25: in-post diagrams shipped with no title or subtitle). Only a blog header or a deck slide omits it.
  if (s.untitled !== undefined && !["blog-header", "deck"].includes(s.untitled)) problems.push(`untitled must be "blog-header" or "deck", got ${s.untitled}`);
  if (!s.untitled && !(s.title?.trim() && s.subtitle?.trim())) problems.push('title and subtitle are required (the wedge-serif tiers); set untitled: "blog-header" or "deck" only when the page or slide carries the title');
  if (s.untitled && (s.title || s.subtitle)) problems.push(`untitled: "${s.untitled}" carries no title block, but title or subtitle is set`);
  if (!(s.insights ?? []).length) problems.push("at least 1 insight is required (the workflow's 1-3)");
  if (s.subScale !== undefined && !(s.subScale >= 0.5 && s.subScale <= 1)) problems.push(`subScale must be 0.5..1, got ${s.subScale}`);
  if (s.ghost !== undefined && !(s.ghost >= 0 && s.ghost <= 0.4)) problems.push(`ghost must be 0..0.4, got ${s.ghost}`);
  if (!Array.isArray(s.nodes) || s.nodes.length === 0) problems.push("nodes must be a non-empty array");
  const ids = new Set<string>();
  for (const n of s.nodes ?? []) {
    const at = `node ${JSON.stringify(n?.id)}`;
    if (!ID_RE.test(n?.id ?? "")) problems.push(`${at}: id must match ${ID_RE}`);
    if (ids.has(n.id)) problems.push(`${at}: duplicate id`);
    ids.add(n.id);
    if (!n.label?.trim()) problems.push(`${at}: label is required`);
    for (const k of ["x", "y", "w", "h"] as const) if (!Number.isFinite(n[k])) problems.push(`${at}: ${k} must be a number`);
    if (n.w < 40 || n.h < 40) problems.push(`${at}: w and h must be ≥ 40`);
    if (n.x < 0 || n.y < 0 || n.x + n.w > width || n.y + n.h > height) problems.push(`${at}: box ${n.x},${n.y} ${n.w}x${n.h} leaves the ${width}x${height} frame`);
    if (n.shape && !["box", "pill", "circle", "cylinder", "diamond", "none"].includes(n.shape)) problems.push(`${at}: unknown shape ${n.shape}`);
    if (n.tone && !["ink", "purple", "teal"].includes(n.tone)) problems.push(`${at}: unknown tone ${n.tone}`);
    if (!Number.isInteger(n.step) || n.step < 1) problems.push(`${at}: step must be an integer ≥ 1`);
  }
  for (const [i, e] of (s.edges ?? []).entries()) {
    const at = `edge ${i} (${e?.from}→${e?.to})`;
    if (!ids.has(e.from) || !ids.has(e.to)) problems.push(`${at}: from and to must name nodes`);
    if (e.from === e.to) problems.push(`${at}: an edge needs two different nodes`);
    if (!Number.isInteger(e.step) || e.step < 1) problems.push(`${at}: step must be an integer ≥ 1`);
    if (e.route && !["curve", "hv", "vh"].includes(e.route)) problems.push(`${at}: route must be curve, hv or vh`);
    if (e.flow && e.dashed) problems.push(`${at}: an edge is either flow or dashed, not both`);
    const ends = (s.nodes ?? []).filter((n) => n.id === e.from || n.id === e.to);
    if (ends.some((n) => n.step > e.step)) problems.push(`${at}: drawn at step ${e.step} before one of its nodes exists`);
  }
  const insights = s.insights ?? [];
  if (insights.length > 3) problems.push(`at most 3 insights (the workflow's 1-3), got ${insights.length}`);
  for (const [i, n] of insights.entries()) {
    if (!n.text?.trim()) problems.push(`insight ${i}: text is required`);
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || n.x < 0 || n.y < 0 || n.x > width || n.y > height) problems.push(`insight ${i}: x,y must sit inside the frame`);
    if (!Number.isInteger(n.step) || n.step < 1) problems.push(`insight ${i}: step must be an integer ≥ 1`);
  }
  if (problems.length) throw new DiagramError(`invalid diagram spec:\n- ${problems.join("\n- ")}`);
  return { ...s, width, height, fps, hold, signature };
}

// ── Hand-drawn geometry (seeded, so deterministic) ──────────────────────────

type Pt = [number, number];

function seeded(key: string): () => number {
  let h = 2166136261;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = (n: number) => Math.round(n * 10) / 10;

/** One stroke from a to b: a cubic with small perpendicular wobble and a slight overshoot, like a confident pen. */
function roughSegment(a: Pt, b: Pt, rnd: () => number, wobble: number): string {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len, w = Math.min(wobble, len * 0.03);
  const j = () => (rnd() - 0.5) * 2 * w;
  const over = (rnd() * 0.6 + 0.2) * Math.min(6, len * 0.02);
  const end: Pt = [b[0] + (dx / len) * over + j() * 0.3, b[1] + (dy / len) * over + j() * 0.3];
  const c1: Pt = [a[0] + dx * 0.3 + nx * j(), a[1] + dy * 0.3 + ny * j()];
  const c2: Pt = [a[0] + dx * 0.7 + nx * j(), a[1] + dy * 0.7 + ny * j()];
  return `C ${f(c1[0])} ${f(c1[1])}, ${f(c2[0])} ${f(c2[1])}, ${f(end[0])} ${f(end[1])}`;
}

function roughPolygon(pts: Pt[], rnd: () => number, wobble: number): string {
  const start = pts[0]!;
  let d = `M ${f(start[0] + (rnd() - 0.5) * 3)} ${f(start[1] + (rnd() - 0.5) * 3)}`;
  for (let i = 0; i < pts.length; i++) d += " " + roughSegment(pts[i]!, pts[(i + 1) % pts.length]!, rnd, wobble);
  return d;
}

/** An ellipse as a Catmull-Rom loop through jittered points, running a little past a full turn. */
function roughEllipse(cx: number, cy: number, rx: number, ry: number, rnd: () => number, from = 0, sweep = Math.PI * 2.08): string {
  const steps = Math.max(10, Math.round(Math.abs(sweep) * 3));
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = from + (sweep * i) / steps, k = 1 + (rnd() - 0.5) * 0.04;
    pts.push([cx + Math.cos(t) * rx * k, cy + Math.sin(t) * ry * k]);
  }
  let d = `M ${f(pts[0]![0])} ${f(pts[0]![1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!, p1 = pts[i]!, p2 = pts[i + 1]!, p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    d += ` C ${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)}, ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)}, ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

/** Outline paths for a node: [first pass, second pass], plus a clean fill path. */
export function nodePaths(n: DiagramNode): { strokes: [string, string]; fill: string } {
  const shape = n.shape ?? "box";
  const { x, y, w, h } = n;
  const pass = (k: number): string => {
    const rnd = seeded(`${n.id}:${k}`);
    if (shape === "circle") return roughEllipse(x + w / 2, y + h / 2, w / 2, h / 2, rnd, -Math.PI / 2 + k * 0.4);
    if (shape === "cylinder") {
      // Top rim as a full ellipse, then the left wall, the front half of the base, the right wall.
      const ry = Math.min(h * 0.14, 26), cx = x + w / 2;
      return `${roughEllipse(cx, y + ry, w / 2, ry, rnd)} M ${f(x)} ${f(y + ry)} ${roughSegment([x, y + ry], [x, y + h - ry], rnd, 3)} ${roughEllipse(cx, y + h - ry, w / 2, ry, rnd, Math.PI, -Math.PI)} M ${f(x + w)} ${f(y + h - ry)} ${roughSegment([x + w, y + h - ry], [x + w, y + ry], rnd, 3)}`;
    }
    if (shape === "pill") {
      const r = h / 2;
      return `M ${f(x + r)} ${f(y)} ${roughSegment([x + r, y], [x + w - r, y], rnd, 3)} ${roughEllipse(x + w - r, y + r, r, r, rnd, -Math.PI / 2, Math.PI)} M ${f(x + w - r)} ${f(y + h)} ${roughSegment([x + w - r, y + h], [x + r, y + h], rnd, 3)} ${roughEllipse(x + r, y + r, r, r, rnd, Math.PI / 2, Math.PI * 1.04)}`;
    }
    if (shape === "diamond") return roughPolygon([[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]], rnd, 4);
    return roughPolygon([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], rnd, 4);
  };
  const fill = shape === "circle" ? `M ${x + w / 2} ${y} A ${w / 2} ${h / 2} 0 1 1 ${x + w / 2 - 0.01} ${y} Z`
    : shape === "cylinder" ? (() => { const ry = Math.min(h * 0.14, 26); return `M ${x} ${y + ry} A ${w / 2} ${ry} 0 0 1 ${x + w} ${y + ry} V ${y + h - ry} A ${w / 2} ${ry} 0 0 1 ${x} ${y + h - ry} Z`; })()
    : shape === "diamond" ? `M ${x + w / 2} ${y} L ${x + w} ${y + h / 2} L ${x + w / 2} ${y + h} L ${x} ${y + h / 2} Z`
    : shape === "pill" ? `M ${x + h / 2} ${y} H ${x + w - h / 2} A ${h / 2} ${h / 2} 0 0 1 ${x + w - h / 2} ${y + h} H ${x + h / 2} A ${h / 2} ${h / 2} 0 0 1 ${x + h / 2} ${y} Z`
    : `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
  return { strokes: [pass(0), pass(1)], fill };
}

/** Edges start 4px off the source outline and their arrowhead tip stops 6px off the target: critics read the old 12/16px gaps as connectors ending in empty space (2026-10-25). */
const ARROW_GAP = 6;

/** Where the line from a node's centre toward `toward` leaves the node's outline, pushed out by `gap`. */
export function borderPoint(n: DiagramNode, toward: Pt, gap = 4): Pt {
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2, dx = toward[0] - cx, dy = toward[1] - cy, len = Math.hypot(dx, dy) || 1;
  let t: number;
  if (n.shape === "circle") t = 1 / Math.hypot(dx / (n.w / 2), dy / (n.h / 2));
  else if (n.shape === "diamond") t = 1 / (Math.abs(dx) / (n.w / 2) + Math.abs(dy) / (n.h / 2));
  else t = Math.min(dx === 0 ? Infinity : n.w / 2 / Math.abs(dx), dy === 0 ? Infinity : n.h / 2 / Math.abs(dy));
  return [cx + dx * t + (dx / len) * gap, cy + dy * t + (dy / len) * gap];
}

/** Edge geometry: a gently bowed hand-drawn line, its arrowhead, and the label point. */
export function edgePaths(e: DiagramEdge, a: DiagramNode, b: DiagramNode, index: number, scale = 1): { line: string; flow: string; arrow: string; mid: Pt } {
  const ca: Pt = [a.x + a.w / 2, a.y + a.h / 2], cb: Pt = [b.x + b.w / 2, b.y + b.h / 2];
  const head = (from: Pt, tip: Pt): string => {
    const tx = tip[0] - from[0], ty = tip[1] - from[1], tl = Math.hypot(tx, ty) || 1, ux = tx / tl, uy = ty / tl, s = 22 * scale;
    const wing = (sign: number): Pt => [tip[0] - ux * s + -uy * s * 0.55 * sign, tip[1] - uy * s + ux * s * 0.55 * sign];
    const l = wing(1), r = wing(-1);
    return `M ${f(l[0])} ${f(l[1])} L ${f(tip[0])} ${f(tip[1])} L ${f(r[0])} ${f(r[1])}`;
  };
  if (e.route === "hv" || e.route === "vh") {
    // Right-angled: leave along one axis, turn once at the corner, arrive along the other.
    const corner: Pt = e.route === "hv" ? [cb[0], ca[1]] : [ca[0], cb[1]];
    // Aligned nodes put the corner on a node's centre, where borderPoint has no direction: route straight instead.
    const degenerate = (corner[0] === ca[0] && corner[1] === ca[1]) || (corner[0] === cb[0] && corner[1] === cb[1]);
    if (degenerate) return edgePaths({ ...e, route: undefined }, a, b, index, scale);
    const p0 = borderPoint(a, corner), p1 = borderPoint(b, corner, ARROW_GAP);
    const rnd = seeded(`edge:${index}:${e.from}:${e.to}`);
    const line = `M ${f(p0[0])} ${f(p0[1])} ${roughSegment(p0, corner, rnd, 2)} ${roughSegment(corner, p1, rnd, 2)}`;
    const flow = `M ${f(p0[0])} ${f(p0[1])} L ${f(corner[0])} ${f(corner[1])} L ${f(p1[0])} ${f(p1[1])}`;
    const [m0, m1] = Math.hypot(corner[0] - p0[0], corner[1] - p0[1]) >= Math.hypot(p1[0] - corner[0], p1[1] - corner[1]) ? [p0, corner] : [corner, p1];
    const horiz = Math.abs(m1[1] - m0[1]) < Math.abs(m1[0] - m0[0]);
    const mid: Pt = horiz ? [(m0[0] + m1[0]) / 2, (m0[1] + m1[1]) / 2 - 30 * scale] : [(m0[0] + m1[0]) / 2 + 30 * scale, (m0[1] + m1[1]) / 2];
    return { line, flow, arrow: head(corner, p1), mid };
  }
  const p0 = borderPoint(a, cb), p1 = borderPoint(b, ca, ARROW_GAP);
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len, bow = (e.bend ?? 0) * len;
  const ctrl: Pt = [(p0[0] + p1[0]) / 2 + nx * bow, (p0[1] + p1[1]) / 2 + ny * bow];
  const rnd = seeded(`edge:${index}:${e.from}:${e.to}`);
  const j = () => (rnd() - 0.5) * 4;
  const clean = `M ${f(p0[0])} ${f(p0[1])} Q ${f(ctrl[0])} ${f(ctrl[1])}, ${f(p1[0])} ${f(p1[1])}`;
  const line = `M ${f(p0[0] + j())} ${f(p0[1] + j())} Q ${f(ctrl[0] + j())} ${f(ctrl[1] + j())}, ${f(p1[0])} ${f(p1[1])}`;
  const arrow = head(ctrl, p1);
  // Label point: the curve's midpoint pushed off the line on its outer side, so the label never sits on the stroke.
  const side = bow === 0 ? (ny <= 0 ? 1 : -1) : Math.sign(bow), off = 30 * scale;
  const mid: Pt = [0.25 * p0[0] + 0.5 * ctrl[0] + 0.25 * p1[0] + nx * off * side, 0.25 * p0[1] + 0.5 * ctrl[1] + 0.25 * p1[1] + ny * off * side];
  return { line, flow: clean, arrow, mid };
}

// ── Fonts ───────────────────────────────────────────────────────────────────

const ROLES = ["title", "subtitle", "label", "insight", "signature"] as const;
type Role = (typeof ROLES)[number];
const FALLBACK: Record<Role, string> = { title: "serif", subtitle: "serif", label: "sans-serif", insight: "sans-serif", signature: "cursive" };
/**
 * The bundled face a role gets when the install configures none. A generic-first stack renders as Inter on the MP4
 * only (the seam's preflight `font-generic-primary`), so every role names a real face; these come from the pinned
 * compiler's own OFL fonts, read from disk.
 */
const STAND_IN: Record<Role, [pkg: string, family: string]> = { title: ["eb-garamond", "EB Garamond"], subtitle: ["eb-garamond", "EB Garamond"], label: ["inter", "Inter"], insight: ["inter", "Inter"], signature: ["eb-garamond", "EB Garamond"] };
const FAMILY: Record<Role, string> = { title: "DiagramTitle", subtitle: "DiagramSubtitle", label: "DiagramLabel", insight: "DiagramInsight", signature: "DiagramSignature" };

export function fontConfigPath(): string {
  return join(getClaudeDir(), "LIFEOS", "USER", "CUSTOMIZATIONS", "SKILLS", "Art", "DiagramFonts.json");
}

export function themeConfigPath(): string {
  return join(getClaudeDir(), "LIFEOS", "USER", "CUSTOMIZATIONS", "SKILLS", "Art", "DiagramTheme.json");
}

/** The install's palette (DiagramTheme.json). Absent file: {} and the shipped palette stands. A bad key or value fails loud, naming the file and key. */
export function loadUserTheme(path = themeConfigPath()): Partial<Palette> {
  if (!existsSync(path)) return {};
  let cfg: unknown;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new DiagramError(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) throw new DiagramError(`${path} must hold a JSON object of palette keys`);
  const out: Partial<Palette> = {};
  for (const [key, value] of Object.entries(cfg as Record<string, unknown>)) {
    if (key === "provenance") continue;
    if (!(key in PALETTE)) throw new DiagramError(`${path}: "${key}" is not a palette key (${Object.keys(PALETTE).join(", ")})`);
    if (typeof value !== "string" || !COLOR.test(value)) throw new DiagramError(`${path}: "${key}" must be #rrggbb or rgb()/rgba(), got ${String(value)}`);
    if (key === "ground") {
      try { colourToHex(value); } catch (e) { throw new DiagramError(`${path}: "ground": ${(e as Error).message}`); }
    }
    out[key as keyof Palette] = value;
  }
  return out;
}

export type DiagramFonts = { faces: FontFaceSpec[]; stacks: Record<Role, string>; code?: string };

/** Every role's face: the install's DiagramFonts.json where it names one, the bundled stand-in otherwise, plus the code role for backticked spans. */
export function loadFontFaces(path = fontConfigPath(), opts: RoleOptions = {}): DiagramFonts {
  const stacks = { ...FALLBACK } as Record<Role, string>;
  let parsed: unknown = {};
  if (existsSync(path)) try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new DiagramError(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new DiagramError(`${path} must hold a JSON object of font roles (${ROLES.join(", ")})`);
  const cfg = parsed as Partial<Record<Role, { path: string; weight?: number; style?: "normal" | "italic" }>>;
  const faces: FontFaceSpec[] = [];
  for (const role of ROLES) {
    const c = cfg[role];
    if (c === undefined) {
      const [pkg, family] = STAND_IN[role];
      for (const f of bundledFaces(pkg, family, [400, 700], opts)) if (!faces.some((x) => x.family === f.family && x.weight === f.weight)) faces.push(f);
      stacks[role] = `"${family}", ${FALLBACK[role]}`;
      continue;
    }
    if (typeof c !== "object" || c === null || typeof c.path !== "string" || !c.path) throw new DiagramError(`${path}: "${role}" must be { "path": "<font file>", "weight"?, "style"? }`);
    faces.push({ family: FAMILY[role], path: c.path, weight: c.weight ?? 400, style: c.style ?? "normal" });
    stacks[role] = `"${FAMILY[role]}", ${FALLBACK[role]}`;
  }
  const code = roleFaces("code", opts);
  faces.push(...code.faces);
  return { faces, stacks, code: `"${code.family}", monospace` };
}

// ── Composition ─────────────────────────────────────────────────────────────

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** Label text with `backticked` spans set as code: monospace, case kept, so identifiers survive the uppercase label style. */
const rich = (t: string) => esc(t).replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`);

export interface Built { html: string; duration: number; holdStart: number }

/** The composition HTML. Pure: the same spec and fonts give the same bytes. */
export function buildHtml(raw: unknown, fonts: DiagramFonts = { faces: [], stacks: { ...FALLBACK } }, signer = "DA"): Built {
  const s = validateSpec(raw);
  const P: Palette = { ...PALETTE, ...(s.theme ?? {}) };
  const STROKE: Record<Tone, string> = { ink: P.ink, purple: P.purple, teal: P.teal };
  const FILL: Record<Tone, string> = { ink: P.paper, purple: P.purpleFill, teal: P.tealFill };
  const W = s.width, H = s.height, k = W / 1920, sc = s.strokeScale ?? 1, ty = s.typeScale ?? 1;
  const sw = (n: number) => f(n * sc);
  const px = (n: number) => `${Math.round(n * k)}px`;
  const byId = new Map(s.nodes.map((n) => [n.id, n]));
  const edges = s.edges ?? [], insights = s.insights ?? [];
  const steps = [...new Set([...s.nodes.map((n) => n.step), ...edges.map((e) => e.step), ...insights.map((i) => i.step)])].sort((a, b) => a - b);

  const svg: string[] = [], html: string[] = [], tw: string[] = [];
  let t = s.title || s.subtitle ? PACE.titleIn : 0.3;
  if (s.title) {
    html.push(`<h1 id="title" class="clip" data-start="0" data-duration="DUR" data-track-index="1">${esc(s.title)}</h1>`);
    tw.push(`tl.from("#title", { opacity: 0, y: ${Math.round(18 * k)}, duration: 0.8, ease: "power3.out" }, 0.15);`);
  }
  if (s.subtitle) {
    html.push(`<p id="subtitle" class="clip" data-start="0" data-duration="DUR" data-track-index="2">${esc(s.subtitle)}</p>`);
    tw.push(`tl.from("#subtitle", { opacity: 0, y: ${Math.round(12 * k)}, duration: 0.7, ease: "power3.out" }, 0.45);`);
  }

  const flows: Array<{ sel: string; at: number }> = [];
  for (const step of steps) {
    let cursor = t;
    s.nodes.filter((n) => n.step === step).forEach((n, i) => {
      const at = t + i * PACE.nodeStagger, tone = n.tone ?? "ink", p = nodePaths(n), sel = `n-${n.id}`, bare = n.shape === "none";
      if (!bare) svg.push(`<path id="${sel}-fill" d="${p.fill}" fill="${FILL[tone]}" stroke="none" opacity="0"/>`);
      if (!bare) p.strokes.forEach((d, j) => svg.push(`<path id="${sel}-s${j}" class="draw" d="${d}" pathLength="1" stroke="${STROKE[tone]}" stroke-width="${sw(j ? 3 : 5.6)}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${j ? 0.55 : 1}"/>`));
      const fs = n.fontSize ?? Math.round(Math.min(34, Math.max(18, Math.floor(n.h / 3.4))) * ty);
      html.push(`<div id="${sel}-label" class="label clip" data-start="0" data-duration="DUR" data-track-index="3" style="left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px;${n.labelAlign === "top" ? "justify-content:flex-start;padding-top:24px;" : ""}color:${tone === "ink" ? P.ink : STROKE[tone]}"><span style="font-size:${fs}px">${rich(n.label)}</span>${n.sub ? `<small style="font-size:${Math.round(fs * (s.subScale ?? 0.62))}px">${rich(n.sub)}</small>` : ""}</div>`);
      if (!bare) {
        tw.push(`tl.to("#${sel}-s0", { strokeDashoffset: 0, duration: ${PACE.strokeDraw}, ease: "power2.inOut" }, ${f(at)});`);
        tw.push(`tl.to("#${sel}-s1", { strokeDashoffset: 0, duration: ${PACE.strokeDraw}, ease: "power2.inOut" }, ${f(at + PACE.secondPass)});`);
        tw.push(`tl.to("#${sel}-fill", { opacity: 1, duration: ${PACE.fillIn}, ease: "power1.out" }, ${f(at + PACE.strokeDraw * 0.6)});`);
      }
      tw.push(`tl.from("#${sel}-label", { opacity: 0, y: 6, duration: ${PACE.fillIn}, ease: "power2.out" }, ${f(at + PACE.strokeDraw * 0.7)});`);
      cursor = Math.max(cursor, at + PACE.strokeDraw + PACE.secondPass);
    });
    let et = cursor;
    edges.forEach((e, i) => {
      if (e.step !== step) return;
      const tone = e.tone ?? (e.flow ? "teal" : "ink"), g = edgePaths(e, byId.get(e.from)!, byId.get(e.to)!, i, sc), sel = `e-${i}`;
      if (e.dashed) {
        // A dash pattern cannot also carry the draw-on, so a solid stroke in a mask draws on and reveals the dashes.
        svg.push(`<mask id="${sel}-m" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><path id="${sel}-line" class="draw" d="${g.flow}" pathLength="1" stroke="#fff" stroke-width="${sw(30)}" fill="none"/></mask>`);
        svg.push(`<path d="${g.flow}" mask="url(#${sel}-m)" stroke="${STROKE[tone]}" stroke-width="${sw(4.8)}" stroke-dasharray="${sw(16)} ${sw(14)}" fill="none" stroke-linecap="butt"/>`);
      } else svg.push(`<path id="${sel}-line" class="draw" d="${g.line}" pathLength="1" stroke="${STROKE[tone]}" stroke-width="${sw(4.8)}" fill="none" stroke-linecap="round"/>`);
      svg.push(`<path id="${sel}-arrow" class="draw" d="${g.arrow}" pathLength="1" stroke="${STROKE[tone]}" stroke-width="${sw(5.2)}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
      tw.push(`tl.to("#${sel}-line", { strokeDashoffset: 0, duration: ${PACE.edgeDraw}, ease: "power2.inOut" }, ${f(et)});`);
      tw.push(`tl.to("#${sel}-arrow", { strokeDashoffset: 0, duration: ${PACE.arrowDraw}, ease: "power2.out" }, ${f(et + PACE.edgeDraw - 0.05)});`);
      if (e.flow) {
        svg.push(`<path id="${sel}-flow" d="${g.flow}" pathLength="1" stroke="${P.ground}" stroke-width="${sw(2.6)}" fill="none" stroke-dasharray="0.035 0.065" stroke-dashoffset="0" opacity="0"/>`);
        flows.push({ sel: `#${sel}-flow`, at: et + PACE.edgeDraw + PACE.arrowDraw });
      }
      if (e.label) {
        html.push(`<div id="${sel}-label" class="edge-label clip" data-start="0" data-duration="DUR" data-track-index="4" style="left:${f(g.mid[0])}px;top:${f(g.mid[1])}px;color:${STROKE[tone]}">${rich(e.label)}</div>`);
        tw.push(`tl.from("#${sel}-label", { opacity: 0, duration: 0.35, ease: "power1.out" }, ${f(et + PACE.edgeDraw * 0.6)});`);
      }
      cursor = Math.max(cursor, et + PACE.edgeDraw + PACE.arrowDraw);
      et += PACE.nodeStagger;
    });
    insights.forEach((n, i) => {
      if (n.step !== step) return;
      const sel = `i-${i}`, color = n.tone === "teal" ? P.teal : P.purple;
      html.push(`<div id="${sel}" class="insight clip" data-start="0" data-duration="DUR" data-track-index="5" style="left:${n.x}px;top:${n.y}px;${n.maxWidth ? `max-width:${n.maxWidth}px;` : ""}color:${color}">*${rich(n.text)}*</div>`);
      tw.push(`tl.fromTo("#${sel}", { clipPath: "inset(-20% 100% -20% 0%)" }, { clipPath: "inset(-20% 0% -20% 0%)", duration: ${PACE.insightWrite}, ease: "power1.inOut" }, ${f(cursor + 0.1)});`);
      cursor += PACE.insightWrite * 0.7;
    });
    t = cursor + PACE.stepGap;
  }

  const holdStart = f(t);
  if (s.signature) {
    html.push(`<div id="signature" class="clip" data-start="0" data-duration="DUR" data-track-index="6">${esc(signer)}</div>`);
    tw.push(`tl.from("#signature", { opacity: 0, duration: 0.5, ease: "power1.out" }, ${f(holdStart - 0.2)});`);
  }
  const fadeAt = f(holdStart + s.hold), duration = f(fadeAt + PACE.fadeOut);
  for (const fl of flows) {
    tw.push(`tl.set("${fl.sel}", { opacity: 0.95 }, ${f(fl.at)});`);
    tw.push(`tl.to("${fl.sel}", { strokeDashoffset: ${-f((duration - fl.at) / PACE.flowPeriod)}, duration: ${f(duration - fl.at)}, ease: "none" }, ${f(fl.at)});`);
  }
  tw.push(`tl.to("#art", { opacity: 0, duration: ${PACE.fadeOut}, ease: "power2.in" }, ${fadeAt});`);

  // The underdrawing: the finished diagram, every stroke already drawn, ids renamed and timing stripped,
  // held still at low opacity under the ink. The loop fades the ink back to it, so the seam is invisible.
  const ghostOpacity = s.ghost ?? 0.13;
  const ghostOf = (m: string) => m.replace(/ id="/g, ' id="g-').replace(/ class="draw"/g, "").replace(/ mask="url\(#[^)]*\)"/g, "")
    .replace(/ opacity="0"/g, "").replace(/ class="([^"]*) clip"/g, ' class="$1"').replace(/ class="clip"/g, "").replace(/ data-[a-z-]+="[^"]*"/g, "");
  const ghost = ghostOpacity > 0 ? `<div id="ghost" style="opacity:${ghostOpacity}">
<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
${svg.filter((m) => !m.startsWith("<mask")).map(ghostOf).join("\n")}
</svg>
${html.map((m) => ghostOf(m).replace(/ id="g-/, ' data-layout-allow-occlusion id="g-')).join("\n")}
</div>
` : "";

  const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${W}, height=${H}" />
<script src="./vendor/gsap.min.js"></script>
<style>
body { margin: 0; background: ${P.ground}; }
#root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: ${P.ground}; }
#art, #ghost { position: absolute; inset: 0; }
svg { position: absolute; inset: 0; }
.draw { stroke-dasharray: 1 1; stroke-dashoffset: 1; }
#title, #g-title { position: absolute; left: ${px(80)}; top: ${px(56)}; margin: 0; font-family: ${fonts.stacks.title}; font-style: italic; font-weight: 400; font-size: ${px(66)}; line-height: 1.05; color: ${P.ink}; }
#subtitle, #g-subtitle { position: absolute; left: ${px(82)}; top: ${px(138)}; margin: 0; font-family: ${fonts.stacks.subtitle}; font-size: ${px(30)}; color: ${P.charcoal}; }
.label { position: absolute; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; box-sizing: border-box; padding: 8px 14px; font-family: ${fonts.stacks.label}; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; line-height: 1.1; }
.label small { margin-top: 6px; font-weight: 400; text-transform: none; letter-spacing: 0; color: ${P.charcoal}; }
.edge-label { position: absolute; transform: translate(-50%, -50%); padding: 2px 6px; background: ${P.ground}; border-radius: 4px; font-family: ${fonts.stacks.label}; font-size: ${px(22 * ty)}; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; white-space: nowrap; }
code { font-family: ${fonts.code ?? "ui-monospace, monospace"}; font-weight: 600; text-transform: none; letter-spacing: 0; font-size: 0.92em; font-variant-ligatures: none; font-feature-settings: "liga" 0, "calt" 0; }
.insight { position: absolute; font-family: ${fonts.stacks.insight}; font-style: italic; font-weight: 700; font-size: ${px(30 * ty)}; line-height: 1.15; }
#signature, #g-signature { position: absolute; right: ${px(64)}; bottom: ${px(34)}; font-family: ${fonts.stacks.signature}; font-size: ${px(52)}; color: ${P.signature}; transform: rotate(-4deg); }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="${W}" data-height="${H}" data-fps="${s.fps}">
${ghost}<div id="art">
<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
${svg.join("\n")}
</svg>
${html.join("\n").replaceAll('data-duration="DUR"', `data-duration="${duration}"`)}
</div>
</div>
<script>
const tl = gsap.timeline({ paused: true });
${tw.join("\n")}
${fonts.faces.length ? registerAfterFonts("main", "tl") : 'window.__timelines = window.__timelines || {};\nwindow.__timelines["main"] = tl;'}
</script>
</body>
</html>
`;
  return { html: fonts.faces.length ? injectFonts(doc, embedFonts(fonts.faces)) : doc, duration, holdStart };
}

// ── Commands ────────────────────────────────────────────────────────────────

export async function build(specPath: string, dir: string, force = false): Promise<{ index: string; duration: number; holdStart: number }> {
  const raw = JSON.parse(readFileSync(resolve(specPath), "utf8"));
  // Install palette under the spec's own theme; written into diagram.json so `gif` pins the same ground.
  const userTheme = loadUserTheme();
  const spec = Object.keys(userTheme).length && raw && typeof raw === "object" && !Array.isArray(raw)
    ? { ...raw, theme: { ...userTheme, ...((raw as DiagramSpec).theme ?? {}) } }
    : raw;
  const built = buildHtml(spec, loadFontFaces(), getDAName());
  const project = resolve(dir), index = join(project, "index.html");
  if (existsSync(index) && !force) throw new DiagramError(`${index} exists; pass --force to rebuild it`);
  invariant(built.html.includes('data-composition-id="main"') && built.html.includes('window.__timelines'), "diagram HTML lost its root or timeline registration");
  mkdirSync(project, { recursive: true });
  writeFileSync(index, built.html);
  writeFileSync(join(project, "diagram.json"), JSON.stringify({ ...spec, _built: { duration: built.duration, holdStart: built.holdStart } }, null, 2) + "\n");
  await stageGsap(project);
  return { index, duration: built.duration, holdStart: built.holdStart };
}

async function sh(cmd: string[]): Promise<void> {
  const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const err = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) throw new DiagramError(`${cmd[0]} failed: ${err.trim().slice(-400)}`);
}

export async function gif(dir: string, opts: { name?: string; width?: number; fps?: number } = {}): Promise<{ mp4: string; gif: string; poster: string; bytes: number }> {
  const project = resolve(dir);
  const built = JSON.parse(readFileSync(join(project, "diagram.json"), "utf8")) as { _built?: { duration: number; holdStart: number }; theme?: Partial<Palette> };
  const meta = built._built;
  if (!meta) throw new DiagramError(`${project}/diagram.json has no build record; run build first`);
  return encodeGif(project, { name: opts.name, width: opts.width, fps: opts.fps, posterAt: Math.max(0, meta.duration - PACE.fadeOut - 0.4), startAt: meta.holdStart, ground: built.theme?.ground ?? PALETTE.ground });
}

/**
 * A ground colour (#rrggbb, rgb() or rgba(), the forms COLOR accepts) as #rrggbb. A ground is opaque paper:
 * the page CSS paints it as given while the GIF encoder pins and measures its hex, so an rgba() with alpha
 * below 1 would render one colour and be checked against another. Such a ground is refused, never flattened.
 */
export function colourToHex(colour: string): string {
  if (/^#[0-9a-f]{6}$/i.test(colour)) return colour.toLowerCase();
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(colour);
  if (!m) throw new DiagramError(`ground must be #rrggbb, rgb() or rgba(), got "${colour}"`, true);
  const ch = [m[1], m[2], m[3]].map((v) => Number(v));
  if (ch.some((v) => !Number.isFinite(v) || v < 0 || v > 255)) throw new DiagramError(`ground channels must be 0-255, got "${colour}"`, true);
  if (m[4] !== undefined && Number(m[4]) !== 1) throw new DiagramError(`ground must be opaque (alpha 1), got "${colour}"; a translucent ground renders differently from the colour the GIF encoder pins`, true);
  return "#" + ch.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

/** Replace the palette entry nearest `colour` with that colour exactly. The palette is ffmpeg's 16x16 palettegen PNG. */
export async function pinPaletteColour(palette: string, colour: string): Promise<{ x: number; y: number; was: [number, number, number] }> {
  const hex = colourToHex(colour);
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  invariant(m !== null, `colourToHex returned ${hex}`);
  const want = [1, 2, 3].map((i) => parseInt(m[i]!, 16)) as [number, number, number];
  const p = Bun.spawn(["magick", palette, "-depth", "8", "txt:-"], { stdout: "pipe", stderr: "pipe" });
  const txt = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new DiagramError(`could not read palette ${palette}`);
  let best: { x: number; y: number; was: [number, number, number]; d: number } | null = null;
  for (const line of txt.split("\n")) {
    const q = /^(\d+),(\d+):\s*\((\d+),(\d+),(\d+)/.exec(line);
    if (!q) continue;
    const c = [Number(q[3]), Number(q[4]), Number(q[5])] as [number, number, number];
    const dist = (c[0] - want[0]) ** 2 + (c[1] - want[1]) ** 2 + (c[2] - want[2]) ** 2;
    if (!best || dist < best.d) best = { x: Number(q[1]), y: Number(q[2]), was: c, d: dist };
  }
  invariant(best !== null, "palette has no colours");
  await sh(["magick", palette, "-fill", hex, "-draw", `point ${best.x},${best.y}`, palette]);
  return { x: best.x, y: best.y, was: best.was };
}

/**
 * ffmpeg filter that rotates a loop to begin at `startAt`: the tail from startAt, then the head up to it.
 * A GIF's first frame is its face everywhere it is not playing (Keynote edit view and exports, PDFs, link
 * previews), so the loop opens on the finished picture rather than the bare underdrawing (2026-10-01, a Keynote deck export).
 */
export function rotationFilter(startAt: number): string {
  invariant(Number.isFinite(startAt) && startAt > 0, `rotation needs a positive start, got ${startAt}`);
  return `split[ra][rb];[ra]trim=start=${startAt},setpts=PTS-STARTPTS[rt];[rb]trim=end=${startAt},setpts=PTS-STARTPTS[rh];[rt][rh]concat=n=2:v=1:a=0`;
}

export interface GifOptions { name?: string; width?: number; fps?: number; posterAt: number; /** Begin the loop here (seconds), normally the start of the complete hold. */ startAt?: number; /** The page's paper colour, pinned into the palette so the GIF's ground matches the slide or page exactly. */ ground?: string; /** "diff" weights the palette to moving pixels (flat diagrams); "full" to the whole frame (textured art). */ palette?: "diff" | "full"; colors?: number }

/** Render a built project through the seam to Out/<name>.mp4, then encode the looping GIF and the poster still. */
export async function encodeGif(project: string, opts: GifOptions): Promise<{ mp4: string; gif: string; poster: string; bytes: number }> {
  const name = opts.name ?? basename(project), width = opts.width ?? 1200, fps = opts.fps ?? 15, colors = opts.colors ?? 160;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new DiagramError(`--name must be a lowercase slug, got "${name}"`, true);
  if (!Number.isInteger(width) || width < 320 || width > 1920) throw new DiagramError(`--width must be 320..1920, got ${width}`, true);
  if (!Number.isInteger(fps) || fps < 8 || fps > 30) throw new DiagramError(`--fps must be 8..30, got ${fps}`, true);
  const out = join(project, "Out"), mp4 = join(out, `${name}.mp4`), gifPath = join(out, `${name}.gif`), poster = join(out, `${name}-poster.png`);
  mkdirSync(out, { recursive: true });
  // Re-encoding a GIF needs no new render when the MP4 is newer than the composition.
  const fresh = existsSync(mp4) && statSync(mp4).mtimeMs > statSync(join(project, "index.html")).mtimeMs;
  if (!fresh) await render({ projectDir: project, out: mp4, quality: "high" });
  const dither = opts.palette === "full" ? "dither=sierra2_4a" : "dither=bayer:bayer_scale=4:diff_mode=rectangle";
  let scale = `fps=${fps},scale=${width}:-2:flags=lanczos`;
  const palette = join(out, `.${name}-palette.png`);
  if (opts.ground) {
    // H.264 darkens the paper a few levels per channel before the palette ever sees it,
    // so pinning alone misses. Measure the rendered paper and shift every channel back by the difference first.
    const probe = join(out, `.${name}-paper.png`);
    await sh(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", String(opts.posterAt), "-i", mp4, "-frames:v", "1", "-vf", "crop=24:24:4:4", probe]);
    const q = Bun.spawnSync(["magick", probe, "-format", "%[fx:round(mean.r*255)] %[fx:round(mean.g*255)] %[fx:round(mean.b*255)]", "info:"]);
    rmSync(probe, { force: true });
    const got = new TextDecoder().decode(q.stdout).trim().split(" ").map(Number);
    const groundHex = colourToHex(opts.ground);
    const want = [1, 3, 5].map((i) => parseInt(groundHex.slice(i, i + 2), 16));
    invariant(got.length === 3 && got.every(Number.isFinite), `could not measure the rendered paper of ${mp4}`);
    const dv = want.map((w, i) => w - got[i]!);
    if (dv.some((v) => Math.abs(v) > 12)) throw new DiagramError(`the frame corner (${got.join(",")}) is not paper near ${opts.ground}; leave the top-left corner empty or omit ground`);
    scale = `lutrgb=r='clip(val+${dv[0]},0,255)':g='clip(val+${dv[1]},0,255)':b='clip(val+${dv[2]},0,255)',${scale}`;
  }
  if (opts.startAt) scale = `${rotationFilter(opts.startAt)},${scale}`;
  await sh(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", mp4, "-vf", `${scale},palettegen=max_colors=${colors}:stats_mode=${opts.palette ?? "diff"}`, palette]);
  // Quantising drifts the paper a few more levels per channel, which shows as a box on a slide.
  // Snap the palette entry nearest the paper to the paper itself.
  if (opts.ground) await pinPaletteColour(palette, opts.ground);
  await sh(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", mp4, "-i", palette, "-lavfi", `${scale}[x];[x][1:v]paletteuse=${dither}`, "-loop", "0", gifPath]);
  rmSync(palette, { force: true });
  await sh(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", String(opts.posterAt), "-i", mp4, "-frames:v", "1", poster]);
  invariant(existsSync(gifPath) && statSync(gifPath).size > 0, "GIF encode produced no file");
  return { mp4, gif: gifPath, poster, bytes: statSync(gifPath).size };
}

const USAGE = `usage:
  bun AnimatedDiagram.ts build --spec <diagram.json> --dir <project> [--force]
  bun AnimatedDiagram.ts gif   --dir <project> [--name <slug>] [--width 1200] [--fps 15]`;

function flags(argv: string[], allowed: string[], bools: string[] = []): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (bools.includes(a)) { m.set(a.slice(2), "true"); continue; }
    if (!allowed.includes(a)) throw new DiagramError(`unknown argument "${a}"`, true);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new DiagramError(`${a} needs a value`, true);
    m.set(a.slice(2), v);
    i++;
  }
  return m;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "build") {
      const v = flags(rest, ["--spec", "--dir"], ["--force"]);
      if (!v.get("spec") || !v.get("dir")) throw new DiagramError("build needs --spec and --dir", true);
      const r = await build(v.get("spec")!, v.get("dir")!, v.has("force"));
      console.log(`✓ ${r.index}  (${r.duration}s; complete diagram holds from ${r.holdStart}s)`);
    } else if (cmd === "gif") {
      const v = flags(rest, ["--dir", "--name", "--width", "--fps"]);
      if (!v.get("dir")) throw new DiagramError("gif needs --dir", true);
      const num = (k: string) => (v.has(k) ? Number(v.get(k)) : undefined);
      const r = await gif(v.get("dir")!, { name: v.get("name"), width: num("width"), fps: num("fps") });
      console.log(`✓ ${r.gif}  (${(r.bytes / 1024 / 1024).toFixed(2)} MB)\n✓ ${r.poster}\n✓ ${r.mp4}`);
    } else {
      throw new DiagramError(cmd ? `unknown command "${cmd}"` : "no command", true);
    }
  } catch (e) {
    const usage = e instanceof DiagramError && e.usage;
    console.error(`✗ ${(e as Error).message}${usage ? `\n${USAGE}` : ""}`);
    process.exit(usage ? 2 : 1);
  }
}
