# ContextCheckin examples

Worked openings and a per-entry walk for `Intents/ContextCheckin.md`, showing the Output format shapes in an illustrative run (placeholder goals and figures): what was read, what was said, and what landed. Each quoted prompt is the question text of an `AskUserQuestion` call, with options shaped as the Output format describes.

## Opening on a system with stale system prompt

```
read freshness ⇒ lifeos_system_prompt 112d/90d (most stale across both surfaces)
Read LIFEOS/LIFEOS_SYSTEM_PROMPT.md fully
```

> "I read your context. **LIFEOS_SYSTEM_PROMPT** hasn't been touched in **112d** (threshold 90d). The Hard Prohibitions section says: *'Never self-rate responses or add unsolicited ratings. Never modify working features unprompted. Analysis means read-only…'* Still want all three of those, or has anything changed in how you want me to operate?"

## Opening when everything is fresh except an audit finding

```
read freshness ⇒ all 7 fresh
read AUDIT.md ⇒ critical: PROJECTS.md at 82 lines exceeds declared 45-line budget
```

> "Everything within freshness thresholds. One audit finding: PROJECTS.md is 82 lines, which is 82% over its declared 45-line budget. Want to trim, raise the budget, or split active state into a load-on-demand file?"

## Per-entry conversation on Goals

```
G3 stale (38d/30d)
Read TELOS.md lines 252-296
```

> "**G3** says: *'Grow the example community to 5,000 members by EOY.'* Where are we?"

Principal: "About 3,000 right now, growing a couple hundred a month. On track but tight."

```
Edit G3 with current-state context
bun TelosFreshness.ts --bump goals
voice-confirm
```

> "Updated G3 with the current count. **G7** is *'Ship ExampleNet v2.'* — that one moved at all, or still in design?"
