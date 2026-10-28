# ConceptMap

A Novak-style concept map that answers one focus question with labeled propositions and cross-links between regions.

## Ideal State

- The map answers one stated focus question with 10–30 concrete noun concepts at comparable granularity.
- Every concept-link-concept is a labeled proposition that reads as a meaningful statement.
- Cross-links expose dependencies between regions and carry insights beyond the hierarchy.
- Hierarchy runs general-to-specific; a flat map is valid when concepts genuinely share a level.
- A map exceeding 30–50 concepts is split into regional sub-maps.
- A map of the Algorithm takes its components and relationships from the current `LIFEOS/DOCUMENTATION/Algorithm/AlgorithmSystem.md`, never from a remembered list.

## Anti-criteria

- No unlabeled edges or orphan concepts remain.
- A missing cross-link merits review, never a fabricated relationship.
- Dynamic causal analysis is not done in the concept map; it belongs in CausalLoop, and concept maps express domain relationships.

## Output format

```
📊 CONCEPT MAP: [topic]

FOCUS QUESTION: [...]

CONCEPTS (general → specific):
- [C1], [C2], ..., [Cn]

HIERARCHY:
  [C1]
    ├─ [C2]
    │   └─ [C5]
    └─ [C3]
        └─ [C6]

PROPOSITIONS (concept → [link] → concept):
- [C1] → [contains] → [C2]
- [C2] → [uses] → [C5]
- ...

CROSS-LINKS:
- [C5] → [feeds back into] → [C3] — reveals non-obvious dependency
- [C6] → [validates through] → [C2] — hidden validation path

KEY INSIGHTS:
- [Insight from cross-link 1]
- [Insight from cross-link 2]
```

## Tool contract

Render with the Art skill:

```bash
Skill("Art", "Mermaid concept map with focus question [Q], concepts: [list], labeled links: [list], cross-links: [list]")
```

Mermaid, Graphviz or d2 all work. Mermaid renders inline in most editors; Graphviz produces higher-quality static images.

## References

- When mapping the Algorithm, `LIFEOS/DOCUMENTATION/Algorithm/AlgorithmSystem.md` § Component map lists its parts.
- Concept maps of Knowledge Archive entries pair with **Cortex**.
- Hand-off: the map's concepts and propositions seed Iceberg Layer 3 (structure: actors and relationships, `Intents/Iceberg.md`) and give CausalLoop its candidate variables and arrows (`Intents/CausalLoop.md`).
