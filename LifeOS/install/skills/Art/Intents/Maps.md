# Maps

> **Palette.** The colour names and hex values in this intent are the skill's neutral defaults (indigo `#2B4C7E` primary accent, green `#3A7D44` secondary accent, umber `#A0522D` warm wash, `#F5F5F0` paper ground). When `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md` § Color palette exists, use its value for each role instead, in prompts, validation and checklists alike, and name its colour words where this file names the defaults.

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Gotchas · Output format · Examples

A hand-drawn conceptual map: an illustrated landscape of idea territories and domains, not geographic locations, in the house editorial cartography style.

## Ideal State

- The map shows the field as 4-8 major territories whose placement carries their relationships: physical proximity for related concepts, ocean between very different domains, mountains for barriers or challenges, rivers for connections or flows, bridges for integration points.
- Every feature stands for a named idea a reader can state from its label: no decorative mountain or river without a meaning.
- Map structure is clear: territories, coastlines and borders are obvious, so the map is navigable and helps a reader understand the lay of the land in the field.
- Every territory and feature label is spelled exactly as planned and legible at the delivered size, in the 3-tier typography: map header and subtitle (Tier 1), territory names (Tier 2), feature labels (Tier 3).
- It is hand-drawn editorial cartography: wobbly coastlines, imperfect borders, human quality, house flat color and black linework.
- Color is strategic: black for all coastlines, borders and features, charcoal for all text, and indigo (#2B4C7E) and green (#3A7D44) as subtle fills on 1-2 key territories, not solid.
- The PNG reaches Downloads only through ArtDirection's `Deliver.ts`, rendered in a working directory outside Downloads (SKILL.md § Output staging), at the aspect ratio its map type calls for (16:9 by default).

## Anti-criteria

- Never a perfect digital map (too clean), realistic geographic features, illegible territory names, color chaos (too many territory colors), confusing metaphors where features don't represent concepts clearly, or gradients or shadows.

## Inputs

The field or topic to map, with its domains and how they relate. Conceptual maps are **metaphorical maps** showing where ideas, concepts, or domains exist in relation to each other.

## Tool contract

| Map Type | Aspect Ratio | Reasoning |
|----------|--------------|-----------|
| Wide horizontal landscape | 16:9 or 21:9 | Spread-out territories |
| Balanced map | 1:1 | Symmetric territory distribution |
| Vertical territories | 9:16 or 4:3 | Stacked or layered domains |
| Poster map | 4:3 | Classic map proportions |

**Default: 16:9 (horizontal)** — Classic map orientation

```bash
ART_DIR=<working dir outside Downloads>   # e.g. scratchpad/art/<slug>; SKILL.md § Output staging
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --intent=Maps \
  --model nano-banana-pro \
  --prompt "[YOUR PROMPT]" \
  --size 2K \
  --aspect-ratio 16:9 \
  --output "$ART_DIR"/conceptual-map.png
```

**Model Recommendation:** nano-banana-pro (best for territory labels) or flux (stylistic variety). For flux, swap the size flags for `--size 16:9` (no `--aspect-ratio`); `--size 2K` fails validation for flux (`References/Models.md`).

Look at the image with the Read tool before judging it. Open it for the principal only after the quality loop in SKILL.md passes:
```bash
bun ~/.claude/skills/ArtDirection/Tools/Deliver.ts --artifact "$ART_DIR"/conceptual-map.png --to ~/Downloads
open ~/Downloads/conceptual-map.png
```

## Gotchas

If validation fails, these prompt fixes apply:

| Problem | Fix |
|---------|-----|
| Too precise/digital | "Hand-drawn wobbly coastlines, imperfect irregular borders, sketch quality" |
| Unclear metaphors | Strengthen feature descriptions: "mountains represent [specific barrier]" |
| Labels unreadable | Increase label sizes, clearer placement inside territories |
| Too complex | Reduce to 4-6 major territories, simplify features |
| Looks like real map | "Conceptual geography, metaphorical territories, abstract cartography" |
| Missing relationships | Add rivers/bridges showing connections: "river connecting [A] to [B]" |

## Output format

Palette: Black #000000 for all coastlines, borders and terrain features; very subtle cream/beige light fills for other territories; Deep Indigo #2B4C7E for the primary domain or "optimal" territory; Deep Green #3A7D44 for a secondary or adjacent territory; Charcoal #2D2D2D for all labels and annotations; background Light Cream #F5E6D3 (warm neutral "ocean") or White #FFFFFF (clean empty space around territories).

Map layout vocabulary: orientation (north-up traditional, centered around a key territory, horizontal spread, vertical layers); territory shapes (continents for large connected domains, islands for isolated concepts, archipelagos for a related cluster, peninsulas for partially connected ones); features (coastlines/borders, landmarks such as mountains and rivers, territory labels, a legend or compass rose).

### Prompt Template

```
Hand-drawn conceptual map in editorial cartography style.

STYLE REFERENCE: Fantasy map, hand-drawn cartography, illustrated territory map

BACKGROUND: [Light Cream #F5E6D3 / White #FFFFFF] — represents ocean/empty space

AESTHETIC:
- Hand-drawn map (wobbly coastlines, imperfect borders)
- Cartographic elements (territories, features, labels)
- Variable stroke weight (coastlines thicker, details thinner)
- Editorial flat color with strategic indigo/green territories
- Sketch quality, not polished digital map

MAP SUBJECT: "[The X Landscape]" or "[Map of Y Domains]"

CARTOGRAPHIC STRUCTURE:
[Describe the overall map, e.g.:]
- Central large landmass: [Primary Domain]
- Surrounding islands and territories representing related concepts
- Ocean/empty space between distant domains
- Physical features (mountains, rivers, bridges) showing relationships

TYPOGRAPHY SYSTEM (3-TIER):

TIER 1 - MAP HEADER & SUBTITLE (Serif Two-Part System):
Header (Main Title):
- "[Header Text]" — Left-justified at top
- Font: wedge-serif italic (elegant, sophisticated)
- Size: Large - 3-4x body text (prominent, commanding attention)
- Style: Italicized, sentence case or title case (NOT all-caps)
- Color: Black #000000 (or Indigo #2B4C7E for emphasis)
- Position: Top-left with margin
- Example: "The Landscape of Artificial Intelligence"

Subtitle (Clarifying Detail):
- "[Subtitle Text]" — Below header
- Font: wedge-serif regular (warm, readable)
- Size: Small - 1-1.5x body text (noticeably smaller than header, supportive)
- Style: Regular (NOT italicized), sentence case (first letter capitalized, rest lowercase except proper nouns)
- Color: Black #000000 or Charcoal #2D2D2D
- Position: Small gap below header, aligned left
- Example: "Domains, Territories, and Frontiers"

TIER 2 - TERRITORY NAMES (Geometric Sans):
- Territory labels: "[Domain 1]", "[Domain 2]", etc.
- Font: geometric sans-serif
- Size: Medium readable
- Color: Charcoal #2D2D2D
- Position: Inside territory borders or nearby

TIER 3 - FEATURE LABELS (Condensed Italic):
- Geographic features: "*mountains of complexity*", "*river of data*"
- Font: condensed italic
- Size: 60% of Tier 2
- Color: Charcoal #2D2D2D
- Position: Near relevant features

TERRITORIES TO MAP:
[List each territory with details, e.g.:]

CENTRAL TERRITORY: [Primary Domain Name]
- Shape: Large irregular continent in center of map
- Coastline: Hand-drawn wobbly black line
- Fill: Subtle Indigo (#2B4C7E) tint (very light, not solid)
- Features: [Mountains / Rivers / Landmarks within]
- Label: "[Domain name]" in geometric sans
- Represents: [Core concept]

EASTERN TERRITORY: [Secondary Domain Name]
- Shape: Medium island separated by ocean from center
- Coastline: Hand-drawn irregular outline
- Fill: Subtle Green (#3A7D44) tint
- Features: [Specific landmarks]
- Label: "[Domain name]"
- Represents: [Related but distinct concept]

WESTERN TERRITORY: [Domain Name]
- Shape: Peninsula connected to central continent
- Coastline: Wobbly black line
- Fill: Light cream or white (minimal color)
- Connection: Narrow land bridge to center
- Label: "[Domain name]"
- Represents: [Partially connected concept]

[Continue for all territories...]

GEOGRAPHIC FEATURES:
- Mountain range: Hand-drawn peaks along [border/territory]
  - Represents: [Barrier or challenge]
  - Color: Black (#000000) linework
  - Label: "*mountains of [X]*" in italic

- Rivers: Wobbly flowing lines connecting territories
  - Represents: [Connections or data flows]
  - Color: Black (#000000) or Green (#3A7D44)
  - Label: "*river of [Y]*"

- Bridges: Small illustrated bridges connecting islands/territories
  - Represents: [Integration points]
  - Color: Black (#000000)

- Compass rose: Small decorative compass in corner (optional)
  - Hand-drawn, simple
  - Indigo (#2B4C7E) north arrow

OCEAN/EMPTY SPACE:
- Background: Light cream or white
- Represents: Unknown territory or very different domains
- Blank areas between distant territories

COLOR USAGE:
- Black (#000000) for ALL coastlines, borders, geographic features
- Deep Indigo (#2B4C7E) subtle fill on [primary territory]
- Deep Green (#3A7D44) subtle fill on [secondary territory]
- Light cream/white fills on other territories
- Charcoal (#2D2D2D) for all text labels

CRITICAL REQUIREMENTS:
- Hand-drawn cartographic style (wobbly lines, imperfect shapes)
- Clear territory labels in 3-tier typography
- Physical features represent conceptual relationships
- Strategic color on 1-2 key territories (subtle fills, not solid)
- No gradients, flat colors only
- Navigable and understandable as conceptual geography
- Editorial illustration aesthetic maintained

```

## Examples

Use this intent for "The Landscape of AI Safety", "Map of Cybersecurity Domains", "Territory of Human Capabilities", domain overviews showing relationships, the conceptual geography of a field, and orientation guides for complex topics.

### Example 1: "The AI Capabilities Landscape"
- **Territories:** Reasoning (center, indigo), Creativity (island, green), Perception (west peninsula), Action (east island)
- **Features:** Mountains of complexity, Rivers of data, Bridges of integration
- **Aspect:** 16:9

### Example 2: "Cybersecurity Domain Map"
- **Territories:** Offensive (green island), Defensive (center continent), Governance (north peninsula), Human Layer (south)
- **Features:** Ocean of unknown threats, Mountain range of technical barriers
- **Aspect:** 16:9

### Example 3: "The Problem-Solving Territory"
- **Territories:** Questions (center), Context (surrounding), Blockers (west mountains), Constraints (north), Solutions (east coast)
- **Features:** Rivers connecting domains, Bridges from problems to solutions
- **Aspect:** 1:1
