# AuditConsent

An audit of whether the consent in an agreement, policy or interaction is real: who asked whom for what, the power between them, the channel the consent came through, five consent tests, and a verdict on whether refusal was ever a live option, with the changes that would make it genuine.

Our ideal-state port of Fabric's `audit_consent`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

## Ideal State

- The audit delivers what the principal wants from this input, inferred before writing and never asked for. A pasted artifact (terms of service, a contract clause, a consent form, a cookie banner, a policy, or an account of an interaction) means an audit of the consent that text claims, built from that text alone. A URL or a file means the same for the document it holds. A bare topic or practice ("gig work contracts", "taxation by democratic participation", "cookie banners") means an audit of its typical form, with a `**Source:**` line naming that form and the arrangements it draws on. A question ("did I really agree to arbitration when I signed?") gets the full audit with its direct answer in an `**Answer:**` line under the consent claim. "This" or nothing means the agreement or interaction under discussion in the conversation. An input that holds several consent claims that would earn different verdicts (data sharing and arbitration in one set of terms) gets one audit per claim. An input that claims no consent from anyone (a recipe, a weather report, a news brief with no agreement in it) gets the single line `**No consent claim:**` saying what the input is instead. A typed hint ("just the five tests", "focus on revocability") overrides the default read and narrows the output to what it names.
- The consent claim names who is asking, who is said to consent, and to what, in the input's own terms.
- The power map rates the economic, information, social and structural asymmetry between the two parties for this arrangement, and each party's position says what that party actually holds or lacks here (a single employer in the town, a 14-page form signed on the spot), never a generic label.
- The consent channel is the one the claim rests on: words, conduct, an explicit agreement, or a permission given beforehand. An act of the consenter that the requester counts as consent (clicking accept, signing, continuing to use a service) is `Conduct` or `Agreement`, and its detail says whether the act carried the intention words would carry; whether it really did is then decided by the tests and the verdict, so a click-through or continued use is audited in full. The channel is `None` only when the claim rests on no word or act of the consenter at all: silence, no one objecting, circumstances, someone else's say-so, or a bare promise. A `None` channel stops the audit there with no tests and no verdict, and only what would make it genuine follows, because there is no consent to test.
- Each of the five tests (information, alternatives, capacity, no manipulation, revocability) is decided from the facts of this input, and its evidence names the clause, term or event that decides it, quoted exactly where the input supplied a text. A test the input gives too little to decide is `Partial`, and its evidence says what is missing.
- The verdict follows from the tests and the power map. `GENUINE` means all five tests pass and no asymmetry is high. `PRESSURED BUT FUNCTIONAL` means real asymmetry with refusal still possible. `MANUFACTURED` means the look of choice covers an outcome already decided. `COERCED` means refusal or withdrawal costs far more than the matter is worth. `ILLUSORY` means no real alternative exists and the consent is a formality. The verdict line gives the reason in one or two sentences that point back at the tests.
- The audit is even-handed. Some asymmetry is normal, and economic need on its own (needing a job, needing housing) is not coercion; it moves a verdict only when it combines with hidden terms, missing alternatives or a costly exit. An arrangement that passes is called `GENUINE` without hedging.
- Every change under What would make this genuine names the term, clause or practice it changes and what it becomes, specific enough to adopt as written. Minimum viable consent is the smallest set of those changes that would make the consent defensible, and it is a subset of them, never a new idea.
- Words are plain and exact: "you can only opt out by deleting your account" over "asymmetric exit friction", with ethics vocabulary used only where it is the precise word.
- Sources are read in full before any audit (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- `bun skills/Fabric/Tools/AuditConsentCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the sections, table rows, fixed values and verdict consistency are checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a `COERCED`, `ILLUSORY` or `MANUFACTURED` verdict resting on ordinary asymmetry alone, and never every consent declared invalid because some asymmetry always exists.
- Never a channel credited for consent that only silence, a lack of objection or circumstances supplied; never tests or a verdict after a `None` channel; and never a `None` channel for a claim that rests on the consenter's own act (a click, a signature, continued use), which gets the full audit.
- Never a quotation that does not appear in the supplied text, and never a fact about the arrangement the input does not give.
- Never a verdict that contradicts the tests above it, such as `GENUINE` with a failed test or `PRESSURED BUT FUNCTIONAL` with no real alternative.
- Never generic recommendations ("increase transparency", "empower users") that name no term to change.
- Never a filled-in audit for an input that claims no consent.
- Never a source audited from its title or a fetched page summary instead of its full text.
- No preamble, caveats, framework history or commentary outside the audit.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-auditconsent — code checks on the sections, channel and verdict values and the no-consent-claim line; judged checks on evidence tied to the input, the channel rule, even-handed verdicts, and recommendations that name the term they change.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: pasted text, a URL, a YouTube link, a file path, a bare topic or practice, a question about an agreement, or "this"/nothing for the conversation's subject. A URL or video is read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- An optional hint narrowing the audit to named sections.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/AuditConsentCheck.ts <file|-> [--json]
#   exit 0: shape and verdict consistency hold; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| (any full audit) | `<file>` or `-` | Check the saved draft or stdin |
| (piping the result to another tool) | `--json` | Print `{ok, noClaim, audits, problems}` |

A hint-narrowed audit (only some sections asked for) skips the check, since its shape is the hint's.

## Output format

One block per consent claim, separated by a blank line. `**Source:**` appears only when no text was supplied; `**Answer:**` only when the request asked a question.

```markdown
## Audit: {who consents to what}

**Consent claim:** {what is presented as voluntary, who asks, who is said to consent}

**Source:** {the typical form audited, and the arrangements it draws on}

**Answer:** {the direct answer to the question asked}

### Power map

| Dimension | Requester: {party} | Consenter: {party} | Asymmetry |
|---|---|---|---|
| Economic | {what the requester holds here} | {what the consenter holds here} | {Low | Medium | High | Extreme} |
| Information | {…} | {…} | {…} |
| Social | {…} | {…} | {…} |
| Structural | {…} | {…} | {…} |

### Consent channel

**Channel:** {Words | Conduct | Agreement | Prior permission | None}: {the words, act or document that carried it, or what stood in for consent}

### Five consent tests

| Test | Status | Evidence |
|---|---|---|
| Information | {Pass | Partial | Fail} | {the clause, term or event that decides it} |
| Alternatives | {…} | {…} |
| Capacity | {…} | {…} |
| No manipulation | {…} | {…} |
| Revocability | {…} | {…} |

### Verdict

**Verdict:** {GENUINE | PRESSURED BUT FUNCTIONAL | MANUFACTURED | COERCED | ILLUSORY}: {the reason, pointing back at the tests}

### What would make this genuine

- {the term or practice, and what it becomes}

### Minimum viable consent

{the smallest set of the changes above that would make the consent defensible}
```

A `None` channel ends the block after `### Consent channel` and one `### What would make this genuine` section. A `GENUINE` verdict may give `None needed.` under both closing sections. An input that claims no consent is the single line `**No consent claim:** {what the input is instead}`.

## References

- Upstream: `Patterns/audit_consent/system.md` (a consent audit from the Ultimate Law framework: power map, consent channel, five consent tests, a five-value verdict, and the changes that would make it genuine).
- `Tools/AuditConsentCheck.help.md`: the checker's rules and exit codes.
