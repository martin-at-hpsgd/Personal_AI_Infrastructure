# AnalyzeProse

A graded read of a piece of writing: by default its novelty, clarity and prose on fixed letter scales with the fixes that would raise each grade, or, when the request asks for Pinker, a Sense of Style critique with scored qualities, the pitfalls it commits, quoted examples, spelling and grammar fixes, rewrites and a score out of 100.

Our ideal-state port of Fabric's `analyze_prose` and `analyze_prose_pinker`. The upstream patterns stay in `Patterns/` for reference; this intent replaces them whenever a request asks for either, so the old prompts never run.

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

## Ideal State

- The analysis delivers what the principal wants from this input, inferred before writing and never asked for. A pasted text, a URL, a YouTube link or a file means a verdict on that exact writing, with every finding pointed to in its words (a YouTube transcript is judged as spoken prose, and its transcription errors are never charged to the speaker). A bare named text ("Orwell's Politics and the English Language", a famous speech) means that text as it is publicly worded, with the version analyzed named in a `**Source:**` line. A bare genre or form ("corporate layoff announcements", "academic abstracts") means the prose that genre typically produces, with `**Source:**` naming it as a composite and its example phrases presented as typical, never as quoted from one real text. A question about a text ("is this too hedgy?", "why does this read flat?") gets the full analysis with its direct answer in an `**Answer:**` line under the title. "This" or nothing means the draft under discussion in the conversation, often the principal's own writing he wants to sharpen, so every fix is a rewrite he could paste. A typed hint ("just clarity", "only the grammar") overrides the default and narrows the output to the sections it names, in the same format and order.
- The request's wording picks the mode, and ratings mode is the default. A request naming Pinker, The Sense of Style, classic style or `analyze_prose_pinker` gets Pinker mode; every other request (`analyze_prose`, "rate this writing", "how good is this essay", "grade my prose") gets ratings mode.
- In ratings mode, Novelty, Clarity and Prose each carry one grade from its fixed scale (the letter and its label, as in § Output format) and a reason specific to this text. Novelty is judged on the ideas, and any one of the A-tier moves earns an A: a new idea, a new model or framework for doing something, clear recommendations built on such a model, a useful new link between existing ideas, a new explanation of a known phenomenon, or a well-supported vision or prediction. Novelty is measured against what the field already says, never against what a lay reader might not know. Clarity is graded on whether the argument stays on its problem and solution; Prose on whether the language is fresh and free of cliché. Clarity and Prose each quote the passage that earned the grade.
- In ratings mode, Recommendations give at least one fix for every grade below A, each opening on the grade it raises, at most 30 words, quoting the passage it changes, with any replacement wording after `→`. The Overall rating is the single letter of the lowest of the three grades.
- In Pinker mode, Style analysis says which of Pinker's styles the prose is written in (classic, practical, self-conscious, postmodern, academic, legal) and which it should be written in for its purpose and reader, in 3 to 5 bullets (2 for a text under 150 words).
- In Pinker mode, Positive assessment scores each of the ten qualities from 1 to 10 with a reason tied to the text, and its `**Weighted:**` line is their mean weighted by importance (Clarity 10, Brevity 8, Elegance 7, Coherence 9, Directness 8, Vividness 7, Honesty 9, Variety 6, Precision 9, Consistency 7), to one decimal.
- In Pinker mode, Critical assessment lists every pitfall from Pinker's list (§ Output format) that the prose actually commits, each with an avoidance score from 1 to 9 (10 would be clean, and a clean pitfall is not listed) and a quoted instance, and names the notable pitfalls it avoids on one `**Avoided:**` line.
- In Pinker mode, Examples quote 3 to 5 passages that work and 3 to 5 that do not (at least one of each for a text under 150 words), each explained by the Pinker principle it shows. Spelling and grammar lists every error, not a sample, each quoted with its fix, or says `None found.` Improvement recommendations give 5 to 10 rewrites (2 or more for a text under 150 words), each quoting the passage and giving the better version. Scoring starts at 100, lists each deduction with its reason, gives a final score equal to 100 minus the deductions, and closes on a 2 to 3 sentence verdict of at most 200 words.
- Every rewrite keeps what the passage says and is plainer or shorter. When the passage lacks a fact the reader needs (a date, a contact), the recommendation names the gap in words; it never invents the fact or leaves a bracketed placeholder in the rewrite.
- Every finding is specific to this text: a reason, pitfall or rewrite that would read as true of most other writing fails. When the writing is strong, the grades and scores say so; when it has no spelling errors or commits few pitfalls, the output says that rather than inventing more.
- When a text was supplied, every quotation from it appears in it word for word. Suggested wording is either a rewrite after `→` or a short word or phrase ("use", "you"), never a sentence presented as if the text said it.
- The words are plain and exact, and the whole output fits the budget `Tools/AnalyzeProseCheck.ts` sets from the mode and the text's length (about 500 words for a ratings analysis and 1500 for a Pinker one).
- Sources are read in full before any grade is given (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- `bun skills/Fabric/Tools/AnalyzeProseCheck.ts` passed on the exact output before it was delivered, with `--source` pointing at the supplied text whenever there was one. Where no shell is available, the sections, grades, arithmetic and quotations are checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a quotation that does not appear in the supplied text, and never a named text quoted from memory with wording that is not its own.
- Never a grade label off its dimension's scale, an Overall rating above the lowest grade, a weighted score or final score that does not follow from the numbers above it, or a deduction with no reason.
- Never generic feedback ("vary your sentence length", "be more concise", "add more examples", "uses some passive voice") without the passage it applies to and the rewrite.
- Never a manufactured error, pitfall or weakness to fill a section, and never a grade inflated or deflated to look balanced.
- Never a verdict on whether the writer's position is right; novelty is about whether the ideas are new, and Honesty is about distortion, never agreement.
- Never a mode the wording did not ask for: Pinker sections in a plain `analyze_prose` request, or letter grades in place of the Pinker critique.
- Never a source graded from its title or a fetched page summary instead of its full text.
- No preamble, complaints about the input, notes on method or commentary outside the sections.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-analyzeprose — code checks on the title of each mode, the sections in order, the grade labels, the Source and Answer lines and the scoring lines; judged checks on grades earned by the text, quoted and specific findings, overall rating as the lowest grade, arithmetic that adds up, real spelling errors caught, and rewrites that improve the passage.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The writing: pasted, a URL, a YouTube link, a file path, a bare named text, a bare genre or form, a question about a text, or "this"/nothing for the draft under discussion.
- The mode, read from the request's wording: Pinker when it names Pinker, The Sense of Style, classic style or `analyze_prose_pinker`; ratings otherwise.
- An optional hint narrowing the analysis to named sections.

## Tool contract

Run from `~/.claude`. Save the draft (and the supplied text, when there is one), check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/AnalyzeProseCheck.ts <file|-> [--mode ratings|pinker] [--source <text-file>] [--max-words N] [--sections <list>] [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| (any analysis) | `<file>` or `-` | Check the saved draft or stdin; the mode is read from the title |
| (a text was supplied) | `--source <text-file>` | Every quotation must appear in that text, and the minimum counts and word budget follow its length |
| "Pinker", "Sense of Style", `analyze_prose_pinker` | `--mode pinker` | Expect the Pinker title and sections |
| `analyze_prose`, "rate this writing" | `--mode ratings` | Expect the ratings title and sections |
| "just clarity", "only the grammar" | `--sections clarity` / `--sections spelling` | Expect only the named sections, in canonical order |
| (piping the result to another tool) | `--json` | Print `{ok, mode, sections, words, budget, problems}` |

## Output format

`**Source:**` appears only when no text was supplied; `**Answer:**` only when the request asked a question. A hint-narrowed analysis keeps the title and only the sections the hint names, in the order below.

### Ratings mode (default)

The scales, best to worst:

| Dimension | A | B | C | D | F |
|---|---|---|---|---|---|
| Novelty | Novel | Fresh | Incremental | Derivative | Stale |
| Clarity | Crystal | Clean | Kludgy | Confusing | Chaotic |
| Prose | Inspired | Distinctive | Standard | Stale | Weak |

```markdown
# Prose Analysis: {what the text is, in a few words}

**Source:** {the version analyzed, or "Composite of {the genre's typical texts}"}

**Answer:** {the direct answer to the question asked}

## Novelty

**Rating:** {letter} - {label}

{why, naming the ideas}

## Clarity

**Rating:** {letter} - {label}

{why, quoting the passage}

## Prose

**Rating:** {letter} - {label}

{why, quoting the passage}

## Recommendations

- **{Novelty|Clarity|Prose}:** {the fix, quoting the passage, at most 30 words} → {replacement wording, when there is one}

## Overall rating

{the lowest letter}
```

### Pinker mode

Pinker's pitfalls: Metadiscourse, Verbal hedge, Nominalization, Passive voice, Jargon and technical terms, Clichés, False fronts, Overuse of adverbs, Zombie nouns, Complex sentences, Euphemism, Out-of-context quotations, Excessive precaution, Overgeneralization, Mixed metaphors, Tautology, Obfuscation, Redundancy, Provincialism, Archaism, Euphuism, Officialese, Gobbledygook, Bafflegab, Mangled idioms.

```markdown
# Sense of Style: {what the text is, in a few words}

## Style analysis

- {the style it is written in, the style it should be, and why}

## Positive assessment

- **Clarity:** {N}/10 — {reason}
- … one bullet each for Brevity, Elegance, Coherence, Directness, Vividness, Honesty, Variety, Precision, Consistency

**Weighted:** {X.X}/10

## Critical assessment

Scores are how well the prose avoids each pitfall; 10 is clean.

- **{Pitfall}:** {N}/10 — "{exact quotation}" {why it is that pitfall}

**Avoided:** {pitfalls it avoids worth naming}

## Examples

- **Good:** "{exact quotation}" {the principle it shows}
- **Bad:** "{exact quotation}" {the principle it breaks}

## Spelling and grammar

- "{the sentence or phrase with the error}" → {the fix}

## Improvement recommendations

- "{exact quotation}" → {the rewrite}

## Scoring

Starting score: 100

Deductions:

- −{N} for {reason}

Final score: {100 minus the deductions}

{2 to 3 sentence verdict}
```

## References

- Upstream: `Patterns/analyze_prose/system.md` (novelty, clarity and prose on fixed letter scales, short recommendations, overall rating as the lowest grade).
- Upstream: `Patterns/analyze_prose_pinker/system.md` (Pinker's styles, ten weighted qualities and pitfall list, examples, spelling and grammar, recommendations and a 100-point score).
- `Tools/AnalyzeProseCheck.help.md`: the checker's rules and exit codes.
