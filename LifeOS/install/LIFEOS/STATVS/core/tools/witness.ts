#!/usr/bin/env bun
/**
 * STATVS core witness — keeps the record's signed checkpoints outside Cloudflare (statvs-full-migration ISA, ISC-166).
 *
 * Fetches the live checkpoint, verifies its signature with the verifier key in the USER repo, and when an earlier
 * checkpoint was witnessed, verifies the consistency proof between the two: the new tree extends the old one and
 * nothing already witnessed was rewritten, reordered or dropped. A checkpoint that passes is appended to
 * USER/STATVS/witness/checkpoints.jsonl and committed to the USER git repo, so every day's root also lives in git.
 * A smaller tree than the last one witnessed, a bad signature or a failed proof stops with exit 1 and appends nothing.
 *
 * With --verify-only it runs every check and records nothing: no line, no commit. It is the before-and-after check of
 * a schema migration (CENSVS ISA ISC-26): the live tree still verifies and still extends the last witnessed one.
 *
 * Usage: bun LIFEOS/STATVS/core/tools/witness.ts [--json] [--no-commit] [--verify-only]
 * Environment: STATVS_CORE_URL and STATVS_CORE_READ_TOKEN; when either is unset, both come from the sealed core secrets.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { lifeosPath } from "../../../TOOLS/Paths";
import { openSealedFile } from "../../../TOOLS/Secrets";
import { verifyCheckpoint, verifyCheckpointPair } from "../lib/checkpoint";
import { toHex } from "../lib/merkle";

const ORIGIN = "lifeos-statvs-core/main";
const args = process.argv.slice(2);
const json = args.includes("--json");
const fail = (reason: string): never => {
  if (json) console.log(JSON.stringify({ ok: false, reason }));
  else console.error(`witness: ${reason}`);
  process.exit(1);
};

let url = process.env.STATVS_CORE_URL, token = process.env.STATVS_CORE_READ_TOKEN;
if (!url || !token) {
  const s = JSON.parse(new TextDecoder().decode(openSealedFile(lifeosPath("USER", "STATVS", "core-secrets.json.age")))) as Record<string, string>;
  url = s.STATVS_CORE_URL; token = s.STATVS_CORE_READ_TOKEN;
}
const verifier = readFileSync(lifeosPath("USER", "STATVS", "core-verifier.txt"), "utf8").trim();
const file = lifeosPath("USER", "STATVS", "witness", "checkpoints.jsonl");
const get = async (p: string) => {
  const res = await fetch(`${url!.replace(/\/$/, "")}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) fail(`GET ${p} answered HTTP ${res.status}`);
  return res;
};

type Witnessed = { at: string; size: number; root: string; note: string };
const note = await (await get("/checkpoint")).text();
const cp = await verifyCheckpoint(note, [verifier], ORIGIN);
if (!cp.ok) fail(`the live checkpoint does not verify: ${cp.reason}`);
const size = (cp as { ok: true; checkpoint: { size: number; root: Uint8Array } }).checkpoint.size;
const root = toHex((cp as { ok: true; checkpoint: { size: number; root: Uint8Array } }).checkpoint.root);

const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
const last = lines.length > 0 ? (JSON.parse(lines[lines.length - 1]!) as Witnessed) : null;
if (last) {
  if (size < last.size) fail(`the live tree has ${size} rows, fewer than the ${last.size} witnessed on ${last.at}`);
  if (size === last.size) {
    if (root !== last.root) fail(`the live root at size ${size} differs from the one witnessed on ${last.at}`);
    if (json) console.log(JSON.stringify({ ok: true, size, root, unchanged: true }));
    else console.log(`Witness: unchanged at ${size} rows since ${last.at}.`);
    process.exit(0);
  }
  const { proof } = (await (await get(`/proof/consistency?first=${last.size}&second=${size}`)).json()) as { proof: string[] };
  const pair = await verifyCheckpointPair(last.note, note, proof, [verifier]);
  if (!pair.ok) fail(`the live tree does not extend the one witnessed on ${last.at}: ${pair.reason}`);
}

if (args.includes("--verify-only")) {
  if (json) console.log(JSON.stringify({ ok: true, size, root, previous: last?.size ?? null, recorded: false }));
  else console.log(`Witness: checkpoint ${size} ${root.slice(0, 12)} verified${last ? `, extends ${last.size}` : ", nothing witnessed yet"}; verify only, nothing recorded.`);
  process.exit(0);
}

const entry: Witnessed = { at: new Date().toISOString(), size, root, note };
mkdirSync(dirname(file), { recursive: true });
appendFileSync(file, JSON.stringify(entry) + "\n");
if (!args.includes("--no-commit")) {
  const rel = file.slice(file.indexOf("/STATVS/") + 1);
  const r = Bun.spawnSync(["bun", lifeosPath("TOOLS", "CommitOwn.ts"), "-m", `STATVS witness: checkpoint ${size} ${root.slice(0, 12)}`, "--", rel], { cwd: lifeosPath("USER") });
  if (r.exitCode !== 0) fail(`the witness line was written but not committed: ${new TextDecoder().decode(r.stderr).trim() || new TextDecoder().decode(r.stdout).trim()}`);
}
if (json) console.log(JSON.stringify({ ok: true, size, root, previous: last?.size ?? null }));
else console.log(`Witness: checkpoint ${size} ${root.slice(0, 12)} verified${last ? `, extends ${last.size}` : ", first witnessed"}, committed.`);
