#!/usr/bin/env bun
/**
 * @version 1.0.1
 * BlockMessageGate — every red box tells you how to get out of it.
 *
 * When a hook returns `decision: "block"` (or a deny permission decision), Claude
 * Code renders that hook's `reason` string in a red-outlined box. That box is the
 * only thing the model and the principal see. A block that states the PROBLEM but
 * not the FIX stops the work without moving it, which turns a gate into an
 * obstacle and invites the worst possible response: rewording the claim until the
 * gate stops firing.
 *
 * The contract (2026-07-31): every block message carries the problem and,
 * when there is one, the recommended fix:
 *
 *   PROBLEM — what was claimed or attempted, and what the gate actually observed.
 *   FIX     — the concrete next action, and where honest downgrade is acceptable,
 *             the downgrade wording that legitimately passes.
 *
 * This gate is deliberately a LINTER, not a refactor: it reads the block strings
 * where they already live rather than forcing every hook through a shared
 * builder, because these are safety-critical paths and a mass rewrite of them
 * carries more risk than the inconsistency it would fix.
 *
 * Usage:
 *   bun LIFEOS/TOOLS/BlockMessageGate.ts          # report; exit 1 on violation
 *   bun LIFEOS/TOOLS/BlockMessageGate.ts --json
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";

const CLAUDE_DIR = join(dirname(new URL(import.meta.url).pathname), "..", "..");
const HOOK_DIRS = [join(CLAUDE_DIR, "hooks"), join(CLAUDE_DIR, "hooks", "handlers")];

/**
 * Markers of an actionable remedy. Broad on purpose — the gate's job is to catch
 * a message that offers NO way forward, not to police phrasing. A false pass on
 * an awkwardly-worded fix costs nothing; a false failure would push authors to
 * pad messages with filler to satisfy a regex.
 */
const FIX_MARKERS = [
  /\bdo one\b/i,
  /\bthen restate\b/i,
  /\bor downgrade\b/i,
  /\bdowngrade honestly\b/i,
  /\bbefore stopping\b/i,
  /\binstead\b/i,
  /\bfix (?:the|it|and)\b/i,
  /\brun\b[^.]{0,60}\b(?:and|then|so)\b/i,
  /\bre-?run\b/i,
  /\bor state\b/i,
  /\bset .{0,30} back to\b/i,
  /\bnow, then\b/i,
  /\badd\b[^.]{0,40}\bthen\b/i,
];

/** Markers that the message says what actually went wrong (not just a label). */
const PROBLEM_MARKERS = [
  /\byou (?:claimed|asserted|declared|said)\b/i,
  /\bthe transcript shows\b/i,
  /\bbut\b/i,
  /\bhas hard violations\b/i,
  /\bthere is no record\b/i,
  /\bwas not\b/i,
  /\bnever\b/i,
];

export interface Finding {
  file: string;
  line: number;
  snippet: string;
  /** "scan" marks an incomplete scan: a directory or file the linter could not read, which blocks like any other finding. */
  missing: ("problem" | "fix" | "scan" | "unanalyzable")[];
}

/**
 * Pull the text of each `reason:` value. Handles the two shapes actually used in
 * this repo: a template literal, and a run of concatenated string/template parts.
 * Deliberately simple — a reason built by a helper call is reported as
 * unanalyzable rather than guessed at.
 */
function extractReasons(src: string): { line: number; text: string; computed: boolean; expr?: string }[] {
  const out: { line: number; text: string; computed: boolean; expr?: string }[] = [];
  const re = /reason:\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    let text = "";
    let segments = 0;
    let computed = false;
    let isType = false;
    let expr0: string | undefined;
    const skipWs = () => { while (i < src.length && /\s/.test(src[i])) i++; };
    // Consume a chain of `+`-joined parts. The guard counts SEGMENTS, not
    // characters: counting characters let indentation between parts exhaust the
    // budget and silently truncate a message to its first line, which reported
    // two compliant gates as missing their fix clause.
    skipWs();
    while (segments++ < 24) {
      const ch = src[i];
      if (ch === "`" || ch === '"' || ch === "'") {
        const quote = ch;
        let j = i + 1;
        while (j < src.length && !(src[j] === quote && src[j - 1] !== "\\")) j++;
        text += src.slice(i + 1, j);
        i = j + 1;
      } else if (/[A-Za-z_$]/.test(ch ?? "")) {
        // A computed part (`lines.join("\n")`, a helper call). Skip it rather
        // than stop — the remedy usually sits in a literal AFTER it.
        const start = i;
        while (i < src.length && !/[+,;\n]/.test(src[i])) i++;
        const expr = src.slice(start, i).replace(/[)\s]+$/, "");
        // `reason: string` in a signature or interface is a type annotation, not a block message.
        if (segments === 1 && /^(?:string|unknown|any)(?:\s*\|\s*(?:undefined|null))?(?:\s*\)\s*=>.*)?$/.test(expr)) { computed = false; text = ""; isType = true; break; }
        computed = true;
        expr0 ??= expr;
      } else break;
      skipWs();
      if (src[i] === "+") { i++; skipWs(); continue; }
      break;
    }
    // Every reason is returned, short or computed: the caller decides, and a reason it cannot read is a finding
    // (short and helper-built reasons used to vanish from the scan).
    if (!isType) out.push({ line: src.slice(0, m.index).split("\n").length, text, computed, expr: expr0 });
  }
  return out;
}

/** The template literals of `const NAME = { key: (…) => `…`, … }` when `expr` indexes NAME; null when it does not. */
export function tableEntries(src: string, expr: string | undefined): { line: number; text: string }[] | null {
  const name = expr?.match(/^([A-Za-z_$][\w$]*)\s*\[/)?.[1];
  if (!name) return null;
  const decl = new RegExp(`\\bconst\\s+${name}\\b[^\\n]*=\\s*\\{[ \\t]*$`, "m").exec(src);
  if (!decl) return null;
  const start = decl.index + decl[0].length;
  const end = src.indexOf("\n};", start);
  if (end < 0) return null;
  const body = src.slice(start, end);
  const out: { line: number; text: string }[] = [];
  for (const m of body.matchAll(/=>\s*`((?:[^`\\]|\\.)*)`/g)) {
    out.push({ line: src.slice(0, start + m.index!).split("\n").length, text: m[1]! });
  }
  return out;
}
function isBlockContext(src: string, lineNo: number): boolean {
  // A `reason:` within a few lines of a block/deny decision is a red-box message.
  const lines = src.split("\n");
  const from = Math.max(0, lineNo - 8);
  const window = lines.slice(from, lineNo + 2).join("\n");
  return /decision:\s*"block"|permissionDecision:\s*"deny"/.test(window);
}

/**
 * A directory or file the scan could not read is a finding, never a skip: a linter that
 * passes after silently dropping the files it could not open reports an all-clear it has not earned.
 */
export function scan(dirs: string[] = HOOK_DIRS, root: string = CLAUDE_DIR): Finding[] {
  const findings: Finding[] = [];
  const unreadable = (abs: string, e: unknown): void => {
    findings.push({ file: relative(root, abs) || abs, line: 0, snippet: `scan incomplete: could not read (${(e as NodeJS.ErrnoException)?.code ?? "error"})`, missing: ["scan"] });
  };
  for (const dir of dirs) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch (e) { unreadable(dir, e); continue; }
    for (const f of entries) {
      if (!f.endsWith(".ts") || f.includes(".test.")) continue;
      const abs = join(dir, f);
      let src: string;
      try { src = readFileSync(abs, "utf8"); } catch (e) { unreadable(abs, e); continue; }
      if (!/decision:\s*"block"|permissionDecision:\s*"deny"/.test(src)) continue;
      for (const r of extractReasons(src)) {
        if (!isBlockContext(src, r.line)) continue;
        // A reason with too little literal text to judge (short, or built by a helper with no literal remedy) is
        // reported, never skipped: the scan cannot vouch for a message it could not read.
        // A reason read from a message table in the same file (`MSGS[type](…)`) is judged entry by entry:
        // every template the table holds must carry both clauses, and a table the scan cannot read is unanalyzable.
        const table = r.computed && r.text.trim().length <= 20 ? tableEntries(src, r.expr) : null;
        if (table && table.length) {
          for (const t of table) {
            const miss: ("problem" | "fix")[] = [];
            if (!PROBLEM_MARKERS.some((p) => p.test(t.text))) miss.push("problem");
            if (!FIX_MARKERS.some((p) => p.test(t.text))) miss.push("fix");
            if (miss.length) findings.push({ file: relative(root, abs), line: t.line, snippet: t.text.replace(/\s+/g, " ").slice(0, 100), missing: miss });
          }
          continue;
        }
        if (r.text.trim().length <= 20) {
          findings.push({
            file: relative(root, abs),
            line: r.line,
            snippet: (r.computed ? `computed reason, literal text: "${r.text.trim()}"` : r.text.trim()).replace(/\s+/g, " ").slice(0, 100),
            missing: ["unanalyzable"],
          });
          continue;
        }
        const missing: ("problem" | "fix")[] = [];
        if (!PROBLEM_MARKERS.some((p) => p.test(r.text))) missing.push("problem");
        if (!FIX_MARKERS.some((p) => p.test(r.text))) missing.push("fix");
        if (missing.length) {
          findings.push({
            file: relative(root, abs),
            line: r.line,
            snippet: r.text.replace(/\s+/g, " ").slice(0, 100),
            missing,
          });
        }
      }
    }
  }
  return findings;
}

function main(): never {
const findings = scan();
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2));
} else {
  console.log("── BlockMessageGate — every block states the problem AND the fix ──");
  if (findings.length === 0) {
    console.log("  all block messages carry a problem clause and a remedy ✅");
  } else {
    for (const f of findings) {
      console.log(`\n  ${f.file}:${f.line}  missing: ${f.missing.join(" + ")}`);
      console.log(`    "${f.snippet}…"`);
    }
    console.log(
      `\n${findings.length} finding(s): block messages that leave the reader stuck, or hook files the scan could not read (the scan is incomplete, so this is not a pass). A block must say what it observed and what to do next — see hooks/README.md § Block messages.`,
    );
  }
}
process.exit(findings.length === 0 ? 0 : 1);
}

if (import.meta.main) main();
