---
provenance: template
version: 1.0.0
---

# WORKFLOWS/Shared — code shared across your Workers

Modules imported by more than one Worker under `../Workers/`. The one file LifeOS itself knows about:

| File | Read by | What it holds |
|---|---|---|
| `infra-inventory.ts` | `hooks/DeployRegistrationGate.hook.ts` (end-of-turn check after a custom-domain deploy), the Cloudflare skill Create/Deploy intents | the curated list of your public sites for the hourly infra-security scanner: one entry per domain with `protectedPaths` and `dataProbePaths`. The gate only requires a new domain to appear here when the file exists; an install without it skips that check. |

Fresh-install state: this README only.
