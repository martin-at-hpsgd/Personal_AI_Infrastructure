#!/usr/bin/env bun
// TerraformPlanCheck — checks a TerraformPlan review (Intents/TerraformPlan.md)
// against the parts of its contract code can judge: the heading, a Summary of
// one sentence within 25 words, a Plan line in Terraform's count form, a Verdict
// from the fixed three, numbered Main points (at most 10, each opening on a
// bold kind and naming a backticked address) and Takeaways (at most 5), and
// nothing else. With --plan it also reads the plan itself (text, or JSON
// parsed with JSON.parse) and checks that the counts match, every destroy and
// replacement is named, every cited address exists, and no clear-text secret
// from the plan is repeated. Whether the findings are right stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `TerraformPlanCheck — shape check for a Fabric TerraformPlan review

  bun skills/Fabric/Tools/TerraformPlanCheck.ts <review|-> [--plan <plan.txt|plan.json>] [--json]

  --plan F  the plan the review is of (terraform plan text, or terraform show -json output);
            adds count, destroy/replace coverage, address and secret checks
  --json    print {ok, kind, counts, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const KINDS = ["Destroy", "Replace", "Security", "Cost", "Compliance", "Drift", "Change"] as const;
export const VERDICTS = ["Safe to apply", "Apply with care", "Do not apply as is"] as const;
const MAX_POINTS = 10;
const MAX_TAKEAWAYS = 5;
const MAX_SUMMARY_WORDS = 25;
const MAX_ITEM_WORDS = 30;

export type Counts = { import: number; add: number; change: number; destroy: number; replace: number };
export type Plan = { counts: Counts | null; addresses: Set<string>; removed: Set<string>; secrets: string[]; truncated: boolean };
type Item = { n: number; text: string; line: number };

const ANSI = /\x1b\[[0-9;]*m/g;
// A CI log's leading ISO timestamp on each line ("2026-03-02T10:14:01Z ").
const CI_STAMP = /^[ \t]*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?[ \t]+/gm;
// A resource address: optional module path, optional data., then type.name with an optional index.
const ADDRESS = /^((?:module\.[A-Za-z0-9_-]+(?:\[[^\]]*\])?\.)*(?:data\.)?[a-z][a-z0-9]*_[a-z0-9_]+\.[A-Za-z0-9_-]+(?:\[[^\]]*\])?)/;
const SECRET_KEY = /(password|passwd|secret|token|private_key|api_key|access_key|client_secret)/i;

function words(text: string): number {
  return text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

// ---------- plan parsing ----------

export function parsePlan(raw: string): Plan {
  const src = raw.replace(ANSI, "").replace(/\r\n/g, "\n").replace(CI_STAMP, "");
  const trimmed = src.trim();
  if (trimmed.startsWith("{")) return parseJsonPlan(JSON.parse(trimmed));
  return parseTextPlan(src);
}

function parseJsonPlan(doc: any): Plan {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.resource_changes)) {
    throw new Error("JSON plan has no resource_changes array (expected terraform show -json output)");
  }
  const counts: Counts = { import: 0, add: 0, change: 0, destroy: 0, replace: 0 };
  const addresses = new Set<string>();
  const removed = new Set<string>();
  const secrets: string[] = [];
  for (const rc of doc.resource_changes) {
    if (typeof rc?.address !== "string" || !Array.isArray(rc?.change?.actions)) continue;
    addresses.add(rc.address);
    const a: string[] = rc.change.actions;
    if (rc.change.importing) counts.import++;
    const has = (x: string) => a.includes(x);
    if (has("create") && has("delete")) { counts.add++; counts.destroy++; counts.replace++; removed.add(rc.address); }
    else if (has("create")) counts.add++;
    else if (has("update")) counts.change++;
    else if (has("delete")) { counts.destroy++; removed.add(rc.address); }
    collectSecrets(rc.change.after, secrets);
    collectSecrets(rc.change.before, secrets);
  }
  return { counts, addresses, removed, secrets, truncated: false };
}

function collectSecrets(v: unknown, out: string[], key = ""): void {
  if (typeof v === "string") { if (SECRET_KEY.test(key) && v.length >= 4) out.push(v); return; }
  if (Array.isArray(v)) { for (const x of v) collectSecrets(x, out, key); return; }
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) collectSecrets(x, out, k);
}

function parseTextPlan(src: string): Plan {
  const addresses = new Set<string>();
  const removed = new Set<string>();
  const secrets: string[] = [];
  const marked: Counts = { import: 0, add: 0, change: 0, destroy: 0, replace: 0 };
  for (const line of src.split("\n")) {
    const m = line.match(/^\s*# (\S+) (will be created|will be destroyed|will be updated in-place|must be replaced|is tainted, so must be replaced|will be replaced, as requested|will be read during apply|will be imported|has moved to (\S+))/);
    if (m) {
      const [, addr, what, moved] = m;
      addresses.add(addr);
      if (moved) addresses.add(moved);
      if (what === "will be created") marked.add++;
      else if (what === "will be updated in-place") marked.change++;
      else if (what === "will be destroyed") { marked.destroy++; removed.add(addr); }
      else if (/replaced/.test(what)) { marked.add++; marked.destroy++; marked.replace++; removed.add(addr); }
      else if (what === "will be imported") marked.import++;
      continue;
    }
    // Addresses Terraform names without planning a change: refresh and read lines, and drift ("has changed").
    const seen = line.match(/^\s*(\S+): (?:Refreshing state|Reading|Read complete|Still reading)\b/) ?? line.match(/^\s*# (\S+) (?:has changed|has been deleted)\b/);
    if (seen) { addresses.add(seen[1]); continue; }
    const s = line.match(/^\s*[-+~]?\s*"?([A-Za-z0-9_]+)"?\s*=\s*"([^"]{4,})"/);
    if (s && SECRET_KEY.test(s[1]) && !/^\(sensitive( value)?\)$/.test(s[2])) secrets.push(s[2]);
  }
  const p = src.match(/Plan:\s*(?:(\d+) to import, )?(\d+) to add, (\d+) to change, (\d+) to destroy/);
  const none = /No changes\.\s/.test(src) || /No changes\.$/m.test(src);
  let counts: Counts | null = null;
  if (p) counts = { import: Number(p[1] ?? 0), add: Number(p[2]), change: Number(p[3]), destroy: Number(p[4]), replace: marked.replace };
  else if (none) counts = { import: 0, add: 0, change: 0, destroy: 0, replace: 0 };
  return { counts, addresses, removed, secrets, truncated: !p && !none };
}

// ---------- review checking ----------

export type Result = { ok: boolean; kind: "review" | "not-a-plan" | "unknown"; counts: Counts | null; problems: string[] };

export function parsePlanLine(text: string): Counts | "not-available" | null {
  if (/^Not available \(.+\)$/.test(text)) return "not-available";
  const m = text.match(/^(?:(\d+) to import, )?(\d+) to add, (\d+) to change, (\d+) to destroy(?: \((\d+) replacements?\))?$/);
  if (!m) return null;
  return { import: Number(m[1] ?? 0), add: Number(m[2]), change: Number(m[3]), destroy: Number(m[4]), replace: Number(m[5] ?? 0) };
}

function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
}

function isAddressToken(tok: string): boolean {
  return ADDRESS.test(tok) || /^module\.[A-Za-z0-9_-]+/.test(tok);
}

function covers(token: string, address: string): boolean {
  return address === token || address.startsWith(token + "[") || address.startsWith(token + ".");
}

export function check(input: string, plan?: Plan): Result {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const content = lines.map((t, i) => ({ t: t.trimEnd(), i: i + 1 })).filter((l) => l.t.trim() !== "");
  const problems: string[] = [];

  if (content.length === 1 && /^\*\*Not a Terraform plan:\*\*\s+\S/.test(content[0].t.trim())) {
    return { ok: true, kind: "not-a-plan", counts: null, problems };
  }
  if (content.length === 0) return { ok: false, kind: "unknown", counts: null, problems: ["empty review"] };

  if (!/^## Terraform plan review: \S/.test(content[0].t)) problems.push(`line ${content[0].i}: the review must open on "## Terraform plan review: {what the plan does}"`);

  let summary: string | null = null, planText: string | null = null, verdict: string | null = null;
  const points: Item[] = [], takeaways: Item[] = [];
  let section: "head" | "points" | "takeaways" = "head";
  const seenSections = new Set<string>();

  for (const { t, i } of content.slice(1)) {
    const line = t.trim();
    let m: RegExpMatchArray | null;
    if (line === "### Main points" || line === "### Takeaways") {
      const name = line.slice(4);
      if (seenSections.has(name)) problems.push(`line ${i}: section "${name}" appears twice`);
      seenSections.add(name);
      if (name === "Takeaways" && !seenSections.has("Main points")) problems.push(`line ${i}: Takeaways come after Main points`);
      section = name === "Main points" ? "points" : "takeaways";
    } else if (section === "head" && (m = line.match(/^\*\*Summary:\*\*\s+(.+)$/))) {
      if (summary !== null) problems.push(`line ${i}: a second Summary line`);
      summary = m[1];
    } else if (section === "head" && (m = line.match(/^\*\*Plan:\*\*\s+(.+)$/))) {
      if (planText !== null) problems.push(`line ${i}: a second Plan line`);
      planText = m[1].trim();
    } else if (section === "head" && (m = line.match(/^\*\*Verdict:\*\*\s+(.+)$/))) {
      if (verdict !== null) problems.push(`line ${i}: a second Verdict line`);
      verdict = m[1].trim();
    } else if (section !== "head" && (m = line.match(/^(\d+)\.\s+(.+)$/))) {
      (section === "points" ? points : takeaways).push({ n: Number(m[1]), text: m[2], line: i });
    } else {
      problems.push(`line ${i}: text outside the review's sections ("${line.slice(0, 80)}")`);
    }
  }

  // Summary
  if (summary === null) problems.push("no **Summary:** line");
  else {
    const w = words(summary);
    if (w > MAX_SUMMARY_WORDS) problems.push(`Summary has ${w} words; at most ${MAX_SUMMARY_WORDS}`);
    const ends = summary.match(/[.!?](?=\s+[A-Z])/g);
    if (ends && ends.length > 0) problems.push("Summary is more than one sentence");
  }

  // Plan line
  let counts: Counts | null = null;
  let notAvailable = false;
  if (planText === null) problems.push("no **Plan:** line");
  else {
    const parsed = parsePlanLine(planText);
    if (parsed === null) problems.push(`Plan line "${planText}" is not "{a} to add, {c} to change, {d} to destroy" (optionally "{i} to import, " first and " (N replacements)" last) or "Not available ({reason})"`);
    else if (parsed === "not-available") notAvailable = true;
    else counts = parsed;
  }

  // Verdict
  let verdictWord: string | null = null;
  if (verdict === null) problems.push("no **Verdict:** line");
  else {
    verdictWord = VERDICTS.find((v) => verdict === v || verdict!.startsWith(v + ".")) ?? null;
    if (!verdictWord) problems.push(`Verdict "${verdict.slice(0, 60)}" does not open on one of: ${VERDICTS.join(" | ")} (followed by a period)`);
    else if (!/\.\s+\S/.test(verdict.slice(verdictWord.length))) problems.push("Verdict has no sentence of why after the verdict");
  }

  const noChanges = counts !== null && counts.import + counts.add + counts.change + counts.destroy === 0;

  // Lists
  const numbering = (items: Item[], name: string) => {
    items.forEach((it, idx) => { if (it.n !== idx + 1) problems.push(`line ${it.line}: ${name} item numbered ${it.n}, expected ${idx + 1}`); });
  };
  if (!seenSections.has("Main points") && !noChanges) problems.push("no ### Main points section (only a no-changes plan may leave it out)");
  if (seenSections.has("Main points") && points.length === 0 && !noChanges) problems.push("Main points section is empty");
  if (points.length > MAX_POINTS) problems.push(`${points.length} main points; at most ${MAX_POINTS}`);
  numbering(points, "Main points");
  const kindOf = (it: Item) => it.text.match(/^\*\*([A-Za-z]+)\*\*/)?.[1];
  for (const it of points) {
    const k = kindOf(it);
    if (!k || !(KINDS as readonly string[]).includes(k)) problems.push(`line ${it.line}: main point does not open on a bold kind (${KINDS.join(", ")})`);
    if (!backticked(it.text).some(isAddressToken)) problems.push(`line ${it.line}: main point names no resource address or module path in backticks`);
    const w = words(it.text);
    if (w > MAX_ITEM_WORDS) problems.push(`line ${it.line}: main point has ${w} words; keep it to one line of at most ${MAX_ITEM_WORDS}`);
  }
  if (!seenSections.has("Takeaways") && !noChanges) problems.push("no ### Takeaways section (only a no-changes plan may leave it out)");
  if (seenSections.has("Takeaways") && takeaways.length === 0) problems.push("Takeaways section is empty");
  if (takeaways.length > MAX_TAKEAWAYS) problems.push(`${takeaways.length} takeaways; at most ${MAX_TAKEAWAYS}`);
  numbering(takeaways, "Takeaways");
  for (const it of takeaways) {
    const w = words(it.text);
    if (w > MAX_ITEM_WORDS) problems.push(`line ${it.line}: takeaway has ${w} words; at most ${MAX_ITEM_WORDS}`);
  }

  // No item repeated
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const seen = new Map<string, number>();
  for (const it of [...points, ...takeaways]) {
    const key = norm(it.text.replace(/^\*\*[A-Za-z]+\*\*\s*/, ""));
    if (seen.has(key)) problems.push(`line ${it.line}: repeats line ${seen.get(key)}`);
    else seen.set(key, it.line);
  }

  // Verdict consistency
  const hasRemoval = points.some((it) => kindOf(it) === "Destroy" || kindOf(it) === "Replace") || (counts !== null && counts.destroy > 0);
  if (verdictWord === "Safe to apply" && hasRemoval) problems.push('a plan that destroys or replaces anything is never "Safe to apply"');

  // Against the plan itself
  if (plan) {
    if (plan.truncated && !notAvailable) problems.push('the plan has no closing "Plan:" line (cut off), so the Plan line must read "Not available (plan output is truncated; visible so far: …)"');
    if (plan.counts && counts) {
      const pc = plan.counts;
      for (const k of ["import", "add", "change", "destroy"] as const) {
        if (pc[k] !== counts[k]) problems.push(`Plan line says ${counts[k]} to ${k}, the plan says ${pc[k]}`);
      }
      if (pc.replace !== counts.replace) problems.push(`Plan line reports ${counts.replace} replacements, the plan has ${pc.replace}`);
    } else if (plan.counts && notAvailable && !plan.truncated) {
      problems.push(`Plan line reads "Not available" but the plan states its counts`);
    }
    const cited = points.flatMap((it) => backticked(it.text));
    for (const addr of plan.removed) {
      if (!cited.some((t) => covers(t, addr))) problems.push(`the plan destroys or replaces \`${addr}\`, and no main point names it`);
    }
    const allText = [summary ?? "", ...points.map((p) => p.text), ...takeaways.map((t) => t.text)].join("\n");
    for (const tok of backticked(allText)) {
      const m = tok.match(ADDRESS);
      if (!m || m[1].length !== tok.length && !/^[.[\s]/.test(tok.slice(m[1].length))) continue;
      const addr = m[1];
      const known = [...plan.addresses].some((a) => covers(addr, a) || covers(a, addr));
      if (!known) problems.push(`\`${addr}\` is not a resource address in the plan`);
    }
    for (const s of plan.secrets) if (input.includes(s)) problems.push("the review repeats a clear-text secret value from the plan");
  }

  return { ok: problems.length === 0, kind: "review", counts, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const pi = args.indexOf("--plan");
  if (pi >= 0 && (args[pi + 1] === undefined || args[pi + 1].startsWith("--"))) {
    console.error("--plan needs a file");
    process.exit(2);
  }
  const unknown = args.filter((a, i) => a.startsWith("--") && a !== "--json" && a !== "--plan" && !(pi >= 0 && i === pi + 1));
  if (unknown.length) {
    console.error(`unknown flag ${unknown[0]}`);
    process.exit(2);
  }
  const src = args.find((a, i) => (!a.startsWith("--") || a === "-") && !(pi >= 0 && i === pi + 1));
  let input: string;
  let plan: Plan | undefined;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  if (pi >= 0) {
    try {
      plan = parsePlan(readFileSync(args[pi + 1], "utf8"));
    } catch (e) {
      console.error(`cannot read plan ${args[pi + 1]}: ${(e as Error).message}`);
      process.exit(2);
    }
  }
  const r = check(input, plan);
  if (json) console.log(JSON.stringify(r));
  else if (r.ok) console.log(r.kind === "not-a-plan" ? "✓ not-a-plan line, shape holds" : `✓ review shape holds${plan ? ", and agrees with the plan" : ""}`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
