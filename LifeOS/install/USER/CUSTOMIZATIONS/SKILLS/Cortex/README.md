---
provenance: template
version: 1.0.0
---

# Cortex — USER config files

The Cortex skill (the memory system) is public code. The one file it reads from this directory configures the weekly Distill lane: `LIFEOS/TOOLS/KnowledgeDistill.ts` harvests the week's Knowledge Archive notes into a digest and routes each item to the system that owns it.

| File | Read by | Parsed how |
|------|---------|------------|
| `DistillConfig.json` | `LIFEOS/TOOLS/KnowledgeDistill.ts:43` (path), `:112-120` (`loadConfig`) | `JSON.parse`, spread over the defaults. A missing file uses the defaults silently; a malformed file logs `bad config ... using defaults` and continues. |

## `DistillConfig.json` keys

| Key | Type | Default (`KnowledgeDistill.ts:113`) | Used at | Meaning |
|-----|------|------------------------------------|---------|---------|
| `contentRepo` | `string` | unset | `:287-289` | GitHub repo (`owner/name`) that receives content-lane items as issues via `gh issue create`. Leave `""` and the content lane reports `not filed — no contentRepo configured` instead of filing. Set it only when `gh` is authenticated for that repo. |
| `contentLabel` | `string` | `content-idea` | `:289` | Label applied to each filed issue. |
| `maxIssues` | `number` | `5` | `:274` | Cap on content-lane items per run. |
| `maxUpgrades` | `number` | `5` | `:275` | Cap on system-lane items per run (these go to the Upgrades store, no config needed). |
| `maxDigestItems` | `number` | `10` | `:272-273` | Cap on total digest items. |
| `windowDays` | `number` | `7` | `:245`, `:358` | How many days of notes each run looks back over (`--days` on the CLI overrides). |

The template ships every key at its default so the file is safe to leave as is. Nothing else under `skills/Cortex/` reads this directory.
