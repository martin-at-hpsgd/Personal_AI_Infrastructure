# Revise

Iterates on existing story content, from a single paragraph to an entire act: tightens prose, deepens layers, enhances memorable moments and fixes structural issues, with the Story Bible as the source of truth for what each section should accomplish.

## Ideal State

- The revision type (Polish, Deepen, Restructure, Voice, Anti-cliché, De-machine, Figure) matches the request, and a writer saying the prose "sounds like AI" gets De-machine.
- The whole chapter/scene/passage was read in full before any change, and what already worked in it survives the revision.
- The revised content matches the relevant Story Bible beats: the chapter accomplishes what the beat map says it should, all seven layers are represented, the sacred flaw is visible/pressured as planned, mystery elements are properly planted/developed, and the prose matches the Aesthetic Profile.
- A Polish revision has strong verbs where weak ones stood, no redundant words or sentences, descriptions in ordinary words, inert details kept and no detail placed for effect (`AntiCliche.md` § The mechanisms), varied sentence length, and a clean Anti-Cliché sweep.
- A Deepen revision gives each underserved layer content at natural insertion points through action and behavior, not exposition (for example, a moment where the sacred flaw affects a decision, or a detail planted that will matter three chapters later).
- A Restructure revision lists all scenes in their new order with the beat each serves; the order improves causal chain clarity, pacing rhythm (fast/slow alternation), mystery information flow and emotional escalation; scenes that serve no beat are removed and missing beats get scenes.
- In a Voice revision every line of dialogue passes against the Story Bible character profiles: the speaker is identifiable without attribution, vocabulary matches their education/background, sentence structure matches their personality, and subtext is present in emotionally charged moments.
- Anti-cliché, De-machine and Figure revisions follow their recipes under Tool contract, and a De-machine revision reports the gate axes and the voice line-up shortfall rate with the revision.
- After revision every consistency check holds: changes don't contradict earlier/later chapters, character voice remains consistent, mystery information state is still correct, the causal chain is still intact, the Aesthetic Profile is maintained, no new clichés were introduced, and `StoryGate.ts` still passes and the `StoryJudge.ts` shortfall rate did not rise.
- If the revision changed anything structural, the Story Bible is updated: the relevant beat map entries, character profiles if behavior changed, mystery architecture if information flow changed, ISC criteria, and a note of the revision in the ISA's log.

## Anti-criteria

- Never breaks what is already working.
- Never deepens a layer through exposition.
- A Figure revision never goes looking for moments to decorate and is never a density pass: the writer names the moment, one moment gets one figure, and a figure that raises the shortfall rate comes out.
- A De-machine fix is never limited to the quoted sentence: the mechanism is fixed across the whole draft.

## Inputs

The revision types:

| Type | Description | Approach |
|------|------------|----------|
| **Polish** | Line-level prose improvement | Focus on Prose layer only |
| **Deepen** | Add missing layer content | Identify gaps, weave in |
| **Restructure** | Reorder or reimagine scenes | Revisit beat map, reorganize |
| **Voice** | Fix character dialogue consistency | Read character profiles, rewrite dialogue |
| **Anti-cliché** | Remove generic/tired language | Run full AntiCliche.md sweep |
| **De-machine** | The prose falls short of the corpus voice through the six mechanisms (the usual reason a revision is asked for) | Measure, then fix by mechanism: see Tool contract |
| **Figure** | Add rhetorical power to a key moment | One moment, one figure the character would think; never a density pass |

## Tool contract

**For Anti-cliché revisions:**
1. Run the full sweep from `AntiCliche.md`
2. Flag every instance from every Banned Phrase Category
3. Apply the six Freshness Rules (`AntiCliche.md` § Freshness Rules): Specificity Test, feeling named or shown, Action Test, Comparison Kill, Verb Test, Dialogue Voice Test
4. Replace each flagged instance with a fresh alternative
5. Run the Machine Rhythm sweep (`AntiCliche.md` category 7): fragments, paragraph-ending beats, fortune-cookie lines, contrastive pairs, rule-of-three runs, stacked short declaratives, one-line stings, narrator's asides (the universalizing clause). Smooth each into ordinary connected sentences; this is the pass a vocabulary sweep cannot do

**For De-machine revisions** (the default when the writer says it "sounds like AI"):
1. Load `Exemplars.md` (SKILL.md § Data & Config) and read it before touching the draft
2. Measure: `bun ~/.claude/skills/WriteStory/Tools/StoryGate.ts <draft>` and `StoryJudge.ts <draft>` (the voice line-up shortfall rate is the verdict; the diagnosis is advisory, and `--detect` adds a model-detection rate that never decides a pass)
3. Fix by the mechanism the numbers name (`AntiCliche.md` § The mechanisms), across the whole draft, not the quoted sentence: summary → scene with speech; narrator stepping out → cut the clause or make it this person's; chained clauses → end the sentence at the fact; landing lines → end on the last thing that happened; manufactured figures → ordinary words; rhythm effects → connected sentences
4. Measure again. Report the gate axes and the shortfall rate with the revision. Two rounds is normal; a third failure on the same axis means the scene plan, not the sentences

**For Figure revisions:**
1. The writer names the moment; you never go looking for moments to decorate
2. Read `RhetoricalFigures.md` for the one figure that fits
3. Rewrite that line, once, in words the character would use
4. Run `StoryGate.ts` and `StoryJudge.ts` afterwards; a figure that raises the shortfall rate comes out

## Output format

Present the revised content with:
1. The revised prose (with changes highlighted if helpful)
2. Brief summary of what changed and why
3. Any Story Bible updates made
4. Recommendation for next revision pass (if needed)
