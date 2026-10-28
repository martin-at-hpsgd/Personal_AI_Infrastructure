#!/usr/bin/env bun
/**
 * CheckFormat — deterministic check of a StoryExplanation output against its intent's format contract.
 *
 *   bun skills/StoryExplanation/Tools/CheckFormat.ts --format <create|links|abridged|cse|cse5> [--lines N] [--words N] [--file <path>] [--json]
 *
 * Reads the output from --file or stdin. Exit 0 = conforms, 1 = violations (one per line), 2 = usage error.
 * The cliche list is read from the embedded prompt in Intents/Cse.md, its one home, never restated here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Format = "create" | "links" | "abridged" | "cse" | "cse5";
export const FORMATS: Format[] = ["create", "links", "abridged", "cse", "cse5"];

export interface CheckOptions {
  lines?: number; // cse: line count (default 8); links: sentence count (default: the header's N)
  words?: number; // cse: exact words per line (default 8-16 flexible)
  cliches?: string[]; // default: the list in Intents/Cse.md
}

const SKILL_DIR = join(import.meta.dir, "..");
const CSE_HEADER = "📖 STORY EXPLANATION:";
const LINKS_HEADER = /^## 📖 STORY EXPLANATION \((\d+) ITEMS\)$/;
const BULLET = /^\s*[-*•+]\s/;
const NUMBERED = /^\s*\d+[.)]\s/;
const LABEL = /^\s*\**(Opening|Body|Closing)\**\s*:/i;
const LINK = /\[[^\]]+\]\([^)]+\)/g;

export function loadCliches(cseIntentPath = join(SKILL_DIR, "Intents", "Cse.md")): string[] {
  const text = readFileSync(cseIntentPath, "utf8");
  const start = text.indexOf("**Avoid all cliche phrases");
  if (start < 0) throw new Error(`no cliche list found in ${cseIntentPath}`);
  const out: string[] = [];
  for (const line of text.slice(start).split("\n").slice(1)) {
    if (line.startsWith("#")) break;
    if (!line.startsWith("- ")) continue;
    for (const m of line.matchAll(/"([^"]+)"/g)) out.push(m[1].toLowerCase());
  }
  if (out.length === 0) throw new Error(`empty cliche list in ${cseIntentPath}`);
  return out;
}

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const nonBlank = (text: string) => text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");

function checkCliches(text: string, cliches: string[], v: string[]) {
  const lower = text.toLowerCase();
  for (const c of cliches) {
    const re = new RegExp(`(^|[^a-z])${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`);
    if (re.test(lower)) v.push(`cliche: "${c}"`);
  }
}

function checkSentenceLine(line: string, n: number, v: string[]) {
  if (BULLET.test(line)) v.push(`line ${n}: bullet marker`);
  if (!/[.]["')\]]?$/.test(line.trim())) v.push(`line ${n}: does not end with a period`);
}

function checkNumbered(lines: string[], expected: number, v: string[], words?: { exact?: number; min?: number; max?: number }) {
  if (lines.length !== expected) v.push(`expected ${expected} numbered lines, found ${lines.length}`);
  lines.forEach((line, i) => {
    const m = line.match(/^(\d+)\.\s+(.*)$/);
    if (!m) {
      v.push(`line ${i + 1}: not numbered "N. text"`);
      return;
    }
    if (Number(m[1]) !== i + 1) v.push(`line ${i + 1}: numbered ${m[1]}, expected ${i + 1}`);
    checkSentenceLine(m[2], i + 1, v);
    const wc = wordCount(m[2]);
    if (words?.exact !== undefined && wc !== words.exact) v.push(`line ${i + 1}: ${wc} words, expected exactly ${words.exact}`);
    if (words?.min !== undefined && wc < words.min) v.push(`line ${i + 1}: ${wc} words, under ${words.min}`);
    if (words?.max !== undefined && wc > words.max) v.push(`line ${i + 1}: ${wc} words, over ${words.max}`);
  });
}

export function checkFormat(format: Format, text: string, opts: CheckOptions = {}): string[] {
  const v: string[] = [];
  const cliches = opts.cliches ?? loadCliches();
  const lines = nonBlank(text);
  if (lines.length === 0) return ["empty output"];

  switch (format) {
    case "create": {
      // Intents/Create.md: Opening 15-25 words, Body 5-15 sentences, Closing 15-25 words; no headers, labels or bullets.
      lines.forEach((l, i) => {
        if (/^#/.test(l)) v.push(`line ${i + 1}: section header`);
        if (LABEL.test(l)) v.push(`line ${i + 1}: section label`);
        if (NUMBERED.test(l)) v.push(`line ${i + 1}: numbered line`);
        checkSentenceLine(l, i + 1, v);
      });
      if (lines.length < 7 || lines.length > 17) v.push(`expected 7-17 sentence lines (opening, 5-15 body, closing), found ${lines.length}`);
      const open = wordCount(lines[0]);
      const close = wordCount(lines[lines.length - 1]);
      if (open < 15 || open > 25) v.push(`opening: ${open} words, expected 15-25`);
      if (close < 15 || close > 25) v.push(`closing: ${close} words, expected 15-25`);
      break;
    }
    case "abridged": {
      // Intents/CreateAbridged.md: exactly 5 lines of 5-12 words, period-ended, no bullets or numbers.
      if (lines.length !== 5) v.push(`expected exactly 5 lines, found ${lines.length}`);
      lines.forEach((l, i) => {
        if (NUMBERED.test(l)) v.push(`line ${i + 1}: numbered line`);
        checkSentenceLine(l, i + 1, v);
        const wc = wordCount(l);
        if (wc < 5 || wc > 12) v.push(`line ${i + 1}: ${wc} words, expected 5-12`);
      });
      break;
    }
    case "cse": {
      // Intents/Cse.md: the header, then exactly N numbered lines; 8-16 words each, or exactly --words.
      const n = opts.lines ?? 8;
      if (n < 3 || n > 50) return [`--lines ${n} outside 3-50`];
      if (lines[0].trim() !== CSE_HEADER) v.push(`first line must be "${CSE_HEADER}"`);
      const body = lines[0].trim() === CSE_HEADER ? lines.slice(1) : lines;
      checkNumbered(body, n, v, opts.words !== undefined ? { exact: opts.words } : { min: 8, max: 16 });
      break;
    }
    case "cse5": {
      // Intents/Cse5.md: exactly 5 numbered lines, one sentence each; a CSE header is tolerated.
      const body = lines[0].trim() === CSE_HEADER ? lines.slice(1) : lines;
      checkNumbered(body, 5, v);
      break;
    }
    case "links": {
      // Intents/CreateWithLinks.md: the N-items header, N sentence lines with links after the period, Primary Sources list.
      const h = lines[0].trim().match(LINKS_HEADER);
      if (!h) v.push(`first line must be "## 📖 STORY EXPLANATION (N ITEMS)"`);
      const end = lines.findIndex((l) => l.trim() === "---" || /^\*\*Primary Sources:?\*\*/.test(l.trim()));
      if (!lines.some((l) => /^\*\*Primary Sources:?\*\*/.test(l.trim()))) v.push("missing **Primary Sources:** list");
      const sentences = lines.slice(h ? 1 : 0, end < 0 ? lines.length : end);
      const n = opts.lines ?? (h ? Number(h[1]) : 25);
      if (h && Number(h[1]) !== sentences.length) v.push(`header says ${h[1]} items, found ${sentences.length} sentence lines`);
      if (sentences.length !== n) v.push(`expected ${n} sentences, found ${sentences.length}`);
      sentences.forEach((l, i) => {
        if (NUMBERED.test(l)) v.push(`sentence ${i + 1}: numbered line`);
        const prose = l.replace(LINK, "").replace(/[\s|]+$/, "");
        checkSentenceLine(prose, i + 1, v);
        if (/\[[^\]]+\]\([^)]+\)/.test(l) && !/\.\s*\[/.test(l)) v.push(`sentence ${i + 1}: links must follow the period`);
      });
      if (sentences.length > 0) {
        const open = wordCount(sentences[0].replace(LINK, "").replace(/\|/g, ""));
        const close = wordCount(sentences[sentences.length - 1].replace(LINK, "").replace(/\|/g, ""));
        if (open < 15 || open > 25) v.push(`opening: ${open} words, expected 15-25`);
        if (close < 15 || close > 25) v.push(`closing: ${close} words, expected 15-25`);
      }
      break;
    }
  }
  checkCliches(text, cliches, v);
  return v;
}

function usage(msg: string): never {
  console.error(`${msg}\nusage: CheckFormat.ts --format <${FORMATS.join("|")}> [--lines N] [--words N] [--file <path>] [--json]`);
  process.exit(2);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (args.includes("--help") || args.includes("-h")) usage("Checks a StoryExplanation output against its format contract.");
  const format = get("--format") as Format | undefined;
  if (!format || !FORMATS.includes(format)) usage(`--format must be one of ${FORMATS.join(", ")}`);
  const num = (flag: string) => {
    const raw = get(flag);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) usage(`${flag} must be a positive integer`);
    return n;
  };
  const file = get("--file");
  const text = file ? readFileSync(file, "utf8") : await Bun.stdin.text();
  const violations = checkFormat(format, text, { lines: num("--lines"), words: num("--words") });
  if (args.includes("--json")) console.log(JSON.stringify({ format, ok: violations.length === 0, violations }));
  else if (violations.length === 0) console.log(`ok: ${format} format`);
  else for (const x of violations) console.log(x);
  process.exit(violations.length === 0 ? 0 : 1);
}
