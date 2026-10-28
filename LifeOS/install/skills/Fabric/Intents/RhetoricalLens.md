# RhetoricalLens

How a text persuades, read through classical rhetoric: how it earns the right to be heard, what it makes the reader feel and when, how its case is built and where it has gaps, why it lands in its moment, who it is written for, and the specific moves worth studying, each pointed to in the text's own words.

Our ideal-state port of Fabric's `lens_rhetorical`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

## Ideal State

- The analysis delivers what the principal wants from this input, inferred before writing and never asked for. A pasted text, a URL, a YouTube link or a file means how that exact text persuades, with every finding pointed to in its words. A bare named text ("the Gettysburg Address", a famous ad campaign) means that text as it is publicly worded, with the version analyzed named in a `**Source:**` line. A bare genre or form ("startup pitch decks", "charity appeal letters") means the rhetoric that genre typically uses, with `**Source:**` naming it as a composite and its example phrases marked as typical, never quoted as if from one real text. A question about a text ("why does this work?", "why didn't this land?", "how could this persuade better?") gets the full analysis with its direct answer in an `**Answer:**` line under the title. "This" or nothing means the draft, post or argument under discussion in the conversation, which is often the principal's own writing he wants to sharpen. A typed hint ("just the pathos", "focus on the audience") overrides the default and narrows the output to the sections it names, in the same format and order.
- The analysis is about how the text argues, never a summary of what it argues. Every section names the mechanism (the credential implied, the feeling triggered, the inference made, the condition exploited) and points to where it happens.
- When a text was supplied, every quotation appears in it word for word, and Ethos, Pathos, Logos, Audience construction and Notable techniques each quote it at least once.
- Ethos shows how the author claims the right to be heard (credentials stated or implied, personal story, strategic vulnerability, tone) and names both where that authority is strongest and where it is most precarious.
- Pathos maps the emotional sequence in order: which feelings come when, what image or story carries them, and where the text makes the reader feel something against where it only tells the reader what to feel.
- Logos lays out the claims, the evidence offered for each and the inferential moves (analogy, example, authority, cause and effect, narrative), and names each logical gap or elision specifically. When the reasoning is tight, it says so rather than inventing a gap.
- Kairos says why the argument works in its moment: the historical, social, technological or emotional conditions it relies on, and what would make it land worse in an earlier or later time. For an undated text it reads the moment from what the text assumes.
- Audience construction describes the implied reader (situation, values, knowledge, fears, aspirations), who the text's "we" includes and leaves out, and which reader it would fail to persuade and why.
- Notable techniques lists the distinctive moves (metaphor, framing, structure, repetition and anaphora, concession, questions, handling of counterarguments), each named, quoted where it appears, and explained in how it works on the reader. Each technique is one the text actually uses, specific enough that it would read wrong under a different text.
- Depth follows the text, and the whole analysis fits a budget set by the text's length: under 250 words for a text under 50 words, under 600 for a text under 300 words, under 1000 for a text under 1500 words, and under 1500 beyond that; a bare named text or genre stays under 800. A slogan or a two-line ad gets one or two techniques. A dimension the text barely uses gets one sentence saying so and why, never padding.
- Words are plain and exact, with rhetoric terms (ethos, anaphora, kairos) used where they are the precise word and explained by what they point at.
- Sources are read in full before any analysis (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- `bun skills/Fabric/Tools/RhetoricalLensCheck.ts` passed on the exact output before it was delivered, with `--source` pointing at the supplied text whenever there was one, or `--max-words 800` when there was none. Where no shell is available, the sections and quotations are checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a quotation that does not appear in the supplied text, and never a named text quoted from memory with wording that is not its own.
- Never a section that restates the text's argument instead of analyzing how it persuades.
- Never a generic finding that would fit most persuasive texts ("uses emotional language", "establishes credibility", "appeals to the reader") without the words that show it.
- Never a manufactured gap, emotion or technique to fill a section the text does not support.
- Never a verdict on whether the text's position is right; the lens judges how it persuades, not what it believes.
- Never a source analyzed from its title or a fetched page summary instead of its full text.
- No preamble, warnings, notes or commentary outside the sections.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-rhetoricallens — code checks on the title, the six sections in order, the Source and Answer lines and the technique bullets; judged checks on analysis over summary, quotations faithful to the text, the strongest and most precarious ethos, felt against told emotion, specific gaps and the reader the text fails.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The text: pasted, a URL, a YouTube link, a file path, a bare named text, a bare genre or form, a question about a text, or "this"/nothing for the conversation's subject.
- An optional hint narrowing the analysis to named sections.

## Tool contract

Run from `~/.claude`. Save the draft (and the supplied text, when there is one), check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/RhetoricalLensCheck.ts <file|-> [--source <text-file>] [--max-words N] [--sections <list>] [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| (any full analysis) | `<file>` or `-` | Check the saved draft or stdin |
| (a text was supplied) | `--source <text-file>` | Every quotation must appear in that text, the five quoting sections must quote it, and the word budget follows its length |
| (a bare named text or genre) | `--max-words 800` | Cap the analysis at that many words |
| "just the pathos", "focus on the audience" | `--sections pathos,audience` | Expect only the named sections, in canonical order |
| (piping the result to another tool) | `--json` | Print `{ok, sections, techniques, quotes, problems}` |

## Output format

`**Source:**` appears only when no text was supplied; `**Answer:**` only when the request asked a question. Each section is prose or short bullets; Notable techniques is always bullets.

```markdown
# Rhetorical Lens: {what the text is, in a few words}

**Source:** {the version analyzed, or "Composite of {the genre's typical texts}"}

**Answer:** {the direct answer to the question asked}

## Ethos

{how authority is claimed, quoted; where it is strongest and where most precarious}

## Pathos

{the emotional sequence in order, what carries it, felt against told}

## Logos

{the claims, their evidence and inferential moves, and each gap}

## Kairos

{the conditions that make it land now, and what would make it land worse then or later}

## Audience construction

{the implied reader, who "we" includes and excludes, the reader it fails and why}

## Notable techniques

- **{Technique}:** "{exact quotation}" {how it works on the reader}
```

A hint-narrowed analysis keeps the title and only the sections the hint names, in the order above.

## References

- Upstream: `Patterns/lens_rhetorical/system.md` (the six-part classical reading: ethos, pathos, logos, kairos, audience construction and notable techniques, quoting the text and calibrated to its length).
- `Tools/RhetoricalLensCheck.help.md`: the checker's rules and exit codes.
