# Script

`Essay.md` → `Script.json`: the narration cut into beats, each carrying one visual that earns its place.

## Ideal State

- `Meaning/Visuals.json` existed before `Script.json` was written: `Meaning.ts` mapped `## The Argument`, directed every paragraph group with a written rationale, and its two-vendor review passed; a failed review was fixed in the essay or the plan before scripting.
- Each directed insert appears, exactly as compiled, on the beat whose sentence carries its claim, and no beat straddles a directed insert's paragraph edge; the other beats in that span, beats under a `none` choice, and unrenderable concepts are the script's call, held to the rules under Output format, and `ScriptLint.ts` checks this whenever `Meaning/Visuals.json` exists.
- `Script.json` follows `References/ScriptSchema.md` and the rules under Output format, and `bun Tools/ScriptLint.ts --run <slug> --require-classes motion,screenshot,scroll,zoom,code` exits 0; a class is dropped from the requirement only when the content genuinely has nothing for it, and that is said.
- The script has 15–35 beats, each with narration and a typed visual; all five classes are present when the content supports them; it has chapters; its runtime is within 25% of target.
- Read once as a viewer, every beat changes the picture when the idea changes, and nothing moves while the viewer is meant to be reading.
- The script is shaped for the bars the Assay video eval set (`video-eval`) holds its render to: no more than two consecutive beats of one visual type (`visual-variety`), a runtime within 15% of `targetMinutes` (`script-length`), and a picture that changes at least every 8 s of narration (`visual-cadence`).

## Anti-criteria

- The words on screen are never the words being said.
- No guessed URL: every URL is real, resolved, and loaded once in the Interceptor test context before it goes in the script, because guessed slugs 404 on camera. X/Twitter URLs are never captured.
- No `zoom` `selector` is written down before it is checked against the page's real DOM in Interceptor.
- Names never go in `tts`; they go in `pronunciations.json` as respellings.
- Never three consecutive beats of the same visual type: the eval set's `visual-variety` fails the render at three, though ScriptLint refuses only four.

## Evals

- compiled: Assay checks the script against the Ideal State and Anti-criteria above, and the Assay video eval set (`video-eval`, `skills/Assay/Tools/VideoEval.ts`) checks the render it becomes, in `Run.ts`'s `eval` stage (`Intents/Produce.md`).

## Tool contract

`bun ~/.claude/skills/VideoEssay/Tools/Meaning.ts --run <slug>` runs before `Script.json` is written and writes `Meaning/Visuals.json` (each directed beat's paragraphs and its compiled visual); a failed review exits with its defects.

## Output format

- Narration is `## The Argument`, split at idea boundaries into beats of 15–70 words (the authoring target; ScriptLint's hard bounds are 4–90). The visual shows the thing the sentence is about.
- Each beat's visual is elected by what the sentence references: a quote from the source → `quote`; a published post or a page → `scroll` (the page holds on its top, then eases down) or `zoom` (one paragraph matters: `selector` from the page's real DOM); a single fact on a page → `screenshot`; a concept, contrast, count, or process → `title` / `compare` / `stat` / `points` / `diagram`; code the argument turns on → `code` with `highlight` lines.
- `chapter` on the opening beat and on each turn of the argument (4–7 chapters for a 7-minute essay). Chapter titles are short nouns, since they also become the description's chapters and the thumbnail vocabulary.
- `thumbnail`: `white` and `accent` lines, three words total at most, one word per line.
- `tts` overrides only when the display text would be misread aloud (a URL, a symbol).
