#!/usr/bin/env bun
/**
 * Coverage.ts — the Trim intent's mechanical coverage check, so it is not redone by hand each run.
 *
 *   bun skills/Trim/Tools/Coverage.ts <original> <replacement>        # merge or tighten
 *   bun skills/Trim/Tools/Coverage.ts --verbatim <excerpt> <reference> # relocate
 *
 * Default mode lists every load-bearing token of the original text (backtick spans, file paths, tool and command
 * names, env-var and ALL_CAPS names, --flags, CamelCase and mid-sentence capitalized names, and the directive
 * words never/always/must/only) and reports each one the replacement no longer contains. Whether the replacement
 * still compels the same behavior, and whether every imperative verb survived, stays the human read-back.
 * --verbatim confirms a relocated excerpt sits in the reference unchanged (trailing whitespace ignored).
 *
 * Prints one JSON line. Exit 0 every token survives, 1 something is missing, 2 usage or unreadable file.
 */
import { readFileSync } from "node:fs";

const DIRECTIVES = ["never", "always", "must", "only", "Never", "Always", "Must", "Only"];

export function tokens(text: string): string[] {
  const out = new Set<string>();
  const add = (re: RegExp, group = 0) => { for (const m of text.matchAll(re)) out.add(m[group]); };
  add(/`([^`\n]+)`/g, 1);                                                   // backtick spans
  add(/(?:~|\.{1,2})?\/?[\w.@-]+(?:\/[\w.@-]+)+\/?/g);                       // paths with a slash
  add(/\b[\w-]+\.(?:md|ts|js|json|jsonl|yaml|yml|toml|sh|txt|plist)\b/g);   // bare filenames
  add(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g);                                     // env vars, OPERATIONAL_PREFERENCES
  add(/\b[A-Z]{3,}\b/g);                                                     // ALL_CAPS names (USER, ISA)
  add(/(?<![\w-])--[a-z][\w-]*/g);                                          // flags
  add(/\b[A-Z][a-z0-9]+[A-Z]\w*\b/g);                                       // CamelCase names
  add(/(?<![.!?:]\s|^|^[-*>#]\s|\n|\n[-*>#]\s|\n\d+\.\s)\b[A-Z][a-z]{2,}\b/g); // capitalized mid-sentence
  for (const w of DIRECTIVES) if (new RegExp(`\\b${w}\\b`).test(text)) out.add(w.toLowerCase());
  return [...out].filter((t) => t.trim().length > 1);
}

export function missing(original: string, replacement: string): string[] {
  const lower = replacement.toLowerCase();
  return tokens(original).filter((t) => (DIRECTIVES.includes(t) ? !new RegExp(`\\b${t}\\b`, "i").test(lower) : !replacement.includes(t)));
}

export function verbatim(excerpt: string, reference: string): boolean {
  const norm = (s: string) => s.split("\n").map((l) => l.trimEnd()).join("\n").trim();
  return norm(reference).includes(norm(excerpt));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const mode = args[0] === "--verbatim" ? "verbatim" : "coverage";
  const files = mode === "verbatim" ? args.slice(1) : args;
  if (files.length !== 2) {
    console.error("usage: Coverage.ts <original> <replacement> | Coverage.ts --verbatim <excerpt> <reference>");
    process.exit(2);
  }
  let a: string, b: string;
  try { [a, b] = files.map((f) => readFileSync(f, "utf8")); } catch (e) { console.error(String(e)); process.exit(2); }
  if (mode === "verbatim") {
    const ok = verbatim(a, b);
    console.log(JSON.stringify({ mode, ok }));
    process.exit(ok ? 0 : 1);
  }
  const lost = missing(a, b);
  console.log(JSON.stringify({ mode, ok: lost.length === 0, checked: tokens(a).length, missing: lost }));
  process.exit(lost.length ? 1 : 0);
}
