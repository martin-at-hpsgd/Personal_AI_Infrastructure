#!/usr/bin/env bun
// PullRequestCheck — checks a PullRequest description against the parts of its
// contract code can judge: a "# " title line first (at most 72 characters,
// imperative, no closing period, optional Conventional Commits prefix), the
// required "## " sections in order and none empty, one Files Changed bullet per
// file opening on a backticked path and its status, at least one fenced block
// with a language in Code Changes, at least one Risks bullet, at least one
// "- [ ]" check in Test Plan, balanced fences, and no secret-shaped string.
// Whether the content is true to the diff stays a judged check in the
// fabric-pullrequest suite.

import { readFileSync } from "node:fs";
import { nonImperative, words } from "./GitDiffSummaryCheck.ts";

const HELP = `PullRequestCheck — shape check for a Fabric PullRequest description

  bun skills/Fabric/Tools/PullRequestCheck.ts <file|-> [--json]

  --json      print {ok, title, sections, files, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const MAX_TITLE = 72;
export const REQUIRED = [
  "Summary",
  "Files Changed",
  "Code Changes",
  "Reason for Changes",
  "Impact of Changes",
  "Risks",
  "Test Plan",
] as const;
export const OPTIONAL_LAST = "Additional Notes";

const FILE_RE = /^- `([^`]+)` \((added|modified|deleted|renamed from `[^`]+`)\)(?::| —| -)\s+\S/;
const CONVENTIONAL_PREFIX = /^[a-z]+(?:\([^()\s]+\))?!?: /;

// Shapes of credentials that must never be quoted back. Reported by kind only.
const SECRET_SHAPES: [string, RegExp][] = [
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["API secret key", /\bsk-(?:live_|test_|proj-)?[A-Za-z0-9_-]{20,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

export type Section = { name: string; line: number; body: string[] };

export function normalize(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function check(input: string): {
  ok: boolean;
  title?: string;
  sections: string[];
  files: string[];
  problems: string[];
} {
  const problems: string[] = [];
  const lines = input.replace(/\r\n/g, "\n").replace(/\s+$/, "").split("\n");
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  const files: string[] = [];
  if (start >= lines.length) return { ok: false, sections: [], files, problems: ["empty description"] };

  for (const [kind, re] of SECRET_SHAPES) if (re.test(input)) problems.push(`secret-shaped string (${kind}); name it by what it is, never quote it`);

  // Title.
  let title: string | undefined;
  const t = lines[start].match(/^# (\S.*)$/);
  if (!t) {
    problems.push(`line ${start + 1}: the description must open on a "# " title line, found "${lines[start].trim().slice(0, 60)}"`);
  } else {
    title = t[1].trim();
    if (title.length > MAX_TITLE) problems.push(`line ${start + 1}: title is ${title.length} characters; at most ${MAX_TITLE}`);
    if (/[.。]$/.test(title)) problems.push(`line ${start + 1}: title ends with a period`);
    const first = words(title.replace(CONVENTIONAL_PREFIX, ""))[0];
    const why = first ? nonImperative(first) : undefined;
    if (why) problems.push(`line ${start + 1}: title opens on "${first}" (${why}); use the imperative`);
  }

  // Sections, ignoring headings inside fenced blocks.
  const sections: Section[] = [];
  let fence: string | undefined;
  let fenceLine = 0;
  const fenceInfo: { section?: string; info: string; line: number }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i];
    const f = raw.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (f) {
      if (fence === undefined) {
        fence = f[1];
        fenceLine = i + 1;
        fenceInfo.push({ section: sections.at(-1)?.name, info: f[2].trim(), line: i + 1 });
      } else if (f[1][0] === fence[0] && f[1].length >= fence.length && f[2].trim() === "") {
        fence = undefined;
      }
      sections.at(-1)?.body.push(raw);
      continue;
    }
    if (fence === undefined) {
      if (/^# /.test(raw)) { problems.push(`line ${i + 1}: a second "# " heading; only the title is H1`); continue; }
      const h = raw.match(/^## (\S.*)$/);
      if (h) { sections.push({ name: h[1].trim(), line: i + 1, body: [] }); continue; }
      if (sections.length === 0 && raw.trim() !== "") { problems.push(`line ${i + 1}: text between the title and the first section ("${raw.trim().slice(0, 60)}")`); continue; }
    }
    sections.at(-1)?.body.push(raw);
  }
  if (fence !== undefined) problems.push(`line ${fenceLine}: code fence never closed`);

  // Order and membership.
  const expected = REQUIRED.map(normalize);
  const names = sections.map((s) => normalize(s.name));
  const seen = new Set<string>();
  for (const s of sections) {
    const n = normalize(s.name);
    if (seen.has(n)) problems.push(`line ${s.line}: section "${s.name}" appears twice`);
    seen.add(n);
    if (!expected.includes(n) && n !== normalize(OPTIONAL_LAST)) problems.push(`line ${s.line}: unexpected section "${s.name}"; the sections are ${[...REQUIRED, OPTIONAL_LAST].join(", ")}`);
  }
  for (const r of REQUIRED) if (!names.includes(normalize(r))) problems.push(`missing section "## ${r}"`);
  const order = names.filter((n) => expected.includes(n));
  const wantOrder = expected.filter((n) => order.includes(n));
  if (order.join("|") !== wantOrder.join("|")) problems.push(`sections out of order: ${order.join(" → ")}; expected ${REQUIRED.join(" → ")}`);
  const notesIdx = names.indexOf(normalize(OPTIONAL_LAST));
  if (notesIdx >= 0 && notesIdx !== names.length - 1) problems.push(`"## ${OPTIONAL_LAST}" must be the last section`);

  const get = (name: string) => sections.find((s) => normalize(s.name) === normalize(name));
  for (const s of sections) if (s.body.every((l) => l.trim() === "")) problems.push(`line ${s.line}: section "${s.name}" is empty`);

  // Files Changed: one well-formed bullet per file.
  const fc = get("Files Changed");
  if (fc) {
    fc.body.forEach((raw, k) => {
      if (raw.trim() === "") return;
      const line = fc.line + 1 + k;
      if (/^\s+[-*+]\s/.test(raw)) { problems.push(`line ${line}: sub-bullet in Files Changed`); return; }
      const m = raw.match(FILE_RE);
      if (!m) { problems.push(`line ${line}: Files Changed bullet must open on a backticked path and its status, e.g. "- \`src/a.ts\` (modified): …" ("${raw.trim().slice(0, 60)}")`); return; }
      if (files.includes(m[1])) problems.push(`line ${line}: \`${m[1]}\` listed twice`);
      files.push(m[1]);
    });
    if (files.length === 0) problems.push("Files Changed lists no files");
  }

  // Code Changes: at least one fenced block, each with a language or diff tag.
  const cc = get("Code Changes");
  if (cc) {
    const blocks = fenceInfo.filter((b) => b.section !== undefined && normalize(b.section) === normalize("Code Changes"));
    if (blocks.length === 0) problems.push("Code Changes has no fenced code block");
    for (const b of blocks) if (b.info === "") problems.push(`line ${b.line}: code block has no language or diff tag`);
  }

  const bullets = (s?: Section) => (s ? s.body.filter((l) => /^- \S/.test(l)) : []);
  if (get("Risks") && bullets(get("Risks")).length === 0) problems.push("Risks has no \"- \" bullet");
  const tp = get("Test Plan");
  if (tp && !tp.body.some((l) => /^- \[[ xX]\] \S/.test(l))) problems.push('Test Plan has no "- [ ]" check for the reviewer');

  return { ok: problems.length === 0, title, sections: sections.map((s) => s.name), files, problems };
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
    console.error(`unknown flag ${unknown[0]}\n\n${HELP}`);
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
  if (json) console.log(JSON.stringify(r));
  else if (r.ok) console.log(`✓ ${r.sections.length} sections, ${r.files.length} files, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
