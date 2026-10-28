#!/usr/bin/env bun
/**
 * STATVS core — read one RES's rows from the live record, read-only (CENSVS ISA F4, ISC-25 and the ISC-27 probe).
 *
 * Pages GET /rows?subject=<kind>:<key> in ingest order with the read token and prints one line per row (offset, time,
 * stream, kind, op), or the rows as JSON with --json. Writes nothing.
 *
 * Usage: bun LIFEOS/STATVS/core/tools/rows-by-subject.ts <kind>:<key> [--json] [--limit N]
 * Environment: STATVS_CORE_URL and STATVS_CORE_READ_TOKEN; when either is unset, both come from the sealed core secrets.
 *
 * @version 0.1.0
 */
import { lifeosPath } from "../../../TOOLS/Paths";
import { openSealedFile } from "../../../TOOLS/Secrets";
import type { Ingested } from "../lib/row";
import { parseSubject } from "../lib/subject";

const args = process.argv.slice(2);
const subject = args.find((a) => !a.startsWith("--") && parseSubject(a) !== null);
const json = args.includes("--json");
const li = args.indexOf("--limit");
const max = li >= 0 ? Number(args[li + 1]) : Infinity;
if (!subject || !(max > 0)) {
  console.error("usage: rows-by-subject.ts <kind>:<key> [--json] [--limit N]");
  process.exit(2);
}
let url = process.env.STATVS_CORE_URL, token = process.env.STATVS_CORE_READ_TOKEN;
if (!url || !token) {
  const s = JSON.parse(new TextDecoder().decode(openSealedFile(lifeosPath("USER", "STATVS", "core-secrets.json.age")))) as Record<string, string>;
  url = s.STATVS_CORE_URL; token = s.STATVS_CORE_READ_TOKEN;
}
const rows: Ingested[] = [];
let next: string | undefined = "-1";
while (next !== undefined && rows.length < max) {
  const res = await fetch(`${url!.replace(/\/$/, "")}/rows?subject=${encodeURIComponent(subject)}&order=offset&limit=${Math.min(1000, max - rows.length)}&after_offset=${next}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) { console.error(`GET /rows?subject= answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`); process.exit(1); }
  const page = (await res.json()) as { rows: Ingested[]; next?: string };
  rows.push(...page.rows);
  next = page.next;
}
if (json) console.log(JSON.stringify({ subject, rows }));
else {
  for (const r of rows) console.log(`${r.offset}\t${r.ts}\t${r.stream}\t${r.kind ?? "-"}\t${r.op ?? "-"}\tv${r.v}`);
  console.log(`${rows.length} rows about ${subject}.`);
}
