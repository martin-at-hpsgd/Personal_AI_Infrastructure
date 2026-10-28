#!/usr/bin/env bun
/**
 * STATVS core erase — the client of the one erasure route (statvs-full-migration ISA, ISC-65).
 *
 *   bun LIFEOS/STATVS/core/tools/erase.ts --chain <chain> --seq <n> --groups data[,text] --reason <reason>
 *
 * Reasons: leaked-secret, customer-data, personal-data. Groups: data (the payload and its body object), text (app,
 * kind, severity, title, session, ref, and a v4 row's subject). Each group is cleared whole; the row keeps its hash
 * and its Merkle leaf.
 *
 * The control is the erase credential: {{PRINCIPAL_NAME}} holds it, and no writer, reader or agent is ever given it, because the
 * core takes any well-formed POST /erase that carries it. This tool adds a deliberate step and a record, not a
 * barrier: it runs only at a terminal, prints what it will erase, reads {{PRINCIPAL_NAME}}'s approval typed in his own words, and
 * the core keeps those words in the signed tombstone it writes before removing anything. The terminal check stops a
 * piped or scripted call by mistake; it cannot stop a process that allocates a pseudo-terminal, so the credential
 * stays out of every agent's environment. {{PRINCIPAL_NAME}} runs it from his prompt with `! bun ...`.
 *
 * Environment: STATVS_CORE_URL and STATVS_ERASE_TOKEN (the erase credential; only {{PRINCIPAL_NAME}} holds it).
 *
 * Exit codes: 0 erased (or already erased), 1 refused by the core, 2 bad arguments, no terminal, or not approved.
 */
import { createInterface } from "node:readline/promises";
import { ERASE_GROUPS, ERASE_REASONS, parseEraseRequest } from "../worker/src/erasure";

const args = process.argv.slice(2);
const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const fail = (msg: string, code = 2): never => { console.error(`erase: ${msg}`); process.exit(code); };

if (args.includes("--help") || args.includes("-h")) {
  console.log(`usage: erase.ts --chain <chain> --seq <n> --groups ${ERASE_GROUPS.join("[,")}] --reason <${ERASE_REASONS.join("|")}>`);
  process.exit(0);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) fail("an erasure needs {{PRINCIPAL_NAME}} at a terminal to approve it; run it from your own prompt with `! bun ...`");
const url = process.env.STATVS_CORE_URL;
const token = process.env.STATVS_ERASE_TOKEN;
if (!url || !token) fail("STATVS_CORE_URL and STATVS_ERASE_TOKEN must both be set");

const draft = { chain: val("--chain"), seq: Number(val("--seq")), groups: (val("--groups") ?? "").split(",").filter(Boolean), reason: val("--reason"), by: "principal", approval: "pending" };
const checked = parseEraseRequest(draft);
if (!checked.ok) fail(checked.error);

console.log("This permanently removes, from the cloud record:");
console.log(`  row      ${draft.chain}#${draft.seq}`);
console.log(`  groups   ${draft.groups.join(" + ")}`);
console.log(`  reason   ${draft.reason}`);
console.log("The row keeps its hash and place; a signed tombstone records this erasure and your words.");
const rl = createInterface({ input: process.stdin, output: process.stdout });
const approval = (await rl.question("Your approval, in your own words (empty to cancel): ")).trim();
rl.close();
if (approval.length === 0) fail("cancelled; nothing was erased");

const final = parseEraseRequest({ ...draft, approval });
const req = final.ok ? final.req : fail(final.error);
const res = await fetch(`${url!.replace(/\/$/, "")}/erase`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(req) });
const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string; tombstone?: { chain: string; seq: number; offset: number } };
if (!res.ok) fail(`the core refused (HTTP ${res.status}): ${body.error ?? "no reason given"}`, 1);
console.log(`${body.status === "already-erased" ? "Already erased" : "Erased"}; tombstone ${body.tombstone?.chain}#${body.tombstone?.seq} at offset ${body.tombstone?.offset}.`);
