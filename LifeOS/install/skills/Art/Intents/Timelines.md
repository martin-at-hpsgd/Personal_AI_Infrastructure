# Timelines

> **Palette.** The colour names and hex values in this intent are the skill's neutral defaults (indigo `#2B4C7E` primary accent, green `#3A7D44` secondary accent, umber `#A0522D` warm wash, `#F5F5F0` paper ground). When `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md` § Color palette exists, use its value for each role instead, in prompts, validation and checklists alike, and name its colour words where this file names the defaults.

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Gotchas · Output format · Examples

Hand-drawn conceptual timelines in the house aesthetic showing evolution, trends and transformations: chronological progressions with a visual metaphor at each stage, combining narrative arc with temporal information rather than a simple date list.

## Ideal State

- A timeline structure (Step 1 shape under Output format) existed before the prompt was written: what is evolving, the time span, the narrative arc (e.g., collapse → crisis → renewal), 4-8 key milestones each with its year/period, event and metaphor, and the 1-2 turning points marked for indigo.
- A timeline layout plan (Step 2 shape under Output format) existed before the prompt was written: orientation (horizontal, vertical, or curved), what small illustration represents each milestone and how it attaches to the line, size variation by importance, and spacing (even, proportional to actual time, or clustered).
- Every date, period and milestone label in the image matches the timeline structure exactly, in chronological order along the line: no invented, dropped, reordered or garbled dates.
- Time visibly flows one way (left-to-right or top-to-bottom) along an organic hand-drawn line, never a ruler-straight or Gantt-style bar.
- Each milestone carries a small illustrated metaphor (never a bare dot) showing the character of its era, so the sequence of metaphors tells the transformation on its own.
- Every label is legible at the delivered size in the three typography tiers (title, dates, milestone descriptions).
- Indigo marks only the 1-2 turning points and green only supporting milestones; everything else is black linework with charcoal text, flat, no gradients.
- The PNG reaches Downloads only through ArtDirection's `Deliver.ts`, rendered in a working directory outside Downloads (SKILL.md § Output staging), at the aspect ratio its timeline type calls for (default 16:9).

## Anti-criteria

- Perfectly straight timeline.
- Generic boring milestone markers (just dots).
- Illegible dates or cluttered text.
- Too many milestones (overwhelming).
- Color chaos (everything highlighted).
- Looks like Gantt chart or business timeline.

## Inputs

The subject that changes over time, its time span, and its key milestones.

## Tool contract

Aspect ratio by timeline type (`--aspect-ratio`):

| Timeline Type | Aspect Ratio | Reasoning |
|---------------|--------------|-----------|
| Horizontal timeline | 21:9 or 16:9 | Wide format for left-to-right flow |
| Vertical timeline | 9:16 | Tall format for top-to-bottom progression |
| Balanced/compact | 1:1 | Square for shorter timelines |
| Long historical | 21:9 | Maximum width for many events |

**Default: 16:9 (horizontal)** — Classic timeline orientation

```bash
ART_DIR=<working dir outside Downloads>   # e.g. scratchpad/art/<slug>; SKILL.md § Output staging
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --intent=Timelines \
  --model nano-banana-pro \
  --prompt "[YOUR PROMPT]" \
  --size 2K \
  --aspect-ratio 16:9 \
  --output "$ART_DIR"/timeline.png
```

nano-banana-pro is the default and only model for this intent. It handles date labels and event captions within the editorial aesthetic.

Look at the image with the Read tool before judging it. Open it for the principal only after the quality loop in SKILL.md passes:
```bash
bun ~/.claude/skills/ArtDirection/Tools/Deliver.ts --artifact "$ART_DIR"/timeline.png --to ~/Downloads
open ~/Downloads/timeline.png
```

## Gotchas

If validation fails, these prompt fixes apply:

| Problem | Fix |
|---------|-----|
| Timeline too straight | "Organic hand-drawn line, slight waviness, imperfect curve" |
| No visual interest | "Small illustrated metaphors at each milestone showing the era's character" |
| Text unreadable | Increase spacing, strengthen typography tier sizes |
| Too cluttered | Reduce milestones to 4-6 key points, simplify |
| Looks corporate | Reference "editorial illustration style, hand-drawn sketch aesthetic" |
| Missing narrative | Emphasize metaphors that show transformation: "seedling → storm → sunrise" |

## Output format

### Step 1 timeline structure

```
SUBJECT: [What's changing over time]
TIME SPAN: [Start year] → [End year]

NARRATIVE ARC: [The transformation story, e.g., "From hype to disillusionment to practical value"]

KEY MILESTONES:
1. [Year/Period]: [Event] — [Metaphor for this stage]
2. [Year/Period]: [Event] — [Metaphor for this stage]
3. [Year/Period]: [Event] — [Metaphor for this stage]
4. [Year/Period]: [Event] — [Metaphor for this stage]
...

TURNING POINTS (Indigo highlights):
- [Which 1-2 milestones are most critical]
```

### Step 2 timeline layout

```
ORIENTATION: [Horizontal / Vertical / Curved]

TIMELINE STRUCTURE:
- Main line: [Black hand-drawn line, slightly wobbly]
- Milestones: [Small illustrated circles/nodes along line]
- Labels: [Above or below timeline]

MILESTONE ILLUSTRATIONS:
1. [Year]: [Small icon/metaphor] — [e.g., "seedling" for beginning]
2. [Year]: [Small icon/metaphor] — [e.g., "storm" for crisis]
3. [Year]: [Small icon/metaphor] — [e.g., "sunrise" for renewal]
...

SPACING: [Even / Proportional / Clustered]

COLOR HIGHLIGHTS:
- Indigo: [Critical milestone(s)]
- Green: [Supporting milestone(s)]
- Black: [Standard milestones]
```

### Prompt Template

Palette: Black #000000 for the timeline spine and all primary structure; Deep Indigo #2B4C7E for the 1-2 key turning points; Deep Green #3A7D44 for secondary, supporting milestones; Charcoal #2D2D2D for all text (dates, labels, annotations); background White #FFFFFF or Light Cream #F5E6D3. Metaphors are simple, recognizable icons that show the feeling of each era, so the progression tells a visual story.

```
Hand-drawn conceptual timeline in editorial illustration style.

STYLE REFERENCE: Illustrated history timeline, hand-drawn progress chart, editorial time progression

BACKGROUND: [White #FFFFFF OR Light Cream #F5E6D3] — clean, flat

AESTHETIC:
- Hand-drawn timeline (organic line, slightly wobbly, not ruler-straight)
- Small illustrated metaphors at each milestone
- Variable stroke weight (timeline thicker, details thinner)
- Editorial flat color with strategic indigo/green accents
- Imperfect but intentional placement

ORIENTATION: [Horizontal left-to-right / Vertical top-to-bottom]

TIMELINE STRUCTURE:
- Black (#000000) timeline spine running [horizontally/vertically]
- [Number] milestone points along timeline
- Each milestone has: small circle/node + illustration + label
- Hand-drawn connecting line with slight organic waviness

TYPOGRAPHY SYSTEM (3-TIER):

TIER 1 - TIMELINE TITLE (Hand-Lettered Block Display):
- "[TIMELINE TITLE IN ALL-CAPS]"
- Font: display style, extra bold, hand-lettered, all-caps
- Size: 3x larger than body text
- Color: Black #000000
- Position: Top or left side
- Example: "THE EVOLUTION OF ARTIFICIAL INTELLIGENCE"

TIER 2 - DATES/PERIODS (Geometric Sans):
- "[1990]", "[2000]", "[2010]", etc.
- Font: geometric sans-serif
- Size: Medium readable
- Color: Charcoal #2D2D2D
- Position: Along timeline at each milestone

TIER 3 - MILESTONE DESCRIPTIONS (Condensed Italic):
- "*symbolic AI era*", "*deep learning breakthrough*", etc.
- Font: condensed italic
- Size: 60% of Tier 2
- Color: Charcoal #2D2D2D (or Indigo/Green for highlighted events)
- Position: Near each milestone node

MILESTONES TO ILLUSTRATE:
[List each point chronologically, e.g.:]

1. [Year]: [Event name]
   - Illustration: [Small hand-drawn icon/metaphor, e.g., "tiny seed sprouting"]
   - Color: Black node with charcoal text
   - Position: [Along timeline at this point]

2. [Year]: [Critical event]
   - Illustration: [Metaphor, e.g., "lightning bolt"]
   - Color: Indigo (#2B4C7E) node and illustration — KEY TURNING POINT
   - Position: [Emphasized size, highlighted]

3. [Year]: [Event name]
   - Illustration: [Metaphor]
   - Color: Green (#3A7D44) node
   - Position: [Along timeline]

[etc. for all milestones]

VISUAL METAPHORS:
- Each milestone illustrated with small simple icon
- Metaphors show the nature/feeling of that era
- Hand-drawn sketch quality, not detailed illustrations
- Examples: seedling, storm cloud, rising sun, mountain peak, valley, crossroads

COLOR USAGE:
- Black (#000000) for timeline spine and most milestone nodes
- Deep Indigo (#2B4C7E) for [1-2 critical turning points] — nodes and illustrations
- Deep Green (#3A7D44) for [supporting important events]
- Charcoal (#2D2D2D) for all text

CRITICAL REQUIREMENTS:
- Hand-drawn timeline (NOT straight digital line)
- Clear temporal progression [left-to-right / top-to-bottom]
- Small illustrated metaphors at each point (simple, sketchy)
- 3-tier typography hierarchy
- Strategic color on key milestones only
- No gradients, flat colors only
- Maintains editorial illustration aesthetic
- Easy to scan and follow progression

```

## Examples

Use this intent for "The Evolution of X", trend analysis over time, historical perspectives, before → during → after progressions, transformation journeys, and era comparisons.

### Example 1: "AI Winter → Spring → Summer"
- **Timeline:** 1970s → 2025 → Future
- **Milestones:** Winter (snowflake), Thaw (ice melting), Spring (bud), Summer (sun)
- **Color:** Indigo on "Deep Learning Breakthrough" (2012)
- **Orientation:** Horizontal 16:9

### Example 2: "Security Thinking Evolution"
- **Timeline:** 2000 → Present
- **Milestones:** Each era with metaphor (fortress → ecosystem → adaptive)
- **Color:** Indigo on paradigm shifts
- **Orientation:** Vertical 9:16

### Example 3: "Startup Journey: Idea to Scale"
- **Timeline:** Year 0 → Year 5
- **Milestones:** Seedling → Sprout → Tree → Forest
- **Color:** Green on funding rounds, indigo on profitability
- **Orientation:** Horizontal 21:9
