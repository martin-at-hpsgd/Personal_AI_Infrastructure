---
contract:
  requires:
    - id: cse-24
      path: scratchpad/art/{slug}/cse.md
      fields: [NARRATIVE 1, NARRATIVE 2, NARRATIVE 3, NARRATIVE 4, NARRATIVE 5, NARRATIVE 6, NARRATIVE 7, NARRATIVE 8, NARRATIVE 9, NARRATIVE 10, NARRATIVE 11, NARRATIVE 12, NARRATIVE 13, NARRATIVE 14, NARRATIVE 15, NARRATIVE 16, NARRATIVE 17, NARRATIVE 18, NARRATIVE 19, NARRATIVE 20, NARRATIVE 21, NARRATIVE 22, NARRATIVE 23, NARRATIVE 24]
      produce: '/cse Create a 24-item story explanation of the full blog post {slug}; save the actual output to {path} under headings NARRATIVE 1 through NARRATIVE 24.'
    - id: composition-design
      path: scratchpad/art/{slug}/composition.md
      fields: [PROBLEM, SUBJECT, VISUAL METAPHOR, COMPOSITION, COLOR APPROACH]
      produce: 'Skill("Art", "Run Essay Steps 3-4 for {slug} using scratchpad/art/{slug}/cse.md; save the design to {path} under headings PROBLEM, SUBJECT, VISUAL METAPHOR, COMPOSITION, COLOR APPROACH. Stop before generation.")'
  bans:
    - '/\bcrowds?\b/i'
    - '/\brows?\s+of\s+identical\b/i'
    - '/\b(tables?|desks?)\b/i'
    - '/\bground[ -]+planes?\b/i'
    - '/\bhorizons?\b/i'
    - '/\bconveyors?\b/i'
    - '/\bassembly[ -]+lines?\b/i'
    - '/\b(gouache|water ?colou?rs?|ghibli|mary blair|storybook|children.?s[ -]book|pixar|anime|oil[ -]paint(ing|ed)?)\b/i'
  mandates: ['/\bcharcoal\b/i']  # the install palette words come from USER ArtConfig.json contractOverrides
---

# Essay

> **Palette.** The colour names and hex values in this intent are the skill's neutral defaults (indigo `#2B4C7E` primary accent, green `#3A7D44` secondary accent, umber `#A0522D` warm wash, `#F5F5F0` paper ground). When `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md` § Color palette exists, use its value for each role instead, in prompts, validation and checklists alike, and name its colour words where this file names the defaults.

**Contents:** Ideal State · Anti-criteria · Output format · Inputs · Safety gates · Tool contract · Gotchas · References

Produces a blog-header essay image: a charcoal architectural-sketch drawing of what the essay is actually about, signed with the DA name, picked by the evaluation round and optimized for the post, the image the principal would have art-directed himself on a good day.

## Ideal State

- `scratchpad/art/{slug}/cse.md` holds the actual output of the Create Story Explanation Level 24 command run on the full blog post, essay or input material, under non-empty headings `## NARRATIVE 1` through `## NARRATIVE 24`. It existed before the composition was designed, and the composition traces to its key metaphors and emotional beats.
- `scratchpad/art/{slug}/composition.md` existed before generation (Step 6) with non-empty headings `PROBLEM`, `SUBJECT`, `VISUAL METAPHOR`, `COMPOSITION` and `COLOR APPROACH`, and it is the best-image deliberation (Step 5A) written down. PROBLEM names the problem the essay addresses, its problem type, the emotional register, and the essay's central mechanism or tension in one sentence (what it argues, not the topic). VISUAL METAPHOR records 2-3 genuinely different scene concepts that would make a stranger FEEL that mechanism in one look, and which one was picked (options, not rules: cutaway, cross-section, facade/backstage, multi-floor, iceberg, scale contrast, before/after split, a single frozen action). SUBJECT says what to ACTUALLY DRAW and gives every element a narrative ROLE and spatial relationship; an element that is just "present" is cut or connected. The composition comes from the essay's actual argument, never from a default subject list.
- When the user gave direction about what to focus on, what the image should convey, or what angle to take, that guidance is the primary input for the composition and is reflected in the image; the CSE-24 supports the user's direction and does not override it.
- The image depicts what the content is actually ABOUT, using the architectural sketching STYLE (gestural lines, hatching, charcoal) as the technique: the key nouns, metaphors and imagery from the content appear visually (the piece's own metaphor when it uses one), and buildings or spaces are drawn only if the content is about those things.
- The essay's problem and its problem type (sorting, double standard, misdirection and so on) are visible at a glance: reading the image alone, a stranger could intuit what the essay is about and guess the title; the image is specific to this content and could not be about something else.
- The visual makes logical and physical sense with the concept: if X is winning, X is in the dominant or winning position; heavy or powerful things weigh DOWN (the winning or heavy side of a scale points down); figures, when present, show the problematic dynamic; and the emotional register is clear and matches the problem.
- When the essay contrasts two things, each side carries its own iconic imagery with DIFFERENT shapes, color is the wash on that imagery rather than a replacement for it, and the image would still read as X-failure vs Y-failure with all color stripped.
- The scene is one connected structure built from solid masses, nothing floating in isolation; it reads at thumbnail size and needs no readable text to work.
- Every figure, robot and object is drawn whole and coherent: no broken anatomy, no smeared or ghosted half-figures, and the mass sits balanced across the frame rather than piled to one side. A 2026-10-08 header was replaced for exactly these three faults (the work is in USER `History.md`).
- Every prompt tells the picked scene as a STORY, not a list of its contents, carries the thesis brief, the visual brief and the anti-pattern list in that order, and passed the Prompt Quality Check before generation.
- The delivered image is landscape and spans the full page width (`--aspect-ratio 16:9` default, trimmed aspect at least 1.4), its subjects LARGE and dominant with few elements, either as a cut-out with nothing drawn behind them or as a full scene whose ground matches the page ground exactly (§ Composition), charcoal and gray dominant with WARM UMBER (#A0522D) on human or warm elements and DEEP INDIGO (#2B4C7E) on tech, capital or cold elements both present as washes, and the DA-name signature added programmatically in the cursive `SignPainter-HouseScript` hand, small, in the bottom-right corner inside the artwork.
- The delivered file is trimmed tight to the subject bounding box with no padding, the subject is whole and never cut off by the frame edge, and FillFrame (`--report-only --max-margin 2`) on the trimmed file reports no edge over 2%.
- For a blog header, round 1 holds 8 `nano-banana-pro` candidates generated together, each a genuinely distinct compositional angle on the same thesis brief, and each is judged the moment its file exists rather than after the whole round; a second round holds up to 4. A single image only when one of the listed exceptions applies.
- The delivered header is the winner `EvalRound.ts` recorded in its `EvalRound.json` (assert gate, blind describer, meaning ladder, flipped tournament, cross-vendor critique), never one chosen by the prompt writer's eye. It sits at rung 4 or above (rung 3 is a pass, rung 4 ships), or it is the best eligible candidate when round 2 ends: a blog header runs at most two rounds. The report names its rung, panel median and remaining defects. (Measured 2026-10-15 in a HillClimb run: this roughly halved the median round time and raised the best critique median; the principal waived the keep rule after every faster run also scored higher.)
- The delivered header has been seen with the Read tool in this turn, its register is the register the essay needs, and it passes every item of the Validation Checklist, including the signature, no other text, transparency, technique, figure style, color, emotion, composition and quality (gallery-grade concept art in the style references `PREFERENCES.md` names; distinctive, not generic AI illustration).
- The winner's files are a transparent `.png` and an opaque page-ground `-thumb.png` from one `--thumbnail` run; a 1024-wide WebP, trimmed to the subject bounding box, that prints `srgba`; and a page-ground `[name]-thumb-optimized.png` listing thumbnail. The site's public images hold those optimized files, staged in git, and the post references the `.webp` inline and `-thumb-optimized.png` in `thumbnail:` frontmatter. Optimization needs no approval from the principal.

## Anti-criteria

- No text in the image other than the programmatic DA-name signature (and any per-request figure labels the principal explicitly asked for): no watermarks, labels, annotations, captions, logos, titles or subtitles, and no readable text of any kind, hallucinated partial words included.
- The signature is never prompted into the model, never a formal calligraphy face or another face `PREFERENCES.md` § Signature rejects, never bottom center or out in blank canvas beside the art, and never stamped a second time after a normal Generate.ts run.
- No group of figures defaults to one ethnicity, no figure breaks the figure treatment `PREFERENCES.md` § Character design sets, and no casting maps a figure's appearance onto a stereotyped role.
- No symmetric "same shape, different paint" contrast: no colored voids, mirror-image silhouettes, two-colored balance-scale pans, or generic two doors, two paths or two voids standing in for the two concepts.
- No borders or frames, background gradients, a filled ground in any color but the exact page ground, or decorative elements that are not part of the subject; no subjects too small in empty space; no busy or cluttered compositions; no interior surface prompted as bright white or left with its color unstated.
- The frontmatter bans apply even to negative instructions: forbidden subjects are omitted entirely from the final prompt.
- `--output` never points at a blog or site `public/images/` directory, the public/ tree of any project, or any git-tracked path, and no image is moved or staged before the visual inspection gate passes; only the winner moves.
- A failed validation is never shipped; it means regenerate. Without a Read of the image file in this turn there is no checklist, no post written, and no "looks good".
- No removed model or dual-provider `compare` mode is reintroduced, no vendor outside `PREFERENCES.md` § Vendors is used, and no second vendor is reached for when a round fails the gate; the fix for a failed round is a sharper brief.
- No padding to square and no breathing-room border baked into the image file.
- Never stops mid-loop to ask whether to run another round.
- Never makes a large field of dense fine technical linework load-bearing in the brief.

## Output format

**Every image contains these elements:**
- Charcoal sketch technique
- Content-relevant subject matter
- **WARM UMBER (#A0522D)** — human warmth, humanity
- **DEEP INDIGO (#2B4C7E)** — technology, AI, capital, cold power
- --thumbnail flag for blog headers

**Full page width, signature inside the art (principal directive, 2026-09-27).** Essay images render at the full width of the post column, so they are generated landscape (`--aspect-ratio 16:9` default) with the subject spanning the whole frame width, never a tall or square figure floating in the middle. The DA-name signature sits in the bottom-right of the ARTWORK, visible, never out in empty canvas beside it. Generate.ts enforces both: it trims to the art before signing (so the signature cannot create a blank strip on the right) and fails any Essay result whose trimmed aspect is below 1.4, which means regenerate wider.

**The DA-name signature** is the only text: `SignPainter-HouseScript`, a cursive human-signature hand, small (~3% of width), semi-transparent charcoal, tucked into the composition (2026-07-09 directive: more cursive, smaller, part of the image), stamped programmatically in Step 7 because models hallucinate garbled text. All other text belongs in the post body, not on the canvas. The ratio of Umber:Indigo tells the emotional story.

### Composition: subjects fill the frame

A blog header is one of two grounds, chosen when composition.md is written and named in Brief.json's register so the critique judges the ground the image was made for (principal approved full scenes 2026-10-15):

- **Cut-out:** nothing drawn behind the subject; the inline file is transparent.
- **Full scene:** architecture, environment and strong charcoal darks behind the subjects, on a ground that matches the page ground exactly (`thumbnailGround` in ArtConfig.json); pixels at exactly that color are made transparent in the inline WebP so the page shows through, and the listing thumbnail is flattened on it. the blogging skill's header-image reference (§ Background), where that skill is installed, allows both.

A register that asks for Piranesi or Ferriss darks with a cut-out ground contradicts itself: every 2026-10-15 cut-out run took "blank void, no architecture or darks" as its top defect every round.

**Include in every prompt:**
- "USE FULL FRAME — subjects fill horizontal and vertical space"
- "Subjects LARGE and DOMINANT in the composition"
- "Few elements, each intentional, in one connected structure — nothing floats in isolation"
- Cut-out only: "NO filled-in backgrounds — nothing drawn behind the subject"
- "the subject fills most of the frame with a small comfortable margin around all four edges — roughly 8% breathing room on top, bottom, left, and right"

The margin line protects the subject from the frame edge. Models routinely produce one of two failure modes: zero margin, where the subject butts against or is cut off by the edge (the 2026-04-27 "flat against the side" failure), or wallpaper margin, where the subject is too small (the original failure that caused FillFrame to exist). The Step 7.0 trim then removes whatever margin is left, because padding belongs in the page CSS, not in the file. Few elements means few, not small elements lost in empty space. Leave "minimalist" and "floats in empty space" out of the prompt: the model obeys them literally (Gotchas).

### Composition design (composition.md)

Architecture is the TECHNIQUE (how to draw), not the required subject. User guidance shapes WHAT to draw; CSE-24 explains the emotional core.

```
PROBLEM (from CSE-24 — MOST CRITICAL):
[What's WRONG with the current state that this essay addresses? The unfairness, mistake, or confusion it critiques]
[Problem type, emotional register, and the central mechanism in one sentence]

SUBJECT (WHAT TO DRAW — showing the problem):
[The actual visual subject that makes the PROBLEM visible, from the content's metaphors/imagery]
[Every element with its narrative role and where it sits relative to the others]

VISUAL METAPHOR:
[2-3 scene concepts compared; the one picked; what would make someone say "Oh, I see what's wrong"?]

FIGURE TREATMENT (if applicable):
[Who is judging unfairly? Who is being judged? Who is making the mistake?]

COMPOSITION:
[Arrangement that makes the PROBLEM OBVIOUS; what fills each region]

COLOR APPROACH:
[Warm:Cool ratio, which colors where]
```

### Prompt template

Three blocks, in this order. If the scene includes any human figures, the visual brief carries the FIGURE TREATMENT language below.

```
THESIS BRIEF: This image illustrates an essay about [topic in one phrase].
[2–4 sentences: the argument, the tension, what the reader should feel,
and what a stranger should intuit from the image alone.]
THE PROBLEM THIS ESSAY ADDRESSES: [from composition.md PROBLEM]. The art
makes this problem VISIBLE AT A GLANCE.

VISUAL BRIEF:
Sophisticated charcoal sketch using architectural rendering TECHNIQUE.
Architecture is the TECHNIQUE, not the required subject.

SCENE: [the picked concept told as a story: the dominant subject with
placement, scale and what it is doing; each supporting element with its
role and where it joins the main structure]. One connected structure,
nothing floats in isolation.

EMOTIONAL REGISTER: [register]

TECHNIQUE — GESTURAL ARCHITECTURAL SKETCH STYLE:
- GESTURAL — quick, confident, energetic marks
- OVERLAPPING LINES — multiple strokes suggesting form
- HATCHING — cross-hatching creates depth and tone
- Loose charcoal/graphite pencil strokes throughout
- Variable line weight, some lines trailing off
- NOT clean vectors, NOT smooth
- Like the figure-study references in `PREFERENCES.md` § Character design (default: architectural concept-sketch figure studies)

LINEWORK (applies to ALL subjects):
- [Specific line quality for the register]
- Visible hatching and gestural marks
- UNIFIED sketch quality across all elements

HUMAN FIGURES (if present) — GESTURAL ABSTRACTED:
- MULTIPLE OVERLAPPING LINES suggesting the form
- Quick, confident, ENERGETIC gestural marks
- HATCHING and cross-hatching to create tone/depth
- Many overlapping strokes creating the form (the density `PREFERENCES.md` § Character design sets, when set)
- Form EMERGES from accumulated linework
- Abstracted but with PRESENCE and WEIGHT
- FACES via simple charcoal marks (dark strokes for eyes, line for mouth)
- Warm Umber (#A0522D) WASH accent
- FIGURE TREATMENT: [the sentence from `PREFERENCES.md` § Character design when set;
  otherwise: "the figures are a varied cast, each one's skin tone, age and build named, spanning a natural range; no figure is a stereotype"]

HANDS (if present) — GESTURAL:
- Same overlapping line technique
- Form suggested through accumulated marks
- Umber wash accent for human warmth

OBJECTS (if present) — GESTURAL SUGGESTED FORMS:
- Objects implied through hatching and gestural strokes
- Same energetic sketch quality
- Recognizable forms through accumulated lines
- NOT flat symbols — sketched with depth

COMPOSITION: [the five composition lines above]

COLOR — CHARCOAL DOMINANT, COLORS AS ACCENTS ONLY:
- CHARCOAL AND GRAY DOMINANT — 70-80% of image
- Burnt umber (#A0522D) and deep indigo (#2B4C7E) as washes
- Colors INTEGRATED INTO forms — not splattered or applied on top
- Colors are the ESSENCE of elements (indigo = cold capital, umber = human warmth)
- Every bit of color belongs to a form — no random color floating in space
- Large flat surfaces in the page ground's paper tone, never white

ANTI-PATTERNS: No text, no labels, no signatures, no watermarks, no
borders. NOT digital, NOT vector. [The literal clichés of the essay's
domain, named only when they are not contract-banned words.] Background:
seamless paper in the page ground colour (ArtConfig.json thumbnailGround,
default #F5F5F0), so it blends into the destination page.
```

Do not include any signature text in the prompt: models hallucinate garbled text instead of clean signatures, so the DA signature is added programmatically in the optimize step.

FIGURE TREATMENT: `PREFERENCES.md` § Character design sets how people are drawn and the exact sentence that goes into every prompt with people; use it verbatim when set. The skill default is a varied cast: the prompt names each figure's skin tone, age and build so the group spans a natural range ("the figures are a varied cast, each one's skin tone, age and build named, spanning a natural range; no figure is a stereotype"). Either way, no casting maps a figure's appearance onto a stereotyped role, and any casting rule the preferences add applies too. Models default to one ethnicity and to stereotyped features, so the language is mandatory. After generating, review how the people are represented: check that no figure's appearance (skin tone, age, build, dress) lines up with a stereotyped or negative role, such as who plays the aggressor, the victim, the authority or the outsider, and regenerate with changed casting when one does.

## Inputs

- The full blog post, essay or input material, and its slug.
- **User guidance**: any compositional or thematic direction, such as "Focus on the tension between X and Y", "The image should show Z losing" or "Emphasize the human impact".
- The emotional register comes from the CSE-24; `References/EssayComposition.md` lists common registers, and it can be anything the CSE run surfaces.

Step names used by the frontmatter `produce` commands, SKILL.md and `EvalRound.help.md`: Step 2 is the CSE-24 run; Steps 3-4 are the emotional register and the composition design saved to `composition.md`; Step 5 is the prompt; Step 5A is the best-image deliberation recorded in `composition.md`; Step 6 is generation; Step 7 is optimization (7.0 trim, 7.0.5 alpha cut, 7.1 signature); Step 8 is validation (the EvalRound pipeline and the Validation Checklist).

## Safety gates

The frontmatter bans apply even to negative instructions: omit forbidden subjects entirely from the final prompt. They take precedence over older illustrative examples below. Artifact checks verify structure and slug binding; they do not prove the quality or provenance of the reasoning.
The frontmatter mandates enforce this intent's technique and palette in the final prompt.

**`nano-banana-pro` is the only model this intent uses.** Removed models and the dual-provider `compare` mode stay removed (SKILL.md § Vendors; the allowed vendors are the principal's call in `PREFERENCES.md` § Vendors), and do not reach for a second vendor when a round fails the gate. The fix for a failed round is a sharper brief, not another provider.

### Working directory: `$ART_DIR` (`scratchpad/art/{slug}/`)

Every image this intent makes is rendered into `$ART_DIR`, the same `scratchpad/art/{slug}/` directory that already holds `cse.md` and `composition.md` (set `ART_DIR=scratchpad/art/{slug}` before Step 6). This follows SKILL.md § Output staging: Downloads and the site's `public/images/` are never the working directory. Rendering here first means no image is staged into git before it has been inspected. This applies to:
- Single-shot generations (`--output "$ART_DIR"/{name}.png`)
- Multi-candidate rounds (`--output "$ART_DIR"/{slug}-candidate-{n}-{angle}.png`)
- Thumbnail generation (`--thumbnail` flag — both `.png` and `-thumb.png` land in `$ART_DIR`)
- Background-removal intermediates
- Optimization intermediates (`cwebp` / `magick` outputs while iterating)

The EvalRound winner moves from `$ART_DIR` into the site's public images without handing back (principal directive, 2026-09-22). Anything shown to the principal for review reaches Downloads only through `bun ~/.claude/skills/ArtDirection/Tools/Deliver.ts --artifact <file> --to ~/Downloads`.

### Opposite-Concept Asymmetry Gate

Applies when the essay contrasts two things (capitalism vs communism, agency vs control, human vs AI, centralized vs distributed). Models default to visually symmetric compositions (left blob indigo, right blob umber), and symmetry collapses meaning: exactly this failure was rejected in review on 2026-05-20, when the image did not visually separate the two contrasted styles of government.

Name the two concepts the essay actually critiques, then 2-4 iconic visual signatures per side that an educated reader recognizes instantly as that concept's failure mode, drawn from real-world iconography. The prompt names each side's iconography (not "left side indigo void" but "left side: monolithic statue above a lockstep column of faceless figures, deep indigo wash"). If the iconography table for the essay cannot be filled in, re-read the content before prompting. Worked tables are in `References/EssayComposition.md`.

### Prompt Quality Check

Before generating, verify:
- [ ] The composition came from the Step 5A deliberation in `composition.md`, not from a default subject list
- [ ] PROBLEM IS VISIBLE — someone could understand what's wrong just from the image
- [ ] Concrete subjects present — nouns from title/content appear visually (not abstracted)
- [ ] Emotional register explicitly stated; figure treatment shows the problematic dynamic (if applicable)
- [ ] Light source and meaning specified; warm:cool ratio matches emotion
- [ ] "Charcoal sketch", "gestural", "hatching" explicitly stated, with an artist reference appropriate to the emotion
- [ ] SPECIFIC to this content (couldn't be about something else); title test — could someone guess the title from the image alone?
- [ ] No contract-banned word anywhere in the prompt, negatives included

### Validation (Step 8)

A failed validation means regenerate, not ship. `open` launches Preview on the principal's machine and shows the agent nothing; inspection is `Read("/path/to/generated-image.png")` (or `.jpg` when nano-banana-pro returns JPEG), which renders the pixels inline. The checklist below is applied to what that Read shows. `open /path/to/generated-image.png` is optional, for the principal.

### Validation Checklist

**Required elements (a missing one means regenerate):**
- [ ] **DA-name signature present** — cursive signature hand (SignPainter-HouseScript), small, in the bottom-right corner of the art, inside it and visible; not bottom center, not formal calligraphy (rejected 2026-06-20; PREFERENCES.md § Signature), never off to the side in blank space that leaves an open strip on the right (2026-09-27). Required since 2026-06-20. Missing, calligraphic, misplaced or garbled → re-stamp with the Step 7.1 command; it is a programmatic stamp, so no regeneration is needed.
- [ ] **No other text** — beyond the DA-name signature (and any per-request figure labels the principal explicitly asked for): zero watermarks, zero stray labels, zero hallucinated letters, and no prompt instruction words rendered as text. Model-baked text → REGENERATE with clearer wording.
- [ ] **Labels readable** — if there are requested labels (like the letters of a framework's acronym), they are clearly visible and correct: the letters exactly as requested, never the words they stand for spelled out instead.
- [ ] **Inline is transparent (srgba)** — `identify -format "%[channels]" [name].webp` prints `srgba`. `srgb` = opaque = the white-box bug → re-cut with RemoveBg.
- [ ] **Full page width** — landscape, subject edge to edge. A tall or square figure with open space around it is a FAIL.
- [ ] **Problem type visible**, subject matches the CONTENT (not defaulted to buildings/spaces unless the content is about architecture), key nouns/metaphors visible, title test passes.
- [ ] **CSE-24 insights captured** and **user guidance incorporated** when given.
- [ ] **Physics and logic hold** — trace any scale beam from the fulcrum: the heavy/winning side's end points DOWN, the light/losing side's end points UP; things fall the right way; proportions are reasonable; "X is winning" means X looks dominant, and "X is losing" means X looks diminished, fading or rising on the scale.
- [ ] **Philosophical alignment** — the image argues the same point as the content, and the user would look at it and say "yes, that captures it".

**TECHNIQUE:** charcoal sketch quality with visible strokes, hatching and gestural marks; NOT clean vectors or cartoony; gestural overlapping lines suggesting form; gallery-worthy sophistication.

**FIGURE STYLE (if figures present):**
- [ ] Gestural abstraction, energetic scratchy linework, hatching for depth, **many overlapping strokes** per figure (the density `PREFERENCES.md` § Character design sets, when set), figures with presence and weight, faces with emotion via charcoal marks (dark strokes for eyes, line for mouth, head tilt)
- [ ] **Figures follow the figure treatment** — `PREFERENCES.md` § Character design when set, else a varied cast. A group that defaulted to one ethnicity, a figure that breaks the set treatment, or a casting that maps appearance onto a stereotyped role → REGENERATE with the mandatory prompt language.
- [ ] Human = organic flowing gestural marks + umber wash; Robot = angular rigid gestural marks + indigo wash
- [ ] Looks like the figure-study references in `PREFERENCES.md` § Character design (default: architectural concept sketches)

**COLOR (both umber and indigo present):** charcoal/gray dominant at 70-85% of the image; WARM UMBER (#A0522D) on human/warm elements; DEEP INDIGO (#2B4C7E) on tech/capital/cold elements; colors as washes/accents, not solid fills; Umber:Indigo ratio matches the emotional story.

**EMOTION:** the register is clear and matches the composition.md selection; architecture, figure treatment and light placement serve the mood.

**COMPOSITION:** subjects LARGE and dominant; a cut-out has no background fill, and a full scene's ground matches the page ground exactly; the trimmed file passes the FillFrame report (no edge over 2%).

**QUALITY:** gallery-grade; could be production concept art for a feature film, in the spirit of the influences `PREFERENCES.md` § Core Aesthetic names; distinctive — NOT generic AI illustration; sophisticated — rewards closer looking.

## Tool contract

### Machine-verified preflight

Before Step 6, persist the actual Step-2 output in `scratchpad/art/{slug}/cse.md` with 24 non-empty Markdown headings (`## NARRATIVE 1` through `## NARRATIVE 24`). Persist Step 4 in `scratchpad/art/{slug}/composition.md` with non-empty headings `PROBLEM`, `SUBJECT`, `VISUAL METAPHOR`, `COMPOSITION`, and `COLOR APPROACH`. Paths are relative to the generation working directory. Pass `--slug <blog-post-slug>` to Generate.ts. `--dry-run` validates the gates without loading credentials or generating images. The producer commands are agent invocations using the actual post, not shell commands that manufacture evidence.

### Step 2: Create Story Explanation Level 24

```
Invoke the StoryExplanation Skill with: "Create a 24-item story explanation for this content" (that skill and `/cse` are maintainer-side; not in the public release payload; without them, write the 24 numbered narrative items yourself under the same headings)
```

Or the slash command: `/cse [paste the content or URL]`. Its output gives the narrative arc (setup, tension, transformation, resolution), the key metaphors and imagery, the emotional journey, and what the piece is REALLY about.

### Default for blog headers: multi-candidate, auto-select

Single-shot generation is fine for low-stakes diagrams, schematics, or technical illustrations where the visual answer is mechanical. Editorial essay headers are creative judgment calls, and the same brief produces meaningfully different compositions roll to roll, so every blog header generates a round of candidates from `nano-banana-pro` in parallel, then auto-selects through the Step 8 pipeline: assert gate → blind describer → meaning ladder → flipped tournament.

- **Round 1 is 8 candidates**, each with a genuinely distinct compositional angle on the same thesis brief — different scene concepts, not the same scene reworded. The variation must come from your angles, since there is no longer a second model supplying it. A round 2, when round 1 misses the bar, is up to 4.
- **Generate all of a round's candidates in parallel inside one foreground command** (a script that starts every generation at once and starts each one's judging as its file lands). A background job should run under `Deadline.ts` (no hook enforces it since AgentBudget.hook was deleted 2026-10-24), and separate foreground calls run one after another: a 2026-10-15 run that tried both generated serially and took 20.6 minutes.
- **All outputs go to `$ART_DIR`** with descriptive suffixes (`{slug}-candidate-{n}-{angle}.png`).
- **The winner moves through optimize → mv → git add. Losers stay in `$ART_DIR` as disposable.**

Generate a single image only when:
- The principal explicitly asks for one.
- The previous round selected a clear leader and the principal wants a tight variation on it.
- The image type is not editorial (diagram, schematic, dashboard, technical illustration).

### Step 6: Generation

```bash
# 1. GENERATE → ALWAYS to "$ART_DIR"/
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --intent=Essay \
  --slug [blog-post-slug] \
  --model nano-banana-pro \
  --prompt "[YOUR PROMPT]" \
  --size 2K \
  --aspect-ratio 16:9 \
  --thumbnail \
  [--reference-image PATH if style reference provided] \
  [--creative-variations N if variations requested] \
  --output "$ART_DIR"/[descriptive-name].png

# 2. INSPECT → MANDATORY visual gate via the Read tool (Step 8)
#    Read("$ART_DIR/[descriptive-name].png")
#    nano-banana-pro often returns JPEG even for --output .png:
#    Read("$ART_DIR/[descriptive-name].jpg")

# 3. OPTIMIZE → still in "$ART_DIR"/. Run the full recipe in the optimize step below (WebP plus the listing thumbnail).
#    The thumbnail is written to [name]-thumb-optimized.png; never overwrite the full-size [name]-thumb.png that --thumbnail produced.
#    The thumbnail is a listing thumbnail, never the social card (og:image needs >=1200x600; the site builds it from the full-size image).

# 4. MOVE → only after visual gate passes, only the chosen winner
mv "$ART_DIR"/[name].png "$ART_DIR"/[name].webp "$ART_DIR"/[name]-thumb-optimized.png "$ART_DIR"/[name]-full.png ~/your-site/public/images/

# 5. STAGE → git add the moved files
cd ~/your-site && git add public/images/[name].* public/images/[name]-thumb-optimized.png public/images/[name]-full.png
```

Flags by request are in `References/Models.md` § Essay flags by request; what `--thumbnail` writes, and `RemoveBg.ts` for a non-blog image, are in `References/BlogHeaders.md`.

### Step 7: Optimize

Runs after generation and background removal, before validation, on the winner while it is still in staging, without asking. Validation (Step 8) checks the optimized files; the original high-res files stay as archives. The order is fixed: optimize in staging first, then move the winner's `.png`, `.webp`, `-thumb-optimized.png` and the full-resolution `-full.png` (kept by Step 7.0 for the social card) into the site's public images, then `git add` them (Step 6 commands 4 and 5); a file is never moved before it is optimized.

**Step 7.0, tight-crop pass.** Every image is cropped tight to the subject bounding box, with no padding or breathing-room border baked into the file. The intent once added 8% padding, which produced visible whitespace gaps above and below the rendered post header (rejected in review 2026-05-02); padding belongs in the page CSS layout.

```bash
# Stage A — magick -trim removes uniform-color/transparent borders to the bbox of opaque pixels.
magick "$ART_DIR"/[name].png -trim +repage "$ART_DIR"/[name]-trimmed.png

# Stage B — resize the trimmed result to 1024 wide (preserve native aspect — DO NOT pad to square).
magick "$ART_DIR"/[name]-trimmed.png -resize 1024x "$ART_DIR"/[name]-resized.png

# Stage C — verify margins are now ≤ 2% on every edge (sanity check; any model whitespace inside
# the bbox stays, but cropping has eliminated background bleed).
bun ~/.claude/skills/Art/Tools/FillFrame.ts \
  "$ART_DIR"/[name]-resized.png \
  "$ART_DIR"/[name]-resized.png \
  --report-only \
  --max-margin 2 \
  --bg-color auto

# If Stage C reports margins > 2%, the model produced an image with internal whitespace inside
# the figure area — REGENERATE with a tighter composition prompt instead of padding it more.

# The 1024-wide inline PNG replaces [name].png, so the full-resolution trimmed header would be lost. Keep it as
# [name]-full.png: it is the source the site builds its social card from (og:image needs >=1200x600) and it ships
# alongside the optimized files (Step 6 command 4). Never resize or overwrite it.
mv "$ART_DIR"/[name]-trimmed.png "$ART_DIR"/[name]-full.png
mv "$ART_DIR"/[name]-resized.png "$ART_DIR"/[name].png
```

**Step 7.0.5 onward.** True alpha before inline (white-box bug, 2026-06-20). The inline blog image MUST have a real alpha channel so the page ground (`ArtConfig.json` thumbnailGround, default `#F5F5F0`) shows through. nano-banana-pro returns an OPAQUE JPEG. Flattening that opaque JPEG on `#F5F5F0` is a NO-OP (there's no alpha to fill), so the model's baked near-white ground survives and renders as a white rectangle on the page ground — exactly the white-background bug. The fix: cut to true alpha FIRST with rembg, THEN derive the WebP. Substantial umber/indigo/solid-figure charcoal survives rembg fine — the "rembg eats thin linework" gotcha applies to thin-line *diagrams*, not solid-figure essay headers.

```bash
# 7.0.5 — TRUE ALPHA (mandatory). A normal Step 6 run (--thumbnail implies --remove-bg) has
#   already cut "$ART_DIR"/[name].png to real alpha and DELETED the opaque [name].jpg
#   (Generate.ts removeBackground), so there is no JPEG to cut. Cut only when [name].png
#   is still opaque: a hand-built image, or a run without --thumbnail/--remove-bg.
#   RemoveBg.ts takes ONE path here: one path cuts a .png in place, or writes a .jpg to
#   [name].png and deletes the jpg (two paths would keep the jpg beside the cut).
if [ "$(identify -format '%[opaque]' "$ART_DIR/[name].png" 2>/dev/null)" != "False" ]; then
  SRC="$ART_DIR/[name].jpg"; [ -f "$SRC" ] || SRC="$ART_DIR/[name].png"
  bun ~/.claude/LIFEOS/TOOLS/RemoveBg.ts "$SRC"   # → [name].png with real alpha
fi
magick "$ART_DIR/[name].png" -trim +repage -resize 1024x "$ART_DIR/[name].png"

# 7.1 — DA-NAME SIGNATURE (human handwriting, NOT calligraphy)
#   🟢 AUTO-STAMPED BY Generate.ts (2026-06-26): any `--intent=Essay` or `--thumbnail`
#   run now stamps the DA name itself (bottom-right, SignPainter-HouseScript cursive, ~3% width,
#   slight rotation — small, integrated; 2026-07-09 directive), before the thumbnail
#   is derived, so it lands on BOTH the transparent PNG and the opaque thumb. You do NOT
#   run this command after a normal Generate.ts run — doing so DOUBLE-stamps.
#   This manual command is ONLY for: (a) a hand-built image that never went through
#   Generate.ts, or (b) re-stamping after rembg ate the signature. Opt out at generation
#   with `--no-signature`. Formal calligraphy faces are REJECTED (2026-06-20; the rejected list is in PREFERENCES.md § Signature).
#   --sign runs Generate.ts's own stamp: it trims first (so the signature lands inside the art,
#   2026-09-27), sizes the mark to the image width, and uses ArtConfig.json signature
#   (fontFile / fontName / fill) and the DA name, so a re-stamp matches a generated one.
#   Set RESTAMP=1 only for case (a) or (b); left unset, this step does nothing.
if [ "${RESTAMP:-0}" = "1" ]; then
  bun ~/.claude/skills/Art/Tools/Generate.ts --sign "$ART_DIR/[name].png"
fi

# 1. Convert the signed transparent PNG to WebP for inline blog display
#    (quality 86 keeps artifacts invisible in charcoal; alpha quality 100 keeps the edge clean)
cwebp -q 86 -alpha_q 100 "$ART_DIR/[name].png" -o "$ART_DIR/[name].webp"

# 1a. VERIFY the inline WebP kept its alpha — MUST print srgba (NOT srgb).
#     srgb here = opaque = the white-box bug. Re-cut with RemoveBg if so.
identify -format "%[channels]\n" "$ART_DIR/[name].webp"   # expect: srgba

# 2. Build the listing thumbnail (flattened onto the page ground, max 512 wide). GROUND is ArtConfig.json thumbnailGround, default #F5F5F0:
#    This is a listing thumbnail, never the social card: og:image must be at least 1200x600 or X shows no image, so the site builds its card from the full-size image, which ships alongside.
#    Social platforms don't honor transparency; the signature is already baked in.
#    --print-setting reads the same ArtConfig.json as generation (CLAUDE_CONFIG_DIR and LIFEOS_ART_USER_DIR honored);
#    malformed JSON or a non-hex ground fails naming the file, and a missing key warns and prints the default.
GROUND=$(bun ~/.claude/skills/Art/Tools/Generate.ts --print-setting thumbnailGround) || exit 1
magick "$ART_DIR/[name].png" -background "$GROUND" -flatten -resize 512x -quality 80 \
  "$ART_DIR/[name]-thumb-optimized.png"

# 3. Check final file sizes
ls -lh "$ART_DIR"/[name].webp "$ART_DIR"/[name]-thumb-optimized.png
```

If the WebP is over 500KB, re-run `cwebp -q 65 -alpha_q 100` on the same input. If the thumbnail is over 600KB, re-run the thumbnail recipe with a lower `-quality` (for example 70); it writes `[name]-thumb-optimized.png` and leaves the full-size `[name]-thumb.png` alone.

The Step 7.1 DA-name signature (stamped by `Generate.ts`, or `Generate.ts --sign` for a manual re-stamp) is the only sanctioned `-annotate` use (removed 2026-05-02, re-required 2026-06-20). The rare per-request figure labels are a separate, explicitly-asked-for case, color-coded to the figures.

### Blog post references

```markdown
---
thumbnail: https://example.com/images/[name]-thumb-optimized.png
---

[![Alt text](/images/[name].webp)](/images/[name].webp) <!-- width="1024" height="576" -->
```

Use `.webp` inline and `-thumb-optimized.png` in `thumbnail:` frontmatter. The transparent `.png` as the thumbnail is wrong: it shows a white background in the listing and RSS.

### Step 8: The evaluation round

The image must carry the CONTENT'S argument, not just look pretty; the operator who wrote the prompt never grades its own output. One command runs the whole round, with every independent call in parallel; one round's eval takes 2 minutes or less (2026-09-24). Do not run the stages one by one.

```bash
bun ~/.claude/skills/Art/Tools/EvalRound.ts \
  --candidates "<a-thumb.png>,<b-thumb.png>,<c-thumb.png>,<d-thumb.png>" \
  --reference "<the 2–4 sentence argument summary from Step 2>" \
  --brief <Brief.json> \
  --question "Which image would make a stranger feel this essay's argument: <one sentence>?" \
  --out <scratchpad>/art/<slug>/round-<n> \
  --incumbent <last round's winner, from round 2 on>
```

The `Brief.json` carries `"calibration": "art-essay"`, so the critique panel reads the principal's calibrated taste profile (built by the Calibrate skill from their own like/dislike labels) on every candidate.

The round runs the assert gate first, then the blind describer, the meaning ladder (rungs **1 unrelated · 2 topic only · 3 argument · 4 specific claim**), the cross-vendor critique and the flipped tournament over the survivors, and picks the winner in code; exit 0 means the winner cleared the bar. What each stage proves and the winner rule: `References/EssayRounds.md` and `Tools/EvalRound.help.md`.

The reference for stage 3 is the argument summary from Step 2, the same 2–4 sentences the prompt was built from, and never the title: a title is one phrase, and a judge given one phrase matches on vocabulary instead of meaning. The suite form of stages 1–3 is `art-meaning-recovery` (USER Assay suites, `Capability/`), which is how the ladder gets calibrated on the principal's labels over time.

Read the winner yourself before shipping (the Read tool, not `open`): the pipeline says which candidate recovered the argument best; your eyes still confirm the register is the register the essay needs (doomy when the essay is empowering is a FAIL no rung catches) and that nothing in the Validation Checklist is broken.

**The loop runs to a picked winner without handing back (principal directive, 2026-09-22).** Each round: generate, then run `EvalRound.ts` over this round's candidates with `--incumbent` set to the best image from earlier rounds. The incumbent is judged and seeded alongside the challengers, so it has to be beaten, not just tied. Rewrite the next round's prompts against the named defects (the most common failure is the prompt not naming the load-bearing concept; the second is the model latching onto a pretty, argument-irrelevant element). When a round fails to reach the bar, change the brief itself (metaphor, composition, what the figures do), not just the wording. For a blog header the loop ends when a candidate clears the bar or when round 2 ends, whichever comes first; other essay images end when a candidate clears the bar or two consecutive rounds produce no new tournament winner. Either way the current winner is wired in and the parent intent continues, through publish when the principal has already authorized publishing. The report names the winner's rung, panel median, and remaining defects. When the last round records no winner (`winner` is null in `EvalRound.json` because no candidate is eligible), that is a failed validation and is never shipped: nothing is wired in, nothing publishes on it, and the report names the carried-forward candidate, its rung and its defects. Never stop mid-loop to ask whether to run another round; asking is the failure this rule exists for.

Square sales or value-proposition sketches for a pitch are a separate intent, `Intents/SalesVisual.md`, with its own contract.

## Gotchas

- **Background removal may remove the signature.** If it is missing after rembg, re-stamp it with the Step 7.1 command; the signature is never prompted into the model.
- **Subject-list prompts get rejected; reasoned compositions get accepted (principal, 2026-07-09).** In one header session, prompts that listed subjects produced flat tableaus that were rejected; a composition reasoned from the essay's actual argument, its central metaphor drawn as a scene, was accepted at once. Same models, same technique block — the difference was the deliberation, which is why `composition.md` records it.
- **Interior-white ban (2026-07-09, "giant white space" incident).** Never prompt interior surfaces (panels, windows, paper stacks) as bright white, and never leave surface color unstated (models default to white). State a paper tone matched to the page ground for any large flat surface so it blends with the page. A baked-white surface survives background removal as a giant white rectangle on a tinted page. Same class as the 2026-06-20 white-box bug, but inside the subject where rembg can't help. Tables and desks are contract-banned subjects, so they are omitted from the prompt outright rather than recoloured.
- **`nano-banana-pro` (Gemini 3 Pro Image) is visually anchored.** It executes composition and style with high fidelity but produces stronger results when the composition is grounded in WHY the scene exists, not just WHAT objects to draw. Lead with composition and include the thesis as context so the model treats the elements as load-bearing instead of decorative.
- **It will not render a large field of dense technical linework, and no amount of prompting fixes it.** Asking for a drafting sheet / plan / grid "packed corner to corner with hundreds of overlapping projection lines" reliably produces the subjects (figures, hands, objects) beautifully rendered and the rest of the canvas BLANK. Verified across repeated rolls on 2026-07-30 — including explicit canvas-fraction instructions ("the drawn linework must cover at least 60 percent of the canvas"), naming the field as THE SUBJECT, and stating which single region is allowed to be bare. All ignored. The fix is the BRIEF, not the wording: build the composition from SOLID MASSES the model renders well — hatched terrain, slabs, faceted forms, gestural figures with umber wash, ledges and shears — and never make a fine-line field load-bearing. A header that had failed every roll landed once its fine-line field was rebuilt as one solid hatched mass.
- **It obeys "minimalist" and "floats in empty space" literally.** When the composition needs weight, say what fills each region instead of relying on those words.
- **Scale contrast is a strength.** Tiny umber figures against a colossal indigo mass reads instantly at thumbnail size and survives the alpha cut cleanly.
- **Continuity and density survive background removal.** "One connected structure, nothing floats in isolation" reads better and survives background removal, because isolated fragments are what rembg destroys.
- Kept inline: the `contract:` frontmatter, the Ideal State and Anti-criteria, the prompt and composition.md templates, the gates every run applies (working directory, asymmetry gate, Prompt Quality Check, Validation Checklist), and the generate, optimize, signature and EvalRound recipes; every Essay run uses all of them, so only the catalogs, flag table, stage detail and fix table moved to References.

## References

| File | Read when |
|------|-----------|
| `References/EssayComposition.md` | designing `composition.md` (Steps 3-5A): naming the problem type, picking the emotional register and warm:cool ratio, or filling the Opposite-Concept iconography table from the worked examples |
| `References/EssayRounds.md` | reading an `EvalRound.ts` table (what each stage proves, how the winner is picked), or rewriting the next round's prompt after a candidate fails a checklist row |
| `References/Models.md` § Essay flags by request | the request names a size, aspect ratio, transparency-only, a style reference or variations |
| `References/BlogHeaders.md` | what `--thumbnail` writes, `RemoveBg.ts` for a non-blog image, and blog-header transparency and wiring |
