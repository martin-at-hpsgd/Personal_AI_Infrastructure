# LinkedInAuth.ts

Keeps the Broadcast LinkedIn token alive. Standard LinkedIn apps get no refresh tokens (Marketing-partner-only), so this tool uses the documented silent re-auth path: re-run the authorization flow BEFORE the 60-day expiry while a logged-in linkedin.com browser session exists — consent is bypassed, redirect is instant, no clicks.

## Commands

| Command | What it does | Exit codes |
|---------|--------------|-----------|
| `status` | Days left on the token — introspectToken when client creds present, stored metadata otherwise | 0 healthy · 1 expired/<10d/unknown |
| `login` | Full interactive flow (one-time bootstrap, or after a full lapse) | |
| `renew` | Silent re-auth now: localhost listener + background browser hit (`open -g`) | |
| `ensure [--days N]` | Renew only if fewer than N days remain (default 14); posts the outcome to Pulse when Pulse is running (optional; silently skipped otherwise) | 1 if renewal failed |

## Requirements

- `LINKEDIN_CLIENT_ID` + `LINKEDIN_CLIENT_SECRET` in `~/.claude/.env`
- `http://localhost:8917/callback` registered as an authorized redirect URL in the LinkedIn app (developer portal → Auth tab)
- For silent renew: the member logged into linkedin.com in the default browser AND the current token not yet expired

## Gotchas

- **Renew before expiry or lose the silent path.** An expired token forces the full consent screen. `ensure` on a schedule well inside 60 days is the whole point.
- **Never change the scope constant casually** — a scope change invalidates every issued token and forces full re-consent.
- **Introspection quirk:** wrong-client credentials return HTTP 200 with `active: false`, not an error.
- Token is written to BOTH `~/.broadcast/credentials.json` (what Broadcast reads) and `LINKEDIN_ACCESS_TOKEN` in the env file (`~/.claude/.env` by default; a mirror for outside tools, which this skill never reads). A sealed env file holds the old token until it is re-sealed.
