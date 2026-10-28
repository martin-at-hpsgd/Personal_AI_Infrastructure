# AuditTransparency

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

A transparency audit of any decision, system, policy or product that affects other people: whether the people it affects can see and understand what is done to them, where it is opaque, whether that opacity is justified or serves the party holding power, and what would fix it.

Our ideal-state port of Fabric's `audit_transparency`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The audit answers what the principal actually wants from this input, inferred before a word is written and never asked for. The read follows what the input is. A pasted artifact (terms of service, a privacy notice, a contract, a policy, a product description) means how much that exact text lets the affected party see and understand, judged from what it says and what it leaves out, with its own words quoted as evidence. A URL or a file means the decision or system the document describes, read in full, with the document itself as the record of what is disclosed. A bare system or practice ("credit scoring", "automated content moderation", "a landlord's tenant-screening app") means how that kind of system typically works for the people it affects, with that assumption stated. A question ("is this hiring algorithm transparent?", "can I trust how this app sets prices?") means its answer, carried by the verdict. A decision someone is making ("we are moving performance reviews to an AI score") means the audit of that decision from the side of the people it lands on. "This" or "that" means the decision or system in the current conversation. A typed hint about whose side the asker is on overrides the default read: an affected party gets what to ask for and how to challenge it, and a decision maker ("we run the platform, how do we fix it") gets recommendations aimed at them.
- The title names what is audited and from whose side ("Transparency Audit: A Bank's Loan-Denial Model, for Applicants"), so a wrong read is visible at a glance.
- SYSTEM ANALYZED says in plain words what decision or system is audited, who makes the decisions and who is affected, and states any assumption the model made because the input did not say.
- TRANSPARENCY VERDICT comes second, so the answer leads: one of the five labels (TRANSPARENT, MOSTLY TRANSPARENT, PARTIALLY OPAQUE, SIGNIFICANTLY OPAQUE, DELIBERATELY OBSCURED) and one sentence saying why. A label that needs a qualifier carries it in the sentence ("TRANSPARENT: details are withheld only until a patch ships, which protects the affected users"). The label follows from the evidence below it: DELIBERATELY OBSCURED needs opacity the evidence shows was chosen and serves the decision maker, never mere suspicion.
- STAKEHOLDER MAP lists every party that decides, is affected or watches, with what information each can reach and how much power each holds, so the power gap the audit turns on is visible.
- TRANSPARENCY AUDIT rates all five dimensions in a fixed order (decision, algorithmic, financial, governance, data), each with evidence specific to this input. The evidence answers the dimension's core questions: for decision, whether the criteria, the process and the exceptions are visible and outcomes predictable; for algorithmic, whether the system's behavior and a single outcome can be explained in plain words and whether a right to explanation exists; for financial, whether costs, fees and revenue flows are visible and whether hidden costs exist; for governance, whether rules are visible before they take effect and whether a visible path to challenge them exists; for data, whether collection, use, sharing and retention are disclosed and whether people can see, correct or delete their data. A dimension the input says nothing about is rated Unknown with what would settle it, and one that does not apply is rated Not applicable with the reason in a few words.
- OPACITY ANALYSIS lists each specific place information is hidden, buried or made unusable, numbered, with whether it is justified, who gains from it and who pays for it. Opacity counts as justified only for a legitimate reason stated specifically: a named security threat, genuine complexity that comes with a plain summary, or the privacy of other individuals. "Too complex to explain", proprietary convenience, and privacy claimed for an institution's own decisions are not justifications, and information that is technically available but buried in legal text or a format the affected party cannot use counts as opacity.
- THE REVERSAL TEST opens on a plain Yes, No or Partly answering whether the decision maker would accept this opacity if positions were reversed, and gives the reason from this case.
- EXPLAINABILITY CHECK writes the attempt: one paragraph explaining how the decision or system works, in words the affected party would understand, then a result line saying whether it worked. When the paragraph cannot be written from what is disclosed, the attempt says exactly what is missing and the result names whether the complexity is genuine or serves opacity.
- RECOMMENDATIONS are concrete changes for this system, each saying who would do what, each ending by citing the opacity rows it fixes, and together covering every row that is not justified. They keep legitimate interests intact (security, other people's privacy, real competitive detail) and say how when that is the hard part.
- Every rating, row and recommendation is specific to this input. A line that would fit most other systems as well ("Users should be informed about how their data is used") fails.
- Facts about a real, named organization come from the input or the well-known public record, and anything the model is inferring rather than reading is marked as inferred in the same line.
- When the input is a source, the audit reflects what it actually says, read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- The words are plain and exact: the most precise ordinary word wins over legal or technical jargon, and a term a non-specialist would not know is explained in the same line or replaced.
- `bun skills/Fabric/Tools/AuditTransparencyCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the shape is checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a clarifying question in place of the audit. The model assumes and states the assumption.
- Never an invented fact (a fee, a policy clause, a data practice) attributed to a real organization or to a pasted text that does not contain it.
- Never a verdict the evidence does not carry: no DELIBERATELY OBSCURED from suspicion alone, and no TRANSPARENT over an unjustified opacity row.
- Never opacity waved through as justified on a vague reason ("security", "it's proprietary", "too complex") without the specific threat, the summary that exists, or the other people whose privacy is protected.
- Never an explainability attempt written in the jargon it is testing for, and never one that hides a gap by staying vague.
- Never a boilerplate recommendation ("be more transparent", "publish a clear policy") without saying exactly what to disclose, to whom and how.
- Never a persona, a preamble, the upstream framework's background story, or commentary outside the eight sections.
- Never asterisks for emphasis or bold.
- Never a claim about a source that the source does not support, and never a source audited from its title or a fetched page summary instead of its full text.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-audittransparency — code checks on the title, the eight sections in order and the table headers, plus judged checks on the inferred read, evidence-backed ratings, honest justification calls, a plain explainability attempt and specific recommendations.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: a pasted artifact, a URL, a YouTube link, a file path, a bare system or practice, a question, a decision being made, or "this"/"that" for the current conversation.
- An optional hint about whose side the asker is on or what they care about, which overrides the default read.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/AuditTransparencyCheck.ts <file|-> [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

## Output format

Plain Markdown with no asterisks: one H1, then exactly these eight H2 sections in this order, with nothing else in them. These are the limits the checker enforces:

- SYSTEM ANALYZED is one paragraph of 10 to 90 words.
- TRANSPARENCY VERDICT is one line: a label, a colon, and one sentence of 6 to 40 words.
- STAKEHOLDER MAP has at least two rows, with at least one Decision maker and one Affected party. Role is Decision maker, Affected or Observer; Information access is Full, Partial or None; Power is High, Medium or Low.
- TRANSPARENCY AUDIT has exactly five rows in the order Decision, Algorithmic, Financial, Governance, Data. Rating is Clear, Partial, Opaque, Unknown or Not applicable; evidence is 3 to 60 words.
- OPACITY ANALYSIS has 0 to 10 rows numbered from 1. Justified is `Yes: <reason>`, `Partly: <reason>` or `No` (a reason after `No:` is allowed). An empty table is allowed only under a TRANSPARENT verdict, and a verdict of SIGNIFICANTLY OPAQUE or DELIBERATELY OBSCURED needs at least one `No` row.
- THE REVERSAL TEST is 1 or 2 paragraphs, 15 to 120 words, opening on Yes, No or Partly.
- EXPLAINABILITY CHECK is an `Attempt:` paragraph of 25 to 120 words and a `Result:` line opening on Yes, Partially, `No — the complexity is genuine` or `No — the complexity serves opacity`.
- RECOMMENDATIONS are 1 to 8 bullets of 6 to 40 words, each ending with the opacity rows it fixes, such as `(#1, #3)`, and every `No` or `Partly` row is cited by at least one. With no opacity rows, the bullets carry no citation.

```markdown
# Transparency Audit: {what is audited, and from whose side}

## SYSTEM ANALYZED

{what is audited, who decides, who is affected, any assumption made}

## TRANSPARENCY VERDICT

{LABEL}: {one sentence saying why}

## STAKEHOLDER MAP

| Party | Role | Information access | Power |
|-------|------|--------------------|-------|
| {party} | Decision maker | Full | High |
| {party} | Affected | None | Low |

## TRANSPARENCY AUDIT

| Dimension | Rating | Evidence |
|-----------|--------|----------|
| Decision | Partial | {specific evidence} |
| Algorithmic | Opaque | {specific evidence} |
| Financial | Not applicable | {why it does not apply} |
| Governance | Clear | {specific evidence} |
| Data | Unknown | {what would settle it} |

## OPACITY ANALYSIS

| # | Opacity | Justified? | Who benefits | Who is harmed |
|---|---------|------------|--------------|---------------|
| 1 | {a specific thing hidden or buried} | No | {party} | {party} |
| 2 | … | Yes: {the specific reason} | {party} | {party} |

## THE REVERSAL TEST

{Yes, No or Partly, then the reason from this case}

## EXPLAINABILITY CHECK

Attempt: {one paragraph a non-expert affected party would understand}

Result: {Yes | Partially | No — the complexity is genuine | No — the complexity serves opacity}

## RECOMMENDATIONS

- {who does what, specifically} (#1)
```

## References

- Upstream: `Patterns/audit_transparency/system.md` (an auditor persona, the framework's background story, eight numbered steps, and the same sections with the verdict near the end and bold yes/no fields per dimension).
- `Tools/AuditTransparencyCheck.help.md`: the checker's rules and exit codes.
