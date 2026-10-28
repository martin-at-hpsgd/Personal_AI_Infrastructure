---
provenance: template
version: 1.0.0
---

# Cloudflare — Config

Facts about your own Cloudflare account. The skill body reads this file; no code parses it. Secrets never go here: the token value lives in `~/.claude/.env`.

## Master token

- Dashboard name: `example-deployer`
- Permissions granted: Workers Scripts edit, Workers Routes edit, D1 edit, Zone DNS edit
- Last checked: probe each endpoint you use and note the date here.

## Workers that read the token at runtime

| Worker | Secret name |
|--------|-------------|
| `example-stats` | `CLOUDFLARE_API_TOKEN` |

## Optional commands

Leave a line out when you have no such tool; the skill then reports the step as not configured.

new_zone_sweep: bun ~/tools/apply-zone-baseline.ts
dev_url_check: the nightly result in ~/tools/check-dev-urls.log
scanner_registration: add the hostname to ~/tools/scan-targets.json, then run bun ~/tools/scan-targets.ts --reload
