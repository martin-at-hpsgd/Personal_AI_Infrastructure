# BusinessIdeas

Every business an input holds or opens up, each stated as what it sells and to whom, followed by the strongest ten pivoted into an adjacent business with a named edge.

Our ideal-state port of Fabric's `extract_business_ideas`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

## Ideal State

- The ideas deliver what the principal wants from this input, inferred before writing and never asked for. A pasted artifact (an essay, post, transcript, talk, email thread, notes), a URL, a YouTube link or a file means the businesses that source proposes or directly opens up: a problem it describes, a cost it complains about, a shift it reports, a workaround people use, each read in full. A bare topic, market or trend ("elder care", "cheap satellite imagery", "the plumber shortage") means the businesses an operator who knows that field would see in it now, at the level an investor would take seriously. A question ("what could you build on top of public court records?") means the businesses that answer it. "This" or nothing means the businesses raised or implied in the current conversation. A typed hint ("only B2B", "ones I could start solo", "20 ideas", "just 5 elaborated") overrides the default read and holds the count it names.
- Every extracted idea is a business, stated in one sentence as what is sold, to whom, and the problem it solves ("A courier network delivers refrigerated prescriptions from regional hubs to rural clinics within a day."). A theme, trend or technology on its own ("AI in healthcare", "The creator economy") is not a business.
- Every extracted idea from a source traces to something the source says: its problem, its customer, its numbers and its conditions intact. A view the source reports in order to reject it is never turned into a business it endorses, and no market size, price, growth rate or statistic appears that the input did not give.
- Every idea is specific to this input: it names the customer and the mechanism that make it this input's opportunity, so it would not fit most other inputs on the subject ("Interaction checking licensed to school nurses", never "A platform that helps healthcare workers").
- The extracted list is complete for a source: every distinct business it holds or directly opens up is there, up to 40, the strongest first. Its length follows the input, from two or three for a paragraph to dozens for a long talk, never padded with ideas the input does not support.
- The elaborated list takes the strongest ten extracted ideas (all of them when fewer than ten exist), each pivoted into an adjacent business: a different customer, channel, product form or business model built on the same insight, never the extracted idea reworded. Each names a differentiator that is concrete and specific to that pivot (an existing asset, a cost others carry, an overlooked buyer), and names the extracted idea it pivots from. No two pivot from the same idea.
- No two items in a list state the same idea in different words, and no two items in a list open on the same first two words.
- The words are plain and exact: what is sold and to whom in ordinary words, no startup jargon ("leverage synergies", "disrupt the space", "AI-powered platform"), no hedging, no hype.
- Input that holds no business at all (a packing list, a log, a recipe card with no context) gets the one `None found:` line saying what the input is instead.
- `bun skills/Fabric/Tools/BusinessIdeasCheck.ts` passed on the exact output before it was delivered, with `--extracted` or `--elaborated` set whenever the request named a count. Where no shell is available, the shape and counts are checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never narration in place of the idea ("The author suggests a business that…", "This article describes…").
- Never an invented fact: a market size, revenue figure, customer count or statistic the input did not supply, or a claim the source does not make.
- Never a source read from its title, its opening, or a fetched page summary instead of its full text.
- Never a generic idea that would fit any input ("An app that connects buyers and sellers", "A consulting service for businesses"), and never a bare trend listed as a business.
- Never an elaborated idea that is its extracted idea with a few words changed, or a differentiator that is a boast with no mechanism ("best-in-class experience", "innovative technology").
- Never a request that is not a business-idea job (what this pattern does, how it differs from extracting ideas) turned into idea lists; it is answered directly.
- No preamble, persona, warnings, caveats, sub-items, bold, italic or commentary outside the two sections.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-businessideas — code checks on the two headings, numbered items, the `Differentiator:` and `Pivot from #k.` shape, and the none line; judged checks on businesses stated as what is sold to whom, faithfulness to the source, no invented numbers, real pivots with concrete edges, specificity and the topic read.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: pasted text, a URL, a YouTube link, a file path, a bare topic, market or trend, a question, or "this"/nothing for the current conversation. A URL or video is read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- An optional hint: a count of extracted or elaborated ideas, a kind of business (B2B, solo, low capital), or a part of the source.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/BusinessIdeasCheck.ts <file|-> [--extracted N] [--elaborated N] [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| (any business-ideas output) | `<file>` or `-` | Check the saved draft or stdin |
| "give me 20 business ideas from this" | `--extracted N` | Require exactly N extracted ideas |
| "elaborate only the top 5" | `--elaborated N` | Require exactly N elaborated ideas instead of min(10, extracted) |
| (piping the result to another tool) | `--json` | Print `{ok, none, extracted, elaborated, problems}` |

## Output format

```markdown
## Extracted Ideas

1. {one sentence: what is sold, to whom, and the problem it solves, 6 to 30 words}
2. {the next business, opening on different words}

## Elaborated Ideas

1. {the adjacent business: what is sold and to whom} Differentiator: {the concrete edge}. Pivot from #{k}.
2. {the next pivot, from a different extracted idea} Differentiator: {its edge}. Pivot from #{k}.
```

- Both lists are numbered from 1, one item per line, no blank lines needed between items and no sub-items.
- Each elaborated item is 12 to 60 words before its tag, carries `Differentiator:` exactly once, and ends on `Pivot from #k.` naming the extracted idea's number.
- Input with no business is `## Extracted Ideas` and the single line `None found: {at most 30 words on what the input is instead}`, with no elaborated section.
- Nothing else: no other heading, no summary line, no bold or italic.

## References

- Upstream: `Patterns/extract_business_ideas/system.md` (a persona "extremely interested" in industry-overhauling ideas, told to take a deep breath and think step by step, then output EXTRACTED_IDEAS of up to 40 and ELABORATED_IDEAS of the best 10 pivoted into an adjacent idea with a differentiator, as numbered Markdown lists with no repeats, no shared openings and no warnings).
- `Tools/BusinessIdeasCheck.help.md`: the checker's rules and exit codes.
- Neighbors: `Intents/ExtractIdeas.md` when the request wants every idea a source holds rather than the businesses in it; a sales or offer-design skill, when one is installed, for shaping an offer around a business already chosen.
