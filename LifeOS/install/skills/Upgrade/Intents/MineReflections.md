# MineReflections

**Contents:** Ideal State · Anti-criteria · Inputs · Output format · Examples · References

Mines internal algorithm reflections for recurring patterns that suggest Algorithm or system upgrades.

## Ideal State

- The report states how many entries of `~/.claude/LIFEOS/MEMORY/LEARNING/REFLECTIONS/algorithm-reflections.jsonl` it analyzed and the date range they span, and the count is the whole file.
- Every quote comes from the entry's improvement channel for its era (§ Inputs): `reflection` on schema 9, `notes` where present in the interim era, `reflection_q2` primarily (Q1/Q3 secondary) on legacy entries.
- Entries are weighted by signal strength per the signal table, with the Errata ledger joined by `context.session_id` for satisfaction where available.
- Similar answers are grouped into themes with their frequency counted across reflections, and each theme names the underlying structural issue it points to. Ideas that need more than a fix (legacy Q3 answers, or schema 9 reflections on what a fundamentally smarter AI would do) sit in a separate ASPIRATIONAL bucket that informs longer-term architecture decisions.
- Every theme with **2+ occurrences** (or 1 occurrence carrying a HIGH signal in the signal table) is an upgrade candidate in the candidate format, with supporting reflection quotes, root cause, proposed fix, target file(s) and effort estimate, for the Algorithm, skills, hooks, or system architecture.
- Candidates appear most recurring first, then by signal strength (highest first), then by effort estimate (lowest first), so quick wins rise.

## Anti-criteria

- Never append to `algorithm-reflections.jsonl` by hand; `LIFEOS/TOOLS/Reflect.ts` is the only sanctioned writer.
- No theme with a single occurrence becomes a candidate unless that occurrence carries a HIGH signal in the signal table.

## Inputs

The Algorithm writes a reflection after every run that did real work to `~/.claude/LIFEOS/MEMORY/LEARNING/REFLECTIONS/algorithm-reflections.jsonl` via `LIFEOS/TOOLS/Reflect.ts`. The improvement signal is the **`reflection` field**: what a smarter run would have done.

### Data Schema — three corpus eras

The corpus spans schema generations; mine the improvement channel by era:

| Era | Entries | Improvement channel |
|-----|---------|---------------------|
| Legacy (pre-2026-07-11) | `reflection_q1/q2/q3` questions, `implied_sentiment`, `criteria_*` | Q2 primarily; Q1/Q3 secondary |
| Interim schema 7/8 (2026-07-11 → 07-28) | operational telemetry only (`claims_total`, `within_budget`, `notes`, ...) | optional `notes` where present — the channel was dark here |
| Schema 9 (2026-07-28 →) | Reflect.ts-gated; `within_budget`/`spend` DERIVED from spend-audit | **required `reflection` field** |

Current-era entry (schema 9, authoritative shape in `LIFEOS/TOOLS/Reflect.ts`):

```json
{
  "schema": 9,
  "ts": "ISO",
  "session_id": "...",
  "slug": "...",
  "iteration": 1,
  "work_kind": "feature-build",
  "claims_closed": ["ISC-1"],
  "evidence_classes": ["bun-test"],
  "deploys": [],
  "within_budget": null,
  "spend": { "verdict": null, "verdict_confidence": null, "dispatches": 0, "rung_mix": {} },
  "context_sufficient": null,
  "reflection": "What a smarter run would have done",
  "notes": "operational notes"
}
```

**Not all reflections are equally valuable.** Weight entries by signal strength:

| Signal | Weight | Rationale |
|--------|--------|-----------|
| `within_budget: false` | HIGH | Measured over/underspend = structural issue (schema 9: derived from spend-audit, trustworthy) |
| joined Errata complaint with a rating <= 5 | HIGH | The user said the run went wrong (any era, joined by `context.session_id`) |
| `context_sufficient: false` | BOOST | Run started without what it needed |
| unclosed criteria (`claims_closed` short of the run's criterion set) | BOOST | Verification gap |
| legacy `implied_sentiment` <= 5 | HIGH | Low satisfaction = something went wrong (legacy era only) |
| legacy `criteria_failed > 0` / `rework_count > 0` | BOOST | Failed criteria or rework (legacy era only) |

**Highest signal entries:** substantive `reflection` (or legacy Q2) + a boosted operational signal. These are the gold. Join the Errata ledger (`bun LIFEOS/ERRATA/Errata.ts list --json --since <date>`) by `context.session_id` for satisfaction where available.

## Output format

Each upgrade candidate:

```
UPGRADE CANDIDATE: [Theme Name]
  Frequency: N reflections
  Signal strength: HIGH/MEDIUM/LOW
  Supporting reflections:
    - [timestamp] [task_description] — "[relevant reflection quote]"
    - [timestamp] [task_description] — "[relevant reflection quote]"
  Root cause: [What structural issue causes this pattern]
  Proposed fix: [Specific change to Algorithm, skill, hook, or system]
  Target file(s): [Which LifeOS files would change]
  Effort estimate: [Instant/Fast/Standard/Extended]
```

The report:

```
# Internal Reflection Mining Report

**Source:** ~/.claude/LIFEOS/MEMORY/LEARNING/REFLECTIONS/algorithm-reflections.jsonl
**Entries analyzed:** N
**Date range:** [earliest] to [latest]
**High-signal entries:** N (sentiment <= 5 or over-budget or failed criteria)

## Top Upgrade Candidates

### 1. [Theme Name] (N occurrences, HIGH signal)
**Root cause:** ...
**Proposed fix:** ...
**Target:** ...
**Effort:** ...
**Evidence:**
- ...

### 2. [Theme Name] ...

## Execution Pattern Warnings
- [Recurring mistake, from any era's channel (legacy Q1 included)] — seen N times
- ...

## Aspirational Insights
- [Fundamental improvement, from the ASPIRATIONAL bucket] — seen N times
- ...
```

## Examples

- Example themes: "ISC criteria too lenient", "class sweep runs after the build instead of before it", "delegates idle silently"

## References

Runs standalone ("mine reflections", "check reflections") or inside the main Upgrade run, in parallel with external source collection, as its internal signal.
