import { readFileSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, join } from "node:path";
import { homedir } from "node:os";
import { loadEnv } from "./session.ts";
import { getDAName } from "../../../hooks/lib/identity.ts";

const execFileP = promisify(execFile);
const AUDIO_EXTENSIONS = new Set(["caf", "m4a", "amr", "mp3", "wav", "aac", "opus", "ogg"]);

export function speakable(text: string): string {
  let out = text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/^\s*-\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (out.length <= 1500) return out;
  const clipped = out.slice(0, 1500);
  const boundary = Math.max(clipped.lastIndexOf(". "), clipped.lastIndexOf("! "), clipped.lastIndexOf("? "));
  out = (boundary > 0 ? clipped.slice(0, boundary + 1) : clipped).trim();
  return out;
}

/** The voice note is a short spoken version of the text reply, never the whole reply read aloud (the principal, 2026-09-24). */
export const SPOKEN_MAX_CHARS = 240;
export const SPOKEN_INSTRUCTION = `[This reply also goes out as a voice note. Write the text reply as usual, then add ONE final line starting with "SPOKEN:" holding a much shorter spoken version: one or two plain sentences, under ${SPOKEN_MAX_CHARS} characters, no emoji, no URLs, the answer first.]`;

/** Pull the model's SPOKEN line out of the reply. Without one, the voice note is the first sentence or two of the text. */
export function splitSpoken(reply: string): { text: string; spoken: string } {
  const lines = reply.split("\n");
  const idx = lines.findLastIndex((l) => /^\s*[*_]*SPOKEN:[*_]*/i.test(l));
  const marked = idx >= 0 ? speakable(lines[idx]!.replace(/^\s*[*_]*SPOKEN:[*_]*\s*/i, "")) : "";
  const text = idx >= 0 ? lines.filter((_, i) => i !== idx).join("\n").trim() : reply.trim();
  return { text, spoken: shorten(marked || speakable(text)) };
}

function shorten(s: string): string {
  if (s.length <= SPOKEN_MAX_CHARS) return s;
  const sentences = s.match(/[^.!?]+[.!?]+/g) ?? [];
  let out = "";
  for (const sentence of sentences) {
    if ((out + sentence).length > SPOKEN_MAX_CHARS) break;
    out += sentence;
    if ((out.match(/[.!?]/g) ?? []).length >= 2) break;
  }
  return (out || s.slice(0, SPOKEN_MAX_CHARS).replace(/\s+\S*$/, "") + ".").trim();
}

export function asksForVoice(text: string): boolean {
  return /\b(?:send me a voice note|voice message|voice memo|reply in voice|say it out loud|read it to me|tell me out loud)\b/i.test(text);
}

export function isAudio(mimeType?: string, name?: string): boolean {
  return !!(mimeType?.toLowerCase().startsWith("audio/") || AUDIO_EXTENSIONS.has(extname(name ?? "").slice(1).toLowerCase()));
}

// The bridge loads LifeOS tools at call time from its own install (LIFEOS/RELAY/bridge → LIFEOS/TOOLS), so a
// relocated install (CLAUDE_CONFIG_DIR) loads its own tools; one place names the root.
const lifeosTool = (name: string): string => join(import.meta.dir, "../../TOOLS", name);

/** The local Whisper turn for one clip: the text file it writes, read back. Injected in tests. */
export type WhisperRun = (argv: string[], outFile: string) => Promise<string>;
const runWhisper: WhisperRun = async (argv, outFile) => { await execFileP(argv[0], argv.slice(1), { timeout: 180_000 }); return readFileSync(outFile, "utf8"); };

/**
 * Voice notes are transcribed on this Mac with mlx_whisper (large-v3-turbo, already cached), never a paid API
 * (2026-10-12). The audio never leaves the machine.
 */
export async function transcribeAudio(path: string, deps: { run?: WhisperRun } = {}): Promise<string> {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { CROSS_VENDOR } = await import(lifeosTool("models.ts"));
  const out = mkdtempSync(join(tmpdir(), "relay-whisper-"));
  try {
    const bin = Bun.which("mlx_whisper") ?? join(homedir(), ".local", "bin", "mlx_whisper");
    // Our names, so Whisper spells them right; the DA's name is resolved at runtime on every install.
    const argv = [bin, path, "--model", CROSS_VENDOR.localTranscribeVoice, "--language", "en", "--output-format", "txt", "--output-dir", out, "--output-name", "voice",
      "--initial-prompt", `${getDAName()}, Tex, Relay, LifeOS, Pulse, Herder.`];
    const text = (await (deps.run ?? runWhisper)(argv, join(out, "voice.txt"))).replace(/\s+/g, " ").trim();
    if (!text) throw new Error("transcription returned empty text");
    return text;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Voice notes speak in the DA's Fish voice (role "main"); the key is FISH_API_KEY. Fish is the only engine (Fish voice ISA phase 2). */
export async function synthesizeSpeech(text: string, deps: { fetch?: typeof fetch; key?: string } = {}): Promise<{ buffer: Buffer; mimeType: "audio/mpeg" }> {
  const { fishSpeak } = await import(lifeosTool("FishTTS.ts"));
  const key = deps.key ?? process.env.FISH_API_KEY ?? loadEnv().FISH_API_KEY;
  if (!key) throw new Error("FISH_API_KEY missing");
  // Fish applies the profile's pace natively (fish_speed), so there is no post-synthesis stretch. Drama 3 tags in the text pass through.
  const raw: Uint8Array = await fishSpeak(speakable(text), { voice: "main", apiKey: key, fetch: deps.fetch, mp3Bitrate: 192 });
  if (raw.length <= 1000) throw new Error("speech synthesis returned too little audio");
  // Broadcast finish (steady loudness, presence), the same as the spoken closers; a failed master sends the raw clip.
  const { masterVoice } = await import(lifeosTool("VoiceMaster.ts"));
  const { audio } = await masterVoice(raw);
  return { buffer: Buffer.from(audio), mimeType: "audio/mpeg" };
}
