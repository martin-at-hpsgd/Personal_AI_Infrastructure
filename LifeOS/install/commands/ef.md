---
name: ef
description: Explain fundamentals — a deep, current explanation of the fundamentals of a project, work area or piece of infrastructure (or whatever we are working on), read fresh from its live sources. Shortcut for the Explain skill's ExplainFundamentals intent. USE WHEN /ef, explain the fundamentals of, catch me up on.
argument-hint: "[area] [short|deep]"
version: 1.0.0
---

# ef — Explain fundamentals

Invoke the Explain skill's **ExplainFundamentals** intent on `$ARGUMENTS`:

```
Skill("Explain", "explain fundamentals $ARGUMENTS")
```

If `$ARGUMENTS` is empty, the area defaults to whatever this conversation has been working in; on a fresh session with nothing in play, the intent asks.

Full intent: `~/.claude/skills/Explain/Intents/ExplainFundamentals.md`.
