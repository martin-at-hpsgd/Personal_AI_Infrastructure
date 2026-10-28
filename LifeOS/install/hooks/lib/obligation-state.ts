/**
 * obligation-state.ts — session-scoped obligation tracking with ISA revision awareness
 *
 * Tracks whether a gate's obligation has been resolved for a given ISA revision.
 * Used by StopGates to prevent recovery loop deadlocks.
 *
 * An obligation is bound to (gate, canonical ISA path, revision). Each ISA holds
 * its own entry and a new revision of it starts that entry over, so a `resolved`
 * (or an exhausted retry count) earned on one ISA or revision never carries to
 * another, and ISAGate never skips an ISA it has not checked.
 *
 * @version 2.0.1
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, renameSync } from "fs";
import { join, resolve } from "path";
import { invariant } from "../../LIFEOS/TOOLS/Invariant";
import { lifeosPath } from "./paths";

const STATE_DIR = lifeosPath("MEMORY", "STATE", "stop-gate-obligations");
const MAX_RETRIES = 3;

interface GateObligation {
  isa_path?: string;
  last_revision?: string;
  last_evaluated?: number;
  retry_count: number;
  resolved: boolean;
}

interface ObligationState {
  session_id: string;
  /** Keyed by `<gate>\u0000<canonical ISA path>`. Entries from the gate-name-only
   *  format carry no binding, so they never match a key and are inert. */
  obligations: Record<string, GateObligation>;
  /** The ISA and revision each gate last checked, so the path-less isExhausted
   *  and getStatus read the obligation the gate is evaluating right now. */
  active?: Record<string, ActiveBinding>;
  updated: string;
}

/** One spelling per ISA: symlinks and `..` resolved, so aliases share an entry. */
function canonicalIsaPath(isaPath: string): string {
  try {
    return realpathSync(isaPath);
  } catch {
    return resolve(isaPath);
  }
}

interface ActiveBinding { key: string; revision: string }

function obligationKey(gateName: string, canonicalPath: string): string {
  return `${gateName}\u0000${canonicalPath}`;
}

function stateFile(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "");
  return join(STATE_DIR, `${safe}.json`);
}

function emptyState(sessionId: string): ObligationState {
  return { session_id: sessionId, obligations: {}, active: {}, updated: new Date().toISOString() };
}

function readState(sessionId: string): ObligationState {
  try {
    const f = stateFile(sessionId);
    if (!existsSync(f)) return emptyState(sessionId);
    const parsed = JSON.parse(readFileSync(f, "utf-8"));
    if (!parsed || typeof parsed.obligations !== "object" || parsed.obligations === null) return emptyState(sessionId);
    const active = parsed.active && typeof parsed.active === "object" ? parsed.active : {};
    return { ...parsed, session_id: sessionId, active };
  } catch {
    return emptyState(sessionId);
  }
}

function writeState(state: ObligationState): void {
  invariant(state.session_id.length > 0, "obligation state written without a session id");
  for (const [key, ob] of Object.entries(state.obligations)) {
    if (!key.includes("\u0000")) continue; // legacy entry, inert
    invariant(
      Number.isInteger(ob.retry_count) && ob.retry_count >= 0 && ob.retry_count <= MAX_RETRIES,
      `obligation ${JSON.stringify(key)} retry_count ${ob.retry_count} outside 0..${MAX_RETRIES}`,
    );
    invariant(
      ob.isa_path === undefined || key.endsWith(`\u0000${ob.isa_path}`),
      `obligation ${JSON.stringify(key)} bound to a different ISA path ${ob.isa_path}`,
    );
  }
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const f = stateFile(state.session_id);
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, f);
  } catch {
    // State write is best-effort
  }
}

/** The obligation for exactly this ISA at exactly this revision; anything else is a fresh one. */
function boundObligation(state: ObligationState, key: string, canonicalPath: string, revision: string): GateObligation {
  const ob = state.obligations[key];
  if (!ob || ob.isa_path !== canonicalPath || ob.last_revision !== revision) {
    return { retry_count: 0, resolved: false };
  }
  return ob;
}

/**
 * Check if a gate should evaluate this turn, for this ISA at this revision.
 * Returns { resolved, retry_count, should_evaluate }. Records this ISA as the one
 * the gate is now evaluating, which the path-less isExhausted reads.
 */
export function checkObligation(
  sessionId: string,
  gateName: string,
  isaPath: string,
  currentRevision: string
): { resolved: boolean; retry_count: number; should_evaluate: boolean } {
  const state = readState(sessionId);
  const canonical = canonicalIsaPath(isaPath);
  const key = obligationKey(gateName, canonical);
  const ob = boundObligation(state, key, canonical, currentRevision);

  const current = state.active?.[gateName];
  if (current?.key !== key || current.revision !== currentRevision) {
    state.active = { ...(state.active ?? {}), [gateName]: { key, revision: currentRevision } };
    state.updated = new Date().toISOString();
    writeState(state);
  }

  return {
    resolved: ob.resolved,
    retry_count: ob.retry_count,
    should_evaluate: !ob.last_revision || (!ob.resolved && ob.retry_count < MAX_RETRIES),
  };
}

/**
 * Record an evaluation result for a gate on this ISA at this revision.
 */
export function recordEvaluation(
  sessionId: string,
  gateName: string,
  isaPath: string,
  currentRevision: string,
  resolved: boolean
): void {
  const state = readState(sessionId);
  const canonical = canonicalIsaPath(isaPath);
  const key = obligationKey(gateName, canonical);
  const ob = { ...boundObligation(state, key, canonical, currentRevision) };

  if (!resolved && ob.retry_count < MAX_RETRIES) {
    ob.retry_count++;
  }

  ob.isa_path = canonical;
  ob.last_revision = currentRevision;
  ob.last_evaluated = Date.now();
  ob.resolved = resolved;

  state.obligations[key] = ob;
  state.active = { ...(state.active ?? {}), [gateName]: { key, revision: currentRevision } };
  state.updated = new Date().toISOString();
  writeState(state);
}

/** With a path, that ISA's latest entry; without one, the gate's active binding,
 *  and only while the entry still holds the revision the gate last checked. */
function targetObligation(state: ObligationState, gateName: string, isaPath?: string): GateObligation | undefined {
  if (isaPath !== undefined) return state.obligations[obligationKey(gateName, canonicalIsaPath(isaPath))];
  const binding = state.active?.[gateName];
  if (!binding || typeof binding.key !== "string") return undefined;
  const ob = state.obligations[binding.key];
  return ob && ob.last_revision === binding.revision ? ob : undefined;
}

/**
 * Check if a gate's obligation is exhausted. With no path, the ISA the gate
 * last checked is the one judged; an exhausted ISA never exhausts another.
 */
export function isExhausted(
  sessionId: string,
  gateName: string,
  isaPath?: string
): boolean {
  const ob = targetObligation(readState(sessionId), gateName, isaPath);
  return !!ob && ob.retry_count >= MAX_RETRIES && !ob.resolved;
}

/**
 * Get human-readable obligation status.
 */
export function getStatus(sessionId: string, gateName: string, isaPath?: string): string {
  const ob = targetObligation(readState(sessionId), gateName, isaPath);
  if (!ob) return "not_tracked";
  if (ob.resolved) return "resolved";
  if (ob.retry_count >= MAX_RETRIES) return `exhausted`;
  return `unresolved`;
}
