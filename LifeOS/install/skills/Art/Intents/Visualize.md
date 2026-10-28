# Visualize

> **Palette.** The colour names and hex values in this intent are the skill's neutral defaults (indigo `#2B4C7E` primary accent, green `#3A7D44` secondary accent, umber `#A0522D` warm wash, `#F5F5F0` paper ground). When `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md` § Color palette exists, use its value for each role instead, in prompts, validation and checklists alike, and name its colour words where this file names the defaults.

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Output format · Examples · References

One adaptive visualization image whose form (single-mode, hybrid composition or multi-panel infographic) is chosen from the content and generated with Nano Banana Pro. Inside Art this is the catch-all image when no specialized intent fits; a request that says "visualize" belongs to the Visualize skill, which may call this intent for its image.

## Ideal State

- The visualization's form was chosen from the content, not from a predetermined format: content with one primary dimension uses the specialized intent directly, 2-3 dimensions of equal importance get a HYBRID composition, 4+ distinct dimensions get a MULTI-PANEL infographic (each panel addressing one dimension); primarily quantitative content leads with data visualization and adds conceptual elements as context, primarily conceptual content leads with a metaphor or framework and adds data as supporting evidence, and a story uses a sequential approach (comic, timeline or multi-step), per the Strategy Options and Decision Framework under Output format.
- The chosen form and aspect ratio fit the content's communication goal, audience and destination as mapped under Inputs (for example, a technical audience gets more data, precision and structure; a general audience gets more metaphor, simplification and narrative).
- Before the generation prompt was written, the content analysis, the strategy selection and the composition design each existed in the shapes under Output format (Output from Analysis, Output from Strategy Selection, Output from Design).
- The generation prompt follows the Prompt Template under Output format (with its infographic block for infographics), with a specification for every major element in the composition, the 3-tier typography system and strategic color usage.
- Every number, proportion, label and data point in the image matches the source exactly. A garbled digit, a bar drawn at the wrong height or a misspelled label fails the image.
- The primary message is obvious within 3 seconds: the eye flows from the primary element to the secondary to the tertiary, the elements tell one story instead of competing, the three type tiers are visibly distinct, and every label, chart and icon reads cleanly both as a thumbnail and at full size.
- Infographics use the Excalidraw whiteboard sketch aesthetic: wobbly boxes, sketchy lines, imperfect shapes, hand-lettered text, variable line weight and rich graphics, all sketchy, with indigo/green accents on key elements and mostly black.
- The background is Light Cream #F5E6D3 unless the user explicitly requested white, and the title and subtitle are left-justified, never centered.
- Color is strategic, not on every element: black for structure, Indigo #2B4C7E for critical insights, key data points and the title (10-20%), Green #3A7D44 for secondary data and supporting elements (5-10%), Charcoal #2D2D2D for all text, in flat colors with no gradients or shadows.
- Any people in the image follow the figure treatment (SKILL.md Gotchas: `PREFERENCES.md` § Character design when set, else a varied cast whose appearance the prompt names), and the prompt says so.
- The image was generated through Generate.ts with the model, size and aspect-ratio flags the request maps to (nano-banana-pro at 2K by default).

## Anti-criteria

- A predetermined template, a one-size-fits-all approach, or a single-mode visualization when a combination would be better.
- A hybrid or multi-panel composition used when it does not serve the content.
- Completion declared before validation passes.
- An infographic with perfect geometric shapes, ruler-straight lines and arrows, digital precision, smooth polished vectors, perfect alignment or a clean corporate infographic style.
- A white background the user did not explicitly request, or a centered title or subtitle.

## Inputs

Content of any shape where the best visual form is not obvious: often several dimensions at once (data, narrative, concepts). Content types to look for: quantitative data, qualitative concepts, narrative elements, comparative elements, hierarchical structures, temporal elements, spatial relationships, process flows.

| Communication goal | Leads with |
|--------------------|-----------|
| Explain a complex concept | Conceptual visualization |
| Show data insights | Data visualization dominant |
| Compare alternatives | Comparison/split approach |
| Tell a story | Sequential/narrative visualization |
| Organize information | Taxonomy/grid approach |
| Guide action | Process/recipe format |
| Make memorable | Metaphor + data hybrid |

| Audience | Needs |
|----------|-------|
| Technical audience | More data, precision, structure |
| General audience | More metaphor, simplification, narrative |
| Executive audience | High-level insights, clear takeaways |
| Social media | Punchy, scannable, shareable |
| Consulting deliverable | Professional, multi-faceted, comprehensive |

## Tool contract

| User Says | Flag |
|-----------|------|
| (default), "best", "high quality" | `--model nano-banana-pro` (best quality + text rendering) |
| "fast", "quick", "draft" | `--model nano-banana` (faster, slightly lower quality) |
| "flux", "stylistic variety" | `--model flux` |
| "draft", "preview" / (default), "standard" / "high res", "print", "large" | `--size 1K` / `--size 2K` / `--size 4K` (nano-banana-pro only). `flux` and `nano-banana` take the aspect ratio as `--size` instead (`--size 16:9`) and no resolution tier; `References/Models.md` lists the valid values per model, and the wrong form fails validation. |
| "square", "social" | `--aspect-ratio 1:1` |
| "wide", "slide", "presentation" | `--aspect-ratio 16:9` |
| "portrait", "mobile" | `--aspect-ratio 9:16` |
| "blog header" | `--thumbnail` (transparent + thumb versions) |
| "variations", "options" | `--creative-variations 3` |

```bash
ART_DIR=<working dir outside Downloads>   # e.g. scratchpad/art/<slug>; SKILL.md § Output staging
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --intent=Visualize \
  --model [SELECTED_MODEL] \
  --prompt "[YOUR COMPREHENSIVE PROMPT]" \
  --size [SELECTED_SIZE] \
  --aspect-ratio [chosen ratio] \
  [--thumbnail if for blog] \
  [--creative-variations N if variations requested] \
  --output "$ART_DIR"/visualization.png
```

<!-- ported from public PR #1707 (commit 1), @anikinsasha — Images was retired into Art -->
**For transparent background** — use the **Art skill's** background-removal tool:

```bash
bun ~/.claude/LIFEOS/TOOLS/RemoveBg.ts "$ART_DIR"/visualization.png
```

Look at the image with the Read tool before judging it. Open it for the principal only after the quality loop in SKILL.md passes:
```bash
bun ~/.claude/skills/ArtDirection/Tools/Deliver.ts --artifact "$ART_DIR"/visualization.png --to ~/Downloads
open ~/Downloads/visualization.png
```

No signature is prompted into the model, because a prompted signature garbles (SKILL.md Gotchas); `--signature` stamps one when it is wanted.

## Output format

#### Strategy Options

**A. SINGLE-MODE (Use one specialized intent)**
When content clearly fits one visualization type:
- Pure data → Create data visualization
- Pure concept → Use editorial illustration or framework
- Pure comparison → Use comparison intent
- Pure process → Use recipe card intent

**B. HYBRID COMPOSITION (Combine 2-3 elements)**
When content has multiple dimensions:
- **Data + Metaphor:** Chart/graph with editorial illustration accent
- **Data + Process:** Numbers showing outcomes at each step
- **Concept + Structure:** Framework with illustrated metaphors in quadrants
- **Timeline + Data:** Progression with quantitative milestones
- **Comparison + Data:** Split screen with metrics on each side

**C. MULTI-PANEL INFOGRAPHIC (Dashboard approach)**
When content is complex and multifaceted:
- **Grid layout:** 4-6 panels each showing different aspect
- **Layered composition:** Top section data, middle concepts, bottom process
- **Dashboard:** Multiple charts/graphs with unified design
- **Slide series:** Sequential slides each focusing on one dimension

#### Decision Framework

```
IF content has 1 primary dimension:
  → Use specialized intent directly

IF content has 2-3 dimensions of equal importance:
  → Design HYBRID composition

IF content has 4+ distinct dimensions:
  → Design MULTI-PANEL infographic

IF content is primarily quantitative:
  → Lead with DATA VISUALIZATION
  → Add conceptual elements as context

IF content is primarily conceptual:
  → Lead with METAPHOR/FRAMEWORK
  → Add data as supporting evidence

IF content tells a story:
  → Use SEQUENTIAL approach
  → Could be comic, timeline, or multi-step
```

**Output from Analysis:**
```
CONTENT TYPE: [Primary and secondary types from above]
INFORMATION DENSITY: [Simple / Medium / Complex]
COMMUNICATION GOAL: [Primary purpose]
AUDIENCE: [Who this is for]

KEY ELEMENTS TO VISUALIZE:
1. [Element type: data/concept/narrative/etc.]
2. [Element type]
3. [Element type]
...

VISUALIZATION OPPORTUNITIES:
- Data points that could be charts/graphs
- Concepts that need metaphors or icons
- Comparisons that need side-by-side
- Sequences that need panels or flow
- Hierarchies that need taxonomies or frameworks
```

**Output from Strategy Selection:**
```
VISUALIZATION STRATEGY: [Single-mode / Hybrid / Multi-panel]

CHOSEN APPROACH:
[Describe the specific visualization approach]

COMPOSITION ELEMENTS:
Primary element (60-70%): [Type and purpose]
Secondary element (20-30%): [Type and purpose]
Tertiary element (10%): [Type and purpose - optional]

LAYOUT STRUCTURE:
[Describe how elements are arranged spatially]

ASPECT RATIO: [1:1 / 16:9 / 9:16 / 4:3]
Rationale: [Why this ratio for this content]
```

**Output from Design:**
```
COMPOSITION LAYOUT:
[Detailed spatial description or ASCII diagram]

VISUAL HIERARCHY:
Primary (50-60%): [Element and placement]
Secondary (25-35%): [Element and placement]
Tertiary (10-15%): [Element and placement]

TYPOGRAPHY ASSIGNMENTS:
Tier 1: [Where used - titles, headers]
Tier 2: [Where used - labels, axes]
Tier 3: [Where used - annotations, insights]

COLOR CODING:
Indigo: [Specific elements to highlight]
Green: [Supporting elements]
Black: [Structural elements]
Text: All charcoal

ELEMENT SPECIFICATIONS:
[For each major element, specify:]
- Type (chart/icon/illustration/text)
- Size (% of canvas)
- Position (coordinates or relative placement)
- Style (data viz / editorial / typographic)
```

#### Prompt Template

```
[VISUALIZATION TYPE] in editorial infographic style optimized for Nano Banana Pro.

OVERALL CONCEPT: "[What this visualization communicates]"

STYLE REFERENCE: [Professional infographic / Data journalism / Editorial slide / Mixed media visualization]

BACKGROUND: Light Cream #F5E6D3 (DEFAULT) — only use White #FFFFFF if user explicitly requests it

AESTHETIC:
- Professional infographic quality (deliverable standard)
- Hand-drawn editorial elements where appropriate
- Clean data visualization where precise
- Variable stroke weight (thicker for structure, thinner for details)
- Flat colors, no gradients or shadows
- Readable at multiple scales (works as thumbnail and full-size)

[FOR INFOGRAPHICS, open with "Excalidraw-style whiteboard infographic with rich hand-drawn graphics." and replace AESTHETIC with:]
STYLE: Excalidraw whiteboard sketch aesthetic
- Wobbly rectangles with rough edges (not perfect boxes)
- Sketchy arrows with slight wobble (not ruler-straight)
- Imperfect shapes throughout (circles slightly oval)
- Hand-lettered text labels (natural slant, imperfect)
- Variable line weight (boxes thicker, details thinner)
- Whiteboard/sketch paper feel
- Rich graphics: hand-drawn icons, illustrations and visual metaphors (wobbly, organic), data as sketchy charts, panels as wobbly boxes with headers, flow as sketchy arrows
- Panel headers: geometric sans-serif, bold, uppercase, Black #000000; descriptions in wedge serif

ASPECT RATIO: [1:1 / 16:9 / 9:16 / 4:3]

COMPOSITION STRUCTURE:
[Detailed description of spatial layout]

TYPOGRAPHY SYSTEM (3-TIER HIERARCHY):

TIER 1 - VISUALIZATION HEADER & SUBTITLE (Serif Two-Part System):
Header (Main Title):
- "[Header Text]"
- Font: wedge-serif italic (elegant, sophisticated)
- Size: Large - 3-4x body text (prominent, commanding attention)
- Style: Italicized, sentence case or title case (NOT all-caps)
- Color: Black #000000 (or Indigo #2B4C7E for emphasis)
- Position: Top-left with margin

Subtitle (Clarifying Detail):
- "[Subtitle Text]"
- Font: wedge-serif regular (warm, readable)
- Size: Small - 1-1.5x body text (noticeably smaller than header, supportive)
- Style: Regular (NOT italicized), sentence case (first letter capitalized, rest lowercase except proper nouns)
- Color: Black #000000 or Charcoal #2D2D2D
- Position: Small gap below header, aligned left

TIER 2 - ELEMENT LABELS (Geometric Sans):
- [List all labels: chart axes, data labels, section headers]
- Font: geometric sans-serif, clean, modern
- Size: Medium readable
- Color: Charcoal #2D2D2D
- Positions: [Specify for each]

TIER 3 - ANNOTATIONS (Condensed Italic):
- [List all annotations and insights]
- Font: condensed italic (editorial voice)
- Size: Small (60% of Tier 2)
- Color: Indigo #2B4C7E (insights) or Green #3A7D44 (technical notes)
- Positions: [Near relevant elements]

[FOR EACH MAJOR ELEMENT IN COMPOSITION:]

ELEMENT 1: [TYPE - e.g., Bar Chart / Line Graph / Icon Grid]
- Purpose: [What this element communicates]
- Position: [Location in composition]
- Size: [Dimensions or % of canvas]
- Data to show: [Specific data points or values]
- Style: [Precise data viz / Hand-drawn editorial / Hybrid]
- Color: Black structure, Indigo highlights on [specific], Green on [specific]
- Labels: [Tier 2 typography for all labels]
- Details: [Any specific styling notes]

ELEMENT 2: [TYPE - e.g., Editorial Illustration / Framework Diagram]
- Purpose: [What this element communicates]
- Position: [Location in composition]
- Size: [Dimensions or % of canvas]
- Content: [What to illustrate]
- Style: [Hand-drawn / Iconic / Metaphorical]
- Color: Black linework, Indigo accents on [specific]
- Integration: [How it relates to other elements]

[Continue for all elements...]

PEOPLE (if any): [the figure treatment from `PREFERENCES.md` § Character design when set; otherwise: "the figures are a varied cast, each one's skin tone, age and build named, spanning a natural range; no figure is a stereotype"]; the group never defaults to one ethnicity.

COLOR USAGE (Strategic, not overwhelming):
- Black (#000000): [All primary structure, chart elements, borders]
- Deep Indigo (#2B4C7E): [Critical data points, key insights, optimal zones]
- Deep Green (#3A7D44): [Secondary data, supporting elements]
- Charcoal (#2D2D2D): [All text labels and annotations]
- Background: Light Cream #F5E6D3 (DEFAULT — white only if explicitly requested)

CRITICAL REQUIREMENTS FOR NANO BANANA PRO:
- Exceptional text rendering required (multiple labels, clean typography)
- Data precision where needed (accurate chart rendering)
- Hand-drawn editorial quality where appropriate
- Multi-element composition with clear visual hierarchy
- Professional infographic / slide quality
- Readable at both thumbnail and full resolution
- No gradients, flat colors only
- Strategic color (not every element colored)
- All elements work together as unified composition
```

## Examples

| Pattern | When | Layout | Example | Aspect |
|---------|------|--------|---------|--------|
| Data + Metaphor Hybrid | Data needs conceptual context | 50% data visualization + 40% editorial illustration + 10% explanatory text | Growth chart with rocket ship illustration showing trajectory | 16:9 or 1:1 |
| Comparative Dashboard | Multiple dimensions of comparison | Split or grid with data on each side/panel | "Before AI vs After AI" with metrics and illustrations for each state | 16:9 (split) or 1:1 (grid) |
| Process + Outcomes | Methodology with results | Vertical or horizontal flow with data at key milestones | 5-step recipe with success metrics at each step | 9:16 or 16:9 |
| Icon Quantification | Quantities as repeated elements | Grid of icons where quantity = visual count | "78 out of 100 developers" as 78 indigo icons + 22 gray icons | 1:1 or 4:3 |
| Annotated Data Story | Data needs narrative explanation | Primary chart with hand-drawn annotations | Timeline chart with indigo arrows: "*this is when everything changed*" | 16:9 or 21:9 |
| Multi-Chart Dashboard | Multiple related datasets | Grid of 2-4 charts with unified design language | 4-panel view: bar chart, line graph, pie chart, key stat | 16:9 or 1:1 |
| Framework + Data | Conceptual model with quantitative evidence | Framework structure (2x2, Venn, pyramid) with data in each zone | 2x2 matrix with percentage of companies in each quadrant | 1:1 |
| Infographic Slide | Comprehensive content for presentation | Title + multiple small visualizations + key takeaway | Slide with 3 mini-charts + 2 key stats + insight annotation | 16:9 |

## References

- `Intents/Mermaid.md` — the complete Excalidraw aesthetic specification (node styling, arrows, per-type color strategy).
