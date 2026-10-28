# LoudnessLock

Deterministic delivery-loudness finalizer. Target: **−14 LUFS integrated, ≤ −1 dBTP true peak** (the YouTube delivery standard — YouTube turns louder content down and leaves quieter content sounding weak).

## Usage

```bash
# Measure only — PASS/FAIL against target (exit 0 = within ±0.5 LU and TP ≤ −1dBTP)
# Also prints a `spread:` line: worst sustained speech span vs integrated.
bun ${LIFEOS_SKILL_DIR}/Tools/LoudnessLock.ts <media>

# Normalize — two-pass loudnorm (linear), video copied, self re-measured
bun ${LIFEOS_SKILL_DIR}/Tools/LoudnessLock.ts <media> --out <out.mp4> [--target -14] [--tp -1] [--abr 256k] [--level]
```

## Flags

- `--level` — adaptive speech leveling before the lock (dynaudnorm: ~7.5s gaussian window, gain-only, +12dB cap, silence-thresholded). Fixes within-file imbalance — raw mic speech sitting LU below a mastered embedded clip — which the uniform lock preserves by design. Pass it for talking-head video deliverables; the maintainer-side video pipeline (not in the public release) passes it by default. The spread line is report-only: no bucket-scale threshold separates a real imbalance from natural soft asides (measured 2026-08-28: defect −6.0 LU vs leveled-good −5.4 LU), so the structural control is this flag being the pipeline default.

## Contract

- Normalize mode exits 0 **only after re-measuring its own output** within tolerance.
- Video stream is bit-copied; only audio re-encodes (AAC, source sample rate).
- Order in the export pipeline: ValidateExport → **LoudnessLock** → ear-check clips. GateScan is not a routine step (per-export scans were retired 2026-07-15); when someone reports ticking, scan and repair before the lock and scan the locked final encode again (SKILL.md § Gate Artifacts).
- Program-level integrated PASS does not certify internal balance — read the `spread:` line. A hot embedded clip next to quiet speech passes integrated and still sounds broken; that is exactly what `--level` exists for (found 2026-08-28: embedded creator clip −13.3 LUFS / speaker intro −16.3).
- The composition's audio stays untouched (unity gain) in the editor; ALL loudness lives here (2026-08-14 clipping incident).
