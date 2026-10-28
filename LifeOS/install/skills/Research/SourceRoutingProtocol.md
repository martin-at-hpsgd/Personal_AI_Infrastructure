# Source Routing Protocol

**Contents:** The Core Rule · Cascade Priority · Per-Platform Cascade · Technical Signal Detection (run at Step 0, alongside the sentiment check) · Discourse Signal Detection (run at Step 0, alongside the other two) · Sentiment Signal Detection (run at Step 0 of every intent) · Sentiment-Mode Routing — Platform Priority · Reddit — Tier 1: JSON API (default path) · Reddit — when the API refuses · YouTube · X / Twitter · TikTok · Output Format When Sentiment-Routed · Anti-Patterns (do not do these) · Quick Reference

Read this before spawning agents. The right source has the answer; the right agent only fetches it. Mismatched source-to-question is the #1 cause of research failures in this skill.

## The Core Rule

**Web search answers "what was published about X." Community APIs answer "what people said about X."** Press articles invent consensus, fabricate timestamps, and miss the loudest fan reactions. If the question is about sentiment, ratings, reactions, opinions, or what real people thought — you do not want web search alone. You want the platforms where those people actually posted, queried via the most-direct path available.

## Cascade Priority

For every platform you reach, walk the cascade in order. Move down only when the upper tier is unavailable or fails:

**Tier 1 — Official API.** Highest signal, stable schema, terms-of-service compliant, often free at research volume. Check it first.

**Tier 2 — A documented vendor data product, within the platform's terms.** Use only when the platform offers no public API for the data the question needs (TikTok), or the API does not expose that data shape (e.g., full comment threads on some platforms), and the product is licensed for it. A rate limit, a spent quota or a refused request is never a reason to switch tiers: the run stops on that platform and reports the gap.

**Tier 3 — Web search (Perplexity / Claude / Gemini).** Last resort for sentiment. Useful only to scaffold context — dates, lineup, version numbers — never to answer "what did fans think." Web search reads press coverage; press coverage is not the community.

## Per-Platform Cascade

| Platform | Tier 1 (API) | Tier 2 (Scraper) | Tier 3 (Web search) |
|----------|--------------|------------------|---------------------|
| **Reddit** | Reddit's official API (public JSON endpoints or OAuth, with a descriptive user agent and within Reddit's rate limits) | none: report it | `site:reddit.com` via WebSearch |
| **X / Twitter** | X API v2 recent-search (via `TWITTER_API_KEY` + `X_BEARER_TOKEN` env vars; LifeOS users with a private X-wrapper skill can invoke it here) | the principal's own exported data | `site:x.com` via WebSearch |
| **YouTube** | YouTube Data API v3 (`commentThreads.list`, `search.list`) — requires `YOUTUBE_API_KEY` env var | `fabric -y URL` for transcripts; comments come only from the API, so without it: report it | `site:youtube.com` |
| **TikTok** | (no public API) | a data-product skill the install carries for TikTok, within TikTok's terms; else report it | `site:tiktok.com` |
| **Bluesky** | AT Protocol public API (`api.bsky.app/xrpc/app.bsky.feed.searchPosts`) — no auth required for reads | none needed: the public API covers reads | `site:bsky.app` |
| **Discord** | Discord API (requires bot token + server membership) | (no general scraper) | n/a |

## Technical Signal Detection (run at Step 0, alongside the sentiment check)

The question is a **technical question** if it is about code, APIs, frameworks, libraries, runtimes, protocols, tooling, versions, migration paths, or "how does <system> actually work under the hood."

If it fires → **add a `CodexResearcher` slot.** It runs OpenAI's flagship model through `codex exec` with live web search, so it is the only researcher whose findings come from outside the Anthropic distribution that the DA and ClaudeResearcher share. On technical questions that difference is the point: a wrong API contract or a hallucinated flag is exactly the failure mode two Claude-family passes agree on. When the answer depends on a language or runtime, the brief names the install stack from `<configRoot>/LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md` (`tech_stack`) rather than assuming one.

```typescript
Agent({
  subagent_type: "CodexResearcher",
  description: "[topic] technical",
  prompt: "Do ONE technical search for: [query]. Prefer primary sources — official docs, source, changelogs, RFCs. Tag each finding [HIGH]/[MED]/[LOW]. Return findings immediately."
})
```

As of 2026-09-26 it is a standing slot in Standard, Extensive and Deep (vendor diversity scales with effort; see SKILL.md). In Standard the slot is the in-session `codex exec` call in `Intents/StandardResearch.md`, never this agent (Router rule 28, 2026-10-24); the Agent form above is for the parallel legs of Extensive and Deep. The technical signal only changes its brief toward docs, source and changelogs. Quick mode does not run it.

## Discourse Signal Detection (run at Step 0, alongside the other two)

The question has a **discourse signal** if it turns on what is being said right now, especially on X: breaking news, a live controversy, AI-industry chatter, what a public figure or company just posted, how a launch is landing, or internet and X culture.

If it fires → **add a `Grok` slot.** It runs xAI's latest Grok model, trained heavily on X, so its read on current discourse comes from a distribution none of the other researchers share. The brief must be public material only: never put personal, customer, financial, or private-file content in it. Secret values stay out of reach through the `.env` read rules (EgressClassGuard retired 2026-10-24); the rest is the caller's job. His findings are `[LOW]` until a second source confirms them, because his path has no grounding citations.

```typescript
Agent({
  subagent_type: "Grok",
  description: "[topic] discourse",
  prompt: "Research this question: [query]. Focus on current discourse and what is being said on X. Cross-check claims with WebSearch/WebFetch, verify every URL, tag each finding [HIGH]/[MED]/[LOW]. Return findings immediately."
})
```

Wired 2026-09-23. As of 2026-09-26 it is a standing explorer slot in Extensive and Deep, and joins Standard when this signal fires or X is otherwise a plausible source; in Standard it runs as the in-session `GrokQuery.ts` call, never this agent (Router rule 28). It never fills a verifier slot. Since 2026-10-16 any data class may go to it; only secret values stay out.

## Sentiment Signal Detection (run at Step 0 of every intent)

The question is a **community-sentiment question** if it contains any of:

- "what did fans / people / the community / users / viewers / listeners / players / attendees think (of|about)"
- "ratings of" / "rated" / "fan ratings" / "user ratings"
- "best / worst / favorite / most disappointing / standout (sets|episodes|moments|games|features|takes)"
- "reactions to" / "reaction to" / "reaction videos"
- "what people are saying about"
- "is X any good" / "is X worth it" — purchase / consumption decision driven by social proof
- "consensus on" / "popular opinion of"
- Event name + ("last night" | "last weekend" | "yesterday" | recent date) — recent-event recap with implied "how was it"
- Lived experience or outcomes — the answer depends on what people who went through it report: patient or user experiences, recovery, results, regret, choosing between providers, clinics, surgeons or products. Published studies answer "what happens on average"; community reports answer "what it was like and who to avoid." Add the community slot alongside the web researchers, never instead of them.

If any signal fires, use sentiment-mode routing; otherwise, standard routing.

## Sentiment-Mode Routing — Platform Priority

Spend community calls (tool calls in Quick and Standard, agent slots in Extensive and Deep) across platforms in this order, walking the Tier-1 → Tier-3 cascade *inside each platform*:

1. **Reddit (always first).** Where most English-language fandoms post raw reactions. Tier-1 path is the free JSON API.
2. **X / Twitter.** Fastest reaction window (first 6 hours post-event). Tier-1 path is an installed X reader/search skill if one exists (check local skills first); otherwise X API v2 recent-search via `curl` against `https://api.twitter.com/2/tweets/search/recent` with `Authorization: Bearer $X_BEARER_TOKEN`.
3. **YouTube** — reactor channels and comment sections, especially for events / launches. Tier-1 path is YouTube Data API v3 *if `YOUTUBE_API_KEY` is set*; otherwise `fabric -y` for transcripts, and the missing comments are reported as a gap.
4. **TikTok** — viral-moment signal (which clips got reshared most). No public API → a data-product skill the install carries for TikTok, within TikTok's terms; without one, web search for discovery and the gap is reported.
5. **Platform-native communities** — Discord, Steam reviews, subject-specific forums. Hit when relevant.
6. **Web search (last, context only)** — dates, lineup, version numbers. Never for sentiment.

The order is hierarchy *and* fallback. Inside each platform, walk Tier 1 → 2 → 3 before moving to the next platform.

## Reddit — Tier 1: JSON API (default path)

Reddit's public JSON endpoints (the `.json` suffix) are the Tier-1 path for light reads, used within Reddit's published rate limits and Data API terms. Anything beyond light reads uses OAuth credentials; when the run has none, report the gap.

**Endpoints:**
- Subreddit Top this week: `https://www.reddit.com/r/{sub}/top.json?t=week&limit=50`
- Subreddit Top this month: `https://www.reddit.com/r/{sub}/top.json?t=month&limit=50`
- Subreddit search: `https://www.reddit.com/r/{sub}/search.json?q={query}&restrict_sr=1&sort=top&t=month`
- Site-wide search: `https://www.reddit.com/search.json?q={query}&sort=top&t=month`
- Thread + comments: `https://www.reddit.com/r/{sub}/comments/{id}.json`

**Headers:** Reddit asks clients to send a descriptive User-Agent, so send `User-Agent: LifeOS-Research/1.0` (`curl -A "LifeOS-Research/1.0" -s`, or pass it via WebFetch / Bash subagent).

**Subreddit discovery:** if you don't know which sub has the conversation, run a site-wide search first and read the `subreddit` field on returned posts. Common subs cluster by domain — `r/{topic}`, `r/{topic}news`, `r/{topic}circlejerk` for contrarian signal.

**What to pull:**
- Megathreads first (high comment count, broad sample).
- Top posts by upvote count (the upvote is the rating).
- Top comments in each thread (sort by score, not chronological).
- Look for dedicated single-subject threads ("ARTIST_NAME was incredible" → 21 score is a meaningful signal).

**Quoting rule:** Quote verbatim from comments with attribution to the thread URL. Fan quotes are the evidence; paraphrasing them launders the signal.

## Reddit — when the API refuses

When the API rate-limits, returns 403, or the content needs an authenticated read the run does not have, stop and report it. Back off and retry later, use `site:reddit.com` web search for discovery, or ask the principal for OAuth credentials. Do not switch to a scraper.

## YouTube

**Tier 1 — Data API v3 (if `YOUTUBE_API_KEY` set).** Use `commentThreads.list` for comment extraction at scale, `search.list` to find reactor videos. Highest signal, structured, free up to quota.

```bash
# Check key
test -n "$YOUTUBE_API_KEY" && echo "Tier 1 available" || echo "Skip to Tier 2"
# Search for reactor videos
curl -s "https://www.googleapis.com/youtube/v3/search?part=snippet&q={event}+reaction&maxResults=10&type=video&order=viewCount&key=$YOUTUBE_API_KEY"
# Pull comments
curl -s "https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId={id}&maxResults=100&order=relevance&key=$YOUTUBE_API_KEY"
```

**Tier 2 — Transcripts, and the comment gap.**
- **Transcripts:** `fabric -y https://www.youtube.com/watch?v={id}` pulls captions to stdin. Use this even when YOUTUBE_API_KEY is set — the Data API doesn't expose transcripts.
- **Comments:** the Data API only. Without the key, or once its daily quota is spent, report the gap; never switch to a scraper.

**Tier 3 — Web search.** `site:youtube.com {event} reaction` via WebSearch for discovery only.

## X / Twitter

**Tier 1 — X API v2 recent-search (default path).** Credentials live in env: `TWITTER_API_KEY`, `X_BEARER_TOKEN`, `TWITTER_CLIENT_ID/SECRET`. Call the recent-search endpoint directly via `curl` (or wrap it in a private skill — many LifeOS users keep a private social-platform skill that wraps this call; check your local skills before reinventing).

```bash
curl -s -H "Authorization: Bearer $X_BEARER_TOKEN" \
  "https://api.twitter.com/2/tweets/search/recent?query=$(echo {event} | jq -sRr @uri)&max_results=50&tweet.fields=public_metrics,created_at"
```

Reactions in the first 6 hours after an event are the highest-signal cluster.

**Tier 2 — the principal's own exported X data,** for a historical sweep the recent-search endpoint cannot reach. It is the principal's own archive, read locally. When the API's read allowance is spent, report the limit.

**Tier 3 — `site:x.com` web search.** Discovery-only fallback.

## TikTok

A data-product skill the install carries for TikTok, used within TikTok's terms, for hashtag pulls; without one, web search for discovery and report the gap. Useful when the event spawned a viral clip moment that didn't trend on Reddit.

## Output Format When Sentiment-Routed

When the workflow returns, organize fan signal by **tier of agreement**, not by source:

```markdown
## Tier S — Multiple fans called this their #1
| # | Subject | Evidence |
|---|---------|----------|
| 1 | [name] | [verbatim quote] — [thread URL, score] / [verbatim quote] — [thread URL, score] |

## Tier A — Repeated standouts
...

## Tier C — Disappointments (the inverse signal — equally valuable)
...

## Sources
- Reddit threads pulled (count) — list URLs + scores
- YouTube videos transcribed (count)
- X posts referenced (count)
```

Include the inverse signal: what fans hated is as informative as what they loved, sometimes more.

## Anti-Patterns (do not do these)

- **Cascade inversion.** Reaching for a vendor data product before checking the official API path (X API v2 via `X_BEARER_TOKEN`, YouTube `commentThreads.list` via `YOUTUBE_API_KEY`), or reaching for Perplexity before either, wastes budget and degrades signal. Always official API → licensed vendor data product (only for a platform with no API, within its terms) → web search; for Reddit and X, a failed API path is reported, never routed around. A documented failure of this skill (a festival-sentiment question, 2026-05) was exactly the inverted cascade — Perplexity ran first and Reddit JSON was never called. The corrected second pass pulled Reddit JSON directly; that should have been the first call.
- **Recap-journalism-only on a sentiment question.** Press articles invent timestamps ("<headliner> closed at 04:14"), fabricate surprise guests ("<artist A> × <artist B> B2B"), and parrot promoter copy. They are wrong about consensus. If a recap-article claim has zero corroboration in the community corpus, drop it.
- **Pulling only one sub** when the event has a community footprint across several. A festival has its own sub plus the genre and scene subs. Game launches have r/{game}, r/games, r/patientgamers. Always check 2-3 subs.
- **Reporting upvote counts without quoting the comments.** The number means nothing without the text it endorses.
- **Filtering out negative reactions to "balance the review."** Report the actual signal. Tier C exists precisely because it's the truest part.

## Quick Reference

| Question shape | First call (always Tier 1) |
|----------------|-----------------------------|
| "what did fans think of X" | Reddit JSON: `r/{topic}/top.json?t=week` |
| "best sets at {festival}" | Reddit JSON site-wide search: `q={festival}&sort=top` |
| "is {product} any good" | Reddit JSON: `r/{product}/top.json?t=month` |
| "reactions to {event}" | YouTube Data API v3 search.list (if key) OR `fabric -y` on top reactor videos, plus Reddit JSON |
| "what's the consensus on X" | Reddit JSON + X API v2 recent-search (`curl` against `api.twitter.com/2/tweets/search/recent` with `X_BEARER_TOKEN`) |
| "what are people saying right now" | X API v2 recent-search (real-time signal) + Reddit JSON |
