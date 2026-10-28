#!/usr/bin/env bun
/**
 * Characters.ts — the bible on canvas: one reference sheet per character, one per place, one style plate.
 *
 *   bun Characters.ts --run <slug|dir> [--force] [--only <id>] [--verify]
 *
 * The style plate (`style`) is painted first from the bible's style line alone and then attached to every
 * character and place sheet so the whole bible shares one hand. Sheets are hash-cached; `--verify` checks
 * that every bible entry has a current, non-degenerate sheet.
 */
import { existsSync } from "node:fs";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { argValue, ensureDir, hasFlag, loadStoryboard, resolveRunDir, runPaths, type Bible } from "./Lib.ts";
import { checkImage, currentPath, paintInto, type Painter } from "./Paint.ts";

export function stylePrompt(bible: Bible): string {
  return `A style plate for an illustrated film. ${bible.style} Paint a quiet establishing image in exactly this style: an empty interior at dusk with one window, so the plate shows the medium, the palette, the light and the texture and nothing else. Wide 16:9 composition.`;
}
export function characterPrompt(bible: Bible, name: string, desc: string): string {
  return `Character reference sheet, in the style of the attached style plate. ${bible.style} The character: ${name}. ${desc} Show the same person three times side by side on one plain ground: a front-facing head and shoulders portrait, a three-quarter view, and a full-length figure standing naturally. Same face, hair, build and clothing in all three. Wide 16:9 composition.`;
}
export function objectPrompt(bible: Bible, name: string, desc: string): string {
  return `Object reference, in the style of the attached style plate. ${bible.style} The object: ${name}. ${desc} Show it three ways on one plain ground: a close detail view, a mid view as it is worn or placed, and a wide view in context, so the object is recognizable at every distance. Wide 16:9 composition.`;
}
export function placePrompt(bible: Bible, name: string, desc: string): string {
  return `Location reference, in the style of the attached style plate. ${bible.style} The place: ${name}. ${desc} One wide establishing view of the place with no people in it, showing its layout, light and the details that identify it. Wide 16:9 composition.`;
}

export async function paintBible(dir: string, opts: { force?: boolean; only?: string; painter?: Painter; log?: (s: string) => void } = {}): Promise<{ painted: number; cached: number }> {
  const sb = loadStoryboard(dir);
  const bibleDir = ensureDir(runPaths(dir).bible);
  const log = opts.log ?? ((s) => console.log(s));
  let painted = 0, cached = 0;
  const tally = (r: { cached: boolean }) => (r.cached ? cached++ : painted++);
  const style = await paintInto(bibleDir, "style", stylePrompt(sb.bible), [], { force: opts.force, painter: opts.painter, log });
  tally(style);
  const jobs: Array<{ id: string; prompt: string }> = [
    ...Object.entries(sb.bible.characters).map(([id, c]) => ({ id, prompt: c.kind === "object" ? objectPrompt(sb.bible, c.name, c.desc) : characterPrompt(sb.bible, c.name, c.desc) })),
    ...Object.entries(sb.bible.places).map(([id, p]) => ({ id, prompt: p.kind === "object" ? objectPrompt(sb.bible, p.name, p.desc) : placePrompt(sb.bible, p.name, p.desc) })),
  ].filter((j) => !opts.only || j.id === opts.only);
  invariant(!jobs.some((j) => j.id === "style"), `a bible entry is named "style" — that id is reserved for the style plate`);
  // Sheets are independent of each other; paint three at a time.
  const queue = [...jobs];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) { const j = queue.shift()!; tally(await paintInto(bibleDir, j.id, j.prompt, [style.path], { force: opts.force, painter: opts.painter, log })); }
  });
  await Promise.all(workers);
  log(`✓ bible: ${painted} painted, ${cached} cached`);
  return { painted, cached };
}

export async function verifyBible(dir: string): Promise<{ ok: boolean; problems: string[] }> {
  const sb = loadStoryboard(dir);
  const bibleDir = runPaths(dir).bible;
  const problems: string[] = [];
  for (const id of ["style", ...Object.keys(sb.bible.characters), ...Object.keys(sb.bible.places)]) {
    const p = currentPath(bibleDir, id);
    if (!p || !existsSync(p)) { problems.push(`${id}: no sheet`); continue; }
    const c = await checkImage(p);
    if (!c.ok) problems.push(`${id}: ${c.problems.join("; ")}`);
  }
  return { ok: !problems.length, problems };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const run = argValue(argv, "--run");
  if (!run) { console.error("usage: Characters.ts --run <slug|dir> [--force] [--only <id>] [--verify]"); process.exit(2); }
  const dir = resolveRunDir(run);
  if (hasFlag(argv, "--verify")) { const r = await verifyBible(dir); for (const p of r.problems) console.log(`✗ ${p}`); console.log(r.ok ? "✓ bible verified" : "✗ bible failed"); process.exit(r.ok ? 0 : 1); }
  await paintBible(dir, { force: hasFlag(argv, "--force"), only: argValue(argv, "--only") });
}
