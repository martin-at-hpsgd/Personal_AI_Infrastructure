#!/usr/bin/env bun
// ExtractInsightsCheck — checks an ExtractInsights output against the parts of
// its contract code can judge: one `# INSIGHTS: …` heading, N hyphen bullets of
// exactly eight words, no two bullets opening on the same word or repeating,
// no numbered lists, sub-bullets or bold lead-ins, and nothing else except the
// one `Only K of N: …` line a thin source may add. Whether each bullet is a
// real insight stays a judged check in the fabric-extractinsights suite.

import { readFileSync } from "node:fs";

const HELP = `ExtractInsightsCheck — shape check for a Fabric ExtractInsights output

  bun skills/Fabric/Tools/ExtractInsightsCheck.ts <file|-> [--count N] [--json]

  --count N  the number of insights the request asked for (default 10)
  --json     print {ok, count, bullets, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const DEFAULT_COUNT = 10;
export const WORDS_PER_BULLET = 8;

type Bullet = { text: string; words: string[]; line: number };
export type CheckResult = { ok: boolean; count: number; bullets: Bullet[]; thin: { k: number; n: number } | null; problems: string[] };

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

export function check(input: string, count: number = DEFAULT_COUNT): CheckResult {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const bullets: Bullet[] = [];
  let heading: { line: number; text: string } | null = null;
  let thin: { k: number; n: number } | null = null;
  let thinLine = -1;

  lines.forEach((raw, i) => {
    const ln = i + 1;
    const t = raw.trim();
    if (t === "") return;
    const h = raw.match(/^#{1,6}\s+(.*\S)\s*$/);
    const b = raw.match(/^- (.*\S)\s*$/);
    const thinM = t.match(/^Only (\d+) of (\d+):\s*\S/);
    if (/^\s*\d+[.)]\s+\S/.test(raw)) {
      problems.push(`line ${ln}: numbered list item; use a hyphen bullet`);
    } else if (/^\s+[-*+]\s/.test(raw)) {
      problems.push(`line ${ln}: sub-bullet; every insight is one top-level bullet`);
    } else if (/^[*+]\s/.test(raw)) {
      problems.push(`line ${ln}: bullet marker "${raw[0]}"; use "- "`);
    } else if (h) {
      if (heading || bullets.length > 0) problems.push(`line ${ln}: extra heading ("${t}"); the output is the INSIGHTS section only`);
      else heading = { line: ln, text: h[1] };
      if (!/^#\s/.test(raw)) problems.push(`line ${ln}: the heading is an H1 ("# INSIGHTS: …")`);
    } else if (b) {
      if (thin) problems.push(`line ${ln}: bullet after the closing "Only K of N" line`);
      bullets.push({ text: b[1], words: words(b[1]), line: ln });
    } else if (thinM && bullets.length > 0 && !thin) {
      thin = { k: Number(thinM[1]), n: Number(thinM[2]) };
      thinLine = ln;
    } else {
      problems.push(`line ${ln}: ${bullets.length === 0 ? "text before the bullets" : "text outside the bullets"} ("${t.slice(0, 60)}")`);
    }
  });

  if (!heading) problems.push('no heading; the output opens on "# INSIGHTS: {what was read, and the read inferred}"');
  else {
    const hd = heading as { line: number; text: string };
    if (!/^INSIGHTS:\s*\S/.test(hd.text)) problems.push(`line ${hd.line}: heading must open on "INSIGHTS:" and name the read ("${hd.text}")`);
    const firstNonBlank = lines.findIndex((l) => l.trim() !== "") + 1;
    if (hd.line !== firstNonBlank) problems.push(`line ${hd.line}: the heading is the first line`);
  }

  if (bullets.length === 0) problems.push("no bullets found (each insight is a line opening on \"- \")");

  if (thin) {
    const th = thin as { k: number; n: number };
    if (th.n !== count) problems.push(`line ${thinLine}: "Only ${th.k} of ${th.n}" names ${th.n}, but ${count} were asked for`);
    if (th.k !== bullets.length) problems.push(`line ${thinLine}: "Only ${th.k} of ${th.n}" but ${bullets.length} bullets were given`);
    if (bullets.length >= count) problems.push(`line ${thinLine}: a closing "Only K of N" line with the full ${count} bullets; drop it`);
  } else if (bullets.length !== count && bullets.length > 0) {
    problems.push(
      bullets.length < count
        ? `expected ${count} bullets, found ${bullets.length}; a thin source closes on "Only ${bullets.length} of ${count}: {why}"`
        : `expected ${count} bullets, found ${bullets.length}`,
    );
  }

  const openings = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const bl of bullets) {
    if (bl.words.length !== WORDS_PER_BULLET) problems.push(`line ${bl.line}: ${bl.words.length} words, expected ${WORDS_PER_BULLET} ("${bl.text}")`);
    if (/^\*\*|^__/.test(bl.text)) problems.push(`line ${bl.line}: bold lead-in; write the bullet as a plain sentence`);
    const first = bl.words[0]?.toLowerCase();
    if (first) {
      const prev = openings.get(first);
      if (prev !== undefined) problems.push(`line ${bl.line}: opens on "${bl.words[0]}" like line ${prev}`);
      else openings.set(first, bl.line);
    }
    const key = bl.words.map((w) => w.toLowerCase()).join(" ");
    const dup = seen.get(key);
    if (dup !== undefined) problems.push(`line ${bl.line}: repeats line ${dup}`);
    else seen.set(key, bl.line);
  }

  return { ok: problems.length === 0, count, bullets, thin, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const ci = args.indexOf("--count");
  const count = ci >= 0 ? Number(args[ci + 1]) : DEFAULT_COUNT;
  if (ci >= 0 && !(Number.isInteger(count) && count >= 1)) {
    console.error("--count needs a whole number of at least 1");
    process.exit(2);
  }
  const unknown = args.find((a) => a.startsWith("--") && a !== "--json" && a !== "--count");
  if (unknown) {
    console.error(`unknown flag ${unknown}\n\n${HELP}`);
    process.exit(2);
  }
  const src = args.find((a, i) => (a === "-" || !a.startsWith("--")) && !(ci >= 0 && i === ci + 1));
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input, count);
  if (json) {
    console.log(JSON.stringify({ ok: r.ok, count: r.count, bullets: r.bullets.map((b) => ({ text: b.text, words: b.words.length })), thin: r.thin, problems: r.problems }));
  } else if (r.ok) console.log(`✓ ${r.bullets.length} insights of ${WORDS_PER_BULLET} words, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
