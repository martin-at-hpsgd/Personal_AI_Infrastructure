# ExtractRecommendations

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

The practical recommendations a source makes, and the ones that follow directly from it, each as one short instruction a reader could act on, under a title that names the read.

Our ideal-state port of Fabric's `extract_recommendations`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The output gives what the principal actually wants from this input, inferred before a word is written and never asked for. The read follows what the input is. A pasted artifact (an article, a transcript, a postmortem, a review, a thread) means the recommendations it makes, plus the ones that follow directly from what it shows. A URL or a file means the same for the source it points at, read in full. A bare topic or goal ("sleeping better", "hardening a home router") means the recommendations a recognized expert in it would give, the settled ones first. A question ("what should a small team do about backups?", "what does this say I should change?") means the recommendations that answer it. "This" or "that" means the recommendations made in the current conversation, the assistant's own included, and the ones that follow from where it landed. A typed hint ("only the security ones", "just the guest's", "only what it says outright") overrides the default read.
- The title names the source and the read that was inferred ("Recommendations: A Fictional Team's Backup Postmortem", "Recommendations: Sleeping Better, Expert Consensus"), so a wrong read is visible at a glance.
- A recommendation is an action a reader could take, written as an instruction that opens on its verb ("Test a full restore every month"), concrete enough that the reader knows what doing it looks like. A finding, a description, a fact about the past or a summary point is not a recommendation and is left out, even when it sits in a recommendations section of the source.
- Each bullet states one recommendation in at most 16 words, in plain exact words that keep the source's figures, thresholds, tools and named things ("Keep one backup copy offline, rotated weekly", not "Improve backup practices").
- When the input is a source, the recommendations it makes outright come first, then the ones that follow directly from what it shows, each of those ending in the tag `(implied)`. An implied recommendation follows from this source's own evidence, failure or result, never from general knowledge of the topic. A bare topic, goal or question carries no tags.
- When the input carries more than one voice, a recommendation one of them made opens on who made it ("Ortiz: …"); an implied one names no speaker.
- Within each group the recommendations run from the one that would change the outcome most to the least. There are at most 20, and no two say the same thing. A source with three recommendations gets three; the list is never padded toward twenty.
- Every bullet is specific to this input. A line that would fit most other sources on the same subject as well ("Stay consistent", "Communicate clearly", "Do your research") fails.
- When the input makes no recommendation and none follows from it, the output is the title and the single line `No recommendations found in {the source}.`, and nothing else.
- When the input is a source, the recommendations are the ones it actually makes or that its content supports, read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs). For a bare topic, every recommendation is one practitioners of the field actually give; nothing is attributed to a named authority or carries a figure the model cannot stand behind.
- The whole output is valid Markdown with no bold and no italics: the title and the bulleted list.
- `bun skills/Fabric/Tools/ExtractRecommendationsCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the shape is checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a clarifying question in place of the extraction. The model takes the default read and the title states it.
- Never a recommendation attributed to the source, or to a speaker, that they did not make, never an implied recommendation without its `(implied)` tag, and never a figure, tool or deadline the source did not give.
- Never a finding, a description or a summary point dressed as a recommendation ("Backups failed silently for six weeks").
- Never generic advice the input does not support, and never filler added to make the list longer.
- Never a rationale, an explanation, a sub-bullet, a preamble, a persona, a closing summary, or any text beyond the title and the list.
- Never markdown ordered-list syntax (`1. text`); the recommendations are a bulleted list.
- Never a source read from its title or a fetched page summary instead of its full text.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-extractrecommendations — code checks on the title, the 16-word limit, the 20-bullet cap and the no-recommendations line, plus judged checks on what counts as a recommendation, fidelity to the source, the implied tag, the hint override and specificity.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: a pasted artifact, a URL, a YouTube link, a file path, a bare topic or goal, a question about what to do, or "this"/"that" for the current conversation.
- An optional hint naming which recommendations to keep, whose, or only the stated ones, which overrides the default read.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/ExtractRecommendationsCheck.ts <file|-> [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| (any extraction) | `<file>` or `-` | Check the saved draft or stdin |
| (piping the result to another tool) | `--json` | Print `{ok, recommendations, none, problems}` |

## Output format

Markdown: one H1 title, then the bulleted list, with nothing else. These are the limits the checker enforces:

- The title opens `# Recommendations: ` and names the source and the read.
- Each bullet is one `- ` line of 3 to 16 words, not counting a trailing `(implied)` tag, unindented, and no two bullets are the same.
- There are 1 to 20 bullets, and no untagged bullet follows a tagged one.
- The tag is exactly `(implied)` at the end of the line; `(inferred)`, `[implied]` or a tag mid-line fails.
- No bold or italics anywhere.

```markdown
# Recommendations: {the source, and the read inferred}

- {recommendation the source makes, at most 16 words}
- {speaker}: {recommendation that speaker made}
- {recommendation that follows from what the source shows} (implied)
```

With no recommendation in the input:

```markdown
# Recommendations: {the source}

No recommendations found in {the source}.
```

## References

- Upstream: `Patterns/extract_recommendations/system.md` (an "expert interpreter" persona, a bulleted list of up to 20 recommendations of at most 16 words each, both stated and naturally following from the content; this intent keeps the list, the limits and both kinds, and marks which kind each one is).
- `Tools/ExtractRecommendationsCheck.help.md`: the checker's rules and exit codes.
