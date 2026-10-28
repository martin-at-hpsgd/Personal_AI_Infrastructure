---
provenance: template
version: 1.0.0
---

# HeadshotExamples — your approved reference photos

Real, approved photos of you, one expression per file, used as identity references by any thumbnail or headshot intent you add. `LIFEOS/TOOLS/PickExpression.ts --sentiment <neutral|positive|casual|curious|thinking>` selects from this pool by the sentiment tag you give each file.

The workflows name two files by default: `headshot-clean.png` (neutral, studio-clean) and `headshot-nah.png` (skeptical). Add those, or edit the workflow's `--reference` lines to your own filenames.

Fresh-install state: empty. An intent that needs a reference and finds none stops and asks for one.
