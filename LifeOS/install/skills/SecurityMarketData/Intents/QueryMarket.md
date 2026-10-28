# QueryMarket

A cybersecurity-market answer drawn from Return on Security's live Signal data, with provider metadata preserved and observed records kept apart from computed analysis.

## Ideal State

- The answer resolves the requested cybersecurity-market question as asked, and its Tools part lists every live call made; no call result went unused in the answer, so the calls are the fewest sufficient to answer it.
- Coverage and freshness from `get_data_status` were known before any result was interpreted, and the Freshness part reports them.
- Unfamiliar category or geography filters carry values that `list_categories` or `list_countries` returned.
- Returned freshness, quota, and request metadata are preserved, and the answer makes it impossible to confuse observed records with heuristics, forecasts, scores, and other analytical outputs, which are clearly labeled.

## Anti-criteria

- Live schemas are never guessed: argument names are never inferred from memory or examples.
- Missing, undisclosed, ambiguous, or access-limited data is never filled by implication.
- The REST fallback is never used unless `ROS_API_KEY` exists; MCP is preferred.
- Never scrapes when MCP or REST is available, and never requests or exposes the value of `ROS_API_KEY`.
- The two-layer taxonomy (category domains and product categories, with metadata tags) is never flattened into an invented taxonomy.

## Safety gates

- No query runs until `signal-mcp` is configured and authenticated. `SignalCheck.ts setup` proves configuration only; the first live call proves authentication. If either is missing or interactive OAuth is incomplete, stop honestly before querying, give the relevant setup command, and claim no success.
- OAuth 2.1 authorization is interactive: only the user can finish it, and setup is incomplete until they have. The setup commands are in § Tool contract.

## Tool contract

- Tool tiers and the REST fallback (base URL, headers to preserve): `../References/ToolCatalog.md`.
- Deterministic checks (flags, JSON output, exit codes in `../Tools/SignalCheck.help.md`), run from `~/.claude`:

```bash
bun skills/SecurityMarketData/Tools/SignalCheck.ts setup        # exit 0: signal-mcp configured or ROS_API_KEY present; 1: neither
bun skills/SecurityMarketData/Tools/SignalCheck.ts shape <file|->  # exit 1 lists the missing Output format parts
```

- Setup prefers Streamable HTTP MCP. For Hermes:

```bash
hermes mcp add signal-mcp --url https://mcp.returnonsecurity.com/mcp
hermes mcp list
```

- Optional vendor examples:

```bash
claude mcp add --transport http signal-mcp https://mcp.returnonsecurity.com/mcp
claude mcp list
codex mcp add signal-mcp --url https://mcp.returnonsecurity.com/mcp
codex mcp login signal-mcp
```

### Intent-to-Flag Mapping

| Need | Command |
|---|---|
| Is the MCP or REST route configured? | `SignalCheck.ts setup` |
| Does the answer carry all six Output format parts? | `SignalCheck.ts shape <file\|->` |

## Output format

- **Scope:** entities, taxonomy, geography, and time window used.
- **Observed:** facts present in provider records.
- **Analytical:** heuristics, forecasts, scores, comparisons, and interpretations, clearly labeled.
- **Freshness:** provider status and relevant response freshness metadata.
- **Caveats:** missing, undisclosed, ambiguous, or access-limited data.
- **Tools:** tool names used, plus quota information when returned.
