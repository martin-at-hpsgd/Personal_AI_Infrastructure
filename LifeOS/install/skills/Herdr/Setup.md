# Herdr

Status: bun ~/.claude/skills/Herdr/Tools/Freshness.ts --offline · optional

## What it does

Herdr is a terminal workspace manager for coding agents. This skill operates a running herdr session through its CLI (panes, tabs, workspaces, worktrees, other agents), explains and edits your local herdr setup, and checks that the install, your `config.toml` and your knowledge of herdr's own agent instructions are current.

It holds no command syntax of its own. The installed binary documents itself (`herdr --skill`, `herdr --help`), and the skill reads that at use time. It needs the `herdr` binary on your PATH and nothing else. The control commands only work from an agent running inside a herdr pane, where herdr sets `HERDR_ENV=1`.

## Fill in

Nothing is required before first use. One file under `LIFEOS/USER/` is created for you, and one more you may edit:

| File | Created by | What it holds |
|---|---|---|
| `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Herdr/freshness.json` | `Freshness.ts --accept` | The accepted baseline: a hash of herdr's own skill text, the herdr version it came from, and the date you accepted it. |
| `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Herdr/upstream-skill.md` | `Freshness.ts --accept` | A copy of the herdr skill text at that baseline, kept only so a later change can be diffed. It is never the instruction source. |

Do not write either by hand. A baseline looks like this (made-up values):

```json
{
  "skill_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "herdr_version": "1.0.0",
  "accepted": "2026-01-01T00:00:00.000Z"
}
```

| Field | Meaning |
|---|---|
| `skill_sha256` | SHA-256 of the output of `herdr --skill` when you last read and accepted it. |
| `herdr_version` | The herdr version that produced it. |
| `accepted` | When you accepted it. |

Your herdr settings live in `~/.config/herdr/config.toml` (or under `$XDG_CONFIG_HOME`), outside LifeOS. An optional note, `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Herdr/ThisInstall.md`, can list the local pieces around herdr (a key mirror, a shell wrapper, hooks); the skill reads it when it exists and works without it.

## Accounts and secrets

No account and no secret. Install the `herdr` binary unmodified from https://herdr.dev (it is AGPL; never vendor or fork its source into the LifeOS tree). These environment variables are set by herdr itself inside its panes. Do not put them in `~/.claude/.env`:

| Name | Where it comes from |
|---|---|
| `HERDR_ENV` | Set to `1` by herdr inside a pane. The skill refuses control commands without it. |
| `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID` | Set by herdr; they say where the current agent sits. |
| `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR` | Optional; they move the config directories the tool reads. |

## Prove it works

```bash
herdr --version
bun ~/.claude/skills/Herdr/Tools/Freshness.ts --accept
bun ~/.claude/skills/Herdr/Tools/Freshness.ts --offline
```

The first prints `herdr <version>`. The second records the baseline (`ok   skill_hash    baseline accepted at <version>`) after you have read `herdr --skill` once. The third prints one `ok` or `skip` line per check (`version` shows `skip` because of `--offline`) and exits 0. Without a baseline the third run exits 1 with `skill_hash` stale; if herdr is not installed the tool exits 2 with `herdr is not runnable`.
