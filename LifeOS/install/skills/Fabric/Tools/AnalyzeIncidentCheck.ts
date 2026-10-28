#!/usr/bin/env bun
// AnalyzeIncidentCheck — checks an AnalyzeIncident output against the parts of
// its contract code can judge: one block per incident opening on
// "## Incident:", a one-sentence-sized Summary, every Reported facts field
// present once and in order, a real attack date (or "Not stated"), CVE IDs in
// CVE-YYYY-NNNN form, ATT&CK technique IDs in T#### or T####.### form, Atomic
// Red Team entries drawn only from the ATT&CK list, a numbered action plan, no
// template placeholders, a one-sentence Summary and Business impact. Fidelity to the source stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `AnalyzeIncidentCheck — shape check for a Fabric AnalyzeIncident output

  bun skills/Fabric/Tools/AnalyzeIncidentCheck.ts <file|-> [--json]

  --json      print {ok, incidents, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const FACT_FIELDS = [
  "Attack date",
  "Attack type",
  "Vulnerable component",
  "Attacker",
  "Attacker origin",
  "Target",
  "Target country",
  "Target size",
  "Industry",
  "CVEs",
  "Accounts compromised",
  "Business impact",
  "Root cause",
] as const;

export const ANALYSIS_FIELDS = [
  "ATT&CK techniques",
  "Atomic Red Team tests",
  "Remediation",
  "Action plan",
  "Lessons learned",
] as const;

const NO_DETAIL = /^Not enough detail in the source\.?$/;
// Enterprise and Mobile IDs are T1xxx with optional .xxx sub-techniques; ICS IDs are T08xx.
const TECHNIQUE = /^T(?:1\d{3}(?:\.\d{3})?|0[89]\d{2})$/;
const CVE = /^CVE-(?:199\d|20\d{2})-\d{4,7}$/;
const PLACEHOLDER = /\{[^}]*\}|\bYYYY\b|\bNNNN\b|\be\.g\.,? Ransomware\b/;

type Field = { name: string; value: string; line: number; children: { text: string; line: number }[] };
export type Incident = { title: string; line: number; facts: Field[]; analysis: Field[] };

export function validDate(value: string): boolean {
  const m = value.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), m[2] ? Number(m[2]) : 1, m[3] ? Number(m[3]) : 1];
  if (y < 1970 || y > 2100 || mo < 1 || mo > 12) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function attackDateProblem(value: string): string | null {
  if (validDate(value)) return null;
  if (value === "Not stated") return null;
  const disclosed = value.match(/^Not stated \(disclosed (\S+?)\)$/);
  if (disclosed) return validDate(disclosed[1]) ? null : `disclosure date "${disclosed[1]}" is not a real YYYY-MM-DD, YYYY-MM or YYYY date`;
  const range = value.match(/^(\S+) to (\S+)$/);
  if (range && validDate(range[1]) && validDate(range[2])) return range[1] <= range[2] ? null : `date range "${value}" runs backwards`;
  return `attack date "${value}" is not YYYY-MM-DD, YYYY-MM, YYYY, a "<date> to <date>" range, "Not stated" or "Not stated (disclosed YYYY-MM-DD)"`;
}

// Sentence count, ignoring the dot in an abbreviation or initialism (U.S., Inc.).
export function sentences(text: string): number {
  const toks = text.trim().split(/\s+/);
  let n = 1;
  for (let i = 0; i < toks.length - 1; i++) {
    const t = toks[i];
    if (!/[.!?]["')\]]*$/.test(t) || !/^["'(]?[A-Z]/.test(toks[i + 1])) continue;
    if (/^(?:[A-Za-z]\.)+$/.test(t) || /^(?:Inc|Ltd|Co|Corp|St|Mr|Ms|Dr|No|vs|approx)\.$/i.test(t)) continue;
    n++;
  }
  return n;
}

function words(text: string): number {
  return text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

// Parse the "- **Name:** value" fields of one section, with their indented
// sub-bullets or numbered steps as children.
function parseFields(lines: { text: string; line: number }[], problems: string[], where: string): Field[] {
  const fields: Field[] = [];
  for (const { text, line } of lines) {
    if (text.trim() === "") continue;
    const top = text.match(/^- \*\*([^*]+?):\*\*\s*(.*)$/);
    if (top) {
      fields.push({ name: top[1].trim(), value: top[2].trim(), line, children: [] });
      continue;
    }
    const child = text.match(/^\s{2,}(?:-|\d+\.)\s+\S/);
    if (child && fields.length > 0) {
      fields[fields.length - 1].children.push({ text: text.trim(), line });
      continue;
    }
    problems.push(`line ${line}: unexpected line in ${where} ("${text.trim().slice(0, 60)}")`);
  }
  return fields;
}

function checkFieldOrder(fields: Field[], want: readonly string[], section: string, problems: string[], at: number) {
  const names = fields.map((f) => f.name);
  for (const w of want) {
    const n = names.filter((x) => x === w).length;
    if (n === 0) problems.push(`incident at line ${at}: ${section} is missing "${w}"`);
    if (n > 1) problems.push(`incident at line ${at}: ${section} has "${w}" ${n} times`);
  }
  for (const f of fields) if (!want.includes(f.name)) problems.push(`line ${f.line}: unknown field "${f.name}" in ${section}`);
  const present = names.filter((x) => want.includes(x));
  const expectedOrder = want.filter((w) => present.includes(w));
  if (present.join("|") !== expectedOrder.join("|") && new Set(present).size === present.length) problems.push(`incident at line ${at}: ${section} fields are out of order`);
}

export function check(input: string): { ok: boolean; incidents: Incident[]; noIncident: boolean; problems: string[] } {
  const text = input.replace(/\r\n/g, "\n").trim();
  const problems: string[] = [];

  if (/^\*\*No incident reported:\*\*/.test(text)) {
    const rest = text.replace(/^\*\*No incident reported:\*\*/, "").trim();
    if (rest === "") problems.push("the no-incident line says nothing about what the source is");
    if (text.includes("\n")) problems.push("a no-incident output is one line only");
    return { ok: problems.length === 0, incidents: [], noIncident: true, problems };
  }

  const lines = text.split("\n").map((t, i) => ({ text: t, line: i + 1 }));
  const starts = lines.filter((l) => /^## Incident:/.test(l.text));
  if (starts.length === 0) return { ok: false, incidents: [], noIncident: false, problems: ['no incident block found (each opens on "## Incident: {target}, {attack type}")'] };
  if (lines.slice(0, starts[0].line - 1).some((l) => l.text.trim() !== "")) problems.push("text before the first incident heading; the output is the record only");

  const ph = lines.find((l) => PLACEHOLDER.test(l.text));
  if (ph) problems.push(`line ${ph.line}: template placeholder left in the output ("${ph.text.trim().slice(0, 60)}")`);

  const incidents: Incident[] = [];
  starts.forEach((start, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1].line - 1 : lines.length;
    const block = lines.slice(start.line, end); // lines after the heading
    const title = start.text.replace(/^## Incident:\s*/, "").trim();
    if (title === "") problems.push(`line ${start.line}: incident heading names nothing`);

    const factsAt = block.findIndex((l) => l.text.trim() === "### Reported facts");
    const analysisAt = block.findIndex((l) => l.text.trim() === "### Analysis");
    if (factsAt < 0) problems.push(`incident at line ${start.line}: no "### Reported facts" section`);
    if (analysisAt < 0) problems.push(`incident at line ${start.line}: no "### Analysis" section`);
    if (factsAt >= 0 && analysisAt >= 0 && analysisAt < factsAt) problems.push(`incident at line ${start.line}: Analysis comes before Reported facts`);

    const head = block.slice(0, factsAt >= 0 ? factsAt : block.length).filter((l) => l.text.trim() !== "");
    const summary = head.find((l) => /^\*\*Summary:\*\*/.test(l.text));
    if (!summary) problems.push(`incident at line ${start.line}: no "**Summary:**" line before the facts`);
    else {
      const s = summary.text.replace(/^\*\*Summary:\*\*/, "").trim();
      if (s === "") problems.push(`line ${summary.line}: Summary is empty`);
      else if (sentences(s) > 1) problems.push(`line ${summary.line}: Summary has ${sentences(s)} sentences; it is one`);
      else if (words(s) > 60) problems.push(`line ${summary.line}: Summary runs ${words(s)} words; it is one sentence`);
    }
    for (const l of head) if (l !== summary) problems.push(`line ${l.line}: unexpected line between heading and facts ("${l.text.trim().slice(0, 60)}")`);

    const factsEnd = analysisAt > factsAt ? analysisAt : block.length;
    const facts = factsAt >= 0 ? parseFields(block.slice(factsAt + 1, factsEnd), problems, "Reported facts") : [];
    let analysisLines = analysisAt >= 0 ? block.slice(analysisAt + 1, analysisAt > factsAt ? block.length : factsAt) : [];
    // An optional trailing **Sources:** line ends the analysis section.
    const sourcesIdx = analysisLines.findIndex((l) => /^\*\*Sources:\*\*/.test(l.text));
    if (sourcesIdx >= 0) {
      const src = analysisLines[sourcesIdx];
      if (src.text.replace(/^\*\*Sources:\*\*/, "").trim() === "") problems.push(`line ${src.line}: Sources line is empty`);
      for (const l of analysisLines.slice(sourcesIdx + 1)) if (l.text.trim() !== "") problems.push(`line ${l.line}: text after the Sources line`);
      analysisLines = analysisLines.slice(0, sourcesIdx);
    }
    const analysis = analysisAt >= 0 ? parseFields(analysisLines, problems, "Analysis") : [];

    if (factsAt >= 0) checkFieldOrder(facts, FACT_FIELDS, "Reported facts", problems, start.line);
    if (analysisAt >= 0) checkFieldOrder(analysis, ANALYSIS_FIELDS, "Analysis", problems, start.line);

    for (const f of facts) {
      if (f.value === "") problems.push(`line ${f.line}: "${f.name}" is empty; write "Not stated" when the source does not say`);
      if (f.children.length) problems.push(`line ${f.line}: "${f.name}" has sub-bullets; facts are one line each`);
      if (f.name === "Business impact" && f.value && sentences(f.value) > 1) problems.push(`line ${f.line}: Business impact has ${sentences(f.value)} sentences; it is one`);
      if (f.name === "Attack date" && f.value) {
        const p = attackDateProblem(f.value);
        if (p) problems.push(`line ${f.line}: ${p}`);
      }
      // "None" (optionally with the source's words in parentheses) records an explicit negative.
      if (f.name === "CVEs" && f.value && f.value !== "Not stated" && !/^None(?: \([^)]+\))?\.?$/.test(f.value)) {
        const ids = f.value.split(/\s*,\s*/);
        for (const id of ids) if (!CVE.test(id)) problems.push(`line ${f.line}: "${id}" is not a CVE ID (CVE-YYYY-NNNN)`);
        const dup = ids.find((id, i) => ids.indexOf(id) !== i);
        if (dup) problems.push(`line ${f.line}: ${dup} is listed twice`);
      }
    }

    const get = (name: string) => analysis.find((f) => f.name === name);
    const techniques = new Set<string>();
    const attack = get("ATT&CK techniques");
    if (attack) {
      if (NO_DETAIL.test(attack.value)) {
        if (attack.children.length) problems.push(`line ${attack.line}: "Not enough detail" with techniques listed under it`);
      } else if (attack.value !== "") problems.push(`line ${attack.line}: ATT&CK techniques go on sub-bullets, or the field reads "Not enough detail in the source"`);
      else if (attack.children.length === 0) problems.push(`line ${attack.line}: no ATT&CK techniques listed`);
      for (const c of attack.children) {
        const m = c.text.match(/^-\s+(T\S+?)\s+(.+?):\s+(\S.*)$/);
        if (!m) { problems.push(`line ${c.line}: technique line is not "- T#### Name: reported behavior"`); continue; }
        if (!TECHNIQUE.test(m[1])) problems.push(`line ${c.line}: "${m[1]}" is not an ATT&CK technique ID (T1### or T1###.### for Enterprise, T08## for ICS)`);
        else if (techniques.has(m[1])) problems.push(`line ${c.line}: ${m[1]} is listed twice`);
        techniques.add(m[1]);
      }
    }
    const atomic = get("Atomic Red Team tests");
    if (atomic) {
      if (NO_DETAIL.test(atomic.value) || /^None\.?$/.test(atomic.value)) {
        if (atomic.children.length) problems.push(`line ${atomic.line}: "${atomic.value}" with tests listed under it`);
      } else if (atomic.value !== "") problems.push(`line ${atomic.line}: Atomic Red Team tests go on sub-bullets, or the field reads "Not enough detail in the source"`);
      else if (atomic.children.length === 0) problems.push(`line ${atomic.line}: no Atomic Red Team tests listed`);
      for (const c of atomic.children) {
        const m = c.text.match(/^-\s+(T\S+?):\s+(\S.*)$/);
        if (!m) { problems.push(`line ${c.line}: atomic line is not "- T####: what it would show"`); continue; }
        if (!TECHNIQUE.test(m[1])) problems.push(`line ${c.line}: "${m[1]}" is not an ATT&CK technique ID`);
        else if (!techniques.has(m[1])) problems.push(`line ${c.line}: ${m[1]} has atomics listed but is not in the ATT&CK techniques`);
      }
    }
    for (const name of ["Remediation", "Lessons learned"]) {
      const f = get(name);
      if (f && f.value === "") problems.push(`line ${f.line}: "${name}" is empty`);
    }
    const plan = get("Action plan");
    if (plan) {
      if (plan.value !== "") problems.push(`line ${plan.line}: Action plan steps go on numbered lines under the field`);
      const steps = plan.children.map((c) => ({ ...c, m: c.text.match(/^(\d+)\.\s+\S/) }));
      if (steps.length < 2) problems.push(`line ${plan.line}: Action plan has ${steps.length} step(s); it needs at least 2`);
      steps.forEach((s, i) => {
        if (!s.m) problems.push(`line ${s.line}: Action plan step is not a numbered line`);
        else if (Number(s.m[1]) !== i + 1) problems.push(`line ${s.line}: Action plan step numbered ${s.m[1]}, expected ${i + 1}`);
      });
    }

    incidents.push({ title, line: start.line, facts, analysis });
  });

  return { ok: problems.length === 0, incidents, noIncident: false, problems };
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
  if (json) console.log(JSON.stringify({ ok: r.ok, noIncident: r.noIncident, incidents: r.incidents.map((i) => ({ title: i.title, line: i.line })), problems: r.problems }));
  else if (r.ok) console.log(r.noIncident ? "\x1b[32m✓\x1b[0m no-incident line, shape holds" : `\x1b[32m✓\x1b[0m ${r.incidents.length} incident record(s), shape holds`);
  else for (const p of r.problems) console.log(`\x1b[31m✗\x1b[0m ${p}`);
  process.exit(r.ok ? 0 : 1);
}
