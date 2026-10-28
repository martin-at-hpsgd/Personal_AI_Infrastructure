---
provenance: template
version: 1.0.0
---

# Assay Preferences — this install

Optional. Install-specific rulings and history the Assay skill reads at run time. Delete this file to keep the skill's defaults: image suites with no `USER/CONFIG/vision-judge.json` entry are judged by the OpenAI + Anthropic panel.

## Judge providers

Your rulings on which vendors may judge what, each with its date. Made-up examples:

- ExampleNet never judges private images (Alex Example, 2026-01-15). It receives only public material, and only with the explicit `--public` flag.
- Identity-bearing images (paths matching `/headshot/i`) are not sent to any vision judge without `--allow-identity`.

## History

Optional dated notes on why the rulings above exist, for example: 2026-01-10, an unlisted image suite defaulted to a vendor that refused private frames, so no visual suite produced a verdict until the default changed.
