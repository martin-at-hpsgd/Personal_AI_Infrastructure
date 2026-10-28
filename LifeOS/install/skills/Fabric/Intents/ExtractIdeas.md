# ExtractIdeas

The full list of ideas a source, topic or conversation holds, each one a distinct claim stated plainly in one short sentence, under one Ideas section.

Our ideal-state port of Fabric's `extract_ideas`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

## Ideal State

- The list delivers what the principal wants from this input, inferred before writing and never asked for. A pasted artifact (an essay, post, transcript, talk, email thread, notes), a URL, a YouTube link or a file means every idea that source puts forward, read in full. A bare topic or field ("stoicism", "network effects", "behavioral economics") means the ideas that define it, each stated as the claim its holders make, at the level an expert would sign. A question ("what are the big ideas in urban planning?", "what ideas does this talk have about hiring?") means the ideas that answer it. "This" or nothing means the ideas raised in the current conversation, from both sides, mine included. A typed hint ("the 10 most important", "only the contrarian ones", "just the second half") overrides the default read and narrows the list to what it names, with exactly the count it names.
- Every bullet is an idea: a claim, argument, proposal, explanation, prediction or concept the input advances, stated as the claim itself ("Small daily habits compound into large changes over years."). A fact appears only as the point it is used to make, never as a bare event or number. A label or phrase ("Network effects", "The role of habits") is not an idea.
- The list is complete for a source: every distinct idea the source advances is there, including the minor ones, and none is left out to keep it short. Its length follows the input, from three bullets for a paragraph to dozens for a long talk, never padded to look thorough. The ideas the input rests on most come first.
- Every bullet is faithful. It says what the source says, with its numbers, names and conditions intact, and adds no claim the source does not make. A view the source reports in order to reject it is never stated as the source's own; the idea is the source's verdict on it. An idea the source credits to someone else names that person or group.
- Every bullet is specific to this input: it carries the mechanism, condition or example that makes it this source's idea, so it would not fit most other sources on the subject ("Rents fell after parking became housing", never "Housing policy matters").
- No two bullets state the same idea in different words, and no two open with the same first two words.
- Each bullet is one complete sentence of 4 to 15 words, in plain, exact words: the most precise ordinary word over jargon, no hedging filler, no word spent on reaching the count.
- Input that advances no ideas (a shopping list, a log, a schedule, a table of raw numbers) gets the one `None found:` line saying what the input is instead.
- `bun skills/Fabric/Tools/ExtractIdeasCheck.ts` passed on the exact output before it was delivered, with `--count` set whenever the request named a count. Where no shell is available, the shape, word counts and openings are checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never narration in place of the idea ("The author argues that…", "The speaker discusses…", "This article explains…").
- Never a claim the source does not make, a reported view presented as the source's position, or a source's case turned into a general lesson it never draws.
- Never a source read from its title, its opening, or a fetched page summary instead of its full text.
- Never a bare topic answered with a description of what the topic covers instead of the ideas it holds.
- Never a list cut short of a source's ideas, and never bullets invented to make a thin input look rich.
- Never a request that is not an idea-extraction job (what this pattern does, how it differs from extracting insights) turned into an ideas list; it is answered directly.
- No preamble, persona, caveats, sub-bullets, bold, italic or commentary outside the one section.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-extractideas — code checks on the one heading, the bullet shape and the none line; judged checks on completeness, faithfulness to the source (a rejected view kept as rejected), ideas stated as claims rather than narration, specificity, the topic read and the named count.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: pasted text, a URL, a YouTube link, a file path, a bare topic or field, a question, or "this"/nothing for the current conversation. A URL or video is read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- An optional hint narrowing the list: a count, a part of the source, or a kind of idea.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/ExtractIdeasCheck.ts <file|-> [--count N] [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| (any ideas list) | `<file>` or `-` | Check the saved draft or stdin |
| "the 10 most important ideas", "top 5" | `--count N` | Also require exactly N bullets |
| (piping the result to another tool) | `--json` | Print `{ok, none, ideas, problems}` |

## Output format

```markdown
## Ideas

- {one idea as a complete sentence, 4 to 15 words}
- {the next idea, opening on different words}
```

- Every item is a `- ` bullet on its own line, one sentence ending in `.`, `?` or `!`. No numbered list, no sub-bullets.
- Input with no ideas is the heading and the single line `None found: {at most 30 words on what the input is instead}`.
- Nothing else: no other heading, no summary line, no bold or italic.

## References

- Upstream: `Patterns/extract_ideas/system.md` (a 2,128-IQ persona told to spend hundreds of hours building a mental graph on a virtual whiteboard, then output the full list of ideas in 15-word bullets under an IDEAS section, with no repeats and no two items opening on the same words).
- `Tools/ExtractIdeasCheck.help.md`: the checker's rules and exit codes.
- Neighbors: `Intents/ExtractInsights.md` when the request wants only the non-obvious, highest-value points; the ExtractWisdom skill for content-adaptive sections with quotes and contrarian takes.
