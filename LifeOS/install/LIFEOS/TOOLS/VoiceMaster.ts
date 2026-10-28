/**
 * VoiceMaster — finish a spoken clip: steady loudness and no clipping, with the voice's own tone left alone.
 *
 * Why: Fish returns clean audio with no noise floor but quiet (about -19 LUFS) and peaky, so lines land soft next to
 * other audio. The target is studio-recording quality: extremely high clarity and
 * volume. Consumers: Pulse VoiceServer (spoken closers), Relay (voice notes).
 *
 * Two quick ffmpeg passes: the first measures integrated loudness after the tone chain, the second adds the gain that
 * lands it on TARGET_LUFS under a true-peak ceiling. A single loudnorm pass undershoots on clips this short.
 * With no ffmpeg, or on any ffmpeg failure, the input comes back unchanged and `mastered` is false.
 */
import { invariant } from "./Invariant.ts";
import { ffmpegPath } from "./AudioTempo.ts";

export const TARGET_LUFS = -14; // take A, the clip {{PRINCIPAL_NAME}} picked on 2026-10-24
export const CEILING = 0.89; // about -1 dBFS
export const BITRATE = "192k";

/**
 * Rumble cut only. No EQ and no compression: Fish's voice is already bright, and the old presence boost, air shelf and
 * 3:1 compressor made it shrill and clippy; a blind pick chose the clip that had only gain and a limiter.
 */
export const TONE_CHAIN = "highpass=f=70";

/** The gain in dB that moves a measured loudness to the target, held to a sane range so a near-silent clip is not blasted. */
export function makeupGain(measuredLufs: number, target = TARGET_LUFS): number {
  if (!Number.isFinite(measuredLufs)) return 0;
  return Math.max(-12, Math.min(18, target - measuredLufs));
}

/** Integrated loudness (LUFS) from ffmpeg's ebur128 summary, or NaN when absent. */
export function parseIntegrated(stderr: string): number {
  const m = stderr.match(/Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/);
  return m && m[1] !== "-inf" ? Number(m[1]) : NaN;
}

async function run(argv: string[], input: Uint8Array): Promise<{ out: ArrayBuffer; err: string; code: number }> {
  const p = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  p.stdin.write(input);
  p.stdin.end();
  const [out, err, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

export async function masterVoice(audio: Uint8Array, opts: { format?: "mp3" | "wav" } = {}): Promise<{ audio: Uint8Array; mastered: boolean; lufs?: number }> {
  const bin = ffmpegPath();
  if (!bin || audio.byteLength < 1000) return { audio, mastered: false };
  const inFmt = opts.format ?? "mp3";
  const measure = await run([bin, "-hide_banner", "-nostats", "-f", inFmt, "-i", "pipe:0", "-af", `${TONE_CHAIN},ebur128`, "-f", "null", "-"], audio);
  const lufs = parseIntegrated(measure.err);
  if (measure.code !== 0 || !Number.isFinite(lufs)) return { audio, mastered: false };
  const render = (gain: number) => run([bin, "-loglevel", "error", "-f", inFmt, "-i", "pipe:0", "-af", `${TONE_CHAIN},volume=${gain.toFixed(2)}dB,alimiter=limit=${CEILING}:attack=2:release=50:level=false`, "-ar", "44100", "-c:a", "libmp3lame", "-b:a", BITRATE, "-f", "mp3", "pipe:1"], audio);
  let gain = makeupGain(lufs);
  let r = await render(gain);
  if (r.code !== 0 || r.out.byteLength < 1000) return { audio, mastered: false };
  // The limiter eats a dB or two on peaky speech, so measure the result once and correct toward the target.
  const after = parseIntegrated((await run([bin, "-hide_banner", "-nostats", "-f", "mp3", "-i", "pipe:0", "-af", "ebur128", "-f", "null", "-"], new Uint8Array(r.out))).err);
  if (Number.isFinite(after) && Math.abs(TARGET_LUFS - after) > 0.5) {
    gain = Math.min(18, gain + Math.min(4, TARGET_LUFS - after));
    const again = await render(gain);
    if (again.code === 0 && again.out.byteLength >= 1000) r = again;
  }
  invariant(r.out.byteLength > 0, "masterVoice produced no audio");
  return { audio: new Uint8Array(r.out), mastered: true, lufs };
}
