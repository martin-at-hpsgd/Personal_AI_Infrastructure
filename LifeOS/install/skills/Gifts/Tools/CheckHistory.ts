#!/usr/bin/env bun
/**
 * CheckHistory — mechanical checks on one saved Gifts run file.
 *
 * Usage: bun skills/Gifts/Tools/CheckHistory.ts <History/<id>-<YYYY-MM-DD>[-N].md> [--json]
 *
 * Checks the parts of a FindGifts run that code can judge; the taste call stays manual:
 *   - count:  8–12 ranked ideas (numbered `N. **Name**` items, wildcard included)
 *   - tag:    each idea's product URL (the first URL in its block) carries `[verified…]` or `[unverified…]` on its line
 *   - repeat: no idea name (normalized) matches an idea in an earlier History file for the same id,
 *             read from the same directory as the checked file; a second run on one day is
 *             `<id>-<YYYY-MM-DD>-2.md` (then -3, …) and counts that day's earlier runs as prior
 *
 * Exit: 0 pass · 1 a check failed · 2 usage or unreadable file.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface Idea {
  name: string;
  line: number;
  block: string[];
}

export interface CheckResult {
  file: string;
  ideas: number;
  failures: string[];
}

const ITEM = /^\s*(\d+)\.\s+\*\*(.+?)\*\*/;
const HEADING = /^#{1,6}\s/;
const URL = /https?:\/\/\S+/;
const TAG = /\[(?:verified|unverified)\b[^\]]*\]/i;
const FILE_NAME = /^(.+)-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.md$/;

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function parseIdeas(text: string): Idea[] {
  const ideas: Idea[] = [];
  let current: Idea | null = null;
  text.split("\n").forEach((raw, i) => {
    const m = raw.match(ITEM);
    if (m) {
      current = { name: m[2], line: i + 1, block: [raw] };
      ideas.push(current);
    } else if (HEADING.test(raw) || /^[-*]\s/.test(raw)) {
      // a heading or a top-level bullet (the unranked "More options" list) ends the idea
      current = null;
    } else if (current) {
      current.block.push(raw);
    }
  });
  return ideas;
}

export function checkRun(file: string, text: string, priorTexts: string[]): CheckResult {
  const ideas = parseIdeas(text);
  const failures: string[] = [];

  if (ideas.length < 8 || ideas.length > 12) {
    failures.push(`count: ${ideas.length} ideas, expected 8–12`);
  }

  for (const idea of ideas) {
    const urlLine = idea.block.find((l) => URL.test(l));
    if (!urlLine) failures.push(`tag: line ${idea.line} "${idea.name}" has no product URL`);
    else if (!TAG.test(urlLine)) failures.push(`tag: line ${idea.line} "${idea.name}" product URL lacks [verified] or [unverified]`);
  }

  const prior = new Set(priorTexts.flatMap((t) => parseIdeas(t).map((i) => normalizeName(i.name))));
  for (const idea of ideas) {
    if (prior.has(normalizeName(idea.name))) {
      failures.push(`repeat: line ${idea.line} "${idea.name}" already appears in an earlier History file`);
    }
  }

  return { file, ideas: ideas.length, failures };
}

/** Earlier History files for the same id, from the checked file's own directory. */
export function priorFiles(file: string): string[] {
  const m = basename(file).match(FILE_NAME);
  if (!m) return [];
  const [, id, date, n] = m;
  const seq = Number(n ?? 1); // the day's first run has no suffix
  const dir = dirname(file);
  return readdirSync(dir)
    .filter((f) => {
      const p = f.match(FILE_NAME);
      if (p === null || p[1] !== id) return false;
      return p[2] < date || (p[2] === date && Number(p[3] ?? 1) < seq);
    })
    .map((f) => join(dir, f));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: bun skills/Gifts/Tools/CheckHistory.ts <History/<id>-<YYYY-MM-DD>[-N].md> [--json]");
    process.exit(2);
  }
  let text: string;
  let priors: string[];
  try {
    text = readFileSync(file, "utf8");
    priors = priorFiles(file).map((f) => readFileSync(f, "utf8"));
  } catch (e) {
    console.error(`cannot read ${file}: ${(e as Error).message}`);
    process.exit(2);
  }
  const result = checkRun(file, text, priors);
  if (json) console.log(JSON.stringify(result));
  else if (result.failures.length === 0) console.log(`PASS ${file}: ${result.ideas} ideas`);
  else console.log(`FAIL ${file}\n${result.failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(result.failures.length === 0 ? 0 : 1);
}
