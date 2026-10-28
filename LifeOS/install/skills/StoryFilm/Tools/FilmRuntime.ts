/**
 * FilmRuntime.ts — the page side of a StoryFilm composition. Bundled by FilmComposition.ts into the project's
 * `film.js` (with Motion.ts), loaded after `plan.js` and the pinned GSAP. It reads the plan and builds one paused
 * GSAP timeline over the static elements index.html already holds; index.html registers it once the fonts load.
 *
 * Seek-safety: every value is a tween or a set on the timeline, so any frame is a pure function of its time.
 *   - opacity ramps are linear `fromTo` tweens between exact keyframes (autoAlpha, so a 0 is also hidden);
 *   - the camera is three tweens per painting (scale, x, y), each with an ease that returns Motion.ts's
 *     transform at that progress, so the move is Motion.ts's math, not an approximation of it;
 *   - discrete changes are `set`s half a frame before the first frame they hold on, so no frame sits on an edge.
 */
import type { Discrete, FilmPlan, Ramp } from "./FilmTimeline.ts";
import { motionTransform } from "./Motion.ts";

/** The slice of the GSAP API this page uses (GSAP is a global from vendor/gsap.min.js, untyped there). */
interface GsapTimeline {
  set(target: Element, vars: Record<string, unknown>, position: number): GsapTimeline;
  fromTo(target: Element, from: Record<string, unknown>, to: Record<string, unknown>, position: number): GsapTimeline;
  add(child: GsapTimeline, position: number): GsapTimeline;
}
interface Gsap { timeline(vars?: Record<string, unknown>): GsapTimeline }
declare const gsap: Gsap;

interface FilmWindow { __storyFilmPlan?: FilmPlan; __storyFilmTimeline?: GsapTimeline }
const host = window as unknown as FilmWindow;
const plan = host.__storyFilmPlan;
if (!plan) throw new Error("storyfilm: plan.js did not define window.__storyFilmPlan");

function byId(id: string): Element {
  const el = document.getElementById(id);
  if (!el) throw new Error(`storyfilm: element #${id} is missing from index.html`);
  return el;
}
const stepAt = (frame: number): number => (frame - 0.5) / plan.fps;

function addRamps(tl: GsapTimeline, target: Element, rs: readonly Ramp[]): void {
  for (const r of rs) tl.fromTo(target, { autoAlpha: r.v0 }, { autoAlpha: r.v1, duration: r.t1 - r.t0, ease: "none", immediateRender: false }, r.t0);
}
function addSteps<T>(tl: GsapTimeline, target: Element, d: Discrete<T>, vars: (v: T) => Record<string, unknown>): void {
  for (const s of d.steps) tl.set(target, vars(s.value), stepAt(s.frame));
}

const root = document.querySelector("[data-composition-id]");
if (!root) throw new Error("storyfilm: no composition root in index.html");
const tl = gsap.timeline({ paused: true });

for (const p of plan.paintings) {
  const wrap = byId(`paint-${p.id}`);
  const img = wrap.querySelector("img");
  if (!img) throw new Error(`storyfilm: #paint-${p.id} has no img`);
  addRamps(tl, wrap, p.opacity);
  const at = (q: number) => { const m = motionTransform(p.motion, q, p.focus); return { scale: m.scale, x: m.tx * plan.width, y: m.ty * plan.height }; };
  const start = at(0);
  for (const prop of ["scale", "x", "y"] as const) {
    const base = start[prop];
    tl.fromTo(img, { [prop]: base, force3D: false }, { [prop]: base + 1, force3D: false, duration: p.duration, immediateRender: false, ease: (q: number) => at(q)[prop] - base }, p.start);
  }
}

if (plan.captions) {
  addRamps(tl, byId("band"), plan.band);
  for (const c of plan.captions) {
    const sub = gsap.timeline();
    const gate = byId(`cap-${c.id}`);
    addSteps(sub, gate, c.shown, (v) => ({ display: v ? "block" : "none" }));
    addRamps(sub, byId(`capfade-${c.id}`), c.opacity);
    c.sentences.forEach((s, k) => {
      const line = byId(`cap-${c.id}-${k}`);
      addSteps(sub, line, s.shown, (v) => ({ display: v ? "block" : "none" }));
      const spans = line.querySelectorAll("span");
      if (spans.length !== s.words.length) throw new Error(`storyfilm: #cap-${c.id}-${k} has ${spans.length} words, the plan has ${s.words.length}`);
      s.words.forEach((w, i) => addSteps(sub, spans[i]!, w.color, (v) => ({ color: v })));
    });
    tl.add(sub, 0);
  }
}

addRamps(tl, byId("card-title"), plan.titleCard);
addRamps(tl, byId("card-end"), plan.endCard);
// The timeline spans the whole film, so its duration is the film's.
tl.set(root, { autoAlpha: 1 }, plan.total);

host.__storyFilmTimeline = tl;
