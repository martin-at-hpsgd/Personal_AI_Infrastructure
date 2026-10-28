#!/usr/bin/env bun
// SilentVictimsCheck — checks a SilentVictims output against the parts of its
// contract code can judge: one "# Silent Victims:" title, the seven H2 sections
// in order, the five scan categories with their fixed fields and values, a
// severity table that agrees with the scan, a verdict that follows from the
// scan, recommendations that cite and cover the found categories, and no
// asterisks. Whether the victims are real and specific stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `SilentVictimsCheck — shape check for a Fabric SilentVictims output

  bun skills/Fabric/Tools/SilentVictimsCheck.ts <file|-> [--json]

  --json  print {ok, verdict, found, recommendations, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const SECTIONS = [
  "ACTION/SYSTEM ANALYZED",
  "VISIBLE STAKEHOLDERS",
  "SILENT VICTIM SCAN",
  "THE REVERSED TEST",
  "SILENT VICTIM SEVERITY",
  "OVERALL ASSESSMENT",
  "RECOMMENDATIONS",
] as const;

export const CATEGORIES = [
  { key: "Temporal", heading: "Temporal Victims (Future)" },
  { key: "Power", heading: "Power Victims (Voiceless)" },
  { key: "Information", heading: "Information Victims (Unaware)" },
  { key: "Diffuse", heading: "Diffuse Victims (Distributed)" },
  { key: "Structural", heading: "Structural Victims (Systemic)" },
] as const;

export type CategoryKey = (typeof CATEGORIES)[number]["key"];
export type Found = "Yes" | "Possible" | "No";
export const VERDICTS = ["NO SILENT VICTIMS", "POSSIBLE SILENT VICTIMS", "PROBABLE SILENT VICTIMS", "CONFIRMED SILENT VICTIMS"] as const;

// Fields each found category carries, in any order. A null value list means free text.
const FIELDS: Record<CategoryKey, Record<string, string[] | null>> = {
  Temporal: { Who: null, Harm: null, Reversibility: ["Reversible", "Partially reversible", "Irreversible"] },
  Power: { Who: null, Harm: null, "Why silent": null },
  Information: { Who: null, Harm: null, "Ignorance source": ["Natural complexity", "Deliberate obscuring", "Delayed effects"] },
  Diffuse: { Who: null, Harm: null, "Individual harm": ["Negligible", "Small", "Moderate"], "Aggregate harm": null, "Diffusion deliberate": ["Yes", "No", "Unclear"] },
  Structural: { Who: null, Harm: null, Mechanism: null, "Self-reinforcing": ["Yes", "No"] },
};
const TEMPORAL_REVERSIBLE: Record<string, string> = { reversible: "Yes", "partially reversible": "Partly", irreversible: "No" };

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

const canon = (value: string, allowed: readonly string[]): string | undefined =>
  allowed.find((a) => a.toLowerCase() === value.trim().replace(/[.]$/, "").toLowerCase());

type Line = { text: string; line: number };

export function check(input: string): {
  ok: boolean;
  verdict?: string;
  found: Partial<Record<CategoryKey, Found>>;
  recommendations: CategoryKey[][];
  problems: string[];
} {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const found: Partial<Record<CategoryKey, Found>> = {};
  const fields: Partial<Record<CategoryKey, Record<string, string>>> = {};
  const recommendations: CategoryKey[][] = [];
  let verdict: string | undefined;

  lines.forEach((raw, i) => {
    if (raw.replace(/`[^`]*`/g, "").includes("*")) problems.push(`line ${i + 1}: asterisk outside inline code; the output uses no bold or italics`);
  });

  // Title and sections.
  const h1 = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^#\s/.test(l));
  const h2 = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^##\s/.test(l));
  if (h1.length !== 1) problems.push(`expected exactly one H1 title, found ${h1.length}`);
  else if (!/^#\s+Silent Victims:\s+\S/.test(h1[0].l)) problems.push(`line ${h1[0].i + 1}: the title opens "# Silent Victims: " and names the action audited`);
  const firstContent = lines.findIndex((l) => l.trim() !== "");
  if (h1.length && firstContent !== h1[0].i) problems.push(`line ${firstContent + 1}: text before the title`);
  if (h1.length && h2.length) {
    if (h1[0].i > h2[0].i) problems.push("the H1 title comes before every section");
    for (let k = h1[0].i + 1; k < h2[0].i; k++) if (lines[k].trim() !== "") problems.push(`line ${k + 1}: text between the title and the first section`);
  }

  const names = h2.map(({ l }) => l.replace(/^##\s+/, "").trim());
  if (names.join("|") !== SECTIONS.join("|")) {
    problems.push(`sections must be exactly ${SECTIONS.join(", ")} in that order; found ${names.length ? names.join(", ") : "none"}`);
  }
  const has = (name: string) => names.includes(name);
  const body = (name: string): Line[] => {
    const idx = names.indexOf(name);
    if (idx < 0) return [];
    const end = idx + 1 < h2.length ? h2[idx + 1].i : lines.length;
    return lines.slice(h2[idx].i + 1, end).map((text, k) => ({ text, line: h2[idx].i + 2 + k }));
  };
  const nonEmpty = (b: Line[]) => b.filter((r) => r.text.trim() !== "");
  const paragraphs = (b: Line[]) => b.map((r) => r.text).join("\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const isBullet = (t: string) => /^\s*-\s+\S/.test(t);

  // ACTION/SYSTEM ANALYZED: one paragraph, at most 100 words.
  if (has(SECTIONS[0])) {
    const b = body(SECTIONS[0]);
    const paras = paragraphs(b);
    if (paras.length !== 1) problems.push(`ACTION/SYSTEM ANALYZED is one paragraph; found ${paras.length}`);
    if (nonEmpty(b).some((r) => isBullet(r.text) || /^\s*(?:\d+[.)]|\|)/.test(r.text))) problems.push("ACTION/SYSTEM ANALYZED is prose, with no bullets, lists or tables");
    const n = words(paras.join(" ")).length;
    if (n > 100) problems.push(`ACTION/SYSTEM ANALYZED has ${n} words; expected at most 100`);
  }

  // VISIBLE STAKEHOLDERS: 2 to 8 bullets.
  if (has(SECTIONS[1])) {
    const b = nonEmpty(body(SECTIONS[1]));
    for (const r of b.filter((r) => !isBullet(r.text))) problems.push(`line ${r.line}: VISIBLE STAKEHOLDERS holds only bullets`);
    const n = b.filter((r) => isBullet(r.text)).length;
    if (n < 2 || n > 8) problems.push(`VISIBLE STAKEHOLDERS has ${n} bullets; expected 2 to 8`);
  }

  // SILENT VICTIM SCAN: five H3 categories in order, field bullets only.
  if (has(SECTIONS[2])) {
    const b = body(SECTIONS[2]);
    const h3 = b.filter((r) => /^###\s/.test(r.text));
    const h3names = h3.map((r) => r.text.replace(/^###\s+/, "").trim());
    const want = CATEGORIES.map((c) => c.heading);
    if (h3names.join("|") !== want.join("|")) problems.push(`SILENT VICTIM SCAN must hold exactly ${want.join(", ")} as H3s in that order; found ${h3names.length ? h3names.join(", ") : "none"}`);
    if (h3.length) for (const r of nonEmpty(b).filter((r) => r.line < h3[0].line)) problems.push(`line ${r.line}: text before the first scan category`);
    h3.forEach((head, k) => {
      const cat = CATEGORIES.find((c) => c.heading === h3names[k]);
      if (!cat) return;
      const start = b.indexOf(head) + 1;
      const end = k + 1 < h3.length ? b.indexOf(h3[k + 1]) : b.length;
      const rows = nonEmpty(b.slice(start, end));
      const f: Record<string, string> = {};
      for (const r of rows) {
        const m = r.text.match(/^\s*-\s+([A-Za-z][A-Za-z -]*?):\s+(\S.*)$/);
        if (!m) { problems.push(`line ${r.line}: ${cat.key} category holds only "- Field: value" bullets`); continue; }
        if (m[1] in f) problems.push(`line ${r.line}: ${cat.key} repeats the ${m[1]} field`);
        f[m[1]] = m[2].trim();
      }
      fields[cat.key] = f;
      const fv = f.Found === undefined ? undefined : canon(f.Found, ["Yes", "Possible", "No"]);
      if (!fv) { problems.push(`${cat.key}: Found is ${f.Found === undefined ? "missing" : `"${f.Found}"`}; expected Yes, Possible or No`); return; }
      found[cat.key] = fv as Found;
      const keys = Object.keys(f).filter((x) => x !== "Found");
      if (fv === "No") {
        if (keys.join("|") !== "Why not") problems.push(`${cat.key}: a category marked No carries only Found and Why not; found ${keys.length ? keys.join(", ") : "nothing else"}`);
        else if (words(f["Why not"]).length < 4) problems.push(`${cat.key}: Why not gives the specific reason in at least four words`);
        return;
      }
      const spec = FIELDS[cat.key];
      for (const name of Object.keys(spec)) {
        if (!(name in f)) { problems.push(`${cat.key}: marked ${fv} but the ${name} field is missing`); continue; }
        const allowed = spec[name];
        if (allowed && !canon(f[name], allowed)) problems.push(`${cat.key}: ${name} is "${f[name]}"; expected ${allowed.join(", ")}`);
        if (!allowed && words(f[name]).length < 2) problems.push(`${cat.key}: ${name} is too thin to name anything ("${f[name]}")`);
      }
      for (const extra of keys.filter((x) => !(x in spec))) problems.push(`${cat.key}: unexpected field ${extra}`);
    });
  }

  // THE REVERSED TEST: opens on Yes, No or Partly, no table, at most 150 words.
  if (has(SECTIONS[3])) {
    const b = nonEmpty(body(SECTIONS[3]));
    const first = words(b[0]?.text ?? "")[0];
    if (!first || !["yes", "no", "partly"].includes(first.toLowerCase())) problems.push(`THE REVERSED TEST opens with Yes, No or Partly; it opens with "${first ?? ""}"`);
    if (b.some((r) => /^\s*\|/.test(r.text))) problems.push("THE REVERSED TEST holds no table");
    const n = words(b.map((r) => r.text).join(" ")).length;
    if (n > 150) problems.push(`THE REVERSED TEST has ${n} words; expected at most 150`);
  }

  // SILENT VICTIM SEVERITY: the five-row table, agreeing with the scan.
  if (has(SECTIONS[4])) {
    const b = nonEmpty(body(SECTIONS[4]));
    for (const r of b.filter((r) => !r.text.trim().startsWith("|"))) problems.push(`line ${r.line}: SILENT VICTIM SEVERITY holds only the table`);
    const table = b.filter((r) => r.text.trim().startsWith("|"));
    const header = table[0] ? cells(table[0].text).map((c) => c.toLowerCase()) : [];
    if (header.join("|") !== "category|found|scale|severity|reversible") problems.push("SILENT VICTIM SEVERITY table header must be | Category | Found | Scale | Severity | Reversible |");
    else if (!table[1] || !cells(table[1].text).every((c) => /^:?-{3,}:?$/.test(c))) problems.push("SILENT VICTIM SEVERITY table has no separator row under its header");
    else {
      const rows = table.slice(2);
      if (rows.length !== CATEGORIES.length) problems.push(`SILENT VICTIM SEVERITY has ${rows.length} rows; expected one per category (${CATEGORIES.length})`);
      rows.forEach((r, k) => {
        const c = cells(r.text);
        if (c.length !== 5) { problems.push(`line ${r.line}: severity row has ${c.length} cells, expected 5`); return; }
        const [category, f, scale, severity, reversible] = c;
        const cat = CATEGORIES[k];
        if (!cat) return;
        if (category.toLowerCase() !== cat.key.toLowerCase()) problems.push(`line ${r.line}: row ${k + 1} is "${category}", expected ${cat.key}`);
        const fv = canon(f, ["Yes", "Possible", "No"]);
        if (!fv) { problems.push(`line ${r.line}: Found "${f}" is not Yes, Possible or No`); return; }
        if (found[cat.key] && fv !== found[cat.key]) problems.push(`line ${r.line}: ${cat.key} is ${fv} in the table but ${found[cat.key]} in the scan`);
        if (fv === "No") {
          if (!canon(severity, ["None"])) problems.push(`line ${r.line}: ${cat.key} is marked No, so its severity is None`);
          if (!canon(reversible, ["n/a"])) problems.push(`line ${r.line}: ${cat.key} is marked No, so Reversible is n/a`);
        } else {
          if (!canon(severity, ["Low", "Medium", "High"])) problems.push(`line ${r.line}: ${cat.key} severity "${severity}" is not Low, Medium or High`);
          const rv = canon(reversible, ["Yes", "Partly", "No"]);
          if (!rv) problems.push(`line ${r.line}: ${cat.key} Reversible "${reversible}" is not Yes, Partly or No`);
          if (scale === "" || canon(scale, ["n/a", "-", "—"])) problems.push(`line ${r.line}: ${cat.key} is found, so Scale says how many`);
          const tr = cat.key === "Temporal" ? fields.Temporal?.Reversibility : undefined;
          if (rv && tr && TEMPORAL_REVERSIBLE[tr.toLowerCase()] && TEMPORAL_REVERSIBLE[tr.toLowerCase()] !== rv) {
            problems.push(`line ${r.line}: Temporal Reversible is ${rv} but the scan says ${tr}`);
          }
        }
      });
    }
  }

  // OVERALL ASSESSMENT: a verdict line that follows from the scan, then prose.
  if (has(SECTIONS[5])) {
    const b = nonEmpty(body(SECTIONS[5]));
    const head = b[0]?.text.trim().replace(/[.]$/, "");
    verdict = VERDICTS.find((v) => v === head);
    if (!verdict) problems.push(`OVERALL ASSESSMENT opens on a line that is exactly one of ${VERDICTS.join(", ")}; found "${head ?? ""}"`);
    const rest = b.slice(1).map((r) => r.text).join(" ");
    const sentences = rest.split(/[.!?](?:\s+|$)/).map((s) => s.trim()).filter(Boolean);
    if (sentences.length < 1 || sentences.length > 4) problems.push(`OVERALL ASSESSMENT follows the verdict with 1 to 4 sentences; found ${sentences.length}`);
    const values = Object.values(found);
    if (verdict && values.length === CATEGORIES.length) {
      const expected = values.every((v) => v === "No") ? ["NO SILENT VICTIMS"]
        : values.includes("Yes") ? ["PROBABLE SILENT VICTIMS", "CONFIRMED SILENT VICTIMS"]
        : ["POSSIBLE SILENT VICTIMS"];
      if (!expected.includes(verdict)) problems.push(`verdict ${verdict} does not follow from the scan; expected ${expected.join(" or ")}`);
    }
  }

  // RECOMMENDATIONS: bullets citing found categories, covering every one.
  if (has(SECTIONS[6])) {
    const b = nonEmpty(body(SECTIONS[6]));
    for (const r of b.filter((r) => !isBullet(r.text))) problems.push(`line ${r.line}: RECOMMENDATIONS holds only bullets`);
    const bullets = b.filter((r) => isBullet(r.text));
    if (verdict === "NO SILENT VICTIMS") {
      if (bullets.length !== 1 || !/^\s*-\s+None needed:\s+\S/.test(bullets[0].text)) problems.push('under NO SILENT VICTIMS, RECOMMENDATIONS is one bullet opening "None needed:" with the reason');
    } else {
      if (bullets.length < 1 || bullets.length > 8) problems.push(`RECOMMENDATIONS has ${bullets.length} bullets; expected 1 to 8`);
      const keys = CATEGORIES.map((c) => c.key.toLowerCase());
      for (const r of bullets) {
        const m = r.text.match(/\(\s*([A-Za-z]+(?:\s*,\s*[A-Za-z]+)*)\s*\)\s*\.?\s*$/);
        const cited = m ? m[1].split(",").map((x) => x.trim()) : [];
        if (!m || !cited.every((x) => keys.includes(x.toLowerCase()))) { problems.push(`line ${r.line}: recommendation does not end by citing its categories, e.g. (Temporal, Diffuse)`); continue; }
        const cats = cited.map((x) => CATEGORIES[keys.indexOf(x.toLowerCase())].key);
        for (const k of cats) if (found[k] === "No") problems.push(`line ${r.line}: recommendation cites ${k}, which the scan marked No`);
        const n = words(r.text.slice(0, r.text.lastIndexOf("("))).length;
        if (n < 4) problems.push(`line ${r.line}: recommendation has ${n} words; it names a concrete change`);
        recommendations.push(cats);
      }
      const covered = new Set(recommendations.flat());
      for (const c of CATEGORIES) if ((found[c.key] === "Yes" || found[c.key] === "Possible") && !covered.has(c.key)) problems.push(`${c.key} is marked ${found[c.key]} but no recommendation cites it`);
    }
  }

  return { ok: problems.length === 0, verdict, found, recommendations, problems };
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
  if (json) console.log(JSON.stringify({ ok: r.ok, verdict: r.verdict ?? null, found: r.found, recommendations: r.recommendations, problems: r.problems }));
  else if (r.ok) console.log(`✓ ${r.verdict}, ${r.recommendations.length} recommendations, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
