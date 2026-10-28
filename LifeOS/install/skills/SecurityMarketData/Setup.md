# SecurityMarketData

Status: bun ~/.claude/skills/SecurityMarketData/Tools/SignalCheck.ts setup · required

## What it does

The security market data skill answers questions about cybersecurity funding, M&A, companies, investors, market maps and deal activity from Return on Security's Signal dataset, reached live through its MCP server (`signal-mcp`). It never answers from memory or by scraping, and it keeps observed records apart from forecasts and scores. It cannot run at all until the server is connected and you have signed in, because the data is behind that account.

## Fill in

There is no config file. Connect the server once for the tool you use. Streamable HTTP is preferred, at `https://mcp.returnonsecurity.com/mcp`:

```bash
claude mcp add --transport http signal-mcp https://mcp.returnonsecurity.com/mcp
claude mcp list
```

For Codex, add the server and sign in:

```bash
codex mcp add signal-mcp --url https://mcp.returnonsecurity.com/mcp
codex mcp login signal-mcp
```

For Hermes, use `hermes mcp add signal-mcp --url https://mcp.returnonsecurity.com/mcp`, then `hermes mcp list`. The setup probe reads only the Claude Code and Codex configs, not Hermes' own list.

Then finish the OAuth 2.1 sign-in. It is interactive, only you can complete it, and the token lasts 24 hours, so a session that worked yesterday may ask you to sign in again.

## Accounts and secrets

- A Return on Security account at <https://www.returnonsecurity.com> with access to Signal. The tiers are set by the provider: the free tier has 12 tools and 180 calls a day, Pro adds 21 more tools, and Enterprise adds one. Check the current terms at <https://docs.returnonsecurity.com/>.
- The MCP sign-in needs no key in `~/.claude/.env`.
- Optional REST fallback: if your plan includes API access (a Pro or Team add-on, or Enterprise), put `ROS_API_KEY=...` in `~/.claude/.env` (the name only is shown here). The skill prefers MCP and uses REST only when that key exists. It never prints or asks for the key's value.

## Prove it works

```bash
bun ~/.claude/skills/SecurityMarketData/Tools/SignalCheck.ts setup
```

It is read-only and prints one JSON line. Before you connect anything, it prints `{"ok":false,"claude":false,"codex":false,"rest":false,"ready":false}` and exits 1. Success is `"ready":true` with exit 0, and at least one of `claude`, `codex` or `rest` true. That proves configuration only, not sign-in: a lapsed 24-hour token still reports ready, and the first live call proves authentication. So finish with a question such as "What is the cybersecurity funding trend for cloud security this year?" and expect an answer headed Scope, Observed, Analytical, Freshness, Caveats and Tools. To check that structure on a saved answer, run `bun ~/.claude/skills/SecurityMarketData/Tools/SignalCheck.ts shape answer.md`.
