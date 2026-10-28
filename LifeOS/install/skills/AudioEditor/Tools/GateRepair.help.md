# GateRepair

Repairs hard noise-gate truncation artifacts ("ticking") in recorded speech: 6ms raised-cosine ramps at every gate edge, hard-zeroed gate-chatter blips, V-notch safety sweep for residual boundary steps. Minimal-touch — audio outside repair windows passes through untouched. A video stream, when the input has one, is bit-copied in `--finalize` mode; audio-only input encodes to an audio-only file (use `.m4a`).

## Usage

```bash
# Repaired WAV only
bun ${LIFEOS_SKILL_DIR}/Tools/GateRepair.ts <in-media> <out.wav>

# Full pipeline: repair → AAC encode + video copy → scan ENCODED file → iterate to clean
bun ${LIFEOS_SKILL_DIR}/Tools/GateRepair.ts <in-media> <out.mp4> --finalize [--abr 192k]
```

## Verification contract

`--finalize` exits 0 only when the ENCODED output has zero silence-boundary steps (GateScan STEP criterion). Always follow with a duration check against the source and (for video) frame-count validation.

## Provenance

Built 2026-07-13 from a ticking incident: a capture-chain noise gate left hundreds of hard edges in one recording, leveling amplified them into audible ticks, and they reached published audio. Method details and false-positive gotchas: AudioEditor SKILL.md § Gotchas.
