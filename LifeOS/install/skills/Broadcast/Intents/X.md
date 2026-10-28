# X

Content posted to X (formerly Twitter), text or media.

## Ideal State

- The posted content fits X's 280-character limit, with every URL counted as ~23 chars (t.co wrapper) and mentions in @username format.
- An attached video or image is on the live post and plays: it went up on the OAuth2 grant's `media.write` scope, and a video reached `succeeded` processing before the tweet went out.
- An attached clip is X-safe: encoded in a format X accepts (H.264 video, AAC audio, MP4) and within the account's video length limit (140 seconds on a standard account; longer on X Premium).
- A multi-tweet composition (media on tweet 1, a handoff link on tweet 2, or a video tweet quoting an existing article tweet) is live exactly as composed, each tweet in order with its media, link or quote.
- House rules are optional posting preferences, off by default. When Config.md sets `house_style = true`, several X posts are spaced hours apart rather than sent back to back, since X's ranking can down-weight a second post from the same author in a viewer's feed.
- With `house_style = true`, a single post that delivers the point is preferred to a thread; a thread is for genuinely separate observations.
- With `house_style = true`, video clips carry burned-in captions.

## Anti-criteria

- No media_id attached before video processing finished: `media.ts` polls STATUS, don't bypass it.
- With `house_style = true`, no hashtags except a sponsorship disclosure such as `#sponsored`.

## Inputs

X auth is the X skill's OAuth 2.0 token store: a local file or a Cloudflare KV namespace, chosen in
the X skill's own Config.md (`skills/X/Setup.md`). With no store configured, the OAuth 1.0a keys
(`TWITTER_API_KEY`, `TWITTER_API_KEY_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`)
post text only; media always needs the OAuth 2.0 grant.

## Tool contract

```bash
# Preview, then drop --dry-run to post
bun ~/.claude/skills/Broadcast/Tools/Broadcast.ts post \
  --content "CONTENT_HERE" \
  --platforms twitter \
  --dry-run
```

Attach a video or image by passing the file:

```bash
bun ~/.claude/skills/Broadcast/src/index.ts post \
  --content "CONTENT_HERE" --media ./clip.mp4 --platforms twitter
```

A **multi-tweet composition** goes straight through the `X` tool, which speaks the
composition contract this adapter doesn't:

```bash
echo '[{"text":"Lead-in","media":["clip.mp4"]},{"text":"Article: <url>"}]' \
  | bun ~/.claude/skills/X/Tools/post.ts --dry-run
bun ~/.claude/skills/X/Tools/post.ts "Lead-in" --media clip.mp4 --quote <tweet-id>
```

Cut and encode the clip before posting with whatever video tool you use (ffmpeg is enough: H.264,
AAC, MP4, under the account's length limit). The authoring side of that post type (lead-in copy,
quote fidelity, article handoff) belongs to your copywriting skill; Broadcast only transports.

## Gotchas

### Common Issues

| Issue | Solution |
|-------|----------|
| 401 Unauthorized | The OAuth2 grant lost `tweet.write` or was revoked — `bun ~/.claude/skills/X/Tools/bookmarks.ts authorize` |
| 403 on a media post | Grant is missing `media.write`, or only the OAuth 1.0a keys are set — same re-auth (it asks for `media.write`) |
| 403 `spend-cap-reached` | The X developer account hit its Billing Cycle Cap; raise it in the developer console |
| Video posts but doesn't play | media_id attached before processing finished — `media.ts` polls STATUS, don't bypass it |
| Duplicate content | X rejects identical tweets |
| Rate limited | 50 tweets per 24 hours |
