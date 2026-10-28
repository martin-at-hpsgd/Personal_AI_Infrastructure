# Status

A connection-status report for every configured social media platform.

## Ideal State

- Every platform in the `Broadcast.ts status` output is reported with its state: ✅ connected and verified, ❌ not configured, or ⚠️ configured but verification failed.
- The report provides both the raw command output (for debugging) and a human-readable summary (for quick understanding) in the 📊 Broadcast Status shape, ending with the platforms it is ready to post to.

## Anti-criteria

- A platform is never reported as connected (✅) unless the status command verified it; a configured platform whose verification failed is reported as ⚠️.
- The human-readable summary never replaces the raw command output; the report carries both.

## Tool contract

### Live Data (pre-injected)

### Platform Status
! `bun ~/.claude/skills/Broadcast/Tools/Broadcast.ts status 2>/dev/null || echo "Error checking broadcast status"`

### Troubleshooting

### Twitter Shows ⚠️
- The X skill's OAuth2 store lost its grant: re-run `bun ~/.claude/skills/X/Tools/bookmarks.ts authorize` (Auth intent)

### LinkedIn Shows ⚠️
- Access token expired (60-day limit)
- Renew: `bun ~/.claude/skills/Broadcast/Tools/LinkedInAuth.ts renew` (Auth intent; the legacy token paste is there too)

### Bluesky Shows ⚠️
- App password may have been revoked
- Create new app password at bsky.app/settings/app-passwords
- Re-authenticate: `bun ~/.claude/skills/Broadcast/Tools/Broadcast.ts auth bluesky --identifier handle --password new-password`

### Instagram Shows ❌
- Requires the Meta app setup and `Tools/InstagramAuth.ts` token in the Auth intent
- Must use a Creator or Business account

## Output format

Summary shape, after the raw command output:

```
📊 Broadcast Status

✅ TWITTER    <x-handle>
✅ LINKEDIN   <linkedin-name>
✅ BLUESKY    <bluesky-handle>
❌ INSTAGRAM  Not configured

Ready to post to: Twitter, LinkedIn, Bluesky
```
