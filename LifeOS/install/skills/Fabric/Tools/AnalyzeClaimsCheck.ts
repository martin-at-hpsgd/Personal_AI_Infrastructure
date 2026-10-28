#!/usr/bin/env bun
// AnalyzeClaimsCheck — checks an AnalyzeClaims output against the parts of its
// contract code can judge: the four sections in order, an Argument summary of
// at most 30 words, numbered claims of at most 16 words, each with support and
// refutation evidence that is either the text's own or a named source with a
// year, fallacies that quote words, a grade letter paired with its word, labels,
// overall scores that follow from the claim grades, an Overall analysis of at
// most 40 words, and no template placeholders. With --source it also requires
// every quote to appear in the input. Whether the evidence is real and the
// grades are right stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `AnalyzeClaimsCheck — shape check for a Fabric AnalyzeClaims output

  bun skills/Fabric/Tools/AnalyzeClaimsCheck.ts <file|-> [--source <input-file>] [--json]

  --source F  the analyzed input; every fallacy quote and quoted "From the text:" passage must appear in it
  --json      print {ok, noClaims, claims, overall, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const SECTIONS = ["Argument summary", "Truth claims", "Overall score", "Overall analysis"] as const;
export const CLAIM_FIELDS = ["Support evidence", "Refutation evidence", "Logical fallacies"] as const;
export const GRADES: Record<string, { word: string; points: number }> = {
  A: { word: "True", points: 4 },
  B: { word: "Likely true", points: 3 },
  C: { word: "Mixed", points: 2 },
  D: { word: "Likely false", points: 1 },
  F: { word: "False", points: 0 },
};
const LETTER_BY_POINTS = ["F", "D", "C", "B", "A"];
const PLACEHOLDER = /\{[^}]*\}|\bA\|B\|C\b/;
const NO_CLAIMS = /^\*\*No truth claims:\*\*[ \t]+\S/;
const SOURCED = /\([^()]*\b(?:1[5-9]\d\d|20\d\d)\b[^()]*\)/;

export type Claim = { n: number; text: string; line: number; grade?: string; fields: Record<string, string[]>; labels?: string };
export type Result = { ok: boolean; noClaims: boolean; claims: Claim[]; overall: Record<string, string>; problems: string[] };

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

export function averageLetter(letters: string[]): string {
  const sum = letters.reduce((s, l) => s + GRADES[l].points, 0);
  // Round half up without floating error: floor((2*sum + n) / (2n)).
  return LETTER_BY_POINTS[Math.floor((2 * sum + letters.length) / (2 * letters.length))];
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function quotedSpans(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"]+)"|“([^”]+)”/g)) out.push((m[1] ?? m[2]).trim());
  return out;
}

// A quote is found when each piece between ellipses appears in the source.
export function quoteInSource(quote: string, source: string): boolean {
  const src = normalize(source);
  return quote
    .split(/\.\.\.|…|\[\.\.\.\]/)
    .map((p) => normalize(p).replace(/^[\s,.;:]+|[\s,.;:]+$/g, ""))
    .filter((p) => p.length > 0)
    .every((p) => src.includes(p));
}

export function check(input: string, source?: string): Result {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const claims: Claim[] = [];
  const overall: Record<string, string> = {};
  const trimmed = input.trim();

  if (NO_CLAIMS.test(trimmed)) {
    if (trimmed.split("\n").filter((l) => l.trim() !== "").length > 1) problems.push("the **No truth claims:** line must be the whole output");
    return { ok: problems.length === 0, noClaims: true, claims, overall, problems };
  }
  if (lines.some((l) => NO_CLAIMS.test(l.trim()))) problems.push("the **No truth claims:** line must be the whole output");

  // Split into H2 sections.
  const sections: { name: string; line: number; body: { text: string; line: number }[] }[] = [];
  lines.forEach((raw, i) => {
    const h2 = raw.match(/^##[ \t]+(.+?)\s*$/);
    if (h2 && !raw.startsWith("###")) {
      sections.push({ name: h2[1], line: i + 1, body: [] });
    } else if (sections.length === 0) {
      if (raw.trim() !== "") problems.push(`line ${i + 1}: text before "## Argument summary" ("${raw.trim().slice(0, 60)}")`);
    } else {
      sections[sections.length - 1].body.push({ text: raw, line: i + 1 });
    }
    if (PLACEHOLDER.test(raw)) problems.push(`line ${i + 1}: template placeholder left in ("${raw.trim().slice(0, 60)}")`);
  });

  const names = sections.map((s) => s.name);
  for (const s of sections) if (!(SECTIONS as readonly string[]).includes(s.name)) problems.push(`line ${s.line}: unexpected section "## ${s.name}"`);
  for (const want of SECTIONS) {
    const count = names.filter((n) => n === want).length;
    if (count === 0) problems.push(`missing section "## ${want}"`);
    else if (count > 1) problems.push(`section "## ${want}" appears ${count} times`);
  }
  const order = names.filter((n) => (SECTIONS as readonly string[]).includes(n));
  if (order.length === SECTIONS.length && order.some((n, i) => n !== SECTIONS[i])) problems.push(`sections out of order: ${order.join(", ")}`);
  const get = (name: string) => sections.find((s) => s.name === name);

  const prose = (name: string, max: number) => {
    const s = get(name);
    if (!s) return;
    const paras = s.body.map((b) => b.text.trim()).join("\n").trim().split(/\n\s*\n/).filter((p) => p.trim() !== "");
    if (paras.length === 0) return problems.push(`"## ${name}" is empty`);
    if (paras.length > 1) problems.push(`"## ${name}" must be one paragraph, found ${paras.length}`);
    const n = words(paras.join(" ")).length;
    if (n > max) problems.push(`"## ${name}" has ${n} words; at most ${max}`);
  };
  prose("Argument summary", 30);
  prose("Overall analysis", 40);

  // Truth claims.
  const tc = get("Truth claims");
  if (tc) {
    let cur: Claim | undefined;
    let field: string | undefined;
    for (const { text: raw, line } of tc.body) {
      const t = raw.trim();
      if (t === "") continue;
      const head = raw.match(/^###[ \t]+Claim[ \t]+(\d+):[ \t]*(.*?)\s*$/);
      if (head) {
        cur = { n: Number(head[1]), text: head[2], line, fields: {} };
        claims.push(cur);
        field = undefined;
        if (cur.n !== claims.length) problems.push(`line ${line}: claim numbered ${cur.n}, expected ${claims.length}`);
        const n = words(cur.text).length;
        if (n === 0) problems.push(`line ${line}: claim ${cur.n} has no text`);
        if (n > 16) problems.push(`line ${line}: claim ${cur.n} has ${n} words; at most 16`);
        continue;
      }
      if (/^###/.test(raw)) { problems.push(`line ${line}: claim heading must read "### Claim N: <claim>"`); continue; }
      if (!cur) { problems.push(`line ${line}: text before the first claim ("${t.slice(0, 60)}")`); continue; }
      const label = t.match(/^\*\*([^*]+?):\*\*[ \t]*(.*)$/);
      if (label) {
        const [, name, rest] = label;
        if ((CLAIM_FIELDS as readonly string[]).includes(name)) {
          if (cur.fields[name]) problems.push(`line ${line}: claim ${cur.n} repeats "${name}"`);
          cur.fields[name] = [];
          field = name;
          if (rest.trim() !== "") problems.push(`line ${line}: "${name}" items go on bullets below the label`);
        } else if (name === "Rating") {
          field = undefined;
          if (cur.grade) problems.push(`line ${line}: claim ${cur.n} has two ratings`);
          const r = rest.match(/^([A-Z])[ \t]+\(([^)]+)\):[ \t]*(.*)$/);
          if (!r) problems.push(`line ${line}: rating must read "<letter> (<word>): <reason>"`);
          else if (!GRADES[r[1]]) problems.push(`line ${line}: grade "${r[1]}" is not one of A, B, C, D, F`);
          else {
            cur.grade = r[1];
            if (r[2] !== GRADES[r[1]].word) problems.push(`line ${line}: grade ${r[1]} pairs with "${GRADES[r[1]].word}", found "${r[2]}"`);
            if (words(r[3]).length < 3) problems.push(`line ${line}: claim ${cur.n} rating needs a one-sentence reason`);
          }
        } else if (name === "Labels") {
          field = undefined;
          if (cur.labels !== undefined) problems.push(`line ${line}: claim ${cur.n} has two label lines`);
          cur.labels = rest.trim();
          if (rest.split(",").map((s) => s.trim()).filter(Boolean).length === 0) problems.push(`line ${line}: claim ${cur.n} has no labels`);
        } else problems.push(`line ${line}: unexpected field "**${name}:**" in claim ${cur.n}`);
        continue;
      }
      const bullet = raw.match(/^[ \t]*[-*][ \t]+(.*\S)\s*$/);
      if (bullet && field) { cur.fields[field].push(bullet[1]); continue; }
      problems.push(`line ${line}: unexpected text in claim ${cur.n} ("${t.slice(0, 60)}")`);
    }
    if (claims.length === 0) problems.push('no claims under "## Truth claims" (each opens on "### Claim N: <claim>")');

    for (const c of claims) {
      const missing = [...CLAIM_FIELDS.filter((f) => !c.fields[f]), ...(c.grade ? [] : ["Rating"]), ...(c.labels === undefined ? ["Labels"] : [])];
      if (missing.length) problems.push(`claim ${c.n}: missing ${missing.join(", ")}`);
      for (const f of ["Support evidence", "Refutation evidence"] as const) {
        const items = c.fields[f];
        if (!items) continue;
        if (items.length === 0) problems.push(`claim ${c.n}: "${f}" has no items (write "- None known" when there are none)`);
        if (items.includes("None known") && items.length > 1) problems.push(`claim ${c.n}: "${f}" lists "None known" beside other items`);
        for (const it of items) {
          if (it === "None known") continue;
          if (/^From the text:\s*\S/.test(it)) {
            if (source !== undefined) for (const q of quotedSpans(it)) if (words(q).length >= 3 && !quoteInSource(q, source)) problems.push(`claim ${c.n}: "From the text" quote not found in the source ("${q.slice(0, 60)}")`);
            continue;
          }
          if (!SOURCED.test(it)) problems.push(`claim ${c.n}: "${f}" item names no source with a year and is not marked "From the text:" ("${it.slice(0, 60)}")`);
        }
      }
      const fal = c.fields["Logical fallacies"];
      if (fal) {
        if (fal.length === 0) problems.push(`claim ${c.n}: "Logical fallacies" has no items (write "- None" when there are none)`);
        if (fal.includes("None") && fal.length > 1) problems.push(`claim ${c.n}: "Logical fallacies" lists "None" beside other items`);
        for (const it of fal) {
          if (it === "None") continue;
          const m = it.match(/^([^:"“]+):[ \t]*(["“].+["”])\s*$/);
          if (!m) { problems.push(`claim ${c.n}: fallacy must read 'Name: "exact words"' ("${it.slice(0, 60)}")`); continue; }
          const q = quotedSpans(m[2]);
          if (q.length === 0 || q.every((s) => s === "")) problems.push(`claim ${c.n}: fallacy "${m[1].trim()}" has an empty quote`);
          if (source !== undefined) for (const s of q) if (!quoteInSource(s, source)) problems.push(`claim ${c.n}: fallacy quote not found in the source ("${s.slice(0, 60)}")`);
        }
      }
    }
  }

  // Overall score.
  const os = get("Overall score");
  if (os) {
    const want = ["Lowest claim score", "Highest claim score", "Average claim score"];
    const seen: string[] = [];
    for (const { text: raw, line } of os.body) {
      if (raw.trim() === "") continue;
      const m = raw.match(/^[ \t]*[-*][ \t]+\*\*([^*]+?):\*\*[ \t]*([A-Z])\s*$/);
      if (!m) { problems.push(`line ${line}: overall score lines read "- **<Lowest|Highest|Average> claim score:** <letter>" ("${raw.trim().slice(0, 60)}")`); continue; }
      if (!want.includes(m[1])) { problems.push(`line ${line}: unexpected score "${m[1]}"`); continue; }
      if (!GRADES[m[2]]) problems.push(`line ${line}: grade "${m[2]}" is not one of A, B, C, D, F`);
      overall[m[1]] = m[2];
      seen.push(m[1]);
    }
    if (seen.join("|") !== want.join("|")) problems.push(`"## Overall score" must list ${want.join(", ")} once each, in that order`);
    const graded = claims.map((c) => c.grade).filter((g): g is string => !!g && !!GRADES[g]);
    if (graded.length > 0 && graded.length === claims.length) {
      const pts = graded.map((g) => GRADES[g].points);
      const expect: Record<string, string> = {
        "Lowest claim score": LETTER_BY_POINTS[Math.min(...pts)],
        "Highest claim score": LETTER_BY_POINTS[Math.max(...pts)],
        "Average claim score": averageLetter(graded),
      };
      for (const k of want) if (overall[k] && overall[k] !== expect[k]) problems.push(`${k.toLowerCase()} is ${overall[k]}, but the claim grades (${graded.join(", ")}) give ${expect[k]}`);
    }
  }

  return { ok: problems.length === 0, noClaims: false, claims, overall, problems };
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
  const unknown = args.filter((a, i) => a.startsWith("--") && a !== "--" && !["--json", "--source"].includes(a) && !(si >= 0 && i === si + 1));
  if (unknown.length) {
    console.error(`unknown flag ${unknown[0]}\n\n${HELP}`);
    process.exit(2);
  }
  const src = args.find((a, i) => (a === "-" || !a.startsWith("--")) && !(si >= 0 && i === si + 1));
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
  if (json) console.log(JSON.stringify({ ok: r.ok, noClaims: r.noClaims, claims: r.claims.map((c) => ({ n: c.n, text: c.text, grade: c.grade ?? null })), overall: r.overall, problems: r.problems }));
  else if (r.ok) console.log(r.noClaims ? "✓ no truth claims, shape holds" : `✓ ${r.claims.length} claims, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
