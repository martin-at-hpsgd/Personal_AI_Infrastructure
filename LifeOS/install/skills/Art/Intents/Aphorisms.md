# Visual Aphorisms & Quote Cards Intent

> **Palette.** The colour names and hex values in this intent are the skill's neutral defaults (indigo `#2B4C7E` primary accent, green `#3A7D44` secondary accent, umber `#A0522D` warm wash, `#F5F5F0` paper ground). When `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md` § Color palette exists, use its value for each role instead, in prompts, validation and checklists alike, and name its colour words where this file names the defaults.

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Gotchas · Output format · Examples

**Aphorisms as shareable visual quote cards using editorial aesthetic.**

## Ideal State

- An aphorism selection (the exact quote in all-caps, its word count, the insight that makes it shareable, the tiny accent element) and a typography layout plan (arrangement, line breaks, word hierarchy, accent placement and size, colour scheme) existed before the prompt was built, in the shapes under Output format.
- The quote on the card matches the selected quote letter for letter: no missing, doubled, swapped or garbled characters.
- The quote is punchy and memorable, ideally 2-8 words, and it IS the visual: massive, all-caps, hand-lettered display typography with imperfect, gestural character shapes, filling 80-90% of the frame.
- The quote is instantly legible even at thumbnail size: high-contrast text that pops from a flat, solid background (black text on light, or white text on dark).
- One minimal, hand-drawn accent element, 5-10% of the image area, reinforces the idea and does not compete with the quote; it is never a full illustration or scene.
- Indigo #2B4C7E is present somewhere (text, accent or background), and the palette stays minimal: quote + accent + background = 3 colors max.
- The card is square 1:1 and works as a shareable social media post.

## Anti-criteria

- A perfect digital font instead of hand-lettering.
- A busy background or complex illustration, or an accent element competing with the quote.
- Low contrast or tiny text that cannot be read at thumbnail size.
- Gradients or shadows.
- Any aspect ratio other than 1:1.
- A misspelled or altered quote.

## Inputs

**Use this intent for:**
- Social media quote cards (LinkedIn, Instagram, X)
- Newsletter pull quotes
- Aphorisms as standalone images
- Thought leadership visuals
- "MAPS NEED MARGINS" style statements
- Memorable insights amplified visually

## Tool contract

**Always 1:1 (square)** — Optimized for social media (Instagram, LinkedIn, X)

```bash
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --intent=Aphorisms \
  --model nano-banana-pro \
  --prompt "[YOUR PROMPT]" \
  --size 2K \
  --aspect-ratio 1:1 \
  --output /path/to/aphorism.png
```

**Model Recommendation:** nano-banana-pro — the default. Use flux only when you want stylistic variety; flux takes the aspect ratio as `--size` (`--model flux --size 1:1`, no `--aspect-ratio`), and `--size 2K` fails validation for it (`References/Models.md`).

## Gotchas

Prompt fixes when a validation check fails:

| Problem | Fix |
|---------|-----|
| Text too small | "MASSIVE hand-lettered typography filling 85% of frame" |
| Looks like digital font | "Hand-drawn display letters, imperfect wobbly strokes, gestural quality" |
| Accent too busy | "MINIMAL accent: small simple [element], 8% of image, subtle" |
| Can't read thumbnail | Increase text size, stronger contrast, simplify layout |
| No brand presence | "Indigo (#2B4C7E) on [accent element / text / background]" |
| Too complex | "Typography IS the visual — quote dominant, minimal everything else" |

## Output format

Palette:
- Typography: Black #000000 (most common), Deep Indigo #2B4C7E (full text in brand color), or White #FFFFFF on a dark background.
- Accent element: Deep Indigo #2B4C7E, or Deep Green #3A7D44 as the alternative.
- Background: Light Cream #F5E6D3 (most common), White #FFFFFF, Black #000000 (white text), or Deep Indigo #2B4C7E (white text).

Aphorism selection, recorded before the layout:

```
APHORISM: "[Quote in all-caps]"
LENGTH: [X words]

INSIGHT: [Why this quote resonates]

ACCENT ELEMENT: [Tiny illustration, e.g.:]
- "scatter of dots" for entropy
- "em dash symbol" for typography topic
- "lightning bolt" for insight moment
- "simple line drawing" reinforcing concept
```

Typography layout plan, recorded before the prompt; the arrangement is one of:

   - All one line (short quote)
   - Multiple lines (longer quote)
   - Stacked words (vertical emphasis)
   - Asymmetric layout (dynamic placement)

```
TYPOGRAPHY LAYOUT:
[Describe arrangement, e.g.:]
- "MAPS NEED" on first line
- "MARGINS" on second line (larger)
- All-caps hand-lettered display style, massive bold letters
- Fills 80% of image area
- Hand-lettered imperfection

ACCENT ELEMENT:
- Small scatter of dots (entropy visual)
- Indigo (#2B4C7E) colored
- Position: Bottom right corner
- Size: ~8% of image
- Does NOT compete with text

COLOR SCHEME:
- Text: [Black / Indigo / White]
- Background: [Cream / White / Black / Indigo]
- Accent: [Indigo / Green]
```

### Prompt Template

```
Typographic quote card in editorial hand-lettered style.

STYLE REFERENCE: Bold typography poster, quote card, hand-lettered aphorism

BACKGROUND: [Light Cream #F5E6D3 / White #FFFFFF / Black #000000 / Indigo #2B4C7E] — flat, solid

AESTHETIC:
- Typography as the primary visual (dominates composition)
- Hand-lettered display style (imperfect, gestural, bold)
- Massive scale lettering (fills 80-90% of frame)
- Minimal accent illustration (subtle, not competing)
- High contrast for readability
- Square 1:1 format

QUOTE CARD STRUCTURE:

TYPOGRAPHY (Hand-Lettered Block Display - MASSIVE):
"[APHORISM TEXT IN ALL-CAPS]"

- Font: display style extra bold, hand-lettered, all-caps
- Size: MASSIVE — fills most of image area
- Layout: [Single line / Multi-line / Stacked words]
- Line breaks: [Where breaks occur for rhythm]
  Line 1: "[FIRST PART]"
  Line 2: "[SECOND PART]" (optionally larger)
- Color: [Black #000000 / Indigo #2B4C7E / White #FFFFFF]
- Style: Hand-lettered with imperfections (not perfect digital font)
- Variable letter sizing for emphasis
- Letters should have character and personality

ACCENT ILLUSTRATION (Minimal):
- [Small simple element, e.g., "scattered dots", "small em dash", "lightning bolt"]
- Hand-drawn, simple, editorial style
- Position: [Bottom right / Top left / etc. — does NOT interfere with text]
- Size: 5-10% of image area
- Color: [Indigo #2B4C7E / Green #3A7D44]
- Style: Imperfect sketch quality, matches text aesthetic
- Purpose: Subtle visual reinforcement, NOT competing focal point

COLOR USAGE:
- Background: [Color choice] — flat solid fill
- Typography: [Color choice] — high contrast with background
- Accent element: [Indigo or Green]

CRITICAL REQUIREMENTS:
- Typography is HERO (quote fills 80-90% of frame)
- Hand-lettered quality (wobbly lines, imperfect character shapes)
- NOT a digital font — should feel hand-drawn
- Accent illustration MINIMAL (does not distract from quote)
- High contrast readability (text must pop from background)
- Square 1:1 aspect ratio
- No gradients, flat colors only
- Shareable social media quality
```

## Examples

### Example 1: "MAPS NEED MARGINS"
- **Typography:** Two lines, "MARGINS" larger
- **Accent:** Small scatter of indigo dots (bottom right)
- **Background:** Light cream
- **Text:** Black
- **Use:** LinkedIn post, newsletter pull quote

### Example 2: "KERNING IS A KINDNESS"
- **Typography:** Stacked words, "KERNING" emphasized
- **Accent:** Two small indigo letterforms nudged together
- **Background:** White
- **Text:** Black
- **Use:** X post about typography

### Example 3: "TOOLS REMEMBER THEIR MAKERS"
- **Typography:** Three lines, "TOOLS" and "MAKERS" larger
- **Accent:** Tiny hammer + human hand (indigo, minimal)
- **Background:** Black
- **Text:** White (high contrast)
- **Use:** Instagram thought leadership post

### Example 4: "LOCKS ARE PROMISES"
- **Typography:** Two lines
- **Accent:** Small indigo padlock with a heart-shaped keyhole
- **Background:** Indigo #2B4C7E
- **Text:** White
- **Use:** Bold brand statement
