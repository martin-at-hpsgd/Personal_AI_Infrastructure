# FetchFredSeries.ts

Fetches up to N years of observations for one FRED series, or every core series, and prints latest value, range, mean, observation count and (with `--trends`) trend statistics. Used by the GetCurrentState intent.

```bash
bun ~/.claude/skills/USStats/Tools/FetchFredSeries.ts <series_id> [--years=10] [--trends] [--json]
bun ~/.claude/skills/USStats/Tools/FetchFredSeries.ts --all [--years=10] [--json]
```

| Flag | Effect |
|------|--------|
| `--years=N` | history window in years (default 10) |
| `--all` | fetch every series in `CORE_SERIES` instead of a positional id |
| `--trends` | add trend calculations (CAGR, change, direction) to the text output |
| `--json` | machine output on stdout; progress lines stay on stderr |
| `-h`, `--help` | usage |

Environment: `FRED_API_KEY` (required; free key at https://fred.stlouisfed.org/docs/api/api_key.html). Bun loads it from `~/.claude/.env` when run from `~/.claude`.

Exit codes: 0 success, 1 missing `FRED_API_KEY` or no series id given. A series that fails to fetch is reported on stderr and the others continue.
