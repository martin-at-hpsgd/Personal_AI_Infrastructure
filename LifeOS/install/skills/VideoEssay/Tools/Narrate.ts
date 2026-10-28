#!/usr/bin/env bun
/**
 * Narrate.ts — per-beat narration in the DA's configured voice, with word timings.
 *
 *   bun Narrate.ts --run <slug|dir> [--force] [--verify] [--json]
 *
 * For every beat in Script.json: apply pronunciation overrides to the spoken text
 * (display narration untouched), synthesize through Fish Audio Drama 3 with timestamps
 * (FishTTS.ts), cache the chunk by content hash, then concatenate chunks with a fixed gap,
 * loudness-normalize the track, and write Narration/timeline.json with beat offsets measured
 * from the real chunk durations (never from the alignment's last word).
 *
 * Voice: LIFEOS_CONFIG.toml [da.voices.main], the DA's one voice, at its fish_speed. The profile's voice_id is the
 * DA's voice; fishVoiceFor() maps it to the Fish role main or the principal's clone and
 * fails loud for any other id. Key: FISH_API_KEY from the env file. Drama 3 tags in the text ([sigh], <emphasis>…</emphasis>)
 * pass through to the voice and are left out when the returned words are matched back to the script.
 * Pace: the profile's `speed` goes to Fish as prosody speed on every request, so a chunk comes back at its pace and
 * its timings need no stretch.
 * Length: one Fish request carries at most FISH_CHUNK_LIMIT characters; longer text splits on sentence boundaries and
 * each chunk's word times are offset by the audio already produced (fishSpeakScript).
 * Timings: Fish returns word-level spans; fishSpeakScript matches them to the script's own tokens (punctuation kept on
 * the token), and wordsToAlignment spreads each word's span across its characters where a consumer reads character
 * timings (the cached `.align.json`, Ingest.ts).
 * Pure pieces (pronunciations, word matching, cache planning, timeline) are exported for tests.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getEnvPath } from "../../../LIFEOS/TOOLS/Paths.ts";
import { loadLifeosConfig, type LifeosVoiceSettings } from "../../../LIFEOS/TOOLS/LifeosConfig.ts";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { fishSpeakWithTimestamps, type FishVoice, type TimedWord } from "../../../LIFEOS/TOOLS/FishTTS.ts";
import { pronounce, pronunciationMap } from "../../../LIFEOS/TOOLS/Pronounce.ts";
import { PAIRED_TAGS, stripVoiceTags } from "../../../LIFEOS/TOOLS/VoiceTags.ts";
import { BEAT_GAP_SECONDS, FPS, TARGET_LUFS, argValue, ensureDir, hasFlag, loadScript, readJson, resolveRunDir, runPaths, sha256, writeJson, type Script, type Timeline, type TimelineBeat, type Word } from "./Lib.ts";
import { CROSS_VENDOR } from "../../../LIFEOS/TOOLS/models";

/** The speaking model; it is part of every chunk hash and the model name a voice reports when its profile names none. */
export const TTS_MODEL = CROSS_VENDOR.fishVoice;
/** Characters one Fish request carries. Longer text splits on sentence boundaries (fishChunks). */
export const FISH_CHUNK_LIMIT = 2_500;

export interface Alignment { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }
/** The voice profile shape. `voice_id` selects the Fish voice (fishVoiceFor); `speed` is the Fish prosody speed; `seed` rides here so the chunk hash covers it. */
export interface VoiceSettings { voice_id: string; model_id?: string; stability?: number; similarity_boost?: number; style?: number; speed?: number; use_speaker_boost?: boolean; seed?: number }
export interface SynthRequest { text: string; voice: VoiceSettings }
/** `alignment` is character-level, spread from Fish's word spans. */
export type Synthesizer = (req: SynthRequest) => Promise<{ audio: Buffer; alignment: Alignment }>;

// ---------- pronunciations ----------

// The one LifeOS pronunciation pass (LIFEOS/TOOLS/Pronounce.ts, Fish voice ISA F7). Narration runs it itself, before
// hashing, because the spoken text is the alignment and cache key; fishSpeakScript then tells Fish not to run it again.
/** The principal's rules with this run's pronunciations.json on top. */
export function loadPronunciations(runDir: string): Record<string, string> {
  return pronunciationMap(runPaths(runDir).pronunciations);
}

/** What the narrator says for this text: homographs, then the overrides. */
export const applyPronunciations = pronounce;

// ---------- alignment → words ----------

export function alignmentToWords(a: Alignment): Word[] {
  const words: Word[] = [];
  let cur = "";
  let start = 0;
  let end = 0;
  for (let i = 0; i < a.characters.length; i++) {
    const ch = a.characters[i];
    if (/\s/.test(ch)) {
      if (cur) words.push({ w: cur, s: start, e: end });
      cur = "";
      continue;
    }
    if (!cur) start = a.character_start_times_seconds[i];
    cur += ch;
    end = a.character_end_times_seconds[i];
  }
  if (cur) words.push({ w: cur, s: start, e: end });
  // The final character's end time absorbs the chunk's trailing silence; clamp the last word to a spoken length.
  const last = words[words.length - 1];
  if (last && last.e - last.s > 1.2) last.e = last.s + 0.6;
  return words;
}

// ---------- Fish: words matched to the script, chunks, voices ----------

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

/** What a word sounds like once punctuation, case and spacing are gone: Fish returns "well","known" for "well-known". */
const sounds = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const TAG_NAMES: ReadonlySet<string> = new Set(PAIRED_TAGS);
const PAIRED_TAG_RE = new RegExp(`</?(${PAIRED_TAGS.join("|")})>`, "g");
const MARK = "\u0001";

type ScriptUnit = { tag: string } | { word: string };

/**
 * The script as Fish speaks it: whitespace tokens with [directions] removed (Fish times no word for them) and each paired
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
 * Match Fish's word spans to the script's tokens, one {w, s, e} per token. The token keeps its punctuation; its span runs
 * from its first piece's start to its last piece's end. A token with no sound ("—") gets a zero-width span where the last
 * word ended. Throws when the words Fish returned do not spell the script, naming the token.
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
      if (!got && TAG_NAMES.has(p) && !want.startsWith(p)) { j++; continue; } // a tag name Fish timed that the script does not carry
      if (!want.startsWith(got + p)) throw new Error(`Fish word "${fish[j].text}" does not match the script token "${unit.word}"`);
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

export interface FishScriptOptions {
  voice: FishVoice;
  speed?: number;
  format?: "mp3" | "wav" | "pcm";
  sampleRate?: number;
  limit?: number;
  apiKey?: string;
  fetch?: typeof fetch;
}

/**
 * Speak text through Fish Drama 3 and return the audio with one timed word per script token. Text over the chunk limit
 * is spoken as several requests; each chunk's word times are offset by the audio duration already produced, so the
 * words sit on the concatenated audio's timeline (a raw pcm stream measures that duration from its bytes).
 */
export async function fishSpeakScript(text: string, o: FishScriptOptions): Promise<{ audio: Buffer; words: Word[]; durationSec: number }> {
  const chunks = fishChunks(text, o.limit);
  invariant(chunks.length > 0, "fishSpeakScript needs text to speak");
  const audio: Uint8Array[] = [];
  const words: Word[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    const r = await fishSpeakWithTimestamps(chunk, { voice: o.voice, speed: o.speed, format: o.format, sampleRate: o.sampleRate, apiKey: o.apiKey, fetch: o.fetch, timeoutMs: 120_000 + 50 * chunk.length, pronunciations: false });
    for (const w of reconcileWords(chunk, r.words)) words.push({ w: w.w, s: w.s + offset, e: w.e + offset });
    audio.push(r.audio);
    offset += o.format === "pcm" && o.sampleRate ? r.audio.byteLength / 2 / o.sampleRate : r.durationSec;
  }
  return { audio: Buffer.concat(audio), words, durationSec: offset };
}

function optionalEnv(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  try { return envValue(key); } catch { return undefined; }
}

/**
 * The Fish voice for a profile's voice_id: the principal's clone when it is ELEVENLABS_PRINCIPAL_VOICE_ID, else the first
 * [da.voices.main] when it carries that id and a fish_reference_id. A role name ("main", "principal") passes through. Any other id throws, naming where to configure it.
 */
export function fishVoiceFor(voiceId: string, voices: Record<string, LifeosVoiceSettings | undefined> = loadLifeosConfig().da.voices, principalId: string | undefined = optionalEnv("ELEVENLABS_PRINCIPAL_VOICE_ID")): FishVoice {
  if (voiceId === "main" || voiceId === "principal") return voiceId;
  if (principalId && voiceId === principalId) return "principal";
  if (voices.main?.voiceId === voiceId && voices.main.fishReferenceId) return "main";
  throw new Error(`Narrate: voice "${voiceId}" has no Fish voice. It is not the principal's voice or a [da.voices.*] profile with a fish_reference_id in LIFEOS_CONFIG.toml; add one there.`);
}

/** Fish Drama 3 as a Synthesizer: the profile's speed is the prosody speed (1.0 when unset, so the role's own pace never leaks into a read). */
export const fishSynthesizer: Synthesizer = async (req) => {
  const voice = fishVoiceFor(req.voice.voice_id);
  if (voice === "principal") process.env.FISH_PRINCIPAL_VOICE_ID ??= envValue("FISH_PRINCIPAL_VOICE_ID");
  const { audio, words } = await fishSpeakScript(req.text, { voice, speed: req.voice.speed ?? 1, apiKey: process.env.FISH_API_KEY ?? envValue("FISH_API_KEY") });
  return { audio, alignment: wordsToAlignment(words) };
};

// ---------- cache planning ----------

export function voiceModel(voice: VoiceSettings): string { return voice.model_id ?? TTS_MODEL; }

/** The engine and pace are in the hash: a chunk made by another engine, or at another speed, is never reused. */
export function chunkHash(spoken: string, voice: VoiceSettings, model = voiceModel(voice)): string {
  return sha256(JSON.stringify({ spoken, voice, model, engine: `fish:${CROSS_VENDOR.fishVoice}`, speed: voice.speed ?? 1 })).slice(0, 12);
}

export interface ChunkPlan { id: string; spoken: string; hash: string; base: string; cached: boolean }

export function planChunks(script: Script, pron: Record<string, string>, voice: VoiceSettings, narrationDir: string, force = false): ChunkPlan[] {
  return script.beats.map((b) => {
    const spoken = applyPronunciations(b.tts ?? b.narration, pron);
    const hash = chunkHash(spoken, voice);
    const base = join(narrationDir, `${b.id}.${hash}`);
    const cached = !force && existsSync(`${base}.mp3`) && existsSync(`${base}.align.json`);
    return { id: b.id, spoken, hash, base, cached };
  });
}

/** Given measured chunk durations (seconds), lay beats out with the gap between them. */
export function buildTimeline(plans: { id: string; base: string; words: Word[]; duration: number }[], gap = BEAT_GAP_SECONDS): Timeline {
  let t = 0;
  const beats: TimelineBeat[] = [];
  for (const p of plans) {
    const start = t;
    const end = t + p.duration;
    beats.push({ id: p.id, start, end, chunk: `${p.base}.wav`, words: p.words.map((w) => ({ w: w.w, s: w.s + start, e: w.e + start })) });
    t = end + gap;
  }
  const total = beats.length ? beats[beats.length - 1].end + gap : 0;
  return { fps: FPS, gap, total, narration: "narration.wav", beats };
}

// ---------- live pieces ----------

export function envValue(key: string): string {
  const text = readFileSync(getEnvPath(), "utf8");
  const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
  const v = m?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  invariant(v, `missing ${key} in the env file`);
  return v;
}

/**
 * The narration voice: [da.voices.main], the DA's one voice, on Fish at its fish_speed (1.0 when unset). Any other
 * [da.voices.*] profile is ignored, so a second DA profile can never put an old clone or pace on a video again.
 */
export function daVoice(voices: { main: LifeosVoiceSettings } & Record<string, LifeosVoiceSettings | undefined> = loadLifeosConfig().da.voices): VoiceSettings {
  const v = voices.main;
  invariant(v?.voiceId && v.fishReferenceId, "no DA voice configured ([da.voices.main] voice_id and fish_reference_id)");
  return { voice_id: v.voiceId, model_id: TTS_MODEL, speed: v.fishSpeed ?? 1 };
}

/**
 * What a chunk was spoken with, written beside it (`<chunk>.voice.json`) at the moment it is synthesized, so a later
 * check reads the voice as a recorded fact (Assay's video eval set, `voice-identity`), never re-derives it from
 * today's config. A chunk with no record predates the record and reads as unknown, never as a match.
 */
export interface VoiceRecord { engine: "fish"; model: string; voiceId: string; fishReferenceId: string; fishSpeed: number; at: string }
export const VOICE_RECORD_SUFFIX = ".voice.json";

/** The record for a chunk spoken in `voice`: the Fish reference the voice id resolves to in [da.voices.main], and the speed sent. */
export function voiceRecordFor(voice: VoiceSettings, voices: Record<string, LifeosVoiceSettings | undefined> = loadLifeosConfig().da.voices, at = new Date().toISOString()): VoiceRecord | null {
  const main = voices.main;
  if (!main?.fishReferenceId || main.voiceId !== voice.voice_id) return null;
  return { engine: "fish", model: voiceModel(voice), voiceId: voice.voice_id, fishReferenceId: main.fishReferenceId, fishSpeed: voice.speed ?? 1, at };
}

/** The author's clone: [principal.voice] from LIFEOS_CONFIG.toml plus the voice id from env. One profile, every tool. */
export function principalVoice(profile = loadLifeosConfig().principal.voice, voiceId = envValue("ELEVENLABS_PRINCIPAL_VOICE_ID")): VoiceSettings {
  invariant(profile, "no principal voice profile: add [principal.voice] to LIFEOS_CONFIG.toml");
  invariant(voiceId, "no principal voice id (ELEVENLABS_PRINCIPAL_VOICE_ID)");
  return { voice_id: voiceId, model_id: profile.modelId, stability: profile.stability, similarity_boost: profile.similarityBoost, style: profile.style, use_speaker_boost: profile.useSpeakerBoost, seed: profile.seed };
}

/** Characters Ingest.ts packs into one take. The Fish synthesizer splits any take over FISH_CHUNK_LIMIT itself, so this only sizes Ingest's takes. */
export const REQUEST_CHAR_LIMIT = 5_000;

async function sh(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd[0]} failed (${code}): ${err.slice(-400)}`);
  return out;
}

export async function probeDuration(path: string): Promise<number> {
  const out = await sh(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
  const d = Number(out.trim());
  invariant(Number.isFinite(d) && d > 0, `ffprobe duration unreadable for ${path}`);
  return d;
}

/** Decode a chunk to 44.1 kHz stereo wav. */
export async function toWav(mp3: string, wav: string): Promise<void> {
  await sh(["ffmpeg", "-y", "-v", "error", "-i", mp3, "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", wav]);
}

export async function concatWithGaps(chunks: string[], gap: number, outWav: string, narrationDir: string): Promise<void> {
  const gapWav = join(narrationDir, `gap.${gap}.wav`);
  if (!existsSync(gapWav)) await sh(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", `anullsrc=r=44100:cl=stereo`, "-t", String(gap), "-c:a", "pcm_s16le", gapWav]);
  const list = join(narrationDir, "concat.txt");
  const lines: string[] = [];
  chunks.forEach((c, i) => { lines.push(`file '${c}'`); if (i < chunks.length - 1 || true) lines.push(`file '${gapWav}'`); });
  writeFileSync(list, lines.join("\n") + "\n");
  const raw = join(narrationDir, "narration.raw.wav");
  await sh(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c:a", "pcm_s16le", raw]);
  // Two-pass loudnorm to the delivery target; keep sample rate (loudnorm upsamples to 192k otherwise).
  // ffmpeg prints the measurement JSON on stderr with exit 0, so capture stderr directly.
  const measureProc = Bun.spawn(["ffmpeg", "-v", "info", "-i", raw, "-af", `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11:print_format=json`, "-f", "null", "-"], { stderr: "pipe", stdout: "pipe" });
  await measureProc.exited;
  const stderrJson = await new Response(measureProc.stderr).text();
  const m = stderrJson.match(/\{[\s\S]*"input_i"[\s\S]*?\}/);
  invariant(m, "loudnorm measurement pass produced no JSON");
  const s = JSON.parse(m[0]) as Record<string, string>;
  const af = `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11:measured_I=${s.input_i}:measured_TP=${s.input_tp}:measured_LRA=${s.input_lra}:measured_thresh=${s.input_thresh}:offset=${s.target_offset}:linear=true:print_format=summary`;
  await sh(["ffmpeg", "-y", "-v", "error", "-i", raw, "-af", af, "-ar", "44100", "-c:a", "pcm_s16le", outWav]);
}

export async function narrate(runDir: string, opts: { force?: boolean; synthesizer?: Synthesizer; log?: (s: string) => void } = {}): Promise<Timeline> {
  const log = opts.log ?? ((s) => console.log(s));
  const synth = opts.synthesizer ?? fishSynthesizer;
  const paths = runPaths(runDir);
  const script = loadScript(runDir);
  const voice = daVoice();
  const pron = loadPronunciations(runDir);
  ensureDir(paths.narration);
  const plans = planChunks(script, pron, voice, paths.narration, opts.force);
  let synthesized = 0;
  const retaken = new Set<string>();
  for (const p of plans) {
    if (p.cached) continue;
    // Drop stale chunks for this beat (older hashes).
    for (const f of readdirSync(paths.narration)) if (f.startsWith(`${p.id}.`) && !f.startsWith(`${p.id}.${p.hash}`)) rmSync(join(paths.narration, f));
    log(`🎙 ${p.id} (${p.spoken.split(/\s+/).length} words)`);
    const { audio, alignment } = await synth({ text: p.spoken, voice });
    writeFileSync(`${p.base}.mp3`, audio);
    writeJson(`${p.base}.align.json`, alignment);
    const record = voiceRecordFor(voice);
    invariant(record, `${p.id}: the narration voice ${voice.voice_id} is not [da.voices.main]; no voice record can be written`);
    invariant(/^[0-9a-f]{32}$/.test(record.fishReferenceId) && record.fishSpeed > 0, `${p.id}: malformed voice record`);
    writeJson(`${p.base}${VOICE_RECORD_SUFFIX}`, record);
    retaken.add(p.id);
    synthesized++;
  }
  const laid: { id: string; base: string; wav: string; words: Word[]; duration: number }[] = [];
  for (const p of plans) {
    const wav = `${p.base}.wav`;
    // A fresh take re-decodes the wav: the hash keys text and voice only, so a forced re-take of the same text would
    // otherwise leave the old audio beside the new word timings.
    if (retaken.has(p.id) || !existsSync(wav)) await toWav(`${p.base}.mp3`, wav);
    const duration = await probeDuration(wav);
    const words = alignmentToWords(readJson<Alignment>(`${p.base}.align.json`));
    invariant(!words.length || words[words.length - 1].e <= duration + 0.25, `${p.id}: last word ends ${words[words.length - 1].e.toFixed(2)}s past the ${duration.toFixed(2)}s chunk`);
    laid.push({ id: p.id, base: p.base, wav, words, duration });
  }
  const timeline = buildTimeline(laid.map((l) => ({ id: l.id, base: l.wav.replace(/\.wav$/, ""), words: l.words, duration: l.duration })));
  await concatWithGaps(laid.map((l) => l.wav), timeline.gap, paths.narrationWav, paths.narration);
  const total = await probeDuration(paths.narrationWav);
  invariant(Math.abs(total - timeline.total) < 0.05, `concatenated narration ${total}s does not match timeline ${timeline.total}s`);
  writeJson(paths.timeline, timeline);
  log(`✓ ${plans.length} beats (${synthesized} synthesized, ${plans.length - synthesized} cached) · ${timeline.total.toFixed(1)}s`);
  return timeline;
}

export async function verifyNarration(runDir: string): Promise<{ ok: boolean; problems: string[] }> {
  const paths = runPaths(runDir);
  const problems: string[] = [];
  if (!existsSync(paths.timeline)) return { ok: false, problems: ["timeline.json missing"] };
  const tl = readJson<Timeline>(paths.timeline);
  let t = 0;
  for (const b of tl.beats) {
    if (!existsSync(b.chunk)) { problems.push(`${b.id}: chunk missing`); continue; }
    const d = await probeDuration(b.chunk);
    if (Math.abs(b.start - t) > 0.02) problems.push(`${b.id}: start ${b.start} ≠ measured ${t.toFixed(3)}`);
    if (Math.abs(b.end - b.start - d) > 0.02) problems.push(`${b.id}: length ${(b.end - b.start).toFixed(3)} ≠ chunk ${d.toFixed(3)}`);
    if (!b.words.length) problems.push(`${b.id}: no word timings`);
    t = b.start + d + tl.gap;
  }
  const total = await probeDuration(paths.narrationWav);
  if (Math.abs(total - tl.total) > 0.05) problems.push(`narration.wav ${total.toFixed(2)}s ≠ timeline ${tl.total.toFixed(2)}s`);
  return { ok: problems.length === 0, problems };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const run = argValue(argv, "--run");
  if (!run) { console.error("usage: Narrate.ts --run <slug|dir> [--force] [--verify]"); process.exit(2); }
  const dir = resolveRunDir(run);
  if (hasFlag(argv, "--verify")) {
    const r = await verifyNarration(dir);
    for (const p of r.problems) console.log(`✗ ${p}`);
    console.log(r.ok ? "✓ narration verified" : "✗ narration failed");
    process.exit(r.ok ? 0 : 1);
  }
  await narrate(dir, { force: hasFlag(argv, "--force") });
}
