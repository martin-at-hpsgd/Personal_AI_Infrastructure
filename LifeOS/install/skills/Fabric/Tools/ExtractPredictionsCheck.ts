#!/usr/bin/env bun
// ExtractPredictionsCheck — checks an ExtractPredictions output against the
// parts of its contract code can judge: one "# Predictions:" title, then
// either the single no-predictions line or a bulleted list of 3-16-word
// predictions followed by the four-column table, one row per bullet in the
// same order, each Prediction cell repeating its bullet, no placeholder
// cells, and no bold or italics. Whether a line is really a prediction, and
// whether its confidence and date are the ones given, stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `ExtractPredictionsCheck — shape check for a Fabric ExtractPredictions output

  bun skills/Fabric/Tools/ExtractPredictionsCheck.ts <file|-> [--json]

  --json  print {ok, predictions, none, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const COLUMNS = ["Prediction", "Confidence", "Date", "How to Verify"] as const;
export const MAX_WORDS = 16;
const PLACEHOLDER = /^(n\/?a|-+|—|–|tbd|unknown|none|\?+|null)$/i;

export type Prediction = { text: string; confidence?: string; date?: string; verify?: string; line: number };

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

export function norm(text: string): string {
  return text.trim().replace(/\s+/g, " ").replace(/[.;]+$/, "").toLowerCase();
}

export function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

function emphasis(line: string): boolean {
  if (/\*\*|__/.test(line)) return true;
  if (/(^|[\s(|])\*[^\s*][^*\n]*?\*(?=$|[\s).,;:!?|])/.test(line)) return true;
  if (/(^|[\s(|])_[^\s_][^_\n]*?_(?=$|[\s).,;:!?|])/.test(line)) return true;
  return false;
}

export function check(input: string): { ok: boolean; predictions: Prediction[]; none: boolean; problems: string[] } {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const predictions: Prediction[] = [];
  const rows = lines.map((text, i) => ({ text: text.replace(/\s+$/, ""), line: i + 1 })).filter((r) => r.text.trim() !== "");

  if (rows.length === 0) return { ok: false, predictions, none: false, problems: ["the output is empty"] };

  for (const r of rows) if (emphasis(r.text)) problems.push(`line ${r.line}: bold or italics ("${r.text.trim().slice(0, 60)}"); the output is plain Markdown`);

  // Title.
  const [title, ...rest] = rows;
  if (!/^#\s+Predictions:\s+\S/.test(title.text)) problems.push(`line ${title.line}: the output opens on a "# Predictions: " title naming the source and the read`);
  for (const r of rest) if (/^#{1,6}\s/.test(r.text)) problems.push(`line ${r.line}: heading beyond the title ("${r.text.trim()}")`);

  // No-predictions form.
  const sentinel = rest.find((r) => /^No predictions found\b/i.test(r.text.trim()));
  if (sentinel) {
    if (rest.length !== 1) problems.push(`the no-predictions form is the title and the single line "No predictions found in …"; found ${rest.length} lines after the title`);
    if (!/^No predictions found in\s+\S/.test(sentinel.text.trim())) problems.push(`line ${sentinel.line}: the line reads "No predictions found in {the source}."`);
    return { ok: problems.length === 0, predictions, none: true, problems };
  }

  // Bullets, then the table, nothing else.
  const bullets: { text: string; line: number }[] = [];
  const table: { text: string; line: number }[] = [];
  for (const r of rest) {
    if (/^#{1,6}\s/.test(r.text)) continue;
    const isRow = /^\s*\|/.test(r.text);
    const b = r.text.match(/^([-*+])\s+(.*\S)\s*$/);
    if (isRow) { table.push(r); continue; }
    if (/^\s+[-*+]\s/.test(r.text)) { problems.push(`line ${r.line}: nested bullet; each prediction is one top-level bullet`); continue; }
    if (/^\s*\d+[.)]\s/.test(r.text)) { problems.push(`line ${r.line}: numbered list; predictions are a bulleted list ("- ")`); continue; }
    if (b) {
      if (table.length) problems.push(`line ${r.line}: bullet after the table; the list comes first`);
      else bullets.push({ text: b[2], line: r.line });
      continue;
    }
    problems.push(`line ${r.line}: text outside the title, list and table ("${r.text.trim().slice(0, 60)}")`);
  }

  if (bullets.length === 0) problems.push('no prediction bullets found (or use the single line "No predictions found in …")');
  const seen = new Set<string>();
  for (const b of bullets) {
    const n = words(b.text).length;
    if (n > MAX_WORDS) problems.push(`line ${b.line}: bullet has ${n} words; at most ${MAX_WORDS}`);
    if (n < 3) problems.push(`line ${b.line}: bullet is not a prediction ("${b.text}")`);
    const k = norm(b.text);
    if (seen.has(k)) problems.push(`line ${b.line}: duplicate prediction ("${b.text.slice(0, 60)}")`);
    seen.add(k);
  }

  // Table.
  if (table.length === 0) {
    problems.push(`no table; under the list goes | ${COLUMNS.join(" | ")} |`);
  } else {
    const [head, sep, ...data] = table;
    const h = cells(head.text);
    if (h.join("|").toLowerCase() !== COLUMNS.join("|").toLowerCase()) problems.push(`line ${head.line}: table header must be exactly | ${COLUMNS.join(" | ")} |; found | ${h.join(" | ")} |`);
    if (!sep || !cells(sep.text).every((c) => /^:?-{3,}:?$/.test(c)) || cells(sep.text).length !== COLUMNS.length) {
      problems.push(`line ${sep?.line ?? head.line}: the header is followed by a ${COLUMNS.length}-column separator row (|---|---|---|---|)`);
    }
    for (let i = 1; i < table.length; i++) if (table[i].line !== table[i - 1].line + 1) problems.push(`line ${table[i].line}: the table is broken by a blank line or other text`);
    if (data.length !== bullets.length) problems.push(`table has ${data.length} rows for ${bullets.length} bullets; one row per bullet`);
    data.forEach((r, i) => {
      const c = cells(r.text);
      if (c.length !== COLUMNS.length) { problems.push(`line ${r.line}: row has ${c.length} cells; expected ${COLUMNS.length} (escape a pipe inside a cell as \\|)`); return; }
      const [text, confidence, date, verify] = c;
      predictions.push({ text, confidence, date, verify, line: r.line });
      const b = bullets[i];
      if (b && norm(text) !== norm(b.text)) problems.push(`line ${r.line}: row ${i + 1} Prediction cell does not repeat bullet ${i + 1} ("${text.slice(0, 50)}" vs "${b.text.slice(0, 50)}")`);
      COLUMNS.forEach((name, j) => { if (!c[j]) problems.push(`line ${r.line}: row ${i + 1} ${name} is empty`); });
      if (confidence && PLACEHOLDER.test(confidence)) problems.push(`line ${r.line}: row ${i + 1} Confidence is "${confidence}"; write Not stated when none was given`);
      if (date && PLACEHOLDER.test(date)) problems.push(`line ${r.line}: row ${i + 1} Date is "${date}"; write No date given when none was given`);
      if (verify && words(verify).length < 4) problems.push(`line ${r.line}: row ${i + 1} How to Verify names no observation ("${verify}"); at least four words`);
    });
  }

  return { ok: problems.length === 0, predictions, none: false, problems };
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
    console.error(`unknown flag: ${unknown.join(" ")}`);
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
  if (json) console.log(JSON.stringify({ ok: r.ok, predictions: r.predictions.map(({ text, confidence, date }) => ({ text, confidence, date })), none: r.none, problems: r.problems }));
  else if (r.ok) console.log(r.none ? "✓ no predictions, shape holds" : `✓ ${r.predictions.length} predictions, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
