#!/usr/bin/env bun
// ExplainDocsCheck — checks an ExplainDocs output against the parts of its
// contract code can judge: one bold title, then the four upstream sections as
// H2 headings, each once and in order, each with a body; What It Does and Why
// People Use It at 8–35 words; a code block or inline code under Most Common
// Syntax; 3–10 "- For {job}: `command`" use cases with no <placeholder> left
// in the command; 3–15 option entries opening
// on inline code or bold; no Note/Warning lines, preamble or closing offer.
// With --source, every long flag the guide uses appears in the documentation;
// with --tool, every use-case command contains the tool name. Whether the
// commands work stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `ExplainDocsCheck — shape check for a Fabric ExplainDocs output

  bun skills/Fabric/Tools/ExplainDocsCheck.ts <file|-> [--source <input-file>] [--tool <name>] [--json]

  --source F   the documentation the guide was built from; every long flag (--name) in
               the use cases and options must appear in it
  --tool N     every use-case command must contain N as a word
  --json       print {ok, noTool, title, sections, useCases, options, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const ORDER = ["OVERVIEW", "HOW TO USE IT", "COMMON USE CASES", "MOST IMPORTANT AND USED OPTIONS AND FEATURES"] as const;
export type Section = (typeof ORDER)[number];

const NO_TOOL = /^\*\*No tool to explain:\*\*\s+\S/;
const PREAMBLE = /^(?:sure|certainly|of course|great question|here(?:'s| is) (?:an?|the|your) (?:guide|explanation|breakdown)|let me (?:explain|walk)|as an (?:ai|expert))\b/i;
const CLOSER = /\b(?:let me know if|hope this helps|feel free to ask|if you have any (?:other |more )?questions|happy to help)\b/i;
const NOTE_LINE = /^\s*(?:[-*]\s+)?(?:\*\*|__)?(?:note|warning|disclaimer)s?(?:\*\*|__)?\s*:/i;
const USE_CASE = /^\s*[-*]\s+For\s+(.+?):\s+`([^`]+)`(.*)$/;
const OPTION = /^\s*[-*]\s+(?:`([^`]+)`|\*\*([^*]+)\*\*)\s*:\s*(.*\S)\s*$/;
const LONG_FLAG = /(?<![\w-])--[a-zA-Z][\w-]*/g;
// <file> or {name} in a command meant to be pasted; not shell redirects, ${VAR} or find's {}.
const PLACEHOLDER = /<[A-Za-z][\w-]*>|(?<!\$)\{[A-Za-z][\w-]*\}/;

export type Options = { source?: string; tool?: string };
export type Result = {
  ok: boolean;
  noTool: boolean;
  title: string | null;
  sections: Section[];
  useCases: { job: string; command: string }[];
  options: string[];
  problems: string[];
};

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}`]+|[^\p{L}\p{N}`]+$/gu, ""))
    .filter((t) => t.length > 0);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function check(input: string, opts: Options = {}): Result {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const result: Result = { ok: false, noTool: false, title: null, sections: [], useCases: [], options: [], problems };

  const content = lines.map((l, i) => ({ l, i })).filter((x) => x.l.trim() !== "");
  if (content.length === 0) return { ...result, problems: ["output is empty"] };

  if (NO_TOOL.test(content[0].l.trim())) {
    result.noTool = true;
    if (content.length > 1) problems.push(`the no-tool line must be the whole output; found ${content.length - 1} more line(s)`);
    result.ok = problems.length === 0;
    return result;
  }

  // Headings outside fences, plus line-level bans.
  let inFence = false;
  const fenceLine: boolean[] = [];
  const heads: { text: string; level: number; line: number }[] = [];
  lines.forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      fenceLine[i] = true;
      return;
    }
    fenceLine[i] = inFence;
    if (inFence) return;
    const h = raw.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) heads.push({ text: h[2], level: h[1].length, line: i });
    if (NOTE_LINE.test(raw)) problems.push(`line ${i + 1}: free-standing note or warning line ("${raw.trim().slice(0, 60)}"); put the caution inside its entry`);
    if (CLOSER.test(raw)) problems.push(`line ${i + 1}: closing offer or filler ("${raw.trim().slice(0, 60)}")`);
  });

  const found: { name: Section; line: number }[] = [];
  for (const h of heads) {
    if (h.level > 2) continue;
    const name = h.text.replace(/:$/, "").trim();
    const canon = ORDER.find((s) => s === name.toUpperCase());
    if (!canon) {
      problems.push(`line ${h.line + 1}: unexpected heading "${"#".repeat(h.level)} ${h.text}"; allowed: ${ORDER.map((s) => `## ${s}`).join(", ")}`);
      continue;
    }
    if (h.level !== 2 || h.text !== canon) problems.push(`line ${h.line + 1}: write the section as "## ${canon}"`);
    found.push({ name: canon, line: h.line });
  }
  if (found.length === 0) return { ...result, problems: [...problems, `no section found; open each on ${ORDER.map((s) => `"## ${s}"`).join(", ")}`] };

  // Title: exactly one bold line before the first section.
  const firstHead = Math.min(...heads.filter((h) => h.level <= 2).map((h) => h.line));
  const before = content.filter((x) => x.i < firstHead);
  if (before.length === 0) problems.push("no title line before the first section; open on **{tool}, {the read}**");
  else {
    const t = before[0].l.trim();
    const m = t.match(/^\*\*(.+)\*\*$/);
    if (!m) problems.push(`line ${before[0].i + 1}: the title must be one bold line ("${t.slice(0, 60)}")${PREAMBLE.test(t) ? ", a preamble" : ""}`);
    else result.title = m[1];
    if (before.length > 1) problems.push(`${before.length} lines before the first section; only the title is allowed`);
  }

  const names = found.map((f) => f.name);
  result.sections = names;
  for (const s of ORDER) {
    const n = names.filter((x) => x === s).length;
    if (n === 0) problems.push(`section "## ${s}" is missing`);
    if (n > 1) problems.push(`section "## ${s}" appears more than once`);
  }
  for (let i = 1; i < found.length; i++) {
    if (ORDER.indexOf(found[i].name) < ORDER.indexOf(found[i - 1].name)) problems.push(`line ${found[i].line + 1}: "## ${found[i].name}" comes after "## ${found[i - 1].name}"; expected order ${ORDER.join(", ")}`);
  }

  const h2Lines = heads.filter((h) => h.level <= 2).map((h) => h.line);
  const body = (s: Section): { l: string; i: number }[] => {
    const f = found.find((x) => x.name === s);
    if (!f) return [];
    const next = h2Lines.find((l) => l > f.line) ?? lines.length;
    return lines.slice(f.line + 1, next).map((l, k) => ({ l, i: f.line + 1 + k }));
  };
  for (const f of found) if (body(f.name).every((x) => x.l.trim() === "")) problems.push(`line ${f.line + 1}: section "## ${f.name}" is empty`);

  // OVERVIEW: the two labelled sentences, 8–35 words each.
  const ov = body("OVERVIEW");
  if (found.some((f) => f.name === "OVERVIEW")) {
    for (const label of ["What It Does", "Why People Use It"]) {
      const re = new RegExp(`^\\s*(?:[-*]\\s+)?(?:\\*\\*)?${label}:(?:\\*\\*)?\\s*(.*)$`, "i");
      const hit = ov.find((x) => re.test(x.l));
      if (!hit) {
        problems.push(`OVERVIEW has no "${label}:" line`);
        continue;
      }
      const n = words(hit.l.match(re)![1]).length;
      if (n < 8 || n > 35) problems.push(`line ${hit.i + 1}: ${label} has ${n} words; give 8 to 35 (about 25)`);
    }
  }

  // HOW TO USE IT: Most Common Syntax with code.
  if (found.some((f) => f.name === "HOW TO USE IT")) {
    const how = body("HOW TO USE IT");
    if (!how.some((x) => /Most Common Syntax:/i.test(x.l))) problems.push(`HOW TO USE IT has no "Most Common Syntax:" line`);
    const hasCode = how.some((x) => /^\s*(```|~~~)/.test(x.l)) || how.some((x) => /`[^`]+`/.test(x.l));
    if (!hasCode) problems.push("HOW TO USE IT shows no syntax in a code block or inline code");
  }

  // COMMON USE CASES: every list item is "- For {job}: `command`", 3–10 of them.
  const flagsUsed: { flag: string; line: number }[] = [];
  if (found.some((f) => f.name === "COMMON USE CASES")) {
    for (const x of body("COMMON USE CASES")) {
      if (fenceLine[x.i] || x.l.trim() === "") continue;
      const m = x.l.match(USE_CASE);
      if (m) {
        result.useCases.push({ job: m[1], command: m[2] });
        for (const f of m[2].match(LONG_FLAG) ?? []) flagsUsed.push({ flag: f, line: x.i });
        if (opts.tool && !new RegExp(`(?:^|[^\\w-])${escapeRe(opts.tool)}(?![\\w-])`).test(m[2])) problems.push(`line ${x.i + 1}: use-case command does not use ${opts.tool} ("${m[2].slice(0, 60)}")`);
        const ph = m[2].match(PLACEHOLDER);
        if (ph) problems.push(`line ${x.i + 1}: use-case command carries the placeholder ${ph[0]}; give a real example value`);
      } else if (/^\s*[-*]\s+/.test(x.l)) problems.push(`line ${x.i + 1}: use case must read "- For {job}: \`command\`" ("${x.l.trim().slice(0, 60)}")`);
      else problems.push(`line ${x.i + 1}: text in COMMON USE CASES outside an entry ("${x.l.trim().slice(0, 60)}")`);
    }
    const n = result.useCases.length;
    if (n < 3 || n > 10) problems.push(`COMMON USE CASES has ${n} entries; give 3 to 10`);
  }

  // OPTIONS: every list item opens on `flag` or **feature**, then a colon and ≤60 words.
  const OPT: Section = "MOST IMPORTANT AND USED OPTIONS AND FEATURES";
  if (found.some((f) => f.name === OPT)) {
    for (const x of body(OPT)) {
      if (fenceLine[x.i] || x.l.trim() === "") continue;
      if (/^\s{2,}[-*]\s+/.test(x.l)) continue; // a sub-bullet belongs to the entry above
      const m = x.l.match(OPTION);
      if (m) {
        const name = m[1] ?? m[2];
        result.options.push(name);
        for (const f of name.match(LONG_FLAG) ?? []) flagsUsed.push({ flag: f, line: x.i });
        for (const f of m[3].match(LONG_FLAG) ?? []) flagsUsed.push({ flag: f, line: x.i });
        const n = words(m[3]).length;
        if (n > 60) problems.push(`line ${x.i + 1}: option "${name}" has ${n} words of description; keep it to 60`);
      } else if (/^\s*[-*]\s+/.test(x.l)) problems.push(`line ${x.i + 1}: option must open on \`flag\` or **feature** then a colon ("${x.l.trim().slice(0, 60)}")`);
      else problems.push(`line ${x.i + 1}: text in ${OPT} outside an entry ("${x.l.trim().slice(0, 60)}")`);
    }
    const n = result.options.length;
    if (n < 3 || n > 15) problems.push(`${OPT} has ${n} entries; give 3 to 15`);
  }

  // Documented flags only, when the source is known.
  if (opts.source !== undefined) {
    const documented = new Set((opts.source.match(LONG_FLAG) ?? []).map((f) => f.toLowerCase()));
    const seen = new Set<string>();
    for (const { flag, line } of flagsUsed) {
      const f = flag.replace(/[-=]+$/, "").toLowerCase();
      if (seen.has(f)) continue;
      seen.add(f);
      if (!documented.has(f)) problems.push(`line ${line + 1}: ${flag} does not appear in the documentation`);
    }
  }

  result.ok = problems.length === 0;
  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  let src: string | undefined;
  let sourceFile: string | undefined;
  let tool: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--source" || a === "--tool") {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) {
        console.error(`${a} needs a value`);
        process.exit(2);
      }
      if (a === "--source") sourceFile = v;
      else tool = v;
    } else if (a === "--json") continue;
    else if (a.startsWith("--")) {
      console.error(`unknown flag ${a}`);
      process.exit(2);
    } else src = a;
  }
  let input: string;
  let source: string | undefined;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
    if (sourceFile !== undefined) source = readFileSync(sourceFile, "utf8");
  } catch (e) {
    console.error(`cannot read input: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input, { source, tool });
  if (args.includes("--json")) console.log(JSON.stringify(r));
  else if (r.ok) console.log(r.noTool ? "✓ no-tool line, shape holds" : `✓ ${r.sections.length} sections, ${r.useCases.length} use cases, ${r.options.length} options, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
