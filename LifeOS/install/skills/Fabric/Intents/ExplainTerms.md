# ExplainTerms

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

A glossary of the terms a reader needs to understand a piece of content or a topic, each with what it means here, an analogy that maps how it works, and why it matters to this content.

Our ideal-state port of Fabric's `explain_terms`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The glossary delivers what the principal wants from this input, inferred before a word is written and never asked for. A pasted artifact (an article, paper, transcript, contract, design doc, thread), a URL, a YouTube link or a file means the specialized terms that content uses which a sharp reader from outside its field would need explained to follow it, read in full. A bare topic ("options trading", "zero-knowledge proofs") means the core vocabulary a newcomer needs to follow serious discussion of it: the eight to fifteen terms an expert would teach first, not every term the field has. A question about one term ("what is a Merkle tree?") means that term's entry first, defined in everyday words so it stands on its own, followed only by the few terms a reader would need next to go deeper. A question about a field ("what do I need to know to read a term sheet?") means the terms that answer it. "This" or nothing means the specialized terms used in the current conversation, mine included. Input with no term worth explaining (a grocery note, a casual message) means the one `**No terms to explain:**` line. A typed hint overrides the default read: a reader ("for a beginner", "I'm a lawyer") sets the level, a scope ("only the finance terms") narrows the list, and a count ("the 3 hardest terms") sets its length.
- The heading names the read that was inferred ("Terms in the checkout postmortem", "Core terms: options trading", "Terms for reading a term sheet"), so a wrong read is visible at a glance.
- Every entry is a term the reader needs and would not already know. Everyday vocabulary of an educated adult is left out, and no term the content leans on is missing. For a source, every term is one the content actually uses, in any inflection, written as the field writes it; an acronym the content uses is given as `Full name (ABBR)`.
- For an essay, argument, report or analysis, the list covers every concept its central claim turns on, including an idea the content states in a phrase rather than a coined label: that entry takes the content's own wording as its term ("separating instructions from data", "telemetry the agent sends home"), so the reader gets the idea the argument rests on and the term is still one the content uses. Before writing, name the content's central claim and confirm each concept it depends on has an entry.
- When the content uses both a general term and a narrower kind of it (prompt injection and indirect prompt injection; malware and ransomware; detection and prevention), each gets its own entry, and the narrower one's definition says what sets it apart from the general one: where the attack comes from, what it targets, what it adds. A definition never gives the general term the narrower one's mechanism, or the reverse.
- Each definition is one or two sentences that an expert in the field would sign, in the sense this content uses the term ("attention" in a transformer paper is the weighting mechanism, not human focus). When the content's sense is not the common one, the definition says so. When the content uses a term wrongly, the entry gives the right meaning and says in its Why it matters how the content uses it.
- Every claim in a definition, analogy or Why it matters keeps the strength the content and the field give it. A defense that closes one path is not called a guarantee of safety, a model that separates instructions from data unreliably is not said to be unable to, and "often", "can" and "reduces" are never sharpened into "always", "will" and "eliminates".
- Each definition leans only on everyday words and on terms explained above it, so the order is the order a reader can follow: a term another definition needs comes first (the asked-about term in a one-term question still leads), and otherwise terms follow their first appearance in the content (or, for a topic, the most foundational first).
- Each analogy is a familiar thing that works the same way in the respect that matters, so its parts map onto how the term works (a coat-check ticket for an idempotency key: show the same ticket twice, get one coat). When the analogy breaks in a way that would mislead, it says where in a clause.
- Each Why it matters names what in this content depends on the term: the claim, decision, number or step a reader cannot follow without it. For a topic or question, it names what understanding the term unlocks in the field. A line that would fit any content using the term fails.
- A source is read in full before anything is written (`Intents/ExecutePattern.md` § Tool contract covers fetching URLs and YouTube links).
- The words are plain and exact: the most precise ordinary word wins over jargon, and no entry carries filler.
- `bun skills/Fabric/Tools/ExplainTermsCheck.ts` passed on the exact output before it was delivered, with `--source` set to the input whenever the input was text or a file and `--count` set to any count a hint asked for. Where no shell is available, or the check cannot run, the shape and counts are checked by hand and nothing about the check appears in the output.
- The reply is the finished glossary itself, as reader-facing markdown in the Output format, and nothing else. The check is a silent step taken with a tool, never text in the reply: the reply holds no command, heredoc, file path, saved-draft step, checker output or note about checking, and it never ends on an attempt to run something. When a check fails, the fixed glossary is delivered whole; when the check cannot run at all, the glossary is still delivered whole.

## Anti-criteria

- Never a term the content does not use, added because it is related, famous or usually taught beside the ones it does use.
- Never basic vocabulary a general reader knows ("email", "server", "budget") padded in to lengthen the list.
- Never a definition in the wrong sense for this content, a definition an expert would reject, or a figure, date or standard the input and the field do not support.
- Never a circular definition, an opening that restates the term ("Jitter is jitter added…", "the term X refers to…"), or a definition that leans on a term explained later or not at all.
- Never a decorative or misleading analogy ("like magic", "like a recipe", one that maps the mood and not the mechanism).
- Never a term explained twice, never two distinct terms merged into one entry, and never a narrower kind of a term defined as if it were the general term, or the general term as if it were the narrower kind.
- Never a concept the content's argument rests on left out because the content names it in a phrase rather than a label.
- Never a claim stated more strongly than the content and the field support: no partial defense called a guarantee, no "unreliable" turned into "impossible".
- Never a reply that shows the glossary inside a shell command, a heredoc or a file-writing step, prints checker output, or stops at an attempt to run a tool instead of delivering the glossary.
- Never a source's terms taken from its title, abstract or a fetched page summary instead of its full text.
- Never a question back to the principal about reader level or scope when the input and the defaults settle it.
- No preamble, persona, closing offer or commentary outside the heading and the entries.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-explainterms — code checks on the heading, the entry and sub-bullet shape, the requested count and the no-terms line; judged checks on terms kept to what the content uses, definitions in the content's sense, analogies that map the mechanism, Why it matters tied to the input, basic words left out, and the inferred read.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: pasted text, a URL, a YouTube link, a file path, a bare topic, a question, or "this"/nothing for the current conversation.
- An optional hint setting the reader's level, the scope or the number of terms.

## Tool contract

Run from `~/.claude`, with a shell tool, out of the reader's sight. Save the draft, check it, fix what it names, and deliver only on exit 0. None of this appears in the reply: the reply is the glossary alone. With no shell tool in the session, skip the command and check the rules in Output format by hand.

```bash
bun skills/Fabric/Tools/ExplainTermsCheck.ts <file|-> [--source <input-file>] [--count N] [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| The run has | Flag | Effect |
|---|---|---|
| (any glossary) | `<file>` or `-` | Check the saved draft or stdin |
| pasted text or a file as the input | `--source <input-file>` | Also require every term, or its abbreviation, to appear in the input |
| a count in the hint ("the 3 hardest terms", "top 5") | `--count N` | Require exactly N entries |
| a caller that wants the result as data | `--json` | Print `{ok, noTerms, heading, terms, problems}` |

## Output format

```markdown
**{the inferred read, e.g. Terms in the checkout postmortem}**

- **{Term}**: {what it means here, one or two sentences}
  - Analogy: {a familiar thing that works the same way, and how it maps}
  - Why it matters: {what in this content depends on it}
- **{Term}**: …
```

- Each entry is a top-level bullet with the term in bold, followed by exactly two sub-bullets indented two spaces, Analogy first.
- A definition holds at most two sentences and 60 words; an Analogy or Why it matters at most two sentences and 40 words.
- The term keeps its real case (`gRPC`, `p99 latency`, `Circuit breaker`), never forced to capitals.
- Input with no term worth explaining is the single line `**No terms to explain:** {what the input is instead}`.

## References

- Upstream: `Patterns/explain_terms/system.md` (a "world's best explainer" persona and six thinking steps; the full list of advanced terms, each `- TERM: definition` with `-- Analogy:` and `-- Why It Matters:` lines, uppercase terms, two-sentence definitions, and no bold or italic). Kept: the glossary, the advanced-terms-only selection, the two-sentence definition, the analogy and why-it-matters for every term, and the order a reader can follow. Changed: the `--` lines, which markdown folds into one paragraph, are now indented sub-bullets; the term is bold in its real case so a glossary scans; why-it-matters is tied to this content instead of the term's general importance.
- `Tools/ExplainTermsCheck.help.md`: the checker's rules and exit codes.
- `Intents/ExecutePattern.md` § Tool contract: fetching URLs and YouTube transcripts.
- Neighbor: `Intents/ExplainCode.md` when the input is code, configuration or tool output to be explained as a whole rather than a list of terms.
