# Fabric

Status: command -v fabric >/dev/null && command -v yt-dlp >/dev/null && echo ok · optional

## What it does

The Fabric skill runs any of the 200-plus ready-made prompt patterns (extract wisdom, summarize, threat model, analyze claims and so on) that ship in its `Patterns/` folder. The assistant reads the pattern and applies it directly, so everything works with no setup. The separate `fabric` program is needed for only two cases: pulling a YouTube transcript, and fetching a web page that blocks the normal fetch. Set it up if you want those.

## Fill in

Nothing to write in LifeOS. The `fabric` program keeps its own settings in `~/.config/fabric/`. Run its setup once to pick a model provider:

```bash
fabric --setup
```

Optional customizations live under `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Fabric/` in your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`):

| Path | What it holds |
|---|---|
| `PREFERENCES.md` | Optional preferences that override the skill's defaults. |
| `Config.md` | Optional. A `scan_tool: <path under ~/.claude>` line names a content scanner that UpdatePatterns runs before and after a sync, failing the sync on any new finding. `FABRIC_SCAN_TOOL` (a full path) overrides it. Without either, the sync skips the scan. |
| `Patterns/<name>/system.md` | Your own patterns, in the same layout as the skill's `Patterns/`. One is used only when the skill's library has no pattern of that name, so an upstream pattern always wins. Example: `Patterns/rate_example_topics/system.md`. |

The skill's own `Patterns/` folder is the shipped library; it takes nothing from `~/.config/fabric/patterns/`, so your own fabric patterns never leak into it. Put a pattern you want the assistant to run in the `Patterns/` folder above instead.

## Accounts and secrets

- Install the program: `go install github.com/danielmiessler/fabric/cmd/fabric@latest` (needs Go; put the Go bin folder on your PATH).
- Install `yt-dlp` and keep it on your PATH. Fabric stops with "yt-dlp not found in PATH" for YouTube transcripts without it. On a Mac, `brew install yt-dlp`.
- An account with whichever model provider you pick in `fabric --setup`. Fabric stores that provider's key in its own folder, not in `~/.claude/.env`, and a `fabric -y URL -p <pattern>` run sends the transcript to that provider.
- Fetching a page the native fetch cannot extract with `fabric -u` uses Jina AI's reader, per `fabric --help`; it is for pages that allow automated access, never for getting past a block. No LifeOS key is involved.
- Updating the pattern library (the UpdatePatterns intent) needs `git` and network access to clone the upstream repo; it does not use the `fabric` program.

## Prove it works

```bash
fabric --version
fabric --listpatterns | wc -l
command -v yt-dlp
bun ~/.claude/skills/Fabric/Tools/CheckPatterns.ts
```

Success: the first command prints a version such as `v1.4.479`, the second prints a count of 200 or more patterns, the third prints the path to `yt-dlp`, and the last prints `Patterns: <count>` followed by a check mark for `extract_wisdom`, `summarize`, `create_threat_model` and `analyze_claims`, exiting 0. If you skip the program, only the last command applies and the skill still runs patterns natively. To try a transcript, `fabric -y "<a public YouTube URL>" -p summarize` should print a summary.
