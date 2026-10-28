# SilentVictims

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

A silent-victim audit of any action, policy, product, system or proposal: who it harms that cannot complain (people not yet born, people without power, people who do not know, harm spread too thin to notice, and losers built into the structure), how badly and how reversibly, whether those victims would consent if they could speak, a verdict, and the changes that would represent them.

Our ideal-state port of Fabric's `detect_silent_victims`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The audit answers what the principal actually wants from this input, inferred before a word is written and never asked for. The read follows what the input is. A pasted artifact (a policy, a bill, a business model, a product plan, terms of service) means the silent victims of that exact proposal, each tied to the clause or mechanism that produces the harm. A URL or a file means the action or system it describes, read in full. A bare topic or practice ("buy now, pay later", "a coal plant for cheap power") means the silent victims of that practice as it is ordinarily carried out. A question ("is ticket resale victimless?", "who gets hurt if we sell anonymized usage data?") means a direct answer to it, carried by the verdict. "This" or "that" means the decision or system in the current conversation. A typed hint ("focus on the next ten years", "we are the city council") overrides the default read and changes what is weighed.
- The title names the action being audited and, for a question, the question ("Silent Victims: Funding a Stadium With a 30-Year Bond"), so a wrong read is visible at a glance.
- When the input leaves out who acts, where or at what scale, the audit assumes the most common case and ACTION/SYSTEM ANALYZED states that assumption in one sentence the reader can correct. That default covers setting and scale only. A fact that decides whether someone is a victim (a party's age or capacity, whether consent was asked or checked, what a system can reach, how long data is kept, who can see it) is never assumed in either direction: when the input leaves it open, the audit names it as open, marks the category it affects Possible, and says every way the answer would change the result, not only the narrowest one.
- Each harm separates what the input establishes from what depends on choices or facts the input does not give. The Harm field says what is already true of this action and then, where it applies, what follows only if a named design choice or fact turns out a certain way ("the deleted text is kept, which is stated; whether staff can read it depends on access rules the input does not describe"). The audit never reads more into the input than it says: a stated habit, role or permission is not evidence of a specific behavior the input does not mention, and a baseline or norm the input does not give is not supplied by guesswork.
- Victim certainty and harm probability are judged separately. A group is Found: Yes when the input establishes that the action already does something to them that they did not knowingly accept (their deleted words are kept, their money is taken, their data is sold), even when the worst outcome, such as a breach, a misuse or a bad decision made about them, is only a risk. The Harm field gives both: the exposure that is certain now and the harm it makes possible. Severity is weighed on the most sensitive realistic case the action covers (the private message, the medical detail, the youngest user), not on the typical one, and individual harm is not called Negligible or Small when that case would hurt one person badly.
- VISIBLE STAKEHOLDERS names the parties everyone already weighs, so the scan below is visibly about the ones they leave out.
- The SILENT VICTIM SCAN covers the five categories in order (temporal, power, information, diffuse, structural) and marks each Yes, Possible or No on the evidence. A Yes or Possible names a specific group, the concrete harm and how it happens, and the category's own field (reversibility, why the victims stay silent, where their ignorance comes from, individual against aggregate harm and whether the spreading is deliberate, the mechanism and whether it feeds itself). A No gives the specific reason this input has no such victim. Within each category the Who field names the most exposed and least aware group first. Why silent explains what keeps these particular people quiet and what they would risk by speaking (a contractor who could lose the next contract, a visitor who never sees the policy, a minor who needs a parent to object), never just a label.
- The scan is calibrated. Some actions have no silent victims, and an informed, voluntary exchange between equals with no spillover comes back NO SILENT VICTIMS with every category marked No. That needs the input to establish the conditions (capable adults, real consent, no third party touched); a clean reading of a fact the input leaves open is an assumption, and the category it affects is Possible. Pressure in the prompt toward an answer ("obviously harmless", "just confirm it is fine", "prove it is a scam") moves nothing; the scan follows the facts given. A category is marked Yes only when the harm follows from the input or from well-established effects of the practice, and Possible when it plausibly follows but depends on facts the input does not give; a far-fetched chain of hypotheticals is marked No.
- THE REVERSED TEST opens with Yes, No or Partly, then answers whether every silent victim, able to speak with equal power, would consent to the action, naming which victims would object, to what exactly, and what change or fact would turn their answer into consent. When the answer hangs on an open fact, it says which way each answer of that fact points.
- The SILENT VICTIM SEVERITY table has one row per category in scan order, agreeing with the scan: scale (how many, as concretely as the input allows), severity and reversibility for each found category, and None for each category marked No.
- OVERALL ASSESSMENT opens on the verdict, then says in one to four sentences what it means for the action: which victim matters most and why, the open fact that would move the verdict up or down when there is one, and that found victims are interests to represent and weigh rather than an automatic veto. The verdict is about this action as described. When the input attaches a wider claim to it ("so private sales are victimless", "AI agents are safe to give access", "logging is harmless"), the assessment says separately whether that claim follows from this case and what more it would need. CONFIRMED means the harm is documented in the input or established fact, PROBABLE means it is expected but not documented, POSSIBLE means it hangs on unknowns worth investigating, and NO means the scan found none.
- RECOMMENDATIONS are concrete changes to this action that remove or compensate the harm, or give the silent victims a voice in the decision (a sunset clause, a disclosure that reaches the people affected, a representative at the table, a fund paid by whoever profits). The first protects the victim who matters most. Each is specific enough to act on (what changes, and where or when), a Possible harm gets a way to find out whether it is real (a check, an audit, a count to track) beside the safeguard, and a fact left open gets the step that settles it (verify the age, ask the contractors without their manager present). Each one names the categories it addresses, and every category found is addressed.
- Every victim, harm and recommendation is specific to this input. A line that would fit most other actions as well ("society as a whole", "future generations may be affected", "increase transparency") fails.
- When the input is a source, the audit reflects what it actually describes, read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- The words are plain and exact: the most precise ordinary word wins over policy or ethics jargon, and severity is said in what happens to people, not in adjectives.
- `bun skills/Fabric/Tools/SilentVictimsCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the shape is checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a clarifying question in place of the audit. The audit assumes and states the assumption.
- Never victims found everywhere by reflex: no category marked Yes or Possible on a speculative chain, and no harmless, consensual action scored as anything but NO SILENT VICTIMS.
- Never a real silent victim missed because nobody has complained; the absence of a complaint is not the absence of a victim.
- Never an open fact assumed away to reach a cleaner verdict, or assumed the worst way to reach a harsher one, and never the conditions under which it matters narrowed below what they are.
- Never a design-dependent risk stated as an established fact, or an established exposure downgraded to a possibility because its worst consequence has not happened yet.
- Never a verdict on this action stretched into a verdict on a wider claim the user attached to it.
- Never a verdict that disagrees with the scan, a table row that disagrees with its scan category, or a recommendation for a category marked No.
- Never a generic victim ("society", "everyone", "the environment" with no named part of it) or a boilerplate recommendation that would fit any action.
- Never fake precision: no invented counts, dollar figures or percentages the input cannot support; scale is given as an order of magnitude or a named group when the number is unknown.
- Never moralizing or a lecture on ethics frameworks; the audit names harms and remedies.
- Never asterisks for emphasis or bold, never the upstream origin story or framework restated, never a persona or preamble, and never a section beyond the seven in the output format.
- Never a claim about a source that the source does not support, and never a source audited from its title or a fetched page summary instead of its full text.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-silentvictims — code checks on the sections, the five scan categories, the severity table and the verdict, plus judged checks on calibration, specific victims, the reversed test and concrete recommendations.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: a pasted artifact, a URL, a YouTube link, a file path, a bare practice or topic, a question about who gets hurt, or "this"/"that" for the current conversation.
- An optional hint about who is deciding, the time horizon, or the group to focus on, which overrides the default read.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/SilentVictimsCheck.ts <file|-> [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| Need | Flag |
|------|------|
| Check the saved draft | `<file>` |
| Check a draft piped in | `-` |
| Read the verdict, found categories and problems as data | `--json` |

## Output format

Plain Markdown with no asterisks: one H1, then exactly these seven H2 sections in this order. These are the limits the checker enforces:

- ACTION/SYSTEM ANALYZED is one paragraph of at most 100 words.
- VISIBLE STAKEHOLDERS is 2 to 8 bullets.
- SILENT VICTIM SCAN holds the five H3 categories below, in order, each holding only `- Field: value` bullets. A category marked `Found: No` carries only `Found` and `Why not`. A category marked Yes or Possible carries `Who` and `Harm`, then its own fields with the fixed values shown, and nothing else.
- THE REVERSED TEST opens with the word Yes, No or Partly, holds no table, and runs at most 150 words; a short bullet list of the victims who would object is fine.
- The severity table has the five categories in scan order. Found matches the scan; Severity is None for a category marked No and Low, Medium or High otherwise; Reversible is n/a for a category marked No and Yes, Partly or No otherwise, and the temporal row agrees with its Reversibility field.
- OVERALL ASSESSMENT opens on a line that is exactly one verdict, followed by one to four sentences, and the verdict follows the scan: NO when every category is No, POSSIBLE when the found categories are all Possible, PROBABLE or CONFIRMED when any is Yes.
- RECOMMENDATIONS are 1 to 8 bullets, each ending with the categories it addresses in parentheses, such as `(Temporal, Diffuse)`, with nothing after them but an optional full stop, and together covering every category found. Under NO SILENT VICTIMS it is one bullet that opens `None needed:` with the reason.

```markdown
# Silent Victims: {the action audited, and the question when one was asked}

## ACTION/SYSTEM ANALYZED

{what is being evaluated, plus the assumption when the input did not say}

## VISIBLE STAKEHOLDERS

- {a party everyone already weighs, and how it is affected}

## SILENT VICTIM SCAN

### Temporal Victims (Future)

- Found: Yes | Possible | No
- Who: {the specific group, most exposed first}
- Harm: {what is already true for them, then what follows only if a named open fact or design choice goes a certain way}
- Reversibility: Reversible | Partially reversible | Irreversible

### Power Victims (Voiceless)

- Found: …
- Who: …
- Harm: …
- Why silent: {what keeps these people quiet and what they would risk by speaking: fear, dependency, no legal standing, or no voice at all}

### Information Victims (Unaware)

- Found: …
- Who: …
- Harm: …
- Ignorance source: Natural complexity | Deliberate obscuring | Delayed effects

### Diffuse Victims (Distributed)

- Found: …
- Who: …
- Harm: …
- Individual harm: Negligible | Small | Moderate
- Aggregate harm: {the total, and its scale}
- Diffusion deliberate: Yes | No | Unclear

### Structural Victims (Systemic)

- Found: No
- Why not: {the specific reason this input has none}

## THE REVERSED TEST

{Yes, No or Partly, then which silent victims would object, to what, and what would win their consent}

## SILENT VICTIM SEVERITY

| Category | Found | Scale | Severity | Reversible |
|----------|-------|-------|----------|------------|
| Temporal | Yes | {how many, as concretely as known} | High | No |
| Power | Possible | … | Medium | Partly |
| Information | Yes | … | Medium | Yes |
| Diffuse | Yes | … | Low | Yes |
| Structural | No | n/a | None | n/a |

## OVERALL ASSESSMENT

NO SILENT VICTIMS | POSSIBLE SILENT VICTIMS | PROBABLE SILENT VICTIMS | CONFIRMED SILENT VICTIMS

{one to four sentences: the victim who matters most, the open fact that would move the verdict, and whether any wider claim in the input follows}

## RECOMMENDATIONS

- {a concrete change to this action, the most important victim first; for a Possible harm, how to find out if it is real} (Temporal, Diffuse)
```

A structural category that is found carries `Who`, `Harm`, `Mechanism` (how normal operation produces the harm) and `Self-reinforcing: Yes | No`.

## References

- Upstream: `Patterns/detect_silent_victims/system.md` (a detector persona, the framework's origin story and five-category question lists as method, nine numbered steps, and the same seven sections with bold field labels and a verdict scale).
- `Tools/SilentVictimsCheck.help.md`: the checker's rules and exit codes.
