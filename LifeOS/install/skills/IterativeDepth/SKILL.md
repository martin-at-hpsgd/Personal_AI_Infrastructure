---
name: IterativeDepth
evals:
  manual:
    reason: "the usefulness of successive analytical lenses depends on whether they reveal real requirements for the supplied problem"
    falsifier: "the reviewer finds the passes repeat one lens, miss a material edge case, or produce unsupported criteria"
metadata:
  short-description: "Explore a problem through multiple analytical lenses to uncover requirements and edge cases. Use ApertureOscillation for tactical/strategic zoom."
version: 1.2.1
description: "Structured multi-angle exploration running 2-8 sequential passes over the same problem, each through a different scientific lens, to surface hidden requirements and edge cases invisible from one angle; each pass yields new ISC criteria. USE WHEN iterative depth, explore deeper, multi-angle analysis, surface hidden requirements, blind spot check, what am I missing. NOT FOR scope/zoom analysis (use ApertureOscillation)."
---

# IterativeDepth

IterativeDepth examines one problem through several structurally different lenses (literal, stakeholder, failure, temporal and more) and merges what each angle surfaces into ISC criteria a single pass misses. The method rests on 20 established techniques across cognitive science, AI/ML, requirements engineering and design thinking (`ScientificFoundation.md`).

## Ideal State

- A run returns ISC criteria and anti-criteria that a single pass over the same problem would have missed, each one binary-testable and deduplicated across lenses.
- The lenses fit the problem (a security problem leans on the failure and adversary angles, a UX problem on the experiential one). A run uses between two and eight passes and ends once a pass only repeats earlier findings, usually by about the fifth.
- The result names the lenses used and the cross-angle finding that only appeared because two lenses collided.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **Explore** | "iterative depth", "explore deeper", "multi-angle" | `Intents/Explore.md` |

| File | Read when |
|------|-----------|
| `TheLenses.md` | choosing lenses: the catalog of eight exploration angles, concrete to abstract, each with its question, grounding and example prompt |
| `ScientificFoundation.md` | justifying the method or explaining why multi-lens passes work: the 20 techniques it rests on and how it differs from CS iterative deepening |

## Data & Config

User customizations live at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/IterativeDepth/` (`configRoot` is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). When that directory exists, its PREFERENCES.md, configurations and resources override the defaults; when it is absent, the defaults stand.

## Gotchas

None reproduced yet.

## Examples

```
User: "Inline, no agents: 3 quick passes over the issue-security route design (private vs public)"
→ Explore intent
→ Three lenses run inline; new criteria and anti-criteria for each route outcome, with the cross-angle finding
```

```
User: "What am I missing in this ISA coordination design?"
→ Explore intent
→ Criteria and anti-criteria the design lacked and existing criteria refined, with the lenses named, returned to the user
```
