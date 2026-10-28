# AnalyzeBill

A plain read of a piece of legislation: who brought it and when, what it says it does, what its provisions do that it does not advertise, each tied to the provision that does it, and a verdict on whether the bill is mostly what it claims to be.

Our ideal-state port of Fabric's `analyze_bill` and its sibling `analyze_bill_short`. The upstream patterns stay in `Patterns/` for reference; this intent replaces them whenever a request asks for either, so the old prompts never run.

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

## Ideal State

- The analysis delivers what the principal wants from this input, inferred before writing and never asked for. Pasted bill text, a file or a URL to the bill means that bill, read in full: the gotchas live in definitions, exemptions, preemption clauses, repeals of existing law and effective dates, which a skim of the findings section misses. A URL to a news story or a summary about a bill means the bill it describes, read from its own text where that can be reached, with the story used only to identify it. A bill named by number or title ("H.R. 1234", "the Kids Online Safety Act") means that bill, from its official text. A question about a bill ("what is this bill really for?") means the full analysis, with the Verdict answering the question. Any other rule-making text (an ordinance, a regulation, an executive order, a ballot measure, a platform's policy change) is analyzed the same way, the Bill field naming what kind of instrument it is. "This" or nothing means the bill under discussion in the current conversation. Input that holds no legislation or rule-making text means the one `**No bill found:**` line; a named bill whose text cannot be read means the one `**Bill text unavailable:**` line. A typed hint overrides the default read: "short", "brief" or the name `analyze_bill_short` gives the short form (§ Output format), and "just the covert goals" or "only section 7" narrows the analysis to what it names.
- The Bill section gives the bill's number and title, jurisdiction, sponsors, introduction date and status exactly as the text states them, and `Not stated` for each one the text does not give. A date the bill mentions for another purpose (an effective date, a deadline, a sunset) is never reported as its introduction date.
- The Summary says in at most 24 words (16 in the short form) what the bill does, read from its operative provisions rather than its findings or its title.
- Each Overt goal is something the bill openly sets out to do and would be glad to have reported: its title, findings and headline provisions. Each one opens on the provision that carries it and states the goal in at most 16 words (8 in the short form). The list holds as many goals as the bill has, up to ten, ordered by weight; a one-purpose bill has one.
- Each Covert goal is an effect the bill produces but does not advertise, found in the provision text: a definition that narrows who benefits or widens who is covered, an exemption for a narrow class, preemption of local rules, a repeal or weakening of existing law, a delegation of power, a funding offset, a buried effective date or sunset. Each one opens on the provision that does it and says in at most 16 words (8 in the short form) what it does and who gains or loses. A reader who checks the cited provision finds the effect there.
- A bill that hides nothing gets `- None found` under Covert goals and a Mostly overt verdict. Unadvertised effects are reported because they are in the text, never because a bill is expected to have them.
- The Verdict is one of three labels (Mostly overt, Mixed, Mostly covert) with one sentence of at most 30 words (16 in the short form) naming the provision that decided it. It is an opinionated call on this bill, made on what the provisions do, never on the sponsors' party or the subject's politics, and held to the same standard whichever side the bill favors.
- Words are plain and exact, the way a careful legislative analyst would brief a colleague: what the provision does, in ordinary words, specific to this bill.
- `bun skills/Fabric/Tools/AnalyzeBillCheck.ts` passed on the exact output before it was delivered, with `--short` for the short form. Where no shell is available, the sections, fields, bullet anchors and word counts are checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a sponsor, cosponsor, party, date, vote, committee or status the text does not give, and never a bill analyzed from memory when its text could not be read.
- Never a covert goal without the provision that produces it, and never a motive, beneficiary or backer the provision does not support (who lobbied for it, who funds the sponsor) asserted as fact.
- Never a covert goal invented to fill the section, and never a bill's stated purpose relabeled as covert.
- Never a buried definition, exemption, preemption or repeal left out while the findings section is restated as the bill's goals.
- Never a source analyzed from its title or a fetched page summary instead of its full text.
- No preamble, persona, caveats or commentary outside the sections.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-analyzebill — code checks on the sections, Bill fields, `Not stated` for absent facts, the verdict label and the two single-line outcomes; judged checks on covert goals tied to real provisions, the buried provisions found, no invented motive on a clean bill, and the short form's size.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: pasted bill text, a URL, a file path, a bill number or title, a question about a bill, or "this"/nothing for the current conversation. A URL or video is read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- An optional hint: "short" for the short form, or a narrowing ("just the covert goals", "section 7").

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/AnalyzeBillCheck.ts <file|-> [--short] [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

| User says | Flag | Effect |
|-----------|------|--------|
| (any full analysis) | `<file>` or `-` | Check the saved draft or stdin |
| "short", "brief", `analyze_bill_short` | `--short` | Apply the short form's limits (at most 3 goals per list, 8-word goals, 16-word summary and verdict) |
| (piping the result to another tool) | `--json` | Print `{ok, outcome, overt, covert, verdict, problems}` |

A hint-narrowed analysis (only some sections asked for) skips the check, since its shape is the hint's.

## Output format

```markdown
## Bill

- **Bill:** {number and title, or the instrument's kind and name}
- **Jurisdiction:** {legislature or body}
- **Sponsors:** {names as the text gives them}
- **Introduced:** {YYYY-MM-DD, YYYY-MM or YYYY}
- **Status:** {as the text gives it}

## Summary

{at most 24 words: what the operative provisions do}

## Overt goals

- **{provision, e.g. Sec. 3}:** {the goal, at most 16 words}

## Covert goals

- **{provision, e.g. Sec. 7}:** {what it does unadvertised and who gains or loses, at most 16 words}

## Verdict

**{Mostly overt|Mixed|Mostly covert}:** {one sentence, at most 30 words, naming the deciding provision}
```

- Any Bill field the text does not give reads `Not stated`.
- The provision anchor is the bill's own section label (`Sec. 7`, `§ 4(b)`, `Section 2`), or a short name for the part when the text has no numbers (`Definitions`, `Exemptions`). The goal's word count does not include the anchor.
- Overt goals hold 1 to 10 bullets. Covert goals hold 1 to 10 bullets, or the single bullet `- None found`, in which case the Verdict is Mostly overt.
- The short form keeps every section and caps each goal list at 3 bullets, the first the main goal; goals run at most 8 words, the Summary and the Verdict sentence at most 16.
- Input with no legislation or rule-making text is the single line `**No bill found:** {what the input is instead}`.
- A named bill whose text cannot be read is the single line `**Bill text unavailable:** {which bill, and where its text was looked for}`.

## References

- Upstream: `Patterns/analyze_bill/system.md` (bill metadata, a 24-word summary, 5 to 10 overt goals and 5 to 10 covert goals in 16-word bullets, and an opinionated conclusion on whether the bill is mostly overt or mostly ulterior).
- Upstream: `Patterns/analyze_bill_short/system.md` (the same with a 16-word summary, a main and two supporting goals per list in 8 words each, and a 16-word conclusion).
- `Tools/AnalyzeBillCheck.help.md`: the checker's rules and exit codes.
- Neighbor: `Intents/AnalyzeClaims.md` when the request wants the factual claims in a bill's findings or a story about it checked, rather than the bill's goals.
