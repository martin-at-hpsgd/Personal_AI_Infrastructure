/**
 * Vigil's legacy outbox, written by STATVS during the migration (design §2.1, §3 Lane A item 4).
 *
 * Until p3 the live Vigil tick reads `outbox.jsonl` and `digest.jsonl` from Vigil's state dir.
 * `writeEvent` appends every accepted event here first, so a caller moved onto STATVS keeps
 * reaching the live tick, and a rollback of the switch finds the outbox complete.
 *
 * The path rule is Vigil's State.ts rule, inlined so STATVS code never imports LIFEOS/VIGIL:
 * VIGIL_STATE_DIR, else under `bun test` a per-process temp dir (the same name State.ts uses,
 * so a test reading Vigil's statePath sees these rows), else ~/.local/state/lifeos/vigil.
 *
 * Deliberately NOT exported from index.ts or reachable through the CLI: `appendNotification`
 * writes `source: "vigil"` rows, which only Vigil's own tick may write (P1).
 *
 * Deleted in p3, with Emit.ts and Schema.ts.
 * @version 1.0.0
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { invariant } from "../../TOOLS/Invariant";
import { validateEvent, type VigilEvent } from "./refuse";

/** Vigil's state dir, by State.ts's rule (test arm included). */
export function legacyStateDir(): string {
  return process.env.VIGIL_STATE_DIR
    || (process.env.NODE_ENV === "test" ? join(tmpdir(), `lifeos-vigil-state-test-${process.pid}`) : join(homedir(), ".local/state/lifeos/vigil"));
}
export const outboxPath = () => join(legacyStateDir(), "outbox.jsonl");
export const digestPath = () => join(legacyStateDir(), "digest.jsonl");

function appendLine(path: string, value: unknown): void {
  const body = JSON.stringify(value);
  invariant(typeof body === "string" && body.length > 2, "legacy outbox record serializes");
  invariant(!body.includes("\n"), "legacy outbox record is one line");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, body + "\n");
}

/** Append one validated event, exactly as Vigil's old `emit` did. Throws on a refused event or a failed write. */
export function append(event: VigilEvent): void {
  validateEvent(event);
  invariant(event.dedup_key.length > 0, "event has dedup key");
  invariant(event.source !== "vigil", "source vigil rows go through appendNotification");
  appendLine(outboxPath(), event);
}

/** Vigil's own notification row (source `vigil`) for the legacy tick. Vigil code only. */
export function appendNotification(row: VigilEvent): void {
  validateEvent(row);
  invariant(row.source === "vigil", "a notification row is Vigil's own");
  invariant(row.dedup_key.length > 0, "notification row has dedup key");
  appendLine(outboxPath(), row);
}

/** One event queued for the legacy brief (`digest.jsonl`). Vigil code only. */
export function appendDigest(line: VigilEvent): void {
  invariant(!!line && typeof line === "object" && typeof line.id === "string" && line.id.length > 0, "digest line carries an event id");
  invariant(typeof line.dedup_key === "string" && line.dedup_key.length > 0, "digest event has dedup key");
  appendLine(digestPath(), line);
}

/**
 * The id of an outbox event with this dedup key (at or after `sinceMs`, when given), or null.
 * A whole-file substring check runs first, so a key that is absent costs one read and no parse.
 */
export function keyEventId(key: string, sinceMs?: number): string | null {
  const path = outboxPath();
  if (!existsSync(path)) return null;
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  const needle = `"dedup_key":${JSON.stringify(key)}`;
  if (!text.includes(needle)) return null;
  for (const line of text.split("\n")) {
    if (!line.includes(needle)) continue;
    try {
      const e = JSON.parse(line) as Partial<VigilEvent>;
      if (e.dedup_key !== key || typeof e.id !== "string") continue;
      if (sinceMs === undefined) return e.id;
      const t = typeof e.ts === "string" ? Date.parse(e.ts) : NaN;
      if (Number.isFinite(t) && t >= sinceMs) return e.id;
    } catch { /* torn line: skip */ }
  }
  return null;
}
