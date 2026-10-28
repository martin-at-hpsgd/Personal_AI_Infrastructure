# AlgorithmUpgrade

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Output format

Section-targeted upgrade proposals for the LifeOS Algorithm, drawn from the system's own learning signals and checked against the current spec.

## Ideal State

- Every proposal quotes the current spec text exactly, from the version named in `LIFEOS/ALGORITHM/LATEST` (`LIFEOS/ALGORITHM/v{VERSION}.md`), never from memory: the Algorithm changes often.
- An Algorithm digest of that spec, in the shape under Output format, existed before any proposal was drafted, and no proposal contradicts a design decision it lists.
- The report cites evidence from all four learning sources in § Inputs and names which Algorithm rules should have prevented the recorded failures but didn't.
- Every signal is assigned to a row of the Algorithm Section Map and weighted by what its era carries, per the signal table in `MineReflections.md` § Inputs: schema 9 entries by `within_budget`, `context_sufficient`, unclosed criteria and a joined Errata complaint; legacy `implied_sentiment` <= 5 and `criteria_failed > 0` only on pre-2026-07-11 entries, since current entries do not carry them.
- The Claude Code features the spec references (agent types, hook events, slash commands) were verified current through `claude-code-guide` before proposals were final; any stale reference or missing feature is its own proposal, tagged with source `claude-code-guide` and priority based on staleness impact.
- Every theme with 2+ occurrences across all sources (or 1 if HIGH signal) has a proposal in the proposal format: it locates the section in the current spec, quotes the current text, says whether this is a known design choice being violated or a genuine gap (the rule missing, too weak, ambiguous, or just not enforced), and drafts the specific text change with before/after.
- The report follows the Output format: Section Heat Map, proposals sorted by priority then frequency, Aspirational Insights, and a recommended version bump set by the Algorithm's versioning rule (§ Output format).

## Anti-criteria

- Do not propose changes that contradict existing design decisions unless the learning data shows those decisions are fundamentally wrong. A rule that exists but isn't followed needs enforcement, not removal.
- Never map a theme to OBSERVE, PLAN or VERIFY; the Algorithm has no phases (retired 2026-07-14).
- The upgrade analysis never starts from memory or assumptions about the Algorithm.

## Inputs

The four learning sources, labelled as the analysis agent and the report cite them:

- **Step 2a** algorithm reflections: the improvement channel by era, per `MineReflections.md` § Inputs (Data Schema — three corpus eras).
- **Step 2b** Errata complaints with a non-null rating <= 5 (`bun LIFEOS/ERRATA/Errata.ts list --json --since <date>`); `context.response_preview` and the complaint show what went wrong from the user's side, not just the Algorithm's self-assessment.
- **Step 2c** `~/.claude/LIFEOS/MEMORY/LEARNING/ALGORITHM/`: the newest dated month directory, then the previous one.
- **Step 2d** `~/.claude/LIFEOS/MEMORY/LEARNING/FAILURES/`: the latest month plus ROOT_CAUSE_ANALYSIS.md.

Step 1 is the Algorithm digest under Output format. MineReflections may suggest this intent when it finds Algorithm-related themes.

### Algorithm Section Map

The one routing table for where a signal's fix lands. The Algorithm section column names H2s of the current `LIFEOS/ALGORITHM/v<LATEST>.md`; when the spec's H2s change, this table changes with it.

| Theme Pattern | Algorithm Section (current `LIFEOS/ALGORITHM/v<LATEST>.md`) | Where the fix lands |
|---------------|-------------------|---------------|
| Built the wrong thing, direction drift | `## The point`, completion criterion 1 | the ladder rules, `IsaLadder.ts drift` |
| ISC quality, vague or missing criteria, no anti-criterion | completion criteria 2, 3, 14 | `LIFEOS/DOCUMENTATION/ISA/ISAFormat.md`, the ISA skill |
| Spend too high or too low, effort mismatch | `## Spend`, criterion 15 | `## Spend` |
| Wrong thinking skill or tool, depth words ignored | `## Route`, `## Spend` (thinking skills) | `LIFEOS/ROUTER/Depth.ts`, Algorithm § Routing |
| Agent overhead, wrong parallelization, idle delegates | `## Spend` (four facts), `## Telemetry & records` (fan-out) | Algorithm § Routing |
| Context recovery, prior work missed, ambiguity | completion criterion 6, `## Telemetry & records` (resume) | the Cortex skill |
| Verification gaps, claims without proof, sibling bugs missed | completion criteria 8, 9, 11, 16 | `LIFEOS/RULES/Verification.md`, VerificationGate |
| ISA out of sync, phase or progress wrong | completion criterion 13, `## Telemetry & records` (phase) | `LIFEOS/TOOLS/ascent.ts` |
| Nudges, mid-run events, notifications | `## Events ask the rest` | `LIFEOS/ALGORITHM/AlgorithmReference.md` § Events ask the rest |
| Iteration, resuming a complete run | criterion 14, `## Telemetry & records` (resume) | `## Telemetry & records` |
| Stopping early or stalling silently | `## Telemetry & records` (when a run may stop) | `## Spend` (idle delegate rule) |

## Tool contract

Two agents, spawned once the Algorithm digest (Step 1) exists.

**Analysis** (`subagent_type=general-purpose`) gets the four sources in § Inputs and the Algorithm Section Map. It classifies each signal to one map row, or `OTHER` when none fits, weights it per the Ideal State, and hands back the shape below, which the proposals and the Section Heat Map are built from. A reflection with no text in its era's improvement channel is counted as analyzed but contributes no quote; a missing or empty corpus returns `{ 'entries_analyzed': 0 }`.

```
{
  'entries_analyzed': N,
  'date_range': '[earliest] to [latest]',
  'section_hits': {
    '[Algorithm section from the map]': { 'count': N, 'quotes': ['...'], 'signal': 'HIGH/MED/LOW' },
    ...
  },
  'top_themes': [
    {
      'section': '[Algorithm section from the map]',
      'theme': '[specific issue]',
      'frequency': N,
      'signal': 'HIGH',
      'root_cause': '[why this keeps happening]',
      'quotes': ['[improvement-channel excerpts with timestamps]']
    }
  ],
  'aspirational': ['[fundamental improvement ideas: legacy Q3 answers, or schema 9 reflections that need more than a spec edit]']
}
```

**Freshness** (`subagent_type=claude-code-guide`) reads the current spec at `~/.claude/LIFEOS/ALGORITHM/v{VERSION}.md` (version from `~/.claude/LIFEOS/ALGORITHM/LATEST`) and checks that every `subagent_type` value is a valid current type, every slash command still exists, every hook event matches the current Claude Code hook API, no referenced feature is deprecated or renamed, and no Claude Code feature the Algorithm should know about is missing. It hands back:

```
{
  'stale_references': [{'reference': '...', 'current_state': '...', 'fix': '...'}],
  'missing_features': [{'feature': '...', 'why_relevant': '...', 'proposed_entry': '...'}],
  'confirmed_current': ['list of references that are still accurate']
}
```

## Output format

Step 1, the Algorithm digest, written before any proposal. It has one line per H2 of the live spec, in the spec's order and under the spec's own heading names (in v8.37.0: The point, Route, The Loop, A run is complete when, The ISA asks the questions, Events ask the rest, Spend, Telemetry & records), so a section the spec no longer has never appears:

```
   ALGORITHM DIGEST: v{VERSION}
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━
   [Each H2 of the spec]: [what that section requires, in its own words]
   A run is complete when: [number every criterion with its pass condition]

   DESIGN DECISIONS (important for upgrade analysis):
   - [List 5-10 deliberate design choices visible in the spec,
      e.g., "a run is complete only when every numbered criterion holds", "ISC requires anti-criteria"]

This digest is the baseline. Every upgrade proposal must be compared against it
to avoid proposing changes that contradict existing design intent.
```

Step 4, one proposal per qualifying theme:

```
ALGORITHM UPGRADE PROPOSAL #{N}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Section: [Algorithm section name]
Priority: [CRITICAL / HIGH / MEDIUM / LOW]
Signal: [N reflections, {HIGH/MED/LOW} average signal]

Problem: [What keeps going wrong, in 1-2 sentences]

Current spec says:
> [Quote the relevant current Algorithm text]

Proposed change:
> [New text that would fix the issue]

Why this helps:
[1-2 sentences explaining how this change prevents the recurring issue]

Evidence:
- [{timestamp}] {task} — "{reflection quote}"
- [{timestamp}] {task} — "{reflection quote}"
```

The recommended bump follows the Algorithm's own versioning rule, never a proposal count. The level comes from what the change does: Patch for a fix or wording with no behavior change, Feature for an additive rule or section, Major for a breaking change, which only the principal approves (OPERATIONAL_PREFERENCES § Versioning). `LIFEOS/ALGORITHM/changelog.md` (not in the public release) labels every past version PATCH or FEATURE under this rule; match its precedent for the same kind of change. No actionable proposals means no bump.

The report:

```markdown
# Algorithm Self-Upgrade Report

**Current Version:** v{VERSION}
**Reflections Analyzed:** {N} entries spanning {date range}
**High-Signal Entries:** {N}
**Upgrade Proposals:** {N} ({N} critical, {N} high, {N} medium, {N} low)
**Recommended Version Bump:** v{NEW_VERSION} ({patch/feature/none})

---

## Section Heat Map

Which Algorithm sections have the most recurring issues:

| Section | Hits | Signal | Top Theme |
|---------|------|--------|-----------|
| [Section] | [N] | [HIGH/MED/LOW] | [Theme] |

---

## Upgrade Proposals

[Proposals from Step 4, sorted by priority then frequency]

---

## Aspirational Insights (legacy Q3 and larger-than-a-spec-edit reflections)

Ideas that require fundamental changes, not just spec edits:
- [pattern with frequency]

---

## Next Steps

- [ ] Review proposals
- [ ] Apply approved changes to Algorithm spec
- [ ] Bump version if warranted
- [ ] `ARCHITECTURE_SUMMARY.md` auto-regenerates via DocIntegrity on SessionEnd; no manual rebuild
```
