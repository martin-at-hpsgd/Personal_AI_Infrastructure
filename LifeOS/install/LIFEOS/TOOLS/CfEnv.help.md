# CfEnv — Cloudflare credential-scoped cf runner

**Single purpose.** Run one cf CLI command with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` read from `~/.claude/.env` and injected into that child process only. The parent shell is untouched. The verb allowlist is hard-coded; anything outside it exits 2 and points back to the Deploy intent.

**Not a generic wrapper.** If you want to call it from outside the Deploy, Query or Troubleshoot intents, the intent needs a new branch, not a bigger allowlist.

## Usage

```bash
bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts <cf args>        # a leading "cf" is accepted and ignored
bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts deploy [--dry-run] [--message <why>]
bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts secret put NAME --name <worker> [--from-env [ENV_KEY]]
```

## Allowed verbs

`analytics`, `auth`, `build`, `cache`, `d1`, `deploy`, `dns`, `kv`, `observability`, `observability-default`, `pages`, `queues`, `r2`, `secret`, `vectorize`, `workers`, `zero-trust` (Access and the two org/identity-provider list reads only), `zones`

## Behavior worth knowing

- `secret put` becomes `cf workers secrets update`, with the value sent in the request body on stdin (`--body @/dev/stdin`). The value is never an argument, never printed, and never returned. `--from-env` reads it from `.env`; otherwise it comes from CfEnv's stdin. `--dry-run` is refused for every `secret put`, before stdin or any credential is read, because cf's dry-run prints the body.
- A non-dry-run `deploy` or `pages deploy` first runs `LIFEOS/TOOLS/Review.ts` on the deploying directory; exit 1 stops the deploy.
- Every cf call runs the pinned `CF_PACKAGE` from its installed bin under `~/.cache/lifeos/cf` (`CfBin.ts`), never through `bunx` and never the global `cf`.
- A real deploy, success or failure, appends one line to `LIFEOS/MEMORY/STATE/deploys.jsonl` and records the Ledger estate event through `LIFEOS/TOOLS/LedgerDeployEvent.ts`; a failed Ledger record only warns.
- Exit code mirrors cf's.

## Why this shape

1. **Raw `cf` from the agent shell** runs on whatever token the shell exports (for example a shell profile that exports `.env`) or on a stale OAuth login, outside CfEnv's allowlist, code review and post-deploy probes.
2. **`source ~/.claude/.env` in the shell** leaks every secret into every later child process.
3. **A generic credential wrapper** gives prompt injection a one-call path to the whole Cloudflare API.

Discovery commands (`cf cli search`, `cf schema`, `--help`) need no credentials and run as plain `cf`.
