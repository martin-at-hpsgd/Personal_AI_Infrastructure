# cf CLI Reference

Detail on Cloudflare's `cf` CLI behind the SKILL.md How It Works summary: the command map, discovery, output, auth order, local mode, extra capabilities, and the Code Mode MCP fallback. Every account-touching command here runs as `bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts <cf args>`.

## Decision rule (when to use which)

| Intent | Use |
|--------|-----|
| Deploy a Worker, static site or Pages project | `deploy` (Pages: `pages deploy`) via `Intents/Deploy.md` |
| Local dev server | `bun run dev` / `cf dev` in the project (no credentials needed) |
| Worker logs and errors | `observability telemetry query` (Workers Logs); there is no live tail |
| Set a Worker secret | `secret put NAME --name <worker> [--from-env KEY]` |
| Version history and roll back | `workers versions list`, then `workers deployments create` |
| Find the command for any Cloudflare task | `cf cli search "<task>"` (no credentials needed) |
| Exact request/response shape for a command | `cf schema <command>` |
| Workers: list, get, triggers, startup profile | `workers list`, `workers get`, `workers triggers`, `workers check` |
| KV / R2 / D1 / Queues | `kv …`, `r2 …`, `d1 query|export|migrations apply`, `queues …` |
| DNS, zones, cache purge, analytics | `dns …`, `zones …`, `cache …`, `analytics …` |
| Reach an Access-protected app from the shell | `cf access curl <url>` / `cf access token <url>` |

## cf CLI

Cloudflare's agent-first CLI, built by the Wrangler team. It covers the whole Cloudflare API (3,000+ operations) as JSON-by-default commands, plus `cf deploy`, `cf dev`, `cf build`, `cf cli search` and `cf schema`.

- **Discovery.** `cf cli search "<describe the task>"` returns five JSON matches; pick one and read its `--help`. `cf schema <command>` shows the API request behind it.
- **Output.** Pretty JSON on stdout for structured results, raw bytes for binary ones. Filter with `jq`. `CF_QUIET=1` or `-q` removes progress output.
- **Auth.** cf reads `CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID`) from its environment first, then an OAuth profile (`cf auth login`). The master token is the credential of record and CfEnv is how it reaches cf; an OAuth profile is a fallback only.
- **Local mode.** `--local` points a command at local resource simulations (state in `~/.config/cloudflare/state`), for testing D1/KV/R2 scripts without touching production.

## Capabilities beyond the decision table

- `d1 migrations apply|list|create` is wire-compatible with the old Wrangler migrations table, so existing migration history carries over. `d1 export` and `d1 time-travel restore` cover backups and point-in-time recovery.
- `observability queries` manages saved Workers Logs queries.
- `cf access curl|token|login` reaches apps behind Cloudflare Access.
- `cf previews deploy` publishes a Worker Preview. It conflicts with the Dev-URLs-off doctrine, so use it only on a Worker whose workers.dev URL is already its authoritative URL.
- `cf secrets-store`, `cf email-sending`, `cf ai-gateway`, `cf security-center` cover products that otherwise need raw API calls.

## Code Mode MCP fallback

**Code Mode MCP** is a fallback for API reads only when it is connected and CfEnv is unavailable. The server (`https://mcp.cloudflare.com/mcp`) exposes the entire Cloudflare API through two tools: `search("<keywords>")` finds endpoints, and `execute("<METHOD> <path>")` calls one. It authenticates with its own OAuth on first use.
