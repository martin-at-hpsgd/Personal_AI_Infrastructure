/**
 * FishTTS.ts — the one Fish Audio text-to-speech client every LifeOS speaker uses
 * (Fish voice ISA, phases 2–3).
 *
 * Voices resolve by role: "main" → [da.voices.main].fish_reference_id in LIFEOS_CONFIG.toml, the DA's one voice
 * (there is no separate presenter voice since 2026-10-24); "principal" → FISH_PRINCIPAL_VOICE_ID
 * in the environment, because the principal's voice id never lives in config (LifeosConfig § principal.voice).
 * The key is FISH_API_KEY from the environment. Text may carry Drama 3 tags (VoiceTags.ts).
 *
 *   fishSpeak(text, { voice })                 → audio bytes (mp3 by default)
 *   fishSpeakWithTimestamps(text, { voice })   → { audio, words: [{ text, start, end }], durationSec }
 *   fishCreateVoice(title, sample, transcript) → id of a new private Fish voice
 */
import { CROSS_VENDOR } from "./models"
import { loadLifeosConfig } from "./LifeosConfig"
import { principalPronunciations, pronounce } from "./Pronounce"
import { invariant } from "./Invariant"

export type FishRole = "main" | "principal"
export type FishVoice = FishRole | { referenceId: string }

export interface FishOptions {
  voice: FishVoice
  /** Prosody speed multiplier 0.5–2.0; unset uses the role's fish_speed, else 1.0. */
  speed?: number
  format?: "mp3" | "wav" | "pcm"
  sampleRate?: number
  mp3Bitrate?: 64 | 128 | 192
  latency?: "normal" | "balanced" | "low"
  /** Per-request timeout. Long narration needs longer than a closer. */
  timeoutMs?: number
  apiKey?: string
  fetch?: typeof fetch
  /** Run the one pronunciation pass (Pronounce.ts: homographs, then PRONUNCIATIONS.json) before synthesis (default true).
   *  False only for a caller that ran pronounce() itself because it keeps the spoken text (narration word alignment). */
  pronunciations?: boolean
  /** Override map, for tests or a run-specific list merged by the caller. */
  pronunciationMap?: Record<string, string>
}

export interface TimedWord { text: string; start: number; end: number }

const BASE = "https://api.fish.audio"

/** The Fish reference id and default speed for a voice. Throws when the role has no Fish clone configured. */
export function resolveFishVoice(voice: FishVoice, env: NodeJS.ProcessEnv = process.env): { referenceId: string; speed?: number } {
  if (typeof voice === "object") return { referenceId: voice.referenceId }
  if (voice === "principal") {
    const id = env.FISH_PRINCIPAL_VOICE_ID
    if (!id) throw new Error("FishTTS: FISH_PRINCIPAL_VOICE_ID is not set")
    return { referenceId: id }
  }
  const v = (loadLifeosConfig().da.voices as Record<string, { fishReferenceId?: string; fishSpeed?: number } | undefined>)[voice]
  if (!v?.fishReferenceId) throw new Error(`FishTTS: no fish_reference_id for [da.voices.${voice}] in LIFEOS_CONFIG.toml`)
  return { referenceId: v.fishReferenceId, speed: v.fishSpeed }
}

// Pronunciation is one module (Pronounce.ts over PronounceCore.ts, Fish voice ISA F7); these names stay for importers.
export { applyPronunciations, principalPronunciations } from "./Pronounce"

export function fishRequestBody(text: string, referenceId: string, o: Omit<FishOptions, "voice">, speed?: number): Record<string, unknown> {
  const s = o.speed ?? speed
  // Every Fish caller speaks through the one pronunciation pass unless it already ran it itself,
  // so every voice in the system says each word the same way.
  if (o.pronunciations !== false) text = pronounce(text, o.pronunciationMap ?? principalPronunciations())
  return {
    text,
    reference_id: referenceId,
    format: o.format ?? "mp3",
    ...(o.sampleRate ? { sample_rate: o.sampleRate } : {}),
    ...(o.mp3Bitrate ? { mp3_bitrate: o.mp3Bitrate } : {}),
    latency: o.latency ?? "normal",
    ...(s && s !== 1 ? { prosody: { speed: s } } : {}),
  }
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    // A missing or misspelled model header silently falls back to s2.1-pro, which has no per-word tags.
    model: CROSS_VENDOR.fishVoice,
  }
}

function apiKey(explicit?: string): string {
  const k = explicit ?? process.env.FISH_API_KEY
  if (!k) throw new Error("FishTTS: FISH_API_KEY is not set")
  return k
}

/** Speak text in a Fish voice. Returns the audio bytes. */
export async function fishSpeak(text: string, o: FishOptions): Promise<Uint8Array> {
  invariant(text.trim().length > 0, "fishSpeak needs non-empty text")
  const { referenceId, speed } = resolveFishVoice(o.voice)
  const res = await (o.fetch ?? fetch)(`${BASE}/v1/tts`, {
    method: "POST",
    headers: headers(apiKey(o.apiKey)),
    body: JSON.stringify(fishRequestBody(text, referenceId, o, speed)),
    signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
  })
  if (!res.ok) throw new Error(`Fish API error: ${res.status} - ${(await res.text().catch(() => "")).slice(0, 200)}`)
  const audio = new Uint8Array(await res.arrayBuffer())
  if (audio.byteLength === 0) throw new Error("Fish API returned no audio")
  return audio
}

/** Parse the with-timestamp SSE stream: concatenate audio chunks, keep the latest alignment per chunk_seq. */
export function parseTimestampStream(sse: string): { audio: Uint8Array; words: TimedWord[]; durationSec: number } {
  const chunks: Uint8Array[] = []
  const byChunk = new Map<number, { offset: number; words: TimedWord[]; duration: number }>()
  for (const block of sse.split(/\n\n+/)) {
    const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
    if (!data || data === "[DONE]") continue
    const ev = JSON.parse(data)
    if (ev.audio_base64) chunks.push(Uint8Array.from(Buffer.from(ev.audio_base64, "base64")))
    if (ev.alignment) {
      byChunk.set(Number(ev.chunk_seq ?? 0), {
        offset: Number(ev.chunk_audio_offset_sec ?? 0),
        duration: Number(ev.alignment.audio_duration ?? 0),
        words: (ev.alignment.segments ?? []).map((s: { text: unknown; start: unknown; end: unknown }) => ({ text: String(s.text), start: Number(s.start), end: Number(s.end) })),
      })
    }
  }
  const audio = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let at = 0
  for (const c of chunks) { audio.set(c, at); at += c.byteLength }
  const words: TimedWord[] = []
  let durationSec = 0
  for (const seq of [...byChunk.keys()].sort((a, b) => a - b)) {
    const c = byChunk.get(seq)!
    for (const w of c.words) words.push({ text: w.text, start: w.start + c.offset, end: w.end + c.offset })
    durationSec = Math.max(durationSec, c.offset + c.duration)
  }
  return { audio, words, durationSec }
}

/** Speak text and return the audio with word-level timings (for narration that cuts to words). */
export async function fishSpeakWithTimestamps(text: string, o: FishOptions): Promise<{ audio: Uint8Array; words: TimedWord[]; durationSec: number }> {
  invariant(text.trim().length > 0, "fishSpeakWithTimestamps needs non-empty text")
  const { referenceId, speed } = resolveFishVoice(o.voice)
  const res = await (o.fetch ?? fetch)(`${BASE}/v1/tts/stream/with-timestamp`, {
    method: "POST",
    headers: headers(apiKey(o.apiKey)),
    body: JSON.stringify(fishRequestBody(text, referenceId, o, speed)),
    signal: AbortSignal.timeout(o.timeoutMs ?? 300_000),
  })
  if (!res.ok) throw new Error(`Fish API error: ${res.status} - ${(await res.text().catch(() => "")).slice(0, 200)}`)
  const out = parseTimestampStream(await res.text())
  if (out.audio.byteLength === 0) throw new Error("Fish API returned no audio")
  return out
}

/** Upload a reference clip and its exact transcript as a new private Fish voice. Returns the model id. */
export async function fishCreateVoice(title: string, sample: Uint8Array, transcript: string, o: { apiKey?: string; mime?: string } = {}): Promise<string> {
  const form = new FormData()
  form.append("visibility", "private")
  form.append("type", "tts")
  form.append("title", title)
  form.append("train_mode", "fast")
  form.append("voices", new Blob([new Uint8Array(sample)], { type: o.mime ?? "audio/mpeg" }), "reference.mp3")
  form.append("texts", transcript)
  const res = await fetch(`${BASE}/model`, { method: "POST", headers: { Authorization: `Bearer ${apiKey(o.apiKey)}` }, body: form, signal: AbortSignal.timeout(120_000) })
  const body = await res.text()
  if (!res.ok) throw new Error(`Fish create model ${res.status}: ${body.slice(0, 200)}`)
  const j = JSON.parse(body)
  invariant(j.visibility === "private", `Fish voice "${title}" came back ${j.visibility}, expected private`)
  return j._id
}
