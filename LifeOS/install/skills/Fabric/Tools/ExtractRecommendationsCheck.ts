#!/usr/bin/env bun
// ExtractRecommendationsCheck — checks an ExtractRecommendations output
// against the parts of its contract code can judge: one "# Recommendations:"
// title, then either the single no-recommendations line or a bulleted list of
// 1-20 recommendations of 3-16 words each (a trailing "(implied)" tag not
// counted), stated ones before implied ones, the tag in its one exact form,
// no duplicates, and no bold or italics. Whether a line is really a
// recommendation, faithful to the source and specific to it, stays a judged
// check in the fabric-extractrecommendations suite.

import { readFileSync } from "node:fs";

const HELP = `ExtractRecommendationsCheck — shape check for a Fabric ExtractRecommendations output

  bun skills/Fabric/Tools/ExtractRecommendationsCheck.ts <file|-> [--json]

  --json  print {ok, recommendations, none, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const MAX_WORDS = 16;
export const MIN_WORDS = 3;
export const MAX_BULLETS = 20;
export const TAG = "(implied)";
const TAG_AT_END = /\s+\(implied\)$/;
const TAG_VARIANT = /[([]\s*(implied|inferred|implicit|derived)\s*[)\]]/i;

export type Recommendation = { text: string; implied: boolean; line: number };

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

export function norm(text: string): string {
  return text.trim().replace(TAG_AT_END, "").replace(/\s+/g, " ").replace(/[.;]+$/, "").toLowerCase();
}

function emphasis(line: string): boolean {
  if (/\*\*|__/.test(line)) return true;
  if (/(^|[\s(])\*[^\s*][^*\n]*?\*(?=$|[\s).,;:!?])/.test(line)) return true;
  if (/(^|[\s(])_[^\s_][^_\n]*?_(?=$|[\s).,;:!?])/.test(line)) return true;
  return false;
}

export function check(input: string): { ok: boolean; recommendations: Recommendation[]; none: boolean; problems: string[] } {
  const problems: string[] = [];
  const recommendations: Recommendation[] = [];
  const rows = input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((text, i) => ({ text: text.replace(/\s+$/, ""), line: i + 1 }))
    .filter((r) => r.text.trim() !== "");

  if (rows.length === 0) return { ok: false, recommendations, none: false, problems: ["the output is empty"] };

  for (const r of rows) if (emphasis(r.text)) problems.push(`line ${r.line}: bold or italics ("${r.text.trim().slice(0, 60)}"); the output is plain Markdown`);

  const [title, ...rest] = rows;
  if (!/^#\s+Recommendations:\s+\S/.test(title.text)) problems.push(`line ${title.line}: the output opens on a "# Recommendations: " title naming the source and the read`);

  // No-recommendations form.
  const sentinel = rest.find((r) => /^No recommendations found\b/i.test(r.text.trim()));
  if (sentinel) {
    if (rest.length !== 1) problems.push(`the no-recommendations form is the title and the single line "No recommendations found in …"; found ${rest.length} lines after the title`);
    if (!/^No recommendations found in\s+\S/.test(sentinel.text.trim())) problems.push(`line ${sentinel.line}: the line reads "No recommendations found in {the source}."`);
    return { ok: problems.length === 0, recommendations, none: true, problems };
  }

  for (const r of rest) {
    if (/^#{1,6}\s/.test(r.text)) { problems.push(`line ${r.line}: heading beyond the title ("${r.text.trim()}")`); continue; }
    if (/^\s+[-*+]\s/.test(r.text)) { problems.push(`line ${r.line}: nested bullet; each recommendation is one top-level bullet`); continue; }
    if (/^\s*\d+[.)]\s/.test(r.text)) { problems.push(`line ${r.line}: numbered list; recommendations are a bulleted list ("- ")`); continue; }
    const b = r.text.match(/^[-*+]\s+(.*\S)\s*$/);
    if (!b) { problems.push(`line ${r.line}: text outside the title and the list ("${r.text.trim().slice(0, 60)}")`); continue; }
    const raw = b[1];
    const implied = TAG_AT_END.test(raw);
    const body = raw.replace(TAG_AT_END, "");
    if (TAG_VARIANT.test(body)) problems.push(`line ${r.line}: the tag is exactly "${TAG}" at the end of the line ("${raw.slice(0, 60)}")`);
    recommendations.push({ text: body, implied, line: r.line });
  }

  if (recommendations.length === 0) problems.push('no recommendation bullets found (or use the single line "No recommendations found in …")');
  if (recommendations.length > MAX_BULLETS) problems.push(`${recommendations.length} recommendations; at most ${MAX_BULLETS}`);

  const seen = new Set<string>();
  let sawImplied = false;
  for (const rec of recommendations) {
    const n = words(rec.text).length;
    if (n > MAX_WORDS) problems.push(`line ${rec.line}: recommendation has ${n} words; at most ${MAX_WORDS}, not counting the ${TAG} tag`);
    if (n < MIN_WORDS) problems.push(`line ${rec.line}: recommendation is too short to act on ("${rec.text}"); at least ${MIN_WORDS} words`);
    if (rec.implied) sawImplied = true;
    else if (sawImplied) problems.push(`line ${rec.line}: a stated recommendation follows an implied one; stated ones come first`);
    const k = norm(rec.text);
    if (seen.has(k)) problems.push(`line ${rec.line}: duplicate recommendation ("${rec.text.slice(0, 60)}")`);
    seen.add(k);
  }

  return { ok: problems.length === 0, recommendations, none: false, problems };
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
  if (json) console.log(JSON.stringify({ ok: r.ok, recommendations: r.recommendations.map(({ text, implied }) => ({ text, implied })), none: r.none, problems: r.problems }));
  else if (r.ok) console.log(r.none ? "✓ no recommendations, shape holds" : `✓ ${r.recommendations.length} recommendations, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
