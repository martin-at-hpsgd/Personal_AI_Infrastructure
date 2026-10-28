/**
 * Store — the Review's only writable place: `LIFEOS/USER/REVIEW/` (private repo, versioned).
 *
 * recs.json      every recommendation and its decision, prediction and score
 * health.json    last state of each instrument, so Vigil hears only changes
 * alarms.jsonl   daily watch alarms, one line each
 * watches.json   registered before/after watches on landed changes
 * labels/        monthly label batches for calibrating the v4 detector
 * runs.jsonl     one line per run with each source's as-of time
 *
 * Override for tests and other installs: REVIEW_DIR.
 *
 * @version 1.1.0
 */
import { appendFileSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { lifeosPath } from "../TOOLS/Paths";

export const reviewDir = (): string => process.env.REVIEW_DIR ?? lifeosPath("USER", "REVIEW");
export const reviewPath = (...parts: string[]): string => join(reviewDir(), ...parts);

export function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } });
}

/** The real path of the store root, so a symlinked component cannot carry a write outside it. */
function insideStore(path: string): boolean {
  mkdirSync(reviewDir(), { recursive: true });
  const root = realpathSync(reviewDir());
  mkdirSync(dirname(path), { recursive: true });
  const parent = realpathSync(dirname(resolve(path)));
  return parent === root || parent.startsWith(root + "/");
}

export function writeJson(path: string, value: unknown): void {
  invariant(value !== undefined, `review write has a value: ${path}`);
  invariant(insideStore(path), `review write stays in ${reviewDir()}: ${path}`);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

export function appendJsonl(path: string, line: unknown): void {
  invariant(line !== undefined && line !== null, `review append has a line: ${path}`);
  invariant(insideStore(path), `review append stays in ${reviewDir()}: ${path}`);
  appendFileSync(path, JSON.stringify(line) + "\n");
}

// ── Recommendations ─────────────────────────────────────────────────────────

export const FIX_TYPES = ["delete", "tool", "check", "prose"] as const;
export type FixType = (typeof FIX_TYPES)[number];
export type RecStatus = "open" | "accepted" | "dismissed" | "expired";
/** A rollback is filed by a watch that measured a change making things worse; it shares the cap of three open decisions with changes (ISC-70). The deletion slot sits beside them. */
export type RecKind = "change" | "deletion" | "rollback";

export interface Prediction {
  metric: string;                    // a Metrics.ts catalog id
  args?: Record<string, string>;     // e.g. { class: "unverified_claim" } or { rule: "sp.x.y" }
  direction: "down" | "up";
  size_pct: number;                  // predicted relative change, percent
  p: number;                         // probability the change happens, 0..1
  due: string;                       // YYYY-MM-DD
  baseline?: number;                 // the metric when the prediction was made
  mde_pct?: number;                  // minimum detectable change at that time
}

export interface Score { result: "hit" | "miss" | "underpowered"; change_pct: number | null; mde_pct: number; ts: string }

export interface Rec {
  id: string; kind: RecKind; status: RecStatus; created: string; decided?: string; note?: string;
  title: string; change: string; fix_type: FixType; target: string; why_not_check?: string;
  evidence: string[]; generators: string[]; key: string;
  prediction?: Prediction; upgrade_id?: string; score?: Score;
}

export interface RecStore { recs: Rec[] }
export const loadRecs = (): RecStore => readJson<RecStore>(reviewPath("recs.json"), { recs: [] });
export function saveRecs(store: RecStore): void {
  invariant(store.recs.every((r) => r.id && r.key && r.title), "every stored recommendation has id, key and title");
  writeJson(reviewPath("recs.json"), store);
}

/** A normalized claim key: same idea, different wording from a different generator, still collides often enough. */
export function claimKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 3).slice(0, 10).sort().join(" ");
}
