# ReportFinding

One security finding, ready to paste into an assessment report: written fresh from notes, a title, tool output or a source, or an existing draft finding rewritten into a better one.

Our ideal-state port of Fabric's `create_report_finding` and `improve_report_finding`. The upstream patterns stay in `Patterns/` for reference; this intent replaces them whenever a request asks for either one, so the old prompts never run.

## Ideal State

- The finding delivers what the principal wants from this input. That read is worked out before writing, never asked for, and never a literal restatement of the words typed. The read follows what the input is. Pasted notes, a title with a short explanation, or raw tool output (a scanner line, a request and response, a port scan) mean a new finding built from those facts. A pasted draft finding means that finding improved. A file means the same as its contents pasted. A URL (an advisory, a CVE entry, a public write-up) or a YouTube link (a talk or demo) means a finding for the vulnerability the source describes, using only the facts the source gives. A bare vulnerability name or class ("missing HSTS", "IDOR on invoices") means a complete finding for that issue, with every engagement-specific fact left as a bracketed placeholder. A question about an issue ("is a missing SPF record a finding?") means the finding that answers it, with the severity carrying the answer. "This" or "that" means the issue the conversation just found. A typed hint ("for an executive audience", "it's internal only", "rate it High", "add a Trends section") overrides the default read.
- The mode follows the request's wording. "Improve", "rewrite", "polish", "clean up", "tighten" or `improve_report_finding` applied to an existing finding means improve mode. Everything else, including `create_report_finding`, is create mode, and create mode is the default. An input that is already a written finding (it carries its own description, risk or recommendation text) is improved even when the request just says "make this a finding". Both modes deliver the same finding, in the same sections.
- In improve mode every fact in the draft survives: hosts, URLs, parameters, payloads, versions, CVE and CWE identifiers, evidence and the tester's observations. A technically wrong claim in the draft is corrected in the text, and a severity the draft's facts do not support is re-rated, with the Risk prose giving the reason from the facts. The finding reads as the final version a client receives: it never mentions the draft, the earlier rating or what was changed.
- The title names the weakness and where it lives ("Reflected Cross-Site Scripting in the Search Parameter"), never a bare class name when the input says where.
- The Description says what is wrong, where, and how it was shown, in prose a client engineer can act on. It uses the input's own specifics (endpoint, parameter, version, the observed response) and can carry the evidence as a fenced block.
- The Risk section opens on a severity of Critical, High, Medium, Low or Informational. The prose after it says who can exploit the issue, what they need first, and what they gain, so the rating follows from facts the input supports. A CVSS v3.1 vector appears on the severity line only when the input fixes every base metric.
- The Recommendations are actions for this finding. The fix that removes the cause comes first, then defense in depth and how to confirm the fix. The list is as long as the finding needs, never padded to a count, and no two items open on the same words.
- The References are 1 to 5 named links to sources that exist at that address: OWASP pages, CWE entries, vendor advisories, standards. Each one is about this issue, this technology or its fix. Fewer real references beat more doubtful ones.
- The One-Sentence Summary states the finding and why it matters in plain words, in under 25 words, so a reader who sees only that line knows what to fix.
- The words are plain and exact. Each sentence is specific to this finding, and a line that would fit most other findings of the same class ("This could lead to serious consequences") is cut.
- `bun skills/Fabric/Tools/ReportFindingCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the shape is checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never an invented engagement fact: no hostname, IP, endpoint, parameter, account, version, payload, date or data exposure the input did not give. A fact the finding needs and the input lacks is a bracketed placeholder (`[affected host]`, `[date tested]`).
- Never an impact the evidence does not show, stated as having happened: a reflected payload is not "customer data was stolen".
- Never a reference URL made up to look plausible, or a deep link to a page that cannot be vouched for.
- Never a severity of High or Critical on an issue whose Risk prose describes only limited, preconditioned impact, and never a downgrade that drops a stated impact without saying why.
- Never a draft fact dropped in improve mode, and never commentary on the draft, inside the finding or around it ("I tightened the description…", "The draft rated this High").
- No bold or italics, no numbered lists, no code fence around the whole output, and no warnings, notes or text outside the finding.
- Never upstream's Trends or Quotes sections unless the request asks for them. They were extract-wisdom leftovers, and a finding written from a two-line note has nothing to quote.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-reportfinding — code checks on sections, the severity line, references and summary length, plus judged checks on fidelity to the input, invented facts, severity reasoning and specificity.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The finding material: pasted notes, a title with a short explanation, tool output, a draft finding, a file path, a URL, a YouTube link, a bare vulnerability name or a question, or "this"/"that" for the issue the conversation found. Sources are read in full; `Intents/ExecutePattern.md` § Tool contract covers fetching YouTube links and URLs.
- Optional hints: audience, environment (internal or external), a severity the tester has set, or extra sections wanted.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/ReportFindingCheck.ts <file|-> [--extra Name[,Name]] [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| Request | Flag |
|---------|------|
| Default: the five sections only | (none) |
| The request asks for extra sections, such as upstream's Trends or Quotes | `--extra Trends,Quotes` |
| A machine-readable verdict is wanted | `--json` |

## Output format

```markdown
# {Weakness} in {where it lives}

## Description

{Prose: what is wrong, where, how it was shown. Evidence as a fenced block when the input has it.}

## Risk

Severity: {Critical|High|Medium|Low|Informational}[ (CVSS:3.1/… when every base metric is known)]

{Prose: who can exploit it, what they need, what they gain.}

## Recommendations

- {The fix that removes the cause}
- {Defense in depth, or how to confirm the fix}

## References

- [{Name of the page}]({https URL})

## One-Sentence Summary

{One plain sentence, under 25 words.}
```

Extra sections the request asked for go after One-Sentence Summary as further `##` sections.

## References

- Upstream: `Patterns/create_report_finding/system.md` (a finding from a title and brief explanation, with Description, Risk, Recommendations, References, One-Sentence-Summary, Trends and Quotes).
- Upstream: `Patterns/improve_report_finding/system.md` (the same sections, rewriting a finding taken from a penetration test report).
- `Tools/ReportFindingCheck.help.md`: the checker's rules and exit codes.
