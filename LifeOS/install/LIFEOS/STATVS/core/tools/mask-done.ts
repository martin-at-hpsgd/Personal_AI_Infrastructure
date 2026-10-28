#!/usr/bin/env bun
/**
 * mask-done — the measured rule for "the masker is done" (statvs-full-migration ISA, ISC-165).
 *
 * Masks every row of the local v1 record (title, ref, data, objects included) and a seeded sample of Claude Code
 * transcript lines with this machine's own secret list, then counts two failures: a masked value that scan() still
 * calls a secret (the intake would refuse it), and any own secret value still present in the masked output. The
 * masker is done when both counts are 0. Only counts and class names are printed; no value, path or line text is.
 *
 * Usage: bun LIFEOS/STATVS/core/tools/mask-done.ts [--sample 2000] [--seed 1] [--json]
 * Exit codes: 0 both counts 0, 1 a failure was found, 2 the own secrets could not be read or nothing was inspected.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getClaudeDir, lifeosPath } from "../../../TOOLS/Paths";
import { statvsDir } from "../../lib/record";
import { openSealedFile } from "../../../TOOLS/Secrets";
import { EXACT_MIN, mask, scan } from "../lib/mask";

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1]! : d; };
const SAMPLE = Number(opt("sample", "2000"));
const SEED = Number(opt("seed", "1"));
const KEY = "mask-done-probe-key";

function ownSecrets(): string[] {
  const values = new Set<string>();
  for (const line of new TextDecoder().decode(openSealedFile(lifeosPath("..", ".env.age"))).split("\n")) {
    const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !m[1]!.startsWith("#")) { const v = m[1]!.replace(/^(["'])(.*)\1$/, "$2"); if (v) values.add(v); }
  }
  const core = JSON.parse(new TextDecoder().decode(openSealedFile(lifeosPath("USER", "STATVS", "core-secrets.json.age")))) as Record<string, unknown>;
  for (const v of Object.values(core)) if (typeof v === "string" && v) values.add(v);
  return [...values];
}
let own: string[];
try { own = ownSecrets(); } catch (e) { console.error(`mask-done: cannot read own secrets: ${(e as Error).message}`); process.exit(2); }
const needles = own.filter((s) => s.length >= EXACT_MIN);

const tally = { rows: 0, lines: 0, dirty: 0, ownLeft: 0, classes: {} as Record<string, number> };
async function check(value: unknown): Promise<void> {
  const out = await mask(value, KEY, { exact: needles });
  const left = scan(out.value);
  if (left.length > 0) { tally.dirty++; for (const f of left) tally.classes[f.cls] = (tally.classes[f.cls] ?? 0) + 1; }
  const text = JSON.stringify(out.value) ?? "";
  if (needles.some((n) => text.includes(n))) tally.ownLeft++;
}

// The whole local record.
// The configured record (STATVS_DIR, else the install's own), the same one the shipper reads.
const record = statvsDir();
const objectOf = (sha: string) => { try { return JSON.parse(readFileSync(join(record, "objects", sha.slice(0, 2), `${sha}.json`), "utf8")); } catch { return undefined; } };
for (const cls of ["public", "system", "personal"]) {
  const root = join(record, cls);
  if (!existsSync(root)) continue;
  for (const day of readdirSync(root)) {
    const d = join(root, day);
    if (!statSync(d).isDirectory()) continue;
    for (const f of readdirSync(d).filter((n) => n.endsWith(".jsonl"))) {
      for (const line of readFileSync(join(d, f), "utf8").split("\n")) {
        if (!line) continue;
        let r: Record<string, unknown>;
        try { r = JSON.parse(line); } catch { continue; }
        tally.rows++;
        if (tally.rows % 2000 === 0) console.error(`mask-done: ${tally.rows} record rows`);
        await check({ title: r.title, ref: r.ref, data: typeof r.obj === "string" ? objectOf(r.obj) : r.data });
      }
    }
  }
}

// A seeded sample of transcript lines, one line per randomly chosen file.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const files: string[] = [];
const projects = join(getClaudeDir(), "projects");
const walkDir = (dir: string) => { for (const n of readdirSync(dir)) { const p = join(dir, n); const st = statSync(p); if (st.isDirectory()) walkDir(p); else if (n.endsWith(".jsonl") && st.size > 0) files.push(p); } };
if (existsSync(projects)) walkDir(projects);
files.sort();
const rand = rng(SEED);
// Read a window at a random offset, never a whole file: some transcripts run to hundreds of megabytes.
const WINDOW = 4 * 1024 * 1024;
for (let i = 0; i < SAMPLE && files.length > 0; i++) {
  const file = files[Math.floor(rand() * files.length)]!;
  const size = statSync(file).size;
  const start = size > WINDOW ? Math.floor(rand() * (size - WINDOW)) : 0;
  const fh = Bun.file(file).slice(start, start + WINDOW);
  const chunk = await fh.text();
  const lines = chunk.split("\n");
  const pick = lines.slice(start > 0 ? 1 : 0, -1).filter(Boolean); // whole lines only
  if (pick.length === 0) continue;
  let v: unknown;
  try { v = JSON.parse(pick[Math.floor(rand() * pick.length)]!); } catch { continue; }
  tally.lines++;
  await check(v);
}

// Zero rows inspected is "not measured", never "done": a missing or misconfigured record must not read as a clean masker.
if (tally.rows + tally.lines === 0) {
  console.error(`mask-done: nothing was inspected (no record rows under the configured record, no transcript lines); the masker is not measured.`);
  process.exit(2);
}
const done = tally.dirty === 0 && tally.ownLeft === 0;
if (args.includes("--json")) console.log(JSON.stringify({ ...tally, own_secrets: needles.length, done }));
else console.log(`${done ? "Masker done" : "Masker not done"}: ${tally.rows} record rows and ${tally.lines} transcript lines; ${tally.dirty} still scan as a secret, ${tally.ownLeft} still hold an own secret (${needles.length} own secrets checked)${tally.dirty ? `; classes ${JSON.stringify(tally.classes)}` : ""}`);
process.exit(done ? 0 : 1);
