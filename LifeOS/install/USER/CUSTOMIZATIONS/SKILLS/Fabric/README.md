---
provenance: template
version: 1.0.0
---

# Fabric — USER customizations

Declared in `skills/Fabric/SKILL.md` § Data & Config. Everything here is optional.

| Path | Read by | How |
|------|---------|-----|
| `PREFERENCES.md` | `SKILL.md` § Data & Config | Prose that overrides the skill's defaults. No tool parses it. |
| `Patterns/<name>/system.md` | `Intents/ExecutePattern.md` § Tool contract | Your own patterns, same layout as the skill's `Patterns/`. Read only when the shipped library has no pattern of that name. |

`Patterns/rate_example_topics/` is a made-up example of a local pattern: a labeler tuned to one writer's themes. Replace it with your own or delete it.
