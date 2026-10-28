#!/usr/bin/env bun
// ExtractReferencesCheck — checks an ExtractReferences output against the parts
// of its contract code can judge: one bold heading, then bullets shaped
// `- *Title*, Creator (kind): note <URL>` (creator optional and absent for an
// unidentified work, kind one to three words with an optional `, alluded` or
// `, unidentified`, the closing `<URL>` optional), notes of at most 12 words,
// at most 16 words in the whole bullet (or --words), no work listed twice, at
// most 20 bullets (or --max), one optional closing `**Left out:**` line used
// only at the cap, or the single `**No references:**` line. With --source it
// also requires every bullet not marked alluded or unidentified to have its
// title appear in the input, and every URL to appear in it exactly. Whether
// each work is real, rightly credited and used as the note says stays judged.

import { readFileSync } from "node:fs";

const HELP = `ExtractReferencesCheck — shape check for a Fabric ExtractReferences output

  bun skills/Fabric/Tools/ExtractReferencesCheck.ts <file|-> [--source <input-file>] [--max N] [--words N] [--json]

  --source F  the input; every bullet not marked alluded or unidentified must have its title
              appear in it, and every <URL> must appear in it exactly
  --max N     the most bullets allowed (default 20; 0 means no cap)
  --words N   the most words in a whole bullet (default 16)
  --json      print {ok, noReferences, heading, references, leftOut, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const DEFAULT_MAX = 20;
export const NOTE_MAX_WORDS = 12;
export const BULLET_MAX_WORDS = 16;

const HEADING = /^\*\*([^*].*?)\*\*$/;
const NO_REFS = /^\*\*No references:\*\*[ \t]+\S/;
const LEFT_OUT = /^\*\*Left out:\*\*[ \t]+(\d+)\b.*\S/;
const BULLET = /^[-*][ \t]+\*([^*]+)\*(?:,[ \t]+([^()]+?))?[ \t]+\(([^()]+)\):[ \t]+(\S.*)$/;
const PLACEHOLDER = /\{[^}]*\}/;
const TRAILING_URL = /^(.*?)[ \t]+<([a-z][a-z0-9+.-]*:\/\/[^\s<>]+)>$/i;
const URL_TITLE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
const MARKERS = new Set(["alluded", "unidentified"]);
const NUMBERED = /^\d+[.)][ \t]+\S/;

export type Reference = {
  title: string;
  creator?: string;
  kind: string;
  alluded: boolean;
  unidentified: boolean;
  note: string;
  url?: string;
  line: number;
};
export type Result = {
  ok: boolean;
  noReferences: boolean;
  heading?: string;
  references: Reference[];
  leftOut?: number;
  problems: string[];
};

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[-–—_]/g, " ")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the URL appears in the source as a whole URL, not as the start of a longer one. */
export function urlInSource(source: string, url: string): boolean {
  for (let i = source.indexOf(url); i >= 0; i = source.indexOf(url, i + 1)) {
    const next = source[i + url.length] ?? "";
    const after = source.slice(i + url.length, i + url.length + 2);
    if (next === "" || /[\s<>()"'\]\[,;!]/.test(next) || /^[.:?](\s|$)/.test(after) || after === "." || after === "?") return true;
  }
  return false;
}

/** The title a source would use: before any subtitle, without a leading article. */
export function mainTitle(title: string): string {
  return normalize(title.split(/:\s/)[0]).replace(/^(the|a|an) /, "");
}

export function check(input: string, opts: { source?: string; max?: number; words?: number } = {}): Result {
  const max = opts.max ?? DEFAULT_MAX;
  const bulletMax = opts.words ?? BULLET_MAX_WORDS;
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const references: Reference[] = [];
  const content = lines.map((raw, i) => ({ raw: raw.trim(), line: i + 1 })).filter((l) => l.raw !== "");

  if (content.length === 0) return { ok: false, noReferences: false, references, problems: ["empty output"] };

  const noRefLine = content.find((l) => NO_REFS.test(l.raw));
  if (noRefLine) {
    if (content.length > 1) problems.push(`line ${noRefLine.line}: the **No references:** line must be the whole output`);
    return { ok: problems.length === 0, noReferences: true, references, problems };
  }

  let heading: string | undefined;
  let leftOut: number | undefined;
  let leftOutLine = 0;
  content.forEach((l, idx) => {
    if (PLACEHOLDER.test(l.raw)) problems.push(`line ${l.line}: template placeholder left in ("${l.raw}")`);
    if (NUMBERED.test(l.raw)) {
      problems.push(`line ${l.line}: numbered list; each reference is a "- " bullet`);
      return;
    }
    const lo = l.raw.match(LEFT_OUT);
    if (lo) {
      if (leftOut !== undefined) problems.push(`line ${l.line}: more than one **Left out:** line`);
      leftOut = Number(lo[1]);
      leftOutLine = l.line;
      if (leftOut < 1) problems.push(`line ${l.line}: **Left out:** must count at least one reference`);
      return;
    }
    const b = l.raw.match(BULLET);
    if (b) {
      if (leftOut !== undefined) problems.push(`line ${l.line}: bullet after the **Left out:** line`);
      const [, title, creator, kindRaw, rest] = b;
      const u = rest.match(TRAILING_URL);
      const note = u ? u[1] : rest;
      const url = u ? u[2] : undefined;
      if (!u && /<[^<>\s]*:\/\/[^<>]*>/.test(rest)) problems.push(`line ${l.line}: a <URL> must close the bullet, after the note`);
      const kindParts = kindRaw.split(",").map((s) => s.trim());
      const last = kindParts[kindParts.length - 1].toLowerCase();
      const marker = kindParts.length > 1 && MARKERS.has(last) ? last : undefined;
      const alluded = marker === "alluded";
      const unidentified = marker === "unidentified";
      const kind = marker ? kindParts.slice(0, -1).join(", ") : kindRaw.trim();
      const kindWords = words(kind).length;
      if (kindWords < 1 || kindWords > 3) problems.push(`line ${l.line}: kind "${kindRaw}" must be one to three words, optionally followed by ", alluded" or ", unidentified"`);
      if (unidentified && creator) problems.push(`line ${l.line}: an unidentified work names no creator ("${creator.trim()}")`);
      const noteWords = words(note).length;
      if (noteWords > NOTE_MAX_WORDS) problems.push(`line ${l.line}: note has ${noteWords} words (at most ${NOTE_MAX_WORDS})`);
      const total = words(title).length + words(creator ?? "").length + words(kindRaw).length + noteWords + (url ? 1 : 0);
      if (total > bulletMax) problems.push(`line ${l.line}: bullet has ${total} words (at most ${bulletMax}, title and URL included)`);
      references.push({ title: title.trim(), creator: creator?.trim(), kind, alluded, unidentified, note: note.trim(), url, line: l.line });
      return;
    }
    if (/^[-*][ \t]/.test(l.raw)) {
      problems.push(`line ${l.line}: bullet not in the shape "- *Title*, Creator (kind): note" ("${l.raw}")`);
      return;
    }
    const h = l.raw.match(HEADING);
    if (h && idx === 0) {
      heading = h[1].trim();
      return;
    }
    problems.push(`line ${l.line}: ${idx === 0 ? "first line is not a bold heading" : "commentary outside the heading, bullets and closing line"} ("${l.raw}")`);
  });

  if (heading === undefined && !problems.some((p) => p.includes("first line"))) problems.push("no bold heading naming the read");
  if (references.length === 0) problems.push("no references found (each is a bullet such as - *Moby-Dick*, Herman Melville (novel): note)");

  const seen = new Map<string, number>();
  for (const r of references) {
    const key = normalize(r.title);
    const prior = seen.get(key);
    if (prior !== undefined) problems.push(`line ${r.line}: "${r.title}" already listed on line ${prior}`);
    else seen.set(key, r.line);
  }

  if (max > 0 && references.length > max) problems.push(`${references.length} references; the cap is ${max}`);
  if (leftOut !== undefined) {
    if (max === 0) problems.push(`line ${leftOutLine}: **Left out:** line with no cap set`);
    else if (references.length !== max) problems.push(`line ${leftOutLine}: **Left out:** line but only ${references.length} of the ${max} allowed references are listed`);
  }

  if (opts.source !== undefined) {
    const src = ` ${normalize(opts.source)} `;
    for (const r of references) {
      if (URL_TITLE.test(r.title) && !urlInSource(opts.source, r.title)) problems.push(`line ${r.line}: URL ${r.title} does not appear in the source exactly; give it as written or drop it`);
      if (r.url && !urlInSource(opts.source, r.url)) problems.push(`line ${r.line}: URL ${r.url} does not appear in the source exactly; give it as written or drop it`);
      if (r.alluded || r.unidentified) continue;
      const t = mainTitle(r.title);
      if (t && !src.includes(` ${t} `)) problems.push(`line ${r.line}: "${r.title}" does not appear in the source; mark it alluded or unidentified, or drop it`);
    }
  }

  return { ok: problems.length === 0, noReferences: false, heading, references, leftOut, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const si = args.indexOf("--source");
  const mi = args.indexOf("--max");
  const wi = args.indexOf("--words");
  if (si >= 0 && (args[si + 1] === undefined || args[si + 1].startsWith("--"))) {
    console.error("--source needs a file path");
    process.exit(2);
  }
  const max = mi >= 0 ? Number(args[mi + 1]) : undefined;
  if (mi >= 0 && (!Number.isInteger(max) || (max as number) < 0)) {
    console.error("--max needs a whole number of 0 or more");
    process.exit(2);
  }
  const wordCap = wi >= 0 ? Number(args[wi + 1]) : undefined;
  if (wi >= 0 && (!Number.isInteger(wordCap) || (wordCap as number) < 1)) {
    console.error("--words needs a whole number of 1 or more");
    process.exit(2);
  }
  const valueAt = new Set([si, mi, wi].filter((i) => i >= 0).map((i) => i + 1));
  const src = args.find((a, i) => (a === "-" || !a.startsWith("--")) && !valueAt.has(i));
  let input: string;
  let source: string | undefined;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  if (si >= 0) {
    try {
      source = readFileSync(args[si + 1], "utf8");
    } catch (e) {
      console.error(`cannot read source ${args[si + 1]}: ${(e as Error).message}`);
      process.exit(2);
    }
  }
  const r = check(input, { source, max, words: wordCap });
  if (json) console.log(JSON.stringify({ ok: r.ok, noReferences: r.noReferences, heading: r.heading, references: r.references, leftOut: r.leftOut, problems: r.problems }));
  else if (r.ok) console.log(r.noReferences ? "✓ no-references line, shape holds" : `✓ ${r.references.length} references, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
