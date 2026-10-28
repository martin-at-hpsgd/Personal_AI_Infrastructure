#!/usr/bin/env bun
/** Gate execution reachability ledger and checker. */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { invariant } from "./Invariant";

const ROOT = join(import.meta.dir, "..", "..");
export const LEDGER_PATH = join(ROOT, "LIFEOS", "MEMORY", "OBSERVABILITY", "gate-reach.jsonl");

export interface GateRunMeta { repo?: string; subject?: string; result?: string }
export interface GateRun extends GateRunMeta { ts: string; gate: string }
export type GateState = "never-run" | "stale" | "healthy";
export interface GateReachStatus { gate: string; state: GateState; lastRun?: string; runs: number }

type Append = (path: string, data: string, options?: { encoding: "utf8" }) => void;

/** Append one bounded, non-secret execution receipt. Failure is deliberately invisible to the gate. */
export function recordGateRun(gate: string, meta: GateRunMeta = {}, append: Append = appendFileSync): void {
  try {
    invariant(typeof gate === "string" && gate.length > 0 && gate.length <= 200, "gate reach ledger needs a bounded gate name");
    invariant(Object.values(meta).every((value) => value === undefined || (typeof value === "string" && value.length <= 500)), "gate reach metadata must be bounded strings");
    mkdirSync(dirname(LEDGER_PATH), { recursive: true });
    append(LEDGER_PATH, `${JSON.stringify({ ts: new Date().toISOString(), gate, ...meta })}\n`, { encoding: "utf8" });
  } catch { /* observability must never alter a gate verdict */ }
}

/** All on-disk hook entrypoints plus ISAGate's source-declared check codes; private dynamic gates are invisible. */
export function registeredGates(root = ROOT): string[] {
  const hooksDir = join(root, "hooks");
  const hooks = existsSync(hooksDir)
    ? readdirSync(hooksDir).filter((name) => name.endsWith(".hook.ts")).map((name) => `hook:${name.slice(0, -3)}`)
    : [];
  const isaPath = join(root, "LIFEOS", "TOOLS", "ISAGate.ts");
  const isaChecks = existsSync(isaPath)
    ? [...readFileSync(isaPath, "utf8").matchAll(/\bcode:\s*"([^"]+)"/g)].map((match) => `ISAGate.${match[1]}`)
    : [];
  return [...new Set([...hooks, ...isaChecks])].sort();
}

export function readLedger(path = LEDGER_PATH): GateRun[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line): GateRun[] => {
    if (!line.trim()) return [];
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object") return [];
      const run = value as Partial<GateRun>;
      return typeof run.gate === "string" && typeof run.ts === "string" && !Number.isNaN(Date.parse(run.ts)) ? [run as GateRun] : [];
    } catch { return []; }
  });
}

/** Clock skew tolerated before a receipt counts as dated in the future. */
const FUTURE_SKEW_MS = 5 * 60_000;

export interface LedgerRead { runs: GateRun[]; malformed: number }

/** Like readLedger, but also counts the non-blank lines it had to discard as malformed. */
export function readLedgerChecked(path = LEDGER_PATH): LedgerRead {
  if (!existsSync(path)) return { runs: [], malformed: 0 };
  const runs = readLedger(path);
  const nonBlank = readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).length;
  return { runs, malformed: nonBlank - runs.length };
}

export function gateStatuses(gates: readonly string[], runs: readonly GateRun[], days: number, now = Date.now()): GateReachStatus[] {
  invariant(Number.isFinite(days) && days > 0, "reachability window must be positive");
  const cutoff = now - days * 86_400_000;
  return gates.map((gate) => {
    // A receipt dated in the future is not evidence the gate ran: it would read "healthy" forever.
    const matching = runs
      .filter((run) => run.gate === gate && Date.parse(run.ts) <= now + FUTURE_SKEW_MS)
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    const lastRun = matching[0]?.ts;
    return { gate, state: !lastRun ? "never-run" : Date.parse(lastRun) < cutoff ? "stale" : "healthy", lastRun, runs: matching.length };
  });
}

export interface GateReachReport { days: number; statuses: GateReachStatus[]; neverRun: string[]; stale: string[]; malformed: number }

export function checkJson(gates: readonly string[], runs: readonly GateRun[], days: number, malformed = 0): GateReachReport {
  const statuses = gateStatuses(gates, runs, days);
  return {
    days,
    statuses,
    neverRun: statuses.filter((status) => status.state === "never-run").map((status) => status.gate),
    stale: statuses.filter((status) => status.state === "stale").map((status) => status.gate),
    malformed,
  };
}

/**
 * The verdict. Anything short of every registered gate healthy blocks: never-run, stale,
 * discarded malformed ledger lines, or no registered gates at all (an empty set proves nothing).
 */
export function exitCodeFor(report: GateReachReport): number {
  if (report.statuses.length === 0) return 1;
  return report.neverRun.length || report.stale.length || report.malformed ? 1 : 0;
}

function main(args: string[]): never {
  const daysAt = args.indexOf("--days");
  const daysText = daysAt >= 0 ? args[daysAt + 1] : "14";
  const days = Number(daysText);
  if (!args.includes("--check") || !Number.isInteger(days) || days <= 0) {
    console.error("Usage: bun LIFEOS/TOOLS/GateReach.ts --check [--days N] [--json]");
    process.exit(2);
  }
  const ledger = readLedgerChecked();
  const report = checkJson(registeredGates(), ledger.runs, days, ledger.malformed);
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    for (const status of report.statuses) console.log(`${status.state.padEnd(9)} ${status.gate}${status.lastRun ? ` · ${status.lastRun}` : ""}`);
    if (report.malformed) console.error(`GateReach: ${report.malformed} malformed ledger line(s) discarded; evidence incomplete`);
  }
  process.exit(exitCodeFor(report));
}

if (import.meta.main) main(process.argv.slice(2));
