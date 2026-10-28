# Storyboard

The one creative stage: `Storyboard.json` for a run whose `Beats.json` exists, in the shape of `References/StoryboardSchema.md`.

## Ideal State

- One `style` line that a painter could work from: medium, paper, line, wash, light, and an accent rule that ties each color to a meaning in this story (for example warmth on people, one cold color on the machine). Forty images stay one film because the accent rule is fixed, not because the prompts repeat adjectives.
- A bible entry for every person who appears in a painting, every place that recurs, and every object that must be recognizable across shots (`kind: "object"`).
- Each person's `desc` is what a portraitist needs: age, build, skin, hair, one or two garments, one telling habit.
- Age is stated as an instruction about the face, never a mood adjective. Ages that differ from the present (a flashback) are said in the shot prompt, with the reference sheet still attached.
- Each person's appearance follows what the story says, and where the story is silent it follows the casting rule in the principal's `PREFERENCES.md` (see Data & Config) when one is set.
- A `desc` names what the character must NOT carry (a device, a color) whenever the plate or another character could bleed onto them.
- Exactly one shot per beat, each in the bible's style. The prompt describes a painted film frame a reader of that paragraph would accept as its picture: what is in frame, where the light is, what the eye lands on.
- The register holds one tone across the film: the `register` in `PREFERENCES.md` when set, else the tone the story itself sets. When a beat is an idea rather than a scene, the shot shows the real place in the story's world where the idea is visible.
- Every shot carries the reference sheets it needs (the people, recurring places and recognizable objects in frame); every shot with a person carries that person's ref, and the lint enforces it by the bible's `key`. Names like "the boss" or "the mother" get an explicit `key`.
- A camera move chosen for the beat: `push` for attention narrowing or dread, `pull` for loss and aftermath, `pan-*` for a space or a sequence being taken in, `tilt-up` for arrival or scale, `tilt-down` for a fall or a settling, `hold` for a beat that should not be touched. Two people walking toward the camera want a push, not a tilt. A push into an already extreme close-up has nowhere to go; start a step wider.
- `focus` marks where the move should keep the eye, in unit coordinates.
- Before `Produce`, a fresh-context read of the storyboard against the story was taken by a non-forked reviewer that had not seen the prompts being written, and each finding was adopted, rebutted or deferred in the run's notes.
- `StoryboardLint.ts --run <slug>` exits 0, run again after the review findings were handled.

## Anti-criteria

- No shot prompt asks for text, and no shot shows what the reader does not yet know at that beat.
- No infographic or diagram unless the story itself is abstract, and no drawn metaphor where a real place in the story's world shows the idea.
- No `desc` contradicts the configured casting rule or what the story says about a person.
- No person in a painting without that person's reference sheet, no recurring place or recognizable object painted without its sheet, and no flashback painted at the wrong age.
- No push into an already extreme close-up.
- No painting before the fresh-context review and a clean lint: forty paintings are the expensive stage.

## Gotchas

- The fresh-context review catches the things the writer cannot see: a reused metaphor, a flashback painted at the wrong age, a person with no reference sheet, a shot that lingers where the prose looks away.
- **"Tired" ages a face by fifteen years (2026-09-17).** A twenty-four-year-old described as "a small tired kind face" came back in her forties; "smooth, soft, no lines, must read as early twenties" fixed it. Give ages as instructions about the face, not adjectives about mood.
- **The lint's name check keys on one word per character.** Names like "the boss" or "Ana's mother" need an explicit `key` in the bible entry, otherwise the derived key is wrong ("Ana" for the mother) and every shot naming the daughter flags the mother.

## Data & Config

Casting and register preferences live at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/StoryFilm/PREFERENCES.md` (`configRoot` is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). Read it before writing the bible; when it is absent, the story alone decides appearance and register.

## Tool contract

```bash
bun ~/.claude/skills/StoryFilm/Tools/StoryboardLint.ts --run <slug> [--json]
```
