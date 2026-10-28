---
contract:
  requires: []
  bans:
    - '/\b(gouache|water ?colou?rs?|ghibli|mary blair|storybook|children.?s[ -]book|pixar|anime|oil[ -]paint(ing|ed)?)\b/i'
  mandates: ['/\bcharcoal\b/i']  # the install palette words come from USER ArtConfig.json contractOverrides
---

# SalesVisual

> **Palette.** The colour names and hex values in this intent are the skill's neutral defaults (indigo `#2B4C7E` primary accent, green `#3A7D44` secondary accent, umber `#A0522D` warm wash, `#F5F5F0` paper ground). When `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md` § Color palette exists, use its value for each role instead, in prompts, validation and checklists alike, and name its colour words where this file names the defaults.

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Output format · Gotchas · References

A square, transparent-background charcoal gestural sketch for a sales narrative or value proposition, used by `skills/Presentation/Intents/Pitch.md` (ported from the retired Sales skill, audit 2026-10-10; public PR #2128, @pai-scaffolde; split out of the Essay intent 2026-10-11 because Generate.ts refused it there).

## Ideal State

- The Scene Construction Template under Output format was filled in from the pitch narrative before the prompt was written, and the prompt is built from it with the sales prompt template.
- The image matches the narrative's emotional register, taken from the Value Proposition Type table, with its warm:cool ratio.
- Its concrete subjects are visible, the composition is minimalist with empty space around centered subjects, and a stranger could connect it to the value proposition.
- It reads as charcoal gestural sketch in the Essay intent's technique, figure treatment and Umber/Indigo washes, never clean vectors.
- It is 1:1, the background is transparent (`file` reports RGBA), and it carries the programmatic DA-name signature in the bottom-right, stamped after the background cut.
- Every figure in it follows the figure treatment in SKILL.md Gotchas (the skill default, or `PREFERENCES.md` § Character design when set).
- It was rendered in a working directory outside Downloads (SKILL.md § Output staging), looked at with the Read tool, and passed the quality loop before hand-off.

## Anti-criteria

- Never a montage of everything the product does.
- No text of any kind in the image other than the stamped signature, and the signature is never prompted into the model (the Sales original prompted it; models garble prompted text).
- A failing image is never delivered; it is regenerated with an adjusted prompt.
- Never run with `--intent=Essay`: that loads the Essay contract, which needs a post slug, `cse.md` and `composition.md` this intent does not have.

## Inputs

- A sales narrative or value-proposition summary, plus an optional target emotional response (derived from the table below when absent).

## Tool contract

```bash
ART_DIR=<working dir outside Downloads>   # e.g. scratchpad/art/<slug>; SKILL.md § Output staging
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --intent=SalesVisual \
  --model nano-banana-pro \
  --prompt "[YOUR PROMPT]" \
  --size 2K \
  --aspect-ratio 1:1 \
  --remove-bg \
  --signature \
  --output "$ART_DIR"/[name].png
# then Read "$ART_DIR"/[name].png and check every subject survived the cut
```

`--signature` stamps the DA name after the background cut, so it survives on the transparent PNG. The full-page-width aspect check (trimmed aspect at least 1.4) applies only to Essay and TechnicalDiagrams, so the 1:1 canvas passes. The contract above enforces the house medium: the prompt must name charcoal, umber and indigo and may not name another medium. `--dry-run` checks the intent and contract without loading credentials.

## Output format

**Value Proposition Type → emotional register**

| Value Proposition Type | Emotional Register | Warm:Cool |
|------------------------|-------------------|-----------|
| **Solves painful problem** | HOPE / POSSIBILITY | 80:20 |
| **Prevents disaster/risk** | URGENCY / WARNING | 60:40 |
| **Enables new capabilities** | WONDER / DISCOVERY | 40:60 |
| **Saves time/effort** | DETERMINATION / EFFORT | 70:30 |
| **Deep expertise/insight** | CONTEMPLATION | 50:50 |
| **Team/collaboration** | CONNECTION | 90:10 |
| **Replaces legacy/old way** | MELANCHOLY (for old) + HOPE (for new) | 60:40 |

**Scene Construction Template** (the visual concept, written before the prompt)

```
VALUE PROPOSITION: [One sentence summary of what matters]
CONCRETE SUBJECTS: [Specific nouns that MUST appear visually]
VISUAL METAPHOR: [What scene captures this value?]
EMOTIONAL REGISTER: [From the table above]
WARM:COOL RATIO: [From the table above]
```

**Sales prompt template**

```
Sophisticated charcoal architectural sketch. [ARTIST REFERENCE] influence.

EMOTIONAL REGISTER: [From the table above]

SCENE:
[Visual scene from the Scene Construction Template]

MINIMALIST COMPOSITION:
- Subject(s) CENTERED in the frame
- Empty/negative space around — NO filled-in backgrounds
- Clean, gallery-worthy simplicity
- Supporting objects that serve the narrative (gestural, minimal)

CONCRETE SUBJECTS:
[List specific subjects that MUST appear]

HUMAN FIGURE — GESTURAL ABSTRACTED SKETCH:
- MULTIPLE OVERLAPPING LINES suggesting the form
- Quick, confident, ENERGETIC gestural marks
- Warm Umber (#A0522D) WASH accent touches
- the figure treatment sentence: `PREFERENCES.md` § Character design when set, else "the figures are a varied cast, each one's skin tone, age and build named, spanning a natural range; no figure is a stereotype"

[If AI/tech figure:]
ROBOT/TECH FIGURE — GESTURAL ANGULAR SKETCH:
- Angular rigid gestural marks
- Deep Indigo (#2B4C7E) WASH accent touches

LINEWORK:
- Loose charcoal/graphite pencil strokes
- Visible hatching and gestural marks
- NOT clean vectors, NOT smooth

COLOR — CHARCOAL DOMINANT:
- CHARCOAL AND GRAY DOMINANT — 85%
- Umber accents on human elements
- Indigo accents on tech elements
- Background is EMPTY — white/cream negative space
- Transparent background

CRITICAL:
- MINIMALIST composition
- Visual captures the VALUE PROPOSITION
- Gallery-worthy gestural sketch aesthetic

NO text of any kind.
```

## Gotchas

- **The minimalist look is deliberate here.** The Essay intent warns that the model obeys "minimalist" literally; for a sales visual that is the intended result, and the white/cream negative space is cut away by `--remove-bg`.
- **The background cut can erase a secondary subject or the signature** (SKILL.md Gotchas, 2026-09-23). Keep the raw when the scene has more than one subject, and Read the cut PNG before judging it.

## References

- `Intents/Essay.md` — the charcoal technique, HUMAN FIGURES block and figure-treatment language this intent reuses.
- `skills/Presentation/Intents/Pitch.md` — the CreateVisual and CreateSalesPackage callers.
