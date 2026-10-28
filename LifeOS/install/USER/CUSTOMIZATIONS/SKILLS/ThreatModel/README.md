---
provenance: template
version: 1.0.0
---

# ThreatModel — USER customizations

Declared in `skills/ThreatModel/SKILL.md` lines 12-16. One file is read from here, as prose.

| File | Read by | How |
|------|---------|-----|
| `PREFERENCES.md` | `SKILL.md` line 16 (data locations, sensitive-data class priorities, response runbook cross-references); `Intents/SensitiveDataMap.md` line 22 (extends the data-class list) | Prose. No tool parses it. |

Threat-model output does not go here. Scenario docs, data classifications, and the risk register are written by `Tools/RiskRegister.ts` to `THREATMODEL_DATA_DIR`, default `~/.claude/LIFEOS/USER/SECURITY/THREATMODEL/` (`RiskRegister.ts` line 65). The tool refuses any data dir inside a `skills/` path.
