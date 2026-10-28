# SummarizeDebate

A short map of a debate or disagreement: who is arguing about what, the one question they actually split on, each side's arguments, the evidence that would change each side's mind, what the sides conceded or agreed on, how well each side argued, who is more likely right, and what to watch to find out.

Our ideal-state port of Fabric's `summarize_debate`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

## Ideal State

- The summary delivers what the principal wants from this input, inferred before writing and never asked for. A pasted transcript, exchange or file means the debate in it, read in full, with the sides named as the source names them. A URL or YouTube link means the debate on that page or in that video, read in full from its full text or transcript, with a `Source:` line naming the title, outlet or channel, and date. A bare topic ("nuclear power", "the minimum wage debate") means the live public debate on it between its leading positions, each side named by its position and, where they exist, its best-known proponents, with the Summary saying it maps the public debate rather than one exchange. A bare question ("should cities ban right turn on red?") means the debate over that question, with the Prediction answering it. "This" or nothing means the disagreement under discussion in the conversation, with the sides named as they appear there. A source with no disagreement in it (a recipe, a one-sided announcement that rebuts nobody) means one `Not a debate:` line saying what it is instead. A typed hint ("just the arguments", "focus on what would change their minds", "the Smith side only") narrows the output to what it names, and a hint naming the sides sets them.
- The Summary is one sentence of at most 25 words saying who is debating, what about, and where (the show, venue or format), or that it is the public debate on a topic.
- The Primary disagreement is one sentence of at most 24 words stating the single question the sides split on, phrased so each side would agree that is the question. It is the crux beneath the talking points: where the sides agree on facts and split on values, or agree on goals and split on a factual prediction, it says which.
- There is one arguments section and one mind-changing section per side, two to four sides, in the same order. A side is a position, so speakers who argue the same way are one side named by all of them. Each arguments section holds up to ten bullets of at most 15 words, each an argument that side actually made (or, for a bare topic, an argument that position's advocates actually make), in its strongest honest form, under the side that made it.
- Every claim is carried at the strength its speaker gave it. A hedge stays a hedge, a reply is recorded as what it said rather than as more agreement or more defiance than it showed, and evidence a side cited is described as covering and proving only what the source says it covers and proves: a proxy measure stays a proxy, a passing test shows what that test checks, and a figure keeps the scope the speaker gave it.
- Each mind-changing section lists, first, every condition the side stated would change its mind, each ending `(stated)`. After those come at most three inferred items, each ending `(inferred)`: a concrete finding (a measurement, a result, an event, a demonstration) that would cut against a reason the side actually gave, aimed at the crux of its case. A finding that would support the side's current position never belongs in its list, and an inferred item stays a hypothetical test, never written as an acceptance criterion the side agreed to or a fact about what exists. Each item is at most 15 words; a side with no stated conditions and too little reasoning to infer from gets one inferred item, not ten.
- The Common ground section, after the mind-changing sections, records up to five things the debate settled between the sides: each concession a speaker made (naming who granted what to whom), each fact or goal both sides accepted, and each conditional compromise in the exact form it was offered ("would accept X if Y"). Each bullet is at most 20 words and names who conceded or agreed. Nothing is listed that a speaker did not grant, and a concession is never inflated into agreement on the crux. For a bare topic or question, it holds what the leading positions broadly accept. When the sides conceded and agreed on nothing, the section is the single line `None stated.`
- The Argument strength section rates each side's case as argued here from 1 to 10, with a reason naming its strongest and its weakest point, then names a winner or a draw with the reason and how wide the margin is. The rating judges the reasoning and evidence offered in this debate, not who is right about the subject. When the crux turns on facts neither side established, or the exchange is too short to test either case, the ratings sit close and the Winner is a draw or a narrow call that says what it rests on.
- The Prediction, in at most three sentences, says which side is more likely to prove right on the underlying question, how confident that call is, and why. It may differ from the debate's winner, and when it does it says so. For a bare topic or question it draws on what is known about the subject: outside facts are ones an expert would sign, stated plainly. For a pasted exchange, file, URL or conversation, it reasons from the evidence in the debate plus only broad, uncontested background, never a statistic, study, date, schedule or claim about the speakers' situation that the source does not contain. When the deciding evidence is missing, it names the open question the call hinges on and keeps the confidence low.
- The Follow-up opens with one sentence on where the debate leaves the question, including any conditional compromise still on the table, then up to five bullets, each a specific, observable development (a study result, a ruling, a number crossing a line, an event the source mentions) and which side it would favor. A bullet uses only dates, deadlines and plans the source gives or the public record holds.
- Every line is specific to this debate: it would read wrong pasted under a different one. Words are plain and exact, the vocabulary a sharp, fair moderator would use, with no item in a list opening on the same words as another (Common ground bullets, which may open on the speaker who conceded, excepted).
- When the input is a URL or text of 200 or more characters, the harvest skill ran on the same input in the background as the summarize family's side effect (`Intents/ExecutePattern.md` § Tool contract, Trigger), and its result block follows the summary. Where harvest is not installed or cannot run, it is skipped without comment.
- `bun skills/Fabric/Tools/SummarizeDebateCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the sections, counts and word limits are checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never an argument filed under the side that did not make it, and never an argument, quote, figure or stated position the source does not contain.
- Never a debate summarized from its title, description or a fetched page summary instead of its full text or transcript.
- Never generic mind-changing evidence ("more data", "better studies", "a convincing argument") that is not tied to the side's own reasons, never an inferred item marked `(stated)` or left unmarked, and never evidence listed under a side that would confirm its own position.
- Never a speaker's claim, reply or cited evidence made stronger, broader or more agreeable than the source shows, and never a concession left out of Common ground or credited to the wrong speaker.
- Never a statistic, study result, date, schedule or claim about the participants' situation that the source does not contain, written into a summary of a pasted exchange, file, URL or conversation, the Prediction and Follow-up included.
- Never a side's arguments weakened into a straw man, or one side given fuller, stronger phrasing than the other because the summary agrees with it.
- Never the strength ratings or the winner decided by which side is right about the subject rather than by how well each argued here.
- Never a filled-in summary for input that holds no disagreement, and never invented names for unnamed speakers (an unnamed speaker is named by the source's own label or by the position).
- No preamble, caveats, notes or commentary outside the sections, no numbered lists, and no bold or italics.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-summarizedebate — code checks on the sections, the paired side sections, the stated and inferred tags, word limits and the rating lines; judged checks on fidelity to each side at the strength it argued, the crux, specific mind-changing evidence aimed against each side's reasons, concessions and conditional compromises in Common ground, no invented outside facts for a pasted exchange, rating independent of the verdict, and the inferred read for topics, questions and non-debates.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The debate: a pasted transcript or exchange, a file path, a URL, a YouTube link, a bare topic, a question, or "this"/nothing for the conversation's disagreement. A URL or video is read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube transcripts and URLs).
- An optional hint naming the sides or narrowing what is wanted.

## Tool contract

Run from `~/.claude`. Save the draft (without the harvest block), check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/SummarizeDebateCheck.ts <file|-> [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| (any full summary or a not-a-debate line) | `<file>` or `-` | Check the saved draft or stdin |
| (piping the result to another tool) | `--json` | Print `{ok, notDebate, sides, problems}` |

A hint-narrowed output (only some sections asked for) skips the check, since its shape is the hint's. The harvest side effect, its input-type gate and its result block follow `Intents/ExecutePattern.md` § Tool contract and § Output format.

## Output format

`Source:` appears only when the debate was fetched from a URL or video. Side names are exactly the same in every section that carries them, and the mind-changing sections follow the arguments sections in the same side order.

```markdown
Source: {title, outlet or channel, date}

## Summary

{one sentence, at most 25 words}

## Primary disagreement

{one sentence, at most 24 words}

## {Side A}'s arguments

- {at most 15 words}

## {Side B}'s arguments

- {at most 15 words}

## What would change {Side A}'s mind

- {a condition Side A stated, at most 15 words} (stated)
- {a finding that cuts against one of Side A's reasons, at most 15 words} (inferred)

## What would change {Side B}'s mind

- {at most 15 words} (inferred)

## Common ground

- {who conceded or agreed, and what, at most 20 words}

## Argument strength

- {Side A}: {1-10}/10. {strongest and weakest point}
- {Side B}: {1-10}/10. {strongest and weakest point}
- Winner: {Side A, Side B or Draw}. {why, and how wide the margin is}

## Prediction

{which side is more likely right on the question, how confident, and why}

## Follow-up

{one sentence on where the debate leaves the question}

- {an observable development and which side it would favor}
```

Common ground with nothing conceded or agreed is the single line `None stated.` Input with no disagreement is the single line `Not a debate: {what it is instead}`.

## References

- Upstream: `Patterns/summarize_debate/system.md` (a 25-word summary, a 24-word primary argument, up to ten 15-word bullets of arguments and of mind-changing evidence for each of two parties, a 1-10 strength analysis with a winner, a conclusion prediction, and a summary with what to look for; plain Markdown bullets with no bold or italics). Its party labels are crossed in places ("arguments made by the second party" under the first party's heading); this port files each side's material under that side. The port adds a Common ground section and the stated/inferred tags, which upstream lacks, so concessions survive and guessed mind-changers are never read as stated ones.
- `Tools/SummarizeDebateCheck.help.md`: the checker's rules and exit codes.
