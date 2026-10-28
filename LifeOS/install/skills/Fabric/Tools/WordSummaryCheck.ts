#!/usr/bin/env bun
// WordSummaryCheck — checks a WordSummary output against the parts of its
// contract code can judge: N levels opening on a bold number (**5.**), N..1, level k holds exactly k
// words, levels separated by blank lines, no level a trimmed copy of the one
// above, nothing but a heading and the levels. Meaning stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `WordSummaryCheck — shape check for a Fabric WordSummary output

  bun skills/Fabric/Tools/WordSummaryCheck.ts <file|-> [--levels N] [--json]

  --levels N  expected level count (default: the first level's number)
  --json      print {ok, levels, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

type Level = { n: number; text: string; words: string[]; line: number };

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

function isOrderedSubsequence(small: string[], big: string[]): boolean {
  let i = 0;
  for (const w of big) if (i < small.length && w === small[i]) i++;
  return i === small.length;
}

export function check(input: string, expected?: number): { ok: boolean; levels: Level[]; problems: string[] } {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const levels: Level[] = [];
  const extras: { line: number; text: string; where: "before" | "between" | "after" }[] = [];

  lines.forEach((raw, i) => {
    const m = raw.match(/^\s*\*\*(\d+)\.\*\*\s+(.*\S)\s*$/);
    const plain = raw.match(/^\s*(\d+)[.)]\s+\S/);
    if (plain) problems.push(`line ${i + 1}: markdown list syntax ("${plain[1]}.") renumbers when rendered; open the level on **${plain[1]}.**`);
    if (m) {
      levels.push({ n: Number(m[1]), text: m[2], words: words(m[2]), line: i + 1 });
    } else if (raw.trim() !== "") {
      extras.push({ line: i + 1, text: raw.trim(), where: levels.length === 0 ? "before" : "between" });
    }
  });

  if (levels.length === 0) return { ok: false, levels, problems: [...problems, "no levels found (each opens on a bold number such as **5.**)"] };

  const lastLevelLine = levels[levels.length - 1].line;
  for (const e of extras) if (e.line > lastLevelLine) e.where = "after";

  const n = expected ?? levels[0].n;
  if (!Number.isInteger(n) || n < 1) problems.push(`expected level count ${n} is not a whole number of at least 1`);
  if (levels.length !== n) problems.push(`expected ${n} levels, found ${levels.length}`);

  levels.forEach((lv, idx) => {
    const want = n - idx;
    if (lv.n !== want) problems.push(`line ${lv.line}: level numbered ${lv.n}, expected ${want}`);
    if (lv.words.length !== lv.n) problems.push(`line ${lv.line}: level ${lv.n} has ${lv.words.length} words ("${lv.text}")`);
    if (idx > 0) {
      const above = levels[idx - 1];
      if (lv.line - above.line < 2 || lines[lv.line - 2].trim() !== "") problems.push(`line ${lv.line}: no blank line between level ${above.n} and level ${lv.n}`);
      const small = lv.words.map((w) => w.toLowerCase());
      const big = above.words.map((w) => w.toLowerCase());
      if (small.join(" ") === big.join(" ")) problems.push(`line ${lv.line}: level ${lv.n} repeats level ${above.n}`);
      else if (small.length > 1 && isOrderedSubsequence(small, big)) problems.push(`line ${lv.line}: level ${lv.n} is level ${above.n} with words deleted, not a reframe`);
    }
  });

  const before = extras.filter((e) => e.where === "before");
  if (before.length > 1) problems.push(`${before.length} lines before the levels; only one heading is allowed`);
  for (const e of extras.filter((e) => e.where === "between")) problems.push(`line ${e.line}: commentary between levels ("${e.text}")`);
  const after = extras.filter((e) => e.where === "after");
  if (after.length > 1) problems.push(`${after.length} lines after the levels; only one cap note is allowed`);

  return { ok: problems.length === 0, levels, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const li = args.indexOf("--levels");
  const expected = li >= 0 ? Number(args[li + 1]) : undefined;
  if (li >= 0 && !Number.isInteger(expected)) {
    console.error("--levels needs a whole number");
    process.exit(2);
  }
  const src = args.find((a, i) => !a.startsWith("--") && !(li >= 0 && i === li + 1));
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input, expected);
  if (json) console.log(JSON.stringify({ ok: r.ok, levels: r.levels.map((l) => ({ n: l.n, text: l.text, words: l.words.length })), problems: r.problems }));
  else if (r.ok) console.log(`✓ ${r.levels.length} levels, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
