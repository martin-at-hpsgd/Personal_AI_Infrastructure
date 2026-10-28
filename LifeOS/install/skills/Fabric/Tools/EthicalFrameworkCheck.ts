#!/usr/bin/env bun
// EthicalFrameworkCheck — checks an EthicalFramework output against the parts
// of its contract code can judge: the nine sections in order, the six parts of
// the implicit framework, quoted explicit claims when a text was supplied, every
// verdict on its fixed values with a reason, the hidden-coercion table, a
// numbered key-concerns list, no template placeholders, and an overall
// assessment that does not contradict the verdicts above it. Fidelity to the
// text and the soundness of each finding stay judged checks.

import { readFileSync } from "node:fs";

const HELP = `EthicalFrameworkCheck — shape check for a Fabric EthicalFramework output

  bun skills/Fabric/Tools/EthicalFrameworkCheck.ts <file|-> [--json]

  --json      print {ok, noPrescriptive, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const SECTIONS = [
  "Document analyzed",
  "Explicit ethical claims",
  "Implicit ethical framework",
  "Internal consistency",
  "Minimal ethics evaluation",
  "Hidden coercion",
  "Overall assessment",
  "Key concerns",
  "Recommendations",
] as const;

export const FRAMEWORK_PARTS = ["Moral patients", "Harm", "Consent", "Authority", "Coercion", "Value hierarchy"] as const;

type Verdict = { label: string; values: readonly string[]; reason: boolean };

export const CONSISTENCY: Verdict[] = [
  { label: "Principles compatible", values: ["Holds", "Fails"], reason: true },
  { label: "Exceptions contained", values: ["Holds", "Fails"], reason: true },
  { label: "Applies to itself", values: ["Holds", "Fails"], reason: true },
  { label: "Terms used consistently", values: ["Holds", "Fails"], reason: true },
];

export const MINIMAL: Verdict[] = [
  { label: "Unwilling victims", values: ["Yes", "No", "Unclear"], reason: true },
  { label: "Harm conflated with discomfort", values: ["Yes", "No", "Unclear"], reason: true },
  { label: "Falsifiable", values: ["Yes", "Partially", "No"], reason: true },
  { label: "Challengeable by those bound", values: ["Yes", "Limited", "No"], reason: true },
  { label: "Authority beyond what it can justify", values: ["Yes", "No"], reason: true },
];

export const OVERALL: Verdict[] = [
  { label: "Framework type", values: ["Consequentialist", "Deontological", "Virtue-based", "Rights-based", "Authority-based", "Mixed"], reason: false },
  { label: "Coherence", values: ["Highly coherent", "Mostly coherent", "Contains tensions", "Internally contradictory"], reason: false },
  { label: "Minimal ethics compliance", values: ["Compliant", "Mostly compliant", "Significant violations", "Fundamentally incompatible"], reason: false },
];

const PLACEHOLDER = /\{[^}\n]*\}|\b(?:Holds \| Fails|Yes \| No)\b/;
const QUOTE_OPEN = /^["“]/;
const NONE_FOUND = /^None found\.?$/;

type Line = { text: string; line: number };

// "Value: reason", "Value — reason" or "Value - reason"; returns the value
// matched and whether a reason follows it.
export function parseVerdict(raw: string, values: readonly string[]): { value: string | null; reason: string } {
  const v = raw.trim();
  const sorted = [...values].sort((a, b) => b.length - a.length);
  for (const val of sorted) {
    if (!v.startsWith(val)) continue;
    let rest = v.slice(val.length);
    if (val === "Mixed") {
      const m = rest.match(/^\s*\(([^)]*)\)/);
      if (!m || m[1].trim() === "") return { value: null, reason: "" };
      rest = rest.slice(m[0].length);
    }
    if (rest.trim() === "" || /^\.\s*$/.test(rest)) return { value: val, reason: "" };
    const sep = rest.match(/^\s*(?::|—|–|-)\s*(.*)$/);
    if (sep) return { value: val, reason: sep[1].trim() };
    return { value: null, reason: "" };
  }
  return { value: null, reason: "" };
}

function fieldLines(body: Line[]): Map<string, Line & { value: string }> {
  const out = new Map<string, Line & { value: string }>();
  for (const l of body) {
    const m = l.text.match(/^- \*\*([^*]+?):\*\*\s*(.*)$/);
    if (m && !out.has(m[1].trim())) out.set(m[1].trim(), { ...l, value: m[2].trim() });
  }
  return out;
}

function checkVerdicts(body: Line[], spec: Verdict[], section: string, problems: string[]): Map<string, string> {
  const fields = fieldLines(body);
  const found = new Map<string, string>();
  let lastIdx = -1;
  for (const v of spec) {
    const f = fields.get(v.label);
    if (!f) { problems.push(`${section} is missing "${v.label}"`); continue; }
    const count = body.filter((l) => l.text.startsWith(`- **${v.label}:**`)).length;
    if (count > 1) problems.push(`${section} has "${v.label}" ${count} times`);
    const idx = body.indexOf(body.find((l) => l.line === f.line)!);
    if (idx < lastIdx) problems.push(`line ${f.line}: "${v.label}" is out of order in ${section}`);
    lastIdx = idx;
    const p = parseVerdict(f.value, v.values);
    if (!p.value) { problems.push(`line ${f.line}: "${v.label}" must open on one of ${v.values.join(", ")} (found "${f.value.slice(0, 40)}")`); continue; }
    if (v.reason && p.reason === "") problems.push(`line ${f.line}: "${v.label}: ${p.value}" gives no reason`);
    found.set(v.label, p.value);
  }
  const labels = new Set(spec.map((v) => v.label));
  for (const l of body) {
    const m = l.text.match(/^- \*\*([^*]+?):\*\*/);
    if (m && !labels.has(m[1].trim())) problems.push(`line ${l.line}: unknown field "${m[1].trim()}" in ${section}`);
  }
  return found;
}

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

export function check(input: string): { ok: boolean; noPrescriptive: boolean; problems: string[] } {
  const text = input.replace(/\r\n/g, "\n").trim();
  const problems: string[] = [];

  if (/^\*\*No prescriptive content:\*\*/.test(text)) {
    if (text.replace(/^\*\*No prescriptive content:\*\*/, "").trim() === "") problems.push("the no-prescriptive-content line says nothing about what the text is");
    if (text.includes("\n")) problems.push("a no-prescriptive-content output is one line only");
    return { ok: problems.length === 0, noPrescriptive: true, problems };
  }

  const lines: Line[] = text.split("\n").map((t, i) => ({ text: t, line: i + 1 }));
  const ph = lines.find((l) => PLACEHOLDER.test(l.text));
  if (ph) problems.push(`line ${ph.line}: template placeholder left in the output ("${ph.text.trim().slice(0, 60)}")`);

  const heads = lines.filter((l) => /^## /.test(l.text));
  if (heads.length === 0) return { ok: false, noPrescriptive: false, problems: [...problems, 'no sections found (the analysis opens on "## Document analyzed")'] };
  if (lines.slice(0, heads[0].line - 1).some((l) => l.text.trim() !== "")) problems.push("text before the first section; the output is the analysis only");

  const names = heads.map((h) => h.text.slice(3).trim());
  for (const n of names) if (!(SECTIONS as readonly string[]).includes(n)) problems.push(`unknown section "## ${n}"`);
  for (const s of SECTIONS) {
    const c = names.filter((n) => n === s).length;
    if (c === 0) problems.push(`missing section "## ${s}"`);
    if (c > 1) problems.push(`section "## ${s}" appears ${c} times`);
  }
  const known = names.filter((n) => (SECTIONS as readonly string[]).includes(n));
  if (new Set(known).size === known.length && known.join("|") !== SECTIONS.filter((s) => known.includes(s)).join("|")) problems.push("sections are out of order");

  const body = (name: string): Line[] => {
    const h = heads.find((x) => x.text.slice(3).trim() === name);
    if (!h) return [];
    const next = heads.find((x) => x.line > h.line);
    return lines.slice(h.line, next ? next.line - 1 : lines.length).filter((l) => l.text.trim() !== "");
  };
  const empty = (name: string, b: Line[]) => {
    if (names.includes(name) && b.length === 0) problems.push(`section "## ${name}" is empty`);
  };

  // Document analyzed: a description, then optional Source and Answer lines.
  const doc = body("Document analyzed");
  empty("Document analyzed", doc);
  const source = doc.filter((l) => /^\*\*Source:\*\*/.test(l.text));
  const answer = doc.filter((l) => /^\*\*Answer:\*\*/.test(l.text));
  if (source.length > 1) problems.push("more than one Source line");
  if (answer.length > 1) problems.push("more than one Answer line");
  for (const l of [...source, ...answer]) if (l.text.replace(/^\*\*(?:Source|Answer):\*\*/, "").trim() === "") problems.push(`line ${l.line}: empty ${l.text.startsWith("**Source") ? "Source" : "Answer"} line`);
  if (names.includes("Document analyzed") && doc.filter((l) => !source.includes(l) && !answer.includes(l)).length === 0) problems.push("Document analyzed has no description of the text");

  // Explicit claims: bullets, each opening on its quotation when a text was supplied.
  const claims = body("Explicit ethical claims");
  empty("Explicit ethical claims", claims);
  if (!(claims.length === 1 && /^None stated\.?$/.test(claims[0].text.trim()))) {
    for (const l of claims) {
      const m = l.text.match(/^- (.*\S)$/);
      if (!m) { problems.push(`line ${l.line}: explicit claims are bullets ("${l.text.trim().slice(0, 50)}")`); continue; }
      if (source.length === 0 && !QUOTE_OPEN.test(m[1])) problems.push(`line ${l.line}: explicit claim does not open on a quotation from the text`);
    }
  }

  // Implicit framework: the six parts, in order, none empty.
  const implicit = body("Implicit ethical framework");
  const parts = implicit.filter((l) => /^### /.test(l.text));
  const partNames = parts.map((p) => p.text.slice(4).trim());
  if (names.includes("Implicit ethical framework")) {
    for (const p of FRAMEWORK_PARTS) if (!partNames.includes(p)) problems.push(`Implicit ethical framework is missing "### ${p}"`);
    for (const p of partNames) if (!(FRAMEWORK_PARTS as readonly string[]).includes(p)) problems.push(`unknown part "### ${p}" in Implicit ethical framework`);
    const knownParts = partNames.filter((p) => (FRAMEWORK_PARTS as readonly string[]).includes(p));
    if (new Set(knownParts).size === knownParts.length && knownParts.join("|") !== FRAMEWORK_PARTS.filter((p) => knownParts.includes(p)).join("|")) problems.push("Implicit ethical framework parts are out of order");
    parts.forEach((p, i) => {
      const end = i + 1 < parts.length ? parts[i + 1].line : Infinity;
      if (!implicit.some((l) => l.line > p.line && l.line < end)) problems.push(`line ${p.line}: "${p.text.slice(4).trim()}" is empty`);
    });
    if (implicit.length && parts.length && implicit[0].line < parts[0].line) problems.push(`line ${implicit[0].line}: text before the first part of the implicit framework`);
  }

  // Internal consistency: four verdicts and the contradictions line.
  const cons = body("Internal consistency");
  const cv = names.includes("Internal consistency") ? checkVerdicts(cons, CONSISTENCY, "Internal consistency", problems) : new Map();
  const contra = cons.find((l) => /^\*\*Contradictions:\*\*/.test(l.text));
  let contradictions = false;
  if (names.includes("Internal consistency")) {
    if (!contra) problems.push('Internal consistency has no "**Contradictions:**" line');
    else {
      const v = contra.text.replace(/^\*\*Contradictions:\*\*/, "").trim();
      const listed = cons.some((l) => l.line > contra.line && /^\s*[-\d]/.test(l.text));
      if (v === "" && !listed) problems.push(`line ${contra.line}: Contradictions is empty; write "None found" when there are none`);
      contradictions = !NONE_FOUND.test(v) && (v !== "" || listed);
      if (!contradictions && (cv.get("Principles compatible") === "Fails" || cv.get("Applies to itself") === "Fails")) problems.push(`line ${contra.line}: a principle fails but Contradictions says none were found`);
      if (contradictions && [...cv.values()].every((x) => x === "Holds") && cv.size === CONSISTENCY.length) problems.push(`line ${contra.line}: contradictions are listed but every consistency check holds`);
    }
  }

  // Minimal ethics: five verdicts.
  const mv = names.includes("Minimal ethics evaluation") ? checkVerdicts(body("Minimal ethics evaluation"), MINIMAL, "Minimal ethics evaluation", problems) : new Map();

  // Hidden coercion: "None found." or a three-column table ending in Yes/No.
  const hc = body("Hidden coercion");
  empty("Hidden coercion", hc);
  let unjustified = 0;
  if (hc.length && !(hc.length === 1 && NONE_FOUND.test(hc[0].text.trim()))) {
    const rows = hc.filter((l) => /^\s*\|/.test(l.text));
    for (const l of hc) if (!/^\s*\|/.test(l.text)) problems.push(`line ${l.line}: Hidden coercion holds the table or "None found." only`);
    if (rows.length < 3) problems.push('Hidden coercion table needs a header, a separator and at least one row (or the line "None found.")');
    else {
      const head = cells(rows[0].text).map((c) => c.toLowerCase());
      if (head.length !== 3 || head[0] !== "coercion point" || head[1] !== "justification given" || head[2] !== "victim identified") problems.push(`line ${rows[0].line}: Hidden coercion header is not | Coercion point | Justification given | Victim identified |`);
      if (!cells(rows[1].text).every((c) => /^:?-{3,}:?$/.test(c))) problems.push(`line ${rows[1].line}: table separator row is malformed`);
      for (const r of rows.slice(2)) {
        const c = cells(r.text);
        if (c.length !== 3) { problems.push(`line ${r.line}: coercion row has ${c.length} cells, not 3`); continue; }
        if (c[0] === "" || c[1] === "") problems.push(`line ${r.line}: coercion row has an empty cell`);
        const v = c[2].match(/^(Yes|No)\b/);
        if (!v) problems.push(`line ${r.line}: Victim identified is "${c[2]}", not Yes or No`);
        else if (v[1] === "No") unjustified++;
      }
    }
  }

  // Overall assessment: three fixed-value fields that follow from the findings.
  const ov = body("Overall assessment");
  const av = names.includes("Overall assessment") ? checkVerdicts(ov, OVERALL, "Overall assessment", problems) : new Map();
  if (av.get("Coherence") === "Highly coherent" && contradictions) problems.push('Coherence is "Highly coherent" but contradictions are listed');
  if (av.get("Minimal ethics compliance") === "Compliant") {
    if (unjustified > 0) problems.push(`Minimal ethics compliance is "Compliant" but ${unjustified} coercion point(s) have no victim identified`);
    if (mv.get("Unwilling victims") === "Yes") problems.push('Minimal ethics compliance is "Compliant" but the framework creates unwilling victims');
  }

  // Key concerns: "None found." or a numbered list from 1; Recommendations: "None needed." or bullets.
  const kc = body("Key concerns");
  empty("Key concerns", kc);
  if (kc.length && !(kc.length === 1 && NONE_FOUND.test(kc[0].text.trim()))) {
    let n = 0;
    for (const l of kc) {
      const m = l.text.match(/^(\d+)\.\s+\S/);
      if (!m) { if (!/^\s{2,}\S/.test(l.text)) problems.push(`line ${l.line}: Key concerns are a numbered list ("${l.text.trim().slice(0, 50)}")`); continue; }
      n++;
      if (Number(m[1]) !== n) problems.push(`line ${l.line}: concern numbered ${m[1]}, expected ${n}`);
    }
  }
  const rec = body("Recommendations");
  empty("Recommendations", rec);
  if (rec.length && !(rec.length === 1 && /^None needed\.?$/.test(rec[0].text.trim()))) {
    for (const l of rec) if (!/^(?:- |\s{2,}\S)/.test(l.text)) problems.push(`line ${l.line}: Recommendations are bullets ("${l.text.trim().slice(0, 50)}")`);
  }

  return { ok: problems.length === 0, noPrescriptive: false, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const unknown = args.find((a) => a.startsWith("--") && a !== "--json");
  if (unknown) {
    console.error(`unknown flag ${unknown}`);
    process.exit(2);
  }
  const json = args.includes("--json");
  const src = args.find((a) => !a.startsWith("--"));
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input);
  if (json) console.log(JSON.stringify({ ok: r.ok, noPrescriptive: r.noPrescriptive, problems: r.problems }));
  else if (r.ok) console.log(r.noPrescriptive ? "\x1b[32m✓\x1b[0m no-prescriptive-content line, shape holds" : "\x1b[32m✓\x1b[0m ethical framework analysis, shape holds");
  else for (const p of r.problems) console.log(`\x1b[31m✗\x1b[0m ${p}`);
  process.exit(r.ok ? 0 : 1);
}
