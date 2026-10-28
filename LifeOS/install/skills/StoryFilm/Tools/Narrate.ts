#!/usr/bin/env bun
/**
 * Narrate.ts — per-beat narration in the story's voice, with word timings.
 *
 *   bun Narrate.ts --run <slug|dir> [--force] [--verify] [--voice <id|role>]
 *
 * Every beat is synthesized through Fish Audio Drama 3 with timestamps (FishTTS.ts), cached by content hash,
 * decoded to wav, laid out with a fixed gap between beats and a longer one at scene breaks, concatenated,
 * loudness-normalized, and written as Narration/narration.wav plus Narration/timeline.json with offsets
 * measured from the real chunk durations. Narration reads only Beats.json and run.json, so it can start right after
 * Intake; `Narration/.narrate.lock` makes a second narrator on the same run wait for the first.
 *
 * Voice: `--voice`, else the story's `audio_voice` frontmatter (run.json), else the DA's main voice. The value is
 * a Fish role name (main, presenter, principal), `fish:<reference id>`, or a voice id that fishVoiceFor()
 * maps to a Fish voice (the voice_id of any [da.voices.*] profile in LIFEOS_CONFIG.toml that has a fish_reference_id,
 * the principal's ELEVENLABS_PRINCIPAL_VOICE_ID); any other id fails loud. Key: FISH_API_KEY. Drama 3 tags in a beat ([sigh], <emphasis>…</emphasis>) pass through to
 * the voice and are left out when the returned words are matched to the beat's tokens.
 * Pace: the DA's voice reads at [da.voices.main] fish_speed, the same pace it speaks everywhere (principal, 2026-10-24);
 * any other voice reads at natural pace (1.0). The speed is sent on every request and is part of each chunk's hash.
 * Length: a request carries at most FISH_CHUNK_LIMIT characters; a longer beat splits on sentence boundaries and each
 * chunk's word times are offset by the audio already produced.
 * Timings: Fish returns word spans; they are matched to the beat's own tokens (punctuation kept), and the cached
 * `.align.json` spreads each word's span across its characters.
 */
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadLifeosConfig, type LifeosVoiceSettings } from "../../../LIFEOS/TOOLS/LifeosConfig.ts";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { fishSpeakWithTimestamps, type FishVoice, type TimedWord } from "../../../LIFEOS/TOOLS/FishTTS.ts";
import { pronounce, pronunciationMap } from "../../../LIFEOS/TOOLS/Pronounce.ts";
import { PAIRED_TAGS, stripVoiceTags } from "../../../LIFEOS/TOOLS/VoiceTags.ts";
import { BEAT_GAP_SECONDS, END_SECONDS, FPS, SCENE_GAP_SECONDS, TARGET_LUFS, TITLE_SECONDS, argValue, ensureDir, hasFlag, loadBeats, loadRun, probeDuration, readJson, resolveRunDir, runPaths, sh, sha256, withFileLock, writeJson, type Beats, type Timeline, type TimelineBeat, type Word } from "./Lib.ts";
import { envValue } from "./Paint.ts";
import { CROSS_VENDOR } from "../../../LIFEOS/TOOLS/models";

export const TTS_MODEL = CROSS_VENDOR.fishVoice;
/** Characters one Fish request carries. A longer beat splits on sentence boundaries (fishChunks). */
export const FISH_CHUNK_LIMIT = 2_500;
export interface Alignment { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }
/** `voice_id` selects the Fish voice (fishVoiceFor); `speed` is the Fish prosody speed. */
export interface Voice { voice_id: string; speed?: number }
export type Synthesizer = (req: { text: string; previous_text?: string; next_text?: string; voice: Voice }) => Promise<{ audio: Buffer; alignment: Alignment }>;

/** The read's pace: the DA's own voice speaks at its configured fish_speed, like everywhere else; any other voice reads at natural pace. */
export function storyVoice(voiceId: string, voices: Record<string, LifeosVoiceSettings | undefined> = loadLifeosConfig().da.voices): Voice {
  const isDa = voiceId === "main" || voiceId === "presenter" || (!!voices.main?.voiceId && voices.main.voiceId === voiceId);
  return { voice_id: voiceId, speed: isDa ? (voices.main?.fishSpeed ?? 1) : 1 };
}

export function resolveVoiceId(runVoice: string | undefined, flag: string | undefined): string {
  if (flag) return flag;
  if (runVoice) return runVoice;
  const v = loadLifeosConfig().da.voices.main;
  invariant(v?.voiceId, "no voice: the story has no audio_voice and no DA main voice is configured");
  return v.voiceId;
}

function optionalEnv(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  try { return envValue(key); } catch { return undefined; }
}

/**
 * The Fish voice for a story's voice value: a role name, `fish:<reference id>`, the principal's clone when it is
 * ELEVENLABS_PRINCIPAL_VOICE_ID, else the [da.voices.*] profile that carries that id and a fish_reference_id:
 * [da.voices.main] first (the DA's own voice, returned as the "main" role so its fish_speed applies), then any other
 * profile, whose reference id is used directly. A legacy "presenter" value is the DA's voice too. Any other id throws,
 * naming where to configure it.
 */
export function fishVoiceFor(voiceId: string, voices: Record<string, LifeosVoiceSettings | undefined> = loadLifeosConfig().da.voices, principalId: string | undefined = optionalEnv("ELEVENLABS_PRINCIPAL_VOICE_ID")): FishVoice {
  if (voiceId === "main" || voiceId === "presenter") return "main";
  if (voiceId === "principal") return voiceId;
  if (voiceId.startsWith("fish:") && voiceId.length > 5) return { referenceId: voiceId.slice(5) };
  if (principalId && voiceId === principalId) return "principal";
  if (voices.main?.voiceId === voiceId && voices.main.fishReferenceId) return "main";
  for (const [name, v] of Object.entries(voices)) {
    if (name !== "main" && v?.voiceId === voiceId && v.fishReferenceId) return { referenceId: v.fishReferenceId };
  }
  throw new Error(`Narrate: voice "${voiceId}" has no Fish voice. Use main, principal or fish:<reference id>, or add a fish_reference_id for it to a [da.voices.*] profile in LIFEOS_CONFIG.toml.`);
}

// ---------- Fish: words matched to the script, chunks ----------

/** What a word sounds like once punctuation, case and spacing are gone: Fish returns "well","known" for "well-known". */
const sounds = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const TAG_NAMES: ReadonlySet<string> = new Set(PAIRED_TAGS);
const PAIRED_TAG_RE = new RegExp(`</?(${PAIRED_TAGS.join("|")})>`, "g");
const MARK = "\u0001";
type ScriptUnit = { tag: string } | { word: string };

/**
 * The text as Fish speaks it: whitespace tokens with [directions] removed (Fish times no word for them) and each paired
 * tag kept as its own unit, because Fish times the tag's name as a word (`<emphasis>Every</emphasis>` comes back as
 * "emphasis", "Every", "emphasis"). Punctuation stays on the token it touches.
 */
export function scriptUnits(text: string): ScriptUnit[] {
  const units: ScriptUnit[] = [];
  for (const raw of stripVoiceTags(text.replace(PAIRED_TAG_RE, (_m, name: string) => `${MARK}${name}${MARK}`)).split(/\s+/).filter(Boolean)) {
    const before: ScriptUnit[] = [], after: ScriptUnit[] = [];
    let word = "";
    raw.split(new RegExp(`${MARK}(\\w+)${MARK}`)).forEach((part, i) => {
      if (i % 2 === 1) (word ? after : before).push({ tag: part });
      else word += part;
    });
    units.push(...before, ...(word ? [{ word }] : []), ...after);
  }
  return units;
}

/**
 * Match Fish's word spans to the text's tokens, one {w, s, e} per token. The token keeps its punctuation; its span runs
 * from its first piece's start to its last piece's end. A token with no sound ("—") gets a zero-width span where the last
 * word ended. Throws when the words Fish returned do not spell the text, naming the token.
 */
export function reconcileWords(script: string, fish: TimedWord[]): Word[] {
  const out: Word[] = [];
  let j = 0;
  let cursor = fish[0]?.start ?? 0;
  for (const unit of scriptUnits(script)) {
    if ("tag" in unit) {
      if (j < fish.length && sounds(fish[j].text) === unit.tag) { cursor = fish[j].end; j++; }
      continue;
    }
    const want = sounds(unit.word);
    if (!want) { out.push({ w: unit.word, s: cursor, e: cursor }); continue; }
    let got = "", s = -1, e = 0;
    while (got.length < want.length) {
      if (j >= fish.length) throw new Error(`Fish returned no timing for "${unit.word}" and the words after it`);
      const p = sounds(fish[j].text);
      if (!got && TAG_NAMES.has(p) && !want.startsWith(p)) { j++; continue; } // a tag name Fish timed that the text does not carry
      if (!want.startsWith(got + p)) throw new Error(`Fish word "${fish[j].text}" does not match the token "${unit.word}"`);
      if (p) { if (s < 0) s = fish[j].start; e = fish[j].end; got += p; }
      j++;
    }
    out.push({ w: unit.word, s, e });
    cursor = e;
  }
  return out;
}

/** Sentences, each with the whitespace after it; a stop only ends a sentence when whitespace or the end follows ("3.5" stays whole). */
const SENTENCE_RE = /.+?(?:[.!?…]+["'”’)\]]*(?=\s|$)\s*|$)/gs;

/** Split text into requests of at most `limit` characters on sentence boundaries; a sentence over the limit splits at a space. */
export function fishChunks(text: string, limit = FISH_CHUNK_LIMIT): string[] {
  invariant(Number.isInteger(limit) && limit > 0, "the chunk limit must be a positive integer");
  const pieces: string[] = [];
  for (const sentence of text.match(SENTENCE_RE) ?? []) {
    let rest = sentence;
    while (rest.length > limit) {
      const space = rest.lastIndexOf(" ", limit);
      const at = space > 0 ? space : limit;
      pieces.push(rest.slice(0, at));
      rest = rest.slice(at);
    }
    pieces.push(rest);
  }
  const chunks: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (cur && cur.length + p.length > limit) { if (cur.trim()) chunks.push(cur.trim()); cur = ""; }
    cur += p;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

/** Character-level alignment from word spans: each word's span is spread evenly across its characters, a space spans the gap to the next word. */
export function wordsToAlignment(words: Word[]): Alignment {
  const a: Alignment = { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] };
  words.forEach((w, i) => {
    if (i > 0) {
      a.characters.push(" ");
      a.character_start_times_seconds.push(words[i - 1].e);
      a.character_end_times_seconds.push(Math.max(words[i - 1].e, w.s));
    }
    const chars = Array.from(w.w);
    chars.forEach((c, k) => {
      a.characters.push(c);
      a.character_start_times_seconds.push(w.s + ((w.e - w.s) * k) / chars.length);
      a.character_end_times_seconds.push(w.s + ((w.e - w.s) * (k + 1)) / chars.length);
    });
  });
  return a;
}

export interface FishScriptOptions { voice: FishVoice; speed?: number; limit?: number; apiKey?: string; fetch?: typeof fetch }

/**
 * Speak text through Fish Drama 3 and return the audio with one timed word per token. Text over the chunk limit is
 * spoken as several requests; each chunk's word times are offset by the audio duration already produced, so the words
 * sit on the concatenated audio's timeline.
 */
export async function fishSpeakScript(text: string, o: FishScriptOptions): Promise<{ audio: Buffer; words: Word[]; durationSec: number }> {
  const chunks = fishChunks(text, o.limit);
  invariant(chunks.length > 0, "fishSpeakScript needs text to speak");
  const audio: Uint8Array[] = [];
  const words: Word[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    const r = await fishSpeakWithTimestamps(chunk, { voice: o.voice, speed: o.speed, apiKey: o.apiKey, fetch: o.fetch, timeoutMs: 120_000 + 50 * chunk.length, pronunciations: false });
    for (const w of reconcileWords(chunk, r.words)) words.push({ w: w.w, s: w.s + offset, e: w.e + offset });
    audio.push(r.audio);
    offset += r.durationSec;
  }
  return { audio: Buffer.concat(audio), words, durationSec: offset };
}

// The one LifeOS pronunciation pass (LIFEOS/TOOLS/Pronounce.ts, Fish voice ISA F7). Narration runs it itself, before
// hashing, because the spoken text is the alignment and cache key; fishSpeakScript then tells Fish not to run it again.
/** The principal's rules with this run's pronunciations file on top. */
export function loadPronunciations(dir: string): Record<string, string> {
  return pronunciationMap(runPaths(dir).pronunciations);
}
/** What the narrator says for this text: homographs, then the overrides. */
export const applyPronunciations = pronounce;

export function alignmentToWords(a: Alignment): Word[] {
  const words: Word[] = [];
  let cur = "", start = 0, end = 0;
  for (let i = 0; i < a.characters.length; i++) {
    const ch = a.characters[i];
    if (/\s/.test(ch)) { if (cur) words.push({ w: cur, s: start, e: end }); cur = ""; continue; }
    if (!cur) start = a.character_start_times_seconds[i];
    cur += ch;
    end = a.character_end_times_seconds[i];
  }
  if (cur) words.push({ w: cur, s: start, e: end });
  const last = words[words.length - 1];
  if (last && last.e - last.s > 1.2) last.e = last.s + 0.6; // the last character absorbs trailing silence
  return words;
}

/** The engine is in the hash: a chunk made by another engine is never reused. */
export function chunkHash(spoken: string, voice: Voice): string { return sha256(JSON.stringify({ spoken, voice, engine: `fish:${TTS_MODEL}` })).slice(0, 12); }

export interface Laid { id: string; scene: number; wav: string; words: Word[]; duration: number }
/** Beats laid out in time: title lead, gap between beats, a longer gap where the scene changes, an end tail. */
export function buildTimeline(laid: Laid[], opts: { gap?: number; sceneGap?: number; lead?: number; tail?: number } = {}): Timeline {
  const gap = opts.gap ?? BEAT_GAP_SECONDS, sceneGap = opts.sceneGap ?? SCENE_GAP_SECONDS, lead = opts.lead ?? TITLE_SECONDS, tail = opts.tail ?? END_SECONDS;
  let t = lead;
  const beats: TimelineBeat[] = [];
  laid.forEach((p, i) => {
    if (i > 0) t += laid[i - 1].scene !== p.scene ? sceneGap : gap;
    beats.push({ id: p.id, scene: p.scene, start: t, end: t + p.duration, chunk: p.wav, words: p.words.map((w) => ({ w: w.w, s: w.s + t, e: w.e + t })) });
    t += p.duration;
  });
  return { fps: FPS, gap, sceneGap, lead, tail, total: t + tail, narration: "narration.wav", beats };
}

/** Fish Drama 3 as a Synthesizer. Neighbour text is ignored: Fish has no request stitching. */
export const fishSynthesizer: Synthesizer = async (req) => {
  const voice = fishVoiceFor(req.voice.voice_id);
  if (voice === "principal") process.env.FISH_PRINCIPAL_VOICE_ID ??= envValue("FISH_PRINCIPAL_VOICE_ID");
  const { audio, words } = await fishSpeakScript(req.text, { voice, speed: req.voice.speed ?? 1, apiKey: process.env.FISH_API_KEY ?? envValue("FISH_API_KEY") });
  return { audio, alignment: wordsToAlignment(words) };
};

async function silence(path: string, seconds: number): Promise<void> {
  if (!existsSync(path)) await sh(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", String(seconds), "-c:a", "pcm_s16le", path]);
}

/** Concatenate chunks with the timeline's silences, then two-pass loudnorm to the delivery target. */
async function assemble(tl: Timeline, narrationDir: string, outWav: string): Promise<void> {
  const sil = async (s: number) => { const p = join(narrationDir, `silence.${s}.wav`); await silence(p, s); return p; };
  const lines: string[] = [`file '${await sil(tl.lead)}'`];
  for (let i = 0; i < tl.beats.length; i++) {
    if (i > 0) lines.push(`file '${await sil(tl.beats[i - 1].scene !== tl.beats[i].scene ? tl.sceneGap : tl.gap)}'`);
    lines.push(`file '${tl.beats[i].chunk}'`);
  }
  lines.push(`file '${await sil(tl.tail)}'`);
  const list = join(narrationDir, "concat.txt");
  writeFileSync(list, lines.join("\n") + "\n");
  const raw = join(narrationDir, "narration.raw.wav");
  await sh(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c:a", "pcm_s16le", raw]);
  const measure = Bun.spawn(["ffmpeg", "-v", "info", "-i", raw, "-af", `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11:print_format=json`, "-f", "null", "-"], { stderr: "pipe", stdout: "pipe" });
  await measure.exited;
  const m = (await new Response(measure.stderr).text()).match(/\{[\s\S]*"input_i"[\s\S]*?\}/);
  invariant(m, "loudnorm measurement produced no JSON");
  const s = JSON.parse(m[0]) as Record<string, string>;
  await sh(["ffmpeg", "-y", "-v", "error", "-i", raw, "-af", `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11:measured_I=${s.input_i}:measured_TP=${s.input_tp}:measured_LRA=${s.input_lra}:measured_thresh=${s.input_thresh}:offset=${s.target_offset}:linear=true`, "-ar", "44100", "-c:a", "pcm_s16le", outWav]);
}

export type NarrateOptions = { force?: boolean; voice?: string; synthesizer?: Synthesizer; log?: (s: string) => void };

/** The lock every reader and writer of a run's Narration/ holds. */
function narrationLock(dir: string): string { return join(runPaths(dir).narration, ".narrate.lock"); }

/**
 * Narrates the run under `Narration/.narrate.lock`. Full starts narration right after Intake, while the storyboard is
 * still being written, and Run.ts's narrate leg can start before that early pass finishes; the second narrator waits
 * for the first, so no file is written by both. Without `--force` the second then finds the first's chunks cached and
 * synthesizes only beats that are missing (none, when the first finished); with `--force` it re-takes every beat.
 */
export async function narrate(dir: string, opts: NarrateOptions = {}): Promise<Timeline> {
  ensureDir(runPaths(dir).narration);
  return withFileLock(narrationLock(dir), () => narrateHoldingLock(dir, opts), { log: opts.log });
}

/**
 * Run.ts's narrate leg: narrates, then verifies the result, in one hold of the lock, so no second narrator can rewrite
 * a chunk or narration.wav while it is being checked. Fails loud when verification fails.
 */
export async function narrateAndVerify(dir: string, opts: NarrateOptions = {}): Promise<Timeline> {
  const log = opts.log ?? ((s) => console.log(s));
  ensureDir(runPaths(dir).narration);
  return withFileLock(narrationLock(dir), async () => {
    const tl = await narrateHoldingLock(dir, opts);
    const r = await verifyHoldingLock(dir);
    invariant(r.ok, `narration failed: ${r.problems.join("; ")}`);
    log("✓ narration verified");
    return tl;
  }, { log: opts.log });
}

async function narrateHoldingLock(dir: string, opts: NarrateOptions): Promise<Timeline> {
  const log = opts.log ?? ((s) => console.log(s));
  const synth = opts.synthesizer ?? fishSynthesizer;
  const paths = runPaths(dir);
  const beats: Beats = loadBeats(dir);
  const voice = storyVoice(resolveVoiceId(loadRun(dir).voice, opts.voice));
  const pron = loadPronunciations(dir);
  ensureDir(paths.narration);
  const spoken = beats.beats.map((b) => applyPronunciations(b.text, pron));
  let synthesized = 0;
  const laid: Laid[] = [];
  for (let i = 0; i < beats.beats.length; i++) {
    const b = beats.beats[i];
    const hash = chunkHash(spoken[i], voice);
    const base = join(paths.narration, `${b.id}.${hash}`);
    const wav = `${base}.wav`;
    const fresh = Boolean(opts.force) || !existsSync(`${base}.mp3`) || !existsSync(`${base}.align.json`);
    if (fresh) {
      for (const f of readdirSync(paths.narration)) if (f.startsWith(`${b.id}.`) && !f.startsWith(`${b.id}.${hash}`)) rmSync(join(paths.narration, f));
      log(`🎙 ${b.id} (${spoken[i].split(/\s+/).length} words)`);
      const { audio, alignment } = await synth({ text: spoken[i], previous_text: spoken[i - 1], next_text: spoken[i + 1], voice });
      writeFileSync(`${base}.mp3`, audio);
      writeJson(`${base}.align.json`, alignment);
      synthesized++;
    }
    // A fresh take (forced or new) re-decodes the WAV: the hash keys only text and voice, so a forced re-take with the
    // same text would otherwise keep the old audio beside the new word timings.
    if (fresh || !existsSync(wav)) await sh(["ffmpeg", "-y", "-v", "error", "-i", `${base}.mp3`, "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", wav]);
    const duration = await probeDuration(wav);
    const words = alignmentToWords(readJson<Alignment>(`${base}.align.json`));
    invariant(!words.length || words[words.length - 1].e <= duration + 0.25, `${b.id}: last word ends past the chunk`);
    laid.push({ id: b.id, scene: b.scene, wav, words, duration });
  }
  const tl = buildTimeline(laid);
  await assemble(tl, paths.narration, paths.narrationWav);
  const total = await probeDuration(paths.narrationWav);
  invariant(Math.abs(total - tl.total) < 0.08, `narration.wav ${total.toFixed(2)}s ≠ timeline ${tl.total.toFixed(2)}s`);
  writeJson(paths.timeline, tl);
  log(`✓ ${laid.length} beats (${synthesized} synthesized, ${laid.length - synthesized} cached) · ${tl.total.toFixed(1)}s · voice ${voice.voice_id} · ${TTS_MODEL}`);
  return tl;
}

/** Verifies the run's narration under the lock, waiting first for any narrator still writing it. */
export async function verifyNarration(dir: string, opts: { pollMs?: number; log?: (s: string) => void } = {}): Promise<{ ok: boolean; problems: string[] }> {
  if (!existsSync(runPaths(dir).narration)) return { ok: false, problems: ["timeline.json missing"] };
  return withFileLock(narrationLock(dir), () => verifyHoldingLock(dir), opts);
}

async function verifyHoldingLock(dir: string): Promise<{ ok: boolean; problems: string[] }> {
  const paths = runPaths(dir);
  const problems: string[] = [];
  if (!existsSync(paths.timeline)) return { ok: false, problems: ["timeline.json missing"] };
  const tl = readJson<Timeline>(paths.timeline);
  let t = tl.lead;
  for (let i = 0; i < tl.beats.length; i++) {
    const b = tl.beats[i];
    if (i > 0) t += tl.beats[i - 1].scene !== b.scene ? tl.sceneGap : tl.gap;
    if (!existsSync(b.chunk)) { problems.push(`${b.id}: chunk missing`); continue; }
    const d = await probeDuration(b.chunk);
    if (Math.abs(b.start - t) > 0.02) problems.push(`${b.id}: start ${b.start.toFixed(3)} ≠ ${t.toFixed(3)}`);
    if (Math.abs(b.end - b.start - d) > 0.02) problems.push(`${b.id}: length ${(b.end - b.start).toFixed(3)} ≠ chunk ${d.toFixed(3)}`);
    if (!b.words.length) problems.push(`${b.id}: no word timings`);
    t += d;
  }
  const total = await probeDuration(paths.narrationWav);
  if (Math.abs(total - tl.total) > 0.08) problems.push(`narration.wav ${total.toFixed(2)}s ≠ timeline ${tl.total.toFixed(2)}s`);
  return { ok: !problems.length, problems };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const run = argValue(argv, "--run");
  if (!run) { console.error("usage: Narrate.ts --run <slug|dir> [--force] [--verify] [--voice <id|role>]"); process.exit(2); }
  if (argv.includes("--model")) { console.error("--model chose an ElevenLabs model; narration is Fish Drama 3 now and takes no model flag"); process.exit(2); }
  const dir = resolveRunDir(run);
  if (hasFlag(argv, "--verify")) { const r = await verifyNarration(dir); for (const p of r.problems) console.log(`✗ ${p}`); console.log(r.ok ? "✓ narration verified" : "✗ narration failed"); process.exit(r.ok ? 0 : 1); }
  await narrate(dir, { force: hasFlag(argv, "--force"), voice: argValue(argv, "--voice") });
}
