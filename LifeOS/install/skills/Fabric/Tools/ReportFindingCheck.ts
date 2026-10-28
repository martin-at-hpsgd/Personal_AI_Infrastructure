#!/usr/bin/env bun
// ReportFindingCheck — checks a ReportFinding output against the parts of its
// contract code can judge: one H1 title, the five sections in order, a severity
// line, prose where prose is owed, bulleted recommendations and references,
// reference links that parse as http(s) URLs, a one-sentence summary under 25
// words, and no bold, italics, numbered lists or wrapping code fence. Whether
// the finding is accurate and specific to its input stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `ReportFindingCheck — shape check for a Fabric ReportFinding output

  bun skills/Fabric/Tools/ReportFindingCheck.ts <file|-> [--extra Name[,Name]] [--json]

  --extra   extra H2 sections the request asked for (e.g. Trends,Quotes), allowed after the five
  --json    print {ok, title, severity, sections, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const SECTIONS = ["Description", "Risk", "Recommendations", "References", "One-Sentence Summary"] as const;
export const SEVERITIES = ["Critical", "High", "Medium", "Low", "Informational"] as const;
const MAX_SUMMARY_WORDS = 24;
const MAX_REFERENCES = 5;
const MIN_RECOMMENDATIONS = 2;

type Section = { name: string; line: number; body: { text: string; line: number; fenced: boolean }[] };
export type Result = { ok: boolean; title: string | null; severity: string | null; sections: string[]; problems: string[] };

const BULLET = /^\s*[-*+]\s+(.*\S)\s*$/;
const TOP_BULLET = /^[-*+]\s+(.*\S)\s*$/;
const NUMBERED = /^\s*\d+[.)]\s+\S/;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const CVSS_METRICS: Record<string, string[]> = {
  AV: ["N", "A", "L", "P"], AC: ["L", "H"], PR: ["N", "L", "H"], UI: ["N", "R"],
  S: ["U", "C"], C: ["N", "L", "H"], I: ["N", "L", "H"], A: ["N", "L", "H"],
};

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

/** Validates a CVSS v3.x base vector; returns a problem string or null. */
export function cvssProblem(vector: string): string | null {
  const m = vector.match(/^CVSS:3\.[01]\/(.+)$/);
  if (!m) return `"${vector}" is not a CVSS:3.0 or CVSS:3.1 vector`;
  const seen = new Map<string, string>();
  for (const part of m[1].split("/")) {
    const [k, v, ...rest] = part.split(":");
    if (rest.length || !k || !v) return `CVSS vector part "${part}" is malformed`;
    if (seen.has(k)) return `CVSS metric ${k} appears twice`;
    seen.set(k, v);
  }
  for (const [k, allowed] of Object.entries(CVSS_METRICS)) {
    const v = seen.get(k);
    if (!v) return `CVSS vector is missing base metric ${k}`;
    if (!allowed.includes(v)) return `CVSS metric ${k}:${v} is not one of ${allowed.join("/")}`;
  }
  return null;
}

function stripForEmphasis(line: string): string {
  return line
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/`[^`]*`/g, "")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, "");
}

function emphasisProblem(line: string): string | null {
  const s = stripForEmphasis(line);
  if (/\*\*|__/.test(s)) return "bold";
  if (/(^|[\s(])\*(?!\s)[^*\n]+?(?<!\s)\*(?=[\s).,;:!?]|$)/.test(s)) return "italics";
  if (/(^|[\s(])_(?!\s)[^_\n]+?(?<!\s)_(?=[\s).,;:!?]|$)/.test(s)) return "italics";
  return null;
}

function firstWords(text: string, n: number): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean).slice(0, n).join(" ");
}

export function check(input: string, opts: { extras?: string[] } = {}): Result {
  const extras = (opts.extras ?? []).map((e) => e.trim()).filter(Boolean);
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  let title: string | null = null;
  let severity: string | null = null;
  const sections: Section[] = [];
  let h1Count = 0;
  let inFence = false;
  let sawContent = false;

  lines.forEach((raw, i) => {
    const ln = i + 1;
    if (FENCE.test(raw)) {
      if (!sawContent) problems.push(`line ${ln}: the output is wrapped in a code fence; deliver the markdown itself`);
      sawContent = true;
      inFence = !inFence;
      sections.at(-1)?.body.push({ text: raw, line: ln, fenced: true });
      return;
    }
    if (inFence) {
      sections.at(-1)?.body.push({ text: raw, line: ln, fenced: true });
      return;
    }
    const h = raw.match(HEADING);
    if (h && h[1].length <= 2) {
      if (h[1].length === 1) {
        h1Count++;
        if (h1Count === 1) {
          if (sawContent) problems.push(`line ${ln}: the title must be the first line`);
          title = h[2];
          if (!title || /^title$/i.test(title)) problems.push(`line ${ln}: the title is empty or the literal word "Title"`);
        } else problems.push(`line ${ln}: a second H1 ("${h[2]}"); the finding has one title`);
      } else {
        sections.push({ name: h[2], line: ln, body: [] });
      }
      sawContent = true;
      return;
    }
    if (raw.trim() !== "") {
      if (!sawContent) problems.push(`line ${ln}: text before the title ("${raw.trim().slice(0, 60)}")`);
      sawContent = true;
      if (NUMBERED.test(raw)) problems.push(`line ${ln}: numbered list item; use bullets`);
      const emph = emphasisProblem(raw);
      if (emph) problems.push(`line ${ln}: ${emph} formatting ("${raw.trim().slice(0, 60)}"); plain text only`);
      if (sections.length === 0 && title !== null) problems.push(`line ${ln}: text between the title and the first section`);
    }
    sections.at(-1)?.body.push({ text: raw, line: ln, fenced: false });
  });

  if (inFence) problems.push("an unclosed code fence");
  if (title === null) problems.push("no H1 title (the first line is # {finding title})");

  const names = sections.map((s) => s.name);
  SECTIONS.forEach((want, idx) => {
    if (names[idx] !== want) problems.push(`section ${idx + 1} should be "## ${want}", found ${names[idx] === undefined ? "nothing" : `"## ${names[idx]}"`}`);
  });
  const lower = new Set(extras.map((e) => e.toLowerCase()));
  for (const s of sections.slice(SECTIONS.length)) {
    if (!lower.has(s.name.toLowerCase())) problems.push(`line ${s.line}: unrequested section "## ${s.name}" (pass --extra ${s.name} when the request asked for it)`);
  }
  const seen = new Set<string>();
  for (const s of sections) {
    if (seen.has(s.name)) problems.push(`line ${s.line}: section "## ${s.name}" appears twice`);
    seen.add(s.name);
  }

  const get = (name: string) => sections.find((s) => s.name === name);
  const plain = (s: Section) => s.body.filter((b) => !b.fenced && b.text.trim() !== "" && !/^#{3,6}\s/.test(b.text));
  const isProse = (t: string) => !BULLET.test(t) && !NUMBERED.test(t);

  const desc = get("Description");
  if (desc) {
    const p = plain(desc);
    if (p.length === 0) problems.push("Description is empty");
    else if (!p.some((b) => isProse(b.text))) problems.push("Description is bullets only; it needs prose");
  }

  const risk = get("Risk");
  if (risk) {
    const p = plain(risk);
    const first = p[0]?.text.trim() ?? "";
    const m = first.match(/^Severity:\s+(Critical|High|Medium|Low|Informational)\b(.*)$/);
    if (!m) problems.push(`Risk must open on "Severity: <${SEVERITIES.join("|")}>", found "${first.slice(0, 60)}"`);
    else {
      severity = m[1];
      const vec = m[2].match(/CVSS:\S+/);
      if (vec) {
        const bad = cvssProblem(vec[0].replace(/[),.;]+$/, ""));
        if (bad) problems.push(`Severity line: ${bad}`);
      }
    }
    if (!p.slice(1).some((b) => isProse(b.text))) problems.push("Risk has no prose after the severity line");
  }

  const recs = get("Recommendations");
  if (recs) {
    const items = plain(recs).map((b) => b.text.match(TOP_BULLET)?.[1]).filter((x): x is string => !!x);
    if (items.length < MIN_RECOMMENDATIONS) problems.push(`Recommendations has ${items.length} bullet${items.length === 1 ? "" : "s"}; at least ${MIN_RECOMMENDATIONS}`);
    const openers = new Map<string, number>();
    for (const it of items) {
      const k = firstWords(it, 2);
      if (openers.has(k)) problems.push(`two recommendations open on the same words ("${k}")`);
      openers.set(k, 1);
    }
  }

  const refs = get("References");
  if (refs) {
    const p = plain(refs);
    const items = p.map((b) => b.text.match(TOP_BULLET)?.[1]).filter((x): x is string => !!x);
    for (const b of p) if (!BULLET.test(b.text)) problems.push(`line ${b.line}: References holds a non-bullet line ("${b.text.trim().slice(0, 60)}")`);
    if (items.length < 1 || items.length > MAX_REFERENCES) problems.push(`References has ${items.length} items; 1 to ${MAX_REFERENCES}`);
    const urls = new Set<string>();
    for (const it of items) {
      const link = it.match(/\[([^\]]+)\]\(([^)\s]+)\)/);
      if (!link) { problems.push(`reference "${it.slice(0, 60)}" is not a named markdown link [name](url)`); continue; }
      let u: URL | null = null;
      try { u = new URL(link[2]); } catch { /* reported below */ }
      if (!u || !/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) { problems.push(`reference URL "${link[2]}" does not parse as an http(s) URL`); continue; }
      const key = u.href.replace(/\/$/, "");
      if (urls.has(key)) problems.push(`reference URL repeated: ${link[2]}`);
      urls.add(key);
    }
  }

  const sum = get("One-Sentence Summary");
  if (sum) {
    const p = plain(sum);
    const text = p.map((b) => b.text.trim()).join(" ");
    if (!text) problems.push("One-Sentence Summary is empty");
    else {
      if (p.some((b) => BULLET.test(b.text))) problems.push("One-Sentence Summary is a bullet; write the sentence");
      const n = wordCount(text);
      if (n > MAX_SUMMARY_WORDS) problems.push(`One-Sentence Summary has ${n} words; under 25`);
      const sentences = text.split(/(?<=[.!?])\s+(?=\S)/).filter((s) => s.trim());
      if (sentences.length !== 1 || !/[.!?]["')]?$/.test(text)) problems.push(`One-Sentence Summary must be exactly one sentence ending in . ! or ?`);
    }
  }

  return { ok: problems.length === 0, title, severity, sections: names, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const ei = args.indexOf("--extra");
  if (ei >= 0 && (!args[ei + 1] || args[ei + 1].startsWith("--"))) {
    console.error("--extra needs a section name or a comma-separated list");
    process.exit(2);
  }
  const extras = ei >= 0 ? args[ei + 1].split(",") : [];
  const src = args.find((a, i) => !a.startsWith("--") && !(ei >= 0 && i === ei + 1));
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input, { extras });
  if (json) console.log(JSON.stringify(r));
  else if (r.ok) console.log(`✓ "${r.title}" (${r.severity}), ${r.sections.length} sections, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
