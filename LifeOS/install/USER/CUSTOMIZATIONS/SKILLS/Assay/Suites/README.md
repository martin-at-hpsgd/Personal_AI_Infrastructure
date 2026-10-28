---
provenance: template
version: 1.0.0
---

# Assay/Suites — your identity-bound eval suites

Suites that reference your own data, voice, or projects live here; generic suites live in the Assay skill's own `Suites/{Capability,Regression}/`. The runner resolves a named suite here first, then in the skill tree, `.yaml` before `.yml`. Subdirectories are walked except those starting with `_` or `.`; only `.yaml`/`.yml` files are loaded, so this README is ignored.

`_drafts/` is created on demand by `skills/Assay/Tools/FailureToCase.ts` for cases mined from failures; a draft is not listed as a suite until you promote it out of that directory.

Fresh-install state: this README only.
