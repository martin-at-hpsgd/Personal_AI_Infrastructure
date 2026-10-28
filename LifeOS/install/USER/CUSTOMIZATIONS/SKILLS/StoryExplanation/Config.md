---
provenance: template
version: 1.0.0
---

# StoryExplanation — Config

Your voice and optional integrations for the story-explanation intents. The
assistant reads this file before writing. Every field is optional; a missing
field means that step is skipped, never filled with someone else's value.

## Voice

- **Voice file:** `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/StoryExplanation/Voice.md` — a file describing how you write; explanations are written in this voice. Leave blank to use first person, plain and conversational.
- **Voice notes:** (a sentence or two on your register, for example: dry, short sentences, no exclamation marks)

## Integrations

- **Opinion lookup:** (a command that prints your published position on a topic, for example `bun ~/tools/my-posts.ts search "<topic>"`; leave blank to skip grounding)
- **Save directory:** (a folder where link-annotated explanations are saved, for example `~/Documents/explanations/`; leave blank to save nothing)
- **Explainer MCP tool:** (the name of an MCP tool that returns a 5-point explanation, or blank to use the built-in prompt)
