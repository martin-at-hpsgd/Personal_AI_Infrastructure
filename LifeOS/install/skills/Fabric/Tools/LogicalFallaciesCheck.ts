#!/usr/bin/env bun
// LogicalFallaciesCheck — checks a LogicalFallacies output against the parts of
// its contract code can judge: the one "## Fallacies" heading, each item as
// `- Name: Type — "quote" — explanation` with a Type from the fixed family list
// and an explanation of at most 15 words, or the single "None found:" line;
// no bold or italic, no commentary, no duplicate items; and, with --source,
// every quote not marked "Common form:" found verbatim in the input. Whether a
// listed fallacy is really committed stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `LogicalFallaciesCheck — shape check for a Fabric LogicalFallacies output

  bun skills/Fabric/Tools/LogicalFallaciesCheck.ts <file|-> [--source <input-file>] [--json]

  --source F  the input text; every quote not marked "Common form:" must appear in it
  --json      print {ok, none, fallacies, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const TYPES = [
  "Formal",
  "Propositional",
  "Quantification",
  "Syllogistic",
  "Informal",
  "Improper premise",
  "Faulty generalization",
  "Questionable cause",
  "Statistical",
  "Relevance",
  "Red herring",
] as const;

export const MAX_EXPLANATION_WORDS = 15;
export const MAX_NONE_WORDS = 30;

export type Fallacy = {
  line: number;
  name: string;
  type: string;
  quote: string;
  commonForm: boolean;
  explanation: string;
  words: number;
};

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

/** Lowercase, straighten quotes and apostrophes, collapse whitespace. */
export function normalize(s: string): string {
  return s
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Each piece of a quote, split on an ellipsis, with edge punctuation trimmed. */
export function quotePieces(quote: string): string[] {
  return quote
    .split(/…|\.\.\./)
    .map((p) => normalize(p).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((p) => p.length > 0);
}

const ITEM = /^- (.+?): (.+?) — (Common form: )?"(.+)" — (.+)$/;
const ITEM_CURLY = /^- (.+?): (.+?) — (Common form: )?“(.+)” — (.+)$/;

export function check(input: string, source?: string): { ok: boolean; none: boolean; fallacies: Fallacy[]; problems: string[] } {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const fallacies: Fallacy[] = [];
  let none = false;
  let noneLines = 0;

  const nonBlank = lines.map((l, i) => ({ raw: l, text: l.trim(), line: i + 1 })).filter((l) => l.text !== "");
  if (nonBlank.length === 0) return { ok: false, none, fallacies, problems: ["output is empty"] };

  const headings = nonBlank.filter((l) => /^#{1,6}\s/.test(l.text));
  const first = nonBlank[0];
  if (!/^##\s+Fallacies\s*$/i.test(first.text)) problems.push(`line ${first.line}: the output must open on "## Fallacies", found "${first.text}"`);
  for (const h of headings) if (h !== first) problems.push(`line ${h.line}: extra heading "${h.text}"; the output is one Fallacies section`);

  if (/\*\*|__/.test(input) || /(^|[\s(])[*_][^\s*_][^*_\n]*[*_](?=$|[\s).,;:!?])/m.test(input))
    problems.push("bold or italic markup found; the output uses neither");

  const seen = new Map<string, number>();
  for (const l of nonBlank.slice(1)) {
    if (/^#{1,6}\s/.test(l.text)) continue;
    if (/^\d+[.)]\s/.test(l.text)) {
      problems.push(`line ${l.line}: numbered list; each item is a "- " bullet`);
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
    const m = l.text.match(ITEM) ?? l.text.match(ITEM_CURLY);
    if (!m) {
      problems.push(`line ${l.line}: item is not "- Name: Type — \\"exact words\\" — explanation" (em-dashes, quoted words)`);
      continue;
    }
    const [, name, type, cf, quote, explanation] = m;
    const f: Fallacy = { line: l.line, name: name.trim(), type: type.trim(), quote: quote.trim(), commonForm: Boolean(cf), explanation: explanation.trim(), words: words(explanation).length };
    fallacies.push(f);
    if (!TYPES.some((t) => t.toLowerCase() === f.type.toLowerCase()))
      problems.push(`line ${l.line}: type "${f.type}" is not one of ${TYPES.join(", ")}`);
    if (words(f.quote).length === 0) problems.push(`line ${l.line}: empty quote`);
    if (f.words === 0) problems.push(`line ${l.line}: no explanation`);
    if (f.words > MAX_EXPLANATION_WORDS) problems.push(`line ${l.line}: explanation has ${f.words} words, at most ${MAX_EXPLANATION_WORDS}`);
    const key = `${normalize(f.name)}|${normalize(f.quote)}`;
    if (seen.has(key)) problems.push(`line ${l.line}: repeats the item on line ${seen.get(key)}`);
    else seen.set(key, l.line);
    if (source !== undefined && !f.commonForm) {
      const hay = normalize(source);
      for (const p of quotePieces(f.quote))
        if (!hay.includes(p)) problems.push(`line ${l.line}: quote "${p}" is not the input's exact words`);
    }
  }

  if (none && fallacies.length > 0) problems.push('"None found:" sits beside listed fallacies; it is either the list or the one line');
  if (noneLines > 1) problems.push(`${noneLines} "None found:" lines; there is one`);
  if (!none && fallacies.length === 0) problems.push('no fallacy items and no "None found:" line');

  return { ok: problems.length === 0, none, fallacies, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const si = args.indexOf("--source");
  if (si >= 0 && (args[si + 1] === undefined || args[si + 1].startsWith("--"))) {
    console.error("--source needs a file");
    process.exit(2);
  }
  const unknown = args.find((a, i) => a.startsWith("--") && a !== "--json" && a !== "--source" && a !== "-" && !(si >= 0 && i === si + 1));
  if (unknown) {
    console.error(`unknown flag ${unknown}\n\n${HELP}`);
    process.exit(2);
  }
  const src = args.find((a, i) => (a === "-" || !a.startsWith("--")) && !(si >= 0 && i === si + 1));
  let input: string;
  let source: string | undefined;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
    if (si >= 0) source = readFileSync(args[si + 1], "utf8");
  } catch (e) {
    console.error(`cannot read input: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input, source);
  if (json) console.log(JSON.stringify({ ok: r.ok, none: r.none, fallacies: r.fallacies, problems: r.problems }));
  else if (r.ok) console.log(r.none ? "✓ none found, shape holds" : `✓ ${r.fallacies.length} fallacies, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
