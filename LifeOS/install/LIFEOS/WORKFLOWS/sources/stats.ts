/**
 * ISC-146: per-workflow figures over the trailing 30 days, from the run ledger.
 *
 * The engine's evidence index (ledgerEvidence) keeps only a run count and the last run per workflow,
 * which cannot answer "how many in the last 30 days" or "median duration". This is the same idea one
 * level up: a byte-offset index beside the ledger (`<ledger>.stats.json`) holding one small bucket per
 * workflow per UTC day. Each call reads only the lines appended since the last call, never the whole
 * ledger; with no index (or a ledger that shrank) it reads everything once and writes one.
 * Read-only with respect to the ledger. The index is a cache: an unwritable directory just means a rescan.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { stepCostsUsd } from "../engine/budget.ts";
import { writeFileAtomic } from "../engine/ledger.ts";
import type { WorkflowStats } from "../types.ts";

export const STATS_WINDOW_DAYS = 30;
const KEEP_DAYS = 90;
const MAX_SAMPLES_PER_DAY = 2000;
const CHUNK = 32 * 1024 * 1024;

interface Bucket { runs: number; failed: number; ms: number[]; cost: number | null }
interface StatsIndex { version: 1; bytes: number; by: Record<string, Record<string, Bucket>> }

export const statsIndexPath = (ledger: string): string => `${ledger}.stats.json`;
const dayOf = (iso: string): string | null => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);

/** Model spend in dollars: a run-level cost if a line carries one, plus each step's own cost_usd (legacy step_costs only where a step has none). */
function costOf(line: any): number | null {
  const run = typeof line.cost_usd === "number" && Number.isFinite(line.cost_usd) && line.cost_usd >= 0 ? line.cost_usd : null;
  const steps = stepCostsUsd(line);
  return run === null && steps === null ? null : (run ?? 0) + (steps ?? 0);
}

function fold(index: StatsIndex, text: string): void {
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    let line: any;
    try { line = JSON.parse(raw); } catch { continue; }
    if (!line || typeof line.workflow !== "string" || line.workflow === "__proto__" || typeof line.finished_at !== "string") continue;
    const day = dayOf(line.finished_at);
    if (!day) continue;
    if (!Object.hasOwn(index.by, line.workflow)) index.by[line.workflow] = {};
    const perWorkflow = index.by[line.workflow];
    const bucket = (perWorkflow[day] ??= { runs: 0, failed: 0, ms: [], cost: null });
    bucket.runs++;
    if (line.status !== "succeeded") bucket.failed++;
    const ms = Date.parse(line.finished_at) - Date.parse(line.started_at);
    if (Number.isFinite(ms) && ms >= 0 && bucket.ms.length < MAX_SAMPLES_PER_DAY) bucket.ms.push(ms);
    const cost = costOf(line);
    if (cost !== null) bucket.cost = (bucket.cost ?? 0) + cost;
  }
}

function readRange(path: string, from: number, to: number, index: StatsIndex): number {
  const fd = openSync(path, "r");
  try {
    let position = from;
    let carry = Buffer.alloc(0);
    while (position < to) {
      const size = Math.min(CHUNK, to - position);
      const chunk = Buffer.alloc(size);
      readSync(fd, chunk, 0, size, position);
      position += size;
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const lastNewline = buf.lastIndexOf(0x0a);
      if (lastNewline < 0) { carry = buf; continue; }
      fold(index, buf.toString("utf8", 0, lastNewline));
      carry = Buffer.from(buf.subarray(lastNewline + 1));
    }
    return position - carry.length;
  } finally {
    closeSync(fd);
  }
}

function loadIndex(ledger: string): StatsIndex {
  const fresh: StatsIndex = { version: 1, bytes: 0, by: {} };
  const path = statsIndexPath(ledger);
  if (!existsSync(path)) return fresh;
  try {
    const saved = JSON.parse(readFileSync(path, "utf8")) as StatsIndex;
    if (saved.version === 1 && Number.isInteger(saved.bytes) && saved.bytes >= 0 && saved.by && typeof saved.by === "object") return saved;
  } catch { /* a damaged index is rebuilt from the ledger */ }
  return fresh;
}

const daysBefore = (now: Date, days: number): string => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);

/** Trailing-30-day figures per workflow name. Workflows with no runs in the window are absent from the result. */
export function workflowStats(ledger: string, now: Date = new Date()): Record<string, WorkflowStats> {
  if (!existsSync(ledger)) return {};
  const size = statSync(ledger).size;
  let index = loadIndex(ledger);
  if (index.bytes > size) index = { version: 1, bytes: 0, by: {} };
  if (index.bytes < size) {
    index.bytes = readRange(ledger, index.bytes, size, index);
    const keepFrom = daysBefore(now, KEEP_DAYS);
    for (const days of Object.values(index.by)) for (const day of Object.keys(days)) if (day < keepFrom) delete days[day];
    try { writeFileAtomic(statsIndexPath(ledger), JSON.stringify(index)); } catch { /* cache only */ }
  }
  const from = daysBefore(now, STATS_WINDOW_DAYS - 1);
  const out: Record<string, WorkflowStats> = {};
  for (const [name, days] of Object.entries(index.by)) {
    let runs = 0, failed = 0;
    let cost: number | null = null;
    const ms: number[] = [];
    for (const [day, b] of Object.entries(days)) {
      if (day < from) continue;
      runs += b.runs; failed += b.failed; ms.push(...b.ms);
      if (b.cost !== null) cost = (cost ?? 0) + b.cost;
    }
    if (!runs) continue;
    ms.sort((a, b) => a - b);
    const mid = ms.length >> 1;
    const median = ms.length ? (ms.length % 2 ? ms[mid] : Math.round((ms[mid - 1] + ms[mid]) / 2)) : null;
    out[name] = { runs, failed, failureRate: failed / runs, medianDurationMs: median, modelSpendUsd: cost === null ? null : Math.round(cost * 1e6) / 1e6 };
  }
  return out;
}
