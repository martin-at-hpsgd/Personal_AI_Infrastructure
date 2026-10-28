# Search

Recent X tweets found through `Tools/search.ts` or the xurl recent-search endpoint.

## Ideal State

- The result set matches the query's operators, covers the last 7 days, holds the count asked for, and carries the author, timestamp and link of every tweet.
- A request scoped to a user, a reply target, a hashtag, an exact phrase, an excluded keyword, links, media, replies or a language uses the matching operator from the Search Operators list.

## Anti-criteria

- No search rate above 450 requests per 15-min window (app-only) or 300 (user context).

## Tool contract

```bash
# Basic search
bun run ~/.claude/skills/X/Tools/search.ts "AI agents"

# From specific user
bun run ~/.claude/skills/X/Tools/search.ts "from:<username>"

# With count
bun run ~/.claude/skills/X/Tools/search.ts "#cybersecurity" --count 50

# Via xurl (for advanced queries)
xurl "/2/tweets/search/recent?query=AI+agents&max_results=10&tweet.fields=created_at,public_metrics"
```

Recent search covers the last 7 days only (Basic tier).

## References

### Search Operators
- `from:username` — tweets from user
- `to:username` — replies to user
- `#hashtag` — by hashtag
- `"exact phrase"` — exact match
- `-keyword` — exclude keyword
- `has:links` — only tweets with links
- `has:media` — only tweets with media
- `is:reply` / `-is:reply` — filter replies
- `lang:en` — by language
