#!/usr/bin/env bun
// BusinessIdeasCheck — checks a BusinessIdeas output against the parts of its
// contract code can judge: "## Extracted Ideas" with a numbered list of 1 to 40
// one-sentence business ideas, then "## Elaborated Ideas" with min(10, extracted)
// numbered pivots, each carrying one "Differentiator:" and ending "Pivot from #k."
// with every k a different extracted idea; or the single "None found:" line and
// no second section. Numbering runs 1..n, no two items in a list open on the
// same first two words, no bold, italic, bullets, sub-items or commentary.
// Whether each idea is a real, specific, faithful business stays a judged check
// in the fabric-businessideas suite.

import { readFileSync } from "node:fs";

const HELP = `BusinessIdeasCheck — shape check for a Fabric BusinessIdeas output

  bun skills/Fabric/Tools/BusinessIdeasCheck.ts <file|-> [--extracted N] [--elaborated N] [--json]

  --extracted N   require exactly N extracted ideas (the request named a count)
  --elaborated N  require exactly N elaborated ideas (default: the smaller of 10 and the extracted count)
  --json          print {ok, none, extracted, elaborated, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const MAX_EXTRACTED = 40;
export const DEFAULT_ELABORATED = 10;
export const EXTRACTED_WORDS = { min: 6, max: 30 };
export const ELABORATED_WORDS = { min: 12, max: 60 };
export const MAX_NONE_WORDS = 30;

export type Extracted = { n: number; line: number; text: string; words: number };
export type Elaborated = Extracted & { pivot: number | null };
export type Result = { ok: boolean; none: boolean; extracted: Extracted[]; elaborated: Elaborated[]; problems: string[] };

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

/** Narration in place of the idea: "The author suggests…", "This article describes…". */
const NARRATION =
  /^(?:the|this|in (?:the|this)) (?:author|writer|speaker|host|guest|article|essay|post|piece|text|video|talk|podcast|episode|transcript|source|paper|book|interview)s?,? (?:\w+ )?(?:argues?|says?|discuss(?:es)?|explains?|describes?|mentions?|talks?|notes?|claims?|suggests?|states?|explores?|proposes?|highlights?|covers?)\b/i;

const PIVOT = /\s*Pivot from #(\d+)\.\s*$/;
const key = (s: string) => words(s).map((w) => w.toLowerCase()).join(" ");
const opening = (s: string) => words(s).slice(0, 2).join(" ").toLowerCase();

export function check(input: string, opts: { extracted?: number; elaborated?: number } = {}): Result {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const extracted: Extracted[] = [];
  const elaborated: Elaborated[] = [];
  let none = false;
  let noneLines = 0;
  let section: "pre" | "extracted" | "elaborated" = "pre";
  let sawElaborated = false;

  const nonBlank = lines.map((l, i) => ({ raw: l, text: l.trim(), line: i + 1 })).filter((l) => l.text !== "");
  if (nonBlank.length === 0) return { ok: false, none, extracted, elaborated, problems: ["output is empty"] };

  if (/\*\*|__/.test(input) || /(^|[\s(])[*_][^\s*_][^*_\n]*[*_](?=$|[\s).,;:!?])/m.test(input))
    problems.push("bold or italic markup found; the output uses neither");

  for (const l of nonBlank) {
    if (/^##\s+Extracted Ideas\s*$/i.test(l.text)) {
      if (section !== "pre") problems.push(`line ${l.line}: "## Extracted Ideas" appears again or after the elaborated section`);
      section = "extracted";
      continue;
    }
    if (/^##\s+Elaborated Ideas\s*$/i.test(l.text)) {
      if (section !== "extracted" || sawElaborated) problems.push(`line ${l.line}: "## Elaborated Ideas" must follow the extracted list, once`);
      section = "elaborated";
      sawElaborated = true;
      continue;
    }
    if (section === "pre") {
      problems.push(`line ${l.line}: the output must open on "## Extracted Ideas", found "${l.text.slice(0, 60)}"`);
      section = "extracted";
      continue;
    }
    if (/^#{1,6}\s/.test(l.text)) {
      problems.push(`line ${l.line}: extra heading "${l.text}"; the output has only the two sections`);
      continue;
    }
    if (/^\s+(?:[-*+]|\d+[.)])\s/.test(l.raw)) {
      problems.push(`line ${l.line}: indented sub-item; every idea is a top-level numbered line`);
      continue;
    }
    if (/^[-*+]\s/.test(l.text)) {
      problems.push(`line ${l.line}: bullet; the lists are numbered ("1. ")`);
      continue;
    }
    const nm = l.text.match(/^None found:\s*(.*)$/i);
    if (nm) {
      none = true;
      noneLines++;
      if (section !== "extracted") problems.push(`line ${l.line}: "None found:" belongs under "## Extracted Ideas"`);
      const n = words(nm[1]).length;
      if (n === 0) problems.push(`line ${l.line}: "None found:" needs a reason`);
      if (n > MAX_NONE_WORDS) problems.push(`line ${l.line}: "None found:" reason has ${n} words, at most ${MAX_NONE_WORDS}`);
      continue;
    }
    const m = l.text.match(/^(\d+)\.\s+(.*\S)$/);
    if (!m) {
      problems.push(`line ${l.line}: commentary outside the lists ("${l.text.slice(0, 60)}")`);
      continue;
    }
    const n = Number(m[1]);
    const text = m[2];
    if (section === "extracted") {
      extracted.push({ n, line: l.line, text, words: words(text).length });
    } else {
      const pm = text.match(PIVOT);
      elaborated.push({ n, line: l.line, text, words: words(text.replace(PIVOT, "")).length, pivot: pm ? Number(pm[1]) : null });
    }
  }

  const listRules = (items: Extracted[], label: string, limits: { min: number; max: number }) => {
    const seen = new Map<string, number>();
    const opens = new Map<string, number>();
    items.forEach((it, idx) => {
      if (it.n !== idx + 1) problems.push(`line ${it.line}: ${label} item numbered ${it.n}, expected ${idx + 1}`);
      if (it.words < limits.min) problems.push(`line ${it.line}: ${label} item ${it.n} has ${it.words} words, at least ${limits.min} ("${it.text.slice(0, 60)}")`);
      if (it.words > limits.max) problems.push(`line ${it.line}: ${label} item ${it.n} has ${it.words} words, at most ${limits.max}`);
      if (NARRATION.test(it.text)) problems.push(`line ${it.line}: ${label} item ${it.n} narrates the source; state the business itself`);
      const k = key(it.text.replace(PIVOT, ""));
      if (seen.has(k)) problems.push(`line ${it.line}: ${label} item ${it.n} repeats line ${seen.get(k)}`);
      else seen.set(k, it.line);
      const o = opening(it.text);
      if (o.includes(" ")) {
        if (opens.has(o)) problems.push(`line ${it.line}: ${label} item ${it.n} opens on "${o}", like line ${opens.get(o)}`);
        else opens.set(o, it.line);
      }
    });
  };

  if (none) {
    if (noneLines > 1) problems.push(`${noneLines} "None found:" lines; there is one`);
    if (extracted.length > 0) problems.push('"None found:" sits beside extracted ideas; it is either the list or the one line');
    if (sawElaborated || elaborated.length > 0) problems.push('"None found:" output carries no "## Elaborated Ideas" section');
    return { ok: problems.length === 0, none, extracted, elaborated, problems };
  }

  if (extracted.length === 0) problems.push('no extracted ideas and no "None found:" line');
  if (extracted.length > MAX_EXTRACTED) problems.push(`${extracted.length} extracted ideas, at most ${MAX_EXTRACTED}`);
  if (opts.extracted !== undefined && extracted.length !== opts.extracted) problems.push(`expected ${opts.extracted} extracted ideas, found ${extracted.length}`);
  listRules(extracted, "extracted", EXTRACTED_WORDS);
  for (const it of extracted) if (!/[.?!]["'”’)]*$/.test(it.text)) problems.push(`line ${it.line}: extracted item ${it.n} is not a complete sentence; end it on . ? or !`);

  if (!sawElaborated) problems.push('missing "## Elaborated Ideas" section');
  const wantElab = opts.elaborated ?? Math.min(DEFAULT_ELABORATED, extracted.length);
  if (sawElaborated && elaborated.length !== wantElab) problems.push(`expected ${wantElab} elaborated ideas, found ${elaborated.length}`);
  listRules(elaborated, "elaborated", ELABORATED_WORDS);

  const pivots = new Map<number, number>();
  for (const it of elaborated) {
    const body = it.text.replace(PIVOT, "");
    const diffs = body.match(/Differentiator:/g)?.length ?? 0;
    if (diffs !== 1) problems.push(`line ${it.line}: elaborated item ${it.n} needs exactly one "Differentiator:", found ${diffs}`);
    else {
      const [biz, edge] = body.split("Differentiator:");
      if (words(biz).length < 6) problems.push(`line ${it.line}: elaborated item ${it.n} states the business in under 6 words before "Differentiator:"`);
      if (words(edge).length < 4) problems.push(`line ${it.line}: elaborated item ${it.n} has a differentiator under 4 words`);
    }
    if (it.pivot === null) {
      problems.push(`line ${it.line}: elaborated item ${it.n} must end on "Pivot from #k." naming the extracted idea it pivots from`);
      continue;
    }
    if (it.pivot < 1 || it.pivot > extracted.length) problems.push(`line ${it.line}: elaborated item ${it.n} pivots from #${it.pivot}, which is not an extracted idea`);
    else {
      const src = extracted[it.pivot - 1];
      if (key(src.text) === key(body.split("Differentiator:")[0] ?? "")) problems.push(`line ${it.line}: elaborated item ${it.n} restates #${it.pivot} instead of pivoting`);
    }
    if (pivots.has(it.pivot)) problems.push(`line ${it.line}: elaborated item ${it.n} pivots from #${it.pivot}, like line ${pivots.get(it.pivot)}; each pivots from a different idea`);
    else pivots.set(it.pivot, it.line);
  }

  return { ok: problems.length === 0, none, extracted, elaborated, problems };
}

function intFlag(args: string[], name: string): number | undefined | "bad" {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = Number(args[i + 1]);
  return Number.isInteger(v) && v >= 1 ? v : "bad";
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const ex = intFlag(args, "--extracted");
  const el = intFlag(args, "--elaborated");
  if (ex === "bad" || el === "bad") {
    console.error("--extracted and --elaborated need a whole number of at least 1");
    process.exit(2);
  }
  const valueIdx = new Set(["--extracted", "--elaborated"].map((f) => args.indexOf(f)).filter((i) => i >= 0).map((i) => i + 1));
  const unknown = args.find((a, i) => a.startsWith("--") && !["--json", "--extracted", "--elaborated"].includes(a) && !valueIdx.has(i));
  if (unknown) {
    console.error(`unknown flag ${unknown}\n\n${HELP}`);
    process.exit(2);
  }
  const src = args.find((a, i) => (a === "-" || !a.startsWith("--")) && !valueIdx.has(i));
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input, { extracted: ex, elaborated: el });
  if (json) console.log(JSON.stringify({ ok: r.ok, none: r.none, extracted: r.extracted, elaborated: r.elaborated, problems: r.problems }));
  else if (r.ok) console.log(r.none ? "✓ none found, shape holds" : `✓ ${r.extracted.length} extracted, ${r.elaborated.length} elaborated, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
