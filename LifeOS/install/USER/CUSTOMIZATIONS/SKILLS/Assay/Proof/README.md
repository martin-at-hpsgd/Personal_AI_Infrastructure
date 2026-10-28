---
provenance: template
version: 1.0.0
---

# Assay/Proof — your standing Proof checks

One `standing-<kind>.json` per output kind (`text`, `doc`, `page`, `image`, `video`, `audio`). Read by `skills/Assay/Tools/Proof.ts` (`readStanding`) on every Proof run of that kind, after the built-in profile; `LIFEOS_PROOF_STANDING` overrides this directory for tests.

Format:

```json
{
  "checks": [
    { "id": "says-example-net", "type": "text-present", "pattern": "ExampleNet", "derived_from": null, "at": "all" }
  ]
}
```

A check that fails validation is dropped and named in the receipt's `profile`. Ids starting `safety-` or the layout prefix are reserved. A retired check stays in the file with `retired: {at, reason}` and is never read into a run.

Fresh-install state: this README only. `Proof.ts miss` creates the file for its kind and appends a check atomically; a missing file means no standing checks.
