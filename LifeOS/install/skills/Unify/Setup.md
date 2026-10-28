# Unify

Status: `test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Unify/Config.md && echo configured` · optional

## What it does

Unify checks whether a set of things pulls in the same direction. Give it systems, rules, skills, goals, documents or plans and it extracts each one's principles and aim, finds where they reinforce, trade off on purpose, duplicate or contradict each other, and recommends a short ranked list of changes. It only reads and recommends; it never edits. With no inputs named it analyzes your whole LifeOS install, and for that it needs a small config file naming the default set and the goal that set is judged against. It needs no accounts or keys.

## Fill in

One file. Without it, Unify still works when you name the inputs; with no inputs it stops and points here.

`~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Unify/Config.md`, smallest working version:

```markdown
Summit for the default LifeOS set:

The One Loop: move the user from current state to ideal state, and measure every step. Source: `LIFEOS/LIFEOS_SYSTEM_PROMPT.md` § The One Loop.

Default input set (no inputs named):

- `LIFEOS/LIFEOS_SYSTEM_PROMPT.md`
- `CLAUDE.md`
- `LIFEOS/DOCUMENTATION/CoreComponents.md`

Standing exclusions:

None yet.
```

| Label | Meaning |
|---------|---------|
| Summit | What the whole set exists to achieve, with the file that says so. Every relationship is judged against it. |
| Default input set | Paths of the constitution, doctrine and component docs analyzed when you name nothing. Add more as your install grows; `bun ~/.claude/LIFEOS/TOOLS/SystemContext.ts list` shows what exists. |
| Standing exclusions | Paths or topics to skip every run. |

## Accounts and secrets

None. Unify uses only files on disk and the thinking skills (FirstPrinciples, Superior, SystemsThinking) that ship with LifeOS. Nothing goes in `~/.claude/.env`.

## Prove it works

```bash
test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Unify/Config.md && echo configured
```

Success prints `configured`. The skill's report checker confirms the shipped code runs:

```bash
bun ~/.claude/skills/Unify/Tools/CheckReport.ts --help
```

Success prints the line `Usage: bun skills/Unify/Tools/CheckReport.ts <report.md> [--max-recs N] [--json]` and exits 0. After a real run, pass the saved report to the same tool to check its shape. Then ask your assistant, "Unify the three files `CLAUDE.md`, `LIFEOS/LIFEOS_SYSTEM_PROMPT.md` and `LIFEOS/DOCUMENTATION/CoreComponents.md`" (named inputs, so it works even without Config.md). A working run answers with the eight-part report starting at "The verdict" and ending with a lens trail, and it edits nothing. With the Config.md present, "Run Unify" with no inputs analyzes the default set.
