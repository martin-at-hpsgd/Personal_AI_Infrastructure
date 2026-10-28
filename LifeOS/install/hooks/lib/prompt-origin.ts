/**
 * @version 3.0.1
 * prompt-origin — did the principal type this prompt, or did a machine deliver it?
 *
 * Two command hooks act on "the principal spoke": Safety clears the taint mark and
 * SendOverride mints a send-release token. Task notifications, peer messages, (maintainer-side; not in the public release)
 * scheduled triggers and channel deliveries fire the same UserPromptSubmit hooks,
 * and Claude Code 2.1.287 builds that hook's input without its `source` field
 * (the binary spreads `...!1` where `source` would go). So a command hook cannot
 * tell them apart on its own.
 *
 * The LifeOSHooks plugin can: `prompt.submit` carries `origin.kind`. Before it
 * calls `next()` (which runs the settings hooks) it records `{ kind, sha }` here
 * through HookBridge `prompt-origin`. The sha is of the prompt text.
 *
 * Fail-closed contract (2026-10-13): an
 * unreadable or corrupt record file, a missing session id, an empty prompt, or
 * (once the session is ARMED) a missing or expired record all read as UNKNOWN
 * origin, never as the principal. A session is armed the first time a
 * principal-kind record (composer, bridge) is written for it: from then on the
 * principal is recognised only by positive evidence, a fresh principal record
 * whose sha matches. A `source` field, when a later build sends it, wins over
 * the record.
 *
 * 3.0.0 (2026-10-14): absence never counts.
 * A missing state file, and an unarmed session with no matching record, used to
 * read as the principal (the older "no delivery record" reading), so Safety
 * could clear taint and the send-override hook mint a release on no evidence at all. Now
 * every path without a fresh principal record for this exact text, or a
 * principal `source`, is UNKNOWN origin. The `armed` flag is still written and
 * survives record expiry, but no decision depends on it any more.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { getLifeosDir } from "./paths";
import { invariant } from "../../LIFEOS/TOOLS/Invariant";

/** A record is about the prompt the settings hooks are running for right now; two minutes is generous. */
export const ORIGIN_TTL_MS = 2 * 60 * 1000;
/** Positive principal evidence is short-lived: the settings hooks run right after the plugin writes it. */
export const PRINCIPAL_TTL_MS = 60 * 1000;
/** Records kept per session; deliveries can queue back to back. */
const KEEP = 16;

/** Origins that are the principal typing (terminal composer, Remote Control). Everything else is a machine delivery. */
export const PRINCIPAL_ORIGIN_KINDS: ReadonlySet<string> = new Set(["composer", "bridge"]);

/** What nonPrincipalOrigin returns when it cannot establish the origin. Never treated as the principal. */
export const UNKNOWN_ORIGIN = "unknown-origin";

export interface OriginRecord { kind: string; sha: string; ts: number }

/** On-disk state. `armed` is set once a principal record was written for the session. A bare array is the v1 format. */
interface OriginState { armed: boolean; records: OriginRecord[] }
type ReadResult = { ok: true; state: OriginState } | { ok: false };

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "unknown";
}

export function originPath(sessionId: string, root: string = getLifeosDir()): string {
  return join(root, "MEMORY", "STATE", "prompt-origin", `${safeId(sessionId)}.json`);
}

export function promptSha(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

function validRecords(v: unknown): OriginRecord[] | null {
  if (!Array.isArray(v)) return null;
  return (v as OriginRecord[]).filter((r) => r && typeof r.sha === "string" && typeof r.kind === "string" && typeof r.ts === "number");
}

/** A missing file is an empty, unarmed state. A file that exists but cannot be read or parsed is `ok: false`. */
function readState(path: string): ReadResult {
  if (!existsSync(path)) return { ok: true, state: { armed: false, records: [] } };
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const legacy = validRecords(j);
    if (legacy) return { ok: true, state: { armed: false, records: legacy } };
    if (j && typeof j === "object") {
      const o = j as { armed?: unknown; records?: unknown };
      const records = validRecords(o.records);
      if (records && typeof o.armed === "boolean") return { ok: true, state: { armed: o.armed, records } };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Record a prompt's origin. Principal kinds are recorded too: they are the positive evidence that arms the
 * session. Throws on a write failure so the bridge reports it. A corrupt existing file is replaced, and the
 * replacement is armed only if this record is a principal one (a corrupt file proves nothing either way).
 */
export function recordOrigin(input: { session_id: string; kind: string; prompt: string }, opts: { root?: string; now?: number } = {}): boolean {
  if (!input.session_id || !input.kind) return false;
  const now = opts.now ?? Date.now();
  const path = originPath(input.session_id, opts.root);
  const read = readState(path);
  const prior = read.ok ? read.state : { armed: false, records: [] };
  const principal = PRINCIPAL_ORIGIN_KINDS.has(input.kind);
  const kept = prior.records.filter((r) => now - r.ts < ORIGIN_TTL_MS);
  kept.push({ kind: input.kind, sha: promptSha(input.prompt), ts: now });
  const next: OriginState = { armed: prior.armed || principal, records: kept.slice(-KEEP) };
  invariant(next.records.length > 0 && next.records[next.records.length - 1]!.sha.length === 64, "prompt-origin: record not built");
  invariant(!principal || next.armed, "prompt-origin: a principal record must arm the session");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next));
  renameSync(tmp, path);
  return true;
}

/** `source` values that mean the principal typed it. Both the hook-input vocabulary (d.ts `user`) and the
 *  engine's internal prompt-source vocabulary (`typed`, `queued`, `suggestion_accepted`) are listed, so a later
 *  build that fills the field with either never reads the principal's own prompt as a delivery. */
const PRINCIPAL_SOURCES: ReadonlySet<string> = new Set(["user", "typed", "queued", "suggestion_accepted", "composer", "bridge", "human"]);
/** `source` values that are machine deliveries. Anything in neither set falls through to the record. */
const MACHINE_SOURCES: ReadonlySet<string> = new Set([
  "system", "sdk", "loop_wakeup", "schedule_wakeup", "poll_event", "task-notification", "scheduled-trigger", "peer",
  "peer-send-message", "channel", "coordinator", "observer", "observer-activity", "plugin", "projects-relay",
  "slack-ping", "unclassified", "auto-continuation",
]);
/** Deliveries that can reach the settings hooks without passing the plugin's prompt.submit (enqueue-time
 *  passes: remote session notices, poll events) still carry one of these envelopes. */
const MACHINE_TEXT: readonly RegExp[] = [
  /^<task-notification>/, /^<cross-session-message\b/, /^\[Cross-session idle notice\]/, /^<system-reminder>/,
];

/**
 * The non-principal origin for this prompt, or null when it is the principal. A machine delivery returns its
 * kind; anything that cannot be established returns UNKNOWN_ORIGIN, which callers must never treat as the principal.
 */
export function nonPrincipalOrigin(input: Record<string, unknown>, opts: { root?: string; now?: number } = {}): string | null {
  const source = input.source;
  if (typeof source === "string" && source) {
    if (PRINCIPAL_SOURCES.has(source)) return null;
    if (MACHINE_SOURCES.has(source)) return source;
  }
  const sid = typeof input.session_id === "string" ? input.session_id : "";
  const prompt = typeof input.prompt === "string" ? input.prompt : typeof input.user_prompt === "string" ? input.user_prompt : "";
  if (!prompt.trim()) return UNKNOWN_ORIGIN;
  if (MACHINE_TEXT.some((re) => re.test(prompt.trimStart()))) return "machine-envelope";
  if (!sid) return UNKNOWN_ORIGIN;
  const path = originPath(sid, opts.root);
  // No state at all is no evidence: it never reads as the principal.
  if (!existsSync(path)) return UNKNOWN_ORIGIN;
  const read = readState(path);
  if (!read.ok) return UNKNOWN_ORIGIN;
  const now = opts.now ?? Date.now();
  const sha = promptSha(prompt);
  // Newest record for this text decides: a delivery that repeats the principal's last words reads as the delivery.
  const hit = [...read.state.records].reverse().find((r) => r.sha === sha && now - r.ts >= 0 && now - r.ts < ORIGIN_TTL_MS);
  if (hit && !PRINCIPAL_ORIGIN_KINDS.has(hit.kind)) return hit.kind;
  if (hit && now - hit.ts < PRINCIPAL_TTL_MS) return null;
  // Positive evidence only: no fresh principal record for this exact text is unknown origin, armed or not.
  return UNKNOWN_ORIGIN;
}

/** True only when the prompt is the principal's. Unknown origin is false. */
export function isPrincipalPrompt(input: Record<string, unknown>, opts: { root?: string; now?: number } = {}): boolean {
  return nonPrincipalOrigin(input, opts) === null;
}
