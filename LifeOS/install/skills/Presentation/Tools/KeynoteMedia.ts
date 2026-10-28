#!/usr/bin/env bun
/**
 * KeynoteMedia.ts — real footage for a talk deck: look at it, cut the moment into a GIF or a still.
 *
 *   bun KeynoteMedia.ts sheet <video.mp4>
 *   bun KeynoteMedia.ts gif   <video.mp4> --from <s> --to <s> --out <file.gif> [--width 1280] [--fps 15] [--crop auto|none|W:H:X:Y] [--long]
 *   bun KeynoteMedia.ts still <video.mp4> --at <s> --out <file.jpg> [--width 1920] [--crop auto|none|W:H:X:Y]
 *   bun KeynoteMedia.ts cover "<book title>" [--author "<name>"] --out <file.jpg>
 *   bun KeynoteMedia.ts --self-test
 *
 * The video is a local file the speaker owns or is licensed to show.
 * sheet writes <video>-sheet.jpg beside it, a timestamped contact sheet, so the moment can be picked by looking.
 * gif cuts [from, to] into a looping GIF with a full-frame palette; by default it crops letterbox bars it
 * detects and refuses clips over 6.5 s (--long overrides) so a slide never carries a scene, only a moment.
 * still writes one frame.
 * cover finds the book on Open Library and saves its largest cover; a miss means the publisher's or author's page.
 *
 * search and fetch run only where the install provides a footage lane beside this file
 * (a lane that is not in the public release); elsewhere they exit 3, "not available in this install".
 *
 * Exit codes: 0 done, 1 failed, 2 usage error, 3 not available in this install.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";

export const MAX_CLIP_SECONDS = 6.5;
const SHEET_FONT = "/System/Library/Fonts/Supplemental/Arial.ttf";

export class MediaError extends Error {
  constructor(message: string, readonly usage = false) { super(message); this.name = "MediaError"; }
}

function run(cmd: string[], opts: { quiet?: boolean } = {}): string {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = new TextDecoder().decode(p.stdout), err = new TextDecoder().decode(p.stderr);
  if (p.exitCode !== 0) throw new MediaError(`${cmd[0]} failed: ${err.trim().slice(-400)}`);
  return opts.quiet ? "" : out + err;
}

// ── optional footage lane ───────────────────────────────────────────────────

/** What the optional footage lane (not in the public release) provides when an install carries it. */
interface FootageLane {
  search(query: string, n?: number): { id: string; title: string; duration: number | null; channel: string; url: string }[];
  fetchVideo(idOrUrl: string, dir: string): string;
  selfTest(t: (name: string, ok: boolean) => void): void;
}

const FOOTAGE_LANE = join(import.meta.dir, "KeynoteFootage.ts"); // optional lane, not in the public release

/** The footage lane, or null when this install does not carry it. A present file that fails to load throws. */
async function footageLane(): Promise<FootageLane | null> {
  return existsSync(FOOTAGE_LANE) ? ((await import(FOOTAGE_LANE)) as FootageLane) : null;
}

export const NOT_AVAILABLE =
  "not available in this install: put a video file you own or are licensed to show in the media folder, then run sheet, gif or still on it";

// ── contact sheet ───────────────────────────────────────────────────────────

export function duration(file: string): number {
  const d = Number(run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]).trim());
  invariant(Number.isFinite(d) && d > 0, `could not read the duration of ${file}`);
  return d;
}

/** Seconds between contact-sheet frames: every second for short clips, at most 96 frames for long ones. Pure. */
export function sheetStep(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 96));
}

/** Write <video>-sheet.jpg beside a local video: one labelled frame per sheetStep seconds, 8 across. */
export function makeSheet(videoPath: string): { video: string; sheet: string; seconds: number } {
  const video = resolve(videoPath);
  if (!existsSync(video) || statSync(video).size === 0) throw new MediaError(`no video file at ${video}`, true);
  const sheet = join(dirname(video), `${parse(video).name}-sheet.jpg`);
  const seconds = duration(video), step = sheetStep(seconds), rows = Math.ceil(seconds / step / 8);
  const label = existsSync(SHEET_FONT) ? `,drawtext=fontfile=${SHEET_FONT}:text='%{pts\\:hms}':x=6:y=6:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.6` : "";
  run(["ffmpeg", "-v", "error", "-y", "-i", video, "-vf", `fps=1/${step},scale=320:-2,setpts=N*${step}/TB${label},tile=8x${Math.max(1, rows)}`, "-frames:v", "1", "-update", "1", sheet], { quiet: true });
  invariant(existsSync(sheet), `contact sheet produced no file for ${video}`);
  return { video, sheet, seconds };
}

// ── cut ─────────────────────────────────────────────────────────────────────

/** The crop ffmpeg's cropdetect settled on most often, as W:H:X:Y, or null. Pure. */
export function parseCropdetect(stderr: string): string | null {
  const counts = new Map<string, number>();
  for (const m of stderr.matchAll(/crop=(\d+:\d+:\d+:\d+)/g)) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  let best: string | null = null, n = 0;
  for (const [k, v] of counts) if (v > n) { best = k; n = v; }
  return best;
}

function cropFilter(video: string, from: number, len: number, crop: string): string {
  if (crop === "none") return "";
  if (crop !== "auto") {
    if (!/^\d+:\d+:\d+:\d+$/.test(crop)) throw new MediaError(`--crop must be auto, none or W:H:X:Y, got "${crop}"`, true);
    return `crop=${crop},`;
  }
  const p = Bun.spawnSync(["ffmpeg", "-hide_banner", "-ss", String(from), "-t", String(Math.max(1, len)), "-i", video, "-vf", "cropdetect=limit=24:round=2:reset=0", "-f", "null", "-"], { stdout: "pipe", stderr: "pipe" });
  const found = parseCropdetect(new TextDecoder().decode(p.stderr));
  return found ? `crop=${found},` : "";
}

/** Validate a clip window. Pure. */
export function checkWindow(from: number, to: number, long = false): number {
  if (!(Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to > from)) throw new MediaError(`--from/--to must satisfy 0 <= from < to, got ${from}..${to}`, true);
  const len = to - from;
  if (len > MAX_CLIP_SECONDS && !long) throw new MediaError(`a ${len.toFixed(1)} s clip is a scene, not a moment; keep it under ${MAX_CLIP_SECONDS} s or pass --long`, true);
  return len;
}

export function cutGif(video: string, o: { from: number; to: number; out: string; width?: number; fps?: number; crop?: string; long?: boolean }): { out: string; bytes: number; frames: number } {
  const len = checkWindow(o.from, o.to, o.long), width = o.width ?? 1280, fps = o.fps ?? 15;
  if (!o.out.toLowerCase().endsWith(".gif")) throw new MediaError("--out must end in .gif", true);
  const crop = cropFilter(video, o.from, len, o.crop ?? "auto");
  const vf = `${crop}fps=${fps},scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a`;
  run(["ffmpeg", "-v", "error", "-y", "-ss", String(o.from), "-t", String(len), "-i", video, "-filter_complex", vf, "-loop", "0", o.out], { quiet: true });
  invariant(existsSync(o.out) && statSync(o.out).size > 0, "GIF encode produced no file");
  const frames = Number(run(["ffprobe", "-v", "error", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", o.out]).trim());
  return { out: o.out, bytes: statSync(o.out).size, frames };
}

export function still(video: string, o: { at: number; out: string; width?: number; crop?: string }): string {
  if (!(o.at >= 0)) throw new MediaError("--at must be a time in seconds", true);
  const crop = cropFilter(video, Math.max(0, o.at - 0.5), 1, o.crop ?? "auto");
  run(["ffmpeg", "-v", "error", "-y", "-ss", String(o.at), "-i", video, "-frames:v", "1", "-vf", `${crop}scale=${o.width ?? 1920}:-2:flags=lanczos`, "-q:v", "2", o.out], { quiet: true });
  invariant(existsSync(o.out), "still produced no file");
  return o.out;
}

// ── cover ───────────────────────────────────────────────────────────────────

export type BookHit = { title: string; author: string; cover: number; year?: number };

/** Open Library search results that carry a cover, best title match first. */
export function pickBooks(json: { docs?: { title?: string; author_name?: string[]; cover_i?: number; first_publish_year?: number }[] }, title: string): BookHit[] {
  const want = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return (json.docs ?? []).filter(d => d.cover_i && d.title)
    .map(d => ({ title: d.title!, author: d.author_name?.[0] ?? "", cover: d.cover_i!, year: d.first_publish_year }))
    .sort((a, b) => Number(b.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === want) - Number(a.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === want));
}

export async function cover(title: string, o: { author?: string; out: string }): Promise<{ out: string; book: BookHit; size: string }> {
  if (!title.trim()) throw new MediaError("cover needs a book title", true);
  const q = new URLSearchParams({ title, ...(o.author ? { author: o.author } : {}), limit: "10", fields: "title,author_name,cover_i,first_publish_year" });
  const r = await fetch(`https://openlibrary.org/search.json?${q}`);
  if (!r.ok) throw new MediaError(`Open Library search failed: HTTP ${r.status}`);
  const book = pickBooks(await r.json(), title)[0];
  if (!book) throw new MediaError(`no cover for "${title}" on Open Library; take it from the publisher's or the author's page`);
  const img = await fetch(`https://covers.openlibrary.org/b/id/${book.cover}-L.jpg?default=false`);
  if (!img.ok) throw new MediaError(`cover ${book.cover} not downloadable: HTTP ${img.status}`);
  await Bun.write(o.out, await img.arrayBuffer());
  invariant(existsSync(o.out), "cover produced no file");
  return { out: o.out, book, size: run(["magick", "identify", "-format", "%wx%h", o.out]).trim() };
}

// ── self-test ───────────────────────────────────────────────────────────────

async function selfTest(): Promise<number> {
  let fail = 0;
  const t = (name: string, ok: boolean) => { if (!ok) fail++; console.log(`${ok ? "✓" : "✗"} ${name}`); };
  t("sheet step is 1 s for short clips", sheetStep(60) === 1 && sheetStep(96) === 1);
  t("sheet step caps the frame count for long clips", sheetStep(600) === 7 && 600 / sheetStep(600) <= 96);
  t("cropdetect takes the most frequent crop", parseCropdetect("crop=1280:536:0:92\ncrop=1280:536:0:92\ncrop=1280:720:0:0") === "1280:536:0:92");
  t("no cropdetect output means no crop", parseCropdetect("nothing here") === null);
  let threw = false; try { checkWindow(10, 20); } catch { threw = true; }
  t("a 10 s clip is refused without --long", threw);
  t("--long allows it", checkWindow(10, 20, true) === 10);
  threw = false; try { checkWindow(5, 4); } catch { threw = true; }
  t("a backwards window is refused", threw);
  t("a 4 s window passes", checkWindow(12, 16) === 4);
  threw = false; try { makeSheet("/nonexistent/synthetic-clip.mp4"); } catch (e) { threw = e instanceof MediaError && e.usage; }
  t("a sheet for a missing file is a usage error", threw);
  const books = pickBooks({ docs: [{ title: "Field Notes", cover_i: 2 }, { title: "Field Notes on Systems", author_name: ["Alex Example"], cover_i: 1 }, { title: "Field Notes on Systems" }] }, "field notes on systems");
  t("cover search prefers the exact title and skips results without a cover", books.length === 2 && books[0]!.cover === 1);
  const lane = await footageLane();
  if (lane) lane.selfTest(t);
  else console.log("· footage lane not in this install; its checks are skipped");
  console.log(fail ? `${fail} failed` : "all passed");
  return fail ? 1 : 0;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `usage:
  bun KeynoteMedia.ts sheet <video.mp4>
  bun KeynoteMedia.ts gif   <video.mp4> --from <s> --to <s> --out <file.gif> [--width 1280] [--fps 15] [--crop auto|none|W:H:X:Y] [--long]
  bun KeynoteMedia.ts still <video.mp4> --at <s> --out <file.jpg> [--width 1920] [--crop auto|none|W:H:X:Y]
  bun KeynoteMedia.ts cover "<book title>" [--author "<name>"] --out <file.jpg>`;

/** A usage error from this file or from the footage lane, which names its errors FootageError. */
function isUsageError(e: unknown): boolean {
  return e instanceof Error && (e.name === "MediaError" || e.name === "FootageError") && (e as MediaError).usage === true;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const num = (k: string) => (flag(k) !== undefined ? Number(flag(k)) : undefined);
  try {
    const [cmd, target] = args;
    if (cmd === "--self-test") process.exit(await selfTest());
    if (cmd === "search" || cmd === "fetch") {
      const lane = await footageLane();
      if (!lane) { console.error(`✗ ${cmd}: ${NOT_AVAILABLE}`); process.exit(3); }
      if (cmd === "search") { for (const c of lane.search(target ?? "", num("n") ?? 8)) console.log(JSON.stringify(c)); }
      else {
        if (!target || !flag("dir")) throw new MediaError("fetch needs a video and --dir", true);
        const r = makeSheet(lane.fetchVideo(target, flag("dir")!));
        console.log(`✓ ${r.video} (${r.seconds.toFixed(1)} s)\n✓ ${r.sheet}`);
      }
    } else if (cmd === "sheet") {
      if (!target) throw new MediaError("sheet needs a video file", true);
      const r = makeSheet(target);
      console.log(`✓ ${r.video} (${r.seconds.toFixed(1)} s)\n✓ ${r.sheet}`);
    } else if (cmd === "gif") {
      if (!target || !flag("out")) throw new MediaError("gif needs a video and --out", true);
      const r = cutGif(target, { from: num("from") ?? NaN, to: num("to") ?? NaN, out: resolve(flag("out")!), width: num("width"), fps: num("fps"), crop: flag("crop"), long: args.includes("--long") });
      console.log(`✓ ${r.out} (${(r.bytes / 1024 / 1024).toFixed(2)} MB, ${r.frames} frames)`);
    } else if (cmd === "still") {
      if (!target || !flag("out")) throw new MediaError("still needs a video and --out", true);
      console.log(`✓ ${still(target, { at: num("at") ?? NaN, out: resolve(flag("out")!), width: num("width"), crop: flag("crop") })}`);
    } else if (cmd === "cover") {
      if (!target || !flag("out")) throw new MediaError("cover needs a title and --out", true);
      const r = await cover(target, { author: flag("author"), out: resolve(flag("out")!) });
      console.log(`✓ ${r.out} (${r.size}) · ${r.book.title}${r.book.author ? ` by ${r.book.author}` : ""}${r.book.year ? `, ${r.book.year}` : ""}`);
    } else throw new MediaError(cmd ? `unknown command "${cmd}"` : "no command", true);
  } catch (e) {
    const usage = isUsageError(e);
    console.error(`✗ ${(e as Error).message}${usage ? `\n${USAGE}` : ""}`);
    process.exit(usage ? 2 : 1);
  }
}
