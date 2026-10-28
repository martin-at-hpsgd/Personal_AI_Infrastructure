#!/usr/bin/env bun
/**
 * TextFit.ts — a deterministic gate that fails a HyperFrames composition when on-screen text is
 * cut off at rest: past the frame edge, clipped by a mask, truncated, or partly covered.
 *
 * Usage:
 *   bun TextFit.ts --project <dir> [--times 1.2,3.4 | --hits hits.md | --every 0.5] [--settle 0.5] [--json]
 *
 *   --times    seconds to check (comma list)
 *   --hits     a hits.md table; its `s (sec)` column gives the times
 *   --every    check every N seconds over the root's data-duration
 *   --settle   added to every time so reveal animations have finished (default 0.5)
 *   --json     one JSON object instead of the report
 *
 * Exit codes: 0 no finding, 1 at least one finding, 2 usage error, 3 the composition could not be measured.
 *
 * How it works: the composition opens in the seam's pinned headless Chrome (sandboxed, no network),
 * waits for window.__timelines[<root id>] (which registerAfterFonts delays until every embedded face
 * has loaded), then seeks the paused timeline to each time and measures every visible text node.
 * Glyph boxes are the ink boxes (canvas TextMetrics for the node's computed font, scaled to the
 * Range rect), so a tight line-height mask does not read as clipping. A finding is kept only when
 * the text is at rest: at t−0.1 s or t+0.1 s its ink box (within 4 px), opacity (0.05), every clip region
 * from every clipping ancestor (overflow and clip-path, within 4 px) and the element covering it (same element,
 * same rect within 4 px, same covered share within 0.05) all match t. A clip-path reveal or a sliding panel
 * that is still changing is motion, not a finding. A clipped finding has its own, looser rest test: at t−0.1 s or
 * t+0.1 s the ink runs past each clip by the same px per side (within 4 px), so a mask that moves with its text
 * and keeps slicing the same cap tops is reported even while both move.
 *
 * Opt-outs, for effects that are meant to look like this:
 *   data-textfit="ignore"   on a text element or any ancestor: that text is not measured at all
 *                           (split-flap halves, a deliberate crop, a decorative overflow)
 *   data-textfit="cover-ok" on a covering element (or inside one): it may overlap text, so it never
 *                           counts as covering (a highlighter, a scanline, a ring). A strike-through bar is
 *                           data-mark="strike" instead: Proof's mark-strikes measures it on its word's cap middle.
 *                           The opt-out must say why: data-annotates-text="<text it marks>" (resolved by Proof OCR, works on raster plates),
 *                           data-annotates="<selector of what it marks>", data-mark="<kind>",
 *                           or a non-empty data-textfit-reason="...". A bare cover-ok is itself a finding of
 *                           kind "optout" (a highlight ring that silently sits on the wrong text passed the gate
 *                           that way), examined once over every cover-ok in the root. A cover-ok that overlaps text
 *                           ink at a checked time with only a reason is also an "optout" finding, once per element:
 *                           what sits on text must name its target (strike bars with a reason sat low and
 *                           nothing measured them). data-textfit="ignore" still needs no reason.
 *
 * Checks, per visible text fragment (computed opacity ≥ 0.5 up the chain, visibility visible, not display none):
 *   frame     ink box past the frame, or within 5% of an edge (title-safe: 54 px top/bottom, 96 px sides at 1080p;
 *             a title 45 px from the top reads as cut off)
 *   clipped   ink cut by more than 2 px on any side by an overflow-clipping, clip-path or mask-image ancestor; the detail names
 *             the px cut per side (text hidden entirely inside a mask is not visible, so not a finding)
 *   optout    a data-textfit="cover-ok" element with neither data-annotates nor data-textfit-reason (reported at the first checked time),
 *             or one overlapping text ink with a reason but no data-annotates(-text) or data-mark (reported at the first time it overlaps)
 *   truncated ellipsis truncation, or its clipping parent's scrollWidth > clientWidth with the ink past the box
 *   covered   part of the ink sits under a painted element stacked above it (elementsFromPoint sampling)
 *   occluded  pixel test, drawing-agnostic: every glyph is hidden (color transparent), the text's shown ink box is captured, and
 *             pixels off the box's median colour by more than OCC_TOL (despeckled, so film grain does not add up) are foreign ink;
 *             ≥ OCC_MIN_PX px² at rest (same count and centroid at t±0.1 s) is a finding naming the top element there
 *             (canvas/unknown for canvas). Text crossed by another block's text is re-captured with only its own block hidden.
 *             Exempt for a text: data-mark="strike" on it, data-annotates(-text) naming it, an untargeted cover-ok (optout polices it).
 *             A mark holding no text owns only the pixels it paints: a second capture hides every such mark, and the pixels that
 *             change inside the mark's whole-pixel box (anti-aliased edges included, a rotated bar's empty corners not) are exempt.
 *             A text already reported covered keeps that kind instead.
 *   canvas-text  readable fillText/strokeText (≥ 2 letters, alpha ≥ 0.5) on a document canvas with no matching box in
 *             window.__hfCanvasText = [{text, l, t, r, b}] (composition px); once per string, with every time it was seen
 *   connector an element with data-joins="#a #b" (SVG line/path/polyline, or a DOM bar along its long axis), or a window.__hfConnectors
 *             entry {id, from:[x,y], to:[x,y], joins}, whose ends land more than JOIN_TOL px from their targets (outline or centre), at rest
 *   align     data-align="center" (frame), "center:#id", "left:#id", "baseline:#id" off by more than ALIGN_TOL px at rest
 *             (text elements are measured by their ink box and first baseline)
 * The new checks seek with callbacks on (tl.seek(t, false)) so a canvas painted in onUpdate is current.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureInstalled, readRoot } from "../../../LIFEOS/TOOLS/HyperFrames/HyperFrames.ts";
import { Cdp, devtoolsUrl } from "../../../LIFEOS/TOOLS/HyperFrames/probe.ts";
import { descendantPids, sandboxed } from "../../../LIFEOS/TOOLS/HyperFrames/run.ts";

export type FitKind = "frame" | "clipped" | "truncated" | "covered" | "optout" | "occluded" | "canvas-text" | "connector" | "align";

export interface FitFinding {
  /** Seconds the timeline was seeked to (requested time plus settle). */
  time: number;
  /** The text node as rendered (text-transform applied), trimmed to 80 characters. */
  text: string;
  /** Text of the nearest block ancestor, so split-letter words read whole. */
  context: string;
  selector: string;
  kinds: FitKind[];
  /** Largest share of the glyph box that is not seen (0..1); 0 for a margin-only frame finding. */
  lost: number;
  detail: string[];
}

export interface TextFitOptions {
  projectDir: string;
  entry?: string;
  times: readonly number[];
  settle?: number;
  /** Seconds either side of each time used for the at-rest test. */
  restDelta?: number;
  /** Frame safe margin as a fraction of width and height. */
  marginFrac?: number;
  /** How long to wait for the timeline to register. */
  loadBudgetMs?: number;
}

export interface TextFitResult { ok: boolean; project: string; checked: number[]; findings: FitFinding[]; ms: number }

export class TextFitError extends Error {
  constructor(message: string) { super(`[textfit] ${message}`); this.name = "TextFitError"; }
}

const REST_PX = 4;
const REST_OPACITY = 0.05;

/** Times from a hits.md table: the column whose header is `s (sec)` (or the third column when no header matches). */
export function parseHitTimes(markdown: string): number[] {
  const rows = markdown.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"));
  const cells = (row: string): string[] => row.split("|").slice(1, -1).map((c) => c.trim());
  const header = rows.find((r) => !/^\|\s*[-:]+\s*\|/.test(r) && !/^\|\s*\d/.test(r));
  let col = header ? cells(header).findIndex((c) => /^s\b|\(sec\)/i.test(c)) : -1;
  if (col < 0) col = 2;
  const times: number[] = [];
  for (const row of rows) {
    const c = cells(row);
    if (!/^\d+$/.test(c[0] ?? "")) continue;
    const t = Number(c[col]);
    if (Number.isFinite(t) && t >= 0) times.push(t);
  }
  return times;
}

/** Add the settle offset, clamp into the composition, dedupe to the millisecond, sort. */
export function planTimes(times: readonly number[], settle: number, durationSec: number | null): number[] {
  const end = durationSec !== null && durationSec > 0 ? durationSec - 0.001 : Infinity;
  const out = new Set<number>();
  for (const t of times) {
    if (!Number.isFinite(t) || t < 0) throw new TextFitError(`time ${t} is not a non-negative number`);
    out.add(Math.round(Math.min(t + settle, end) * 1000) / 1000);
  }
  return [...out].sort((a, b) => a - b);
}

export function everyTimes(step: number, durationSec: number): number[] {
  // Times are kept to the millisecond, so a step under 0.001 s would round to no advance and never end.
  if (!(step >= 0.001)) throw new TextFitError(`--every must be at least 0.001 s, got ${step}`);
  const out: number[] = [];
  for (let t = 0; t < durationSec; t = Math.round((t + step) * 1000) / 1000) out.push(t);
  return out;
}

/**
 * In-page measurement. Installs window.__tfMeasure(t, margin) and window.__tfInk(t).
 * Kept as a string: it runs inside the composition page, never in Bun.
 */
const PAGE_LIB = String.raw`(() => {
  if (window.__tfMeasure) return true;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const style = document.createElement('style');
  style.textContent = '*{pointer-events:auto !important}';
  document.head.appendChild(style);
  const root = document.querySelector('[data-composition-id]');
  const tl = () => window.__timelines[root.getAttribute('data-composition-id')];

  const alpha = (c) => { if (!c || c === 'transparent' || c === 'none') return 0; const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return 1; const p = m[1].split(/[ ,\/]+/).filter(Boolean); return p.length >= 4 ? parseFloat(p[3]) : 1; };
  const opacityOf = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o; };
  const area = (r) => r ? Math.max(0, r.r - r.l) * Math.max(0, r.b - r.t) : 0;
  const inter = (a, b) => { const r = { l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) }; return r.r > r.l && r.b > r.t ? r : null; };
  const box = (d) => ({ l: d.left, t: d.top, r: d.right, b: d.bottom });
  const px = (n) => Math.round(n);
  const transform = (s, tt) => tt === 'uppercase' ? s.toUpperCase() : tt === 'lowercase' ? s.toLowerCase() : tt === 'capitalize' ? s.replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase()) : s;

  function selectorOf(el) {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.body; e = e.parentElement) {
      if (e.id) { parts.unshift('#' + CSS.escape(e.id)); break; }
      let s = e.tagName.toLowerCase() + [...e.classList].slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
      const p = e.parentElement;
      if (p) { const same = [...p.children].filter((c) => c.tagName === e.tagName); if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(e) + 1) + ')'; }
      parts.unshift(s);
    }
    return parts.join(' > ');
  }

  /** Text of the nearest ancestor holding more than this node, so a split-letter word reads whole. */
  function contextOf(node) {
    const own = node.data.replace(/\s+/g, ' ').trim();
    for (let e = node.parentElement; e && e !== root; e = e.parentElement) {
      const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > own.length) return transform(t, getComputedStyle(e).textTransform).slice(0, 80);
    }
    return '';
  }

  /** Line fragments of a text node: consecutive non-space characters on one line, with their union rect. */
  function fragments(node) {
    const text = node.data, out = [], range = document.createRange();
    let cur = null;
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) { if (cur) cur.gap = true; continue; }
      range.setStart(node, i); range.setEnd(node, i + 1);
      const rs = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      if (!rs.length) continue;
      const r = rs[rs.length - 1];
      const sameLine = cur && Math.abs(r.top - cur.top) < r.height * 0.5 && r.left >= cur.rect.l - 1;
      if (!sameLine) { cur = { top: r.top, text: '', rect: box(r), gap: false }; out.push(cur); }
      else if (cur.gap) { cur.text += ' '; cur.gap = false; }
      cur.text += text[i];
      cur.rect = { l: Math.min(cur.rect.l, r.left), t: Math.min(cur.rect.t, r.top), r: Math.max(cur.rect.r, r.right), b: Math.max(cur.rect.b, r.bottom) };
    }
    return out;
  }

  /** Ink box of a fragment: canvas glyph metrics for the computed font, scaled onto the Range rect. */
  function inkOf(frag, cs) {
    ctx.font = cs.font || (cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily);
    ctx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
    const s = transform(frag.text, cs.textTransform);
    const m = ctx.measureText(s);
    const content = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
    const r = frag.rect;
    if (!(content > 0) || !(m.width > 0)) return r;
    const sy = (r.b - r.t) / content;
    const sx = (r.r - r.l) / m.width;
    const stroke = (parseFloat(cs.webkitTextStrokeWidth) || 0) / 2;
    return {
      l: r.l - (m.actualBoundingBoxLeft + stroke) * sx,
      r: r.l + (m.actualBoundingBoxRight + stroke) * sx,
      t: r.t + (m.fontBoundingBoxAscent - m.actualBoundingBoxAscent - stroke) * sy,
      b: r.t + (m.fontBoundingBoxAscent + m.actualBoundingBoxDescent + stroke) * sy,
    };
  }

  /** Clip rects from overflow, clip-path and mask-image ancestors, stopping below the composition root (the frame check owns the root). */
  function clipsOf(el) {
    const out = [];
    for (let e = el; e && e !== root && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      const b = e.getBoundingClientRect();
      const clipX = cs.overflowX !== 'visible', clipY = cs.overflowY !== 'visible';
      if (clipX || clipY) {
        const sx = e.offsetWidth ? b.width / e.offsetWidth : 1, sy = e.offsetHeight ? b.height / e.offsetHeight : 1;
        const bl = parseFloat(cs.borderLeftWidth) * sx, br = parseFloat(cs.borderRightWidth) * sx, bt = parseFloat(cs.borderTopWidth) * sy, bb = parseFloat(cs.borderBottomWidth) * sy;
        out.push({ el: e, why: 'overflow:' + (clipX ? cs.overflowX : cs.overflowY), rect: { l: clipX ? b.left + bl : -1e9, r: clipX ? b.right - br : 1e9, t: clipY ? b.top + bt : -1e9, b: clipY ? b.bottom - bb : 1e9 } });
      }
      if (cs.clipPath && cs.clipPath !== 'none') {
        const rect = clipPathRect(cs.clipPath, e, b);
        if (rect) out.push({ el: e, why: 'clip-path', rect });
      }
      // A mask image paints nothing outside the element's border box (mask-clip border-box), so that box clips.
      const mask = cs.maskImage || cs.webkitMaskImage;
      if (mask && mask !== 'none') out.push({ el: e, why: 'mask-image', rect: box(b) });
    }
    return out;
  }

  /** Bounding rect of a clip-path in client space. inset() and polygon() are exact before rotation; other shapes use the border box. */
  function clipPathRect(cp, e, b) {
    const w = e.offsetWidth || b.width, h = e.offsetHeight || b.height;
    const sx = w ? b.width / w : 1, sy = h ? b.height / h : 1;
    const len = (v, basis) => v.endsWith('%') ? parseFloat(v) / 100 * basis : parseFloat(v) || 0;
    let m = /inset\(([^)]*)\)/.exec(cp);
    if (m) {
      const v = m[1].split(/\s+round\s+/)[0].trim().split(/\s+/);
      const [t, r, bo, l] = [v[0], v[1] ?? v[0], v[2] ?? v[0], v[3] ?? v[1] ?? v[0]];
      return { t: b.top + len(t, h) * sy, r: b.right - len(r, w) * sx, b: b.bottom - len(bo, h) * sy, l: b.left + len(l, w) * sx };
    }
    m = /polygon\(([^)]*)\)/.exec(cp);
    if (m) {
      const pts = m[1].replace(/^\s*(nonzero|evenodd)\s*,/, '').split(',').map((p) => p.trim().split(/\s+/));
      const xs = pts.map((p) => b.left + len(p[0], w) * sx), ys = pts.map((p) => b.top + len(p[1] ?? '0', h) * sy);
      return { l: Math.min(...xs), r: Math.max(...xs), t: Math.min(...ys), b: Math.max(...ys) };
    }
    return box(b);
  }

  function paintsAt(el, x, y) {
    if (opacityOf(el) < 0.2) return false;
    const cs = getComputedStyle(el);
    if (el instanceof SVGElement) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'svg' || tag === 'g') return false;
      return (alpha(cs.fill) > 0.2 && parseFloat(cs.fillOpacity) > 0.2) || (alpha(cs.stroke) > 0.2 && parseFloat(cs.strokeWidth) > 0);
    }
    if (/^(IMG|CANVAS|VIDEO|IFRAME|OBJECT|EMBED)$/.test(el.tagName)) return true;
    if (alpha(cs.backgroundColor) > 0.2 || cs.backgroundImage !== 'none') return true;
    for (const c of el.childNodes) {
      if (c.nodeType !== 3 || !c.data.trim()) continue;
      const r = document.createRange(); r.selectNodeContents(c);
      for (const q of r.getClientRects()) if (x >= q.left && x <= q.right && y >= q.top && y <= q.bottom) return true;
    }
    return false;
  }

  /**
   * Share of ink columns hidden under a painted element stacked above the text's parent, and the element seen most.
   * A column counts when at least two of its three sample rows are covered, so a thin strike-through line
   * (one row) is decoration, while a panel over the last letters (every row) is a cut.
   */
  function coverOf(node, parent, ink) {
    const pb = [...parent.getClientRects()].map(box).reduce((a, r) => a ? { l: Math.min(a.l, r.l), t: Math.min(a.t, r.t), r: Math.max(a.r, r.r), b: Math.max(a.b, r.b) } : r, null);
    const band = pb && inter(ink, pb);
    if (!band) return null;
    const cols = Math.max(3, Math.min(16, Math.round((band.r - band.l) / Math.max(4, (band.b - band.t) / 2))));
    let known = 0, covered = 0;
    const by = new Map();
    for (let i = 0; i < cols; i++) {
      let rows = 0, hits = 0;
      for (const fy of [0.3, 0.5, 0.7]) {
        const x = band.l + (band.r - band.l) * ((i + 0.5) / cols), y = band.t + (band.b - band.t) * fy;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const stack = document.elementsFromPoint(x, y);
        const at = stack.indexOf(parent);
        if (at < 0) continue;
        rows++;
        const top = stack.slice(0, at).find((el) => !el.contains(node) && !el.closest('[data-textfit="cover-ok"]') && paintsAt(el, x, y));
        if (top) { hits++; by.set(top, (by.get(top) || 0) + 1); }
      }
      if (rows < 2) continue;
      known++;
      if (hits >= 2) covered++;
    }
    if (!known) return null;
    const who = [...by.entries()].sort((a, b) => b[1] - a[1])[0];
    return { frac: covered / known, by: who ? selectorOf(who[0]) : '', rect: who ? box(who[0].getBoundingClientRect()) : null };
  }

  function textNodes() {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.data.trim() && n.parentElement && !/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(n.parentElement.tagName) ? 1 : 3 });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
    return out;
  }

  function visible(el) {
    if (!el.checkVisibility({ visibilityProperty: true })) return false;
    return opacityOf(el) >= 0.5;
  }

  /** Ink cut by more than this many px on a side is a clipped finding (2026-10-10: was 3% of the ink height, which let 12 px slices through on big caps). */
  const CLIP_TOL = 2;
  /** How far the ink runs past a clip rect on each side, 0 where it does not. */
  const cutOf = (ink, c) => ({ l: Math.max(0, c.l - ink.l), r: Math.max(0, ink.r - c.r), t: Math.max(0, c.t - ink.t), b: Math.max(0, ink.b - c.b) });

  function measureNode(node, frame, margin) {
    const el = node.parentElement;
    const cs = getComputedStyle(el);
    const clips = clipsOf(el);
    const kinds = new Set(), detail = [], lostBy = {};
    let seen = false;
    for (const frag of fragments(node)) {
      const ink = inkOf(frag, cs);
      const inkArea = area(ink);
      if (!inkArea) continue;
      const inFrame = inter(ink, frame);
      if (!inFrame) continue;
      let shown = inFrame;
      for (const c of clips) { shown = shown && inter(shown, c.rect); }
      if (!shown) continue;
      seen = true;
      const word = transform(frag.text, cs.textTransform);
      const outFrac = 1 - area(inFrame) / inkArea;
      const safe = { l: frame.l + margin * (frame.r - frame.l), r: frame.r - margin * (frame.r - frame.l), t: frame.t + margin * (frame.b - frame.t), b: frame.b - margin * (frame.b - frame.t) };
      const edges = [];
      if (ink.l < safe.l) edges.push(ink.l < frame.l ? px(frame.l - ink.l) + 'px past left' : px(ink.l - frame.l) + 'px from left');
      if (ink.r > safe.r) edges.push(ink.r > frame.r ? px(ink.r - frame.r) + 'px past right' : px(frame.r - ink.r) + 'px from right');
      if (ink.t < safe.t) edges.push(ink.t < frame.t ? px(frame.t - ink.t) + 'px past top' : px(ink.t - frame.t) + 'px from top');
      if (ink.b > safe.b) edges.push(ink.b > frame.b ? px(ink.b - frame.b) + 'px past bottom' : px(frame.b - ink.b) + 'px from bottom');
      if (edges.length) { kinds.add('frame'); detail.push({ kind: 'frame', text: '"' + word + '" ' + edges.join(', ') + ' of the frame' }); lostBy.frame = Math.max(lostBy.frame || 0, outFrac); }
      for (const c of clips) {
        const k = cutOf(ink, c.rect);
        const cut = [];
        if (k.l > CLIP_TOL) cut.push(px(k.l) + 'px left');
        if (k.r > CLIP_TOL) cut.push(px(k.r) + 'px right');
        if (k.t > CLIP_TOL) cut.push(px(k.t) + 'px top');
        if (k.b > CLIP_TOL) cut.push(px(k.b) + 'px bottom');
        if (!cut.length) continue;
        kinds.add('clipped');
        const vis = inter(ink, c.rect);
        lostBy.clipped = Math.max(lostBy.clipped || 0, 1 - area(vis) / inkArea);
        detail.push({ kind: 'clipped', text: '"' + word + '" cut ' + cut.join(', ') + ' by ' + c.why + ' on ' + selectorOf(c.el) });
      }
      const cover = coverOf(node, el, shown);
      if (cover && cover.frac > 0 && cover.frac < 1) {
        kinds.add('covered');
        lostBy.covered = Math.max(lostBy.covered || 0, cover.frac);
        detail.push({ kind: 'covered', text: '"' + word + '" ' + Math.round(cover.frac * 100) + '% covered by ' + cover.by });
      }
    }
    if (!seen) return null;
    if (cs.textOverflow === 'ellipsis' && cs.overflowX !== 'visible' && el.scrollWidth > el.clientWidth) {
      kinds.add('truncated'); detail.push({ kind: 'truncated', text: 'ellipsis truncation: scrollWidth ' + el.scrollWidth + ' > clientWidth ' + el.clientWidth });
    } else if (cs.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1 && kinds.has('clipped')) {
      kinds.add('truncated'); detail.push({ kind: 'truncated', text: 'scrollWidth ' + el.scrollWidth + ' > clientWidth ' + el.clientWidth });
    }
    return { kinds: [...kinds], lostBy, detail };
  }

  /**
   * The node's ink box, the part of it its clips let through, and its opacity, for the at-rest comparison.
   * The shown box, every clip rect and the covering element matter: a clip-path, mask or panel that is still
   * animating over still text is motion. cuts (how far the ink runs past each clip, per side) decide clipped on their own:
   * a mask that slides with its text but keeps slicing the same caps is not motion.
   */
  function stateOf(node) {
    const el = node.parentElement;
    if (!el || !el.isConnected || !el.checkVisibility({ visibilityProperty: true })) return null;
    const cs = getComputedStyle(el);
    const clips = clipsOf(el);
    const union = (a, k) => a ? { l: Math.min(a.l, k.l), t: Math.min(a.t, k.t), r: Math.max(a.r, k.r), b: Math.max(a.b, k.b) } : k;
    let u = null, shown = null, cover = null;
    for (const f of fragments(node)) {
      const k = inkOf(f, cs);
      u = union(u, k);
      let v = k;
      for (const c of clips) v = v && inter(v, c.rect);
      if (v) {
        shown = union(shown, v);
        const cv = coverOf(node, el, v);
        if (cv && (!cover || cv.frac > cover.frac)) cover = cv;
      }
    }
    return u && { box: u, shown: shown || { l: 0, t: 0, r: 0, b: 0 }, opacity: opacityOf(el), clips: clips.map((c) => c.rect), cuts: clips.map((c) => cutOf(u, c.rect)), cover };
  }

  window.__tfMeasure = (t, margin) => {
    tl().seek(t);
    const frame = box(root.getBoundingClientRect());
    window.__tfNodes = [];
    const out = [];
    for (const node of textNodes()) {
      if (!visible(node.parentElement) || node.parentElement.closest('[data-textfit="ignore"]')) continue;
      const r = measureNode(node, frame, margin);
      if (!r || !r.kinds.length) continue;
      const i = window.__tfNodes.push(node) - 1;
      out.push({ i, text: transform(node.data.replace(/\s+/g, ' ').trim(), getComputedStyle(node.parentElement).textTransform).slice(0, 80), context: contextOf(node), selector: selectorOf(node.parentElement), state: stateOf(node), ...r });
    }
    return out;
  };

  // A cover-ok opt-out must say what it annotates or why it may overlap; a bare one is a finding.
  window.__tfOptOuts = () => [...root.querySelectorAll('[data-textfit="cover-ok"]')]
    .filter((el) => !(el.getAttribute('data-annotates') || '').trim() && !(el.getAttribute('data-annotates-text') || '').trim() && !(el.getAttribute('data-mark') || '').trim() && !(el.getAttribute('data-textfit-reason') || '').trim())
    .map((el) => ({ selector: selectorOf(el), text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) }));

  // A cover-ok that sits on text ink must name what it marks (data-annotates, data-annotates-text or data-mark); a reason
  // alone lets a strike or ring rest on the wrong place unmeasured. Text inside the cover-ok element itself is not counted.
  window.__tfCoverTargets = (t) => {
    tl().seek(t);
    const named = (el) => ['data-annotates', 'data-annotates-text', 'data-mark'].some((a) => (el.getAttribute(a) || '').trim());
    const els = [...root.querySelectorAll('[data-textfit="cover-ok"]')].filter((el) => !named(el) && (el.getAttribute('data-textfit-reason') || '').trim() && opacityOf(el) >= 0.05);
    const out = [];
    for (const el of els) {
      const r = box(el.getBoundingClientRect());
      if (r.r - r.l <= 0 || r.b - r.t <= 0) continue;
      for (const node of textNodes()) {
        if (el.contains(node) || !visible(node.parentElement)) continue;
        const cs = getComputedStyle(node.parentElement);
        const frag = fragments(node).find((fr) => inter(inkOf(fr, cs), r));
        if (frag) { out.push({ selector: selectorOf(el), text: transform(frag.text, cs.textTransform).slice(0, 80) }); break; }
      }
    }
    return out;
  };

  window.__tfStates = (t) => { tl().seek(t); return window.__tfNodes.map(stateOf); };

  // ── occluded: hide text glyphs, capture, look for foreign ink inside each text's shown ink box ──
  const hideStyle = document.createElement('style');
  hideStyle.textContent = '.__tfg{color:transparent!important;-webkit-text-fill-color:transparent!important;-webkit-text-stroke-color:transparent!important;text-shadow:none!important;text-decoration-color:transparent!important}.__tfb{background-image:none!important}.__tfm{opacity:0!important}';
  document.head.appendChild(hideStyle);
  /** Seek with callbacks on: a composition that paints a canvas in onUpdate only repaints when events fire (tl.seek suppresses them by default). */
  const seekDrawn = (t) => tl().seek(t, false);
  const isInline = (d) => d.startsWith('inline') || d === 'contents';
  const blockOf = (el) => { let e = el; while (e && e !== root && isInline(getComputedStyle(e).display)) e = e.parentElement; return e || root; };
  const unionBox = (a, k) => a ? { l: Math.min(a.l, k.l), t: Math.min(a.t, k.t), r: Math.max(a.r, k.r), b: Math.max(a.b, k.b) } : k;
  const allVisibleText = () => textNodes().filter((n) => visible(n.parentElement));
  const inkUnion = (node) => { const cs = getComputedStyle(node.parentElement); let u = null; for (const f of fragments(node)) u = unionBox(u, inkOf(f, cs)); return u; };
  function shownBox(node, frame) {
    const cs = getComputedStyle(node.parentElement), clips = clipsOf(node.parentElement);
    let u = null;
    for (const f of fragments(node)) { let v = inter(inkOf(f, cs), frame); for (const c of clips) v = v && inter(v, c.rect); if (v) u = unionBox(u, v); }
    return u && { l: Math.ceil(u.l) + 1, t: Math.ceil(u.t) + 1, r: Math.floor(u.r) - 1, b: Math.floor(u.b) - 1 };
  }
  const safeAll = (sel) => { try { return [...root.querySelectorAll(sel)]; } catch { return null; } };
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  /** Elements allowed to paint over this text: a cover-ok without a named target (policed by optout), and declared annotations of this text. */
  function exemptEls(node) {
    const out = [];
    const own = norm(node.data);
    for (const el of root.querySelectorAll('[data-textfit="cover-ok"], [data-mark], [data-annotates], [data-annotates-text]')) {
      if (el.contains(node)) continue;
      const ann = (el.getAttribute('data-annotates') || '').trim(), annText = norm(el.getAttribute('data-annotates-text'));
      let ok = false;
      if (ann) ok = (safeAll(ann) || []).some((t) => t.contains(node));
      else if (annText) ok = own.includes(annText) || annText.includes(own);
      else if (el.getAttribute('data-mark') === 'strike') ok = !!el.parentElement && el.parentElement.contains(node);
      else ok = el.getAttribute('data-textfit') === 'cover-ok';
      if (ok) out.push(el);
    }
    return out;
  }
  /** A mark that holds no text is pure ink: it is hidden for a second capture, so only the pixels it actually paints are exempt. */
  const inkOnly = (el) => !(el.textContent || '').trim();
  /** Client rect rounded out to whole pixels: an anti-aliased edge pixel the element only partly covers still belongs to it. */
  const outBox = (el) => { const r = el.getBoundingClientRect(); return { l: Math.floor(r.left), t: Math.floor(r.top), r: Math.ceil(r.right), b: Math.ceil(r.bottom) }; };
  const hideGlyphs = (nodes) => { for (const n of nodes) { const el = n.parentElement; el.classList.add('__tfg'); const cs = getComputedStyle(el); if ((cs.backgroundClip || '').includes('text') || (cs.webkitBackgroundClip || '').includes('text')) el.classList.add('__tfb'); } };
  window.__tfOccClear = () => { for (const el of document.querySelectorAll('.__tfg, .__tfb, .__tfm')) el.classList.remove('__tfg', '__tfb', '__tfm'); return true; };
  window.__tfOccMarkEls = [];
  /** Hide the ink-only marks some planned text is exempt for: true hides all, an index list hides those, false shows all again. */
  window.__tfOccMarks = (which) => { window.__tfOccMarkEls.forEach((el, k) => el.classList.toggle('__tfm', which === true || (Array.isArray(which) && which.includes(k)))); return true; };

  /** Seek, pick the text to test (all visible measured text, or the given indices of the last plan), hide every visible glyph. */
  window.__tfOccPlan = (t, only) => {
    window.__tfOccClear();
    seekDrawn(t);
    const frame = box(root.getBoundingClientRect());
    if (!only) window.__tfOccNodes = allVisibleText().filter((n) => !n.parentElement.closest('[data-textfit="ignore"]'));
    const nodes = window.__tfOccNodes;
    const shown = allVisibleText();
    const inks = shown.map((n) => ({ n, ink: inkUnion(n), block: blockOf(n.parentElement) }));
    const cands = [], owns = [], marks = new Set();
    let clip = null;
    nodes.forEach((node, i) => {
      if (only && !only.includes(i)) return;
      if (!node.isConnected || !visible(node.parentElement) || node.parentElement.closest('[data-textfit="ignore"]')) return;
      const b = shownBox(node, frame);
      if (!b || b.r - b.l < 2 || b.b - b.t < 2) return;
      const blk = blockOf(node.parentElement);
      const solo = inks.some((o) => o.n !== node && o.block !== blk && o.ink && inter(o.ink, b));
      const own = exemptEls(node);
      for (const el of own) if (inkOnly(el)) marks.add(el);
      owns.push(own);
      cands.push({ i, text: transform(node.data.replace(/\s+/g, ' ').trim(), getComputedStyle(node.parentElement).textTransform).slice(0, 80), context: contextOf(node), selector: selectorOf(node.parentElement), box: b, exempt: own.map((el) => ({ ...outBox(el), ink: inkOnly(el) })), others: [], marks: [], solo });
      clip = unionBox(clip, b);
    });
    // The second capture hides every mark at once; where another text's mark overlaps this one's, its own marks are re-captured alone.
    window.__tfOccMarkEls = [...marks];
    cands.forEach((c, k) => window.__tfOccMarkEls.forEach((el, m) => { if (owns[k].includes(el)) c.marks.push(m); else { const r = outBox(el); if (inter(r, c.box)) c.others.push(r); } }));
    hideGlyphs(shown);
    return { cands, clip, marks: marks.size };
  };

  /** Show every glyph except those in node i's own block, so other text over it counts as foreign ink. */
  window.__tfOccSolo = (i) => {
    window.__tfOccClear();
    const node = window.__tfOccNodes[i], blk = blockOf(node.parentElement);
    hideGlyphs(allVisibleText().filter((n) => n === node || blockOf(n.parentElement) === blk));
    return true;
  };

  const pixelsOf = async (b64) => {
    const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
    const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
    const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0);
    return { W: bmp.width, H: bmp.height, d: g.getImageData(0, 0, bmp.width, bmp.height).data };
  };
  /**
   * Score a PNG capture of clip: per item, pixels inside its box that differ from the box's median colour and are not its own.
   * Its own: inside a text-bearing exempt element's box, or painted by one of its ink-only marks, which is where the capture
   * with marks hidden (b64Bare) differs, inside that mark's box and outside every other text's hidden mark. A pixel in both sets
   * conflict, and the caller re-captures that text with only its own marks hidden (others then empty).
   */
  window.__tfOccScore = async (b64, b64Bare, clip, items, tol, minRun) => {
    const { W, H, d } = await pixelsOf(b64);
    const bare = b64Bare ? await pixelsOf(b64Bare) : null;
    if (bare && (bare.W !== W || bare.H !== H)) throw new Error('occlusion captures differ in size: ' + W + 'x' + H + ' vs ' + bare.W + 'x' + bare.H);
    const hitsPx = (r, X, Y) => X + 1 > r.l && X < r.r && Y + 1 > r.t && Y < r.b;
    return items.map((it) => {
      const x0 = Math.max(0, it.box.l - clip.l), y0 = Math.max(0, it.box.t - clip.t), x1 = Math.min(W, it.box.r - clip.l), y1 = Math.min(H, it.box.b - clip.t);
      if (x1 - x0 < 2 || y1 - y0 < 2) return { i: it.i, foreign: 0, cx: 0, cy: 0, pts: [], conflict: false };
      const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * W + x) * 4; hist[0][d[o]]++; hist[1][d[o + 1]]++; hist[2][d[o + 2]]++; n++; }
      const med = hist.map((h) => { let c = 0; for (let v = 0; v < 256; v++) { c += h[v]; if (c * 2 >= n) return v; } return 0; });
      const bw = x1 - x0, bh = y1 - y0, mask = new Uint8Array(bw * bh);
      // A foreign-looking pixel inside both its own mark and another text's hidden mark cannot be attributed from the shared capture.
      let conflict = false;
      const exempt = (x, y) => {
        const X = x + clip.l, Y = y + clip.t;
        let markPx = null;
        for (const r of it.exempt) {
          if (!hitsPx(r, X, Y)) continue;
          if (!r.ink) return true;
          if (markPx === null) {
            if (!bare) markPx = false;
            else if (it.others.some((q) => hitsPx(q, X, Y))) { markPx = false; conflict = true; }
            else { const o = (y * W + x) * 4; markPx = Math.max(Math.abs(d[o] - bare.d[o]), Math.abs(d[o + 1] - bare.d[o + 1]), Math.abs(d[o + 2] - bare.d[o + 2])) > tol / 2; }
          }
          if (markPx) return true;
        }
        return false;
      };
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const o = (y * W + x) * 4;
        if (Math.max(Math.abs(d[o] - med[0]), Math.abs(d[o + 1] - med[1]), Math.abs(d[o + 2] - med[2])) > tol && !exempt(x, y)) mask[(y - y0) * bw + (x - x0)] = 1;
      }
      // Despeckle: a foreign pixel counts only with at least minRun foreign 4-neighbours, so scattered film grain does not add up.
      let foreign = 0, sx = 0, sy = 0;
      const kept = [];
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        if (!mask[y * bw + x]) continue;
        const nb = (x > 0 && mask[y * bw + x - 1]) + (x < bw - 1 && mask[y * bw + x + 1]) + (y > 0 && mask[(y - 1) * bw + x]) + (y < bh - 1 && mask[(y + 1) * bw + x]);
        if (nb >= minRun) { foreign++; sx += x; sy += y; kept.push(x, y); }
      }
      if (!foreign) return { i: it.i, foreign: 0, cx: 0, cy: 0, pts: [], conflict };
      const mx = sx / foreign, my = sy / foreign;
      // The centroid of a ring is its empty middle, so the element lookup uses the foreign pixel nearest the centroid.
      let best = 0, bd = Infinity;
      for (let k = 0; k < kept.length; k += 2) { const dd = (kept[k] - mx) ** 2 + (kept[k + 1] - my) ** 2; if (dd < bd) { bd = dd; best = k; } }
      const at = (k) => [clip.l + x0 + kept[k] + 0.5, clip.t + y0 + kept[k + 1] + 0.5];
      const pts = [at(best)];
      for (let n = 1; n < 8; n++) pts.push(at(2 * Math.floor((kept.length / 2 - 1) * n / 7)));
      return { i: it.i, foreign, cx: clip.l + x0 + mx, cy: clip.t + y0 + my, pts, conflict };
    });
  };

  /** The topmost painting element at a point that is not the text's own element chain; a canvas reads as canvas/unknown. */
  window.__tfOccTop = (i, pts) => {
    window.__tfOccClear();
    const el = window.__tfOccNodes[i].parentElement;
    let hit = null;
    for (const [x, y] of pts) { hit = document.elementsFromPoint(x, y).find((e) => !e.contains(el) && !el.contains(e) && e !== root && paintsAt(e, x, y)); if (hit) break; }
    if (!hit) return 'canvas/unknown';
    return hit.tagName === 'CANVAS' ? 'canvas/unknown (' + selectorOf(hit) + ')' : selectorOf(hit);
  };

  // ── canvas-text: readable fillText/strokeText recorded by the init hook, against published boxes ──
  window.__tfCanvasText = (t) => {
    seekDrawn(t > 0 ? 0 : Math.min(0.001, tl().duration()));
    window.__hfCanvasLog.length = 0;
    seekDrawn(t);
    const frame = box(root.getBoundingClientRect());
    const calls = window.__hfCanvasLog.filter((c) => c.canvas.isConnected && visible(c.canvas) && c.alpha * opacityOf(c.canvas) >= 0.5 && inter(c.box, frame))
      .map((c) => ({ text: c.text, box: c.box, canvas: selectorOf(c.canvas) }));
    const pub = window.__hfCanvasText;
    return { calls, published: pub === undefined ? null : pub, errors: window.__hfCanvasErrors.slice(0, 3), frame };
  };

  // ── connector and align geometry ──
  function endpointsOf(el) {
    let g = el;
    if (!(g instanceof SVGGeometryElement) && g instanceof SVGElement) g = el.querySelector('line, path, polyline, polygon') || el;
    if (g instanceof SVGGeometryElement) {
      const len = g.getTotalLength(), m = g.getScreenCTM();
      if (!m) return null;
      return [g.getPointAtLength(0), g.getPointAtLength(len)].map((p) => { const q = new DOMPoint(p.x, p.y).matrixTransform(m); return { x: q.x, y: q.y }; });
    }
    if (el instanceof SVGElement) return null;
    const along = el.offsetWidth >= el.offsetHeight;
    const probes = (along ? [['0', '50%'], ['100%', '50%']] : [['50%', '0'], ['50%', '100%']]).map(([l, t]) => {
      const p = document.createElement('i'); p.style.cssText = 'position:absolute;width:0;height:0;margin:0;padding:0;border:0;left:' + l + ';top:' + t; el.appendChild(p); return p;
    });
    const pts = probes.map((p) => { const r = p.getBoundingClientRect(); return { x: r.left, y: r.top }; });
    for (const p of probes) p.remove();
    return pts;
  }
  const elBox = (el) => box(el.getBoundingClientRect());
  /** Visual box and baseline: the ink of the element's visible text when it has any, else its border box. */
  function geomOf(el) {
    let ink = null, baseline = null;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.data.trim() ? 1 : 3 });
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!visible(n.parentElement)) continue;
      const cs = getComputedStyle(n.parentElement);
      for (const f of fragments(n)) {
        ink = unionBox(ink, inkOf(f, cs));
        if (baseline === null) { ctx.font = cs.font; const m = ctx.measureText(f.text); const content = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent; baseline = f.rect.t + m.fontBoundingBoxAscent * ((f.rect.b - f.rect.t) / (content || 1)); }
      }
    }
    const b = ink || elBox(el);
    return { box: b, baseline: baseline === null ? b.b : baseline };
  }
  const resolveOne = (sel) => { try { return root.querySelector(sel) || document.querySelector(sel); } catch { return null; } };
  window.__tfLayout = (t) => {
    seekDrawn(t);
    const frame = box(root.getBoundingClientRect());
    const joins = [], aligns = [];
    for (const el of root.querySelectorAll('[data-joins]')) {
      if (!el.checkVisibility({ visibilityProperty: true }) || opacityOf(el) < 0.5) continue;
      const sels = (el.getAttribute('data-joins') || '').trim().split(/\s+/).filter(Boolean);
      const cs = getComputedStyle(el);
      joins.push({ key: selectorOf(el), joins: sels, ends: endpointsOf(el), targets: sels.map((s) => { const tg = resolveOne(s); return tg ? elBox(tg) : null; }), dash: cs.strokeDasharray + '|' + cs.strokeDashoffset });
    }
    const pub = window.__hfConnectors;
    if (pub !== undefined) {
      if (!Array.isArray(pub)) joins.push({ key: 'window.__hfConnectors', joins: [], ends: null, targets: [], dash: '', malformed: true });
      else for (const c of pub) {
        const ok = c && Array.isArray(c.from) && Array.isArray(c.to) && Array.isArray(c.joins) && c.joins.length === 2 && [...c.from, ...c.to].every(Number.isFinite);
        if (!ok) { joins.push({ key: 'window.__hfConnectors[' + String(c && c.id) + ']', joins: [], ends: null, targets: [], dash: '', malformed: true }); continue; }
        joins.push({ key: 'canvas:' + String(c.id), joins: c.joins, ends: [{ x: frame.l + c.from[0], y: frame.t + c.from[1] }, { x: frame.l + c.to[0], y: frame.t + c.to[1] }], targets: c.joins.map((s) => { const tg = resolveOne(s); return tg ? elBox(tg) : null; }), dash: '' });
      }
    }
    for (const el of root.querySelectorAll('[data-align]')) {
      if (!el.checkVisibility({ visibilityProperty: true }) || opacityOf(el) < 0.5) continue;
      const specs = (el.getAttribute('data-align') || '').trim().split(/\s+/).filter(Boolean).map((s) => {
        const [kind, ref] = s.split(/:(.*)/s);
        if (!ref) return { spec: s, kind, ref: null, geom: null, missing: false };
        const tg = resolveOne(ref);
        return { spec: s, kind, ref, geom: tg ? geomOf(tg) : null, missing: !tg };
      });
      aligns.push({ key: selectorOf(el), text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80), geom: geomOf(el), specs });
    }
    return { frame, joins, aligns };
  };
  return true;
})()`;

/**
 * Runs before any page script: records every readable fillText/strokeText on a canvas in the document, with its box
 * in client px, so canvas-drawn words are visible to the gate. A recorder failure is counted, never thrown into the page.
 */
const CANVAS_HOOK = String.raw`(() => {
  window.__hfCanvasLog = []; window.__hfCanvasErrors = [];
  const P = CanvasRenderingContext2D.prototype;
  for (const name of ['fillText', 'strokeText']) {
    const orig = P[name];
    P[name] = function (text, x, y) {
      try {
        const s = String(text), cv = this.canvas;
        if ((s.match(/\p{L}/gu) || []).length >= 2 && cv instanceof HTMLCanvasElement && cv.isConnected && this.globalAlpha > 0) {
          const m = this.measureText(s), tf = this.getTransform(), r = cv.getBoundingClientRect();
          const sx = cv.width ? r.width / cv.width : 1, sy = cv.height ? r.height / cv.height : 1;
          const xs = [], ys = [];
          for (const [px, py] of [[x - m.actualBoundingBoxLeft, y - m.actualBoundingBoxAscent], [x + m.actualBoundingBoxRight, y - m.actualBoundingBoxAscent], [x - m.actualBoundingBoxLeft, y + m.actualBoundingBoxDescent], [x + m.actualBoundingBoxRight, y + m.actualBoundingBoxDescent]]) {
            const q = new DOMPoint(px, py).matrixTransform(tf); xs.push(r.left + q.x * sx); ys.push(r.top + q.y * sy);
          }
          window.__hfCanvasLog.push({ text: s, alpha: this.globalAlpha, canvas: cv, box: { l: Math.min(...xs), t: Math.min(...ys), r: Math.max(...xs), b: Math.max(...ys) } });
        }
      } catch (e) { window.__hfCanvasErrors.push(String((e && e.message) || e)); }
      return orig.apply(this, arguments);
    };
  }
})()`;

interface PageCandidate { i: number; text: string; context: string; selector: string; state: NodeState | null; kinds: FitKind[]; lostBy: Partial<Record<FitKind, number>>; detail: { kind: FitKind; text: string }[] }
interface Box { l: number; t: number; r: number; b: number }
interface CoverState { frac: number; by: string; rect: Box | null }
interface NodeState { box: Box; shown: Box; opacity: number; clips?: Box[]; cuts?: Box[]; cover?: CoverState | null }

const boxDelta = (a: Box, b: Box): number => Math.max(Math.abs(a.l - b.l), Math.abs(a.r - b.r), Math.abs(a.t - b.t), Math.abs(a.b - b.b));

/**
 * At rest: the ink box, the clipped (shown) box and every clip rect each moved at most REST_PX, opacity at most
 * REST_OPACITY, and the covering element is the same, in the same place, covering the same share.
 */
/**
 * Steady cut: the text is visible at both times and, clip for clip, it runs past each clip rect by the same px per side
 * (within REST_PX). Text and mask moving together keep the same cut, so a slice that lasts is not excused as motion,
 * while a reveal whose clip is still opening changes the cut and is.
 */
export function sameCut(a: NodeState | null, b: NodeState | null): boolean {
  if (!a || !b || Math.abs(a.opacity - b.opacity) > REST_OPACITY) return false;
  const ac = a.cuts ?? [], bc = b.cuts ?? [];
  return ac.length > 0 && ac.length === bc.length && ac.every((c, i) => boxDelta(c, bc[i]!) <= REST_PX);
}

export function sameState(a: NodeState | null, b: NodeState | null): boolean {
  if (!a || !b) return false;
  if (boxDelta(a.box, b.box) > REST_PX || boxDelta(a.shown, b.shown) > REST_PX || Math.abs(a.opacity - b.opacity) > REST_OPACITY) return false;
  const ac = a.clips ?? [], bc = b.clips ?? [];
  if (ac.length !== bc.length || ac.some((c, i) => boxDelta(c, bc[i]!) > REST_PX)) return false;
  const av = a.cover ?? null, bv = b.cover ?? null;
  if (!av || !bv) return av === bv;
  if (av.by !== bv.by || Math.abs(av.frac - bv.frac) > REST_OPACITY) return false;
  return !av.rect || !bv.rect || boxDelta(av.rect, bv.rect) <= REST_PX;
}

async function evaluate(cdp: Cdp, sessionId: string, expression: string, timeoutMs = 60_000): Promise<unknown> {
  const res = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId, timeoutMs);
  if (res?.exceptionDetails) throw new TextFitError(`page script failed: ${String(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text).split("\n")[0]}`);
  return res?.result?.value;
}

// ─────────────────────────────────────────────────────────────── occluded, canvas-text, connector, align

/** A pixel differs from the box's ground when one channel is off by more than this (film grain stays under it). */
export const OCC_TOL = 48;
/** Foreign px² inside a text's box, after despeckling, that make it occluded. */
export const OCC_MIN_PX = 40;
/** A connector end must land within this many px of its target box (edge or centre). */
export const JOIN_TOL = 8;
/** A declared alignment must hold within this many px. */
export const ALIGN_TOL = 4;

/** An exempt element box; ink marks own only the pixels they paint (where the marks-hidden capture differs). */
interface ExemptBox extends Box { ink: boolean }
/** marks: indices of its own ink-only marks; others: boxes of other texts' hidden marks over its box. */
interface OccCand { i: number; text: string; context: string; selector: string; box: Box; exempt: ExemptBox[]; others: Box[]; marks: number[]; solo: boolean }
/** Foreign px², their centroid (rest test), and foreign pixels to look up the element by, nearest the centroid first. */
interface OccScore { i: number; foreign: number; cx: number; cy: number; pts: [number, number][]; conflict: boolean }
export interface OccHit { i: number; text: string; context: string; selector: string; foreign: number; by: string }

async function capture(cdp: Cdp, sessionId: string, clip: Box): Promise<string> {
  const res = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, captureBeyondViewport: false, clip: { x: clip.l, y: clip.t, width: clip.r - clip.l, height: clip.b - clip.t, scale: 1 } }, sessionId, 30_000);
  if (typeof res?.data !== "string" || !res.data) throw new TextFitError("Page.captureScreenshot returned no image");
  return res.data;
}

const intBox = (b: Box): Box => ({ l: Math.max(0, Math.floor(b.l)), t: Math.max(0, Math.floor(b.t)), r: Math.ceil(b.r), b: Math.ceil(b.b) });

/** Foreign-ink scores for the planned text at time t (all of it, or `only` indices of the last full plan). */
async function occlusionScores(cdp: Cdp, sessionId: string, t: number, only: number[] | null): Promise<{ cands: OccCand[]; scores: Map<number, OccScore> }> {
  const plan = (await evaluate(cdp, sessionId, `window.__tfOccPlan(${t}, ${only ? JSON.stringify(only) : "null"})`)) as { cands: OccCand[]; clip: Box | null; marks: number };
  if (!plan || !Array.isArray(plan.cands)) throw new TextFitError(`occlusion plan at ${t}s returned no list`);
  const scores = new Map<number, OccScore>();
  if (!plan.clip || plan.cands.length === 0) { await evaluate(cdp, sessionId, "window.__tfOccClear()"); return { cands: [], scores }; }
  if (typeof plan.marks !== "number") throw new TextFitError(`occlusion plan at ${t}s returned no mark count`);
  /** The same clip with the given ink-only marks hidden (true: all of them); null when there are none to hide. */
  const bareCapture = async (clip: Box, which: true | number[]): Promise<string | null> => {
    if (plan.marks === 0 || (which !== true && which.length === 0)) return null;
    await evaluate(cdp, sessionId, `window.__tfOccMarks(${JSON.stringify(which)})`);
    try { return await capture(cdp, sessionId, clip); } finally { await evaluate(cdp, sessionId, "window.__tfOccMarks(false)"); }
  };
  const scoreWith = async (png: string, bare: string | null, clip: Box, items: { i: number; box: Box; exempt: ExemptBox[]; others: Box[] }[]): Promise<OccScore[]> => {
    const out = (await evaluate(cdp, sessionId, `window.__tfOccScore(${JSON.stringify(png)}, ${JSON.stringify(bare)}, ${JSON.stringify(clip)}, ${JSON.stringify(items)}, ${OCC_TOL}, 2)`)) as OccScore[];
    if (!Array.isArray(out) || out.length !== items.length) throw new TextFitError(`occlusion score at ${t}s returned ${Array.isArray(out) ? out.length : "no"} result(s) for ${items.length} text(s)`);
    return out;
  };
  const score = async (clip: Box, items: OccCand[]): Promise<OccScore[]> => {
    const png = await capture(cdp, sessionId, clip);
    // Same frame with every declared ink-only mark hidden: the difference is exactly the ink those marks paint.
    const out = await scoreWith(png, await bareCapture(clip, true), clip, items.map((c) => ({ i: c.i, box: c.box, exempt: c.exempt, others: c.others })));
    // Where another text's mark overlaps this text's own, the shared difference cannot say whose ink it is: hide only its own marks.
    for (const [k, c] of items.entries()) {
      if (!out[k]!.conflict) continue;
      const own = intBox(c.box);
      const [s] = await scoreWith(await capture(cdp, sessionId, own), await bareCapture(own, c.marks), own, [{ i: c.i, box: c.box, exempt: c.exempt, others: [] }]);
      out[k] = s!;
    }
    return out;
  };
  for (const s of await score(intBox(plan.clip), plan.cands)) scores.set(s.i, s);
  // Text whose box another block's text crosses is re-captured with only its own block hidden, so text over text is foreign too.
  for (const c of plan.cands.filter((x) => x.solo)) {
    await evaluate(cdp, sessionId, `window.__tfOccSolo(${c.i})`);
    const [s] = await score(intBox(c.box), [c]);
    if (s && s.foreign > (scores.get(c.i)?.foreign ?? 0)) scores.set(c.i, s);
  }
  await evaluate(cdp, sessionId, "window.__tfOccClear()");
  return { cands: plan.cands, scores };
}

/** Same foreign ink a step away: the count within 15% (or OCC_MIN_PX) and its centroid within REST_PX. */
export function sameOcclusion(a: OccScore | undefined, b: OccScore | undefined): boolean {
  if (!a || !b || b.foreign < OCC_MIN_PX) return false;
  return Math.abs(a.foreign - b.foreign) <= Math.max(OCC_MIN_PX, 0.15 * a.foreign) && Math.hypot(a.cx - b.cx, a.cy - b.cy) <= REST_PX;
}

async function occludedAt(cdp: Cdp, sessionId: string, t: number, restDelta: number, durationSec: number | null): Promise<OccHit[]> {
  const now = await occlusionScores(cdp, sessionId, t, null);
  const hit = now.cands.filter((c) => (now.scores.get(c.i)?.foreign ?? 0) >= OCC_MIN_PX);
  if (!hit.length) return [];
  const idx = hit.map((c) => c.i);
  const before = t - restDelta >= 0 ? (await occlusionScores(cdp, sessionId, t - restDelta, idx)).scores : new Map<number, OccScore>();
  const after = durationSec === null || t + restDelta <= durationSec ? (await occlusionScores(cdp, sessionId, t + restDelta, idx)).scores : new Map<number, OccScore>();
  const out: OccHit[] = [];
  await evaluate(cdp, sessionId, `window.__tfOccPlan(${t}, ${JSON.stringify(idx)})`);
  for (const c of hit) {
    const s = now.scores.get(c.i)!;
    if (!sameOcclusion(s, before.get(c.i)) && !sameOcclusion(s, after.get(c.i))) continue;
    const by = (await evaluate(cdp, sessionId, `window.__tfOccTop(${c.i}, ${JSON.stringify(s.pts)})`)) as string;
    out.push({ i: c.i, text: c.text, context: c.context, selector: c.selector, foreign: s.foreign, by: typeof by === "string" ? by : "canvas/unknown" });
  }
  await evaluate(cdp, sessionId, "window.__tfOccClear()");
  return out;
}

/**
 * Fold occluded hits into the time's findings: a text already reported as covered keeps that diagnosis (a DOM element over it,
 * measured), any other text gains or gets an occluded finding.
 */
export function mergeOccluded(time: number, found: FitFinding[], hits: OccHit[]): FitFinding[] {
  const out = found.map((f) => ({ ...f, kinds: [...f.kinds], detail: [...f.detail] }));
  for (const h of hits) {
    const detail = `"${h.text}" has ${h.foreign} px² of other ink inside its box (top element there: ${h.by})`;
    const same = out.find((f) => f.selector === h.selector && f.text === h.text);
    if (same?.kinds.includes("covered")) continue;
    if (same) { same.kinds.push("occluded"); same.detail.push(detail); continue; }
    out.push({ time, text: h.text, context: h.context, selector: h.selector, kinds: ["occluded"], lost: 0, detail: [detail] });
  }
  return out;
}

interface CanvasCall { text: string; box: Box; canvas: string }
interface PublishedText { text: string; l: number; t: number; r: number; b: number }
interface CanvasSeen { text: string; canvas: string; times: number[]; why: string }

const normText = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
const boxesMeet = (a: Box, b: Box): boolean => Math.min(a.r, b.r) > Math.max(a.l, b.l) && Math.min(a.b, b.b) > Math.max(a.t, b.t);

/** A published entry covers a canvas call when its text matches and its box meets the drawn box (composition px, root at the origin). */
export function publishedCovers(call: CanvasCall, published: readonly PublishedText[], frame: Box): boolean {
  return published.some((p) => normText(p.text) === normText(call.text) && boxesMeet(call.box, { l: frame.l + p.l, t: frame.t + p.t, r: frame.l + p.r, b: frame.t + p.b }));
}

const isPublishedList = (v: unknown): v is PublishedText[] =>
  Array.isArray(v) && v.every((p) => p && typeof p === "object" && typeof (p as PublishedText).text === "string" && ["l", "t", "r", "b"].every((k) => Number.isFinite((p as Record<string, number>)[k])));

async function canvasTextAt(cdp: Cdp, sessionId: string, t: number, seen: Map<string, CanvasSeen>): Promise<void> {
  const res = (await evaluate(cdp, sessionId, `window.__tfCanvasText(${t})`)) as { calls: CanvasCall[]; published: unknown; errors: string[]; frame: Box };
  if (!res || !Array.isArray(res.calls)) throw new TextFitError(`canvas text scan at ${t}s returned no list`);
  if (res.errors.length) throw new TextFitError(`canvas text recorder failed: ${res.errors[0]}`);
  const malformed = res.published !== null && !isPublishedList(res.published);
  const published = isPublishedList(res.published) ? res.published : [];
  for (const c of res.calls) {
    if (publishedCovers(c, published, res.frame)) continue;
    const key = `${c.canvas}\u0000${normText(c.text)}`;
    const why = malformed ? "window.__hfCanvasText is not a list of {text, l, t, r, b}" : published.length ? "no published box in window.__hfCanvasText matches it" : "the page publishes no window.__hfCanvasText";
    const s = seen.get(key) ?? { text: c.text, canvas: c.canvas, times: [], why };
    if (!s.times.includes(t)) s.times.push(t);
    seen.set(key, s);
  }
}

/** One canvas-text finding per drawn string, at the first time it was readable, with every time it was. */
export function canvasTextFindings(seen: ReadonlyMap<string, CanvasSeen>): FitFinding[] {
  return [...seen.values()].map((s) => ({
    time: s.times[0]!, text: s.text.replace(/\s+/g, " ").trim().slice(0, 80), context: "", selector: s.canvas, kinds: ["canvas-text"] as FitKind[], lost: 0,
    detail: [`"${s.text.trim().slice(0, 80)}" is drawn with fillText/strokeText on ${s.canvas} at ${s.times.length} checked time(s) (${s.times.slice(0, 8).map((x) => x.toFixed(2) + "s").join(", ")}${s.times.length > 8 ? ", …" : ""}); ${s.why}: put readable text in the DOM or publish its box`],
  }));
}

interface Pt { x: number; y: number }
interface JoinGeom { key: string; joins: string[]; ends: Pt[] | null; targets: (Box | null)[]; dash: string; malformed?: boolean }
interface Geom { box: Box; baseline: number }
interface AlignSpec { spec: string; kind: string; ref: string | null; geom: Geom | null; missing: boolean }
interface AlignGeom { key: string; text: string; geom: Geom; specs: AlignSpec[] }
interface LayoutGeom { frame: Box; joins: JoinGeom[]; aligns: AlignGeom[] }

/** Distance from a connector end to a target: to the box outline (0 on it) or to its centre, whichever is nearer. */
export function distanceToBox(p: Pt, b: Box): number {
  const inside = p.x >= b.l && p.x <= b.r && p.y >= b.t && p.y <= b.b;
  const outline = inside ? Math.min(p.x - b.l, b.r - p.x, p.y - b.t, b.b - p.y) : Math.hypot(Math.max(b.l - p.x, 0, p.x - b.r), Math.max(b.t - p.y, 0, p.y - b.b));
  return Math.min(outline, Math.hypot(p.x - (b.l + b.r) / 2, p.y - (b.t + b.b) / 2));
}

/** Best pairing of the two ends with the two targets; the distance of each end to its target. */
export function connectorMiss(ends: readonly [Pt, Pt], targets: readonly [Box, Box]): { dists: [number, number]; swapped: boolean } {
  const straight: [number, number] = [distanceToBox(ends[0], targets[0]), distanceToBox(ends[1], targets[1])];
  const crossed: [number, number] = [distanceToBox(ends[1], targets[0]), distanceToBox(ends[0], targets[1])];
  return Math.max(...crossed) < Math.max(...straight) ? { dists: crossed, swapped: true } : { dists: straight, swapped: false };
}

/** Signed px an element is off its declared alignment; null for an unknown kind. */
export function alignOffset(kind: string, el: Geom, ref: Geom): number | null {
  const cx = (b: Box) => (b.l + b.r) / 2;
  if (kind === "center") return cx(el.box) - cx(ref.box);
  if (kind === "left") return el.box.l - ref.box.l;
  if (kind === "baseline") return el.baseline - ref.baseline;
  return null;
}

const near = (a: Pt[] | null, b: Pt[] | null): boolean => !!a && !!b && a.length === b.length && a.every((p, i) => Math.hypot(p.x - b[i]!.x, p.y - b[i]!.y) <= REST_PX);
const nearBoxes = (a: (Box | null)[], b: (Box | null)[]): boolean => a.length === b.length && a.every((x, i) => (x === null) === (b[i] === null) && (!x || boxDelta(x, b[i]!) <= REST_PX));
const joinRest = (a: JoinGeom, b: JoinGeom | undefined): boolean => !!b && a.dash === b.dash && near(a.ends, b.ends) && nearBoxes(a.targets, b.targets);
const alignRest = (a: AlignGeom, b: AlignGeom | undefined): boolean => !!b && boxDelta(a.geom.box, b.geom.box) <= REST_PX && nearBoxes(a.specs.map((s) => s.geom?.box ?? null), b.specs.map((s) => s.geom?.box ?? null));

async function layoutAt(cdp: Cdp, sessionId: string, t: number, restDelta: number, durationSec: number | null): Promise<FitFinding[]> {
  const get = async (at: number): Promise<LayoutGeom> => {
    const g = (await evaluate(cdp, sessionId, `window.__tfLayout(${at})`)) as LayoutGeom;
    if (!g || !Array.isArray(g.joins) || !Array.isArray(g.aligns)) throw new TextFitError(`layout scan at ${at}s returned no lists`);
    return g;
  };
  const now = await get(t);
  if (!now.joins.length && !now.aligns.length) return [];
  const before = t - restDelta >= 0 ? await get(t - restDelta) : null;
  const after = durationSec === null || t + restDelta <= durationSec ? await get(t + restDelta) : null;
  const out: FitFinding[] = [];
  const add = (kind: FitKind, text: string, selector: string, lost: number, detail: string) => out.push({ time: t, text, context: "", selector, kinds: [kind], lost, detail: [detail] });
  for (const j of now.joins) {
    if (j.malformed) { add("connector", j.key, j.key, 0, `${j.key} is not {id, from:[x,y], to:[x,y], joins:["#a","#b"]}`); continue; }
    if (j.joins.length !== 2) { add("connector", j.key, j.key, 0, `data-joins="${j.joins.join(" ")}" must name exactly two targets`); continue; }
    const missing = j.joins.filter((_, i) => !j.targets[i]);
    if (missing.length) { add("connector", j.key, j.key, 0, `data-joins target ${missing.join(", ")} is not in the page`); continue; }
    if (!j.ends || j.ends.length !== 2) { add("connector", j.key, j.key, 0, "its two ends could not be measured (an SVG line/path/polyline or a DOM element is required)"); continue; }
    if (!joinRest(j, before?.joins.find((x) => x.key === j.key)) && !joinRest(j, after?.joins.find((x) => x.key === j.key))) continue;
    const m = connectorMiss([j.ends[0]!, j.ends[1]!], [j.targets[0]!, j.targets[1]!]);
    const order = m.swapped ? [1, 0] : [0, 1];
    const bad = m.dists.map((d, i) => ({ d, target: j.joins[i]!, end: order[i]! })).filter((x) => x.d > JOIN_TOL);
    if (!bad.length) continue;
    add("connector", j.key, j.key, 0, bad.map((x) => `end ${x.end + 1} is ${Math.round(x.d)}px from ${x.target}`).join("; ") + ` (tolerance ${JOIN_TOL}px)`);
  }
  for (const a of now.aligns) {
    if (!alignRest(a, before?.aligns.find((x) => x.key === a.key)) && !alignRest(a, after?.aligns.find((x) => x.key === a.key))) continue;
    for (const s of a.specs) {
      if (s.missing) { add("align", a.text || a.key, a.key, 0, `data-align="${s.spec}": ${s.ref} is not in the page`); continue; }
      const ref = s.ref ? s.geom : { box: now.frame, baseline: now.frame.b };
      const off = ref ? alignOffset(s.kind, a.geom, ref) : null;
      if (off === null || (!s.ref && s.kind !== "center")) { add("align", a.text || a.key, a.key, 0, `data-align="${s.spec}" is not one of center, center:#id, left:#id, baseline:#id`); continue; }
      if (Math.abs(off) <= ALIGN_TOL) continue;
      add("align", a.text || a.key, a.key, 0, `${Math.round(Math.abs(off))}px off data-align="${s.spec}" (${off > 0 ? (s.kind === "baseline" ? "low" : "right") : (s.kind === "baseline" ? "high" : "left")}; tolerance ${ALIGN_TOL}px)`);
    }
  }
  return out;
}

export async function textFit(opts: TextFitOptions): Promise<TextFitResult> {
  const started = performance.now();
  const projectDir = resolve(opts.projectDir);
  const entry = resolve(projectDir, opts.entry ?? "index.html");
  if (!existsSync(entry)) throw new TextFitError(`no ${opts.entry ?? "index.html"} in ${projectDir}`);
  const root = readRoot(projectDir, opts.entry ?? "index.html");
  const settle = opts.settle ?? 0.5;
  if (!(settle >= 0)) throw new TextFitError(`settle must be ≥ 0, got ${settle}`);
  const times = planTimes(opts.times, settle, root.durationSec);
  if (times.length === 0) throw new TextFitError("no times to check");
  const restDelta = opts.restDelta ?? 0.1;
  const margin = opts.marginFrac ?? 0.05;
  const budgetMs = opts.loadBudgetMs ?? 30_000;

  const inst = await ensureInstalled();
  const profile = mkdtempSync(join(tmpdir(), "lifeos-hf-textfit-"));
  const chrome = Bun.spawn(sandboxed([
    // Same launch as the seam's probe (probe.ts): Chrome's own sandbox cannot start inside sandbox-exec.
    inst.browserPath, "--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--allow-file-access-from-files", "--hide-scrollbars",
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost", `--window-size=${root.width},${root.height}`, "about:blank",
  ]), { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  let cdp: Cdp | undefined;
  try {
    cdp = await Cdp.connect(await devtoolsUrl(chrome.stderr, 20_000), 10_000);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const pageErrors: string[] = [];
    let loaded = false;
    cdp.on((method, params, sid) => {
      if (sid !== sessionId) return;
      if (method === "Runtime.exceptionThrown") pageErrors.push(String(params?.exceptionDetails?.exception?.description ?? params?.exceptionDetails?.text ?? "page error").split("\n")[0]);
      if (method === "Page.loadEventFired") loaded = true;
    });
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: root.width, height: root.height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: CANVAS_HOOK }, sessionId);
    await cdp.send("Page.navigate", { url: pathToFileURL(entry).href }, sessionId, 60_000);

    const ready = `(() => { const t = window.__timelines && window.__timelines[${JSON.stringify(root.id)}]; return { reg: !!(t && typeof t.seek === 'function'), fontsError: window.__hfFontsError || null }; })()`;
    const deadline = Date.now() + budgetMs;
    let registered = false;
    while (Date.now() < deadline) {
      await Bun.sleep(100);
      if (!loaded) continue;
      const s = (await evaluate(cdp, sessionId, ready)) as { reg: boolean; fontsError: string | null } | undefined;
      if (s?.fontsError) throw new TextFitError(`font gate failed: ${s.fontsError}`);
      if (pageErrors.length) throw new TextFitError(`page error: ${pageErrors[0]}`);
      if (s?.reg) { registered = true; break; }
    }
    if (!registered) throw new TextFitError(`window.__timelines["${root.id}"] was not registered within ${budgetMs} ms${loaded ? "" : " (the page never finished loading)"}`);
    await evaluate(cdp, sessionId, "document.fonts.ready.then(() => true)");
    await evaluate(cdp, sessionId, PAGE_LIB);

    const findings: FitFinding[] = [];
    const bare = (await evaluate(cdp, sessionId, "window.__tfOptOuts()")) as { selector: string; text: string }[];
    if (!Array.isArray(bare)) throw new TextFitError("opt-out scan returned no list");
    for (const o of bare) {
      findings.push({ time: times[0]!, text: o.text, context: "", selector: o.selector, kinds: ["optout"], lost: 0, detail: ['data-textfit="cover-ok" without data-annotates(-text) or data-textfit-reason: say what it marks or why it may cover text'] });
    }
    const untargeted = new Set<string>();
    const canvasSeen = new Map<string, CanvasSeen>();
    for (const t of times) {
      const onInk = (await evaluate(cdp, sessionId, `window.__tfCoverTargets(${t})`)) as { selector: string; text: string }[];
      if (!Array.isArray(onInk)) throw new TextFitError(`cover-ok target scan at ${t}s returned no list`);
      for (const o of onInk) {
        if (untargeted.has(o.selector)) continue;
        untargeted.add(o.selector);
        findings.push({ time: t, text: o.text, context: "", selector: o.selector, kinds: ["optout"], lost: 0, detail: [`data-textfit="cover-ok" overlaps the ink of "${o.text}" with only a reason: name what it marks with data-annotates="<id>" or data-mark (data-mark="strike" for a strike-through, which Proof measures)`] });
      }
      await canvasTextAt(cdp, sessionId, t, canvasSeen);
      findings.push(...(await layoutAt(cdp, sessionId, t, restDelta, root.durationSec)));
      const occluded = await occludedAt(cdp, sessionId, t, restDelta, root.durationSec);
      const cands = (await evaluate(cdp, sessionId, `window.__tfMeasure(${t}, ${margin})`)) as PageCandidate[];
      if (!Array.isArray(cands)) throw new TextFitError(`measurement at ${t}s returned no list`);
      const timeFindings: FitFinding[] = [];
      const before = t - restDelta >= 0 ? ((await evaluate(cdp, sessionId, `window.__tfStates(${t - restDelta})`)) as (NodeState | null)[]) : [];
      const after = root.durationSec === null || t + restDelta <= root.durationSec ? ((await evaluate(cdp, sessionId, `window.__tfStates(${t + restDelta})`)) as (NodeState | null)[]) : [];
      for (const c of cands) {
        const prev = before[c.i] ?? null, next = after[c.i] ?? null;
        const atRest = sameState(c.state, prev) || sameState(c.state, next);
        const steadyCut = sameCut(c.state, prev) || sameCut(c.state, next);
        const kinds = c.kinds.filter((k) => atRest || (k === "clipped" && steadyCut));
        if (!kinds.length) continue;
        const lost = Math.max(...kinds.map((k) => c.lostBy[k] ?? 0));
        timeFindings.push({ time: t, text: c.text, context: c.context, selector: c.selector, kinds, lost: Math.round(lost * 1000) / 1000, detail: c.detail.filter((d) => kinds.includes(d.kind)).map((d) => d.text) });
      }
      findings.push(...mergeOccluded(t, timeFindings, occluded));
    }
    findings.push(...canvasTextFindings(canvasSeen));
    return { ok: findings.length === 0, project: projectDir, checked: times, findings, ms: Math.round(performance.now() - started) };
  } finally {
    cdp?.close();
    // Read the tree before the kill: once the browser dies its helpers reparent to launchd.
    const helpers = descendantPids(chrome.pid);
    chrome.kill("SIGKILL");
    for (const p of helpers) { try { process.kill(p, "SIGKILL"); } catch { /* exited between the ps read and the kill */ } }
    await chrome.exited;
    rmSync(profile, { recursive: true, force: true });
  }
}

const KIND_ORDER: Record<FitKind, number> = { clipped: 0, covered: 1, occluded: 2, frame: 3, connector: 4, align: 5, "canvas-text": 6, truncated: 7, optout: 8 };

/** Worst first: most of the glyph box lost, then kind, then time. */
export function rankFindings(findings: readonly FitFinding[]): FitFinding[] {
  return [...findings].sort((a, b) => b.lost - a.lost || Math.min(...a.kinds.map((k) => KIND_ORDER[k])) - Math.min(...b.kinds.map((k) => KIND_ORDER[k])) || a.time - b.time);
}

// ─────────────────────────────────────────────────────────────── CLI

class UsageError extends Error {}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new UsageError(`--${name} needs a value`);
  return v;
}

function num(argv: string[], name: string): number | undefined {
  const v = flag(argv, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number, got "${v}"`);
  return n;
}

async function main(argv: string[]): Promise<number> {
  const project = flag(argv, "project");
  if (!project) throw new UsageError("--project <dir> is required");
  const sources = ["times", "hits", "every"].filter((n) => argv.includes(`--${n}`));
  if (sources.length !== 1) throw new UsageError("give exactly one of --times, --hits, --every");
  const root = readRoot(resolve(project));
  let times: number[];
  if (sources[0] === "times") {
    times = flag(argv, "times")!.split(",").map((s) => Number(s.trim()));
    if (times.some((t) => !Number.isFinite(t))) throw new UsageError("--times must be comma-separated seconds");
  } else if (sources[0] === "hits") {
    const path = flag(argv, "hits")!;
    if (!existsSync(path)) throw new UsageError(`no hits file at ${path}`);
    times = parseHitTimes(readFileSync(path, "utf8"));
    if (times.length === 0) throw new UsageError(`${path} has no hit rows`);
  } else {
    if (root.durationSec === null) throw new UsageError("--every needs a root data-duration");
    times = everyTimes(num(argv, "every")!, root.durationSec);
  }
  const res = await textFit({ projectDir: project, times, settle: num(argv, "settle") });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(res));
  } else {
    console.log(`TextFit ${res.project}: ${res.checked.length} times checked, ${res.findings.length} finding(s) in ${res.ms} ms`);
    for (const f of rankFindings(res.findings)) {
      console.log(`  ✗ ${f.time.toFixed(2)}s [${f.kinds.join(",")}] "${f.text}"${f.context && f.context !== f.text ? ` in "${f.context}"` : ""} lost ${Math.round(f.lost * 100)}% — ${f.selector}`);
      for (const d of f.detail) console.log(`      ${d}`);
    }
  }
  return res.ok ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(err instanceof UsageError ? 2 : 3);
  });
}
