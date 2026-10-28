#!/usr/bin/env bun
/**
 * KeynotePlayback.ts — prove, from Keynote's own reading of the deck, that no slide waits for an extra click.
 *
 *   bun KeynotePlayback.ts <deck.key>
 *   bun KeynotePlayback.ts --self-test
 *
 * Keynote opens the deck and exports it as HTML. The export lists every slide's click steps as Keynote will
 * play them, each with `automaticPlay`; the last step is the advance to the next slide. Any earlier step
 * that is not automatic waits for a click: to the speaker, a slide that looks duplicated until advanced,
 * because the animation only starts on the second press. This is the oracle for autoplay.
 * KeynoteAutoplay.ts --check only rereads the field it wrote, and on 2026-10-04 that check passed while the
 * deck the speaker opened (an iCloud autosave of the build, never patched) waited for a click on every GIF.
 *
 * Why the export and not the slideshow: driving the slideshow ("show next", or arrow keys through System
 * Events) worked once, then failed with "No window" whenever another deck was open (2026-10-04). The export
 * agreed with the slideshow click count on patched and unpatched test decks, needs no focus, and never takes
 * over the speaker's screen. The deck is closed without saving.
 * Exit: 0 no extra clicks, 1 extra clicks found, 2 usage or Keynote error.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const JXA = String.raw`
function run(argv) {
  const K = Application("Keynote");
  const path = argv[0], out = argv[1];
  const name = path.split("/").pop();
  // Match by name: d.file() throws on unsaved documents. A document already open under this name may be the
  // speaker's own edited copy, so refuse rather than export or close it.
  const byName = () => K.documents().find(d => d.name() === name);
  if (byName()) throw new Error("a document named " + name + " is already open in Keynote; close it first");
  K.open(Path(path));
  let doc = byName();
  for (let i = 0; !doc && i < 120; i++) { delay(0.5); doc = byName(); } // a large deck takes seconds to appear
  if (!doc) throw new Error("Keynote did not open " + path);
  // A large deck exports for longer than an AppleEvent waits (2 min). Keynote keeps exporting, so the deck stays
  // open and the caller waits for the files to settle before closing it (2026-10-17, a 706 MB deck).
  try { K.export(doc, { to: Path(out), as: "HTML" }); }
  catch (e) { if (e.errorNumber === -1712) return "exporting"; try { doc.close({ saving: "no" }); } catch (e2) {} throw e; }
  try { doc.close({ saving: "no" }); } catch (e) {}
  return "ok";
}`;

const CLOSE = String.raw`
function run(argv) {
  const d = Application("Keynote").documents().find(d => d.name() === argv[0]);
  if (d) d.close({ saving: "no" });
}`;

/** Newest modification time and file count under a directory, or null while it does not exist. */
function treeState(dir: string): string | null {
  if (!existsSync(dir)) return null;
  let n = 0, newest = 0;
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else { n++; newest = Math.max(newest, statSync(p).mtimeMs); } } };
  walk(dir);
  return `${n}:${newest}`;
}

/** Wait until the export has its slide list and nothing under it has changed for 20 s. */
async function settled(out: string, limitMs = 30 * 60_000): Promise<void> {
  let last = "", still = 0;
  for (const end = Date.now() + limitMs; Date.now() < end; await Bun.sleep(5000)) {
    const now = treeState(out);
    if (now && now === last && existsSync(join(out, "assets", "header.json"))) { if ((still += 5000) >= 20_000) return; }
    else still = 0;
    last = now ?? "";
  }
  throw new Error("Keynote was still exporting after 30 minutes");
}

type Step = { automaticPlay?: boolean; effects?: { name?: string }[] };
export interface Playback { slides: number; animations: number; stuck: number[] }

/** Read Keynote's HTML export: slide order from header.json, each slide's click steps from its own JSON. */
export function analyze(exportDir: string): Playback {
  const assets = join(exportDir, "assets");
  const order: string[] = JSON.parse(readFileSync(join(assets, "header.json"), "utf8")).slideList ?? [];
  if (!order.length) throw new Error("the export lists no slides");
  return judge(order.map(id => (JSON.parse(readFileSync(join(assets, id, `${id}.json`), "utf8")).events ?? []) as Step[]));
}

/** Per slide, every step before the final advance must play by itself. */
export function judge(slides: Step[][]): Playback {
  let animations = 0;
  const stuck: number[] = [];
  slides.forEach((steps, i) => {
    const within = steps.slice(0, -1);
    animations += within.filter(s => s.effects?.some(e => e.name && e.name !== "none")).length;
    if (within.some(s => !s.automaticPlay)) stuck.push(i + 1);
  });
  return { slides: slides.length, animations, stuck };
}

export async function playback(deck: string): Promise<Playback> {
  const dir = mkdtempSync(join(tmpdir(), "keynote-playback-"));
  try {
    const p = Bun.spawn(["osascript", "-l", "JavaScript", "-e", JXA, resolve(deck), join(dir, "export")], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
    if ((await p.exited) !== 0) throw new Error(err.trim().split("\n").pop() || "osascript failed");
    if (out.trim() === "exporting") {
      try { await settled(join(dir, "export")); }
      finally { Bun.spawnSync(["osascript", "-l", "JavaScript", "-e", CLOSE, resolve(deck).split("/").pop()!]); }
    }
    return analyze(join(dir, "export"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Plain-words verdict for a result. */
export function verdict(r: Playback): { ok: boolean; text: string } {
  return r.stuck.length
    ? { ok: false, text: `✗ ${r.stuck.length} slide(s) wait for an extra click before their animation: ${r.stuck.join(", ")}` }
    : { ok: true, text: `✓ ${r.slides} slides, ${r.animations} animation(s): every one starts by itself, no slide waits for an extra click` };
}

function selfTest(): number {
  let fails = 0;
  const t = (name: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) fails++; };
  const advance: Step = { automaticPlay: false, effects: [{ name: "none" }] };
  const movie = (auto: boolean): Step => ({ automaticPlay: auto, effects: [{ name: "apple:movie-start" }] });
  // Shapes copied from Keynote's export of the patched and unpatched test decks (2026-10-04).
  const clean = judge([[advance], [movie(true), advance]]);
  t("a patched GIF slide passes and is counted", clean.stuck.length === 0 && clean.animations === 1 && verdict(clean).ok);
  const bad = judge([[advance], [movie(false), advance], [movie(true), advance]]);
  t("an unpatched GIF slide fails and is named", JSON.stringify(bad.stuck) === "[2]" && !verdict(bad).ok);
  t("the final advance waiting for a click is normal", judge([[advance], [advance]]).stuck.length === 0);
  t("a slide with no steps is not an error", judge([[]]).stuck.length === 0);
  console.log(fails ? `${fails} failed` : "all passed");
  return fails ? 1 : 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) process.exit(selfTest());
  const deck = args.find(a => !a.startsWith("--") && a.endsWith(".key"));
  if (!deck || !existsSync(deck)) { console.error("usage: bun KeynotePlayback.ts <deck.key> | --self-test"); process.exit(2); }
  try {
    const v = verdict(await playback(deck));
    console.log(v.text);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`✗ Keynote playback check failed: ${(e as Error).message}`);
    process.exit(2);
  }
}
