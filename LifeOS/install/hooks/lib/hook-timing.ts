/**
 * @version 1.0.0
 * hook-timing.ts — per-module wall-time telemetry for the event dispatchers.
 *
 * Until 2026-09-03 the only signal of a slow hook was the harness discarding
 * its output ("hook timed out after 8s — output discarded"). Every dispatcher
 * now wraps each module in `timed()` and flushes one row per invocation to
 * MEMORY/OBSERVABILITY/hook-timing.jsonl:
 *
 *   {ts, event, tool, session, total_ms, modules: {name: ms}, errors: [name]}
 *
 * Write policy: always when total_ms >= ALWAYS_LOG_MS or any module errored;
 * otherwise 1-in-SAMPLE_EVERY. The file is capped by size — when it passes
 * MAX_BYTES the newest KEEP_ROWS rows are kept. `/ic hook-latency` grades the
 * last 24 h of rows against each dispatcher's registered timeout.
 *
 * Fail-open everywhere: a telemetry failure never touches the turn.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { lifeosPath } from "./paths";

export const HOOK_TIMING_PATH = lifeosPath("MEMORY", "OBSERVABILITY", "hook-timing.jsonl");
export const ALWAYS_LOG_MS = 100;
export const SAMPLE_EVERY = 10;
const MAX_BYTES = 8 * 1024 * 1024;
const KEEP_ROWS = 10_000;

export interface TimingRow {
  ts: string;
  event: string;
  tool?: string;
  session: string;
  total_ms: number;
  modules: Record<string, number>;
  errors: string[];
}

export class HookTimer {
  private readonly started = performance.now();
  readonly modules: Record<string, number> = {};
  readonly errors: string[] = [];

  constructor(
    private readonly event: string,
    private readonly input: { session_id?: unknown; tool_name?: unknown } | null,
    private readonly opts: { path?: string; sampleEvery?: number; alwaysLogMs?: number; random?: () => number } = {},
  ) {}

  /** Milliseconds since the dispatcher started. */
  elapsed(): number {
    return performance.now() - this.started;
  }

  /**
   * Run one module, record its wall time, swallow its error (recorded by name).
   * Returns the module's value, or null when it threw.
   */
  async timed<T>(name: string, fn: () => T | Promise<T>): Promise<T | null> {
    const t0 = performance.now();
    try {
      return await fn();
    } catch (e) {
      this.errors.push(name);
      process.stderr.write(`[${this.event}/${name}] ${(e as Error)?.message ?? String(e)}\n`);
      return null;
    } finally {
      this.modules[name] = Math.round((performance.now() - t0) * 10) / 10;
    }
  }

  row(): TimingRow {
    return {
      ts: new Date().toISOString(),
      event: this.event,
      tool: typeof this.input?.tool_name === "string" ? this.input.tool_name : undefined,
      session: typeof this.input?.session_id === "string" ? this.input.session_id : "unknown",
      total_ms: Math.round(this.elapsed()),
      modules: this.modules,
      errors: this.errors,
    };
  }

  /** Decide, per policy, whether this invocation's row is written. */
  shouldLog(row: TimingRow = this.row()): boolean {
    if (row.errors.length > 0) return true;
    if (row.total_ms >= (this.opts.alwaysLogMs ?? ALWAYS_LOG_MS)) return true;
    const every = this.opts.sampleEvery ?? SAMPLE_EVERY;
    return (this.opts.random ?? Math.random)() < 1 / every;
  }

  /** Append the row when the policy says so. Never throws. */
  flush(): TimingRow | null {
    const row = this.row();
    if (!this.shouldLog(row)) return null;
    appendTimingRow(row, this.opts.path ?? HOOK_TIMING_PATH);
    return row;
  }
}

export function appendTimingRow(row: TimingRow, path: string = HOOK_TIMING_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(row) + "\n");
    capFile(path);
  } catch {
    /* telemetry never breaks a turn */
  }
}

/** Keep the newest KEEP_ROWS rows once the file passes MAX_BYTES. */
export function capFile(path: string, maxBytes = MAX_BYTES, keepRows = KEEP_ROWS): boolean {
  try {
    if (!existsSync(path) || statSync(path).size <= maxBytes) return false;
    const kept = readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-keepRows);
    writeFileSync(path, kept.join("\n") + "\n");
    return true;
  } catch {
    return false;
  }
}

/** Rows from the last `windowMs` (default 24 h). Malformed lines are skipped. */
export function readRecentRows(path: string = HOOK_TIMING_PATH, windowMs = 24 * 3600 * 1000, now = Date.now()): TimingRow[] {
  if (!existsSync(path)) return [];
  const out: TimingRow[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as TimingRow;
      const t = Date.parse(r.ts);
      if (Number.isFinite(t) && now - t <= windowMs) out.push(r);
    } catch {
      /* skip */
    }
  }
  return out;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}
