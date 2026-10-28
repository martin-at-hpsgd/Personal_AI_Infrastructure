# QuickCheck

Fast audit of a single file or rule set.

## Ideal State

- The report covers every rule or instruction in the given target: the file itself when a file path is given or the file is already in context, or the provided text when the rules are inline.
- Each rule is first sorted by kind under SKILL.md § The First Sort; preferences are kept, and prescriptive steps that are not keep-classes are cut or rewritten as the outcome they protect.
- Each rule carries a verdict from the six questions in SKILL.md, with findings named for rules that restate Claude's default behavior, are vague enough that they'll be interpreted differently each time, or look like they were added to fix one specific bad output.
- The report is concise and follows the Output format below: the file (path or "inline"), the count of rules found, the keep/cut/sharpen verdict counts, and every Cut, Sharpen and Keep rule with its reason, how, or why.

## Anti-criteria

- No report omits the File, Rules found, or Verdict counts lines of the Output format.

## Output format

```
**File:** [path or "inline"]
**Rules found:** [count]
**By kind:** [N] preferences · [N] steps · [N] gotchas · [N] tool contracts
**Verdict:** [X] keep, [Y] cut, [W] rewrite, [Z] sharpen

### Cut
- [rule] — [reason]

### Rewrite as outcome
- [step] → [the outcome it protects]

### Sharpen
- [rule] — [how]

### Keep
- [rule] — [why]
```

## Inputs

User provides either:
- A file path to audit
- A block of rules/instructions to evaluate
- "check this file" with a file already in context
