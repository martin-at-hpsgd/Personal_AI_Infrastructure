/**
 * The `proposal` slice's live side (CENSVS ISA F8, ISC-41): what `Statvs.ts compare things-proposal`
 * diffs the things fold against while the Upgrades store dual-writes (STATVS migration step 3).
 *
 * The record side is every `proposal` RES the things fold holds, folded from the `res` stream. The
 * live side is the Upgrades store (LIFEOS/MEMORY/UPGRADES, or LIFEOS_UPGRADES_DIR), read through
 * Upgrades.ts's own parser and mapped by its proposalShape(), the one mapping the dual-write and the
 * seed tool use. Both sides are `{ proposals: { <upgrade id>: { title, state, ...data } } }`, with the
 * state in GENERA's word (the store's `recommended` reads as `proposed`) and data picked to
 * PROPOSAL_DATA.
 *
 * Left out, and why: the claim, current state, recommendation and notes are the store's prose (a RES
 * points at prose, never copies it), and evidence and session ids stay in the store file.
 *
 * Found by the things view on its own; imports from views/things.ts only types (things.ts imports
 * the live sources while it loads, so a runtime import back would be a cycle).
 *
 * @version 1.0.0
 */
import { listUpgrades, proposalShape, type UpgradeRecord } from "../../TOOLS/Upgrades";
import { canonicalState, validSubject } from "../genera";
import type { LiveSource, ThingsView } from "../../STATVS/views/things";

/** The data fields a proposal slice row compares, in the order a row lists them. */
export const PROPOSAL_DATA = ["species", "source_kind", "created", "expires", "confidence", "target_surface", "ledger_id"] as const;
const PREFIX = "proposal:";

type SliceRow = Record<string, unknown>;

function row(title: unknown, state: unknown, data: Record<string, unknown> | undefined): SliceRow {
  const out: SliceRow = {};
  if (typeof title === "string") out.title = title;
  if (typeof state === "string") out.state = canonicalState("proposal", state) ?? state;
  for (const f of PROPOSAL_DATA) if (data && Object.hasOwn(data, f) && data[f] !== undefined && data[f] !== null) out[f] = data[f];
  return out;
}

/** The record side: every proposal RES in the view, keyed by its upgrade id. */
export function projectProposals(view: ThingsView): { proposals: Record<string, SliceRow> } {
  const proposals: Record<string, SliceRow> = {};
  for (const r of Object.values(view.res)) {
    if (r.kind !== "proposal" || !r.id.startsWith(PREFIX)) continue;
    proposals[r.id.slice(PREFIX.length)] = row(r.title, r.state, r.data);
  }
  return { proposals };
}

/**
 * The live side: every record the store parses, mapped as the dual-write maps it. A record whose id the
 * subject guard refuses (genera validSubject, e.g. a key that reads as a phone number) can never be a RES
 * under that id, so it is left out here; the seed tool names each one, and `unrepresentable` lists them.
 */
export function storeProposals(records: UpgradeRecord[]): { proposals: Record<string, SliceRow> } {
  const proposals: Record<string, SliceRow> = {};
  for (const r of records) {
    if (validSubject(`${PREFIX}${r.id}`) !== null) continue;
    const s = proposalShape(r);
    proposals[r.id] = row(s.title, s.state, s.data);
  }
  return { proposals };
}

/** Store ids that cannot be a RES subject, with the reason: the slice leaves these out. */
export function unrepresentable(records: UpgradeRecord[]): { id: string; reason: string }[] {
  const out: { id: string; reason: string }[] = [];
  for (const r of records) {
    const why = validSubject(`${PREFIX}${r.id}`);
    if (why) out.push({ id: r.id, reason: why });
  }
  return out;
}

/** The proposal live source over any store reader; the default reads the live Upgrades store. */
export function proposalSource(read: () => UpgradeRecord[] = () => listUpgrades()): LiveSource {
  return {
    kind: "proposal",
    // The Upgrades dual-write and the seed write only to the res stream.
    streams: ["res"],
    project: (view) => projectProposals(view),
    live: () => storeProposals(read()),
  };
}

export default proposalSource();
