# AnalyzeRisk

A risk assessment of a third-party vendor for one intended use: a Low, Medium or High rating with its reason, the data at stake, the facts it rests on, findings on the vendor's security, privacy, terms and breach handling, the obligations that apply, the controls the people adopting it must put in place, and what would move the rating.

Our ideal-state port of Fabric's `analyze_risk`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

## Ideal State

- The assessment delivers what the principal wants from this input, inferred before writing and never asked for. A pasted artifact (a vendor's terms, a data processing agreement, a privacy policy, a security questionnaire or trust-page text, a procurement request) means an assessment of that vendor for the use the input describes, built from that text. A URL or a file means the same for what it holds, and a vendor's own site means its privacy policy, security page and terms, each read in full. A bare vendor, product or category ("an e-signature SaaS for HR offer letters") means an assessment of its typical form for that use, with a `**Source:**` line naming what the assessment draws on. A question ("can we put patient intake forms in this form builder?") gets the full assessment with its direct answer in an `**Answer:**` line. "This" or nothing means the vendor under discussion in the conversation. An input that names several vendors gets one assessment per vendor. An input with no third party to assess (a recipe, a poem, an internal memo about lunch) gets the single line `**No vendor:**` saying what the input is instead. A typed hint ("just the controls", "against HIPAA only", "for the vendor to read") overrides the default read and narrows or reshapes the output to what it names.
- The rating leads. The first line under the heading is the rating and its reason in one or two sentences, and the reason names the data at stake and the finding that decides it.
- The data line classifies what the vendor will hold or touch for this use as `Public`, `Internal`, `Confidential` or `Restricted` (regulated or highly sensitive: health, student, payment, credentials, government identifiers), and says what that data is in this case.
- The rating follows from the data and the findings. `High` means Confidential or Restricted data with a gap the vendor does not close, or a vendor that refuses the security or data terms that data requires. `Medium` means sensitive data with gaps the adopter's own controls can close, or low-sensitivity data with a real weakness. `Low` means public or low-sensitivity data, or protections that match the data. A vendor that holds up is rated `Low` without hedging, and ordinary vendor terms do not make every vendor `High`.
- Every fact the rating rests on appears under Assumptions, marked `Stated` when the input gave it and `Assumed` when it did not, so the reader can correct a wrong one.
- The findings cover data handled, security, privacy, terms and breach notice for this vendor. Each finding names its evidence: a clause quoted exactly from the supplied text, `Not stated` when the text is silent on something the use needs (silence on breach notice is itself a finding), or, for a bare topic, the public fact it relies on. Each says whether it raises, lowers or leaves the risk.
- Compliance names only the obligations that apply to this data and use (a privacy law for the jurisdiction the input gives or implies, a sector rule such as HIPAA, FERPA or PCI DSS, the adopter's own policy when the input names it), each with why it applies and whether the vendor meets it, leaves a gap, or the input cannot tell. When no obligation applies, it says so in one line with the reason. An obligation a reader would expect but this use does not bring in may be named once in a `**Ruled out:**` line with the reason, never as a table row.
- Every required control is specific to this vendor and data, names who carries it out (the implementer, the end user, or procurement negotiating a term), and names the finding it answers. Baseline hygiene (unique passwords, backups, patching) appears only when a finding calls for it.
- What would change the rating names the one to three facts that would move it most, each with the rating it would move to.
- Words are plain and exact: "they can keep your files for a year after you cancel" over "extended post-termination retention exposure".
- Sources are read in full before any assessment (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- `bun skills/Fabric/Tools/AnalyzeRiskCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the lines, sections, table rows, fixed values and rating consistency are checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a certification, audit report, encryption scheme, data location or contract term credited to the vendor that the input does not give, and never a quotation that does not appear in the supplied text.
- Never a rating that contradicts the data line and the findings, such as `Low` for Restricted data with an open compliance gap, or `High` for public data with nothing that raises the risk.
- Never a compliance list of every law that exists; an obligation is listed only when this data and use bring it in.
- Never generic controls ("follow security best practices", "review the vendor's policies") that name no finding and no owner.
- Never a filled-in assessment for an input with no third party in it.
- Never a source assessed from its title or a fetched page summary instead of its full text.
- No preamble, framework history, institution boilerplate or commentary outside the assessment.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-analyzerisk — code checks on the lines, sections, tables, fixed values and the no-vendor line; judged checks on evidence tied to the input, no invented vendor facts, a rating that matches the data, and controls tied to findings.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: pasted vendor documents or a procurement request, a URL, a YouTube link, a file path, a bare vendor, product or category with its use, a question about adopting one, or "this"/nothing for the conversation's subject. A URL or video is read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- An optional hint narrowing the assessment (one framework, one section) or naming its reader.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/AnalyzeRiskCheck.ts <file|-> [--json]
#   exit 0: shape and rating consistency hold; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| (any full assessment) | `<file>` or `-` | Check the saved draft or stdin |
| (piping the result to another tool) | `--json` | Print `{ok, noVendor, assessments, problems}` |

A hint-narrowed assessment (only some sections asked for) skips the check, since its shape is the hint's.

## Output format

One block per vendor, separated by a blank line. The rating and the data class are each followed by a colon (`**Risk:** High: …`, never `High.` or `High —`), and a change line ends on its target rating with nothing after it. `**Source:**` appears only when no vendor text was supplied; `**Answer:**` only when the request asked a question.

```markdown
## Vendor risk: {vendor} for {the intended use}

**Risk:** {Low | Medium | High}: {the reason, naming the data and the deciding finding}

**Data:** {Public | Internal | Confidential | Restricted}: {what data the vendor holds or touches for this use}

**Source:** {what the assessment draws on when no vendor text was supplied}

**Answer:** {the direct answer to the question asked}

### Assumptions

- **Stated:** {a fact the input gave}
- **Assumed:** {a fact the rating rests on that the input did not give}

### Findings

| Area | Finding | Evidence | Effect |
|---|---|---|---|
| Data | {what the vendor collects, keeps and shares} | {quoted clause, Not stated, or the public fact} | {Raises | Lowers | Neutral} |
| Security | {…} | {…} | {…} |
| Privacy | {…} | {…} | {…} |
| Terms | {…} | {…} | {…} |
| Breach notice | {…} | {…} | {…} |

### Compliance

| Obligation | Why it applies | Status | Evidence |
|---|---|---|---|
| {law, standard or policy} | {what in this data or use brings it in} | {Met | Gap | Unknown} | {the clause or fact that decides it} |

### Required controls

1. **{Implementer | User | Procurement}:** {the control}. Answers: {the finding it closes}

### What would change the rating

- {the fact that would change} → {Low | Medium | High}
```

Every Findings area appears at least once, and an area may take more than one row. A control owner may name the role in parentheses (`**User (registrar):**`). A rating `High` rests on at least one finding that raises the risk or one compliance gap, and each change line names a rating other than the current one. When no obligation applies, the Compliance section is the single line `**None apply:** {why}` in place of the table. A table may be followed by one `**Ruled out:** {obligations considered and why they do not apply}` line, and nothing else goes in the section. An input with no third party is the single line `**No vendor:** {what the input is instead}`.

## References

- Upstream: `Patterns/analyze_risk/system.md` (a third-party vendor risk assessment: a Low, Medium or High score, the reasoning and assumptions behind it, analysis of the vendor's privacy, security and terms, adherence to applicable laws and policies, and the security controls the implementer or user should apply).
- `Tools/AnalyzeRiskCheck.help.md`: the checker's rules and exit codes.
