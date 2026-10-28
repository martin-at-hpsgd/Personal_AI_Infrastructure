/**
 * FilmComposition.ts — write a run's film as a HyperFrames project the shared seam renders.
 *
 *   <run>/Out/composition/
 *     index.html       the root composition: every painting, the vignette, the caption band, one caption block
 *                      per beat (one line element per sentence, one span per word), the two cards, the narration
 *     plan.js          the FilmPlan (FilmTimeline.ts) as window.__storyFilmPlan
 *     film.js          FilmRuntime.ts + Motion.ts, bundled: builds the paused GSAP timeline from the plan
 *     vendor/gsap.min.js   the seam's pinned GSAP (stageGsap)
 *     shots/<beat>.png     each painting, cropped to its paper edge on the way in
 *     narration.wav
 * Every script sits after the root: HyperFrames joins all local scripts into one at the first one's place, so a
 * script in <head> would pull the runtime ahead of the elements it animates.
 * The serif is embedded as @font-face data (SerifFont.ts), so nothing is fetched; the timeline registers only
 * after the faces load (registerAfterFonts). The layout and colours are the Remotion composition's, value for value.
 */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { embedFonts, injectFonts, registerAfterFonts, stageGsap } from "../../../LIFEOS/TOOLS/HyperFrames/HyperFrames.ts";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import type { FilmPlan, PlanCaption, PlanPainting } from "./FilmTimeline.ts";
import { ensureDir, type SkillConfig } from "./Lib.ts";
import { SERIF_FAMILY, serifFaces } from "./SerifFont.ts";

export const COMPOSITION_ID = "storyfilm";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Opacity and visibility for an element whose first value is `v` (autoAlpha semantics: 0 is hidden). */
function alpha(v: number): string { return `opacity:${v};visibility:${v > 0 ? "inherit" : "hidden"}`; }

function paintingHtml(p: PlanPainting): string {
  return `<div id="paint-${p.id}" class="fill paint" style="${alpha(0)}"><img src="${escapeHtml(p.image)}" alt="" decoding="sync"></div>`;
}

export function captionHtml(c: PlanCaption): string {
  const lines = c.sentences.map((s, k) => {
    const words = s.words.map((w, i) => `<span style="color:${w.color.initial}">${escapeHtml(w.w)}${i < s.words.length - 1 ? " " : ""}</span>`).join("");
    return `<div id="cap-${c.id}-${k}" class="text" style="display:${s.shown.initial ? "block" : "none"}">${words}</div>`;
  }).join("");
  return `<div id="cap-${c.id}" class="cap" style="display:${c.shown.initial ? "block" : "none"}"><div id="capfade-${c.id}" class="fade" style="${alpha(0)}">${lines}</div></div>`;
}

function cardHtml(id: string, title: string, line: string | undefined, small: boolean): string {
  return `<div id="${id}" class="fill card${small ? " small" : ""}" style="${alpha(0)}"><div class="inner"><div class="title">${escapeHtml(title)}</div>${line ? `<div class="line">${escapeHtml(line)}</div>` : ""}</div></div>`;
}

export function compositionHtml(plan: FilmPlan, narration: string): string {
  const { width: W, height: H } = plan;
  const serif = `"${SERIF_FAMILY}", serif`;
  const css = `
html, body { margin: 0; padding: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
#${COMPOSITION_ID} { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
.fill { position: absolute; left: 0; top: 0; right: 0; bottom: 0; width: 100%; height: 100%; display: flex; flex-direction: column; }
.paint { background-color: #000; }
.paint img { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; object-fit: cover; transform-origin: 50% 50%; will-change: transform; }
.vignette { background: radial-gradient(ellipse at 50% 45%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.55) 100%); pointer-events: none; }
#band { position: absolute; left: 0; right: 0; bottom: 0; height: 260px; background: linear-gradient(to top, rgba(0,0,0,0.72), rgba(0,0,0,0)); }
.cap .fade { position: absolute; left: 0; right: 0; bottom: 0; padding: 0 160px 58px; display: flex; justify-content: center; }
.cap .text { font-family: ${serif}; font-size: 40px; line-height: 1.35; color: #EDE6DA; text-align: center; max-width: 1500px; text-shadow: 0 2px 18px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.8); }
.card { background-color: #050505; align-items: center; justify-content: center; }
.card .inner { font-family: ${serif}; color: #EDE6DA; text-align: center; padding: 0 200px; }
.card .title { font-size: 88px; letter-spacing: 1px; line-height: 1.15; font-style: normal; }
.card.small .title { font-size: 56px; letter-spacing: 0.5px; font-style: italic; }
.card .line { font-size: 30px; margin-top: 34px; color: rgba(237,230,218,0.62); letter-spacing: 2px; text-transform: uppercase; }
`;
  const body = [
    `<audio id="narration" src="${escapeHtml(narration)}" data-start="0" data-duration="${plan.total}" data-volume="1"></audio>`,
    ...plan.paintings.map(paintingHtml),
    `<div class="fill vignette"></div>`,
    ...(plan.captions ? [`<div id="band" style="${alpha(0)}"></div>`, ...plan.captions.map(captionHtml)] : []),
    cardHtml("card-title", plan.title, plan.titleLine, false),
    cardHtml("card-end", plan.title, plan.endLine, true),
  ].join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${W}, height=${H}" />
<style>${css}</style>
</head>
<body>
<div id="${COMPOSITION_ID}" data-composition-id="${COMPOSITION_ID}" data-start="0" data-duration="${plan.total}" data-fps="${plan.fps}" data-width="${W}" data-height="${H}">
${body}
</div>
<script src="./vendor/gsap.min.js"></script>
<script src="./plan.js"></script>
<script src="./film.js"></script>
<script>
var tl = window.__storyFilmTimeline;
${registerAfterFonts(COMPOSITION_ID, "tl")}
</script>
</body>
</html>
`;
}

/** FilmRuntime.ts and Motion.ts as one browser script. */
export async function bundleRuntime(): Promise<string> {
  const res = await Bun.build({ entrypoints: [join(import.meta.dir, "FilmRuntime.ts")], target: "browser", format: "iife", minify: false });
  invariant(res.success && res.outputs.length === 1, `film runtime bundle failed: ${res.logs.map(String).join("; ")}`);
  return await res.outputs[0]!.text();
}

export interface WriteOptions {
  projectDir: string;
  plan: FilmPlan;
  narrationWav: string;
  /** Writes one painting into the project (Build.ts crops the paper edge here). Returns whether it trimmed. */
  stageImage: (beatId: string, dest: string) => Promise<boolean>;
  config: SkillConfig;
}

/** Write the whole project. The directory is replaced; it must be a run's `Out/composition`. */
export async function writeComposition(opts: WriteOptions): Promise<{ trimmed: number }> {
  invariant(basename(opts.projectDir) === "composition" && basename(join(opts.projectDir, "..")) === "Out", `refusing to replace ${opts.projectDir}: not a run's Out/composition`);
  rmSync(opts.projectDir, { recursive: true, force: true });
  ensureDir(join(opts.projectDir, "shots"));
  let trimmed = 0;
  const plan: FilmPlan = { ...opts.plan, paintings: [] };
  for (const p of opts.plan.paintings) {
    const rel = `shots/${p.id}.png`;
    if (await opts.stageImage(p.id, join(opts.projectDir, rel))) trimmed++;
    plan.paintings.push({ ...p, image: rel });
  }
  copyFileSync(opts.narrationWav, join(opts.projectDir, "narration.wav"));
  await stageGsap(opts.projectDir);
  writeFileSync(join(opts.projectDir, "film.js"), await bundleRuntime());
  writeFileSync(join(opts.projectDir, "plan.js"), `window.__storyFilmPlan = ${JSON.stringify(plan)};\n`);
  const work = mkdtempSync(join(tmpdir(), "storyfilm-fonts-"));
  try {
    const fonts = embedFonts(serifFaces(opts.config, work));
    writeFileSync(join(opts.projectDir, "index.html"), injectFonts(compositionHtml(plan, "narration.wav"), fonts));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { trimmed };
}
