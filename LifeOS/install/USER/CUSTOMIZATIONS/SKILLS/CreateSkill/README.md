---
provenance: template
version: 1.0.0
---

# CreateSkill — USER config directory

`skills/CreateSkill/SKILL.md` § Data & Config reads an optional `PREFERENCES.md` here: install-specific versioning commands and scaffolding conventions. It is read by the model, not parsed by code; no tool under `skills/CreateSkill/` opens a file from this path.

`PREFERENCES.md` beside this file is the template, with each key documented. Copy it into `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/CreateSkill/` and fill it in, or leave it out and the skill's defaults stand.
