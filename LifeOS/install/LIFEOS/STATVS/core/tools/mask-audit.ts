#!/usr/bin/env bun
/**
 * mask-audit — how often the masker fires on real Claude Code transcript lines (ISC-53).
 *
 * Samples N lines (default 1000) from ~/.claude/projects/**\/*.jsonl with a seeded generator, one line
 * per randomly chosen file so the sample spreads across sessions, runs mask() over each parsed line
 * and prints counts. For each masked line it prints only the class and JSON path. With --explain it
 * adds a shape descriptor per match (the key name, the length, a run-length skeleton such as
 * "A4 9 a12" and the character entropy) so a reviewer can tell a random credential from a word or an
 * id. No matched content, file path or line text is ever printed or written; matches live in memory.
 *
 * Usage: bun LIFEOS/STATVS/core/tools/mask-audit.ts [--sample 1000] [--seed 1] [--root <dir>] [--explain] [--json]
 *
 * @version 0.1.0
 */
import { join } from "node:path";
import { getClaudeDir } from "../../../TOOLS/Paths";
import { mask, type MaskMatch } from "../lib/mask";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1]! : dflt; };
const SAMPLE = Number(opt("sample", "1000"));
const SEED = Number(opt("seed", "1"));
const ROOT = opt("root", join(getClaudeDir(), "projects"));
const EXPLAIN = args.includes("--explain");
const JSON_OUT = args.includes("--json");
const WINDOW = 16 * 1024 * 1024;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A run-length character-class skeleton: upper A, lower a, digit 9, others as themselves. Reveals shape, not content. */
function skeleton(v: string): string {
  const cls = [...v].map((c) => (/[A-Z]/.test(c) ? "A" : /[a-z]/.test(c) ? "a" : /[0-9]/.test(c) ? "9" : c));
  const out: string[] = [];
  for (let i = 0; i < cls.length;) {
    let j = i;
    while (j < cls.length && cls[j] === cls[i]) j++;
    out.push(j - i > 1 ? `${cls[i]}${j - i}` : cls[i]!);
    i = j;
  }
  const s = out.join(" ");
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

function entropy(v: string): number {
  const counts = new Map<string, number>();
  for (const c of v) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / v.length; h -= p * Math.log2(p); }
  return Math.round(h * 100) / 100;
}

/** One random complete line from a file, or null when the window held none. */
async function randomLine(path: string, rand: () => number): Promise<string | null> {
  const f = Bun.file(path);
  const size = f.size;
  if (size === 0) return null;
  if (size <= WINDOW) {
    const lines = (await f.text()).split("\n").filter((l) => l.trim());
    return lines.length ? lines[Math.floor(rand() * lines.length)]! : null;
  }
  const off = Math.floor(rand() * (size - 1));
  const text = await f.slice(off, Math.min(size, off + WINDOW)).text();
  const a = off === 0 ? -1 : text.indexOf("\n");
  if (a < 0 && off !== 0) return null;
  const b = text.indexOf("\n", a + 1);
  if (b < 0) return null;
  const line = text.slice(a + 1, b);
  return line.trim() ? line : null;
}

async function main() {
  const files: string[] = [];
  for await (const p of new Bun.Glob("**/*.jsonl").scan({ cwd: ROOT, onlyFiles: true, followSymlinks: false })) files.push(p);
  files.sort();
  if (!files.length) { console.error(`no transcripts under ${ROOT}`); process.exit(1); }
  const rand = rng(SEED);
  const key = crypto.getRandomValues(new Uint8Array(32)); // ephemeral: nothing masked here is kept
  const order = files.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const k = Math.floor(rand() * (i + 1)); [order[i], order[k]] = [order[k]!, order[i]!]; }

  const counts = { files: files.length, sampled: 0, parsed: 0, unparsed: 0, skipped: 0, maskedLines: 0, matches: 0 };
  const byClass: Record<string, number> = {};
  const flagged: { sample: number; matches: { cls: string; path: string; name?: string; len?: number; shape?: string; entropy?: number }[] }[] = [];
  let cursor = 0;
  while (counts.sampled < SAMPLE && cursor < order.length * 4) {
    const path = join(ROOT, files[order[cursor % order.length]!]!);
    cursor++;
    let line: string | null = null;
    try { line = await randomLine(path, rand); } catch { line = null; }
    if (!line) { counts.skipped++; continue; }
    counts.sampled++;
    let value: unknown;
    try { value = JSON.parse(line); counts.parsed++; } catch { value = line; counts.unparsed++; }
    const seen: MaskMatch[] = [];
    const out = await mask(value, key, { onMatch: (m) => seen.push(m) });
    if (!out.masked.length) continue;
    counts.maskedLines++;
    counts.matches += seen.length;
    for (const m of seen) byClass[m.cls] = (byClass[m.cls] ?? 0) + 1;
    flagged.push({
      sample: counts.sampled,
      matches: seen.map((m) => ({ cls: m.cls, path: m.path, ...(EXPLAIN ? { name: m.name, len: m.value.length, shape: skeleton(m.value), entropy: entropy(m.value) } : {}) })),
    });
  }

  if (JSON_OUT) { console.log(JSON.stringify({ root: "~/.claude/projects", seed: SEED, counts, byClass, flagged }, null, 2)); return; }
  console.log(`mask-audit  seed ${SEED}  files ${counts.files}  sampled ${counts.sampled}  parsed ${counts.parsed}  unparsed ${counts.unparsed}  skipped ${counts.skipped}`);
  console.log(`masked lines ${counts.maskedLines}  matches ${counts.matches}`);
  for (const [cls, n] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) console.log(`  ${cls.padEnd(20)} ${n}`);
  for (const f of flagged) {
    for (const m of f.matches) {
      const extra = EXPLAIN ? `  name=${m.name ?? "-"} len=${m.len} H=${m.entropy} shape=${m.shape}` : "";
      console.log(`#${f.sample}  ${m.cls}  ${m.path}${extra}`);
    }
  }
}

await main();
