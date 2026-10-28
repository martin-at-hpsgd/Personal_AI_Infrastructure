# Illustrated Dichotomies & Comparisons Intent

> **Palette.** The colour names and hex values in this intent are the skill's neutral defaults (indigo `#2B4C7E` primary accent, green `#3A7D44` secondary accent, umber `#A0522D` warm wash, `#F5F5F0` paper ground). When `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md` § Color palette exists, use its value for each role instead, in prompts, validation and checklists alike, and name its colour words where this file names the defaults.

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Gotchas · Output format · Examples

**Hand-drawn side-by-side visual comparisons using the house aesthetic.**

## Ideal State

- A comparison definition (the two sides, the core contrast, a visual metaphor for each side, whether it is neutral or one side is preferred, the colour strategy) and a split layout plan (orientation, each side's metaphor, key elements and colour, the dividing line, the mirror elements) existed before the prompt was built, in the shapes under Output format.
- A clear split (vertical left/right, horizontal top/bottom, or diagonal) gives an obvious division between the two sides, through a dividing line or a visual separation; which side is which is never in doubt, and side names and annotations are spelled exactly as given and legible.
- The difference is readable with the colour removed: each side is drawn from iconography a reader recognizes as that side (spaghetti code against one straight line, fancy locks on a cardboard door against plain solid construction), so the two sides differ in shape and subject, never the same drawing painted two colours. The metaphors do the talking, with minimal text.
- Both sides carry equal visual weight and the same hand-drawn editorial style: imperfect, gestural black linework, flat colors, house aesthetic. The mirror structure is in the frame (parallel slots, matching label positions), never in the content.
- Colour distinguishes the sides by one of the strategies under Output format: Indigo #2B4C7E accents on one side and Green #3A7D44 on the other; or Indigo on the preferred side and black on the alternative; or, for a neutral comparison, both sides in black linework with subtle indigo/green accents. Any dividing line is always black.
- When the comparison includes human or robot figures, they follow the figure style `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md` § Figure style sets when present, else simplified, stylized editorial figures with adult proportions, minimal faces and emotion through gesture and silhouette, never cartoonish. Every person follows the figure treatment (SKILL.md § Gotchas: `PREFERENCES.md` § Character design when set, else a varied cast whose appearance the prompt names), and the prompt says so.

## Anti-criteria

- Unbalanced sides (one dominates).
- Unclear which is which, or a missing dividing line or separation.
- A corporate comparison chart look.
- Gradients or photorealistic elements.
- Cluttered or confusing visuals.
- Same shape, different paint: two sides built from the same form and told apart only by colour. Essay's Opposite-Concept Asymmetry Gate records this exact failure, rejected in review on 2026-05-20, because symmetry collapses the contrast.
- A group of figures that reads as one ethnicity by the model's default, or that breaks the figure treatment set in PREFERENCES.md.

## Inputs

**Use this intent for:**
- "X vs Y" comparisons
- Before/After transformations
- This/That contrasts
- Junior vs Senior behaviors
- Old way vs New way
- Opposite approaches

## Tool contract

| Split Type | Aspect Ratio | Reasoning |
|------------|--------------|-----------|
| Vertical split (left/right) | 16:9 or 21:9 | Wide for side-by-side |
| Horizontal split (top/bottom) | 9:16 or 1:1 | Vertical or square for stacking |
| Square balanced | 1:1 | Symmetric comparison |
| Social media | 1:1 | Instagram/LinkedIn friendly |

**Default: 16:9 (horizontal)** — Classic side-by-side comparison

```bash
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --intent=Comparisons \
  --model nano-banana-pro \
  --prompt "[YOUR PROMPT]" \
  --size 2K \
  --aspect-ratio 16:9 \
  --output /path/to/comparison.png
```

**Model Recommendation:** nano-banana-pro or flux (both work well for split compositions). For flux, swap the size flags for `--size 16:9` (no `--aspect-ratio`); `--size 2K` fails validation for flux (`References/Models.md`).

## Gotchas

Prompt fixes when a validation check fails:

| Problem | Fix |
|---------|-----|
| Sides unclear | "Strong black dividing line down center, clear LEFT: vs RIGHT: labels" |
| Not balanced | "Equal visual weight, mirror structure, parallel composition both sides" |
| Contrast weak | "Stronger metaphor contrast: [Side A metaphor] vs [Side B opposite metaphor]" |
| Too complex | Simplify each side to single clear metaphor |
| Colors confusing | "Indigo accents left side only, Green accents right side only" |
| Looks corporate | Reference "editorial split composition, hand-drawn contrast illustration" |

## Output format

Colour strategies:
- Balanced comparison: Indigo left, Green right
- Value judgment: Indigo on better side, black on other
- Neutral: Both black with subtle indigo/green accents

Black #000000 carries the dividing line and all linework on both sides; Charcoal #2D2D2D carries all text and labels. The background is White #FFFFFF or Light Cream #F5E6D3 on both sides, or a very subtle Light Indigo tint left and Light Green tint right.

Comparison definition, recorded before the layout:

```
COMPARISON: [Side A] vs [Side B]

CORE CONTRAST: [What's fundamentally different]

VISUAL METAPHORS:
- Side A: [Metaphor showing this approach/state]
- Side B: [Contrasting metaphor]

VALUE JUDGMENT:
- [Neutral comparison] OR [Side X is preferred]

COLOR STRATEGY:
- [Indigo left / Green right] OR [Indigo on preferred, black on alternative]
```

Split layout plan, recorded before the prompt:

```
SPLIT ORIENTATION: [Vertical left/right / Horizontal top/bottom]

LAYOUT STRUCTURE:
Left/Top: [Side A]
- Metaphor: [What to illustrate]
- Key elements: [Specific visual details]
- Color: [Indigo accents / Black only]

Right/Bottom: [Side B]
- Metaphor: [Contrasting illustration]
- Key elements: [Specific visual details]
- Color: [Green accents / Black only]

DIVIDING LINE:
- [Strong black vertical/horizontal line] OR [Soft separation] OR [No line]

MIRROR ELEMENTS:
- [What appears on both sides for parallel structure]
```

### Prompt Template

```
Hand-drawn split composition comparing two contrasting concepts in editorial style.

STYLE REFERENCE: Magazine comparison spread, split-screen editorial illustration, before/after visual

BACKGROUND: [White #FFFFFF OR Light Cream #F5E6D3] — clean, flat, both sides

AESTHETIC:
- Split composition with [vertical/horizontal] division
- Hand-drawn black linework on both sides (imperfect, gestural)
- Mirror structure showing parallel concepts with visual contrast
- Editorial flat color with strategic indigo/green differentiation
- Variable stroke weight, organic lines

SPLIT ORIENTATION: [Vertical left-to-right / Horizontal top-to-bottom]

COMPOSITION STRUCTURE:
- Clear [vertical/horizontal] division creating two equal sections
- [Black dividing line] OR [Visual separation through composition]
- Left/Top: [Side A name]
- Right/Bottom: [Side B name]

TYPOGRAPHY SYSTEM (3-TIER):

TIER 1 - COMPARISON TITLE (Hand-Lettered Block Display):
- "[SIDE A] VS [SIDE B]" — Large at top
- Font: display style, extra bold, hand-lettered, all-caps
- Size: 3x larger than body text
- Color: Black #000000
- Position: Top center above split
- Example: "JUNIOR ENGINEER VS SENIOR ENGINEER"

TIER 2 - SIDE LABELS (Geometric Sans):
- Left/Top: "[Side A]"
- Right/Bottom: "[Side B]"
- Font: geometric sans-serif
- Size: Medium readable
- Color: Charcoal #2D2D2D
- Position: Headers for each side

TIER 3 - ANNOTATIONS (Condensed Italic):
- Key characteristics: "*overthinks*" vs "*simplifies*"
- Font: condensed italic
- Size: 60% of Tier 2
- Color: Matches side color (Indigo left, Green right)
- Position: Within each side's visual

LEFT/TOP SIDE - [SIDE A]:
Visual metaphor: [Describe the illustration, e.g.:]
- [Metaphor showing Side A characteristic]
- Hand-drawn with [imperfect lines, gestural quality]
- Color: Indigo (#2B4C7E) accents on [specific elements]
- Black (#000000) primary linework
- Represents: [What this side embodies]

RIGHT/BOTTOM SIDE - [SIDE B]:
Visual metaphor: [Contrasting illustration, e.g.:]
- [Metaphor showing Side B characteristic]
- Hand-drawn matching style to left side
- Color: Green (#3A7D44) accents on [specific elements]
- Black (#000000) primary linework
- Represents: [What this side embodies]

[OR if one side is preferred:]
- Preferred side: Indigo (#2B4C7E) accents
- Alternative side: Black only (or subtle Green)

FIGURES (if present):
- [The figure style from `PREFERENCES.md` § Figure style, when set]; default: simplified, stylized editorial figures, adult proportions, minimal faces, emotion through gesture and silhouette, not cartoonish
- Every person follows the figure treatment: `PREFERENCES.md` § Character design when set, else "the figures are a varied cast, each one's skin tone, age and build named, spanning a natural range; no figure is a stereotype"

DIVIDING LINE:
- [Strong black vertical/horizontal line down center] OR
- [Soft visual separation through composition and color]

COLOR USAGE:
- Black (#000000) for all linework on both sides and dividing line
- Left side: Indigo (#2B4C7E) accents on [elements]
- Right side: Green (#3A7D44) accents on [elements]
- Charcoal (#2D2D2D) for all label text
- OR: Indigo on preferred side only, black on alternative

CRITICAL REQUIREMENTS:
- Hand-drawn editorial style on BOTH sides (consistent aesthetic)
- Clear visual contrast between sides (metaphors show difference)
- Each side drawn from its own recognizable iconography, never the same shape in two colours
- Mirror structure (parallel elements contrasted)
- Strategic color differentiation (indigo vs green, or indigo on better side)
- No gradients, flat colors only
- Immediate visual understanding of the difference
- Equal visual weight to both sides (balanced composition)
```

## Examples

### Example 1: "Junior Engineer vs Senior Engineer"
- **Split:** Vertical left/right
- **Left (Junior):** Complex spaghetti code (indigo tangle)
- **Right (Senior):** Simple elegant solution (green straight line)
- **Color:** Indigo left, Green right
- **Aspect:** 16:9

### Example 2: "Before AI vs After AI"
- **Split:** Horizontal top/bottom
- **Top (Before):** Manual tedious work (person with paper pile)
- **Bottom (After):** Automated flow (person directing AI)
- **Color:** Indigo on "After" (preferred state)
- **Aspect:** 9:16

### Example 3: "Security Theater vs Real Security"
- **Split:** Vertical left/right
- **Left (Theater):** Fancy locks on cardboard door
- **Right (Real):** Simple but solid construction
- **Color:** Indigo right (effective), black left (ineffective)
- **Aspect:** 16:9
