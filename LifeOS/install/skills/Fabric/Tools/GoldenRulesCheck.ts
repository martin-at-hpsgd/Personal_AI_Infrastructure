#!/usr/bin/env bun
// GoldenRulesCheck — checks a GoldenRules output against the parts of its
// contract code can judge: one "# Golden Rules:" title, the tier sections in
// order, rules numbered once across the document with every field present
// (Rule, Why, Basis with --source, Do, Don't, Test), 1-5 Critical and 1-15 in
// all, a Quick Reference table that matches the rules, and a checklist whose
// boxes cite real rules and cover every Critical one. Whether the rules are
// specific, faithful and well ranked stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `GoldenRulesCheck — shape check for a Fabric GoldenRules output

  bun skills/Fabric/Tools/GoldenRulesCheck.ts <file|-> [--source] [--json]

  --source  the input was a source: every rule needs a "Stated in" or "Observed in" Basis line
  --json    print {ok, rules, checklist, none, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const TIERS = [
  { heading: "Critical Rules", priority: "Critical" },
  { heading: "Important Rules", priority: "Important" },
  { heading: "Guidelines", priority: "Guideline" },
] as const;
const TAIL = ["Quick Reference", "Checklist"] as const;
const FIELDS = ["Rule", "Why", "Basis", "Do", "Don't", "Test"] as const;
type Field = (typeof FIELDS)[number];
type Priority = (typeof TIERS)[number]["priority"];

export type Rule = { n: number; name: string; tier: Priority; fields: Partial<Record<Field, string>>; line: number };
export type Box = { text: string; cites: number[]; line: number };

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

export function sentences(text: string): number {
  return text
    .replace(/`[^`]*`/g, "code")
    .replace(/\b(?:e\.g|i\.e|etc|vs)\./gi, "x")
    .replace(/(\d)\.(\d)/g, "$1$2")
    .split(/[.!?]+(?:\s+|$)/)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

// Lines outside fenced blocks, with fence state, so a "#" comment in a code example is not a heading.
function scan(lines: string[]): boolean[] {
  const inFence: boolean[] = [];
  let open: string | null = null;
  for (const l of lines) {
    const m = l.match(/^\s*(`{3,}|~{3,})/);
    if (open === null && m) { inFence.push(true); open = m[1]; continue; }
    if (open !== null) { inFence.push(true); if (m && m[1][0] === open[0] && m[1].length >= open.length && l.trim() === m[1]) open = null; continue; }
    inFence.push(false);
  }
  return inFence;
}

export function check(input: string, opts: { source?: boolean } = {}): { ok: boolean; rules: Rule[]; checklist: Box[]; none: boolean; problems: string[] } {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const fence = scan(lines);
  const problems: string[] = [];
  const rules: Rule[] = [];
  const checklist: Box[] = [];
  const at = (i: number) => ({ l: lines[i], i });
  const idx = lines.map((_, i) => i).filter((i) => !fence[i]);

  // Title.
  const h1 = idx.filter((i) => /^#\s/.test(lines[i])).map(at);
  const firstContent = lines.findIndex((l) => l.trim() !== "");
  if (h1.length !== 1) problems.push(`expected exactly one H1 title, found ${h1.length}`);
  else {
    if (!/^#\s+Golden Rules:\s+\S/.test(h1[0].l)) problems.push(`line ${h1[0].i + 1}: the title opens "# Golden Rules: " and names the subject and the read`);
    if (firstContent !== h1[0].i) problems.push(`line ${firstContent + 1}: text before the title`);
  }

  // The no-rules form: the title and one line, nothing else.
  const rest = lines.slice((h1[0]?.i ?? -1) + 1).map((t) => t.trim()).filter(Boolean);
  if (rest.some((t) => /^No golden rules found in\s+\S/.test(t))) {
    if (rest.length !== 1 || !/^No golden rules found in\s+\S.*\.$/.test(rest[0])) problems.push('the no-rules form is the title and the single line "No golden rules found in {the source}." with nothing else');
    return { ok: problems.length === 0, rules, checklist, none: true, problems };
  }

  // Sections: tiers that have rules, in order, then Quick Reference and Checklist.
  const h2 = idx.filter((i) => /^##\s/.test(lines[i])).map(at);
  const names = h2.map(({ l }) => l.replace(/^##\s+/, "").trim());
  const allowed = [...TIERS.map((t) => t.heading), ...TAIL] as string[];
  for (const n of names) if (!allowed.includes(n)) problems.push(`unknown section "## ${n}"; allowed: ${allowed.join(", ")}`);
  const order = names.filter((n) => allowed.includes(n)).map((n) => allowed.indexOf(n));
  if (order.some((v, k) => k > 0 && v <= order[k - 1])) problems.push(`sections out of order or repeated: ${names.join(", ")}; expected ${allowed.join(", ")}`);
  if (!names.includes("Critical Rules")) problems.push('missing "## Critical Rules"; every output has at least one Critical rule');
  for (const t of TAIL) if (!names.includes(t)) problems.push(`missing "## ${t}"`);
  if (h1.length && h2.length) {
    for (let i = h1[0].i + 1; i < h2[0].i; i++) if (lines[i].trim() !== "") { problems.push(`line ${i + 1}: text between the title and the first section`); break; }
  }
  for (const i of idx) if (/^#{4,}\s/.test(lines[i])) problems.push(`line ${i + 1}: heading deeper than H3; rules are "### {n}. {name}"`);

  const section = (name: string): { start: number; end: number } | null => {
    const k = h2.findIndex(({ l }) => l.replace(/^##\s+/, "").trim() === name);
    if (k < 0) return null;
    return { start: h2[k].i + 1, end: k + 1 < h2.length ? h2[k + 1].i : lines.length };
  };

  // Rules inside each tier.
  for (const tier of TIERS) {
    const s = section(tier.heading);
    if (!s) continue;
    const h3 = idx.filter((i) => i >= s.start && i < s.end && /^###\s/.test(lines[i]));
    if (h3.length === 0) { problems.push(`"## ${tier.heading}" has no rules; a tier with no rules is left out`); continue; }
    for (let i = s.start; i < h3[0]; i++) if (lines[i].trim() !== "") { problems.push(`line ${i + 1}: text under "## ${tier.heading}" before its first rule (no tier boilerplate)`); break; }
    h3.forEach((hi, k) => {
      const end = k + 1 < h3.length ? h3[k + 1] : s.end;
      const m = lines[hi].match(/^###\s+(\d+)\.\s+(.*\S)\s*$/);
      if (!m) { problems.push(`line ${hi + 1}: a rule heading is "### {n}. {Rule name}"`); return; }
      const rule: Rule = { n: Number(m[1]), name: m[2], tier: tier.priority, fields: {}, line: hi + 1 };
      const nw = words(rule.name).length;
      if (nw < 2 || nw > 10) problems.push(`line ${hi + 1}: rule name has ${nw} words; expected 2 to 10`);
      // Fields: "**Label**: text", the value running to the next label (fenced blocks included).
      const seen: Field[] = [];
      let cur: Field | null = null;
      let buf: string[] = [];
      const flush = () => { if (cur) rule.fields[cur] = buf.join("\n").trim(); };
      for (let i = hi + 1; i < end; i++) {
        const fm = fence[i] ? null : lines[i].match(/^\*\*([A-Za-z']+)\*\*\s*:\s*(.*)$/);
        if (fm) {
          const label = fm[1].replace("’", "'") as Field;
          if (!FIELDS.includes(label)) { problems.push(`line ${i + 1}: unknown field "**${fm[1]}**"; fields are ${FIELDS.join(", ")}`); continue; }
          if (seen.includes(label)) { problems.push(`line ${i + 1}: rule ${rule.n} repeats "**${label}**"`); continue; }
          flush();
          seen.push(label);
          cur = label;
          buf = [fm[2]];
        } else if (cur) buf.push(lines[i]);
        else if (lines[i].trim() !== "") problems.push(`line ${i + 1}: text in rule ${rule.n} outside its fields`);
      }
      flush();
      const want = FIELDS.filter((f) => f !== "Basis" || opts.source || seen.includes("Basis"));
      const missing = want.filter((f) => !seen.includes(f));
      if (missing.length) problems.push(`line ${hi + 1}: rule ${rule.n} is missing ${missing.map((f) => `**${f}**`).join(", ")}`);
      const present = seen.filter((f) => want.includes(f));
      const expectedOrder = want.filter((f) => present.includes(f));
      if (present.join("|") !== expectedOrder.join("|")) problems.push(`line ${hi + 1}: rule ${rule.n} fields out of order; expected ${want.join(", ")}`);
      for (const f of present) if (!rule.fields[f] || rule.fields[f]!.replace(/^`{3,}\S*\s*|`{3,}\s*$/g, "").trim() === "") problems.push(`line ${hi + 1}: rule ${rule.n} has an empty **${f}**`);
      const r = rule.fields.Rule ?? "";
      if (r && (sentences(r) > 2 || words(r).length > 40)) problems.push(`line ${hi + 1}: rule ${rule.n}'s **Rule** is ${sentences(r)} sentence(s) and ${words(r).length} words; expected at most 2 sentences and 40 words`);
      const w = rule.fields.Why ?? "";
      if (w && sentences(w) > 2) problems.push(`line ${hi + 1}: rule ${rule.n}'s **Why** is ${sentences(w)} sentences; expected at most 2`);
      const b = rule.fields.Basis;
      if (b !== undefined && b !== "" && !/^(?:Stated|Observed) in\s+\S/.test(b)) problems.push(`line ${hi + 1}: rule ${rule.n}'s **Basis** opens "Stated in" or "Observed in"`);
      const norm = (x?: string) => (x ?? "").replace(/\s+/g, " ").trim();
      if (rule.fields.Do && norm(rule.fields.Do) === norm(rule.fields["Don't"])) problems.push(`line ${hi + 1}: rule ${rule.n}'s **Do** and **Don't** are identical`);
      rules.push(rule);
    });
  }

  rules.forEach((r, k) => { if (r.n !== k + 1) problems.push(`line ${r.line}: rule numbered ${r.n}, expected ${k + 1} (rules are numbered once across the document)`); });
  const crit = rules.filter((r) => r.tier === "Critical").length;
  if (names.includes("Critical Rules") && (crit < 1 || crit > 5)) problems.push(`${crit} Critical rules; expected 1 to 5`);
  if (rules.length > 15) problems.push(`${rules.length} rules; expected at most 15`);
  const seenNames = new Set<string>();
  for (const r of rules) {
    const key = r.name.toLowerCase();
    if (seenNames.has(key)) problems.push(`line ${r.line}: rule name "${r.name}" repeats an earlier rule`);
    seenNames.add(key);
  }

  // Quick Reference: one row per rule, in order, priority matching the tier.
  const qr = section("Quick Reference");
  if (qr) {
    const body = lines.slice(qr.start, qr.end).map((text, k) => ({ text, line: qr.start + 1 + k })).filter((r) => r.text.trim() !== "");
    for (const r of body.filter((r) => !r.text.trim().startsWith("|"))) problems.push(`line ${r.line}: Quick Reference holds only the table`);
    const table = body.filter((r) => r.text.trim().startsWith("|"));
    const header = table[0] ? cells(table[0].text).map((c) => c.toLowerCase()) : [];
    if (header.join("|") !== "#|category|rule|priority") problems.push("Quick Reference header must be | # | Category | Rule | Priority |");
    else if (!table[1] || !cells(table[1].text).every((c) => /^:?-{3,}:?$/.test(c) || /^:?-+:?$/.test(c))) problems.push("Quick Reference table has no separator row under its header");
    else {
      const rows = table.slice(2);
      if (rows.length !== rules.length) problems.push(`Quick Reference has ${rows.length} rows for ${rules.length} rules`);
      rows.forEach((row, k) => {
        const c = cells(row.text);
        if (c.length !== 4) { problems.push(`line ${row.line}: Quick Reference row has ${c.length} cells, expected 4`); return; }
        const [num, cat, text, pri] = c;
        const rule = rules[k];
        if (Number(num.replace(/^#/, "")) !== k + 1) problems.push(`line ${row.line}: Quick Reference row ${k + 1} is numbered "${num}"`);
        if (words(cat).length < 1) problems.push(`line ${row.line}: Quick Reference row has no category`);
        const nw = words(text).length;
        if (nw < 1 || nw > 12) problems.push(`line ${row.line}: Quick Reference rule cell has ${nw} words; expected 1 to 12`);
        if (!["Critical", "Important", "Guideline"].includes(pri)) problems.push(`line ${row.line}: priority "${pri}" is not Critical, Important or Guideline`);
        else if (rule && rule.tier !== pri) problems.push(`line ${row.line}: rule ${rule.n} is ${rule.tier} but its row says ${pri}`);
      });
    }
  }

  // Checklist: boxes citing real rules, every Critical rule covered.
  const cl = section("Checklist");
  if (cl) {
    const body = lines.slice(cl.start, cl.end).map((text, k) => ({ text, line: cl.start + 1 + k })).filter((r) => r.text.trim() !== "");
    for (const r of body) {
      const m = r.text.match(/^- \[ \] (.*\S)\s*$/);
      if (!m) { problems.push(`line ${r.line}: Checklist holds only "- [ ] " boxes`); continue; }
      const cite = m[1].match(/\(\s*(#\d+(?:\s*,\s*#\d+)*)\s*\)\s*$/);
      if (!cite) { problems.push(`line ${r.line}: checklist box does not end by citing the rules it checks, e.g. (#1, #3)`); continue; }
      const cites = cite[1].split(",").map((x) => Number(x.trim().slice(1)));
      const text = m[1].slice(0, m[1].lastIndexOf("(")).trim();
      if (words(text).length < 3) problems.push(`line ${r.line}: checklist box has fewer than 3 words`);
      for (const n of cites) if (!rules.some((rr) => rr.n === n)) problems.push(`line ${r.line}: checklist box cites #${n}, which is not a rule`);
      checklist.push({ text, cites, line: r.line });
    }
    if (checklist.length < 1 || checklist.length > 15) problems.push(`Checklist has ${checklist.length} boxes; expected 1 to 15`);
    const covered = new Set(checklist.flatMap((b) => b.cites));
    for (const r of rules.filter((r) => r.tier === "Critical")) if (!covered.has(r.n)) problems.push(`Critical rule #${r.n} is cited by no checklist box`);
  }

  return { ok: problems.length === 0, rules, checklist, none: false, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const source = args.includes("--source");
  const unknown = args.filter((a) => a.startsWith("--") && a !== "--json" && a !== "--source");
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
  const r = check(input, { source });
  if (json) console.log(JSON.stringify({ ok: r.ok, rules: r.rules.map(({ n, name, tier }) => ({ n, name, tier })), checklist: r.checklist.map(({ cites }) => cites), none: r.none, problems: r.problems }));
  else if (r.ok) console.log(r.none ? "✓ no-rules form, shape holds" : `✓ ${r.rules.length} rules, ${r.checklist.length} checklist boxes, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
