# Comics

> **Palette.** The colour names and hex values in this intent are the skill's neutral defaults (indigo `#2B4C7E` primary accent, green `#3A7D44` secondary accent, umber `#A0522D` warm wash, `#F5F5F0` paper ground). When `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md` § Color palette exists, use its value for each role instead, in prompts, validation and checklists alike, and name its colour words where this file names the defaults.

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Gotchas · Output format · Examples · References

**Comic strips in the house editorial illustration style, NOT cartoonish.**

## Ideal State

- A comic narrative plan (concept, 3 or 4 panels, the arc panel by panel, minimal dialogue, key characters with their accents) and a panel layout plan (horizontal strip, vertical strip or 2x2 grid; panel sizes and content; colour coding) exist before the prompt is built, in the shapes under Output format.
- The strip has 3-4 panels that are obviously sequential (3: setup → action → result; 4: setup → complication → action → result), each building on the last to make a point, with the final panel delivering the punchline or insight. A reader who sees the strip once can say what the point was.
- It is a sophisticated editorial comic, New Yorker cartoon style and not Sunday funnies: smart insight or humor that lands, hand-drawn imperfect gestural linework, the house aesthetic of flat color and black linework, and minimal, simple backgrounds.
- Figures follow the figure style `PREFERENCES.md` § Figure style sets when present; the skill default is simplified, stylized editorial figures with adult proportions, minimal faces, and emotion carried by gesture and silhouette. The same character is recognizable and consistent across all panels.
- Every person follows the figure treatment (SKILL.md Gotchas): `PREFERENCES.md` § Character design when set, else a varied cast whose skin tone, age and build the prompt names; the prompt states it explicitly, and characters keep the same look from panel to panel.
- Dialogue is minimal and supports the visual narrative, in charcoal for readability, every word spelled correctly; colour stays strategic: Black #000000 for all linework, panel borders and outlines, Deep Indigo #2B4C7E on the main character or key element, Deep Green #3A7D44 on a secondary character if needed.

## Anti-criteria

- A cast that defaults to one ethnicity, or breaks the figure treatment set in PREFERENCES.md, is the one hard failure.
- A cartoonish, cutesy, children's-book, clip-art or generic AI illustration style, or silly humor instead of sophisticated insight.
- Figures that break the figure style `PREFERENCES.md` § Figure style sets, big heads or stubby proportions, detailed facial features or big eyes.
- Realistic detailed illustration, busy complex backgrounds, or too much dialogue.
- Inconsistent character design across panels.
- Gradients or shadows.

## Inputs

A concept to explain through a short narrative: an "AGI arrives" scenario, a before/during/after sequence, an illustrated thought experiment, or a multi-step process shown visually.

## Tool contract

| Comic Layout | Aspect Ratio | Reasoning |
|--------------|--------------|-----------|
| 3-panel horizontal | 16:9 or 21:9 | Wide strip format |
| 4-panel horizontal | 21:9 | Extra wide for 4 panels |
| 3-panel vertical | 9:16 | Tall strip |
| 4-panel grid (2x2) | 1:1 | Square balanced |
| Variable | 4:3 | Flexible proportions |

**Default: 16:9 (horizontal)** — Classic comic strip format

```bash
ART_DIR=<working dir outside Downloads>   # e.g. scratchpad/art/<slug>; SKILL.md § Output staging
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --intent=Comics \
  --model nano-banana-pro \
  --prompt "[YOUR PROMPT]" \
  --size 2K \
  --aspect-ratio 16:9 \
  --output "$ART_DIR"/comic.png
```

**Model Recommendation:** nano-banana-pro or flux (both handle sequential panels well). For flux, swap the size flags for `--size 16:9` (no `--aspect-ratio`); `--size 2K` fails validation for flux (`References/Models.md`).

Look at the image with the Read tool before judging it. Open it for the principal only after the quality loop in SKILL.md passes:
```bash
bun ~/.claude/skills/ArtDirection/Tools/Deliver.ts --artifact "$ART_DIR"/comic.png --to ~/Downloads
open ~/Downloads/comic.png
```

No signature is prompted into the model, because a prompted signature garbles (SKILL.md Gotchas); `--signature` stamps one when it is wanted.

## Gotchas

When a check fails, these prompt phrases are the fix:

| Problem | Fix |
|---------|-----|
| Too cartoonish | "Sophisticated editorial style, New Yorker cartoon aesthetic, NOT cartoonish" |
| Can't follow story | Clarify narrative arc: "Panel 1 setup → Panel 2 complication → Panel 3 result" |
| Characters inconsistent | "Same simplified character across all panels, consistent design" |
| Too complex | "Minimal backgrounds, simple scenes, focus on key action" |
| Too much text | "Visual storytelling prioritized, minimal dialogue, brief text" |
| Looks corporate | Reference "hand-drawn editorial comic, imperfect wobbly lines, gestural quality" |
| **Characters too round/cute** | Restate the figure construction from `PREFERENCES.md` § Figure style; default: "Simplified, stylized adult figures. NOT cute, NOT children's book." |
| **Cartoon proportions** | "Adult proportions. Elongated dignified figures. NO big heads, NO stubby limbs." |
| **Too much facial detail** | "Faces are MINIMAL. NO detailed features, NO big eyes. Emotion through GESTURE only." |
| **Generic AI illustration** | Name the figure-style influences from `PREFERENCES.md` § Figure style; default: "Editorial magazine illustration. NOT children's book." |

## Output format

Comic narrative plan, recorded before the layout:

```
COMIC CONCEPT: [What you're illustrating]
PANELS: [3 or 4]

NARRATIVE ARC:
Panel 1: [Setup - what's the initial state]
Panel 2: [Action/Complication - what changes]
Panel 3: [Escalation or Result]
Panel 4: [Punchline/Insight - the point] (if using 4)

DIALOGUE (Minimal):
Panel 1: "[Optional brief text]"
Panel 2: "[Optional brief text]"
Panel 3: "[Optional brief text]"
Panel 4: "[Punchline or insight]"

KEY CHARACTERS:
- [Character/Element 1]: [Description, indigo accent]
- [Character/Element 2]: [Description, green accent if needed]
```

Panel layout plan, recorded before the prompt:

```
PANEL LAYOUT: [Horizontal strip / Vertical strip / Grid]

PANEL STRUCTURE:
- Panel 1: [Same size / Smaller / Larger]
  * Content: [What's shown]
  * Characters: [Positions]
  * Background: [Minimal elements]

- Panel 2: [Size]
  * Content: [What's shown]
  * Characters: [Positions]
  * Background: [Elements]

- Panel 3: [Size]
  * Content: [What's shown]
  * Characters: [Positions]
  * Background: [Elements]

- Panel 4: [Size - often larger for punchline]
  * Content: [What's shown]
  * Characters: [Positions]
  * Background: [Elements]

COLOR CODING:
- Main character/element: Indigo (#2B4C7E) accents
- Secondary: Green (#3A7D44) accents (if needed)
- Backgrounds: Light cream or white, simple
```

Backgrounds are Light Cream #F5E6D3, White #FFFFFF, or different cream and light tones per panel for differentiation.

### Prompt Template

```
Hand-drawn editorial comic strip in New Yorker style.

STYLE REFERENCE: New Yorker cartoon, editorial illustration comic, sophisticated sequential art

BACKGROUND: Light Cream (#F5E6D3) OR varied light tones per panel

AESTHETIC:
- Hand-drawn editorial style (NOT cartoonish or cute)
- Flat color, black linework, house palette
- Simplified but sophisticated character design
- Variable stroke weight (thicker for outlines, thinner for details)
- Gestural imperfect linework
- Minimal backgrounds (not busy scenes)
- Smart humor or insight, not silly

COMIC STRUCTURE: [3-panel / 4-panel] [horizontal strip / vertical strip / grid]

PANEL LAYOUT:
- [Number] panels arranged [horizontally left-to-right / vertically / grid 2x2]
- Each panel has black border (hand-drawn, slightly wobbly)
- Panel sizes: [Equal / Varied - specify which panels larger]

TYPOGRAPHY FOR DIALOGUE (Condensed):
- Minimal text, supports visual narrative
- Font: condensed sans
- Size: Small readable
- Color: Charcoal (#2D2D2D)
- Style: Hand-lettered in speech bubbles or captions

COMIC NARRATIVE: "[Overall concept being illustrated]"

PANEL 1 - [SETUP]:
Scene: [Describe what's happening]
Characters: [Who's present, what they're doing]
- Main character: Simplified figure with Indigo (#2B4C7E) accent on [element]
- Hand-drawn black linework, imperfect
Background: Light cream, minimal [optional elements]
Dialogue: "[Brief text]" OR no text
Represents: [Initial state]

PANEL 2 - [ACTION/COMPLICATION]:
Scene: [What changes or happens]
Characters: [Actions, positions]
- Main character: [Reacting or acting]
- [Optional secondary character]: Green (#3A7D44) accent
Background: [Minimal elements]
Dialogue: "[Brief text]" OR no text
Represents: [The change]

PANEL 3 - [ESCALATION/RESULT]:
Scene: [Situation develops]
Characters: [New positions or states]
- Main character: [Further development]
Background: [Minimal]
Dialogue: "[Brief text]" OR no text
Represents: [Progression]

PANEL 4 - [PUNCHLINE/INSIGHT]: (if using 4 panels)
Scene: [Final state or revelation]
Characters: [Final positions]
- Main character: [Conclusion state]
- Often larger panel for emphasis
Background: [Simple or empty for focus]
Dialogue: "[Punchline or insight text]"
Represents: [The point being made]

CHARACTER DESIGN (CRITICAL):
- [The figure construction and influences from `PREFERENCES.md` § Figure style, when set]
- Adult proportions, elongated and dignified
- NO cute proportions (big heads, stubby limbs)
- Faces are MINIMAL — NOT detailed, NOT cute, NO big eyes
- Emotion through GESTURE and SILHOUETTE only
- Hand-drawn gestural quality
- Consistent character across panels (same visual vocabulary)
- Editorial sophistication — NOT cartoonish, NOT children's book style
- If robots present: same construction as humans, differentiated by green accents

PEOPLE: [the figure treatment from `PREFERENCES.md` § Character design when set; otherwise: "the figures are a varied cast, each one's skin tone, age and build named, spanning a natural range; no figure is a stereotype"]. The group must never default to one ethnicity.

VISUAL CONTINUITY:
- Same character recognizable across all panels
- Consistent hand-drawn style throughout
- Background simplicity maintained in all panels
- Color accents (indigo/green) consistent

COLOR USAGE:
- Black (#000000) for all linework, panel borders, character outlines
- Deep Indigo (#2B4C7E) accent on main character or key element
- Deep Green (#3A7D44) accent on secondary character (if present)
- Charcoal (#2D2D2D) for all dialogue and captions
- Light Cream (#F5E6D3) OR White (#FFFFFF) panel backgrounds
- Minimal flat color fills, mostly linework

CRITICAL REQUIREMENTS:
- Hand-drawn editorial style (NOT cartoonish, NOT clip-art)
- Simplified but sophisticated character design
- Clear narrative flow across panels
- Minimal dialogue (visual storytelling prioritized)
- Strategic indigo/green accents (not overwhelming color)
- No gradients, flat colors only
- Maintains house aesthetic (black linework, flat color, imperfect)
- Smart insight or humor (sophisticated, not silly)
```

## Examples

### Example 1: "AGI Arrives" (4 panels)
- **Panel 1:** Person at desk, normal work
- **Panel 2:** AGI announcement (computer screen glowing)
- **Panel 3:** Person staring, processing
- **Panel 4:** Person still at desk: "...so what do I do now?"
- **Layout:** Horizontal 21:9
- **Character:** Indigo accent on person

### Example 2: "Security Theater vs Real Security" (3 panels)
- **Panel 1:** Fancy lock on cardboard door (theater)
- **Panel 2:** Simple lock on solid door (real)
- **Panel 3:** Thief easily bypassing fancy lock, stopped by simple door
- **Layout:** Horizontal 16:9
- **Accents:** Indigo on real security, green on theater

### Example 3: "Junior vs Senior Engineer" (4 panels grid)
- **Panel 1 (top-left):** Junior with complex spaghetti code
- **Panel 2 (top-right):** Senior with simple elegant line
- **Panel 3 (bottom-left):** Both present to boss
- **Panel 4 (bottom-right):** Boss confused by junior's complexity, nodding at senior's simplicity
- **Layout:** Grid 1:1
- **Accents:** Indigo on senior, green on junior

## References

- SKILL.md Gotchas, people rule.
