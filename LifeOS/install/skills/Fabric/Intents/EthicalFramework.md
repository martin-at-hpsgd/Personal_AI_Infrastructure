# EthicalFramework

The ethics a prescriptive text carries without saying so: who counts, what counts as harm and consent, who holds authority and when it may use force, all made explicit, checked for consistency, and tested against the floor of creating no unwilling victims.

Our ideal-state port of Fabric's `extract_ethical_framework`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

## Ideal State

- The analysis delivers what the principal wants from this input, inferred before writing and never asked for. A pasted policy, terms of service, AI system description, manifesto, proposal or argument, a URL, or a file means the framework of that exact text, with every finding traced to its words. A bare named document ("Asimov's Three Laws", "a named company's usage policy") means that document as it is publicly worded, with the version analyzed named in a `**Source:**` line. A bare topic or practice ("content moderation", "school dress codes") means the framework shared by the prevailing rules on it, with `**Source:**` naming it as a composite of the rules it draws on. A question about a text ("is this coherent?", "does this create victims?") gets the full analysis with its direct answer in an `**Answer:**` line under Document analyzed. "This" or nothing means the rules, draft or proposal under discussion in the conversation. A text that prescribes nothing and takes no stance on how anyone should act (a weather report, a data table, a recipe) means the single line `**No prescriptive content:**` saying what the text is instead. A typed hint ("just the coercion points", "focus on consent") overrides the default and narrows the output to the sections it names, in the same format.
- Explicit claims are only what the text states, each quoted exactly from it. When a text was supplied, every quotation appears in it word for word. The implicit framework holds what the text assumes without stating, and each implicit finding names the clause or omission that implies it, so a reader can check the inference against the text.
- The six parts of the implicit framework answer their questions for this text specifically: who counts as a moral patient and who is left out, what counts as harm and whether it is drawn narrowly (body, property, freedom) or broadly (offense, discomfort), how consent is obtained and when it can be overridden, who holds authority and on what basis and whether it can be challenged, when force is permitted, and which value wins when values conflict. Each part would read wrong if pasted under a different text.
- The minimal-ethics test is applied evenly. A rule that restrains someone in order to protect an identified, unwilling party is recorded as coercion with a victim identified, and is never counted as a violation. The violations named are force or penalty against people who created no victim: penalties on people who did nothing ("collective punishment"), overrides of a person's own choices for their own good, penalties for conduct that harms no one, and consent the person could not refuse in any real sense.
- The internal consistency verdicts and the contradictions found are real and specific: a contradiction quotes or names the two clauses that conflict, and an exception that swallows its rule names both the rule and the exception. When nothing conflicts, the output says `None found` rather than inventing a tension.
- Every verdict uses the fixed values in Output format and carries its reason, and an `Unclear` verdict says what the text would need to state to settle it. The overall assessment follows from the findings above it: a framework with a contradiction is not rated highly coherent, and one with an unjustified coercion point is not rated compliant.
- Key concerns run from most severe to least, and every recommendation names the clause it changes and what it should say instead, specific enough to adopt as written. When there is nothing to change, the sections say so.
- The analysis extracts the text's ethics and judges it only against the stated floor. It never grades the text against the analyst's own politics or values.
- Words are plain and exact: "the company can change the terms without notice" over "unilateral modification rights", with ethics vocabulary used only where it is the precise word.
- Sources are read in full before any analysis (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- `bun skills/Fabric/Tools/EthicalFrameworkCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the sections, verdict values and table are checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a quotation that does not appear in the supplied text, never one altered to fit the sentence around it (a changed inflection such as "break" for "breaks" is a misquote; paraphrase outside the quotation marks instead), and never a named document quoted from memory with wording that is not its own.
- Never a protection of an identified victim labeled as hidden coercion or a minimal-ethics violation.
- Never a generic finding that would fit any policy ("authority is centralized", "harm is broadly defined") without the clause that shows it.
- Never a manufactured concern, contradiction or recommendation to fill a section that has nothing in it.
- Never an assessment that contradicts the findings above it.
- Never a filled-in analysis of a text that prescribes nothing.
- Never a source analyzed from its title or a fetched page summary instead of its full text.
- No preamble, caveats or commentary outside the analysis.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-ethicalframework — code checks on the sections, verdict values, coercion table and the no-prescriptive-content line; judged checks on quotes faithful to the text, protections kept apart from violations, specific contradictions, and an assessment that follows from the findings.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The text: pasted, a URL, a YouTube link, a file path, a bare named document, a bare topic or practice, a question about a text, or "this"/nothing for the conversation's subject.
- An optional hint narrowing the analysis to named sections.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/EthicalFrameworkCheck.ts <file|-> [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| (any full analysis) | `<file>` or `-` | Check the saved draft or stdin |
| (piping the result to another tool) | `--json` | Print `{ok, noPrescriptive, problems}` |

A hint-narrowed analysis (only some sections asked for) skips the check, since its shape is the hint's.

## Output format

`**Source:**` appears only when no text was supplied; `**Answer:**` only when the request asked a question. Without a `**Source:**` line, every explicit claim opens with its exact quotation.

```markdown
## Document analyzed

{Type of text}: {what it is, who it binds, and what it governs, in one or two sentences}

**Source:** {the version analyzed, or "Composite of {the rules it draws on}"}

**Answer:** {the direct answer to the question asked}

## Explicit ethical claims

- "{exact quotation}": {the principle or rule it states}

## Implicit ethical framework

### Moral patients

{who is protected, who is left out, any ranking of moral status, each tied to its clause}

### Harm

{what counts as harm, narrow or broad, and any harm with no identifiable victim}

### Consent

{how consent is obtained, whether it is implied, and when it can be overridden}

### Authority

{who makes and enforces the rules, on what basis, and whether it can be challenged}

### Coercion

{when force or penalty is permitted, victimless offenses, collective punishment}

### Value hierarchy

{which value wins when values conflict, from the clause that settles it}

## Internal consistency

- **Principles compatible:** {Holds | Fails}: {reason}
- **Exceptions contained:** {Holds | Fails}: {reason}
- **Applies to itself:** {Holds | Fails}: {reason}
- **Terms used consistently:** {Holds | Fails}: {reason}

**Contradictions:** {each conflicting pair of clauses, or None found}

## Minimal ethics evaluation

- **Unwilling victims:** {Yes | No | Unclear}: {who and how}
- **Harm conflated with discomfort:** {Yes | No | Unclear}: {reason}
- **Falsifiable:** {Yes | Partially | No}: {reason}
- **Challengeable by those bound:** {Yes | Limited | No}: {reason}
- **Authority beyond what it can justify:** {Yes | No}: {reason}

## Hidden coercion

| Coercion point | Justification given | Victim identified |
|---|---|---|
| {the action forced or penalized} | {the reason the text gives} | {Yes | No} |

## Overall assessment

- **Framework type:** {Consequentialist | Deontological | Virtue-based | Rights-based | Authority-based | Mixed (the types it mixes)}
- **Coherence:** {Highly coherent | Mostly coherent | Contains tensions | Internally contradictory}
- **Minimal ethics compliance:** {Compliant | Mostly compliant | Significant violations | Fundamentally incompatible}

## Key concerns

1. {most severe first, naming the clause}

## Recommendations

- {the clause, and what it should say instead}
```

The Hidden coercion table has one row per point where the text authorizes force or penalty: `Yes` marks a point that protects an identified, unwilling party, and `No` marks a point that falls on people who created no victim. A Hidden coercion section with no coercion point is the single line `None found.` in place of the table; Key concerns with none is `None found.`, and Recommendations with nothing to change is `None needed.`. A text that prescribes nothing is the single line `**No prescriptive content:** {what the text is instead}`.

## References

- Upstream: `Patterns/extract_ethical_framework/system.md` (the implicit-ethics extraction with a consistency checklist, the no-unwilling-victims evaluation from the Ultimate Law framework, a hidden-coercion table, and an overall rating).
- `Tools/EthicalFrameworkCheck.help.md`: the checker's rules and exit codes.
