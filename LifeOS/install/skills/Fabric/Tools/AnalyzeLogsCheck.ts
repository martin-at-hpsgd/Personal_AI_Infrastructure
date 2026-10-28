#!/usr/bin/env bun
// AnalyzeLogsCheck — checks an AnalyzeLogs output against the parts of its
// contract code can judge: a Verdict line first, the three fixed sections in
// order, every finding numbered with Seen, Evidence and Impact lines, every
// recommendation tied to a finding that exists, no unmasked secret anywhere,
// and (with --log) every Evidence excerpt found verbatim on one line of the
// source log. Whether the diagnosis is right stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `AnalyzeLogsCheck — shape check for a Fabric AnalyzeLogs output

  bun skills/Fabric/Tools/AnalyzeLogsCheck.ts <file|-> [--log <logfile>] [--json]

  --log FILE  the analyzed log; every Evidence excerpt must appear on one of its lines
  --json      print {ok, findings, recommendations, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

const SECTIONS = ["Findings", "Reliability and performance", "Recommendations"] as const;
const OPTIONAL = new Set(["Limits"]);
const MASK = "[REDACTED]";

// Secret shapes that must never appear unmasked in the output. Generic by
// class (credential assignments, bearer tokens, well-known key prefixes, JWTs).
const SECRET_SHAPES: { name: string; re: RegExp }[] = [
  // `pwd` is left out on purpose: sudo and shells log `PWD=/home/user`, the working directory.
  { name: "credential assignment", re: /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[=:]\s*(?!\[REDACTED\])["']?[^\s"'&,;\[\]`]{4,}/i },
  { name: "bearer token", re: /\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+\/-]{16,}/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "provider API key", re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
];

export type Finding = { n: number; title: string; line: number; seen?: string; evidence: string[]; impact?: string };
export type Result = { ok: boolean; findings: Finding[]; recommendations: number; problems: string[] };

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** The excerpt's fragments (split on the mask and on elision) appear in order on one log line. */
export function inLog(excerpt: string, logLines: string[]): boolean {
  const frags = excerpt
    .split(/\[REDACTED\]|…|\.\.\./)
    .map(norm)
    .filter((f) => f.length > 0);
  if (frags.length === 0) return false;
  return logLines.some((raw) => {
    const line = norm(raw);
    let at = 0;
    for (const f of frags) {
      const i = line.indexOf(f, at);
      if (i < 0) return false;
      at = i + f.length;
    }
    return true;
  });
}

function spans(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

export function check(input: string, log?: string): Result {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const findings: Finding[] = [];
  let recommendations = 0;

  // Verdict first.
  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  if (firstIdx < 0) return { ok: false, findings, recommendations, problems: ["output is empty"] };
  if (!/^\*\*Verdict:\*\*\s+\S/.test(lines[firstIdx].trim())) problems.push(`line ${firstIdx + 1}: the output must open on "**Verdict:** <the answer>"`);

  // H2 sections.
  const h2: { name: string; line: number }[] = [];
  lines.forEach((l, i) => {
    const m = l.match(/^##\s+(.+?)\s*$/);
    if (m && !l.startsWith("###")) h2.push({ name: m[1], line: i });
  });
  for (const s of h2) if (!SECTIONS.includes(s.name as (typeof SECTIONS)[number]) && !OPTIONAL.has(s.name)) problems.push(`line ${s.line + 1}: unexpected section "## ${s.name}"`);
  const pos = SECTIONS.map((name) => h2.findIndex((s) => s.name === name));
  SECTIONS.forEach((name, i) => {
    if (pos[i] < 0) problems.push(`missing section "## ${name}"`);
    else if (h2.filter((s) => s.name === name).length > 1) problems.push(`section "## ${name}" appears more than once`);
  });
  if (pos.every((p) => p >= 0) && !(pos[0] < pos[1] && pos[1] < pos[2])) problems.push(`sections out of order; expected ${SECTIONS.map((s) => `## ${s}`).join(", then ")}`);
  const limits = h2.findIndex((s) => s.name === "Limits");
  if (limits >= 0 && pos[2] >= 0 && limits < pos[2]) problems.push(`"## Limits" must come after "## Recommendations"`);

  const body = (name: string): { start: number; end: number } | null => {
    const idx = h2.findIndex((s) => s.name === name);
    if (idx < 0) return null;
    return { start: h2[idx].line + 1, end: idx + 1 < h2.length ? h2[idx + 1].line : lines.length };
  };

  // Findings.
  const fb = body("Findings");
  if (fb) {
    const text = lines.slice(fb.start, fb.end);
    const nonEmpty = text.filter((l) => l.trim() !== "");
    const none = nonEmpty.length > 0 && /^none\b/i.test(nonEmpty[0].trim());
    let cur: Finding | null = null;
    text.forEach((l, k) => {
      const ln = fb.start + k + 1;
      const h = l.match(/^###\s+(\d+)\.\s+(\S.*)$/);
      if (h) {
        cur = { n: Number(h[1]), title: h[2].trim(), line: ln, evidence: [] };
        findings.push(cur);
        return;
      }
      if (!cur) return;
      const f: Finding = cur;
      const field = l.match(/^\s*[-*]\s+(Seen|Evidence|Impact|Cause):\s*(.*)$/);
      if (!field) return;
      const [, key, val] = field;
      if (key === "Seen") f.seen = val.trim();
      if (key === "Impact") f.impact = val.trim();
      if (key === "Evidence") {
        const s = spans(val);
        if (s.length === 0) problems.push(`line ${ln}: finding ${f.n} Evidence has no \`quoted log line\``);
        f.evidence.push(...s);
      }
    });
    if (findings.length === 0 && !none) problems.push(`"## Findings" has no "### 1. <finding>" entries and does not say "None."`);
    if (findings.length > 0 && none) problems.push(`"## Findings" says "None." but also lists findings`);
    findings.forEach((f, i) => {
      if (f.n !== i + 1) problems.push(`line ${f.line}: finding numbered ${f.n}, expected ${i + 1}`);
      if (!f.seen) problems.push(`line ${f.line}: finding ${f.n} has no "- Seen:" line`);
      // A count is a number followed by × or a counted noun ("14×", "2 warnings", "40 failed"),
      // never a timestamp fragment followed by a preposition ("Mar 2 from …").
      else if (!/\b\d[\d,]*\s*(?:×|x\b|(?!(?:from|and|until|through|between|at|on|to)\b)[A-Za-z]{3,})|\bonce\b|\btwice\b/i.test(f.seen))
        problems.push(`line ${f.line}: finding ${f.n} "Seen:" gives no count ("${f.seen}")`);
      if (f.evidence.length === 0) problems.push(`line ${f.line}: finding ${f.n} has no "- Evidence:" line quoting the log`);
      if (!f.impact) problems.push(`line ${f.line}: finding ${f.n} has no "- Impact:" line`);
    });
  }

  // Reliability and performance must say something.
  const rb = body("Reliability and performance");
  if (rb && lines.slice(rb.start, rb.end).every((l) => l.trim() === "")) problems.push(`"## Reliability and performance" is empty`);

  // Recommendations: numbered 1..n, each tied to an existing finding.
  const recb = body("Recommendations");
  if (recb) {
    const text = lines.slice(recb.start, recb.end);
    // An item runs from its "N." line to the next one, so a finding named on
    // a continuation line (an indented sub-list, a wrapped paragraph) counts.
    const items: { n: number; text: string; line: number }[] = [];
    text.forEach((l, k) => {
      const m = l.match(/^(\d+)\.\s+(\S.*)$/);
      if (m) items.push({ n: Number(m[1]), text: m[2], line: recb.start + k + 1 });
      else if (items.length > 0) items[items.length - 1].text += "\n" + l;
    });
    recommendations = items.length;
    const nonEmpty = text.filter((l) => l.trim() !== "");
    const none = nonEmpty.length > 0 && /^none\b/i.test(nonEmpty[0].trim());
    if (items.length === 0 && !none) problems.push(`"## Recommendations" has no numbered items and does not say "None."`);
    if (items.length === 0 && none && findings.length > 0) problems.push(`"## Recommendations" says "None." but there are ${findings.length} findings`);
    const known = new Set(findings.map((f) => f.n));
    items.forEach((it, i) => {
      if (it.n !== i + 1) problems.push(`line ${it.line}: recommendation numbered ${it.n}, expected ${i + 1}`);
      const ref = it.text.match(/\(findings?\s+([\d,\s and&]+)\)/i);
      if (!ref) {
        // With no findings, a recommendation improves the next log and has no finding to name.
        if (findings.length === 0) return;
        problems.push(`line ${it.line}: recommendation ${it.n} names no finding, e.g. "(finding 1)"`);
        return;
      }
      for (const n of ref[1].match(/\d+/g) ?? []) if (!known.has(Number(n))) problems.push(`line ${it.line}: recommendation ${it.n} names finding ${n}, which does not exist`);
    });
  }

  // No unmasked secret anywhere in the output.
  lines.forEach((l, i) => {
    for (const s of SECRET_SHAPES) if (s.re.test(l)) problems.push(`line ${i + 1}: unmasked ${s.name}; replace the value with ${MASK}`);
  });

  // Evidence is verbatim from the log.
  if (log !== undefined) {
    const logLines = log.replace(/\r\n/g, "\n").split("\n");
    for (const f of findings) for (const e of f.evidence) if (!inLog(e, logLines)) problems.push(`finding ${f.n}: Evidence \`${e.length > 80 ? e.slice(0, 77) + "..." : e}\` is not on any line of the log`);
  }

  return { ok: problems.length === 0, findings, recommendations, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const li = args.indexOf("--log");
  if (li >= 0 && (args[li + 1] === undefined || args[li + 1].startsWith("--"))) {
    console.error("--log needs a file path");
    process.exit(2);
  }
  const src = args.find((a, i) => !a.startsWith("--") && !(li >= 0 && i === li + 1));
  let input: string;
  let log: string | undefined;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
    if (li >= 0) log = readFileSync(args[li + 1], "utf8");
  } catch (e) {
    console.error(`cannot read input: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input, log);
  if (json) console.log(JSON.stringify({ ok: r.ok, findings: r.findings.map((f) => ({ n: f.n, title: f.title, evidence: f.evidence.length })), recommendations: r.recommendations, problems: r.problems }));
  else if (r.ok) console.log(`✓ ${r.findings.length} findings, ${r.recommendations} recommendations, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
