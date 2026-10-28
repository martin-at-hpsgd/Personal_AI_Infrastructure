#!/usr/bin/env bun
// CheckAgreementCheck — checks a CheckAgreement output against the parts of its
// contract code can judge: the four sections and three severity groups in
// order, numbered labelled items (never bullets), a one-sentence summary of at
// most 30 words, at most ten callouts of at most 20 words, at most ten issues,
// one Response per Critical and Important issue whose label repeats that
// issue's group, number and label, no repeated labels or openings in a list, and
// no disclaimer. Fidelity to the document and severity stay judged checks.

import { readFileSync } from "node:fs";

const HELP = `CheckAgreementCheck — shape check for a Fabric CheckAgreement output

  bun skills/Fabric/Tools/CheckAgreementCheck.ts <file|-> [--json]

  --json      print {ok, notAgreement, counts, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export type Item = { n: number; label: string; text: string; line: number };
export type Counts = { callouts: number; critical: number; important: number; other: number; responses: number };
export type Result = { ok: boolean; notAgreement: boolean; counts: Counts; problems: string[] };

const SECTIONS = ["Document summary", "Callouts", "Issues", "Responses"] as const;
const GROUPS = ["Critical", "Important", "Other"] as const;
const ITEM = /^(\d+)\.\s+\*\*(.+?)(?::\*\*|\*\*:)\s+(\S.*)$/;
const BULLET = /^\s*[-*+]\s+\S/;
const DISCLAIMER = /not (?:legal advice|a lawyer|an attorney)|consult (?:a|an|your) (?:lawyer|attorney|legal)|seek (?:independent )?legal advice/i;

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[\s.:;,]+$/, "").trim();
const opening = (text: string) => words(text).slice(0, 2).map((w) => w.toLowerCase()).join(" ");

type Block = { lines: { text: string; line: number }[] };

function parseList(block: Block, where: string, problems: string[]): Item[] {
  const items: Item[] = [];
  for (const { text, line } of block.lines) {
    if (text.trim() === "") continue;
    if (BULLET.test(text)) { problems.push(`line ${line}: ${where} uses a bullet; items are numbered`); continue; }
    const m = text.trim().match(ITEM);
    if (!m) { problems.push(`line ${line}: ${where} has a line that is not a numbered **label:** item ("${text.trim()}")`); continue; }
    items.push({ n: Number(m[1]), label: m[2].trim(), text: m[3].trim(), line });
  }
  items.forEach((it, i) => {
    if (it.n !== i + 1) problems.push(`line ${it.line}: ${where} item numbered ${it.n}, expected ${i + 1}`);
  });
  const seenLabel = new Map<string, number>();
  const seenOpen = new Map<string, number>();
  for (const it of items) {
    const l = norm(it.label);
    if (seenLabel.has(l)) problems.push(`line ${it.line}: ${where} repeats the label "${it.label}"`);
    else seenLabel.set(l, it.line);
    const o = opening(it.text);
    if (o.includes(" ") && seenOpen.has(o)) problems.push(`line ${it.line}: ${where} has two items opening on "${o}"`);
    else seenOpen.set(o, it.line);
  }
  return items;
}

function nonBlank(block: Block) {
  return block.lines.filter((l) => l.text.trim() !== "");
}

export function check(input: string): Result {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const counts: Counts = { callouts: 0, critical: 0, important: 0, other: 0, responses: 0 };
  const filled = lines.map((t, i) => ({ text: t, line: i + 1 })).filter((l) => l.text.trim() !== "");

  if (DISCLAIMER.test(input)) problems.push("a legal-advice disclaimer appears; the output carries none");

  const na = filled.findIndex((l) => /^\*\*Not an agreement:\*\*\s+\S/.test(l.text.trim()));
  if (na >= 0) {
    if (filled.length > 1) problems.push(`line ${filled[na].line}: a not-an-agreement answer is that single line, with nothing else`);
    return { ok: problems.length === 0, notAgreement: true, counts, problems };
  }

  // Split into the preamble, H2 sections, and H3 groups inside Issues.
  const preamble: Block = { lines: [] };
  const sections: { name: string; line: number; body: Block; groups: { name: string; line: number; body: Block }[] }[] = [];
  lines.forEach((text, i) => {
    const line = i + 1;
    const h = text.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (h && h[1].length === 2) { sections.push({ name: h[2], line, body: { lines: [] }, groups: [] }); return; }
    const cur = sections[sections.length - 1];
    if (h && h[1].length === 3 && cur) { cur.groups.push({ name: h[2], line, body: { lines: [] } }); return; }
    if (h) { problems.push(`line ${line}: unexpected heading "${text.trim()}"; only the four ## sections and the three ### groups are allowed`); return; }
    if (!cur) { preamble.lines.push({ text, line }); return; }
    const g = cur.groups[cur.groups.length - 1];
    (g ? g.body : cur.body).lines.push({ text, line });
  });

  const pre = nonBlank(preamble);
  if (pre.length > 1 || (pre.length === 1 && !/^\*\*Source:\*\*\s+\S/.test(pre[0].text.trim())))
    problems.push("before the first section only one **Source:** line is allowed");

  const names = sections.map((s) => s.name);
  if (names.join("|") !== SECTIONS.join("|")) {
    problems.push(`sections are [${names.join(", ")}]; expected ${SECTIONS.join(", ")} in that order`);
    return { ok: false, notAgreement: false, counts, problems };
  }
  const [summary, callouts, issues, responses] = sections;
  for (const s of [summary, callouts, responses])
    for (const g of s.groups) problems.push(`line ${g.line}: ### ${g.name} belongs only inside Issues`);

  // Document summary: one line, one sentence, at most 30 words.
  const sum = nonBlank(summary.body);
  if (sum.length !== 1) problems.push(`Document summary has ${sum.length} lines; it is one sentence on one line`);
  else {
    const t = sum[0].text.trim();
    if (BULLET.test(t) || /^\d+\.\s/.test(t)) problems.push("Document summary is a list item; it is one sentence");
    if (/(?<!\b[A-Z])[.!?]["')\]]?\s+["'(]?[A-Z]/.test(t)) problems.push("Document summary holds more than one sentence");
    const w = words(t).length;
    if (w > 30) problems.push(`Document summary has ${w} words; at most 30`);
  }

  // Callouts.
  const co = parseList(callouts.body, "Callouts", problems);
  counts.callouts = co.length;
  if (co.length === 0) problems.push("Callouts has no items");
  if (co.length > 10) problems.push(`Callouts has ${co.length} items; at most 10`);
  for (const it of co) {
    const w = words(it.text).length;
    if (w > 20) problems.push(`line ${it.line}: callout ${it.n} has ${w} words after its label; at most 20`);
  }

  // Issues: three groups in order, each None. or a numbered list.
  for (const l of nonBlank(issues.body)) problems.push(`line ${l.line}: Issues holds text outside its ### groups`);
  const gnames = issues.groups.map((g) => g.name);
  const byGroup: Record<string, Item[]> = { Critical: [], Important: [], Other: [] };
  if (gnames.join("|") !== GROUPS.join("|")) problems.push(`Issues groups are [${gnames.join(", ")}]; expected Critical, Important, Other in that order`);
  else {
    for (const g of issues.groups) {
      const body = nonBlank(g.body);
      if (body.length === 1 && body[0].text.trim() === "None.") continue;
      if (body.length === 0) { problems.push(`line ${g.line}: ### ${g.name} is empty; write None. when it has no issues`); continue; }
      byGroup[g.name] = parseList(g.body, g.name, problems);
    }
    const all = [...byGroup.Critical, ...byGroup.Important, ...byGroup.Other];
    const seen = new Set<string>();
    for (const it of all) {
      const l = norm(it.label);
      if (seen.has(l) && !problems.some((p) => p.includes(`repeats the label "${it.label}"`))) problems.push(`line ${it.line}: Issues flag "${it.label}" twice`);
      seen.add(l);
    }
    if (all.length > 10) problems.push(`Issues has ${all.length} items; at most 10`);
  }
  counts.critical = byGroup.Critical.length;
  counts.important = byGroup.Important.length;
  counts.other = byGroup.Other.length;

  // Responses: one per Critical and Important issue, in order, labels matching.
  const expected = [
    ...byGroup.Critical.map((it) => ({ group: "Critical", n: it.n, label: it.label })),
    ...byGroup.Important.map((it) => ({ group: "Important", n: it.n, label: it.label })),
  ];
  const rbody = nonBlank(responses.body);
  if (expected.length === 0) {
    if (!(rbody.length === 1 && rbody[0].text.trim() === "None needed.")) problems.push("with no Critical or Important issues, Responses is the single line None needed.");
  } else {
    const rs = parseList(responses.body, "Responses", problems);
    counts.responses = rs.length;
    if (rs.length !== expected.length) problems.push(`Responses has ${rs.length} items; expected ${expected.length}, one per Critical and Important issue`);
    rs.forEach((r, i) => {
      const want = expected[i];
      if (!want) return;
      const m = r.label.match(/^(Critical|Important)\s+(\d+),\s+(.+)$/);
      const wantLabel = `${want.group} ${want.n}, ${want.label}`;
      if (!m) problems.push(`line ${r.line}: response label "${r.label}" should be "${wantLabel}"`);
      else if (m[1] !== want.group || Number(m[2]) !== want.n || norm(m[3]) !== norm(want.label))
        problems.push(`line ${r.line}: response label "${r.label}" should be "${wantLabel}"`);
    });
  }

  return { ok: problems.length === 0, notAgreement: false, counts, problems };
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
  const src = args.find((a) => !a.startsWith("--") || a === "-");
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input);
  if (json) console.log(JSON.stringify(r));
  else if (r.ok) console.log(r.notAgreement ? "✓ not-an-agreement line, shape holds" : `✓ ${r.counts.callouts} callouts, ${r.counts.critical}/${r.counts.important}/${r.counts.other} issues, ${r.counts.responses} responses, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
