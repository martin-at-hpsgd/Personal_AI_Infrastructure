# Frameworks

> **Palette.** The colour names and hex values in this intent are the skill's neutral defaults (indigo `#2B4C7E` primary accent, green `#3A7D44` secondary accent, umber `#A0522D` warm wash, `#F5F5F0` paper ground). When `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md` § Color palette exists, use its value for each role instead, in prompts, validation and checklists alike, and name its colour words where this file names the defaults.

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Gotchas · Output format · Examples

A hand-drawn visual framework: a signature mental model (2x2, Venn, pyramid, spectrum, triangle) drawn as a memorable editorial diagram in the house aesthetic.

## Ideal State

- The image shows one framework whose type (2x2, Venn, pyramid, spectrum, triangle) a reader names correctly at first glance, with its dimensions or concepts and every quadrant, area or level named, and the optimal zone marked.
- Every title, axis label, quadrant name and annotation is spelled exactly as written in the prompt and is legible at the delivered size, in the 3-tier hierarchy: framework title (Tier 1), axis and quadrant labels (Tier 2), annotations (Tier 3).
- The linework is visibly hand-drawn: wobbly axes, imperfect circles, variable stroke weight, organic shapes, house flat color and black linework.
- Color is strategic: black framework structure, charcoal text, indigo (#2B4C7E) on the optimal zone and green (#3A7D44) on the contrast zone as subtle accents on 1-2 key zones only, not everywhere.
- It is conceptually memorable: one annotation states the insight the framework exists to make (for example "*this is the sweet spot*"), so the image works as THE reference image for this framework.
- It is generated with nano-banana-pro at the aspect ratio its framework type calls for (1:1 by default).

## Anti-criteria

- Never perfect digital geometry (too clean), illegible or cluttered text, color overload (solid fills everywhere), a confusing structure where the framework type cannot be identified, a corporate/boring diagram look, or gradients or shadows.
- Never generated with any model other than nano-banana-pro, the default and only model for this intent.
- A misspelled or garbled label, or a quadrant left unnamed.

## Inputs

Visual frameworks illustrate mental models, thinking frameworks, and conceptual relationships. These are **signature frameworks** made visual — 2x2 matrices, Venn diagrams, conceptual maps with personality and editorial style.

**Use this intent for:**
- 2x2 matrices and quadrant models
- Venn diagrams with editorial flair
- Conceptual relationship maps
- "The [Your Name] Framework for X"
- Mental models and thinking tools
- Decision frameworks

## Tool contract

| Framework Type | Aspect Ratio | Reasoning |
|----------------|--------------|-----------|
| 2x2 Matrix | 1:1 | Square for balanced quadrants |
| Venn Diagram | 1:1 | Square for circular symmetry |
| Pyramid | 1:1 or 4:3 | Vertical emphasis |
| Horizontal spectrum | 16:9 | Wide for left-right continuum |
| Triangle | 1:1 | Balanced for three concepts |

**Default: 1:1 (square)** — Works for most framework types

```bash
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --intent=Frameworks \
  --model nano-banana-pro \
  --prompt "[YOUR PROMPT]" \
  --size 2K \
  --aspect-ratio 1:1 \
  --output /path/to/framework.png
```

nano-banana-pro handles quadrant labels and axis titles within the editorial aesthetic.

## Gotchas

Prompt fixes when a check fails:

| Problem | Fix |
|---------|-----|
| Too precise/digital | "Hand-drawn wobbly axes, organic imperfect circles, human sketch quality" |
| Text unreadable | Increase label sizes, simplify annotations |
| Over-colored | "Subtle indigo accent on optimal zone only, rest black structure" |
| Confusing structure | Simplify framework, stronger geometry cues |
| Looks corporate | Reference "editorial conceptual illustration" plus the illustrator references `PREFERENCES.md` § Figure style names, when set |
| Not memorable | Add strategic annotation showing the insight: "*this is the sweet spot*" |

## Output format

The prompt follows this template. The background is White #FFFFFF or Light Cream #F5E6D3.

```
Hand-drawn conceptual framework diagram in editorial style.

STYLE REFERENCE: Mental model illustration, conceptual diagram with personality, smart person's framework sketch

BACKGROUND: [White #FFFFFF OR Light Cream #F5E6D3] — clean, flat

AESTHETIC:
- Hand-drawn framework structure (wobbly lines, organic shapes)
- Variable stroke weight (axes thicker, details thinner)
- Imperfect but intentional geometry (circles not perfect, axes slightly wavy)
- Editorial flat color with strategic indigo/green accents
- Clear conceptual structure with human touch

FRAMEWORK TYPE: [2x2 Matrix / Venn Diagram / Pyramid / Spectrum / etc.]

FRAMEWORK STRUCTURE:
[Describe the specific framework geometry, e.g.:]
- Two hand-drawn perpendicular axes (black) forming cross
- X-axis: [Low concept] on left → [High concept] on right
- Y-axis: [Low concept] on bottom → [High concept] on top
- Four quadrants created by intersection

TYPOGRAPHY SYSTEM (3-TIER):

TIER 1 - FRAMEWORK TITLE (Hand-Lettered Block Display):
- "[FRAMEWORK NAME IN ALL-CAPS]"
- Font: display style, extra bold, hand-lettered, all-caps
- Size: 3x larger than body text
- Color: Black #000000
- Position: Top center
- Example: "THE SECURITY VS CONVENIENCE FRAMEWORK"

TIER 2 - LABELS & CONCEPTS (Geometric Sans):
- Axis labels: "[X-axis concept]", "[Y-axis concept]"
- Quadrant names: "[Quadrant 1]", "[Quadrant 2]", etc.
- Font: geometric sans-serif
- Size: Medium readable
- Color: Charcoal #2D2D2D
- Position: Along axes and inside quadrants

TIER 3 - ANNOTATIONS (Condensed Italic):
- Insight notes: "*optimal zone*", "*avoid this quadrant*"
- Font: condensed italic
- Size: 60% of Tier 2
- Color: Indigo #2B4C7E or Green #3A7D44 for emphasis
- Position: Near relevant quadrants/areas

QUADRANTS/AREAS TO SHOW:
[List each region with description, e.g.:]

TOP-RIGHT QUADRANT:
- Label: "[Name]"
- Description: [What this represents]
- Color: Indigo (#2B4C7E) subtle accent/highlight — OPTIMAL ZONE
- Annotation: "*ideal state*" in indigo italic

TOP-LEFT QUADRANT:
- Label: "[Name]"
- Description: [What this represents]
- Color: Black structure only

BOTTOM-RIGHT QUADRANT:
- Label: "[Name]"
- Description: [What this represents]
- Color: Green (#3A7D44) subtle accent — CONTRAST ZONE

BOTTOM-LEFT QUADRANT:
- Label: "[Name]"
- Description: [What this represents]
- Color: Black structure only

[Adjust based on framework type - Venn would describe circles, pyramid would describe levels, etc.]

COLOR USAGE:
- Black (#000000) for all framework structure (axes, circles, lines)
- Deep Indigo (#2B4C7E) for [optimal zone] — subtle fill or accent
- Deep Green (#3A7D44) for [contrast zone] — subtle accent
- Charcoal (#2D2D2D) for all text except emphasized annotations

CRITICAL REQUIREMENTS:
- Hand-drawn imperfect geometry (NOT digital precision)
- Framework structure immediately recognizable
- Clear labels in 3-tier typography hierarchy
- Strategic color on 1-2 key zones only (subtle, not solid fills)
- No gradients, flat colors only
- Editorial illustration aesthetic maintained
- Conceptually clear and memorable
```

## Examples

### Example 1: "Security vs Convenience Framework"
- **Type:** 2x2 matrix
- **Axes:** Security (low → high), Convenience (low → high)
- **Quadrants:** Vulnerable, Fortress, Balanced (indigo), Abandoned
- **Color:** Indigo on "Balanced" optimal quadrant
- **Aspect:** 1:1

### Example 2: "Human + AI Capability Venn"
- **Type:** Venn diagram (3 circles)
- **Circles:** Human abilities, AI capabilities, Tools
- **Overlap:** Where magic happens (indigo)
- **Color:** Indigo on center overlap
- **Aspect:** 1:1

### Example 3: "Threat Modeling Pyramid"
- **Type:** Pyramid (4 levels)
- **Levels:** Assets (bottom) → Threats → Vulnerabilities → Mitigations (top)
- **Color:** Indigo on top level (actions), green on bottom (foundation)
- **Aspect:** 4:3
