# Explore

An enriched ISC criteria set for one problem, drawn from several exploration passes, each through a different lens, richer than single-pass analysis produces.

## Ideal State

- Every lens in the result comes from `TheLenses.md` and fits what this problem calls for, in whatever order and number earn their keep. When passes ran in sequence, each later pass's criteria extend or refine what the earlier passes found rather than restating it.
- Every pass kept in the result contributes at least one criterion no earlier pass found, and the run ends at the first lens that only repeats earlier findings.
- The returned ISC set is deduplicated: no two criteria are semantically identical across lenses or restate each other.
- Every criterion is in ISC form: binary-testable, 8-12 words, phrased as a state, not an action.
- Refinements to existing criteria are reported, each noting what changed and why; when multiple lenses refined the same criterion, the most specific version is kept.
- Within each criteria list, criteria surfaced by several lenses are listed before those surfaced by one.
- Anti-criteria, the failure modes that must not happen, are part of the result.
- The result holds at least one surprising cross-angle finding: a requirement that only appeared because two lenses collided.

## Anti-criteria

- Never a run that surfaces nothing a single pass would have missed; a run like that added no value.
- No lens added for its own sake, and none added after a pass has only restated previous findings: non-redundant angles are what matter, and more angles are not.

## Output format

```
🔍 ITERATIVE DEPTH COMPLETE ({N} lenses applied)

📊 Coverage:
- Lenses used: {list of lens names}
- New criteria discovered: {count}
- Existing criteria refined: {count}
- Anti-criteria discovered: {count}

📋 NEW ISC CRITERIA:
[one line each, prefixed "ISC-"]

📋 REFINED ISC CRITERIA:
[one line each, with evidence of what changed]

📋 NEW ANTI-CRITERIA:
[one line each, "ISC-N: Anti: ...", numbered in the same ISC pool as the new criteria]

💡 Key Insight: [The most surprising finding across all lenses — the thing single-pass analysis would have missed]
```

## Inputs

- **Problem/Request:** The original user request or problem statement
- **Context:** Any available context (conversation history, codebase state, prior work)
- **Lenses:** the catalog in `TheLenses.md`

## Tool contract

Return the enriched criteria to the calling context: into the ISA's criteria when called from an Algorithm run (before the criteria are written, so they are informed by the passes rather than corrected after), to the calling skill, or to the user when called standalone. Lenses can run inline or as parallel background agents.
