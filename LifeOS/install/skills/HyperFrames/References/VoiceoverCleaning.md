# Voiceover cleaning

**Where it applies:** a LaunchVideo built on a script the principal recorded (`Intents/LaunchVideo.md` Ideal State, "A voiceover is clean before anything is built on it"). A film cut to music has no voiceover and skips this file.

## Tool contract

Voiceover cleaning, in this order:

1. Run the video skill’s TightCut intent with `--classify-noise`.
2. Sweep the whole cut in overlapping 3 s windows transcribed one at a time (`whisper-cli -ng`), and run a Gemini listen pass that asks for every throat-clear, cough, click and false start with timestamps.
3. Cut whatever either pass finds with `AudioEditor/Tools/Edit.ts`, then run `AudioEditor/Tools/BreathTame.ts` and `LoudnessLock.ts --target -14`.
4. Run `AudioEditor/Tools/GateScan.ts` on the result, and on the final encode. Splices leave sample steps that sound like a stutter, so any STEP gets `GateRepair.ts`.
5. Re-derive word times on the clean file and snap each word to its audio onset.

## Gotchas

- **Whole-file transcription and the noise finder both missed throat-clears that were still in the "clean" cut (2026-09-29).** An earlier cut had passed TightCut with 0 noise spans. It still held a 2.5 s cluster of throat-clears after one sentence and another 0.8 s after a later one, and `--add-noise` found neither, because the ledger had absorbed them. A Gemini listen pass flagged both, and short slices transcribed alone confirmed them as `*clears throat*`. A word ledger is not evidence that there is no noise. Listen for it.
- **Transcribers miss a spoken "Edit" at the start of a recording (2026-09-28).** When a voice line is used, transcribe the first 5 s, the last 5 s and 1.5 s around every seam as separate clips (`whisper-cli -ng`), and scan for edit, cough, ahem and false starts.
- **Splice ticks heard as a "stutter" passed every transcript check (2026-09-29).** The principal heard a stutter near the end of a clean-looking voiceover. Whisper, windowed sweeps and three Gemini listens all came back clean, and the film's audio matched the voice track exactly. GateScan found 5 sample steps at old TightCut splice points (6.7 s, 29.5 s, 51.4 s and 67.5 s), and `GateRepair` cleared them without changing the length. When a listener reports a glitch that no transcript shows, scan the samples.
