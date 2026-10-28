# SigmaRules

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Gotchas · Output format · References

Sigma detection rules, as valid YAML a detection team can load, for the attacker behavior in a threat report, an article, an advisory, a log sample, a named technique or a question about catching one.

Our ideal-state port of Fabric's `create_sigma_rules`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The rules catch what the principal wants caught from this input, inferred before any rule is written and never asked for. A pasted threat report, article or advisory means a rule for each distinct step it describes that a log in scope can see: every process it runs, every file it drops or creates (`file_event`, `TargetFilename`), every registry change and every connection it reports (`network_connection`, `dns_query`). Sysmon records outbound connections, DNS lookups and file writes on the host, so a reported connection to an address is endpoint-visible and gets a rule, never a Not covered line. A URL or file means the same for that source, read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs). A named technique or tool ("LSASS dumping", "T1490", "rclone exfiltration") means rules for the ways attackers actually carry it out. A question ("how would I catch a new local admin being added?") means rules that answer it. A log sample or IOC list means rules that match that activity. "This" means the TTPs in the current conversation. The default telemetry is host-based Windows logging (Sysmon, PowerShell script block logs, Security, System and Application). A typed hint ("for Linux auditd", "Okta", "cloud") overrides it, and a TTP that only happens on another platform uses the logsource where it actually shows up.
- Every rule traces to its input. Its `description` names the behavior it catches as the source describes it, and its selections use the command lines, file names, paths, registry keys, parent-child chains, task names and named pipes the source gives. A rule that would fit most other reports as well (a generic "Suspicious PowerShell" rule for a report about a comsvcs MiniDump) fails.
- When the source states how a step ran, the rule matches that form and nothing it did not state. The selection tolerates what an attacker varies without changing the technique (flag order, `-` or `/` through `|windash`, case, a renamed binary caught by `OriginalFileName`), but adds no other tool, flag or method: a report of `certutil -urlcache -split -f` gets no `-verifyctl` selection, and a report that names the dropped file gets no guess at how it was downloaded. The common forms of a technique are for inputs that name it without saying how it ran (a named technique, a question, a report that only says "they dumped credentials"), and the description then says the rule covers its common forms.
- Each rule uses the telemetry that records the step as the source describes it. No rule for activity the source does not report, and none that depends on telemetry the source gives no reason to expect: no `ps_script` rule for a script body the source never shows, no `dns_query` rule for a domain it never names.
- Behavior rules come first; they survive the attacker renaming a file or moving a server. A distinctive IOC from the source (a unique task name, a mutex, a dropped file name) may anchor a behavior selection. Network indicators the source gives (a destination address, port or domain) also get their own indicator rule, never dropped: `network_connection` with `DestinationIp`, `DestinationPort` and `Initiated: 'true'`, or `dns_query` with `QueryName`, anchored on the process the source names when it names one. Its description says it is an indicator rule that ages as the infrastructure moves, its `falsepositives` names shared hosting or later reuse of the address, and its level is medium or lower unless the selection also carries the named process. An indicator rule never stands in for a behavior rule, and a hash alone is not a rule.
- Each rule is a valid Sigma document: YAML that parses, carrying `title`, `id` (a fresh random UUID per rule), `status: experimental`, `description`, `references` (the source URL when one was given), `date` (YYYY-MM-DD), `logsource`, `detection` with a `condition`, `falsepositives`, `level` and `tags`. `author` appears only when the requester names one.
- The detection is one a detection engineer would deploy. Every field exists in that logsource's events (`Image`, `CommandLine`, `ParentImage`, `OriginalFileName` for Windows process creation), every modifier is a real Sigma modifier, and the condition names only defined selections and uses every one. Executables match with `|endswith: '\name.exe'`, never a full install path. A filter excludes known-good activity wherever false positives are likely.
- `falsepositives` names the specific legitimate activity likely to trip this rule. `level` weighs how rare and how damaging the matched activity is against how firm the source's evidence is: confirmed credential dumping is high or critical and a broad admin tool rates lower, and a step the source reports thinly or as unconfirmed ("may have", "reportedly", one uncorroborated sighting) rates one step lower than it would if confirmed, with the description saying why.
- `tags` carry the ATT&CK tactic and technique the rule detects (`attack.credential_access`, `attack.t1003.001`), lowercase, and the technique is the one the source's evidence establishes. When the evidence fits more than one technique, the tag is the one that assumes least, never a narrower one the source does not show: archives sent to an address over HTTPS is `attack.exfiltration` with no `attack.t1041` (Exfiltration Over C2 Channel) unless the source says that address is the C2 server.
- The closing Not covered list names two things, each as one bullet with its reason: a TTP that no log in scope can see (an email lure, a password spray visible only at a VPN appliance), which gets no forced rule, and each place the source is too thin to pin a rule down (it never says how the payload arrived, or names an address but no process), naming the rule that limit narrows. It is left out when there is neither.
- `bun skills/Fabric/Tools/SigmaRulesCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the rules are checked against the same rules by hand, and nothing about the check appears in the output.

## Anti-criteria

- Never a rule whose YAML fails to parse, a condition naming a selection the detection does not define, or a key repeated inside one selection (the parser keeps only the last, which silently drops a match).
- Never a detail the source does not support: no command line, path, flag variant, download method or tool name presented as the source's when the source never gave it. When the source is vague about how a technique ran, the rule detects its common forms and its description says so; when the source is specific, the rule stays on what it gave.
- Never a network indicator the source gives dropped for being an IOC, and never an endpoint-visible connection, DNS lookup or file write listed under Not covered.
- Never a level or technique tag firmer than the source's evidence.
- Never the upstream example's ids, a placeholder value (`author: Your Name`), or a rule adapted from the example instead of written for this input.
- Never an aggregation pipe (`| count() by …`) in a condition; Sigma v2 moved aggregations to correlation rules.
- No preamble, explanation or summary outside the rule sections and the Not covered list.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-sigmarules — code checks on the section layout and Sigma fields, plus judged checks on fidelity to the source, behavioral detection, valid fields and conditions, the input-kind read, and a thin report kept to its evidence (no added variants, a caveated indicator rule, levels held down).
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- A threat report, news article, advisory or incident write-up, pasted, as a URL, or as a file path.
- A named technique, tool or ATT&CK id; a question about detecting something; a log sample or IOC list; or "this" for the current conversation.
- An optional hint naming the telemetry or platform ("Sysmon only", "Linux auditd", "Okta", "AWS CloudTrail").

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/SigmaRulesCheck.ts <file|-> [--json]
#   exit 0: every rule parses and holds the Sigma shape; exit 1: prints each failure with the rule's line and title
```

### Intent-to-Flag Mapping

| Need | Flag |
|------|------|
| Check the saved draft | `<file>` |
| Check piped output | `-` |
| Read failures per rule in code | `--json` |

## Gotchas

- The upstream example is not valid Sigma, so it is never a model to copy (read 2026-10-25). Its `filter` key has no colon, so the YAML does not parse. It matches PowerShell by full install path, and it writes `product: sysmon` where SigmaHQ rules write `product: windows` with a category such as `network_connection`.
- YAML treats a backslash inside double quotes as an escape, so `"C:\Windows\x.exe"` fails to parse. Write Windows paths in single quotes with single backslashes (`'\rundll32.exe'`), as SigmaHQ rules do.
- Bun 1.3.6's YAML parser, which the checker uses, rejects ` ... ` in the middle of an unquoted value (`description: forms such as echo '... curl ...'`). YAML 1.2 and the `yaml` package accept it, but the checker fails the rule. Single-quote any `description` that carries quotes, ellipses or command fragments; that form parses everywhere.
- PowerShell script block content is `category: ps_script, product: windows` with the field `ScriptBlockText`. It only exists when script block logging is on, so the `falsepositives` or `description` says so when a rule depends on it.

## Output format

````markdown
#### Sigma Rule: {title, identical to the YAML title}
```yaml
title: {title}
id: {fresh UUID}
status: experimental
description: {the behavior caught, as the source describes it}
references:
  - {source URL, when given}
date: {YYYY-MM-DD}
logsource:
  category: {category}
  product: {product}
detection:
  selection: {…}
  condition: {…}
falsepositives:
  - {specific legitimate activity}
level: {informational|low|medium|high|critical}
tags:
  - attack.{tactic}
  - attack.t{NNNN[.NNN]}
```
#### End of Sigma Rule

…one section per rule…

#### Not covered

- {a TTP no log in scope can see, and why}   (only when there is one)
- {where the source is too thin to pin a rule, and which rule it limits}   (only when there is one)
````

## References

- Upstream: `Patterns/create_sigma_rules/system.md` (host-based Sigma rules from a security news publication, each in its own titled section with a header and footer).
- `Tools/SigmaRulesCheck.help.md`: the checker's rules and exit codes.
