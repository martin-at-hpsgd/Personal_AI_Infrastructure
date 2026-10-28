# BreathTame.ts

Surgical breath and mouth-sound attenuation. Attenuates individual **events** in the gaps between words. It is not a filter — no gate, no denoiser, no expander, no broadband processing — and it proves that before writing.

## Usage

```bash
bun ~/.claude/skills/AudioEditor/Tools/BreathTame.ts <audio-or-video> [flags]
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--out <path>` | `<stem>-tamed<ext>` | Output file |
| `--words <transcript.json>` | auto | Word-level transcript. Auto-detects `<stem>.transcript.json`, else runs `Transcribe.ts` |
| `--breath-db <n>` | `-9` | Attenuation applied to breath events. Must be negative; 0 or above exits 2 |
| `--click-db <n>` | `-12` | Attenuation applied to mouth-click events. Must be negative; 0 or above exits 2 |
| `--guard-ms <n>` | `40` | Protected margin around every word. Nothing inside a word ±guard is ever touched. A negative value exits 2 |
| `--max-affected-pct <n>` | `12` | Refuse to write if more than this share of the file would be attenuated. Above 0 and at most 100 |
| `--dry-run` | | Report detections, write nothing |
| `--json` | | Machine-readable report including every event |

## Why it is safe

- **Word-confined.** Detection runs only in the complement of (word windows + `--guard-ms`). An event that straddles a word boundary is discarded, so speech is structurally out of reach.
- **Attenuates, never removes.** Events are ducked by a fixed dB amount with 12 ms raised-cosine ramps. Nothing is cut to silence, so no discontinuity is created for a downstream editor to splice on.
- **Level-bounded.** An event must sit at least 8 dB above the measured room floor and at least 6 dB below measured speech level. Anything louder is assumed to be speech and left alone.
- **Shape-bounded.** Events under 20 ms or over 1200 ms are ignored. A 1200 ms "breath" is content.
- **Refuses to go broad.** If detection would touch more than `--max-affected-pct` of the file, it exits non-zero without writing. Broad detection means the settings are wrong, not that the file needs more processing.
- **Bit-identity falsifier.** Before writing, every sample outside a detected event is compared against the input. Any drift prints `UNTOUCHED-IDENTICAL: FAIL` and aborts. A successful run prints `PASS` with the count of untouched frames.

## Output

```
Room floor -69.9 dBFS · speech -14.9 dBFS · event window -61.9..-20.9 dBFS
Events: 12 breaths, 3 clicks · 2.41s (1.83% of file)
UNTOUCHED-IDENTICAL: PASS (1263840 frames bit-identical)
Done. 12 breaths at -9 dB, 3 clicks at -12 dB, 1.83% of file touched.
```

Typical real speech lands at **1–5%** affected. Double digits means detection is catching speech — dry-run it and look at the event list before raising the ceiling.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Clean run (or dry run) |
| 1 | Bit-identity failed, affected share over ceiling, no transcript, or ffmpeg error |
| 2 | Bad arguments |

## Requirements

- `ffmpeg`
- A word-level transcript, or `whisper` / `insanely-fast-whisper` for `Transcribe.ts` to produce one

## Notes

- WAV output is copied verbatim at 32-bit so the untouched samples stay bit-exact. Video output re-encodes audio to 320k AAC (unavoidable when modifying) and copies the video stream.
- Run it **before** `LoudnessLock.ts`, never after — loudness is the last thing that touches a deliverable.
