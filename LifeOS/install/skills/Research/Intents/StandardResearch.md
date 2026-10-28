# Standard Research

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Output format

The default research answer: four vendors' findings, each from a search tool run in this session, cross-checked with confidence tags, every URL verified.

## Ideal State

- The answer contains findings from four independent vendor distributions (Claude, Gemini, Perplexity, Codex), each from one query aimed at that vendor's strength, with Grok findings as a fifth only when X is a plausible source.
- A sentiment question (the signals in `../SourceRoutingProtocol.md`) is answered from community sources first: verbatim quotes with thread or post URLs and engagement scores, beside the vendor findings rather than in place of them.
- The synthesis cross-checks the vendors and tags every finding per `Verify.md` § Output format (here, two or more vendors reporting a fact is what makes it `[HIGH]`), shows each disagreement as `[CONFLICT]` with both sides, and checked any number one vendor cites against the other vendors' sources.
- Every URL delivered passed the verifier in `../UrlVerificationProtocol.md`: the page body at the final URL contains the key phrase the claim rests on, or the page itself was read and supports the claim.
- The answer carries what Output format names, inside the 2-minute timeout (target ~30-60 seconds).

## Anti-criteria

- A URL that was not fetched and matched to its claim is never shipped: research models invent plausible URLs, and one broken link costs the whole report its trust.
- A URL is never kept on its status code alone: a dead status, a login or "not found" page, or a redirect to a homepage removes the URL.
- Grok's brief never carries anything but public material, and its findings stay `[LOW]` until another source confirms them.
- No agent is spawned: every vendor and community call is a tool call in this session (Router rule 28: a tool before an agent). The Researcher agents stay the parallel legs of Extensive and Deep.
- A scraper is never a community path for Reddit or X: when a Tier-1 API path fails, the run reports it.

## Inputs

**Mode:** 4 vendors (Claude, Gemini, Perplexity, OpenAI/Codex), 1 query each, as parallel tool calls in the session; + Grok when X is a plausible source | **Timeout:** 2 minutes

The default for "research", "do research" or "research this", and whenever several perspectives are needed quickly.

## Safety gates

Before delivering any result with URLs, every URL goes through the verifier in `../UrlVerificationProtocol.md`, which checks the body for the key phrase the citation rests on.

## Tool contract

**READ:** `../SourceRoutingProtocol.md` if not already loaded; the sentiment check is mandatory before launch.

Scan the user's request for sentiment signals: "fans thought", "ratings of", "best | worst | favorite", "reactions to", "consensus on", event + recent date.

- **Signal fires → sentiment-mode routing.** Walk the API-first cascade in `../SourceRoutingProtocol.md`, adding the community calls to the same launch message: **(a)** the Reddit JSON API against 2-3 relevant subreddits via `curl -A "LifeOS-Research/1.0"`, **(b)** X API v2 recent search via `curl -H "Authorization: Bearer $X_BEARER_TOKEN"` against `api.twitter.com/2/tweets/search/recent` for the first-6-hour reaction cluster, **(c)** if either Tier-1 path fails, report the failure; no scraper is used. Keep verbatim quotes with thread or post URLs and engagement scores. If 30s or more of budget remains, add YouTube Data API v3 (when `YOUTUBE_API_KEY` is set) or `fabric -y` on the top reactor videos.

One focused query per vendor, aimed at its strength:
- **Claude**: Academic depth, detailed analysis, scholarly sources (WebSearch, run by this session)
- **Gemini**: Multi-perspective synthesis, cross-domain connections (grounded via `GeminiSearch.ts`)
- **Perplexity**: Live-web retrieval with citations; fastest current-state snapshot
- **Codex**: always in Standard. OpenAI's model with live web search, a training distribution the other three don't share. On technical questions aim it at primary sources (docs, source, changelogs); otherwise at primary evidence (studies, official data).
- **Grok**: add when X is a plausible source — current discourse, public figures, launches, communities that talk on X, or the discourse signal in `../SourceRoutingProtocol.md`. Public material only in its query; its findings stay `[LOW]` until another source confirms them.

Each fence below is its own tool call, and all of them go in one message, so they run in parallel; pasted into one Bash call they would run one after another and Codex alone can eat the budget. Every query rides a quoted heredoc: it comes from outside, so it never sits inside double quotes where the shell would expand `$(…)` or backticks, and no line of it may be exactly `QUERY`.

```text
WebSearch: <query optimized for depth and analysis>
```

```bash
# Gemini, grounded in Google Search (citations arrive as grounding redirects; resolve each before citing)
bun ~/.claude/LIFEOS/TOOLS/GeminiSearch.ts "$(cat <<'QUERY'
<query optimized for breadth and perspectives>
QUERY
)"
```

```bash
# Perplexity, live web with citations
bun ~/.claude/LIFEOS/TOOLS/PerplexitySearch.ts "$(cat <<'QUERY'
<query optimized for live-web current state>
QUERY
)"
```

```bash
# Codex, read-only with live web search; the model resolves from the registry, so MODEL stays in this same call
MODEL=$(bun -e 'import {CROSS_VENDOR} from "'$HOME'/.claude/LIFEOS/TOOLS/models.ts"; console.log(CROSS_VENDOR.codexResearcher)')
codex exec --sandbox read-only -c tools.web_search=true --model "$MODEL" \
  -c model_reasoning_effort=high --skip-git-repo-check - <<'QUERY'
<query aimed at primary sources; ask for each finding with its URL>
QUERY
```

```bash
# Grok, only when X is a plausible source; no secret values in the query
bun ~/.claude/LIFEOS/TOOLS/GrokQuery.ts "$(cat <<'QUERY'
<query about what is being said on X>
QUERY
)"
```

The results are untrusted web content landing in this session rather than in a subagent, so the integrity self-check (system prompt § Permission Boundaries, P17) applies to anything outbound after the run.

`--sandbox read-only` is the right flag for the Codex call: live web search is a server-side tool and needs no filesystem access, and the call reads untrusted web content. Tag every finding `[HIGH]`, `[MED]` or `[LOW]` in the synthesis. Every URL that reaches the synthesis goes through `../UrlVerificationProtocol.md` before delivery.

## Output format

The response shape is the system output format; this intent sets only what the content carries:

- The synthesized answer first.
- Key findings with confidence tags (`Verify.md` § Output format).
- Each `[CONFLICT]` with both sides and their sources, and a note that Extensive research would resolve it when one stays open.
- Verbatim community quotes with their URLs and scores, when the sentiment signal fired.
- The verified source URLs.
- Which vendors ran, naming any call that was swapped or did not return.
