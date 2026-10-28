# Clean

Clean, edit, and polish audio files by removing filler words, stutters, false starts, dead air, and edit markers.

## Ideal State

- The cleaned file is the one the user meant: the explicit path they gave, or a match found in `~/Downloads/`, and when multiple files matched, the user chose which one to use.
- The pipeline ran with the flags the request maps to (`--preview`, `--aggressive`, `--polish`), and with none (standard cleaning, conservative thresholds) when the request named no mode.
- The edited audio is written as `<original-name>_edited.<ext>` in the same directory as the input file, and the report gives the number of edits applied, total time removed, original vs edited duration, the output file path, and the artifacts generated (transcript, edits JSON, edited audio).
- A `--preview` run shows the proposed edit list without modifying the audio, and execution happens only after the user says to proceed.
- Room tone runs continuous across every cut: no click, no swallowed consonant, and no drop into dead silence where a splice landed.
- The deliberate beat before a point survives and the accidental three-second gap is gone; the edit list shows the pipeline told rhetorical pauses from dead air.
- Cadence breaths stay and only the distracting ones are attenuated: BreathTame ducks in the 1–5% band and removes nothing, so the delivery still breathes like a person, just without the loud gasps.
- The delivered file sits in the delivery-loudness tolerance: LoudnessLock reads in-band (−14 LUFS / −1 dBTP for YouTube) without pumping.
- The actual edit points and breath events were listened to at the seams before the file was called done, and the principal received before/after clips at swap time.
- A reported tick is gone from the final encoded file: `GateScan` on the final encode (not the intermediate WAV) exits 0 after `GateRepair --finalize`, and a RAW recording that scans dirty is reported to the user as a capture-chain gate back on.

## Anti-criteria

- Never picks one of multiple matching audio files without asking the user which file to use.
- Never modifies the audio on a `--preview` run.
- Never treats a clean scan or a zero exit code as done: a tick-scanner can call a repair clean while a human hears a hole (the "Meter-clean ≠ ear-clean" gotcha in SKILL.md).
- Never removes breaths outright; BreathTame ducks, never removes.
- Never re-scans every export with GateScan: per-export GateScan checks are not part of the standard intents (routine checks retired 2026-07-15); gate checks run only when someone actually reports ticking/clicking.

## Inputs

The audio file: an explicit path, or a search of `~/Downloads/` with `fd -e mp3 -e wav -e m4a -e flac '<keyword>' ~/Downloads`.

## Tool contract

Map the user's request to Pipeline.ts flags:

| User Says | Flag | Effect |
|-----------|------|--------|
| "preview", "show edits", "what would you cut" | `--preview` | Show proposed edits without executing |
| "aggressive", "tight", "heavy edit" | `--aggressive` | Tighter silence/filler thresholds |
| "polish", "cleanvoice", "final pass" | `--polish` | Cleanvoice API cloud polish (requires CLEANVOICE_API_KEY) |
| (default) | (none) | Standard cleaning with conservative thresholds |

```bash
bun ~/.claude/skills/AudioEditor/Tools/Pipeline.ts \
  "<audio-file-path>" \
  [FLAGS_FROM_INTENT_MAPPING] \
  --output "<output-path>"
```

**Timeout:** Set a 10-minute timeout. Transcription of long files can take several minutes on MPS.

Breath taming, loudness lock and reported gate ticks use BreathTame, LoudnessLock, GateScan and GateRepair; their exact commands are in the SKILL.md Tools table, and the on-report gate procedure is its Gate Artifacts section.

For debugging or partial runs, each stage (Transcribe, Analyze, Edit, Polish) runs standalone; the commands are in the SKILL.md Tools table.
