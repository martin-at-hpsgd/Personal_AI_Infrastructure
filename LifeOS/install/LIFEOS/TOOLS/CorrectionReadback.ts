#!/usr/bin/env bun
/**
 * CorrectionReadback — the consumption leg for captured corrections.
 *
 * @version 1.0.4
 *
 * Why this exists (improvement pass #4, 2026-08-20): the capture leg works and
 * nothing reads it back. Hundreds of corrections were captured in a month and
 * `grep -rln correction_ hooks` returned zero consumers, while seven repeated-
 * correction incidents landed in four days.
 *
 * Source of record is the FAILURES corpus (`capture_source: correction`), NOT
 * the `correction_*.md` files under LEARNING/{ALGORITHM,SYSTEM}. Those are
 * regex-harvested from transcripts on patterns like /actually,?\s+/ and a 5/5
 * sample held a writing rubric under `## Learning` with an empty `## Context`.
 * Replaying that corpus would inject noise every turn.
 *
 * What gets replayed is the capture's `description` slug, never the principal's
 * verbatim complaint: the slug already reads as the lesson
 * ("used-browser-automation-instead-of-existing-discord-webhook-capability"),
 * and the free-text summaries are emotional and add nothing over it.
 *
 * Cost discipline: this feeds a per-turn hook. Only the current and previous
 * month directories are scanned, only each capture's frontmatter is read
 * (first 512 bytes), and the rendered result is cached with a TTL so the common
 * turn does one small JSON read.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, openSync, readSync, closeSync } from "node:fs";
import { resolve as pathResolve, join } from "node:path";
import { invariant } from "./Invariant";
import { getClaudeDir } from "./Paths"; // public issue #1665 @rogdex24, #1584 @ramazanpolat — aliased resolve sites missed by the 09-03 sweep

const CLAUDE_ROOT = getClaudeDir();
const FAILURES_DIR = pathResolve(CLAUDE_ROOT, "LIFEOS/MEMORY/LEARNING/FAILURES");
const CACHE_FILE = pathResolve(CLAUDE_ROOT, "LIFEOS/MEMORY/STATE/correction-readback.json");

export const DEFAULT_DAYS = 30;
export const DEFAULT_MAX_LINES = 10;
export const DEFAULT_MAX_CHARS = 900;

export interface CorrectionEntry {
  date: string;        // YYYY-MM-DD
  description: string; // slug, humanised
  dirName: string;
}

/** Month dir names (YYYY-MM) for `now` and the month before it. */
export function recentMonthDirs(now: Date): string[] {
  const m = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return [m(now), m(prev)];
}

/** Reads at most `bytes` from the head of a file. Frontmatter only — captures run to 100KB+. */
function readHead(path: string, bytes = 512): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

function frontmatterValue(head: string, key: string): string | null {
  const m = head.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m ? m[1].trim() : null;
}

/**
 * Collects distinct corrections newer than `days`, newest first.
 * Pure read — safe to call anywhere.
 */
export function collectCorrections(
  opts: { now?: Date; days?: number; maxLines?: number; failuresDir?: string } = {}
): CorrectionEntry[] {
  const now = opts.now ?? new Date();
  const days = opts.days ?? DEFAULT_DAYS;
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const root = opts.failuresDir ?? FAILURES_DIR;
  if (!existsSync(root)) return [];

  const cutoff = now.getTime() - days * 86400000;
  const seen = new Set<string>();
  const out: CorrectionEntry[] = [];

  for (const month of recentMonthDirs(now)) {
    const monthDir = join(root, month);
    if (!existsSync(monthDir)) continue;
    let dirs: string[];
    try {
      dirs = readdirSync(monthDir).filter((d) => /^\d{4}-\d{2}-\d{2}-\d{6}_/.test(d)).sort().reverse();
    } catch { continue; }

    for (const dirName of dirs) {
      const ctx = join(monthDir, dirName, "CONTEXT.md");
      if (!existsSync(ctx)) continue;
      const head = readHead(ctx);
      if (frontmatterValue(head, "capture_source") !== "correction") continue;

      const date = dirName.slice(0, 10);
      const t = Date.parse(`${date}T12:00:00Z`);
      if (Number.isFinite(t) && t < cutoff) continue;

      const slug = frontmatterValue(head, "description");
      if (!slug) continue;
      const description = slug.replace(/-/g, " ").trim();
      if (!description || seen.has(description)) continue;
      seen.add(description);
      out.push({ date, description, dirName });
      if (out.length >= maxLines) return out;
    }
  }
  return out;
}

/** Renders the injectable block; "" when there is nothing to say. */
export function renderReadback(entries: CorrectionEntry[], maxChars = DEFAULT_MAX_CHARS): string {
  if (entries.length === 0) return "";
  const lines: string[] = [];
  let used = 0;
  for (const e of entries) {
    const line = `- ${e.date}: ${e.description}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return "";
  return [
    "## RECENT CORRECTIONS — you have already been told these. Do not repeat them.",
    ...lines,
  ].join("\n");
}

interface CacheShape { generated: string; block: string; count: number }

/** Cached render for per-turn callers. Recomputes at most every `maxAgeMs`. */
export function readbackCached(maxAgeMs = 3 * 3600_000, now: Date = new Date()): string {
  try {
    if (existsSync(CACHE_FILE)) {
      const c = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as CacheShape;
      const age = now.getTime() - Date.parse(c.generated);
      if (Number.isFinite(age) && age >= 0 && age < maxAgeMs && typeof c.block === "string") return c.block;
    }
  } catch { /* fall through and recompute */ }

  let block = "";
  try {
    block = renderReadback(collectCorrections({ now }));
  } catch { return ""; }

  try {
    const payload: CacheShape = { generated: now.toISOString(), block, count: block ? block.split("\n").length - 1 : 0 };
    // Persistent-state write: a cache that claims freshness it does not have would
    // pin a stale correction list into every turn until the TTL rolls.
    invariant(typeof payload.block === "string", "correction readback cache block must be a string");
    invariant(!Number.isNaN(Date.parse(payload.generated)), "correction readback cache needs a parseable timestamp");
    mkdirSync(pathResolve(CACHE_FILE, ".."), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(payload), "utf8");
  } catch { /* cache is an optimisation, never a requirement */ }

  return block;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--json")) {
    console.log(JSON.stringify(collectCorrections(), null, 2));
  } else if (args.includes("--fresh")) {
    console.log(renderReadback(collectCorrections()) || "(no corrections in window)");
  } else {
    console.log(readbackCached() || "(no corrections in window)");
  }
}
