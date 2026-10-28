# Analyze

Answer any question about US long-run indicators from the live dataset, with sources and direction-aware verdicts.

## Ideal State

- The answer addresses the actual question asked, grounded entirely in tool output from this session.
- Each series' publisher (`source`) is named when its numbers are quoted, per the dataset license.
- Better/worse claims use the series' `goodDirection` verdicts.
- YTD caveats and `note` methodology breaks are surfaced whenever they touch the years being compared.
- Correlation claims report r, N, and the overlap window, and keep the causation caveat.

## Anti-criteria

- No recalled figures: every number comes from this session's tool output.
- No value judgment on a `neutral` series.
- No `partialYear` (YTD) value quoted as an annual figure.
- No guessed series key when the topic is ambiguous; the candidate series from `search` are shown instead.

## Tool contract

```bash
TOOL=~/.claude/skills/USStats/Tools/UsStats.ts
bun $TOOL search <topic>              # find keys first when the user names a topic, not a key
bun $TOOL get <key> [--json]          # full series + provenance
bun $TOOL trend <key> [--from Y] [--to Y]
bun $TOOL movers [--window N] [--limit N]
bun $TOOL correlate <a> <b>
bun $TOOL summary
```

| User Says | Command / Flag |
|-----------|----------------|
| "since the 80s", "last 20 years" | `trend <key> --from 1980` / `movers --window 20` |
| "what's improving/declining" | `movers` |
| "does X track Y", "relationship between" | `correlate <a> <b>` |
| "latest data", "right now" | add `--fresh` |
| structured output for further processing | add `--json` |
