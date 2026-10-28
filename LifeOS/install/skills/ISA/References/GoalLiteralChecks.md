# Goal-Literal Checks

The two CheckCompleteness checks that run only on an ISA whose frontmatter carries a `principal_stated_goal` key (`Intents/CheckCompleteness.md` § Goal-literal checks). Their severities stay in that intent's Severity table.

## The checks

- **Goal-signal mismatch:** `principal_stated_goal_signal:` is set but `principal_stated_goal:` is empty/null → hard failure: "literal capture missed — the detector fired but Scaffold did not preserve the literal." A non-null literal under 6 tokens or failing the minimum-content rule → hard failure: "literal violates minimum-content rule — should have been `null`."
- **Artifact presence (deepest work; 2026-05-11 lesson, an ISA marked a design surface done that existed only in chat):** for every `[x]` criterion that claims a named design surface ("the proposal includes X", "the design names Y", "a table appears"), the surface appears textually in the ISA body; otherwise hard failure: "ISC claims surface that does not exist in artifact (system-of-record violation)." The ISA carries its own design surface, never a pointer to ephemeral chat context.
