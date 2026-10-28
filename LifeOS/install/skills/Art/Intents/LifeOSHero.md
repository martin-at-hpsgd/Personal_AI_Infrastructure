---
contract:
  requires:
    - id: move
      path: lifeos-heroes/{slug}/unit.json
      fields: [IDEA, MOVE, OUTLINE, ACCENT, CHECKS]
      produce: 'Read the whole card for {slug}, then save {path} as JSON with IDEA (the card''s one idea in a plain sentence), MOVE (the single physical change made to the Unit that carries that idea), OUTLINE (how that move changes the silhouette, so it reads at thumbnail size), ACCENT (the one part that carries the card colour), CHECKS (2-4 claims a viewer can verify from pixels).'
  bans:
    - '/\b(charcoal|sienna|sepia|cream|parchment|watercolou?r|gouache|pastel)\b/i'
    - '/\b(neon|hologram|holographic|hud|cyberpunk|lens flare|bokeh|particles?)\b/i'
    - '/\b(circuit[ -]board|plexus|neural network|network of nodes|orb)\b/i'
    - '/\b(screens?|monitors?|dashboards?|keyboards?|interfaces?|user interface|ui)\b/i'
    - '/\b(isometric|excalidraw|flat vector|infographic)\b/i'
    - '/\b(section plane|drafting|bone-grey)\b/i'
    - '/\bwhite (background|ground|paper)\b/i'
  mandates: ['/\blight-grey\b/i', '/\bno vignette\b/i', '/\bthe Unit\b/', '/\brim light\b/i', '/\bno letters\b/i', '/#[0-9A-F]{6}\b.*#[0-9A-F]{6}\b/is']
---

# LifeOSHero

**Contents:** Ideal State · Anti-criteria · Output format · Inputs · Tool contract · Gotchas

Hero images for LifeOS philosophy cards in the One Block series: every card is the same object, the Unit, changed by one physical move that carries the card's idea, in that card's own accent colour, shipped as a transparent cut-out. The same file is the page hero and the card thumbnail on the philosophy index.

The series replaced the section-plate machines on 2026-10-19, when the principal picked this direction from four council concepts ("I like row 2, but remember that they're going to be transparent"). The section plates were judged too busy, and at thumbnail size viewers named the machine rather than the idea.

## Ideal State

- `lifeos-heroes/{slug}/unit.json` (IDEA, MOVE, OUTLINE, ACCENT, CHECKS) existed before any render, written after reading the whole card, and the prompt fills the template from it with the rig paragraph verbatim.
- The Unit is recognisable on every card: a satin dark-graphite ceramic cube with softly radiused edges and a thin brushed-aluminium band around its waist. Each card changes it with exactly one move (carve, split, slice, stack, hollow, multiply, pierce, turn to glass, lean, spin), and that move is the idea.
- The move changes the outline, so a viewer who has read the card can name the idea from the thumbnail; a move that is only a surface mark is redone as one that changes the silhouette.
- The accent colour sits on one part only, the part where the move happens, as tinted glass or an inlay. Every other surface is neutral graphite and aluminium, and the accent hue of the most saturated pixels sits within about 12° of the card's hex.
- It reads on a near-black page with no ground: every face separates from #0A0A0C by its own lighter satin tone, a lit top face and a crisp rim light on the edges. Nothing depends on a shadow or reflection on the floor, because the cut removes the floor.
- The delivered hero is transparent: outside the object every pixel has zero alpha, the frame edge is fully clear, and no ground survives inside holes or behind glass edges; on the page it sits directly on the background with no border, radius, fill or box shadow.
- No letters, numerals, glyphs or pseudo-text anywhere, confirmed by reading the pixels.
- Composition survives the crops: 16:9 master, the object centred in about the middle 55-65% of the width, the essential parts inside x 15-85% and y 15-85%, at most seven pieces.
- It reads as one series: beside the other cards it shares the Unit, the camera, the light and the materials, and its outline alone tells it apart.
- The cut passed: `CutHero.ts --solid` exited 0 and the `-on-blue` preview shows no grey patch of ground.
- The ArtDirection quality loop reached its bar (median 8.5, both vendors within 0.5, zero critical defects), with the series also critiqued together as a contact sheet; a card that stops improving is reported with its score and remaining defects.
- The raw generation and the cut master stay in the staging directory, and the site copy is a transparent 1600×900 WebP with alt text that describes what the image shows (the cube and its move), not what the system is.

## Anti-criteria

- Name puns are never the main idea (no lighthouse for a watcher, no brain for memory).
- No second object type beside the Unit: more pieces are always more Units, plates sliced from a Unit, or a thin graphite rod joining Units.
- Words banned by the contract never appear in the prompt, including in negative phrasing.
- No `--remove-bg` or bare rembg on a hero; `CutHero.ts` cuts it.
- A card whose accent drifts past about 12° is regenerated, never recoloured wholesale.

## Output format

One image per card, a transparent cut-out that sits straight on the page, with no studio ground and no plate or box around it (principal directive, 2026-09-27).

### Series grammar

- **The Unit:** a cube with softly radiused edges, satin dark-graphite ceramic one shade lighter than the page, a thin brushed graphite-aluminium band at its waist. Every piece in every image is the Unit, part of it, a smaller or larger Unit, or a rod joining Units.
- **The move:** one change per card, chosen so it is the idea. Carve (stairs, a helix, a funnel, a slot), split (a geode, a crack), slice (plates, a log of slices), hollow (a shell, a frame), multiply (stacks, chains, a still-life), pierce (a rod), turn to glass (a twin, a vitrine), lean or spin.
- **The accent** is tinted glass or an inlay at the point of the move, and nothing else is coloured.
- **The rig:** three-quarter view from about 30° above, long lens; a soft key light from upper left that lights the top face, a crisp cool rim light on every edge, a faint fill so the shadow sides stay readable. The ground is a flat, evenly lit light-grey seamless (#A8ABB0) with no vignette, the object floating in front of it and casting no shadow, there only so the cut can remove it. It is light on purpose: the Unit is dark, and wherever the ground darkens (a dark ground, or the vignette the model adds to a mid-grey one) the shadow faces match the floor and the cut bites them away.
- **Series distinctness:** cards that share a hue take different moves and different outlines (tall, wide, stacked, split, spread).
- **No text:** captions belong to the page's HTML, never the image.

### Deliver

The raw generation and the cut master stay in the staging directory. The site copy is a transparent WebP at 1600×900 (`CutHero.ts … --webp <site path>`; `identify -format "%[channels]"` reads `srgba`), with alt text that describes what the image shows.

## Inputs

The card's text (read whole, not the tagline), its slug, its accent hex and colour name, and the run's `Direction.md` and `Brief.json`. The contract requires `lifeos-heroes/{slug}/unit.json` relative to the generation working directory before any render.

## Tool contract

### Prompt template (tool contract)

Fill every slot; keep the rig paragraph verbatim so the series stays one series.

```text
Studio product photograph, 16:9, of the Unit: one single solid seamless cube with softly radiused edges in satin dark-graphite ceramic, one shade lighter than a near-black page, with a thin brushed graphite-aluminium band around its waist and no other seams. Where the object below uses several Units, each one is a separate whole cube of this kind.
THE OBJECT: {MOVE as physical parts: what the Unit becomes, exact small counts, where each piece sits}
ACCENT: {COLOR NAME} {HEX} only on {ACCENT}, as tinted glass or an inlay with a restrained inner glow and no bloom. Nothing else is coloured; every other surface is neutral graphite or brushed aluminium.
LIGHT AND CAMERA: three-quarter view from about 30 degrees above, long lens. Soft key light from upper left lighting the top faces, a crisp cool rim light tracing every outer edge so each face will separate from a near-black page, a faint fill so the shadow sides stay readable. The object floats in front of a plain, flat, evenly lit light-grey seamless studio backdrop (#A8ABB0) that is the same light grey everywhere in the frame, top to bottom and corner to corner, with no vignette, no darkening toward any edge, and no floor: it casts no shadow and no reflection, so every dark face of the object stands out sharply against the light grey.
COMPOSITION: the object centred, filling about 55-65 percent of the frame width, every part inside the middle of the frame, a large simple outline that reads when shrunk to a small thumbnail, at most seven pieces.
Entirely unmarked, uninscribed surfaces: no letters, no numerals, no glyphs, no symbols, no logos anywhere in the image.
```

Words that pull the model toward stock tech art are banned by the contract above and stay out of the prompt, including in negative phrasing. Translate card nouns into physical ones ("a slot", "a stepped face") rather than naming devices.

### Generate

Run from the directory that holds `lifeos-heroes/{slug}/unit.json`:

```bash
bun ~/.claude/skills/Art/Tools/Generate.ts --intent=LifeOSHero --slug {slug} \
  --model nano-banana-pro --size 2K --aspect-ratio 16:9 --no-signature \
  --prompt "$(cat lifeos-heroes/{slug}/unit-prompt.txt)" \
  --output lifeos-heroes/{slug}/{slug}-u1.png
```

For series consistency, pass one or two already-approved Units as `--reference-image` once the first anchors pass. Keep the raw generation and cut it:

```bash
bun ~/.claude/skills/Art/Tools/CutHero.ts lifeos-heroes/{slug}/{slug}-uN.jpg \
  --out lifeos-heroes/{slug}/{slug}-uN-cut.png --preview lifeos-heroes/{slug}/preview \
  --solid --webp <site path>
```

It prints one JSON line and exits 1 when the result has no real alpha, a frame edge that is not clear, or implausible subject coverage (contract: `Tools/CutHero.help.md`).

### Verify before judging

Read every candidate with the Read tool. Any glyph-like mark fails it. Composite the cut on #0A0A0C and judge whether every face separates from the page; a face that disappears into the page fails it. Measure the accent hue and walk the CHECKS from `unit.json` against the pixels.

### Quality loop

Run through `Skill("ArtDirection")`: `skills/ArtDirection/Tools/Critique.ts` per card (brief: the run's `Brief.json`), iterate on the named defects, and critique the series together as a contact sheet as well. Bar: median 8.5, both vendors within 0.5, zero critical defects. A card that stops improving is reported with its score and remaining defects.

## Gotchas

- **Nano Banana Pro drifts hue on named colours.** Always pass the hex and a colour name together, and measure the result.
- **Black on black disappears once cut (2026-10-19).** A pure-black cube read only by its top highlight on the near-black page. The Unit is satin dark graphite one shade lighter than the page, with a rim light on every edge; judge the cut on #0A0A0C, never the raw.
- **Surface-only moves read as 27 identical cubes.** A notch, a groove or an engraved ripple vanishes at thumbnail size; pick a move that changes the outline.
- **Dark on dark cannot be cut (2026-10-19).** On a dark ground the Unit's shadow faces were the same tone as the floor, and both CutHero and a bare birefnet mask bit away the lower faces of the cube. A mid-grey ground was not enough: the model darkens it toward the bottom, and four of 27 cuts shipped with chunks missing from the cube's base (caught by the principal, not the contact sheet). The ground is light grey with no vignette; a candidate whose ground darkens near the object is regenerated. No pixel check catches a bite, because the bitten pixels match the dark ground beside them.
- **Judge every cut at full size against its raw (2026-10-19).** Contact sheets at 480px hid those four bites. Composite each cut on a loud colour (magenta) beside its raw at 640px or more and compare the silhouettes edge by edge before anything ships.
- **Glass carries the ground.** Tinted glass shows the grey ground through it, and the cut keeps that as tint inside the glass. Keep glass deeply tinted so it reads as coloured glass, not a grey patch.
- **Device nouns invite pseudo-text.** "Gauge", "dial", "panel" and "plate" get fake markings unless the prompt says the faces are blank.
- **Plain rembg leaves ground behind (2026-09-27).** `CutHero.ts` exists for this; do not reach for `--remove-bg`.
- **The meaning ladder rarely clears rung 3 with no text in the image.** Pick by critique median and the CHECKS, and say so in the report.
