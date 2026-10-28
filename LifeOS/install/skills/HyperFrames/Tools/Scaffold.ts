#!/usr/bin/env bun
/**
 * Scaffold.ts — start a one-off HyperFrames composition that already meets the seam's contract.
 *
 *   bun Scaffold.ts --dir <project> --title "<text>" [--subtitle "<text>"]
 *                   [--width 1920] [--height 1080] [--fps 30] [--duration 6] [--id main] [--intent <intent.md>] [--force]
 *
 * Writes <project>/index.html (root with data-composition-id/width/height/duration/fps,
 * the LifeOS theme as CSS custom properties, generic font stacks only, one paused GSAP
 * timeline registered as window.__timelines[<id>]) and stages the pinned GSAP into
 * <project>/vendor/ through the seam. The starting timeline is a themed title card that
 * enters, holds for the read, and exits, so the project renders and passes the seam's
 * motion check before anything else is authored. Replace the scenes; keep the contract.
 *
 * --intent records the intent the film is made for in <project>/intent.json, so the seam's final render runs that
 * intent's Assay video eval set with no flag (HyperFrames README § Eval).
 *
 * Render through the seam, never a bare CLI:
 *   bun ~/.claude/LIFEOS/TOOLS/HyperFrames/HyperFrames.ts render --project <project> --out <project>/Out/<name>.mp4 [--eval <intent.md>]
 *
 * Exit codes: 0 written, 1 refused (index.html exists without --force, staging failed), 2 usage error.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { recordIntent, stageGsap } from "../../../LIFEOS/TOOLS/HyperFrames/HyperFrames.ts";
import { LIFEOS_THEME, themeCss } from "./Theme.ts";

export interface ScaffoldOptions {
  dir: string;
  title: string;
  subtitle?: string;
  width?: number;
  height?: number;
  fps?: number;
  /** Seconds. */
  duration?: number;
  /** data-composition-id; also the window.__timelines key. */
  id?: string;
  /** The intent the film is made for, recorded in <project>/intent.json for the seam's eval on the final render. */
  intent?: string;
  force?: boolean;
}

export class ScaffoldError extends Error {
  constructor(message: string, readonly usage = false) {
    super(message);
    this.name = "ScaffoldError";
  }
}

const ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

interface Resolved { title: string; subtitle?: string; width: number; height: number; fps: number; duration: number; id: string }

export function resolveOptions(o: ScaffoldOptions): Resolved {
  const r: Resolved = {
    title: o.title?.trim() ?? "",
    subtitle: o.subtitle?.trim() || undefined,
    width: o.width ?? 1920,
    height: o.height ?? 1080,
    fps: o.fps ?? 30,
    duration: o.duration ?? 6,
    id: o.id ?? "main",
  };
  if (!r.title) throw new ScaffoldError("--title is required and cannot be blank", true);
  for (const [k, v, lo, hi] of [["width", r.width, 16, 7680], ["height", r.height, 16, 7680], ["fps", r.fps, 1, 240]] as const) {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new ScaffoldError(`--${k} must be an integer ${lo}..${hi}, got ${v}`, true);
  }
  if (r.width % 2 || r.height % 2) throw new ScaffoldError(`--width and --height must be even for H.264, got ${r.width}x${r.height}`, true);
  // The title card needs ~1 s in, a read hold, and ~0.6 s out.
  if (!Number.isFinite(r.duration) || r.duration < 3 || r.duration > 600) throw new ScaffoldError(`--duration must be 3..600 seconds, got ${r.duration}`, true);
  if (!ID_RE.test(r.id)) throw new ScaffoldError(`--id must match ${ID_RE}, got "${r.id}"`, true);
  return r;
}

/** The starting index.html. Pure: same options, same bytes. */
export function buildIndexHtml(o: ScaffoldOptions): string {
  const r = resolveOptions(o);
  const t = LIFEOS_THEME;
  const scale = r.width / 1920;
  const px = (n: number) => `${Math.round(n * scale)}px`;
  const exitAt = +(r.duration - 0.6).toFixed(3);
  const subtitle = r.subtitle
    ? `\n    <p id="subtitle" class="clip" data-start="0" data-duration="${r.duration}" data-track-index="2">${escapeHtml(r.subtitle)}</p>`
    : "";
  const subtitleTweens = r.subtitle
    ? `\ntl.from("#subtitle", { opacity: 0, y: ${Math.round(24 * scale)}, duration: ${t.motion.durations.quick + 0.2}, ease: "${t.motion.eases.enter}" }, 0.55);
tl.to("#subtitle", { opacity: 0, duration: 0.5, ease: "${t.motion.eases.exit}" }, ${exitAt});`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${r.width}, height=${r.height}" />
<script src="./vendor/gsap.min.js"></script>
<style>
${themeCss()}
body { margin: 0; background: var(--color-background-dark); }
#root {
  position: relative; width: ${r.width}px; height: ${r.height}px; overflow: hidden;
  background: radial-gradient(ellipse at 30% 20%, var(--color-cool-wash), transparent 60%), var(--color-background);
  font-family: var(--font-body); color: var(--color-text);
}
#card {
  position: absolute; left: ${px(t.spacing.page)}; right: ${px(t.spacing.page)}; top: 50%;
  transform: translateY(-50%);
}
#title {
  margin: 0; font-size: ${px(t.typography.title.fontSize * 1.5)}; font-weight: var(--type-title-weight);
  line-height: var(--type-title-leading); color: var(--color-text); max-width: 80%;
}
#rule { width: ${px(120)}; height: ${px(6)}; margin: ${px(t.spacing.element)} 0; background: var(--color-accent); border-radius: var(--radius-small); transform-origin: left center; }
#subtitle {
  margin: 0; font-size: ${px(t.typography.subtitle.fontSize)}; font-weight: 400;
  line-height: var(--type-subtitle-leading); color: var(--color-text-muted); max-width: 70%;
}
</style>
</head>
<body>
<div id="root" data-composition-id="${r.id}" data-start="0" data-duration="${r.duration}" data-width="${r.width}" data-height="${r.height}" data-fps="${r.fps}">
  <div id="card">
    <h1 id="title" class="clip" data-start="0" data-duration="${r.duration}" data-track-index="1">${escapeHtml(r.title)}</h1>
    <div id="rule" class="clip" data-start="0" data-duration="${r.duration}" data-track-index="3"></div>${subtitle}
  </div>
</div>
<script>
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
tl.from("#title", { opacity: 0, y: ${Math.round(40 * scale)}, duration: ${t.motion.durations.fade}, ease: "${t.motion.eases.settle}" }, 0.1);
tl.from("#rule", { scaleX: 0, duration: ${t.motion.durations.quick + 0.1}, ease: "${t.motion.eases.enter}" }, 0.35);${subtitleTweens}
tl.to("#title", { opacity: 0, y: ${-Math.round(20 * scale)}, duration: 0.5, ease: "${t.motion.eases.exit}" }, ${exitAt});
tl.to("#rule", { scaleX: 0, duration: 0.45, ease: "${t.motion.eases.exit}" }, ${exitAt});
window.__timelines["${r.id}"] = tl;
</script>
</body>
</html>
`;
}

/** Write index.html and stage GSAP. Refuses to replace an authored index.html unless `force`. */
export async function scaffold(o: ScaffoldOptions): Promise<{ dir: string; index: string; gsap: string; intent?: string }> {
  if (o.intent !== undefined && !(existsSync(resolve(o.intent)) && o.intent.endsWith(".md"))) throw new ScaffoldError(`--intent names no intent .md file: ${o.intent}`, true);
  const html = buildIndexHtml(o);
  const dir = resolve(o.dir);
  const index = join(dir, "index.html");
  if (existsSync(index) && !o.force) throw new ScaffoldError(`${index} exists; pass --force to replace it`);
  invariant(html.includes(`data-composition-id="${o.id ?? "main"}"`) && html.includes("window.__timelines["), "scaffold HTML lost its root or timeline registration");
  mkdirSync(dir, { recursive: true });
  writeFileSync(index, html);
  const gsap = join(dir, await stageGsap(dir));
  return { dir, index, gsap, ...(o.intent !== undefined ? { intent: recordIntent(dir, o.intent) } : {}) };
}

const USAGE = 'usage: bun Scaffold.ts --dir <project> --title "<text>" [--subtitle "<text>"] [--width 1920] [--height 1080] [--fps 30] [--duration 6] [--id main] [--intent <intent.md>] [--force]';

export function parseArgs(argv: readonly string[]): ScaffoldOptions {
  const values = new Map<string, string>();
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--force") { force = true; continue; }
    if (!["--dir", "--title", "--subtitle", "--width", "--height", "--fps", "--duration", "--id", "--intent"].includes(a)) throw new ScaffoldError(`unknown argument "${a}"`, true);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new ScaffoldError(`${a} needs a value`, true);
    values.set(a.slice(2), v);
    i++;
  }
  const dir = values.get("dir");
  if (!dir) throw new ScaffoldError("--dir is required", true);
  const num = (k: string): number | undefined => (values.has(k) ? Number(values.get(k)) : undefined);
  return { dir, title: values.get("title") ?? "", subtitle: values.get("subtitle"), width: num("width"), height: num("height"), fps: num("fps"), duration: num("duration"), id: values.get("id"), intent: values.get("intent"), force };
}

if (import.meta.main) {
  try {
    const r = await scaffold(parseArgs(process.argv.slice(2)));
    console.log(`✓ ${r.index}\n✓ ${r.gsap}${r.intent ? `\n✓ ${r.intent}` : ""}`);
  } catch (e) {
    const usage = e instanceof ScaffoldError && e.usage;
    console.error(`✗ ${(e as Error).message}${usage ? `\n${USAGE}` : ""}`);
    process.exit(usage ? 2 : 1);
  }
}
