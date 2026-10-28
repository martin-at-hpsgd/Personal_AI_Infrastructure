---
provenance: template
version: 1.0.0
---

# SOCRATES — standing questions the system keeps answering

Socrates holds questions you want asked on a schedule ("is every deployed app green?", "is any risk past its review date?") and records each answer as yes, no, or unknown, routing a bad answer into the vulnerability registry or your work tracker.

- `questions/`: one file per standing question. `questions/README.md` explains the file shape and the commands that validate, seed, and run them.
- `findings.jsonl`: appended by the router when an answer opens or resolves a finding. Created on first run; do not create it by hand.

Seed the starter set with the command in `questions/README.md`, then add your own questions as files in the same shape.
