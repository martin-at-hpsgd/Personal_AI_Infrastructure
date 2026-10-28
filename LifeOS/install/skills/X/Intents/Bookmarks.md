# Bookmarks

Raw X bookmark fetches and OAuth 2.0 grant (re-)authorization through `Tools/bookmarks.ts`.

## Ideal State

- The bookmarks returned are the number requested, newest first, each with its author, text and link, and with full text and fields when the caller needs more than the 80-character preview.
- A missing, revoked or under-scoped grant ends with `bookmarks.ts authorize` (the PKCE flow that opens a browser) run and its consent URL surfaced to the human, since the click cannot be automated; the new grant lands in the token store named in the skill's `Config.md`.
- A missing or broken `Config.md` is reported with its path and the pointer to `Setup.md`, never worked around.

## Anti-criteria

- No sweep state is kept here: deduplicating bookmarks across runs belongs to the sweep (`Intents/PullBookmarks.md`) or whatever workflow calls this tool, not to the fetch.
- No request for more than 100 bookmarks per API request (pagination for more), and no request rate above 180 requests per 15-min window.
- The token endpoint is never called directly with a stored refresh token; refresh goes only through `x-client.ts getValidTokens()`.

## Tool contract

### Fetch Bookmarks

```bash
# Fetch 50 bookmarks (human output truncates text to 80 chars)
bun run ~/.claude/skills/X/Tools/bookmarks.ts fetch 50

# Full JSON: id, text, author, author_name, created_at, url, urls, metrics
bun run ~/.claude/skills/X/Tools/bookmarks.ts fetch 50 --json

# Quick test (authorizes first if there is no usable grant, then fetches 5)
bun run ~/.claude/skills/X/Tools/bookmarks.ts test
```

### Authorize or re-authorize

```bash
# Opens a browser for the PKCE flow; waits up to X_AUTHORIZE_TIMEOUT_S (default 600s)
bun run ~/.claude/skills/X/Tools/bookmarks.ts authorize
```

The callback listens on `http://localhost:9876/callback`, which must be a registered callback URL on the X app. The requested scopes are `bookmark.read bookmark.write tweet.read tweet.write users.read media.write offline.access`.

## Gotchas

- A tweet's `created_at` is when it was published, not when it was bookmarked. A caller deduplicating "new" bookmarks must track seen ids, never filter by date.
