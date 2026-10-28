---
provenance: template
version: 1.0.0
---

# AudioEditor Preferences

Optional. Read by the AudioEditor skill (`skills/AudioEditor/SKILL.md` § Data & Config) before an edit; it is read by the model, not parsed by code, and anything left out keeps the skill's default. Setup guide: `skills/AudioEditor/Setup.md`.

## Default cleaning mode

Which mode a plain "clean this audio" request uses. Default: standard. Example: "aggressive for Alex Example's solo voice notes, standard for interviews".

## Polish

Whether the Cleanvoice polish pass runs without being asked. Default: only when requested. Example: "always polish episodes of the ExampleNet podcast".

## Delivery loudness

The LoudnessLock target when the request does not name one. Default: -14 LUFS / -1 dBTP. Example: "-16 LUFS for podcast feeds".

## Output format

The file type cleaned audio is written as. Default: the tool's own (MP3 or WAV). Example: "WAV, 48 kHz, for handoff to an editor".
