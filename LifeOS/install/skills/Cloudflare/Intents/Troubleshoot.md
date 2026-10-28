# Troubleshoot Cloudflare Deployment

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Gotchas

A failing Cloudflare deployment diagnosed from cf state and logs, fixed, redeployed and verified in a real browser.

## Ideal State

- The report names the root cause with its evidence: the cf account state or log lines it came from (deployments and versions, Workers Logs or Pages build logs, DNS records and Worker triggers), or Code Mode MCP data when that is the fallback.
- The fix built and ran locally (`bun run build`, `bun run dev` / `cf dev`) before it was redeployed through the Deploy intent.
- The fix is verified live at the deployment URL in a real browser: the Interceptor skill when it is installed, otherwise any headless browser you have (for example Playwright) or the user's own browser with its developer console open. With no browser check possible, the report says so and calls the fix "deploy accepted", not verified. The report shows the screenshot plus the console-error count and the failed-request count, both zero, or names exactly what still fails.
- An auth error (`9109` or `10000`) diagnosis shows the `CfEnv.ts auth whoami` result and the scope-matching probe's status, in that order. A 200 kept the diagnosis downstream with no rotation; a 403 or code 10000 led to checking `CLOUDFLARE_ACCOUNT_ID` and the token's scope against Config.md first; only a dead token (401, or code 9109 / invalid token) led to rotation, followed by a 200 re-probe, a re-run of `whoami`, and the new value re-threaded to every Worker secret that consumes it.
- A problem still unresolved after 5 fix-and-redeploy rounds is escalated to manual investigation with a list of what was ruled out and how.

## Anti-criteria

- Build success is never taken to mean the site works, and deployment status alone is never trusted.
- OAuth is never a fix for an auth error. Unsetting `CLOUDFLARE_API_TOKEN` to see whether cf falls back to its OAuth profile (`cf auth login`) is a diagnostic only; as a fix it hides the real fault and restarts the rotation loop. The OAuth profile is never the credential of record.
- Never use `/user/tokens/verify` to test the master token: it needs `User Details: Read`, so it returns a false-negative `code 1000` on a valid deploy token (SKILL.md § Gotchas, Wrong probe trap).
- Account state is queried with cf, never with ad-hoc manual curl to api.cloudflare.com; the scope-matching auth probe is the one documented exception.

## Inputs

- Deploying to Cloudflare and something goes wrong
- Website deployment succeeds but site doesn't work
- cf deploy errors occur
- Need to verify deployment is actually working
- Site shows errors after deployment
- Need to check logs from failed deployments

## Tool contract

Every account read below runs as `bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts <args after cf>`; `cf cli search` needs no credentials and runs as plain `cf`.

| Look at | Command |
|---------|---------|
| What is live and what was uploaded (Workers) | `workers deployments list`, `workers versions list`; `workers deployments create` rolls back to a known-good version (a write: through the Deploy intent) |
| Pages deployments | `pages projects deployments list` |
| Worker runtime errors | `observability telemetry query` (Workers Logs); cf has no live tail, and CfEnv refuses `tail` |
| Slow cold starts | `workers check` |
| Pages build logs | find the command with `cf cli search "pages deployment logs"` |
| DNS and routes | `dns records list -z <zone>`; `workers triggers` for a Worker's routes, custom domains and crons |
| The live site | a real browser at the deployment URL: the Interceptor skill if installed, else a headless browser or the user's own with its console open |

## Gotchas

### Auth errors during deploy (`code: 9109 / Invalid access token`, `code: 10000 / Authentication error`)

The order below is fixed:

1. **Confirm cf authenticates with the master token:**
   ```bash
   bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts auth whoami
   ```
   Expected on a healthy env path: `"You are logged in with an Account API Token … ℹ️ The API Token is read from the CLOUDFLARE_API_TOKEN environment variable."` If `whoami` errors instead, the env-var path itself is broken: fix the env loader (or the calling shell), and do not fall back to OAuth.

2. **If `whoami` shows the env-var path, run the scope-matching probe against the master:**
   ```bash
   bun --env-file ~/.claude/.env -e 'const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts?per_page=1`, { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } }); console.log(r.status)'
   ```
   The values load through bun's env path and are never printed; never read `.env` with `grep` or `cat` in a shell, which prints every secret in the file into the transcript. To branch on the error code, print `(await r.json()).errors` beside the status; it carries codes and messages, never the token.
   - **200** → token is fine. The failure is elsewhere (wrong binding in cloudflare.config.ts, stale Worker script name, project misconfiguration, network). Keep diagnosing downstream; do not rotate the token.
   - **403 or code 10000** → the token authenticated but this request was refused, which a wrong `CLOUDFLARE_ACCOUNT_ID` or a missing product scope also produces. Check the account ID and the token's permission set against Config.md, and prove scope per product endpoint (SKILL.md § Gotchas, Verify the token against what you deploy). Rotate only when both check out and the probe still fails.
   - **401, or code 9109 / invalid token** → the token itself is dead. Rotation is the path. After rotation, re-write `~/.claude/.env` (and re-seal it with `bun ~/.claude/LIFEOS/TOOLS/Secrets.ts seal` if your install seals the env file), re-run the probe (expect 200), re-run `CfEnv.ts auth whoami`, and re-thread the new value to any Worker secret that consumes it via `CfEnv.ts secret put CLOUDFLARE_API_TOKEN --name <worker> --from-env`.

### Resource 404s after a deploy

A page that loads with its assets 404ing usually means files that were never committed or a stale `_redirects`; on Workers with Static Assets, a long-lived tab 404s on hashed chunks because every deploy purges the old ones (References/RuntimeGotchas.md § Workers Assets).
