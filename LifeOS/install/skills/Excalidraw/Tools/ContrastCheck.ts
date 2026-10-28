#!/usr/bin/env bun
/**
 * ContrastCheck.ts — deterministic text-visibility gate for the live canvas.
 *
 * Reads every text element from the canvas server and computes the WCAG
 * contrast ratio against its effective background: the container's fill for
 * bound labels, else the backdrop color. Fails (exit 1) when any text falls
 * below the threshold, so "the text is invisible" can never ship silently.
 *
 * Usage: bun ContrastCheck.ts [--bg <hex>] [--min <ratio>] [--url <canvasUrl>]
 *   --bg   backdrop color behind free-standing text (default #ffffff; pass
 *          your backdrop rectangle's color when the scene uses one)
 *   --min  minimum ratio (default 3.0 — WCAG large-text floor)
 */

interface El {
  id: string;
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: string;
  containerId?: string | null;
  text?: string;
  isDeleted?: boolean;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = process.env.EXCALIDRAW_PORT ?? "3579";
const URL_ = arg("--url", process.env.EXPRESS_SERVER_URL ?? `http://127.0.0.1:${PORT}`);
const BG = arg("--bg", "#ffffff");
const MIN = parseFloat(arg("--min", "3.0"));

function parseHex(c: string | undefined): [number, number, number] | null {
  if (!c) return null;
  const m = c.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null; // "transparent" and named colors → caller falls through
  let h = m[1];
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: [number, number, number], b: [number, number, number]): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const res = await fetch(`${URL_}/api/elements`);
if (!res.ok) {
  console.error(`Canvas unreachable at ${URL_} (HTTP ${res.status})`);
  process.exit(3);
}
const body = (await res.json()) as { elements?: El[] } | El[];
const elements: El[] = Array.isArray(body) ? body : (body.elements ?? []);
const byId = new Map(elements.map((e) => [e.id, e]));
const backdrop = parseHex(BG);

const failures: string[] = [];
let checked = 0;

for (const el of elements) {
  if (el.type !== "text" || el.isDeleted) continue;
  const fg = parseHex(el.strokeColor);
  if (!fg) continue; // non-hex text color — cannot judge, skip
  let bg = backdrop;
  let where = `backdrop ${BG}`;
  if (el.containerId) {
    const c = byId.get(el.containerId);
    const cbg = parseHex(c?.backgroundColor);
    if (cbg) {
      bg = cbg;
      where = `container ${el.containerId} fill ${c?.backgroundColor}`;
    }
  } else if (el.x != null && el.y != null) {
    // Free text: effective background is the topmost solid-filled shape under
    // its center (array order = z-order; last hit wins).
    const cx = el.x + (el.width ?? 0) / 2;
    const cy = el.y + (el.height ?? 0) / 2;
    for (const s of elements) {
      if (s === el || s.isDeleted || s.type === "text" || s.type === "arrow" || s.type === "line") continue;
      if (s.x == null || s.y == null || s.width == null || s.height == null) continue;
      if (cx < s.x || cx > s.x + s.width || cy < s.y || cy > s.y + s.height) continue;
      const sbg = parseHex(s.backgroundColor);
      if (sbg && s.backgroundColor !== "transparent" && s.fillStyle !== "hachure") {
        bg = sbg;
        where = `shape ${s.id} fill ${s.backgroundColor}`;
      }
    }
  }
  if (!bg) continue;
  checked++;
  const r = ratio(fg, bg);
  if (r < MIN) {
    failures.push(
      `"${(el.text ?? "").slice(0, 40)}" [${el.id}]: ${el.strokeColor} on ${where} → ${r.toFixed(2)}:1 (min ${MIN})`
    );
  }
}

if (failures.length) {
  console.error(`CONTRAST FAIL — ${failures.length} of ${checked} text elements below ${MIN}:1`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`Contrast OK — ${checked} text elements ≥ ${MIN}:1`);

export {};
