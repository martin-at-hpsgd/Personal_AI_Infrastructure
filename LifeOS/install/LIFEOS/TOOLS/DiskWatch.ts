#!/usr/bin/env bun
/**
 * @version 0.1.0
 * DiskWatch — warns before the startup disk fills, and says how fast it is falling.
 *
 * Run every 5 minutes by the `disk-watch` workflow. Each run reads the data volume's free space, compares it with the
 * last sample, and writes one STATVS event when it matters:
 *   - high (Vigil texts the principal): free under LOW_GB, where a write can fail with ENOSPC before macOS purges.
 *   - medium (digest): free under WARN_GB, or falling faster than FAST_GB_PER_MIN.
 *   - nothing on a healthy run (the engine already records that it ran).
 * One alert per level per hour (dedup key), so a slow slide does not text every five minutes.
 *
 * Why (2026-10-23): the disk swung between full and hundreds of GB free. One cause was a test harness that never removed
 * its run folders (arca, 178 GB); another is a system process writing APFS-purgeable files at about 5 GB a minute that
 * macOS purges only when the disk is nearly full (495 GB in one purge), which is when builds hit ENOSPC.
 *
 * USAGE: bun DiskWatch.ts [--json] [--dry-run]
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { invariant } from "./Invariant";
import { lifeosPath } from "./Paths";

export const LOW_GB = 60;
export const WARN_GB = 150;
export const FAST_GB_PER_MIN = 3;
const VOLUME = "/System/Volumes/Data";
const STATE = lifeosPath("MEMORY", "STATE", "disk-watch.json");

export type Sample = { at: string; freeGb: number };
export type Reading = { at: string; freeGb: number; rateGbPerMin: number | null; level: "ok" | "warn" | "low" };

export function freeGb(volume = VOLUME): number {
  const out = spawnSync("df", ["-k", volume], { encoding: "utf8" }).stdout.trim().split("\n").pop() ?? "";
  const kb = Number(out.split(/\s+/)[3]);
  invariant(Number.isFinite(kb) && kb >= 0, `df gave no free size for ${volume}`);
  return kb / 1048576;
}

/** The level for this reading: low under LOW_GB, warn under WARN_GB or when falling faster than FAST_GB_PER_MIN. */
export function classify(free: number, last: Sample | null, now: Date): Reading {
  const mins = last ? (now.getTime() - Date.parse(last.at)) / 60000 : 0;
  const rate = last && mins >= 1 ? (last.freeGb - free) / mins : null;
  const level = free < LOW_GB ? "low" : free < WARN_GB || (rate !== null && rate > FAST_GB_PER_MIN) ? "warn" : "ok";
  return { at: now.toISOString(), freeGb: free, rateGbPerMin: rate, level };
}

export function event(r: Reading) {
  const free = `${r.freeGb.toFixed(0)} GB free`;
  const fall = r.rateGbPerMin !== null && r.rateGbPerMin > 0 ? `, falling ${r.rateGbPerMin.toFixed(1)} GB a minute` : "";
  const eta = r.rateGbPerMin && r.rateGbPerMin > 0.1 ? ` (full in about ${Math.round(r.freeGb / r.rateGbPerMin)} minutes at this rate)` : "";
  return {
    id: crypto.randomUUID(), source: "disk-watch", ts: r.at, kind: "infra" as const,
    severity: (r.level === "low" ? "high" : "medium") as "high" | "medium",
    title: r.level === "low" ? `Mac disk nearly full: ${free}` : `Mac disk falling: ${free}${fall}`,
    summary: `${free}${fall}${eta}. Under ${LOW_GB} GB a build or write can fail before macOS purges its caches.`,
    ref: "LIFEOS/TOOLS/DiskWatch.ts", url: null, privacy_class: "public" as const,
    dedup_key: `disk-watch:${r.level}:${r.at.slice(0, 13)}`,
    meta: { freeGb: Math.round(r.freeGb), rateGbPerMin: r.rateGbPerMin === null ? null : Math.round(r.rateGbPerMin * 10) / 10, level: r.level },
  };
}

function readLast(): Sample | null {
  try { return existsSync(STATE) ? (JSON.parse(readFileSync(STATE, "utf8")) as Sample) : null; } catch { return null; }
}

function writeLast(s: Sample): void {
  invariant(Number.isFinite(s.freeGb) && s.freeGb >= 0 && !Number.isNaN(Date.parse(s.at)), "a disk sample has a time and a free size");
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(`${STATE}.tmp`, JSON.stringify(s));
  renameSync(`${STATE}.tmp`, STATE);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const r = classify(freeGb(), readLast(), new Date());
  if (!args.includes("--dry-run")) {
    writeLast({ at: r.at, freeGb: r.freeGb });
    if (r.level !== "ok") {
      const { writeEvent } = await import("../STATVS/index");
      const sent = writeEvent(event(r)) as { ok: boolean; refused?: string };
      if (!sent.ok) console.error(`disk-watch: STATVS refused the event: ${sent.refused}`);
    }
  }
  console.log(args.includes("--json") ? JSON.stringify(r) : `${r.level}: ${r.freeGb.toFixed(1)} GB free${r.rateGbPerMin === null ? "" : `, ${r.rateGbPerMin.toFixed(2)} GB/min`}`);
}
