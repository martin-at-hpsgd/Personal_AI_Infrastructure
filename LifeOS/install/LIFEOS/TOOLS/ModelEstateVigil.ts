/**
 * Model Estate → Vigil. Every model-estate run leaves one Vigil line, quiet runs included:
 * the Atlas model sync, the daily model sync, and the model advisor. Builders are pure so tests
 * check the exact event; emitSafe never lets a logging failure break the job it reports on.
 * Severity follows what the principal needs: info for a quiet run (Pulse), medium when something moved
 * or a new recommendation exists (the daily digest).
 */

import { randomUUID } from "node:crypto";
import { emitVigilEvent, type VigilEvent } from "./lib/VigilOptional";
import type { RegistryExport } from "./ModelEstate";

type Severity = VigilEvent["severity"];

export function estateEvent(e: {
  source: string; severity: Severity; title: string; summary: string; dedup: string;
  meta?: Record<string, string | number | boolean | null>;
}): VigilEvent {
  return {
    id: randomUUID(), source: e.source, ts: new Date().toISOString(), kind: "ai", severity: e.severity,
    title: e.title.slice(0, 200), summary: e.summary.slice(0, 1200), ref: null, url: null,
    privacy_class: "personal", dedup_key: e.dedup, ...(e.meta ? { meta: e.meta } : {}),
  };
}

/** Emit, reporting rather than throwing: the job's own result matters more than its log line. False when Vigil is not installed. */
export function emitSafe(event: VigilEvent): boolean {
  try { return emitVigilEvent(event); }
  catch (err) { console.error(`vigil emit failed (${event.source}): ${(err as Error).message}`); return false; }
}

export type LaneMove = { lane: string; from: string; to: string };

/** Lanes whose id changed between two registry exports. Pure. */
export function laneMoves(before: RegistryExport | null, after: RegistryExport): LaneMove[] {
  if (!before) return [];
  return Object.values(after.lanes)
    .filter((e) => before.lanes[e.lane] && before.lanes[e.lane].id !== e.id)
    .map((e) => ({ lane: e.lane, from: before.lanes[e.lane].id, to: e.id }));
}

/** One line per daily model-sync run. */
export function modelSyncEvent(moves: LaneMove[], problems: string[], day: string): VigilEvent {
  const moved = moves.map((m) => `${m.lane}: ${m.from} → ${m.to}`);
  return estateEvent({
    source: "model-sync",
    severity: moves.length ? "medium" : problems.length ? "low" : "info",
    title: moves.length ? `Models moved: ${moves.map((m) => m.lane).join(", ")}` : "Model sync ran: nothing moved",
    summary: [moves.length ? `Moved ${moves.length} lane(s): ${moved.join("; ")}.` : "No lane moved.", ...problems].join(" "),
    dedup: `model-sync:${day}:${moved.join("|") || "none"}`,
    meta: { moved: moves.length, problems: problems.length },
  });
}

/** One line per Atlas sync that ran the model collectors. */
export function atlasModelsEvent(v: {
  counts: Record<string, number>; coverage: Record<string, { coverage: string; detail: string }>; snapshots: Array<{ behind: unknown[] }>;
}, ran: string[], runKey: string): VigilEvent {
  const gaps = Object.entries(v.coverage).filter(([s, c]) => ran.includes(s) && c.coverage !== "scanned");
  const oldCopies = v.snapshots.filter((s) => s.behind.length).length;
  return estateEvent({
    source: "atlas-models",
    severity: gaps.some(([, c]) => c.coverage === "unreadable") ? "low" : "info",
    title: `Model estate synced: ${v.counts.stale ?? 0} stale use(s)`,
    summary: `${v.counts.tracks ?? 0} tracking, ${v.counts.pinned ?? 0} pinned, ${v.counts["auto-moving"] ?? 0} auto-moving, ${v.counts.stale ?? 0} stale; ${oldCopies} worker(s) carry an old registry copy.` +
      (gaps.length ? ` Not fully read: ${gaps.map(([s, c]) => `${s} (${c.coverage})`).join(", ")}.` : " Every source read."),
    dedup: `atlas-models:${runKey}`,
    meta: { stale: v.counts.stale ?? 0, sources: ran.length, gaps: gaps.length, old_copies: oldCopies },
  });
}
