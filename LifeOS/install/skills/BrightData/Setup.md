# BrightData

Status: bun ~/.claude/LIFEOS/TOOLS/Secrets.ts has BRIGHT_DATA_API_KEY BRIGHT_DATA_CRAWL_DATASET_ID · optional

## What it does

BrightData fetches a page as markdown, trying four tiers in order and stopping at the first that works: plain `curl`, `curl` with a declared user agent, a real Chrome browser through Interceptor, and finally Bright Data's paid managed fetch product for managed rendering and region-specific requests. It can also crawl a whole site. It works within each target site's terms and reports a refusal rather than working around it. Tiers 1 to 3 are free and need no account. Only the paid tier and the full-site crawl need a Bright Data account.

## Fill in

No config file. The free tiers work as soon as `curl` and the Interceptor skill do. For the paid tier you register one piece yourself:

- **The Bright Data MCP server**, which supplies the tools `mcp__Brightdata__scrape_as_markdown` and `scrape_batch` that Tier 4 calls. Add it to Claude Code with `claude mcp add` using the command and token from your Bright Data dashboard. The skill does not install it. When the server is not registered, a request stops at the best free-tier result and says Tier 4 is not configured.
- **Full Crawl** (a whole site through Bright Data's Crawl API) needs a crawl dataset: its id is shown in the Bright Data dashboard.

Optional: a `PREFERENCES.md` at `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/BrightData/` overrides the defaults.

## Accounts and secrets

Open a Bright Data account (brightdata.com); Tier 4 pages are billed from your credits. Add these to `~/.claude/.env` only for the paid paths:

| Name | Needed for |
|---|---|
| `BRIGHT_DATA_API_KEY` | Full Crawl, as a bearer token on `api.brightdata.com` |
| `BRIGHT_DATA_CRAWL_DATASET_ID` | Full Crawl, the dataset id of the Crawl API |

The MCP server holds its own token in its registration, so it needs no `.env` name. After editing `.env`, run `bun ~/.claude/LIFEOS/TOOLS/Secrets.ts seal`.

## Prove it works

```bash
bun ~/.claude/skills/BrightData/Tools/MarkdownPreCheck.ts check "https://example.com/"
bun ~/.claude/skills/BrightData/Tools/MarkdownPreCheck.ts label "https://example.com/" 2
bun ~/.claude/LIFEOS/TOOLS/Secrets.ts has BRIGHT_DATA_API_KEY BRIGHT_DATA_CRAWL_DATASET_ID
```

Success: the first command is the free pre-check. For a page that does not serve markdown it prints `no markdown signal: proceed to Tier 1` and exits 1, which is the normal result and shows the tool and your network work. The second prints `Successfully retrieved content from https://example.com/ using Tier 2`. The third prints `yes` for each name you set up for Full Crawl; on a free-tier-only install both read `no`. To check the MCP server, list your registered servers with `claude mcp list` and look for a Bright Data entry.
