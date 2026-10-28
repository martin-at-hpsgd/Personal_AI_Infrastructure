# Quick Research

A fast answer from one Perplexity call and one query, or verbatim fan quotes when the question is about sentiment.

## Ideal State

- A sentiment question (the signals in `../SourceRoutingProtocol.md`: "fans thought", "ratings of", "best | worst | favorite", "reactions to", "what people are saying", "consensus on", event + recent date) is answered with verbatim fan quotes, their thread URLs and scores, rather than recap journalism.
- Any other question's answer comes from exactly one well-crafted query to `PerplexitySearch.ts`, run in this session, with every finding tagged per `Verify.md` § Output format.
- A claim that a venue exists, is open, keeps certain hours or books a certain way matches the official page of the venue or its host property, and every URL delivered passed the verifier in `../UrlVerificationProtocol.md` (Verify Tier 1).
- The answer carries what Output format names, inside the 30-second timeout (target ~10-15 seconds).

## Anti-criteria

- No multi-query exploration and no agent: quick mode is 1 tool call, 1 query (Router rule 28: a tool before an agent).
- If the Reddit call fails, sentiment mode reports the failure; no scraper is used.

## Inputs

**Mode:** One Perplexity call in the session, 1 query | **Timeout:** 30 seconds

"quick research" or "minor research", and everyday look-ups that never say "research" (venue, hours, travel, best-of); see SKILL.md § Intent Routing.

## Tool contract

**READ:** `../SourceRoutingProtocol.md` if not already loaded; the sentiment check is mandatory before any lookup.

- **Signal fires → sentiment-mode.** Skip the Perplexity call below. Instead, single-call to Reddit JSON API at the most relevant subreddit + sort: `curl -A "LifeOS-Research/1.0" -s "https://www.reddit.com/r/{sub}/top.json?t=week&limit=25"` (or site-wide search if sub is unknown). Parse top 10 posts, pull comments on the highest-signal thread, return verbatim fan quotes with thread URLs and scores. If the call fails, report it.

**No signal → one Bash call to the Perplexity search tool with a single focused query:**

```bash
bun ~/.claude/LIFEOS/TOOLS/PerplexitySearch.ts "$(cat <<'QUERY'
<one focused query, pasted verbatim>
QUERY
)"
# flags go before the query: --recency day|week|month, --model perplexityReasoning, --json
```

**Quoting rule.** The query comes from outside, so it never goes inside double quotes where the shell would expand `$(…)` or backticks; the quoted heredoc delimiter passes it through literally. No line of the query may be exactly `QUERY`. Tag each finding `[HIGH]`, `[MED]` or `[LOW]` yourself from what the call returns.

**Why Perplexity:** Fastest live-web retrieval with built-in citations; best single-call default for "just tell me what's current."

## Output format

The response shape is the system output format; this intent sets only what the content carries:

- The answer first, in a sentence or two.
- Confidence tags on the findings it rests on.
- The verified source URLs, the venue's own page first for existence, hours and booking claims.
- Any conflict between sources, with both sides.
- A note that Standard research would add depth, only when the single query left a real gap.
