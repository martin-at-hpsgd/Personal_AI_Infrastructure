#!/usr/bin/env bun
// ExtractPatternsCheck — checks an ExtractPatterns output against the parts of
// its contract code can judge: one "# Patterns:" title, then either the single
// "None found:" line under ## Patterns or the five sections in order (Patterns,
// Meta, Analysis, Best N, Advice for Builders), with the bullet counts and word
// limits the intent states. Whether a pattern truly recurs, and whether its
// count matches the input, stays a judged check in the fabric-extractpatterns suite.

import { readFileSync } from "node:fs";

const HELP = `ExtractPatternsCheck — shape check for a Fabric ExtractPatterns output

  bun skills/Fabric/Tools/ExtractPatternsCheck.ts <file|-> [--count N] [--json]

  --count N  also require exactly N patterns (when the request named a count)
  --json     print {ok, none, patterns, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const SECTIONS = ["Patterns", "Meta", "Analysis", "Best", "Advice for Builders"] as const;
export const LIMITS = {
  patterns: { min: 3, max: 16, maxItems: 50 },
  meta: { max: 20 },
  analysis: { min: 8, max: 30 },
  best: { min: 8, max: 30, items: 5 },
  advice: { min: 4, max: 15, maxItems: 15 },
};

type Line = { text: string; line: number };
type Section = { name: string; heading: string; line: number; body: Line[] };

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

export function norm(text: string): string {
  return text.trim().replace(/\s+/g, " ").replace(/[.;!?]+$/, "").toLowerCase();
}

function bullets(sec: Section, problems: string[]): string[] {
  const out: string[] = [];
  for (const r of sec.body) {
    if (/^\s+[-*+]\s/.test(r.text)) { problems.push(`line ${r.line}: nested bullet in ${sec.heading}; every item is one top-level bullet`); continue; }
    if (/^\s*\d+[.)]\s/.test(r.text)) { problems.push(`line ${r.line}: numbered list in ${sec.heading}; use "- " bullets`); continue; }
    const b = r.text.match(/^[-*+]\s+(.*\S)\s*$/);
    if (b) out.push(b[1]);
    else problems.push(`line ${r.line}: text in ${sec.heading} that is not a bullet ("${r.text.trim().slice(0, 60)}")`);
  }
  return out;
}

function sized(items: string[], label: string, min: number, max: number, problems: string[]) {
  items.forEach((t, i) => {
    const n = words(t).length;
    if (n > max) problems.push(`${label} ${i + 1} has ${n} words; at most ${max} ("${t.slice(0, 60)}")`);
    if (n < min) problems.push(`${label} ${i + 1} has ${n} words; at least ${min} ("${t.slice(0, 60)}")`);
  });
}

export function check(input: string, count?: number): { ok: boolean; none: boolean; patterns: string[]; problems: string[] } {
  const problems: string[] = [];
  const rows: Line[] = input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((text, i) => ({ text: text.replace(/\s+$/, ""), line: i + 1 }))
    .filter((r) => r.text.trim() !== "");
  if (rows.length === 0) return { ok: false, none: false, patterns: [], problems: ["the output is empty"] };

  const [title, ...rest] = rows;
  if (!/^#\s+Patterns:\s+\S/.test(title.text)) problems.push(`line ${title.line}: the output opens on a "# Patterns: " title naming the source and the read`);

  const sections: Section[] = [];
  for (const r of rest) {
    const h = r.text.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (h) {
      if (h[1] !== "##") problems.push(`line ${r.line}: heading "${r.text.trim()}" is not an H2 section`);
      sections.push({ name: h[2], heading: h[2], line: r.line, body: [] });
    } else if (sections.length === 0) {
      problems.push(`line ${r.line}: text between the title and ## Patterns ("${r.text.trim().slice(0, 60)}")`);
    } else sections[sections.length - 1].body.push(r);
  }

  // The none-found form: title, ## Patterns, one "None found:" line.
  const first = sections[0];
  if (first && first.heading === "Patterns" && first.body.some((r) => /^None found:/.test(r.text.trim()))) {
    if (sections.length !== 1) problems.push(`the none-found form is the title, ## Patterns and one "None found:" line; found ${sections.length} sections`);
    if (first.body.length !== 1) problems.push(`the none-found form has exactly one line under ## Patterns; found ${first.body.length}`);
    if (!/^None found:\s+\S+(\s+\S+){2,}/.test(first.body[0].text.trim())) problems.push(`line ${first.body[0].line}: "None found:" says what the input is and why nothing recurs`);
    return { ok: problems.length === 0, none: true, patterns: [], problems };
  }

  // Five sections in order.
  const names = sections.map((s) => s.heading);
  const expectedOrder = ["Patterns", "Meta", "Analysis", "Best N", "Advice for Builders"];
  const matches =
    names.length === 5 &&
    names[0] === "Patterns" &&
    names[1] === "Meta" &&
    names[2] === "Analysis" &&
    /^Best [1-5]$/.test(names[3]) &&
    names[4] === "Advice for Builders";
  if (!matches) {
    problems.push(`sections must be exactly ${expectedOrder.map((n) => `## ${n}`).join(", ")} in that order; found ${names.length ? names.map((n) => `## ${n}`).join(", ") : "none"}`);
    return { ok: false, none: false, patterns: [], problems };
  }
  const [pSec, mSec, aSec, bSec, vSec] = sections;

  // Patterns.
  const patterns = bullets(pSec, problems);
  if (patterns.length === 0) problems.push('## Patterns has no bullets (or use the single line "None found: …")');
  if (patterns.length > LIMITS.patterns.maxItems) problems.push(`${patterns.length} patterns; at most ${LIMITS.patterns.maxItems}`);
  if (count !== undefined && patterns.length !== count) problems.push(`expected ${count} patterns (the requested count), found ${patterns.length}`);
  sized(patterns, "pattern", LIMITS.patterns.min, LIMITS.patterns.max, problems);
  const seen = new Set<string>();
  const openings = new Map<string, number>();
  patterns.forEach((p, i) => {
    const k = norm(p);
    if (seen.has(k)) problems.push(`pattern ${i + 1} repeats an earlier pattern ("${p.slice(0, 60)}")`);
    seen.add(k);
    const open = words(p).slice(0, 2).join(" ").toLowerCase();
    if (open.split(" ").length === 2) {
      if (openings.has(open)) problems.push(`pattern ${i + 1} opens on the same two words as pattern ${openings.get(open)} ("${open}")`);
      else openings.set(open, i + 1);
    }
  });

  // Meta: one bullet per pattern, each carrying its count in digits.
  const meta = bullets(mSec, problems);
  if (meta.length !== patterns.length) problems.push(`## Meta has ${meta.length} bullets for ${patterns.length} patterns; one per pattern, in the same order`);
  sized(meta, "meta bullet", 1, LIMITS.meta.max, problems);
  meta.forEach((m, i) => { if (!/\d/.test(m)) problems.push(`meta bullet ${i + 1} gives no count in digits ("${m.slice(0, 60)}")`); });

  // Analysis: one line, not a bullet.
  if (aSec.body.length !== 1) problems.push(`## Analysis is one sentence on one line; found ${aSec.body.length} lines`);
  else if (/^\s*([-*+]|\d+[.)])\s/.test(aSec.body[0].text)) problems.push(`line ${aSec.body[0].line}: ## Analysis is a sentence, not a list item`);
  else {
    const n = words(aSec.body[0].text).length;
    if (n > LIMITS.analysis.max || n < LIMITS.analysis.min) problems.push(`## Analysis has ${n} words; ${LIMITS.analysis.min} to ${LIMITS.analysis.max}`);
  }

  // Best N: N = min(5, patterns).
  const wantBest = Math.min(LIMITS.best.items, patterns.length);
  const headedBest = Number(bSec.heading.split(" ")[1]);
  if (patterns.length > 0 && headedBest !== wantBest) problems.push(`line ${bSec.line}: heading is "## Best ${headedBest}"; with ${patterns.length} patterns it is "## Best ${wantBest}"`);
  const best = bullets(bSec, problems);
  if (best.length !== headedBest) problems.push(`## ${bSec.heading} has ${best.length} bullets; exactly ${headedBest}`);
  sized(best, "best bullet", LIMITS.best.min, LIMITS.best.max, problems);

  // Advice for Builders.
  const advice = bullets(vSec, problems);
  if (advice.length === 0) problems.push("## Advice for Builders has no bullets");
  if (advice.length > LIMITS.advice.maxItems) problems.push(`## Advice for Builders has ${advice.length} bullets; at most ${LIMITS.advice.maxItems}`);
  sized(advice, "advice bullet", LIMITS.advice.min, LIMITS.advice.max, problems);

  return { ok: problems.length === 0, none: false, patterns, problems };
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
  const unknown = args.filter((a) => a.startsWith("--") && a !== "--json" && a !== "--count");
  if (unknown.length) {
    console.error(`unknown flag: ${unknown.join(" ")}`);
    process.exit(2);
  }
  const src = args.find((a, i) => (!a.startsWith("--") || a === "-") && !(ci >= 0 && i === ci + 1));
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input, count);
  if (json) console.log(JSON.stringify({ ok: r.ok, none: r.none, patterns: r.patterns, problems: r.problems }));
  else if (r.ok) console.log(r.none ? "✓ none found, shape holds" : `✓ ${r.patterns.length} patterns, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
