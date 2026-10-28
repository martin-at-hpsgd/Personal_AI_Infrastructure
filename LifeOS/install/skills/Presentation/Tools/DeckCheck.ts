#!/usr/bin/env bun
/**
 * DeckCheck.ts — the deck-mode (HTML) gate: real things on screen, animations that start by themselves,
 * and every slide's layout measured in a real browser.
 *
 *   bun DeckCheck.ts <deck-dir> [--deck deck.html] [--real <RealThings.json>]   static checks
 *   bun DeckCheck.ts <deck-dir> --live <url>                                    + live layout, via Interceptor
 *   bun DeckCheck.ts --self-test
 *
 * Static checks read deck.html:
 *   - a slide whose text or notes name a registered real thing (RealThings.ts) shows that thing's picture;
 *   - no `fragment` builds, since each one is an extra press before the slide moves on;
 *   - every <video> carries data-autoplay, muted and loop, so reveal.js starts it on slide entry;
 *   - every <img src> exists in the deck directory.
 * The live check opens the served deck in the Interceptor browser, steps through every slide, measures each
 * picture and text block in slide coordinates, and flags thumbnails, overflow, pictures over text, large
 * empty bands and pictures shown far above their pixel size. Lecture-mode Keynote decks use Layout.ts instead.
 *
 * Exit codes: 0 clean (warnings allowed) · 2 usage · 4 a slide needs fixing.
 */
import { existsSync, readFileSync } from "fs";
import { basename, join, resolve } from "path";
import { getClaudeDir } from "../../../LIFEOS/TOOLS/Paths.ts";
import { defaultRealThingsPath, loadRealThings, mentions, type RealThing } from "./RealThings.ts";

export type Issue = { slide: number; level: "fix" | "warn"; text: string };
export type DeckSection = { n: number; text: string; notes: string; imgs: string[]; fragments: number; videos: string[] };

const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&mdash;/g, "—").replace(/&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"').replace(/\s+/g, " ").trim();

/** Top-level <section> elements of a reveal.js deck, in order. */
export function parseDeck(html: string): DeckSection[] {
  const slidesStart = html.indexOf('class="slides"');
  const body = slidesStart >= 0 ? html.slice(slidesStart) : html;
  const out: DeckSection[] = [];
  for (const m of body.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/g)) {
    const inner = m[1];
    const notes = (inner.match(/<aside\b[^>]*class="[^"]*notes[^"]*"[^>]*>([\s\S]*?)<\/aside>/) ?? [])[1] ?? "";
    const visible = inner.replace(/<aside\b[^>]*class="[^"]*notes[^"]*"[^>]*>[\s\S]*?<\/aside>/g, "");
    out.push({
      n: out.length + 1, text: strip(visible), notes: strip(notes),
      imgs: [...visible.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map(x => x[1]),
      fragments: (visible.match(/class="[^"]*\bfragment\b[^"]*"/g) ?? []).length,
      videos: [...visible.matchAll(/<video\b[^>]*>/g)].map(x => x[0]),
    });
  }
  return out;
}

export function staticIssues(secs: DeckSection[], things: RealThing[], exists: (src: string) => boolean): Issue[] {
  const out: Issue[] = [];
  for (const s of secs) {
    for (const t of things) {
      if (!mentions(s.text, t) && !mentions(s.notes, t)) continue;
      if (!s.imgs.some(src => basename(src) === basename(t.image)))
        out.push({ slide: s.n, level: "fix", text: `names ${t.name} but does not show its real ${t.what ?? "picture"} (${basename(t.image)})` });
    }
    if (s.fragments) out.push({ slide: s.n, level: "fix", text: `${s.fragments} fragment build(s): each is an extra press before the slide moves on` });
    for (const v of s.videos) {
      const missing = ["data-autoplay", "muted", "loop"].filter(a => !new RegExp(`\\s${a}(\\s|=|>|/)`).test(v));
      if (missing.length) out.push({ slide: s.n, level: "fix", text: `a <video> lacks ${missing.join(", ")}, so it will not start by itself` });
    }
    for (const src of s.imgs) if (!/^(https?:|data:)/.test(src) && !exists(src)) out.push({ slide: s.n, level: "fix", text: `image not found: ${src}` });
  }
  return out;
}

// ── live layout ─────────────────────────────────────────────────────────────

export type Box = { x: number; y: number; w: number; h: number };
export type Measured = { n: number; w: number; h: number; media: (Box & { natural: [number, number] })[]; texts: Box[] };

/** Runs in the page (Interceptor eval --main): steps through every slide and measures it in slide units. */
export const MEASURE_JS = `(async () => {
  const R = window.Reveal; if (!R) return JSON.stringify({ error: "no Reveal on this page" });
  const cfg = R.getConfig(), slides = R.getSlides(), out = [];
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && !e.closest("aside.notes"); };
  for (let i = 0; i < slides.length; i++) {
    R.slide(...Object.values(R.getIndices(slides[i])).slice(0, 2));
    await new Promise(r => setTimeout(r, 400));
    const s = slides[i], sr = s.getBoundingClientRect(), k = sr.width / cfg.width || 1;
    const rel = r => ({ x: (r.left - sr.left) / k, y: (r.top - sr.top) / k, w: r.width / k, h: r.height / k });
    const media = [...s.querySelectorAll("img,svg,video,canvas")].filter(e => visible(e) && !e.parentElement.closest("svg"))
      .map(e => Object.assign(rel(e.getBoundingClientRect()), { natural: [e.naturalWidth || e.videoWidth || 0, e.naturalHeight || e.videoHeight || 0] }))
      .filter(b => b.w > 40 && b.h > 40);
    const texts = [...s.querySelectorAll("h1,h2,h3,h4,h5,p,li,blockquote,figcaption,td,th")].filter(e => visible(e) && e.innerText.trim())
      .map(e => rel(e.getBoundingClientRect()));
    out.push({ n: i + 1, w: cfg.width, h: cfg.height, media, texts });
  }
  R.slide(0, 0);
  return JSON.stringify(out);
})()`;

const overlaps = (a: Box, b: Box, tol = 8) => a.x + tol < b.x + b.w && b.x + tol < a.x + a.w && a.y + tol < b.y + b.h && b.y + tol < a.y + a.h;
export const DECK_LIMITS = { minPictureShare: 0.12, maxEmptyBand: 0.3, maxUpscale: 1.6, footerBand: 0.08 };

export function liveIssues(m: Measured): Issue[] {
  const out: Issue[] = [], add = (level: Issue["level"], text: string) => out.push({ slide: m.n, level, text });
  const all = [...m.media, ...m.texts];
  if (!all.length) { add("fix", "the slide is empty"); return out; }
  for (const b of all) if (b.x < -2 || b.y < -2 || b.x + b.w > m.w + 2 || b.y + b.h > m.h + 2) { add("fix", "content runs off the slide"); break; }
  const backdrop = (b: Box) => b.w * b.h > 0.9 * m.w * m.h;
  const pics = m.media.filter(b => !backdrop(b));
  if (!pics.length) return out;
  const biggest = pics.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
  const share = (biggest.w * biggest.h) / (m.w * m.h);
  if (m.texts.length && share < DECK_LIMITS.minPictureShare) add("fix", `the picture is thumbnail-sized (${Math.round(share * 100)}% of the slide)`);
  if (pics.some(p => m.texts.some(t => overlaps(p, t)))) add("fix", "a picture overlaps text");
  // Largest empty vertical band between the top of the content and the footer band.
  const bottom = m.h * (1 - DECK_LIMITS.footerBand), top = Math.min(...all.map(b => b.y));
  const spans = all.map(b => [Math.max(top, b.y), Math.min(bottom, b.y + b.h)] as [number, number]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let cursor = top, worst = 0;
  for (const [a, b] of spans) { worst = Math.max(worst, a - cursor); cursor = Math.max(cursor, b); }
  worst = Math.max(worst, bottom - cursor);
  if (worst / m.h > DECK_LIMITS.maxEmptyBand) add("fix", `${Math.round((worst / m.h) * 100)}% of the slide height is an empty band`);
  for (const p of pics) if (p.natural[0] && p.w / p.natural[0] > DECK_LIMITS.maxUpscale)
    add("warn", `a picture is shown at ${(p.w / p.natural[0]).toFixed(1)}× its ${p.natural[0]} px width and will look soft`);
  return out;
}

function interceptor(args: string[]): string {
  const p = Bun.spawnSync(["interceptor", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = new TextDecoder().decode(p.stdout);
  if (p.exitCode !== 0) throw new Error(`interceptor ${args[0]} failed: ${new TextDecoder().decode(p.stderr).trim().slice(-300)}`);
  return out;
}

/** Pull the JSON array the measure script returned out of Interceptor's eval output. */
export function parseEvalOutput(raw: string): Measured[] {
  let v: unknown = raw.split("\n").filter(l => !/^\[[0-9a-f]+\] → /.test(l.trim())).join("\n").trim();
  for (let i = 0; i < 4 && typeof v === "string"; i++) {
    const s = v.trim(), at = s.search(/[\[{"]/);
    if (at < 0) break;
    try { v = JSON.parse(s.slice(at)); } catch { break; }
    if (v && typeof v === "object" && !Array.isArray(v) && "value" in (v as Record<string, unknown>)) v = (v as Record<string, unknown>).value;
    if (v && typeof v === "object" && !Array.isArray(v) && "result" in (v as Record<string, unknown>)) v = (v as Record<string, unknown>).result;
  }
  if (v && typeof v === "object" && !Array.isArray(v) && "error" in (v as Record<string, unknown>)) throw new Error(String((v as Record<string, unknown>).error));
  if (!Array.isArray(v)) throw new Error(`could not read the measurements from interceptor: ${raw.slice(0, 200)}`);
  return v as Measured[];
}

/**
 * The Interceptor skill's isolation rules: run its profile gate first, then name the pinned test context on
 * every call. A bare call can land in the operator's own browser.
 */
function testContext(): string {
  const tools = join(import.meta.dir, "..", "..", "Interceptor", "Tools");
  const gate = Bun.spawnSync(["bash", join(tools, "EnsureTestProfile.sh")], { stdout: "pipe", stderr: "pipe" });
  if (gate.exitCode !== 0) throw new Error(`Interceptor test profile not ready (EnsureTestProfile exit ${gate.exitCode}): ${new TextDecoder().decode(gate.stderr).trim().slice(-300)}`);
  const prefs = join(getClaudeDir(), "LIFEOS", "USER", "CUSTOMIZATIONS", "SKILLS", "Interceptor", "preferences.env");
  const p = Bun.spawnSync(["bash", "-c", `set -a; . "$1"; printf %s "$INTERCEPTOR_TEST_CONTEXT_ID"`, "_", prefs], { stdout: "pipe" });
  const id = new TextDecoder().decode(p.stdout).trim();
  if (!id) throw new Error("INTERCEPTOR_TEST_CONTEXT_ID is unset; refusing to measure (never the default profile)");
  return id;
}

export function measureLive(url: string): Measured[] {
  const ctx = testContext();
  interceptor(["open", url, "--reuse", "--text-only", "--context", ctx]);
  return parseEvalOutput(interceptor(["eval", MEASURE_JS, "--main", "--context", ctx]));
}

// ── self-test ───────────────────────────────────────────────────────────────

function selfTest(): number {
  let fail = 0;
  const t = (name: string, ok: boolean) => { if (!ok) fail++; console.log(`${ok ? "✓" : "✗"} ${name}`); };
  const book: RealThing = { name: "A Field Guide to Examples", image: "/x/cover.png", what: "book cover" };
  const html = `<div class="reveal"><div class="slides">
    <section><h2>Intro</h2><aside class="notes">Back in 2016 I wrote A Field Guide to Examples.</aside></section>
    <section><h2>The book</h2><img src="images/cover.png"><aside class="notes">A Field Guide to Examples.</aside></section>
    <section><ul><li class="fragment">one</li><li class="fragment">two</li></ul></section>
    <section><video src="clip.mp4" muted loop></video></section>
    <section><video src="clip.mp4" data-autoplay muted loop playsinline></video></section>
  </div></div>`;
  const secs = parseDeck(html);
  t("parses each section with notes kept apart", secs.length === 5 && secs[0].text === "Intro" && secs[0].notes.includes("2016"));
  const issues = staticIssues(secs, [book], () => true);
  const on = (n: number) => issues.filter(i => i.slide === n).map(i => i.text).join(" | ");
  t("a slide naming the book without its cover is flagged", /does not show its real book cover/.test(on(1)));
  t("a slide showing the cover passes", on(2) === "");
  t("fragments are flagged as extra presses", /2 fragment/.test(on(3)));
  t("a video without data-autoplay is flagged", /lacks data-autoplay/.test(on(4)));
  t("a correctly tagged video passes", on(5) === "");
  t("a missing image file is flagged", staticIssues(secs, [], s => s !== "images/cover.png").some(i => /not found/.test(i.text)));

  const base = { n: 1, w: 1280, h: 720 };
  const good: Measured = { ...base, media: [{ x: 640, y: 150, w: 560, h: 420, natural: [1120, 840] }], texts: [{ x: 80, y: 60, w: 1000, h: 70 }, { x: 80, y: 250, w: 500, h: 220 }] };
  t("a balanced slide passes", liveIssues(good).length === 0);
  const thumb: Measured = { ...base, media: [{ x: 900, y: 150, w: 200, h: 140, natural: [800, 560] }], texts: [{ x: 80, y: 60, w: 1000, h: 70 }, { x: 80, y: 160, w: 500, h: 120 }] };
  const ti = liveIssues(thumb).map(i => i.text).join(" | ");
  t("a thumbnail picture is flagged", /thumbnail-sized/.test(ti));
  t("an empty lower half is flagged", /empty band/.test(ti));
  t("a picture over text is flagged", liveIssues({ ...good, media: [{ x: 60, y: 200, w: 700, h: 400, natural: [1400, 800] }] }).some(i => /overlaps text/.test(i.text)));
  t("overflow is flagged", liveIssues({ ...good, texts: [...good.texts, { x: 80, y: 650, w: 600, h: 120 }] }).some(i => /runs off/.test(i.text)));
  t("a soft picture warns", liveIssues({ ...good, media: [{ ...good.media[0], natural: [300, 225] }] }).some(i => i.level === "warn"));
  t("a full backdrop is not judged as a thumbnail or overlap", liveIssues({ ...base, media: [{ x: 0, y: 0, w: 1280, h: 720, natural: [1920, 1080] }], texts: [{ x: 80, y: 300, w: 900, h: 90 }] }).length === 0);
  t("the [id] → verb trace line is stripped", parseEvalOutput("[8e83c00e] → eval\n[{\"n\":2,\"w\":1280,\"h\":720,\"media\":[],\"texts\":[]}]")[0].n === 2);
  t("interceptor eval output is unwrapped", parseEvalOutput(`{"value":"[{\\"n\\":1,\\"w\\":1280,\\"h\\":720,\\"media\\":[],\\"texts\\":[]}]"}`)[0].n === 1);
  console.log(fail ? `${fail} failed` : "all passed");
  return fail ? 1 : 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) process.exit(selfTest());
  const flag = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const dir = args[0] && !args[0].startsWith("--") ? resolve(args[0]) : undefined;
  if (!dir || !existsSync(dir)) { console.error("usage: bun DeckCheck.ts <deck-dir> [--deck deck.html] [--live <url>] [--real <RealThings.json>]"); process.exit(2); }
  const deck = join(dir, flag("deck") ?? "deck.html");
  if (!existsSync(deck)) { console.error(`no ${basename(deck)} in ${dir}`); process.exit(2); }
  let issues: Issue[];
  try {
    const things = loadRealThings(flag("real") ? resolve(flag("real")!) : defaultRealThingsPath());
    issues = staticIssues(parseDeck(readFileSync(deck, "utf8")), things, src => existsSync(join(dir, src)));
    const url = flag("live");
    if (url) {
      const measured = measureLive(url);
      console.log(`measured ${measured.length} slides live at ${url}`);
      issues.push(...measured.flatMap(liveIssues));
    }
  } catch (e) { console.error(`❌ ${(e as Error).message}`); process.exit(2); }
  issues.sort((a, b) => a.slide - b.slide);
  for (const x of issues) console.log(`  ${x.level === "fix" ? "❌" : "⚠"} slide ${x.slide}: ${x.text}`);
  const fixes = issues.filter(x => x.level === "fix").length;
  console.log(fixes ? `❌ ${fixes} slide problem(s) to fix` : `✓ deck clean${issues.length ? ` · ${issues.length} warning(s)` : ""}`);
  process.exit(fixes ? 4 : 0);
}
