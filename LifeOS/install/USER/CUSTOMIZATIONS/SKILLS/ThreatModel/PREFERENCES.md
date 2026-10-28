---
provenance: template
version: 1.0.0
---

# ThreatModel preferences

> Applied by every ThreatModel intent when present (`skills/ThreatModel/SKILL.md` line 16). Read as prose; no tool parses it. Every section is optional. Register entries name credentials by environment-variable name only, never by value, and that rule applies to this file too.

## Data locations

Where the workflows should look when mapping sensitive data, beyond what Atlas already inventories. Paths and service names, no secrets.

- Private USER tree: `~/.claude/LIFEOS/USER/`
- Secrets file: `~/.claude/.env` (names only ever appear in output)
- Project repositories: `~/Projects/`
- Cloud accounts: (provider and account label, e.g. "Cloudflare, main account")
- Threat-model data dir: `THREATMODEL_DATA_DIR`, default `~/.claude/LIFEOS/USER/SECURITY/THREATMODEL/`

## Sensitive-data class priorities

The default classes from `Intents/SensitiveDataMap.md` line 22, highest impact first. Reorder, or add classes of your own; impact scoring anchors to this order.

1. `credentials`
2. `pii`
3. `financial`
4. `health`
5. `customer-data`
6. `source-private`
7. `internal-only`
8. `public`

## Response runbook cross-references

Where the "how would you respond" step of a compromise scenario should point. The skill plans responses; it does not execute them.

- Key rotation: (path to your rotation runbook, or the skill that owns it)
- Account lockout and recovery: (path)
- Provider abuse or takedown contacts: (path)

## Review cadence

- Register review: `monthly`
- Default `review_by` horizon for a new risk: `90` days
