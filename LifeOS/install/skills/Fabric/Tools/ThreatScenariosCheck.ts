#!/usr/bin/env bun
// ThreatScenariosCheck — checks a ThreatScenarios output against the parts of
// its contract code can judge: one "# Threat Scenarios:" title, the five H2
// sections in order, a ranked scenario table whose rows are sorted by
// likelihood x impact with a valid call on each, controls that cite real ranks
// and cover every Defend row, a short narrative and a one-sentence conclusion,
// and no asterisks. Whether the ranking is realistic stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `ThreatScenariosCheck — shape check for a Fabric ThreatScenarios output

  bun skills/Fabric/Tools/ThreatScenariosCheck.ts <file|-> [--json]

  --json  print {ok, scenarios, controls, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const SECTIONS = ["THREAT SCENARIOS", "THREAT MODEL ANALYSIS", "RECOMMENDED CONTROLS", "NARRATIVE ANALYSIS", "CONCLUSION"] as const;
const LEVEL: Record<string, number> = { low: 1, medium: 2, high: 3 };

export type Scenario = { rank: number; text: string; likelihood: string; impact: string; call: "Defend" | "Watch" | "Accept"; reason?: string; line: number };
export type Control = { text: string; cites: number[]; line: number };

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

export function check(input: string): { ok: boolean; scenarios: Scenario[]; controls: Control[]; problems: string[] } {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const scenarios: Scenario[] = [];
  const controls: Control[] = [];

  // Asterisks outside inline code (a wildcard like `s3:*` is fine).
  lines.forEach((raw, i) => {
    if (raw.replace(/`[^`]*`/g, "").includes("*")) problems.push(`line ${i + 1}: asterisk outside inline code; the output uses no bold or italics`);
  });

  // Title and sections.
  const h1 = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^#\s/.test(l));
  const h2 = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^##\s/.test(l));
  if (h1.length !== 1) problems.push(`expected exactly one H1 title, found ${h1.length}`);
  else if (!/^#\s+Threat Scenarios:\s+\S/.test(h1[0].l)) problems.push(`line ${h1[0].i + 1}: the title opens "# Threat Scenarios: " and names what is protected`);
  if (h1.length && h2.length && h1[0].i > h2[0].i) problems.push("the H1 title comes before every section");
  const firstContent = lines.findIndex((l) => l.trim() !== "");
  if (h1.length && firstContent !== h1[0].i) problems.push(`line ${firstContent + 1}: text before the title`);

  const names = h2.map(({ l }) => l.replace(/^##\s+/, "").trim());
  if (names.join("|") !== SECTIONS.join("|")) {
    problems.push(`sections must be exactly ${SECTIONS.join(", ")} in that order; found ${names.length ? names.join(", ") : "none"}`);
  }
  const body = (name: string): { text: string; line: number }[] => {
    const idx = h2.findIndex(({ l }) => l.replace(/^##\s+/, "").trim() === name);
    if (idx < 0) return [];
    const end = idx + 1 < h2.length ? h2[idx + 1].i : lines.length;
    return lines.slice(h2[idx].i + 1, end).map((text, k) => ({ text, line: h2[idx].i + 2 + k }));
  };
  if (h1.length && h2.length) {
    for (const { text, line } of lines.slice(h1[0].i + 1, h2[0].i).map((text, k) => ({ text, line: h1[0].i + 2 + k }))) {
      if (text.trim() !== "") problems.push(`line ${line}: text between the title and the first section`);
    }
  }

  // THREAT SCENARIOS: the table and nothing else.
  const sc = body("THREAT SCENARIOS").filter((r) => r.text.trim() !== "");
  if (sc.length) {
    const nonTable = sc.filter((r) => !r.text.trim().startsWith("|"));
    for (const r of nonTable) problems.push(`line ${r.line}: THREAT SCENARIOS holds only the table ("${r.text.trim().slice(0, 60)}")`);
    const table = sc.filter((r) => r.text.trim().startsWith("|"));
    const header = table[0] ? cells(table[0].text).map((c) => c.toLowerCase()) : [];
    if (header.join("|") !== "rank|scenario|likelihood|impact|call") problems.push(`THREAT SCENARIOS table header must be | Rank | Scenario | Likelihood | Impact | Call |`);
    else if (!table[1] || !cells(table[1].text).every((c) => /^:?-{3,}:?$/.test(c))) problems.push("THREAT SCENARIOS table has no separator row under its header");
    else {
      for (const r of table.slice(2)) {
        const c = cells(r.text);
        if (c.length !== 5) { problems.push(`line ${r.line}: scenario row has ${c.length} cells, expected 5`); continue; }
        const [rank, text, likelihood, impact, call] = c;
        const s: Partial<Scenario> = { rank: Number(rank), text, likelihood, impact, line: r.line };
        if (!/^\d+$/.test(rank)) problems.push(`line ${r.line}: rank "${rank}" is not a whole number`);
        if (!(likelihood.toLowerCase() in LEVEL)) problems.push(`line ${r.line}: likelihood "${likelihood}" is not Low, Medium or High`);
        if (!(impact.toLowerCase() in LEVEL)) problems.push(`line ${r.line}: impact "${impact}" is not Low, Medium or High`);
        const n = words(text).length;
        if (n < 5 || n > 25) problems.push(`line ${r.line}: scenario has ${n} words; it is one plain sentence of 5 to 25`);
        const m = call.match(/^(Defend|Watch|Accept)\b\s*(?::\s*(.*))?$/i);
        if (!m) problems.push(`line ${r.line}: call "${call}" is not Defend, Watch, or Accept: <reason>`);
        else {
          s.call = (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) as Scenario["call"];
          s.reason = m[2]?.trim();
          if (s.call === "Accept" && words(s.reason ?? "").length < 3) problems.push(`line ${r.line}: an Accept call carries its reason ("Accept: <why it gets no control>")`);
        }
        scenarios.push(s as Scenario);
      }
      if (scenarios.length < 4 || scenarios.length > 15) problems.push(`THREAT SCENARIOS has ${scenarios.length} rows; expected 4 to 15`);
      scenarios.forEach((s, i) => { if (s.rank !== i + 1) problems.push(`line ${s.line}: rank ${s.rank}, expected ${i + 1}`); });
      const risk = (s: Scenario) => (LEVEL[s.likelihood.toLowerCase()] ?? 0) * (LEVEL[s.impact.toLowerCase()] ?? 0);
      for (let i = 1; i < scenarios.length; i++) {
        if (risk(scenarios[i]) > risk(scenarios[i - 1])) problems.push(`line ${scenarios[i].line}: rank ${scenarios[i].rank} (${scenarios[i].likelihood}/${scenarios[i].impact}) outranks rank ${scenarios[i - 1].rank} (${scenarios[i - 1].likelihood}/${scenarios[i - 1].impact}); rows are ordered by likelihood times impact`);
      }
    }
  }

  // THREAT MODEL ANALYSIS: 3 to 8 short bullets.
  const an = body("THREAT MODEL ANALYSIS").filter((r) => r.text.trim() !== "");
  if (h2.some(({ l }) => l.includes("THREAT MODEL ANALYSIS"))) {
    const bullets = an.filter((r) => /^\s*-\s+\S/.test(r.text));
    for (const r of an.filter((r) => !/^\s*-\s+\S/.test(r.text))) problems.push(`line ${r.line}: THREAT MODEL ANALYSIS holds only bullets`);
    if (bullets.length < 3 || bullets.length > 10) problems.push(`THREAT MODEL ANALYSIS has ${bullets.length} bullets; expected 3 to 10`);
    for (const b of bullets) { const n = words(b.text).length; if (n > 20) problems.push(`line ${b.line}: analysis bullet has ${n} words; expected at most 20`); }
  }

  // RECOMMENDED CONTROLS: bullets that cite ranks.
  const co = body("RECOMMENDED CONTROLS").filter((r) => r.text.trim() !== "");
  if (h2.some(({ l }) => l.includes("RECOMMENDED CONTROLS"))) {
    for (const r of co) {
      if (!/^\s*-\s+\S/.test(r.text)) { problems.push(`line ${r.line}: RECOMMENDED CONTROLS holds only bullets`); continue; }
      const m = r.text.match(/\(\s*(#\d+(?:\s*,\s*#\d+)*)\s*\)\s*$/);
      if (!m) { problems.push(`line ${r.line}: control does not end by citing the ranks it addresses, e.g. (#1, #3)`); continue; }
      const cites = m[1].split(",").map((x) => Number(x.trim().slice(1)));
      const text = r.text.slice(0, r.text.lastIndexOf("(")).replace(/^\s*-\s+/, "").trim();
      const n = words(text).length;
      if (n < 4 || n > 30) problems.push(`line ${r.line}: control has ${n} words; expected 4 to 30`);
      controls.push({ text, cites, line: r.line });
    }
    const defend = scenarios.filter((s) => s.call === "Defend");
    if (defend.length && controls.length === 0) problems.push("RECOMMENDED CONTROLS is empty but scenarios are called Defend");
    if (controls.length > 10) problems.push(`RECOMMENDED CONTROLS has ${controls.length} controls; expected at most 10`);
    const byRank = new Map(scenarios.map((s) => [s.rank, s]));
    for (const c of controls) for (const k of c.cites) {
      const s = byRank.get(k);
      if (!s) problems.push(`line ${c.line}: control cites #${k}, which is not a scenario rank`);
      else if (s.call === "Accept") problems.push(`line ${c.line}: control cites #${k}, which is called Accept and gets no control`);
    }
    const covered = new Set(controls.flatMap((c) => c.cites));
    for (const s of defend) if (!covered.has(s.rank)) problems.push(`scenario #${s.rank} is called Defend but no control cites it`);
  }

  // NARRATIVE ANALYSIS: 1 to 3 prose paragraphs.
  const na = body("NARRATIVE ANALYSIS");
  if (h2.some(({ l }) => l.includes("NARRATIVE ANALYSIS"))) {
    const paras = na.map((r) => r.text).join("\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (paras.length < 1 || paras.length > 3) problems.push(`NARRATIVE ANALYSIS has ${paras.length} paragraphs; expected 1 to 3`);
    if (na.some((r) => /^\s*(?:[-+]|\d+[.)]|\|)\s/.test(r.text))) problems.push("NARRATIVE ANALYSIS is prose paragraphs, with no bullets, lists or tables");
  }

  // CONCLUSION: one sentence of 12 to 35 words.
  const cn = body("CONCLUSION").filter((r) => r.text.trim() !== "");
  if (h2.some(({ l }) => l.includes("CONCLUSION"))) {
    const text = cn.map((r) => r.text.trim()).join(" ");
    const sentences = text.split(/[.!?](?:\s+|$)/).map((s) => s.trim()).filter(Boolean);
    if (cn.length !== 1 || sentences.length !== 1) problems.push(`CONCLUSION is one sentence on one line; found ${sentences.length} sentence(s) on ${cn.length} line(s)`);
    const n = words(text).length;
    if (n < 12 || n > 35) problems.push(`CONCLUSION has ${n} words; expected 12 to 35`);
  }

  return { ok: problems.length === 0, scenarios, controls, problems };
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
  if (json) console.log(JSON.stringify({ ok: r.ok, scenarios: r.scenarios.map(({ rank, likelihood, impact, call }) => ({ rank, likelihood, impact, call })), controls: r.controls.map(({ cites }) => cites), problems: r.problems }));
  else if (r.ok) console.log(`✓ ${r.scenarios.length} scenarios, ${r.controls.length} controls, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
