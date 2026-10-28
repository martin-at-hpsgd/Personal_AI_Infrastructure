#!/usr/bin/env bun
/**
 * FilmStats.ts — measures the numbers that separate a launch film from a slow explainer:
 * length, how often the picture changes, how much it moves, how much of the frame is type
 * or graphic, brightness spread, and sound.
 *
 * Usage:
 *   bun FilmStats.ts <film.mp4> [more.mp4 ...] [--json] [--sheet]
 *
 *   --sheet   also writes <film>-sheet.png: 30 frames spread over the whole film, 6x5
 *   --json    one JSON object per film instead of the table
 *
 * Run it on the reference films and on the cut together; LaunchVideo compares against the
 * reference medians. Hard-cut detection (scene > 0.3) misses morphs and match cuts, which is
 * how most code-built films change picture, so beatsPer10s and motion are the columns to read.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";

export type FilmStats = {
  file: string;
  durationS: number;
  beatsPer10s: number;     // visual changes (10 fps scene score > 0.06, merged within 0.4 s): cuts, morphs, slams
  meanBeatS: number;       // average time between visual changes
  motion: number;          // mean frame-to-frame scene score at 10 fps, 0..1
  ink: number;             // median share of the frame that is type or graphic (the minority of bright vs dark pixels), 0..1
  cuts: number;            // hard cuts only (scene score > 0.3)
  lumaMin: number;         // darkest per-half-second mean luma, 0..255
  lumaMax: number;         // brightest per-half-second mean luma, 0..255
  hasAudio: boolean;
  lufs: number | null;     // integrated loudness
};

/** ffmpeg prints filter metadata to stderr; return both streams. */
function ff(args: string[]): string {
  const r = Bun.spawnSync(["ffmpeg", "-hide_banner", "-nostats", ...args], { stdout: "pipe", stderr: "pipe" });
  return r.stderr.toString() + r.stdout.toString();
}

function probe(file: string, entries: string, stream?: string): string {
  const r = Bun.spawnSync(["ffprobe", "-v", "error", ...(stream ? ["-select_streams", stream] : []), "-show_entries", entries, "-of", "csv=p=0", file], { stdout: "pipe", stderr: "pipe" });
  return r.stdout.toString().trim();
}

const nums = (text: string, key: string) => [...text.matchAll(new RegExp(`${key.replace(/\./g, "\\.")}=([0-9.]+)`, "g"))].map(m => Number(m[1]));
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** Count visual changes from 10 fps scene scores; a change within 0.4 s of the last one is the same beat. */
export function countBeats(scores: number[], threshold = 0.06, mergeFrames = 4): number {
  let beats = 0, last = -Infinity;
  scores.forEach((v, i) => { if (v > threshold && i - last > mergeFrames) { beats++; last = i; } });
  return beats;
}

export function measure(file: string): FilmStats {
  if (!existsSync(file)) throw new Error(`no such file: ${file}`);
  const durationS = Number(probe(file, "format=duration"));
  if (!(durationS > 0)) throw new Error(`ffprobe found no duration in ${file}`);

  const cuts = (ff(["-i", file, "-vf", "select='gt(scene,0.3)',showinfo", "-an", "-f", "null", "-"]).match(/pts_time:/g) ?? []).length;
  const scores = nums(ff(["-i", file, "-vf", "fps=10,select='gte(scene,0)',metadata=print:key=lavfi.scene_score", "-an", "-f", "null", "-"]), "lavfi.scene_score");
  const beats = countBeats(scores);

  const yavg = (pre: string) => nums(ff(["-i", file, "-vf", `fps=2,${pre}signalstats,metadata=print:key=lavfi.signalstats.YAVG`, "-an", "-f", "null", "-"]), "lavfi.signalstats.YAVG");
  const avgs = yavg("");
  const bright = yavg("lutyuv=y='if(gt(val,170),255,0)':u=128:v=128,").map(v => v / 255);
  const dark = yavg("lutyuv=y='if(lt(val,60),255,0)':u=128:v=128,").map(v => v / 255);
  const ink = bright.map((b, i) => Math.min(b, dark[i] ?? b));

  const hasAudio = probe(file, "stream=codec_type", "a").includes("audio");
  let lufs: number | null = null;
  if (hasAudio) {
    const m = ff(["-i", file, "-vn", "-af", "ebur128", "-f", "null", "-"]).match(/I:\s+(-?[0-9.]+) LUFS/g);
    if (m?.length) lufs = Number(m[m.length - 1].replace(/[^-0-9.]/g, ""));
  }

  return {
    file: basename(file),
    durationS: round(durationS, 1),
    beatsPer10s: round((beats / durationS) * 10, 1),
    meanBeatS: round(durationS / Math.max(beats, 1), 1),
    motion: round(scores.reduce((a, b) => a + b, 0) / Math.max(scores.length, 1), 3),
    ink: round(median(ink), 3),
    cuts,
    lumaMin: Math.round(Math.min(...avgs)),
    lumaMax: Math.round(Math.max(...avgs)),
    hasAudio,
    lufs,
  };
}

export function contactSheet(file: string): string {
  const out = file.replace(/\.[^.]+$/, "-sheet.png");
  const d = Number(probe(file, "format=duration"));
  ff(["-y", "-v", "error", "-i", file, "-vf", `fps=${(30 / d).toFixed(4)},scale=480:-1,tile=6x5`, "-frames:v", "1", out]);
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const files = args.filter(a => !a.startsWith("-"));
  if (!files.length || args.includes("-h") || args.includes("--help")) {
    console.log("Usage: bun FilmStats.ts <film.mp4> [more.mp4 ...] [--json] [--sheet]");
    process.exit(files.length ? 0 : 2);
  }
  const rows = files.map(measure);
  if (args.includes("--sheet")) for (const f of files) console.error(`sheet: ${contactSheet(f)}`);
  if (args.includes("--json")) {
    for (const r of rows) console.log(JSON.stringify(r));
  } else {
    const cols = Object.keys(rows[0]) as (keyof FilmStats)[];
    console.log(cols.join("\t"));
    for (const r of rows) console.log(cols.map(c => String(r[c])).join("\t"));
  }
}
