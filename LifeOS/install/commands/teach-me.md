---
name: teach-me
description: Interactive voice-narrated tutorial on the current conversation topic (or a named one) — ASCII diagrams, spoken lesson content, one question per beat, quizzes. Routes to the Explain skill's Teach intent. USE WHEN /teach-me, teach me, tutorial, quiz me, learn mode. NOT FOR plain written explanations with no dialogue (just answer directly).
argument-hint: [topic]
version: 1.0.2
---

# teach-me — Explain skill Teach intent

Invoke the Explain skill's **Teach** intent on `$ARGUMENTS`:

```
Skill("Explain", "teach me $ARGUMENTS")
```

If `$ARGUMENTS` is empty, the topic defaults to whatever this conversation has been working on or asking about; on a fresh session with no topic, the intent asks.

Full procedure: `~/.claude/skills/Explain/Intents/Teach.md`.
