# RecipeCards

> **Palette.** The colour names and hex values in this intent are the skill's neutral defaults (indigo `#2B4C7E` primary accent, green `#3A7D44` secondary accent, umber `#A0522D` warm wash, `#F5F5F0` paper ground). When `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md` § Color palette exists, use its value for each role instead, in prompts, validation and checklists alike, and name its colour words where this file names the defaults.

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Gotchas · Output format · Examples

Step-by-step visual recipes for processes and methodologies in the house aesthetic: illustrated how-to guides with numbered steps and a small hand-drawn illustration per action, combining procedural clarity with editorial style so complex processes are scannable and memorable.

## Ideal State

- A process definition (Step 1 shape under Output format) existed before the prompt was written: process name, outcome, each step with its action description and icon metaphor, and the critical step(s) marked for indigo.
- A recipe card layout plan (Step 2 shape under Output format) existed before the prompt was written: layout style (vertical list, grid such as 2x3 for 6 steps, horizontal flow, or circular for process loops), what each step shows (numbered badge, small icon, step name, brief description, arrow to the next step), icon metaphors and color coding.
- The card holds 3-7 steps; a longer process becomes several cards rather than one crowded card.
- Every step number, step name and description in the image matches the process definition exactly and in order: no skipped, duplicated, renumbered or garbled steps.
- The flow reads 1 → 2 → 3 → outcome without effort: numbered badges and connecting arrows on every step.
- Each step has one simple hand-drawn icon recognizable at a glance, never a detailed scene.
- Every label is legible at the delivered size in the three typography tiers (title, step names, descriptions).
- Indigo marks only the critical step(s) and the final outcome; the rest is black linework with charcoal text, flat, no gradients.
- The card is client-ready: it could go into a consulting deliverable without edits, and a card that needs any edit before it can be included fails.
- The PNG reaches Downloads only through ArtDirection's `Deliver.ts`, rendered in a working directory outside Downloads (SKILL.md § Output staging), at the aspect ratio its layout type calls for (default 9:16).

## Anti-criteria

- Complex detailed illustrations (should be simple icons).
- Cluttered layout (too much information).
- Illegible small text.
- Missing step numbers.
- Unclear flow or progression.
- Corporate process diagram look.

## Inputs

The process or methodology to turn into a recipe: its name, the outcome it achieves, and its steps in sequence.

## Tool contract

Aspect ratio by recipe type (`--aspect-ratio`):

| Recipe Type | Aspect Ratio | Reasoning |
|-------------|--------------|-----------|
| Vertical list (3-7 steps) | 9:16 or 4:3 | Tall card format |
| Grid layout (6-9 steps) | 1:1 | Square balanced grid |
| Horizontal flow | 16:9 | Wide linear progression |
| Circular process | 1:1 | Square for circular symmetry |

**Default: 9:16 (vertical)** — Classic recipe card orientation

```bash
ART_DIR=<working dir outside Downloads>   # e.g. scratchpad/art/<slug>; SKILL.md § Output staging
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --intent=RecipeCards \
  --model nano-banana-pro \
  --prompt "[YOUR PROMPT]" \
  --size 2K \
  --aspect-ratio 9:16 \
  --output "$ART_DIR"/recipe-card.png
```

nano-banana-pro is the model for this intent (best text rendering for steps).

Look at the image with the Read tool before judging it. Open it for the principal only after the quality loop in SKILL.md passes:
```bash
bun ~/.claude/skills/ArtDirection/Tools/Deliver.ts --artifact "$ART_DIR"/recipe-card.png --to ~/Downloads
open ~/Downloads/recipe-card.png
```

## Gotchas

If validation fails, these prompt fixes apply:

| Problem | Fix |
|---------|-----|
| Icons too complex | "Simple hand-drawn icons, minimal detail, recognizable at glance" |
| Can't follow flow | "Clear numbered badges 1→2→3, black arrows connecting steps" |
| Too cluttered | Reduce description text, simplify layout |
| Looks corporate | Reference "recipe card aesthetic, hand-drawn playbook, editorial style" |
| Text unreadable | Increase Tier 2/3 text sizes, more spacing |
| Missing emphasis | "Indigo (#2B4C7E) on Step [X] critical and final outcome step" |

## Output format

### Step 1 process definition

```
PROCESS NAME: [The X Recipe / X-Step Y Method]
OUTCOME: [What this process achieves]

STEPS:
1. [Step name] — [Action description] — [Icon metaphor]
2. [Step name] — [Action description] — [Icon metaphor]
3. [Step name] — [Action description] — [Icon metaphor]
4. [Step name] — [Action description] — [Icon metaphor]
5. [Step name] — [Action description] — [Icon metaphor]

CRITICAL STEPS (Indigo):
- [Which step(s) are most important]
```

### Step 2 layout plan

```
LAYOUT: [Vertical list / Grid / Horizontal flow / Circular]

CARD STRUCTURE:
- Title at top (Tier 1 typography)
- [X] steps arranged [vertically/in grid]
- Each step contains:
  * Numbered badge (e.g., "1" in circle)
  * Small hand-drawn icon/illustration
  * Step name (Tier 2)
  * Brief description (Tier 3)
- Arrows or lines connecting steps
- Final outcome emphasized

ICON METAPHORS:
Step 1: [Simple icon, e.g., "magnifying glass" for discover]
Step 2: [Icon, e.g., "lightbulb" for ideate]
Step 3: [Icon, e.g., "hammer" for build]
...

COLOR CODING:
- Step [X] (critical): Indigo badge and icon accents
- Step [Y] (outcome): Indigo emphasis
- Other steps: Black badges, minimal color
```

### Prompt Template

Palette: Black #000000 for step numbers, dividing lines and icon outlines; Deep Indigo #2B4C7E for critical steps and the outcome (final) step; Deep Green #3A7D44 for supporting steps or inputs; Charcoal #2D2D2D for all body text and descriptions; background Light Cream #F5E6D3 (recipe card warmth) or White #FFFFFF. Icons are simple and represent the action of their step.

```
Hand-drawn process recipe card in editorial style.

STYLE REFERENCE: Recipe card, visual playbook, illustrated step-by-step guide

BACKGROUND: [Light Cream #F5E6D3 OR White #FFFFFF] — clean, card-like

AESTHETIC:
- Recipe card layout (organized, scannable)
- Hand-drawn step icons (simple, imperfect, editorial style)
- Numbered steps with clear progression
- Variable stroke weight (icons and dividing lines)
- Professional but human quality (deliverable to clients)

LAYOUT TYPE: [Vertical list / Grid / Horizontal flow]

CARD STRUCTURE:
[Describe the overall layout, e.g.:]
- Title at top
- 5 steps arranged vertically down the card
- Each step has: numbered badge → icon → name → description
- Arrows connecting steps showing flow
- Final step emphasized with indigo accent

TYPOGRAPHY SYSTEM (3-TIER):

TIER 1 - RECIPE TITLE (Hand-Lettered Block Display):
- "[PROCESS NAME]" — Large at top
- Font: display style, extra bold, hand-lettered, all-caps
- Size: 3x larger than body text
- Color: Black #000000
- Example: "THE 5-STEP PROBLEM ANALYSIS RECIPE"

TIER 2 - STEP NAMES (Geometric Sans):
- "Step 1: [Name]", "Step 2: [Name]", etc.
- Font: geometric sans-serif
- Size: Medium readable
- Color: Charcoal #2D2D2D (or Indigo for critical step)
- Position: Next to each step icon

TIER 3 - STEP DESCRIPTIONS (Condensed):
- Brief action description for each step
- Font: condensed sans (smaller)
- Size: 60% of Tier 2
- Color: Charcoal #2D2D2D
- Position: Below step name

PROCESS STEPS TO ILLUSTRATE:
[List each step in detail, e.g.:]

STEP 1: [Step Name]
- Number badge: "1" in black circle
- Icon: [Hand-drawn simple icon, e.g., "magnifying glass examining document"]
- Description: "[Brief action description]"
- Color: Black linework
- Arrows: Black arrow pointing to Step 2

STEP 2: [Step Name]
- Number badge: "2" in black circle
- Icon: [Hand-drawn icon, e.g., "hands sorting cards"]
- Description: "[Action description]"
- Color: Black linework
- Arrows: Black arrow pointing to Step 3

STEP 3: [Critical Step Name]
- Number badge: "3" in Indigo (#2B4C7E) circle — CRITICAL STEP
- Icon: [Hand-drawn icon with indigo accents]
- Description: "[Action description]"
- Color: Indigo (#2B4C7E) accents on icon and badge
- Arrows: Indigo arrow pointing to Step 4

[Continue for all steps...]

FINAL STEP [X]: [Outcome]
- Number badge: "[X]" in Indigo (#2B4C7E) circle — OUTCOME
- Icon: [Success/completion icon, e.g., "trophy", "checkmark", "rocket"]
- Description: "[Outcome achieved]"
- Color: Indigo (#2B4C7E) emphasis
- Represents: Final result of process

CONNECTING ELEMENTS:
- Hand-drawn arrows between steps (wobbly, imperfect)
- Dotted or dashed lines for optional paths
- All arrows in Black (#000000) except critical path (Indigo)

COLOR USAGE:
- Black (#000000) for most step badges, icons, arrows
- Deep Indigo (#2B4C7E) for critical step(s) and final outcome
- Deep Green (#3A7D44) optional for input/supporting steps
- Charcoal (#2D2D2D) for all text

CRITICAL REQUIREMENTS:
- Hand-drawn recipe card aesthetic (not polished diagram)
- Simple scannable icons for each step (not detailed illustrations)
- Clear numbered progression (1 → 2 → 3 → outcome)
- 3-tier typography hierarchy
- Strategic indigo emphasis on critical/outcome steps
- No gradients, flat colors only
- Professional deliverable quality (client-ready)
- Recipe card proportions (vertical card layout)

```

## Examples

Use this intent for consulting methodology playbooks, how-to guides, workflow documentation, best practice checklists, and strategic frameworks with steps.

### Example 1: "5-Step Problem Analysis Recipe"
- **Steps:** Context → Questions → Blockers → Constraints → Solutions
- **Icons:** Magnifying glass, question marks, roadblock, fence, lightbulb
- **Color:** Indigo on final "Solutions" step
- **Layout:** Vertical 9:16
- **Use:** Consulting deliverable

### Example 2: "The Security Assessment Method"
- **Steps:** Assets → Threats → Vulnerabilities → Mitigations → Validation
- **Icons:** Treasure, storm, crack, shield, checkmark
- **Color:** Indigo on "Mitigations" (critical) and "Validation" (outcome)
- **Layout:** Vertical 9:16

### Example 3: "3-Step Content Creation Recipe"
- **Steps:** Research → Create → Distribute
- **Icons:** Books, pencil, megaphone
- **Color:** Indigo on final "Distribute" outcome
- **Layout:** Horizontal 16:9 (simpler process)
