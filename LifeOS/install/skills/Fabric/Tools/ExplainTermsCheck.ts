#!/usr/bin/env bun
// ExplainTermsCheck — checks an ExplainTerms output against the parts of its
// contract code can judge: one bold heading, then entries shaped
// `- **Term**: definition` each followed by exactly two indented sub-bullets,
// `- Analogy: …` then `- Why it matters: …`; a definition of at most two
// sentences and 60 words, sub-bullets of at most two sentences and 40 words;
// no term twice; no definition that opens by restating its own term; no
// definition that leans on a distinctive term explained further down; or the
// single `**No terms to explain:**` line. With --source every term must appear
// in the input; with --count the number of entries must match. Whether each
// definition is right, in the content's sense, and whether each analogy maps
// how the term works stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `ExplainTermsCheck — shape check for a Fabric ExplainTerms output

  bun skills/Fabric/Tools/ExplainTermsCheck.ts <file|-> [--source <input-file>] [--count N] [--json]

  --source F  the input; every term (or its abbreviation) must appear in it
  --count N   the exact number of terms a hint asked for
  --json      print {ok, noTerms, heading, terms, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const DEF_MAX_WORDS = 60;
export const DEF_MAX_SENTENCES = 2;
export const SUB_MAX_WORDS = 40;
export const SUB_MAX_SENTENCES = 2;

const HEADING = /^\*\*([^*].*?)\*\*$/;
const NO_TERMS = /^\*\*No terms to explain:\*\*[ \t]+\S/;
// `- **Term**: definition` or `- **Term:** definition`, at the left margin.
const ENTRY = /^ ?[-*][ \t]+\*\*([^*]+?)(:?)\*\*(:?)[ \t]+(\S.*)$/;
const SUB = /^(?:[ \t]{2,}|\t)[-*][ \t]+(Analogy|Why it matters):[ \t]+(\S.*)$/i;
const PLACEHOLDER = /\{[^}]*\}/;
const NUMBERED = /^\s*\d+[.)][ \t]+\S/;
const DOUBLE_DASH = /^\s*--[ \t]*\S/;

export type Term = { term: string; definition: string; analogy?: string; whyItMatters?: string; line: number };
export type Result = { ok: boolean; noTerms: boolean; heading?: string; terms: Term[]; problems: string[] };

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
    .replace(/[-–—_/]/g, " ")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sentences, with common abbreviations and initials kept whole. */
export function sentences(text: string): string[] {
  const masked = text
    .replace(/`[^`]*`/g, "CODE")
    .replace(/\b(e\.g|i\.e|etc|vs|cf|approx|Mr|Mrs|Ms|Dr|St|Inc|Ltd|Corp|No)\./gi, "$1")
    .replace(/\b([A-Za-z])\.(?=[A-Za-z]\.|\s)/g, "$1")
    .replace(/(\d)\.(\d)/g, "$1$2");
  return masked
    .split(/(?<=[.!?])["')\]]*\s+(?=["'(\[]?[A-Z0-9`])/)
    .map((s) => s.trim())
    .filter((s) => words(s).length > 0);
}

/** The forms a term can take in text: the whole label, and each side of `Full name (ABBR)`. */
export function variants(term: string): string[] {
  const out = new Set<string>();
  const m = term.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (m) {
    out.add(normalize(m[1]));
    out.add(normalize(m[2]));
  }
  out.add(normalize(term));
  return [...out].filter((v) => v.length > 0);
}

/** A term distinctive enough that its appearance in another definition is a reference to it, not an everyday word. */
export function distinctive(variant: string, raw: string): boolean {
  return variant.includes(" ") || /[A-Z]{2,}|\d|-/.test(raw);
}

function inflections(v: string): string[] {
  const out = [v, `${v}s`, `${v}es`];
  if (v.endsWith("s")) out.push(v.slice(0, -1));
  if (v.endsWith("y")) out.push(`${v.slice(0, -1)}ies`);
  if (v.endsWith("ies")) out.push(`${v.slice(0, -3)}y`);
  return out;
}

export function mentions(haystack: string, term: string): boolean {
  const h = ` ${normalize(haystack)} `;
  return variants(term).some((v) => inflections(v).some((f) => h.includes(` ${f} `)));
}

export function check(input: string, opts: { source?: string; count?: number } = {}): Result {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const terms: Term[] = [];
  const content = lines.map((raw, i) => ({ raw: raw.replace(/\s+$/, ""), line: i + 1 })).filter((l) => l.raw.trim() !== "");

  if (content.length === 0) return { ok: false, noTerms: false, terms, problems: ["empty output"] };

  const noTermsLine = content.find((l) => NO_TERMS.test(l.raw.trim()));
  if (noTermsLine) {
    if (content.length > 1) problems.push(`line ${noTermsLine.line}: the **No terms to explain:** line must be the whole output`);
    if (opts.count !== undefined && opts.count > 0) problems.push(`--count ${opts.count} set, but the output says there are no terms`);
    return { ok: problems.length === 0, noTerms: true, terms, problems };
  }

  let heading: string | undefined;
  let current: Term | undefined;
  content.forEach((l, idx) => {
    const t = l.raw.trim();
    if (PLACEHOLDER.test(t)) problems.push(`line ${l.line}: template placeholder left in ("${t}")`);
    if (NUMBERED.test(l.raw)) {
      problems.push(`line ${l.line}: numbered list; each term is a "- **Term**: definition" bullet`);
      return;
    }
    if (DOUBLE_DASH.test(l.raw)) {
      problems.push(`line ${l.line}: "--" line renders as part of the paragraph above; use an indented "- Analogy:" or "- Why it matters:" sub-bullet`);
      return;
    }
    const sub = l.raw.match(SUB);
    if (sub) {
      const label = sub[1].toLowerCase();
      const text = sub[2].trim();
      if (!current) {
        problems.push(`line ${l.line}: "${sub[1]}:" sub-bullet with no term above it`);
        return;
      }
      if (label === "analogy") {
        if (current.analogy !== undefined) problems.push(`line ${l.line}: second Analogy for "${current.term}"`);
        else if (current.whyItMatters !== undefined) problems.push(`line ${l.line}: Analogy for "${current.term}" comes after Why it matters; Analogy goes first`);
        current.analogy = text;
      } else {
        if (current.whyItMatters !== undefined) problems.push(`line ${l.line}: second Why it matters for "${current.term}"`);
        current.whyItMatters = text;
      }
      const w = words(text).length;
      const s = sentences(text).length;
      if (w > SUB_MAX_WORDS) problems.push(`line ${l.line}: ${sub[1]} for "${current.term}" has ${w} words (at most ${SUB_MAX_WORDS})`);
      if (s > SUB_MAX_SENTENCES) problems.push(`line ${l.line}: ${sub[1]} for "${current.term}" has ${s} sentences (at most ${SUB_MAX_SENTENCES})`);
      return;
    }
    const e = l.raw.match(ENTRY);
    if (e) {
      const [, termRaw, colonIn, colonOut, def] = e;
      if (!colonIn && !colonOut) {
        problems.push(`line ${l.line}: term "${termRaw}" needs a colon after it ("- **Term**: definition")`);
      }
      if (colonIn && colonOut) problems.push(`line ${l.line}: two colons after "${termRaw}"`);
      current = { term: termRaw.trim(), definition: def.trim(), line: l.line };
      terms.push(current);
      const w = words(def).length;
      const s = sentences(def).length;
      if (w > DEF_MAX_WORDS) problems.push(`line ${l.line}: definition of "${current.term}" has ${w} words (at most ${DEF_MAX_WORDS})`);
      if (s > DEF_MAX_SENTENCES) problems.push(`line ${l.line}: definition of "${current.term}" has ${s} sentences (at most ${DEF_MAX_SENTENCES})`);
      const nd = normalize(def);
      const restates = variants(current.term).some((v) => nd.startsWith(`${v} `) || nd === v || ` ${nd} `.includes(` the term ${v} `));
      if (restates) problems.push(`line ${l.line}: definition of "${current.term}" opens by restating the term; say what it is`);
      return;
    }
    if (/^\s*[-*][ \t]/.test(l.raw)) {
      problems.push(`line ${l.line}: line not in the shape "- **Term**: definition" or an indented "- Analogy:" / "- Why it matters:" sub-bullet ("${t}")`);
      return;
    }
    const h = t.match(HEADING);
    if (h && idx === 0) {
      heading = h[1].trim();
      return;
    }
    problems.push(`line ${l.line}: ${idx === 0 ? "first line is not a bold heading" : "commentary outside the heading and the entries"} ("${t}")`);
  });

  if (heading === undefined && !problems.some((p) => p.includes("first line"))) problems.push("no bold heading naming the read");
  if (terms.length === 0) problems.push('no terms found (each is a bullet such as - **Circuit breaker**: definition)');

  for (const term of terms) {
    if (term.analogy === undefined) problems.push(`line ${term.line}: "${term.term}" has no "- Analogy:" sub-bullet`);
    if (term.whyItMatters === undefined) problems.push(`line ${term.line}: "${term.term}" has no "- Why it matters:" sub-bullet`);
  }

  const seen = new Map<string, number>();
  for (const term of terms) {
    for (const v of variants(term.term)) {
      const prior = seen.get(v);
      if (prior !== undefined && prior !== term.line) {
        problems.push(`line ${term.line}: "${term.term}" already explained on line ${prior}`);
        break;
      }
    }
    for (const v of variants(term.term)) if (!seen.has(v)) seen.set(v, term.line);
  }

  // A definition leans only on everyday words and terms explained above it.
  terms.forEach((a, i) => {
    for (const b of terms.slice(i + 1)) {
      const raw = b.term;
      const used = variants(raw).some((v) => distinctive(v, raw) && mentions(a.definition, v));
      if (used) problems.push(`line ${a.line}: definition of "${a.term}" uses "${b.term}", which is explained later (line ${b.line}); put "${b.term}" first`);
    }
  });

  if (opts.count !== undefined && terms.length !== opts.count) problems.push(`${terms.length} terms; the hint asked for ${opts.count}`);

  if (opts.source !== undefined) {
    for (const term of terms) {
      if (!mentions(opts.source, term.term)) problems.push(`line ${term.line}: "${term.term}" does not appear in the source; explain only terms the content uses`);
    }
  }

  return { ok: problems.length === 0, noTerms: false, heading, terms, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const si = args.indexOf("--source");
  const ci = args.indexOf("--count");
  if (si >= 0 && (args[si + 1] === undefined || args[si + 1].startsWith("--"))) {
    console.error("--source needs a file path");
    process.exit(2);
  }
  const count = ci >= 0 ? Number(args[ci + 1]) : undefined;
  if (ci >= 0 && (!Number.isInteger(count) || (count as number) < 0)) {
    console.error("--count needs a whole number of 0 or more");
    process.exit(2);
  }
  const valueAt = new Set([si, ci].filter((i) => i >= 0).map((i) => i + 1));
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
  const r = check(input, { source, count });
  if (json) console.log(JSON.stringify({ ok: r.ok, noTerms: r.noTerms, heading: r.heading, terms: r.terms, problems: r.problems }));
  else if (r.ok) console.log(r.noTerms ? "✓ no-terms line, shape holds" : `✓ ${r.terms.length} terms, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
