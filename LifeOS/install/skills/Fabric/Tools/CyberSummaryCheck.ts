#!/usr/bin/env bun
// CyberSummaryCheck — checks a CyberSummary output against the parts of its
// contract code can judge: a "# Cyber Summary: …" title, a one-sentence
// SUMMARY of at most 25 words, then ADVISORIES, INCIDENTS, MALWARE and
// VULNERABILITIES in that order, each holding 1 to 10 "- " items of at most 25
// words or the single line "- None reported.", no item repeated, no bold or
// italics, no sub-bullets, no commentary. Meaning stays a judged check.

import { readFileSync } from "node:fs";
import { words } from "./WordSummaryCheck.ts";

const HELP = `CyberSummaryCheck — shape check for a Fabric CyberSummary output

  bun skills/Fabric/Tools/CyberSummaryCheck.ts <file|-> [--json]

  --json  print {ok, sections, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const SECTIONS = ["SUMMARY", "ADVISORIES", "INCIDENTS", "MALWARE", "VULNERABILITIES"] as const;
export const NONE = "None reported.";
const MAX_ITEMS = 10;
const MAX_WORDS = 25;

type Section = { name: string; line: number; items: string[]; body: { line: number; text: string }[] };

const EMPHASIS = [/\*\*/, /__/, /(^|[\s(])\*[^\s*][^*\n]*\*(?=$|[\s).,;:!?])/, /(^|[\s(])_[^\s_][^_\n]*_(?=$|[\s).,;:!?])/];

export function check(input: string): { ok: boolean; title: string | null; sections: { name: string; items: number }[]; problems: string[] } {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const sections: Section[] = [];
  let title: string | null = null;

  lines.forEach((raw, i) => {
    const n = i + 1;
    const text = raw.trim();
    if (text === "") return;
    if (EMPHASIS.some((re) => re.test(raw))) problems.push(`line ${n}: bold or italics ("${text}")`);
    const t = text.match(/^#\s+Cyber Summary:\s*(\S.*)$/i);
    if (t) {
      if (title !== null || sections.length > 0) problems.push(`line ${n}: title must be the first line and appear once`);
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

  if (title === null) problems.push('missing title line "# Cyber Summary: <what was summarized>"');

  const names = sections.map((s) => s.name.toUpperCase());
  if (names.join("|") !== SECTIONS.join("|")) problems.push(`sections must be ${SECTIONS.join(", ")} in that order; found ${names.length ? names.join(", ") : "none"}`);

  const seen = new Map<string, string>();
  for (const s of sections) {
    const name = s.name.toUpperCase();
    if (name === "SUMMARY") {
      const body = s.body.map((b) => b.text.trim());
      if (body.length !== 1) problems.push(`line ${s.line}: SUMMARY must be exactly one line, found ${body.length}`);
      if (body.length >= 1) {
        const line = body.join(" ");
        if (/^[-*+]\s|^\d+[.)]\s/.test(line)) problems.push(`line ${s.body[0].line}: SUMMARY is a sentence, not a list item`);
        const wc = words(line).length;
        if (wc > MAX_WORDS) problems.push(`line ${s.body[0].line}: SUMMARY has ${wc} words (max ${MAX_WORDS})`);
        const sentences = line.split(/(?<=[.!?])\s+(?=[A-Z])/).filter((x) => x.trim());
        if (sentences.length > 1) problems.push(`line ${s.body[0].line}: SUMMARY has ${sentences.length} sentences (one allowed)`);
      }
      continue;
    }
    for (const b of s.body) {
      if (/^\s+[-*+]\s/.test(b.text) || /^\s{2,}\S/.test(b.text)) { problems.push(`line ${b.line}: sub-bullet or indented line in ${name}`); continue; }
      const m = b.text.match(/^-\s+(\S.*)$/);
      if (!m) { problems.push(`line ${b.line}: ${name} holds only "- " items ("${b.text.trim()}")`); continue; }
      s.items.push(m[1].trim());
      const wc = words(m[1]).length;
      if (wc > MAX_WORDS) problems.push(`line ${b.line}: ${name} item has ${wc} words (max ${MAX_WORDS})`);
      const key = m[1].trim().toLowerCase();
      if (key !== NONE.toLowerCase()) {
        const prior = seen.get(key);
        if (prior) problems.push(`line ${b.line}: item repeats one already in ${prior}`);
        else seen.set(key, name);
      }
    }
    const none = s.items.filter((x) => x.toLowerCase() === NONE.toLowerCase()).length;
    if (s.items.length === 0) problems.push(`line ${s.line}: ${name} is empty; use "- ${NONE}"`);
    else if (none > 0 && s.items.length > 1) problems.push(`line ${s.line}: ${name} mixes "${NONE}" with items`);
    if (s.items.length > MAX_ITEMS) problems.push(`line ${s.line}: ${name} has ${s.items.length} items (max ${MAX_ITEMS})`);
  }

  return {
    ok: problems.length === 0,
    title,
    sections: sections.map((s) => ({ name: s.name.toUpperCase(), items: s.items.filter((x) => x.toLowerCase() !== NONE.toLowerCase()).length })),
    problems,
  };
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
    console.error(`unknown flag ${unknown[0]}\n\n${HELP}`);
    process.exit(2);
  }
  const src = args.find((a) => !a.startsWith("--") || a === "-");
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input);
  if (json) console.log(JSON.stringify({ ok: r.ok, title: r.title, sections: r.sections, problems: r.problems }));
  else if (r.ok) console.log(`✓ ${r.sections.map((s) => `${s.name} ${s.items}`).join(", ")}; shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
