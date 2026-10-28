# Rank.ts

Score one or more collections down to the vital few.

```
bun ~/.claude/skills/Pareto/Tools/Rank.ts <collection.json> [more.json ...] [--top 100] [--out ranked.json]
```

Items below the relevance floor (0.2) are dropped before scoring. Each kept item carries `factors` (all 0..1):

| Factor | Weight | Meaning |
|---|---|---|
| relevance | 0.35 | Topic terms in title (x2) and description |
| reach | 0.25 | Percentile of log(views or stars) within its source; 0.5 when the source gives none |
| recency | 0.15 | exp(−age/365 days) |
| outlier | 0.25 | Percentile of reach ÷ author baseline (subscribers); stars per day for repos |

Plus `era` (`past` > 2 years, `current`, `undated`) and `frontier_candidate` (≤ 1 year old, measured reach outside the top third of its source, and outlier ≥ 0.6; Research-handoff items qualify when recent or undated). Up to a tenth of the slots are reserved for frontier candidates and past items so both report sections have material.
