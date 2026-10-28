# Pareto

Status: bun ~/.claude/LIFEOS/TOOLS/Secrets.ts has YOUTUBE_API_KEY PERPLEXITY_API_KEY && gh auth status · optional

## What it does

Pareto sweeps YouTube, GitHub and the web for one topic, ranks everything down to the vital few, and writes a report on the past meta, the current mainstream meta and where the forward thinkers are heading, with every frontier claim linked. It needs no config file. Each source is its own door: a source whose key is missing or whose quota is spent is skipped and named in the result, and the run only fails when every source fails. You can run on GitHub alone with just the GitHub command-line tool, but a full sweep wants all three.

## Fill in

Nothing to write in a config file. Set up the sources, then optionally add a `PREFERENCES.md` under `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Pareto/` in your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`) with your default sources, sweep size or sources to skip, for example:

```markdown
# Pareto preferences

- Default sources: youtube, github, web
- Skip YouTube unless I ask for it.
- Sweep size: 40 candidates per source.
```

The collector takes `--sources` as a comma list from `youtube,github,web`, and `--per-source N` (default 100). The report is written to `~/Downloads/pareto-<topic-slug>-<date>.md`.

Two other things feed the report step. The Gemini watch pass (`LIFEOS/TOOLS/GeminiWatch.ts`, which needs `GOOGLE_API_KEY` in `~/.claude/.env`) reads YouTube transcripts for the items that carry the argument, and the Research skill supplies the handoff of cited sources, so set Research up too (its own `Setup.md`) if you want that leg.

## Accounts and secrets

Keys go in `~/.claude/.env` as `NAME=value` lines (never in a skill file), and where your install has `LIFEOS/TOOLS/Secrets.ts` you re-seal the file after editing it with `bun ~/.claude/LIFEOS/TOOLS/Secrets.ts seal`.

| Source | What it needs | Env var name |
|---|---|---|
| YouTube | A Google Cloud project with the YouTube Data API v3 enabled, and an API key. The default quota is 10,000 units a day and each search costs 100, so about 25 full runs a day. | `YOUTUBE_API_KEY` |
| Web | An API key from a Perplexity account with API credits. | `PERPLEXITY_API_KEY` |
| GitHub | The GitHub command-line tool, signed in: `gh auth login`. No env var. | none |

## Prove it works

```bash
bun ~/.claude/LIFEOS/TOOLS/Secrets.ts has YOUTUBE_API_KEY PERPLEXITY_API_KEY
gh auth status
bun ~/.claude/skills/Pareto/Tools/Collect.ts "agentic coding" --sources github --per-source 5 --out "$TMPDIR/pareto-check.json"
```

The first command prints one `NAME yes` or `NAME no` line per key, never a value, and exits 0 only when all are present. The second prints your signed-in GitHub account. The third is a small read-only sweep that writes a file only at the `--out` path. Success is a line like `github   ok   19` on stderr (the count varies) and `N items` written to the file. Add `youtube` or `web` to `--sources` to prove each key the same way; a source that fails shows `failed` with its error instead of stopping the run.
