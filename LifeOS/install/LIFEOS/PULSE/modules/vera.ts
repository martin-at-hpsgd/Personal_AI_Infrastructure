/**
 * Vera Pulse module — read-only surface over the person-profile ledger.
 *
 * Reads ONLY the redacted snapshot (LIFEOS/USER/VERA/pulse-snapshot.json)
 * exported by `bun LIFEOS/VERA/Vera.ts export-pulse` — personal-sensitivity
 * rows are excluded at export and never reach this surface. Mutations go
 * through the CLI so every write passes store invariants. No score is stored
 * anywhere; the snapshot carries computed leaf projections plus the read-time
 * 1-100 VERA composite per person and per branch.
 *
 * Routes:
 *   GET /api/vera → { generated, stale, age_minutes, axes, people }
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MODULE_NAME = "vera";
const SNAPSHOT = process.env.VERA_DATA_DIR
  ? join(process.env.VERA_DATA_DIR, "pulse-snapshot.json")
  : join(homedir(), ".claude/LIFEOS/USER/VERA/pulse-snapshot.json");

/** Ledger changes are event-driven, not scheduled — stale after 7 days. */
const STALE_MS = 7 * 24 * 3600_000;
const CACHE_TTL_MS = 15_000;
const state: { running: boolean; cache: { payload: unknown; expiresAt: number } | null } = { running: false, cache: null };

function compose(): Record<string, unknown> {
  if (!existsSync(SNAPSHOT)) {
    return { generated: "", stale: true, age_minutes: -1, axes: { branches: [] }, people: [] };
  }
  const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as { generated: string };
  const ageMs = Date.now() - Date.parse(snap.generated);
  return { ...snap, stale: ageMs > STALE_MS, age_minutes: Math.round(ageMs / 60_000) };
}

export function start(): void {
  state.running = true;
  console.log(`[${MODULE_NAME}] Started — serving /api/vera`);
}

export async function handleRequest(req: Request, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/api/vera")) return null;
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  const now = Date.now();
  if (!state.cache || state.cache.expiresAt <= now) {
    try {
      state.cache = { payload: compose(), expiresAt: now + CACHE_TTL_MS };
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
  }
  return Response.json(state.cache.payload);
}

export function health(): { running: boolean } {
  return { running: state.running };
}
