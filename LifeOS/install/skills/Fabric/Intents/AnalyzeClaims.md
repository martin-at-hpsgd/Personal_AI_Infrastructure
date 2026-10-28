# AnalyzeClaims

A claim-by-claim truth check of an argument: each factual claim stated plainly, the real evidence for and against it, the fallacies it leans on quoted from the text, a letter grade, and an overall verdict on how far the argument should move a reader.

Our ideal-state port of Fabric's `analyze_claims`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

## Ideal State

- The analysis delivers what the principal wants from this input, inferred before writing and never asked for. A pasted artifact (an article, post, transcript, speech, ad copy), a URL, a YouTube link or a file means the claims that source makes, read in full and judged against what is actually known. A single claim typed on its own ("cracking your knuckles causes arthritis") means that one claim analyzed. A bare topic ("seed oils", "rent control") means the main claims people actually make about it, the strongest from each side, each analyzed, with the Argument summary naming what the dispute is about. A question ("does fluoride lower IQ?") means the claims that decide its answer, with the Overall analysis answering it. "This" or nothing means the claims made in the current conversation, mine included. Input that asserts nothing checkable (a poem, a recipe, a pure statement of taste) means the one `**No truth claims:**` line. A typed hint ("just the statistics", "only rate them", "the second paragraph") overrides the default read and narrows the analysis to what it names.
- Every claim the argument depends on is listed on its own, in at most 16 words, as the source states it, scope included. "Doubled productivity in every industry" is analyzed as a claim about every industry, never softened into "remote work can help productivity". Two sentences that make the same claim are one claim; one sentence that makes two checkable claims is two. A reported fact and the conclusion drawn from it are separate claims: "sign-ups rose 40% after the redesign" is one claim and "the redesign caused the rise" is another, and a recommendation the argument ends on ("so every product should copy it") is a third, each graded on its own evidence. Value judgments and statements of taste are not graded as truth claims. For a long source, the claims the argument rests on come first and passing facts that carry no weight are left out.
- Each evidence item is either something the input itself offers, marked `From the text:`, or a real external source a reader could find, named with its author or publisher and year. Evidence on both sides is the strongest that exists, not the easiest to cite. When the claim's subject cannot be checked from outside (a fictional company, a vendor's own report, a private event, an unpublished survey), the rating reason says once, plainly, that the specific figure is unverifiable and why, taking the input at its word when it says the subject is fictional rather than wondering aloud whether it exists. Outside evidence is still brought on both sides from real research on the general class the claim rests on (the technique, the product category, the intervention, the kind of study), worded as being about that class ("four-day work weeks in general …", "pitcher filters in general …") and never credited to the unverifiable subject. The outside evidence reads `None known` only when nothing real bears even on that class. Every author, publisher and year given is the right one for that finding (a famous self-experiment is dated to its publication, not to a later award), and a source whose details are uncertain is left out rather than cited with guessed details. A `From the text:` item appears only when the input actually offers that support or leaves that gap.
- The input's own evidence is weighed, not just repeated. Each `From the text:` item says what kind of evidence it is (one anecdote, a testimonial, the maker's own test, an opinion survey, an unsourced number) and how far that kind can carry the claim. What the input leaves out that the claim would need (sample size, method, who measured, a baseline, a comparison group, the time window, the denominator) is listed under refutation as a `From the text:` item naming the gap. An anecdote or a single case is never the support that settles a general claim.
- Refutation is the strongest known way the claim fails as stated, not only a contrary study. A causal claim is checked against the explanations the input does not rule out (a missing baseline or comparison group, regression to the mean, selection, confounders, timing). A claim that an action works or should be taken is checked against what the action leaves open or creates: the risk that remains, the weaker path people can still fall back to, side effects, costs, and risk moved somewhere else. The most important of these consequences reappears as the main weakness in the Overall analysis.
- Support and refutation are held to the same standard whichever side a claim favors. A claim's grade follows the evidence for the claim as stated, never its popularity, its politics, or how confidently the text asserts it.
- Each logical fallacy names the fallacy and quotes the exact words from the input that commit it. Every fallacy the claim actually leans on is listed (a sweeping conclusion from one anecdote, an inference from sequence to cause, an appeal to authority or popularity, a false choice), and a label appears only when the quoted words fit its textbook definition; a doubtful fit is left out rather than stretched. A claim that commits none says `None`.
- The grade is one letter from the fixed scale (A True, B Likely true, C Mixed, D Likely false, F False) with a one-sentence reason that names what decided it. The overall lowest, highest and average grades follow from the claim grades by the arithmetic in § Output format.
- Labels are a few plain words for the character of each claim as the text shows it (overreach, opinion-as-data, unsourced statistic, emotional appeal, cherry-picked). A political-lean label appears only when the claim plainly carries one, and is applied the same way to every side.
- The Argument summary (at most 30 words) says what the input argues. The Overall analysis (at most 40 words) names the argument's main strength and main weakness (for an argument that recommends an action, the weakness includes what acting on it would leave exposed) and says how a reader should update their view, specific to this input.
- Words are plain and exact, the way a careful fact-checker would put it to a colleague.
- `bun skills/Fabric/Tools/AnalyzeClaimsCheck.ts` passed on the exact output before it was delivered, with `--source` set to the input whenever the input was text or a file. Where no shell is available, the sections, word counts, grades and quotes are checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never an invented study, statistic, quote, author, date or URL, never a real source credited with a finding it does not report, and never a real source given the wrong year or author.
- Never a fallacy quote that is not the input's exact words.
- Never a claim weakened or strengthened from what the text states and then graded in its new form.
- Never an opinion survey, anecdote or testimonial graded as if it measured the thing it is about (a poll of managers who believe teams are more productive is evidence about belief, not productivity), and never the input's own anecdote listed as support for a general claim without saying it is one case.
- Never `None known` for outside evidence when real research on the claim's general class bears on it, and never that class research credited to the input's fictional or unverifiable subject.
- Never a doubt raised about whether a subject the input itself calls fictional exists; its fictional status is stated once and the analysis moves on.
- Never a fallacy label the quoted words do not fit, and never an evidence item that does not bear on the claim it sits under.
- Never the claims collapsed into one verdict on the whole passage.
- Never a source analyzed from its title or a fetched page summary instead of its full text.
- Never a request that is not a claims job (a question about which patterns exist, how this works, or what another tool does) turned into a claims analysis; it is answered directly.
- No preamble, persona, caveats or commentary outside the sections.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-analyzeclaims — code checks on the sections, grade letters and no-claims line; judged checks on claims kept separate and at their stated scope (a fact split from the cause drawn from it), opinion data and anecdotes told from measurement, evidence that is real or marked as the text's own, class-level evidence brought for an unverifiable subject, the input's missing method named, residual risk and side effects of a recommended action weighed, fallacy quotes taken verbatim, and the non-claims question answered directly.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: pasted text, a URL, a YouTube link, a file path, a single claim, a bare topic, a question, or "this"/nothing for the current conversation. A URL or video is read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- An optional hint narrowing the analysis.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/AnalyzeClaimsCheck.ts <file|-> [--source <input-file>] [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| (any full analysis) | `<file>` or `-` | Check the saved draft or stdin |
| (the input was pasted text or a file) | `--source <input-file>` | Also require every quoted fallacy snippet and `From the text:` quote to appear in the input |
| (piping the result to another tool) | `--json` | Print `{ok, noClaims, claims, overall, problems}` |

A hint-narrowed analysis (only some sections asked for) skips the check, since its shape is the hint's.

## Output format

```markdown
## Argument summary

{at most 30 words: what the input argues}

## Truth claims

### Claim 1: {the claim as stated, at most 16 words}

**Support evidence:**
- From the text: {what the input offers, quoted where it can be, and what kind of evidence it is}
- {finding, about this subject or its general class} ({author or publisher}, {year})

**Refutation evidence:**
- From the text: {what the input leaves out that the claim needs}
- {finding, or the way the claim fails as stated} ({author or publisher}, {year})

**Logical fallacies:**
- {Fallacy name}: "{exact words from the input}"

**Rating:** {A|B|C|D|F} ({True|Likely true|Mixed|Likely false|False}): {one sentence naming what decided it}

**Labels:** {label}, {label}

### Claim 2: …

## Overall score

- **Lowest claim score:** {letter}
- **Highest claim score:** {letter}
- **Average claim score:** {letter}

## Overall analysis

{at most 40 words: main strength, main weakness, how to update}
```

- An evidence list with nothing in it is the single bullet `- None known`. A claim with no fallacy has the single bullet `- None`.
- The letters pair with their words exactly: A True, B Likely true, C Mixed, D Likely false, F False.
- The average maps A=4, B=3, C=2, D=1, F=0, takes the mean of the claim grades, and rounds half up to the nearest letter.
- Input with no truth claims is the single line `**No truth claims:** {what the input is instead}`.

## References

- Upstream: `Patterns/analyze_claims/system.md` (argument summary, then per claim the claim, support evidence, refutation evidence, logical fallacies, an A to F rating and labels, then lowest, highest and average scores and an overall analysis).
- `Tools/AnalyzeClaimsCheck.help.md`: the checker's rules and exit codes.
- Neighbor: `Intents/LogicalFallacies.md` when the request wants fallacies alone, without grading claims.
