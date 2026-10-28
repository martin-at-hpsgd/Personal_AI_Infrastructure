# Freshness

Tell whether the herdr install, our config and my knowledge of herdr's agent instructions are current.

## Ideal State

- Every check reads fresh, or each stale one is reported with what it means and what I would do.
- After an update, the new release notes were read and anything that touches our setup is named.
- A changed `herdr --skill` was diffed against `upstream-skill.md`, and any new safety rule or changed default was folded into this skill's Gotchas or Operate constraints, before `--accept` recorded the new baseline.

## Anti-criteria

- The tool never mutates herdr; updating is a separate, confirmed step.
- Never `--accept` a changed skill text unread; the baseline means "I have read this version."

## Tool contract

```bash
bun ~/.claude/skills/Herdr/Tools/Freshness.ts [FLAGS]
```

| The principal says | Flag | Effect |
|--------------------|------|--------|
| (default) "is herdr current" | none | Table of five checks; exit 0 fresh, 1 stale, 2 herdr not runnable |
| scripted or gate use | `--json` | Machine-readable result |
| no network, or a fast gate | `--offline` | Skips the stable-version lookup |
| "accept it", after I have read the changed skill text | `--accept` | Records the current `herdr --skill` hash and snapshot as the baseline |

## Output format

What each stale check means, and the response to report with it:

| Check | Meaning | Response |
|-------|---------|----------|
| `version` | A newer stable release exists | Read `release-notes.json` beside `config.toml` or the release page from the docs index. Recommend an update and run it through `Intents/Update.md`, which carries the safety gate. |
| `server` | The server runs an older binary than the client | A restart takes down every pane, so it carries the same gate as an update (`Intents/Update.md` § Safety gates). New commands fail with a missing-method error until it restarts. |
| `integrations` | An installed agent hook is behind the binary | `herdr integration install <name>`, then confirm `herdr integration status` reads current |
| `config_keys` | Our `config.toml` sets a key this binary does not list | A rename or removal upstream. Find the replacement in `herdr --default-config` and fix through Configure. |
| `skill_hash` | `herdr --skill` changed since the baseline | Diff it against `upstream-skill.md` in the skill's customization directory, fold what changed into this skill, then `--accept`. |
