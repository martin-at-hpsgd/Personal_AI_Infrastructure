# ExtractPatterns

The patterns that keep recurring across a body of material (interviews, survey answers, reviews, comments, notes, a long talk, a topic's well-known cases), ranked by how often they show up, with where each came from, a one-sentence read, the best five argued from the evidence, and advice for people building in that space.

Our ideal-state port of Fabric's `extract_patterns`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

## Ideal State

- The output gives what the principal wants from this input, inferred before a word is written and never asked for. A pasted artifact that is a collection (interview notes, survey responses, app reviews, support tickets, comments, journal entries, meeting notes) means the patterns that recur across its items, each item counted as a source. A single long piece (an essay, a talk, a transcript) means the ideas, moves and claims it keeps returning to, its speakers or sections counted as sources. A URL, a YouTube link or a file means the same reading of the source it points at, read in full; several files or links mean each one is a source. A bare topic or question ("failed hardware startups", "what do long-lived open-source projects have in common") means the patterns documented across well-known cases of it, each case named. "This" or nothing means what kept coming up in the current conversation, from both sides, mine included. A typed hint ("only the complaints", "the top 10", "just the enterprise customers") overrides the default read and narrows the output to what it names, with exactly the count it names.
- The title names the source and the read that was inferred ("Patterns: 9 Fictional Customer Interviews on Invoicing", "Patterns: Complaints in 40 App Reviews"), so a wrong read is visible at a glance.
- Every pattern recurs: it is the same idea, behavior, complaint or observation showing up in at least two distinct sources (or, for a single piece, at least two separate places in it). A striking one-off is not a pattern and is left out, however interesting.
- The Patterns list is complete for the input and sized by it: a rich input (dozens of sources or a long body of observations) yields 20 to 50 patterns, a thin one yields as many as it actually supports, never padded with one-offs or restatements to reach a number. Patterns are ordered by how often they show up, most frequent first; among patterns seen equally often, the more surprising one comes first. A frequent but obvious pattern stays in, because it is what the material says.
- Each pattern states the recurring thing itself, specific to this input, in at most 16 plain, exact words: who does or says what, under what condition ("Users rebuild the monthly report in a spreadsheet before sharing it"), never a theme label ("Reporting issues") or a line that would fit most inputs ("Customers want better tools").
- Meta has one bullet per pattern, in the same order, giving the evidence behind it: how many sources it appeared in out of how many, as digits, and which ones, named as the input names them ("6 of 9 interviews: Ana, Ben, Chloe, Dev, Eli, Fay"). Unnamed items are named by their place in the input ("reviews 2, 5 and 11"). The counts are the real counts from the input, and a source is never credited with something it did not say.
- Analysis is one sentence of at most 30 words that says what the patterns, taken together, show about this input, a read a person could act on rather than a recap of the list.
- Best 5 holds the five patterns that matter most, judged by frequency first and then by how surprising or consequential each is, each in one bullet of at most 30 words that names the pattern and argues its place from the input's evidence (its count, a source's own words, what it explains). When the input supports fewer than five patterns, the section is headed with that number and holds all of them.
- Advice for Builders gives bullets of at most 15 words each, advice for someone building a product, service or company for the people in this material, each one an action that follows from a named pattern above, never generic startup advice.
- For a bare topic, the list is the 10 to 20 patterns best grounded in cases the model knows of, and Meta names those cases (companies, projects, people, studies, with years where it matters) and counts how many of the named cases show each pattern. A pattern it cannot ground in named cases is left out rather than asserted.
- An input in which nothing recurs (a single short message, one data point, a list of unrelated items) gets the title, the Patterns heading and the one `None found:` line saying what the input is and why nothing recurs, and nothing else.
- The words are plain and exact throughout: the most precise ordinary word over jargon, no hedging filler, and no two patterns opening on the same two words.
- `bun skills/Fabric/Tools/ExtractPatternsCheck.ts` passed on the exact output before it was delivered, with `--count N` whenever the request named a count. Where no shell is available, the shape, word counts and section order are checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a clarifying question in place of the extraction. The model takes the default read and the title states it.
- Never a one-off observation, a single source's quote or the model's own opinion listed as a pattern, and never a pattern the input does not contain.
- Never a count inflated, rounded up or guessed, never a source named for a pattern it did not voice, and never a name invented for an anonymous item.
- Never a source read from its title, its opening or a fetched page summary instead of its full text.
- Never patterns padded to reach 20, and never a list cut short of the patterns a rich input holds.
- Never narration in place of the pattern ("Several people discussed pricing", "The theme of trust comes up").
- Never advice that would fit any startup ("Talk to your users", "Focus on product-market fit") with no tie to a pattern here.
- No preamble, persona, warnings, notes, numbered lists, sub-bullets or any section beyond the title and the five sections.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-extractpatterns — code checks on the title, the five sections in order, the Best heading and the none line; judged checks on patterns that truly recur, counts that match the input, specific patterns over theme labels, Best 5 argued from evidence, advice tied to patterns, grounded topic cases and the typed hint.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: pasted text, a URL, a YouTube link, a file path or several, a bare topic or question, or "this"/nothing for the current conversation. A URL or video is read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- An optional hint narrowing the output: a count, a subset of the sources, or a kind of pattern.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/ExtractPatternsCheck.ts <file|-> [--count N] [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| (any patterns output) | `<file>` or `-` | Check the saved draft or stdin |
| "the top 10 patterns", "give me 25" | `--count N` | Also require exactly N patterns |
| (piping the result to another tool) | `--json` | Print `{ok, none, patterns, problems}` |

## Output format

Markdown: one H1 title, then five H2 sections in this order, each holding only what is listed. These are the limits the checker enforces:

- The title opens `# Patterns: ` and names the source and the read.
- `## Patterns`: 1 to 50 `- ` bullets, each 3 to 16 words, no duplicates, no two opening on the same two words.
- `## Meta`: one `- ` bullet per pattern, each at most 20 words and carrying its count in digits.
- `## Analysis`: one line, not a bullet, of 8 to 30 words.
- `## Best 5` (or `## Best N` when there are N < 5 patterns): exactly that many `- ` bullets, each 8 to 30 words.
- `## Advice for Builders`: 1 to 15 `- ` bullets, each 4 to 15 words.
- No numbered lists, no nested bullets, no other headings, and no text outside these sections.

```markdown
# Patterns: {the source, and the read inferred}

## Patterns

- {the most frequent recurring pattern, at most 16 words}
- {the next, opening on different words}

## Meta

- {N of M sources: which ones, for the first pattern}
- {N of M sources: which ones, for the second pattern}

## Analysis

{One sentence, at most 30 words, on what the patterns together show.}

## Best 5

- {pattern and why it ranks here, with the input's evidence, at most 30 words}

## Advice for Builders

- {an action following from a named pattern, at most 15 words}
```

With nothing recurring in the input:

```markdown
# Patterns: {the source}

## Patterns

None found: {what the input is and why nothing in it recurs}
```

## References

- Upstream: `Patterns/extract_patterns/system.md` (a "take a step back and think step-by-step" preamble, then 20 to 50 patterns of at most 16 words weighted mainly by frequency, a META section on how each was assembled and from whom, a 30-word ANALYSIS, a BEST 5 of 30-word bullets justified from the input, and ADVICE FOR BUILDERS in 15-word bullets; this intent keeps every section and limit, drops the hard floor of 20 for thin inputs, and ties Meta to the patterns one for one).
- `Tools/ExtractPatternsCheck.help.md`: the checker's rules and exit codes.
- Neighbors: `Intents/ExtractIdeas.md` for every idea a source puts forward whether or not it recurs; `Intents/ExtractInsights.md` for the non-obvious, highest-value points.
