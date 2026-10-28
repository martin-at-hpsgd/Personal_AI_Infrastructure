# Annotated Screenshots Intent

> **Palette.** The colour names and hex values in this intent are the skill's neutral defaults (indigo `#2B4C7E` primary accent, green `#3A7D44` secondary accent, umber `#A0522D` warm wash, `#F5F5F0` paper ground). When `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md` § Color palette exists, use its value for each role instead, in prompts, validation and checklists alike, and name its colour words where this file names the defaults.

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Gotchas · Output format · Examples

**Real screenshots with hand-drawn editorial annotations, arrows, and highlights using the house aesthetic.**

## Ideal State

- A screenshot plan (source path, subject, key areas to annotate) and an annotation plan (type, colour, text and position of each annotation, plus which are indigo and which green) existed before the overlay was drawn, in the shapes under Output format.
- The base is the real screenshot file, of UI, code or data, never illustrated or re-rendered: its pixels come from the source, so every character of its text matches the original and stays readable. The only permitted changes to it are a crop to the relevant area and an optional uniform fade or desaturation (80% opacity) so the annotations stand out.
- The overlay reads obviously as hand-drawn commentary on top of the screenshot, not integrated into the UI: wobbly arrows, imperfect circles, underlines, brackets, boxes and callouts with variable stroke weight and the house imperfect, gestural linework, plus hand-lettered annotation text.
- Every mark lands on the element it names: each arrow tip, circle or underline sits on the area its plan entry gives, at the screenshot's exact pixel size.
- Colour carries emphasis: Indigo #2B4C7E on critical annotations, Green #3A7D44 on helpful context, Black #000000 for structural marks (arrows, circles, underlines, boxes), Charcoal #2D2D2D for annotation text that is not indigo or green; not every annotation needs colour.
- Every annotation points at a key insight and actually enhances understanding, written in casual, direct editorial voice that sounds like smart commentary ("*this is the issue*", "*genius design*", "*completely missed the point*", not "Area A shows problem"). Three to five annotations carry the point.
- The image preserves the original screenshot's proportions: its aspect ratio matches the screenshot (16:9, 9:16 for vertical phone UI, 1:1 for square, 21:9 for wide desktop).

## Anti-criteria

- An unreadable screenshot.
- A screenshot passed to an image model as `--reference-image` to produce the base: the model re-renders the whole image, so its text and UI drift from the source and it is no longer the real artifact.
- A polished digital annotation look, or perfect straight arrows or circles.
- Generic corporate callouts ("Feature A") or a formal voice; annotations stay casual and direct.
- Too many annotations (cluttered), or annotations that are random decoration instead of pointing at insights.
- Gradients on annotations.

## Inputs

A screenshot file (UI, code, data or a code snippet) and what to call out.

**Use this intent for:**
- Product reviews with annotated screenshots
- Technical tutorials pointing out UI elements
- UX critiques with visual commentary
- Code reviews with illustrated notes
- "THIS IS THE PROBLEM" arrows and callouts

Things an annotation calls attention to:

   - Problem areas
   - Good examples
   - Workflow steps
   - Hidden features

Annotation types:

   - Arrow pointing to element
   - Circle/box highlighting region
   - Underline or bracket
   - Callout with note

## Tool contract

The overlay is a separate transparent layer at the screenshot's exact pixel size, composited over the untouched screenshot. Authoring it as SVG keeps every mark where the plan puts it; draw paths with deliberate jitter and variable stroke width so they read as pen marks, and leave the SVG without a background.

```bash
D=<working dir outside Downloads>                                   # ArtDirection Deliver.ts hands the result to Downloads
magick identify -format "%w %h" screenshot.png                     # W H: the overlay's size
magick screenshot.png -crop WxH+X+Y +repage "$D"/base.png            # optional crop to the relevant area
magick "$D"/base.png -fill white -colorize 20% "$D"/base.png         # optional fade (about 80% opacity)
rsvg-convert -w W -h H annotations.svg -o "$D"/annotations.png       # overlay, transparent, same W x H as base
magick "$D"/base.png "$D"/annotations.png -compose over -composite "$D"/annotated.png
```

**Match screenshot aspect ratio:**
- Screenshot is 16:9 → Use 16:9
- Screenshot is vertical phone UI → Use 9:16
- Screenshot is square → Use 1:1
- Screenshot is wide desktop → Use 21:9

## Gotchas

Fixes when a validation check fails:

| Problem | Fix |
|---------|-----|
| Screenshot too dark | Lighten/desaturate screenshot layer, increase annotation contrast |
| Annotations too polished | Emphasize "hand-drawn wobbly arrows, imperfect circles, gestural sketch" |
| Voice too formal | Rewrite annotations in casual voice: "*this right here*" |
| Can't tell what's being pointed out | Larger/bolder arrows, clearer pointing direction |
| Too cluttered | Reduce annotations to 3-5 key insights only |
| Looks corporate | Reference "editorial annotation style, smart person's markup, hand-drawn notes" |

## Output format

Screenshot layer: original colors preserved, or slightly faded/grayed (80% opacity) to let annotations stand out.

Annotation overlay:

```
Deep Indigo #2B4C7E — Primary annotations (important callouts)
Deep Green #3A7D44 — Secondary annotations (supporting notes)
Black #000000 — Arrows, circles, underlines
Charcoal #2D2D2D — Annotation text (when not indigo/green)
```

- Indigo for critical annotations ("THIS IS THE ISSUE")
- Green for helpful context ("here's how it works")
- Black for structural annotations (arrows, circles, boxes)
- Annotation text: condensed italic (hand-lettered style), readable against the screenshot

Screenshot plan, recorded before the overlay is drawn:

```
SCREENSHOT SOURCE: [Path to screenshot file]
SUBJECT: [What the screenshot shows]
KEY AREAS TO ANNOTATE:
- Area 1: [Description] — [What to call out]
- Area 2: [Description] — [What to call out]
...
```

Annotation plan:

```
ANNOTATIONS TO ADD:

1. [Area/Element]:
   - Type: [Arrow / Circle / Box / Underline]
   - Color: [Indigo / Green / Black]
   - Text: "[Your commentary]"
   - Position: [Where on screenshot]

2. [Area/Element]:
   - Type: [Annotation type]
   - Color: [Color choice]
   - Text: "[Commentary]"
   - Position: [Location]

...

EMPHASIS:
- Indigo (critical): [Which annotations]
- Green (helpful): [Which annotations]
```

## Examples

### Example 1: Chat UI Critique
- **Screenshot:** A chatbot conversation from your own prototype
- **Annotations:**
  - Indigo arrow: "*this system prompt needs work*"
  - Green circle: "*the answer drifts from the question here*"
  - Black underline: Emphasizing problematic output
- **Aspect:** 16:9

### Example 2: Code Review
- **Screenshot:** Python code snippet
- **Annotations:**
  - Indigo box: "*bottleneck right here*"
  - Green arrow: "*clever use of list comprehension*"
  - Black circle: Highlighting security issue
- **Aspect:** 1:1 (code block)

### Example 3: UX Flow Breakdown
- **Screenshot:** Mobile app workflow (multiple screens)
- **Annotations:**
  - Numbered indigo arrows showing flow
  - Green notes on each step: "*where users drop off*"
  - Black boxes highlighting UI elements
- **Aspect:** 9:16 (vertical phone layout)
