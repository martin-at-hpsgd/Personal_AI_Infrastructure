---
intent: ViewModels
mode: single-run
---

# ViewModels

Reads and displays the current state of the world threat models in `LIFEOS/MEMORY/RESEARCH/WorldModels/`: each model's status and freshness, read-only. Ported from the retired WorldThreatModel skill on 2026-10-10 with nothing dropped.

## Ideal State

- The view matches its scope as defined in Output format: Overview by default (INDEX table, 2-3 sentence Executive Summary excerpt per model, models older than 30 days flagged for refresh by the freshness scale), the full model document with all sections for a single horizon, or side-by-side key themes with conflicts highlighted for a comparison.
- Every model shown carries a freshness label from comparing its last_updated to today, so the user can check model freshness before running TestIdea, and models needing refresh appear under Recommendations.

## Anti-criteria

- Never writes or modifies a model file or INDEX.md: this is a read-only intent.
- When INDEX.md does not exist, no model status is presented; the user is told no world models were found and to run UpdateModels.

## Inputs

`<configRoot>/LIFEOS/MEMORY/RESEARCH/WorldModels/INDEX.md` (configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). When it is missing, the message is "No world models found. Run 'update world models' to create them."

## Output format

**Overview** (default — no specific horizon mentioned):
- Display the INDEX table with all horizons, dates, versions, confidence
- For each model, show 2-3 sentence Executive Summary excerpt
- Flag any model older than 30 days for refresh (Aging or Stale on the scale below)

**Single Horizon** (user says "show me the 5-year model"):
- Read and display the full model document for that horizon
- Include all sections

**Comparison** (user says "compare near-term vs long-term"):
- Side-by-side key themes from selected horizons
- Highlight where short-term and long-term trends conflict

For each model, compare `last_updated` to today:
- **< 7 days**: 🟢 Fresh
- **7-30 days**: 🟡 Current
- **30-90 days**: 🟠 Aging — recommend refresh
- **> 90 days**: 🔴 Stale — strongly recommend update

```markdown
# 🌍 World Threat Model Status

| Horizon | Last Updated | Version | Confidence | Freshness |
|---------|-------------|---------|------------|-----------|
| 6 months | YYYY-MM-DD | N | HIGH | 🟢 Fresh |
| 1 year | YYYY-MM-DD | N | MEDIUM | 🟡 Current |
| ... | ... | ... | ... | ... |

## Summaries

### 6-Month Horizon
{2-3 sentence executive summary excerpt}

### 1-Year Horizon
{2-3 sentence executive summary excerpt}

...

## Recommendations
- {Any models needing refresh}
- {Any notable changes since last update}
```

## Examples

```
User: "show me the world models"
→ ViewModels
→ INDEX table with a freshness label per horizon and the models that need a refresh
```
