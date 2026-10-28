#!/usr/bin/env bun
/**
 * Intake.ts — read a story markdown file into a run.
 *
 *   bun Intake.ts --story <path.md> [--run <slug|dir>] [--json]
 *
 * Frontmatter: `title`, `author`, `audio_voice` (a Fish role, `fish:<reference id>`, or a configured voice id) are read when present.
 * Body: paragraphs become beats; a line of `* * *` (or `***`, `---`) is a scene break and
 * bumps the scene index. Markdown emphasis is stripped from the beat text; the words are verbatim.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { argValue, ensureDir, hasFlag, resolveRunDir, runPaths, writeJson, type Beat, type Beats, type RunMeta } from "./Lib.ts";

export interface Frontmatter { [k: string]: string }

export function parseFrontmatter(raw: string): { meta: Frontmatter; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta: Frontmatter = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[kv[1]] = v;
  }
  return { meta, body: m[2] };
}

/** Strip the markdown a story paragraph is likely to carry; keep the words exactly. */
export function cleanParagraph(p: string): string {
  return p
    .replace(/\s*\n\s*/g, " ")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*]+?)\*(?!\*)/g, "$1$2")
    .replace(/_(.+?)_/g, "$1")
    .replace(/^#+\s+/, "")
    .replace(/\\([*_])/g, "$1")
    .trim();
}

export function isSceneBreak(p: string): boolean {
  const t = p.trim();
  return /^(\*\s*){3,}$/.test(t) || /^(-\s*){3,}$/.test(t) || /^(_\s*){3,}$/.test(t) || t === "* * *";
}

/** Body → beats. Titles like `“The Lantern Keeper”` in the frontmatter are unwrapped of their outer quotes. */
/** A run of short quoted paragraphs (dialogue) folds into one beat: one painting per exchange, not per line. A short narrative paragraph is never folded. */
export const SHORT_PARA_WORDS = 40;
export const BEAT_FOLD_WORDS = 60;
const wc = (t: string) => t.split(/\s+/).filter(Boolean).length;

export function storyToBeats(body: string, slug: string, meta: Frontmatter): Beats {
  const paras = body.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean);
  const beats: Beat[] = [];
  let scene = 1;
  let lastShort = false;
  for (const p of paras) {
    if (isSceneBreak(p)) { if (beats.length) scene++; lastShort = false; continue; }
    const text = cleanParagraph(p);
    if (!text) continue;
    const short = wc(text) < SHORT_PARA_WORDS && /^[\"“‘']/.test(text);
    const last = beats[beats.length - 1];
    // Fold a short paragraph into the previous beat when that beat is in the same scene, is
    // still under the fold size, and is itself made of short paragraphs (never onto a long
    // narrative paragraph, whose painting is its own).
    if (short && last && last.scene === scene && lastShort && wc(last.text) < BEAT_FOLD_WORDS) {
      last.text = `${last.text}\n\n${text}`;
    } else {
      const index = beats.length + 1;
      beats.push({ id: `b${String(index).padStart(2, "0")}`, index, scene, text });
    }
    lastShort = short;
  }
  invariant(beats.length > 0, "the story has no paragraphs");
  const title = (meta.title ?? slug).replace(/^[“"']+|[”"']+$/g, "").trim();
  return { slug, title, author: meta.author?.split(",")[0]?.trim() || undefined, voice: meta.audio_voice || undefined, scenes: scene, beats };
}

export function intake(storyPath: string, runArg?: string): { dir: string; beats: Beats } {
  const src = resolve(storyPath.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
  invariant(existsSync(src), `story not found: ${src}`);
  const slug = runArg && !runArg.includes("/") ? runArg : basename(src).replace(/\.md$/, "");
  const dir = resolveRunDir(runArg ?? slug);
  const { meta, body } = parseFrontmatter(readFileSync(src, "utf8"));
  const beats = storyToBeats(body, slug, meta);
  ensureDir(dir);
  const paths = runPaths(dir);
  const run: RunMeta = { slug, title: beats.title, author: beats.author, voice: beats.voice, source: src, createdAt: new Date().toISOString() };
  writeJson(paths.run, run);
  writeJson(paths.beats, beats);
  return { dir, beats };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const story = argValue(argv, "--story");
  if (!story) { console.error("usage: Intake.ts --story <path.md> [--run <slug|dir>] [--json]"); process.exit(2); }
  const { dir, beats } = intake(story, argValue(argv, "--run"));
  if (hasFlag(argv, "--json")) console.log(JSON.stringify({ dir, title: beats.title, beats: beats.beats.length, scenes: beats.scenes, voice: beats.voice }));
  else console.log(`✓ ${dir}\n  "${beats.title}" · ${beats.beats.length} beats · ${beats.scenes} scenes · voice ${beats.voice ?? "(DA default)"} · ${beats.beats.reduce((n, b) => n + b.text.split(/\s+/).length, 0)} words`);
}
