#!/usr/bin/env bun
// SigmaRulesCheck — checks a SigmaRules output against the parts of its
// contract code can judge: every rule sits in its own
// "#### Sigma Rule: <title>" / ```yaml / "#### End of Sigma Rule" section,
// the YAML parses (Bun.YAML.parse) with no duplicate keys, the Sigma required
// fields are present (title, logsource, detection with a condition) along with
// the fields the intent requires, the condition names only defined search
// identifiers and uses every one, and modifiers, ids, levels, statuses and tags
// are well formed. Whether a rule fits its source stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `SigmaRulesCheck — shape and validity check for a Fabric SigmaRules output

  bun skills/Fabric/Tools/SigmaRulesCheck.ts <file|-> [--json]

  --json      print {ok, rules, problems}
Exit: 0 every rule is valid, 1 a rule failed, 2 bad usage or unreadable input.`;

export type RuleResult = { title: string; line: number; problems: string[]; parsed?: Record<string, unknown> };
export type CheckResult = { ok: boolean; rules: RuleResult[]; problems: string[] };

const HEADER = /^####\s+Sigma Rule:\s*(.*?)\s*$/;
const FOOTER = /^####\s+End of Sigma Rule\s*$/;
const NOT_COVERED = /^####\s+Not covered\s*$/i;
const FENCE_OPEN = /^```ya?ml\s*$/;
const FENCE_CLOSE = /^```\s*$/;

const REQUIRED = ["title", "id", "status", "description", "date", "logsource", "detection", "falsepositives", "level", "tags"] as const;
const STATUSES = new Set(["stable", "test", "experimental", "deprecated", "unsupported"]);
const LEVELS = new Set(["informational", "low", "medium", "high", "critical"]);
const MODIFIERS = new Set([
  "contains", "all", "startswith", "endswith", "base64", "base64offset", "utf16le", "utf16be", "wide", "utf16",
  "windash", "re", "i", "m", "s", "cidr", "exists", "expand", "fieldref", "lt", "lte", "gt", "gte", "cased",
  "minute", "hour", "day", "week", "month", "year",
]);
// The two ids in the upstream pattern's example output; a rule carrying one was copied, not written.
const UPSTREAM_EXAMPLE_IDS = new Set(["e3f8b2a0-5b6e-11ec-bf63-0242ac130002", "e3f8b2a1-5b6e-11ec-bf63-0242ac130002"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAG = /^[a-z0-9_-]+\.[a-z0-9._-]+$/;
const TECHNIQUE_TAG = /^attack\.t\d{4}(\.\d{3})?$/;
const CONDITION_WORDS = new Set(["and", "or", "not", "of", "them", "all", "any"]);

function isMap(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function isScalar(v: unknown): boolean {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

function unquote(k: string): string {
  if (k.startsWith("'") && k.endsWith("'")) return k.slice(1, -1).replace(/''/g, "'");
  if (k.startsWith('"') && k.endsWith('"')) return k.slice(1, -1);
  return k.trim();
}

/** Keys repeated inside one YAML mapping. Bun.YAML.parse keeps the last one silently, which drops a selection. */
export function duplicateKeys(yaml: string): string[] {
  const out: string[] = [];
  const stack: { indent: number; keys: Set<string> }[] = [];
  let blockIndent = -1;
  for (const raw of yaml.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    let ind = raw.match(/^ */)![0].length;
    if (blockIndent >= 0) {
      if (ind > blockIndent) continue;
      blockIndent = -1;
    }
    let line = raw.slice(ind);
    while (line.startsWith("- ") || line === "-") {
      if (line === "-") { line = ""; break; }
      ind += 2;
      line = line.slice(2);
      while (stack.length && stack[stack.length - 1].indent >= ind) stack.pop();
      const extra = line.match(/^ */)![0].length;
      ind += extra;
      line = line.slice(extra);
      stack.push({ indent: ind, keys: new Set() });
    }
    const m = line.match(/^('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^\s'"#\-[{][^:#]*?|-[^\s][^:#]*?)\s*:(?:\s|$)/);
    if (!m) continue;
    const key = unquote(m[1]);
    while (stack.length && stack[stack.length - 1].indent > ind) stack.pop();
    if (!stack.length || stack[stack.length - 1].indent < ind) stack.push({ indent: ind, keys: new Set() });
    const top = stack[stack.length - 1];
    if (top.keys.has(key)) out.push(key);
    else top.keys.add(key);
    if (/:\s*[|>][-+0-9]*\s*(#.*)?$/.test(line)) blockIndent = ind;
  }
  return out;
}

function checkFieldMap(where: string, map: Record<string, unknown>, problems: string[]) {
  const entries = Object.entries(map);
  if (entries.length === 0) problems.push(`${where} is an empty mapping`);
  for (const [key, value] of entries) {
    const [field, ...mods] = key.split("|");
    if (field.trim() === "") problems.push(`${where}: key "${key}" has no field name`);
    for (const mod of mods) if (!MODIFIERS.has(mod)) problems.push(`${where}: "${mod}" in "${key}" is not a Sigma modifier`);
    if (isMap(value)) problems.push(`${where}: field "${key}" holds a nested mapping; a field takes a value or a list of values`);
    else if (Array.isArray(value)) {
      if (value.length === 0) problems.push(`${where}: field "${key}" has an empty list`);
      if (value.some((v) => !isScalar(v))) problems.push(`${where}: field "${key}" lists something other than plain values`);
    }
  }
}

function checkDetection(detection: Record<string, unknown>, problems: string[]) {
  const ids = Object.keys(detection).filter((k) => k !== "condition" && k !== "timeframe");
  if (ids.length === 0) problems.push("detection defines no search identifier (selection) besides its condition");
  for (const id of ids) {
    const v = detection[id];
    if (isMap(v)) checkFieldMap(`detection.${id}`, v, problems);
    else if (Array.isArray(v)) {
      if (v.length === 0) problems.push(`detection.${id} is an empty list`);
      v.forEach((item, i) => {
        if (isMap(item)) checkFieldMap(`detection.${id}[${i}]`, item, problems);
        else if (!isScalar(item)) problems.push(`detection.${id}[${i}] is neither a mapping nor a keyword`);
      });
    } else problems.push(`detection.${id} must be a mapping of fields or a list, not ${v === null ? "empty" : typeof v}`);
  }

  const raw = detection.condition;
  const conditions = typeof raw === "string" ? [raw] : Array.isArray(raw) && raw.every((c) => typeof c === "string") ? (raw as string[]) : null;
  if (raw === undefined) { problems.push("detection has no condition"); return; }
  if (!conditions || conditions.length === 0 || conditions.some((c) => c.trim() === "")) { problems.push("detection.condition must be a non-empty string or list of strings"); return; }

  const used = new Set<string>();
  for (const cond of conditions) {
    if (cond.includes("|")) problems.push(`condition "${cond}" uses an aggregation pipe; Sigma v2 moved aggregations to correlation rules`);
    const tokens = cond.split("|")[0].replace(/[()]/g, " ").split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      const low = t.toLowerCase();
      if (CONDITION_WORDS.has(low) || /^\d+$/.test(t)) {
        if (low === "them") ids.forEach((id) => used.add(id));
        continue;
      }
      if (t.includes("*")) {
        const re = new RegExp(`^${t.replace(/[.+?^${}()[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
        const hits = ids.filter((id) => re.test(id));
        if (hits.length === 0) problems.push(`condition pattern "${t}" matches no search identifier`);
        hits.forEach((h) => used.add(h));
      } else if (!ids.includes(t)) problems.push(`condition names "${t}", which the detection does not define`);
      else used.add(t);
    }
  }
  for (const id of ids) if (!used.has(id)) problems.push(`search identifier "${id}" is defined but the condition never uses it`);
}

export function checkRule(yaml: string, headerTitle: string): { problems: string[]; parsed?: Record<string, unknown> } {
  const problems: string[] = [];
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(yaml);
  } catch (e) {
    return { problems: [`YAML does not parse: ${(e as Error).message}`] };
  }
  if (Array.isArray(doc) || !isMap(doc)) return { problems: ["the YAML block is not a single mapping (one rule per block)"] };

  for (const key of duplicateKeys(yaml)) problems.push(`duplicate key "${key}" in one mapping; the parser keeps only the last`);
  for (const f of REQUIRED) if (!(f in doc) || doc[f] === null || doc[f] === "") problems.push(`missing required field "${f}"`);

  if ("title" in doc) {
    if (typeof doc.title !== "string" || !doc.title.trim()) problems.push("title must be a non-empty string");
    else if (headerTitle && doc.title.trim() !== headerTitle) problems.push(`header title "${headerTitle}" differs from the YAML title "${doc.title.trim()}"`);
  }
  if (doc.id !== undefined && doc.id !== null) {
    const id = String(doc.id);
    if (!UUID.test(id)) problems.push(`id "${id}" is not a UUID`);
    if (UPSTREAM_EXAMPLE_IDS.has(id.toLowerCase())) problems.push(`id "${id}" is copied from the upstream example`);
  }
  if (doc.status !== undefined && doc.status !== null && !STATUSES.has(String(doc.status))) problems.push(`status "${doc.status}" is not one of ${[...STATUSES].join(", ")}`);
  if (doc.level !== undefined && doc.level !== null && !LEVELS.has(String(doc.level))) problems.push(`level "${doc.level}" is not one of ${[...LEVELS].join(", ")}`);
  if (doc.date !== undefined && doc.date !== null) {
    const d = doc.date instanceof Date ? doc.date.toISOString().slice(0, 10) : String(doc.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) problems.push(`date "${d}" is not YYYY-MM-DD`);
  }
  if (typeof doc.author === "string" && /your name|<.*>/i.test(doc.author)) problems.push(`author "${doc.author}" is a placeholder`);

  if ("logsource" in doc) {
    const ls = doc.logsource;
    if (!isMap(ls)) problems.push("logsource must be a mapping");
    else if (!["category", "product", "service"].some((k) => typeof ls[k] === "string" && (ls[k] as string).trim())) problems.push("logsource names none of category, product or service");
  }
  if ("detection" in doc) {
    if (!isMap(doc.detection)) problems.push("detection must be a mapping");
    else checkDetection(doc.detection, problems);
  }
  if ("falsepositives" in doc) {
    const fp = doc.falsepositives;
    if (!Array.isArray(fp) || fp.length === 0 || fp.some((x) => typeof x !== "string" || !x.trim())) problems.push("falsepositives must be a non-empty list of strings");
  }
  if ("tags" in doc) {
    const tags = doc.tags;
    if (!Array.isArray(tags) || tags.length === 0) problems.push("tags must be a non-empty list");
    else {
      for (const t of tags) if (typeof t !== "string" || !TAG.test(t)) problems.push(`tag "${String(t)}" is not a lowercase namespace.name tag`);
      if (!tags.some((t) => typeof t === "string" && TECHNIQUE_TAG.test(t))) problems.push("tags carry no ATT&CK technique (attack.tNNNN or attack.tNNNN.NNN)");
    }
  }
  return { problems, parsed: doc };
}

export function check(input: string): CheckResult {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const rules: RuleResult[] = [];
  let i = 0;
  let notCovered = false;
  const skipBlank = () => { while (i < lines.length && lines[i].trim() === "") i++; };

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    if (notCovered) {
      if (!/^\s*[-*]\s+\S/.test(line)) problems.push(`line ${i + 1}: only bullets may follow "#### Not covered" ("${line.trim()}")`);
      i++;
      continue;
    }
    if (NOT_COVERED.test(line)) {
      if (rules.length === 0) problems.push(`line ${i + 1}: "#### Not covered" comes before any rule`);
      notCovered = true;
      i++;
      continue;
    }
    const h = line.match(HEADER);
    if (!h) {
      problems.push(`line ${i + 1}: text outside a rule section ("${line.trim().slice(0, 80)}")`);
      i++;
      continue;
    }
    const rule: RuleResult = { title: h[1], line: i + 1, problems: [] };
    rules.push(rule);
    if (!h[1]) rule.problems.push("header carries no title");
    i++;
    skipBlank();
    if (i >= lines.length || !FENCE_OPEN.test(lines[i])) {
      rule.problems.push("no ```yaml block directly under the header");
      continue;
    }
    i++;
    const body: string[] = [];
    while (i < lines.length && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
    if (i >= lines.length) {
      rule.problems.push("the ```yaml block is never closed");
      break;
    }
    i++;
    const r = checkRule(body.join("\n"), h[1]);
    rule.problems.push(...r.problems);
    rule.parsed = r.parsed;
    skipBlank();
    if (i >= lines.length || !FOOTER.test(lines[i])) rule.problems.push('no "#### End of Sigma Rule" footer after the YAML block');
    else i++;
  }

  if (rules.length === 0) problems.push('no rules found (each opens on "#### Sigma Rule: <title>")');
  const ids = rules.map((r) => r.parsed?.id).filter((x) => x !== undefined && x !== null).map(String);
  for (const id of new Set(ids.filter((x, k) => ids.indexOf(x) !== k))) problems.push(`id "${id}" is used by more than one rule`);
  const titles = rules.map((r) => r.title).filter(Boolean);
  for (const t of new Set(titles.filter((x, k) => titles.indexOf(x) !== k))) problems.push(`title "${t}" is used by more than one rule`);

  const ok = problems.length === 0 && rules.every((r) => r.problems.length === 0);
  return { ok, rules, problems };
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
    console.error(`unknown flag ${unknown[0]}\n\n${HELP}`);
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
  if (json) console.log(JSON.stringify({ ok: r.ok, rules: r.rules.map((x) => ({ title: x.title, line: x.line, problems: x.problems })), problems: r.problems }));
  else if (r.ok) console.log(`✓ ${r.rules.length} rule${r.rules.length === 1 ? "" : "s"}, every one parses and holds the Sigma shape`);
  else {
    for (const p of r.problems) console.log(`✗ ${p}`);
    for (const x of r.rules) for (const p of x.problems) console.log(`✗ line ${x.line} "${x.title}": ${p}`);
  }
  process.exit(r.ok ? 0 : 1);
}
