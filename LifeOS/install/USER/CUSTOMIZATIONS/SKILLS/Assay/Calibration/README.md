---
provenance: template
version: 1.0.0
---

# Assay/Calibration — your labeled calibration sets

One `<suite>.yaml` per suite whose LLM judge you want tuned to your own judgment. Read by `skills/Assay/Tools/Calibrate.ts`; the Calibrate intent writes them.

Format (a YAML list):

```yaml
- output: "the agent output text"
  assert: { type: llm-rubric, value: "what a good output does" }
  label: pass        # pass | fail — your call is the ground truth
  note: "why"        # optional; seeds the rubric mining
```

Fresh-install state: this README only. `Calibrate.ts <suite>` with no set here prints where to create one and exits 1.
