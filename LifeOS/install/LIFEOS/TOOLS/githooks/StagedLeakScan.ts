#!/usr/bin/env bun
/**
 * @version 1.0.0
 * StagedLeakScan.ts — the pre-commit leak check for SYSTEM files (ISA 20261024-native-security).
 *
 * Replaces the per-call SystemFileGuard and BashSystemWriteGuard: instead of judging every Write, Edit
 * and shell command, it judges what is actually committed, once, from any tool. Each staged file's
 * staged bytes go through the same core (hooks/lib/system-file-guard-core.ts evaluateWrite), so a USER
 * zone file passes and a SYSTEM file carrying a deny-list pattern refuses the commit.
 *
 * Output names the file and the hit count only, never the pattern or the matched text (both are
 * identity data). Fail-closed: a listing or read that fails refuses the commit.
 *
 * EXIT: 0 clean · 1 leak found or scan could not complete.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { evaluateWrite } from "../../../hooks/lib/system-file-guard-core";

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || "").trim().split("\n")[0]}`);
  return r.stdout;
}

function main(): number {
  const top = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const staged = git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRT"], top).split("\0").filter(Boolean);
  const leaks: string[] = [];
  for (const rel of staged) {
    const content = git(["show", `:${rel}`], top);
    if (content.includes("\0")) continue; // binary: no text pattern to match
    const d = evaluateWrite(join(top, rel), content);
    if (d.block) leaks.push(`${rel} (${d.hits.length} hit${d.hits.length === 1 ? "" : "s"})`);
  }
  if (leaks.length === 0) return 0;
  process.stderr.write(
    "✗ lifeos-leak-scan: SYSTEM file(s) carry user-identifying content (deny-list match):\n" +
      leaks.map((l) => `    ${l}\n`).join("") +
      "  Move the personal content into a USER-zone file (LIFEOS/USER/…) and reference it from there.\n",
  );
  return 1;
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`✗ lifeos-leak-scan: scan could not complete (${(err as Error).message}); refusing to commit unchecked.\n`);
    process.exit(1);
  }
}
