---
provenance: template
version: 1.0.0
---

# Headshot — Config

Read by `Tools/Headshot.ts` (`check`, `config`, `references`) and by the CreateHeadshot intent. Setup guide: `skills/Headshot/Setup.md`.

## Reference photos

Directory: `~/Pictures/headshot-references`

Real photos of the subject that the subject has approved. The sentiment column drives `Headshot.ts references --sentiment <s>`. Never list generated or rejected images.

| File | Sentiment | Notes |
|------|-----------|-------|
| `alex-front.jpg` | neutral | straight to camera, even light |
| `alex-smile.jpg` | positive | warm, relaxed smile; the highest-energy photo |
| `alex-garden.jpg` | casual | outdoors, natural light |
| `alex-thinking.jpg` | thinking | looking slightly off camera |

## Default look

| Key | Value |
|-----|-------|
| `attire` | navy crew-neck sweater over a white collar |
| `backdrop` | soft warm gray studio backdrop |
| `mood` | the easy confidence of explaining something you enjoy |

## Scene plates

Optional real background photos to composite the subject into.

| Name | Path | Description |
|------|------|-------------|
| `office` | `~/Pictures/headshot-references/office-plate.jpg` | Empty office with a window on the left and a plant on the right. |

## Notes

Free text. The skill does not read this section.
