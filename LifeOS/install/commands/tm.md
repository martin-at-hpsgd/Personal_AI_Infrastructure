---
name: tm
description: Interactive voice-narrated tutorial on the current conversation topic (or a named one). Shortcut for the Explain skill's Teach intent. USE WHEN /tm, teach me, tutorial, quiz me.
argument-hint: [topic]
version: 1.0.2
---

# tm — Teach shortcut

Invoke the Explain skill's **Teach** intent on `$ARGUMENTS`:

```
Skill("Explain", "teach me $ARGUMENTS")
```

If `$ARGUMENTS` is empty, the topic defaults to whatever this conversation has been working on or asking about; on a fresh session with no topic, the intent asks.

Full procedure: `~/.claude/skills/Explain/Intents/Teach.md`.
