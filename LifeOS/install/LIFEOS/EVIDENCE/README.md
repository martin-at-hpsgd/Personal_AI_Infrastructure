# Evidence

A derived index of how the system actually behaved, built from the harness transcripts and the router decision log. It pairs each main-session turn with the router's pick and with what happened next, labels every human turn good or bad from several weak signals, and files the label model's confident misses into Errata as `detected` rows.

The index lives at `LIFEOS/MEMORY/EVIDENCE/evidence.sqlite`. It is not a ledger: delete it and `build` recreates it.

| Command | What it does |
|---|---|
| `bun LIFEOS/EVIDENCE/Project.ts build [--since YYYY-MM-DD]` | Builds or extends the index from transcripts |
| `bun LIFEOS/EVIDENCE/Project.ts query by-model\|by-skill\|compliance [--json]` | Read-only questions over the index |
| `bun LIFEOS/EVIDENCE/Nightly.ts [--emit] [--json] [--dry-run]` | Build, label and trigger in order, then one Vigil event with the counts |

Files: `Store.ts` (schema and incremental build), `Classify.ts` (prompt origin), `Decisions.ts` (router join), `Reactions.ts` (next-prompt reaction counts), `Label.ts` (labeling functions combined by Dawid–Skene), `Trigger.ts` (Errata filing), `Queries.ts` (read-only queries).
