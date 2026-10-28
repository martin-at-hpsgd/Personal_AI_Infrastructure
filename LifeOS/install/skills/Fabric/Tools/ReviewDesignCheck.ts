#!/usr/bin/env bun
// ReviewDesignCheck — checks a ReviewDesign output against the parts of its
// contract code can judge: one block per design under "# Design review:", a
// Verdict line with a fixed value and a reason, optional Source and Answer lines,
// the H2 sections in their fixed order (areas, Assumptions, then the closing
// Strengths and Most critical changes), 1 to 5 ranked changes naming an area,
// finding bullets with a severity, Evidence and Fix, worst first, a verdict that
// follows the worst finding, Stated/Assumed assumptions, no bold or italics, and
// (with --source) every quoted evidence string present in the design text.
// Whether findings are specific to the design stays a judged check in the suite.

import { readFileSync } from "node:fs";

const HELP = `ReviewDesignCheck — shape check for a Fabric ReviewDesign output

  bun skills/Fabric/Tools/ReviewDesignCheck.ts <file|-> [--source <design-file>] [--json]

  --source F  the supplied design text; every quoted evidence string must appear in it
  --json      print {ok, noDesign, reviews, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const AREAS = [
  "Architecture and components",
  "External integrations",
  "Security",
  "Performance, scalability and resilience",
  "Data management",
  "Maintainability and growth",
  "Document readability",
] as const;

export const SECTIONS = [...AREAS, "Assumptions", "Strengths", "Most critical changes"] as const;

export const SEVERITIES = ["Critical", "High", "Medium", "Low"] as const;
type Severity = (typeof SEVERITIES)[number];
const RANK: Record<Severity, number> = { Critical: 3, High: 2, Medium: 1, Low: 0 };

export type Verdict = "Sound" | "Sound with changes" | "Needs rework";

export function expectedVerdict(worst: Severity | null): Verdict {
  if (worst === "Critical") return "Needs rework";
  if (worst === "High" || worst === "Medium") return "Sound with changes";
  return "Sound";
}

export type Finding = { area: string; severity: Severity; finding: string; evidence: string; fix: string; line: number };
export type Review = {
  system: string;
  line: number;
  verdict: Verdict | null;
  worst: Severity | null;
  changes: number;
  findings: Finding[];
};
export type Result = { ok: boolean; noDesign: boolean; reviews: Review[]; problems: string[] };

const HEADING = /^#\s+Design review:\s*(.*\S)?\s*$/;
const VERDICT = /^Verdict:\s+(Sound with changes|Needs rework|Sound)\.(\s+\S.*)?$/;
const FINDING = /^- (Critical|High|Medium|Low): (.+?)\s+Evidence: (.+?)\s+Fix: (.*\S)\s*$/;
const EMPTY_AREA = /^- (No issues|Not applicable): \S/;
const CHANGE = /^(\d+)\. (.+?): \S/;
const ASSUMPTION = /^- (Stated|Assumed): \S/;

/** Text with fenced blocks and inline code spans removed, so code never trips the emphasis rule. */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

export function emphasisProblems(text: string): string[] {
  const out: string[] = [];
  stripCode(text)
    .split("\n")
    .forEach((raw, i) => {
      if (/\*\*\S|\S\*\*|__\S|\S__/.test(raw)) out.push(`line ${i + 1}: bold text; the review uses no bold`);
      else if (/(^|[^\w*\\])\*(?=\S)[^*\n]*?\S\*(?![\w*])/.test(raw) || /(^|[^\w_\\])_(?=\S)[^_\n]*?\S_(?![\w_])/.test(raw))
        out.push(`line ${i + 1}: italic text; the review uses no italics`);
    });
  return out;
}

function norm(s: string): string {
  return s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function quotes(evidence: string): string[] {
  return [...evidence.replace(/[“”]/g, '"').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function checkBlock(lines: string[], start: number, end: number, problems: string[], source?: string): Review {
  const head = lines[start].trim().match(HEADING)!;
  const review: Review = { system: head[1] ?? "", line: start + 1, verdict: null, worst: null, changes: 0, findings: [] };
  if (!head[1]) problems.push(`line ${start + 1}: the heading names no system ("# Design review: {system}")`);

  // Lines between the heading and the first H2: Verdict, then optional Source and Answer.
  let i = start + 1;
  const preamble: { ln: number; t: string }[] = [];
  while (i < end && !/^##\s/.test(lines[i].trim())) {
    const t = lines[i].trim();
    if (t !== "") preamble.push({ ln: i + 1, t });
    i++;
  }
  if (preamble.length === 0) problems.push(`line ${start + 1}: no Verdict line under the heading`);
  preamble.forEach((p, idx) => {
    if (idx === 0) {
      const v = p.t.match(VERDICT);
      if (!v) problems.push(`line ${p.ln}: the first line under the heading must be "Verdict: {Sound | Sound with changes | Needs rework}. {reason}" ("${p.t.slice(0, 60)}")`);
      else {
        review.verdict = v[1] as Verdict;
        if (!v[2]) problems.push(`line ${p.ln}: the verdict carries no reason`);
      }
      return;
    }
    if (/^Source:\s+\S/.test(p.t) || /^Answer:\s+\S/.test(p.t)) return;
    problems.push(`line ${p.ln}: text between the verdict and the first section ("${p.t.slice(0, 60)}"); only Source: and Answer: lines go there`);
  });
  const keys = preamble.slice(1).map((p) => p.t.split(":")[0]);
  for (const k of ["Source", "Answer"]) if (keys.filter((x) => x === k).length > 1) problems.push(`review at line ${start + 1}: more than one ${k}: line`);

  // Sections.
  const sections: { name: string; ln: number; body: { ln: number; raw: string }[] }[] = [];
  for (; i < end; i++) {
    const raw = lines[i];
    const t = raw.trim();
    const h2 = t.match(/^##\s+(.+?)\s*$/);
    if (h2 && !t.startsWith("###")) {
      sections.push({ name: h2[1], ln: i + 1, body: [] });
      continue;
    }
    if (t === "") continue;
    sections[sections.length - 1]?.body.push({ ln: i + 1, raw });
  }

  const names = sections.map((s) => s.name);
  for (const s of sections) {
    if (!(SECTIONS as readonly string[]).includes(s.name)) problems.push(`line ${s.ln}: unexpected section "## ${s.name}"`);
    if (names.filter((n) => n === s.name).length > 1 && names.indexOf(s.name) !== sections.indexOf(s)) problems.push(`line ${s.ln}: section "## ${s.name}" appears twice`);
  }
  const known = names.filter((n) => (SECTIONS as readonly string[]).includes(n));
  for (const want of SECTIONS) if (!known.includes(want)) problems.push(`review at line ${start + 1}: missing section "## ${want}"`);
  const order = [...new Set(known)];
  const expectedOrder = SECTIONS.filter((s) => order.includes(s));
  if (order.join("|") !== expectedOrder.join("|")) problems.push(`review at line ${start + 1}: sections out of order; the order is ${SECTIONS.join(", ")}`);

  const changeAreas: string[] = [];
  for (const s of sections) {
    const isArea = (AREAS as readonly string[]).includes(s.name);
    if (s.body.length === 0 && (SECTIONS as readonly string[]).includes(s.name)) {
      problems.push(`line ${s.ln}: section "## ${s.name}" is empty`);
      continue;
    }
    for (const b of s.body) {
      const t = b.raw.trim();
      if (/^#{3,}\s/.test(t)) problems.push(`line ${b.ln}: sub-heading ("${t}"); sections hold bullets only`);
      else if (/^\s+[-*+]\s/.test(b.raw)) problems.push(`line ${b.ln}: sub-bullet; each item is its own top-level line`);
    }
    const body = s.body.filter((b) => !/^#{3,}\s/.test(b.raw.trim()) && !/^\s+[-*+]\s/.test(b.raw));

    if (s.name === "Most critical changes") {
      review.changes = body.length;
      if (body.length < 1 || body.length > 5) problems.push(`line ${s.ln}: ${body.length} critical changes; the list holds 1 to 5`);
      body.forEach((b, idx) => {
        const m = b.raw.trim().match(CHANGE);
        if (!m) return problems.push(`line ${b.ln}: a change is "{n}. {Area}: {the change}" ("${b.raw.trim().slice(0, 60)}")`);
        if (Number(m[1]) !== idx + 1) problems.push(`line ${b.ln}: change numbered ${m[1]}, expected ${idx + 1}`);
        if (!(AREAS as readonly string[]).includes(m[2])) problems.push(`line ${b.ln}: change names "${m[2]}", which is not one of the seven areas`);
        changeAreas.push(m[2]);
      });
    } else if (s.name === "Strengths") {
      for (const b of body) if (!/^- \S/.test(b.raw.trim())) problems.push(`line ${b.ln}: a strength is a "- " bullet ("${b.raw.trim().slice(0, 60)}")`);
    } else if (s.name === "Assumptions") {
      for (const b of body) if (!ASSUMPTION.test(b.raw.trim())) problems.push(`line ${b.ln}: an assumption opens on "Stated:" or "Assumed:" ("${b.raw.trim().slice(0, 60)}")`);
    } else if (isArea) {
      let prev: Severity | null = null;
      let empties = 0;
      for (const b of body) {
        const t = b.raw.trim();
        if (EMPTY_AREA.test(t)) {
          empties++;
          continue;
        }
        const f = t.match(FINDING);
        if (!f) {
          problems.push(`line ${b.ln}: a finding is "- {Critical | High | Medium | Low}: {finding}. Evidence: {evidence}. Fix: {fix}" ("${t.slice(0, 60)}")`);
          continue;
        }
        const sev = f[1] as Severity;
        const ev = f[3].replace(/\.$/, "");
        if (!/^["“]/.test(ev) && !/^Not stated\b/.test(ev) && !/^Common practice\b/.test(ev))
          problems.push(`line ${b.ln}: evidence must be a quotation, "Not stated" or "Common practice, ..." ("${ev.slice(0, 40)}")`);
        if (prev && RANK[sev] > RANK[prev]) problems.push(`line ${b.ln}: ${sev} finding after a ${prev} one; findings run worst first`);
        prev = sev;
        review.findings.push({ area: s.name, severity: sev, finding: f[2], evidence: ev, fix: f[4], line: b.ln });
        if (source !== undefined) {
          const hay = norm(source);
          for (const q of quotes(ev)) if (!hay.includes(norm(q))) problems.push(`line ${b.ln}: quoted evidence "${q.slice(0, 60)}" does not appear in the source`);
        }
      }
      if (empties > 0 && body.length > 1) problems.push(`line ${s.ln}: a "No issues:" or "Not applicable:" bullet must be the only bullet in "## ${s.name}"`);
    } else {
      // unexpected section: its body is not checked further
    }
  }

  review.worst = review.findings.reduce<Severity | null>((w, f) => (w === null || RANK[f.severity] > RANK[w] ? f.severity : w), null);
  if (review.verdict) {
    const want = expectedVerdict(review.worst);
    if (review.verdict !== want)
      problems.push(`line ${start + 2}: verdict "${review.verdict}" contradicts the findings (worst is ${review.worst ?? "none"}, so the verdict is "${want}")`);
  }
  if (review.worst && changeAreas.length > 0) {
    const worstAreas = new Set(review.findings.filter((f) => f.severity === review.worst).map((f) => f.area));
    if (!worstAreas.has(changeAreas[0]))
      problems.push(`review at line ${start + 1}: the first critical change names "${changeAreas[0]}", but the worst (${review.worst}) finding is in ${[...worstAreas].join(", ")}`);
  }
  return review;
}

export function check(input: string, source?: string): Result {
  const text = input.replace(/\r\n/g, "\n");
  const problems: string[] = [];
  const trimmed = text.trim();

  if (/^No design:/m.test(trimmed)) {
    const ok = /^No design:\s+\S[^\n]*$/.test(trimmed);
    if (!ok) problems.push('an input with no design is answered with the single line "No design: {what the input is instead}" and nothing else');
    return { ok: problems.length === 0, noDesign: true, reviews: [], problems };
  }

  problems.push(...emphasisProblems(text));
  const lines = text.split("\n");
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (HEADING.test(l.trim())) starts.push(i);
  });
  if (starts.length === 0) return { ok: false, noDesign: false, reviews: [], problems: [...problems, 'no review found (each opens on "# Design review: {system}")'] };

  for (let i = 0; i < starts[0]; i++) if (lines[i].trim() !== "") problems.push(`line ${i + 1}: text before the first review ("${lines[i].trim().slice(0, 60)}")`);
  for (let i = 0; i < lines.length; i++) if (/^#\s/.test(lines[i].trim()) && !HEADING.test(lines[i].trim())) problems.push(`line ${i + 1}: unexpected top-level heading ("${lines[i].trim()}")`);

  const reviews = starts.map((s, k) => checkBlock(lines, s, starts[k + 1] ?? lines.length, problems, source));
  return { ok: problems.length === 0, noDesign: false, reviews, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const si = args.indexOf("--source");
  if (si >= 0 && (args[si + 1] === undefined || args[si + 1].startsWith("--"))) {
    console.error("--source needs a file path");
    process.exit(2);
  }
  const unknown = args.find((a) => a.startsWith("--") && a !== "--json" && a !== "--source");
  if (unknown) {
    console.error(`unknown flag ${unknown}\n\n${HELP}`);
    process.exit(2);
  }
  const src = args.find((a, i) => !a.startsWith("--") && !(si >= 0 && i === si + 1));
  let input: string;
  let source: string | undefined;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
    if (si >= 0) source = readFileSync(args[si + 1], "utf8");
  } catch (e) {
    console.error(`cannot read input: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input, source);
  if (json)
    console.log(
      JSON.stringify({
        ok: r.ok,
        noDesign: r.noDesign,
        reviews: r.reviews.map((v) => ({ system: v.system, verdict: v.verdict, worst: v.worst, changes: v.changes, findings: v.findings.length })),
        problems: r.problems,
      }),
    );
  else if (r.ok) console.log(r.noDesign ? "✓ no-design line, shape holds" : `✓ ${r.reviews.length} review(s), ${r.reviews.reduce((s, v) => s + v.findings.length, 0)} findings, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
