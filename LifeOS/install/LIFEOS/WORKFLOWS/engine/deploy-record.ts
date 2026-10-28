/**
 * What went live (ISA ISC-174). A successful cloud deploy appends one line with
 * the hash of the definition text it built from; the page compares that hash
 * with the file on disk and labels a cloud workflow "changed since deploy"
 * until the next deploy, across reloads.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ledgerPath } from "./paths.ts";

export interface DeployRecord {
  name: string;
  definition_hash: string;
  runner: string;
  deployed_at: string;
}

export const deployLogPath = (): string => join(dirname(ledgerPath()), "deploys.jsonl");

export function recordDeploy(record: DeployRecord, path: string = deployLogPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n", { mode: 0o600 });
}

/** The newest deploy record per workflow name. Unreadable lines are skipped. */
export function lastDeploys(path: string = deployLogPath()): Map<string, DeployRecord> {
  const out = new Map<string, DeployRecord>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as DeployRecord;
      if (typeof r.name === "string" && typeof r.definition_hash === "string") out.set(r.name, r);
    } catch { /* a torn line */ }
  }
  return out;
}

export type DeployDrift = { state: "never-deployed" } | { state: "current"; deployed_at: string } | { state: "changed"; deployed_at: string };

/** Whether the file on disk is what the last deploy shipped. */
export function deployDrift(name: string, currentHash: string, records: Map<string, DeployRecord>): DeployDrift {
  const r = records.get(name);
  if (!r) return { state: "never-deployed" };
  return r.definition_hash === currentHash ? { state: "current", deployed_at: r.deployed_at } : { state: "changed", deployed_at: r.deployed_at };
}
