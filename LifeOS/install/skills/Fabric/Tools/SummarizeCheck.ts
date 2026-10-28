#!/usr/bin/env bun
// SummarizeCheck — checks a Summarize output against the parts of its contract
// code can judge: a "# Summary:" title, then ONE SENTENCE SUMMARY (one sentence,
// at most 20 words, not a description of the input), MAIN POINTS (1 to 10
// numbered items of at most 16 words) and TAKEAWAYS (1 to 5 numbered items of
// at most 25 words) in that order, lists numbered from 1 with no gaps, no
// repeated items, no two items opening on the same two words, no bullets, bold
// or commentary. A trailing Harvest block is ignored. Fidelity to the source and
// the quality of the read stay judged checks.

import { readFileSync } from "node:fs";

const HELP = `SummarizeCheck — shape check for a Fabric Summarize output

  bun skills/Fabric/Tools/SummarizeCheck.ts <file|-> [--json]

  --json      print {ok, title, mainPoints, takeaways, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export type Result = { ok: boolean; title: string; mainPoints: number; takeaways: number; problems: string[] };

type Line = { text: string; line: number };
type Section = { name: string; line: number; body: Line[] };

export const LIMITS = { sentenceWords: 20, mainPoints: 10, pointWords: 16, takeaways: 5, takeawayWords: 25 };
const SECTIONS = ["ONE SENTENCE SUMMARY", "MAIN POINTS", "TAKEAWAYS"];
const ABBREV = /\b(?:Dr|Mr|Mrs|Ms|Prof|St|Sr|Jr|vs|etc|e\.g|i\.e|U\.S|U\.K|No|Inc|Ltd|Co)\./g;
const META =
  /^(?:this|the)\s+(?:article|video|post|text|transcript|document|paper|episode|podcast|talk|piece|essay|report|conversation|thread|memo|email|source|content|book|chapter)\s+(?:discusses|covers|describes|explores|examines|is about|talks about|looks at|provides|offers|outlines|gives an overview)\b|^(?:the\s+)?(?:author|speaker|writer|narrator|host)s?\s+(?:discuss|discusses|talk|talks|describe|describes|explore|explores|cover|covers)\b|^in this\s+(?:article|video|post|episode|talk|piece|paper|report)\b/i;

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

const norm = (s: string) => s.replace(/[’‘]/g, "'").toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
const opening = (text: string) => words(text).slice(0, 2).map((w) => w.toLowerCase()).join(" ");
const nonBlank = (b: Line[]) => b.filter((l) => l.text.trim() !== "");

function multiSentence(t: string): boolean {
  return /(?<!\b[A-Z])[.!?]["')\]]?\s+["'(]?[A-Z0-9]/.test(t.replace(ABBREV, (m) => m.replace(/\./g, "")));
}

type Item = { n: number; text: string; line: number; section: string };

function numberedList(s: Section, max: number, maxWords: number, problems: string[]): Item[] {
  const body = nonBlank(s.body);
  const items: Item[] = [];
  for (const { text, line } of body) {
    const m = text.match(/^\s*(\d+)\.\s+(.*\S)\s*$/);
    if (!m) {
      if (/^\s*[-*+]\s+\S/.test(text)) problems.push(`line ${line}: ${s.name} has a bullet; items are numbered (1. 2. 3.)`);
      else problems.push(`line ${line}: ${s.name} has a line that is not a numbered item ("${text.trim()}")`);
      continue;
    }
    items.push({ n: Number(m[1]), text: m[2], line, section: s.name });
  }
  if (items.length === 0) problems.push(`line ${s.line}: ${s.name} has no numbered items`);
  if (items.length > max) problems.push(`${s.name} has ${items.length} items; at most ${max}`);
  items.forEach((it, i) => {
    if (it.n !== i + 1) problems.push(`line ${it.line}: ${s.name} item numbered ${it.n}, expected ${i + 1}`);
    const w = words(it.text).length;
    if (w > maxWords) problems.push(`line ${it.line}: ${s.name} item has ${w} words; at most ${maxWords}`);
  });
  return items;
}

export function check(input: string): Result {
  const problems: string[] = [];
  let lines = input.replace(/\r\n/g, "\n").split("\n");
  const harvest = lines.findIndex((l) => /^\s*-{3}\s*HARVEST\s*-{3}\s*$/.test(l));
  if (harvest >= 0) lines = lines.slice(0, harvest);
  const all: Line[] = lines.map((text, i) => ({ text, line: i + 1 }));

  if (/\*\*[^*\n]+\*\*/.test(lines.join("\n"))) problems.push("bold text appears; the output uses no bold");

  let title = "";
  const preamble: Line[] = [];
  const sections: Section[] = [];
  for (const l of all) {
    const h = l.text.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (h && h[1].length === 1 && sections.length === 0 && !title) {
      const t = h[2].match(/^Summary:\s+(\S.*)$/);
      if (t) { title = t[1]; continue; }
      problems.push(`line ${l.line}: title is "${h[2]}"; it opens "# Summary: " and names what was summarized`);
      title = h[2];
      continue;
    }
    if (h && h[1].length === 2) { sections.push({ name: h[2].replace(/:\s*$/, "").trim(), line: l.line, body: [] }); continue; }
    if (h) { problems.push(`line ${l.line}: unexpected heading "${l.text.trim()}"; only the title and the three ## sections are allowed`); continue; }
    (sections.length ? sections[sections.length - 1].body : preamble).push(l);
  }

  if (!title) problems.push('no title; the output opens on "# Summary: <what was summarized>"');
  for (const l of nonBlank(preamble)) problems.push(`line ${l.line}: text outside the sections ("${l.text.trim()}")`);

  const names = sections.map((s) => s.name.toUpperCase());
  if (names.length !== 3 || SECTIONS.some((n, i) => names[i] !== n)) {
    problems.push(`sections are [${sections.map((s) => s.name).join(", ")}]; expected ${SECTIONS.join(", ")} in that order`);
    return { ok: false, title, mainPoints: 0, takeaways: 0, problems };
  }

  const [sentence, main, take] = sections;
  const sl = nonBlank(sentence.body);
  if (sl.length !== 1) problems.push(`ONE SENTENCE SUMMARY has ${sl.length} lines; it is one sentence on one line`);
  if (sl.length >= 1) {
    const t = sl[0].text.trim();
    if (/^(?:[-*+]|\d+\.)\s+/.test(t)) problems.push("ONE SENTENCE SUMMARY is a list item; it is one sentence");
    if (multiSentence(t)) problems.push("ONE SENTENCE SUMMARY holds more than one sentence");
    const w = words(t).length;
    if (w > LIMITS.sentenceWords) problems.push(`ONE SENTENCE SUMMARY has ${w} words; at most ${LIMITS.sentenceWords}`);
    if (META.test(t.replace(/^[^\p{L}]+/u, ""))) problems.push("ONE SENTENCE SUMMARY describes the input instead of stating its content");
  }

  const points = numberedList(main, LIMITS.mainPoints, LIMITS.pointWords, problems);
  const takeaways = numberedList(take, LIMITS.takeaways, LIMITS.takeawayWords, problems);

  const seenText = new Map<string, Item>();
  const seenOpen = new Map<string, Item>();
  for (const it of [...points, ...takeaways]) {
    const n = norm(it.text);
    const dup = seenText.get(n);
    if (dup) problems.push(`line ${it.line}: repeats the item on line ${dup.line}`);
    else seenText.set(n, it);
    const o = opening(it.text);
    const prev = seenOpen.get(o);
    if (o.includes(" ") && prev) problems.push(`line ${it.line}: opens on "${o}", like line ${prev.line}`);
    else seenOpen.set(o, it);
  }
  if (sl.length === 1) {
    const s = norm(sl[0].text);
    for (const it of [...points, ...takeaways]) if (norm(it.text) === s) problems.push(`line ${it.line}: repeats the one-sentence summary`);
  }

  return { ok: problems.length === 0, title, mainPoints: points.length, takeaways: takeaways.length, problems };
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
    console.error(`unknown flag ${unknown[0]}\n${HELP}`);
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
  if (json) console.log(JSON.stringify(r));
  else if (r.ok) console.log(`✓ ${r.mainPoints} main points, ${r.takeaways} takeaways, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
