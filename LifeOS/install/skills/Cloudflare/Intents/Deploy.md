# Deploy

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract

Any Cloudflare deploy, write or approved teardown, live through CfEnv, proven, versioned and recorded in the Ledger.

## Ideal State

- Every account-touching write ran through `LIFEOS/TOOLS/CfEnv.ts`, which handed the master token to one cf process and nothing else.
- The change is live, proven two ways: an HTTP probe of the authoritative URL plus a real-browser check for anything user-visible (the Interceptor skill if installed, else a headless browser or the user's own browser with its console open). "Deploy accepted" is the honest word when only one of the two proofs exists.
- The report carries the version ID cf printed.
- For D1 migrations, `d1 migrations list` shows none pending and a `SELECT` confirms the schema.
- Every deploy that ran, success or failure, is recorded as one estate event in the Ledger (`LIFEOS/DOCUMENTATION/Ledger/LedgerSystem.md`). CfEnv records it through `LedgerDeployEvent.ts` on every real deploy; a project whose own gated deploy command bypasses CfEnv records it there, and a CfEnv warning that the record failed means recording it by hand with the command it prints.
- A converted Wrangler project has no Wrangler anywhere: cf bundles through `@cloudflare/vite-plugin`, every field of the old Wrangler file is accounted for in `cloudflare.config.ts`, and the dry run ends "Dry run complete" after logging "Delegating to bunx vite build", never "Delegating to Wrangler".
- When the deploy introduced a new zone to the account (a brand-new apex domain), the account's security baseline is on that zone, applied through Config.md's `new_zone_sweep:` command when one is configured, or the report names the zone as bare.
- A finished teardown report lists what the target owned (worker references, custom domains, secrets, bound KV/D1/R2) before and after, shows each removed resource absent, and shows the hostname's DNS re-read from a cold resolver minutes after the deletion, so an asynchronous record loss (§ Safety gates, Teardown) is caught rather than missed by a warm-cache probe.

## Anti-criteria

- Never call `cf` or `wrangler` raw from Bash for a write, never source `.env` into the shell, and never fall back to an OAuth login.
- A deploy the review blocks for a real defect is never overridden.
- Never a bare `cf deploy` in a converted project's package scripts: it bypasses CfEnv, so it skips the code review and runs on whatever token the calling shell happens to export.
- Anything cf cannot express from the old Wrangler file is never silently dropped; it is a blocker to report.
- Never claim "deployed" without a version ID and a probe.

## Inputs

Any request to deploy, push, ship, release, redeploy, or roll out a Cloudflare Worker / Pages / Site / D1 schema / KV namespace / R2 bucket, set a Worker secret, tear down an approved Worker and what it owns, or convert a project from Wrangler to cf.

## Safety gates

**Never call `cf` or `wrangler` raw from Bash for a write.** A shell whose profile exports `~/.claude/.env` hands a raw call that copy of the token, outside CfEnv's probes and review; the other fixes people reach for (sourcing `.env` into the shell, an OAuth login) either leak every secret into every child process or coast on a stale credential. Read-only lookups go through `Intents/Query.md`. If your install runs a tool-call guard that denies raw `cf`/`wrangler` writes (LifeOS's PreToolGuard has one, ProviderDeployGuard), it covers what it lists and nothing more; a guard of that kind typically denies deploy, publish, rollback, upload, `workers versions\|deployments create`, secret writes, resource deletes and `cf dns` writes, while data operations (`d1 execute`, `d1 migrations apply`, `kv key put\|delete`, `r2 object put\|delete`) and queue writes stay prose-only. Without such a guard, this whole rule is yours to follow. Reads and `--help` pass either way.

CfEnv's verb allowlist exists because a generic credential wrapper would give prompt injection a one-call path to the whole Cloudflare API; a new verb means updating this intent and the allowlist together. Two verbs run a LifeOS tool instead of cf: `observability-default` (Observability.ts) and `workers-crashes` (WorkerCrashes.ts, hourly crash counts for every Worker from one fixed read-only analytics query; Bunker's monitor reads it each sweep).

CfEnv runs the independent code review (`LIFEOS/TOOLS/Review.ts`) before every non-dry-run deploy; exit 1 stops the deploy. Development Build and Modify already ran the review at the end of their run, so the deploy reviews only spans nobody reviewed. A deploy the review blocks for a real defect gets fixed, never overridden. CfEnv forwards two waivers, each with a reason the review records: `--allow-dirty "<reason>"` waives only the uncommitted-files block, and `--waive-blockers "<reason>"` waives only model blockers or a reviewer outage. A waived span never counts as reviewed. The old single override flag is retired. One finding is a common false positive: a converted project's deploy script calling `$HOME/.claude/LIFEOS/TOOLS/CfEnv.ts` ("requires a script outside the repository") or the removal of the Wrangler config. When that is the only blocker, show it to the user and ask for the reason to record, then redeploy with `--waive-blockers "<their reason>"`. When PREFERENCES.md gives a standing reason for exactly this blocker, use that reason without asking. The review's requirements (a reachable reviewer from the other vendor, a git repository with commits) and its failure messages are in `Setup.md` § Deploy review. CfEnv also waits out Cloudflare account throttling (API 971 / HTTP 429) and retries up to five times, so a throttled deploy is never a manual rerun. `--message "<why>"` and `--tag <tag>` label the Worker version.

**New apex domain (safety gate).** Zone settings and transform rules are per-zone: a new subdomain, route or worker on an existing zone inherits the settings already in place, but a brand-new zone starts with none of them. Whatever zone-level baseline your account keeps (commonly HTTPS redirects, HSTS and response security headers) is absent until something applies it. If this deploy introduced a new zone to the account, apply your baseline right away: when Config.md names a `new_zone_sweep:` command, run it now; when it names none, apply the baseline by hand or report the new zone as bare. The Create intent deploys through this intent, so this is the one place the gate lives. `DeployRegistrationGate` probes the live edge (HSTS, CSP, SPF) at the end of each turn where cf printed a `(custom domain)` deploy and blocks that turn once while any is missing, then checks again every later turn until it comes back clean. It sees only deploys whose session output prints cf's `Deployed … triggers` line with a `(custom domain)` host.

**Teardown.** A teardown needs the user's explicit approval for each resource. If your settings deny deletes to the assistant, the user runs `workers delete` (with `--force` when not interactive) themselves; otherwise the assistant runs it through CfEnv after that approval. The listing before and after, and the cold-resolver DNS re-read, follow the two gotchas below.

- **`workers delete` needs `--force` when not run interactively.** Without it cf prints the confirmation prompt and aborts. Whoever runs it, list what the Worker owns (`workers get <name>` references, domains, secrets) before and after.
- **Deleting a worker (or its custom domain) can take hostname DNS with it, asynchronously.** Detaching a custom domain and deleting its worker can pass every immediate HTTP probe (warm DNS) and then lose the apex record minutes later, leaving the domain dead until someone notices. A `100::`-style proxied record listed in dns_records may be the custom domain's own surfaced record, not an independent anchor. Deletion protocol: (1) re-read `dns_records` a few minutes after the deletion, (2) re-probe from a cold resolver (`dig @1.1.1.1` + `curl --resolve`), never same-cache instant probes, (3) prefer migrating the hostname to the surviving worker as a custom domain first (the deploy then owns the record) before deleting the old worker.

## Tool contract

### Deploy

From the directory holding `cloudflare.config.ts`:

```bash
bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts deploy                 # Worker or static site
bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts deploy --dry-run       # build + checks, no upload
bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts pages deploy <dir> --project-name <name>   # Pages, only when asked for
```

If the project's `package.json` has a `deploy` script (a site build chained before `cf deploy`), run the build first, then CfEnv `deploy`, so the token still flows only through CfEnv. A project with its own documented, gated deploy command uses that command.

A repo that still has `wrangler.toml|json|jsonc` is unconverted. Convert it first (below).

### Writes other than a deploy

```bash
# D1 migrations (wire-compatible with the old Wrangler migrations table; needs the database ID)
bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts d1 migrations apply <database-id> --dir migrations

# Worker secret from ~/.claude/.env (value read by CfEnv, sent to cf on stdin, never printed).
# Add a source key when the names differ.
bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts secret put SECRET_NAME --name <worker> --from-env
bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts secret put API_KEY --name <worker> --from-env SOURCE_ENV_KEY

# Worker secret whose value you hold (piped; never as an argument)
printf '%s' "$SECRET_VALUE" | bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts secret put SECRET_NAME --name <worker>

# Rollback: find the good version, then deploy it
bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts workers versions list --worker-id <worker>
bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts workers deployments create --help   # then create with that version

# Queue
bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts queues create --help

# Cloudflare Access (sign-in gates). CfEnv admits zero-trust ONLY as `access …` and
# `organizations list` / `identity-providers list`; gateway, tunnels and devices stay out.
bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts zero-trust organizations list
bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts zero-trust access applications create --help
```

Check exact flags with `--help` on the command; cf is beta and flags move. Destructive commands (`… delete`) take `--dry-run` first.

### Converting a Wrangler project

The result has no Wrangler anywhere: cf bundles through `@cloudflare/vite-plugin`.

```bash
# package.json must exist and carry "type": "module"
bun add -d cf@latest @cloudflare/vite-plugin@beta vite@latest
bun remove wrangler                                   # if present
./node_modules/.bin/cf migrate --bundler vite --force --no-install
```

Then:

- Write `vite.config.ts` with `plugins: [cloudflare()]` and `publicDir` set to the old `assets.directory`.
- In `cloudflare.config.ts`, resolve every TODO `cf migrate` wrote and delete its `throw new Error("Migration incomplete…")` line.
- Check it field by field against the old Wrangler file: name, entrypoint, compatibility date and flags, domains/routes, `workersDev`/`previewUrls` false where they were false, every binding, crons, vars, observability, placement, limits. Anything cf cannot express is a blocker to report, never a silent drop.
- `git rm` the old Wrangler file; add `node_modules/` and `.cloudflare/` to `.gitignore`; set package scripts `"dev": "cf dev"` and `"deploy": "bun \"$HOME/.claude/LIFEOS/TOOLS/CfEnv.ts\" deploy"` (chain any site build before it). Never a bare `cf deploy` (see Anti-criteria).
- `./node_modules/.bin/cf deploy --dry-run` must end "Dry run complete" and log "Delegating to bunx vite build", never "Delegating to Wrangler".
- Update wherever the project documents its deploy command if it named Wrangler.
- **`cf migrate` without `--bundler vite` keeps Wrangler.** It picks the Wrangler bundler for any project not already on `@cloudflare/vite-plugin`, prints "Delegating to Wrangler", and needs Wrangler installed. Always pass `--bundler vite`, then resolve the assets TODO it writes with `publicDir` in `vite.config.ts` and delete the `throw` line it inserts.
- **A routed Worker defaults to no workers.dev.** When a config has routes or custom domains and omits `workersDev`, Wrangler left workers.dev off; set `workersDev: false` and `previewUrls: false` explicitly when converting so the deploy does not add a second public origin.

### Tools that deploy generated Workers

A tool that generates and deploys its own Workers (a build step writing into a git-ignored output directory) should call CfEnv from that directory; CfEnv then reviews the whole repository (SKILL.md § Gotchas). Use such a tool's own deploy entry point rather than reinventing it.

### Verify

The version ID comes from cf's deploy output; the probe is `curl -sI <authoritative URL>` plus a real-browser check when the change is user-visible (the Interceptor skill if installed). D1 pending check: `CfEnv.ts d1 migrations list <database-id> --dir migrations`.

### Ledger event

CfEnv runs `bun ~/.claude/LIFEOS/TOOLS/LedgerDeployEvent.ts record --project <repo name> --target worker:<name>|pages:<project> --repo <repo root> --ok|--fail` after every real deploy, appending to `MEMORY/SYSTEMUPDATES/deploys.jsonl` without blocking the deploy. A deploy that does not run through CfEnv (a project's own gated command) records its own event with the same flags plus `--domain <authoritative-domain-if-any>`; other targets such as `workflows:<worker>` are allowed. Version is resolved best-effort (repo `VERSION` file, then `package.json`); a missing version records `null` with the git SHA, so a project with no VERSION still records its event.
