#!/usr/bin/env bun
// RhetoricalLensCheck — checks a RhetoricalLens output against the parts of its
// contract code can judge: one "# Rhetorical Lens:" title, only the Source and
// Answer lines between it and the sections, the six sections (or the hinted
// subset) in canonical order and non-empty, Notable techniques as named bullets,
// quotations present where a supplied text requires them, and, with --source,
// every quotation found word for word in that text and the analysis inside the
// word budget that text's length sets (--max-words caps it when there is no
// text). Whether the analysis is
// about how rather than what, and specific to the text, stays judged.

import { readFileSync } from "node:fs";

const HELP = `RhetoricalLensCheck — shape check for a Fabric RhetoricalLens output

  bun skills/Fabric/Tools/RhetoricalLensCheck.ts <file|-> [--source <text-file>] [--max-words N] [--sections <list>] [--json]

  --source F    the supplied text; every quotation must appear in it, no **Source:** line is allowed,
                and the analysis fits the word budget the text's length sets
  --max-words N cap the analysis at N words (overrides the budget from --source)
  --sections L  comma list of the sections a hint asked for (ethos, pathos, logos, kairos,
                audience, techniques); the output must hold exactly those, in canonical order
  --json        print {ok, sections, techniques, quotes, words, budget, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const SECTIONS = ["Ethos", "Pathos", "Logos", "Kairos", "Audience construction", "Notable techniques"] as const;
export type Section = (typeof SECTIONS)[number];
/** Sections that must quote the text when a text was supplied. Kairos is about context, so it may not. */
export const QUOTING: readonly Section[] = ["Ethos", "Pathos", "Logos", "Audience construction", "Notable techniques"];

const ALIASES: Record<string, Section> = {
  ethos: "Ethos",
  pathos: "Pathos",
  logos: "Logos",
  kairos: "Kairos",
  audience: "Audience construction",
  "audience construction": "Audience construction",
  techniques: "Notable techniques",
  "notable techniques": "Notable techniques",
};

export function parseSections(list: string): Section[] | string {
  const out: Section[] = [];
  for (const raw of list.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const s = ALIASES[raw];
    if (!s) return `unknown section "${raw}" (use ${Object.keys(ALIASES).filter((k) => !k.includes(" ")).join(", ")})`;
    if (!out.includes(s)) out.push(s);
  }
  if (out.length === 0) return "--sections needs at least one section";
  return SECTIONS.filter((s) => out.includes(s));
}

/** Letters and digits only, lowercased, apostrophes dropped, so punctuation and curly quotes never decide a match. */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’‘`]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/** Double-quoted spans, straight or curly. */
export function quotations(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"\n]+)"|“([^”\n]+)”/g)) out.push((m[1] ?? m[2]).trim());
  return out.filter((q) => tokens(q).length > 0);
}

/** A quotation matches when each fragment (split at ellipses and [bracketed] insertions) appears in the source as a token run. */
export function inSource(quote: string, sourceTokens: string): boolean {
  const fragments = quote.split(/\.\.\.|…|\[[^\]]*\]/).map((f) => tokens(f)).filter((f) => f.length > 0);
  if (fragments.length === 0) return true;
  return fragments.every((f) => ` ${sourceTokens} `.includes(` ${f.join(" ")} `));
}

/** The word budget for a whole analysis, from the analyzed text's length in words. */
export function budget(sourceWords: number): number {
  if (sourceWords < 50) return 250;
  if (sourceWords < 300) return 600;
  if (sourceWords < 1500) return 1000;
  return 1500;
}

/** Words as a reader counts them: whitespace-separated tokens holding a letter or digit. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

type Row = { text: string; line: number };

export function check(
  input: string,
  opts: { source?: string; sections?: Section[]; maxWords?: number } = {},
): { ok: boolean; sections: string[]; techniques: number; quotes: number; words: number; budget?: number; problems: string[] } {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const expected: readonly Section[] = opts.sections ?? SECTIONS;
  const sourceTokens = opts.source !== undefined ? tokens(opts.source).join(" ") : undefined;

  const firstContent = lines.findIndex((l) => l.trim() !== "");
  const limit = opts.maxWords ?? (opts.source !== undefined ? budget(wordCount(opts.source)) : undefined);
  if (firstContent < 0) return { ok: false, sections: [], techniques: 0, quotes: 0, words: 0, budget: limit, problems: ["empty output"] };
  const words = wordCount(lines.filter((l) => !/^#{1,6}\s/.test(l)).join("\n"));
  if (limit !== undefined && words > limit) problems.push(`the analysis has ${words} words; the budget for this text is ${limit}`);

  // Title.
  const h1 = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^#\s/.test(l));
  if (h1.length !== 1) problems.push(`expected exactly one H1 title, found ${h1.length}`);
  else {
    if (!/^#\s+Rhetorical Lens:\s+\S/.test(h1[0].l)) problems.push(`line ${h1[0].i + 1}: the title opens "# Rhetorical Lens: " and names the text`);
    if (firstContent !== h1[0].i) problems.push(`line ${firstContent + 1}: text before the title`);
  }

  // Sections.
  const h2 = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^##\s/.test(l));
  const names = h2.map(({ l }) => l.replace(/^##\s+/, "").trim());
  if (names.map((n) => n.toLowerCase()).join("|") !== expected.map((s) => s.toLowerCase()).join("|")) {
    problems.push(`sections must be exactly ${expected.join(", ")} in that order; found ${names.length ? names.join(", ") : "none"}`);
  }
  if (h1.length === 1 && h2.length && h2[0].i < h1[0].i) problems.push("the title comes before every section");

  // Header block between the title and the first section: only **Source:** then **Answer:**.
  let hasSource = false;
  if (h1.length === 1) {
    const end = h2.length ? h2[0].i : lines.length;
    const header = lines.slice(h1[0].i + 1, end).map((text, k) => ({ text, line: h1[0].i + 2 + k })).filter((r) => r.text.trim() !== "");
    let seenAnswer = false;
    for (const r of header) {
      const t = r.text.trim();
      if (/^\*\*Source:\*\*\s+\S/.test(t)) {
        if (hasSource) problems.push(`line ${r.line}: more than one **Source:** line`);
        if (seenAnswer) problems.push(`line ${r.line}: **Source:** comes before **Answer:**`);
        hasSource = true;
      } else if (/^\*\*Answer:\*\*\s+\S/.test(t)) {
        if (seenAnswer) problems.push(`line ${r.line}: more than one **Answer:** line`);
        seenAnswer = true;
      } else problems.push(`line ${r.line}: only a **Source:** or **Answer:** line may sit between the title and the first section ("${t.slice(0, 60)}")`);
    }
  }
  if (hasSource && opts.source !== undefined) problems.push("a text was supplied (--source), so there is no **Source:** line");

  const body = (idx: number): Row[] => {
    const end = idx + 1 < h2.length ? h2[idx + 1].i : lines.length;
    return lines.slice(h2[idx].i + 1, end).map((text, k) => ({ text, line: h2[idx].i + 2 + k }));
  };

  // Quotations are required in the quoting sections whenever the text was supplied (no **Source:** line).
  const quotesRequired = !hasSource;
  let allQuotes = 0;
  let techniques = 0;

  h2.forEach(({ i }, idx) => {
    const name = names[idx];
    const rows = body(idx).filter((r) => r.text.trim() !== "");
    if (rows.length === 0) {
      problems.push(`line ${i + 1}: ${name} is empty`);
      return;
    }
    const text = rows.map((r) => r.text).join("\n");
    const qs = quotations(text);
    allQuotes += qs.length;
    const canonical = SECTIONS.find((s) => s.toLowerCase() === name.toLowerCase());
    if (quotesRequired && canonical && QUOTING.includes(canonical) && qs.length === 0) {
      problems.push(`line ${i + 1}: ${name} quotes nothing from the text`);
    }
    if (sourceTokens !== undefined) {
      for (const q of qs) if (!inSource(q, sourceTokens)) problems.push(`${name}: quotation not found in the source ("${q.slice(0, 80)}")`);
    }
    if (canonical === "Notable techniques") {
      for (const r of rows) {
        if (/^\s*[-*]\s+\S/.test(r.text)) {
          techniques++;
          const item = r.text.replace(/^\s*[-*]\s+/, "");
          const m = item.match(/^\*\*([^*:]{2,80}):\*\*\s+(.*\S)/) ?? item.match(/^([^*:"“]{2,80}):\s+(.*\S)/);
          if (!m) problems.push(`line ${r.line}: a technique bullet opens on its name and a colon ("- **Anaphora:** …")`);
          else if (quotesRequired && quotations(m[2]).length === 0) problems.push(`line ${r.line}: technique "${m[1].trim()}" points to no quotation from the text`);
        } else if (!/^\s{2,}\S/.test(r.text)) {
          problems.push(`line ${r.line}: Notable techniques holds only technique bullets ("${r.text.trim().slice(0, 60)}")`);
        }
      }
      if (techniques < 1 || techniques > 10) problems.push(`Notable techniques has ${techniques} bullets; expected 1 to 10`);
    }
  });

  return { ok: problems.length === 0, sections: names, techniques, quotes: allQuotes, words, budget: limit, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const valued = new Set(["--source", "--sections", "--max-words"]);
  const known = new Set(["--json", ...valued]);
  const unknown = args.filter((a) => a.startsWith("--") && !known.has(a));
  if (unknown.length) {
    console.error(`unknown flag ${unknown[0]}`);
    process.exit(2);
  }
  const value = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) {
      console.error(`${flag} needs a value`);
      process.exit(2);
    }
    return v;
  };
  const sourcePath = value("--source");
  const sectionsArg = value("--sections");
  const maxArg = value("--max-words");
  const maxWords = maxArg !== undefined ? Number(maxArg) : undefined;
  if (maxWords !== undefined && (!Number.isInteger(maxWords) || maxWords < 1)) {
    console.error("--max-words needs a whole number of at least 1");
    process.exit(2);
  }
  const positional = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1] ?? ""));
  const src = positional[0];

  let sections: Section[] | undefined;
  if (sectionsArg !== undefined) {
    const parsed = parseSections(sectionsArg);
    if (typeof parsed === "string") {
      console.error(parsed);
      process.exit(2);
    }
    sections = parsed;
  }
  const read = (p: string | undefined, what: string): string => {
    try {
      return p === undefined || p === "-" ? readFileSync(0, "utf8") : readFileSync(p, "utf8");
    } catch (e) {
      console.error(`cannot read ${what} ${p ?? "stdin"}: ${(e as Error).message}`);
      process.exit(2);
    }
  };
  if (src === "-" && sourcePath === "-") {
    console.error("only one of the output and --source can be stdin");
    process.exit(2);
  }
  const input = read(src, "output");
  const source = sourcePath !== undefined ? read(sourcePath, "source") : undefined;
  const r = check(input, { source, sections, maxWords });
  if (json) console.log(JSON.stringify(r));
  else if (r.ok) console.log(`✓ ${r.sections.length} sections, ${r.techniques} techniques, ${r.quotes} quotations, ${r.words}${r.budget ? `/${r.budget}` : ""} words, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
