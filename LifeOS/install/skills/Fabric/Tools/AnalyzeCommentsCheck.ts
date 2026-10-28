#!/usr/bin/env bun
// AnalyzeCommentsCheck — checks an AnalyzeComments output against the parts of
// its contract code can judge: one "**Comments read:**" line, then the four
// sections in order; a verdict from the fixed scale whose positive, negative and
// neutral counts add up to the total and whose direction follows the split; up
// to five points per list, each at most 15 words, carrying "(k of total)" with
// the same total, ranked by count, and quoting a commenter; a Summary of at most
// 20 words; no template placeholders. With --source it also requires every quote
// to appear in the comments. Whether the points and counts match the comments
// stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `AnalyzeCommentsCheck — shape check for a Fabric AnalyzeComments output

  bun skills/Fabric/Tools/AnalyzeCommentsCheck.ts <file|-> [--source <comments-file>] [--json]

  --source F  the analyzed comments; every quoted comment must appear in them
  --json      print {ok, noComments, verdict, counts, positives, negatives, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const SECTIONS = ["Comments sentiment", "Positives", "Negatives", "Summary"] as const;
export const VERDICTS = ["HATED", "DISLIKED", "NEUTRAL", "LIKED", "LOVED"] as const;
const PLACEHOLDER = /\{[^}]*\}|HATED\|DISLIKED/;
const NO_COMMENTS = /^\*\*No comments:\*\*[ \t]+\S/;
const READ_LINE = /^\*\*Comments read:\*\*[ \t]+\S/;
const VERDICT_LINE = /^\*\*([A-Z]+)\*\*:[ \t]*(\d+)[ \t]+positive,[ \t]*(\d+)[ \t]+negative,[ \t]*(\d+)[ \t]+neutral[ \t]+of[ \t]+(\d+)[ \t]+comments?\.[ \t]*(.*)$/;
const POINT = /^[-*][ \t]+(.+?)[ \t]+\((\d+)[ \t]+of[ \t]+(\d+)\):[ \t]*["“](.+)["”][ \t]*$/;

export type Point = { text: string; count: number; total: number; quote: string; line: number };
export type Counts = { positive: number; negative: number; neutral: number; total: number };
export type Result = {
  ok: boolean;
  noComments: boolean;
  verdict?: string;
  counts?: Counts;
  positives: Point[];
  negatives: Point[];
  problems: string[];
};

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// A quote is found when each piece between ellipses appears in the source.
export function quoteInSource(quote: string, source: string): boolean {
  const src = normalize(source);
  return quote
    .split(/\.\.\.|…|\[\.\.\.\]/)
    .map((p) => normalize(p).replace(/^[\s,.;:!?]+|[\s,.;:!?]+$/g, ""))
    .filter((p) => p.length > 0)
    .every((p) => src.includes(p));
}

export function check(input: string, source?: string): Result {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const positives: Point[] = [];
  const negatives: Point[] = [];
  const trimmed = input.trim();

  if (NO_COMMENTS.test(trimmed)) {
    if (trimmed.split("\n").filter((l) => l.trim() !== "").length > 1) problems.push("the **No comments:** line must be the whole output");
    return { ok: problems.length === 0, noComments: true, positives, negatives, problems };
  }
  if (lines.some((l) => NO_COMMENTS.test(l.trim()))) problems.push("the **No comments:** line must be the whole output");

  const sections: { name: string; line: number; body: { text: string; line: number }[] }[] = [];
  const preamble: { text: string; line: number }[] = [];
  lines.forEach((raw, i) => {
    const h2 = raw.match(/^##[ \t]+(.+?)\s*$/);
    if (h2 && !raw.startsWith("###")) sections.push({ name: h2[1], line: i + 1, body: [] });
    else if (sections.length === 0) { if (raw.trim() !== "") preamble.push({ text: raw.trim(), line: i + 1 }); }
    else sections[sections.length - 1].body.push({ text: raw, line: i + 1 });
    if (PLACEHOLDER.test(raw)) problems.push(`line ${i + 1}: template placeholder left in ("${raw.trim().slice(0, 60)}")`);
  });

  if (preamble.length === 0 || !READ_LINE.test(preamble[0].text)) problems.push('the output must open on one "**Comments read:** …" line');
  for (const p of preamble.slice(READ_LINE.test(preamble[0]?.text ?? "") ? 1 : 0)) problems.push(`line ${p.line}: text before "## Comments sentiment" ("${p.text.slice(0, 60)}")`);

  const names = sections.map((s) => s.name);
  for (const s of sections) if (!(SECTIONS as readonly string[]).includes(s.name)) problems.push(`line ${s.line}: unexpected section "## ${s.name}"`);
  for (const want of SECTIONS) {
    const count = names.filter((n) => n === want).length;
    if (count === 0) problems.push(`missing section "## ${want}"`);
    else if (count > 1) problems.push(`section "## ${want}" appears ${count} times`);
  }
  const order = names.filter((n) => (SECTIONS as readonly string[]).includes(n));
  if (order.length === SECTIONS.length && order.some((n, i) => n !== SECTIONS[i])) problems.push(`sections out of order: ${order.join(", ")}`);
  const get = (name: string) => sections.find((s) => s.name === name);
  const nonEmpty = (name: string) => (get(name)?.body ?? []).filter((b) => b.text.trim() !== "");

  // Verdict.
  let verdict: string | undefined;
  let counts: Counts | undefined;
  const sent = nonEmpty("Comments sentiment");
  if (get("Comments sentiment")) {
    if (sent.length !== 1) problems.push(`"## Comments sentiment" must be the one verdict line, found ${sent.length} lines`);
    const first = sent[0];
    const m = first?.text.trim().match(VERDICT_LINE);
    if (!m) problems.push('verdict must read "**<VERDICT>**: <p> positive, <n> negative, <m> neutral of <total> comments. <reason>"');
    else {
      verdict = m[1];
      counts = { positive: Number(m[2]), negative: Number(m[3]), neutral: Number(m[4]), total: Number(m[5]) };
      const { positive: p, negative: n, neutral: z, total } = counts;
      if (!(VERDICTS as readonly string[]).includes(verdict)) problems.push(`verdict "${verdict}" is not one of ${VERDICTS.join(", ")}`);
      if (total < 1) problems.push("the total must be at least 1 comment (use the **No comments:** line otherwise)");
      if (p + n + z !== total) problems.push(`counts ${p} + ${n} + ${z} = ${p + n + z}, but the total is ${total}`);
      if ((verdict === "LIKED" || verdict === "LOVED") && !(p > n)) problems.push(`${verdict} needs more positive than negative comments (${p} vs ${n})`);
      if ((verdict === "DISLIKED" || verdict === "HATED") && !(n > p)) problems.push(`${verdict} needs more negative than positive comments (${n} vs ${p})`);
      if (words(m[6]).length < 3) problems.push("the verdict line needs a one-sentence reason after the counts");
    }
  }

  // Points.
  const points = (name: "Positives" | "Negatives", into: Point[]) => {
    if (!get(name)) return;
    const body = nonEmpty(name);
    if (body.length === 0) return problems.push(`"## ${name}" is empty (write "- None" when there are no points)`);
    if (body.length === 1 && /^[-*][ \t]+None\.?\s*$/.test(body[0].text.trim())) return;
    for (const { text: raw, line } of body) {
      const t = raw.trim();
      if (/^[-*][ \t]+None\.?\s*$/.test(t)) { problems.push(`line ${line}: "- None" must be the only bullet in "## ${name}"`); continue; }
      const m = t.match(POINT);
      if (!m) { problems.push(`line ${line}: point must read '- <point> (<k> of <total>): "<exact words>"' ("${t.slice(0, 60)}")`); continue; }
      const pt: Point = { text: m[1], count: Number(m[2]), total: Number(m[3]), quote: m[4], line };
      into.push(pt);
      const n = words(pt.text).length;
      if (n > 15) problems.push(`line ${line}: point has ${n} words; at most 15`);
      if (pt.count < 1) problems.push(`line ${line}: a point needs at least 1 comment behind it`);
      if (counts && pt.total !== counts.total) problems.push(`line ${line}: point total ${pt.total} differs from the verdict total ${counts.total}`);
      if (pt.count > pt.total) problems.push(`line ${line}: count ${pt.count} exceeds the total ${pt.total}`);
      if (words(pt.quote).length === 0) problems.push(`line ${line}: empty quote`);
      if (source !== undefined && !quoteInSource(pt.quote, source)) problems.push(`line ${line}: quote not found in the source ("${pt.quote.slice(0, 60)}")`);
    }
    if (into.length > 5) problems.push(`"## ${name}" lists ${into.length} points; at most 5`);
    for (let i = 1; i < into.length; i++) {
      if (into[i].count > into[i - 1].count) problems.push(`line ${into[i].line}: "## ${name}" not ranked by count (${into[i].count} after ${into[i - 1].count})`);
    }
    const seen = new Set<string>();
    for (const p of into) {
      const k = normalize(p.text);
      if (seen.has(k)) problems.push(`line ${p.line}: point repeated in "## ${name}"`);
      seen.add(k);
    }
  };
  points("Positives", positives);
  points("Negatives", negatives);

  // Summary.
  if (get("Summary")) {
    const paras = nonEmpty("Summary").map((b) => b.text.trim()).join("\n").split(/\n\s*\n/).filter((p) => p.trim() !== "");
    const body = nonEmpty("Summary");
    if (body.length === 0) problems.push('"## Summary" is empty');
    else {
      if (body.length > 1 || paras.length > 1) problems.push(`"## Summary" must be one line, found ${body.length}`);
      if (/^[-*][ \t]/.test(body[0].text.trim())) problems.push('"## Summary" is prose, not a bullet');
      const n = words(body.map((b) => b.text).join(" ")).length;
      if (n > 20) problems.push(`"## Summary" has ${n} words; at most 20`);
    }
  }

  return { ok: problems.length === 0, noComments: false, verdict, counts, positives, negatives, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const si = args.indexOf("--source");
  if (si >= 0 && (args[si + 1] === undefined || args[si + 1].startsWith("--"))) {
    console.error("--source needs a file path");
    process.exit(2);
  }
  const unknown = args.filter((a, i) => a.startsWith("--") && !["--json", "--source"].includes(a) && !(si >= 0 && i === si + 1));
  if (unknown.length) {
    console.error(`unknown flag ${unknown[0]}\n\n${HELP}`);
    process.exit(2);
  }
  const src = args.find((a, i) => (a === "-" || !a.startsWith("--")) && !(si >= 0 && i === si + 1));
  let input: string;
  let source: string | undefined;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
    if (si >= 0) source = readFileSync(args[si + 1], "utf8");
  } catch (e) {
    console.error(`cannot read input: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input, source);
  if (json) {
    console.log(JSON.stringify({
      ok: r.ok, noComments: r.noComments, verdict: r.verdict, counts: r.counts,
      positives: r.positives.map(({ line, ...p }) => p), negatives: r.negatives.map(({ line, ...p }) => p), problems: r.problems,
    }));
  } else if (r.ok) {
    console.log(r.noComments ? "✓ no-comments line, shape holds" : `✓ ${r.verdict}, ${r.positives.length} positives, ${r.negatives.length} negatives, shape holds`);
  } else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
