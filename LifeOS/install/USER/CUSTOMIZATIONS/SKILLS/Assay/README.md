---
provenance: template
version: 1.0.0
---

# Assay — USER config files

The Assay skill is public code. This directory holds the one config file plus two subdirectories the runner looks in for identity-bound material. The config file, an optional `PREFERENCES.md`, an empty `IdentityTerms.json` and `Proof/README.md` ship as templates; the subdirectories are created by you (or by the tools) as suites appear.

| Path | Read by | Parsed how |
|------|---------|------------|
| `config.json` | `LIFEOS/TOOLS/ConfigEvalOnChange.ts:37-45` (`resolveSuite`) · `skills/Assay/Tools/ImageAsserts.ts` (`signatureMask`) | `JSON.parse`; for `config_change_suite` a missing or malformed file falls back to the default silently; a missing or malformed `ocr_signature_mask` (file or key absent included) is an error naming the file and key. |
| `Suites/` | `skills/Assay/Tools/EvalRunner.ts:34`, `:123-127` · `SuiteManager.ts:23`, `:36-44`, `:52` · `ImageEvalRunner.ts:41` · `Calibrate.ts:40` | First root searched for a named suite (`<name>.yaml`, then `.yml`, also under `Regression/` and `Capability/`); the skill's own `Suites/` is searched second. A missing directory is fine (`SuiteManager.ts:37`). |
| `PREFERENCES.md` (optional) | the model, when a run touches judge providers | Prose: your install's provider rulings and their dated history (for example, which vendors may judge private images). The skill's defaults stand when it is absent. |
| `IdentityTerms.json` (optional) | `skills/Assay/Tools/Proof.ts` (`readIdentityTerms`) | `JSON.parse`; key `terms`, a list of extra user names (2 to 64 characters each) Proof's safety scan reads as your own home path. Absent means none; a file with no `terms` array, or unreadable JSON, records an `unavailable` safety-scan finding, never a pass. Template ships `{"terms": []}`. |
| `Proof/standing-<kind>.json` (optional) | `skills/Assay/Tools/Proof.ts` (`readStanding`, `miss`) | `JSON.parse`; key `checks`, validated like any Proof check. Written by `Proof.ts miss`; absent means no standing checks. See `Proof/README.md`. |
| `Suites/_drafts/` | `skills/Assay/Tools/FailureToCase.ts:26` | Written by the tool, never read by the runner (`_`-prefixed dirs are skipped at `SuiteManager.ts:41`). |
| `Calibration/<suite>.yaml` | `skills/Assay/Tools/Calibrate.ts:39`, `:43-48` · `EvalRunner.ts:59` | YAML list of `{output, assert, label: pass|fail, note?}`; absent means the suite's judge stays at the default level. |

## `config.json` keys

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `config_change_suite` | non-empty `string` | `core-dispositions` | Suite run by `LIFEOS/TOOLS/ConfigEvalOnChange.ts` after a behaviour-defining file changes. The default is the generic suite that ships with the skill; point it at your own suite in `Suites/` once you have one. |
| `ocr_signature_mask` | `{"x0": number, "y0": number}` (fractions 0..1) or `false` | none (required; template ships `false`) | Corner blanked before the `ocr-word-ratio` image assert runs OCR, so a cursive signature stamp on your images is not read as a garbled word. The region runs from `x0` of the width and `y0` of the height to the bottom-right corner. `false` turns the mask off. |
## Not shipped

No suite or calibration YAML is included: those are identity-bound by definition (`skills/Assay/SKILL.md:72`) and seed from your real usage, never from invented cases.
