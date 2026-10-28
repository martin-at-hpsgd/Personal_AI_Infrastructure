# WriteChapter

**Contents:** Ideal State · Anti-criteria · Safety gates · Inputs · Tool contract · Output format · Gotchas

Turns Story Bible beats into a revisable draft chapter built on named craft mechanisms. The seven layers say what the chapter has to do; this intent says what the sentences have to be, and it measures them against published fiction before anyone reads them. The draft is delivered as an AI-assisted draft the writer owns; nothing is shaped to hide that a model was involved.

## Ideal State

- Before drafting, a composition contract was written down from the Story Bible: for each beat in the chapter, what each of the seven layers is doing, and the beats broken into scenes, each with a POV character, a want, an opposition, a turn, and an outcome, so the layers are served by the scene rather than inserted afterwards.
- The vantage and the scene list were decided in that contract, never in the prose: who is telling this, from where, when, what they cannot know, what they get wrong; every strand gets dramatized scenes with people speaking, and the turns of the story happen inside them.
- The writer was asked for texture, not plot: one lived particular they actually know for each planned scene, transcribed in their phrasing, and at least one placed unaltered and unexplained in each scene.
- `Exemplars.md` was read in full before a word was drafted, and the prose meets the sentence contract under Output format.
- The chapter does what its beats say across the seven layers.
- The prose measures inside the human bands: `StoryGate.ts` passes.
- The draft matches the voice and quality of published fiction, free of the six mechanisms: in the `StoryJudge.ts` voice line-up, a blind judge comparing it with published paragraphs prefers the published paragraph in both orders on at most 0.6 of pairs (parity is 0.5). The number locates craft defects to fix. A model-detection rate (`--detect`) may be read as a diagnostic, and it is never the pass condition or a reason to disguise authorship.
- The four mandatory passes in `Critics.md` (all eight for opening, midpoint, climax, finale) existed and were checked before delivery: every change from them that improves the chapter is in the delivered prose, and a chapter changed above a word after them carries a fresh measurement.
- The numbers are in the report: gate axes, shortfall rate, and the diagnosis dimensions that failed. A chapter presented without them is not done.

## Anti-criteria

- Nothing is shaped to hide that a model was involved: the chapter is delivered as an AI-assisted draft the writer owns, and no step exists to make authorship undetectable.
- Never drafts without the fiction voice model: `Exemplars.md` in context and `StoryProfile.json` for the gate (Safety gates).
- No omniscient voice that knows every mind exactly when the argument needs it: it is the machine's default and reads as a lecture.
- No turn of the story happens in summary: summary is connective tissue between scenes.
- No measuring paragraph by paragraph before the whole chapter is drafted: that produces prose written to the meter.
- Revision never fixes only the sentence the judge quoted: it fixes what the numbers name.
- The six-mechanism diagnosis is never the gate: it is advisory, and real authors score below 0.7 on it.
- Critics suggest at the line level and never rewrite.
- When scenes are drafted in parallel, measuring, revision and critic passes never run on the pieces, only on the merged chapter.

## Safety gates

- **The fiction voice model** (SKILL.md § Data & Config): `Exemplars.md` loaded into context before a word is drafted; `StoryProfile.json` for the gate. If the model is not built, build it first; drafting without it produces prose that sounds like a model.

## Inputs

- Story Bible ISA exists (from BuildBible), and you know which beat(s) this chapter covers
- `AestheticProfiles.md` — the configured style
- `AntiCliche.md` — the mechanisms of machine prose and their fixes (§ The mechanisms, § Category 7)
- `Critics.md` — the review passes

## Tool contract

```bash
bun ~/.claude/skills/WriteStory/Tools/StoryGate.ts <draft.md>
bun ~/.claude/skills/WriteStory/Tools/StoryJudge.ts <draft.md>
```

The gate names the axes that drifted (sentence length, clauses per sentence, share of long sentences, paragraph-ending beats, dialogue share, universals, fragments) and any narrator's aside. The judge's verdict is the blind voice line-up: the draft's paragraphs against corpus paragraphs, a judge asked which carries the stronger voice and craft, both orders; the shortfall rate (pairs the published paragraph won both times) is the number. Its diagnosis (six mechanisms, each with a reason) tells the revision what to fix.

What the numbers name, and the fix. A high clause count means the sentences chain; break them across the draft. A low dialogue share means the scenes are summarised; put the people back in the room and let them talk. A failed `paragraph_endings` in the diagnosis means the paragraphs perform; flatten the last sentences. A shortfall rate that stays high after the axes are in band means the sentences are still evenly weighted and interpretive; rewrite the scene from the exemplars rather than editing it. Then run `AntiCliche.md`'s checklist once, and measure again. Two rounds is normal. If the third round still fails the same axis, the scene plan is the problem: return to the composition contract.

### Multi-agent production (novel or series)

Sequential drafting by one agent keeps the voice. If scenes are drafted in parallel, every agent gets the same Aesthetic Profile, `Exemplars.md`, and the character voice profiles.

## Output format

### The composition contract

Written down before drafting. For each beat in this chapter, what each layer is doing: MEANING, CHARACTER (where the sacred flaw is pressured), PLOT (what happens, what causes it, what it causes), MYSTERY (what the reader learns, what opens), WORLD, RELATIONSHIP, PROSE (register). Then the scenes, each with a POV character, a want, an opposition, a turn, and an outcome.

The texture the writer supplied, one lived particular per scene in their phrasing (what a party in that neighborhood smells of, the text their own mother sends, a boss's tic, a stairwell). Those are the inert details and the lines of speech a model cannot supply.

### The sentence contract

`AntiCliche.md` category 7 catalogues the rhythm tells these rules exclude, with examples.

- **Scene, not summary.** People in a place doing and saying things in order. Speech carries the turns; a scene with no one speaking needs a reason. "Over the next weeks" narration joins scenes and is kept short.
- **The narrator stays with the character.** Report what this person did, saw, said, and thought, here. No clause that generalises to everyone, nobody, anyone, or people (the narrator's aside). No line that explains what the moment means or what the reader should feel. Feeling is named plainly and rarely, or shown as an object and an action; never both, and never explained after it was shown.
- **Sentences stop.** A sentence delivers its fact and ends. Commas join facts that belong together. No clause chained on for rhythm, no fragments stacked for punch, no runs of short declaratives, no word order chosen for the cadence.
- **Paragraphs end on the last thing that happened.** Not on a sting, a reversal, an aphorism, or a short line placed after long ones. Read the last sentence of each paragraph on its own; if it is there for the snap, cut it or flatten it.
- **Figures are rare and from this character's world.** A comparison is something this person would think of. Ordinary adjectives. No emotion smuggled into objects ("the anxious corridor"), no metaphor per paragraph, no stock concrete swap for an abstraction ("the taste of copper"). `RhetoricalFigures.md` is a reference for the rare moment that wants one, never a quota.
- **Dialogue is people talking.** Each speaker sounds like themselves; what they avoid saying matters. "Said" for attribution; action beats where the body tells you something.
- **Chapter endings end.** Stop where the scene stops. A question left open comes from the plot, not from a line written to leave one.

### The report

1. The prose
2. The three numbers: gate (pass, or the axes), judge score with any failed dimension, voice line-up shortfall rate
3. Which layers each scene advanced, one line each
4. Story Bible updates the writing revealed
5. What to write next

### Chapter length

| Format | Chapter | Scenes |
|--------|---------|--------|
| Short story | continuous | 1–5 total |
| Novella | 3,000–5,000 words | 2–4 |
| Novel | 3,000–6,000 words | 2–5 |
| Epic novel | 4,000–8,000 words | 3–6 |

Guidelines; pacing decides.

## Gotchas

Draft rough and long, then cut. Write each scene with more detail, more speech, and more small wrong human behaviour than the story needs, including things that go nowhere; then cut toward the exemplars. Polished summary cannot be sanded into roughness afterwards, however many revision passes it gets.
