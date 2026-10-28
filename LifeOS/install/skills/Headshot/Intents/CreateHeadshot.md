# CreateHeadshot

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Output format

A professional AI headshot of the principal, generated with `Tools/Headshot.ts` from approved reference photos and staged for review.

## Ideal State

- The face is recognizably the principal: every face reference came from the approved pool in `Config.md` (`Headshot.ts references`) or from the principal, chosen so its energy matches the target expression. Every approved reference whose energy matches goes in (a quick draft may use one or two), plus at most one video frame as a context reference for clothing and setting continuity; a real photo owns the face.
- Studio-context outputs (posters, podcast stills) carry a scene plate from `Config.md` § Scene plates as a reference with an instruction to composite.
- The prompt is the Default Prompt baseline filled with the look from `Config.md` § Default look, customized as needed for what the principal requested (the background, attire and mood variations under Inputs), with mood described as a scenario rather than facial mechanics.
- The image is at the size and aspect ratio the request maps to in the Intent-to-Flag Mapping (2K and the use-case ratio by default).
- The image is saved to `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Headshot/generated-headshots/` as `YYYY-MM-DD-HHMMSS_[description].png`, the description kebab-case and naming the key elements (attire, accessories, mood).
- Anything a human will look at has passed the SKILL.md quality loop: a `Skill("ArtDirection")` critique, then hand-over through `skills/ArtDirection/Tools/Deliver.ts`. The principal is told where it landed and asked whether anything should be adjusted.
- For a public-facing likeness (site poster, thumbnail, profile image anywhere public), 2–4 variants exist as a labeled pick sheet, and the principal picked one before anything shipped.
- Every adjustment round is a new timestamped file beside the earlier ones, so history is preserved, and each round's fix reconsiders the references before the prompt (energy mismatch is the usual root cause), then the prompt elements, then a different aspect ratio or a 4K render for more detail.

## Anti-criteria

- Never runs generation when `Headshot.ts check` fails; it reports what the check printed and stops.
- References are never generated images or rejected generations; only photos listed in `Config.md` or supplied by the principal.
- Mood is never prompted as muscle-level facial mechanics ("corners of mouth lifted", "jaw set"); those produce uncanny, posed results.
- For a public-facing likeness (site poster, thumbnail, profile image anywhere public), never single-shot-ship the face, and never iterate on the live asset — stage variants, the principal approves one, swap once.
- No headshot is written into the skill tree.
- No generation at lower resolution than 2K unless the principal explicitly asks for it.
- A raw generation or pick sheet is never opened for the principal or written to ~/Downloads outside `Deliver.ts`.

## Inputs

### Default Prompt

Run `bun ~/.claude/skills/Headshot/Tools/Headshot.ts config` and read `look.attire`, `look.backdrop` and `look.mood`. Substitute them for `{attire}` and `{backdrop}`; when a key is absent use `dark smart casual blazer` and `clean neutral gray gradient background`. Use this prompt as the baseline (customize as needed):

```
Professional studio portrait photograph, chest-up framing with generous headroom, subject looking directly into camera, {attire}, {backdrop}, soft diffused key lighting with gentle fill, subtle catchlight in eyes, shallow depth of field with crisp eye focus and soft bokeh, visible fabric texture and natural skin detail, confident and approachable expression, clean contemporary color grading with subtle warmth, cinematic quality, 8K ultra-detailed
```

Reference selection doctrine: `References/ReferenceLibrary.md`.

The default prompt works well for standard professional headshots. Modify if the principal requests:

**Background variations:**
- Default: the `backdrop` from Config.md
- Neutral: `clean neutral gray gradient background`
- White: `pure white seamless studio background`
- Dark: `deep charcoal studio background`

**Attire variations:**
- Default: the `attire` from Config.md
- Formal: `tailored navy suit jacket with crisp white dress shirt`
- Casual: `quality black crew neck t-shirt`
- Tech: `dark henley with subtle texture`

**Mood — describe the scenario, not facial mechanics:**
- Default: the `mood` from Config.md, or `the relaxed confidence of talking about work they know deeply`
- Welcoming: `greeting a colleague they respect and are glad to see`
- Presenter: `about to walk someone through a product they're proud of`
- Thoughtful: `considering a good question before answering`

## Safety gates

When the output is a public-facing likeness (site poster, thumbnail, profile image anywhere public): generate 2–4 variants, montage them into a labeled pick sheet in `generated-headshots/`, deliver it through `Deliver.ts`, and get the principal's pick before anything ships:

```bash
magick montage v1.png v2.png v3.png -tile 3x1 -geometry +4+4 -background black ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Headshot/generated-headshots/${TIMESTAMP}_pick-sheet.png
```

Shipping each attempt before approval turns one profile photo into a string of live swaps.

## Tool contract

References come from the approved pool in `Config.md`, chosen by target energy:

```bash
bun ~/.claude/skills/Headshot/Tools/Headshot.ts references                    # every approved photo
bun ~/.claude/skills/Headshot/Tools/Headshot.ts references --sentiment positive   # e.g. the real smiling photo
```

Filename example: `2026-01-15-093012_navy-blazer-gray-backdrop-smiling.png`.

- **Available Sizes:** 1K, 2K, 4K
- **Aspect Ratios:** 1:1 (square), 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9
- **Recommended for Headshots:** 2K at 1:1 or 3:4

### Intent-to-Flag Mapping

#### Size Selection

| User Says | Flag | When to Use |
|-----------|------|-------------|
| "draft", "quick", "preview" | `--size 1K` | Fast iterations |
| (default), "standard" | `--size 2K` | Standard output |
| "high res", "final", "print" | `--size 4K` | Maximum quality final output |

#### Aspect Ratio

| User Says | Flag | Use Case |
|-----------|------|----------|
| "avatar", "profile", "square" | `--aspect-ratio 1:1` | Social profiles, avatars |
| "portrait", "headshot" | `--aspect-ratio 3:4` | Traditional portrait format |
| "banner", "wide", "header" | `--aspect-ratio 16:9` | Banners, video thumbnails |
| "social story", "vertical" | `--aspect-ratio 9:16` | Instagram/TikTok stories |

#### Reference Images

| Use Case | References | Why |
|----------|------------|-----|
| Best likeness | Every energy-matched approved reference (Ideal State) | More angles = better match |
| Quick draft | 1-2 references | Faster generation |
| Specific angle | Match reference angle to desired output | Better pose matching |

### Generate Command

`--reference` repeats once per reference image.

```bash
# Generate timestamp
TIMESTAMP=$(date +%Y-%m-%d-%H%M%S)
DESCRIPTION="blazer-gray-background"  # Customize based on request

bun ~/.claude/skills/Headshot/Tools/Headshot.ts \
  --prompt "[CUSTOMIZED PROMPT]" \
  --reference [PATH FROM `references` OUTPUT] \
  --reference [SECOND PATH] \
  --size [SELECTED_SIZE] \
  --aspect-ratio [SELECTED_RATIO] \
  --output ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Headshot/generated-headshots/${TIMESTAMP}_${DESCRIPTION}.png
```

### Hand-over

After a passing critique, `Deliver.ts` copies the image or pick sheet out of `generated-headshots/`; it exits 1 without a passing critique:

```bash
bun ~/.claude/skills/ArtDirection/Tools/Deliver.ts --artifact <generated file> --critique <Critique.json> --to ~/Downloads
```

## Output format

Inform the principal, adding the `Proof:` line when `Deliver.ts` printed one:
> "Headshot delivered to `~/Downloads/[filename]` (original in `generated-headshots/[filename]`). Want me to adjust anything?"
