#!/usr/bin/env bun
// SummarizeDebateCheck — checks a SummarizeDebate output against the parts of
// its contract code can judge: the sections in order, two to four sides each
// with an arguments section and a mind-changing section in the same order and
// under the same names, one-sentence Summary (<=25 words) and Primary
// disagreement (<=24 words), up to ten bullets of at most 15 words per side
// list with no repeated openings, one 1-10 rating line per side plus a Winner
// line naming a side or Draw, mind-changing bullets tagged (stated) or
// (inferred) with stated first and at most three inferred, a Common ground
// section of up to five bullets or "None stated.", a Prediction that names a
// side, a Follow-up of
// one sentence plus up to five bullets, and no bold, italics or numbered lists.
// Fidelity to the debate and the quality of the crux stay judged checks.

import { readFileSync } from "node:fs";

const HELP = `SummarizeDebateCheck — shape check for a Fabric SummarizeDebate output

  bun skills/Fabric/Tools/SummarizeDebateCheck.ts <file|-> [--json]

  --json      print {ok, notDebate, sides, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export type Result = { ok: boolean; notDebate: boolean; sides: string[]; problems: string[] };

type Line = { text: string; line: number };
type Section = { name: string; line: number; body: Line[] };

const MAX_LIST = 10;
const MAX_ITEM_WORDS = 15;
const MAX_FOLLOW = 5;
const MAX_COMMON = 5;
const MAX_COMMON_WORDS = 20;
const MAX_INFERRED = 3;
const TAG = /\s*\((stated|inferred)\)\s*$/i;
const ABBREV = /\b(?:Dr|Mr|Mrs|Ms|Prof|St|Sr|Jr|vs|etc|e\.g|i\.e|U\.S|U\.K|No)\./g;

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

const apos = (s: string) => s.replace(/[’‘]/g, "'");
const norm = (s: string) => apos(s).toLowerCase().replace(/\s+/g, " ").trim();
const opening = (text: string) => words(text).slice(0, 2).map((w) => w.toLowerCase()).join(" ");
const nonBlank = (b: Line[]) => b.filter((l) => l.text.trim() !== "");
const isBullet = (t: string) => /^\s*-\s+\S/.test(t);

function multiSentence(t: string): boolean {
  return /(?<!\b[A-Z])[.!?]["')\]]?\s+["'(]?[A-Z0-9]/.test(t.replace(ABBREV, (m) => m.replace(/\./g, "")));
}

function sentenceSection(s: Section, max: number, problems: string[]) {
  const body = nonBlank(s.body);
  if (body.length !== 1) { problems.push(`${s.name} has ${body.length} lines; it is one sentence on one line`); return; }
  const t = body[0].text.trim();
  if (isBullet(t)) problems.push(`${s.name} is a list item; it is one sentence`);
  if (multiSentence(t)) problems.push(`${s.name} holds more than one sentence`);
  const w = words(t).length;
  if (w > max) problems.push(`${s.name} has ${w} words; at most ${max}`);
}

function bulletList(s: Section, where: string, problems: string[], mind: boolean) {
  const body = nonBlank(s.body);
  if (body.length === 0) problems.push(`line ${s.line}: ${where} has no bullets`);
  if (body.length > MAX_LIST) problems.push(`${where} has ${body.length} bullets; at most ${MAX_LIST}`);
  const seenOpen = new Map<string, number>();
  const seenText = new Set<string>();
  let inferred = 0;
  for (const { text, line } of body) {
    if (!isBullet(text)) { problems.push(`line ${line}: ${where} has a line that is not a "- " bullet ("${text.trim()}")`); continue; }
    let item = text.trim().replace(/^-\s+/, "");
    if (mind) {
      const tag = item.match(TAG)?.[1]?.toLowerCase();
      if (!tag) problems.push(`line ${line}: ${where} bullet ends in neither (stated) nor (inferred)`);
      else if (tag === "inferred") inferred++;
      else if (inferred > 0) problems.push(`line ${line}: ${where} lists a (stated) item after an (inferred) one; stated conditions come first`);
      item = item.replace(TAG, "");
    }
    const w = words(item).length;
    if (w > MAX_ITEM_WORDS) problems.push(`line ${line}: ${where} bullet has ${w} words; at most ${MAX_ITEM_WORDS}`);
    const n = norm(item);
    if (seenText.has(n)) problems.push(`line ${line}: ${where} repeats a bullet`);
    seenText.add(n);
    const o = opening(item);
    if (o.includes(" ") && seenOpen.has(o)) problems.push(`line ${line}: ${where} has two bullets opening on "${o}"`);
    else seenOpen.set(o, line);
  }
  if (inferred > MAX_INFERRED) problems.push(`${where} has ${inferred} (inferred) items; at most ${MAX_INFERRED}`);
}

function commonGround(s: Section, problems: string[]) {
  const body = nonBlank(s.body);
  if (body.length === 0) { problems.push('Common ground is empty; it lists concessions and agreements or says "None stated."'); return; }
  if (body.length === 1 && /^None stated\.?$/i.test(body[0].text.trim())) return;
  if (body.length > MAX_COMMON) problems.push(`Common ground has ${body.length} bullets; at most ${MAX_COMMON}`);
  const seen = new Set<string>();
  for (const { text, line } of body) {
    if (!isBullet(text)) { problems.push(`line ${line}: Common ground has a line that is not a "- " bullet ("${text.trim()}")`); continue; }
    const item = text.trim().replace(/^-\s+/, "");
    const w = words(item).length;
    if (w > MAX_COMMON_WORDS) problems.push(`line ${line}: Common ground bullet has ${w} words; at most ${MAX_COMMON_WORDS}`);
    if (seen.has(norm(item))) problems.push(`line ${line}: Common ground repeats a bullet`);
    seen.add(norm(item));
  }
}

function startsWithName(rest: string, names: string[]): string | undefined {
  const r = norm(rest);
  return names
    .filter((n) => r.startsWith(norm(n)) && /^[.,:]/.test(r.slice(norm(n).length)))
    .sort((a, b) => b.length - a.length)[0];
}

export function check(input: string): Result {
  const problems: string[] = [];
  let lines = input.replace(/\r\n/g, "\n").split("\n");
  const harvest = lines.findIndex((l) => /^\s*-{3}\s*HARVEST\s*-{3}\s*$/.test(l));
  if (harvest >= 0) lines = lines.slice(0, harvest);
  const all: Line[] = lines.map((text, i) => ({ text, line: i + 1 }));
  const filled = nonBlank(all);

  if (/\*\*[^*\n]+\*\*/.test(input)) problems.push("bold text appears; the output uses no bold");
  if (/(?<![\w*])\*(?!\s)[^*\n]+(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)[^_\n]+(?<!\s)_(?![\w_])/.test(lines.join("\n")))
    problems.push("italic text appears; the output uses no italics");
  for (const { text, line } of all) if (/^\s*\d+[.)]\s+\S/.test(text)) problems.push(`line ${line}: numbered list item; lists are "- " bullets`);

  const nd = filled.findIndex((l) => /^Not a debate:\s+\S/.test(l.text.trim()));
  if (nd >= 0) {
    if (filled.length > 1) problems.push(`line ${filled[nd].line}: a not-a-debate answer is that single line, with nothing else`);
    return { ok: problems.length === 0, notDebate: true, sides: [], problems };
  }

  const preamble: Line[] = [];
  const sections: Section[] = [];
  for (const l of all) {
    const h = l.text.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (h && h[1].length === 2) { sections.push({ name: h[2], line: l.line, body: [] }); continue; }
    if (h) { problems.push(`line ${l.line}: unexpected heading "${l.text.trim()}"; only ## sections are allowed`); continue; }
    (sections.length ? sections[sections.length - 1].body : preamble).push(l);
  }

  const pre = nonBlank(preamble);
  if (pre.length > 1 || (pre.length === 1 && !/^Source:\s+\S/.test(pre[0].text.trim())))
    problems.push("before the first section only one Source: line is allowed");

  // Expected order: Summary, Primary disagreement, N arguments, N mind, Common ground, Argument strength, Prediction, Follow-up.
  const names = sections.map((s) => s.name);
  const head = ["Summary", "Primary disagreement"];
  const tail = ["Common ground", "Argument strength", "Prediction", "Follow-up"];
  const argRe = /^(.+?)(?:'s|')\s+arguments$/i;
  const mindRe = /^What would change\s+(.+?)(?:'s|')\s+mind$/i;
  const middle = sections.slice(2, sections.length - tail.length);
  const argSides: string[] = [];
  const mindSides: string[] = [];
  let shapeOk = names.length >= head.length + tail.length + 2 && head.every((h, i) => norm(names[i]) === norm(h)) && tail.every((t, i) => norm(names[names.length - tail.length + i]) === norm(t));
  if (shapeOk) {
    let phase: "arg" | "mind" = "arg";
    for (const s of middle) {
      const n = apos(s.name);
      const a = n.match(argRe);
      const m = n.match(mindRe);
      if (m) { phase = "mind"; mindSides.push(m[1].trim()); }
      else if (a && phase === "arg") argSides.push(a[1].trim());
      else { shapeOk = false; break; }
    }
  }
  if (!shapeOk) {
    problems.push(`sections are [${names.join(", ")}]; expected Summary, Primary disagreement, "<Side>'s arguments" for each side, "What would change <Side>'s mind" for each side, Common ground, Argument strength, Prediction, Follow-up`);
    return { ok: false, notDebate: false, sides: argSides, problems };
  }
  if (argSides.length < 2 || argSides.length > 4) problems.push(`${argSides.length} sides; a debate has two to four`);
  if (argSides.map(norm).join("|") !== mindSides.map(norm).join("|"))
    problems.push(`mind-changing sections name [${mindSides.join(", ")}]; expected the arguments sides [${argSides.join(", ")}] in the same order`);
  if (new Set(argSides.map(norm)).size !== argSides.length) problems.push("two arguments sections name the same side");

  const [summary, primary] = sections;
  sentenceSection(summary, 25, problems);
  sentenceSection(primary, 24, problems);
  for (const s of middle) bulletList(s, s.name, problems, mindRe.test(apos(s.name)));

  const [common, strength, prediction, follow] = sections.slice(-tail.length);
  commonGround(common, problems);

  // Argument strength: one rating line per side in order, then a Winner line.
  const sl = nonBlank(strength.body);
  const want = argSides.length + 1;
  if (sl.length !== want) problems.push(`Argument strength has ${sl.length} lines; expected one per side plus a Winner line (${want})`);
  argSides.forEach((side, i) => {
    const l = sl[i];
    if (!l) return;
    const m = apos(l.text.trim()).match(/^-\s+(.+):\s+(\d+)\s*\/\s*10\b\.?\s*(.*)$/);
    if (!m) { problems.push(`line ${l.line}: rating line is not "- ${side}: N/10. reason"`); return; }
    if (norm(m[1]) !== norm(side)) problems.push(`line ${l.line}: rating line names "${m[1]}", expected "${side}"`);
    const n = Number(m[2]);
    if (n < 1 || n > 10) problems.push(`line ${l.line}: rating ${n} is outside 1 to 10`);
    if (words(m[3]).length < 3) problems.push(`line ${l.line}: rating for ${side} has no reason`);
  });
  const wl = sl[argSides.length];
  if (wl) {
    const m = wl.text.trim().match(/^-\s+Winner:\s+(.*)$/);
    if (!m) problems.push(`line ${wl.line}: the last Argument strength line is not "- Winner: <Side or Draw>. reason"`);
    else {
      const who = startsWithName(m[1], [...argSides, "Draw"]);
      if (!who) problems.push(`line ${wl.line}: Winner names neither a side (${argSides.join(", ")}) nor Draw`);
      else if (words(m[1].slice(who.length)).length < 3) problems.push(`line ${wl.line}: Winner has no reason`);
    }
  }

  // Prediction: prose, names a side (or neither/both).
  const pl = nonBlank(prediction.body);
  if (pl.length === 0) problems.push("Prediction is empty");
  else {
    if (pl.some((l) => isBullet(l.text))) problems.push("Prediction is a list; it is prose");
    const text = norm(pl.map((l) => l.text).join(" "));
    // A side counts as named by its full name or its last word (a surname, or the head noun of "Nuclear advocates").
    const named = argSides.some((s) => {
      const last = words(s).at(-1)?.toLowerCase() ?? "";
      return text.includes(norm(s)) || (last.length >= 3 && new RegExp(`\\b${last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text));
    });
    if (!named && !/\b(?:neither|both)\b/.test(text))
      problems.push("Prediction names no side");
  }

  // Follow-up: one sentence, then 1..5 bullets.
  const fl = nonBlank(follow.body);
  if (fl.length === 0) problems.push("Follow-up is empty");
  else {
    if (isBullet(fl[0].text)) problems.push("Follow-up opens on a bullet; it opens on one sentence about where the debate leaves the question");
    else if (multiSentence(fl[0].text.trim())) problems.push("Follow-up's opening holds more than one sentence");
    const rest = fl.slice(1);
    const nonB = rest.filter((l) => !isBullet(l.text));
    for (const l of nonB) problems.push(`line ${l.line}: Follow-up has a line that is not a "- " bullet after its opening sentence`);
    const b = rest.length - nonB.length;
    if (b === 0) problems.push("Follow-up has no bullets of what to watch");
    if (b > MAX_FOLLOW) problems.push(`Follow-up has ${b} bullets; at most ${MAX_FOLLOW}`);
  }

  return { ok: problems.length === 0, notDebate: false, sides: argSides, problems };
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
  else if (r.ok) console.log(r.notDebate ? "✓ not-a-debate line, shape holds" : `✓ ${r.sides.length} sides, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
