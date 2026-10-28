# HillClimb

**Contents:** What it does · Fill in · Accounts and secrets · Prove it works

Status: `bun ~/.claude/skills/HillClimb/Tools/HillClimb.ts help` · optional

## What it does

HillClimb improves a LifeOS target (a skill, workflow, eval, ISA, prompt, rule or code metric) by experiment: it surveys real misses, draws changes from varied proposers, keeps only what held-out measurement supports, and records each climb in its own ledger. It runs with no configuration; the two optional USER files below only switch on install-specific behaviour and keep install history.

## Fill in

### `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/HillClimb/PREFERENCES.md`

Optional. Without it, `Intents/Ideate.md` runs with its defaults and no optional behaviour. The skill reads it as prose before running Ideate; there is no fixed schema. Each entry names one optional behaviour, who asked for it and when, and their words behind it. Delete an entry to turn its behaviour off.

```markdown
# HillClimb preferences

- **The DA ideates first (Alex Example, 2026-01-15).** Before any proposer roster runs, the DA reads the train misses itself and persists its own generation.
```

| Entry | Meaning |
|-------|---------|
| `The DA ideates first` | Before Ideate's proposer roster runs, the DA reads the train misses and records its own generation of candidate changes, which then enters the pool like any proposer's. Off when absent. |

The installer puts a placeholder copy at `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/HillClimb/PREFERENCES.md`; if it is missing, `bun ~/.claude/skills/LifeOS/Tools/ScaffoldUser.ts --apply` copies any missing starter file into place and never overwrites one you have edited.

### `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/HillClimb/History.md`

Optional, free-form. The full stories behind the skill's dated gotchas for this install (which climb, which repos, which scores). The skill reads it only when a climb looks like one of them and runs the same without it.

### Climb ledger

Created on first use at `$HILLCLIMB_DIR`, else `~/.claude/LIFEOS/MEMORY/STATE/HillClimb/<climb-id>/`. Nothing to fill in.

## Accounts and secrets

None of its own. Climbs that measure with Assay suites or proposers on other vendors use those systems' existing credentials.

## Prove it works

```bash
bun ~/.claude/skills/HillClimb/Tools/HillClimb.ts help
```

Success prints the command list and exits 0.
