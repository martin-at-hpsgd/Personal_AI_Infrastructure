---
name: qf
description: Quiz fundamentals — a graded quiz on the fundamentals of a project, work area or piece of infrastructure, weighted to past misses and recent changes, with every answer recorded. Shortcut for the Explain skill's QuizFundamentals intent. USE WHEN /qf, quiz me on the fundamentals of, test what I know about.
argument-hint: "[area] [N questions]"
version: 1.0.0
---

# qf — Quiz fundamentals

Invoke the Explain skill's **QuizFundamentals** intent on `$ARGUMENTS`:

```
Skill("Explain", "quiz fundamentals $ARGUMENTS")
```

If `$ARGUMENTS` is empty, the area defaults to whatever this conversation has been working in; with nothing in play, the intent offers the most overdue areas.

Full intent: `~/.claude/skills/Explain/Intents/QuizFundamentals.md`.
