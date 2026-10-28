---
name: ew
description: Extract wisdom — content-adaptive sections, contrarian takes and quotes from a URL, YouTube link, file, pasted text, or "this". An optional depth word (instant, fast, basic, full, comprehensive) sets the level; full by default. Shortcut for the ExtractWisdom skill's Extract intent.
argument-hint: "[instant|fast|basic|full|comprehensive] <url | youtube | file | text | \"this\">"
version: 1.0.0
---

# ew — Extract wisdom (quick)

Alias for the **ExtractWisdom** skill's **Extract** intent.

- `/ew <url>` → Full extraction of that source
- `/ew fast <url>` → Fast level (3 sections of 3)
- `/ew this` → extract from the current conversation's subject

```
Skill("ExtractWisdom", "Extract — $ARGUMENTS")
```

If `$ARGUMENTS` is empty or is "this" / "that", extract from the most recent source in context rather than asking which one.
