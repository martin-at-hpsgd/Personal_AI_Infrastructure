#!/usr/bin/env bun
// AnalyzePaperCheck — checks an AnalyzePaper output against the parts of its
// contract code can judge, per mode. Full mode: a "# Paper Analysis: …" title,
// an optional "Source:" line, then the eleven sections in order, the nine
// labeled STUDY QUALITY items, a conflict rating from the fixed scale, three
// 1–10 scores whose chart bars put each score at its exact cell, a letter
// grade that does not contradict the rigor score or the conflict rating, and
// a summary statement with five short bullets. Summary mode: exactly the seven
// summarize_paper headers in order, each with a body. Brief mode: exactly the
// eight labeled bullets with their word caps and an n/5 reproducibility score.
// Whether each item is faithful, specific and fairly graded stays a judged
// check in the fabric-analyzepaper suite.

import { readFileSync } from "node:fs";
import { words } from "./WordSummaryCheck.ts";

const HELP = `AnalyzePaperCheck — shape check for a Fabric AnalyzePaper output

  bun skills/Fabric/Tools/AnalyzePaperCheck.ts <file|-> [--mode full|summary|brief] [--json]

  --mode  full (default), summary, or brief
  --json  print {ok, mode, scores, grade, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export type Mode = "full" | "summary" | "brief";

export const FULL_SECTIONS = [
  "SUMMARY",
  "AUTHORS",
  "AUTHOR ORGANIZATIONS",
  "FINDINGS",
  "STUDY OVERVIEW",
  "STUDY QUALITY",
  "CONFLICTS OF INTEREST",
  "RESEARCHER'S INTERPRETATION",
  "PAPER QUALITY",
  "FINAL GRADE",
  "SUMMARY STATEMENT",
] as const;

export const QUALITY_ITEMS = [
  "Study design",
  "Sample size",
  "Confidence intervals",
  "P-values",
  "Effect size",
  "Consistency of results",
  "Methodology transparency",
  "Reproducibility",
  "Data analysis method",
] as const;

export const COI_RATINGS = ["NONE DETECTED", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

export const SUMMARY_HEADERS = [
  "Title and Authors",
  "Main Goal and Fundamental Concept",
  "Technical Approach",
  "Distinctive Features",
  "Experimental Setup and Results",
  "Advantages and Limitations",
  "Conclusion",
] as const;

/** Brief-mode labels and the word cap on the text after each label (null: no cap). */
export const BRIEF_LABELS: readonly { label: string; max: number | null }[] = [
  { label: "TITLE", max: null },
  { label: "SUMMARY", max: 20 },
  { label: "IMPLICATIONS", max: 40 },
  { label: "RECOMMENDATION", max: 40 },
  { label: "AUTHORS", max: 40 },
  { label: "METHODOLOGY", max: 40 },
  { label: "CONFLICT/BIAS", max: 40 },
  { label: "REPRODUCIBILITY", max: 25 },
];

const CHART_ROWS = [
  { left: "Known", right: "Novel", score: "Novelty" },
  { left: "Weak", right: "Rigorous", score: "Rigor" },
  { left: "Theoretical", right: "Empirical", score: "Empiricism" },
] as const;

const DASH = "[—–-]";
// Bold (**x**, __x__) and single-delimiter italics. Backtick code spans are allowed.
const EMPHASIS = [/\*\*/, /__/, /(^|[\s(])\*[^\s*][^*\n]*\*(?=$|[\s).,;:!?])/, /(^|[\s(])_[^\s_][^_\n]*_(?=$|[\s).,;:!?])/];

type BodyLine = { line: number; text: string; fenced: boolean };
type Section = { name: string; line: number; body: BodyLine[] };

export type Result = {
  ok: boolean;
  mode: Mode;
  scores: Record<string, number>;
  grade: string | null;
  problems: string[];
};

const norm = (s: string) => s.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().toUpperCase();

/** Sentences of at least three words, so "U.S." or "et al." never reads as its own sentence. */
export function sentenceCount(text: string): number {
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/);
  let count = 0;
  let carry = "";
  for (const p of parts) {
    const piece = (carry + " " + p).trim();
    if (words(piece).length < 3 || /\b(al|e\.g|i\.e|vs|Fig|Dr|Mr|Ms|No)\.$/.test(piece)) carry = piece;
    else {
      count++;
      carry = "";
    }
  }
  return count + (carry && count === 0 ? 1 : 0);
}

/** The bar a score of n (1..10) draws: n-1 dashes, the number, 10-n dashes. */
export function expectedBar(n: number): string {
  return "-".repeat(n - 1) + String(n) + "-".repeat(10 - n);
}

function splitSections(lines: string[], problems: string[], opts: { allowFence: boolean; headingLevel: 2 }): {
  pre: BodyLine[];
  sections: Section[];
} {
  const pre: BodyLine[] = [];
  const sections: Section[] = [];
  let inFence = false;
  lines.forEach((raw, i) => {
    const n = i + 1;
    const text = raw.trim();
    if (/^```/.test(text)) {
      if (!opts.allowFence) problems.push(`line ${n}: code fence not allowed in this mode`);
      inFence = !inFence;
      (sections.length ? sections[sections.length - 1].body : pre).push({ line: n, text: raw, fenced: true });
      return;
    }
    if (text === "") return;
    if (!inFence) {
      const h = text.match(/^##\s+(.+?)\s*$/);
      if (h) {
        sections.push({ name: h[1], line: n, body: [] });
        return;
      }
    }
    (sections.length ? sections[sections.length - 1].body : pre).push({ line: n, text: raw, fenced: inFence });
  });
  if (inFence) problems.push("a code fence is opened and never closed");
  return { pre, sections };
}

function emphasisAndLists(lines: string[], problems: string[]): void {
  let inFence = false;
  lines.forEach((raw, i) => {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence || raw.trim() === "") return;
    if (EMPHASIS.some((re) => re.test(raw))) problems.push(`line ${i + 1}: bold or italics ("${raw.trim()}")`);
    if (/^\s*\d+[.)]\s+\S/.test(raw)) problems.push(`line ${i + 1}: numbered list item; use "- " bullets ("${raw.trim()}")`);
  });
}

function items(s: Section, problems: string[]): string[] {
  const out: string[] = [];
  for (const b of s.body) {
    if (b.fenced) continue;
    if (/^\s+\S/.test(b.text)) {
      problems.push(`line ${b.line}: sub-bullet or indented line in ${norm(s.name)}`);
      continue;
    }
    const m = b.text.match(/^-\s+(\S.*)$/);
    if (!m) {
      problems.push(`line ${b.line}: ${norm(s.name)} holds only "- " items ("${b.text.trim()}")`);
      continue;
    }
    out.push(m[1].trim());
  }
  return out;
}

function plainLines(s: Section): BodyLine[] {
  return s.body.filter((b) => !b.fenced);
}

function sentence(s: Section, maxWords: number, problems: string[]): void {
  const body = plainLines(s);
  const name = norm(s.name);
  if (body.length !== 1) {
    problems.push(`line ${s.line}: ${name} must be exactly one line, found ${body.length}`);
    if (body.length === 0) return;
  }
  const line = body[0].text.trim();
  if (/^[-*+]\s|^\d+[.)]\s/.test(line)) problems.push(`line ${body[0].line}: ${name} is a sentence, not a list item`);
  const wc = words(line).length;
  if (wc > maxWords) problems.push(`line ${body[0].line}: ${name} has ${wc} words (max ${maxWords})`);
  const sc = sentenceCount(line);
  if (sc > 1) problems.push(`line ${body[0].line}: ${name} has ${sc} sentences (one allowed)`);
}

function capItems(name: string, list: string[], min: number, max: number, maxWords: number, line: number, problems: string[]): void {
  if (list.length < min || list.length > max)
    problems.push(`line ${line}: ${name} has ${list.length} items (${min === max ? `exactly ${min}` : `${min} to ${max}`})`);
  list.forEach((it, i) => {
    const wc = words(it).length;
    if (wc > maxWords) problems.push(`line ${line}: ${name} item ${i + 1} has ${wc} words (max ${maxWords})`);
  });
  const seen = new Set<string>();
  for (const it of list) {
    const k = it.toLowerCase();
    if (seen.has(k)) problems.push(`line ${line}: ${name} repeats an item ("${it}")`);
    seen.add(k);
  }
}

function checkFull(lines: string[], problems: string[]): { scores: Record<string, number>; grade: string | null } {
  emphasisAndLists(lines, problems);
  const { pre, sections } = splitSections(lines, problems, { allowFence: true, headingLevel: 2 });
  const scores: Record<string, number> = {};
  let grade: string | null = null;
  let coi: string | null = null;

  const preText = pre.filter((b) => !b.fenced);
  if (pre.some((b) => b.fenced)) problems.push("a code fence before the first section");
  if (preText.length === 0 || !/^#\s+Paper Analysis:\s*\S/i.test(preText[0].text.trim()))
    problems.push('missing title line (expected "# Paper Analysis: <title>" first)');
  for (const b of preText.slice(1)) {
    if (/^Source:\s*\S/i.test(b.text.trim()) && b === preText[1]) continue;
    problems.push(`line ${b.line}: text before the first section ("${b.text.trim()}")`);
  }

  const names = sections.map((s) => norm(s.name));
  if (names.join("|") !== FULL_SECTIONS.join("|"))
    problems.push(`sections must be ${FULL_SECTIONS.join(", ")} in that order; found ${names.length ? names.join(", ") : "none"}`);

  for (const s of sections) {
    const name = norm(s.name);
    if (name !== "PAPER QUALITY" && s.body.some((b) => b.fenced)) problems.push(`line ${s.line}: code fence in ${name}; only the PAPER QUALITY chart is fenced`);
    switch (name) {
      case "SUMMARY":
        sentence(s, 25, problems);
        break;
      case "RESEARCHER'S INTERPRETATION":
        sentence(s, 30, problems);
        break;
      case "AUTHORS":
      case "AUTHOR ORGANIZATIONS":
        capItems(name, items(s, problems), 1, 60, 40, s.line, problems);
        break;
      case "FINDINGS":
        capItems(name, items(s, problems), 1, 10, 30, s.line, problems);
        break;
      case "STUDY OVERVIEW":
        capItems(name, items(s, problems), 1, 10, 35, s.line, problems);
        break;
      case "STUDY QUALITY": {
        const list = items(s, problems);
        if (list.length !== QUALITY_ITEMS.length) problems.push(`line ${s.line}: STUDY QUALITY has ${list.length} items (exactly ${QUALITY_ITEMS.length})`);
        QUALITY_ITEMS.forEach((label, i) => {
          const it = list[i];
          if (it === undefined) return;
          const m = it.match(/^([^:]+):\s*(.*)$/);
          const got = m ? m[1].trim().toLowerCase().replace(/^p-value$/, "p-values") : "";
          if (got !== label.toLowerCase()) problems.push(`line ${s.line}: STUDY QUALITY item ${i + 1} must open "${label}:" ("${it}")`);
          else if (!m![2].trim()) problems.push(`line ${s.line}: STUDY QUALITY "${label}" is empty`);
          else if (words(m![2]).length > 40) problems.push(`line ${s.line}: STUDY QUALITY "${label}" has ${words(m![2]).length} words (max 40)`);
        });
        break;
      }
      case "CONFLICTS OF INTEREST": {
        const body = plainLines(s);
        if (body.length !== 1) problems.push(`line ${s.line}: CONFLICTS OF INTEREST must be one line, found ${body.length}`);
        const first = body[0]?.text.trim() ?? "";
        const m = first.match(new RegExp(`^(${COI_RATINGS.join("|")})\\s+${DASH}\\s+\\S`));
        if (!m) problems.push(`line ${s.line}: CONFLICTS OF INTEREST must open on ${COI_RATINGS.join(", ")} then " — " and the reason ("${first}")`);
        else coi = m[1];
        break;
      }
      case "PAPER QUALITY": {
        const list = items(s, problems);
        if (list.length !== 3) problems.push(`line ${s.line}: PAPER QUALITY has ${list.length} scored items (exactly 3)`);
        CHART_ROWS.forEach((row, i) => {
          const it = list[i];
          if (it === undefined) return;
          const m = it.match(new RegExp(`^${row.score}:\\s*(\\d+)\\s*/\\s*10\\s+${DASH}\\s+\\S`));
          if (!m) {
            problems.push(`line ${s.line}: PAPER QUALITY item ${i + 1} must be "${row.score}: n/10 — reason" ("${it}")`);
            return;
          }
          const n = Number(m[1]);
          if (n < 1 || n > 10) problems.push(`line ${s.line}: ${row.score} score ${n} is outside 1 to 10`);
          else scores[row.score] = n;
        });
        const chart = s.body.filter((b) => b.fenced && !/^\s*```/.test(b.text.trim()) && b.text.trim() !== "");
        if (chart.length !== 3) problems.push(`line ${s.line}: the rating chart must be three fenced lines, found ${chart.length}`);
        CHART_ROWS.forEach((row, i) => {
          const c = chart[i];
          if (!c) return;
          const m = c.text.trim().match(/^(\S+)\s+\[([^\]]*)\]\s+(\S+)$/);
          if (!m || m[1] !== row.left || m[3] !== row.right) {
            problems.push(`line ${c.line}: chart row ${i + 1} must read "${row.left}  [bar]  ${row.right}" ("${c.text.trim()}")`);
            return;
          }
          const n = scores[row.score];
          if (n === undefined) return;
          const want = expectedBar(n);
          if (m[2] !== want) problems.push(`line ${c.line}: chart ${row.left}/${row.right} bar is [${m[2]}]; a ${row.score} of ${n} draws [${want}]`);
        });
        break;
      }
      case "FINAL GRADE": {
        const body = plainLines(s).map((b) => b.text.trim());
        if (body.length !== 2) problems.push(`line ${s.line}: FINAL GRADE must be two lines (the grade, then its reason), found ${body.length}`);
        const g = (body[0] ?? "").replace("−", "-");
        if (!/^[ABCDF][+-]?$/.test(g)) problems.push(`line ${s.line}: FINAL GRADE first line must be a letter A to F, optionally with + or - ("${body[0] ?? ""}")`);
        else grade = g;
        if (body[1] !== undefined) {
          const wc = words(body[1]).length;
          if (wc > 30) problems.push(`line ${s.line}: FINAL GRADE reason has ${wc} words (max 30)`);
          if (/^[-*+]\s/.test(body[1])) problems.push(`line ${s.line}: FINAL GRADE reason is a sentence, not a list item`);
        }
        break;
      }
      case "SUMMARY STATEMENT": {
        const body = plainLines(s);
        const head = body[0];
        if (!head || /^-\s/.test(head.text.trim())) problems.push(`line ${s.line}: SUMMARY STATEMENT must open on one sentence before its bullets`);
        else {
          const wc = words(head.text).length;
          if (wc > 35) problems.push(`line ${head.line}: SUMMARY STATEMENT sentence has ${wc} words (max 35)`);
        }
        const rest: Section = { name: s.name, line: s.line, body: head && !/^-\s/.test(head.text.trim()) ? body.slice(1) : body };
        capItems("SUMMARY STATEMENT", items(rest, problems), 5, 5, 15, s.line, problems);
        break;
      }
    }
  }

  if (grade && grade.startsWith("A")) {
    if (scores.Rigor !== undefined && scores.Rigor < 7) problems.push(`grade ${grade} contradicts a Rigor score of ${scores.Rigor}/10 (an A needs rigor of 7 or more)`);
    if (coi && !["NONE DETECTED", "LOW"].includes(coi)) problems.push(`grade ${grade} contradicts a ${coi} conflict of interest (an A needs none or low)`);
  }
  return { scores, grade };
}

function checkSummary(lines: string[], problems: string[]): void {
  const trimmed = lines.map((l) => l.trim()).filter((l) => l !== "");
  if (trimmed.length && /^```/.test(trimmed[0])) problems.push("output is wrapped in a code fence; emit the content only");
  const { pre, sections } = splitSections(lines, problems, { allowFence: true, headingLevel: 2 });
  for (const b of pre) if (!b.fenced) problems.push(`line ${b.line}: text before the first header ("${b.text.trim()}")`);
  const names = sections.map((s) => norm(s.name).replace(/&/g, "AND").replace(/^\d+[.)]\s*/, ""));
  const want = SUMMARY_HEADERS.map((h) => h.toUpperCase());
  if (names.join("|") !== want.join("|"))
    problems.push(`headers must be ${SUMMARY_HEADERS.join(", ")} in that order; found ${names.length ? sections.map((s) => s.name).join(", ") : "none"}`);
  for (const s of sections) {
    for (const b of s.body) if (!b.fenced && /^#{1,6}\s/.test(b.text.trim())) problems.push(`line ${b.line}: extra header ("${b.text.trim()}"); only the seven are allowed`);
    if (!s.body.some((b) => !b.fenced && b.text.trim() !== "")) problems.push(`line ${s.line}: "${s.name}" has no content`);
  }
}

function checkBrief(lines: string[], problems: string[]): void {
  emphasisAndLists(lines, problems);
  const body = lines.map((raw, i) => ({ line: i + 1, text: raw.trim() })).filter((b) => b.text !== "");
  if (body.length && /^```/.test(body[0].text)) problems.push("output is wrapped in a code fence; emit the content only");
  if (body.length !== BRIEF_LABELS.length) problems.push(`brief mode is exactly ${BRIEF_LABELS.length} labeled bullets, found ${body.length} lines`);
  BRIEF_LABELS.forEach(({ label, max }, i) => {
    const b = body[i];
    if (!b) return;
    const m = b.text.match(/^-\s+([A-Z/]+):\s+(\S.*)$/);
    if (!m || m[1] !== label) {
      problems.push(`line ${b.line}: bullet ${i + 1} must be "- ${label}: …" ("${b.text}")`);
      return;
    }
    const text = m[2];
    if (label === "REPRODUCIBILITY") {
      const r = text.match(new RegExp(`^([1-5])/5\\s+${DASH}\\s+(\\S.*)$`));
      if (!r) problems.push(`line ${b.line}: REPRODUCIBILITY must be "n/5 — reason" with n from 1 to 5 ("${text}")`);
      else if (words(r[2]).length > 20) problems.push(`line ${b.line}: REPRODUCIBILITY reason has ${words(r[2]).length} words (max 20)`);
      return;
    }
    if (max !== null && words(text).length > max) problems.push(`line ${b.line}: ${label} has ${words(text).length} words (max ${max})`);
  });
}

export function check(input: string, mode: Mode = "full"): Result {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  let scores: Record<string, number> = {};
  let grade: string | null = null;
  if (mode === "full") {
    const first = lines.find((l) => l.trim() !== "");
    if (first && /^\s*```/.test(first)) problems.push("output is wrapped in a code fence; emit the content only");
    ({ scores, grade } = checkFull(lines, problems));
  } else if (mode === "summary") checkSummary(lines, problems);
  else checkBrief(lines, problems);
  return { ok: problems.length === 0, mode, scores, grade, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const mi = args.indexOf("--mode");
  let mode: Mode = "full";
  if (mi >= 0) {
    const v = args[mi + 1];
    if (v !== "full" && v !== "summary" && v !== "brief") {
      console.error(`--mode must be full, summary or brief\n\n${HELP}`);
      process.exit(2);
    }
    mode = v;
  }
  const unknown = args.filter((a, i) => a.startsWith("--") && a !== "--json" && a !== "--mode" && !(mi >= 0 && i === mi + 1));
  if (unknown.length) {
    console.error(`unknown flag ${unknown[0]}\n\n${HELP}`);
    process.exit(2);
  }
  const src = args.find((a, i) => (!a.startsWith("--") || a === "-") && !(mi >= 0 && i === mi + 1));
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input, mode);
  if (json) console.log(JSON.stringify(r));
  else if (r.ok) console.log(`✓ ${mode} mode: shape holds${r.grade ? `, grade ${r.grade}` : ""}`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
