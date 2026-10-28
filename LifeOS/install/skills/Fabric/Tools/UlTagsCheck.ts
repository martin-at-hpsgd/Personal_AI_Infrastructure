#!/usr/bin/env bun
// UlTagsCheck — checks a UlTags output against the parts of its contract code
// can judge: the whole output parses with JSON.parse, it is an object whose only
// key is `tags`, the value is an array of unique lowercase strings drawn from
// the twenty-tag vocabulary (plus any --extra tags a hint allowed), and `ai`
// never appears without `technology`. Whether each tag is earned stays a
// judged check in the fabric-ultags suite.

import { readFileSync } from "node:fs";

const HELP = `UlTagsCheck — shape check for a Fabric UlTags output

  bun skills/Fabric/Tools/UlTagsCheck.ts <file|-> [--extra tag1,tag2] [--json]

  --extra  comma-separated tags a hint allowed beside the twenty
  --json   print {ok, tags, problems}
Exit: 0 every rule holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const VOCABULARY = [
  "future", "politics", "cybersecurity", "books", "society", "science", "philosophy",
  "nationalsecurity", "ai", "culture", "personal", "innovation", "business", "meaning",
  "technology", "ethics", "productivity", "writing", "creativity", "tutorial",
] as const;

export function check(input: string, extra: string[] = []): { ok: boolean; tags: string[]; problems: string[] } {
  const problems: string[] = [];
  const text = input.trim();
  if (text.startsWith("```")) problems.push("the object is wrapped in a code fence; deliver the bare JSON object");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    problems.push(`output is not valid JSON: ${(e as Error).message}`);
    return { ok: false, tags: [], problems };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    problems.push("output is not a JSON object");
    return { ok: false, tags: [], problems };
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "tags") problems.push(`the object must hold exactly one key, "tags"; found ${keys.length ? keys.map((k) => `"${k}"`).join(", ") : "none"}`);
  const value = (parsed as Record<string, unknown>).tags;
  if (!Array.isArray(value)) {
    problems.push(`"tags" is not an array`);
    return { ok: false, tags: [], problems };
  }

  const allowed = new Set<string>([...VOCABULARY, ...extra.map((t) => t.trim()).filter(Boolean)]);
  const tags: string[] = [];
  const seen = new Set<string>();
  value.forEach((t, i) => {
    if (typeof t !== "string") {
      problems.push(`tag ${i + 1} is not a string (${JSON.stringify(t)})`);
      return;
    }
    tags.push(t);
    if (seen.has(t)) problems.push(`"${t}" appears more than once`);
    seen.add(t);
    if (!allowed.has(t)) {
      const near = VOCABULARY.find((v) => v === t.toLowerCase().replace(/[^a-z]/g, ""));
      problems.push(near ? `"${t}" is not spelled as listed; use "${near}"` : `"${t}" is not in the vocabulary`);
    }
  });

  if (seen.has("ai") && !seen.has("technology")) problems.push(`"ai" is tagged without "technology"; every AI piece also carries technology`);

  return { ok: problems.length === 0, tags, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const ei = args.indexOf("--extra");
  if (ei >= 0 && (args[ei + 1] === undefined || args[ei + 1].startsWith("--"))) {
    console.error("--extra needs a comma-separated list of tags");
    process.exit(2);
  }
  const extra = ei >= 0 ? args[ei + 1].split(",") : [];
  const src = args.find((a, i) => !a.startsWith("--") && !(ei >= 0 && i === ei + 1));
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input, extra);
  if (json) console.log(JSON.stringify({ ok: r.ok, tags: r.tags, problems: r.problems }));
  else if (r.ok) console.log(`✓ ${r.tags.length} tag${r.tags.length === 1 ? "" : "s"}, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
