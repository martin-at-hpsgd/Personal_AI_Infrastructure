import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { SECRET_VALUE_SHAPES } from "../../hooks/lib/egress-shapes";
import { invariant } from "./Invariant";
import { lifeosPath } from "./Paths";

export type InterruptionKind = "voice" | "text";

interface Interruption { ts: string; kind: InterruptionKind; source: string; summary?: string; }

function ledgerPath(): string {
  return process.env.LIFEOS_INTERRUPTIONS_LEDGER ?? lifeosPath("MEMORY", "OBSERVABILITY", "interruptions.jsonl");
}

function hasSecretShape(summary: string): boolean {
  return SECRET_VALUE_SHAPES.some((shape) => { shape.lastIndex = 0; return shape.test(summary); });
}

/** Record an interruption. This observation path must never affect delivery. */
export function record({ kind, source, summary }: { kind: InterruptionKind; source: string; summary: string }): void {
  try {
    const ts = new Date().toISOString();
    const row: Interruption = { ts, kind, source };
    if (!hasSecretShape(summary)) row.summary = summary.slice(0, 120);
    const line = JSON.stringify(row);
    invariant(kind === "voice" || kind === "text", "interruption kind must be voice or text");
    invariant(typeof source === "string" && source.length > 0, "interruption source must be non-empty");
    invariant(Number.isFinite(Date.parse(ts)), "interruption ts must be parseable");
    invariant(!line.includes("\n"), "interruption ledger rows must be single-line JSONL");
    const path = ledgerPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line}\n`);
  } catch {}
}

export function ceiling(configPath = lifeosPath("USER", "CONFIG", "notifications.json")): number {
  try {
    const value = JSON.parse(readFileSync(configPath, "utf8"))?.interruptions_per_day;
    return typeof value === "number" && Number.isFinite(value) ? value : 12;
  } catch { return 12; }
}

export function countSince(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  try {
    if (!existsSync(ledgerPath())) return 0;
    return readFileSync(ledgerPath(), "utf8").split("\n").filter((line) => {
      try { const ts = JSON.parse(line).ts; return typeof ts === "string" && Number.isFinite(Date.parse(ts)) && Date.parse(ts) >= ms; } catch { return false; }
    }).length;
  } catch { return 0; }
}
