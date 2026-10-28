#!/usr/bin/env bun
// MindVirusCheck — checks a MindVirus output against the parts of its contract
// code can judge: one "# Mind Virus Check:" title, the nine H2 sections in
// order, 1 to 5 numbered core claims, the six-row exploit table with a valid
// rating and real evidence on every Yes or Partial, the fixed falsifiability
// and social-enforcement fields, a verdict level consistent with those fields,
// an inoculation that matches the verdict, and a one-sentence key insight.
// Whether the evidence is grounded and the reading even-handed stays judged.

import { readFileSync } from "node:fs";

const HELP = `MindVirusCheck — shape check for a Fabric MindVirus output

  bun skills/Fabric/Tools/MindVirusCheck.ts <file|-> [--json]

  --json  print {ok, verdict, claims, exploits, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const SECTIONS = [
  "CONTENT ANALYZED",
  "CORE CLAIMS",
  "COGNITIVE EXPLOIT ANALYSIS",
  "TERM REDEFINITION CHECK",
  "FALSIFIABILITY CHECK",
  "SOCIAL ENFORCEMENT PATTERNS",
  "MIND VIRUS VERDICT",
  "INOCULATION",
  "KEY INSIGHT",
] as const;

export const EXPLOITS = ["Fear-based", "Guilt-based", "Identity-based", "Authority-based", "Zero-sum", "Unfalsifiability"] as const;
export const VERDICTS = ["CLEAN", "MILD INFECTION PATTERNS", "SIGNIFICANT MIND VIRUS MARKERS", "SEVERE MIND VIRUS"] as const;
export const INOCULATION_GROUPS = [
  "Questions that expose the manipulation",
  "Evidence that would test the claims",
  "Reframings that restore falsifiability",
] as const;

export type Verdict = (typeof VERDICTS)[number];
export type Rating = "Yes" | "Partial" | "No";
export type Exploit = { type: string; present: Rating; evidence: string; line: number };
type Row = { text: string; line: number };

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

const nonEmpty = (rows: Row[]) => rows.filter((r) => r.text.trim() !== "");
const isBullet = (s: string) => /^\s*-\s+\S/.test(s);
const unbullet = (s: string) => s.replace(/^\s*-\s+/, "").trim();

// Sentence boundaries inside one line, ignoring common abbreviations.
function sentenceBreaks(line: string): number {
  const cleaned = line.replace(/\b(?:e\.g|i\.e|vs|etc|Dr|Mr|Mrs|Ms|St|No|U\.S|U\.K)\./g, "ABBR");
  return (cleaned.match(/[.!?]["”’)]?\s+(?=["“(]?[A-Z0-9])/g) ?? []).length;
}

// Parse "- Label: value" fields in a fixed order.
function fields(name: string, rows: Row[], labels: readonly string[], problems: string[]): Map<string, Row> {
  const out = new Map<string, Row>();
  const lines = nonEmpty(rows);
  for (const r of lines) if (!isBullet(r.text)) problems.push(`line ${r.line}: ${name} holds only its field bullets`);
  const bullets = lines.filter((r) => isBullet(r.text));
  if (bullets.length !== labels.length) problems.push(`${name} has ${bullets.length} bullets; expected exactly ${labels.length} (${labels.join("; ")})`);
  labels.forEach((label, i) => {
    const b = bullets[i];
    if (!b) return;
    const body = unbullet(b.text);
    if (!body.toLowerCase().startsWith(label.toLowerCase() + ":")) {
      problems.push(`line ${b.line}: ${name} field ${i + 1} must open "${label}:"`);
      return;
    }
    out.set(label, { text: body.slice(label.length + 1).trim(), line: b.line });
  });
  return out;
}

export function check(input: string): { ok: boolean; verdict?: Verdict; claims: number; exploits: Exploit[]; problems: string[] } {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const exploits: Exploit[] = [];
  let claims = 0;
  let verdict: Verdict | undefined;

  // Title and sections.
  const h1 = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^#\s/.test(l));
  const h2 = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^##\s/.test(l));
  if (h1.length !== 1) problems.push(`expected exactly one H1 title, found ${h1.length}`);
  else if (!/^#\s+Mind Virus Check:\s+\S/.test(h1[0].l)) problems.push(`line ${h1[0].i + 1}: the title opens "# Mind Virus Check: " and names what was checked`);
  const firstContent = lines.findIndex((l) => l.trim() !== "");
  if (firstContent < 0) return { ok: false, claims, exploits, problems: ["empty output"] };
  if (h1.length && firstContent !== h1[0].i) problems.push(`line ${firstContent + 1}: text before the title`);
  if (h1.length && h2.length && h1[0].i > h2[0].i) problems.push("the H1 title comes before every section");

  const names = h2.map(({ l }) => l.replace(/^##\s+/, "").trim());
  if (names.join("|") !== SECTIONS.join("|")) {
    problems.push(`sections must be exactly ${SECTIONS.join(", ")} in that order; found ${names.length ? names.join(", ") : "none"}`);
  }
  const has = (name: string) => names.includes(name);
  const body = (name: string): Row[] => {
    const idx = names.indexOf(name);
    if (idx < 0) return [];
    const end = idx + 1 < h2.length ? h2[idx + 1].i : lines.length;
    return lines.slice(h2[idx].i + 1, end).map((text, k) => ({ text, line: h2[idx].i + 2 + k }));
  };
  if (h1.length && h2.length && h1[0].i < h2[0].i) {
    for (let i = h1[0].i + 1; i < h2[0].i; i++) if (lines[i].trim() !== "") problems.push(`line ${i + 1}: text between the title and the first section`);
  }
  for (const name of SECTIONS) {
    if (!has(name)) continue;
    if (nonEmpty(body(name)).length === 0) problems.push(`${name} is empty`);
    if (name !== "INOCULATION") for (const r of body(name)) if (/^#{3,}\s/.test(r.text)) problems.push(`line ${r.line}: ${name} holds no subheadings`);
  }

  // CONTENT ANALYZED: one short paragraph.
  if (has("CONTENT ANALYZED")) {
    const rows = nonEmpty(body("CONTENT ANALYZED"));
    const paras = body("CONTENT ANALYZED").map((r) => r.text).join("\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (paras.length > 1) problems.push(`CONTENT ANALYZED has ${paras.length} paragraphs; expected one`);
    if (rows.some((r) => /^\s*(?:[-+*]|\d+[.)]|\|)\s/.test(r.text))) problems.push("CONTENT ANALYZED is a prose paragraph, with no bullets, lists or tables");
    const n = words(paras.join(" ")).length;
    if (n > 60) problems.push(`CONTENT ANALYZED has ${n} words; expected at most 60`);
  }

  // CORE CLAIMS: numbered 1..k, k from 1 to 5.
  if (has("CORE CLAIMS")) {
    const rows = nonEmpty(body("CORE CLAIMS"));
    const items = rows.filter((r) => /^\s*\d+\.\s+\S/.test(r.text));
    for (const r of rows.filter((r) => !/^\s*\d+\.\s+\S/.test(r.text))) problems.push(`line ${r.line}: CORE CLAIMS holds only numbered claims`);
    claims = items.length;
    if (claims < 1 || claims > 5) problems.push(`CORE CLAIMS has ${claims} claims; expected 1 to 5`);
    items.forEach((r, i) => {
      const n = Number(r.text.trim().match(/^(\d+)\./)![1]);
      if (n !== i + 1) problems.push(`line ${r.line}: claim numbered ${n}, expected ${i + 1}`);
      if (words(r.text.replace(/^\s*\d+\.\s+/, "")).length < 3) problems.push(`line ${r.line}: a claim is a sentence of at least three words`);
    });
  }

  // COGNITIVE EXPLOIT ANALYSIS: the six-row table and nothing else.
  if (has("COGNITIVE EXPLOIT ANALYSIS")) {
    const rows = nonEmpty(body("COGNITIVE EXPLOIT ANALYSIS"));
    for (const r of rows.filter((r) => !r.text.trim().startsWith("|"))) problems.push(`line ${r.line}: COGNITIVE EXPLOIT ANALYSIS holds only the table ("${r.text.trim().slice(0, 60)}")`);
    const table = rows.filter((r) => r.text.trim().startsWith("|"));
    const header = table[0] ? cells(table[0].text).map((c) => c.toLowerCase()) : [];
    if (header.join("|") !== "exploit type|present?|evidence") problems.push("COGNITIVE EXPLOIT ANALYSIS table header must be | Exploit Type | Present? | Evidence |");
    else if (!table[1] || !cells(table[1].text).every((c) => /^:?-{3,}:?$/.test(c))) problems.push("COGNITIVE EXPLOIT ANALYSIS table has no separator row under its header");
    else {
      const data = table.slice(2);
      if (data.length !== EXPLOITS.length) problems.push(`COGNITIVE EXPLOIT ANALYSIS has ${data.length} rows; expected exactly ${EXPLOITS.length} (${EXPLOITS.join(", ")})`);
      data.forEach((r, i) => {
        const c = cells(r.text);
        if (c.length !== 3) { problems.push(`line ${r.line}: exploit row has ${c.length} cells, expected 3`); return; }
        const [type, presentRaw, evidence] = c;
        const want = EXPLOITS[i];
        if (want && type.toLowerCase() !== want.toLowerCase()) problems.push(`line ${r.line}: row ${i + 1} is "${type}", expected "${want}"`);
        const m = presentRaw.match(/^(yes|partial|no)$/i);
        if (!m) { problems.push(`line ${r.line}: Present? "${presentRaw}" is not Yes, Partial or No`); return; }
        const present = (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) as Rating;
        if (words(evidence).length === 0) problems.push(`line ${r.line}: ${type} has no evidence`);
        else if (present !== "No" && words(evidence).length < 4) problems.push(`line ${r.line}: ${type} is ${present} but its evidence has fewer than four words`);
        exploits.push({ type, present, evidence, line: r.line });
      });
    }
  }

  // TERM REDEFINITION CHECK: quoted-term bullets or one "None found:" line.
  if (has("TERM REDEFINITION CHECK")) {
    const rows = nonEmpty(body("TERM REDEFINITION CHECK"));
    const none = rows.length === 1 && /^None found:\s*\S/.test(rows[0].text.trim());
    if (!none) {
      for (const r of rows) {
        if (/^None found:/.test(r.text.trim())) problems.push(`line ${r.line}: "None found:" stands alone as the section's only line`);
        else if (!/^\s*-\s+["“][^"”]+["”]\s*:\s*\S/.test(r.text)) problems.push(`line ${r.line}: TERM REDEFINITION CHECK bullets open on the quoted term and a colon (- "term": …)`);
        else if (words(r.text.replace(/^\s*-\s+["“][^"”]+["”]\s*:/, "")).length < 6) problems.push(`line ${r.line}: a redefinition gives the ordinary meaning, the content's meaning and what it shuts out`);
      }
    }
  }

  // FALSIFIABILITY CHECK.
  let testable: string | undefined;
  if (has("FALSIFIABILITY CHECK")) {
    const f = fields("FALSIFIABILITY CHECK", body("FALSIFIABILITY CHECK"), ["Can the core claims be tested", "What would disprove them", "Acknowledges it could be wrong"], problems);
    const t = f.get("Can the core claims be tested");
    if (t) {
      const m = t.text.match(/^(Yes|No|Partially)\b/i);
      if (!m) problems.push(`line ${t.line}: "Can the core claims be tested" is Yes, No or Partially`);
      else testable = m[1].toLowerCase();
    }
    const d = f.get("What would disprove them");
    if (d && words(d.text).length < 2) problems.push(`line ${d.line}: "What would disprove them" names the observation, or "None specified" and why`);
    const a = f.get("Acknowledges it could be wrong");
    if (a && !/^(Yes|No)\b/i.test(a.text)) problems.push(`line ${a.line}: "Acknowledges it could be wrong" is Yes or No`);
  }

  // SOCIAL ENFORCEMENT PATTERNS.
  let questioners: string | undefined;
  let doubtMoral = false;
  let loyalty = false;
  if (has("SOCIAL ENFORCEMENT PATTERNS")) {
    const f = fields("SOCIAL ENFORCEMENT PATTERNS", body("SOCIAL ENFORCEMENT PATTERNS"), ["Questioners are", "Doubt framed as moral failure", "Loyalty tests"], problems);
    const q = f.get("Questioners are");
    if (q) {
      const m = q.text.match(/^(Answered|Dismissed|Attacked|Excluded|Not addressed)\b/i);
      if (!m) problems.push(`line ${q.line}: "Questioners are" is Answered, Dismissed, Attacked, Excluded or Not addressed`);
      else questioners = m[1].toLowerCase();
    }
    const d = f.get("Doubt framed as moral failure");
    if (d) {
      const m = d.text.match(/^(Yes|No)\b/i);
      if (!m) problems.push(`line ${d.line}: "Doubt framed as moral failure" is Yes or No`);
      else doubtMoral = m[1].toLowerCase() === "yes";
    }
    const l = f.get("Loyalty tests");
    if (l) {
      if (/^No\b/i.test(l.text)) loyalty = false;
      else if (/^Yes:\s*\S/i.test(l.text) && words(l.text.replace(/^Yes:/i, "")).length >= 3) loyalty = true;
      else problems.push(`line ${l.line}: "Loyalty tests" is No, or "Yes: <the test>" naming it`);
    }
  }

  // MIND VIRUS VERDICT: one line, a level and one reason, consistent with the fields.
  if (has("MIND VIRUS VERDICT")) {
    const rows = nonEmpty(body("MIND VIRUS VERDICT"));
    if (rows.length !== 1) problems.push(`MIND VIRUS VERDICT is one line; found ${rows.length}`);
    const r = rows[0];
    if (r) {
      const m = r.text.trim().match(/^(CLEAN|MILD INFECTION PATTERNS|SIGNIFICANT MIND VIRUS MARKERS|SEVERE MIND VIRUS)\s*(?:—|–|:|-)\s*(.+)$/);
      if (!m) problems.push(`line ${r.line}: the verdict is one of ${VERDICTS.join(", ")}, then an em-dash or colon and one sentence why`);
      else {
        verdict = m[1] as Verdict;
        if (words(m[2]).length < 5) problems.push(`line ${r.line}: the verdict's reason is a sentence of at least five words`);
      }
    }
  }
  if (verdict && exploits.length === EXPLOITS.length) {
    const rated = (t: string) => exploits.find((e) => e.type.toLowerCase() === t.toLowerCase())?.present;
    const punished = questioners === "attacked" || questioners === "excluded";
    if (verdict === "CLEAN") {
      const yes = exploits.filter((e) => e.present === "Yes").map((e) => e.type);
      if (yes.length) problems.push(`verdict CLEAN but ${yes.join(", ")} rated Yes`);
      if (punished) problems.push(`verdict CLEAN but questioners are ${questioners}`);
      if (doubtMoral) problems.push("verdict CLEAN but doubt is framed as moral failure");
      if (loyalty) problems.push("verdict CLEAN but a loyalty test is named");
    }
    if (verdict === "SIGNIFICANT MIND VIRUS MARKERS" || verdict === "SEVERE MIND VIRUS") {
      const resists = rated("Unfalsifiability") !== "No" || testable === "no" || testable === "partially" || punished || doubtMoral || loyalty;
      if (!resists) problems.push(`verdict ${verdict} rests on no shown resistance to correction (Unfalsifiability No, claims testable, questioners not attacked or excluded, doubt not moral failure, no loyalty test)`);
    }
  }

  // INOCULATION: three groups, or "Not needed:" when CLEAN.
  if (has("INOCULATION")) {
    const rows = nonEmpty(body("INOCULATION"));
    const notNeeded = rows.length === 1 && /^Not needed:\s*\S/.test(rows[0].text.trim());
    if (verdict === "CLEAN") {
      if (!notNeeded) problems.push(`INOCULATION for a CLEAN verdict is the single line "Not needed: <why the content holds up>"`);
    } else if (notNeeded) {
      problems.push(`INOCULATION says "Not needed" but the verdict is ${verdict ?? "missing"}`);
    } else {
      const h3 = rows.filter((r) => /^###\s/.test(r.text));
      const h3names = h3.map((r) => r.text.replace(/^###\s+/, "").trim());
      if (h3names.join("|") !== INOCULATION_GROUPS.join("|")) problems.push(`INOCULATION groups must be exactly ${INOCULATION_GROUPS.map((g) => `### ${g}`).join(", ")} in that order`);
      const firstH3 = h3[0]?.line ?? Infinity;
      for (const r of rows) if (r.line < firstH3) problems.push(`line ${r.line}: text before the first INOCULATION group`);
      h3.forEach((g, i) => {
        const end = h3[i + 1]?.line ?? Infinity;
        const inGroup = rows.filter((r) => r.line > g.line && r.line < end);
        for (const r of inGroup.filter((r) => !isBullet(r.text))) problems.push(`line ${r.line}: INOCULATION groups hold only bullets`);
        const n = inGroup.filter((r) => isBullet(r.text)).length;
        if (n < 1 || n > 4) problems.push(`line ${g.line}: "${g.text.replace(/^###\s+/, "").trim()}" has ${n} bullets; expected 1 to 4`);
      });
    }
  }

  // KEY INSIGHT: one sentence on one line.
  if (has("KEY INSIGHT")) {
    const rows = nonEmpty(body("KEY INSIGHT"));
    if (rows.length !== 1) problems.push(`KEY INSIGHT is one line; found ${rows.length}`);
    const r = rows[0];
    if (r) {
      if (/^\s*(?:[-+*]|\d+[.)])\s/.test(r.text)) problems.push(`line ${r.line}: KEY INSIGHT is a sentence, not a list item`);
      const n = words(r.text).length;
      if (n > 40) problems.push(`line ${r.line}: KEY INSIGHT has ${n} words; expected at most 40`);
      if (sentenceBreaks(r.text.trim()) > 0) problems.push(`line ${r.line}: KEY INSIGHT is one sentence`);
    }
  }

  return { ok: problems.length === 0, verdict, claims, exploits, problems };
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
    console.error(`unknown flag ${unknown[0]}`);
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
  if (json) console.log(JSON.stringify({ ok: r.ok, verdict: r.verdict ?? null, claims: r.claims, exploits: r.exploits.map((e) => ({ type: e.type, present: e.present })), problems: r.problems }));
  else if (r.ok) console.log(`✓ ${r.verdict}, ${r.claims} claims, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
