/**
 * gate-run.ts — the two gate kinds (ISA 20261015-security-p1-batch1, L1 "Gate kinds", C1/C2).
 *
 *   runGate(kind, name, fn)       async; fn may return a value or a promise.
 *   runGateSync(kind, name, fn)   the same for a gate that must stay synchronous.
 *   gateInput(source)             the gate's input, or a thrown UnreadableInput.
 *
 * What a gate decides when it works is its own business: the result is `{ status: "ok", value }` with whatever
 * fn returned. runGate only decides what happens when the gate itself breaks (a throw, a rejection, unreadable input):
 *
 *   enforce  (send, public push, taint, secret reads, deploy) fails CLOSED: decision "block" with a reason naming
 *            the gate and the error. Nothing is emitted; the block is the record.
 *   advise   (ISA, format, nudges, verification reminders, every Stop gate) fails OPEN, LOUDLY: decision "allow",
 *            one Vigil event (meta.event "hook-error", the gate name, the scrubbed error) and one stderr line.
 *
 * The kind of each gate is set in the gate's own file at its call site, never in a central list.
 * runGate never throws: a failing emitter or logger leaves the decision unchanged and reports `emitted: false`.
 * The event is reached through LIFEOS/TOOLS/lib/VigilOptional (computed path), whose internals write through STATVS
 * writeEvent (STATVS migration design §3 Lane E1), so a public install without it still runs and simply emits nothing.
 * An emitter result of `false` or `{ ok: false }` (writeEvent's refusal) reads as not emitted (Lane E2). The write
 * happens after the decision and never changes it (STATVS ISC-58).
 *
 * The move stream (STATVS ISA F14): every verdict that is not an allow (a refusal, an ask, a deferral) and every
 * gate failure (fail-closed, fail-open) is written as one row in the STATVS `move` stream, after the decision, so
 * refused moves are part of the record that rebuild and replay read. An allow writes nothing and loads nothing.
 * The verdict is read from the gate's own result shape (`block: true`, `decision`/`permissionDecision` of block,
 * deny or ask, `status: "deferred"`); a result with none of them is an allow. Under a test runner (NODE_ENV=test)
 * with no STATVS_DIR nothing is written, so tests never reach the live record.
 * @version 1.2.1
 */
import { createHash } from "node:crypto";
import { emitVigilEvent, type VigilEvent } from "../../LIFEOS/TOOLS/lib/VigilOptional";
import { redactSecretValues } from "./egress-shapes";

export type GateKind = "enforce" | "advise";
export type GateCause = "error" | "unreadable-input";

export type GateRun<T> =
  | { status: "ok"; value: T }
  | {
      status: "failed";
      kind: GateKind;
      gate: string;
      cause: GateCause;
      /** enforce → "block", advise → "allow". */
      decision: "block" | "allow";
      /** One line naming the gate and the (scrubbed) error; safe to print to the model or stderr. */
      reason: string;
      /** advise only: whether the Vigil event was handed over. Always false for enforce. */
      emitted: boolean;
    };

export type GateDeps = {
  /** Event emitter; `false` or `{ ok: false }` means the event was not written, anything else that it was. Tests stub this. */
  emit?: (event: VigilEvent) => boolean | unknown;
  /** One stderr line for an advise failure. Tests stub this. */
  log?: (line: string) => void;
  /** The move-row writer (STATVS `move` stream). Tests stub this; the default appends to STATVS. */
  record?: (move: MoveRow) => unknown;
};

/** A non-allow verdict, as the move stream records it. */
export type MoveVerdict = "refuse" | "ask" | "defer" | "fail-closed" | "fail-open";

/** One move row's data: which gate ruled, how, and why (scrubbed). `session` goes on the row's envelope, not its data. */
export type MoveRow = { gate: string; kind: GateKind; verdict: MoveVerdict; reason: string; cause?: GateCause; session?: string };

/** Thrown when a gate's input is empty, malformed, or not a JSON object. */
export class UnreadableInput extends Error {
  constructor(detail: string) {
    super(`unreadable input: ${detail}`);
    this.name = "UnreadableInput";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The gate's input as a JSON object, or a thrown UnreadableInput. Accepts the raw stdin text, an already-parsed
 * object, or a hook-io `HookInputRead` (`{ ok: true, input }` unwraps; `{ ok: false, reason }` is unreadable,
 * including `empty`: a gate that received nothing checked nothing).
 */
export function gateInput(source: unknown): Record<string, unknown> {
  if (source === null || source === undefined) throw new UnreadableInput("none");
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (!trimmed) throw new UnreadableInput("empty");
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { throw new UnreadableInput("not JSON"); }
    if (!isRecord(parsed)) throw new UnreadableInput("not a JSON object");
    return parsed;
  }
  if (isRecord(source) && typeof source.ok === "boolean" && ("input" in source || "reason" in source)) {
    if (source.ok && isRecord(source.input)) return source.input;
    throw new UnreadableInput(typeof source.reason === "string" ? source.reason.slice(0, 40) : "read failed");
  }
  if (isRecord(source)) return source;
  throw new UnreadableInput(`a ${Array.isArray(source) ? "list" : typeof source}`);
}

// ── failure handling ─────────────────────────────────────────────────────────

/** A gate name safe for an event field and a dedup key. */
function safeName(name: unknown): string {
  const s = typeof name === "string" ? name.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64) : "";
  return s || "unnamed-gate";
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || "Error";
  if (err === undefined) return "undefined thrown";
  try { return typeof err === "string" ? err : JSON.stringify(err) ?? String(err); } catch { return String(err); }
}

/**
 * Error text with every path-like word, address and secret-shaped value removed, capped. Runs of 40+ token
 * characters are cut too, so a hash or key the shapes miss cannot make Vigil's schema refuse the event.
 */
export function scrubError(text: string, max = 300): string {
  const words = redactSecretValues(String(text ?? "")).split(/\s+/).filter(Boolean).map((w) =>
    /[\/\\]/.test(w) || w.startsWith("~") ? "<path>" : w.includes("@") ? "<redacted>" : w,
  );
  return words.join(" ").replace(/[A-Za-z0-9+/=_-]{40,}/g, "<redacted>").slice(0, max);
}

const defaultEmit = (event: VigilEvent): unknown => emitVigilEvent(event);

/** Whether an emitter result means the event was written: `false` and a `{ ok: false }` write result do not. */
export function wasWritten(result: unknown): boolean {
  return result !== false && !(isRecord(result) && result.ok === false);
}

const defaultLog = (line: string): void => { process.stderr.write(line + "\n"); };

function hookErrorEvent(gate: string, cause: GateCause, detail: string): VigilEvent {
  const now = new Date();
  const hour = Math.floor(now.getTime() / 3_600_000);
  const digest = createHash("sha256").update(`${cause}\0${detail}`).digest("hex").slice(0, 12);
  return {
    id: crypto.randomUUID(),
    source: `hook:${gate}`,
    ts: now.toISOString(),
    kind: "infra",
    severity: "medium",
    title: `hook-error: ${gate} failed open`.slice(0, 140),
    summary: `Advise gate ${gate} broke (${cause}) and let the action through: ${detail}`.slice(0, 1000),
    ref: null,
    url: null,
    privacy_class: "personal",
    dedup_key: `hook-error:${gate}:${hour}:${digest}`,
    meta: { event: "hook-error", gate, cause, kind: "advise" },
  };
}

// ── the move stream ──────────────────────────────────────────────────────────

/** The verdict a gate's own result carries, or null for an allow (or a result that is not a verdict). */
export function moveVerdict(value: unknown): { verdict: MoveVerdict; reason: string } | null {
  if (!isRecord(value)) return null;
  const said = (k: string): string => (typeof value[k] === "string" ? (value[k] as string) : "");
  const reason = said("reason") || said("message") || said("permissionDecisionReason");
  const decision = (said("decision") || said("permissionDecision")).toLowerCase();
  if (value.block === true || decision === "block" || decision === "deny") return { verdict: "refuse", reason };
  if (decision === "ask") return { verdict: "ask", reason };
  if (said("status") === "deferred" || decision === "defer" || decision === "deferred") return { verdict: "defer", reason };
  return null;
}

type StatvsAppend = (input: { writer: string; stream: string; class: string; kind: string; title: string; session?: string; data: unknown }, opts?: { noDrain?: boolean }) => unknown;
let statvsAppend: StatvsAppend | null = null;

const defaultRecord = (move: MoveRow): unknown => {
  // A test runner reaches a record only through an explicit STATVS_DIR (ISC-103).
  if (process.env.NODE_ENV === "test" && !process.env.STATVS_DIR) return false;
  statvsAppend ??= (require("../../LIFEOS/STATVS/lib/record") as { append: StatvsAppend }).append;
  const { session, ...data } = move;
  return statvsAppend({ writer: `hook:${move.gate}`, stream: "move", class: "personal", kind: "move", title: `${move.gate} ${move.verdict}`, ...(session ? { session } : {}), data }, { noDrain: true }); // a verdict never waits on draining the spool
};

/** Write one move row after the decision. Never throws and never changes the result (ISC-101). */
function recordMove(move: MoveRow, deps: GateDeps): void {
  try { (deps.record ?? defaultRecord)({ ...move, reason: scrubError(move.reason) }); } catch { /* the decision stands */ }
}

/** The Claude Code session a hook input names, if any: what a move row puts on its envelope. */
export function sessionOf(input: unknown): string | undefined {
  const s = isRecord(input) ? input.session_id : undefined;
  // An id, never a carrier: a path or a value smuggled in as session_id is dropped, not recorded.
  return typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : undefined;
}

/**
 * For a gate that decides outside runGate (it exits from deep inside its own dispatcher): write the move row its
 * refusal or ask would have written through runGate, before it exits (STATVS ISC-116). Same row, same scrub, same
 * test guard; never throws. An allow has nothing to record, so a gate calls this only on a non-allow verdict.
 */
export function recordVerdict(gate: string, verdict: MoveVerdict, reason: string, opts: { kind?: GateKind; session?: string; deps?: GateDeps } = {}): void {
  recordMove({ gate: safeName(gate), kind: normalKind(opts.kind), verdict, reason, ...(opts.session ? { session: opts.session } : {}) }, opts.deps ?? {});
}

function withMove<T>(kind: GateKind, name: string, value: T, deps: GateDeps): GateRun<T> {
  const v = moveVerdict(value);
  if (v) recordMove({ gate: safeName(name), kind, verdict: v.verdict, reason: v.reason }, deps);
  return { status: "ok", value };
}

function onFailure<T>(kind: GateKind, name: string, err: unknown, deps: GateDeps): GateRun<T> {
  const gate = safeName(name);
  const cause: GateCause = err instanceof UnreadableInput ? "unreadable-input" : "error";
  const detail = scrubError(messageOf(err)) || "no message";
  recordMove({ gate, kind, verdict: kind === "enforce" ? "fail-closed" : "fail-open", reason: detail, cause }, deps);
  if (kind === "enforce") {
    return {
      status: "failed", kind, gate, cause, decision: "block", emitted: false,
      reason: `[${gate}] blocked: the gate could not run (${cause === "unreadable-input" ? "" : "error: "}${detail}). An enforce gate fails closed.`,
    };
  }
  let emitted = false;
  try { emitted = wasWritten((deps.emit ?? defaultEmit)(hookErrorEvent(gate, cause, detail))); } catch { emitted = false; }
  const reason = `[${gate}] advise gate failed open (${cause}): ${detail}${emitted ? "" : " (Vigil event not recorded)"}`;
  try { (deps.log ?? defaultLog)(reason); } catch { /* the result still carries it */ }
  return { status: "failed", kind, gate, cause, decision: "allow", emitted, reason };
}

/** An unknown kind is treated as enforce: a typo must never turn a security gate into one that fails open. */
const normalKind = (kind: unknown): GateKind => (kind === "advise" ? "advise" : "enforce");

// ── the runners ──────────────────────────────────────────────────────────────

export async function runGate<T>(kind: GateKind, name: string, fn: () => T | Promise<T>, deps: GateDeps = {}): Promise<GateRun<T>> {
  const k = normalKind(kind);
  let value: T;
  try {
    value = await fn();
  } catch (err) {
    return onFailure<T>(k, name, err, deps);
  }
  return withMove(k, name, value, deps);
}

/** For a gate that must stay synchronous. A fn that returns a promise is a gate whose verdict was never checked, so it fails like a throw. */
export function runGateSync<T>(kind: GateKind, name: string, fn: () => T, deps: GateDeps = {}): GateRun<T> {
  const k = normalKind(kind);
  let value: T;
  try {
    value = fn();
    if (value && typeof (value as { then?: unknown }).then === "function") {
      (value as unknown as Promise<unknown>).catch(() => { /* already reported as a failure below */ });
      throw new Error("runGateSync got a promise; use runGate");
    }
  } catch (err) {
    return onFailure<T>(k, name, err, deps);
  }
  return withMove(k, name, value, deps);
}
