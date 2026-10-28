#!/usr/bin/env bun
// CodeRulesCheck — checks a CodeRules output against the parts of its
// contract code can judge: the bare paste-ready list with no title or
// heading, either the single no-rules line or 1-25 bulleted rules, each one sentence of 3-30
// words (a backticked span counts as one word) ending in a period, with
// balanced backticks, no third-person or softening opener, no duplicates,
// and no bold or italics outside code. Whether a rule is faithful to the
// source, concrete, and something a capable model would not already do stays
// a judged check in the fabric-coderules suite.

import { readFileSync } from "node:fs";

const HELP = `CodeRulesCheck — shape check for a Fabric CodeRules output

  bun skills/Fabric/Tools/CodeRulesCheck.ts <file|-> [--json]

  --json  print {ok, rules, none, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const MAX_WORDS = 30;
export const MIN_WORDS = 3;
export const MAX_RULES = 25;

// Openers that address the agent in the third person or soften the instruction.
const BAD_OPENER =
  /^(the\s+(ai|assistant|agent|model|llm)\b|ai\b|an?\s+(ai|agent|assistant)\b|you\s+(should|must|need\s+to|have\s+to)\b|developers?\s+should\b|please\b|try\s+to\b|make\s+sure\b|remember\s+to\b|rule\s*\d*\s*:)/i;

export type Rule = { text: string; line: number };

/** Replace each backticked span with a placeholder so its contents are neither counted nor parsed. */
export function stripCode(text: string): string {
  return text.replace(/`[^`]*`/g, "CODE");
}

export function words(text: string): string[] {
  return stripCode(text)
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

export function norm(text: string): string {
  return text.trim().replace(/\s+/g, " ").replace(/[.;]+$/, "").toLowerCase();
}

function emphasis(line: string): boolean {
  const s = stripCode(line);
  if (/\*\*|__/.test(s)) return true;
  if (/(^|[\s(])\*[^\s*][^*\n]*?\*(?=$|[\s).,;:!?])/.test(s)) return true;
  if (/(^|[\s(])_[^\s_][^_\n]*?_(?=$|[\s).,;:!?])/.test(s)) return true;
  return false;
}

export function check(input: string): { ok: boolean; rules: Rule[]; none: boolean; problems: string[] } {
  const problems: string[] = [];
  const rules: Rule[] = [];
  const all = input.replace(/\r\n/g, "\n").split("\n");

  if (all.some((l) => /^\s*(```|~~~)/.test(l))) problems.push("code block found; each rule is one sentence with commands inline in backticks");

  const rows = all
    .map((text, i) => ({ text: text.replace(/\s+$/, ""), line: i + 1 }))
    .filter((r) => r.text.trim() !== "");

  if (rows.length === 0) return { ok: false, rules, none: false, problems: ["the output is empty"] };

  for (const r of rows) if (emphasis(r.text)) problems.push(`line ${r.line}: bold or italics ("${r.text.trim().slice(0, 60)}"); the output is plain Markdown`);

  const rest = rows;

  // No-rules form.
  const sentinel = rest.find((r) => /^No code rules found\b/i.test(r.text.trim()));
  if (sentinel) {
    if (rest.length !== 1) problems.push(`the no-rules form is the single line "No code rules found in …" and nothing else; found ${rest.length} lines`);
    if (!/^No code rules found in\s+\S/.test(sentinel.text.trim())) problems.push(`line ${sentinel.line}: the line reads "No code rules found in {the source}."`);
    return { ok: problems.length === 0, rules, none: true, problems };
  }

  for (const r of rest) {
    if (/^\s*(```|~~~)/.test(r.text)) continue; // reported once above
    if (/^#{1,6}\s/.test(r.text)) { problems.push(`line ${r.line}: heading; the output is the bare list with no title or heading, ready to paste ("${r.text.trim()}")`); continue; }
    if (/^\s+[-*+]\s/.test(r.text)) { problems.push(`line ${r.line}: nested bullet; each rule is one top-level bullet`); continue; }
    if (/^\s*\d+[.)]\s/.test(r.text)) { problems.push(`line ${r.line}: numbered list; rules are a bulleted list ("- ")`); continue; }
    const b = r.text.match(/^[-*+]\s+(.*\S)\s*$/);
    if (!b) { problems.push(`line ${r.line}: text outside the list ("${r.text.trim().slice(0, 60)}")`); continue; }
    rules.push({ text: b[1], line: r.line });
  }

  if (rules.length === 0) problems.push('no rule bullets found (or use the single line "No code rules found in …")');
  if (rules.length > MAX_RULES) problems.push(`${rules.length} rules; at most ${MAX_RULES}`);

  const seen = new Set<string>();
  for (const rule of rules) {
    const at = `line ${rule.line}`;
    const ticks = (rule.text.match(/`/g) ?? []).length;
    if (ticks % 2 !== 0) problems.push(`${at}: unbalanced backticks ("${rule.text.slice(0, 60)}")`);
    const n = words(rule.text).length;
    if (n > MAX_WORDS) problems.push(`${at}: rule has ${n} words; at most ${MAX_WORDS}, a backticked span counting as one`);
    if (n < MIN_WORDS) problems.push(`${at}: rule is too short to follow ("${rule.text}"); at least ${MIN_WORDS} words`);
    if (!rule.text.endsWith(".")) problems.push(`${at}: a rule is one sentence ending in a period ("${rule.text.slice(-40)}")`);
    const plain = stripCode(rule.text);
    if (/[.!?]["')]?\s+["'(]?[A-Z]/.test(plain)) problems.push(`${at}: more than one sentence; each rule is one sentence ("${rule.text.slice(0, 60)}")`);
    if (BAD_OPENER.test(plain.trim())) problems.push(`${at}: write the rule as a direct instruction, not about the agent or softened ("${rule.text.slice(0, 40)}")`);
    const k = norm(rule.text);
    if (seen.has(k)) problems.push(`${at}: duplicate rule ("${rule.text.slice(0, 60)}")`);
    seen.add(k);
  }

  return { ok: problems.length === 0, rules, none: false, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const unknown = args.filter((a) => a.startsWith("--") && a !== "--json");
  if (unknown.length) {
    console.error(`unknown flag: ${unknown.join(" ")}`);
    process.exit(2);
  }
  const src = args.find((a) => !a.startsWith("--"));
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input);
  if (json) console.log(JSON.stringify({ ok: r.ok, rules: r.rules.map(({ text }) => text), none: r.none, problems: r.problems }));
  else if (r.ok) console.log(r.none ? "✓ no code rules, shape holds" : `✓ ${r.rules.length} rules, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
