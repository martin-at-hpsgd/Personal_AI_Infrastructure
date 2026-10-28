# Interview

Status: test -f ~/.claude/LIFEOS/TOOLS/InterviewScan.ts && echo ok · optional

## What it does

Interview walks the TELOS, constitutional and CURRENT_STATE / IDEAL_STATE files, checks each claim's freshness, and confronts stale claims with locally landed evidence (sleep and heart data, app-focus time, the work registry, git, the expense ledger). It drafts corrections the principal ratifies one at a time. On a fresh install it runs first-time setup (identity, voice, credentials, first project, work repo) before any check-in. It needs nothing beyond a LifeOS install; evidence sources that are not configured are reported as not live, and their claims are asked rather than checked.

## Fill in

Optional. Preferences go in `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interview/PREFERENCES.md` under your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`). The release template carries the shape.

| Key | Where | Default when absent | What it changes |
|-----|-------|---------------------|-----------------|
| `## State check-in priority` | `PREFERENCES.md` | every journal dimension asked with equal weight, stale ones first | names the one journal dimension (for example E for energy) the wrap asks first and never skips |

`History.md` in the same directory is optional reference for your own interview history; the skill never reads it at run time.

## Accounts and secrets

None for the skill itself. Evidence comes from files other LifeOS pieces already land (health sync, Conduit, the work registry); each has its own setup.

## Prove it works

```bash
bun ~/.claude/LIFEOS/TOOLS/InterviewScan.ts --json | jq '.targets | length'
```

Success: a number greater than zero. Then type `/interview`. Success is an opening that names a specific stale claim (or, on a fresh install, the six setup steps) rather than a blank questionnaire.
