#!/usr/bin/env bun
// ExtractIdeasCheck — checks an ExtractIdeas output against the parts of its
// contract code can judge: the one "## Ideas" heading, then either "- " bullets
// (one sentence each, 4 to 15 words, ending in . ? or !, no two repeating or
// opening on the same first two words, none narrating "the author argues") or
// the single "None found:" line; no bold or italic, no sub-bullets, no
// commentary; with --count, exactly N bullets. Whether each bullet is a real,
// faithful, specific idea stays a judged check in the fabric-extractideas suite.

import { readFileSync } from "node:fs";

const HELP = `ExtractIdeasCheck — shape check for a Fabric ExtractIdeas output

  bun skills/Fabric/Tools/ExtractIdeasCheck.ts <file|-> [--count N] [--json]

  --count N  require exactly N bullets (the request named a count)
  --json     print {ok, none, ideas, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const MIN_WORDS = 4;
export const MAX_WORDS = 15;
export const MAX_NONE_WORDS = 30;

export type Idea = { line: number; text: string; words: number };

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

/** Narration in place of the idea: "The author argues…", "This article explains…". */
const NARRATION =
  /^(?:the|this|in (?:the|this)) (?:author|writer|speaker|host|guest|article|essay|post|piece|text|video|talk|podcast|episode|transcript|source|paper|book|interview)s?,? (?:\w+ )?(?:argues?|says?|discuss(?:es)?|explains?|describes?|mentions?|talks?|notes?|claims?|suggests?|states?|explores?|believes?|thinks?|highlights?|emphasi[sz]es?|points? out|covers?)\b/i;

const key = (s: string) => words(s).map((w) => w.toLowerCase()).join(" ");

export function check(input: string, count?: number): { ok: boolean; none: boolean; ideas: Idea[]; problems: string[] } {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const ideas: Idea[] = [];
  let none = false;
  let noneLines = 0;

  const nonBlank = lines.map((l, i) => ({ raw: l, text: l.trim(), line: i + 1 })).filter((l) => l.text !== "");
  if (nonBlank.length === 0) return { ok: false, none, ideas, problems: ["output is empty"] };

  const first = nonBlank[0];
  if (!/^##\s+Ideas\s*$/i.test(first.text)) problems.push(`line ${first.line}: the output must open on "## Ideas", found "${first.text.slice(0, 60)}"`);

  if (/\*\*|__/.test(input) || /(^|[\s(])[*_][^\s*_][^*_\n]*[*_](?=$|[\s).,;:!?])/m.test(input))
    problems.push("bold or italic markup found; the output uses neither");

  const seen = new Map<string, number>();
  const openings = new Map<string, number>();
  for (const l of nonBlank.slice(1)) {
    if (/^#{1,6}\s/.test(l.text)) {
      problems.push(`line ${l.line}: extra heading "${l.text}"; the output is one Ideas section`);
      continue;
    }
    if (/^\s+[-*+]\s/.test(l.raw)) {
      problems.push(`line ${l.line}: sub-bullet; every idea is a top-level "- " bullet`);
      continue;
    }
    if (/^\d+[.)]\s/.test(l.text) || /^[*+]\s/.test(l.text)) {
      problems.push(`line ${l.line}: not a "- " bullet; each idea opens on "- "`);
      continue;
    }
    const nm = l.text.match(/^(?:- )?None found:\s*(.*)$/i);
    if (nm) {
      none = true;
      noneLines++;
      const n = words(nm[1]).length;
      if (n === 0) problems.push(`line ${l.line}: "None found:" needs a reason`);
      if (n > MAX_NONE_WORDS) problems.push(`line ${l.line}: "None found:" reason has ${n} words, at most ${MAX_NONE_WORDS}`);
      continue;
    }
    if (!l.text.startsWith("- ")) {
      problems.push(`line ${l.line}: commentary outside the list ("${l.text.slice(0, 60)}")`);
      continue;
    }
    const text = l.text.slice(2).trim();
    const w = words(text);
    ideas.push({ line: l.line, text, words: w.length });
    if (w.length < MIN_WORDS) problems.push(`line ${l.line}: ${w.length} words is a label, not an idea; at least ${MIN_WORDS} ("${text}")`);
    if (w.length > MAX_WORDS) problems.push(`line ${l.line}: ${w.length} words, at most ${MAX_WORDS} ("${text.slice(0, 60)}…")`);
    if (!/[.?!]["'”’)]*$/.test(text)) problems.push(`line ${l.line}: not a complete sentence; end it on . ? or !`);
    if (NARRATION.test(text)) problems.push(`line ${l.line}: narrates the source ("${text.slice(0, 40)}…"); state the idea itself`);
    const k = key(text);
    if (seen.has(k)) problems.push(`line ${l.line}: repeats the idea on line ${seen.get(k)}`);
    else seen.set(k, l.line);
    if (w.length >= 2) {
      const open = w.slice(0, 2).join(" ").toLowerCase();
      if (openings.has(open) && seen.get(k) === l.line) problems.push(`line ${l.line}: opens on "${w[0]} ${w[1]}", like line ${openings.get(open)}`);
      else if (!openings.has(open)) openings.set(open, l.line);
    }
  }

  if (none && ideas.length > 0) problems.push('"None found:" sits beside listed ideas; it is either the list or the one line');
  if (noneLines > 1) problems.push(`${noneLines} "None found:" lines; there is one`);
  if (!none && ideas.length === 0) problems.push('no idea bullets and no "None found:" line');
  if (count !== undefined && !none && ideas.length !== count) problems.push(`expected ${count} ideas, found ${ideas.length}`);

  return { ok: problems.length === 0, none, ideas, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const ci = args.indexOf("--count");
  const count = ci >= 0 ? Number(args[ci + 1]) : undefined;
  if (ci >= 0 && (!Number.isInteger(count) || (count as number) < 1)) {
    console.error("--count needs a whole number of at least 1");
    process.exit(2);
  }
  const unknown = args.find((a, i) => a.startsWith("--") && a !== "--json" && a !== "--count" && !(ci >= 0 && i === ci + 1));
  if (unknown) {
    console.error(`unknown flag ${unknown}\n\n${HELP}`);
    process.exit(2);
  }
  const src = args.find((a, i) => (a === "-" || !a.startsWith("--")) && !(ci >= 0 && i === ci + 1));
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input, count);
  if (json) console.log(JSON.stringify({ ok: r.ok, none: r.none, ideas: r.ideas, problems: r.problems }));
  else if (r.ok) console.log(r.none ? "✓ none found, shape holds" : `✓ ${r.ideas.length} ideas, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
