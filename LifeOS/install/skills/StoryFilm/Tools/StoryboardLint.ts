#!/usr/bin/env bun
/**
 * StoryboardLint.ts — the storyboard is complete, consistent, and never asks a painting for text.
 *
 *   bun StoryboardLint.ts --run <slug|dir> [--json]
 *
 * Checks: exactly one shot per beat and no shot for a beat that does not exist; every ref names a
 * bible character or place; every motion is in the vocabulary; every shot with a character in its
 * prompt (by bible name) carries that character's ref; no prompt asks for text, captions, titles,
 * lettering, logos, signatures or watermarks; focus, when given, is inside the unit square.
 */
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { MOTIONS, argValue, hasFlag, loadBeats, loadStoryboard, resolveRunDir, type Beats, type Storyboard } from "./Lib.ts";

export const TEXT_WORDS = /\b(text|caption|captions|title|titles|subtitle|lettering|letters|words?|typography|font|logo|signature|signed|watermark|label|labels|headline|written)\b/i;

/** The word a bible entry is recognized by in a prompt: an explicit key, else the first capitalized word (possessive stripped), else the last word. */
export function entryKey(e: { name: string; key?: string }): string {
  if (e.key) return e.key;
  const words = e.name.replace(/\(.*?\)/g, "").trim().split(/\s+/);
  const cap = words.find((w) => /^[A-Z]/.test(w));
  return (cap ?? words[words.length - 1]).replace(/[’\x27]s$/, "").replace(/[^\w’\x27-]/g, "");
}
/** Capitalized keys match case-sensitively as whole words (possessive allowed); lowercase keys match case-insensitively. */
export function mentions(prompt: string, key: string): boolean {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z])${esc}(?:[’\x27]s)?(?![A-Za-z])`, /^[A-Z]/.test(key) ? "" : "i").test(prompt);
}

export function lintStoryboard(beats: Beats, sb: Storyboard): string[] {
  const problems: string[] = [];
  const ids = new Set(beats.beats.map((b) => b.id));
  const seen = new Map<string, number>();
  for (const s of sb.shots) seen.set(s.beat, (seen.get(s.beat) ?? 0) + 1);
  for (const id of ids) if (!seen.has(id)) problems.push(`${id}: no shot`);
  for (const [id, n] of seen) { if (!ids.has(id)) problems.push(`${id}: shot for a beat that does not exist`); if (n > 1) problems.push(`${id}: ${n} shots (exactly one)`); }
  if (!sb.bible?.style?.trim()) problems.push("bible.style is empty");
  const refIds = new Set([...Object.keys(sb.bible?.characters ?? {}), ...Object.keys(sb.bible?.places ?? {})]);
  const charNames = Object.entries(sb.bible?.characters ?? {}).map(([id, c]) => ({ id, key: entryKey(c) }));
  for (const s of sb.shots) {
    if (!s.prompt?.trim()) problems.push(`${s.beat}: empty prompt`);
    if (!(MOTIONS as readonly string[]).includes(s.motion)) problems.push(`${s.beat}: unknown motion "${s.motion}" (${MOTIONS.join(", ")})`);
    for (const r of s.refs ?? []) if (!refIds.has(r)) problems.push(`${s.beat}: unknown ref "${r}"`);
    const m = s.prompt?.match(TEXT_WORDS);
    if (m && !/\bno (text|words|lettering|captions?|titles?|logos?|signatures?|watermarks?)\b/i.test(s.prompt.slice(Math.max(0, m.index! - 12), m.index! + m[0].length))) problems.push(`${s.beat}: prompt asks for text ("${m[0]}")`);
    for (const c of charNames) {
      if (mentions(s.prompt ?? "", c.key) && !(s.refs ?? []).includes(c.id)) problems.push(`${s.beat}: names ${c.key} but does not carry ref "${c.id}"`);
    }
    if (s.focus && !(s.focus.x >= 0 && s.focus.x <= 1 && s.focus.y >= 0 && s.focus.y <= 1)) problems.push(`${s.beat}: focus outside 0..1`);
  }
  for (const [id, c] of Object.entries(sb.bible?.characters ?? {})) if (!c.desc?.trim() || !c.name?.trim()) problems.push(`bible.characters.${id}: name and desc required`);
  for (const [id, p] of Object.entries(sb.bible?.places ?? {})) if (!p.desc?.trim() || !p.name?.trim()) problems.push(`bible.places.${id}: name and desc required`);
  return problems;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const run = argValue(argv, "--run");
  if (!run) { console.error("usage: StoryboardLint.ts --run <slug|dir> [--json]"); process.exit(2); }
  const dir = resolveRunDir(run);
  const beats = loadBeats(dir);
  const sb = loadStoryboard(dir);
  const problems = lintStoryboard(beats, sb);
  const motions = Object.fromEntries(MOTIONS.map((m) => [m, sb.shots.filter((s) => s.motion === m).length]));
  if (hasFlag(argv, "--json")) console.log(JSON.stringify({ ok: !problems.length, shots: sb.shots.length, characters: Object.keys(sb.bible.characters).length, places: Object.keys(sb.bible.places).length, motions, problems }));
  else {
    for (const p of problems) console.log(`✗ ${p}`);
    console.log(`${problems.length ? "✗" : "✓"} ${sb.shots.length} shots · ${Object.keys(sb.bible.characters).length} characters · ${Object.keys(sb.bible.places).length} places · motions ${Object.entries(motions).map(([k, v]) => `${k}:${v}`).join(" ")}`);
  }
  invariant(true, "unreachable");
  process.exit(problems.length ? 1 : 0);
}
