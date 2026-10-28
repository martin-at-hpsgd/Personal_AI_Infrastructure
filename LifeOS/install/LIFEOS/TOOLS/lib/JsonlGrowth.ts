#!/usr/bin/env bun
/**
 * JsonlGrowth — how fast each observability stream is growing, without reading
 * whole files. Rows are appended in time order, so the first row of the last
 * 24 hours is found by binary search on row timestamps and the growth is the
 * bytes after it. The memory health check compares each stream's growth with
 * its budget in USER/CONFIG/observability-budgets.json and names any stream
 * over it (observability-growth ISA, ISC-1..3).
 *
 *   bun LIFEOS/TOOLS/lib/JsonlGrowth.ts            # table of streams, 24h growth, budget
 *   bun LIFEOS/TOOLS/lib/JsonlGrowth.ts --check    # exit 1 when a stream is over budget
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { lifeosPath } from "../Paths";

const CHUNK = 64 * 1024;
export const DAY_MS = 86_400_000;

function readAt(fd: number, offset: number, len: number): string {
  const buf = Buffer.alloc(len);
  const n = readSync(fd, buf, 0, len, offset);
  return buf.toString("latin1", 0, n); // byte-exact offsets; timestamps are ASCII
}

const rowTs = (line: string): number | null => {
  const m = line.match(/"(?:ts|timestamp)"\s*:\s*"([^"]+)"/);
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** First timestamped row starting at or after `offset`: its byte offset and ts, or null past the end. */
function rowAfter(fd: number, size: number, offset: number): { at: number; ts: number } | null {
  let pos = offset;
  if (pos > 0) {
    // Skip the partial line we landed in.
    while (pos < size) {
      const text = readAt(fd, pos, CHUNK);
      const nl = text.indexOf("\n");
      if (nl >= 0) { pos += nl + 1; break; }
      pos += text.length;
      if (!text.length) return null;
    }
  }
  while (pos < size) {
    const text = readAt(fd, pos, CHUNK);
    let start = 0;
    for (;;) {
      const nl = text.indexOf("\n", start);
      if (nl < 0) break;
      const ts = rowTs(text.slice(start, nl));
      if (ts !== null) return { at: pos + start, ts };
      start = nl + 1;
    }
    if (start === 0) { if (!text.length) return null; pos += text.length; continue; } // one very long line
    pos += start;
  }
  return null;
}

/** Bytes of rows whose timestamp is at or after `cutoffMs`. Exact when rows are in time order. */
export function bytesSince(path: string, cutoffMs: number): number {
  if (!existsSync(path)) return 0;
  const size = statSync(path).size;
  if (size === 0) return 0;
  const fd = openSync(path, "r");
  try {
    // Invariant: the first row at or after cutoff starts in (lo, hi] or later.
    let lo = 0, hi = size;
    const first = rowAfter(fd, size, 0);
    if (!first) return 0;
    if (first.ts >= cutoffMs) return size - first.at;
    while (hi - lo > CHUNK) {
      const mid = Math.floor((lo + hi) / 2);
      const r = rowAfter(fd, size, mid);
      if (r && r.ts < cutoffMs) lo = r.at + 1; else hi = mid;
    }
    // Scan forward from lo for the first row at or after the cutoff.
    let pos = lo;
    for (;;) {
      const r = rowAfter(fd, size, pos);
      if (!r) return 0;
      if (r.ts >= cutoffMs) return size - r.at;
      pos = r.at + 1;
    }
  } finally { closeSync(fd); }
}

export interface StreamGrowth { stream: string; bytes: number }
export interface Budgets { default_bytes_per_day: number; streams: Record<string, number> }
export interface OverBudget { stream: string; bytes: number; budget: number }

export function streamGrowth(dir: string, nowMs = Date.now()): StreamGrowth[] {
  if (!existsSync(dir)) return [];
  const out: StreamGrowth[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    // One unreadable stream never hides the others; it simply reports no growth.
    let bytes = 0;
    try { bytes = bytesSince(join(dir, e.name), nowMs - DAY_MS); } catch { /* unreadable */ }
    out.push({ stream: basename(e.name, ".jsonl"), bytes });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

export function overBudget(growth: StreamGrowth[], budgets: Budgets): OverBudget[] {
  return growth
    .map((g) => ({ ...g, budget: budgets.streams[g.stream] ?? budgets.default_bytes_per_day }))
    .filter((g) => g.bytes > g.budget);
}

export const BUDGETS_PATH = lifeosPath("USER", "CONFIG", "observability-budgets.json");
export const OBSERVABILITY_DIR = lifeosPath("MEMORY", "OBSERVABILITY");

export function loadBudgets(path = BUDGETS_PATH): Budgets {
  const fallback: Budgets = { default_bytes_per_day: 10 * 1024 * 1024, streams: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const def = Number(raw.default_bytes_per_day);
    const streams: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.streams ?? {})) if (Number.isFinite(Number(v)) && Number(v) > 0) streams[k] = Number(v);
    return { default_bytes_per_day: Number.isFinite(def) && def > 0 ? def : fallback.default_bytes_per_day, streams };
  } catch { return fallback; }
}

if (import.meta.main) {
  const budgets = loadBudgets();
  const growth = streamGrowth(OBSERVABILITY_DIR);
  const over = new Set(overBudget(growth, budgets).map((o) => o.stream));
  const mb = (n: number) => (n / 1048576).toFixed(1).padStart(7);
  console.log("stream                              24h MB   budget MB");
  for (const g of growth.filter((g) => g.bytes > 0)) {
    console.log(`${over.has(g.stream) ? "✗" : " "} ${g.stream.padEnd(32)} ${mb(g.bytes)}   ${mb(budgets.streams[g.stream] ?? budgets.default_bytes_per_day)}`);
  }
  if (process.argv.includes("--check")) process.exit(over.size ? 1 : 0);
}
