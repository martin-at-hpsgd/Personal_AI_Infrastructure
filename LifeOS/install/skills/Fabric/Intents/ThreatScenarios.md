# ThreatScenarios

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

A plain-language threat model of any system, place, habit or decision: the realistic ways it gets hurt, ranked by likelihood and impact, what is worth defending against and what is not, the controls that buy the most safety, and an honest read of the real risk.

Our ideal-state port of Fabric's `create_threat_scenarios`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The model answers what the principal actually wants from this input, inferred before a word is written and never asked for. The read follows what the input is. A pasted artifact (an architecture note, a config, a description of a setup) means the most likely ways that exact setup gets attacked, tied to the weaknesses it shows. A URL or a file means the system or situation it describes, read in full. A bare thing ("my home NAS", "a small online shop") means the most likely ways it gets attacked for the ordinary owner of one. A should-I question ("should I put my address on my website", "should I use a smart lock") means whether the value is worth the total risk, with a verdict. A control question ("PIN, fingerprint or face unlock") means which option wins against the realistic scenarios. A stated fear ("I'm worried the NSA is in our systems") means that fear weighed honestly against what is actually likely. "This" or "that" means the system or decision in the current conversation. A typed hint about who is asking or what they face ("for a journalist", "we hold medical records") overrides the default read and changes the ranking.
- The title names the thing being protected and the question being answered ("Threat Scenarios: A Smart Lock on the Front Door, Worth It?"), so a wrong read is visible at a glance.
- When the input does not say who is asking or where, the model assumes the most common case, and the first analysis bullet states that assumption so the reader can correct it.
- The model keeps what the input says apart from what it infers. A fact the input leaves out (which device, who sent a message, whether two events are connected, what a click or a login actually confirmed) stays open: a scenario that depends on it says so in its own wording ("if the texts came from the same sender"), its likelihood reflects that doubt, and the analysis names the one or two open facts that would most change the ranking. Thin or ambiguous input gets a cautious read stated as such, never a confident story built from guesses.
- Placeholder values are recognized for what they are. Documentation IP ranges (192.0.2.x, 198.51.100.x, 203.0.113.x), example.com and other reserved domains, 555-01xx phone numbers and obvious stand-in names mean the input was redacted or invented, so the model treats them as unknowns and never reads a location, a provider, an attacker or a pattern into them.
- Every statement about how a technology, service or attack works is accurate and no stronger than the truth. A protection is described with its real limit (a VPN hides traffic from the café network, not from the VPN provider), and nothing is called untraceable, impossible, guaranteed or "never" unless that is actually so.
- Protections the input says are already in place (a password manager, backups, two-factor on some accounts, a locked-down network) lower the likelihood of the scenarios they stop, are credited in the analysis by name, and are never recommended again as if new; the controls build on them and close the gaps they leave.
- Impact is rated by what the owner would lose and could not get back: irreplaceable data (family photos and videos, the only copy of records) and money that leaves an account rate higher than an inconvenience that a reset fixes. A scenario about an account takeover names what the attacker could do with that particular service (redirect payouts, issue refunds, reset other passwords through the inbox), never a bare "the account is compromised".
- THREAT SCENARIOS is a ranked table of the realistic ways this specific thing gets hurt. Each row rates likelihood over the next few years and impact if it happens, each as Low, Medium or High, and the rows are ordered by likelihood times impact, highest first. Mundane, likely scenarios that apply (phishing, a lost or stolen device, a reused password, a misconfiguration, someone in the household or company) rank above dramatic, unlikely ones, and the fear the input named is in the table, rated honestly, even when that rating is low.
- Every scenario carries a call: Defend (a control is worth its cost), Watch (cheap to notice, revisit if circumstances change), or Accept with its reason (possible but not realistic for this owner, or impossible to stop at a sane cost, such as a targeted state-level attacker). The table separates what is realistic from what is merely possible.
- THREAT MODEL ANALYSIS is the short chain of reasoning a reader needs to make the choice: what is being protected and how much it is worth to the owner, who the realistic adversaries are, where the risk concentrates, and, for a should-I or control question, how the value or the options weigh against that risk.
- RECOMMENDED CONTROLS are ordered by how much risk they remove for what they cost in money, time and friction. Each one is a concrete action for this system, specific enough to do today, and ends by citing the scenario ranks it addresses. Every Defend scenario is covered by at least one control.
- NARRATIVE ANALYSIS is one to three paragraphs, written warmly and honestly, that take the concern seriously and inject realism: they say why the scenarios were rated as they were, reassure with reasons where the worry outruns the risk, and name what was missed where the input worried about the wrong thing.
- CONCLUSION is one sentence that sums up the whole read and, for a should-I or control question, gives the verdict.
- Every scenario, bullet and control is specific to this input. A line that would fit most other systems as well ("Attackers may exploit vulnerabilities") fails.
- When the input is a source, the model reflects what it actually describes, read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- The words are plain and exact: the most precise ordinary word wins over security jargon, and a term a non-specialist would not know is explained in the same line or replaced.
- `bun skills/Fabric/Tools/ThreatScenariosCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the shape is checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a clarifying question in place of the model. The model assumes and states the assumption.
- Never a movie-plot scenario ranked above a likely, mundane one, and never a named fear left out of the table or waved away without a rating and a reason.
- Never a control for a scenario called Accept, and never a Defend scenario that no control covers.
- Never a padding row: a dramatic, unlikely scenario (a state-level attacker, an elite crew) appears only when the input raised it or this owner plausibly fears it, never as a generic row added to every table.
- Never a boilerplate control that would fit any system ("use strong passwords", "keep software updated", "train your staff") without saying exactly what to do here and which scenario it stops.
- Never fake precision: no invented percentages or scores the input cannot support; the ratings are Low, Medium or High.
- Never an invented detail stated as fact: no device, sender, connection between events or confirmed outcome the input did not give, and no conclusion drawn from a placeholder value.
- Never an absolute or overconfident claim about a technology or attack ("tunnels never filter anyone", "this access is untraceable") that its real behaviour does not support.
- Never a protection the input already has recommended as a new control, and never a scenario rated as though that protection were absent.
- Never alarmism that inflates a rare risk, and never false comfort that dismisses a real one.
- Never asterisks for emphasis or bold, never the upstream essay restated, never a persona or preamble, and never a section beyond the five in the output format.
- Never a claim about a source that the source does not support, and never a source modeled from its title or a fetched page summary instead of its full text.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-threatscenarios — code checks on the section order and the scenario table, plus judged checks on realistic ranking, honest handling of the named fear, specific controls and the verdict.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: a pasted artifact, a URL, a YouTube link, a file path, a bare system or situation, a should-I or control question, a stated fear, or "this"/"that" for the current conversation.
- An optional hint about who is asking, what they hold, or who they fear, which overrides the default read.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/ThreatScenariosCheck.ts <file|-> [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

## Output format

Plain Markdown with no asterisks: one H1, then exactly these five H2 sections in this order, with nothing else in them. These are the limits the checker enforces:

- The table has 4 to 15 rows. Each scenario is one sentence of 5 to 25 words. Rows sort by risk, likelihood times impact with Low 1, Medium 2 and High 3, highest first, so a Low/High row (3) sits above a Low/Medium row (2) and below a Medium/Medium row (4).
- The analysis has 3 to 10 bullets of at most 20 words each.
- The controls are 1 to 10 bullets of 4 to 30 words each, every one ending with the ranks it addresses, such as `(#1, #3)`.
- The conclusion is one sentence on one line, 12 to 35 words.

```markdown
# Threat Scenarios: {the thing being protected, and the question being answered}

## THREAT SCENARIOS

| Rank | Scenario | Likelihood | Impact | Call |
|------|----------|------------|--------|------|
| 1 | {a specific way it gets hurt, in one plain sentence} | High | Medium | Defend |
| 2 | … | Medium | Medium | Watch |
| 3 | … | Low | High | Accept: {why it gets no control} |

## THREAT MODEL ANALYSIS

- {assumption about who is asking, when the input did not say}
- {one step of the reasoning, about 10 to 15 words}

## RECOMMENDED CONTROLS

- {a concrete action for this system} (#1, #2)

## NARRATIVE ANALYSIS

{one to three paragraphs}

## CONCLUSION

{one sentence}
```

## References

- Upstream: `Patterns/create_threat_scenarios/system.md` (a security-expert persona, the Everyday Threat Modeling essay inlined as method, and five sections with fixed bullet word counts and no visible ratings).
- `Tools/ThreatScenariosCheck.help.md`: the checker's rules and exit codes.
