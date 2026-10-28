#!/usr/bin/env bun
/**
 * CheckReport.ts - Checks a saved Unify Harmonize report against the parts of
 * its output contract that code can judge.
 *
 * Usage:
 *   bun skills/Unify/Tools/CheckReport.ts <report.md> [--max-recs N] [--json]
 *
 * Checks (Intents/Harmonize.md § Output format and § Ideal State):
 *   - the eight parts appear in order: verdict, summit, inputs, harmony map,
 *     stragglers, unifying principle, recommendations, lens trail
 *   - every harmony-map row names a known relationship and has a non-empty
 *     "Evidence (both sides)" cell
 *   - every stragglers row starts with a path:line
 *   - recommendations number at most --max-recs (default 8, "about seven")
 *     and each names what it resolves, where it lands and its proof
 *
 * Whether a finding is real stays a human judgment (SKILL.md evals.manual).
 *
 * Exit codes: 0 pass, 1 contract broken, 2 usage or unreadable file.
 */

export const SECTIONS = [
  { key: "verdict", match: /verdict/i },
  { key: "summit", match: /summit/i },
  { key: "inputs", match: /inputs/i },
  { key: "harmony map", match: /harmony map/i },
  { key: "stragglers", match: /stragglers/i },
  { key: "unifying principle", match: /unifying principle/i },
  { key: "recommendations", match: /recommendations/i },
  { key: "lens trail", match: /lens trail/i },
] as const;

export const RELATIONSHIPS = [
  "reinforcing",
  "productive tension",
  "drift",
  "duplication",
  "straggler",
  "conflict",
  "gap",
];

const EMPTY_CELL = /^(|-+|—|–|n\/a|none|tbd)$/i;

export interface CheckResult {
  ok: boolean;
  problems: string[];
  recommendations: number;
  harmonyRows: number;
  stragglerRows: number;
}

/** A line that can open a section: a markdown heading, a bold lead, or a numbered bold lead. */
function headingText(line: string): string | null {
  const t = line.trim();
  const h = t.match(/^#{1,6}\s+(.*)$/);
  if (h) return h[1];
  const b = t.match(/^(?:\d+\.\s+)?\*\*(.+?)\*\*/);
  if (b) return b[1];
  return null;
}

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim().replace(/\*\*|`/g, "").trim());
}

/** Header cells plus data rows of the first markdown table in the given lines. */
function firstTable(lines: string[]): { header: string[]; rows: string[][] } | null {
  const start = lines.findIndex((l) => l.trim().startsWith("|"));
  if (start < 0) return null;
  const block: string[] = [];
  for (let i = start; i < lines.length && lines[i].trim().startsWith("|"); i++) block.push(lines[i]);
  if (block.length < 2) return null;
  const header = cells(block[0]).map((c) => c.toLowerCase());
  const rows = block.slice(1).filter((l) => !/^\|?\s*:?-{2,}/.test(l.trim())).map(cells);
  return { header, rows };
}

function col(header: string[], word: string): number {
  return header.findIndex((h) => h.includes(word));
}

export function checkReport(text: string, maxRecs = 8): CheckResult {
  const lines = text.split("\n");
  const problems: string[] = [];

  // Locate the eight sections in order.
  const starts: number[] = [];
  let from = 0;
  for (const s of SECTIONS) {
    let found = -1;
    for (let i = from; i < lines.length; i++) {
      const h = headingText(lines[i]);
      if (h && s.match.test(h)) {
        found = i;
        break;
      }
    }
    if (found < 0) {
      const anywhere = lines.findIndex((l) => {
        const h = headingText(l);
        return h !== null && s.match.test(h);
      });
      problems.push(
        anywhere >= 0
          ? `section "${s.key}" is out of order (line ${anywhere + 1})`
          : `section "${s.key}" is missing`,
      );
      starts.push(-1);
      continue;
    }
    starts.push(found);
    from = found + 1;
  }

  const body = (idx: number): string[] => {
    const s = starts[idx];
    if (s < 0) return [];
    const next = starts.slice(idx + 1).find((n) => n > s);
    return lines.slice(s + 1, next ?? lines.length);
  };

  // Harmony map: known relationship, non-empty both-sides evidence.
  let harmonyRows = 0;
  const harmony = firstTable(body(3));
  if (starts[3] >= 0) {
    if (!harmony) problems.push("harmony map has no table");
    else {
      const rel = col(harmony.header, "relationship");
      const ev = col(harmony.header, "evidence");
      if (rel < 0) problems.push("harmony map table has no Relationship column");
      if (ev < 0) problems.push("harmony map table has no Evidence column");
      harmonyRows = harmony.rows.length;
      harmony.rows.forEach((r, i) => {
        const n = i + 1;
        if (rel >= 0) {
          const v = (r[rel] ?? "").toLowerCase();
          if (!RELATIONSHIPS.some((k) => v.startsWith(k)))
            problems.push(`harmony map row ${n}: relationship "${r[rel] ?? ""}" is not one of ${RELATIONSHIPS.join(", ")}`);
        }
        if (ev >= 0 && EMPTY_CELL.test(r[ev] ?? "")) problems.push(`harmony map row ${n}: evidence (both sides) is empty`);
      });
    }
  }

  // Stragglers: each row opens on path:line. A section with no table is an honest "none found".
  let stragglerRows = 0;
  const stragglers = firstTable(body(4));
  if (stragglers) {
    stragglerRows = stragglers.rows.length;
    stragglers.rows.forEach((r, i) => {
      if (!/\S+:\d+/.test(r[0] ?? "")) problems.push(`stragglers row ${i + 1}: first cell "${r[0] ?? ""}" is not a path:line`);
    });
  }

  // Recommendations: count and placement cells.
  let recommendations = 0;
  const recs = firstTable(body(6));
  if (starts[6] >= 0) {
    if (!recs) problems.push("recommendations has no table");
    else {
      recommendations = recs.rows.length;
      if (recommendations > maxRecs) problems.push(`recommendations: ${recommendations} rows, more than ${maxRecs}`);
      for (const word of ["resolves", "lands", "proof"]) {
        const c = col(recs.header, word);
        if (c < 0) {
          problems.push(`recommendations table has no "${word}" column`);
          continue;
        }
        recs.rows.forEach((r, i) => {
          if (EMPTY_CELL.test(r[c] ?? "")) problems.push(`recommendations row ${i + 1}: "${recs.header[c]}" is empty`);
        });
      }
    }
  }

  return { ok: problems.length === 0, problems, recommendations, harmonyRows, stragglerRows };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log("Usage: bun skills/Unify/Tools/CheckReport.ts <report.md> [--max-recs N] [--json]");
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const mi = args.indexOf("--max-recs");
  const maxRecs = mi >= 0 ? Number(args[mi + 1]) : 8;
  if (!Number.isInteger(maxRecs) || maxRecs < 1) {
    console.error("\x1b[31m--max-recs needs a positive integer\x1b[0m");
    process.exit(2);
  }
  const path = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--max-recs");
  const file = path ? Bun.file(path) : null;
  if (!file || !(await file.exists())) {
    console.error(`\x1b[31mreport not found: ${path ?? "(none)"}\x1b[0m`);
    process.exit(2);
  }
  const result = checkReport(await file.text(), maxRecs);
  if (json) console.log(JSON.stringify(result));
  else if (result.ok)
    console.log(`\x1b[32mPASS\x1b[0m ${path}: 8 parts in order, ${result.harmonyRows} harmony rows, ${result.stragglerRows} stragglers, ${result.recommendations} recommendations`);
  else {
    console.log(`\x1b[31mFAIL\x1b[0m ${path}`);
    for (const p of result.problems) console.log(`  - ${p}`);
  }
  process.exit(result.ok ? 0 : 1);
}
