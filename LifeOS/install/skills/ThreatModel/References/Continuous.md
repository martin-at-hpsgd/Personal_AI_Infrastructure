# Continuous review and the two register tiers

How the estate register is watched after a run, and how it sits under the TELOS life register.

## Continuous (the register is watched, not remembered)

The register feeds the standing-question engine (Socrates, if the install has it: `LIFEOS/SOCRATES/`) through a read-only `threatmodel` adapter. Each ref is a daily question that fails loudly and, when it keeps failing, becomes a ticket through the existing router:

| Ref | Question | Fails when |
|---|---|---|
| `overdue-review` | Is any open risk past its review date, or missing one? | any open row has `review_by` empty or ≤ today |
| `unowned-high` | Is any open High/Critical without an owner or a mitigation? | any such row has no owner or an empty mitigations list |
| `new-stores` | Has a data store appeared since the sensitive data map was generated? | a d1/r2/kv asset in the Atlas snapshot was first observed after the `EstateDataMap.md` generated date — the Atlas-delta trigger for re-running SensitiveDataMap and scoring the new store |

The `atlas` adapter's `injection-ungoverned` ref watches the InjectionSurfaceMap the same way (untrusted ingest surfaces with no active control). The questions only make sure a human reviews, rescores, and classifies. Per-risk falsifiers that need a ledger which does not exist yet stay `unanswerable` rows, never fake probes.

## Two tiers: the TELOS life register above, the estate register below

The estate register is the operational layer under the principal's life risk register, the `## Risks (RN)` section of `TELOS.md` (ids `R0`, `R1`, … — zero-indexed, no dash, never renumbered). Parser and validator: `bun ~/.claude/LIFEOS/TOOLS/TelosRisks.ts list|show|validate --links`. How the two link, and the life register's own fields, cadence and Socrates adapter: `LIFEOS/DOCUMENTATION/Telos/RiskRegister.md`.

- An estate row points up with `--telos-ref Rn` (`add`/`update`); the CLI checks the id exists in TELOS when the section is readable. Estate ids are `R-NNN`, so the two shapes never collide.
- A review here that changes a row's level or mitigation state is also a prompt to re-read the parent `Rn` line in TELOS.

**Scope.** Every row carries `scope` (values and the assignment rule in `Intents/RiskRegister.md` § Tool contract; legacy rows read as `personal`). One register serves the operator's life and their business; `render --scope <s>` prints one scope's rows as a standalone markdown register for export into that entity's own governance surface. This skill never performs that export — a private skill does, and only for non-personal scopes.
