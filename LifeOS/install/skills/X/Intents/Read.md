# Read

An X post, thread, long tweet or article read in full through `Tools/read.ts`.

## Ideal State

- The content of every X/Twitter post, thread or article comes from `Tools/read.ts` (bearer token, `tweet.fields=article,note_tweet`), tried before anything else.
- The output carries the full tweet text, the full article body (`article.plain_text`) when the post is or links an X article, and the full long-tweet text (`note_tweet.text`) for posts over 280 chars.
- The output also carries author username and name, timestamp, engagement metrics (likes, retweets, replies, views), expanded URLs from entities, and thread context (conversation_id if part of a thread).

## Anti-criteria

- No WebFetch, WebSearch, or Interceptor on an X URL: X blocks WebFetch (402), blocks article-id reads on the v2 API, and browser automation contexts are usually logged out of X.
- The bare tweet text (just a `t.co` link) is never presented as an X article's content.

## Tool contract

```bash
# By tweet ID
bun run ~/.claude/skills/X/Tools/read.ts 1234567890

# By URL
bun run ~/.claude/skills/X/Tools/read.ts https://x.com/user/status/1234567890

# Via xurl (more fields)
xurl "/2/tweets/1234567890?tweet.fields=created_at,author_id,text,entities,public_metrics,conversation_id&expansions=author_id&user.fields=username,name"
```

### Rate Limits
- 450 requests per 15-min window (app-only)
- 900 requests per 15-min window (user context)

## Gotchas

- An X article (`x.com/i/article/...`) is readable only through `read.ts`'s `article.plain_text`: the bare tweet text is just a `t.co` link, and the body is auth-gated to WebFetch (402) and to the v2 tweets-by-article-id endpoint (401/not-found).
