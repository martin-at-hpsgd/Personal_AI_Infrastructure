#!/usr/bin/env bun
/**
 * @version 1.4.4
 * LoadMemory — UserPromptSubmit hook that injects the two hot-layer memory
 * files (PRINCIPAL_MEMORY.md, DA_MEMORY.md) as additionalContext on every
 * prompt, so the Claude Code CLI session sees the same memory the remote
 * channels (iMessage, Siri) inject via buildLifeosContextBlock.
 *
 * 1.3.0 (2026-08-17, improvement-pass P1/P2 adoption): also injects
 *   (a) the STANDING FACTS card (LIFEOS/USER/CONFIG/STANDING_FACTS.md) plus the
 *       live ~/.claude/.env credential KEY NAMES — names only, never values —
 *       so "you already have it" facts surface at the moment of need
 *       (sessions kept re-asking for credentials/capabilities already held), and
 *   (b) a one-line aging alert when Upgrades-store records sit `recommended`
 *       past 14 days (proposals had aged silently while their classes recurred).
 * Both legs are fail-open and cheap (one small file read + one cached summary).
 *
 * 1.4.0 (2026-08-20, improvement-pass #4 P1 adoption): also injects the RECENT
 *   CORRECTIONS readback (LIFEOS/TOOLS/CorrectionReadback.ts). The capture leg
 *   had run with zero consumers while repeated-correction incidents kept
 *   landing. Cached with a TTL; fail-open like the rest.
 *
 * Closes the CLI-vs-remote-channel parity gap (the autonomic loop was
 * writing memory files but the CLI session was never reading them in-prompt).
 *
 * Performance: hot-path hook. Must be cheap. Both files cap at 48 entries
 * × 256 chars = ~12K chars each, ~24K combined max. We render only the
 * entries (no help comments), so practical injection is far smaller.
 *
 * Failure mode: any error logs to stderr and exits 0 (never block the prompt).
 *
 * Subagent skip: subagents see only what their parent passed them; the per-
 * turn memory loop is for the principal's primary session. Detect and skip
 * via env markers the harness sets on subagent processes.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { isSubagentContext as isSubagentInvocation } from './lib/subagent';
import { parseMemoryContent } from "../LIFEOS/TOOLS/MemoryWriter";
import { getClaudeDir } from "./lib/paths"; // public issue #1665 @rogdex24, #1584 @ramazanpolat — aliased resolve sites missed by the 09-03 sweep
import { renderProgressiveMemory } from "./lib/progressive-memory";

const CLAUDE_ROOT = getClaudeDir();
const PRINCIPAL_MEMORY = pathResolve(CLAUDE_ROOT, "LIFEOS/USER/PRINCIPAL/PRINCIPAL_MEMORY.md");
const DA_MEMORY = pathResolve(CLAUDE_ROOT, "LIFEOS/USER/DIGITAL_ASSISTANT/DA_MEMORY.md");
const STANDING_FACTS = pathResolve(CLAUDE_ROOT, "LIFEOS/USER/CONFIG/STANDING_FACTS.md");

/** Curated facts between the FACTS BEGIN/END markers; empty string when absent. */
function readStandingFacts(): string {
  try {
    if (!existsSync(STANDING_FACTS)) return "";
    const raw = readFileSync(STANDING_FACTS, "utf8");
    const m = raw.match(/<!-- FACTS BEGIN -->\n([\s\S]*?)<!-- FACTS END -->/);
    return (m?.[1] ?? "").trim();
  } catch { return ""; }
}

/** Recent corrections the principal already gave, replayed so they are not repeated. */
function correctionsBlock(): string {
  try {
    // Lazy import for the same reason as the Upgrades store: a broken reader
    // must never take memory injection down with it.
    const { readbackCached } = require("../LIFEOS/TOOLS/CorrectionReadback") as typeof import("../LIFEOS/TOOLS/CorrectionReadback");
    return readbackCached();
  } catch { return ""; }
}

/** One-line aging alert for Upgrades-store records stuck at `recommended`. */
function upgradesStaleLine(): string {
  try {
    // Lazy import keeps the hot path resilient: a broken store never blocks memory injection.
    const { staleSummaryCached } = require("../LIFEOS/TOOLS/Upgrades") as typeof import("../LIFEOS/TOOLS/Upgrades");
    const s = staleSummaryCached();
    if (s.count > 0) return `⏳ UPGRADES: ${s.count} recommendation(s) pending >14d (oldest ${s.oldestDays}d) — disposition via Pulse /upgrades or \`bun LIFEOS/TOOLS/Upgrades.ts stale\`.`;
  } catch { /* fail open */ }
  return "";
}

interface MemoryRead {
  entries: string[];
  count: number;
  charsUsed: number;
}

function readMemory(path: string): MemoryRead {
  if (!existsSync(path)) return { entries: [], count: 0, charsUsed: 0 };
  try {
    // Shared lenient parser — MemoryWriter owns it. The old strict indexOf slice
    // returned ZERO entries on any marker disorder, so a file with a stray END
    // before BEGIN silently loaded no memory into any session while the writer
    // kept curating it. (public PR #1593, @anikinsasha)
    const { entries } = parseMemoryContent(readFileSync(path, "utf8"));
    const charsUsed = entries.reduce((sum, e) => sum + e.length, 0);
    return { entries, count: entries.length, charsUsed };
  } catch {
    return { entries: [], count: 0, charsUsed: 0 };
  }
}

function renderBlock(title: string, path: string, mem: MemoryRead, capEntries = 48, capChars = 12288): string {
  return renderProgressiveMemory(title, path, mem.entries, capEntries, capChars);
}

/** Returns the <lifeos-memory> context block, or null on error. Pure — no exit.
 *  forText (Tex ISA F17): a text session gets content only, every entry inline, with no
 *  load counters, hash, source pointer or Upgrades nag, because it cannot spend a Read per
 *  personal fact and any status note risks being relayed to the phone. */
export function run(opts: { forText?: boolean } = {}): string | null {
  try {
    const principal = readMemory(PRINCIPAL_MEMORY);
    const da = readMemory(DA_MEMORY);

    const render = (title: string, path: string, mem: MemoryRead) =>
      opts.forText ? `## ${title}\n${mem.entries.join("\n") || "(none)"}` : renderBlock(title, path, mem);
    const principalBlock = render("PRINCIPAL MEMORY", PRINCIPAL_MEMORY, principal);
    const daBlock = render("DA MEMORY", DA_MEMORY, da);

    const facts = readStandingFacts();
    const stale = opts.forText ? "" : upgradesStaleLine();
    const corrections = correctionsBlock();
    const factsBlock = `\n<lifeos-standing-facts>\n## STANDING FACTS — current snapshot, replacing earlier copies\nCurrent skill tools and operational rules take precedence over these historical notes. Before claiming a credential is missing, use \`bun LIFEOS/TOOLS/Secrets.ts has KEY\` or \`Secrets.ts keys\`; never read or print .env.\n${facts}${stale ? `\n${stale}` : ""}\n</lifeos-standing-facts>\n`;

    const correctionsWrapped = `\n<lifeos-corrections>\n## Current corrections (replaces earlier copies)\n${corrections || "No current corrections."}\n</lifeos-corrections>\n`;

    return `<lifeos-memory>\n${principalBlock}\n\n${daBlock}\n</lifeos-memory>\n${factsBlock}${correctionsWrapped}`;
  } catch (e) {
    process.stderr.write(`LoadMemory error: ${(e as Error)?.message || String(e)}\n`);
    return null;
  }
}

if (import.meta.main) {
  if (!isSubagentInvocation()) {
    const out = run();
    if (out) process.stdout.write(out);
  }
  process.exit(0);
}
