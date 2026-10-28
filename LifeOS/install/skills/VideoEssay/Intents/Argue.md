# Argue

Source plus stance → `Essay.md`. The argument is the product; production cannot rescue a weak one.

## Ideal State

- `Essay.md` exists in the run with the frontmatter and the four sections laid out under Output format, and `bun Tools/EssayLint.ts --run <slug> --source` exits 0 on it.
- Every quote in `## Their Claims` is verbatim from `Source/transcript.txt`, cleaned only of fillers and stutters, and attributed to an unambiguous speaker; a quote whose speaker is ambiguous in the transcript is attributed `unsure (...)` and listed in `attribution_unsure`.
- The source is steelmanned and the real disagreement located before any attack: the concessions come first, and a reader who likes the source recognizes their position in `## The Disagreement`.
- `## The Argument` grounds the author's side in the author's own published posts, supplied by the user, by name (they become on-screen visuals) and invents no position for the author.
- `## The Argument` is first person as the DA, 1000–1300 words for a 6–9 minute video unless the user sets a length, states once, plainly, that an AI is making the case, whatever the topic, and follows the writing contract under Output format.
- The essay the user sees has passed every required gate under Safety gates, with the adversarial read's findings folded in and linted again, and the response showing it names the optional audits that ran.
- The essay is sharper than the stance notes it started from: it makes the author's case better than the notes did, without adding a position the author does not hold.

## Anti-criteria

- A video is never parsed from someone else's summary of it, and when the user gives only "I disagree with most of it", the author's positions are never recalled from memory: the user supplies the author's relevant posts (files or URLs), and the essay reads them in full.
- No attack before the concessions; if the author agrees with most of the source, the essay says so, and the disagreement gets sharper, never weaker.
- Never misattributes a quote: misattributing the interviewer's line to the guest in a public video is the credibility failure this skill exists to prevent.
- An AI-detection score, when one is run, is reported, never chased, never a gate, and never a reason to degrade the writing.
- The essay breaks none of the rules in the user's style file (Config.json `styleFile`, below).

## Inputs

- The source: a YouTube URL, article URL, file, or pasted text. `bun Tools/Intake.ts --run <slug> --youtube <url> [--notes <file>]` creates the run and `Source/transcript.txt`.
- The author's stance, in their words, saved to `Source/notes.md`.
- The author's relevant published posts, as files or URLs, when the stance leans on them.
- The user's style file, when Config.json names one in `styleFile` (a Markdown list of writing rules, path relative to the config folder). Without it, the essay follows plain-prose defaults: short paragraphs, every paragraph ending on a fact.

## Safety gates

Gates 1 and 4 are required and run before the user sees the essay; 2 and 3 run when the install has them (the line the response carries is under Output format):

1. `bun Tools/EssayLint.ts --run <slug> --source` exits 0.
2. Optional: an AI-writing-pattern audit over `## The Argument` (the `Writing` skill's DETECT mode when installed), every serious finding fixed in the same voice.
3. Optional: an AI-detection score (`bun LIFEOS/TOOLS/PangramScore.ts --file <argument.txt>`, which needs `PANGRAM_API_KEY`), reported as a number only.
4. An adversarial read by a dispatched fresh-context, cross-vendor reviewer on misattribution, strawman, the strongest objection, invented positions, and tone. Findings are folded in; the fixed essay is linted again.

Checkpoint: show the essay path and the thesis. Stop here unless the ask said to go straight through. The user's edits go into `Essay.md` directly; the lint runs again before `Script`.

## Gotchas

- **The transcript has `>>` turn markers and no speaker labels.** Quote only turns whose speaker is unambiguous from context; mark the rest `unsure` and list them in `attribution_unsure`.
- **Quote normalization strips fillers (uh/um) and immediate word repeats ("a a sort", "like like") on both sides**, so a cleaned quote still matches the transcript. Anything beyond that must be quoted as spoken.

## Output format

`Essay.md` with frontmatter `title`, `thesis` (one paragraph that could stand alone as the video's description), `source`, `stance`, `attribution_unsure` (a list, empty when nothing is ambiguous), and four sections:

- `## Their Claims`: the source's positions as blockquotes, verbatim, each ending `> — <Speaker>`.
- `## Where We Agree`: the concessions, stated before any attack.
- `## The Disagreement`: the real fork, located precisely. Two theories named in a sentence each. A reader who likes the source should recognize their position in it.
- `## The Argument`: the narration, held to the Ideal State on voice, length and grounding.

The writing is bound by the user's style file (Inputs).

When an optional audit ran, the response that shows the essay carries one line naming it, for example `✍️ WRITING-AUDIT: DETECT <findings fixed> · Pangram <AI%>`; with neither installed, it says no writing audit ran.
