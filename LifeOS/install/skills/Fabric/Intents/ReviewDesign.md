# ReviewDesign

A review of a software architecture design: a verdict with its reason, findings with severity, evidence and a specific fix across seven areas (components, external integrations, security, performance and resilience, data, maintainability, the document itself), the assumptions the review rests on, and a closing summary of the design's strengths and its highest-impact changes, ranked.

Our ideal-state port of Fabric's `review_design`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

## Ideal State

- The review delivers what the principal wants from this input, inferred before writing and never asked for. A pasted artifact (a design document, an RFC, an architecture note, a diagram in Mermaid or PlantUML, a deployment description, a README that describes a system) means a review of that design, built from that text. A URL or a file means the same for what it holds, read in full, and a diagram in it is read as part of the design. A bare topic or system kind ("a URL shortener", "event sourcing for an order system") means a review of the typical design of that kind of system, with a `Source:` line saying what the review draws on. A question about a design ("is one Postgres instance enough for this?") gets the full review with its direct answer in an `Answer:` line. "This" or nothing means the design under discussion in the conversation. An input with two or more designs gets one review per design. An input with no design in it (a recipe, a poem, a bug report with no system described) gets the single line `No design:` saying what the input is instead. A typed hint ("security only", "for the CTO", "just the data layer", "brief") overrides the default read and narrows or reshapes the review to what it names.
- The verdict leads and the ranked changes close. The line under the heading is `Verdict:` with one of `Sound`, `Sound with changes` or `Needs rework`, then one or two sentences naming what decides it. The verdict follows from the findings: `Needs rework` when any finding is Critical, `Sound with changes` when the worst finding is High or Medium, `Sound` when nothing is worse than Low. A design that holds up is called `Sound` without hedging. The review ends on its conclusion, as the upstream pattern does: the strengths, then the most critical changes, so the last thing a reader sees is what to do first.
- Severity means the same thing on every review. Critical: the design as written will lose or expose data, fail under its own stated requirements, or cannot be built as described. High: a likely failure or serious weakness under realistic load, attack or growth, to fix before launch. Medium: a real weakness with a contained blast radius or an easy workaround. Low: polish, clarity or a cheap hardening step.
- The most critical changes are one to five actions ranked by impact, each naming its area, the first answering the worst finding in the review. Each one is the fix of a finding above, stated as the action to take, never a new finding introduced at the end.
- Strengths name what the design gets right and where, specific to this design ("the outbox table makes order events survive a broker outage"), never praise that fits any design. A strength, a `No issues:` line and the `Answer:` line claim no more than the findings allow: when a finding shows data can be lost, exposed or applied twice, nothing elsewhere credits the design with a guarantee that rules it out ("cannot lose data", "fully isolated"), and a strength that a finding qualifies names that limit.
- Each of the seven areas carries its findings, worst first. Architecture and components covers each component's responsibility, the interactions between them, redundancy and needless complexity, and whether the split itself is right (what should merge, split or move), so every component the design names is weighed somewhere in the review. External integrations covers every outside system and client for security, performance and reliability. Security covers authentication, authorization, secrets, data protection and the attack paths the design opens. Trust follows who can write a piece of content, not where it is stored: when a component acts on content (a language-model agent reading tickets, mail, wiki pages, repository files or tool output; a template renderer; a job runner taking parameters), anything a user, customer or outside party can write is untrusted input even after it lands inside the system, and the review traces each such source to what that component is allowed to do. Performance, scalability and resilience covers bottlenecks, horizontal scaling, rate limits and what fails when each component fails. It follows each path a request, event or job takes and says what happens when a step fails partway: retries, duplicate or out-of-order delivery, lost messages, half-finished writes, and work in flight when a process dies. Data management covers storage, data flow, consistency and, when the system serves several clients or tenants, their isolation. Maintainability and growth covers modularity, deployment, onboarding a new client or feature, and what the next order of magnitude breaks. Document readability covers inconsistent terms, components that appear in a diagram but not the text or the reverse, and the passages that need a rewrite.
- Every finding names its evidence: words quoted exactly from the design, `Not stated` when the design is silent on something it needs (no failover described is itself a finding), or, for a bare topic, `Common practice` and the fact relied on. Every finding ends on a fix specific enough to act on: what to change, in which component, to what. A control that must always hold (read-only access, tenant isolation, a spending cap, an allowlist of actions) goes in the layer that enforces it, such as database privileges, the platform's permissions or a network boundary, never in a code convention that one missed call breaks. When the platform the design names cannot enforce it (a datastore with no per-role privileges, an all-or-nothing binding), the finding says so plainly and the fix uses what can, such as a separate store or a narrow service that exposes only the allowed operations.
- An area with nothing wrong says `No issues:` and why it holds up, naming the part of the design that does it. An area the design does not touch says `Not applicable:` and why; a bare topic has no document, so its Document readability is `Not applicable:`. Neither is padded with filler findings.
- Every fact the review rests on that the design does not give (expected load, team size, data sensitivity, the cloud it runs on) appears under Assumptions as `Assumed:`, and the facts the design gives that decide a finding appear as `Stated:`, so the reader can correct a wrong one.
- Words are plain and exact: "two app servers write the same counter, so concurrent requests lose updates" over "potential concurrency-related data integrity concerns".
- Sources are read in full before any review (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- `bun skills/Fabric/Tools/ReviewDesignCheck.ts` passed on the exact output before it was delivered, with `--source` pointing at the supplied design text when there was one. Where no shell is available, the sections, finding lines, severity order, verdict consistency and quotations are checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a component, technology, setting or guarantee credited to the design that the input does not give, never a stated fact made stronger in the retelling ("over HTTPS" read as "HTTPS end to end"), and never a quotation that does not appear in the supplied text. A Fix may propose a technology the design does not use; that is a proposal, not a credit.
- Never a guarantee the review's own findings contradict, such as a strength saying the design cannot lose data beside a finding where a failed step drops an event, and never a fix that relies on a control the named platform does not offer or on a code convention standing in for an enforced one.
- Never the ranked changes placed anywhere but the end of the review, and never a ranked change with no finding behind it.
- Never a verdict that contradicts the findings, such as `Sound` beside a Critical finding, or `Needs rework` when nothing is worse than Medium.
- Never a generic finding or fix that would fit any design ("ensure proper security measures", "consider scalability", "follow best practices"); each one names the part of this design it is about.
- Never a finding the design already answers, such as asking for TLS when the design states TLS.
- Never filler findings added so that every area has something to say.
- Never a filled-in review for an input with no design in it.
- Never a source reviewed from its title or a fetched page summary instead of its full text.
- No bold or italics anywhere, no preamble, and no commentary, warnings or notes outside the review.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-reviewdesign — code checks on the heading, verdict line, the seven areas, the closing strengths and ranked changes, finding lines and the no-design line; judged checks on findings tied to this design, no invented facts, a verdict that follows the findings, and fixes specific enough to act on.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: a pasted design document, RFC, architecture note or diagram, a URL, a YouTube link, a file path, a bare system kind, a question about a design, or "this"/nothing for the conversation's subject. A URL or video is read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- An optional hint narrowing the review (areas, depth) or naming its reader.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/ReviewDesignCheck.ts <file|-> [--source <design-file>] [--json]
#   exit 0: shape and verdict consistency hold; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| (any full review) | `<file>` or `-` | Check the saved draft or stdin |
| (a design text was supplied) | `--source <file>` | Also require every quoted evidence string to appear in that text |
| (piping the result to another tool) | `--json` | Print `{ok, noDesign, reviews, problems}` |

A hint-narrowed review (only some areas asked for) skips the check, since its shape is the hint's.

## Output format

One block per design, separated by a blank line. Plain Markdown: headings, list markers and inline code only, no bold or italics. `Source:` appears only when no design text was supplied; `Answer:` only when the request asked a question. The seven area headings appear in this order with these exact words, each followed by at least one bullet.

```markdown
# Design review: {the system under review}

Verdict: {Sound | Sound with changes | Needs rework}. {one or two sentences naming what decides it}

Source: {what the review draws on when no design text was supplied}

Answer: {the direct answer to the question asked}

## Architecture and components

- {Critical | High | Medium | Low}: {the finding and what it causes}. Evidence: {"words quoted from the design" | Not stated | Common practice, the fact}. Fix: {the specific change}

## External integrations

- No issues: {why this area holds up, naming the part of the design that does it}

## Security

## Performance, scalability and resilience

## Data management

## Maintainability and growth

## Document readability

- Not applicable: {why the design does not touch this area}

## Assumptions

- Stated: {a fact the design gives that decides a finding}
- Assumed: {a fact the review rests on that the design does not give}

## Strengths

- {what the design gets right, and where}

## Most critical changes

1. {Area}: {the change, ranked by impact}
```

Findings in an area run worst first. A `No issues:` or `Not applicable:` bullet is the only bullet in its area. The review always ends on Strengths and then Most critical changes. The most critical changes hold one to five numbered items ranked by impact, each opening on one of the seven area names. An input with no design is the single line `No design: {what the input is instead}`.

## References

- Upstream: `Patterns/review_design/system.md` (an expert solution architect's review of an architecture design across eight areas: architecture clarity and component design, external system integrations, security architecture, performance, scalability and resilience, data management and storage security, maintainability and future growth, potential risks and improvements, and document readability, concluding with the design's strengths and the most critical changes, in plain Markdown with no bold or italics).
- `Tools/ReviewDesignCheck.help.md`: the checker's rules and exit codes.
