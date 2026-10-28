---
provenance: template
---

# ThreatModel — your risk register

The Pulse `/achilles` page (risk panel) reads `risk-register.json` in this
directory. Without it the panel says no register exists.

## How it gets filled

Start the register with the ThreatModel skill's tool, then add risks through it:

```sh
bun ~/.claude/skills/ThreatModel/Tools/RiskRegister.ts init
bun ~/.claude/skills/ThreatModel/Tools/RiskRegister.ts add --title "<what could go wrong>"
```

Or ask your DA: "run a threat model on my setup". The tool writes the
register, scenario docs and data classifications here. It refuses a data
directory inside a `skills/` path, so code and data stay separate. Set
`THREATMODEL_DATA_DIR` to move it.

## Format

`risk-register.json` holds `{ "updated": "<ISO time>", "risks": [ ... ] }`.
Each risk carries an id (`R-001`), a title, a `level` (Critical, High,
Medium, Low), a `status`, and a review date. The tool owns the schema, so
edit through `RiskRegister.ts update` rather than by hand.

## Privacy

A risk register is a map of how you could be hurt. It never ships in a
release. Pulse only serves a redacted summary of it, and only on your machine.
