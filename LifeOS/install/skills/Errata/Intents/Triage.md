# Triage

Run enrichment and triage now instead of waiting for the daily job.

## Ideal State

- Every erratum with a null enrichment is enriched or reported as left null with the model error.
- A triage report exists for today under the ledger's `reports/` dir.
- Each cluster that met the bar has an Upgrades record and its entries carry `links.upgrade_id`.
- The reply names the report path, the clusters, and the upgrade ids filed, and says plainly when nothing met the bar.

## Anti-criteria

- Never retries after the command exits non-zero under `LIFEOS_INFERENCE_DISABLED`; that exit is reported, and from a liveness probe or a hook it is correct, not a bug.

## Tool contract

```bash
bun ~/.claude/LIFEOS/ERRATA/Errata.ts daily        # enrich, then triage
bun ~/.claude/LIFEOS/ERRATA/Errata.ts enrich       # one half
bun ~/.claude/LIFEOS/ERRATA/Errata.ts triage       # the other half
```

Runs a model on the configured unattended lane. Under `LIFEOS_INFERENCE_DISABLED` the command exits non-zero without touching the ledger.
