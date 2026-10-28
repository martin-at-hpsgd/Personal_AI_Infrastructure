---
name: ha
description: Mine one piece of content (URL, YouTube, article, text, file) for anything useful to LifeOS, then ingest it into the Knowledge Archive. Shortcut for the Harvest skill.
argument-hint: [url, youtube link, file path, or text]
version: 1.0.3
---

# ha — Redirect

Alias for `/harvest`. Routes to the **Harvest** skill's Mine intent: take one input, mine it for anything worth adopting into LifeOS, return a ranked report, then ALWAYS ingest the content into the Knowledge Archive as the final step. System adoption stays report-only.

**Invoke the skill directly:**

Use the Skill tool to invoke Harvest with the provided arguments:

```
Skill("Harvest", "$ARGUMENTS")
```
