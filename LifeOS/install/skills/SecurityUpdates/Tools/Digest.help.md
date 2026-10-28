# Digest

Run state and shape checks for the SecurityUpdates Update intent. Run from `~/.claude`.

```bash
bun skills/SecurityUpdates/Tools/Digest.ts filter [--state <path>] < candidates.json
bun skills/SecurityUpdates/Tools/Digest.ts record [--state <path>] < shown.json
bun skills/SecurityUpdates/Tools/Digest.ts check <digest.md> [--state <path>]
```

| Command | Does |
|---------|------|
| `filter` | Reads a JSON array of `{title, source, url?, date?}` on stdin and prints `{first_run, since, items}`: only items whose key is not in the state, with dated items older than the window dropped (7 days on a first run, 90 days after) and exact repeats in the batch collapsed. |
| `record` | Reads the items actually shown on stdin, adds their keys to the state, prunes keys older than 90 days, sets `last_check_timestamp`, and writes the file atomically. Refuses more than 32 items. |
| `check` | Validates a saved digest against the Output format (heading, three sections, summary table, `**Total:** X/32`, at most 32 items, counts that agree) and, when the state file exists, its schema. |

An item's key is the first 16 hex characters of a SHA-256 over its canonical URL (host lowercased, `www.`, fragment, tracking params and trailing slash removed), or over its normalized title when it has no URL.

`--state` overrides the default path, `<configRoot>/LIFEOS/MEMORY/STATE/SecurityUpdates-last-check.json` (`configRoot` is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`).

Exit codes: 0 ok, 1 check failed, 2 usage or input error.
