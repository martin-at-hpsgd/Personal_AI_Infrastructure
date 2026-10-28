#!/usr/bin/env bun
// ExtractInstructionsCheck — checks an ExtractInstructions output against the
// parts of its contract code can judge: one "# Instructions:" title, then
// either the single no-instructions line or the sections in order
// (## Objectives, optional ## You need, ## Instructions), 1-10 objectives of
// 3-15 words, a numbered step list counting 1..N with no gap, steps of at most
// 40 words and sub-steps of at most 25, no step or sub-step joining two
// actions with "then", no duplicates, no other headings or
// paragraph text, and no bold or italics outside inline code. Whether the
// steps are faithful, complete, in the order the reader must do them and
// carry their warnings stays a judged check in the fabric-extractinstructions
// suite.

import { readFileSync } from "node:fs";

const HELP = `ExtractInstructionsCheck — shape check for a Fabric ExtractInstructions output

  bun skills/Fabric/Tools/ExtractInstructionsCheck.ts <file|-> [--json]

  --json  print {ok, objectives, needs, steps, none, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const MAX_OBJECTIVES = 10;
export const OBJECTIVE_MIN_WORDS = 3;
export const OBJECTIVE_MAX_WORDS = 15;
export const STEP_MAX_WORDS = 40;
export const SUBSTEP_MAX_WORDS = 25;

const SECTIONS = ["Objectives", "You need", "Instructions"] as const;
type Section = (typeof SECTIONS)[number];

export type Step = { n: number; text: string; line: number; substeps: string[] };
export type Result = { ok: boolean; objectives: string[]; needs: string[]; steps: Step[]; none: boolean; problems: string[] };

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}`]+|[^\p{L}\p{N}`]+$/gu, ""))
    .filter((t) => t.length > 0);
}

export function norm(text: string): string {
  return text.trim().replace(/\s+/g, " ").replace(/[.;:]+$/, "").toLowerCase();
}

// Two actions joined by "then" (", then", "; then", "and then"), unless the
// "then" closes a condition ("If it fails, then …", "When it beeps, then …").
export function joinsActions(text: string): boolean {
  const t = stripCode(text);
  const m = t.match(/(?:[,;]\s*(?:and\s+)?|\s+and\s+)then\s+\p{L}/iu);
  if (!m || m.index === undefined) return false;
  return !/\b(?:if|when|whenever|once|unless|until|after|before|as soon as)\b/i.test(t.slice(0, m.index));
}

function stripCode(line: string): string {
  return line.replace(/`[^`]*`/g, "``");
}

export function emphasis(line: string): boolean {
  const l = stripCode(line);
  if (/\*\*|__/.test(l)) return true;
  if (/(^|[\s(])\*[^\s*][^*\n]*?\*(?=$|[\s).,;:!?])/.test(l)) return true;
  if (/(^|[\s(])_[^\s_][^_\n]*?_(?=$|[\s).,;:!?])/.test(l)) return true;
  return false;
}

export function check(input: string): Result {
  const problems: string[] = [];
  const objectives: string[] = [];
  const needs: string[] = [];
  const steps: Step[] = [];
  const all = input.replace(/\r\n/g, "\n").split("\n").map((text, i) => ({ text: text.replace(/\s+$/, ""), line: i + 1 }));

  // Drop fenced code blocks indented under a step; a fence at column 0 is text outside the sections.
  const rows: { text: string; line: number }[] = [];
  let fence: { line: number; indented: boolean } | null = null;
  for (const r of all) {
    const f = r.text.match(/^(\s*)(```|~~~)/);
    if (f) {
      if (fence) { fence = null; continue; }
      fence = { line: r.line, indented: f[1].length >= 2 };
      if (!fence.indented) problems.push(`line ${r.line}: a code block sits outside a step; indent it under the step it belongs to`);
      continue;
    }
    if (fence) continue;
    if (r.text.trim() !== "") rows.push(r);
  }
  if (fence) problems.push(`line ${fence.line}: code block is never closed`);

  if (rows.length === 0) return { ok: false, objectives, needs, steps, none: false, problems: ["the output is empty"] };

  for (const r of rows) if (emphasis(r.text)) problems.push(`line ${r.line}: bold or italics ("${r.text.trim().slice(0, 60)}"); the output is plain Markdown`);

  const [title, ...rest] = rows;
  if (!/^#\s+Instructions:\s+\S/.test(title.text)) problems.push(`line ${title.line}: the output opens on a "# Instructions: " title naming the task and the read`);

  const sentinel = rest.find((r) => /^No instructions found\b/i.test(r.text.trim()));
  if (sentinel) {
    if (rest.length !== 1) problems.push(`the no-instructions form is the title and the single line "No instructions found in …"; found ${rest.length} lines after the title`);
    if (!/^No instructions found in\s+\S/.test(sentinel.text.trim())) problems.push(`line ${sentinel.line}: the line reads "No instructions found in {the source}."`);
    return { ok: problems.length === 0, objectives, needs, steps, none: true, problems };
  }

  let section: Section | null = null;
  const seenSections: Section[] = [];
  let expectN = 1;

  for (const r of rest) {
    const h = r.text.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (h) {
      const name = SECTIONS.find((s) => s.toLowerCase() === h[2].trim().replace(/:$/, "").toLowerCase());
      if (h[1] !== "##" || !name) { problems.push(`line ${r.line}: heading "${r.text.trim()}" is not one of ## Objectives, ## You need, ## Instructions`); section = null; continue; }
      if (seenSections.includes(name)) problems.push(`line ${r.line}: section "${name}" appears twice`);
      const last = seenSections[seenSections.length - 1];
      if (last && SECTIONS.indexOf(name) < SECTIONS.indexOf(last)) problems.push(`line ${r.line}: section "${name}" is out of order; the order is Objectives, You need, Instructions`);
      seenSections.push(name);
      section = name;
      continue;
    }
    if (section === null) { problems.push(`line ${r.line}: text outside the sections ("${r.text.trim().slice(0, 60)}")`); continue; }

    if (section === "Objectives" || section === "You need") {
      if (/^\s+[-*+]\s/.test(r.text)) { problems.push(`line ${r.line}: nested bullet under ${section}; each item is one top-level bullet`); continue; }
      if (/^\s*\d+[.)]\s/.test(r.text)) { problems.push(`line ${r.line}: numbered item under ${section}; use "- " bullets`); continue; }
      const b = r.text.match(/^[-*+]\s+(.*\S)\s*$/);
      if (!b) { problems.push(`line ${r.line}: text under ${section} that is not a bullet ("${r.text.trim().slice(0, 60)}")`); continue; }
      (section === "Objectives" ? objectives : needs).push(b[1]);
      continue;
    }

    // Instructions
    const s = r.text.match(/^(\d+)[.)]\s+(.*\S)\s*$/);
    if (s) {
      const n = Number(s[1]);
      if (n !== expectN) problems.push(`line ${r.line}: step numbered ${n}, expected ${expectN}`);
      expectN = n + 1;
      steps.push({ n, text: s[2], line: r.line, substeps: [] });
      continue;
    }
    const sub = r.text.match(/^\s{2,}(?:[-*+]|[a-z0-9]+[.)])\s+(.*\S)\s*$/);
    if (sub) {
      if (steps.length === 0) { problems.push(`line ${r.line}: sub-step before any step`); continue; }
      steps[steps.length - 1].substeps.push(sub[1]);
      const n = words(sub[1]).length;
      if (n > SUBSTEP_MAX_WORDS) problems.push(`line ${r.line}: sub-step has ${n} words; at most ${SUBSTEP_MAX_WORDS}`);
      if (joinsActions(sub[1])) problems.push(`line ${r.line}: sub-step joins two actions with "then"; each sub-step is one action`);
      continue;
    }
    if (/^[-*+]\s/.test(r.text)) { problems.push(`line ${r.line}: unnumbered bullet under Instructions; steps are a numbered list ("1. ") and sub-steps are indented under a step`); continue; }
    problems.push(`line ${r.line}: text under Instructions that is not a step or sub-step ("${r.text.trim().slice(0, 60)}")`);
  }

  if (!seenSections.includes("Objectives")) problems.push('missing "## Objectives" section');
  if (!seenSections.includes("Instructions")) problems.push('missing "## Instructions" section');
  if (seenSections.includes("You need") && needs.length === 0) problems.push('"## You need" is present but empty; leave it out when the input names nothing to have ready');

  if (seenSections.includes("Objectives") && objectives.length === 0) problems.push("no objectives under ## Objectives");
  if (objectives.length > MAX_OBJECTIVES) problems.push(`${objectives.length} objectives; at most ${MAX_OBJECTIVES}`);
  const seenObj = new Set<string>();
  objectives.forEach((o) => {
    const n = words(o).length;
    if (n > OBJECTIVE_MAX_WORDS) problems.push(`objective has ${n} words; at most ${OBJECTIVE_MAX_WORDS} ("${o.slice(0, 60)}")`);
    if (n < OBJECTIVE_MIN_WORDS) problems.push(`objective is too short to say what it achieves ("${o}"); at least ${OBJECTIVE_MIN_WORDS} words`);
    if (seenObj.has(norm(o))) problems.push(`duplicate objective ("${o.slice(0, 60)}")`);
    seenObj.add(norm(o));
  });

  if (seenSections.includes("Instructions") && steps.length === 0) problems.push('no numbered steps under ## Instructions (or use the single line "No instructions found in …")');
  const seenSteps = new Set<string>();
  for (const st of steps) {
    const n = words(st.text).length;
    if (n > STEP_MAX_WORDS) problems.push(`line ${st.line}: step ${st.n} has ${n} words; at most ${STEP_MAX_WORDS}, one action per step`);
    if (joinsActions(st.text)) problems.push(`line ${st.line}: step ${st.n} joins two actions with "then"; make each its own step or sub-step`);
    if (seenSteps.has(norm(st.text))) problems.push(`line ${st.line}: step ${st.n} repeats an earlier step`);
    seenSteps.add(norm(st.text));
  }

  return { ok: problems.length === 0, objectives, needs, steps, none: false, problems };
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
  if (json) console.log(JSON.stringify({ ok: r.ok, objectives: r.objectives, needs: r.needs, steps: r.steps.map(({ n, text, substeps }) => ({ n, text, substeps })), none: r.none, problems: r.problems }));
  else if (r.ok) console.log(r.none ? "✓ no instructions, shape holds" : `✓ ${r.objectives.length} objectives, ${r.steps.length} steps, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
