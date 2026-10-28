---
name: ea
description: Extract alpha — the N highest-alpha, net-new ideas in a URL, YouTube link, file, pasted text, or "this", as short ranked bullets. An optional leading number sets N (24 by default). Shortcut for the ExtractWisdom skill's Alpha intent.
argument-hint: "[count] <url | youtube | file | text | \"this\">"
version: 1.0.0
---

# ea — Extract alpha (quick)

Alias for the **ExtractWisdom** skill's **Alpha** intent.

- `/ea <url>` → the 24 highest-alpha ideas
- `/ea 8 <url>` → the top 8
- `/ea this` → alpha from the current conversation's subject

```
Skill("ExtractWisdom", "Alpha — $ARGUMENTS")
```

If `$ARGUMENTS` is empty or is "this" / "that", extract from the most recent source in context rather than asking which one.
