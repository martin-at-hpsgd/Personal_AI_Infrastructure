/**
 * The `isa` slice's live side (CENSVS ISA F5, ISC-30): what `Statvs.ts compare things-isa` diffs
 * the things fold against.
 *
 * The record side is the things fold's work map: every `work` stream row folded to `isa:<slug>`
 * through deriveSubject, with the work registry's reducer. The live side is work.json (snapshot
 * plus the event log suffix, read-only). Both are picked to ISA_FIELDS, the fields an isa RES
 * carries, and compared as `{ sessions: { <slug>: <fields> } }`.
 *
 * Fields left out, and why:
 *  - criteria: the ISA's criterion text is git prose; criteria become their own `criterion` RES
 *    from git, never copies in the record.
 *  - intent, sessionName: prose and labels the ISA file already holds.
 *  - agents, ratings, lastToolActivity, ascent, bodyHash, lastBodySize, criteriaParseWarning:
 *    session activity and render caches, not facts about the ISA.
 *
 * A live source file in LIFEOS/CENSVS/live/ is found by the things view on its own. It
 * default-exports a LiveSource and imports from views/things.ts only types: the things view
 * imports the live sources while it loads, so a runtime import back would be a cycle.
 *
 * @version 1.0.0
 */
import { readLiveRegistry, type Registry } from "../../../hooks/lib/work-events";
import type { LiveSource, ThingsState } from "../../STATVS/views/things";

/** The work.json fields an isa RES carries, in the order a slice row lists them. */
export const ISA_FIELDS = [
  "task", "phase", "progress", "started", "updatedAt", "isa", "sessionUUID", "createdBy", "iteration", "resumedAt", "resumedFromPhase",
] as const;

/** One work.json row picked to ISA_FIELDS. Values are copied as JSON (a row is plain JSON already). */
export function pickIsa(row: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!row || typeof row !== "object" || Array.isArray(row)) return out;
  const r = row as Record<string, unknown>;
  for (const f of ISA_FIELDS) if (Object.hasOwn(r, f) && r[f] !== undefined) out[f] = JSON.parse(JSON.stringify(r[f]));
  return out;
}

/** A work registry as the slice compares it. */
export function isaSlice(reg: Registry): { sessions: Record<string, Record<string, unknown>> } {
  const sessions: Record<string, Record<string, unknown>> = {};
  for (const [slug, r] of Object.entries(reg?.sessions ?? {})) sessions[slug] = pickIsa(r);
  return { sessions };
}

/** The isa live source over any registry reader; the default reads the live work.json. */
export function isaSource(read: () => Registry = () => readLiveRegistry()): LiveSource {
  return {
    kind: "isa",
    // The slice needs only the work stream: an isa RES's work map is folded from it alone.
    streams: ["work"],
    project: (_view, state: ThingsState) => ({ sessions: JSON.parse(JSON.stringify(state.work)) }),
    live: () => isaSlice(read()),
  };
}

export default isaSource();
