# Auth

**Contents:** Ideal State · Anti-criteria · Tool contract · Gotchas

Authentication configured for each social media platform Broadcast posts to.

## Ideal State

- Each platform being configured shows as configured in `bun ~/.claude/skills/Broadcast/src/index.ts status`, with its credential in the storage this intent names for that platform.
- A broken X grant is restored by re-running `bun ~/.claude/skills/X/Tools/bookmarks.ts authorize`, completing with zero clicks when the app grant is still active on the X account and otherwise with the URL surfaced to the principal.
- LinkedIn and Instagram tokens are kept alive inside their 60-day lifespans by their `ensure` commands, run daily by a scheduled workflow (worked example in `Setup.md`), unattended for both platforms.
- The stored Instagram publishing id is the professional-account `user_id` (17841…-form) resolved from `/me?fields=user_id`, not the app-scoped `id`.

## Anti-criteria

- Credentials are never committed to git.
- Scopes are never wider than the minimal required scopes.

## Tool contract

### Twitter/X

**Primary:** the X skill's OAuth 2.0 token store (`tweet.write` + `media.write` + `offline.access`). Where it lives, a local file this machine refreshes or a Cloudflare KV namespace another process refreshes, is set in the X skill's Config.md; setup is `skills/X/Setup.md`. The adapter verifies and posts through it; `x` is accepted as a platform alias for `twitter`.

**Text-only fallback:** the OAuth 1.0a env keys in `~/.claude/.env` (`TWITTER_API_KEY`, `TWITTER_API_KEY_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`), used only when no token store is configured. X can revoke these from the developer portal without notice, and they have no media path, so keep the token store as the live path.

**To verify:**
```bash
bun ~/.claude/skills/Broadcast/src/index.ts status
```

**If broken:** re-run `bun ~/.claude/skills/X/Tools/bookmarks.ts authorize` (if the app grant is still active on the X account, it completes with zero clicks; otherwise surface the URL to the principal). A 403 on media means the grant is missing `media.write`; the same re-auth fixes it.

### LinkedIn

**Storage:** `~/.broadcast/credentials.json`, which is what Broadcast reads. Every login and renewal also writes the token into the env file as `LINKEDIN_ACCESS_TOKEN`, a mirror for outside tools that read it there; nothing in this skill reads the mirror. If your install seals the env file, the sealed copy holds an old token until you re-seal (`Setup.md` § Accounts and secrets).

**Auth is automated via `Tools/LinkedInAuth.ts`**, because an unwatched 60-day token expires silently:

```bash
bun ~/.claude/skills/Broadcast/Tools/LinkedInAuth.ts status    # days left (introspection when client creds present)
bun ~/.claude/skills/Broadcast/Tools/LinkedInAuth.ts login     # one-time interactive bootstrap
bun ~/.claude/skills/Broadcast/Tools/LinkedInAuth.ts renew     # silent re-auth, zero clicks
bun ~/.claude/skills/Broadcast/Tools/LinkedInAuth.ts ensure    # cron entrypoint: renew if <14 days left
```

**Why this works:** standard apps never get refresh tokens (Marketing-partner-only), but LinkedIn officially bypasses the consent screen when the member is logged into linkedin.com AND the current token hasn't expired yet — the auth flow 302s straight back with a fresh code. `ensure` on a daily schedule renews inside that window forever. Full contract: `Tools/LinkedInAuth.help.md`.

**Requirements (one-time):** `LINKEDIN_CLIENT_ID` + `LINKEDIN_CLIENT_SECRET` in `~/.claude/.env`, and `http://localhost:8917/callback` registered as an authorized redirect URL in the app (developer portal → Auth tab).

**Legacy manual path** (fallback if the token fully lapses and the browser session is gone): Token Generator in the developer portal with `w_member_social`, then `bun ~/.claude/skills/Broadcast/Tools/Broadcast.ts auth linkedin --password ACCESS_TOKEN`.

**Token lifespan:** 60 days, hard. The automation renews it; it never extends it.

### Bluesky

**Storage:** `~/.broadcast/credentials.json`

**Command:**
```bash
bun ~/.claude/skills/Broadcast/Tools/Broadcast.ts auth bluesky \
  --identifier your.handle.bsky.social \
  --password your-app-password
```

**App password:** create one at https://bsky.app/settings/app-passwords (name it "Broadcast") and pass it as `--password`.

**Token lifespan:** Until revoked

### Instagram

**Storage:** `~/.broadcast/credentials.json`

Instagram uses an OAuth code flow (not a token paste), so it has its own helper: `Tools/InstagramAuth.ts`. Posting to your OWN professional account runs under Standard Access — **no App Review**.

**One-time Meta app setup:**
1. Convert your Instagram account to **Creator or Business** (IG app → Settings → Account type). Personal accounts can't publish via API.
2. Create a Meta app at https://developers.facebook.com/apps (type: **Business**).
3. Add the product **Instagram → "API setup with Instagram login"**.
4. Set an OAuth **redirect URI** (for a local CLI, `https://localhost/` works — you only read the `?code=` back out).
5. Copy the **Instagram app ID + app secret**.
6. Add your own IG account as an app **tester/role** and accept the invite.

**Env (in `~/.claude/.env`):**
```
INSTAGRAM_APP_ID=...
INSTAGRAM_APP_SECRET=...
INSTAGRAM_REDIRECT_URI=https://localhost/
# Media staging (Meta fetches media from a public URL — no binary upload):
BROADCAST_R2_BUCKET=...
BROADCAST_R2_PUBLIC_BASE=https://<your-public-r2-domain>
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
CLOUDFLARE_ACCOUNT_ID=...
```

**Get the token:**
```bash
bun ~/.claude/skills/Broadcast/Tools/InstagramAuth.ts url            # 1. open the printed URL, approve
bun ~/.claude/skills/Broadcast/Tools/InstagramAuth.ts exchange --code THE_CODE   # 2. exchange the ?code=
bun ~/.claude/skills/Broadcast/Tools/InstagramAuth.ts status         # confirm token + expiry
```

**Token lifespan:** 60 days. Keep it alive with `InstagramAuth.ts ensure` (refreshes only when <14 days left; token must be ≥24h old). Schedule LinkedIn and Instagram `ensure` together once a day; `Setup.md` has a worked workflow example.

### Credential Storage

**Twitter:** the X skill's OAuth 2.0 token store, or the OAuth 1.0a env keys for text only (above)

**Other platforms:** `~/.broadcast/credentials.json`
```json
{
  "linkedin": {
    "accessToken": "..."
  },
  "bluesky": {
    "identifier": "handle.bsky.social",
    "password": "app-password"
  }
}
```

## Gotchas

**Gotcha:** the Instagram code-exchange response's `user_id` can be wrong (off by one against the account's real node id, so verification 400s with "Object does not exist"). `exchange` now resolves the canonical id from `/me?fields=user_id` and stores that. The publishing id is the professional-account `user_id` (17841…-form), not the app-scoped `id`.
