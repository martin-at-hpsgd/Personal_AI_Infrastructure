# Models, sizes and reference images

Moved out of `SKILL.md` § Tool contract. The default command there (`--model nano-banana-pro --size 2K --aspect-ratio 16:9`) needs nothing from this file; read it when a run changes model or size, passes `--reference-image`, or maps a request's words to flags.

## Models and sizes

The default model is the one `PREFERENCES.md` pins (SKILL.md § Data & Config); without one it is nano-banana-pro (Gemini 3 Pro). Each model accepts a different `--size` format, and the wrong one fails validation; nano-banana-pro uses `--size` for resolution (1K/2K/4K) and a separate `--aspect-ratio` flag, so don't pass aspect ratio values to `--size`:

| Model | `--size` format | Valid values | Default |
|-------|----------------|--------------|---------|
| `flux` | Aspect ratio | `1:1`, `16:9`, `3:2`, `2:3`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `21:9` | `16:9` |
| `nano-banana` | Aspect ratio | `1:1`, `16:9`, `3:2`, `2:3`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `21:9` | `16:9` |
| `nano-banana-pro` | Resolution tier | `1K`, `2K`, `4K` (also accepts `--aspect-ratio` separately, default `16:9`) | `2K` |

| Job | Model | Why |
|-----|-------|-----|
| Everything by default — editorial illustration, blog headers, text-heavy stat cards, frameworks, taxonomies, timelines, aphorism cards | `nano-banana-pro` | Best composition fidelity for the user's editorial aesthetic, and strong enough on labels and numbers to carry the text-heavy intents too. |
| Stylistic variety / non-photoreal / crisper technical linework | `flux` | Different aesthetic register. |
| Faster iteration once the composition is settled | `nano-banana` | Quicker, slightly lower fidelity. |

An intent that pins a model (Essay uses only `nano-banana-pro`) overrides this table.

## Reference images

Repeat `--reference-image` for character or style consistency:

```bash
bun run ${LIFEOS_SKILL_DIR}/Tools/Generate.ts \
  --intent=<IntentName> \
  --model nano-banana-pro \
  --prompt "Person from references at a party..." \
  --reference-image face1.jpg \
  --reference-image face2.jpg \
  --reference-image face3.jpg \
  --size 2K \
  --aspect-ratio 16:9 \
  --output "$ART_DIR"/character-scene.png
```

Gemini limits: up to 5 human reference images, up to 6 object reference images, and a maximum of 14 total reference images per request.

- **Reference-image edits: negative text loses to the reference (2026-07-09, a background-edit session).** When nano-banana-pro keeps reproducing an unwanted object that exists in the reference photo (e.g. a duplicated prop), "do NOT add/duplicate" prompt language fails on most rolls — the model preserves what it sees over what you forbid. Fix: roll until one output has the corrected composition, then use that output as the new `--reference-image` for the remaining variations; the later rolls then complied. Editing the reference beats describing the edit.

## Essay flags by request

Moved out of `Intents/Essay.md` § Step 6: Generation. How an Essay request's words map to `Generate.ts` flags:

| User Says | Flag | Effect |
|-----------|------|--------|
| "thumbnail", "small" | `--size 1K` | Quick previews |
| (default), "standard" | `--size 2K` | Standard blog headers |
| "high res", "large", "print" | `--size 4K` | Maximum resolution |
| (default), "wide", "landscape", "banner" | `--aspect-ratio 16:9` | Default: fills the full post width |
| "square" | `--aspect-ratio 1:1` | Only on explicit request; fails the page-width gate unless the art is wide after trim |
| "portrait", "vertical" | `--aspect-ratio 9:16` | Vertical content |
| "ultrawide" | `--aspect-ratio 21:9` | Cinematic banners |
| "blog header" (default) | `--thumbnail` | Creates transparent + thumb versions |
| "transparent only" | `--remove-bg` | Just removes background |
| "with reference", "style like" | `--reference-image <path>` | Uses reference for style guidance |
| "variations", "options" | `--creative-variations 3` | Generates multiple versions |
