#!/usr/bin/env bun
// CheckFalsifiabilityCheck — checks a CheckFalsifiability output against the
// parts of its contract code can judge: one "# Falsifiability Check:" title,
// the seven H2 sections in order, claims numbered 1..N matching one analysis
// block each with valid verdict and precision values, the four Kafka trap
// lines with evidence on every checked box, an overall rating consistent with
// the verdicts, and a test and a quoted rewrite for every claim that is not
// Yes. Whether a verdict is fair stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `CheckFalsifiabilityCheck — shape check for a Fabric CheckFalsifiability output

  bun skills/Fabric/Tools/CheckFalsifiabilityCheck.ts <file|-> [--json]

  --json  print {ok, claims, rating, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const SECTIONS = [
  "CLAIMS IDENTIFIED",
  "FALSIFIABILITY ANALYSIS",
  "KAFKA TRAP CHECK",
  "OVERALL FALSIFIABILITY RATING",
  "RISK ASSESSMENT",
  "PROPOSED TESTS",
  "RECOMMENDATIONS",
] as const;
export const VERDICTS = ["Yes", "No", "Partially", "Moving goalposts"] as const;
export const PRECISION = ["Precise", "Vague", "Shifting"] as const;
export const TRAPS = ["Denial proves guilt", "Questioning proves ignorance", "Only agreement is valid", "Doubt is moral failure"] as const;
export const RATINGS = [
  "FULLY FALSIFIABLE",
  "MOSTLY FALSIFIABLE",
  "PARTIALLY FALSIFIABLE",
  "LARGELY UNFALSIFIABLE",
  "COMPLETELY UNFALSIFIABLE",
] as const;
const ANALYSIS_FIELDS = ["Falsifiable", "What would disprove it", "Definitional precision", "Escape hatches"] as const;
const TEST_FIELDS = ["Test", "Confirms if", "Refutes if", "Claimant would accept"] as const;

export type Claim = { n: number; text: string; verdict?: string; precision?: string; disprover?: string; line: number };
type Row = { text: string; line: number };

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

// "- **Falsifiable?** Yes" and "- Falsifiable: Yes" both read as field Falsifiable = Yes.
function field(raw: string): { name: string; value: string } | null {
  const m = raw.replace(/\*\*/g, "").match(/^\s*[-*]\s+([^:?]+?)\s*[:?]\s*:?\s*(.*?)\s*$/);
  return m ? { name: m[1].trim(), value: m[2].trim() } : null;
}

function oneOf<T extends readonly string[]>(value: string, set: T): T[number] | undefined {
  const v = value.replace(/\s*[.;,—–(].*$/, "").trim().toLowerCase();
  return set.find((s) => s.toLowerCase() === v);
}

function blocks(rows: Row[]): { head: Row; body: Row[] }[] {
  const out: { head: Row; body: Row[] }[] = [];
  for (const r of rows) {
    if (/^###\s/.test(r.text)) out.push({ head: r, body: [] });
    else if (out.length) out[out.length - 1].body.push(r);
  }
  return out;
}

export function check(input: string): { ok: boolean; claims: Claim[]; rating?: string; problems: string[] } {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const claims: Claim[] = [];

  // Title and sections.
  const h1 = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^#\s/.test(l));
  const h2 = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^##\s/.test(l));
  if (h1.length !== 1) problems.push(`expected exactly one H1 title, found ${h1.length}`);
  else if (!/^#\s+Falsifiability Check:\s+\S/.test(h1[0].l)) problems.push(`line ${h1[0].i + 1}: the title opens "# Falsifiability Check: " and names what was audited`);
  const firstContent = lines.findIndex((l) => l.trim() !== "");
  if (h1.length && firstContent !== h1[0].i) problems.push(`line ${firstContent + 1}: text before the title`);
  if (h1.length && h2.length) {
    if (h1[0].i > h2[0].i) problems.push("the H1 title comes before every section");
    else for (let i = h1[0].i + 1; i < h2[0].i; i++) if (lines[i].trim() !== "") problems.push(`line ${i + 1}: text between the title and the first section`);
  }
  const names = h2.map(({ l }) => l.replace(/^##\s+/, "").trim());
  if (names.join("|") !== SECTIONS.join("|")) {
    problems.push(`sections must be exactly ${SECTIONS.join(", ")} in that order; found ${names.length ? names.join(", ") : "none"}`);
  }
  const has = (name: string) => names.includes(name);
  const body = (name: string): Row[] => {
    const idx = h2.findIndex(({ l }) => l.replace(/^##\s+/, "").trim() === name);
    if (idx < 0) return [];
    const end = idx + 1 < h2.length ? h2[idx + 1].i : lines.length;
    return lines.slice(h2[idx].i + 1, end).map((text, k) => ({ text, line: h2[idx].i + 2 + k })).filter((r) => r.text.trim() !== "");
  };

  // CLAIMS IDENTIFIED: a numbered list 1..N, nothing else.
  if (has("CLAIMS IDENTIFIED")) {
    for (const r of body("CLAIMS IDENTIFIED")) {
      const m = r.text.match(/^\s*(\d+)[.)]\s+(.*\S)\s*$/);
      if (!m) { problems.push(`line ${r.line}: CLAIMS IDENTIFIED holds only the numbered list ("${r.text.trim().slice(0, 60)}")`); continue; }
      claims.push({ n: Number(m[1]), text: m[2], line: r.line });
    }
    if (claims.length < 1 || claims.length > 12) problems.push(`CLAIMS IDENTIFIED has ${claims.length} claims; expected 1 to 12`);
    claims.forEach((c, i) => { if (c.n !== i + 1) problems.push(`line ${c.line}: claim numbered ${c.n}, expected ${i + 1}`); });
    for (const c of claims) if (words(c.text).length < 3) problems.push(`line ${c.line}: claim ${c.n} is not a sentence ("${c.text}")`);
  }

  // FALSIFIABILITY ANALYSIS: one ### Claim N block per claim, four fields each.
  if (has("FALSIFIABILITY ANALYSIS")) {
    const rows = body("FALSIFIABILITY ANALYSIS");
    const firstBlock = rows.findIndex((x) => /^###\s/.test(x.text));
    for (const r of firstBlock < 0 ? rows : rows.slice(0, firstBlock)) problems.push(`line ${r.line}: text before the first claim block`);
    const bl = blocks(rows);
    if (bl.length !== claims.length) problems.push(`FALSIFIABILITY ANALYSIS has ${bl.length} claim blocks for ${claims.length} claims`);
    bl.forEach((b, i) => {
      const m = b.head.text.match(/^###\s+Claim\s+(\d+)\s*:\s*\S/);
      if (!m) { problems.push(`line ${b.head.line}: claim block heading must be ### Claim N: "the claim"`); return; }
      const n = Number(m[1]);
      if (n !== i + 1) problems.push(`line ${b.head.line}: claim block ${n}, expected ${i + 1}`);
      const fields = b.body.map((r) => ({ r, f: field(r.text) }));
      for (const { r, f } of fields) if (!f || !ANALYSIS_FIELDS.some((k) => k.toLowerCase() === f.name.toLowerCase())) problems.push(`line ${r.line}: claim ${n} holds only the four fields ("${r.text.trim().slice(0, 60)}")`);
      const get = (k: string) => fields.find(({ f }) => f?.name.toLowerCase() === k.toLowerCase());
      for (const k of ANALYSIS_FIELDS) {
        const g = get(k);
        if (!g) problems.push(`line ${b.head.line}: claim ${n} is missing its "${k}" field`);
        else if (!g.f!.value) problems.push(`line ${g.r.line}: claim ${n} "${k}" is empty`);
      }
      if (fields.filter(({ f }) => f && ANALYSIS_FIELDS.some((k) => k.toLowerCase() === f.name.toLowerCase())).length > 4) problems.push(`line ${b.head.line}: claim ${n} repeats a field`);
      const claim = claims.find((c) => c.n === n);
      const v = get("Falsifiable");
      if (v) {
        const verdict = oneOf(v.f!.value, VERDICTS);
        if (!verdict) problems.push(`line ${v.r.line}: verdict "${v.f!.value}" is not Yes, No, Partially or Moving goalposts`);
        else if (claim) claim.verdict = verdict;
      }
      const p = get("Definitional precision");
      if (p) {
        const precision = oneOf(p.f!.value, PRECISION);
        if (!precision) problems.push(`line ${p.r.line}: precision "${p.f!.value}" is not Precise, Vague or Shifting`);
        else if (claim) claim.precision = precision;
      }
      const d = get("What would disprove it");
      if (d && claim) {
        claim.disprover = d.f!.value;
        if (claim.verdict === "Yes") {
          if (/^nothing specified/i.test(d.f!.value)) problems.push(`line ${d.r.line}: claim ${n} is Yes but its disprover says nothing is specified`);
          else if (words(d.f!.value).length < 5) problems.push(`line ${d.r.line}: claim ${n} is Yes; its disprover names a real observation of at least five words`);
        }
      }
    });
  }

  // KAFKA TRAP CHECK: the four checkbox lines in order, evidence on each checked box.
  if (has("KAFKA TRAP CHECK")) {
    const rows = body("KAFKA TRAP CHECK");
    if (rows.length !== TRAPS.length) problems.push(`KAFKA TRAP CHECK has ${rows.length} lines; expected exactly the ${TRAPS.length} checkbox lines`);
    rows.forEach((r, i) => {
      const m = r.text.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*?)\s*$/);
      if (!m) { problems.push(`line ${r.line}: KAFKA TRAP CHECK holds only checkbox lines ("${r.text.trim().slice(0, 60)}")`); return; }
      const want = TRAPS[i];
      if (!want) return;
      const [label, ...rest] = m[2].split(":");
      if (label.trim().toLowerCase() !== want.toLowerCase()) problems.push(`line ${r.line}: trap ${i + 1} is "${label.trim()}", expected "${want}"`);
      const evidence = rest.join(":").trim();
      if (m[1].toLowerCase() === "x" && words(evidence).length < 2) problems.push(`line ${r.line}: "${want}" is checked but names no line of the input that sets it`);
    });
  }

  // OVERALL FALSIFIABILITY RATING: one line, a valid rating, a reason, consistent with the verdicts.
  let rating: string | undefined;
  if (has("OVERALL FALSIFIABILITY RATING")) {
    const rows = body("OVERALL FALSIFIABILITY RATING");
    if (rows.length !== 1) problems.push(`OVERALL FALSIFIABILITY RATING is one line; found ${rows.length}`);
    const text = rows[0]?.text.replace(/\*\*/g, "").replace(/^\[|\]/g, "").trim() ?? "";
    rating = RATINGS.find((x) => text.startsWith(x));
    if (!rating) problems.push(`OVERALL FALSIFIABILITY RATING opens on one of ${RATINGS.join(", ")}`);
    else {
      const reason = text.slice(rating.length).replace(/^\s*[—–:-]+\s*/, "");
      if (words(reason).length < 5) problems.push("OVERALL FALSIFIABILITY RATING carries one sentence saying why after the rating");
      const verdicts = claims.map((c) => c.verdict).filter(Boolean);
      if (verdicts.length === claims.length && claims.length) {
        const yes = verdicts.filter((v) => v === "Yes").length;
        if (rating === "FULLY FALSIFIABLE" && yes !== verdicts.length) problems.push(`rating is FULLY FALSIFIABLE but ${verdicts.length - yes} claim(s) are not Yes`);
        if (rating === "COMPLETELY UNFALSIFIABLE" && yes > 0) problems.push(`rating is COMPLETELY UNFALSIFIABLE but ${yes} claim(s) are Yes`);
        if (yes === verdicts.length && /UNFALSIFIABLE/.test(rating)) problems.push(`every claim is Yes but the rating is ${rating}`);
        if (yes === 0 && /^(FULLY|MOSTLY)/.test(rating)) problems.push(`no claim is Yes but the rating is ${rating}`);
      }
    }
  }

  // RISK ASSESSMENT: present and not empty.
  if (has("RISK ASSESSMENT") && body("RISK ASSESSMENT").length === 0) problems.push("RISK ASSESSMENT is empty");

  const weak = claims.filter((c) => c.verdict && c.verdict !== "Yes").map((c) => c.n);
  const allYes = claims.length > 0 && claims.every((c) => c.verdict === "Yes");

  // PROPOSED TESTS: a ### Test for Claim N block for every non-Yes claim.
  if (has("PROPOSED TESTS")) {
    const rows = body("PROPOSED TESTS");
    const bl = blocks(rows);
    if (bl.length === 0) {
      if (!allYes) problems.push(`PROPOSED TESTS has no test blocks, but claim(s) ${weak.join(", ")} are not Yes`);
      else if (rows.length !== 1 || !/^No tests needed/i.test(rows[0].text.trim())) problems.push('PROPOSED TESTS, with every claim Yes, is the single line "No tests needed: …"');
    } else {
      for (const r of rows.filter((r) => r.line < bl[0].head.line)) problems.push(`line ${r.line}: text before the first test block`);
      const tested = new Set<number>();
      for (const b of bl) {
        const m = b.head.text.match(/^###\s+Test for Claim\s+(\d+)\s*$/i);
        if (!m) { problems.push(`line ${b.head.line}: test block heading must be ### Test for Claim N`); continue; }
        const n = Number(m[1]);
        if (!claims.some((c) => c.n === n)) problems.push(`line ${b.head.line}: test for claim ${n}, which is not a listed claim`);
        if (tested.has(n)) problems.push(`line ${b.head.line}: claim ${n} has two test blocks`);
        tested.add(n);
        const fields = b.body.map((r) => ({ r, f: field(r.text) }));
        for (const { r, f } of fields) if (!f || !TEST_FIELDS.some((k) => k.toLowerCase() === f.name.toLowerCase())) problems.push(`line ${r.line}: test for claim ${n} holds only the four fields ("${r.text.trim().slice(0, 60)}")`);
        for (const k of TEST_FIELDS) {
          const g = fields.find(({ f }) => f?.name.toLowerCase() === k.toLowerCase());
          if (!g) problems.push(`line ${b.head.line}: test for claim ${n} is missing its "${k}" field`);
          else if (words(g.f!.value).length < 2) problems.push(`line ${g.r.line}: test for claim ${n} "${k}" is empty or one word`);
        }
      }
      for (const n of weak) if (!tested.has(n)) problems.push(`claim ${n} is not Yes but has no test in PROPOSED TESTS`);
    }
  }

  // RECOMMENDATIONS: a "- Claim N: "rewrite"" bullet for every non-Yes claim.
  if (has("RECOMMENDATIONS")) {
    const rows = body("RECOMMENDATIONS");
    const rewritten = new Set<number>();
    if (allYes && rows.length === 1 && /^No rewrites needed/i.test(rows[0].text.trim())) {
      // the one allowed line
    } else {
      for (const r of rows) {
        const m = r.text.match(/^\s*[-*]\s+Claim\s+(\d+)\s*:\s*(.*)$/i);
        if (!m) { problems.push(`line ${r.line}: RECOMMENDATIONS holds only "- Claim N: \\"rewrite\\"" bullets ("${r.text.trim().slice(0, 60)}")`); continue; }
        const n = Number(m[1]);
        if (!claims.some((c) => c.n === n)) problems.push(`line ${r.line}: recommendation for claim ${n}, which is not a listed claim`);
        const q = m[2].match(/["“]([^"”]+)["”]/);
        if (!q || words(q[1]).length < 4) problems.push(`line ${r.line}: recommendation for claim ${n} carries no quoted rewrite of at least four words`);
        rewritten.add(n);
      }
      if (rows.length === 0) problems.push(allYes ? 'RECOMMENDATIONS, with every claim Yes, is the single line "No rewrites needed: …"' : "RECOMMENDATIONS is empty");
      for (const n of weak) if (!rewritten.has(n)) problems.push(`claim ${n} is not Yes but has no rewrite in RECOMMENDATIONS`);
    }
  }

  return { ok: problems.length === 0, claims, rating, problems };
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
  const src = args.find((a) => !a.startsWith("--"));
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input);
  if (json) console.log(JSON.stringify({ ok: r.ok, claims: r.claims.map(({ n, verdict, precision }) => ({ n, verdict, precision })), rating: r.rating ?? null, problems: r.problems }));
  else if (r.ok) console.log(`✓ ${r.claims.length} claims, rating ${r.rating}, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
