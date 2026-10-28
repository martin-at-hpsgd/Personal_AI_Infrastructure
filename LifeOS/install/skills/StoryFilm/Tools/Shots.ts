#!/usr/bin/env bun
/**
 * Shots.ts — one painting per beat, against the bible.
 *
 *   bun Shots.ts --run <slug|dir> [--force] [--only <beat>] [--concurrency N] [--verify] [--sheet]
 *
 * Every shot prompt is prefixed with the bible's style line and painted with the style plate plus the
 * reference sheets its storyboard entry names attached, so the same faces and places recur. Cached by a
 * hash of prompt + reference bytes. `--verify` runs the non-degenerate check on every current shot and
 * fails on any two byte-identical shots. `--sheet` tiles every shot into Shots/contact-sheet.png for one look.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { argValue, ensureDir, hasFlag, loadBeats, loadStoryboard, resolveRunDir, runPaths, sh, sha256, type Bible, type Shot } from "./Lib.ts";
import { checkImage, currentPath, paintInto, type Painter } from "./Paint.ts";

export function shotPrompt(bible: Bible, shot: Shot): string {
  const named = shot.refs.map((r) => bible.characters[r]?.name ?? bible.places[r]?.name).filter(Boolean);
  const refLine = named.length ? ` The attached reference images show, in order after the style plate: ${named.join(", ")}. Keep each of them exactly as drawn there.` : "";
  return `A single film frame, painted in the style of the attached style plate. ${bible.style}${refLine}\n\nThe shot: ${shot.prompt}\n\nWide 16:9 cinematic composition that fills the whole frame edge to edge (no paper margin, no border, no vignette of bare paper), one clear focal point, room at the bottom of the frame for a caption band.`;
}

export function refPaths(dir: string, shot: Shot): string[] {
  const bibleDir = runPaths(dir).bible;
  const style = currentPath(bibleDir, "style");
  invariant(style, "style plate missing — run Characters.ts first");
  const refs = shot.refs.map((r) => { const p = currentPath(bibleDir, r); invariant(p, `${shot.beat}: reference sheet for "${r}" missing — run Characters.ts first`); return p; });
  return [style, ...refs];
}

export async function paintShots(dir: string, opts: { force?: boolean; only?: string; concurrency?: number; painter?: Painter; log?: (s: string) => void } = {}): Promise<{ painted: number; cached: number }> {
  const sb = loadStoryboard(dir);
  const shotsDir = ensureDir(runPaths(dir).shots);
  const log = opts.log ?? ((s) => console.log(s));
  const queue = sb.shots.filter((s) => !opts.only || s.beat === opts.only);
  let painted = 0, cached = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, queue.length)) }, async () => {
    while (queue.length) {
      const s = queue.shift()!;
      const r = await paintInto(shotsDir, s.beat, shotPrompt(sb.bible, s), refPaths(dir, s), { force: opts.force, painter: opts.painter, log });
      r.cached ? cached++ : painted++;
    }
  });
  await Promise.all(workers);
  log(`✓ shots: ${painted} painted, ${cached} cached`);
  return { painted, cached };
}

export async function verifyShots(dir: string): Promise<{ ok: boolean; problems: string[]; count: number }> {
  const beats = loadBeats(dir);
  const shotsDir = runPaths(dir).shots;
  const problems: string[] = [];
  const hashes = new Map<string, string>();
  let count = 0;
  for (const b of beats.beats) {
    const p = currentPath(shotsDir, b.id);
    if (!p) { problems.push(`${b.id}: no shot`); continue; }
    count++;
    const c = await checkImage(p);
    if (!c.ok) problems.push(`${b.id}: ${c.problems.join("; ")}`);
    const h = sha256(readFileSync(p));
    const dup = hashes.get(h);
    if (dup) problems.push(`${b.id}: byte-identical to ${dup}`);
    hashes.set(h, b.id);
  }
  return { ok: !problems.length, problems, count };
}

/** Tile every current shot, in beat order, 6 across. */
export async function shotSheet(dir: string): Promise<string> {
  const beats = loadBeats(dir);
  const shotsDir = runPaths(dir).shots;
  const files = beats.beats.map((b) => currentPath(shotsDir, b.id)).filter((p): p is string => !!p);
  invariant(files.length, "no shots to tile");
  const list = join(shotsDir, "sheet.txt");
  await Bun.write(list, files.map((f) => `file '${f}'\nduration 0.04`).join("\n") + "\n");
  const out = join(shotsDir, "contact-sheet.png");
  const across = 6;
  const rows = Math.ceil(files.length / across);
  await sh(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", `scale=320:180,tile=${across}x${rows}:padding=4:margin=4`, "-frames:v", "1", out]);
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const run = argValue(argv, "--run");
  if (!run) { console.error("usage: Shots.ts --run <slug|dir> [--force] [--only <beat>] [--concurrency N] [--verify] [--sheet]"); process.exit(2); }
  const dir = resolveRunDir(run);
  if (hasFlag(argv, "--verify")) { const r = await verifyShots(dir); for (const p of r.problems) console.log(`✗ ${p}`); console.log(r.ok ? `✓ ${r.count} shots verified` : "✗ shots failed"); process.exit(r.ok ? 0 : 1); }
  if (hasFlag(argv, "--sheet")) { console.log(`✓ ${await shotSheet(dir)}`); process.exit(0); }
  invariant(existsSync(runPaths(dir).bible) && readdirSync(runPaths(dir).bible).length > 0, "Bible/ is empty — run Characters.ts first");
  await paintShots(dir, { force: hasFlag(argv, "--force"), only: argValue(argv, "--only"), concurrency: Number(argValue(argv, "--concurrency")) || undefined });
}
