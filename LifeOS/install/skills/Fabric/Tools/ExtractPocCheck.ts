#!/usr/bin/env bun
// ExtractPocCheck — checks an ExtractPoc output (Intents/ExtractPoc.md) against
// the parts of its contract code can judge: either one fenced shell block holding
// the runnable command(s) and nothing outside it, with the block parsing under
// `bash -n`, or the single sentinel line that declines when the source carries no
// runnable proof of concept. Whether the commands are faithful to the source and
// invent nothing stays a judged check in the fabric-extractpoc suite.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HELP = `ExtractPocCheck — shape and shell-parse check for a Fabric ExtractPoc output

  bun skills/Fabric/Tools/ExtractPocCheck.ts <file|-> [--json] [--no-parse]

  --json      print {ok, shape, commands, parse, problems}
  --no-parse  structural checks only (no bash -n on the command block)
Exit: 0 every check holds, 1 a check failed, 2 bad usage, unreadable input, or bash missing.`;

// Fence labels that mark a runnable shell block; "" is an unlabelled fence.
const SHELL_LANGS = new Set(["", "bash", "sh", "shell", "zsh"]);
// The exact decline the intent emits when the source has no runnable PoC.
const SENTINEL = /^No runnable proof of concept\b/;

export type Block = { lang: string; body: string; line: number };
export type Shape = "commands" | "none" | "invalid";
export type Result = {
  ok: boolean;
  shape: Shape;
  commands: number;
  parse: "passed" | "failed" | "skipped";
  problems: string[];
};

/** Splits the output into fenced blocks and the non-blank lines sitting outside any fence. */
export function blocks(input: string): { blocks: Block[]; outside: { line: number; text: string }[]; unclosed: boolean } {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  const outside: { line: number; text: string }[] = [];
  let cur: { lang: string; fence: string; start: number; body: string[] } | null = null;
  lines.forEach((raw, i) => {
    if (cur) {
      if (raw.trim().startsWith(cur.fence) && raw.trim().replace(/[`~]/g, "") === "") {
        out.push({ lang: cur.lang, body: cur.body.join("\n"), line: cur.start });
        cur = null;
      } else cur.body.push(raw);
      return;
    }
    const open = raw.match(/^\s*(`{3,}|~{3,})\s*([\w#+.-]*)/);
    if (open) cur = { lang: open[2].toLowerCase(), fence: open[1], start: i + 1, body: [] };
    else if (raw.trim() !== "") outside.push({ line: i + 1, text: raw.trim() });
  });
  return { blocks: out, outside, unclosed: cur !== null };
}

/** A non-blank line inside a command block that is not a pure comment. */
function commandLines(body: string): string[] {
  return body.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
}

/** Structural checks only; no process is spawned. */
export function checkShape(input: string): Result & { block?: Block } {
  const problems: string[] = [];
  const { blocks: all, outside, unclosed } = blocks(input);
  if (unclosed) problems.push("a code fence is never closed");

  // Shape B — the decline sentinel: no fence, exactly the one sentinel line.
  if (all.length === 0) {
    const lines = outside;
    if (lines.length === 1 && SENTINEL.test(lines[0].text)) {
      return { ok: problems.length === 0, shape: "none", commands: 0, parse: "skipped", problems };
    }
    if (lines.length === 0) problems.push("empty output: emit one fenced shell block, or the \"No runnable proof of concept…\" line");
    else problems.push(`no fenced command block and the output is not the single "No runnable proof of concept…" line (found "${lines[0].text.slice(0, 60)}")`);
    return { ok: false, shape: "invalid", commands: 0, parse: "skipped", problems };
  }

  // Shape A — one fenced shell block, nothing outside it.
  for (const o of outside) problems.push(`line ${o.line}: text outside the command block ("${o.text.slice(0, 60)}"); the output is the shell block alone`);
  if (all.length > 1) problems.push(`${all.length} code blocks; put every command in one shell block, in run order`);
  const block = all[0];
  if (!SHELL_LANGS.has(block.lang)) problems.push(`line ${block.line}: the command block is labelled "${block.lang}"; label it as a shell (\`\`\`bash) so it runs in a terminal`);
  const cmds = commandLines(block.body);
  if (cmds.length === 0) problems.push(`line ${block.line}: the command block has no command (only blanks or comments)`);

  return { ok: problems.length === 0, shape: problems.length === 0 ? "commands" : "invalid", commands: cmds.length, parse: "skipped", problems, block };
}

export function bashAvailable(): boolean {
  return Bun.which("bash") !== null;
}

/** Full check: structure, then `bash -n` on the command block unless parse is false. */
export function check(input: string, opts: { parse?: boolean } = {}): Result {
  const shape = checkShape(input);
  const { block, ...base } = shape;
  const useParse = opts.parse ?? true;
  if (!useParse || !block || base.shape !== "commands") return { ...base, ok: base.problems.length === 0 };
  const problems = [...base.problems];
  const dir = mkdtempSync(join(tmpdir(), "extract-poc-check-"));
  try {
    const path = join(dir, "poc.sh");
    writeFileSync(path, block.body + "\n");
    // -n reads the commands for syntax but never runs them.
    const p = Bun.spawnSync(["bash", "-n", path], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    if ((p.exitCode ?? -1) !== 0) {
      const why = p.stderr.toString().split("\n").filter(Boolean).slice(0, 4).join(" | ");
      problems.push(`bash -n could not parse the command block: ${why || "syntax error"}`);
      return { ...base, ok: false, parse: "failed", problems };
    }
    return { ...base, ok: problems.length === 0, parse: "passed", problems };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const noParse = args.includes("--no-parse");
  const unknown = args.filter((a) => a.startsWith("--") && !["--json", "--no-parse"].includes(a));
  if (unknown.length) {
    console.error(`unknown flag ${unknown[0]}`);
    process.exit(2);
  }
  const src = args.find((a) => !a.startsWith("--") || a === "-");
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  if (!noParse && !bashAvailable()) {
    console.error("bash is not on PATH; install it or pass --no-parse for structural checks only");
    process.exit(2);
  }
  const r = check(input, { parse: !noParse });
  if (json) console.log(JSON.stringify({ ok: r.ok, shape: r.shape, commands: r.commands, parse: r.parse, problems: r.problems }));
  else if (r.ok) console.log(r.shape === "none" ? "✓ no runnable PoC, declined as required" : `✓ ${r.commands} command line(s), one shell block, bash -n ${r.parse}`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
