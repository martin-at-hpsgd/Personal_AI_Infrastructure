# Errata

Status: command -v gh >/dev/null && gh auth status >/dev/null 2>&1 && echo ok · optional

## What it does

Errata is the complaint ledger. `/er <text>` writes one line holding your own words and the context around them; `/er review` reads recent lines back; `/er triage` has a model enrich them and group them into upgrade records. Recording and reviewing work with nothing set up: the ledger folder is created on first use. Only the Send intent, which files feedback about LifeOS itself as a GitHub issue, needs the GitHub command-line tool signed in as you.

## Fill in

Nothing to write. Defaults you can move with environment variables:

| Setting | Default | Override |
|---|---|---|
| Ledger | `LIFEOS/USER/ERRATA/` under your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`) | `ERRATA_DIR` |
| Attachments | `~/.local/state/lifeos/errata/` | `ERRATA_STATE_DIR` |

Optional preferences go in `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Errata/PREFERENCES.md`.

## Accounts and secrets

- A GitHub account, only for Send. Install the GitHub CLI (`brew install gh`) and run `gh auth login`. Send files the issue under that login. It removes `GH_TOKEN` and `GITHUB_TOKEN` from the environment of its own `gh` calls, so a token left in your shell never swaps in a different account. It never contacts GitHub until you approve the exact text and its hash.
- Triage and the daily enrichment run a model on LifeOS's unattended lane, which is configured for the whole system, not for this skill. They do nothing and exit non-zero while `LIFEOS_INFERENCE_DISABLED` is set.
- No `~/.claude/.env` keys belong to this skill.

## Prove it works

```bash
gh auth status
bun ~/.claude/LIFEOS/ERRATA/Errata.ts stats --json | head -5
bun ~/.claude/LIFEOS/ERRATA/Errata.ts list --limit 3
```

Success: `gh auth status` says you are logged in to github.com, the second prints a JSON object of ledger counts (`"total": 0` on a new install), and the third lists up to three recent entries (nothing on a new install). The ledger folder is created on the first `/er`. If `gh` is missing, recording and reviewing still work; only Send is unavailable. A first `/er some words` then adds one line and prints its id.
