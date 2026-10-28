#!/usr/bin/env bun
// AuditTransparencyCheck — checks an AuditTransparency output against the parts
// of its contract code can judge: one "# Transparency Audit:" title, the eight
// H2 sections in order, a one-line verdict with a valid label, the stakeholder,
// dimension and opacity tables with their allowed values, a reversal test that
// opens on a plain answer, an explainability attempt and result, and
// recommendations that cite real opacity rows and cover every unjustified one.
// Whether the ratings are true to the input stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `AuditTransparencyCheck — shape check for a Fabric AuditTransparency output

  bun skills/Fabric/Tools/AuditTransparencyCheck.ts <file|-> [--json]

  --json  print {ok, verdict, opacity, recommendations, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const SECTIONS = [
  "SYSTEM ANALYZED",
  "TRANSPARENCY VERDICT",
  "STAKEHOLDER MAP",
  "TRANSPARENCY AUDIT",
  "OPACITY ANALYSIS",
  "THE REVERSAL TEST",
  "EXPLAINABILITY CHECK",
  "RECOMMENDATIONS",
] as const;
export const VERDICTS = ["TRANSPARENT", "MOSTLY TRANSPARENT", "PARTIALLY OPAQUE", "SIGNIFICANTLY OPAQUE", "DELIBERATELY OBSCURED"] as const;
export const DIMENSIONS = ["Decision", "Algorithmic", "Financial", "Governance", "Data"] as const;
const RATINGS = ["clear", "partial", "opaque", "unknown", "not applicable"];
const ROLES = ["decision maker", "affected", "observer"];
const ACCESS = ["full", "partial", "none"];
const POWER = ["high", "medium", "low"];

export type Opacity = { n: number; text: string; justified: "Yes" | "Partly" | "No"; line: number };
export type Recommendation = { text: string; cites: number[]; line: number };
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

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// A section's table: header must match, a separator row must follow, and the
// section holds nothing but the table. Returns the data rows' cells.
function table(name: string, rows: Row[], header: string[], problems: string[]): { c: string[]; line: number }[] | null {
  const filled = rows.filter((r) => r.text.trim() !== "");
  for (const r of filled.filter((r) => !r.text.trim().startsWith("|"))) problems.push(`line ${r.line}: ${name} holds only its table ("${r.text.trim().slice(0, 60)}")`);
  const t = filled.filter((r) => r.text.trim().startsWith("|"));
  const got = t[0] ? cells(t[0].text).map(norm) : [];
  if (got.join("|") !== header.map(norm).join("|")) {
    problems.push(`${name} table header must be | ${header.join(" | ")} |`);
    return null;
  }
  if (!t[1] || !cells(t[1].text).every((c) => /^:?-{3,}:?$/.test(c))) {
    problems.push(`${name} table has no separator row under its header`);
    return null;
  }
  const out: { c: string[]; line: number }[] = [];
  for (const r of t.slice(2)) {
    const c = cells(r.text);
    if (c.length !== header.length) problems.push(`line ${r.line}: ${name} row has ${c.length} cells, expected ${header.length}`);
    else out.push({ c, line: r.line });
  }
  return out;
}

function paragraphs(rows: Row[]): string[] {
  return rows.map((r) => r.text).join("\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

export function check(input: string): {
  ok: boolean;
  verdict: string | null;
  opacity: Opacity[];
  recommendations: Recommendation[];
  problems: string[];
} {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const opacity: Opacity[] = [];
  const recommendations: Recommendation[] = [];
  let verdict: string | null = null;

  lines.forEach((raw, i) => {
    if (raw.replace(/`[^`]*`/g, "").includes("*")) problems.push(`line ${i + 1}: asterisk outside inline code; the output uses no bold or italics`);
  });

  // Title and sections.
  const h1 = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^#\s/.test(l));
  const h2 = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^##\s/.test(l));
  if (h1.length !== 1) problems.push(`expected exactly one H1 title, found ${h1.length}`);
  else if (!/^#\s+Transparency Audit:\s+\S/.test(h1[0].l)) problems.push(`line ${h1[0].i + 1}: the title opens "# Transparency Audit: " and names what is audited`);
  if (h1.length && h2.length && h1[0].i > h2[0].i) problems.push("the H1 title comes before every section");
  const firstContent = lines.findIndex((l) => l.trim() !== "");
  if (h1.length && firstContent !== h1[0].i) problems.push(`line ${firstContent + 1}: text before the title`);
  const names = h2.map(({ l }) => l.replace(/^##\s+/, "").trim());
  if (names.join("|") !== SECTIONS.join("|")) {
    problems.push(`sections must be exactly ${SECTIONS.join(", ")} in that order; found ${names.length ? names.join(", ") : "none"}`);
  }
  if (h1.length && h2.length) {
    lines.slice(h1[0].i + 1, h2[0].i).forEach((text, k) => {
      if (text.trim() !== "") problems.push(`line ${h1[0].i + 2 + k}: text between the title and the first section`);
    });
  }
  const has = (name: string) => names.includes(name);
  const body = (name: string): Row[] => {
    const idx = h2.findIndex(({ l }) => l.replace(/^##\s+/, "").trim() === name);
    if (idx < 0) return [];
    const end = idx + 1 < h2.length ? h2[idx + 1].i : lines.length;
    return lines.slice(h2[idx].i + 1, end).map((text, k) => ({ text, line: h2[idx].i + 2 + k }));
  };
  const proseOnly = (name: string, rows: Row[]) => {
    if (rows.some((r) => /^\s*(?:[-+]|\d+[.)]|\|)\s/.test(r.text) || /^\s*\|/.test(r.text))) problems.push(`${name} is prose, with no bullets, lists or tables`);
  };

  // SYSTEM ANALYZED: one paragraph, 10 to 90 words.
  if (has("SYSTEM ANALYZED")) {
    const rows = body("SYSTEM ANALYZED");
    const paras = paragraphs(rows);
    proseOnly("SYSTEM ANALYZED", rows);
    if (paras.length !== 1) problems.push(`SYSTEM ANALYZED has ${paras.length} paragraphs; expected 1`);
    const n = words(paras.join(" ")).length;
    if (n < 10 || n > 90) problems.push(`SYSTEM ANALYZED has ${n} words; expected 10 to 90`);
  }

  // TRANSPARENCY VERDICT: one line, LABEL: one sentence.
  if (has("TRANSPARENCY VERDICT")) {
    const rows = body("TRANSPARENCY VERDICT").filter((r) => r.text.trim() !== "");
    if (rows.length !== 1) problems.push(`TRANSPARENCY VERDICT is one line; found ${rows.length}`);
    if (rows[0]) {
      const m = rows[0].text.trim().match(/^([A-Z ]+?)\s*:\s*(.+)$/);
      if (!m || !(VERDICTS as readonly string[]).includes(m[1].trim())) {
        problems.push(`line ${rows[0].line}: verdict opens on one of ${VERDICTS.join(", ")} followed by a colon and a reason`);
      } else {
        verdict = m[1].trim();
        const n = words(m[2]).length;
        if (n < 6 || n > 40) problems.push(`line ${rows[0].line}: verdict reason has ${n} words; expected 6 to 40`);
      }
    }
  }

  // STAKEHOLDER MAP.
  if (has("STAKEHOLDER MAP")) {
    const t = table("STAKEHOLDER MAP", body("STAKEHOLDER MAP"), ["Party", "Role", "Information access", "Power"], problems);
    if (t) {
      if (t.length < 2) problems.push(`STAKEHOLDER MAP has ${t.length} rows; expected at least 2`);
      const roles = new Set<string>();
      for (const { c, line } of t) {
        const [party, role, access, power] = c;
        if (words(party).length === 0) problems.push(`line ${line}: party is empty`);
        const rs = role.split(/\s*[\/,]\s*|\s+and\s+/i).map(norm).filter(Boolean);
        if (!rs.length || rs.some((r) => !ROLES.includes(r))) problems.push(`line ${line}: role "${role}" is not Decision maker, Affected or Observer`);
        rs.forEach((r) => roles.add(r));
        if (!ACCESS.includes(norm(access))) problems.push(`line ${line}: information access "${access}" is not Full, Partial or None`);
        if (!POWER.includes(norm(power))) problems.push(`line ${line}: power "${power}" is not High, Medium or Low`);
      }
      if (!roles.has("decision maker")) problems.push("STAKEHOLDER MAP names no Decision maker");
      if (!roles.has("affected")) problems.push("STAKEHOLDER MAP names no Affected party");
    }
  }

  // TRANSPARENCY AUDIT: five dimensions in order.
  if (has("TRANSPARENCY AUDIT")) {
    const t = table("TRANSPARENCY AUDIT", body("TRANSPARENCY AUDIT"), ["Dimension", "Rating", "Evidence"], problems);
    if (t) {
      const dims = t.map(({ c }) => c[0].replace(/\s+transparency$/i, "").trim());
      if (dims.map(norm).join("|") !== DIMENSIONS.map(norm).join("|")) problems.push(`TRANSPARENCY AUDIT rows must be ${DIMENSIONS.join(", ")} in that order; found ${dims.join(", ") || "none"}`);
      for (const { c, line } of t) {
        if (!RATINGS.includes(norm(c[1]))) problems.push(`line ${line}: rating "${c[1]}" is not Clear, Partial, Opaque, Unknown or Not applicable`);
        const n = words(c[2]).length;
        if (n < 3 || n > 60) problems.push(`line ${line}: evidence has ${n} words; expected 3 to 60`);
      }
    }
  }

  // OPACITY ANALYSIS.
  if (has("OPACITY ANALYSIS")) {
    const t = table("OPACITY ANALYSIS", body("OPACITY ANALYSIS"), ["#", "Opacity", "Justified?", "Who benefits", "Who is harmed"], problems);
    if (t) {
      if (t.length > 10) problems.push(`OPACITY ANALYSIS has ${t.length} rows; expected at most 10`);
      t.forEach(({ c, line }, i) => {
        const [num, text, just, gains, pays] = c;
        if (Number(num.replace(/^#/, "")) !== i + 1 || !/^#?\d+$/.test(num)) problems.push(`line ${line}: row number "${num}", expected ${i + 1}`);
        if (words(text).length < 3) problems.push(`line ${line}: opacity "${text}" does not say what is hidden`);
        const m = just.match(/^(Yes|Partly|No)\b\s*(?::\s*(.*))?$/i);
        let j: Opacity["justified"] | undefined;
        if (!m) problems.push(`line ${line}: justified "${just}" is not Yes: <reason>, Partly: <reason>, or No`);
        else {
          j = (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) as Opacity["justified"];
          if (j !== "No" && words(m[2] ?? "").length < 3) problems.push(`line ${line}: a ${j} carries its specific reason ("${j}: <reason>")`);
        }
        if (words(gains).length === 0 || words(pays).length === 0) problems.push(`line ${line}: who benefits and who is harmed are both named`);
        if (j) opacity.push({ n: i + 1, text, justified: j, line });
      });
    }
  }

  // Verdict against the opacity rows.
  if (verdict && has("OPACITY ANALYSIS")) {
    if (opacity.length === 0 && verdict !== "TRANSPARENT") problems.push(`verdict ${verdict} with an empty OPACITY ANALYSIS; name the opacity or the verdict is TRANSPARENT`);
    if ((verdict === "SIGNIFICANTLY OPAQUE" || verdict === "DELIBERATELY OBSCURED") && !opacity.some((o) => o.justified === "No")) problems.push(`verdict ${verdict} needs at least one opacity row judged No`);
    if (verdict === "TRANSPARENT" && opacity.some((o) => o.justified === "No")) problems.push("verdict TRANSPARENT over an opacity row judged No");
  }

  // THE REVERSAL TEST: prose, opens on Yes/No/Partly.
  if (has("THE REVERSAL TEST")) {
    const rows = body("THE REVERSAL TEST");
    const paras = paragraphs(rows);
    proseOnly("THE REVERSAL TEST", rows);
    if (paras.length < 1 || paras.length > 2) problems.push(`THE REVERSAL TEST has ${paras.length} paragraphs; expected 1 or 2`);
    if (paras[0] && !/^(?:>\s*)?(Yes|No|Partly)\b/i.test(paras[0])) problems.push("THE REVERSAL TEST opens on a plain Yes, No or Partly");
    const n = words(paras.join(" ")).length;
    if (n < 15 || n > 120) problems.push(`THE REVERSAL TEST has ${n} words; expected 15 to 120`);
  }

  // EXPLAINABILITY CHECK: Attempt paragraph and Result line.
  if (has("EXPLAINABILITY CHECK")) {
    const paras = paragraphs(body("EXPLAINABILITY CHECK"));
    const attempt = paras.filter((p) => /^Attempt:\s*/.test(p));
    const result = paras.filter((p) => /^Result:\s*/.test(p));
    const other = paras.filter((p) => !/^(Attempt|Result):/.test(p));
    if (attempt.length !== 1) problems.push(`EXPLAINABILITY CHECK has ${attempt.length} Attempt: paragraphs; expected 1`);
    else {
      const n = words(attempt[0].replace(/^Attempt:\s*/, "")).length;
      if (n < 25 || n > 120) problems.push(`Attempt has ${n} words; expected 25 to 120`);
    }
    if (result.length !== 1) problems.push(`EXPLAINABILITY CHECK has ${result.length} Result: lines; expected 1`);
    else {
      const r = result[0].replace(/^Result:\s*/, "").replace(/\s*[—–]\s*|\s+-{1,2}\s+/g, " — ");
      if (!/^(Yes|Partially|No — the complexity is genuine|No — the complexity serves opacity)\b/i.test(r)) problems.push(`Result opens on Yes, Partially, "No — the complexity is genuine" or "No — the complexity serves opacity"`);
      if (result[0].includes("\n")) problems.push("Result is one line");
    }
    for (const p of other) problems.push(`EXPLAINABILITY CHECK holds only the Attempt and the Result ("${p.slice(0, 60)}")`);
    if (paras.length && !/^Attempt:/.test(paras[0])) problems.push("EXPLAINABILITY CHECK opens on the Attempt");
  }

  // RECOMMENDATIONS: bullets citing opacity rows.
  if (has("RECOMMENDATIONS")) {
    const rows = body("RECOMMENDATIONS").filter((r) => r.text.trim() !== "");
    for (const r of rows) {
      if (!/^\s*-\s+\S/.test(r.text)) { problems.push(`line ${r.line}: RECOMMENDATIONS holds only bullets`); continue; }
      const m = r.text.match(/\(\s*(#\d+(?:\s*,\s*#\d+)*)\s*\)\s*\.?\s*$/);
      const cites = m ? m[1].split(",").map((x) => Number(x.trim().slice(1))) : [];
      const text = (m ? r.text.slice(0, r.text.lastIndexOf("(")) : r.text).replace(/^\s*-\s+/, "").trim();
      if (opacity.length && !m) problems.push(`line ${r.line}: recommendation does not end by citing the opacity rows it fixes, e.g. (#1, #3)`);
      if (!opacity.length && m) problems.push(`line ${r.line}: recommendation cites opacity rows but the table has none`);
      const n = words(text).length;
      if (n < 6 || n > 40) problems.push(`line ${r.line}: recommendation has ${n} words; expected 6 to 40`);
      recommendations.push({ text, cites, line: r.line });
    }
    if (recommendations.length < 1 || recommendations.length > 8) problems.push(`RECOMMENDATIONS has ${recommendations.length} bullets; expected 1 to 8`);
    const rowNums = new Set(opacity.map((o) => o.n));
    for (const r of recommendations) for (const k of r.cites) if (!rowNums.has(k)) problems.push(`line ${r.line}: recommendation cites #${k}, which is not an opacity row`);
    const covered = new Set(recommendations.flatMap((r) => r.cites));
    for (const o of opacity) if (o.justified !== "Yes" && !covered.has(o.n)) problems.push(`opacity #${o.n} is judged ${o.justified} but no recommendation cites it`);
  }

  return { ok: problems.length === 0, verdict, opacity, recommendations, problems };
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
  if (json) console.log(JSON.stringify({ ok: r.ok, verdict: r.verdict, opacity: r.opacity.map(({ n, justified }) => ({ n, justified })), recommendations: r.recommendations.map(({ cites }) => cites), problems: r.problems }));
  else if (r.ok) console.log(`✓ ${r.verdict}, ${r.opacity.length} opacity rows, ${r.recommendations.length} recommendations, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
