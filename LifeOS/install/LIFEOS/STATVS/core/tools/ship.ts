#!/usr/bin/env bun
/**
 * STATVS core shipper CLI: send this machine's local record to the cloud core.
 *
 *   bun LIFEOS/STATVS/core/tools/ship.ts            ship once
 *   bun LIFEOS/STATVS/core/tools/ship.ts --dry-run  read and convert, send nothing, write no cursor
 *   bun LIFEOS/STATVS/core/tools/ship.ts --accept-held  ship held rows as accepted
 *   options: --max-rows <n>  --json
 *
 * Each call is one run; the statvs-ship Workflow (USER/WORKFLOWS) schedules them, so there is no loop here.
 *
 * Environment: STATVS_CORE_URL, STATVS_CORE_TOKEN and STATVS_MASK_KEY; any left unset is read from the sealed core
 * secrets (USER/STATVS/core-secrets.json.age), never printed. The token goes only in the Authorization header.
 * Without a mask key nothing leaves the machine, since rows could not be masked.
 * STATVS_PROVENANCE overrides the provenance config path (default USER/STATVS/provenance.json).
 * STATVS_MACHINE_ID names this machine in every chain; unset, the stored or derived id is used.
 *
 * A held row (a local hash chain that does not hold, or a payload object missing with no
 * redaction tombstone) stops its segment and is listed in ship/held.jsonl under the state dir.
 * Restore the object and the next run ships it; --accept-held ships a lost payload as
 * body-missing metadata and a failed check as a content-free integrity-failed marker.
 *
 * A row the core refuses for any reason but a provenance withhold stops its segment there and is
 * resent on the next run, so fixing the masker or the shipper ships it (ISC-161).
 *
 * Exit codes: 0 shipped (or nothing to do), 1 the run stopped on a network or server error,
 * 2 configuration missing, 3 shipped but rows are held or refused and need a look.
 *
 * @version 0.1.0
 */

import { lifeosPath } from "../../../TOOLS/Paths";
import { openSealedFile } from "../../../TOOLS/Secrets";
import { parseProvenanceConfig } from "../lib/provenance";
import { loadProvenanceFile, ship, type ShipResult } from "../lib/ship";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

if (has("--help") || has("-h")) {
  console.log("usage: ship.ts [--dry-run] [--accept-held] [--max-rows <n>] [--json]");
  process.exit(0);
}
if (has("--loop") || has("--interval")) {
  console.error("STATVS core shipper: each call ships once; the statvs-ship Workflow schedules the runs (bun LIFEOS/WORKFLOWS/workflow.ts run statvs-ship).");
  process.exit(2);
}

const dryRun = has("--dry-run");
const json = has("--json");
const acceptHeld = has("--accept-held");
const maxRows = val("--max-rows") !== undefined ? Number(val("--max-rows")) : undefined;
if (maxRows !== undefined && !(Number.isInteger(maxRows) && maxRows > 0)) { console.error("--max-rows must be a positive integer"); process.exit(2); }

let url = process.env.STATVS_CORE_URL;
let token = process.env.STATVS_CORE_TOKEN;
let maskKey = process.env.STATVS_MASK_KEY;
if (!url || !token || !maskKey) {
  try {
    const sealed = JSON.parse(new TextDecoder().decode(openSealedFile(lifeosPath("USER", "STATVS", "core-secrets.json.age")))) as Record<string, string>;
    url ||= sealed.STATVS_CORE_URL; token ||= sealed.STATVS_CORE_TOKEN; maskKey ||= sealed.STATVS_MASK_KEY;
  } catch (e) {
    console.error(`STATVS core shipper: the sealed core secrets could not be read (${(e as Error).message}).`);
  }
}
if (!dryRun && (!url || !token)) {
  console.log("STATVS core shipper: STATVS_CORE_URL and STATVS_CORE_TOKEN are not both set; nothing shipped.");
  process.exit(0);
}
if (!maskKey) {
  console.error("STATVS core shipper: STATVS_MASK_KEY is not set; nothing leaves this machine unmasked.");
  process.exit(2);
}
let provenance;
try {
  provenance = loadProvenanceFile(process.env.STATVS_PROVENANCE || lifeosPath("USER", "STATVS", "provenance.json"), parseProvenanceConfig);
} catch (e) {
  console.error(`STATVS core shipper: ${(e as Error).message}`);
  process.exit(2);
}

function report(r: ShipResult): void {
  if (json) { console.log(JSON.stringify(r)); return; }
  const parts = [`${r.pending} pending`, `${r.stored} stored`, `${r.duplicate} duplicate`, `${r.refused} refused`, `${r.withheld} withheld`, `${r.masked} masked`, `${r.bodies} bodies`, `${r.held} held`];
  if (r.accepted > 0) parts.push(`${r.accepted} accepted`);
  const cp = r.checkpoint ? `, checkpoint ${r.checkpoint.size} ${r.checkpoint.root.slice(0, 12)}` : "";
  console.log(`${dryRun ? "Dry run" : r.ok ? "Shipped" : "Stopped"}: ${parts.join(", ")}${cp}${r.error ? ` (${r.error})` : ""}`);
  for (const h of r.holds) console.log(`  ${h.accepted ? "Accepted" : "Held"} ${h.segment}#${h.seq}: ${h.reason}`);
  for (const s of r.stopped) console.log(`  Refused ${s.segment}#${s.seq}: ${s.reason}; resent next run`);
}

/**
 * Every secret value this machine holds, read in memory from the sealed env and the sealed core secrets, never
 * printed. The shipper masks each by exact match (ISC-164); without them nothing ships, so a failure stops the run.
 */
function ownSecrets(): string[] {
  const values = new Set<string>();
  const env = new TextDecoder().decode(openSealedFile(lifeosPath("..", ".env.age")));
  for (const line of env.split("\n")) {
    const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || m[1]!.startsWith("#")) continue;
    const v = m[1]!.replace(/^(["'])(.*)\1$/, "$2");
    if (v.length > 0) values.add(v);
  }
  const core = JSON.parse(new TextDecoder().decode(openSealedFile(lifeosPath("USER", "STATVS", "core-secrets.json.age")))) as Record<string, unknown>;
  for (const v of Object.values(core)) if (typeof v === "string" && v.length > 0) values.add(v);
  return [...values];
}
let secrets: string[];
try { secrets = ownSecrets(); } catch (e) {
  console.error(`STATVS core shipper: cannot read this machine's own secrets to mask them (${(e as Error).message}); nothing shipped.`);
  process.exit(2);
}

const machine = process.env.STATVS_MACHINE_ID || undefined;
const once = () => ship({ url, token, maskKey, ownSecrets: secrets, provenance, dryRun, maxRows, machine, acceptHeld, log: json ? undefined : (l) => console.error(l) });

const r = await once();
report(r);
process.exit(!r.ok ? 1 : r.held > 0 || r.stopped.length > 0 ? 3 : 0);
