#!/usr/bin/env bun
/**
 * Capture.ts — web assets for screenshot / scroll / zoom beats, through Interceptor only.
 *
 *   bun Capture.ts --run <slug|dir> [--force] [--verify] [--only <beatId>]
 *
 * Per url-bearing beat: open the page in the pinned Interceptor TEST context
 * (never the operator's profile), neutralize sticky/fixed elements and CSS
 * animation, dismiss common consent banners, capture the FULL page once through
 * the sanctioned `Capture.sh` wrapper, and — for zoom/screenshot beats with a
 * selector — store the element's bounding box, in IMAGE pixels, as a region file. The box is read off
 * the pixels, never off the DOM: the clean full-page capture is taken, the element is outlined, a second
 * capture is taken, and the region is the bounding box of every pixel that differs between the two (so a
 * page that already uses the marker colour, in header art for one, cannot fool it). A DOM rect measured before the capture drifts (Chrome reflows the page when it resizes
 * the viewport for a full-page shot), which put the highlight a line off.
 * Captures are cached by (url, selector); `--force` re-captures.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstalled } from "../../../LIFEOS/TOOLS/HyperFrames/run.ts";
import { CdpClient, descendants, devtoolsEndpoint } from "./DesignAudit.ts";
import { getSkillsDir } from "../../../LIFEOS/TOOLS/Paths.ts";
import { lifeosUserDir } from "../../../LIFEOS/TOOLS/LifeosConfig.ts";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { argValue, capturePresetFor, ensureDir, hasFlag, loadScript, readJson, resolveRunDir, runPaths, validCaptureUrl, writeJson, sentencesOf, sha256, type Beat, type Post, type RunMeta } from "./Lib.ts";

export interface Region { x: number; y: number; w: number; h: number; pageWidth: number; pageHeight: number }
export interface CaptureMeta { url: string; selector?: string; file: string; capturedAt: string; width: number; height: number; cssWidth?: number; cssHeight?: number }

/** A URL that names an image file: Chrome draws it centered on its own dark page, which a capture must not keep. */
export function isImageUrl(url: string): boolean {
  try { return /\.(webp|png|jpe?g|gif|avif|svg)$/i.test(new URL(url).pathname); } catch { return false; }
}

export function captureBeats(beats: Beat[]): Beat[] {
  return beats.filter((b) => b.visual.type === "screenshot" || b.visual.type === "scroll" || b.visual.type === "zoom");
}

function testContextId(): string {
  const prefs = join(lifeosUserDir(), "CUSTOMIZATIONS", "SKILLS", "Interceptor", "preferences.env");
  invariant(existsSync(prefs), `Interceptor preferences.env missing at ${prefs}`);
  const m = readFileSync(prefs, "utf8").match(/^\s*(?:export\s+)?INTERCEPTOR_TEST_CONTEXT_ID=["']?([^"'\s]+)["']?/m);
  invariant(m?.[1], "INTERCEPTOR_TEST_CONTEXT_ID not set in preferences.env");
  return m[1];
}

async function run(cmd: string[], opts: { allowFail?: boolean } = {}): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0 && !opts.allowFail) throw new Error(`${cmd.slice(0, 2).join(" ")} failed (${code}): ${err.slice(-500) || out.slice(-500)}`);
  return { code, out, err };
}

/**
 * Load everything that can still change the page's height before any full-page shot: lazy images turn eager and are
 * awaited, and late content (link-preview cards) gets time to render. Returns the page height after it held still.
 * (A page that grows between the clean and the marked shot as its lazy images and preview cards load makes the
 * sentence pass refuse the pair.)
 */
const SETTLE_JS = `(async () => {
  for (const img of document.querySelectorAll('img[loading="lazy"]')) img.loading = 'eager';
  const pending = [...document.images].filter(i => !i.complete).map(i => new Promise(r => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }));
  await Promise.race([Promise.all(pending), new Promise(r => setTimeout(r, 15000))]);
  let last = -1, still = 0;
  for (let t = 0; t < 60 && still < 4; t++) { await new Promise(r => setTimeout(r, 400)); const h = document.documentElement.scrollHeight; still = h === last ? still + 1 : 0; last = h; }
  return { h: last, still: still >= 4, pending: [...document.images].filter(i => !i.complete).length };
})()`;

/**
 * Embeds that finish after the page does: an embedded frame (a post's tweet, video or widget) and a card that fetches
 * its preview. A capture taken early shows their loading state (a tweet embed reads
 * "LOADING TWEET…" and a link card shows its loading line). Three facts shape the handling:
 * - A card or placeholder finishes in any tab, so the capture waits (bounded) until no loading marker is visible:
 *   aria-busy, a class token that says loading (`loading`, `card-loading`, `skeleton`, `spinner`), or a leaf whose
 *   text starts "Loading". It never shoots a loading state; past EMBED_TIMEOUT_MS it fails naming what was loading.
 * - Chrome lays out nothing inside a frame of a tab it considers hidden (a background tab, or the test window covered
 *   or on another Space), so a tweet's frame stays 0 px tall there forever.
 * - The DOM-render screenshot cannot draw a frame's content at all: it clones the top document, and a frame comes out
 *   as blank paper.
 * So a page with embedded frames is also opened in a headless copy of the pinned browser at the same viewport and
 * pixel ratio, where frames lay out and embed scripts finish. Each embed's container is held on the Interceptor page at
 * its headless size with its own content hidden (so the post flows as a reader sees it, and a placeholder that never
 * resolves in a hidden tab cannot show), and the container's headless pixels are pasted into the capture at its box.
 */
export const EMBED_MIN_CSS = 40;
export const EMBED_TIMEOUT_MS = 30_000;
const EMBED_POLL_MS = 500;
export interface EmbedFrame { x: number; y: number; w: number; h: number }
export interface EmbedState { frames: EmbedFrame[]; loading: string[]; viewportH: number; viewportW: number; dpr: number }

/** The frames EMBED_STATE_JS counts, in document order: a displayed, visible iframe at least EMBED_MIN_CSS wide. */
const FRAMES_JS = `[...document.querySelectorAll('iframe')].filter(f => { const cs = getComputedStyle(f); return cs.display !== 'none' && cs.visibility === 'visible' && f.getBoundingClientRect().width >= ${EMBED_MIN_CSS}; })`;
const EMBED_STATE_JS = `(() => {
  const frames = ${FRAMES_JS}.map(f => { const r = f.getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; });
  const shown = el => {
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) { const s = getComputedStyle(a); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false; }
    const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  };
  const token = /^(?:[a-z0-9]+[-_]+)*(?:loading|skeleton|spinner)$/i;
  const loading = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('script, style, noscript, template, svg')) continue;
    const text = el.children.length ? '' : (el.textContent || '').replace(/\\s+/g, ' ').trim();
    const busy = el.getAttribute('aria-busy') === 'true' || [...el.classList].some(c => token.test(c)) || /^loading\\b/i.test(text);
    if (busy && shown(el)) loading.push(el.tagName.toLowerCase() + '.' + [...el.classList].join('.') + ' "' + (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) + '"');
  }
  return { frames, loading, viewportH: innerHeight, viewportW: innerWidth, dpr: devicePixelRatio };
})()`;

/**
 * Why the embeds are not ready in this state, or null when they are: a visible loading marker, or (with `frames`)
 * a frame not yet laid out. The Interceptor page is judged without `frames`: its frame boxes come from the headless copy.
 */
export function embedsPending(state: EmbedState, opts: { frames: boolean } = { frames: true }): string | null {
  if (state.loading.length) return `loading markers still visible: ${state.loading.slice(0, 4).join("; ")}`;
  const small = opts.frames ? state.frames.filter((f) => f.h < EMBED_MIN_CSS) : [];
  if (small.length) return `${small.length} embedded frame(s) not laid out yet (${small.map((f) => `${f.w}×${f.h} at y ${f.y}`).join(", ")})`;
  return null;
}

/** Ready when the last `still` states have nothing pending and (with `frames`) every frame box held its place and size. */
export function embedsSettled(history: EmbedState[], opts: { frames: boolean } = { frames: true }, still = 3): boolean {
  if (history.length < still) return false;
  const last = history.slice(-still);
  if (last.some((s) => embedsPending(s, opts) !== null)) return false;
  if (!opts.frames) return true;
  const key = (s: EmbedState) => JSON.stringify(s.frames);
  return last.every((s) => key(s) === key(last[0]));
}

/** Poll `read` until the embeds settle, or throw after EMBED_TIMEOUT_MS naming what was still loading. */
async function waitForEmbeds(read: () => Promise<unknown>, url: string, opts: { frames: boolean }): Promise<EmbedState> {
  const history: EmbedState[] = [];
  const deadline = Date.now() + EMBED_TIMEOUT_MS;
  for (;;) {
    const state = (await read()) as EmbedState | null;
    invariant(state && Array.isArray(state.frames) && Array.isArray(state.loading), `embed state unreadable on ${url}`);
    history.push(state);
    if (embedsSettled(history, opts)) return state;
    if (Date.now() > deadline) throw new Error(`embeds on ${url} did not finish loading within ${EMBED_TIMEOUT_MS / 1000} s: ${embedsPending(state, opts) ?? "frame boxes still moving"}`);
    await Bun.sleep(EMBED_POLL_MS);
  }
}

/**
 * An embed's container: the outermost ancestor of a frame that holds no prose of its own (climbing stops below the
 * first ancestor with visible text), named by its tag and classes plus its index among the page's elements that match,
 * so the same container can be found on the Interceptor page, which runs the same HTML.
 */
export interface EmbedBox { selector: string; index: number; x: number; y: number; w: number; h: number }
const CONTAINERS_JS = `(() => {
  const seen = new Set(), out = [];
  for (const f of ${FRAMES_JS}) {
    let el = f;
    while (el.parentElement && el.parentElement !== document.body && !(el.parentElement.innerText || '').replace(/\\s+/g, '').length) el = el.parentElement;
    if (seen.has(el)) continue;
    seen.add(el);
    const selector = el.tagName.toLowerCase() + [...el.classList].map(c => '.' + CSS.escape(c)).join('');
    const r = el.getBoundingClientRect();
    out.push({ selector, index: [...document.querySelectorAll(selector)].indexOf(el), x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) });
  }
  return out;
})()`;

/** One settled embed from the headless copy: its container box (CSS px) and its pixels (PNG at the page's pixel ratio). */
interface EmbedShot { box: EmbedBox; png: Buffer }

/**
 * Open `url` in a headless copy of the pinned browser at the Interceptor page's viewport and pixel ratio, scroll it
 * through once (embed scripts may wait for their frame to near the viewport), wait until every frame is laid out and
 * still and no loading marker shows, and shoot each embed container. The browser runs with Chrome's own sandbox and a
 * throwaway profile, and is killed with every child before this returns. Fails when the embeds never settle.
 */
async function headlessEmbedShots(url: string, view: { w: number; h: number; dpr: number }): Promise<EmbedShot[]> {
  const { browserPath } = await ensureInstalled();
  const profile = mkdtempSync(join(tmpdir(), "ve-embed-"));
  const proc = Bun.spawn([browserPath, "--headless", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-sync", "--hide-scrollbars", "--force-color-profile=srgb", `--window-size=${view.w},${view.h}`, "about:blank"], { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  let cdp: CdpClient | undefined;
  try {
    cdp = await CdpClient.connect(await devtoolsEndpoint(proc.stderr as ReadableStream<Uint8Array>, 20_000), 10_000);
    const c = cdp;
    const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
    const evaluate = async (expression: string): Promise<unknown> => {
      const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId, 60_000);
      if (r?.exceptionDetails) throw new Error(`headless evaluation failed: ${String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split("\n")[0]}`);
      return r?.result?.value;
    };
    let loaded = false;
    c.on((method, _p, sid) => { if (sid === sessionId && method === "Page.loadEventFired") loaded = true; });
    await c.send("Page.enable", {}, sessionId);
    await c.send("Runtime.enable", {}, sessionId);
    await c.send("Emulation.setDeviceMetricsOverride", { width: view.w, height: view.h, deviceScaleFactor: view.dpr, mobile: false }, sessionId);
    await c.send("Page.navigate", { url }, sessionId);
    const deadline = Date.now() + EMBED_TIMEOUT_MS;
    while (!loaded) { invariant(Date.now() < deadline, `headless copy of ${url} did not load within ${EMBED_TIMEOUT_MS / 1000} s`); await Bun.sleep(100); }
    await evaluate(`(async () => { for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight / 2) { scrollTo(0, y); await new Promise(r => setTimeout(r, 150)); } scrollTo(0, 0); return true; })()`);
    await waitForEmbeds(() => evaluate(EMBED_STATE_JS), `${url} (headless)`, { frames: true });
    // The same neutralizing as the capture: a fixed masthead would otherwise sit over any embed scrolled under it.
    await evaluate(NEUTRALIZE_JS);
    const boxes = (await evaluate(CONTAINERS_JS)) as EmbedBox[];
    invariant(Array.isArray(boxes), `embed containers unreadable on ${url} (headless)`);
    const shots: EmbedShot[] = [];
    for (const box of boxes) {
      invariant(box.index >= 0 && box.w > 0 && box.h > 0, `embed container ${box.selector} has no box in the headless copy`);
      // A frame outside the viewport is not painted (its shot comes back blank): bring it in first.
      await evaluate(`(async () => { scrollTo(0, ${Math.max(0, box.y - 16)}); await new Promise(r => setTimeout(r, 600)); return true; })()`);
      const r = await c.send("Page.captureScreenshot", { format: "png", clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 }, captureBeyondViewport: box.h > view.h, fromSurface: true }, sessionId, 60_000);
      shots.push({ box, png: Buffer.from(String(r.data), "base64") });
    }
    return shots;
  } finally {
    cdp?.close();
    const kids = descendants(proc.pid);
    proc.kill("SIGKILL");
    for (const k of kids) { try { process.kill(k, "SIGKILL"); } catch { /* exited with its parent */ } }
    await proc.exited;
    rmSync(profile, { recursive: true, force: true });
  }
}

/** Each container on the Interceptor page: found by selector and index, given its headless height, content hidden. */
function holdContainersJs(boxes: EmbedBox[]): string {
  return `(() => {
    const boxes = ${JSON.stringify(boxes.map(({ selector, index, h }) => ({ selector, index, h })))};
    return boxes.map(b => {
      const el = document.querySelectorAll(b.selector)[b.index];
      if (!el) return null;
      for (const [k, v] of [['height', b.h + 'px'], ['min-height', '0'], ['max-height', 'none'], ['overflow', 'hidden'], ['visibility', 'hidden'], ['box-sizing', 'border-box']]) el.style.setProperty(k, v, 'important');
      el.setAttribute('data-capture-embed', String(b.index));
      return true;
    });
  })()`;
}
/** Where each held container sits on the Interceptor page now (CSS px, page space), in the order they were held. */
function containerBoxesJs(boxes: EmbedBox[]): string {
  return `(() => ${JSON.stringify(boxes.map(({ selector, index }) => ({ selector, index })))}.map(b => { const el = document.querySelectorAll(b.selector)[b.index]; if (!el) return null; const r = el.getBoundingClientRect(); return { selector: b.selector, index: b.index, x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; }))()`;
}

/** Page containers match the headless copy only one for one at the same size within a pixel (positions may differ). */
export function boxesMatch(page: (EmbedBox | null)[], reference: EmbedBox[]): string | null {
  if (page.length !== reference.length) return `the page resolved ${page.length} embed container(s), the headless copy ${reference.length}`;
  const missing = page.findIndex((b) => b === null);
  if (missing >= 0) return `embed container ${reference[missing].selector} #${reference[missing].index + 1} is not on the page`;
  const off = page.findIndex((b, i) => Math.abs(b!.w - reference[i].w) > 1 || Math.abs(b!.h - reference[i].h) > 1);
  return off < 0 ? null : `embed container ${off + 1} is ${page[off]!.w}×${page[off]!.h} on the page, ${reference[off].w}×${reference[off].h} in the headless copy`;
}

/**
 * Open a page for capture in the test context and settle its embeds. A page with frames or loading markers is also
 * shot headless; each embed container on the page is held at its headless size with its own (possibly unloaded)
 * content hidden, and the shots come back to be painted after the clean capture. Then the page's remaining loading
 * markers (a card outside any frame) must clear within the timeout, or the capture fails.
 */
async function openSettled(url: string, ctx: string, scale?: number): Promise<EmbedShot[]> {
  await run(["interceptor", "open", url, "--context", ctx, "--reuse"]);
  await run(["interceptor", "wait-stable", "--context", ctx], { allowFail: true });
  // The site's look is set, never inherited from whatever the test profile last saved (principal directive, 2026-10-25: the blog
  // "should always be rendered in its sepia form"; the profile held a dark theme preference). A changed value reloads.
  const preset = capturePresetFor(url);
  if (Object.keys(preset).length) {
    const changed = (await evalJs(`(() => { const p = ${JSON.stringify(preset)}; let n = 0; for (const [k, v] of Object.entries(p)) if (localStorage.getItem(k) !== v) { localStorage.setItem(k, v); n++; } return n; })()`, ctx, "main")) as number | null;
    invariant(typeof changed === "number", `capture preset not applied on ${url}`);
    if (changed) {
      await run(["interceptor", "navigate", url, "--context", ctx]);
      await run(["interceptor", "wait-stable", "--context", ctx], { allowFail: true });
    }
  }
  // The state read only reads the DOM, which both worlds share, so it takes the isolated-first path: a strict-CSP page
  // (GitHub, 2026-10-24) refuses page-context eval and failed every capture of it as "embed state unreadable".
  const first = (await evalJs(EMBED_STATE_JS, ctx)) as EmbedState | null;
  invariant(first && Array.isArray(first.frames), `embed state unreadable on ${url}`);
  let shots: EmbedShot[] = [];
  if (first.frames.length || first.loading.length) {
    shots = await headlessEmbedShots(url, { w: first.viewportW, h: first.viewportH, dpr: scale ?? first.dpr });
    if (shots.length) {
      const held = (await evalJs(holdContainersJs(shots.map((s) => s.box)), ctx, "main")) as (boolean | null)[];
      invariant(Array.isArray(held) && held.every(Boolean), `embed containers on ${url} not found on the page: ${JSON.stringify(held)}`);
      const mismatch = boxesMatch((await evalJs(containerBoxesJs(shots.map((s) => s.box)), ctx, "main")) as (EmbedBox | null)[], shots.map((s) => s.box));
      invariant(mismatch === null, `embed containers on ${url} could not take their headless size: ${mismatch}`);
      console.log(`embeds: ${shots.length} embed(s) shot headless and held on the page (${shots.map((s) => `${s.box.selector} ${s.box.w}×${s.box.h}`).join(", ")})`);
    }
  }
  await waitForEmbeds(() => evalJs(EMBED_STATE_JS, ctx, "main"), url, { frames: false });
  return shots;
}

/**
 * Paste each headless embed shot into `png` (a DOM-render capture at `dpr` image px per CSS px) at its container's box
 * on the page as captured. A near-uniform shot is an embed that rendered nothing, and fails the capture.
 */
async function paintFrames(ctx: string, png: string, shots: EmbedShot[], dpr: number, scratch: string): Promise<void> {
  if (!shots.length) return;
  const now = (await evalJs(containerBoxesJs(shots.map((s) => s.box)), ctx, "main")) as (EmbedBox | null)[];
  const mismatch = boxesMatch(now, shots.map((s) => s.box));
  invariant(mismatch === null, `embed containers moved before painting: ${mismatch}`);
  const tile = join(scratch, "embed-shot.png");
  try {
    for (const [i, box] of now.entries()) {
      const b = box!;
      writeFileSync(tile, shots[i].png);
      const { out } = await run(["magick", tile, "-colorspace", "Gray", "-format", "%[fx:standard_deviation]", "info:"]);
      invariant(Number(out) >= 0.02, `embed ${b.selector} #${b.index + 1} (${b.w}×${b.h} at y ${b.y}) shot blank (sd ${out.trim()}): it rendered nothing`);
      await run(["magick", png, "(", tile, "-resize", `${Math.round(b.w * dpr)}x${Math.round(b.h * dpr)}!`, ")", "-geometry", `+${Math.round(b.x * dpr)}+${Math.round(b.y * dpr)}`, "-composite", png]);
    }
  } finally {
    rmSync(tile, { force: true });
  }
  console.log(`embeds: ${shots.length} embed(s) painted into the capture`);
}

const NEUTRALIZE_JS = `(() => {
  const kill = ['[id*="cookie" i]','[class*="cookie" i]','[id*="consent" i]','[class*="consent" i]','[class*="newsletter-modal" i]','[class*="popup" i]','[aria-label*="cookie" i]'];
  for (const sel of kill) for (const el of document.querySelectorAll(sel)) { if (el.getBoundingClientRect().height > 40) el.remove(); }
  const style = document.createElement('style');
  style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important} [style*="position: sticky"],[style*="position:sticky"]{position:static!important}';
  document.head.appendChild(style);
  window.scrollTo(0,0);
  // Sticky sits in the flow, so static changes nothing at scroll 0. Fixed sits out of the flow: static would
  // drop it into the flow (a fixed masthead would land mid-page and push the post down), so it
  // becomes absolute at the box it occupies at scroll 0, measured against its containing block.
  const pinned = [];
  for (const el of document.querySelectorAll('*')) { const cs = getComputedStyle(el); if (cs.position === 'sticky') el.style.setProperty('position', 'static', 'important'); else if (cs.position === 'fixed') pinned.push(el); }
  const boxes = pinned.map(el => {
    const r = el.getBoundingClientRect();
    let cb = el.parentElement; while (cb && getComputedStyle(cb).position === 'static') cb = cb.parentElement;
    const c = cb ? cb.getBoundingClientRect() : { left: -window.scrollX, top: -window.scrollY };
    return { el, left: r.left - c.left - (cb ? cb.clientLeft - cb.scrollLeft : 0), top: r.top - c.top - (cb ? cb.clientTop - cb.scrollTop : 0), w: r.width, h: r.height };
  });
  for (const b of boxes) {
    for (const [k, v] of [['position','absolute'],['left',b.left+'px'],['top',b.top+'px'],['right','auto'],['bottom','auto'],['width',b.w+'px'],['height',b.h+'px'],['transform','none'],['margin','0']]) b.el.style.setProperty(k, v, 'important');
  }
  return { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight };
})()`;

/**
 * Interceptor's default screenshot is a DOM render: it clones the page with every computed style inlined,
 * serializes it into an SVG `<foreignObject>` and rasterizes that as an image. An SVG image is its own
 * document and cannot see the page's `@font-face` rules, so every web font falls back to Times while the
 * layout boxes keep the web font's widths. That is why caps faces rendered as lowercase and tags ran into
 * each other. The fix embeds the faces the page actually loaded as data-URL `@font-face` rules
 * inside an inline `<svg><style>`: the renderer skips `<style>` elements but deep-clones inline SVG, so the
 * rules travel into the image. Fonts come from readable stylesheets, or a stylesheet re-fetched when its
 * rules are cross-origin. `missing` names loaded families that could not be embedded; `failed` names
 * fetches that broke. Runs in the page's main world because it awaits promises.
 */
const FONT_STYLE_MARK = "data-capture-fonts";
const EMBED_FONTS_JS = `(async () => {
  const strip = s => s.trim().replace(/^["']|["']$/g, "");
  if (document.readyState !== "complete") await new Promise(ok => addEventListener("load", ok, { once: true }));
  await document.fonts.ready;
  const used = new Set([...document.fonts].filter(f => f.status === "loaded").map(f => strip(f.family)));
  const rules = [], unreadable = [];
  const collect = (list, base) => { for (const r of list) {
    if (r instanceof CSSFontFaceRule) rules.push({ r, base });
    else if (r instanceof CSSImportRule) { try { collect(r.styleSheet.cssRules, r.styleSheet.href || base); } catch { unreadable.push(r.href); } }
    else if (r.cssRules) collect(r.cssRules, base);
  } };
  for (const sheet of document.styleSheets) {
    const base = sheet.href || location.href;
    try { collect(sheet.cssRules, base); continue; } catch {}
    try { const res = await fetch(sheet.href, { credentials: "omit" }); if (!res.ok) throw new Error(String(res.status)); const copy = new CSSStyleSheet(); copy.replaceSync(await res.text()); collect(copy.cssRules, sheet.href); }
    catch { unreadable.push(sheet.href); }
  }
  const toData = async url => { const res = await fetch(url); if (!res.ok) throw new Error(url + " " + res.status); const blob = await res.blob(); return await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = () => no(fr.error); fr.readAsDataURL(blob); }); };
  const cache = new Map(), css = [], embedded = new Set(), failed = new Set();
  let bytes = 0;
  for (const { r, base } of rules) {
    const family = strip(r.style.getPropertyValue("font-family"));
    if (!used.has(family)) continue;
    const first = [...r.style.getPropertyValue("src").matchAll(/url\\(\\s*(["']?)([^"')]+)\\1\\s*\\)\\s*(format\\([^)]*\\))?/g)][0];
    if (!first) continue;
    try {
      const url = new URL(first[2], base).href;
      if (!cache.has(url)) { const data = url.startsWith("data:") ? url : await toData(url); cache.set(url, data); bytes += data.length; }
      const descriptors = ["font-weight", "font-style", "font-stretch", "unicode-range", "font-feature-settings", "size-adjust", "ascent-override", "descent-override", "line-gap-override"]
        .map(d => [d, r.style.getPropertyValue(d)]).filter(([, v]) => v).map(([d, v]) => d + ":" + v + ";").join("");
      css.push("@font-face{font-family:" + JSON.stringify(family) + ";src:url(" + JSON.stringify(cache.get(url)) + ") " + (first[3] || "") + ";" + descriptors + "}");
      embedded.add(family);
    } catch { failed.add(family); }
  }
  for (const old of document.querySelectorAll("svg[${FONT_STYLE_MARK}]")) old.remove();
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("${FONT_STYLE_MARK}", "1"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("width", "0"); svg.setAttribute("height", "0");
  svg.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:hidden";
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = css.join("\\n"); svg.appendChild(style); document.body.appendChild(svg);
  return { embedded: [...embedded], missing: [...used].filter(f => !embedded.has(f)), failed: [...failed], unreadable, faces: css.length, bytes };
})()`;
const REMOVE_FONTS_JS = `(() => { for (const s of document.querySelectorAll("svg[${FONT_STYLE_MARK}]")) s.remove(); return true; })()`;

export interface FontEmbed { embedded: string[]; missing: string[]; failed: string[]; unreadable: (string | null)[]; faces: number; bytes: number }

function isFontEmbed(v: unknown): v is FontEmbed {
  const o = v as FontEmbed | null;
  return !!o && Array.isArray(o.embedded) && Array.isArray(o.missing) && Array.isArray(o.failed) && Array.isArray(o.unreadable) && typeof o.faces === "number" && typeof o.bytes === "number";
}

async function embedFonts(ctx: string): Promise<FontEmbed> {
  const out = await evalJs(EMBED_FONTS_JS, ctx, "main");
  if (!isFontEmbed(out)) throw new Error(`font embed returned an unexpected shape: ${JSON.stringify(out)?.slice(0, 200)}`);
  return out;
}

/**
 * A capture is only trusted once its pixels prove the web fonts applied. Probes are single-line text
 * elements set in an embedded web font whose width in that font differs from the fallback's by a clear
 * margin (8% and 0.6em at least). In the disposable marked shot each probe's glyphs are painted a marker
 * colour; the width of those glyph pixels must sit nearer the web-font width than the fallback width.
 */
const MAX_PROBES = 8;
function fontProbesJs(families: string[], colors: number[][]): string {
  return `(() => {
    const web = new Set(${JSON.stringify(families)}), colors = ${JSON.stringify(colors)};
    const generic = new Set(["serif","sans-serif","monospace","cursive","fantasy","system-ui","ui-serif","ui-sans-serif","ui-monospace","ui-rounded","math","emoji","-apple-system","BlinkMacSystemFont"]);
    const strip = s => s.trim().replace(/^["']|["']$/g, "");
    const cased = (t, tt) => tt === "uppercase" ? t.toUpperCase() : tt === "lowercase" ? t.toLowerCase() : tt === "capitalize" ? t.replace(/(^|\\s)(\\S)/g, (_, a, b) => a + b.toUpperCase()) : t;
    const ctx = document.createElement("canvas").getContext("2d");
    const found = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (el.children.length || el.closest("svg, script, style, noscript, template")) continue;
      const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
      if (text.length < 6) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility !== "visible" || Number(cs.opacity) === 0) continue;
      let faded = false;
      for (let a = el.parentElement; a; a = a.parentElement) { const s = getComputedStyle(a); if (Number(s.opacity) < 1 || s.filter !== "none" || s.mixBlendMode !== "normal") { faded = true; break; } }
      if (faded) continue;
      const families = cs.fontFamily.split(",").map(strip);
      if (!web.has(families[0])) continue;
      const range = document.createRange(); range.selectNodeContents(el);
      const lines = [...range.getClientRects()].filter(r => r.width > 0), size = parseFloat(cs.fontSize);
      if (!lines.length || lines.some(r => Math.abs(r.top - lines[0].top) > size * 0.5)) continue;
      const live = range.getBoundingClientRect().width;
      const fallbackList = families.slice(1).filter(f => !web.has(f)).map(f => generic.has(f) ? f : JSON.stringify(f)).join(", ") || "serif";
      ctx.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + fallbackList;
      ctx.letterSpacing = cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing;
      ctx.wordSpacing = cs.wordSpacing === "normal" ? "0px" : cs.wordSpacing;
      const fallback = ctx.measureText(cased(text, cs.textTransform)).width, gap = Math.abs(fallback - live);
      if (live < 40 || gap < Math.max(0.08 * live, 0.6 * size)) continue;
      found.push({ el, family: families[0], text: text.slice(0, 40), live, fallback, fontSize: size, score: gap / live });
    }
    found.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const f of found) if (picked.length < colors.length && !picked.some(p => p.family === f.family)) picked.push(f);
    for (const f of found) if (picked.length < colors.length && !picked.includes(f)) picked.push(f);
    return picked.map((p, i) => {
      const cs = getComputedStyle(p.el), rgb = "rgb(" + colors[i].join(",") + ")";
      p.el.setAttribute("data-capture-probe", p.el.getAttribute("style") ?? "");
      for (const side of ["top", "right", "bottom", "left"]) p.el.style.setProperty("border-" + side + "-color", cs.getPropertyValue("border-" + side + "-color"), "important");
      p.el.style.setProperty("outline-color", cs.outlineColor, "important");
      p.el.style.setProperty("color", rgb, "important");
      p.el.style.setProperty("-webkit-text-fill-color", rgb, "important");
      p.el.style.setProperty("text-decoration-color", "transparent", "important");
      p.el.style.setProperty("text-shadow", "none", "important");
      p.el.style.setProperty("opacity", "1", "important");
      p.el.style.setProperty("filter", "none", "important");
      p.el.style.setProperty("mix-blend-mode", "normal", "important");
      return { id: "probe" + (i + 1), family: p.family, text: p.text, live: p.live, fallback: p.fallback, fontSize: p.fontSize };
    });
  })()`;
}
const CLEAR_MARKS_JS = `(() => {
  for (const s of document.querySelectorAll('[data-post-sentence]')) s.replaceWith(...s.childNodes);
  for (const el of document.querySelectorAll('[data-capture-probe]')) { const s = el.getAttribute('data-capture-probe'); if (s) el.setAttribute('style', s); else el.removeAttribute('style'); el.removeAttribute('data-capture-probe'); }
  return true;
})()`;

export interface FontProbe { id: string; family: string; text: string; live: number; fallback: number; fontSize: number }
export interface ProbeResult extends FontProbe { ink: number | null; ok: boolean }

/** Glyph-pixel width (image pixels) against the probe's CSS widths: nearer the web-font width than the fallback's passes. */
export function probeVerdict(probe: FontProbe, inkPx: number | null, dpr: number): ProbeResult {
  invariant(dpr > 0, "probe verdict needs a positive device pixel ratio");
  if (inkPx === null || inkPx <= 0) return { ...probe, ink: null, ok: false };
  const ink = inkPx / dpr;
  return { ...probe, ink, ok: Math.abs(ink - probe.live) < Math.abs(probe.fallback - probe.live) / 2 };
}

/** Every probe that drew pixels must pass, and at least one must have drawn. */
export function fontsApplied(results: ProbeResult[]): boolean {
  const drawn = results.filter((r) => r.ink !== null);
  return drawn.length > 0 && drawn.every((r) => r.ok);
}

export class FontsNotApplied extends Error {}

/**
 * Selector forms: a CSS selector, or `text:<phrase>` which resolves to the SMALLEST element whose
 * text contains the phrase (case- and whitespace-insensitive). The text form survives pages with no
 * usable structure (old HTML, generated class names) and anchors the zoom to the content itself.
 */
const MARK = "#FF00FE";
const MARK_PX = 4; // css px of outline; measured box is inset by MARK_PX * dpr on each side

function finderJs(selector: string): string {
  return selector.startsWith("text:")
    ? `(() => { const want = ${JSON.stringify(selector.slice(5))}.toLowerCase().replace(/\\s+/g, " ").trim(); let best = null; for (const el of document.body.querySelectorAll("*")) { if (["SCRIPT","STYLE","NOSCRIPT"].includes(el.tagName)) continue; const t = (el.textContent || "").toLowerCase().replace(/\\s+/g, " "); if (!t.includes(want)) continue; if (!best || t.length < (best.textContent || "").length) best = el; } return best; })()`
    : `document.querySelector(${JSON.stringify(selector)})`;
}

/** Outline the element in the marker colour (on) or clear it (off); returns whether it was found. */
function markJs(selector: string, on: boolean): string {
  const style = on ? `el.style.setProperty("outline", "${MARK_PX}px solid ${MARK}", "important"); el.style.setProperty("outline-offset", "0px", "important"); el.style.setProperty("box-shadow", "none", "important");` : `el.style.removeProperty("outline"); el.style.removeProperty("outline-offset"); el.style.removeProperty("box-shadow");`;
  return `(() => { const el = ${finderJs(selector)}; if (!el) return { found: false }; ${style} return { found: true }; })()`;
}

/** Bounding box of the pixels that differ between the marked and clean captures, inset by the outline width. */
export async function markedRegion(markedPng: string, cleanPng: string, dpr: number): Promise<Region | null> {
  const { out } = await run(["magick", markedPng, cleanPng, "-compose", "difference", "-composite", "-colorspace", "Gray", "-threshold", "12%", "-format", "%@ %w %h", "info:"], { allowFail: true });
  const m = out.trim().match(/^(\d+)x(\d+)\+(\d+)\+(\d+) (\d+) (\d+)$/);
  if (!m) return null;
  const [, w, h, x, y, pw, ph] = m.map(Number);
  const inset = Math.round(MARK_PX * dpr);
  if (w <= inset * 2 || h <= inset * 2) return null;
  return { x: x + inset, y: y + inset, w: w - inset * 2, h: h - inset * 2, pageWidth: pw, pageHeight: ph };
}

/**
 * Isolated-world eval first; strict-CSP pages refuse it, so fall back to the page context (--main).
 * `main` goes straight to the page context, for scripts that await promises or use page-origin fetch.
 */
async function evalJs(js: string, ctx: string, world: "isolated-first" | "main" = "isolated-first"): Promise<unknown> {
  for (const extra of world === "main" ? [["--main"]] : [[], ["--main"]]) {
    const { out, err } = await run(["interceptor", "eval", js, "--context", ctx, ...extra], { allowFail: true });
    const text = out + err;
    if (/CSP blocks eval|Isolated eval is unavailable|chrome.userScripts.execute is unavailable/i.test(text)) continue;
    if (/^error:/m.test(text)) throw new Error(`interceptor eval failed: ${text.slice(-300)}`);
    return parseEval(out);
  }
  throw new Error("interceptor eval refused in both worlds (CSP)");
}

function parseEval(out: string): unknown {
  const trimmed = out.replace(/^\[[0-9a-f]+\] → \w+\s*$/m, "").trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const m = trimmed.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

async function imageSize(png: string): Promise<{ width: number; height: number }> {
  const { out } = await run(["magick", "identify", "-format", "%w %h", png]);
  const [w, h] = out.trim().split(" ").map(Number);
  invariant(w > 0 && h > 0, `unreadable image ${png}`);
  return { width: w, height: h };
}

interface SentenceRegion { id: string; p: string; i0: number; i1: number; rects: { x: number; y: number; w: number; h: number }[] }
/** Bumped when the marker pass measures something new (2: the title box; 3: the web-font proof), so an older cache re-captures. */
const SENTENCE_CAPTURE_VERSION = 5;
/**
 * The post page is rendered at 3 image px per CSS px, whatever the display's ratio, so the reading camera only ever
 * shrinks it (READ.maxScale: an enlarged capture reads as pixelated text). At a display ratio of 2, ordinary body
 * text lands below the reading size and the camera would have to enlarge it.
 */
export const POST_CAPTURE_SCALE = 3;
export interface FontCheck { ok: boolean; embedded: string[]; probes: ProbeResult[]; attempts: number }
interface SentenceCapture { version?: number; pageWidth: number; pageHeight: number; sentences: SentenceRegion[]; postHash: string; title?: { x: number; y: number; w: number; h: number }; fonts?: FontCheck }

/**
 * Which page blocks carry narrated prose, mirroring Ingest parseMarkdown. A main-text paragraph or list item always.
 * Nothing inside an aside, ever. Inside a blockquote or any quote-shaped element (a rendered pull-quote component),
 * or a blockquote itself (a quote component may render its text straight into one): only when its visible text is
 * one of the paragraphs Ingest narrated as a block quote (`quoteTexts`, normalized like `text`), so an attributed
 * quote, a callout or a pull quote, none of which Ingest narrates, never matches. Self-contained: it is serialized
 * into the page with toString.
 */
export function isNarratedBlock(tag: string, ancestorTags: string[], text = "", quoteTexts: string[] = []): boolean {
  const own = tag.toUpperCase(), above = ancestorTags.map((t) => t.toUpperCase());
  if (own === "ASIDE" || above.includes("ASIDE")) return false;
  const quoted = own === "BLOCKQUOTE" || above.some((t) => t.includes("QUOTE"));
  if (!quoted) return own === "P" || own === "LI";
  return ["P", "LI", "BLOCKQUOTE"].includes(own) && text !== "" && quoteTexts.includes(text);
}

function sentenceData(post: Post) {
  return post.paragraphs.map(p => ({ ...p, sentences: sentencesOf(p.text).map((s, i) => ({ ...s, id: `${p.id}.s${i + 1}`, p: p.id })) }));
}

/** One text node of a page element; `skip` marks attribution Ingest never narrates (a trailing cite, a caption). */
export interface TextPiece { text: string; skip: boolean }
export interface NodeSlice { node: number; a: number; b: number; id: string }

/**
 * Where each sentence of a paragraph sits in an element's text nodes, or null when the element's prose
 * does not have the paragraph's word count. Mirrors Ingest: attribution is not prose, and a leading
 * emoji run (a paragraph's icon) is not a word. Runs in the page too (serialized into the marker script),
 * so it must stay self-contained.
 */
export function proseSlices(pieces: TextPiece[], wordCount: number, sentences: { id: string; i0: number; i1: number }[]): NodeSlice[] | null {
  let text = "";
  const starts: number[] = [];
  for (const piece of pieces) { starts.push(text.length); if (!piece.skip) text += piece.text; }
  const lead = (text.match(/^[\s\p{Extended_Pictographic}️‍]*/u) ?? [""])[0].length;
  const tokens = [...text.slice(lead).matchAll(/\S+/g)].map((m) => ({ start: lead + m.index!, end: lead + m.index! + m[0].length }));
  if (tokens.length !== wordCount || sentences.some((s) => s.i0 < 0 || s.i1 >= tokens.length || s.i1 < s.i0)) return null;
  const slices: NodeSlice[] = [];
  for (const s of sentences) {
    const start = tokens[s.i0].start, end = tokens[s.i1].end;
    pieces.forEach((piece, n) => {
      if (piece.skip) return;
      const a = Math.max(0, start - starts[n]), b = Math.min(piece.text.length, end - starts[n]);
      if (b > a) slices.push({ node: n, a, b, id: s.id });
    });
  }
  return slices;
}

/** Wrap text-node slices without replacing links or changing paragraph layout. */
function markSentencesJs(post: Post): string {
  const paragraphs = sentenceData(post);
  let index = 0;
  const payload = paragraphs.map(p => ({ id: p.id, text: p.text, kind: p.kind, words: p.text.trim().split(/\s+/).length, sentences: p.sentences.map(s => ({ id: s.id, i0: s.i0, i1: s.i1, color: sentenceColor(index++) })) }));
  return `(() => {
    const proseSlices = ${proseSlices.toString()};
    const isNarratedBlock = ${isNarratedBlock.toString()};
    const paragraphs = ${JSON.stringify(payload)};
    const titleColor = ${JSON.stringify(sentenceColor(index))}, title = ${JSON.stringify(post.title)};
    const norm = s => s.toLowerCase().replace(/[’‘]/g,"'").replace(/[^a-z0-9]+/g," ").trim();
    const root = document.querySelector('article') || document.querySelector('main') || document.body;
    const ancestors = el => { const tags = []; for (let a = el.parentElement; a; a = a.parentElement) tags.push(a.tagName); return tags; };
    const piecesOf = el => {
      const trailing = a => { const r = document.createRange(); r.setStartAfter(a); r.setEnd(el, el.childNodes.length); return !r.toString().trim(); };
      const skip = [...el.querySelectorAll('figcaption,caption,cite')].filter(a => a.tagName !== 'CITE' || trailing(a));
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const nodes = []; let node;
      while (node = walker.nextNode()) nodes.push(node);
      return { nodes, pieces: nodes.map(n => ({ text: n.textContent || '', skip: skip.some(a => a.contains(n)) })) };
    };
    const visible = el => norm(piecesOf(el).pieces.filter(x => !x.skip).map(x => x.text).join(''));
    const quoteTexts = paragraphs.filter(p => p.kind === 'blockquote').map(p => norm(p.text));
    const candidates = [...root.querySelectorAll('p,li,blockquote')].filter(el => isNarratedBlock(el.tagName, ancestors(el), visible(el), quoteTexts));
    const used = new Set(); let matched = 0;
    for (const p of paragraphs) {
      let hit = null;
      for (const el of candidates) {
        if (used.has(el)) continue;
        const { nodes, pieces } = piecesOf(el);
        if (norm(pieces.filter(x => !x.skip).map(x => x.text).join('')) !== norm(p.text)) continue;
        const slices = proseSlices(pieces, p.words, p.sentences);
        if (slices) { hit = { el, nodes, slices }; break; }
      }
      if (!hit) continue;
      used.add(hit.el);
      const colors = new Map(p.sentences.map(s => [s.id, s.color]));
      hit.nodes.forEach((n, i) => {
        const cuts = hit.slices.filter(s => s.node === i).sort((x, y) => x.a - y.a);
        if (!cuts.length) return;
        const text = n.textContent; const fragment = document.createDocumentFragment(); let pos = 0;
        for (const c of cuts) {
          fragment.append(document.createTextNode(text.slice(pos, c.a)));
          const span = document.createElement('span'); span.dataset.postSentence = c.id;
          span.style.setProperty('background-color', 'rgb(' + colors.get(c.id).join(',') + ')', 'important');
          span.style.setProperty('box-shadow', 'none', 'important');
          span.textContent = text.slice(c.a, c.b); fragment.append(span); pos = c.b;
        }
        fragment.append(document.createTextNode(text.slice(pos))); n.replaceWith(fragment);
      });
      matched += p.sentences.length;
    }
    // The title gets the next marker colour, so the camera can open on the post's head.
    const heading = [...document.querySelectorAll('h1')].find(h => norm(h.textContent || '') === norm(title));
    if (heading) {
      const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT); const nodes = []; let node;
      while (node = walker.nextNode()) if ((node.textContent || '').trim()) nodes.push(node);
      for (const n of nodes) {
        const span = document.createElement('span'); span.dataset.postSentence = 'title';
        span.style.setProperty('background-color', 'rgb(' + titleColor.join(',') + ')', 'important');
        span.textContent = n.textContent; n.replaceWith(span);
      }
    }
    return {matched, title: !!heading};
  })()`;
}

function sentenceColor(i: number): number[] {
  // Up to 4,096 distinct saturated markers, never inferred from CSS coordinates.
  return [16 + (i % 16) * 15, 16 + (Math.floor(i / 16) % 16) * 15, 16 + (Math.floor(i / 256) % 16) * 15];
}

async function rgbPixels(path: string): Promise<Buffer> {
  const p = Bun.spawn(["magick", path, "-alpha", "off", "-depth", "8", "rgb:-"], { stdout: "pipe", stderr: "pipe" });
  const [data, err, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  invariant(code === 0, `pixel decode failed: ${err.slice(-200)}`);
  return Buffer.from(data);
}

/** The box around a set of line rects. */
export function unionRect(rects: { x: number; y: number; w: number; h: number }[]): { x: number; y: number; w: number; h: number } {
  invariant(rects.length > 0, "union of no rects");
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}

/**
 * A sentence's real rects are its highlighted line boxes, all one line height. Anti-aliased ink that moved between
 * the clean and the marked shot can land exactly on a marker colour and add slivers far from the sentence (slivers a few pixels tall
 * under the masthead make the read camera cut to the top of the post mid-paragraph). Rects shorter than half the sentence's tallest rect are those slivers.
 */
export function dropStrayRects<R extends { h: number }>(rects: R[]): R[] {
  if (rects.length < 2) return rects;
  const tallest = Math.max(...rects.map((r) => r.h));
  return rects.filter((r) => r.h * 2 >= tallest);
}

/** Palette slots after the sentences: the title takes the first, font probes the ones after it. */
function probeColors(post: Post, count: number): number[][] {
  const base = sentenceData(post).reduce((n, p) => n + p.sentences.length, 0) + 1;
  invariant(base + count < 4096, "sentence marker palette exhausted");
  return Array.from({ length: count }, (_, i) => sentenceColor(base + i));
}

async function sentenceRegions(clean: string, marked: string, post: Post, probeCount: number): Promise<SentenceCapture & { probeInk: (number | null)[] }> {
  const size = await imageSize(clean), markedSize = await imageSize(marked);
  invariant(size.width === markedSize.width && size.height === markedSize.height, `sentence pass reflowed between captures: clean ${size.width}×${size.height}, marked ${markedSize.width}×${markedSize.height}`);
  const sentences: SentenceRegion[] = sentenceData(post).flatMap(p => p.sentences.map(({ text: _text, ...s }) => ({ ...s, rects: [] })));
  invariant(sentences.length + 1 + probeCount < 4096, "sentence marker palette exhausted");
  const colors = new Map(sentences.map((_, i) => [sentenceColor(i).join(","), i]));
  // One slot past the sentences marks the title (markSentencesJs paints it); its rects are collected like a sentence's.
  const titleSlot: SentenceRegion = { id: "title", p: "", i0: 0, i1: 0, rects: [] };
  colors.set(sentenceColor(sentences.length).join(","), sentences.length);
  const probeSlots: SentenceRegion[] = Array.from({ length: probeCount }, (_, i) => ({ id: `probe${i + 1}`, p: "", i0: 0, i1: 0, rects: [] }));
  probeSlots.forEach((_, i) => colors.set(sentenceColor(sentences.length + 1 + i).join(","), sentences.length + 1 + i));
  const slots = [...sentences, titleSlot, ...probeSlots];
  const [a, b] = await Promise.all([rgbPixels(clean), rgbPixels(marked)]);
  invariant(a.length === b.length && b.length === size.width * size.height * 3, "unexpected pixel buffer size");
  // Row extents coalesce into line rectangles. Glyph holes do not fragment a line.
  for (let y = 0; y < size.height; y++) {
    const row = new Map<number, { x: number; end: number }>();
    for (let x = 0; x < size.width; x++) {
      const k = (y * size.width + x) * 3;
      if (Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2]) < 24) continue;
      const id = colors.get(`${b[k]},${b[k + 1]},${b[k + 2]}`);
      if (id === undefined) continue;
      const r = row.get(id); if (r) r.end = x; else row.set(id, { x, end: x });
    }
    for (const [id, r] of row) {
      const rects = slots[id].rects, last = rects.at(-1);
      if (last && last.y + last.h === y && r.x <= last.x + last.w && r.end >= last.x) {
        const end = Math.max(last.x + last.w, r.end + 1); last.x = Math.min(last.x, r.x); last.w = end - last.x; last.h++;
      } else rects.push({ x: r.x, y, w: r.end - r.x + 1, h: 1 });
    }
  }
  for (const s of sentences) s.rects = dropStrayRects(s.rects);
  const title = titleSlot.rects.length ? unionRect(titleSlot.rects) : undefined;
  const probeInk = probeSlots.map((p) => (p.rects.length ? unionRect(p.rects).w : null));
  return { version: SENTENCE_CAPTURE_VERSION, pageWidth: size.width, pageHeight: size.height, sentences, postHash: sha256(JSON.stringify(post)), ...(title ? { title } : {}), probeInk };
}

/**
 * Where the post page is loaded for its capture: run.json captureUrl (a local draft the live site does not have
 * yet; https, or http on loopback) or else the post's own https URL. The video's browser chrome always shows the
 * post's own URL.
 */
export function postCaptureUrl(meta: Pick<RunMeta, "captureUrl">, post: Pick<Post, "url">): string {
  if (meta.captureUrl !== undefined) return validCaptureUrl(meta.captureUrl);
  invariant(/^https:\/\//.test(post.url), "post capture needs an https URL (or run.json captureUrl for a local draft)");
  return post.url;
}

/** Attempts at a post capture whose pixels prove the web fonts applied; each re-opens the page. */
const FONT_ATTEMPTS = 3;

async function capturePost(runDir: string, ctx: string, captureSh: string, force: boolean): Promise<void> {
  const paths = runPaths(runDir), post = readJson<Post>(join(paths.source, "post.json"));
  const png = join(paths.assets, "post.png"), meta = join(paths.assets, "post.meta.json"), regions = join(paths.assets, "post.sentences.json");
  const url = postCaptureUrl(readJson<RunMeta>(paths.meta), post);
  if (!force && [png, meta, regions].every(existsSync) && readJson<CaptureMeta>(meta).url === url && (({ postHash, version, fonts }) => postHash === sha256(JSON.stringify(post)) && version === SENTENCE_CAPTURE_VERSION && fonts?.ok === true)(readJson<SentenceCapture>(regions))) return;
  for (let attempt = 1; ; attempt++) {
    try { return await shootPost(post, url, paths.assets, ctx, captureSh, attempt); }
    catch (e) {
      if (!(e instanceof FontsNotApplied) || attempt >= FONT_ATTEMPTS) throw e;
      console.log(`post capture attempt ${attempt}: ${e.message} — retrying`);
      await run(["interceptor", "wait", "1500", "--context", ctx], { allowFail: true });
    }
  }
}

/**
 * One post capture: a clean shot and a marked shot of the same styled page. The marked shot paints each
 * sentence background and each font probe's glyphs; the probes decide whether the web fonts applied, and
 * only a capture that passes replaces post.png.
 */
async function shootPost(post: Post, url: string, assets: string, ctx: string, captureSh: string, attempt: number): Promise<void> {
  const png = join(assets, "post.png"), meta = join(assets, "post.meta.json"), regions = join(assets, "post.sentences.json");
  const clean = join(assets, "post.clean.png"), marked = join(assets, "post.marked.png"), painted = join(assets, "post.painted.png");
  const shots = await openSettled(url, ctx, POST_CAPTURE_SCALE);
  const settled = (await evalJs(SETTLE_JS, ctx, "main")) as { h?: number; still?: boolean; pending?: number } | null;
  if (!settled?.still) console.log(`post capture: the page height had not held still before the shot (${JSON.stringify(settled)})`);
  const dims = (await evalJs(NEUTRALIZE_JS, ctx)) as { w?: number } | null;
  invariant(typeof dims?.w === "number" && dims.w > 0, "page width unreadable before the post capture");
  try {
    const fonts = await embedFonts(ctx);
    if (fonts.missing.length) throw new FontsNotApplied(`web fonts not embeddable: ${fonts.missing.join(", ")} (failed: ${fonts.failed.join(", ") || "none"}; unreadable sheets: ${fonts.unreadable.length})`);
    await run([captureSh, "--current", "--full", "--scale", String(POST_CAPTURE_SCALE), "--out", clean]);
    // A --pixel fallback inside Capture.sh cannot honour the scale; a capture at any other ratio is refused.
    const cleanWidth = (await imageSize(clean)).width;
    invariant(Math.abs(cleanWidth - dims.w * POST_CAPTURE_SCALE) <= POST_CAPTURE_SCALE, `post capture is ${cleanWidth} px wide for a ${dims.w} CSS px page, not ${POST_CAPTURE_SCALE}x`);
    // Frames are painted into a copy: the sentence pass compares the DOM-render pair, where frames are blank in both.
    copyFileSync(clean, painted);
    await paintFrames(ctx, painted, shots, (await imageSize(clean)).width / dims.w, assets);
    const probes = fonts.embedded.length ? (await evalJs(fontProbesJs(fonts.embedded, probeColors(post, MAX_PROBES)), ctx, "main")) as FontProbe[] : [];
    invariant(Array.isArray(probes), "font probe script returned no list");
    await evalJs(markSentencesJs(post), ctx);
    if (fonts.embedded.length && !probes.length) throw new Error(`no font probe found on ${url}: web fonts ${fonts.embedded.join(", ")} are embedded but no single-line text tells them from the fallback`);
    await run([captureSh, "--current", "--full", "--scale", String(POST_CAPTURE_SCALE), "--out", marked]);
    const { probeInk, ...result } = await sentenceRegions(clean, marked, post, probes.length);
    const dpr = result.pageWidth / dims.w;
    const checked = probes.map((p, i) => probeVerdict(p, probeInk[i] ?? null, dpr));
    const table = checked.map((p) => `${p.ink === null ? "·" : p.ok ? "✓" : "✗"} ${p.family} "${p.text}" live ${p.live.toFixed(1)} fallback ${p.fallback.toFixed(1)} drawn ${p.ink === null ? "none" : p.ink.toFixed(1)}`).join("; ");
    if (probes.length && !fontsApplied(checked)) throw new FontsNotApplied(`web fonts did not apply in the capture: ${table}`);
    const check: FontCheck = { ok: true, embedded: fonts.embedded, probes: checked, attempts: attempt };
    renameSync(painted, png);
    writeJson(regions, { ...result, fonts: check } satisfies SentenceCapture);
    writeJson(meta, { url, file: png, capturedAt: new Date().toISOString(), width: result.pageWidth, height: result.pageHeight } satisfies CaptureMeta);
    console.log(`post fonts: ${fonts.faces} faces embedded (${(fonts.bytes / 1024).toFixed(0)} KiB); ${checked.filter((p) => p.ok).length}/${checked.length} probes drawn in the web font${table ? ` — ${table}` : ""}`);
    console.log(`post sentence regions: ${result.sentences.filter(s => s.rects.length).length}/${result.sentences.length}${result.title ? " + title" : " (title not found)"}`);
  } finally {
    await evalJs(CLEAR_MARKS_JS, ctx);
    await evalJs(REMOVE_FONTS_JS, ctx);
    rmSync(marked, { force: true });
    rmSync(clean, { force: true });
    rmSync(painted, { force: true });
  }
}

export async function capture(runDir: string, opts: { force?: boolean; only?: string; log?: (s: string) => void } = {}): Promise<void> {
  const log = opts.log ?? ((s) => console.log(s));
  const paths = runPaths(runDir);
  ensureDir(paths.assets);
  const ctx = testContextId();
  const captureSh = join(getSkillsDir(), "Interceptor", "Tools", "Capture.sh");
  invariant(existsSync(captureSh), `Interceptor Capture.sh missing at ${captureSh}`);
  const voice = existsSync(paths.meta) && readJson<RunMeta>(paths.meta).mode === "voice";
  if (voice && (!opts.only || opts.only === "post")) await capturePost(runDir, ctx, captureSh, !!opts.force);
  const beats = captureBeats(loadScript(runDir).beats).filter((b) => !opts.only || b.id === opts.only);
  for (const b of beats) {
    const v = b.visual as { type: string; url: string; selector?: string };
    const png = join(paths.assets, `${b.id}.png`);
    const metaPath = join(paths.assets, `${b.id}.meta.json`);
    const regionPath = join(paths.assets, `${b.id}.region.json`);
    const wantRegion = v.type === "zoom" || (v.type === "screenshot" && !!v.selector);
    if (!opts.force && existsSync(png) && existsSync(metaPath)) {
      const meta = readJson<CaptureMeta>(metaPath);
      if (meta.url === v.url && meta.selector === v.selector && (!wantRegion || existsSync(regionPath))) { log(`· ${b.id} cached`); continue; }
    }
    log(`📷 ${b.id} ← ${v.url}`);
    const shots = await openSettled(v.url, ctx);
    await run(["interceptor", "wait", "1200", "--context", ctx], { allowFail: true });
    const dims = (await evalJs(NEUTRALIZE_JS, ctx)) as { w?: number; h?: number } | null;
    const fonts = await embedFonts(ctx);
    if (fonts.missing.length) log(`  ⚠ ${b.id}: web fonts not embeddable, they render in a fallback face: ${fonts.missing.join(", ")}`);
    const r = await run([captureSh, "--current", "--full", "--out", png], { allowFail: true });
    invariant(r.code === 0 && existsSync(png), `${b.id}: Capture.sh exit ${r.code}: ${r.err.slice(-300)}`);
    const size = await imageSize(png);
    if (wantRegion) {
      const marked = (await evalJs(markJs(v.selector!, true), ctx)) as { found: boolean } | null;
      invariant(marked?.found, `${b.id}: selector ${v.selector} not found on ${v.url}`);
      const markedPng = join(paths.assets, `${b.id}.marked.png`);
      const rm = await run([captureSh, "--current", "--full", "--out", markedPng], { allowFail: true });
      await evalJs(markJs(v.selector!, false), ctx);
      invariant(rm.code === 0 && existsSync(markedPng), `${b.id}: marked Capture.sh exit ${rm.code}: ${rm.err.slice(-300)}`);
      const msize = await imageSize(markedPng);
      invariant(msize.width === size.width && msize.height === size.height, `${b.id}: marked capture ${msize.width}×${msize.height} differs from the clean one ${size.width}×${size.height} — page reflowed between shots`);
      const dpr = dims?.w ? size.width / dims.w : 2;
      const region = await markedRegion(markedPng, png, dpr);
      rmSync(markedPng, { force: true });
      invariant(region, `${b.id}: the outlined element left no pixel difference — off-canvas or covered`);
      writeJson(regionPath, region);
      log(`  ▭ ${b.id} region ${region.w}×${region.h} at ${region.x},${region.y} (pixels)`);
    }
    await paintFrames(ctx, png, shots, dims?.w ? size.width / dims.w : 2, paths.assets);
    await evalJs(REMOVE_FONTS_JS, ctx);
    // An image URL is the original file at its own pixels, never a screenshot of Chrome's image viewer: the viewer fit
    // the image to the window and the 2x capture scaled it back up, which cost about a third of its edge detail and read
    // as blur (principal directive, 2026-10-24), and its dark page read as letterbox bands. A region still uses
    // the screenshot, so its coordinates stay in the screenshot's pixel space.
    let kept = size, css = dims;
    if (isImageUrl(v.url) && !wantRegion) {
      const res = await fetch(v.url, { signal: AbortSignal.timeout(60_000) });
      invariant(res.ok, `${b.id}: ${v.url} answered ${res.status}`);
      const src = `${png}.src`;
      await Bun.write(src, new Uint8Array(await res.arrayBuffer()));
      await run(["magick", ...(/\.svg$/i.test(new URL(v.url).pathname) ? ["-density", "300"] : []), src, "-strip", png]);
      rmSync(src, { force: true });
      kept = await imageSize(png);
      css = { w: Math.round(kept.width / 2), h: Math.round(kept.height / 2) };
      log(`  ⤓ ${b.id} original image at its own pixels: ${kept.width}×${kept.height}`);
    }
    writeJson(metaPath, { url: v.url, selector: v.selector, file: png, capturedAt: new Date().toISOString(), ...kept, cssWidth: css?.w, cssHeight: css?.h } satisfies CaptureMeta);
  }
  log(`✓ ${beats.length} capture beats ready`);
}

export async function verifyCaptures(runDir: string): Promise<{ ok: boolean; problems: string[] }> {
  const paths = runPaths(runDir);
  const problems: string[] = [];
  if (existsSync(paths.meta) && readJson<RunMeta>(paths.meta).mode === "voice") {
    const post = readJson<Post>(join(paths.source, "post.json"));
    const regionPath = join(paths.assets, "post.sentences.json");
    if (![regionPath, join(paths.assets, "post.png"), join(paths.assets, "post.meta.json")].every(existsSync)) problems.push("post capture or sentence regions missing");
    else {
      const r = readJson<SentenceCapture>(regionPath), expected = sentenceData(post).flatMap(p => p.sentences);
      const found = expected.filter(s => r.sentences.some(x => x.id === s.id && x.i0 === s.i0 && x.i1 === s.i1 && x.rects.some(b => b.w > 0 && b.h > 0 && b.x >= 0 && b.y >= 0 && b.x + b.w <= r.pageWidth && b.y + b.h <= r.pageHeight))).length;
      const coverage = found / Math.max(1, expected.length);
      console.log(`post sentence coverage: ${found}/${expected.length} (${(100 * coverage).toFixed(2)}%)`);
      if (coverage < 0.9) problems.push("post sentence coverage below 90%");
      if (r.postHash !== sha256(JSON.stringify(post))) problems.push("post sentence capture is stale");
      if (r.version !== SENTENCE_CAPTURE_VERSION) problems.push(`post capture is version ${r.version ?? 1}, want ${SENTENCE_CAPTURE_VERSION} — re-capture with --force`);
      if (r.fonts?.ok !== true) problems.push("post capture carries no passing web-font check");
      else console.log(`post fonts: ${r.fonts.probes.filter((p) => p.ok).length}/${r.fonts.probes.length} probes drawn in the web font (${r.fonts.embedded.join(", ")})`);
      const size = await imageSize(join(paths.assets, "post.png"));
      if (size.width !== r.pageWidth || size.height !== r.pageHeight) problems.push("sentence regions differ from post image dimensions");
    }
  }
  for (const b of captureBeats(loadScript(runDir).beats)) {
    const v = b.visual as { type: string; url: string; selector?: string };
    const png = join(paths.assets, `${b.id}.png`);
    const metaPath = join(paths.assets, `${b.id}.meta.json`);
    if (!existsSync(png)) { problems.push(`${b.id}: capture missing`); continue; }
    if (!existsSync(metaPath)) { problems.push(`${b.id}: meta missing`); continue; }
    const meta = readJson<CaptureMeta>(metaPath);
    if (meta.url !== v.url) problems.push(`${b.id}: capture is of ${meta.url}, script wants ${v.url}`);
    const { out } = await run(["magick", png, "-colorspace", "Gray", "-format", "%[fx:standard_deviation]", "info:"]);
    if (Number(out) < 0.02) problems.push(`${b.id}: capture is near-uniform (blank)`);
    if (v.type === "zoom" || (v.type === "screenshot" && v.selector)) {
      const rp = join(paths.assets, `${b.id}.region.json`);
      if (!existsSync(rp)) { problems.push(`${b.id}: region missing`); continue; }
      const r = readJson<Region>(rp);
      if (!(r.w > 0 && r.h > 0)) problems.push(`${b.id}: region has zero size`);
      if (r.pageWidth !== meta.width || r.pageHeight !== meta.height) problems.push(`${b.id}: region is not in this capture's pixel space (${r.pageWidth}×${r.pageHeight} vs ${meta.width}×${meta.height}) — re-capture with --force`);
      if (r.x + r.w > meta.width || r.y + r.h > meta.height) problems.push(`${b.id}: region falls outside the capture`);
    }
  }
  return { ok: problems.length === 0, problems };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const runArg = argValue(argv, "--run");
  if (!runArg) { console.error("usage: Capture.ts --run <slug|dir> [--force] [--verify] [--only <beatId>]"); process.exit(2); }
  const dir = resolveRunDir(runArg);
  if (hasFlag(argv, "--verify")) {
    const r = await verifyCaptures(dir);
    for (const p of r.problems) console.log(`✗ ${p}`);
    console.log(r.ok ? "✓ captures verified" : "✗ captures failed");
    process.exit(r.ok ? 0 : 1);
  }
  await capture(dir, { force: hasFlag(argv, "--force"), only: argValue(argv, "--only") });
}
