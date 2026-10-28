# CheckFalsifiability

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

A falsifiability audit of any claim, argument, framework, policy or source: each claim it makes, whether any observation could prove it wrong, the escape hatches and Kafka traps that keep it from being checked, how much rides on it, and the concrete test and rewrite that would make each weak claim checkable.

Our ideal-state port of Fabric's `check_falsifiability`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The audit answers what the principal actually wants from this input, inferred before a word is written and never asked for. The read follows what the input is. A pasted artifact (a pitch, a policy, a manifesto, an abstract, a safety claim) means the claims it makes, load-bearing ones first, and whether the decisions it asks for rest on testable ground. A URL or a file means the claims of the source it points at, read in full. A bare claim ("astrology predicts personality") means that claim in its strongest common form, the version its best defenders would sign. A bare topic or framework ("psychoanalysis", "effective altruism") means its central claims as its proponents state them. A question ("is string theory falsifiable?", "can 'everything happens for a reason' be tested?") means a direct answer, carried by the overall rating. "This" or "that" means the claims made in the current conversation, the assistant's own included. A typed hint ("only the second paragraph", "the safety claims", "steelman it") overrides the default read.
- The title names what was audited and the read that was inferred ("Falsifiability Check: A Vendor's Alignment Claims", "Falsifiability Check: Is String Theory Testable?"), so a wrong read is visible at a glance.
- CLAIMS IDENTIFIED lists each distinct assertion of fact, cause or prediction the input makes, one sentence each, numbered from 1, quoted verbatim where the input words it plainly and paraphrased faithfully where it does not. A statement of personal value, taste or faith is listed only when the input uses it to justify action that affects others.
- Every claim gets a verdict in FALSIFIABILITY ANALYSIS: Yes, No, Partially, or Moving goalposts. Yes names the specific observation that would prove it wrong, with the measure and threshold where one applies ("a controlled trial of the same size shows no reduction in ticket volume after 90 days"). No says plainly that nothing specified could disprove it, and why. Partially names which part is testable and which is not. Moving goalposts is used only when the input itself shows a term or prediction being redefined to absorb a counter-example, and the field quotes or names that shift.
- The verdict judges testability, never truth. A claim that has been tested and failed is falsifiable (its verdict is Yes, and the disprover may note the evidence against it); a claim the auditor finds congenial gets no softer standard than one it does not, whatever its politics or field.
- Definitional precision is rated Precise, Vague or Shifting for each claim, and Escape hatches names each one the input actually uses (a no-true-Scotsman, a retrospective redefinition, an appeal to something unmeasurable, an "it would have worked if not for X", a prediction with no timeline), or None.
- KAFKA TRAP CHECK marks each of the four traps present or absent, and every trap marked present quotes or names the line of the input that sets it. A trap is never marked on suspicion.
- The overall rating is exactly one of the five upstream levels, spelled as written here and never blended into a new one: FULLY FALSIFIABLE, MOSTLY FALSIFIABLE, PARTIALLY FALSIFIABLE, LARGELY UNFALSIFIABLE, COMPLETELY UNFALSIFIABLE. It follows from the per-claim verdicts, weighted toward the claims the input leans on most, with one sentence saying why. FULLY FALSIFIABLE means every claim is Yes; COMPLETELY UNFALSIFIABLE means none is.
- RISK ASSESSMENT says what action the claims are used to justify, who it affects, and what recourse those people have if the claims are wrong. When the claims justify nothing that affects others, it says so in one line and stops.
- PROPOSED TESTS gives, for every claim whose verdict is not Yes, a test someone could actually run on this claim, the outcome that would confirm it, the outcome that would refute it, and whether the claimant would plausibly accept that test, judged from what the input says. When every claim is Yes, the section says in one line that no test is needed beyond the disprovers above.
- RECOMMENDATIONS rewrites every claim whose verdict is not Yes as a quoted falsifiable version that keeps the claimant's meaning, and says in a few words what precision the rewrite adds. Nothing else goes in the section.
- Every line is specific to this input. A disprover, test or rewrite that would fit most other claims as well ("gather more evidence", "define terms more clearly") fails.
- When the input is a source, the audit reflects what it actually claims, read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- The words are plain and exact: the most precise ordinary word wins over philosophy-of-science jargon, and a term a non-specialist would not know is explained in the same line or replaced.
- `bun skills/Fabric/Tools/CheckFalsifiabilityCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the shape is checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a clarifying question in place of the audit. The model takes the default read and the title states it.
- Never "unfalsifiable" used to mean "false" or "I disagree", and never "falsifiable" used to mean "true".
- Never a strawman: a claim is never audited in a weaker form than its input or its best defenders state it.
- Never a Kafka trap, escape hatch or moving goalpost reported that the input does not show.
- Never a rating outside the five levels ("MOSTLY UNFALSIFIABLE" is not one), never an overall rating that contradicts the per-claim verdicts, and never a non-Yes claim left without a test and a rewrite.
- Never a generic disprover, test or recommendation that names no measure, population, timeline or observation from this claim.
- Never a lecture on falsifiability, the upstream essay restated, a persona, a preamble, or a section beyond the seven in the output format.
- Never a claim attributed to a source that the source does not make, and never a source audited from its title or a fetched page summary instead of its full text.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-checkfalsifiability — code checks on the title, the seven sections, the verdict fields and the Kafka list, plus judged checks on fair verdicts, testability over truth, traps grounded in the text, and specific tests and rewrites.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: a pasted artifact, a URL, a YouTube link, a file path, a bare claim, a bare topic or framework, a question about whether something is falsifiable, or "this"/"that" for the current conversation.
- An optional hint naming which claims to audit or how to read them, which overrides the default read.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/CheckFalsifiabilityCheck.ts <file|-> [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

## Output format

Markdown: one H1, then exactly these seven H2 sections in this order, with nothing else in them. These are the limits the checker enforces:

- CLAIMS IDENTIFIED is a numbered list of 1 to 12 claims, numbered from 1 with no gaps.
- FALSIFIABILITY ANALYSIS has one `### Claim N: "…"` block per claim, in the same order, each holding exactly the four field bullets shown. `Falsifiable` is one of Yes, No, Partially, Moving goalposts; `Definitional precision` is one of Precise, Vague, Shifting. A Yes claim's disprover is a real observation of at least five words, never "Nothing specified".
- KAFKA TRAP CHECK is exactly the four checkbox lines shown, in that order; a checked box (`[x]`) is followed by a colon and the line that sets the trap.
- OVERALL FALSIFIABILITY RATING is one line: one of FULLY FALSIFIABLE, MOSTLY FALSIFIABLE, PARTIALLY FALSIFIABLE, LARGELY UNFALSIFIABLE or COMPLETELY UNFALSIFIABLE, an em-dash or colon, and one sentence why. FULLY FALSIFIABLE requires every claim Yes; COMPLETELY UNFALSIFIABLE requires no claim Yes.
- PROPOSED TESTS has one `### Test for Claim N` block for every claim that is not Yes, each holding the four field bullets shown, or the single line `No tests needed: every claim names its own disprover above.` when every claim is Yes.
- RECOMMENDATIONS has one `- Claim N: "…"` bullet with a quoted rewrite for every claim that is not Yes, or the single line `No rewrites needed: every claim is already testable as stated.` when every claim is Yes.

```markdown
# Falsifiability Check: {what was audited, and the read inferred}

## CLAIMS IDENTIFIED

1. "{claim, one sentence}"
2. "{claim}"

## FALSIFIABILITY ANALYSIS

### Claim 1: "{the claim}"

- Falsifiable: Yes
- What would disprove it: {the specific observation, with its measure and threshold}
- Definitional precision: Precise
- Escape hatches: None

### Claim 2: "{the claim}"

- Falsifiable: No
- What would disprove it: Nothing specified; {why no observation could count against it}
- Definitional precision: Vague
- Escape hatches: {each one the input uses, named}

## KAFKA TRAP CHECK

- [ ] Denial proves guilt
- [x] Questioning proves ignorance: "{the line that sets it}"
- [ ] Only agreement is valid
- [ ] Doubt is moral failure

## OVERALL FALSIFIABILITY RATING

PARTIALLY FALSIFIABLE — {one sentence why}

## RISK ASSESSMENT

{what action the claims justify, who it affects, what recourse they have; or one line saying they justify nothing that affects others}

## PROPOSED TESTS

### Test for Claim 2

- Test: {a test someone could run on this claim}
- Confirms if: {outcome}
- Refutes if: {outcome}
- Claimant would accept: {Yes, No or Unclear, and why}

## RECOMMENDATIONS

- Claim 2: "{the claim rewritten so it can be proven wrong}" ({the precision the rewrite adds})
```

## References

- Upstream: `Patterns/check_falsifiability/system.md` (an auditor persona, a seven-step method, three framing essays on AGI safety and the Ultimate Law framework, and the seven output sections this intent keeps).
- `Tools/CheckFalsifiabilityCheck.help.md`: the checker's rules and exit codes.
