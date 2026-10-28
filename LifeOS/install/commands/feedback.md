---
name: feedback
description: Send feedback about LifeOS itself — records it locally, drafts a clean GitHub issue with private details stripped, and files it under your own gh account only after you approve the exact text. Shortcut for the Errata skill's Send intent.
argument-hint: '[bug:|feature:|praise:] <what happened>'
version: 1.0.0
---

# feedback — Redirect

This command routes to the **Errata** skill's **Send** intent.

```
Skill("Errata", "send feedback: $ARGUMENTS")
```
