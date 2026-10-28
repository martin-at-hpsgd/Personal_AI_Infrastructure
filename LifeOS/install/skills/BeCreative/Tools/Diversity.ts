#!/usr/bin/env bun
/**
 * Diversity.ts - Deterministic near-duplicate gate and diversity index for SyntheticDataExpansion
 *
 * Similarity is TF-IDF cosine over word unigrams and bigrams of each example's
 * flattened leaf values (keys ignored), with IDF taken over every text in the call.
 * Offline and reproducible: the same inputs always give the same numbers.
 *
 * Usage:
 *   bun skills/BeCreative/Tools/Diversity.ts dedupe --accepted <file> --candidates <file> [--threshold 0.85]
 *   bun skills/BeCreative/Tools/Diversity.ts index <file> [<file>...]
 *
 * Files are a JSON array or JSONL. A record with an `example` field is read as that
 * example (generations.jsonl and turn output both work); anything else is the example.
 *
 * Commands:
 *   dedupe   One JSON line per candidate: {index, maxSimilarity, nearest, duplicate}.
 *            Each candidate is compared with every accepted example and every earlier
 *            non-duplicate candidate. duplicate = maxSimilarity > threshold. Exit 0.
 *   index    {n, meanPairwiseSimilarity, diversityIndex} per file, where
 *            diversityIndex = 1 - mean pairwise similarity (0 = all identical, 1 = no shared terms).
 *
 * @author LifeOS System
 * @version 1.0.0
 */

export const DEFAULT_THRESHOLD = 0.85;

type Vec = Map<string, number>;

function leaves(v: unknown, out: string[]): void {
  if (v == null) return;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out.push(String(v));
  else if (Array.isArray(v)) for (const x of v) leaves(x, out);
  else if (typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) leaves(x, out);
}

export function terms(example: unknown): string[] {
  const parts: string[] = [];
  leaves(example, parts);
  const words = parts.join(" ").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const bigrams = words.slice(1).map((w, i) => `${words[i]} ${w}`);
  return [...words, ...bigrams];
}

function vectorize(docs: string[][]): Vec[] {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v: Vec = new Map();
    for (const [t, c] of tf) v.set(t, c * (Math.log((1 + n) / (1 + (df.get(t) ?? 0))) + 1));
    return v;
  });
}

function cosine(a: Vec, b: Vec): number {
  let dot = 0, na = 0, nb = 0;
  for (const [t, x] of a) { na += x * x; const y = b.get(t); if (y) dot += x * y; }
  for (const y of b.values()) nb += y * y;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export type DedupeResult = { index: number; maxSimilarity: number; nearest: number | null; duplicate: boolean };

/** nearest indexes the accepted list first, then earlier kept candidates at accepted.length + candidate index. */
export function dedupe(accepted: unknown[], candidates: unknown[], threshold = DEFAULT_THRESHOLD): DedupeResult[] {
  const vecs = vectorize([...accepted, ...candidates].map(terms));
  const pool: number[] = accepted.map((_, i) => i);
  return candidates.map((_, ci) => {
    const me = vecs[accepted.length + ci];
    let maxSimilarity = 0, nearest: number | null = null;
    for (const p of pool) { const s = cosine(me, vecs[p]); if (s > maxSimilarity) { maxSimilarity = s; nearest = p; } }
    const duplicate = maxSimilarity > threshold;
    if (!duplicate) pool.push(accepted.length + ci);
    return { index: ci, maxSimilarity: Number(maxSimilarity.toFixed(4)), nearest, duplicate };
  });
}

export function diversityIndex(examples: unknown[]): { n: number; meanPairwiseSimilarity: number; diversityIndex: number } {
  const vecs = vectorize(examples.map(terms));
  let sum = 0, pairs = 0;
  for (let i = 0; i < vecs.length; i++) for (let j = i + 1; j < vecs.length; j++) { sum += cosine(vecs[i], vecs[j]); pairs++; }
  const mean = pairs ? sum / pairs : 0;
  return { n: examples.length, meanPairwiseSimilarity: Number(mean.toFixed(4)), diversityIndex: Number((1 - mean).toFixed(4)) };
}

export function parseRecords(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const rows: unknown[] = trimmed.startsWith("[") ? JSON.parse(trimmed) : trimmed.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  return rows.map((r) => (r && typeof r === "object" && !Array.isArray(r) && "example" in r ? (r as { example: unknown }).example : r));
}

const RED = "\x1b[31m", RESET = "\x1b[0m";
function fail(msg: string, code = 2): never { console.error(`${RED}Diversity: ${msg}${RESET}`); process.exit(code); }

async function load(path: string | undefined, flag: string): Promise<unknown[]> {
  if (!path) fail(`missing ${flag}`);
  const f = Bun.file(path);
  if (!(await f.exists())) fail(`no such file: ${path}`);
  try { return parseRecords(await f.text()); } catch (e) { fail(`cannot parse ${path}: ${(e as Error).message}`); }
}

if (import.meta.main) {
  const [cmd, ...rest] = Bun.argv.slice(2);
  const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(await Bun.file(new URL("./Diversity.help.md", import.meta.url)).text());
    process.exit(cmd ? 0 : 2);
  }
  if (cmd === "dedupe") {
    const threshold = flag("--threshold") === undefined ? DEFAULT_THRESHOLD : Number(flag("--threshold"));
    if (!(threshold > 0 && threshold <= 1)) fail("--threshold must be in (0, 1]");
    const accepted = await load(flag("--accepted"), "--accepted");
    const candidates = await load(flag("--candidates"), "--candidates");
    for (const r of dedupe(accepted, candidates, threshold)) console.log(JSON.stringify(r));
  } else if (cmd === "index") {
    if (!rest.length) fail("index needs at least one file");
    for (const p of rest) console.log(JSON.stringify({ file: p, ...diversityIndex(await load(p, "file")) }));
  } else fail(`unknown command: ${cmd}`);
}
