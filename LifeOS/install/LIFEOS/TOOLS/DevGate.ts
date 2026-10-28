#!/usr/bin/env bun
/**
 * DevGate.ts — the logged escape hatch for DevelopmentEditGate.
 *
 *   bun LIFEOS/TOOLS/DevGate.ts trivial <file> --reason "<why it is trivial>"
 *   bun LIFEOS/TOOLS/DevGate.ts list [--limit N]
 *
 * A trivial declaration unlocks edits to that one file in this session (the gate reads the
 * declaration from the transcript) and appends one line to the ledger, so every skipped
 * Development run is visible.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { invariant } from "./Invariant";
import { getClaudeDir } from "./Paths.ts";

const HOME = process.env.HOME ?? "";
const CONFIG = getClaudeDir();
export const LEDGER = process.env.DEV_GATE_LEDGER || `${CONFIG}/LIFEOS/MEMORY/STATE/dev-gate-trivial.jsonl`;

export interface TrivialEntry { ts: string; session: string; file: string; reason: string; cwd: string }

export type DeclareResult = { ok: true; entry: TrivialEntry } | { ok: false; error: string };

export function declareTrivial(fileArg: string, reason: string, ledger = LEDGER, now = new Date()): DeclareResult {
  const file = fileArg.startsWith("~/") ? `${HOME}/${fileArg.slice(2)}` : fileArg;
  if (!isAbsolute(file)) return { ok: false, error: "give the file as an absolute or ~/ path" };
  if (reason.trim().length < 10) return { ok: false, error: "--reason must say why the change is trivial (10+ characters)" };
  const entry: TrivialEntry = {
    ts: now.toISOString(),
    session: process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "unknown",
    file,
    reason: reason.trim(),
    cwd: process.cwd(),
  };
  invariant(isAbsolute(entry.file) && entry.reason.length >= 10, "trivial entry needs an absolute file and a reason");
  mkdirSync(dirname(ledger), { recursive: true });
  appendFileSync(ledger, JSON.stringify(entry) + "\n");
  return { ok: true, entry };
}

export function listTrivial(ledger = LEDGER, limit = 20): TrivialEntry[] {
  if (!existsSync(ledger)) return [];
  return readFileSync(ledger, "utf8").split("\n").filter(Boolean).slice(-limit).map((l) => JSON.parse(l) as TrivialEntry);
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  if (cmd === "trivial") {
    const r = declareTrivial(args[0] ?? "", flag("--reason") ?? "");
    if (!r.ok) { console.error(`DevGate: ${r.error}`); process.exit(2); }
    console.log(`DevGate: ${r.entry.file} unlocked for this session as trivial — logged to ${LEDGER}`);
  } else if (cmd === "list") {
    for (const e of listTrivial(LEDGER, Number(flag("--limit") ?? 20))) console.log(`${e.ts}  ${e.file}  — ${e.reason}`);
  } else {
    console.error('usage: DevGate.ts trivial <file> --reason "<why>" | list [--limit N]');
    process.exit(2);
  }
}
