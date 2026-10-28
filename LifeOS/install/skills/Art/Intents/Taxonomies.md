# Taxonomies

> **Palette.** The colour names and hex values in this intent are the skill's neutral defaults (indigo `#2B4C7E` primary accent, green `#3A7D44` secondary accent, umber `#A0522D` warm wash, `#F5F5F0` paper ground). When `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md` § Color palette exists, use its value for each role instead, in prompts, validation and checklists alike, and name its colour words where this file names the defaults.

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Gotchas · Output format · Examples

Hand-drawn visual taxonomies in the house aesthetic: classification systems such as periodic tables, capability matrices or framework grids that show organized categories and hierarchies, unlike technical diagrams (flows/relationships) or editorial illustrations (metaphors).

## Ideal State

- A classification definition (Step 1 shape under Output format) existed before the prompt was written: what is being categorized, the organizing dimensions, how many categories, the hierarchy (major categories → subcategories), and which category each item belongs to.
- A grid layout plan (Step 2 shape under Output format) existed before the prompt was written: layout type (periodic table grid, 2x2/3x3/4x4 matrix, hierarchical tree, grouped clusters, or linear taxonomy), cell structure, which categories get indigo and which get green, and the three typography tiers.
- Every item in the image sits in the cell or group of the category the classification definition assigns it, and every category and item label is spelled exactly as in that definition: no invented, dropped, duplicated or garbled entries.
- Every label is legible at the delivered size, and the hierarchy reads Title > Categories > Items at a glance through the three typography tiers: a wedge-serif italic title left-justified at top, geometric-sans category headers, condensed sans item labels.
- The grid is visibly organized into cells and groups yet hand-drawn: lines wobble, cells are roughly aligned rather than ruler-perfect.
- Colour is strategic and flat: roughly 80% black structure, about 10% indigo and 10% green marking categories, all text charcoal, no gradients or shadows.
- The PNG reaches Downloads only through ArtDirection's `Deliver.ts`, rendered in a working directory outside Downloads (SKILL.md § Output staging), at the aspect ratio its taxonomy type calls for (default 1:1).

## Anti-criteria

- Perfect straight grid lines.
- Polished vector graphics.
- Gradients or shadows.
- Illegible or tiny text.
- Color chaos (too many colors).
- Confusing organization.

## Inputs

The subject to classify, with its categories and the items that belong to them.

## Tool contract

Aspect ratio by taxonomy type (`--aspect-ratio`):

| Taxonomy Type | Aspect Ratio | Reasoning |
|---------------|--------------|-----------|
| Wide grid (many columns) | 16:9 or 21:9 | Horizontal periodictable layout |
| Tall hierarchy | 9:16 | Vertical tree structure |
| Square matrix | 1:1 | Balanced 4x4 or 5x5 grid |
| Reference card | 1:1 or 4:3 | Compact, poster-like |

**Default: 1:1 (square)** — Works for most taxonomy grids

```bash
ART_DIR=<working dir outside Downloads>   # e.g. scratchpad/art/<slug>; SKILL.md § Output staging
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --intent=Taxonomies \
  --model nano-banana-pro \
  --prompt "[YOUR PROMPT]" \
  --size 2K \
  --aspect-ratio 1:1 \
  --output "$ART_DIR"/taxonomy.png
```

nano-banana-pro is the default and only model for this intent. It handles hierarchy labels within the editorial aesthetic.

Look at the image with the Read tool before judging it. Open it for the principal only after the quality loop in SKILL.md passes:
```bash
bun ~/.claude/skills/ArtDirection/Tools/Deliver.ts --artifact "$ART_DIR"/taxonomy.png --to ~/Downloads
open ~/Downloads/taxonomy.png
```

## Gotchas

If validation fails, these prompt fixes apply:

| Problem | Fix |
|---------|-----|
| Grid too perfect | Emphasize "wobbly hand-drawn grid lines, organic imperfection" |
| Text unreadable | Increase text size, strengthen typography tier requirements |
| Too colorful | "Strategic color use — indigo for [specific], green for [specific], rest black" |
| Unclear organization | Simplify grid, reduce categories, clarify groupings |
| Looks digital | Reference "hand-drawn field guide, editorial notebook aesthetic" |

## Output format

### Step 1 classification definition

```
CLASSIFICATION SUBJECT: [What you're organizing]

ORGANIZING DIMENSIONS:
- Dimension 1: [e.g., Complexity: Simple → Complex]
- Dimension 2: [e.g., Impact: Low → High]

CATEGORIES:
1. [Category name] — [Description]
2. [Category name] — [Description]
3. [Category name] — [Description]
...

ITEMS TO CLASSIFY:
- [Item 1] belongs to [Category]
- [Item 2] belongs to [Category]
...
```

### Step 2 grid layout

```
LAYOUT: [Grid type, e.g., 4x4 matrix, Periodic table style]

GRID STRUCTURE:
- [Describe arrangement: "4 rows by 4 columns, grouped by color into quadrants"]
- Cell size: [Uniform squares, varied rectangles, etc.]
- Groupings: [How categories cluster together]

COLOR CODING:
- Indigo: [Category type 1]
- Green: [Category type 2]
- Black: [Remaining structure]

TYPOGRAPHY:
- Title (Tier 1): "[MAIN TITLE]"
- Category headers (Tier 2): [Category names]
- Item labels (Tier 3): [Individual items]
```

### Prompt Template

Palette: Black #000000 for all grid lines, cell borders and primary structure; Deep Indigo #2B4C7E and Deep Green #3A7D44 for category headers and highlights (one category type each, or alternating by row/column); Charcoal #2D2D2D for all body text and labels; background White #FFFFFF or Light Cream #F5E6D3.

```
Hand-drawn taxonomy grid in editorial notebook style.

STYLE REFERENCE: Periodic table, field guide illustration, reference card aesthetic

BACKGROUND: [White #FFFFFF OR Light Cream #F5E6D3] — clean, flat

AESTHETIC:
- Hand-drawn imperfect grid lines (slightly wobbly, human quality)
- Variable stroke weight (grid structure in black)
- Cell borders with slight waviness (not perfect rectangles)
- Editorial flat color aesthetic with strategic accents
- Organized layout but hand-crafted feel

LAYOUT TYPE: [Periodic table grid / Matrix / Hierarchical tree / etc.]

GRID STRUCTURE:
[Describe the grid organization, e.g.:]
- 4 rows by 4 columns of cells
- Each cell contains: [category icon/symbol] + [label text]
- Cells grouped by color into [quadrants/categories]
- Clear visual separation between category groups

TYPOGRAPHY SYSTEM (3-TIER):

TIER 1 - TAXONOMY HEADER & SUBTITLE (Serif Two-Part System):
Header (Main Title):
- "[Header Text]" — Left-justified at top
- Font: wedge-serif italic (elegant, sophisticated)
- Size: Large - 3-4x body text (prominent, commanding attention)
- Style: Italicized, sentence case or title case (NOT all-caps)
- Color: Black #000000 (or Indigo #2B4C7E for emphasis)
- Position: Top-left with margin
- Example: "The Periodic Table of AI Capabilities"

Subtitle (Clarifying Detail):
- "[Subtitle Text]" — Below header
- Font: wedge-serif regular (warm, readable)
- Size: Small - 1-1.5x body text (noticeably smaller than header, supportive)
- Style: Regular (NOT italicized), sentence case (first letter capitalized, rest lowercase except proper nouns)
- Color: Black #000000 or Charcoal #2D2D2D
- Position: Small gap below header, aligned left
- Example: "Classification of Machine Learning Functions"

TIER 2 - CATEGORY HEADERS (Geometric Sans):
- "[Category 1]", "[Category 2]", etc.
- Font: geometric sans-serif, clean, modern
- Size: Medium readable
- Color: Indigo #2B4C7E for Category 1, Green #3A7D44 for Category 2
- Example: "Reasoning", "Creativity", "Perception"

TIER 3 - ITEM LABELS (Condensed):
- Individual items within cells
- Font: condensed sans, smaller
- Size: 60% of Tier 2
- Color: Charcoal #2D2D2D
- Example: Item names, abbreviations, symbols

CONTENT TO INCLUDE:
[List all categories and items to be shown, e.g.:]

CATEGORY 1 (Indigo #2B4C7E headers):
- Item A: [label]
- Item B: [label]
- Item C: [label]

CATEGORY 2 (Green #3A7D44 headers):
- Item D: [label]
- Item E: [label]

[etc.]

COLOR USAGE:
- Black (#000000) for all grid structure, cell borders
- Deep Indigo (#2B4C7E) for [Category 1] headers and accents
- Deep Green (#3A7D44) for [Category 2] headers and accents
- Charcoal (#2D2D2D) for all item labels and body text

CRITICAL REQUIREMENTS:
- Hand-drawn sketch quality — NOT polished digital grid
- Grid lines wobble slightly (human imperfection)
- Cells roughly aligned but organic (grid-aware not grid-perfect)
- No gradients, no shadows, flat colors only
- Clear typography with 3-tier hierarchy
- Scannable and reference-friendly layout
- Strategic color coding for categories

```

## Examples

Use this intent for "The Periodic Table of X", classification grids and matrices, capability taxonomies, framework reference cards, and organized typologies.

### Example 1: "Periodic Table of AI Capabilities"
- **Grid:** 5x6 matrix of capabilities
- **Categories:** Reasoning (indigo), Creativity (green), Perception (black), Action (indigo), Memory (green)
- **Items:** Each cell = one capability with icon + label
- **Aspect:** 16:9 (wide grid)

### Example 2: "Cybersecurity Threat Taxonomy"
- **Grid:** Hierarchical tree from top (threat types) to bottom (specific attacks)
- **Categories:** Network threats (indigo), Application threats (green), Human threats (indigo)
- **Aspect:** 9:16 (tall tree)

### Example 3: "Business Model Classification"
- **Grid:** 3x3 matrix (complexity vs. scalability)
- **Categories:** 9 business model archetypes
- **Color:** Indigo for high-scalability, green for low-complexity
- **Aspect:** 1:1 (square reference card)
