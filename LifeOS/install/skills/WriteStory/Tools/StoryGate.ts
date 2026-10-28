#!/usr/bin/env bun
/**
 * StoryGate.ts — deterministic fiction voice gate.
 *
 * A draft is measured against bands taken from a corpus of human short fiction
 * (see BuildFictionCorpus.ts) rather than against a ban list. The bands say what
 * human story prose measures like; the gate fails a draft that drifts in the
 * machine direction on several axes at once, or carries a narrator's aside.
 *
 * Machine-direction axes (each one a mechanism, not a phrase):
 *   sent_len_mean HIGH, clauses_per_sentence HIGH, long_sentence_rate HIGH —
 *     clause-chained narration instead of sentences that stop;
 *   beat_rate HIGH — paragraphs that close on a short landing line;
 *   dialogue_para_rate LOW — summary instead of scene;
 *   universal_density HIGH — the narrator generalising over people;
 *   fragment_rate HIGH — stacked fragments for rhythm.
 *
 * Usage:
 *   bun StoryGate.ts --build --manifest <Corpus.md> --voice <VoiceProfile.json> --out <StoryProfile.json>
 *   bun StoryGate.ts <draft.md> [--profile <StoryProfile.json>] [--json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lifeosUserDir } from "../../../LIFEOS/TOOLS/LifeosConfig.ts";
import { parseManifest } from "./BuildVoiceProfile.ts";
import { measure, extractProse, splitSentences, type VoiceVector } from "./VoiceMetrics.ts";

export interface StoryVector extends VoiceVector {
  dialogue_para_rate: number; // % paragraphs carrying quoted speech
  beat_rate: number;          // % multi-sentence paragraphs ending on a short landing line
  universal_density: number;  // everyone/nobody/always/never … per 100 words
}

export type Band = { p10: number; p50: number; p90: number };
export interface StoryProfile {
  corpus: { manifest: string; documents: number; total_words: number };
  bands: Record<string, Band>;
  generated: string;
}

/** Axis → the direction that reads as machine prose. */
export const MACHINE_AXES: Record<string, "high" | "low"> = {
  sent_len_mean: "high",
  clauses_per_sentence: "high",
  long_sentence_rate: "high",
  beat_rate: "high",
  dialogue_para_rate: "low",
  universal_density: "high",
  fragment_rate: "high",
};
export const FAIL_AT = 2; // axes out of band in the machine direction

const UNIVERSAL = /\b(everyone|everybody|nobody|no one|no-one|anyone|anybody|always|never|every(?:thing|where)?|all of us|people)\b/gi;
const QUOTE = /[“"]/;
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

export function measureStory(raw: string, source = "inline"): StoryVector {
  const base = measure(raw, source);
  const prose = extractProse(raw);
  const paras = prose.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
  const dialogue = paras.filter((p) => QUOTE.test(p)).length;
  let multi = 0, beats = 0;
  for (const p of paras) {
    const s = splitSentences(p);
    if (s.length < 2) continue;
    multi++;
    const lens = s.map(words);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const last = lens[lens.length - 1];
    if (last <= 9 && last <= 0.6 * mean) beats++;
  }
  const w = words(prose) || 1;
  const uni = (prose.match(UNIVERSAL) ?? []).length;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    ...base,
    dialogue_para_rate: r2(paras.length ? (100 * dialogue) / paras.length : 0),
    beat_rate: r2(multi ? (100 * beats) / multi : 0),
    universal_density: r2((100 * uni) / w),
  };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return Math.round((s[lo] + (s[hi] - s[lo]) * (i - lo)) * 100) / 100;
};

export async function buildProfile(manifest: string, voiceProfile: string): Promise<StoryProfile> {
  const { root, slugs } = parseManifest(readFileSync(manifest, "utf8"));
  const vectors = slugs.map((s) => measureStory(readFileSync(`${root}/${s}.md`, "utf8"), s));
  const voice = JSON.parse(readFileSync(voiceProfile, "utf8"));
  const bands: Record<string, Band> = { ...voice.bands };
  for (const k of ["dialogue_para_rate", "beat_rate", "universal_density"] as const) {
    const xs = vectors.map((v) => v[k]);
    bands[k] = { p10: pct(xs, 0.1), p50: pct(xs, 0.5), p90: pct(xs, 0.9) };
  }
  return {
    corpus: { manifest, documents: vectors.length, total_words: vectors.reduce((a, v) => a + v.word_count, 0) },
    bands,
    generated: new Date().toISOString(),
  };
}

export interface GateFinding { metric: string; value: number; band: Band; direction: "high" | "low"; machine: boolean }
export interface GateResult { draft: string; word_count: number; passed: boolean; reasons: string[]; findings: GateFinding[]; aside_hits: number; vector: StoryVector }

export function gate(v: StoryVector, profile: StoryProfile): GateResult {
  const findings: GateFinding[] = [];
  for (const [metric, band] of Object.entries(profile.bands)) {
    const value = (v as unknown as Record<string, number>)[metric];
    if (typeof value !== "number") continue;
    if (value >= band.p10 && value <= band.p90) continue;
    const direction = value < band.p10 ? "low" : "high";
    findings.push({ metric, value, band, direction, machine: MACHINE_AXES[metric] === direction });
  }
  const aside_hits = v.banned_hits["narrator-aside"] ?? 0;
  const machine = findings.filter((f) => f.machine);
  const reasons: string[] = [];
  if (aside_hits) reasons.push(`narrator's aside ×${aside_hits} (a clause that leaves the character to speak for everyone)`);
  if (machine.length >= FAIL_AT) reasons.push(`${machine.length} axes drift toward machine prose: ${machine.map((f) => `${f.metric} ${f.direction} (${f.value} vs ${f.band.p10}–${f.band.p90})`).join(", ")}`);
  return { draft: v.source, word_count: v.word_count, passed: reasons.length === 0, reasons, findings, aside_hits, vector: v };
}

export function report(r: GateResult): string {
  const lines = [`${r.passed ? "PASS" : "FAIL"} ${r.draft} (${r.word_count}w)`];
  for (const reason of r.reasons) lines.push(`  ✗ ${reason}`);
  for (const f of r.findings.filter((x) => !x.machine)) lines.push(`  · ${f.metric} ${f.direction} (${f.value} vs ${f.band.p10}–${f.band.p90}) — outside the band, not in the machine direction`);
  return lines.join("\n");
}

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const expand = (p: string) => p.replace(/^~/, process.env.HOME ?? "");
export const DEFAULT_PROFILE = join(lifeosUserDir(), "CUSTOMIZATIONS", "SKILLS", "WriteStory", "Corpus", "StoryProfile.json");

if (import.meta.main) {
  if (process.argv.includes("--build")) {
    const manifest = expand(arg("--manifest") ?? ""), voice = expand(arg("--voice") ?? ""), out = expand(arg("--out") ?? DEFAULT_PROFILE);
    if (!manifest || !voice) { console.error("usage: StoryGate.ts --build --manifest <Corpus.md> --voice <VoiceProfile.json> [--out <StoryProfile.json>]"); process.exit(2); }
    const p = await buildProfile(manifest, voice);
    writeFileSync(out, JSON.stringify(p, null, 2) + "\n");
    console.log(`wrote ${out} — ${p.corpus.documents} docs, ${p.corpus.total_words} words`);
    for (const k of Object.keys(MACHINE_AXES)) console.log(`  ${k.padEnd(22)} ${JSON.stringify(p.bands[k])}`);
    process.exit(0);
  }
  const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--profile");
  if (!files.length) { console.error("usage: StoryGate.ts <draft.md> [--profile <StoryProfile.json>] [--json]"); process.exit(2); }
  const profilePath = expand(arg("--profile") ?? DEFAULT_PROFILE);
  let profile: StoryProfile;
  try { profile = JSON.parse(readFileSync(profilePath, "utf8")); }
  catch { console.error(`StoryGate: not configured — no profile at ${profilePath}. Build the corpus and voice-profile inputs described in WriteStory SKILL.md § Data & Config, then run StoryGate.ts --build.`); process.exit(2); }
  let failed = false;
  for (const f of files) {
    const r = gate(measureStory(readFileSync(expand(f), "utf8"), f), profile);
    if (!r.passed) failed = true;
    console.log(process.argv.includes("--json") ? JSON.stringify(r, null, 2) : report(r));
  }
  process.exit(failed ? 1 : 0);
}
