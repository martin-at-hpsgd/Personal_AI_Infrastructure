---
provenance: template
version: 1.0.0
---

# LifeOSHooks — this install

Read by the LifeOSHooks skill (SKILL.md § Gotchas, reload) before answering whether an open session runs the current module. Every value here is an example; replace each with how your install loads the plugin, or delete this file if you load it straight from the skills folder.

## Plugin loading topology

- Marketplace: `example-local`, a folder marketplace listing the plugin folder by relative path.
- Mods loaded from it: `LifeOS@example-local`.
- Skills-folder copies disabled in settings.json: `LifeOSHooks@skills-dir`.
- Consequence: an edit reaches no open session until `/reload-plugins`.

## Install state the module assumes

- One Claude login; the module reads no multi-login state.
