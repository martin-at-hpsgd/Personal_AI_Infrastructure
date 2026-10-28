# SensitiveDataMap

Produce a classified map of which assets in the estate hold sensitive data, written to the private data dir.

## Ideal State

- An `EstateDataMap.md` exists in the data dir where every data-bearing asset is tagged with the data classes it holds and why.
- Every asset that cannot be classified from evidence is listed explicitly as `unclassified` and surfaced for follow-up — never omitted, never assumed clean.
- Every data store (database, bucket, KV) and every asset holding credentials is in the map, classified or on the unclassified list, because they anchor impact scoring in scenarios and the register.
- Without an asset graph, the output states that coverage is user-enumerated, not graph-complete.
- The close reports the count by data class, the highest-sensitivity assets, and the unclassified list, and offers CompromiseScenario on the top data-bearing assets and to land standing risks in the register.

## Anti-criteria

- Credential stores are referenced by name/key only.
- The map is never named `DataClassification`: `DOCUMENTATION/Security/DataClassification.md` is a different document that two enforcement hooks load, and the collision made both undiscoverable.

## Output format

An `EstateDataMap.md` in the data dir: one entry per data-bearing asset with its data classes and why, and every unclassified asset listed as unclassified. The map is the input to scoring impact in scenarios and the register.

Data classes (extend per `PREFERENCES.md`): `credentials` · `pii` · `financial` · `health` · `customer-data` · `source-private` · `internal-only` · `public`.

## Inputs

If the estate scope is unclear (whole estate vs one app vs one provider) and the choice changes the output, emit one ambiguity flag and proceed with "whole estate via the asset graph." `proceed` accepts.

## Tool contract

Prefer the asset graph if present:

```bash
bun ~/.claude/LIFEOS/ATLAS/Atlas.ts sql "SELECT kind, canonical_key, attrs FROM asset WHERE kind IN ('worker','domain','d1','r2','kv','repo','project')"
bun ~/.claude/LIFEOS/ATLAS/Atlas.ts sql "SELECT canonical_key FROM asset WHERE kind IN ('d1','r2','kv')"   # data stores first
```

Without a graph: enumerate from what the user names plus repo/config inspection, and state in the output that coverage is user-enumerated, not graph-complete.
