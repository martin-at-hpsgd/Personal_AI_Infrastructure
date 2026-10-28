# GenerateAnalysis.ts

Generates the US Economic State Analysis report (the template in `Intents/GetCurrentState.md` § Output format): fetches each priority series' 10-year FRED history and the EIA weekly gas price, computes 10y/5y/2y/1y trends, and writes the markdown report. Used by the GetCurrentState intent.

```bash
bun ~/.claude/skills/USStats/Tools/GenerateAnalysis.ts                    # report to stdout
bun ~/.claude/skills/USStats/Tools/GenerateAnalysis.ts --output=<path>    # report to a file
```

| Flag | Effect |
|------|--------|
| `--output=PATH` | save the report to PATH instead of stdout (GetCurrentState uses `~/.claude/LIFEOS/MEMORY/RESEARCH/[YYYY-MM]/[YYYY-MM-DD]_US-Economic-State-Analysis.md`) |
| `-h`, `--help` | usage |

Environment: `FRED_API_KEY` (required), `EIA_API_KEY` (optional; without it the gas price is omitted).

Exit codes: 0 report written, 1 missing `FRED_API_KEY`. A series that fails to fetch is left out of the report and named on stderr.
