---
provenance: template
version: 1.0.0
---

# Standing Questions

This directory holds standing questions for the Socrates system — prompts that get regular scheduled answers and route into the vulnerability registry and your work tracker.

On a fresh install this directory is empty by default. Seed initial questions using:

```bash
bun LIFEOS/SOCRATES/Socrates.ts seed
```

You can then add, edit, or list questions using the Socrates CLI. Each question becomes a standing item with scheduled three-valued answers and action routing based on the answer.

Available commands: `validate`, `seed`, `tick`, `sync`, `list`, `show`, `board`, `findings`, `route`, `rebuild`, `export`.
