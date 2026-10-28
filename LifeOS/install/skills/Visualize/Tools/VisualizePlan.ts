#!/usr/bin/env bun
/**
 * VisualizePlan.ts — deterministic renderer for physical plans in the Visualize skill.
 *
 * A plan is a setup that exists (or will exist) in space: a drum kit, a studio
 * desk, a rack, a room. The model writes one typed plan-model JSON after reading
 * the plan's own documents; this tool validates that every piece, order line,
 * cost and decision quotes the file it came from, and that every cost, stated
 * total and `dims` value appears as a number in its own quote, then emits:
 *   1. a concise console summary on stdout
 *   2. one self-contained HTML page — a to-scale top-down drawing with a detail
 *      panel, the cost split, the grouped order and the open decisions — written
 *      to <root>/Visualize-<slug>-<YYYY-MM-DD-HHmmss>.html
 *
 * Usage:
 *   bun VisualizePlan.ts --model plan.json --root <plan dir> [--out-dir <dir>] [--width 100] [--no-html]
 *   bun VisualizePlan.ts --check --model plan.json --root <plan dir>
 *   bun VisualizePlan.ts --schema
 *
 * Exit: 0 rendered · 1 model refused (errors printed) · 2 usage error
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { SECRET_SHAPES, outputPath, slugify, wrap, writeHtml } from "./Visualize.ts";

// ---------- model ----------

export const MATERIALS = ["wood", "brass", "brass-dark", "steel", "membrane", "dark"] as const;
export type Material = (typeof MATERIALS)[number];

/** A citation: the file the fact came from and a verbatim quote that appears in it. */
export interface Source { file: string; quote: string }

export interface Category { id: string; name: string; cost?: number; source?: Source }
export interface Piece {
  id: string; cat: string; name: string; model: string;
  shape: "circle" | "rect"; material: Material;
  x: number; y: number;          // centre, in drawing units; y grows toward the viewer's seat
  dia?: number;                   // circle diameter
  w?: number; d?: number;         // rect width and depth
  dims?: number[];                // real dimensions to display (e.g. diameter × depth); each must appear in the quote
  dimsLabel?: string;             // what dims mean, e.g. "Dia × depth"
  label?: string;                 // short text drawn on the piece (defaults to its size)
  tag?: string;                   // small type tag drawn on larger pieces
  price?: string; note?: string; optional?: boolean; z?: number;
  source: Source;
}
export interface OrderItem { name: string; spec?: string; piece?: string; optional?: boolean; source: Source }
export interface Group { cat: string; title?: string; note?: string; items: OrderItem[] }
export interface Decision { title: string; text: string; source: Source }
export interface PlanModel {
  kind: "plan";
  name: string;
  kicker?: string;
  lede: string;
  chips?: { strong: string; text?: string }[];
  currency?: string;
  unit: "in" | "cm";
  drawing: {
    note: string;                 // where the positions come from; positions are rarely in the plan itself
    front?: string;
    ground?: { x: number; y: number; w: number; h: number };
    scale?: { length: number; label: string };
  };
  summary?: { heading: string; counts?: { n: number | string; label: string }[]; facts?: { k: string; v: string }[] };
  categories: Category[];
  statedTotal?: { amount: number; source: Source };
  costNote?: string;
  pieces: Piece[];
  groups: Group[];
  decisions?: Decision[];
  sources: string[];
}

export const EXAMPLE: PlanModel = {
  kind: "plan",
  name: "Corner Studio Desk",
  kicker: "Planned · nothing bought yet",
  lede: "A small recording desk for a spare-room corner, drawn top-down to scale with the wall at the top.",
  chips: [{ strong: "≈ $2,050", text: "total" }, { strong: "5", text: "pieces" }],
  currency: "$",
  unit: "cm",
  drawing: { note: "Positions are a proposed arrangement; the plan lists items, not placement.", front: "WALL", ground: { x: 0, y: 0, w: 180, h: 150 }, scale: { length: 50, label: "50 cm" } },
  summary: { heading: "Corner studio desk", counts: [{ n: 5, label: "Pieces" }, { n: 3, label: "Categories" }], facts: [{ k: "Desk", v: "160 × 80 cm oak" }] },
  categories: [
    { id: "furniture", name: "Furniture", cost: 900, source: { file: "plan.md", quote: "Furniture: $900" } },
    { id: "audio", name: "Audio", cost: 700, source: { file: "plan.md", quote: "Audio: $700" } },
    { id: "display", name: "Display", cost: 450, source: { file: "plan.md", quote: "Display: $450" } },
  ],
  statedTotal: { amount: 2050, source: { file: "plan.md", quote: "Total: $2,050" } },
  pieces: [
    { id: "desk", cat: "furniture", name: "Desk", model: "Oak top on steel legs", shape: "rect", material: "wood", x: 90, y: 45, w: 160, d: 80, dims: [160, 80], dimsLabel: "Width × depth", source: { file: "plan.md", quote: "Oak desk 160 x 80" } },
    { id: "spkL", cat: "audio", name: "Monitor speaker, left", model: "Two-way near-field", shape: "rect", material: "dark", x: 30, y: 25, w: 20, d: 25, source: { file: "plan.md", quote: "2x near-field monitors" } },
    { id: "spkR", cat: "audio", name: "Monitor speaker, right", model: "Two-way near-field", shape: "rect", material: "dark", x: 150, y: 25, w: 20, d: 25, source: { file: "plan.md", quote: "2x near-field monitors" } },
    { id: "screen", cat: "display", name: "Display", model: "27-inch 4K", shape: "rect", material: "steel", x: 90, y: 20, w: 62, d: 8, source: { file: "plan.md", quote: "27-inch 4K display" } },
    { id: "chair", cat: "furniture", name: "Chair", model: "Task chair", shape: "circle", material: "dark", x: 90, y: 115, dia: 55, source: { file: "plan.md", quote: "Task chair" } },
  ],
  groups: [
    { cat: "furniture", items: [{ name: "Oak desk", spec: "160 × 80", piece: "desk", source: { file: "plan.md", quote: "Oak desk 160 x 80" } }, { name: "Task chair", piece: "chair", source: { file: "plan.md", quote: "Task chair" } }] },
    { cat: "audio", items: [{ name: "2× near-field monitors", piece: "spkL", source: { file: "plan.md", quote: "2x near-field monitors" } }] },
    { cat: "display", items: [{ name: "27-inch 4K display", piece: "screen", source: { file: "plan.md", quote: "27-inch 4K display" } }] },
  ],
  decisions: [{ title: "Desk finish", text: "Oiled or lacquered oak.", source: { file: "plan.md", quote: "finish: oiled or lacquered" } }],
  sources: ["plan.md"],
};

// ---------- validation ----------

export interface Validation { errors: string[]; warnings: string[] }

/** Every number written in a quote, thousands separators dropped: "~$1,250" → 1250, 14"×6.5" → 14, 6.5. */
export const numbersIn = (q: string): number[] => (q.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((t) => Number(t.replace(/,/g, "")));

const norm = (s: string) => s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D\u2033]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();

export function validate(model: PlanModel, root: string): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cache = new Map<string, string | null>();
  const req = (v: unknown, where: string) => { if (typeof v !== "string" || !v.trim()) errors.push(`${where}: required text is missing`); };
  const num = (v: unknown, where: string) => { if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`${where}: must be a number`); };
  const read = (file: string): string | null => {
    if (!cache.has(file)) {
      const full = isAbsolute(file) ? file : join(root, file);
      cache.set(file, existsSync(full) && statSync(full).isFile() ? readFileSync(full, "utf8") : null);
    }
    return cache.get(file)!;
  };
  const cite = (s: Source | undefined, where: string) => {
    if (!s || typeof s.file !== "string" || !s.file.trim() || typeof s.quote !== "string" || !s.quote.trim()) {
      errors.push(`${where}: source { file, quote } is required — the plan document this fact comes from`); return;
    }
    const body = read(s.file);
    if (body === null) { errors.push(`${where}: source file "${s.file}" does not exist under the root`); return; }
    if (!norm(body).includes(norm(s.quote))) errors.push(`${where}: quote "${s.quote}" does not appear in ${s.file}`);
  };
  // A quote that merely exists does not back a number: the value itself must be in it.
  const states = (s: Source | undefined, n: number | undefined, where: string) => {
    if (typeof n !== "number" || typeof s?.quote !== "string") return;
    if (!numbersIn(s.quote).includes(n)) errors.push(`${where}: ${n} does not appear in its quote "${s.quote}"`);
  };

  if (model.kind !== "plan") errors.push(`kind: must be "plan"`);
  req(model.name, "name"); req(model.lede, "lede");
  if (model.unit !== "in" && model.unit !== "cm") errors.push(`unit: must be "in" or "cm"`);
  req(model.drawing?.note, "drawing.note");
  for (const key of ["categories", "pieces", "groups", "sources"] as const) if (!Array.isArray(model[key])) errors.push(`${key}: must be an array`);
  if (errors.length) return { errors, warnings };

  const cats = new Set<string>();
  for (const c of model.categories) {
    const w = `category "${c.id}"`;
    req(c.id, "category.id"); req(c.name, `${w}.name`);
    if (cats.has(c.id)) errors.push(`${w} is declared twice`);
    cats.add(c.id);
    if (c.cost !== undefined) { num(c.cost, `${w}.cost`); cite(c.source, `${w}.cost`); states(c.source, c.cost, `${w}.cost`); }
  }
  if (model.statedTotal) { num(model.statedTotal.amount, "statedTotal.amount"); cite(model.statedTotal.source, "statedTotal"); states(model.statedTotal.source, model.statedTotal.amount, "statedTotal.amount"); }

  const ids = new Set<string>();
  for (const p of model.pieces) {
    const w = `piece "${p.id}"`;
    req(p.id, "piece.id"); req(p.name, `${w}.name`); req(p.model, `${w}.model`);
    if (ids.has(p.id)) errors.push(`${w} is declared twice`);
    ids.add(p.id);
    if (!cats.has(p.cat)) errors.push(`${w}: category "${p.cat}" is not declared`);
    if (!MATERIALS.includes(p.material)) errors.push(`${w}: material "${p.material}" is not one of ${MATERIALS.join(", ")}`);
    num(p.x, `${w}.x`); num(p.y, `${w}.y`);
    if (p.shape === "circle") { num(p.dia, `${w}.dia`); if ((p.dia ?? 0) <= 0) errors.push(`${w}: dia must be positive`); }
    else if (p.shape === "rect") { num(p.w, `${w}.w`); num(p.d, `${w}.d`); if ((p.w ?? 0) <= 0 || (p.d ?? 0) <= 0) errors.push(`${w}: w and d must be positive`); }
    else errors.push(`${w}: shape must be circle or rect`);
    cite(p.source, w);
    (p.dims ?? []).forEach((v, i) => states(p.source, v, `${w}.dims[${i}]`));
  }
  if (model.pieces.length === 0) errors.push("pieces: a plan needs at least one piece to draw");

  model.groups.forEach((g, gi) => {
    const w = `group ${gi + 1} (${g.cat})`;
    if (!cats.has(g.cat)) errors.push(`${w}: category "${g.cat}" is not declared`);
    if (!Array.isArray(g.items) || g.items.length === 0) { errors.push(`${w}: needs at least one item`); return; }
    g.items.forEach((it, ii) => {
      const iw = `${w} item ${ii + 1}`;
      req(it.name, `${iw}.name`);
      if (it.piece !== undefined && !ids.has(it.piece)) errors.push(`${iw}: piece "${it.piece}" is not declared`);
      cite(it.source, iw);
    });
  });
  (model.decisions ?? []).forEach((d, i) => { req(d.title, `decision ${i + 1}.title`); req(d.text, `decision ${i + 1}.text`); cite(d.source, `decision ${i + 1}`); });
  if (model.sources.length === 0) errors.push("sources: list the plan files you read");
  for (const s of model.sources) if (read(s) === null) errors.push(`sources: "${s}" does not exist under the root`);

  const total = model.categories.reduce((a, c) => a + (c.cost ?? 0), 0);
  if (model.statedTotal && total > 0 && total !== model.statedTotal.amount) {
    warnings.push(`categories add up to ${total}, the plan states ${model.statedTotal.amount}; the page shows both`);
  }
  const blob = JSON.stringify(model);
  for (const [re, what] of SECRET_SHAPES) if (re.test(blob)) errors.push(`model text contains a ${what}; remove it`);
  return { errors, warnings };
}

// ---------- shared helpers ----------

const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const CAT_COLORS = ["#6cc4ff", "#b59cff", "#ffb86b", "#5fe0b0", "#ff8fa3", "#f2dc6b", "#9fb3c8", "#7fd4e8"]; // the system map PALETTE
const S = 10; // svg units per drawing unit

export function money(n: number, cur = "$"): string { return cur + Math.round(n).toLocaleString("en-US"); }
export function categoryTotal(model: PlanModel): number { return model.categories.reduce((a, c) => a + (c.cost ?? 0), 0); }

/** Human size with the other unit alongside: 14″ (35.6 cm), or 50 cm (19.7″). */
export function sizeText(p: Piece, unit: "in" | "cm"): string {
  const dims = p.dims ?? (p.shape === "circle" ? (p.dia ? [p.dia] : []) : [p.w ?? 0, p.d ?? 0]);
  if (!dims.length) return "";
  const r1 = (v: number) => String(Math.round(v * 10) / 10);
  if (unit === "in") return `${dims.map((v) => `${r1(v)}″`).join(" × ")} (${dims.map((v) => r1(v * 2.54)).join(" × ")} cm)`;
  return `${dims.map((v) => r1(v)).join(" × ")} cm (${dims.map((v) => `${r1(v / 2.54)}″`).join(" × ")})`;
}

function bounds(model: PlanModel) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (a: number, b: number, c: number, d: number) => { x0 = Math.min(x0, a); y0 = Math.min(y0, b); x1 = Math.max(x1, c); y1 = Math.max(y1, d); };
  for (const p of model.pieces) {
    if (p.shape === "circle") { const r = p.dia! / 2; add(p.x - r, p.y - r, p.x + r, p.y + r); }
    else add(p.x - p.w! / 2, p.y - p.d! / 2, p.x + p.w! / 2, p.y + p.d! / 2);
  }
  const g = model.drawing.ground;
  if (g) add(g.x, g.y, g.x + g.w, g.y + g.h);
  const pad = Math.max(x1 - x0, y1 - y0) * 0.04;
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

// ---------- SVG ----------

const DEFAULT_Z: Record<Material, number> = { dark: 0, wood: 1, steel: 1, membrane: 2, brass: 3, "brass-dark": 3 };
const LABEL_FONT = "Avenir Next, Segoe UI, system-ui, sans-serif";
const BODY_FONT = "Avenir Next, Segoe UI, system-ui, sans-serif";
const INK = { text: "#a7b4c6", darkInk: "#2b1d08", headInk: "#3a2814" };

export function renderSvg(model: PlanModel): string {
  const b = bounds(model);
  const W = (b.x1 - b.x0) * S;
  const base = W / 40;
  const top = model.drawing.front ? base * 2.4 : 0;
  const bottom = model.drawing.scale ? base * 2.6 : 0;
  const vb = [b.x0 * S, b.y0 * S - top, W, (b.y1 - b.y0) * S + top + bottom].map((v) => Math.round(v * 10) / 10);
  const out: string[] = [];
  out.push(`<svg id="plan" viewBox="${vb.join(" ")}" role="img" aria-label="${esc(`Top-down drawing of ${model.name}`)}">`);
  out.push(`<defs>
<radialGradient id="g-brass" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#f1d48d"/><stop offset="18%" stop-color="#d9b25a"/><stop offset="60%" stop-color="#c29143"/><stop offset="100%" stop-color="#9c7031"/></radialGradient>
<radialGradient id="g-brass-dark" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#e9bf78"/><stop offset="18%" stop-color="#c98f45"/><stop offset="70%" stop-color="#a86a2c"/><stop offset="100%" stop-color="#7f4c1d"/></radialGradient>
<radialGradient id="g-bell" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#fff0c4"/><stop offset="100%" stop-color="#d7ab52"/></radialGradient>
<linearGradient id="g-wood" x1="0" x2="1" y1="0" y2="0"><stop offset="0%" stop-color="#7f5731"/><stop offset="22%" stop-color="#c89b63"/><stop offset="50%" stop-color="#e0bb86"/><stop offset="78%" stop-color="#c89b63"/><stop offset="100%" stop-color="#7f5731"/></linearGradient>
</defs>`);
  const g = model.drawing.ground;
  if (g) {
    out.push(`<rect x="${g.x * S}" y="${g.y * S}" width="${g.w * S}" height="${g.h * S}" rx="${base * 0.25}" fill="#151c26" stroke="#263243" stroke-width="${base * 0.12}"/>`);
    const i = base * 0.6;
    out.push(`<rect x="${g.x * S + i}" y="${g.y * S + i}" width="${g.w * S - 2 * i}" height="${g.h * S - 2 * i}" fill="none" stroke="#334358" stroke-width="${base * 0.08}" stroke-dasharray="${base * 0.4} ${base * 0.3}"/>`);
  }
  if (model.drawing.front) {
    out.push(`<text x="${vb[0] + W / 2}" y="${vb[1] + top * 0.5}" fill="${INK.text}" font-size="${base * 0.9}" font-family="${LABEL_FONT}" font-weight="700" letter-spacing="${base * 0.2}" text-anchor="middle" dominant-baseline="central">▲  ${esc(model.drawing.front)}</text>`);
  }
  if (model.drawing.scale) {
    const sx = vb[0] + base, sy = vb[1] + vb[3] - bottom * 0.45, L = model.drawing.scale.length * S;
    out.push(`<line x1="${sx}" y1="${sy}" x2="${sx + L}" y2="${sy}" stroke="${INK.text}" stroke-width="${base * 0.11}"/>`);
    for (const dx of [0, L / 2, L]) out.push(`<line x1="${sx + dx}" y1="${sy - base * 0.3}" x2="${sx + dx}" y2="${sy + base * 0.3}" stroke="${INK.text}" stroke-width="${base * 0.11}"/>`);
    out.push(`<text x="${sx + L + base * 0.6}" y="${sy}" fill="${INK.text}" font-size="${base * 0.8}" font-family="${BODY_FONT}" dominant-baseline="central">${esc(model.drawing.scale.label)}</text>`);
  }

  const ordered = [...model.pieces].sort((a, c) => {
    const za = a.z ?? (a.optional ? 3 : DEFAULT_Z[a.material]), zc = c.z ?? (c.optional ? 3 : DEFAULT_Z[c.material]);
    if (za !== zc) return za - zc;
    return (c.dia ?? c.w ?? 0) - (a.dia ?? a.w ?? 0);
  });
  const text = (x: number, y: number, s: string, size: number, fill: string, weight = 700, extra = "") =>
    `<text x="${r(x)}" y="${r(y)}" font-size="${r(size)}" fill="${fill}" font-weight="${weight}" font-family="${LABEL_FONT}" text-anchor="middle" dominant-baseline="central" pointer-events="none"${extra}>${esc(s)}</text>`;
  const r = (v: number) => Math.round(v * 10) / 10;

  for (const p of ordered) {
    const cx = p.x * S, cy = p.y * S;
    const size = p.label ?? (p.shape === "circle" ? `${p.dia}${model.unit === "in" ? "″" : ""}` : `${p.w} × ${p.d}`);
    const parts: string[] = [];
    const body = (shape: string) => parts.push(shape.replace(/^<(\w+)/, (_m, tag) => `<${tag} data-body="1"`));
    if (p.shape === "rect") {
      const w = p.w! * S, d = p.d! * S;
      const fill = p.optional ? "none" : p.material === "wood" ? "url(#g-wood)" : p.material === "steel" ? "#59636e" : p.material === "membrane" ? "#e6dfcf" : p.material === "dark" ? "#262b31" : `url(#g-${p.material})`;
      const stroke = p.optional ? "#d9b25a" : p.material === "wood" ? "#5b3f22" : "#8c98a5";
      body(`<rect x="${r(cx - w / 2)}" y="${r(cy - d / 2)}" width="${r(w)}" height="${r(d)}" rx="${r(base * 0.25)}" fill="${fill}" stroke="${stroke}" stroke-width="${r(base * 0.12)}"${p.optional ? ` stroke-dasharray="${r(base * 0.45)} ${r(base * 0.33)}"` : ""}/>`);
      if (p.material === "wood" && !p.optional) {
        const band = Math.min(d * 0.08, base * 0.55);
        parts.push(`<rect x="${r(cx - w / 2)}" y="${r(cy - d / 2)}" width="${r(w)}" height="${r(band)}" fill="#6e4a28"/>`);
        parts.push(`<rect x="${r(cx - w / 2)}" y="${r(cy + d / 2 - band)}" width="${r(w)}" height="${r(band)}" fill="#6e4a28"/>`);
      }
      const ink = p.optional ? "#d9b25a" : p.material === "wood" || p.material === "membrane" ? INK.headInk : "#c9ced4";
      const fs = Math.min(base * 0.9, w / Math.max(3, size.length) * 1.6);
      parts.push(text(cx, p.material === "wood" ? cy + d * 0.28 : cy, size, fs, ink));
    } else {
      const rad = (p.dia! / 2) * S;
      const big = Math.min(base * 1.2, rad * 0.55);
      if (p.material === "brass" || p.material === "brass-dark") {
        body(`<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(rad)}" fill="${p.optional ? "none" : `url(#g-${p.material})`}" fill-opacity="0.72" stroke="${p.optional ? "#d9b25a" : "#6e4f1f"}" stroke-width="${r(base * (p.optional ? 0.11 : 0.07))}"${p.optional ? ` stroke-dasharray="${r(base * 0.45)} ${r(base * 0.33)}"` : ""}/>`);
        if (!p.optional) {
          for (const f of [0.82, 0.62, 0.42]) parts.push(`<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(rad * f)}" fill="none" stroke="#3c280a" stroke-opacity="0.22" stroke-width="${r(base * 0.045)}"/>`);
          if (p.material === "brass-dark") parts.push(`<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(rad * 0.92)}" fill="none" stroke="#321905" stroke-opacity="0.55" stroke-width="${r(base * 0.07)}" stroke-dasharray="${r(base * 0.22)} ${r(base * 0.22)}"/>`);
          parts.push(`<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(rad * 0.2)}" fill="url(#g-bell)" stroke="#50370f" stroke-opacity="0.4" stroke-width="${r(base * 0.04)}"/>`);
        }
        const ink = p.optional ? "#d9b25a" : INK.darkInk;
        const showTag = !!p.tag && rad > base * 1.8;
        parts.push(text(cx, showTag ? cy + rad * 0.5 : cy, size, big, ink));
        if (showTag) parts.push(text(cx, cy - rad * 0.5, p.tag!, big * 0.5, ink, 600, ` letter-spacing="${r(base * 0.05)}"`));
      } else if (p.material === "membrane") {
        body(`<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(rad)}" fill="#e6dfcf" stroke="#c89b63" stroke-width="${r(base * 0.33)}"/>`);
        parts.push(`<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(rad - base * 0.33)}" fill="none" stroke="#b8ad95" stroke-width="${r(base * 0.055)}"/>`);
        parts.push(text(cx, cy, size, Math.min(base * 1.25, rad * 0.62), INK.headInk));
      } else {
        const fill = p.material === "wood" ? "url(#g-wood)" : p.material === "steel" ? "#59636e" : "#262b31";
        body(`<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(rad)}" fill="${p.optional ? "none" : fill}" stroke="#8c98a5" stroke-width="${r(base * 0.11)}"${p.optional ? ` stroke-dasharray="${r(base * 0.45)} ${r(base * 0.33)}"` : ""}/>`);
        parts.push(text(cx, cy, p.label ?? p.name.toUpperCase(), Math.min(base * 0.75, rad * 0.4), INK.text, 600));
      }
    }
    out.push(`<g class="piece" data-id="${esc(p.id)}" tabindex="0" role="button" aria-label="${esc(`${p.name}, ${sizeText(p, model.unit)}`)}" cursor="pointer">${parts.join("")}</g>`);
  }
  out.push("</svg>");
  return out.join("\n");
}

// ---------- HTML ----------

// Same shell as the system map in Visualize.ts: one look across every Visualize page.
const CSS = `
:root{
  --ground:#0d1117; --ground-2:#11171f; --panel:#151c26; --panel-2:#1a2330; --line:#263243; --line-2:#334358;
  --fg:#e9eef5; --dim:#a7b4c6; --faint:#6f7f95; --hot:#c8f56a; --hot-ink:#15200a; --medium:#ffc266;
  --display:"Futura","Futura PT","Century Gothic","Avenir Next",system-ui,sans-serif;
  --body:"Charter","Iowan Old Style","Palatino","Georgia",serif;
  --ui:"Avenir Next","Segoe UI",system-ui,sans-serif;
  --mono:"SF Mono","JetBrains Mono","Menlo","Consolas",monospace;
  color-scheme: dark;
}
*{box-sizing:border-box}
html{background:var(--ground)}
body{margin:0;color:var(--fg);font:17px/1.6 var(--body);
  background-image:
    linear-gradient(rgba(120,150,190,0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(120,150,190,0.05) 1px, transparent 1px);
  background-size: 32px 32px; background-color: var(--ground);}
.wrap{max-width:1320px;margin:0 auto;padding:0 32px}
header{text-align:center;padding:72px 0 40px}
h1,h2,h3{text-wrap:balance}
.eyebrow{font:600 12px/1.4 var(--ui);letter-spacing:.32em;text-transform:uppercase;color:var(--hot)}
h1{font:700 clamp(40px,6vw,76px)/1.02 var(--display);letter-spacing:-.01em;margin:18px 0 18px}
.lede{font:italic 400 clamp(19px,2.1vw,24px)/1.45 var(--body);color:var(--dim);max-width:860px;margin:0 auto}
.chips{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-top:28px}
.chip{white-space:nowrap;font:500 12.5px/1 var(--mono);color:var(--dim);border:1px solid var(--line-2);border-radius:999px;padding:8px 13px;background:rgba(21,28,38,.7);font-variant-numeric:tabular-nums}
.chip b{color:var(--fg);font-weight:600}
section{padding:56px 0 8px}
section>h2{font:700 13px/1 var(--ui);letter-spacing:.28em;text-transform:uppercase;color:var(--faint);margin:0 0 22px;display:flex;align-items:center;gap:14px}
section>h2::after{content:"";flex:1;height:1px;background:var(--line)}
.stage{display:grid;grid-template-columns:minmax(0,2.1fr) minmax(280px,1fr);gap:20px;align-items:stretch}
.plot{background:var(--ground-2);border:1px solid var(--line);border-radius:22px;overflow-x:auto}
.plot svg{display:block;width:100%;min-width:600px;height:auto}
.detail{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:26px 28px;display:flex;flex-direction:column;gap:14px}
.detail .eyebrow{letter-spacing:.2em}
.detail h2{font:700 26px/1.15 var(--display);margin:0}
.detail p{margin:0;font-size:16px}
.detail .note{color:var(--dim)}
.dl{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;margin:0;font-size:16px;font-variant-numeric:tabular-nums}
.dl dt{font:600 11.5px/1.9 var(--ui);letter-spacing:.16em;text-transform:uppercase;color:var(--faint)}
.dl dd{margin:0}
.counts{display:grid;grid-template-columns:repeat(auto-fit,minmax(84px,1fr));gap:10px}
.count{background:var(--panel-2);border:1px solid var(--line);border-radius:14px;padding:14px 12px;display:flex;flex-direction:column;gap:8px}
.count b{font:700 34px/1 var(--display);color:var(--fg)}
.count span{font:600 11px/1.3 var(--ui);letter-spacing:.16em;text-transform:uppercase;color:var(--faint)}
.hint{color:var(--faint);font:italic 15px/1.5 var(--body);margin-top:auto!important}
.linkbtn{background:transparent;border:1px solid var(--line-2);border-radius:999px;padding:8px 14px;font:600 13px/1 var(--ui);color:var(--dim);cursor:pointer}
.linkbtn:hover{color:var(--fg);border-color:var(--faint)}
.linkbtn:focus-visible,.piece:focus-visible{outline:2px solid var(--hot);outline-offset:2px}
.swatch{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:8px}
.piece{outline:none}
.piece [data-body]{transition:stroke-width .2s}
.bar{display:flex;height:44px;border-radius:12px;overflow:hidden;border:1px solid var(--line)}
.bar div{display:flex;align-items:center;padding-inline:12px;font:700 13px/1 var(--ui);color:var(--ground);white-space:nowrap;overflow:hidden;font-variant-numeric:tabular-nums}
.legend{display:flex;flex-wrap:wrap;gap:8px 22px;margin-top:14px;font:500 13px/1.4 var(--ui);color:var(--dim);font-variant-numeric:tabular-nums}
.legend>div{white-space:nowrap}.legend b{color:var(--fg);font-weight:600}
.total-note{color:var(--faint);font:italic 15px/1.5 var(--body);margin:12px 0 0}
.parts{display:grid;grid-template-columns:repeat(var(--cols,3),minmax(0,1fr));gap:14px}
.col{display:flex;flex-direction:column;gap:14px}
.group{background:var(--panel);border:1px solid var(--line);border-top:3px solid var(--c);border-radius:14px;padding:20px 22px}
.group h3{font:700 20px/1.2 var(--display);margin:0;display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.group h3 .gc{font:500 12.5px/1 var(--mono);color:var(--faint);white-space:nowrap;font-variant-numeric:tabular-nums}
.group .sub{color:var(--dim);font-size:15px;margin:6px 0 0}
.group ul{list-style:none;margin:12px 0 0;padding:10px 0 0;border-top:1px solid var(--line);display:grid;gap:2px}
.group li{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:12px;padding:5px 8px;border-radius:8px;font:500 15px/1.35 var(--ui);font-variant-numeric:tabular-nums}
.group li span:last-child{font:500 12.5px var(--mono);color:var(--dim);text-align:right;white-space:nowrap}
.group li[data-id]{cursor:pointer}
.group li[data-id]:hover,.group li[data-id]:focus-visible{background:var(--panel-2);outline:none}
.group li.sel{background:rgba(200,245,106,.1);box-shadow:inset 2px 0 0 var(--hot)}
.group li.sel span:first-child{color:var(--hot)}
.opt{color:var(--faint);font-style:italic}
.open{background:linear-gradient(135deg,rgba(255,194,102,.08),rgba(255,194,102,.02));border:1px solid #5c4a24;border-radius:16px;padding:8px 26px;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:0 28px}
.decision{padding:14px 0;border-bottom:1px solid rgba(255,194,102,.14)}
.decision b{display:block;font:700 17px/1.3 var(--ui);color:var(--fg);margin-bottom:4px}
.decision span{font-size:16px;color:var(--dim)}
footer{padding:56px 0 64px;text-align:center;color:var(--faint);font:400 13.5px/1.7 var(--ui);display:grid;gap:4px}
footer code{font:500 12.5px var(--mono);color:var(--fg);background:var(--panel-2);border:1px solid var(--line);border-radius:7px;padding:3px 8px;word-break:break-all}
@media (max-width:900px){
  .wrap{padding:0 16px}
  .stage,.parts{grid-template-columns:1fr}
  header{padding-top:48px}
}
@media (prefers-reduced-motion: reduce){*{transition-duration:0s !important}}
`;

// Highlight state is set as SVG attributes, never CSS on SVG (see SKILL.md gotcha).
const JS = `
const D = JSON.parse(document.getElementById('plan-data').textContent);
const byId = Object.fromEntries(D.pieces.map(p => [p.id, p]));
const svg = document.getElementById('plan');
const detail = document.getElementById('detail');
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function mark(id) {
  svg.querySelectorAll('.piece').forEach(g => {
    const on = g.dataset.id === id;
    g.setAttribute('opacity', id && !on ? '0.42' : '1');
    const b = g.querySelector('[data-body]');
    if (!b.dataset.sw) { b.dataset.sw = b.getAttribute('stroke-width'); b.dataset.st = b.getAttribute('stroke'); }
    b.setAttribute('stroke', on ? '#c8f56a' : b.dataset.st);
    b.setAttribute('stroke-width', on ? String(parseFloat(b.dataset.sw) * 2.4 + 2) : b.dataset.sw);
  });
  document.querySelectorAll('.group li[data-id]').forEach(li => li.classList.toggle('sel', li.dataset.id === id));
}
function summary() {
  mark(null);
  detail.innerHTML = D.summaryHtml;
}
function select(id) {
  const p = byId[id]; if (!p) return;
  mark(id);
  const c = D.cats[p.cat];
  detail.innerHTML = '<div class="eyebrow"><span class="swatch" style="background:' + c.color + '"></span>' + esc(c.name) + '</div>'
    + '<h2>' + esc(p.name) + '</h2><p>' + esc(p.model) + '</p><dl class="dl">'
    + (p.size ? '<dt>' + esc(p.sizeLabel) + '</dt><dd>' + esc(p.size) + '</dd>' : '')
    + (p.price ? '<dt>Price</dt><dd>' + esc(p.price) + '</dd>' : '')
    + '</dl>' + (p.note ? '<p class="note">' + esc(p.note) + '</p>' : '')
    + '<p class="hint"><button class="linkbtn" id="clear" type="button">Show the whole plan</button></p>';
  document.getElementById('clear').addEventListener('click', summary);
}
const act = (el, id) => {
  el.addEventListener('click', () => select(id));
  el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(id); } });
};
svg.querySelectorAll('.piece').forEach(g => act(g, g.dataset.id));
document.querySelectorAll('.group li[data-id]').forEach(li => act(li, li.dataset.id));
summary();
`;

/** Greedy balance of groups into columns by item count. */
export function columns(groups: Group[], n: number): Group[][] {
  const cols: { load: number; gs: Group[] }[] = Array.from({ length: Math.max(1, Math.min(n, groups.length)) }, () => ({ load: 0, gs: [] }));
  const order = groups.map((g, i) => ({ g, i, w: g.items.length + 2 })).sort((a, b) => b.w - a.w);
  for (const o of order) { const c = cols.reduce((m, x) => (x.load < m.load ? x : m)); c.gs.push(o.g); c.load += o.w; }
  for (const c of cols) c.gs.sort((a, b) => groups.indexOf(a) - groups.indexOf(b));
  const first = (c: { gs: Group[] }) => (c.gs.length ? groups.indexOf(c.gs[0]) : Infinity);
  return cols.sort((a, b) => first(a) - first(b)).map((c) => c.gs);
}

export function renderHtml(model: PlanModel, generatedAt: Date): string {
  const cur = model.currency ?? "$";
  const cats = Object.fromEntries(model.categories.map((c, i) => [c.id, { ...c, color: CAT_COLORS[i % CAT_COLORS.length] }]));
  const total = categoryTotal(model);
  const pieceCount = model.pieces.length;

  const sm = model.summary;
  const summaryHtml = `<div class="eyebrow">The whole plan</div><h2>${esc(sm?.heading ?? model.name)}</h2>`
    + (sm?.counts?.length ? `<div class="counts">${sm.counts.map((c) => `<div class="count"><b>${esc(String(c.n))}</b><span>${esc(c.label)}</span></div>`).join("")}</div>` : "")
    + (sm?.facts?.length ? `<dl class="dl">${sm.facts.map((f) => `<dt>${esc(f.k)}</dt><dd>${esc(f.v)}</dd>`).join("")}</dl>` : "")
    + `<p class="hint">Tap a piece in the drawing, or a line in the order below, to see its spec.</p>`;

  const data = {
    summaryHtml,
    cats: Object.fromEntries(Object.entries(cats).map(([k, c]) => [k, { name: c.name, color: c.color }])),
    pieces: model.pieces.map((p) => ({
      id: p.id, cat: p.cat, name: p.name, model: p.model, price: p.price, note: p.note,
      size: sizeText(p, model.unit), sizeLabel: p.dimsLabel ?? (p.shape === "circle" ? "Diameter" : "Width × depth"),
    })),
  };

  const costed = model.categories.filter((c) => (c.cost ?? 0) > 0);
  let costSection = "";
  if (costed.length) {
    const bar = costed.map((c) => {
      const pct = (c.cost! / total) * 100;
      return `<div style="width:${pct.toFixed(3)}%;background:${cats[c.id].color}" title="${esc(`${c.name}: ${money(c.cost!, cur)}`)}">${pct > 12 ? esc(`${c.name} ${money(c.cost!, cur)}`) : ""}</div>`;
    }).join("");
    const legend = costed.map((c) => `<div><span class="swatch" style="background:${cats[c.id].color}"></span>${esc(c.name)} <b>${money(c.cost!, cur)}</b> · ${Math.round((c.cost! / total) * 100)}%</div>`).join("");
    const notes: string[] = [];
    if (model.costNote) notes.push(esc(model.costNote));
    if (model.statedTotal && model.statedTotal.amount !== total) notes.push(`The categories add up to ${money(total, cur)}; the plan's stated total is ${money(model.statedTotal.amount, cur)}.`);
    else notes.push(`Total ${money(total, cur)}.`);
    costSection = `<section><h2>Where the money goes</h2><div class="bar">${bar}</div><div class="legend">${legend}</div><p class="total-note">${notes.join(" ")}</p></section>`;
  }

  const cols = columns(model.groups, 3);
  const parts = cols.map((gs) => `<div class="col">${gs.map((g) => {
    const c = cats[g.cat];
    const items = g.items.map((it) => {
      const opt = it.optional || (it.piece && model.pieces.find((p) => p.id === it.piece)?.optional);
      const attrs = it.piece ? ` data-id="${esc(it.piece)}" tabindex="0"` : "";
      return `<li${attrs}><span${opt ? ' class="opt"' : ""}>${esc(it.name)}</span><span>${esc(it.spec ?? "")}</span></li>`;
    }).join("");
    return `<div class="group" style="--c:${c.color}"><h3><span><span class="swatch" style="background:${c.color}"></span>${esc(g.title ?? c.name)}</span>${c.cost ? `<span class="gc">≈ ${money(c.cost, cur)}</span>` : ""}</h3>${g.note ? `<p class="sub">${esc(g.note)}</p>` : ""}<ul>${items}</ul></div>`;
  }).join("")}</div>`).join("");

  const decisions = model.decisions?.length
    ? `<section><h2>Still undecided</h2><div class="open">${model.decisions.map((d) => `<div class="decision"><b>${esc(d.title)}</b><span>${esc(d.text)}</span></div>`).join("")}</div></section>`
    : "";
  const chips = (model.chips ?? []).map((c) => `<div class="chip"><b>${esc(c.strong)}</b>${c.text ? ` ${esc(c.text)}` : ""}</div>`).join("");
  const p2 = (n: number) => String(n).padStart(2, "0");
  const when = `${generatedAt.getFullYear()}-${p2(generatedAt.getMonth() + 1)}-${p2(generatedAt.getDate())} ${p2(generatedAt.getHours())}:${p2(generatedAt.getMinutes())}`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(model.name)}</title>
<style>${CSS}</style></head>
<body><div class="wrap">
<header>${model.kicker ? `<div class="eyebrow">${esc(model.kicker)}</div>` : ""}<h1>${esc(model.name)}</h1><p class="lede">${esc(model.lede)}</p>${chips ? `<div class="chips">${chips}</div>` : ""}</header>
<div class="stage"><div class="plot">${renderSvg(model)}</div><aside class="detail" id="detail" aria-live="polite">${summaryHtml}</aside></div>
${costSection}
<section><h2>Full order</h2><div class="parts" style="--cols:${cols.length}">${parts}</div></section>
${decisions}
<footer><div>${esc(model.drawing.note)} ${pieceCount} pieces drawn to scale.</div><div>Sources: ${model.sources.map((s) => `<code>${esc(s)}</code>`).join(" · ")}</div><div>Generated ${when} by Visualize.</div></footer>
</div>
<script id="plan-data" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
<script>${JS}</script>
</body></html>
`;
}

// ---------- console ----------

export function renderConsole(model: PlanModel, htmlPath: string | undefined, width = 100, previous: string[] = []): string {
  const W = Math.max(60, width);
  const cur = model.currency ?? "$";
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s);
  const rule = (t: string) => { const s = clip(t, W - 8); return `── ${s} ${"─".repeat(Math.max(3, W - s.length - 4))}`; };
  const out: string[] = [rule(model.name)];
  if (model.kicker) for (const l of wrap(model.kicker, W - 2)) out.push(`  ${l}`);
  for (const l of wrap(model.lede, W - 2)) out.push(`  ${l}`);
  out.push("");
  const total = categoryTotal(model);
  const costed = model.categories.filter((c) => (c.cost ?? 0) > 0);
  // The totals line wraps like every other prose line, so a long stated-total note never overruns W.
  const totals = `${model.pieces.length} pieces in ${model.categories.length} categories${total ? ` · categories total ${money(total, cur)}` : ""}${model.statedTotal && model.statedTotal.amount !== total ? ` (plan states ${money(model.statedTotal.amount, cur)})` : ""}`;
  for (const l of wrap(totals, W - 2)) out.push(`  ${l}`);
  if (costed.length) {
    // Bar row = 2 + name + 2 + bar + 2 + 8 (money) + 1 + 3 + 1 = name + bar + 19; keep the bar at least 10 wide.
    const nameW = Math.min(Math.max(...costed.map((c) => c.name.length)), W - 29);
    const barW = Math.max(10, W - nameW - 24);
    for (const c of costed) {
      const n = Math.max(1, Math.round((c.cost! / total) * barW));
      out.push(`  ${clip(c.name, nameW).padEnd(nameW)}  ${"█".repeat(n).padEnd(barW)}  ${money(c.cost!, cur).padStart(8)} ${String(Math.round((c.cost! / total) * 100)).padStart(3)}%`);
    }
  }
  out.push("", rule("Order"));
  for (const g of model.groups) {
    const c = model.categories.find((x) => x.id === g.cat)!;
    out.push(`  ${clip((g.title ?? c.name).toUpperCase(), W - 2)}`);
    for (const it of g.items) {
      const opt = it.optional || (it.piece && model.pieces.find((p) => p.id === it.piece)?.optional);
      const left = `    ${opt ? "(opt) " : ""}${it.name}`;
      const right = it.spec ?? "";
      const line = right ? `${left}${" ".repeat(Math.max(2, W - left.length - right.length))}${right}` : left;
      out.push(line.length > W ? line.slice(0, W - 1) + "…" : line);
    }
  }
  if (model.decisions?.length) {
    out.push("", rule("Still undecided"));
    for (const d of model.decisions) for (const [i, l] of wrap(`${d.title}: ${d.text}`, W - 6).entries()) out.push(`  ${i ? "  " : "• "}${l}`);
  }
  out.push("", rule("Page"));
  out.push(`  ${htmlPath ?? "(no page written: --no-html)"}`);
  if (previous.length) out.push(`  earlier pages here: ${previous.length} (latest ${previous[0]})`);
  for (const l of wrap(model.drawing.note, W - 2)) out.push(`  ${l}`);
  return out.join("\n");
}

// ---------- CLI ----------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`VisualizePlan — grounded pages for physical plans (setups, layouts, purchase lists)

Usage:
  bun VisualizePlan.ts --model <plan.json> --root <plan dir> [flags]
  bun VisualizePlan.ts --schema

Flags:
  --check          validate the model against the plan files; write nothing
  --no-html        print the console summary only
  --out-dir <dir>  write the page here instead of the root
  --width <n>      console width (default 100)

Exit: 0 rendered · 1 model refused · 2 usage error`);
    return 0;
  }
  if (process.argv.includes("--schema")) {
    console.log(JSON.stringify(EXAMPLE, null, 2));
    console.log(`\nmaterials: ${MATERIALS.join(", ")}\n  wood = shell/board with end bands · brass = cymbal-style metal disc · brass-dark = flanged disc (china) · steel = hardware · membrane = light head with rim · dark = seat or black object\nshapes: circle (dia) · rect (w, d) · every piece, order line, cost and decision cites { file, quote } and the quote must appear in the file`);
    return 0;
  }
  const modelPath = arg("--model");
  const rootArg = arg("--root");
  if (!modelPath || !rootArg) { console.error("usage: bun VisualizePlan.ts --model <plan.json> --root <plan dir> [--out-dir <dir>] [--no-html] [--check]"); return 2; }
  const root = resolve(rootArg);
  if (!existsSync(root) || !statSync(root).isDirectory()) { console.error(`root is not a directory: ${root}`); return 2; }
  let model: PlanModel;
  try { model = JSON.parse(readFileSync(modelPath, "utf8")); }
  catch (e) { console.error(`cannot read model: ${(e as Error).message}`); return 2; }

  const { errors, warnings } = validate(model, root);
  for (const w of warnings) console.error(`warn: ${w}`);
  if (errors.length) {
    console.error(`\nplan refused — ${errors.length} problem${errors.length > 1 ? "s" : ""}:`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    return 1;
  }
  if (process.argv.includes("--check")) { console.error("plan ok"); return 0; }

  const outDir = resolve(arg("--out-dir") ?? root);
  const now = new Date();
  const prefix = `Visualize-${slugify(model.name)}-`;
  const previous = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.startsWith(prefix) && f.endsWith(".html")).sort().reverse() : [];
  let outPath: string | undefined;
  if (!process.argv.includes("--no-html")) {
    outPath = outputPath(outDir, model.name, now);
    writeHtml(renderHtml(model, now), outPath, outDir);
  }
  console.log(renderConsole(model, outPath, Number(arg("--width") ?? 100), previous));
  return 0;
}

if (import.meta.main) process.exit(main());
