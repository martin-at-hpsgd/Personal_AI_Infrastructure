---
provenance: template
version: 1.0.0
---

# Harvest — Config

harvest_api_base: https://harvest.example.com

Read by `Tools/harvest.ts` (`resolveHarvestApiBase()`). The tool takes the **first** line in this file where the key name is followed by a colon, so the value line above stays first and the key is not written in that form anywhere else in this file. The `HARVEST_API_BASE` environment variable, when set, overrides this file entirely.

## Keys

| Key | Meaning | Example | Where to get it |
|-----|---------|---------|-----------------|
| harvest api base (the line at the top) | Base URL of your deployed harvest classifier Worker (the service `skills/Harvest/Setup.md` § 3. Build the service describes). `harvest.ts` POSTs to `<base>/ingest-and-classify` and `LIFEOS/TOOLS/HarvestExecutor.ts` polls `<base>/items`. No trailing slash needed; one is stripped. | `https://harvest.example.com` | Cloudflare dashboard → Workers & Pages → your harvest worker → its custom domain or `workers.dev` URL. Build and deploy it per `skills/Harvest/Setup.md` first. |

## Optional environment variables (values live in `~/.claude/.env`, never here)

| Env var | Meaning | Default |
|---------|---------|---------|
| `HARVEST_API_BASE` | Overrides the file value above. | unset |
| `HARVEST_WHISPER_MODEL` | Whisper model used to transcribe audio captures. | `small` |
