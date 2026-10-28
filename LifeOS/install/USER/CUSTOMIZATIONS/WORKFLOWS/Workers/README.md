---
provenance: template
version: 1.0.0
---

# WORKFLOWS/Workers — your deployed Cloudflare Workers

One subdirectory per Worker you deploy through the Workflows cloud-execution layer (`LIFEOS/DOCUMENTATION/Workflows/WorkflowsSystem.md`). Each holds that Worker's source, its `cloudflare.config.ts` (a legacy `wrangler.jsonc` is still read), and a `deploy.sh` or equivalent.

What reads this directory:

| Reader | What it looks for |
|---|---|
| `LIFEOS/PULSE/modules/scheduled.ts` | every `<worker>/cloudflare.config.ts` (or legacy `wrangler.jsonc` / `.json`) with a scheduled trigger, listed as scheduled jobs on the Pulse Scheduled page; the directory being absent means no Workflows jobs |
| the incident-response skill key-rotation runbooks | each Worker directory, to enumerate and re-thread secrets with `cf secret put` (through the Cloudflare skill's credential-scoped runner) |
| the brand skill UpdateIdeasPage | an optional amber-ledger Worker CLI (`_A_AMBER_LEDGER/cli/amber.ts`) as one idea source; skipped when it does not exist |

Fresh-install state: this README only. Nothing here ships in a release.
