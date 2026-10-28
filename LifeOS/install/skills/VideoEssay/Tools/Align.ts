#!/usr/bin/env bun
import { join } from "node:path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { argValue, ensureDir, readJson, resolveRunDir, runPaths, writeJson, type Post, type Word } from "./Lib.ts";

const units = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const tens = "zero ten twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
function numberText(n: number): string {
  if (n < 20) return units[n];
  if (n < 100) return `${tens[Math.floor(n / 10)]} ${n % 10 ? numberText(n % 10) : ""}`;
  if (n < 1000) return `${units[Math.floor(n / 100)]} hundred ${n % 100 ? numberText(n % 100) : ""}`;
  if (n < 1000000) return `${numberText(Math.floor(n / 1000))} thousand ${n % 1000 ? numberText(n % 1000) : ""}`;
  return String(n);
}
export function alignmentTokens(text: string): string[] {
  return text.toLowerCase().replace(/[’‘]/g, "'").replace(/(?<=\d),(?=\d)/g, "").replace(/\b\d+(?:\.\d+)?\b/g, n => {
    const [whole, fraction] = n.split(".");
    return numberText(Number(whole)) + (fraction ? ` point ${fraction.split("").map(d => units[Number(d)]).join(" ")}` : "");
  }).replace(/'/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

export interface AlignmentResult { words: Word[]; total: number; coverage: number; unmatched: { p: string; i0: number; i1: number; text: string }[] }

/** Global edit alignment, including 1:2 and 2:1 token joins. Coverage counts exact normalized matches, never substitutions. */
export function alignWords(post: Post, spoken: Word[], total: number): AlignmentResult {
  const refs = post.paragraphs.flatMap(p => p.text.split(/\s+/).filter(Boolean).map((w, i) => ({ p: p.id, i, w })));
  const r = refs.flatMap((v, owner) => alignmentTokens(v.w).map(t => ({ t, owner })));
  const h = spoken.flatMap((v, owner) => alignmentTokens(v.w).map(t => ({ t, owner })));
  const width = h.length + 1;
  invariant((r.length + 1) * width <= 30000000, "alignment exceeds 30 million cells; split the input post");
  const cost = new Float64Array((r.length + 1) * width), step = new Uint8Array(cost.length);
  for (let i = 1; i <= r.length; i++) { cost[i * width] = i; step[i * width] = 1; }
  for (let j = 1; j <= h.length; j++) { cost[j] = j; step[j] = 2; }
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) {
    const k = i * width + j;
    cost[k] = cost[k - width - 1] + (r[i - 1].t === h[j - 1].t ? 0 : 1); step[k] = 3;
    const choose = (c: number, s: number) => { if (c < cost[k]) { cost[k] = c; step[k] = s; } };
    choose(cost[k - width] + 1, 1); choose(cost[k - 1] + 1, 2);
    if (j >= 2 && r[i - 1].t === h[j - 2].t + h[j - 1].t) choose(cost[k - width - 2], 4);
    if (i >= 2 && r[i - 2].t + r[i - 1].t === h[j - 1].t) choose(cost[k - 2 * width - 1], 5);
  }
  const words = spoken.map(w => ({ ...w }));
  const matchedAtoms = new Set<number>();
  let i = r.length, j = h.length;
  while (i || j) {
    const s = step[i * width + j];
    const di = s === 2 ? 0 : s === 5 ? 2 : 1, dj = s === 1 ? 0 : s === 4 ? 2 : 1;
    if (di && dj) {
      const exact = r.slice(i - di, i).map(x => x.t).join("") === h.slice(j - dj, j).map(x => x.t).join("");
      for (let a = i - di; a < i; a++) if (exact) matchedAtoms.add(a);
      const ref = refs[r[i - di].owner];
      for (let b = j - dj; b < j; b++) Object.assign(words[h[b].owner], { p: ref.p, i: ref.i });
    }
    i -= di; j -= dj;
  }
  const matched = new Set(refs.map((_, owner) => owner).filter(owner => {
    const atoms = r.map((t, k) => t.owner === owner ? k : -1).filter(k => k >= 0);
    return atoms.length > 0 && atoms.every(k => matchedAtoms.has(k));
  }));
  const unmatched: AlignmentResult["unmatched"] = [];
  refs.forEach((ref, n) => {
    if (matched.has(n)) return;
    const last = unmatched.at(-1);
    if (last?.p === ref.p && last.i1 + 1 === ref.i) { last.i1 = ref.i; last.text += ` ${ref.w}`; }
    else unmatched.push({ p: ref.p, i0: ref.i, i1: ref.i, text: ref.w });
  });
  return { words, total, coverage: matched.size / Math.max(1, refs.length), unmatched };
}

export function verifyAlignment(result: AlignmentResult): string[] {
  const problems: string[] = [];
  if (!result.words.length || !(result.total > 0)) problems.push("empty alignment");
  let last = 0;
  for (const [i, w] of result.words.entries()) {
    if (![w.s, w.e].every(Number.isFinite) || w.s < last - 0.001 || w.e < w.s || w.e > result.total + 0.001) problems.push(`word ${i}: non-monotonic or outside waveform`);
    last = w.e;
  }
  if (result.coverage < 0.95) problems.push(`coverage ${(100 * result.coverage).toFixed(2)}% below 95%`);
  return problems;
}

export async function align(runDir: string, model = "small.en"): Promise<AlignmentResult> {
  const paths = runPaths(runDir), post = readJson<Post>(join(paths.source, "post.json"));
  const out = ensureDir(join(paths.narration, "whisper"));
  invariant(post.paragraphs.length > 0, "cannot align an empty post");
  const probe = Bun.spawn(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", paths.narrationWav], { stdout: "pipe", stderr: "pipe" });
  const [duration, probeCode] = await Promise.all([new Response(probe.stdout).text(), probe.exited]);
  invariant(probeCode === 0 && Number(duration) > 0, "narration duration unavailable");
  const p = Bun.spawn(["whisper", paths.narrationWav, "--model", model, "--language", "en", "--word_timestamps", "True", "--output_format", "json", "--output_dir", out, "--fp16", "False", "--verbose", "False"], { stdout: "ignore", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  invariant(code === 0, `whisper failed: ${err.slice(-400)}`);
  const transcript = readJson<{ segments: { words: { word: string; start: number; end: number }[] }[] }>(join(out, "narration.json"));
  const words = transcript.segments.flatMap(s => s.words ?? []).map(w => ({ w: w.word.trim(), s: w.start, e: w.end }));
  const result = alignWords(post, words, Number(duration));
  writeJson(join(paths.narration, "words.json"), result);
  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2), run = argValue(args, "--run");
  invariant(run, "usage: Align.ts --run <slug> [--verify] [--model small.en]");
  const result = await align(resolveRunDir(run), argValue(args, "--model"));
  console.log(`Align coverage: ${(result.coverage * 100).toFixed(2)}%`);
  for (const s of result.unmatched) console.log(`unmatched ${s.p}[${s.i0}–${s.i1}]: ${s.text}`);
  if (args.includes("--verify")) { const problems = verifyAlignment(result); problems.forEach(p => console.error(p)); process.exit(problems.length ? 1 : 0); }
}
