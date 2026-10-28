#!/usr/bin/env bun
// AnalyzeBillCheck — checks an AnalyzeBill output against the parts of its
// contract code can judge: the five sections in order, the five Bill fields in
// order with a date-shaped (or Not stated) introduction date, a Summary within
// its word cap, goal bullets that open on a provision anchor and stay within
// their word cap and count, "None found" alone under Covert goals, a Verdict of
// one of three labels with a capped sentence (Mostly overt when nothing covert
// was found), and no template placeholders. The two single-line outcomes
// (No bill found, Bill text unavailable) must be the whole output. Whether the
// covert goals are really in the cited provisions stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `AnalyzeBillCheck — shape check for a Fabric AnalyzeBill output

  bun skills/Fabric/Tools/AnalyzeBillCheck.ts <file|-> [--short] [--json]

  --short   apply the short form's limits (3 goals per list, 8-word goals, 16-word summary and verdict)
  --json    print {ok, outcome, overt, covert, verdict, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const SECTIONS = ["Bill", "Summary", "Overt goals", "Covert goals", "Verdict"] as const;
export const FIELDS = ["Bill", "Jurisdiction", "Sponsors", "Introduced", "Status"] as const;
export const VERDICTS = ["Mostly overt", "Mixed", "Mostly covert"] as const;
export const LIMITS = {
  full: { summary: 24, goal: 16, goals: 10, verdict: 30 },
  short: { summary: 16, goal: 8, goals: 3, verdict: 16 },
} as const;

const PLACEHOLDER = /\{[^}]*\}|Mostly overt\|Mixed/;
const SINGLE_LINES = [
  { outcome: "no-bill", re: /^\*\*No bill found:\*\*[ \t]+\S/ },
  { outcome: "unavailable", re: /^\*\*Bill text unavailable:\*\*[ \t]+\S/ },
] as const;
const DATE = /^(?:Not stated|\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?)$/;
const MAX_ANCHOR_WORDS = 6;

export type Goal = { anchor: string; text: string; line: number };
export type Outcome = "analysis" | "no-bill" | "unavailable";
export type Result = {
  ok: boolean;
  outcome: Outcome;
  fields: Record<string, string>;
  overt: Goal[];
  covert: Goal[];
  noneFound: boolean;
  verdict?: string;
  problems: string[];
};

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

export function check(input: string, opts: { short?: boolean } = {}): Result {
  const lim = opts.short ? LIMITS.short : LIMITS.full;
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const fields: Record<string, string> = {};
  const overt: Goal[] = [];
  const covert: Goal[] = [];
  let noneFound = false;
  let verdict: string | undefined;
  const trimmed = input.trim();

  for (const s of SINGLE_LINES) {
    if (s.re.test(trimmed)) {
      if (trimmed.split("\n").filter((l) => l.trim() !== "").length > 1) problems.push(`the single-line outcome must be the whole output`);
      return { ok: problems.length === 0, outcome: s.outcome, fields, overt, covert, noneFound, problems };
    }
  }
  if (lines.some((l) => SINGLE_LINES.some((s) => s.re.test(l.trim())))) problems.push("a single-line outcome (No bill found, Bill text unavailable) must be the whole output");
  if (trimmed === "") problems.push("the output is empty");

  const sections: { name: string; line: number; body: { text: string; line: number }[] }[] = [];
  lines.forEach((raw, i) => {
    const h2 = raw.match(/^##[ \t]+(.+?)\s*$/);
    if (h2 && !raw.startsWith("###")) sections.push({ name: h2[1], line: i + 1, body: [] });
    else if (sections.length === 0) {
      if (raw.trim() !== "") problems.push(`line ${i + 1}: text before "## Bill" ("${raw.trim().slice(0, 60)}")`);
    } else sections[sections.length - 1].body.push({ text: raw, line: i + 1 });
    if (PLACEHOLDER.test(raw)) problems.push(`line ${i + 1}: template placeholder left in ("${raw.trim().slice(0, 60)}")`);
  });

  const names = sections.map((s) => s.name);
  for (const s of sections) if (!(SECTIONS as readonly string[]).includes(s.name)) problems.push(`line ${s.line}: unexpected section "## ${s.name}"`);
  if (trimmed !== "") for (const want of SECTIONS) {
    const count = names.filter((n) => n === want).length;
    if (count === 0) problems.push(`missing section "## ${want}"`);
    else if (count > 1) problems.push(`section "## ${want}" appears ${count} times`);
  }
  const order = names.filter((n) => (SECTIONS as readonly string[]).includes(n));
  if (order.length === SECTIONS.length && order.some((n, i) => n !== SECTIONS[i])) problems.push(`sections out of order: ${order.join(", ")}`);
  const get = (name: string) => sections.find((s) => s.name === name);
  const nonblank = (name: string) => (get(name)?.body ?? []).filter((b) => b.text.trim() !== "");

  // Bill fields.
  if (get("Bill")) {
    const seen: string[] = [];
    for (const { text: raw, line } of nonblank("Bill")) {
      const m = raw.match(/^[ \t]*[-*][ \t]+\*\*([^*]+?):\*\*[ \t]*(.*?)\s*$/);
      if (!m) { problems.push(`line ${line}: Bill lines read "- **<Field>:** <value>" ("${raw.trim().slice(0, 60)}")`); continue; }
      const [, name, value] = m;
      if (!(FIELDS as readonly string[]).includes(name)) { problems.push(`line ${line}: unexpected Bill field "${name}"`); continue; }
      seen.push(name);
      fields[name] = value;
      if (value === "") problems.push(`line ${line}: "${name}" is empty (write "Not stated" when the text does not give it)`);
      if (name === "Introduced" && value !== "" && !DATE.test(value)) problems.push(`line ${line}: Introduced must be YYYY-MM-DD, YYYY-MM, YYYY or "Not stated", found "${value}"`);
    }
    if (seen.join("|") !== FIELDS.join("|")) problems.push(`"## Bill" must list ${FIELDS.join(", ")} once each, in that order`);
  }

  // Summary and Verdict prose.
  const paragraphs = (name: string) =>
    nonblank(name).map((b) => b.text.trim()).join("\n").split(/\n\s*\n/).filter((p) => p.trim() !== "");
  if (get("Summary")) {
    const s = get("Summary")!.body.map((b) => b.text).join("\n").trim().split(/\n\s*\n/).filter((p) => p.trim() !== "");
    if (s.length === 0) problems.push('"## Summary" is empty');
    else {
      if (s.length > 1) problems.push(`"## Summary" must be one paragraph, found ${s.length}`);
      if (/^\s*[-*][ \t]/m.test(s.join("\n"))) problems.push('"## Summary" is prose, not bullets');
      const n = words(s.join(" ")).length;
      if (n > lim.summary) problems.push(`"## Summary" has ${n} words; at most ${lim.summary}`);
    }
  }

  // Goal lists.
  const goals = (name: "Overt goals" | "Covert goals", out: Goal[]) => {
    if (!get(name)) return;
    let none = false;
    for (const { text: raw, line } of nonblank(name)) {
      const b = raw.match(/^[ \t]*[-*][ \t]+(.*\S)\s*$/);
      if (!b) { problems.push(`line ${line}: "${name}" holds only bullets ("${raw.trim().slice(0, 60)}")`); continue; }
      if (b[1] === "None found") {
        if (name === "Overt goals") problems.push(`line ${line}: "Overt goals" cannot be "None found"; every bill sets out to do something`);
        none = true;
        continue;
      }
      const m = b[1].match(/^\*\*([^*]+?):\*\*[ \t]+(.+)$/);
      if (!m) { problems.push(`line ${line}: goal must open on its provision, "- **Sec. N:** <goal>" ("${b[1].slice(0, 60)}")`); continue; }
      const [, anchor, text] = m;
      const aw = words(anchor).length;
      if (aw === 0 || aw > MAX_ANCHOR_WORDS) problems.push(`line ${line}: provision anchor "${anchor}" must be 1 to ${MAX_ANCHOR_WORDS} words`);
      const n = words(text).length;
      if (n > lim.goal) problems.push(`line ${line}: goal has ${n} words; at most ${lim.goal}`);
      out.push({ anchor, text, line });
    }
    if (none && out.length > 0) problems.push(`"${name}" lists "None found" beside other goals`);
    if (!none && out.length === 0) problems.push(`"${name}" has no goals${name === "Covert goals" ? ' (write "- None found" when there are none)' : ""}`);
    if (out.length > lim.goals) problems.push(`"${name}" has ${out.length} goals; at most ${lim.goals}`);
    if (name === "Covert goals") noneFound = none;
  };
  goals("Overt goals", overt);
  goals("Covert goals", covert);

  if (get("Verdict")) {
    const v = paragraphs("Verdict");
    if (v.length === 0) problems.push('"## Verdict" is empty');
    else {
      if (v.length > 1) problems.push(`"## Verdict" must be one paragraph, found ${v.length}`);
      const m = v[0].match(/^\*\*([^*]+?):\*\*[ \t]+(.+)$/s);
      if (!m) problems.push(`"## Verdict" must read "**<${VERDICTS.join("|")}>:** <sentence>"`);
      else if (!(VERDICTS as readonly string[]).includes(m[1])) problems.push(`verdict label "${m[1]}" is not one of ${VERDICTS.join(", ")}`);
      else {
        verdict = m[1];
        const n = words(m[2]).length;
        if (n < 3) problems.push("the verdict needs a sentence naming the deciding provision");
        if (n > lim.verdict) problems.push(`the verdict sentence has ${n} words; at most ${lim.verdict}`);
        if (noneFound && verdict !== "Mostly overt") problems.push(`Covert goals is "None found", so the verdict must be Mostly overt, found ${verdict}`);
      }
    }
  }

  return { ok: problems.length === 0, outcome: "analysis", fields, overt, covert, noneFound, verdict, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const unknown = args.filter((a) => a.startsWith("--") && !["--json", "--short"].includes(a));
  if (unknown.length) {
    console.error(`unknown flag ${unknown[0]}\n\n${HELP}`);
    process.exit(2);
  }
  const positional = args.filter((a) => a === "-" || !a.startsWith("--"));
  if (positional.length > 1) {
    console.error(`one input only\n\n${HELP}`);
    process.exit(2);
  }
  const src = positional[0];
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read input: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input, { short: args.includes("--short") });
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: r.ok, outcome: r.outcome, overt: r.overt.length, covert: r.noneFound ? 0 : r.covert.length, verdict: r.verdict ?? null, problems: r.problems }));
  } else if (r.ok) {
    console.log(r.outcome === "analysis" ? `✓ ${r.overt.length} overt, ${r.noneFound ? "no" : r.covert.length} covert, ${r.verdict}; shape holds` : `✓ ${r.outcome} line, shape holds`);
  } else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
