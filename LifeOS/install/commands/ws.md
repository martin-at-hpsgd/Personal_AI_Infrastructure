---
name: ws
description: Word summary — anything told at N levels, from N words down to 1 word, for anything: a topic ("russian literature"), a URL, YouTube link, file, pasted text, a question, or "this". A leading number sets N (5 by default). Shortcut for the Fabric skill's WordSummary intent.
argument-hint: "[N] <topic | url | youtube | file | text | question | \"this\">"
version: 2.0.0
---

# ws — Word summary (N levels)

Alias for the **Fabric** skill's **WordSummary** intent: our ideal-state port of `create_5_sentence_summary`, at N levels set by the leading number.

- `/ws <url>` → 5 levels: 5 words, 4, 3, 2, 1
- `/ws 3 <text>` → 3 levels: 3 words, 2, 1
- `/ws 5 russian literature` → 5 levels of what the topic teaches: its lessons, never a description of it
- `/ws 8 this` → 8 levels, 8 words down to 1, on the current conversation's subject

```
Skill("Fabric", "WordSummary — $ARGUMENTS")
```

The intent owns the rules: `skills/Fabric/Intents/WordSummary.md`. N is the leading whole number, 5 by default, and the output passes `skills/Fabric/Tools/WordSummaryCheck.ts` before it is shown.

If `$ARGUMENTS` (after the number) is empty or is "this" / "that", summarize the current conversation's subject (the most recent source or topic in context) rather than asking what to summarize.
