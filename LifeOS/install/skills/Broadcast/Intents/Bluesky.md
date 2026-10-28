# Bluesky

Content posted to Bluesky.

## Ideal State

- The content is live on Bluesky within the 300-character limit, as plain text: links auto-linkified, mentions in @handle.bsky.social format, and no markdown markers showing.
- Text over 300 characters was cut to fit before the send (key points kept, the link moved to the end), because the tool truncates longer text with an ellipsis (`src/adapters/base.ts` `truncate()`) and has no Bluesky thread support.

## Anti-criteria

- Content over the 300-character limit is never handed to the tool as-is, where it would be cut mid-thought with "...".
- With `house_style = true` in Config.md, hashtags are not used. Bluesky does render `#tag` as a link (the adapter detects tag facets), so this is a style preference, not a platform limit; with the key absent or `false`, hashtags the author wrote stay.

## Tool contract

```bash
# Preview, then drop --dry-run to post
bun ~/.claude/skills/Broadcast/Tools/Broadcast.ts post \
  --content "CONTENT_HERE" \
  --platforms bluesky \
  --dry-run
```

The account is the handle you signed in with (`Broadcast.ts auth bluesky --identifier <handle>`); the app password setup is in the Auth intent.

## Gotchas

| Issue | Solution |
|-------|----------|
| Auth failed | Regenerate app password at bsky.app/settings/app-passwords |
| Content too long | Trim to 300 chars; the CLI has no Bluesky threads |
| Rate limited | Wait 5 minutes and retry |

## Output format

- Plain text only. Bluesky posts have no bold or italic, so strip markdown styling (`**`, `*`, `#` headers) before the send; the adapter detects only link, mention and tag facets (`src/adapters/bluesky.ts`).
