# Profile

An X user's profile looked up through `Tools/profile.ts` or xurl.

## Ideal State

- The profile shows username, display name, bio, location, website URL, follower/following/tweet counts and account creation date, as returned by `Tools/profile.ts` (or the xurl users-by-username call).
- When recent tweets are asked for (`--tweets N`), they appear with their engagement metrics.

## Anti-criteria

- No lookup rate above 300 requests per 15-min window (app-only) or 900 (user context).

## Tool contract

```bash
# Basic profile lookup
bun run ~/.claude/skills/X/Tools/profile.ts <username>

# Profile with recent tweets
bun run ~/.claude/skills/X/Tools/profile.ts <username> --tweets 10

# Via xurl
xurl "/2/users/by/username/<username>?user.fields=created_at,description,location,public_metrics,url,verified"
```
