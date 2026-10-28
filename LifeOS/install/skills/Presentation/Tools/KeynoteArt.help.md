# KeynoteArt — draw and place the art a Keynote deck still needs

**Single purpose.** For every slide in a deck's KEYNOTE.json that has an art brief and no image, make the image and place it. The slide's art type picks the Art intent: `essay` → Essay, `diagram` → TechnicalDiagrams.

## Usage

```bash
bun KeynoteArt.ts --read <READ.md> [--only <slide>[,…]] [--candidates 2] [--rounds 4]
                  [--concurrency 5] [--compose-only] [--force-compose]
bun KeynoteArt.ts --read <READ.md> --status
bun KeynoteArt.ts --self-test
```

## Behaviour

- **Compose.** An opus-tier model writes each slide's scene (essay) or diagram spec (components, layout, insights) from the art direction, the story explanation, the slide's title and spoken lines, and the designer's brief. Essay slides also get the Essay contract's `cse.md` and `composition.md` under `art/scratchpad/art/<slug>/`. Every prompt is dry-run through `Generate.ts` and recomposed if the intent contract refuses it. Prompts are kept in `art/prompts/<slug>.txt`; `--force-compose` rewrites them.
- **Candidate names** carry a hash of the composed prompt, so recomposing never reuses an old drawing; an interrupted run with the same prompt resumes where it stopped.
- **Slugs** are the section hash's first 8 characters plus the slide's index in the section, so they survive reordering the talk.
- **Draw and normalize.** Candidates go to `<Downloads>/<talk folder>-art/raw/`, are cropped to exactly 16:9 (full essay), 21:9 (full diagram, placed below the title) or 3:2 (split), and have their paper mapped to `art.paper`.
- **Title zone.** On full essay slides the area the slide's title and subtitle cover must stay nearly empty (≤1.2% dark pixels); a candidate that fails is not critiqued.
- **Critique.** ArtDirection `Critique.ts` scores each candidate against `Brief.json` or `Brief-diagram.json` at bar 8.5. Defects from the best candidate feed the next round.
- **Place.** Passing winners go through Assay Proof and ArtDirection Deliver into the deck's images folder. A slide still below the bar after the last round gets its best candidate copied in and is reported. KEYNOTE.json is updated; rebuild the deck with Keynote.ts.
- Results accumulate in `art/results.json`.

## Exit codes

0 every slide passed · 1 a slide fell short or failed · 2 usage or missing inputs.

## Gotchas

- Image models draw quoted words and slide titles into the picture, so essay prompts carry neither; diagram prompts say outright that there is no title block.
- `Generate.ts` signs and trims Essay and TechnicalDiagrams output by default; slides pass `--no-signature`, which also skips the trim, so the reserved title area survives.
- Private material can't go to every critique vendor, so the panel may be one vendor and record `vendor_missing`. That is expected.
