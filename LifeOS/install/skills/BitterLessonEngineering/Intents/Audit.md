# Audit

Full audit of all force-loaded AI instructions for over-prompting.

## Ideal State

- The report covers every force-loaded instruction source named under Inputs, and each file was read completely, with its total lines and rules counted.
- Every rule found is sorted by kind under SKILL.md § The First Sort, and the report states the count of each kind before any verdict.
- Every rule found carries a verdict from the six questions in SKILL.md, judged against what Claude Code's current built-in system prompt and model already do.
- Every prescriptive step that is not a keep-class leaves as CUT or as a REWRITE that states the outcome it protects in the rule's own place, keeping its tool contracts.
- The report lists, across all files, the same concept stated differently in two places, rules that contradict each other, and outdated references (skill names, file paths, tool names).
- Each force-loaded file carries an estimate of how many tokens it consumes, how often its content actually affects output quality, and whether it could be on-demand (via the CLAUDE.md routing table) instead of always-loaded.
- The report follows the Output format below, including estimated token savings.
- Trimmed versions of the files are offered after the report.

## Anti-criteria

- No trimmed version removes or rewrites a rule the report did not give a CUT, REWRITE, RESOLVE, MERGE, SHARPEN or MOVE verdict.
- No preference is cut because it is old, long, rarely triggered or scored low in an ablation.

## Output format

```
## BitterLessonEngineering Audit

**Scope:** [what was audited]
**Files read:** [count]
**Rules evaluated:** [count]
**By kind:** [N] preferences · [N] prescriptive steps · [N] gotchas · [N] tool contracts · [N] safety/output contracts

### CUT (restating defaults, or steps a smarter model does not need)
- [rule] — [reason]

### REWRITE as outcome (prescriptive steps)
- [step] → [the outcome it protects]

### MOVE to tool (gotchas a tool can prevent)
- [gotcha] — [the tool that should make it impossible]

### RESOLVE (contradictions)
- [rule A] vs [rule B] — [which to keep and why]

### MERGE (redundancies)
- [locations] — [merge into where]

### EVALUATE (one-off fixes)
- [rule] — [still needed? verdict]

### SHARPEN or CUT (vague)
- [rule] — [sharpen how, or cut why]

### MOVE to on-demand
- [content] — [how often it's actually needed]

### KEEP (carrying weight)
- [rule] — [why it matters]

**Estimated savings:** [lines] lines, ~[tokens] tokens
```

## Inputs

The force-loaded instruction sources:
- The appended system prompt: the file `--append-system-prompt-file` names (in LifeOS, `LIFEOS/LIFEOS_SYSTEM_PROMPT.md`), usually the largest source.
- CLAUDE.md, the native instruction file, and every file it `@`-imports.
- `settings.json` `dynamicContext` sections: learning, advisory, work summaries. <!-- public PR #2008, @jbmml -->
- The skill listing: every installed skill's `description`, loaded each session.
- Project-level CLAUDE.md files, when working in a specific project.

## Safety gates

- Approval is per file: no audited file is edited until the user approves that file's trimmed version, and approving one file does not cover the others.
