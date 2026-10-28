---
name: SecurityMarketData
evals:
  manual:
    reason: "Figure fidelity needs each answer compared with the records and metadata the authenticated MCP returned, and no permitted fixture corpus exists yet."
    falsifier: "An answer changes the returned entity, scope, taxonomy or figures; presents a forecast or score as an observed event; invents undisclosed data; or drops returned freshness or quota metadata."
metadata:
  short-description: "Query curated cybersecurity funding, M&A, companies, investors, market maps, and deal activity. Excludes vulnerabilities, security news, and investment advice."
version: 1.1.2
description: Query curated cybersecurity market and company intelligence. USE WHEN security market data OR cybersecurity funding OR cyber M&A OR security-company/investor research OR market maps OR deal activity OR Return on Security OR The Signal. NOT FOR vulnerability research, security news, or investment advice.
---

# SecurityMarketData

Query Return on Security's Signal data through its live MCP interface, with evidence, freshness, and analytical boundaries intact.

## Ideal State

- Every answer comes from live Signal records reached through an authenticated `signal-mcp` (or the REST fallback when `ROS_API_KEY` exists), never from scraping, memory or an invented taxonomy.
- A reader can tell observed records from analytical outputs (forecasts, scores, suggestions) and sees the provider's freshness and quota as returned.

## Intent Routing

| Intent | Trigger | File |
|---|---|---|
| **QueryMarket** | Any supported market, company, investor, funding, M&A, or lifecycle query | `Intents/QueryMarket.md` |

| File | Read when |
|------|-----------|
| `References/ToolCatalog.md` | selecting tools, confirming tiers, or using the REST fallback; not needed for routing |
| `Tools/SignalCheck.help.md` | probing setup or checking an answer's Output format parts |
| `Setup.md` | first-time setup: connecting `signal-mcp`, the account and OAuth sign-in, and the optional REST key |

## Data & Config

Before executing, check `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/SecurityMarketData/`. If present, load enabled preferences and configuration; otherwise use these defaults. (configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`)

First-time setup (the MCP server, the account, the sign-in) is in [Setup.md](Setup.md).

## Gotchas

- OAuth 2.1 tokens last 24 hours, so a session that worked yesterday may need the interactive flow again.
- Free access provides 180 calls/day and 12 tools; Pro adds 21 tools; Enterprise adds one.
- `suggest_acquirers`, `forecast_funding`, `exit_score`, and consolidation or growth scores are analytical outputs, not observed facts, even though they come back from the same API.

## Examples

- **Funding trend:** “Show quarterly funding trends for cloud security and distinguish observed rounds from forecasts.”

- **Company enrichment:** “Enrich this security company and report its category, funding, investors, lifecycle, and data freshness.”

- **Category M&A:** “Map identity-security M&A activity, acquirers, and observed consolidation signals for the last three years.”
