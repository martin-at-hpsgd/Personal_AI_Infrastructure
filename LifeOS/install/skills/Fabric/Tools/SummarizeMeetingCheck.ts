#!/usr/bin/env bun
// SummarizeMeetingCheck — checks a SummarizeMeeting output against the parts of
// its contract code can judge: a "# Meeting Summary: …" title, an OVERVIEW of
// one line and at most 25 words, then KEY POINTS, TASKS, DECISIONS, CHALLENGES,
// TIMELINE, REFERENCES and NEXT STEPS in that order, each holding "- " items
// (1-20 key points, 1-10 elsewhere, at most 25 words each) or the single line
// "- None recorded.". TASKS lines read "Owner: action (due …)", TIMELINE lines
// read "when: what". No item repeats, no two items in a section open on the
// same three words, no bold, italics, sub-bullets, numbered lists or commentary.
// A trailing "--- HARVEST ---" block ends the summary and is not checked.
// Meaning (decision fidelity, ownership, specificity) stays a judged check.

import { readFileSync } from "node:fs";
import { words } from "./WordSummaryCheck.ts";

const HELP = `SummarizeMeetingCheck — shape check for a Fabric SummarizeMeeting output

  bun skills/Fabric/Tools/SummarizeMeetingCheck.ts <file|-> [--json]

  --json  print {ok, title, sections, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const SECTIONS = ["OVERVIEW", "KEY POINTS", "TASKS", "DECISIONS", "CHALLENGES", "TIMELINE", "REFERENCES", "NEXT STEPS"] as const;
export const NONE = "None recorded.";
export const MAX_WORDS = 25;
const MAX_ITEMS: Record<string, number> = { "KEY POINTS": 20 };
const DEFAULT_MAX_ITEMS = 10;
const OPENING_WORDS = 3;
// The Harvest block opens on "--- HARVEST ---"; a harvest error may also come
// back as a "> " warning line naming Harvest. Either one ends the summary.
const HARVEST = /^(?:-{3}\s*HARVEST\b|>\s*.*\bharvest\b)/i;

const TASK = /^(\S.*?):\s+(\S.*)\s+\(due\s+([^)]+)\)$/i;
const TIMELINE = /^(\S.*?):\s+(\S.*)$/;
const EMPHASIS = [/\*\*/, /__/, /(^|[\s(])\*[^\s*][^*\n]*\*(?=$|[\s).,;:!?])/, /(^|[\s(])_[^\s_][^_\n]*_(?=$|[\s).,;:!?])/];

type Section = { name: string; line: number; items: { line: number; text: string }[]; body: { line: number; text: string }[] };
export type Result = { ok: boolean; title: string | null; sections: { name: string; items: number }[]; problems: string[] };

const isNone = (s: string) => s.trim().toLowerCase() === NONE.toLowerCase();

export function check(input: string): Result {
  const all = input.replace(/\r\n/g, "\n").split("\n");
  const cut = all.findIndex((l) => HARVEST.test(l.trim()));
  const lines = cut === -1 ? all : all.slice(0, cut);
  const problems: string[] = [];
  const sections: Section[] = [];
  let title: string | null = null;

  lines.forEach((raw, i) => {
    const n = i + 1;
    const text = raw.trim();
    if (text === "") return;
    if (EMPHASIS.some((re) => re.test(raw))) problems.push(`line ${n}: bold or italics ("${text}")`);
    const t = text.match(/^#\s+Meeting Summary:\s*(\S.*)$/i);
    if (t) {
      if (title !== null || sections.length > 0) problems.push(`line ${n}: title must be the first line and appear once`);
      title = t[1];
      return;
    }
    const h = text.match(/^##\s+(.+?)\s*$/);
    if (h) {
      sections.push({ name: h[1].toUpperCase(), line: n, items: [], body: [] });
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

  if (title === null) problems.push('missing title line "# Meeting Summary: <the meeting>"');

  const names = sections.map((s) => s.name);
  if (names.join("|") !== SECTIONS.join("|")) problems.push(`sections must be ${SECTIONS.join(", ")} in that order; found ${names.length ? names.join(", ") : "none"}`);

  const seen = new Map<string, string>();
  for (const s of sections) {
    if (s.name === "OVERVIEW") {
      const body = s.body.map((b) => b.text.trim());
      if (body.length !== 1) problems.push(`line ${s.line}: OVERVIEW must be exactly one line, found ${body.length}`);
      if (body.length >= 1) {
        const line = body.join(" ");
        if (/^[-*+]\s|^\d+[.)]\s/.test(line)) problems.push(`line ${s.body[0].line}: OVERVIEW is prose, not a list item`);
        const wc = words(line).length;
        if (wc > MAX_WORDS) problems.push(`line ${s.body[0].line}: OVERVIEW has ${wc} words (max ${MAX_WORDS})`);
      }
      continue;
    }
    for (const b of s.body) {
      if (/^\s+[-*+]\s/.test(b.text) || /^\s{2,}\S/.test(b.text)) { problems.push(`line ${b.line}: sub-bullet or indented line in ${s.name}`); continue; }
      if (/^\d+[.)]\s/.test(b.text.trim())) { problems.push(`line ${b.line}: numbered list item in ${s.name}; use "- " items`); continue; }
      const m = b.text.match(/^-\s+(\S.*)$/);
      if (!m) { problems.push(`line ${b.line}: ${s.name} holds only "- " items ("${b.text.trim()}")`); continue; }
      const item = m[1].trim();
      s.items.push({ line: b.line, text: item });
      const wc = words(item).length;
      if (wc > MAX_WORDS) problems.push(`line ${b.line}: ${s.name} item has ${wc} words (max ${MAX_WORDS})`);
      if (isNone(item)) continue;
      if (s.name === "TASKS" && !TASK.test(item)) problems.push(`line ${b.line}: TASKS item must read "Owner: action (due <deadline or not set>)" ("${item}")`);
      if (s.name === "TIMELINE" && !TIMELINE.test(item)) problems.push(`line ${b.line}: TIMELINE item must read "<date or milestone>: <what happens>" ("${item}")`);
      const key = item.toLowerCase();
      const prior = seen.get(key);
      if (prior) problems.push(`line ${b.line}: item repeats one already in ${prior}`);
      else seen.set(key, s.name);
    }
    const real = s.items.filter((x) => !isNone(x.text));
    const max = MAX_ITEMS[s.name] ?? DEFAULT_MAX_ITEMS;
    if (s.items.length === 0) problems.push(`line ${s.line}: ${s.name} is empty; use "- ${NONE}"`);
    else if (real.length !== s.items.length && s.items.length > 1) problems.push(`line ${s.line}: ${s.name} mixes "${NONE}" with items`);
    if (real.length > max) problems.push(`line ${s.line}: ${s.name} has ${real.length} items (max ${max})`);
    if (s.name !== "TASKS" && s.name !== "TIMELINE") {
      const openings = new Map<string, number>();
      for (const it of real) {
        const w = words(it.text).slice(0, OPENING_WORDS).map((x) => x.toLowerCase());
        if (w.length < OPENING_WORDS) continue;
        const k = w.join(" ");
        if (openings.has(k)) problems.push(`line ${it.line}: ${s.name} item opens with the same ${OPENING_WORDS} words as line ${openings.get(k)} ("${k}")`);
        else openings.set(k, it.line);
      }
    }
  }

  return {
    ok: problems.length === 0,
    title,
    sections: sections.map((s) => ({ name: s.name, items: s.items.filter((x) => !isNone(x.text)).length })),
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
