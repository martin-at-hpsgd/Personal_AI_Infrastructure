# BuildBible

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Output format

Builds the Story Bible: the comprehensive layered plan that maps the entire story across all seven layers from start to finish. It is the central artifact of WriteStory and the criteria every chapter written is verified against.

## Ideal State

- The saved interview for this book (`interview.md`) was read first, and the bible expands its confirmed spine, derivation lens, per-layer state and Foolscap spine instead of starting over.
- The Story Bible is the project's ISA at `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/WriteStory/projects/<book-slug>/ISA.md`, created through the ISA system per the Tool contract: the living plan that grows across sessions and tracks what is done versus what is left, updated each session with beats drafted, criteria met and what is next.
- The bible fixes the story parameters (scope, genre, aesthetic profile, POV, tense) confirmed from the interview or the writer, and the Pressfield foundation: concept, high-concept test, theme-question, hook, villain design, and the gift.
- Every major character has a full profile built on the Storr Character Construction Protocol (sacred flaw, origin wound, external want, internal need as the inverse of the flaw, philosophical purpose, crisis point, arc direction, status dynamics, mystery hooks, connection to theme), with ISC criteria for each major character's arc.
- The plot is mapped through all three acts and every mandatory event in the Master Event Table, each event with its cause, its effect, the character decisions that drive it, and the Pressfield clothesline test; major plot beats have ISC criteria.
- The mystery architecture covers the primary mystery, the mystery timeline, clue plants, red herrings and the reveal cascade, with plant, development and resolution points and reader state tracked for each element, and ISC criteria.
- The world framework, relationship arcs (with special attention to the Influence Character relationship) and prose strategy are defined, and a full beat map gives every major story beat with all seven layers mapped.
- The ISA opens with its `## Ideal State` ladder seeded from the Foolscap spine: L3 is the story in one sentence (theme and dramatic question), L2 is that sentence plus four bullets, and L1 is the full articulation (hook, climax, the three acts, the reader-experience target from the interview).
- The story's criteria (character arcs, plot beats, mystery reveals) are `ISC-N` lines in the ISA's `## Criteria`; the beat map and layer detail live in the ISA body, and progress and session notes go in the ISA's own frontmatter and log, never in a parallel STATUS, CRITERIA or LOG section.
- For a multi-book series, a parent file for the series and a child file per book exist, cross-book arcs and series-level mysteries are mapped, and each book works as a satisfying standalone and advances the series.
- The writer is shown the bible with the five presentation items under Output format: what was mapped, gaps or decisions still needed, which chapters to write first, and the Explore and WriteChapter options.

## Anti-criteria

- Never starts over when the interview already carries the spine: BuildBible expands that spine.
- Never written as a one-off PRD outside the ISA system.
- No world element that does not serve the story: if you can remove it and nothing changes, it is removed.
- New chapters are never written without first reading the ISA, the source of truth for continuity.

## Inputs

- The saved interview for this book: `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/WriteStory/projects/<book-slug>/interview.md`. It carries the confirmed spine, the derivation lens used, the per-layer state, and the one-page **Foolscap spine** (theme, dramatic question, hook, climax, three acts).
- Read `StoryLayers.md` for layer definitions
- Read `StorrFramework.md` for character construction protocol
- Read `PressfieldFramework.md` for concept, hook, theme-question, villain design
- Read `PhasesAndEvents.md` for three-act phases and mandatory event positions
- Read `StoryStructures.md` for additional framework perspectives

## Tool contract

**Location:** `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/WriteStory/projects/<book-slug>/ISA.md`

Create it via `Skill("ISA", "scaffold project ISA at <path>")`, then fill it, with the Story Bible content in the ISA sections the Ideal State names: the Foolscap spine seeding `## Ideal State` L3, L2 and L1, criteria in `## Criteria`, the beat map and layer detail in the body. Section names and ladder rules are `LIFEOS/DOCUMENTATION/ISA/ISAFormat.md`'s.

## Output format

### Story parameters and Pressfield foundation

From the Interview output or user input, confirm:
- **Scope:** Short story / Novella / Novel / Series
- **Genre:** Primary + secondary genres
- **Aesthetic Profile:** From AestheticProfiles.md
- **POV:** First person / Third limited / Third omniscient / Second / Multiple POV
- **Tense:** Past / Present

Then establish the Pressfield foundation (from `PressfieldFramework.md`):
- **Concept:** One sentence — the clothesline everything hangs from
- **High Concept test:** Does the one-sentence pitch get "I'd read that"?
- **Theme-Question:** The inquiry the story investigates (yes/no or either/or)
- **Hook:** How does the opening promise the concept?
- **Villain design:** Who/what embodies the counter-argument to the theme?
- **The Gift:** What wisdom will the hero bring back?

### Criteria

Criteria for character arcs, plot beats and mystery reveals go in the ISA's `## Criteria` as numbered `ISC-N` lines, phrased like these:

```
- [ ] ISC-1: [Character] transforms from [flaw state] to [new state]
- [ ] ISC-2: [Character]'s sacred flaw [flaw] is established through behavior by [beat]
- [ ] ISC-3: [Character]'s crisis forces a choice between [flaw] and [need] at [beat]
- [ ] ISC-4: Catalyst event [event] disrupts [character]'s world at ~10%
- [ ] ISC-5: Midpoint [false victory/defeat] raises stakes at ~50%
- [ ] ISC-6: All Is Lost moment exposes [character]'s sacred flaw at ~75%
- [ ] ISC-7: Primary mystery [question] is introduced by [beat]
- [ ] ISC-8: [N] clues are planted before the reveal at [beat]
- [ ] ISC-9: At least [N] micro-mysteries are active at any point
```

### World framework

Map world elements needed for the story:

1. Physical geography (only what the story visits/references)
2. Political/power structures (only what affects characters)
3. Rules/magic systems (if applicable — apply Sanderson's Laws)
4. Cultural details (only what drives character behavior or conflict)
5. History (only what matters to the present story)

### Relationship arcs

For each key relationship:

1. Initial state (how they meet, first dynamic)
2. Tension points (disagreements, challenges)
3. Deepening moments (vulnerability, shared experience)
4. Crisis point (relationship tested)
5. Resolution (new equilibrium)

Special attention to the **Influence Character** relationship: the one that most directly challenges the protagonist's sacred flaw.

### Prose strategy

Based on the Aesthetic Profile:

1. Sentence length and complexity patterns
2. POV consistency rules
3. Dialogue voice guidelines per character
4. Description density by scene type

No figure plan: figures are rare, from the character's world, and placed only where the writer names the moment (`WriteChapter.md` § The sentence contract).

### Beat map

One entry for each of the 15 Save the Cat beats (the Snyder column of `PhasesAndEvents.md` § Master Event Table), Opening Image through Final Image, each mapping all seven layers in the shape of `StoryLayers.md` § Mapping Template:

```markdown
## Beat Map

### Beat 1: Opening Image (0-1%)
- **MEANING:** [thematic element present]
- **CHARACTER:** [sacred flaw visible through behavior]
- **PLOT:** [establishing event]
- **MYSTERY:** [first question planted]
- **WORLD:** [initial setting established]
- **RELATIONSHIP:** [key bond introduced]
- **PROSE:** [register, tone]

### Beat 2: Setup / Theme Stated (1-10%)
[same structure, through Beat 15: Final Image (99-100%)]
```

The bible body (below) is the working content the ISA carries after its `## Ideal State` ladder and beside its `## Criteria`; progress is the ISA's `progress` frontmatter field:

```markdown
## CHARACTERS
[Full character profiles with sacred flaws, wants, needs]

## BEAT MAP
[Full 15-beat map with all 7 layers per beat]

## MYSTERY ARCHITECTURE
[Information management timeline]

## WORLD FRAMEWORK
[Essential world elements]

## RELATIONSHIP ARCS
[Key relationship timelines]

## PROSE STRATEGY
[Aesthetic profile, sentence and dialogue patterns]
```
