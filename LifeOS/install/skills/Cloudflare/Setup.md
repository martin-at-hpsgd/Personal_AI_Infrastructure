# Cloudflare

**Contents:** What it does · Fill in · Accounts and secrets · Prove it works

Status: `bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts auth whoami` · optional

## What it does

Cloudflare deploys and manages Workers, Pages, KV, R2, D1, DNS and Queues with Cloudflare's `cf` CLI, and builds MCP servers as Workers. Every call that touches your account goes through `LIFEOS/TOOLS/CfEnv.ts`, which reads your API token from `~/.claude/.env`, hands it to one `cf` process, and refuses any command outside a short allowlist. Before a real deploy CfEnv runs the LifeOS code review (§ Deploy review below) and checks that no live secret would be dropped. Afterwards it checks that each declared domain draws a link card on X and LinkedIn (a public fetch, no account needed; a broken card makes CfEnv exit non-zero even though the deploy is already live) and records the deploy.

It needs a Cloudflare account, the `cf` CLI (`bun add -g cf@latest`, used for discovery and local work; CfEnv runs its own pinned cf for every account call), a project you deploy from that is a git repository with at least one commit, and a reachable reviewer model for the deploy review.

## Fill in

Both files below are optional and no code parses them: the skill reads them when a step needs them. Neither ever holds a secret value.

### `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Cloudflare/Config.md`

Notes about your own account. A complete example on made-up values:

```markdown
# Cloudflare — Config

## Master token

- Dashboard name: example-deployer
- Permissions granted: Workers Scripts edit, Workers Routes edit, D1 edit, Zone DNS edit
- Last checked: 2030-01-15, a 200 from an endpoint of each product the token covers

## Workers that read the token at runtime

| Worker | Secret name |
|--------|-------------|
| example-stats | CLOUDFLARE_API_TOKEN |

## Optional commands

new_zone_sweep: bun ~/tools/apply-zone-baseline.ts
dev_url_check: the nightly result in ~/tools/check-dev-urls.log
scanner_registration: add the hostname to ~/tools/scan-targets.json, then run bun ~/tools/scan-targets.ts --reload
```

| Entry | Meaning |
|-------|---------|
| Master token | The token's dashboard name and permission set, so a refused call can be checked against what it was granted. |
| Workers that read the token | Every Worker that holds the token as a secret; each needs the new value after a rotation. |
| `new_zone_sweep:` | A command that applies your zone baseline (for example HTTPS redirects, HSTS, response security headers) to a newly added zone. Without it, the skill reports a new zone as bare. |
| `dev_url_check:` | Where to read the latest result of a scheduled check that flags workers still answering on `*.workers.dev` after they got a custom domain. Without it, the skill does not claim the account is clean. |
| `scanner_registration:` | The step that adds a newly public app to your external scanner. Without it, the skill reports that the app has no external scan. |

Each optional command is your own tool. A minimal worked example of each, on made-up paths:

- **Zone baseline.** `~/tools/apply-zone-baseline.ts` lists your zones through `bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts zones list`, and for each one missing the baseline sets Always Use HTTPS and HSTS through the zone settings API. It is safe to run twice.
- **Dev-URL check.** A scheduled workflow runs nightly, requests `https://<worker>.<subdomain>.workers.dev/` for each worker that has a custom domain, and writes one line per worker to `~/tools/check-dev-urls.log`; anything other than 404 or 410 is a finding.
- **Scanner registration.** `~/tools/scan-targets.json` holds `[{"host": "app.example.com", "protectedPaths": ["/admin"]}]`; registering a new app appends one entry and reloads the scanner.

### `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Cloudflare/PREFERENCES.md`

Short standing preferences that override the skill's defaults, one paragraph each. Example:

```markdown
# Cloudflare — Preferences

## New sites

Prefer static Workers with assets over Pages for every new site.

## Telemetry

Keep `cf` CLI telemetry Disabled on this machine.
```

## Accounts and secrets

Open a Cloudflare account, then add two keys to `~/.claude/.env`:

| Env key | Where to get the value |
|---------|------------------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → Manage Account → Account API Tokens → Create Token. Grant only the scopes your deploys use. A Workers site with a D1 database on its own domain needs Workers Scripts edit, Workers Routes edit, D1 edit and Zone DNS edit; add KV, R2, Pages or Queues only when you deploy them. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → Account details, or any zone's Overview page. |

If your install seals the env file (`~/.claude/.env.age` exists), re-seal it after editing: `bun ~/.claude/LIFEOS/TOOLS/Secrets.ts seal`. CfEnv stops with exit 2 when `CLOUDFLARE_API_TOKEN` is missing. Never source `.env` into your shell and never rely on `cf auth login`; the token in `.env` is the credential of record.

To prove the token's scope without trusting `/user/tokens/verify` (an Account API Token usually lacks the `User Details: Read` it needs, so it fails on a valid token), use the scope-matching probe in `Intents/Troubleshoot.md` § Auth errors during deploy.

### Deploy review

Every real deploy (anything but `--dry-run`) first runs `LIFEOS/TOOLS/Review.ts`, an independent code review of the changes since the last passing review, by a model from the other vendor than the one that wrote the code. It reads the commits' `Co-Authored-By` trailers: code with no trailer, and uncommitted work, count as Claude-written, so on a fresh install the reviewer is OpenAI. Review reaches the model through `LIFEOS/TOOLS/Inference.ts`:

| Reviewer | What it needs |
|----------|---------------|
| OpenAI (reviews Claude-written code, the usual case) | The `codex` CLI on your PATH, signed in to a ChatGPT subscription with `codex login` (it writes `~/.codex/auth.json`). No OpenAI API key is used. |
| Anthropic (reviews code only OpenAI models wrote) | The `claude` CLI on your PATH, signed in. |

When commits carry both vendors' trailers, each vendor reviews, so both CLIs must be present.

It also needs the deploy directory inside a git repository with at least one commit, and every file in it committed: a deploy ships committed code only.

The review fails closed. A missing or signed-out reviewer stops the deploy before anything uploads, with lines like:

```
review: NOT RUN — reviewer unavailable (openai-codex: codex CLI not found). Deploy stopped: an unreviewed change does not ship by default.
CfEnv: deploy stopped by the code review above.
```

Uncommitted files print `review: BLOCKED — N uncommitted path(s) …`, and a directory that is not a git repository prints `CfEnv: code review did not run (exit N); deploy stopped.` Two waivers exist, each taking a reason that the review records. The reason is the deployer's own words for this deploy, never a stock string:

- `--allow-dirty "<reason>"` ships uncommitted files; the model review still runs.
- `--waive-blockers "<reason>"` ships past model blockers, a reviewer outage or a missing repository, unreviewed. The next deploy reviews the waived span again.

```bash
bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts deploy --waive-blockers "<why this ships unreviewed>"
```

## Prove it works

Needs no Cloudflare account and writes nothing:

```bash
bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts tail
```

Success is exit 2 and the line `CfEnv: verb "tail" not in allowlist.` followed by the allowed verbs. That proves the allowlist guard is in place before any credential is read.

With the token in place, these two read-only calls prove the credential path:

```bash
bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts auth whoami
bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts workers list
```

`auth whoami` prints JSON with `"authenticated": true`, `"authSource": "CLOUDFLARE_API_TOKEN environment variable"` and `"tokenValid": true`, and `workers list` returns your account's Workers (an empty list on a new account).
