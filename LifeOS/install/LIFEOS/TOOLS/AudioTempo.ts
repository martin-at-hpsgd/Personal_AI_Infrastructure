/**
 * AudioTempo — change the pace of an MP3 without changing its pitch (ffmpeg `atempo`).
 *
 * Fish applies pace itself (fish_speed), so nothing here is in the speech path. This is the shared ffmpeg
 * resolver (VoiceMaster) and the post-synthesis tempo and pitch filter for any caller that needs one.
 *
 * ffmpeg is resolved from PATH, then the Homebrew and /usr/local locations, because the VoiceServer runs under launchd
 * with a thin PATH. With no ffmpeg the audio comes back unchanged and `stretched` is false, so the caller can log it.
 */
import { existsSync } from "fs";
import { invariant } from "./Invariant.ts";

const FFMPEG_FALLBACKS = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"];

export function ffmpegPath(): string | null {
  return Bun.which("ffmpeg") ?? FFMPEG_FALLBACKS.find((p) => existsSync(p)) ?? null;
}

/** The ffmpeg filter for a tempo and a pitch shift in semitones. Pitch uses rubberband with formants kept, so the voice sounds younger rather than sped-up. */
export function tempoFilter(tempo: number, pitchSemitones = 0): string {
  if (pitchSemitones === 0) return `atempo=${tempo}`;
  invariant(Math.abs(pitchSemitones) <= 12, `pitch ${pitchSemitones} semitones is outside ±12`);
  return `rubberband=pitch=${Math.pow(2, pitchSemitones / 12).toFixed(5)}:tempo=${tempo}:formant=preserved`;
}

async function runFilter(bin: string, audio: Uint8Array, filter: string): Promise<{ out: ArrayBuffer; err: string; code: number }> {
  const p = Bun.spawn([bin, "-loglevel", "error", "-f", "mp3", "-i", "pipe:0", "-filter:a", filter, "-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3", "pipe:1"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  p.stdin.write(audio);
  p.stdin.end();
  const [out, err, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

/**
 * Re-time an MP3 by `tempo` (1.1 = 10% faster, same pitch) and optionally shift its pitch by `pitchSemitones`.
 * Tempo 1 with no pitch returns the input untouched. An ffmpeg built without rubberband falls back to tempo only
 * and reports `pitched: false`, so the caller can log it.
 */
export async function stretchMp3(audio: Uint8Array, tempo: number, pitchSemitones = 0): Promise<{ audio: Uint8Array; stretched: boolean; pitched: boolean }> {
  if (tempo === 1 && pitchSemitones === 0) return { audio, stretched: false, pitched: false };
  invariant(tempo >= 0.5 && tempo <= 2, `tempo ${tempo} is outside ffmpeg atempo's single-filter range 0.5–2`);
  const bin = ffmpegPath();
  if (!bin) return { audio, stretched: false, pitched: false };
  if (pitchSemitones !== 0) {
    const r = await runFilter(bin, audio, tempoFilter(tempo, pitchSemitones));
    if (r.code === 0 && r.out.byteLength >= 1000) return { audio: new Uint8Array(r.out), stretched: tempo !== 1, pitched: true };
    if (tempo === 1) return { audio, stretched: false, pitched: false };
  }
  const r = await runFilter(bin, audio, tempoFilter(tempo));
  if (r.code !== 0 || r.out.byteLength < 1000) throw new Error(`ffmpeg atempo=${tempo} failed (exit ${r.code}): ${r.err.slice(0, 200)}`);
  return { audio: new Uint8Array(r.out), stretched: true, pitched: false };
}
