# X

**Contents:** What it does · Fill in · Accounts and secrets · Prove it works

Status: `bun ~/.claude/skills/X/Tools/bookmarks.ts status` · optional

## What it does

This skill does all X (Twitter) work through the X API v2: posting tweets, threads, media, quotes and replies, publishing long-form X Articles, searching recent posts, fetching your bookmarks, looking up profiles, and reading any post or Article by id or URL. Other skills hand it their X work so there is one place for credentials and one place for the OAuth 2.0 grant.

It needs an X developer app, so you have a client id and secret and a bearer token, and a choice of where the OAuth 2.0 user grant is stored. Most installs use `local`: the grant lives in a private file on your machine and the skill renews it itself. `cloudflare-kv` is for an install where some other always-on process, such as a scheduled Cloudflare Worker, already owns and renews the grant in a KV namespace; the skill then only reads it. X revokes a grant when two parties renew it, so pick exactly one.

Without the config file, reads still work on the bearer token and posting falls back to OAuth 1.0a text-only if you set those keys. Media, Articles, bookmarks and delete stop with an error that names this guide.

## Fill in

Create `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/X/Config.md`. The skill reads the first fenced `yaml` block in it.

Smallest working example (local store):

````markdown
# X config

```yaml
token_store: local
```
````

With the local store and an explicit token file:

````markdown
```yaml
token_store: local
token_file: ~/.local/state/my-x/grant.json
```
````

With a Cloudflare KV store that another process renews:

````markdown
```yaml
token_store: cloudflare-kv
kv_namespace: 0123456789abcdef0123456789abcdef
```
````

| Field | Required | Meaning |
|-------|----------|---------|
| `token_store` | yes | `local` (file on this machine, renewed by the skill) or `cloudflare-kv` (KV value `oauth2`, renewed by someone else) |
| `token_file` | no, `local` only | Where the grant is written, mode 0600. Default `~/.local/state/lifeos/x/oauth2-tokens.json`. Keep it outside any git repo. Relative paths resolve against `~/.claude`. |
| `kv_namespace` | one of these two, `cloudflare-kv` only | The 32-hex KV namespace id holding the grant. `X_TOKENS_KV_NAMESPACE` in `.env` overrides it. |
| `kv_discover_dir` | one of these two, `cloudflare-kv` only | A directory of Worker projects; the first `wrangler.jsonc` or `cloudflare.config.ts` one level down that binds `X_TOKENS` supplies the id. Relative paths resolve against `~/.claude`. |
| `bookmark_sweep.repo` | no, bookmark sweep only | The private GitHub repo (`owner/name`) idea-issues are filed in. Default: the `repo` in `LIFEOS/USER/WORK/work_repo.json`. |
| `bookmark_sweep.labels` | no, bookmark sweep only | List of GitHub labels every idea-issue carries, for example `["idea", "source:x-bookmark"]`. Each must already exist in the work repo, or `bookmark-issue.ts create` exits 3 naming the missing ones. Default: none. |
| `bookmark_sweep.property_label_prefix` | no, bookmark sweep only | Prefix for the optional `--property` label, for example `area:` turns `--property blog` into `area:blog`. Default: empty, so the label is the bare value. |

### Bookmark sweep (optional)

The PullBookmarks intent turns new bookmarks into idea-issues and LifeOS Upgrade analysis. Besides the two `bookmark_sweep` fields above it needs:

- A private GitHub repo for the idea-issues, set as `bookmark_sweep.repo` (`owner/name`) in `Config.md`. When that key is absent the tool reads `{"repo": "owner/name"}` from `~/.claude/LIFEOS/USER/WORK/work_repo.json` instead. It also needs `WORK.AGENT_LABEL` in `~/.claude/LIFEOS/USER/WORK/config.yaml`, which is added to every idea-issue.
- `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/X/PREFERENCES.md` with two sections: `## Relevance profile` (a HIGH / MEDIUM / LOW table of what you care about) and `## What counts as an idea` (the create-or-skip definition plus the `--property` values you use). Without it the intent falls back to the generic defaults in `Intents/PullBookmarks.md` § Inputs.

````markdown
## Relevance profile

| Category | Criteria | Action |
|----------|----------|--------|
| **HIGH** | Agents, skills, hooks, evals, MCP | Deep analysis + Upgrade extraction |
| **MEDIUM** | General AI/ML news | Brief note |
| **LOW** | Humor, entertainment, your own posts | Skip |

## What counts as an idea

Anything Alex Example could act on: a post to write, a feature for ExampleNet. `--property` values: `blog`, `product`, `internal`.
````

## Accounts and secrets

1. **X developer account and app.** Sign in at developer.x.com, create a Project and an App, and make sure the account has API access with credit or a plan that covers posting and bookmarks. In the developer console, set a Billing Cycle Cap you are comfortable with; when it is hit every endpoint returns 403 `spend-cap-reached`.
2. **User authentication settings on the app.** Turn on OAuth 2.0, choose the confidential client type ("Web App, Automated App or Bot"), set App permissions to Read and write, and add `http://localhost:9876/callback` as a callback URL. Any website URL you own is fine for the required website field.
3. **Keys and tokens page of the app.** Copy these into `~/.claude/.env`:

| Env key | Where the value comes from |
|---------|----------------------------|
| `TWITTER_CLIENT_ID` | OAuth 2.0 Client ID |
| `TWITTER_CLIENT_SECRET` | OAuth 2.0 Client Secret (shown once; regenerate if lost) |
| `X_BEARER_TOKEN` | Bearer Token (app-only reads: search, profiles, read) |
| `TWITTER_API_KEY`, `TWITTER_API_KEY_SECRET` | Optional. API Key and Secret, for the OAuth 1.0a text-only fallback |
| `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` | Optional. Access Token and Secret generated with Read and write permission |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | Only for `cloudflare-kv`: your account id and an API token with Workers KV Storage edit rights |
| `X_TOKENS_KV_NAMESPACE` | Optional, `cloudflare-kv` only: overrides `kv_namespace` |

4. **Get the OAuth 2.0 grant.** Run `bun ~/.claude/skills/X/Tools/bookmarks.ts authorize`. It opens the X consent page in your browser, waits on port 9876 (up to `X_AUTHORIZE_TIMEOUT_S`, default 600 seconds), and writes the grant to your configured store. It asks for `bookmark.read bookmark.write tweet.read tweet.write users.read media.write offline.access`. Re-run it whenever the grant is revoked or a scope is missing.

## Prove it works

```bash
bun ~/.claude/skills/X/Tools/post.ts --dry-run "Testing my X setup"
```

This needs no credentials and sends nothing. Success is `[1/1] 18/280 weighted chars:`, the text, then `Dry run — all tweets valid. No posts sent.` and exit code 0.

```bash
bun ~/.claude/skills/X/Tools/bookmarks.ts status
```

Success is a last line of `READY` and exit code 0, after the config shows `found`, the three required env keys (`TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET`, `X_BEARER_TOKEN`) show `set`, and the grant shows `present`. The four optional OAuth 1.0a keys are listed too and may show `missing` without blocking `READY`. A `MISSING` config line, a `missing` required key or a `none` grant says which step above to finish; the last line is then `NOT READY` and the exit code is 1.

### When a post is blocked

Every real post and Article publish passes LifeOS's send gate (`LIFEOS/TOOLS/lib/SendGate.ts`) first. It checks the exact text and every media file with the Assay skill's code checks, and stops the post if one finds a real secret, a private key, or your own home-directory path, or if a file could not be read. A block prints `SEND BLOCKED (x)`, the finding, a `Block <id>` line, and `Nothing was sent.`, and the command exits 1. On a standard install there is no override: the override hook the message mentions is not part of the public release, so the line saying "Only the principal can override" does not apply to you. To post, remove what the finding names from the text or media and run the same command again; the gate re-checks the new bytes. `--dry-run` checks length and format only and does not run the gate.
