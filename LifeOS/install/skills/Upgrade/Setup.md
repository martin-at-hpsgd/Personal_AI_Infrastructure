# Upgrade

Status: bun ~/.claude/LIFEOS/TOOLS/Secrets.ts has GITHUB_TOKEN >/dev/null && echo ok · optional

## What it does

Upgrade reads what Anthropic and other practitioners are shipping (changelogs, docs, GitHub releases, blogs, and optionally YouTube channels and trending repos), weighs it against your install, and recommends improvements that are not already adopted or rejected. The Anthropic lane works out of the box from the list shipped in `sources.json`. This guide covers the optional extras that widen coverage, and the one setting that stops the GitHub part of the Anthropic lane from failing quietly.

## Fill in

Three optional files under `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Upgrade/` in your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`). Without the first two, those lanes are skipped and the report says so; without the third, the digest uses its defaults.

**1. youtube-channels.json** lists the creators to watch. No base list ships, so an empty list is the default:

```json
{
  "channels": [
    {
      "name": "Example Dev Channel",
      "channel_id": "@exampledev",
      "url": "https://www.youtube.com/@exampledev",
      "priority": "HIGH",
      "description": "Agent tooling tutorials"
    }
  ]
}
```

**2. user-sources.json** adds your own GitHub repos to watch, blogs to read and a GitHub trending lane:

```json
{
  "github_repos": [
    { "name": "Example upstream", "repo": "alex-example/widget", "priority": "HIGH", "check_releases": true, "check_commits": false }
  ],
  "blogs": [
    { "name": "Example Lab Blog", "url": "https://example.com/blog/", "priority": "HIGH", "type": "blog" }
  ],
  "github_trending": {
    "enabled": true,
    "lookback_days": 7,
    "min_stars": 50,
    "results_per_query": 3,
    "queries": ["topic:ai-agent"]
  }
}
```

| Field | Meaning |
|---|---|
| `github_repos[]` | Repos you maintain or follow upstream; `Tools/Anthropic.ts` appends them to the shipped list and checks releases or commits as each entry's flags say. A malformed entry stops the run naming the file and key. |
| `blogs[]` | Pages fetched each run; dead or redirected pages are skipped with a note. |
| `github_trending.enabled` | Turns the trending lane on. Absent means the lane is skipped. |
| `lookback_days`, `min_stars`, `results_per_query` | Window, star floor and result count for each search. |
| `queries` | GitHub search terms; give each a free-text or `topic:` term. |

**3. PREFERENCES.md** (optional) sets the NewsDigest story-explanation format under `## News digest`:

| Key | Meaning | Default without the file |
|---|---|---|
| `story_items` | Number of items in the story explanation the combined digest adds on request | `12` |
| `link_separator` | Text placed between several inline `[LABEL](url)` links after one sentence in "with links" mode | `, ` |

The skill also keeps its monitoring state in this directory, under `State/` (`last-check.json` from `Tools/Anthropic.ts`, plus the YouTube and trending seen-lists). Nothing to fill in: each file is created on the first run that needs it.

## Accounts and secrets

- `GITHUB_TOKEN` (optional, in `~/.claude/.env`): a GitHub personal access token with read access to public repositories. `Tools/Anthropic.ts` sends it with its GitHub requests. Without it GitHub's lower anonymous rate limit applies, and a rejected GitHub page is dropped without a warning, so a run can show no GitHub changes when it simply could not look. The tool reads the process environment, and Bun loads `.env` from the directory you run it in, so run it from `~/.claude` or export the variable in your shell.
- `yt-dlp` on your PATH, for the YouTube lane.
- `gh` on your PATH and signed in to your GitHub account, for the trending lane.

## Prove it works

```bash
bun ~/.claude/LIFEOS/TOOLS/Secrets.ts has GITHUB_TOKEN
command -v yt-dlp gh
grep -c '"name"' ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Upgrade/youtube-channels.json
grep -n '"enabled"' ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Upgrade/user-sources.json
```

Success is `GITHUB_TOKEN yes`, a path printed for each of `yt-dlp` and `gh`, a channel count of at least 1, and `"enabled": true` for the trending lane. Each line you skipped on purpose is a lane that will be reported as skipped. Do not use `Tools/Anthropic.ts` as the check: every run of it advances `USER/CUSTOMIZATIONS/SKILLS/Upgrade/State/last-check.json`, so the items it shows are marked as seen. When the above is in place, ask your assistant "check for upgrades" for a real sweep.
