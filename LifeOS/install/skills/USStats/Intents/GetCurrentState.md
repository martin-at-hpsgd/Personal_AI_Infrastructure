# GetCurrentState

**Contents:** Ideal State · Anti-criteria · Inputs · Output format · Tool contract

A comprehensive U.S. economic overview with multi-timeframe trend analysis: the report `GenerateAnalysis.ts` writes from its own FRED and EIA fetch, with 10y/5y/2y/1y trends and a cross-category read. Ported from the retired USMetrics skill on 2026-10-10 with nothing dropped. This is the live-government-data side of USStats; the annual long-run almanac questions go to Analyze. Metric counts and sources for the live side are stated once, in SKILL.md's purpose paragraph.

## Ideal State

- The report covers GenerateAnalysis.ts's 29 priority series in 8 categories (Economic Output, Inflation, Employment, Housing, Consumer, Financial Markets, Trade, Fiscal; `PRIORITY_SERIES`, counted 2026-10-11) across 10 year, 5 year, 2 year and 1 year horizons, each series carrying its change per horizon and its trend direction.
- An answer that needs a category outside the report (Demographics, Health & Crisis) names that gap; Demographics values may be quoted from the US-Common-Metrics dataset with their period, and Health & Crisis has no fetched source.
- For each metric with a FRED series ID, the historical data behind its trends spans 10+ years.
- The report identifies patterns, correlations and research opportunities in its Cross-Metric Analysis, Pattern Detection and Research Recommendations sections.
- The report is the markdown GenerateAnalysis.ts writes (Output format), saved to the Output Location path.
- When the FRED API fails, the report notes which metrics could not be fetched and proceeds with the available data.
- When a metric is not found, the missing series is logged and the analysis continues with the others.
- When the API key is missing, the user is prompted to set the `FRED_API_KEY` environment variable.
- Every number reported is current and carries its period and source, and preliminary or stale figures are labelled as such.
- A metric the tools did not fetch is named, never silently counted.

## Anti-criteria

- Never presents preliminary data as final (publication lag, SKILL.md Gotchas).
- Never claims one metric caused another (SKILL.md Gotchas).
- One failed API call or missing series never stops the report.
- Never hand-computes or rebuilds the tables GenerateAnalysis.ts already rendered.

## Inputs

GenerateAnalysis.ts reads no local file. The master metrics document, which lists every metric with its FRED series ID (or other API identifier), category, update frequency and current value, holds the current values for metrics outside the report:
```
${USMETRICS_DATA_DIR:-~/.claude/LIFEOS/USER/DATA/US-Common-Metrics}/US-Common-Metrics.md
```

## Output format

The report is the markdown GenerateAnalysis.ts writes, titled `# US Economic State Analysis`, with these sections: Executive Summary, Current Snapshot (category, metric, current value, 1Y change, trend), Detailed Trend Analysis (one table per category: Current, 10Y, 5Y, 2Y, 1Y), Cross-Metric Analysis (inflation-employment dynamics, yield curve status, housing affordability), Pattern Detection (historical extremes, recent momentum shifts), Research Recommendations (high priority investigations, risks to monitor, data gaps) and Sources. A single-series question gets `FetchFredSeries.ts` output instead, which adds CAGR and summary statistics.

The closer-look line draws on the standard linkages: Inflation ↔ Employment (Phillips Curve dynamics, wage growth vs. inflation), Monetary Policy ↔ Economy (Fed Funds Rate into mortgage rates and housing; the 10Y-2Y yield curve as a recession indicator), Consumer Health ↔ Economic Output (sentiment vs. retail sales, saving rate vs. spending), Housing ↔ Broader Economy (housing starts as a leading indicator), Energy ↔ Inflation (oil and gas prices into CPI), and Fiscal ↔ Financial Markets (debt growth vs. Treasury yields). The leading-indicator signals are the jobless claims trend, the yield curve shape and consumer sentiment direction.

### Output Location

Save generated report to:
```
~/.claude/LIFEOS/MEMORY/RESEARCH/[YYYY-MM]/[YYYY-MM-DD]_US-Economic-State-Analysis.md
```

## Tool contract

```bash
bun ~/.claude/skills/USStats/Tools/FetchFredSeries.ts <series_id> --years=10   # one series
bun ~/.claude/skills/USStats/Tools/FetchFredSeries.ts --all --years=10         # every core series
bun ~/.claude/skills/USStats/Tools/GenerateAnalysis.ts [--output=path]         # the report
```

Both need `FRED_API_KEY`; GenerateAnalysis also needs `EIA_API_KEY` for energy data (usage from each tool's header and `Tools/<Tool>.help.md`). GenerateAnalysis fetches its priority series' 10-year history from FRED itself, so the report is current even between UpdateData runs; without `--output` it prints the report to stdout.

### Intent-to-Flag Mapping

| User says | Command / flag | Effect |
|-----------|----------------|--------|
| "how is the economy", "economic overview" | `GenerateAnalysis.ts --output=<Output Location>` | the full report, saved |
| "show me unemployment over 10 years" | `FetchFredSeries.ts UNRATE --years=10` | one series' trend statistics |
| "pull every core series" | `FetchFredSeries.ts --all --years=10` | trend statistics for every core series |
| "last 5 years only" | `--years=5` | shorter history window |

**Key FRED Series (Priority Fetch):**

| Category | Metric | FRED ID |
|----------|--------|---------|
| GDP | Real GDP | GDPC1 |
| GDP | GDP Growth Rate (QoQ) | A191RL1Q225SBEA |
| Inflation | CPI-U All Items | CPIAUCSL |
| Inflation | Core CPI | CPILFESL |
| Inflation | PCE Price Index | PCEPI |
| Employment | Unemployment Rate (U-3) | UNRATE |
| Employment | Nonfarm Payrolls | PAYEMS |
| Employment | Initial Jobless Claims | ICSA |
| Housing | Median Home Price | MSPUS |
| Housing | 30-Year Mortgage Rate | MORTGAGE30US |
| Consumer | Consumer Sentiment | UMCSENT |
| Consumer | Personal Saving Rate | PSAVERT |
| Markets | Fed Funds Rate | FEDFUNDS |
| Markets | 10-Year Treasury | DGS10 |
| Markets | 2-Year Treasury | DGS2 |
| Trade | Trade Balance | BOPGSTB |
| Fiscal | Federal Debt | GFDEBTN |

**Non-FRED Data (separate APIs):**
- Gas prices: EIA API (`PET.EMM_EPMR_PTE_NUS_DPG.W`)
- Oil prices: EIA API (`PET.RWTC.W`)
- Federal debt (daily): Treasury FiscalData API
