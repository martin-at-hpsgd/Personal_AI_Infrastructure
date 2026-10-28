---
intent: UpdateModels
mode: loop-compatible
---

# UpdateModels

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Output format · References

Refreshes or creates the 11 horizon world model documents in `LIFEOS/MEMORY/RESEARCH/WorldModels/` using deep research and user-provided analysis, so TestIdea always tests against current, dated models. Ported from the retired WorldThreatModel skill on 2026-10-10 with nothing dropped.

## Ideal State

- The choice of full creation vs. targeted update matches the state on disk before anything was written: INDEX.md (if it exists) and which models exist with their last_updated dates.
- The update matches its scope as defined in Inputs: Full Creation creates all 11 models from scratch, Targeted Update changes only affected models, Single Horizon updates only the specified horizon.
- Every created or updated model is grounded in research for its horizon (near-term on current events, immediate trends and specific forecasts; mid-term on trend trajectories, structural shifts and emerging patterns; long-term on megatrends, demographic forces and technological paradigm shifts); when the user provided analysis, the user's insights are the primary source and research is supporting.
- Each model follows ModelTemplate.md (`References/WorldModelTemplate.md`): frontmatter (horizon, last_updated: today, version: increment, confidence level), all 9 required sections with minimum word counts, hedging language for predictions, specific data points, named entities and cited reasoning, and a Wildcards section with probability estimates; it is saved to its horizon file.
- INDEX.md lists every horizon with file, last updated, version and confidence, and its Update History records what was updated and why.
- Every world model it writes lives under `<configRoot>/LIFEOS/MEMORY/RESEARCH/WorldModels/` with a `last_updated` date, so how fresh a model is shows before an idea is tested against it. Scenario models (alternative futures) stay in `<configRoot>/LIFEOS/MEMORY/RESEARCH/WorldModels/Scenarios/`, separate from the baseline horizon files.

## Anti-criteria

- Never states a prediction without hedging language.
- A targeted or single-horizon update never rewrites a model it did not affect.

## Inputs

Run when:

- User provides new information/analysis to incorporate into models
- Models are stale (>30 days since last update)
- Initial model population (no models exist yet)
- A major world event occurs: static threat models decay in accuracy.

Update scope:

**Full Creation** (no models exist or user says "rebuild all"):
- Create all 11 models from scratch

**Targeted Update** (models exist, user provides new analysis OR routine refresh):
- If user provided analysis: incorporate into relevant horizons
- If routine refresh: research what's changed since last_updated date
- Update only affected models

**Single Horizon** (user specifies "update the 5-year model"):
- Research and update only the specified horizon

The horizon files: `INDEX.md` (summary of all models with last-updated dates), `6-month.md`, `1-year.md`, `2-year.md`, `3-year.md`, `5-year.md`, `7-year.md`, `10-year.md`, `15-year.md`, `20-year.md`, `30-year.md`, `50-year.md`.

### Prerequisites

- Model template at `<configRoot>/skills/RedTeam/References/WorldModelTemplate.md` (configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`)
- Research skill available for web research

### State Management (Loop Compatibility)

- Models on disk are the state
- Each model is independently updatable
- INDEX.md tracks aggregate state

## Tool contract

For each model being created or updated:

- **Research skill** (Standard or Extensive mode depending on scope), query: "Current global state and projections for {HORIZON} timeframe: geopolitics, AI/technology trajectory, economics, society, environment, security. Focus on developments since {last_updated or 'baseline'}." Near-term is 6mo-3yr, mid-term 5yr-10yr, long-term 15yr-50yr.
- **Parallel execution** when creating multiple models:
   - Near-term batch: 6mo, 1yr, 2yr, 3yr (4 agents)
   - Mid-term batch: 5yr, 7yr, 10yr (3 agents)
   - Long-term batch: 15yr, 20yr, 30yr, 50yr (4 agents)
   - Each agent uses Research skill for its specific horizon

Save to: `<configRoot>/LIFEOS/MEMORY/RESEARCH/WorldModels/{horizon}.md`

### Agent Prompt Template (for parallel model creation)

When spawning agents for model creation, use this prompt structure:

```
CONTEXT: You are creating a world threat model for the {HORIZON} time horizon.
The current date is {TODAY}. This model will be used to test ideas, strategies,
and investments against projected future world states.

TASK: Write a comprehensive world model document following this template:
{INSERT ModelTemplate.md CONTENT}

REQUIREMENTS:
- Minimum 4,000 words across all sections
- Use hedging language for predictions ("likely," "projected," "if trends continue")
- Be specific: name countries, companies, technologies, cite numbers where possible
- Near-term models: heavier on current data extrapolation
- Long-term models: focus on structural forces and megatrends
- Include at least 4 wildcards with probability estimates
- Rate your overall confidence and explain why

RESEARCH: Use WebSearch to find current data, forecasts, and analysis relevant to
this {HORIZON} timeframe across all sections (geopolitics, technology, economics,
society, environment, security).

SLA: Complete within 5 minutes.

OUTPUT: Write the complete model document in markdown format following the template exactly.
Include the frontmatter with horizon, last_updated, version: 1, and confidence rating.
```

`{INSERT ModelTemplate.md CONTENT}` is the full text of `References/WorldModelTemplate.md`.

### Integration Points

| Skill | Purpose |
|-------|---------|
| **Research** | Primary data gathering for model content |
| **WebSearch** | Current events and projections |

## Output format

Write/update `<configRoot>/LIFEOS/MEMORY/RESEARCH/WorldModels/INDEX.md`:

```markdown
# World Threat Models — Index

Last full update: {date}

| Horizon | File | Last Updated | Version | Confidence |
|---------|------|-------------|---------|------------|
| 6 months | 6-month.md | YYYY-MM-DD | N | high/med/low |
| 1 year | 1-year.md | YYYY-MM-DD | N | high/med/low |
| ... | ... | ... | ... | ... |

## Update History

- YYYY-MM-DD: {what was updated and why}
```

## References

- `References/WorldModelTemplate.md` — the frontmatter, the 9 required sections with word counts, writing guidelines and minimum length.
