#!/usr/bin/env bun
// ExplainCodeCheck — checks an ExplainCode output against the parts of its
// contract code can judge: only the four upstream sections as H2 headings,
// each at most once, in the fixed order, each with a body; nothing before the
// first section; no free-standing Note/Warning lines, preamble or closing
// offer; and, with --question / --kind, the sections the input calls for.
// Whether the explanation is right stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `ExplainCodeCheck — shape check for a Fabric ExplainCode output

  bun skills/Fabric/Tools/ExplainCodeCheck.ts <file|-> [--question] [--kind code|config|security] [--json]

  --question   the input asked a question: ## ANSWER must be present and first
  --kind K     the input holds K (code, config or security); its section must be present; repeatable
  --json       print {ok, sections, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const ORDER = ["ANSWER", "EXPLANATION", "SECURITY IMPLICATIONS", "CONFIGURATION EXPLANATION"] as const;
export type Section = (typeof ORDER)[number];
export type Kind = "code" | "config" | "security";
const KIND_SECTION: Record<Kind, Section> = { code: "EXPLANATION", config: "CONFIGURATION EXPLANATION", security: "SECURITY IMPLICATIONS" };

// Generic chat filler that never belongs in a sections-only output.
const PREAMBLE = /^(?:sure|certainly|of course|great question|here(?:'s| is) (?:an?|the) (?:explanation|breakdown)|let me (?:explain|walk)|as an (?:ai|expert))\b/i;
const CLOSER = /\b(?:let me know if|hope this helps|feel free to ask|if you have any (?:other |more )?questions|happy to help)\b/i;
const NOTE_LINE = /^\s*(?:[-*]\s+)?(?:\*\*|__)?(?:note|warning|disclaimer)s?(?:\*\*|__)?\s*:/i;

export type Options = { question?: boolean; kinds?: Kind[] };
export type Result = { ok: boolean; sections: Section[]; problems: string[] };

export function check(input: string, opts: Options = {}): Result {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const found: { name: Section; line: number }[] = [];

  let inFence = false;
  const heads: { text: string; level: number; line: number }[] = [];
  lines.forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const h = raw.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) heads.push({ text: h[2], level: h[1].length, line: i });
    if (NOTE_LINE.test(raw)) problems.push(`line ${i + 1}: free-standing note or warning line ("${raw.trim().slice(0, 60)}"); put the caution inside its section`);
    if (CLOSER.test(raw)) problems.push(`line ${i + 1}: closing offer or filler ("${raw.trim().slice(0, 60)}")`);
  });

  for (const h of heads) {
    if (h.level === 1) {
      problems.push(`line ${h.line + 1}: H1 heading "# ${h.text}"; the output is the sections only`);
      continue;
    }
    if (h.level !== 2) continue;
    const name = h.text.replace(/:$/, "").trim();
    const canon = ORDER.find((s) => s === name);
    if (!canon) {
      const loose = ORDER.find((s) => s === name.toUpperCase());
      problems.push(loose ? `line ${h.line + 1}: section "## ${h.text}" must be written "## ${loose}"` : `line ${h.line + 1}: unexpected section "## ${h.text}"; allowed: ${ORDER.join(", ")}`);
      continue;
    }
    if (h.text !== canon) problems.push(`line ${h.line + 1}: section "## ${h.text}" must be written "## ${canon}" with no trailing colon`);
    found.push({ name: canon, line: h.line });
  }

  const firstContent = lines.findIndex((l) => l.trim() !== "");
  if (firstContent < 0) return { ok: false, sections: [], problems: ["output is empty"] };
  if (found.length === 0) return { ok: false, sections: [], problems: [...problems, `no section found; open on one of ${ORDER.map((s) => `"## ${s}"`).join(", ")}`] };
  const firstHead = Math.min(...heads.map((h) => h.line));
  if (firstContent < firstHead) {
    const pre = lines[firstContent].trim();
    problems.push(`line ${firstContent + 1}: text before the first section ("${pre.slice(0, 60)}")${PREAMBLE.test(pre) ? ", a preamble" : ""}`);
  }

  // Each section once, in order, with a body.
  const names = found.map((f) => f.name);
  for (const s of ORDER) if (names.filter((n) => n === s).length > 1) problems.push(`section "## ${s}" appears more than once`);
  for (let i = 1; i < found.length; i++) {
    if (ORDER.indexOf(found[i].name) < ORDER.indexOf(found[i - 1].name)) problems.push(`line ${found[i].line + 1}: "## ${found[i].name}" comes after "## ${found[i - 1].name}"; expected order ${ORDER.join(", ")}`);
  }
  const h2Lines = heads.filter((h) => h.level <= 2).map((h) => h.line);
  for (const f of found) {
    const next = h2Lines.find((l) => l > f.line) ?? lines.length;
    if (lines.slice(f.line + 1, next).every((l) => l.trim() === "")) problems.push(`line ${f.line + 1}: section "## ${f.name}" is empty`);
  }

  if (opts.question) {
    if (!names.includes("ANSWER")) problems.push(`the input asked a question, but "## ANSWER" is missing`);
    else if (names[0] !== "ANSWER") problems.push(`"## ANSWER" must be the first section when the input asks a question`);
  }
  for (const k of opts.kinds ?? []) {
    const s = KIND_SECTION[k];
    if (!names.includes(s)) problems.push(`the input holds ${k}, but "## ${s}" is missing`);
  }

  return { ok: problems.length === 0, sections: names, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const kinds: Kind[] = [];
  let src: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--kind") {
      const k = args[++i];
      if (k !== "code" && k !== "config" && k !== "security") {
        console.error("--kind needs code, config or security");
        process.exit(2);
      }
      kinds.push(k);
    } else if (a === "--question" || a === "--json") continue;
    else if (a.startsWith("--")) {
      console.error(`unknown flag ${a}`);
      process.exit(2);
    } else src = a;
  }
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input, { question: args.includes("--question"), kinds });
  if (args.includes("--json")) console.log(JSON.stringify(r));
  else if (r.ok) console.log(`✓ ${r.sections.length} section${r.sections.length === 1 ? "" : "s"} (${r.sections.join(", ")}), shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
