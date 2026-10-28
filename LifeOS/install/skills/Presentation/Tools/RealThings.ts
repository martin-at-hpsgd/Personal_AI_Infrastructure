#!/usr/bin/env bun
/**
 * RealThings.ts — the speaker's own real things (a book, a product, a site) and the one true picture of each.
 *
 * When a talk names one of them, the slide shows that picture, never generated art. The registry lives in
 * the install's customization folder (RealThings.json next to PREFERENCES.md) or wherever `--real` points:
 *
 *   { "things": [ { "name": "<exact name as spoken>", "aliases": ["<other way it is said>"],
 *                   "image": "<path relative to this file>", "what": "book cover" } ] }
 *
 * Keynote.ts tells the designer about every registered thing a section names, and after any design (new or
 * stored) `applyRealThings` puts the registered picture on the slide whose sentences name it, as art type
 * media. Real things outside the registry (films, other people's products, websites) are the designer's
 * media slides, sourced through Intents/MediaSourcing.md.
 *
 *   bun RealThings.ts --list [--real <file>]    every registered thing and whether its picture exists
 *   bun RealThings.ts --self-test
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { getClaudeDir } from "../../../LIFEOS/TOOLS/Paths.ts";

export type RealThing = { name: string; aliases?: string[]; image: string; what?: string };
type Slide = { image?: string | null; art?: string | null; artType?: string; count: number; title: string };

export function defaultRealThingsPath(): string {
  return join(getClaudeDir(), "LIFEOS", "USER", "CUSTOMIZATIONS", "SKILLS", "Presentation", "RealThings.json");
}

/** Registered things with absolute image paths. A missing registry is an empty one; a missing picture is an error. */
export function loadRealThings(path = defaultRealThingsPath()): RealThing[] {
  if (!existsSync(path)) return [];
  const j = JSON.parse(readFileSync(path, "utf8")) as { things?: RealThing[] };
  return (j.things ?? []).map(t => {
    if (!t.name?.trim() || !t.image) throw new Error(`${path}: every thing needs a name and an image`);
    const image = resolve(dirname(path), t.image);
    if (!existsSync(image)) throw new Error(`${path}: picture for "${t.name}" not found: ${image}`);
    return { ...t, image };
  });
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a line names the thing, as a whole phrase, ignoring case and curly quotes. */
export function mentions(line: string, t: RealThing): boolean {
  const plain = line.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  return [t.name, ...(t.aliases ?? [])].some(n => new RegExp(`(^|[^\\w])${esc(n)}($|[^\\w])`, "i").test(plain));
}

/** The registered things a section names, for the designer's prompt. */
export function thingsIn(lines: string[], things: RealThing[]): RealThing[] {
  return things.filter(t => lines.some(l => !isStageNote(l) && mentions(l, t)));
}

/** A line wholly in parentheses is a note about what to show, not the speaker naming the thing. */
export const isStageNote = (line: string) => /^\s*\(.*\)\s*$/.test(line);

/** Copy each registered picture into the deck's image folder (once) so a design can name it by file name. */
export function stageRealImages(things: RealThing[], imageDir: string): void {
  if (!things.length) return;
  mkdirSync(imageDir, { recursive: true });
  for (const t of things) { const to = join(imageDir, basename(t.image)); if (!existsSync(to)) copyFileSync(t.image, to); }
}

/**
 * Put the registered picture on every slide whose sentences name a registered thing. Returns what changed
 * and the slides that name two things (only the first can be shown; that slide should be split).
 */
export function applyRealThings(slides: Slide[], lines: string[], things: RealThing[]): { changed: string[]; crowded: string[] } {
  const changed: string[] = [], crowded: string[] = [];
  let at = 0;
  for (const s of slides) {
    const named = thingsIn(lines.slice(at, at + s.count), things);
    at += s.count;
    if (!named.length) continue;
    if (named.length > 1) crowded.push(`"${s.title}" names ${named.map(t => t.name).join(" and ")}; give each its own slide`);
    if (named.some(t => s.image === basename(t.image))) { if (s.artType !== "media") { s.artType = "media"; changed.push(`"${s.title}" → art type media`); } continue; }
    const t = named[0];
    s.image = basename(t.image); s.art = null; s.artType = "media";
    changed.push(`"${s.title}" → the real ${t.what ?? "picture"} of ${t.name}`);
  }
  return { changed, crowded };
}

function selfTest(): number {
  let fail = 0;
  const t = (name: string, ok: boolean) => { if (!ok) fail++; console.log(`${ok ? "✓" : "✗"} ${name}`); };
  const book: RealThing = { name: "A Field Guide to Examples", aliases: ["my book"], image: "/x/cover.png", what: "book cover" };
  t("names the thing in any case", mentions("I wrote a field guide to examples in 2016.", book));
  t("an alias counts", mentions("That was in My Book.", book));
  t("curly quotes do not hide it", mentions("In “A Field Guide to Examples” I argued…", book));
  t("a partial word does not count", !mentions("my bookshelf is full", book));
  const slides: Slide[] = [
    { title: "Prediction", count: 2, art: "a road", artType: "essay" },
    { title: "The book", count: 1, art: "an open book", artType: "essay" },
  ];
  const r = applyRealThings(slides, ["One.", "Two.", "Back in 2016 I wrote A Field Guide to Examples."], [book]);
  t("the naming slide gets the real picture", slides[1].image === "cover.png" && slides[1].artType === "media" && slides[1].art === null);
  t("other slides are untouched", slides[0].image === undefined && slides[0].artType === "essay");
  t("the change is reported", r.changed.length === 1);
  t("a second pass changes nothing", applyRealThings(slides, ["One.", "Two.", "Back in 2016 I wrote A Field Guide to Examples."], [book]).changed.length === 0);
  const film: RealThing = { name: "The Quiet Engine", image: "/x/quiet-engine.gif" };
  const two: Slide[] = [{ title: "Both", count: 1 }];
  t("two things on one slide are reported as crowded", applyRealThings(two, ["My book came out the year before The Quiet Engine."], [book, film]).crowded.length === 1);
  t("a parenthetical stage note does not count", thingsIn(["(show paths from a field guide to examples book)"], [book]).length === 0);
  t("a missing registry is empty", loadRealThings("/nonexistent/RealThings.json").length === 0);
  console.log(fail ? `${fail} failed` : "all passed");
  return fail ? 1 : 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) process.exit(selfTest());
  const i = args.indexOf("--real"), path = i >= 0 ? resolve(args[i + 1]) : defaultRealThingsPath();
  try {
    const things = loadRealThings(path);
    if (!things.length) console.log(`no real things registered (${path})`);
    for (const th of things) console.log(`${th.name}${th.aliases?.length ? ` (also: ${th.aliases.join(", ")})` : ""} → ${th.image}`);
  } catch (e) { console.error(`❌ ${(e as Error).message}`); process.exit(1); }
}
