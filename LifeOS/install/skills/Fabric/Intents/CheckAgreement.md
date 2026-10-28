# CheckAgreement

A pre-signing review of a contract, terms of service, license or other agreement: what it says, the gotchas a careful reader would catch, ranked by how much they matter to the signer, and a ready-to-send request for each one worth changing.

Our ideal-state port of Fabric's `check_agreement`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

## Ideal State

- The review delivers what the principal wants from this input, inferred before writing and never asked for. Pasted agreement text or a file means a review of that agreement, read in full. A URL means the agreement on that page (terms of service, license, offer letter, lease), read in full. The bare name of a public agreement ("GitHub's terms of service", "the GPLv3") means its current published text, fetched and read in full, named with its version or date in a `**Source:**` line. A bare agreement type or question ("a standard freelance contract", "what should I watch for in an NDA", "should I sign a two-year non-compete") means a review of the terms that kind of agreement usually carries, with each label naming a clause type rather than a section number, the Document summary saying it reviews the type and not a specific document, and a question answered in that summary. "This" or nothing means the agreement under discussion in the conversation. Input that is not an agreement (a press release, a recipe, an invoice with no terms) means one `**Not an agreement:**` line saying what it is instead. The default side is the party being asked to sign; a typed hint naming a side ("I'm the contractor", "we're the vendor") sets the side the review takes and the party the Responses go to, and a typed focus ("just the IP terms", "only the responses") narrows the review to what it names.
- The Document summary is one sentence of at most 30 words that says what the agreement is, between whom, and the single thing about it that matters most to the signer.
- The Callouts are the terms someone signing must know (money, duration, renewal, termination, obligations, ownership, governing law), each stated as what the document says, neutrally, in at most 20 words after its label. There are up to ten, as many as the document warrants; a short agreement gets fewer, never padding.
- The Issues are the judgment: up to ten problems to resolve before agreeing, sorted into Critical, Important and Other by what they could cost the signer. Critical is a term a careful signer in this position should not accept as written because it could cost money, ownership, rights or the ability to leave beyond what is normal for this kind of agreement. Important is worth negotiating but would not stop the deal. Other is worth knowing and needs no change. Each issue says what the risk is for this signer and why it sits at that level.
- The review catches what a quick read misses: obligations hidden in definitions, cross-references, documents incorporated by reference, survival clauses and "as updated from time to time" language, and the protections the agreement leaves out (no liability cap for the signer, no termination for convenience, no cure period). A missing protection is flagged only after the whole document was read and the protection is absent from all of it, and its label says it is missing.
- Every label names a clause the document actually contains, by its section number and heading, or by its heading or a short exact quote when the document is unnumbered. Every quote is exact, and every number (fee, notice period, cap, term length) is the one the document states.
- The Responses hold one request per Critical and Important issue, in the same order, addressed to the other party and ready to paste. Each names the clause and asks for a specific change (replacement wording, a number, a cap, a carve-out or a deletion) with the reason in a clause, courteous and firm.
- Every item is specific to this agreement: it would read wrong pasted under a different document. Words are plain and exact, the vocabulary a sharp contracts lawyer would use with a client.
- `bun skills/Fabric/Tools/CheckAgreementCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the sections, counts and Response labels are checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a clause, section number, quote or figure the document does not contain, and never a "missing" protection the document actually has.
- Never an agreement reviewed from its title, its first pages or a fetched page summary instead of its full text.
- Never callouts or issues padded toward ten with boilerplate ("read the agreement carefully", "terms may change") that is not tied to a clause.
- Never a Critical issue that is a normal, balanced term for this kind of agreement, and never an uncapped indemnity, a grab of the signer's ownership or a one-sided exit left out of Critical.
- Never a Response that only asks the other party to "reconsider" or "clarify" without naming the change wanted.
- Never an issue or callout that repeats another item in the same list, and never two items in a list opening on the same words.
- No preamble, legal-advice disclaimer, caveats or commentary outside the sections. Never bullets where the format has numbered items.
- Never a filled-in review for input that is not an agreement.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-checkagreement — code checks on the sections, numbered labelled items and Response labels; judged checks on fidelity to the document, catching the buried and missing terms, severity calibration, the signer's side, and specific Responses.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The agreement: pasted text, a file path (PDF, DOCX, text), a URL, a YouTube link, the name of a public agreement, an agreement type or question, or "this"/nothing for the conversation's agreement. A URL or video is read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- An optional hint naming the principal's side or narrowing the focus.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/CheckAgreementCheck.ts <file|-> [--json]
#   exit 0: review shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| (any full review or a not-an-agreement line) | `<file>` or `-` | Check the saved draft or stdin |
| (piping the result to another tool) | `--json` | Print `{ok, notAgreement, counts, problems}` |

A focus-narrowed review (only some sections asked for) skips the check, since its shape is the hint's.

## Output format

`**Source:**` appears only when the agreement was fetched or named rather than supplied. A severity group with no issues holds the single line `None.`; when there are no Critical or Important issues, Responses holds the single line `None needed.` Issues are numbered from 1 within each severity group, and each Response label repeats the issue's group, number and label exactly.

```markdown
**Source:** {publisher, document name, version or date read}

## Document summary

{one sentence, at most 30 words}

## Callouts

1. **{§4.2 Auto-renewal}:** {at most 20 words: what the term says}
2. **{§6.1 Fees}:** {…}

## Issues

### Critical

1. **{§9.3 Indemnification}:** {the risk to this signer and why it is critical}

### Important

1. **{§5.4 Price changes}:** {…}

### Other

1. **{Missing cure period}:** {…}

## Responses

1. **Critical 1, {§9.3 Indemnification}:** {the request: what to change, to what, and why in a clause}
2. **Important 1, {§5.4 Price changes}:** {…}
```

Input that is not an agreement is the single line `**Not an agreement:** {what it is instead}`.

## References

- Upstream: `Patterns/check_agreement/system.md` (a 30-word summary, ten callouts of at most 20 words, ten issues in Critical, Important and Other, and change requests to the sending organization for the Critical and Important ones, as numbered lists with no notes).
- `Tools/CheckAgreementCheck.help.md`: the checker's rules and exit codes.
