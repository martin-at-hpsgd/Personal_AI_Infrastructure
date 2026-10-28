# Oscillate

One question answered at two scope levels, narrow (component-first) and wide (system-first), with the divergence between the two answers as the deliverable.

## Ideal State

- A narrow answer to the question with the component as primary and the system as background, capturing what the thing naturally wants to be: its own logic, patterns, conventions, interfaces, and what a good implementation looks like in isolation.
- A wide answer to the *same* question with the system as primary and the component derived from it, capturing what the system needs from the component: coherence with adjacent pieces, alignment demands, and constraints the bigger picture imposes that local thinking misses.
- The two passes genuinely differ in what they treat as primary, and each framing produced something the other wouldn't.
- A synthesis names every point where the two answers diverge, gives each divergence a resolution and a scope recommendation, and ends on a coherence verdict (ALIGNED or DIVERGENT). If the two answers agree, "no divergence" is itself the finding and is stated: it means tactical and strategic are already coherent.

## Anti-criteria

- A wide answer that just restates the narrow one: it means the scope shift didn't happen.
- No oscillation when the tactical target and strategic context are essentially the same thing (no meaningful scope difference); it aborts and recommends IterativeDepth instead.
- No pass beyond the three: the narrow/wide/synthesis structure is complete at 3, and adding passes would just be lens rotation, which is IterativeDepth's job.

## Output format

Frame both inputs, then report results in this shape:

```
🔭 APERTURE OSCILLATION
 🎯 Tactical Target: [the specific thing — 1-2 sentences]
 🌐 Strategic Context: [the bigger picture — 1-2 sentences]

── Narrow (component-first) ──
[what the component wants to be, on its own logic]

── Wide (system-first) ──
[what the system needs the component to be]

── Synthesis ──
Divergences: [each point where narrow and wide disagree]

⚡ DESIGN TENSIONS:
[each tension + resolution recommendation]

📋 ISC IMPLICATIONS:
[new / refined / anti- criteria surfaced by the oscillation]

Coherence: [ALIGNED | DIVERGENT — one-line verdict]
💡 Key Insight: [the most important thing single-scope analysis would have missed]
```

## Inputs

- **Tactical Target:** The specific thing being built, designed, or decided. The narrow, concrete question.
- **Strategic Context:** The bigger-picture goal, system vision, or purpose the tactical target serves.
- **Current State (optional):** Any existing ISC criteria, approach decisions, or constraints already established.

If invoked without explicit inputs, extract them from the conversation: tactical = the specific ask being worked on; strategic = the broader goal, system, or vision in context (CLAUDE.md, TELOS, project context).

Two moments fit. Before ISC criteria are written, the tactical target is the request and the strategic context is project, TELOS or conversation context, so the tensions shape the criteria. Before an approach is committed, the tactical target is the proposed approach and the strategic context is the broader system or project goals.
