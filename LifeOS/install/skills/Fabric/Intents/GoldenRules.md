# GoldenRules

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

The few non-negotiable rules that, followed, prevent most of the problems in a codebase, a team practice or a domain, each one specific, explained, shown right and wrong, and checkable, ranked Critical, Important or Guideline, with a quick-reference table and a pre-merge checklist.

Our ideal-state port of Fabric's `create_golden_rules`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The rules give what the principal actually wants from this input, inferred before a word is written and never asked for. The read follows what the input is. A pasted artifact means the rules it states and the conventions it follows without stating them: code or a diff yields the conventions the code keeps, a style guide or contributing guide yields its rules checked against any code beside it, review comments yield the rules reviewers keep enforcing, and a postmortem or incident record yields the rules that would have prevented it. A URL or a file means the same for the source it points at, read in full. A directory or repository path means the conventions its code actually follows, read from the code together with its own docs and configs (README, contributing guide, lint, format and CI settings). A bare topic or domain ("database schema migrations", "on-call handoffs") means the rules a seasoned practitioner of it would enforce, the settled ones only. A question ("what rules should our deploys follow?") means the rules that answer it. "This" or "that" means the rules the current conversation settled on, plus the ones its mistakes teach. A typed hint (a domain such as "security only", an audience such as "for new hires", or "critical only") overrides the default read.
- The title names the subject and the read that was inferred ("Golden Rules: A Fictional Payments API, From Its Code and Contributing Guide", "Golden Rules: Database Schema Migrations, Practitioner Consensus"), so a wrong read is visible at a glance.
- Each rule is one or two sentences in plain exact words, specific enough that a reviewer could point at a line and say it breaks the rule ("Every handler validates its request body with the route's zod schema before reading it", never "Validate inputs properly"). It keeps the input's own names, paths, tools, thresholds and figures.
- Each rule's Why names the concrete consequence of breaking it in this subject (the outage, the leak, the corrupted record, the wasted review cycle), never a restatement of the rule.
- Each rule's Do and Don't are a matched pair that differ only in the point the rule makes: code in the input's own language and idiom when the subject is code, and a short concrete example of the practice when it is not.
- Each rule's Test says exactly how compliance is checked: a lint rule, a command, a test, a CI gate, a grep, or a yes-or-no review question a reviewer can answer from the diff. A rule nobody could check is rewritten until it can be or left out.
- When the input is a source, every rule carries a Basis line that says where it comes from: `Stated in` the place the source says it, or `Observed in` the places the source shows it (a convention seen in code shows in at least two places, both named), or, for an incident record, `Observed in` the failure it would have prevented. A bare topic, a question or the conversation carries no Basis lines.
- The rules are ranked ruthlessly. Critical rules are the few whose breach causes serious harm (security, data loss, outages, broken releases), at most five and at least one. Important rules cause friction or debt when broken. Guidelines are good practice a reviewer may waive with a reason. A tier with no rules is left out. Within a tier the rule that prevents the most harm comes first, rules are numbered once across the whole document, there are at most 15 in all, and no two say the same thing. A source that supports four rules gets four; the list is never padded.
- Every rule is specific to this input. A rule that would fit most other codebases or teams just as well ("Write clean code", "Communicate clearly", "Follow best practices") fails.
- The Quick Reference table has one row per rule in document order, its number, category, a short form of the rule and its tier. The Checklist turns the rules into boxes a person ticks before a commit, merge or deploy, each citing the rules it checks, and every Critical rule is cited by at least one box.
- When the input supports no rule at all, the output is the title and the single line `No golden rules found in {the source}.`, and nothing else.
- When the input is a source, the rules are the ones it states or shows, read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs). For a bare topic, every rule is one practitioners of the field actually hold; nothing is attributed to a named authority and no figure appears that the model cannot stand behind.
- `bun skills/Fabric/Tools/GoldenRulesCheck.ts` passed on the exact output before it was delivered, with `--source` when the input was a source. Where no shell is available, the shape is checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a clarifying question in place of the rules. The model takes the default read and the title states it.
- Never a rule attributed to a source that the source neither states nor shows, never a Basis line that cites a place in the source that says or shows something else, and never a stated rule reported as followed when the code beside it breaks it.
- Never a secret, key, token, password or personal detail from the input copied into an example. A Don't example that needs a credential uses an obvious placeholder (`sk_live_EXAMPLE`).
- Never a generic best practice the input does not support, never a platitude posing as a rule, and never filler added to make the list longer.
- Never more than five Critical rules, never a style preference ranked Critical, and never an empty tier heading.
- Never a persona, a preamble, an explanation of the method, tier boilerplate ("These MUST be followed"), a closing summary, or any text outside the sections in § Output format.
- Never a source read from its title or a fetched page summary instead of its full text.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-goldenrules — code checks on the title, tiers, rule fields, Basis lines, the secret placeholder and the checklist, plus judged checks on the inferred read, fidelity to the source, specificity, ranking and checkable tests.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: a pasted artifact (code, a diff, a style or contributing guide, review comments, a runbook, a postmortem), a URL, a file or directory path, a bare topic or domain, a question about what rules to follow, or "this"/"that" for the current conversation.
- An optional hint naming a domain, an audience or a tier to keep, which overrides the default read.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/GoldenRulesCheck.ts <file|-> [--source] [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| (any golden-rules request) | `<file>` or `-` | Check the saved draft or stdin |
| (the input was a source: pasted artifact, URL, file, directory) | `--source` | Require a `Stated in` or `Observed in` Basis line on every rule |
| (piping the result to another tool) | `--json` | Print `{ok, rules, checklist, none, problems}` |

## Output format

Markdown. One H1 title, then the tier sections that have rules, then Quick Reference and Checklist, with nothing else. These are the limits the checker enforces:

- The title opens `# Golden Rules: ` and names the subject and the read.
- The H2 sections are, in this order, `## Critical Rules` (required), `## Important Rules` and `## Guidelines` (each only when it has rules), `## Quick Reference`, `## Checklist`.
- Each rule is an H3 `### {n}. {Rule name}` of 2 to 10 words, numbered 1 to N once across the document; 1 to 5 Critical, 1 to 15 in all.
- Each rule carries, in order, `**Rule**:` (one or two sentences, at most 40 words), `**Why**:` (one or two sentences), `**Basis**:` (with `--source`, opening `Stated in` or `Observed in`), `**Do**:`, `**Don't**:` and `**Test**:`. Do and Don't each hold either text on the same line or a fenced block on the lines below, never empty, never identical.
- The Quick Reference table is `| # | Category | Rule | Priority |`, one row per rule in order, Priority `Critical`, `Important` or `Guideline` matching the rule's tier, and a Rule cell of at most 12 words.
- The Checklist is 1 to 15 `- [ ] ` boxes, each ending by citing the rules it checks, such as `(#1, #3)`, citing only rules that exist, with every Critical rule cited at least once.
- No other heading, and no text between the title and the first tier.

````markdown
# Golden Rules: {the subject, and the read inferred}

## Critical Rules

### 1. {Rule name}

**Rule**: {one or two sentences, specific and checkable}

**Why**: {the concrete consequence of breaking it here}

**Basis**: {Stated in … | Observed in … — source inputs only}

**Do**:
```{language}
{the right way}
```

**Don't**:
```{language}
{the wrong way, secrets as placeholders}
```

**Test**: {the lint rule, command, test, CI gate or review question that checks it}

## Important Rules

### 2. {Rule name}
…

## Guidelines

### 3. {Guideline name}
…

## Quick Reference

| # | Category | Rule | Priority |
|---|----------|------|----------|
| 1 | Security | {short form} | Critical |
| 2 | Style | {short form} | Important |
| 3 | Process | {short form} | Guideline |

## Checklist

- [ ] {a check a person ticks before merge or deploy} (#1)
- [ ] {another check} (#2, #3)
````

With no rule in the input:

```markdown
# Golden Rules: {the source}

No golden rules found in {the source}.
```

## References

- Upstream: `Patterns/create_golden_rules/system.md` (an "expert at extracting rules" persona and six analysis steps; Critical, Important and Guideline tiers, each rule with Rule, Why, Do, Don't and Test, a Quick Reference table and a checklist; this intent keeps all of those, numbers rules once across the document, adds the Basis line for sources, and ties each checklist box to the rules it checks).
- `Tools/GoldenRulesCheck.help.md`: the checker's rules and exit codes.
