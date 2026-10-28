#!/usr/bin/env bun
// GitDiffSummaryCheck — checks a GitDiffSummary commit message against the
// parts of its contract code can judge: a Conventional Commits subject line
// (known type, optional scope, optional "!", at most 72 characters, imperative,
// no closing period), a blank line, a "CHANGES:" line, 1 to 8 "- " bullets of
// 4 to 12 words opening on an imperative verb, and a BREAKING CHANGE footer
// exactly when the subject carries "!". Nothing else. A trailing Harvest block
// ("--- HARVEST ---" onward) is ignored. Whether the type fits the diff and the
// bullets are true stays a judged check in the fabric-gitdiffsummary suite.

import { readFileSync } from "node:fs";

const HELP = `GitDiffSummaryCheck — shape check for a Fabric GitDiffSummary commit message

  bun skills/Fabric/Tools/GitDiffSummaryCheck.ts <file|-> [--json]

  --json      print {ok, header, bullets, breakingFooter, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const TYPES = ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"] as const;
export const MAX_SUBJECT = 72;
export const MIN_BULLETS = 1;
export const MAX_BULLETS = 8;
export const MIN_WORDS = 4;
export const MAX_WORDS = 12;

// First words that are not imperative: past tense, third person, gerund.
const THIRD_PERSON = new Set([
  "adds", "fixes", "updates", "removes", "changes", "makes", "moves", "renames", "refactors", "improves",
  "introduces", "implements", "replaces", "uses", "supports", "handles", "ensures", "allows", "prevents",
  "creates", "deletes", "bumps", "upgrades", "converts", "extracts", "drops", "sets", "returns", "reverts",
]);
const ED_OK = new Set(["embed", "need", "seed", "speed", "feed", "shed", "shred", "bleed", "proceed", "exceed", "succeed", "breed", "red", "bed"]);
const ING_OK = new Set(["bring", "string", "spring", "ping", "ring", "thing", "swing", "sting", "wing", "king", "sing"]);

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}`]+|[^\p{L}\p{N}`]+$/gu, ""))
    .filter((t) => /[\p{L}\p{N}]/u.test(t));
}

export function nonImperative(word: string): string | undefined {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return undefined;
  if (THIRD_PERSON.has(w)) return "third person";
  if (w.length > 3 && w.endsWith("ed") && !ED_OK.has(w)) return "past tense";
  if (w.length > 4 && w.endsWith("ing") && !ING_OK.has(w)) return "gerund";
  return undefined;
}

export type Header = { type: string; scope?: string; breaking: boolean; subject: string; length: number };

const HEADER_RE = /^([a-z]+)(?:\(([^()\s]+)\))?(!)?: (\S.*)$/;

export function parseHeader(line: string): Header | undefined {
  const m = line.match(HEADER_RE);
  if (!m) return undefined;
  return { type: m[1], scope: m[2], breaking: m[3] === "!", subject: m[4], length: line.length };
}

export function check(input: string): {
  ok: boolean;
  header?: Header;
  bullets: string[];
  breakingFooter?: string;
  problems: string[];
} {
  const problems: string[] = [];
  let text = input.replace(/\r\n/g, "\n");
  // The Harvest block starts at a "--- HARVEST ---" line, or at a bare "---"
  // rule whose remainder mentions Harvest.
  const rule = /^-{3,}(?:\s*HARVEST\s*-{3,})?\s*$/gim;
  let harvest = -1;
  for (let m; (m = rule.exec(text)); ) {
    if (/HARVEST/i.test(m[0]) || /harvest/i.test(text.slice(m.index + m[0].length))) { harvest = m.index; break; }
  }
  if (harvest >= 0) text = text.slice(0, harvest);
  // A trailing Harvest warning written as a blockquote is the same block.
  else text = text.replace(/\n\s*\n(?:>[^\n]*\n?)*>[^\n]*harvest[^\n]*(?:\n>[^\n]*)*\s*$/i, "\n");
  const lines = text.replace(/\s+$/, "").split("\n");
  while (lines.length && lines[0].trim() === "") lines.shift();
  const bullets: string[] = [];
  let breakingFooter: string | undefined;

  if (lines.length === 0) return { ok: false, bullets, problems: ["empty message"] };

  lines.forEach((raw, i) => {
    if (/^\s*#/.test(raw)) problems.push(`line ${i + 1}: starts with "#", which git strips as a comment in the commit editor`);
    if (/^\s*(```|~~~)/.test(raw)) problems.push(`line ${i + 1}: code fence; the message is delivered bare`);
    if (/\*\*|__/.test(raw)) problems.push(`line ${i + 1}: bold markup`);
    if (/https?:\/\//i.test(raw)) problems.push(`line ${i + 1}: URL; describe the context instead`);
  });

  const headerLine = lines[0];
  const header = parseHeader(headerLine);
  if (!header) {
    problems.push(`line 1: not a Conventional Commits subject ("type(scope): subject"): "${headerLine}"`);
  } else {
    if (!(TYPES as readonly string[]).includes(header.type)) problems.push(`line 1: type "${header.type}" is not one of ${TYPES.join(", ")}`);
    if (header.length > MAX_SUBJECT) problems.push(`line 1: subject line is ${header.length} characters; at most ${MAX_SUBJECT}`);
    if (/[.。]\s*$/.test(header.subject)) problems.push("line 1: subject ends with a period");
    const first = words(header.subject)[0];
    const why = first ? nonImperative(first) : undefined;
    if (why) problems.push(`line 1: subject opens on "${first}" (${why}); use the imperative`);
  }

  if (lines.length < 2 || lines[1].trim() !== "") problems.push("line 2: a blank line must follow the subject");

  let i = 2;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length || lines[i].trim() !== "CHANGES:") {
    problems.push(`line ${i + 1}: expected the line "CHANGES:"${i < lines.length ? `, found "${lines[i].trim()}"` : ""}`);
  } else {
    i++;
    while (i < lines.length && lines[i].trim() === "") i++;
    for (; i < lines.length; i++) {
      const raw = lines[i];
      if (raw.trim() === "") break;
      if (/^\s+[-*+]\s/.test(raw)) { problems.push(`line ${i + 1}: sub-bullet`); continue; }
      const m = raw.match(/^- (\S.*)$/);
      if (!m) { problems.push(`line ${i + 1}: not a "- " bullet ("${raw.trim()}")`); continue; }
      bullets.push(m[1]);
      const ws = words(m[1]);
      if (ws.length < MIN_WORDS || ws.length > MAX_WORDS) problems.push(`line ${i + 1}: bullet has ${ws.length} words; ${MIN_WORDS} to ${MAX_WORDS}`);
      const why = ws[0] ? nonImperative(ws[0]) : undefined;
      if (why) problems.push(`line ${i + 1}: bullet opens on "${ws[0]}" (${why}); use the imperative`);
    }
    if (bullets.length < MIN_BULLETS || bullets.length > MAX_BULLETS) problems.push(`CHANGES has ${bullets.length} bullets; ${MIN_BULLETS} to ${MAX_BULLETS}`);
    const seen = new Set<string>();
    for (const b of bullets) {
      const k = b.toLowerCase().trim();
      if (seen.has(k)) problems.push(`duplicate bullet: "${b}"`);
      seen.add(k);
    }
  }

  const rest = lines.slice(i).filter((l) => l.trim() !== "");
  for (const l of rest) {
    const f = l.match(/^BREAKING[ -]CHANGE: (\S.*)$/);
    if (f && breakingFooter === undefined) breakingFooter = f[1];
    else problems.push(`extra line after CHANGES ("${l.trim()}"); only one BREAKING CHANGE footer may follow`);
  }
  if (header) {
    if (header.breaking && breakingFooter === undefined) problems.push('subject carries "!" but no "BREAKING CHANGE: " line says what callers must do');
    if (!header.breaking && breakingFooter !== undefined) problems.push('a BREAKING CHANGE line is present but the subject has no "!"');
  }

  return { ok: problems.length === 0, header, bullets, breakingFooter, problems };
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
  const r = check(input);
  if (json) console.log(JSON.stringify({ ok: r.ok, header: r.header ?? null, bullets: r.bullets.length, breakingFooter: r.breakingFooter ?? null, problems: r.problems }));
  else if (r.ok) console.log(`✓ ${r.header?.type}${r.header?.scope ? `(${r.header.scope})` : ""}${r.header?.breaking ? "!" : ""}, ${r.bullets.length} bullets, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
