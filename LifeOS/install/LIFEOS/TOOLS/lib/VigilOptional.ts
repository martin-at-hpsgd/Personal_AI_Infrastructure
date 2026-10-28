/**
 * Optional Vigil access for files that ship publicly.
 *
 * Vigil (LIFEOS/VIGIL) is a private zone, so a shipped file never imports it by a literal or static path:
 * ShadowRelease's assertStagedOptionalImports refuses the cut when one does. These loaders resolve Vigil by a
 * computed path and return null when it is absent, so a public install simply emits nothing. Loading is
 * synchronous (require), so a caller keeps its old sync semantics and an emit error still reaches it.
 *
 * VIGIL_DIR overrides the directory, the same variable EvalSample and ISAGate honour.
 *
 * STATVS migration (design §1.3, §3 Lane E1, S12): events are written by STATVS `writeEvent`
 * (LIFEOS/STATVS/lib/event.ts), loaded the same optional way, so this file keeps its name and exports and its
 * importers need no change. Adapter modules are looked up under STATVS/adapters first, then VIGIL/adapters (lane C
 * moves them in p2). Until p3: an explicit VIGIL_DIR still names the emitter (a test's fake Vigil, or a simulated
 * public install), and an install without STATVS falls back to Vigil's own emit.
 * @version 1.1.0
 */
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { InvariantViolation } from "../Invariant";

/** A Vigil event, structurally (LIFEOS/VIGIL/Schema.ts is the source; a shipped file cannot import it). */
export type VigilEvent = {
  id: string; source: string; ts: string; kind: string; severity: string;
  title: string; summary: string; ref: string | null; url: string | null;
  privacy_class: string; dedup_key: string;
  meta?: Record<string, unknown>;
};

/** The Vigil code directory: VIGIL_DIR, else LIFEOS/VIGIL beside this tree. */
export const vigilDir = (): string => process.env.VIGIL_DIR || join(import.meta.dir, "../../VIGIL");

/** The STATVS code directory, LIFEOS/STATVS beside this tree. (STATVS_DIR names the record, never this.) */
export const statvsCodeDir = (): string => join(import.meta.dir, "../../STATVS");

/** One Vigil module by file name, or null when Vigil is not installed. */
export function loadVigilModule<T>(file: string): T | null {
  const path = join(vigilDir(), file);
  if (!existsSync(path)) return null;
  return require(path) as T;
}

/** One adapter module by file name, from the first of STATVS/adapters and VIGIL/adapters that holds it; null when neither does. */
export function loadAdapterModule<T>(file: string, dirs: string[] = [join(statvsCodeDir(), "adapters"), join(vigilDir(), "adapters")]): T | null {
  for (const dir of dirs) {
    const path = join(dir, file);
    if (existsSync(path)) return require(path) as T;
  }
  return null;
}

/** What a write returns, narrowed from STATVS `writeEvent`'s outcome to what callers check. */
export type VigilWriteResult = { ok: true; event_id: string } | { ok: false; event_id: string; refused: string };
type EventWriter = (event: VigilEvent) => VigilWriteResult;

/** Vigil's throwing `emit` as a writer: a refusal becomes `ok: false`; an InvariantViolation still escapes. */
function fromEmit(emit: (event: never) => unknown): EventWriter {
  return (event) => {
    try { emit(event as never); return { ok: true, event_id: event.id }; }
    catch (e) {
      if (e instanceof InvariantViolation) throw e;
      return { ok: false, event_id: event.id, refused: e instanceof Error ? e.message : String(e) };
    }
  };
}

/**
 * The event writer, or null when nothing is installed. An explicit VIGIL_DIR names the emitter (that directory's
 * Emit.ts, never STATVS), so a fake or absent Vigil stays exactly what a test made it. Otherwise STATVS `writeEvent`,
 * else Vigil's emit on an install without STATVS. Never throws for a refusal.
 */
export function loadEventWriter(): EventWriter | null {
  const vigilEmit = () => loadVigilModule<{ emit: (event: never) => unknown }>("Emit.ts")?.emit ?? null;
  if (process.env.VIGIL_DIR) { const emit = vigilEmit(); return emit ? fromEmit(emit) : null; }
  const path = join(statvsCodeDir(), "lib/event.ts");
  if (existsSync(path)) {
    const { writeEvent } = require(path) as { writeEvent: (event: VigilEvent) => VigilWriteResult };
    return (event) => {
      const r = writeEvent(event);
      return r.ok ? { ok: true, event_id: r.event_id } : { ok: false, event_id: r.event_id, refused: r.refused };
    };
  }
  const emit = vigilEmit();
  return emit ? fromEmit(emit) : null;
}

/** Write one event: null when nothing is installed (a public install), else the outcome, which the caller checks. */
export function writeVigilEvent(event: VigilEvent): VigilWriteResult | null {
  return loadEventWriter()?.(event) ?? null;
}

/** Vigil's emit contract (validate, throw on a refusal, return the event) over the event writer, or null when nothing is installed. */
export function loadVigilEmit(): ((event: never) => unknown) | null {
  const write = loadEventWriter();
  if (!write) return null;
  return (event: never) => {
    const r = write(event as VigilEvent);
    if (!r.ok) throw new Error(r.refused);
    return event;
  };
}

/** Vigil's state path, the same rule as LIFEOS/VIGIL/State.ts (VigilOptional.test.ts holds the two equal). */
export const vigilStatePath = (...parts: string[]): string =>
  join(process.env.VIGIL_STATE_DIR || (process.env.NODE_ENV === "test" ? join(tmpdir(), `lifeos-vigil-state-test-${process.pid}`) : join(homedir(), ".local/state/lifeos/vigil")), ...parts);

type EventBuilder = (source: string, ref: string, state: string, severity: string, title: string, summary: string, kind?: string, url?: string | null, occurrence?: string) => VigilEvent;

/**
 * An event in Vigil's shape, built by the adapter helper when it is installed (so it is validated and settled exactly
 * as before) and by the same field rules here when it is not. The result is only ever consumed by an emit, which is a
 * no-op without a writer, so the fallback keeps callers and their tests working on a public install.
 */
export function vigilEvent(source: string, ref: string, state: string, severity: string, title: string, summary: string, kind = "infra", url: string | null = null, occurrence?: string): VigilEvent {
  const build = loadAdapterModule<{ event: EventBuilder }>("common.ts")?.event;
  if (build) return build(source, ref, state, severity, title, summary, kind, url, occurrence);
  return {
    id: crypto.randomUUID(), source, ts: new Date().toISOString(), kind, severity, title: title.slice(0, 140), summary: summary.slice(0, 1000),
    ref, url, privacy_class: "personal", dedup_key: `${source}:${ref}:${state}${occurrence ? `:${occurrence}` : ""}`,
  };
}

/** Emit one event through the event writer, or do nothing when none is installed. Returns whether it was handed over; a refusal throws, as before. */
export function emitVigilEvent(event: VigilEvent): boolean {
  const emit = loadVigilEmit();
  if (!emit) return false;
  emit(event as never);
  return true;
}

/** Vigil's severity ladder (LIFEOS/VIGIL/Schema.ts is the source), for validating a severity without importing Vigil. */
export const VIGIL_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
