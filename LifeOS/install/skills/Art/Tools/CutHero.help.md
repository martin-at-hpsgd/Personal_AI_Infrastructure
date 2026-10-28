# CutHero

Cuts a LifeOSHero plate out of its dark studio ground into a transparent image, keeping the ghosted drafting linework and leaving no ground between the lines.

## Usage

```bash
bun ~/.claude/skills/Art/Tools/CutHero.ts <raw.jpg> --out <master.png> [--webp <site.webp>] [--size 1600x900] [--preview <dir>]
```

- `<raw.jpg>`: the raw generation, never an edge-settled `-f.png` (the settle darkens the ground unevenly and breaks the ground estimate).
- `--out`: transparent PNG master, framed to `--size` (resize to cover, centre crop, like the old edge settle).
- `--webp`: transparent site copy, quality 82, lossless alpha.
- `--solid`: a solid object on a plain, featureless ground (the One Block series). Also keys everything inside the object's closed outline (never outside it, so ground shading stays out), samples the ground only outside that outline, and keys hard (noise floor 22, span 40), so dark shadow faces birefnet drops as notches come back opaque.
- `--preview`: writes `<stem>-on-dark.png` (#0A0A0C, the page) and `<stem>-on-blue.png` (#3A6EA5, shows leftover ground).

## Output

One JSON line on stdout: `input`, `master`, `webp`, `noise` (ground noise floor, 0–255), `coverage` (mean alpha), `edgeAlpha` (mean alpha of the outer 4% strip), `channels`, `ok`, `fails`.

Exit 0 when `channels` is `srgba`, `edgeAlpha` < 0.02 and coverage is 4–75%; 1 when any check fails; 2 on bad usage or a missing binary.

## Requires

`magick` (`MAGICK_BIN` overrides `/opt/homebrew/bin/magick`) and `rembg` with the `birefnet-general` model (`REMBG_BIN` overrides `~/.local/bin/rembg`). About 35 s per 2K master; three in parallel saturate a laptop.

## Limits

It assumes a smooth, featureless ground. A ground with drawn grids, glow pools or strong reflections is keyed as foreground near the object or leaves smudges; regenerate on a plain ground instead.
