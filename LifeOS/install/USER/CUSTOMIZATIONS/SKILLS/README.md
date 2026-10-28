---
provenance: template
---

# Skill Customizations

**Purpose:** Per-skill overrides — the place to change a default skill behavior without forking the skill itself.

**What lives here:** One subdir per customized skill, named to match the skill (e.g. `CUSTOMIZATIONS/SKILLS/<SkillName>/`). Each skill that supports customization documents which files it reads from its override dir — typically configuration, templates, or prompt fragments that the skill merges over its defaults at runtime.

**How it gets populated:** A fresh install ships one template dir per skill that reads config from here (a `Config.md`, `PREFERENCES.md`, or a JSON/YAML file, each with every key the skill reads, an example value in the right shape, and where to get it). Skills run on those defaults until you edit them; a skill with no dir here needs nothing.

**Sample state for fresh installs:** One template dir per config-reading skill, every file marked `provenance: template`. Real values replace the placeholders as you set each skill up.
