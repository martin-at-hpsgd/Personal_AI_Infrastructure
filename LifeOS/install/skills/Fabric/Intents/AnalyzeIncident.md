# AnalyzeIncident

A one-page record of a cybersecurity incident from an article, report or named breach: what the source says happened, kept strictly apart from the ATT&CK mapping, tests and remediation we add.

Our ideal-state port of Fabric's `analyze_incident`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

## Ideal State

- The record delivers what the principal wants from this input, inferred before writing and never asked for. A pasted article, report or advisory, a URL or a file means a record of the incident that source describes, built from that source alone. A source covering several incidents means one record per incident. A bare incident name or question ("the Equifax breach", "how did the MGM hack happen") means a record of that incident from reputable public reporting, with the reporting named in a `**Sources:**` line, and a question gets its answer in the Summary and Root cause. "This" or nothing means the incident under discussion in the conversation. A source that describes no incident (a patch notice, a vulnerability disclosure with no exploitation, a vendor pitch) means one `**No incident reported:**` line saying what the source is instead. A typed hint ("just the ATT&CK mapping", "focus on remediation") overrides the default read and narrows the record to what it names.
- Every value under Reported facts is something the source states, at the confidence the source states it. A field the source does not state reads `Not stated`; nothing is guessed, filled from general knowledge, or carried over from a different incident. Attribution keeps the source's hedging ("suspected", "claimed by", "attributed by the vendor to"), and a group's claim is never promoted to fact.
- Silence and an explicit negative are different facts. When the source says a thing was absent ("no CVE was involved", "no customer data was taken", "no malware was found"), the field reads `None` followed by the source's own claim in parentheses, never `Not stated`, which is reserved for what the source never addresses.
- Quantities keep the source's precision and nothing more. A source that confirms one compromised account and gives no total reads "At least one confirmed; total not stated", never a count. An estimate stays an estimate ("about", "up to", "the company believes"), and a figure for records, customers or devices is never relabeled as accounts.
- When the source carries conflicting accounts (two outlets, the victim against the attacker, an early report later corrected), the field gives each version with who said it, and the record does not pick a winner the source does not pick. A detail the source marks as unconfirmed stays marked as unconfirmed everywhere it is used, the Summary included.
- Root cause is the cause the source gives, in the source's terms. When the source reports the conditions that let the attack through (an unapplied patch, an MFA exemption, an exposed tool) without calling them the cause, the field states those reported conditions and the entry path they sit on, as reported. When the source says nothing about why the attack worked, the field reads `Not stated` followed by what the source does report about the entry path and what it leaves open ("Not stated; access came through the vendor account, how it was obtained is not disclosed"). Reported facts carry no inference of ours, labeled or not: our reading of an open cause belongs in the Action plan, as the step that confirms it. No control is called the only, sole or last barrier, and no condition is called always present or the reason the attack succeeded, unless the source says so; a contributing factor (an exemption, a shared credential, a missing alert) is written as contributing, at the weight the source gives it.
- The attack date is when the attack happened, never when it was disclosed, reported or published. When the source gives only a disclosure date, the field reads `Not stated (disclosed YYYY-MM-DD)`. A full date is a real calendar date in `YYYY-MM-DD`; a month or year alone is written `YYYY-MM` or `YYYY`, and an attack that ran over days is `YYYY-MM-DD to YYYY-MM-DD`.
- The CVEs field lists exactly the CVE IDs the source names, in `CVE-YYYY-NNNN` form, and no others.
- The Summary is one sentence of at most 40 words that says who was hit, how, and what harm the source reports. Business impact is one sentence that says what the reported harm was and why it matters to the target. Neither names a cost, fine, loss, downstream consequence or detection failure the source does not report: "the clinic is offering credit monitoring" stays an action the clinic took, never "credit monitoring costs".
- A location the source gives at a finer grain answers the coarser field: a company "based in Rotterdam" has Target country `Netherlands (based in Rotterdam)`.
- Every Reported facts field is one line, a phrase or at most one sentence, however much the source says; hedges, negatives and conflicting versions are written compactly inside that line ("At least one confirmed (credit union); three per an unconfirmed local report"), never as extra sentences. The Attack date field holds only one of its date forms, with nothing after it. The `**Sources:**` line lists every report on that one line, separated by semicolons, never as bullets.
- Every ATT&CK technique is tied to a behavior the source describes, with its real technique ID and name and the reported behavior it maps to. Techniques are as specific as the source allows (a sub-technique when the source says which variant), and an attack on industrial control systems uses the ATT&CK for ICS IDs where they fit better. When the source describes too little to map, the field says so rather than listing likely techniques.
- The Atomic Red Team entries name only techniques from the ATT&CK list. Each entry is a testing objective a defender could run tomorrow: the system or control in this incident to run that technique's atomics against, and what a pass and a fail would each tell them about this attack path (alert fired, action blocked, or neither). Each entry is honest about coverage. Where Atomic Red Team has tests for that technique on this incident's platform, the entry says to run them (naming a test only when it is certain the test exists, in words, never by number or GUID) and to confirm the choice against the current atomics. Where coverage is thin or absent (exploiting a specific CVE under T1190, phishing delivery, most ATT&CK for ICS IDs), the entry says so in a short clause and gives the closest manual emulation or check, labeled as manual, rather than presenting it as an atomic. No atomic test number, GUID or name is invented.
- Everything in the Analysis that describes this incident uses only reported facts. A pass/fail line, an action step or a lesson never adds a detail the source does not give, such as an alert that did not fire, encryption that "went unnoticed", or a step the victim skipped; "as happened here" is written only where the source says it happened.
- The Remediation is the one action that would most directly have stopped this incident, aimed at its root cause, and the Action plan is the ordered steps to carry it out. When the source does not report the root cause, the Remediation is aimed at the reported entry path and the first Action plan step confirms the open cause (naming our most likely reading as the thing to check) before acting on it. The Lessons learned say what this incident teaches that a reader could act on elsewhere. All three are specific to this incident: each would read wrong if pasted under a different breach.
- Words are plain and exact, the vocabulary a security analyst would use with a colleague.
- `bun skills/Fabric/Tools/AnalyzeIncidentCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the fields, ID formats and cross-references are checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never an attacker, origin country, CVE, account count or date that the source does not state.
- Never `Not stated` for a fact the source explicitly says is absent, and never `None` for a fact the source does not address.
- Never a count, a "sole barrier", an "always available" or a "because of" claim that is firmer than the source, and never one side of a conflict reported as settled.
- Never a disclosure or publication date reported as the attack date.
- Never an ATT&CK technique included because it is common for this kind of attack rather than because the source describes it, and never a technique ID with the wrong name.
- Never generic remediation ("implement MFA, patch regularly, train staff") that ignores the reported root cause.
- Never an inferred cause, cost or consequence written into Reported facts, and never an incident detail in the Analysis that the source does not give.
- Never a manual check presented as an Atomic Red Team test, and never an atomic named that is not certain to exist.
- Never a source analyzed from its headline or a fetched page summary instead of its full text.
- Never a filled-in record for a source that reports no incident.
- No preamble, caveats or commentary outside the record.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-analyzeincident — code checks on the record's fields, date and ID formats; judged checks on fidelity to the source, the attack-versus-disclosure date, hedged attribution, and remediation tied to the root cause.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The source: pasted text, a URL, a YouTube link, a file path, a bare incident name or question, or "this"/nothing for the conversation's incident. A URL or video is read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- An optional hint narrowing the record.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/AnalyzeIncidentCheck.ts <file|-> [--json]
#   exit 0: record shape holds; exit 1: prints each failed rule; exit 2: bad usage
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| (any full record) | `<file>` or `-` | Check the saved draft or stdin |
| (piping the result to another tool) | `--json` | Print `{ok, noIncident, incidents, problems}` |

A hint-narrowed record (only some sections asked for) skips the check, since its shape is the hint's.

## Output format

One block per incident, separated by a blank line. `**Sources:**` appears only when no source was supplied.

```markdown
## Incident: {target}, {attack type}

**Summary:** {one sentence: who was hit, how, and what it cost}

### Reported facts

- **Attack date:** {YYYY-MM-DD | YYYY-MM | YYYY | YYYY-MM-DD to YYYY-MM-DD | Not stated (disclosed YYYY-MM-DD)}
- **Attack type:** {e.g. Ransomware}
- **Vulnerable component:** {the exploited element}
- **Attacker:** {name or group, with the source's hedging}
- **Attacker origin:** {country, as the source states it}
- **Target:** {the organization}
- **Target country:** {country}
- **Target size:** {as stated}
- **Industry:** {sector}
- **CVEs:** {CVE-YYYY-NNNN, CVE-YYYY-NNNN | None (what the source says) | Not stated}
- **Accounts compromised:** {as stated, at the source's precision}
- **Business impact:** {one sentence}
- **Root cause:** {the cause or conditions the source gives | Not stated; {what the source reports about the entry path, and what it leaves open}}

### Analysis

- **ATT&CK techniques:**
  - T1190 Exploit Public-Facing Application: {the reported behavior it maps to}
- **Atomic Red Team tests:**
  - T1190: {run against which system or control in this incident, whether atomics cover it or a labeled manual check stands in; what a pass and a fail would each show}
- **Remediation:** {the one action}
- **Action plan:**
  1. {step}
  2. {step}
- **Lessons learned:** {what this teaches}

**Sources:** {publisher and date of each report used}
```

Any field the source leaves empty reads `Not stated`; a field the source says is absent reads `None (…)`; conflicting reports read as each version with its source. When the source describes too little to map, `**ATT&CK techniques:**` and `**Atomic Red Team tests:**` each read `Not enough detail in the source` on their own line with no sub-bullets. A source with no incident is the single line `**No incident reported:** {what the source is instead}`.

## References

- Upstream: `Patterns/analyze_incident/system.md` (a fixed field list for hack articles, with MITRE ATT&CK, Atomic Red Team, remediation and lessons learned).
- `Tools/AnalyzeIncidentCheck.help.md`: the checker's rules and exit codes.
