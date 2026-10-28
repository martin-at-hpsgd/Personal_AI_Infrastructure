# Research

Status: bun ~/.claude/LIFEOS/TOOLS/Secrets.ts has PERPLEXITY_API_KEY GOOGLE_API_KEY XAI_API_KEY · optional

## What it does

The research skill answers a question with several independent researchers, checks every URL before delivering it, and tags each finding `[HIGH]`, `[MED]`, `[LOW]` or `[CONFLICT]`. The depth sets how many research vendors run: Quick uses one (Perplexity), Standard uses Claude, Gemini, Perplexity and OpenAI's Codex (plus Grok when X is a likely source), and Extensive and Deep use all five. Each vendor is a separate account, and a missing one narrows the roster instead of stopping the run, but the answer must say which slot was swapped. The `ClaudeResearch` intent uses Claude's own web search and needs no key at all.

## Fill in

Nothing to write in a config file. Optionally add `PREFERENCES.md` under `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Research/` in your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`) to change defaults (the installer puts a starter there; if it is missing, `bun ~/.claude/skills/LifeOS/Tools/ScaffoldUser.ts --apply` copies any missing starter file into place and never overwrites one you have edited). It is free-form bullets, no required keys. Two optional sections are read by name:

- `## ExtractAlpha`: `Count` (how many insights) and `Bullet style` (voice and words per bullet). Default: up to 30 insights, each one plain-language sentence.
- `## InterviewResearch`: `Question style` (whose or what interviewing style the 10 questions follow) and `Interview context` (the usual kind of interview). Default: the Question principles in `Intents/InterviewResearch.md`.

A made-up example:

```markdown
# Research preferences

- Default depth: Standard.
- Always keep a link to the primary source next to every claim.

## ExtractAlpha

- Count: 15-20 insights.
- Bullet style: plain conversational sentences, 10-15 words each.

## InterviewResearch

- Question style: oblique, story-eliciting questions that challenge the guest's assumptions.
- Interview context: podcast interviews with ExampleNet founders.
```

Research artifacts are saved to `LIFEOS/MEMORY/RESEARCH/YYYY-MM/YYYY-MM-DD_<topic>/` and working files to the current work item's folder.

## Accounts and secrets

Keys go in `~/.claude/.env` as `NAME=value` lines, never in a skill file. Where your install has `LIFEOS/TOOLS/Secrets.ts`, re-seal after editing with `bun ~/.claude/LIFEOS/TOOLS/Secrets.ts seal`.

| Vendor slot | Account to open | Env var name or tool |
|---|---|---|
| Perplexity (Quick, and part of Standard and up) | A Perplexity API account with credits | `PERPLEXITY_API_KEY`, read by `LIFEOS/TOOLS/PerplexitySearch.ts` |
| Gemini | A Google AI Studio account with an API key | `GOOGLE_API_KEY`, read by `LIFEOS/TOOLS/GeminiSearch.ts` |
| OpenAI Codex | An OpenAI account | The `codex` command-line tool: `bun install -g @openai/codex`, then `codex login` |
| Grok | An xAI API account | `XAI_API_KEY`, read by `LIFEOS/TOOLS/GrokQuery.ts` |
| Claude | Your Claude login | Nothing extra |

Optional extras for community and sentiment questions, each tried before any scraper:

| Source | Env var name or tool |
|---|---|
| YouTube Data API v3 | `YOUTUBE_API_KEY` |
| X API v2 recent search | `X_BEARER_TOKEN` (and `TWITTER_API_KEY` where your X skill uses it) |
| YouTube transcripts | the `fabric` command-line tool, used as `fabric -y <url>` |
| Pages that need rendering | the Interceptor skill with Google Chrome; a page that refuses automated access is reported, and vendor data products (Bright Data, or a platform-scraping skill if installed) are used only with your yes and within the site's terms |

## Prove it works

```bash
bun ~/.claude/LIFEOS/TOOLS/Secrets.ts has PERPLEXITY_API_KEY GOOGLE_API_KEY XAI_API_KEY
codex --version
echo 'https://example.com/|Example Domain' > "$TMPDIR/research-check.txt" && bun ~/.claude/skills/Research/Tools/VerifyUrls.ts "$TMPDIR/research-check.txt"
```

The first command prints one `NAME yes` or `NAME no` line per key, never a value, and exits 0 only when every key is present. Each `no` is one vendor you will not have; Quick needs only the Perplexity line. The second prints the Codex version, or fails if the tool is not installed (`bun ~/.claude/LIFEOS/TOOLS/Doctor.ts` also reports whether `codex` is installed and logged in). The third runs the URL verifier on one made-up pair and prints `SUPPORTED 200 https://example.com/ ... phrase found` with exit 0. Then ask your assistant for a quick research question. Success is an answer where every link was fetched and confidence-tagged.
