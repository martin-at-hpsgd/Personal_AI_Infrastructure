# Stats

> **Palette.** The colour names and hex values in this intent are the skill's neutral defaults (indigo `#2B4C7E` primary accent, green `#3A7D44` secondary accent, umber `#A0522D` warm wash, `#F5F5F0` paper ground). When `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md` § Color palette exists, use its value for each role instead, in prompts, validation and checklists alike, and name its colour words where this file names the defaults.

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Gotchas · Output format · Examples

Single striking statistics illustrated as visual data points in the house aesthetic: one number made visual with a small illustration showing what it means, a memorable single-stat card in editorial style designed for newsletters and social media.

## Ideal State

- A statistic selection (Step 1 shape under Output format) existed before the prompt was written: the exact number and metric, its source, the context (what it represents and why it matters), and the small illustration that shows it.
- The number is accurate and sourced: it matches the source the principal gave or a cited primary source, with the same unit, scale and qualifier (`%`, `$`, `B`, `X`, "of developers"), and the source is named in the hand-back.
- Every digit, symbol and decimal point in the image matches the Step 1 statistic character for character: no garbled, dropped, extra or reordered digits. An image whose number differs from the statistic in any character is a failure however good it looks.
- The number dominates: it carries 60-70% of the visual weight, its glyphs span 50-60% of the image height, and it stays readable at thumbnail size.
- The number is hand-lettered with an imperfect, gestural stroke (not a digital font) and high contrast: indigo or black on a light background.
- The illustration is one small, simple icon (20-30% of the image) that shows what the statistic measures and never competes with the number.
- Metric and context text state what the number means, so the card is understood without the surrounding post.
- The PNG reaches Downloads only through ArtDirection's `Deliver.ts`, rendered in a working directory outside Downloads (SKILL.md § Output staging), at the aspect ratio its use case calls for (default 1:1).

## Anti-criteria

- Number too small (should dominate).
- Digital font rendering (should be hand-lettered).
- Complex detailed illustration (should be simple icon).
- Illustration competing with number.
- Low contrast (can't read number).
- Missing context (unclear what stat represents).
- A number that is unsourced, rounded differently from its source, or rendered with any wrong character.

## Inputs

The statistic to illustrate: the number and metric, and what it represents.

## Tool contract

Aspect ratio by use case (`--aspect-ratio`):

| Use Case | Aspect Ratio | Reasoning |
|----------|--------------|-----------|
| Social media post | 1:1 | Instagram/LinkedIn friendly |
| Newsletter inline | 16:9 | Horizontal fits email width |
| Vertical mobile | 9:16 | Instagram story format |
| Balanced | 1:1 | Works everywhere |

**Default: 1:1 (square)** — Most versatile for social/newsletter

```bash
ART_DIR=<working dir outside Downloads>   # e.g. scratchpad/art/<slug>; SKILL.md § Output staging
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --intent=Stats \
  --model nano-banana-pro \
  --prompt "[YOUR PROMPT]" \
  --size 2K \
  --aspect-ratio 1:1 \
  --output "$ART_DIR"/stat-card.png
```

nano-banana-pro is the default and only model for this intent. It renders numbers clearly within the editorial aesthetic.

Look at the image with the Read tool and compare the rendered number to the Step 1 statistic character by character before judging it. Open it for the principal only after the quality loop in SKILL.md passes:
```bash
bun ~/.claude/skills/ArtDirection/Tools/Deliver.ts --artifact "$ART_DIR"/stat-card.png --to ~/Downloads
open ~/Downloads/stat-card.png
```

## Gotchas

If validation fails, these prompt fixes apply:

| Problem | Fix |
|---------|-----|
| Number too small | "MASSIVE hand-lettered number filling 65% of image height" |
| Looks digital | "Hand-drawn display-style number, wobbly imperfect strokes" |
| Illustration too complex | "SMALL SIMPLE illustration, minimal detail, 25% of image size" |
| Can't read thumbnail | Increase number size, stronger contrast |
| Unclear meaning | Add metric text above: "of [X]", context below: "[what they do]" |
| No visual interest | "Small illustrated [icon] showing what stat represents" |

The 65% in the first fix pushes a number that came out too small; the delivered number is still judged against the 50-60% height rule in the Ideal State.

## Output format

### Step 1 statistic selection

```
STATISTIC: [Number + unit, e.g., "78%", "$2.1B", "3.5X"]
METRIC: [What's being measured]
SOURCE: [Who published it, with link or citation]

CONTEXT: [What this number represents]

ILLUSTRATION: [Small visual element, e.g.:]
- "Tiny developer at computer" for developer stat
- "Stack of coins" for money stat
- "Growing arrow" for growth stat
- Size: 20-30% of image, simple, not detailed
```

### Step 2 stat card layout

```
LAYOUT STRUCTURE:
- Number: [Placement, e.g., "Center dominant"]
- Size: [50-60% of image height]
- Illustration: [Placement, e.g., "Bottom right, 25% of image"]
- Metric text: [Above number]
- Context: [Below number in smaller text]

VISUAL RELATIONSHIP:
[How number and illustration interact, e.g.:]
- "78%" in massive indigo
- Small illustrated developer sitting on top of "%" symbol
- Text above: "of developers"
- Text below: "use AI tools daily"

COLOR SCHEME:
- Number: Indigo (#2B4C7E)
- Illustration: Black linework with indigo accents
- Background: Light cream
- Text: Charcoal
```

### Prompt Template

Palette, 2-3 colors total: number in Deep Indigo #2B4C7E (most common) or Black #000000; illustration in black linework with indigo or Deep Green #3A7D44 accents; Charcoal #2D2D2D context text; background Light Cream #F5E6D3 or White #FFFFFF. Put the exact Step 1 statistic in the prompt in quotes.

```
Illustrated statistic card in editorial style.

STYLE REFERENCE: Data visualization, stat card, number + icon illustration

BACKGROUND: [Light Cream #F5E6D3 / White #FFFFFF] — flat, clean

AESTHETIC:
- Number as dominant visual element (massive typography)
- Small simple illustration providing context
- Hand-drawn imperfect number rendering (not digital font)
- Editorial flat color with strategic indigo emphasis
- Scannable, immediate impact

STAT CARD STRUCTURE:

NUMBER TYPOGRAPHY (Hand-Lettered Block Display - MASSIVE):
"[STATISTIC]"

- Font: display style extra bold, hand-lettered
- Size: MASSIVE — glyphs span 50-60% of image height
- Color: [Deep Indigo #2B4C7E / Black #000000]
- Style: Hand-lettered with imperfections (wobbly lines, character)
- Position: [Center / Left / Top]
- Example: "78%" in giant indigo hand-lettered numbers

METRIC TEXT (Geometric Sans - Medium):
"[what the stat measures]"

- Font: geometric sans-serif
- Size: Medium readable (15-20% of number size)
- Color: Charcoal (#2D2D2D)
- Position: [Above / Below number]
- Example: "of developers" above the 78%

CONTEXT TEXT (Condensed - Small):
"[additional context]"

- Font: condensed sans
- Size: Small (10-15% of number size)
- Color: Charcoal (#2D2D2D)
- Position: [Below number / Bottom of card]
- Example: "use AI tools daily" below the number

ILLUSTRATION (Small, Simple):
[Describe the tiny illustration, e.g.:]
- Small hand-drawn [icon/figure]
- Hand-drawn black (#000000) linework
- Indigo (#2B4C7E) accents on [specific elements]
- Position: [Bottom right / Next to number / etc.]
- Size: 20-30% of image area
- Style: Simple sketch, not detailed
- Represents: [What the stat is about]
- Example: "Tiny developer sitting at computer with code on screen"

VISUAL INTERACTION:
[How illustration and number relate, e.g.:]
- Illustration positioned [near/on/beside] the number
- Creates visual story: "Developer represents the 78%"
- Illustration does NOT compete with number (stays small)

COLOR USAGE:
- Number: Deep Indigo (#2B4C7E) OR Black (#000000)
- Illustration linework: Black (#000000)
- Illustration accents: Indigo (#2B4C7E) OR Green (#3A7D44)
- Metric/context text: Charcoal (#2D2D2D)
- Background: Light Cream (#F5E6D3) OR White (#FFFFFF)

CRITICAL REQUIREMENTS:
- Number is HERO (dominates composition, 60-70%)
- Hand-lettered number quality (NOT digital font)
- Illustration SMALL and SIMPLE (supporting role, 20-30%)
- High contrast for readability
- Strategic indigo emphasis (number OR illustration accents)
- No gradients, flat colors only
- Immediately scannable (number jumps out at thumbnail)
- Square 1:1 or horizontal 16:9 format

```

## Examples

Use this intent for newsletter "by the numbers" sections, social media stat cards, quick visual facts and data highlights. The numbers below show the layout only; they are not sourced statistics.

### Example 1: "78% of developers use AI daily"
- **Number:** "78%" in massive indigo hand-lettering
- **Metric:** "of developers" above number
- **Context:** "use AI tools daily" below
- **Illustration:** Tiny developer at computer with AI sparkles (bottom right, 25%)
- **Aspect:** 1:1

### Example 2: "$2.1B invested in AI safety"
- **Number:** "$2.1B" in giant black hand-lettering
- **Metric:** "invested in" above
- **Context:** "AI safety research" below
- **Illustration:** Small stack of coins with shield symbol (indigo accents)
- **Aspect:** 1:1

### Example 3: "3.5X growth in AI adoption"
- **Number:** "3.5X" in massive indigo
- **Metric:** "growth in" above
- **Context:** "enterprise AI adoption" below
- **Illustration:** Upward arrow with small building icon
- **Aspect:** 16:9 (horizontal for newsletter)

### Example 4: "92% of security breaches involve humans"
- **Number:** "92%" in black bold hand-lettering
- **Metric:** "of breaches" above
- **Context:** "involve human error" below
- **Illustration:** Tiny person with open door/lock symbol (indigo accents)
- **Aspect:** 1:1
