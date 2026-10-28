#!/usr/bin/env bun
/**
 * One-time seed (CENSVS ISA F8, ISC-41): brings every Upgrades record that predates the
 * dual-write into the record as a `proposal:<upgrade id>` RES, at the state the store holds
 * now, so the `things-proposal` slice can equal the store.
 *
 *   bun LIFEOS/CENSVS/tools/seed-proposals.ts            dry run: counts, writes nothing
 *   bun LIFEOS/CENSVS/tools/seed-proposals.ts --apply    one create row per record not yet in the record
 *   add --json for the summary as JSON
 *
 * Idempotent: an id the record already issued (created, observed or retired) is skipped, so a
 * rerun writes nothing. It never moves or edits a RES that exists; a difference between such a
 * RES and the store is what `Statvs.ts compare things-proposal` reports.
 *
 * Each create carries the store's current state directly (a seed records what already happened,
 * it decides nothing), written by `tool:Upgrades:seed`, which GENERA's fieldOwners reads as the
 * Upgrades store (prefix `tool:Upgrades`). The store is read through Upgrades.ts's own parser and
 * mapped by its proposalShape(), the mapping the dual-write uses. Old store files are never
 * touched (migration step 1 keeps the store).
 *
 * The record is STATVS_DIR, else the live record; the store is LIFEOS_UPGRADES_DIR, else the
 * live store. Tests set both.
 *
 * @version 1.0.0
 */
import { listUpgrades, proposalId, proposalShape, type UpgradeRecord } from "../../TOOLS/Upgrades";
import { invariant } from "../../TOOLS/Invariant";
import { canonicalState, validSubject } from "../genera";
import { create, recordFold } from "../res";

export const SEED_WRITER = "tool:Upgrades:seed";

export interface SeedResult {
  apply: boolean;
  /** Records the store parses. */
  store: number;
  /** Of those, ids the record already issued. */
  present: number;
  /** Records not yet in the record that can be written: what a dry run would write, what apply tried. */
  toWrite: number;
  written: number;
  /** Apply: creates the record spooled (they land when the spool drains). */
  spooled: number;
  /**
   * Records that can never be a RES under their id (the subject guard refuses the key, e.g. a hex run that
   * reads as a phone number): never written, in either mode. The slice leaves them out (live/proposal.ts).
   */
  unrepresentable: number;
  /** Apply: the writer refused at write time, reason → count. Any entry makes the CLI exit 1. */
  refused: Record<string, number>;
  /** Up to five unrepresentable or refused upgrade ids with their reason. */
  examples: { id: string; reason: string }[];
  byState: Record<string, number>;
}

/** Why the writer would refuse this record before any append, or null. Read-only. */
function precheck(r: UpgradeRecord): string | null {
  const bad = validSubject(proposalId(r.id));
  if (bad) return bad;
  if (canonicalState("proposal", r.status) === null) return `proposal has no state "${r.status}"`;
  return null;
}

export function seedProposals(opts: { apply: boolean; read?: () => UpgradeRecord[] }): SeedResult {
  const records = [...(opts.read ?? (() => listUpgrades()))()].sort((a, b) => a.id.localeCompare(b.id));
  const out: SeedResult = { apply: opts.apply, store: records.length, present: 0, toWrite: 0, written: 0, spooled: 0, unrepresentable: 0, refused: {}, examples: [], byState: {} };
  const fold = recordFold();
  const missing: UpgradeRecord[] = [];
  for (const r of records) {
    const sid = proposalId(r.id);
    if (Object.hasOwn(fold.issued, sid) || Object.hasOwn(fold.res, sid)) out.present++;
    else missing.push(r);
  }
  const example = (id: string, reason: string) => { if (out.examples.length < 5) out.examples.push({ id, reason }); };
  const refuse = (id: string, reason: string) => { out.refused[reason] = (out.refused[reason] ?? 0) + 1; example(id, reason); };
  for (const r of missing) {
    const state = canonicalState("proposal", r.status) ?? r.status;
    out.byState[state] = (out.byState[state] ?? 0) + 1;
    const why = precheck(r);
    if (why) { out.unrepresentable++; example(r.id, why); continue; }
    if (!opts.apply) continue;
    const sid = proposalId(r.id);
    // Never reissue: the fold is re-read (incrementally) so a writer racing this seed is seen.
    invariant(!Object.hasOwn(recordFold().issued, sid), `seed-proposals: ${sid} must not be in the record before its create`);
    const s = proposalShape(r);
    const res = create(sid, { title: s.title, state: s.state, data: s.data }, { writer: SEED_WRITER });
    if (res.ok) out.written++;
    else if ("spooled" in res) out.spooled++;
    else refuse(r.id, res.refused);
  }
  out.toWrite = missing.length - out.unrepresentable;
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--apply" && a !== "--json");
  if (unknown.length) {
    console.error(`seed-proposals: unknown argument ${unknown.join(", ")}; usage: seed-proposals.ts [--apply] [--json]`);
    process.exit(2);
  }
  const r = seedProposals({ apply: args.includes("--apply") });
  if (args.includes("--json")) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`${r.apply ? "applied" : "dry run"}: store ${r.store}, already in the record ${r.present}, to write ${r.toWrite}, written ${r.written}${r.spooled ? `, spooled ${r.spooled}` : ""}`);
    console.log(`by state: ${Object.entries(r.byState).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
    if (r.unrepresentable) console.log(`cannot be a RES under its id (left out of the slice): ${r.unrepresentable}`);
    for (const [why, n] of Object.entries(r.refused)) console.log(`refused at write: ${n}  ${why}`);
    for (const e of r.examples) console.log(`  e.g. ${e.id}: ${e.reason}`);
  }
  const failed = r.apply && Object.keys(r.refused).length > 0;
  process.exit(failed ? 1 : 0);
}
