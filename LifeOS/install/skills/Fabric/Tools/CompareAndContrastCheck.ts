#!/usr/bin/env bun
// CompareAndContrastCheck — checks a CompareAndContrast output against the
// parts of its contract code can judge: one "# Compare and Contrast:" title,
// one GitHub-flavored table parsed cell by cell (header, separator, one row
// per item, equal cell counts), 2-10 distinct items and 2-8 distinct,
// non-filler dimensions, no empty, placeholder or overlong cell, no column
// that gives every item the same answer, and the In common and Key difference
// closing lines. Whether a dimension matters or a cell is accurate stays a
// judged check.

import { readFileSync } from "node:fs";

const HELP = `CompareAndContrastCheck — shape check for a Fabric CompareAndContrast output

  bun skills/Fabric/Tools/CompareAndContrastCheck.ts <file|-> [--table-only] [--json]

  --table-only  the request said "just the table": the closing lines must be absent
  --json        print {ok, items, dimensions, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const LIMITS = { minItems: 2, maxItems: 10, minDims: 2, maxDims: 8, cellWords: 15, closingWords: 40 } as const;
export const FILLER_HEADERS = ["overview", "description", "summary", "notes", "other", "miscellaneous", "misc", "details", "general", "comments", "info"];
export const PLACEHOLDER_CELLS = ["n/a", "na", "tbd", "tbc", "?", "-", "—", "–", "...", "…", "varies", "depends", "it depends", "unknown"];
export const CLOSING = ["In common", "Key difference"] as const;

export type Table = { header: string[]; rows: string[][]; startLine: number; endLine: number };
export type Result = { ok: boolean; items: string[]; dimensions: string[]; problems: string[] };

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

// Split one GFM table row into trimmed cells. Leading and trailing pipes are
// optional; a backslash-escaped pipe stays inside its cell.
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

const isTableLine = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSeparator = (cells: string[]) => cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
const plain = (c: string) => c.replace(/\*\*|__|`/g, "").replace(/^[*_]|[*_]$/g, "").trim();

export function check(input: string, opts: { tableOnly?: boolean } = {}): Result {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];

  // Find every table block (consecutive pipe lines).
  const tables: Table[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isTableLine(lines[i])) continue;
    const start = i;
    while (i + 1 < lines.length && isTableLine(lines[i + 1])) i++;
    const block = lines.slice(start, i + 1).map(splitRow);
    tables.push({ header: block[0], rows: block.slice(1), startLine: start + 1, endLine: i + 1 });
  }

  // Title.
  const nonBlank = lines.map((l, i) => ({ text: l.trim(), line: i + 1 })).filter((l) => l.text !== "");
  const h1s = nonBlank.filter((l) => /^#\s/.test(l.text));
  if (h1s.length !== 1) problems.push(`expected exactly one H1 title, found ${h1s.length}`);
  const title = h1s[0];
  if (title && !/^#\s+Compare and Contrast:\s+\S/.test(title.text)) problems.push(`line ${title.line}: title must read "# Compare and Contrast: {items and read}"`);
  if (title && nonBlank[0] !== title) problems.push(`line ${nonBlank[0].line}: text before the title ("${nonBlank[0].text}")`);

  if (tables.length !== 1) {
    problems.push(tables.length === 0 ? "no markdown table found" : `expected one table, found ${tables.length}`);
    if (tables.length === 0) return { ok: false, items: [], dimensions: [], problems };
  }
  const t = tables[0];

  // Separator row and body.
  if (t.rows.length === 0 || !isSeparator(t.rows[0])) {
    problems.push(`line ${t.startLine + 1}: second table line must be the separator row (|---|---|)`);
    return { ok: false, items: [], dimensions: [], problems };
  }
  if (t.rows[0].length !== t.header.length) problems.push(`line ${t.startLine + 1}: separator has ${t.rows[0].length} cells, header has ${t.header.length}`);
  const body = t.rows.slice(1);
  const width = t.header.length;
  body.forEach((r, i) => {
    if (r.length !== width) problems.push(`line ${t.startLine + 2 + i}: row has ${r.length} cells, header has ${width}`);
  });

  const items = body.map((r) => plain(r[0] ?? ""));
  const dimensions = t.header.slice(1).map(plain);

  if (plain(t.header[0] ?? "") === "") problems.push(`line ${t.startLine}: first header cell must name what the items are`);
  if (items.length < LIMITS.minItems || items.length > LIMITS.maxItems) problems.push(`expected ${LIMITS.minItems} to ${LIMITS.maxItems} items (rows), found ${items.length}`);
  if (dimensions.length < LIMITS.minDims || dimensions.length > LIMITS.maxDims) problems.push(`expected ${LIMITS.minDims} to ${LIMITS.maxDims} dimensions (columns after the first), found ${dimensions.length}`);

  const dup = (xs: string[]) => xs.filter((x, i) => x !== "" && xs.findIndex((y) => y.toLowerCase() === x.toLowerCase()) !== i);
  for (const d of new Set(dup(items))) problems.push(`item "${d}" appears in more than one row`);
  for (const d of new Set(dup(dimensions))) problems.push(`dimension "${d}" appears in more than one column`);
  dimensions.forEach((d) => {
    if (d === "") problems.push(`line ${t.startLine}: a dimension header is empty`);
    else if (FILLER_HEADERS.includes(d.toLowerCase())) problems.push(`line ${t.startLine}: "${d}" is a filler dimension, not something the items differ on`);
  });

  body.forEach((r, ri) => {
    const line = t.startLine + 2 + ri;
    r.forEach((cell, ci) => {
      const c = plain(cell);
      const where = ci === 0 ? "item name" : `"${items[ri]}" × "${dimensions[ci - 1] ?? ci}"`;
      if (c === "") problems.push(`line ${line}: empty cell (${where})`);
      else if (PLACEHOLDER_CELLS.includes(c.toLowerCase().replace(/\.$/, ""))) problems.push(`line ${line}: placeholder cell "${c}" (${where}); use a concrete phrase or "Not stated"`);
      else if (/<br\s*\/?>/i.test(c)) problems.push(`line ${line}: line break inside a cell (${where})`);
      else if (words(c).length > LIMITS.cellWords) problems.push(`line ${line}: cell has ${words(c).length} words, limit ${LIMITS.cellWords} (${where})`);
    });
  });

  if (body.length >= 2 && body.every((r) => r.length === width)) {
    dimensions.forEach((d, di) => {
      const vals = body.map((r) => plain(r[di + 1]).toLowerCase());
      if (vals.every((v) => v === vals[0]) && vals[0] !== "") problems.push(`dimension "${d}" gives every item the same answer; that belongs in the In common line`);
    });
  }

  // Everything outside the title and the table.
  const outside = nonBlank.filter((l) => l !== title && (l.line < t.startLine || l.line > t.endLine));
  const before = outside.filter((l) => l.line < t.startLine);
  for (const b of before) if (b !== nonBlank[0] || !title) problems.push(`line ${b.line}: text between the title and the table ("${b.text}")`);
  const after = outside.filter((l) => l.line > t.endLine);

  if (opts.tableOnly) {
    for (const a of after) problems.push(`line ${a.line}: text after the table in table-only mode ("${a.text}")`);
  } else {
    CLOSING.forEach((label, k) => {
      const a = after[k];
      const m = a?.text.match(new RegExp(`^\\*\\*${label}:\\*\\*\\s+(.+)$`));
      if (!a || !m) {
        problems.push(`missing closing line ${k + 1}: "**${label}:** {one sentence}"${a ? ` (found "${a.text}" on line ${a.line})` : ""}`);
        return;
      }
      const n = words(m[1]).length;
      if (n > LIMITS.closingWords) problems.push(`line ${a.line}: ${label} line has ${n} words, limit ${LIMITS.closingWords}`);
    });
    for (const a of after.slice(CLOSING.length)) problems.push(`line ${a.line}: commentary after the closing lines ("${a.text}")`);
  }

  return { ok: problems.length === 0, items, dimensions, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const tableOnly = args.includes("--table-only");
  const unknown = args.filter((a) => a.startsWith("--") && !["--json", "--table-only"].includes(a));
  if (unknown.length) {
    console.error(`unknown flag: ${unknown.join(", ")}`);
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
  const r = check(input, { tableOnly });
  if (json) console.log(JSON.stringify(r));
  else if (r.ok) console.log(`\x1b[32m✓\x1b[0m ${r.items.length} items × ${r.dimensions.length} dimensions, shape holds`);
  else for (const p of r.problems) console.log(`\x1b[31m✗\x1b[0m ${p}`);
  process.exit(r.ok ? 0 : 1);
}
