#!/usr/bin/env bun
// AnalyzeThreatReportCheck — checks an AnalyzeThreatReport output against the
// parts of its contract code can judge, per mode. Full mode: a
// "# Threat Report Analysis: …" title, then SUMMARY (one sentence, <=25 words),
// TRENDS, STATISTICS, QUOTES, REFERENCES and RECOMMENDATIONS in that order,
// each a list of 1..50 "- " items or the single line "- None found.". Trends
// mode: a title and a TRENDS section alone. Commands mode: a title and one or
// more "## GROUP" sections, each with at least one "- " item and at least one
// fenced-or-backtick command line. All modes forbid bold or italics, numbered
// lists, a code fence wrapping the whole output, duplicate items, and
// commentary outside the sections. Whether each item is faithful and specific
// stays a judged check in the fabric-analyzethreatreport suite.

import { readFileSync } from "node:fs";
import { words } from "./WordSummaryCheck.ts";

const HELP = `AnalyzeThreatReportCheck — shape check for a Fabric AnalyzeThreatReport output

  bun skills/Fabric/Tools/AnalyzeThreatReportCheck.ts <file|-> [--mode full|trends|cmds] [--json]

  --mode  full (default), trends, or cmds
  --json  print {ok, mode, title, sections, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export type Mode = "full" | "trends" | "cmds";
export const FULL_SECTIONS = ["SUMMARY", "TRENDS", "STATISTICS", "QUOTES", "REFERENCES", "RECOMMENDATIONS"] as const;
const TITLE_BY_MODE: Record<Mode, RegExp> = {
  full: /^#\s+Threat Report Analysis:\s*(\S.*)$/i,
  trends: /^#\s+Threat Report Trends:\s*(\S.*)$/i,
  cmds: /^#\s+Threat Report Commands:\s*(\S.*)$/i,
};
export const NONE = "None found.";
const MAX_ITEMS = 50;
const SUMMARY_MAX_WORDS = 25;

// Bold (**x**, __x__) and single-delimiter italics; backtick code spans are allowed (commands).
const EMPHASIS = [/\*\*/, /__/, /(^|[\s(])\*[^\s*][^*\n]*\*(?=$|[\s).,;:!?])/, /(^|[\s(])_[^\s_][^_\n]*_(?=$|[\s).,;:!?])/];

type Section = { name: string; line: number; items: string[]; body: { line: number; text: string }[] };

export function check(input: string, mode: Mode = "full"): {
  ok: boolean;
  mode: Mode;
  title: string | null;
  sections: { name: string; items: number }[];
  problems: string[];
} {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const sections: Section[] = [];
  let title: string | null = null;
  const titleRe = TITLE_BY_MODE[mode];

  if (/^\s*```/.test(input.trim())) problems.push("output is wrapped in a code fence; emit the content only");

  lines.forEach((raw, i) => {
    const n = i + 1;
    const text = raw.trim();
    if (text === "") return;
    if (EMPHASIS.some((re) => re.test(raw))) problems.push(`line ${n}: bold or italics ("${text}")`);
    if (/^\s*\d+[.)]\s+\S/.test(raw)) problems.push(`line ${n}: numbered list item; use "- " bullets ("${text}")`);
    const t = text.match(titleRe);
    if (t && title === null && sections.length === 0) {
      title = t[1];
      return;
    }
    const h = text.match(/^##\s+(.+?)\s*$/);
    if (h) {
      sections.push({ name: h[1], line: n, items: [], body: [] });
      return;
    }
    if (/^#{1,6}\s/.test(text)) {
      problems.push(`line ${n}: unexpected heading ("${text}")`);
      return;
    }
    if (sections.length === 0) {
      problems.push(`line ${n}: text before the first section ("${text}")`);
      return;
    }
    sections[sections.length - 1].body.push({ line: n, text: raw });
  });

  if (title === null) problems.push(`missing or misnamed title line for ${mode} mode (expected "${sampleTitle(mode)}")`);

  if (mode === "full") checkFull(sections, problems);
  else if (mode === "trends") checkTrends(sections, problems);
  else checkCmds(sections, problems);

  return {
    ok: problems.length === 0,
    mode,
    title,
    sections: sections.map((s) => ({ name: s.name.toUpperCase(), items: s.items.length })),
    problems,
  };
}

function sampleTitle(mode: Mode): string {
  if (mode === "trends") return "# Threat Report Trends: <subject>";
  if (mode === "cmds") return "# Threat Report Commands: <subject>";
  return "# Threat Report Analysis: <subject>";
}

function collectItems(s: Section, problems: string[]): void {
  for (const b of s.body) {
    if (/^\s+[-*+]\s/.test(b.text) || /^\s{2,}\S/.test(b.text)) {
      problems.push(`line ${b.line}: sub-bullet or indented line in ${s.name.toUpperCase()}`);
      continue;
    }
    const m = b.text.match(/^-\s+(\S.*)$/);
    if (!m) {
      problems.push(`line ${b.line}: ${s.name.toUpperCase()} holds only "- " items ("${b.text.trim()}")`);
      continue;
    }
    s.items.push(m[1].trim());
  }
}

function checkListSection(s: Section, problems: string[], seen: Map<string, string>): void {
  const name = s.name.toUpperCase();
  collectItems(s, problems);
  const none = s.items.filter((x) => x.toLowerCase() === NONE.toLowerCase()).length;
  if (s.items.length === 0) problems.push(`line ${s.line}: ${name} is empty; use "- ${NONE}"`);
  else if (none > 0 && s.items.length > 1) problems.push(`line ${s.line}: ${name} mixes "${NONE}" with items`);
  if (s.items.length > MAX_ITEMS) problems.push(`line ${s.line}: ${name} has ${s.items.length} items (max ${MAX_ITEMS})`);
  for (const item of s.items) {
    const key = item.toLowerCase();
    if (key === NONE.toLowerCase()) continue;
    const prior = seen.get(key);
    if (prior) problems.push(`line ${s.line}: ${name} repeats an item already in ${prior} ("${item}")`);
    else seen.set(key, name);
  }
}

function checkSummary(s: Section, problems: string[]): void {
  const body = s.body.map((b) => b.text.trim()).filter((x) => x !== "");
  if (body.length !== 1) {
    problems.push(`line ${s.line}: SUMMARY must be exactly one line, found ${body.length}`);
    if (body.length === 0) return;
  }
  const line = body.join(" ");
  if (/^[-*+]\s|^\d+[.)]\s/.test(line)) problems.push(`line ${s.body[0]?.line ?? s.line}: SUMMARY is a sentence, not a list item`);
  const wc = words(line).length;
  if (wc > SUMMARY_MAX_WORDS) problems.push(`line ${s.body[0]?.line ?? s.line}: SUMMARY has ${wc} words (max ${SUMMARY_MAX_WORDS})`);
  const sentences = line.split(/(?<=[.!?])\s+(?=[A-Z])/).filter((x) => x.trim());
  if (sentences.length > 1) problems.push(`line ${s.body[0]?.line ?? s.line}: SUMMARY has ${sentences.length} sentences (one allowed)`);
}

function checkFull(sections: Section[], problems: string[]): void {
  const names = sections.map((s) => s.name.toUpperCase());
  if (names.join("|") !== FULL_SECTIONS.join("|"))
    problems.push(`sections must be ${FULL_SECTIONS.join(", ")} in that order; found ${names.length ? names.join(", ") : "none"}`);
  const seen = new Map<string, string>();
  for (const s of sections) {
    if (s.name.toUpperCase() === "SUMMARY") checkSummary(s, problems);
    else checkListSection(s, problems, seen);
  }
}

function checkTrends(sections: Section[], problems: string[]): void {
  const names = sections.map((s) => s.name.toUpperCase());
  if (names.join("|") !== "TRENDS") problems.push(`trends mode holds one TRENDS section; found ${names.length ? names.join(", ") : "none"}`);
  const seen = new Map<string, string>();
  for (const s of sections) if (s.name.toUpperCase() === "TRENDS") checkListSection(s, problems, seen);
}

function checkCmds(sections: Section[], problems: string[]): void {
  if (sections.length === 0) problems.push("commands mode needs at least one group section (## RECONNAISSANCE, …)");
  let commandLines = 0;
  for (const s of sections) {
    let groupItems = 0;
    for (const b of s.body) {
      const text = b.text;
      if (/^-\s+\S/.test(text)) groupItems++;
      if (/`[^`]+`/.test(text) || /^\s{2,}\S/.test(text)) commandLines++;
    }
    if (groupItems === 0) problems.push(`line ${s.line}: group ${s.name.toUpperCase()} has no "- " items`);
  }
  if (commandLines === 0) problems.push("no command lines found; each tool carries its command in backticks or an indented line");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const mi = args.indexOf("--mode");
  let mode: Mode = "full";
  if (mi >= 0) {
    const v = args[mi + 1];
    if (v !== "full" && v !== "trends" && v !== "cmds") {
      console.error(`--mode must be full, trends or cmds\n\n${HELP}`);
      process.exit(2);
    }
    mode = v;
  }
  const unknown = args.filter((a, i) => a.startsWith("--") && a !== "--json" && a !== "--mode" && a !== "--help" && !(mi >= 0 && i === mi + 1));
  if (unknown.length) {
    console.error(`unknown flag ${unknown[0]}\n\n${HELP}`);
    process.exit(2);
  }
  const src = args.find((a, i) => !a.startsWith("--") && !(mi >= 0 && i === mi + 1));
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input, mode);
  if (json) console.log(JSON.stringify({ ok: r.ok, mode: r.mode, title: r.title, sections: r.sections, problems: r.problems }));
  else if (r.ok) console.log(`✓ ${mode} mode: ${r.sections.map((s) => `${s.name} ${s.items}`).join(", ") || "shape holds"}`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
