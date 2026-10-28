---
name: ApertureOscillation
evals:
  manual:
    reason: "a reviewer must judge whether the synthesis preserves the actual tactical and strategic tensions in the supplied question"
    falsifier: "the reviewer identifies a material tension omitted, collapsed, or misrepresented in the delivered synthesis"
metadata:
  short-description: "Explore one question at tactical and strategic zoom levels, then synthesize scope and design tensions. Use IterativeDepth for different analytical lenses."
version: 1.0.17
description: "3-pass scope oscillation that holds a question constant while shifting zoom — narrow/tactical, wide/strategic, then synthesis — to surface design tensions, scope recommendations, and coherence assessments invisible at any single zoom level. USE WHEN aperture oscillation, oscillate scope, zoom in and out, tactical vs strategic, scope framing, design tension, system coherence check, local vs global design, wrong scope, scope negotiation. NOT FOR lens rotation across angles (use IterativeDepth)."
---

# ApertureOscillation

Holds one question constant and answers it at two zoom levels: narrow (what the component wants to be on its own) and wide (what the system needs it to be). A third pass names where the two answers disagree, and that gap is the output. The point is to catch a component that works on its own but fights the system before the build commits to it. IterativeDepth varies the analytical lens instead of the scope; when both apply, run IterativeDepth first (understand the problem), then ApertureOscillation (understand where the solution fits).

## Ideal State

- The principal gets a coherence verdict that changes or confirms a design decision before the build commits to it: a component that works alone but fights the system is caught at scoping, not after it ships.
- Scope questions land here and angle questions land in IterativeDepth, so the two skills never run the same analysis twice.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **Oscillate** | "aperture oscillation", "oscillate scope", "zoom in/out", "tactical vs strategic"; an Algorithm run selects the ApertureOscillation capability while scoping | `Intents/Oscillate.md` |

## Gotchas

- None reproduced yet. Add each real failure here, dated, with where it was seen.

## Examples

**Example 1: Feature design within a system**
```
Tactical target: "Build a caching layer for session data"
Strategic context: "LifeOS is a Life OS that needs responsive, session-spanning AI assistance"

Pass 1 (Narrow): Redis with TTL, standard session cache patterns
Pass 2 (Wide): Cache must survive session boundaries, integrate with memory system, serve the Life OS vision
Pass 3 (Synthesis): Tension — standard session cache expires data that the Life OS needs to persist. Resolution: hybrid cache with session-scoped fast layer + memory-backed persistent layer.
```

**Example 2: Architecture decision**
```
Tactical target: "Add webhook support to the Feed system"
Strategic context: "Feed is one pipeline in Workflows, which processes content for a reader app"

Pass 1 (Narrow): Standard webhook receiver, queue, retry logic
Pass 2 (Wide): Webhooks must flow through Workflows' action/function pattern, integrate with existing queue infrastructure
Pass 3 (Synthesis): Tension — standalone webhook service vs. Workflows action. Resolution: implement as Workflows action, not standalone service, because the strategic context demands pipeline coherence over component independence.
```
