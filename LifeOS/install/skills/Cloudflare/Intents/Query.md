# Query Cloudflare State

Read Cloudflare account state with the cf CLI: workers, versions, KV, R2, D1, DNS, Pages, Vectorize, analytics and logs.

## Ideal State

- The answer comes from a cf command's JSON output this turn.
- It is shown as a table for lists and trimmed JSON for single objects, with counts when the list is long.
- Every account read ran through CfEnv, which passed the master token to that one cf process; discovery (`cf cli search`, `cf schema`, `--help`) ran as plain `cf`.
- Nothing was written to the account.

## Anti-criteria

- Never source `.env` into the session shell and never print the token.
- No write command (`cf kv keys put`, `cf dns records delete` and the other write commands) runs from this intent; writes go through `Intents/Deploy.md`.

## Inputs

- "List all my workers", "what version is live on X"
- "What DNS records does [domain] have?"
- "Check KV namespace contents", "show me my R2 buckets", "what's in my D1 database?"
- "Show Vectorize indexes", "view worker analytics", "what errors did X log today"
- Any read-only Cloudflare API operation

## Safety gates

Run every command below as `bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts <args after cf>`: it passes the master token to that one cf process. Discovery (`cf cli search`, `cf schema`, `--help`) needs no credentials and runs as plain `cf`. Never source `.env` into the session shell and never print the token.

## Tool contract

### Commands (verified against cf 1.0.0-beta.5, the version CfEnv pins as CF_PACKAGE)

Find anything not listed with `cf cli search "<task>"` (anonymous wording), then `<command> --help`. A plain `cf` may be newer than the pin, so when the pin moves, check a command against the pinned version with `bunx cf@<pinned version> <command> --help`.

| Question | Command |
|----------|---------|
| Workers in the account | `cf workers list` |
| One Worker's details | `cf workers get <worker-id>` |
| Version history / live deployment | `cf workers versions list`, `cf workers deployments list` |
| Routes, crons, other triggers | `cf workers triggers` |
| KV namespaces / keys / a value | `cf kv namespaces list`, `cf kv keys list`, `cf kv keys get` |
| Zones / DNS records | `cf zones list`, `cf dns records list`, `cf dns records get <dns-record-id>` |
| R2 buckets / objects | `cf r2 buckets list`, `cf r2 objects list`, `cf r2 objects get` |
| D1 databases / a query | `cf d1 list`, `cf d1 query` |
| Vectorize indexes | `cf vectorize list` |
| Pages projects / deployments | `cf pages projects list`, `cf pages projects deployments list` |
| Zone traffic | `cf analytics` |
| Zone traffic + WAF + Worker analytics + active custom rules as one JSON | `bun ~/.claude/LIFEOS/TOOLS/TrafficSnapshot.ts --zone <zone> [--script <worker>] [--json]`; plan-gated datasets degrade per block; also feeds `bunker code-sweep` when Bunker is installed |
| Worker logs and errors | `cf observability telemetry query` |
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

Add `-z <zone>` for zone-scoped commands. Pipe through `jq` to trim output.

## Gotchas

- `cf d1 query` and `cf d1 migrations apply` take the database ID, not its name or binding. Get IDs from `d1 list` or the project's `cloudflare.config.ts`.
