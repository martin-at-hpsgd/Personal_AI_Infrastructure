# Mermaid

> **Palette.** The colour names and hex values in this intent are the skill's neutral defaults (indigo `#2B4C7E` primary accent, green `#3A7D44` secondary accent, umber `#A0522D` warm wash, `#F5F5F0` paper ground). When `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md` § Color palette exists, use its value for each role instead, in prompts, validation and checklists alike, and name its colour words where this file names the defaults.

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Output format · Examples

A Mermaid-structured technical diagram (flowchart, sequence, state, class, ER, Gantt, git graph) drawn in the Excalidraw hand-drawn whiteboard style with the install palette (`PREFERENCES.md` § Color palette, else the defaults below), derived from the content through a story explanation.

## Ideal State

- A 24-item story explanation of the content, made with /cse, existed before the diagram type and structure were chosen, with its structural elements (processes, decisions, states, entities, flows, conditions) identified in the CSE analysis shape under Output format; the diagram is derived from it.
- The prompt names every node and every arrow of that structure (the NODE and ARROW entries in the template), and the image shows exactly those: every element from the CSE represented, no extra node, no missing or misspelled label, no arrow pointing to the wrong node. One garbled label fails the diagram.
- The diagram uses the PRIMARY Mermaid diagram type that captures the content's main structure and follows that type's conventions: decision diamonds with exactly two exits for flowcharts, lifelines with time flowing down for sequence diagrams, a filled initial state and a double-circle final state for state diagrams, cardinality on class and ER relationships.
- It looks sketched on a whiteboard in the Excalidraw style: wobbly shapes with no perfect rectangles or circles, sketchy arrows with organic curves, hand-lettered text with a natural slant, variable line weight, and organic joins.
- It keeps the house editorial style: black dominant for most structure, indigo on critical nodes (10-20%), green on secondary (5-10%), charcoal text, 3 typography tiers clear, flat colors with no gradients; indigo and green play the roles the diagram-type table under Output format gives them.
- It is readable and clear despite the sketch style: all labels legible, the flow obvious, the critical path clear through indigo highlights, spacing adequate, and readable at thumbnail and full-size.
- It was generated with nano-banana-pro at the aspect ratio its diagram type calls for (16:9 by default), kept on a white background as a one-off or quick preview, and drawn on the destination page's own ground (PREFERENCES.md § Color palette) when it goes into a blog or website, so it composites with no visible seam and needs no background cut.

## Anti-criteria

- Never skips the story-explanation step, and never derives the diagram structure from a glance at the content: the diagram is always derived from the written 24-item analysis, never manually specified. Where `/cse` and the StoryExplanation skill are not installed (they are maintainer-side, not in the public release payload), write the 24 numbered items yourself in the same CSE analysis shape; that is the step, not a skip.
- Never declares completion until validation passes.
- Never runs `RemoveBg.ts` or `--remove-bg` on the diagram: rembg reads thin black linework on a light field as background and strips it to a near-empty ghost (SKILL.md Gotchas, 2026-05-11 flowchart).
- Never perfect geometric shapes, ruler-straight arrows, digital precision, smooth curves (too polished), perfect alignment, or vector crispness.

## Inputs

Content with inherent diagram structure (flow, sequence, states, relationships, timeline, branching). A diagram whose value depends on exact text or numbers (code identifiers, hex values, measured figures) takes TechnicalDiagrams' vector-text route (`Tools/AnimatedDiagram.ts`, whose poster PNG is the static image), because an image model can garble any label. Not for freeform architecture diagrams (`Intents/TechnicalDiagrams.md`, a cleaner hand-drawn style), abstract conceptual metaphors (`Intents/Essay.md`) or data visualizations (`Intents/Visualize.md`).

## Tool contract

```bash
/cse [content or URL]   # maintainer-side; on a public install write the 24 numbered items yourself
```

```bash
ART_DIR=<working dir outside Downloads>   # e.g. scratchpad/art/<slug>; SKILL.md § Output staging
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --intent=Mermaid \
  --model nano-banana-pro \
  --prompt "[YOUR COMPREHENSIVE PROMPT]" \
  --size 2K \
  --aspect-ratio [chosen ratio] \
  --output "$ART_DIR"/mermaid-diagram.png
```

<!-- ported from public PR #1707 (commit 1), @anikinsasha — Images was retired into Art -->
For blog or website use, put the page ground in the prompt ("background: flat [page ground colour and hex], no texture", the ground from `PREFERENCES.md` § Color palette) instead of cutting the background afterwards.

Look at the image with the Read tool before judging it. Open it for the principal only after the quality loop in SKILL.md passes:
```bash
bun ~/.claude/skills/ArtDirection/Tools/Deliver.ts --artifact "$ART_DIR"/mermaid-diagram.png --to ~/Downloads
open ~/Downloads/mermaid-diagram.png
```

No signature is prompted into the model, because a prompted signature garbles (SKILL.md Gotchas); `--signature` stamps one when it is wanted.

## Output format

**Output from CSE Analysis:**
```
24-ITEM STORY EXPLANATION:
1. [Item 1]
2. [Item 2]
...
24. [Item 24]

STRUCTURAL ELEMENTS IDENTIFIED:
- Processes: [List of distinct processes/actions]
- Decisions: [List of decision points with conditions]
- States: [List of distinct states]
- Entities: [List of actors/objects/components]
- Flows: [List of connections and sequences]
- Conditions: [List of triggers and transitions]
```

When several types fit, the PRIMARY type is chosen and the alternatives can be noted.

### Diagram types

| Diagram Type | Typical Aspect Ratio | Indigo | Green | Black |
|--------------|---------------------|--------|------|-------|
| Flowchart (vertical) | 9:16 or 4:3 | main success / happy path | error handling or alternative paths | decision nodes and structure |
| Flowchart (horizontal) | 16:9 or 21:9 | main success / happy path | error handling or alternative paths | decision nodes and structure |
| Sequence diagram | 16:9 | critical actor, its activation bars filled | secondary actors | all messages and arrows |
| State diagram | 1:1 | active, current or important states | intermediate states | terminal and error states, all transitions |
| Class diagram | 1:1 or 4:3 | core entities | related entities | relationship lines (attribute text charcoal) |
| ER diagram | 16:9 or 1:1 | core entities | related entities | relationship lines (attribute text charcoal) |
| Gantt chart | 16:9 or 21:9 | critical path | secondary tasks | structure |
| Git graph | 16:9 | critical path | alternative branches | structure |

**Default: 16:9** — Works for most diagram types

### Prompt Template

```
Hand-drawn Mermaid [DIAGRAM TYPE] in Excalidraw whiteboard sketch style.

STYLE REFERENCE: Excalidraw whiteboard diagram, hand-drawn flowchart, sketchy technical diagram

BACKGROUND: [White #FFFFFF for a one-off / the destination page's ground from PREFERENCES.md § Color palette / Light Cream #F5E6D3] — whiteboard/sketch paper feel

AESTHETIC:
- Excalidraw hand-drawn style (wobbly, sketchy, organic)
- Whiteboard sketch quality (looks hand-drawn, not digital)
- Rough edges on all shapes (rectangles not perfect, circles slightly oval)
- Sketchy arrows (gentle curves, slight wobble, not ruler-straight)
- Hand-lettered text labels (imperfect alignment, natural slant)
- Variable line weight (boxes thicker, arrows medium, details thinner)
- Organic connections (lines join naturally, small overlaps at nodes)
- NO digital precision, NO perfect geometry, NO smooth vectors

DIAGRAM TYPE: [Flowchart / Sequence Diagram / State Diagram / etc.]

OVERALL STRUCTURE:
[Describe the complete diagram flow, e.g.:]
- [DIAGRAM TYPE] showing [what it represents]
- Layout: [Top-to-bottom / Left-to-right / etc.]
- [Number] main nodes/states/entities
- Critical path highlighted in indigo
- Alternative paths in green

TYPOGRAPHY SYSTEM (3-TIER HIERARCHY):

TIER 1 - DIAGRAM HEADER & SUBTITLE (Serif Two-Part System):
Header (Main Title):
- "[Header Text]"
- Font: wedge-serif italic (elegant, sophisticated)
- Size: Large - 3-4x body text (prominent, commanding attention) (refined, not overwhelming)
- Style: Italicized, sentence case or title case (NOT all-caps)
- Color: Black #000000 (or Indigo #2B4C7E for emphasis)
- Position: Top-left with margin
- Example: "User Authentication Flow"

Subtitle (Clarifying Detail):
- "[Subtitle Text]"
- Font: wedge-serif regular (warm, readable)
- Size: Small - 1-1.5x body text (noticeably smaller than header, supportive)
- Style: Regular (NOT italicized), sentence case (first letter capitalized, rest lowercase except proper nouns)
- Color: Black #000000 or Charcoal #2D2D2D
- Position: Small gap below header, aligned left
- Example: "Security Validation Process"

TIER 2 - NODE LABELS & DESCRIPTIONS (Geometric Sans + Serif):
Technical Node Labels — geometric sans:
- Labels inside boxes/nodes for technical identifiers
- Font: geometric sans, functional, precise
- Size: Medium readable
- Color: Charcoal #2D2D2D
- Style: Hand-drawn interpretation, slightly imperfect
- Examples: "Auth Service", "Database", "API Gateway"

Human/Process Descriptions — wedge serif:
- Process descriptions, human-readable actions
- Font: wedge serif, warm, narrative
- Size: Medium (same as geometric sans)
- Color: Charcoal #2D2D2D
- Style: Natural, readable, explanatory
- Examples: "Validate credentials", "Check permissions", "Send confirmation"

TIER 3 - EDGE LABELS & ANNOTATIONS (Condensed Italic + Serif):
Edge Labels/Conditions — Condensed (or Serif):
- Labels on arrows/connections, conditions
- Font: condensed (voice) or wedge serif (neutral)
- Size: 60% of Tier 2
- Color: Charcoal #2D2D2D
- Style: Hand-written notes along arrows
- Examples: "Yes", "No", "timeout", "success", "error"

Insights/Commentary — Condensed Italic:
- Critical observations, editorial voice
- Font: condensed italic
- Size: 60% of Tier 2
- Color: Indigo #2B4C7E or Green #3A7D44
- Examples: "*this is where it breaks*", "*performance bottleneck*"

DIAGRAM COMPONENTS (Excalidraw Style):

[LIST EACH NODE/COMPONENT:]

NODE 1: [Type - e.g., START NODE]
- Shape: [Rounded rectangle / Circle / etc.]
- Label: "[Label text]"
- Style: Wobbly hand-drawn edges, slightly asymmetric
- Color: Black (#000000) outline, no fill OR subtle cream fill
- Size: [Relative size]
- Position: [Location in layout]

NODE 2: [Type - e.g., PROCESS BOX]
- Shape: Rectangle with rough edges
- Label: "[Action description]"
- Style: Wobbly lines, slightly tilted, hand-drawn imperfection
- Color: Indigo (#2B4C7E) outline — CRITICAL PATH
- Fill: Light cream or transparent
- Size: [Relative size]
- Position: [Below Node 1]

NODE 3: [Type - e.g., DECISION DIAMOND]
- Shape: Diamond/rhombus with wobbly edges
- Label: "[Question?]"
- Style: Hand-drawn, asymmetric diamond, organic edges
- Color: Black (#000000) outline
- Fill: Transparent or very light cream
- Size: [Relative size]
- Position: [Below Node 2, centered]

NODE 4: [Type - e.g., PROCESS BOX - ALTERNATIVE PATH]
- Shape: Rectangle with rough edges
- Label: "[Alternative action]"
- Style: Wobbly lines, slightly tilted
- Color: Green (#3A7D44) outline — SECONDARY PATH
- Fill: Light cream or transparent
- Size: [Relative size]
- Position: [To the side, alternative branch]

NODE 5: [Type - e.g., END NODE]
- Shape: Rounded rectangle or double circle
- Label: "[Terminal state]"
- Style: Hand-drawn, organic curves
- Color: Black (#000000) outline
- Fill: Subtle fill or transparent
- Size: [Relative size]
- Position: [Bottom of diagram]

[Continue for all nodes...]

CONNECTIONS (Sketchy Arrows):

ARROW 1: [Node A] → [Node B]
- Style: Sketchy hand-drawn arrow, slight curve even if "straight"
- Path: [Describe route, e.g., "curves gently from Node 1 down to Node 2"]
- Color: Black (#000000)
- Label: [Optional label text, e.g., "process" or condition]
- Arrowhead: Hand-drawn triangle, slightly asymmetric

ARROW 2: [Node C] → [Node D]
- Style: Sketchy arrow with organic wobble
- Path: [Describe route]
- Color: Black (#000000)
- Label: "[Yes]" in small hand-written style
- Arrowhead: Rough triangle

[Continue for all arrows/connections...]

SPECIAL ELEMENTS (if applicable):

[For Sequence Diagrams:]
- Actor boxes: Hand-drawn rectangles at top
- Lifelines: Dashed vertical lines (hand-drawn, wobbly)
- Activation boxes: Rectangles on lifelines (indigo for key)
- Messages: Arrows between lifelines with labels

[For State Diagrams:]
- Initial state: Filled circle (hand-drawn)
- Final state: Double circle (wobbly concentric circles)
- State boxes: Rounded rectangles with rough edges
- Transition arrows: Curved arrows with condition labels

[For Class/ER Diagrams:]
- Class boxes: Three-section rectangles (wobbly dividers)
- Relationship lines: Different arrow styles for different relationships
- Cardinality labels: Hand-written "1", "*", "0..1", etc.

COLOR USAGE (Strategic; PREFERENCES.md § Color palette replaces these defaults):
- Black (#000000): All primary structure (most boxes, all arrows)
- Deep Indigo (#2B4C7E): Critical path nodes, main flow, key entities (10-20% of nodes)
- Deep Green (#3A7D44): Alternative paths, secondary entities (5-10% of nodes)
- Charcoal (#2D2D2D): All text labels (node labels, arrow labels)
- Background: White (#FFFFFF), Light Cream (#F5E6D3), or the destination page's ground (PREFERENCES.md § Color palette)

CRITICAL REQUIREMENTS:
- Excalidraw hand-drawn aesthetic (wobbly, sketchy, organic)
- Mermaid diagram structure ([chosen type] grammar)
- house color scheme (indigo for critical, green for secondary, black structure)
- 3-tier typography (title, node labels, edge labels)
- Whiteboard sketch feel (not polished, not digital)
- All shapes imperfect (rectangles wobbly, circles oval, arrows curved)
- Variable line weight (thicker boxes, medium arrows, thin details)
- Hand-lettered text (natural slant, imperfect alignment)
- Strategic color (not everything colored, mostly black structure)
- Readable and clear despite sketch style
- Follows [Mermaid diagram type] conventions
```

## Examples

| Content | Diagram type | Structure | Colour | Aspect |
|---------|--------------|-----------|--------|--------|
| Blog post about user authentication | Flowchart | Start → Enter Credentials → Valid? → [Yes] → Generate Token → Success; [No] → Retry Limit? → [Yes] → Lock Account, [No] → back to Enter | Indigo on success path, green on error handling | 9:16 vertical |
| Article about microservices communication | Sequence diagram | 4 actors (User, Gateway, Auth, DB) with request/response message arrows | Indigo on Gateway (critical), green on Auth | 16:9 |
| E-commerce order processing | State diagram | Initial → Pending → Processing → Shipped → Delivered → Final; Processing → (error) → Cancelled | Indigo on happy-path states, green on processing, black on cancelled | 1:1 |
| Data model for a blog platform | ER diagram | User 1──* Post, Post 1──* Comment, Post *──* Category | Indigo on User and Post, green on Comment and Category | 16:9 |
