---
name: Pareto
metadata:
  short-description: "Sweeps YouTube, GitHub and the web on a topic, ranks it down to the vital few, and reports the past meta, current meta, and frontier."
version: 1.0.4
description: Maps any topic's zeitgeist and frontier — sweeps YouTube, GitHub, the web and the Research skill, ranks everything down to the vital few by relevance, reach, recency and outlier-ness, then reports the past meta, the current mainstream meta, and where the forward thinkers are heading, every frontier claim linked. USE WHEN pareto, pareto this, run pareto on, zeitgeist, what's the zeitgeist on, what's the meta on, what is the current meta, where is thinking on X heading, who are the forward thinkers on, who is ahead of the curve on, what are the big thinkers saying about, top content on a topic, vital few. NOT FOR answering a specific factual question (Research), analyzing one piece of content (ExtractWisdom), or AI industry news digests (Upgrade NewsDigest; security news SecurityUpdates).
evals:
  manual:
    reason: "whether the frontier section names people genuinely ahead of the mainstream is a judgment about the topic"
    falsifier: "the principal reads a generated report and says the frontier section is just the mainstream restated or names nobody worth following"
---

# Pareto

Most of what gets said about a topic is repetition. A few people and a few pieces carry the signal, and some of them are early. Pareto sweeps wide, ranks down to that vital few, and reports how thinking has moved and where it is going next.

## Ideal State

- The principal can act on a run without redoing the search: who to follow and what to read first are named, each with a link from the collected data.
- A failed or quota-limited source narrows the sweep but never aborts the run, and the result names every source that failed.
- Ranking keeps the vital few on topic: off-topic viral items and cracked-software lure repos never reach the ranked set.
- Every era claim (past, current, frontier) carries a date taken from the source itself, never a crawl date.

## Intent Routing

| Intent | Trigger | File |
|----------|---------|------|
| **Run** | any topic: "pareto X", "what's the zeitgeist on X", "where are the forward thinkers going on X" | `Intents/Run.md` |

| File | Read when |
|------|-----------|
| `Tools/<Name>.help.md` | calling or changing Collect (the sweep), Rank (scoring to the vital few) or Check (the report gate): flags, env, output shape |
| `Setup.md` | first-time setup: the four sources, the keys and accounts each needs, and a read-only sweep to prove them |

## Data & Config

Credentials are env var names only, read from the LifeOS `.env`: `YOUTUBE_API_KEY` (YouTube Data API v3), `PERPLEXITY_API_KEY` (web search). GitHub uses the authenticated `gh` CLI.

First-time setup for these sources is in [Setup.md](Setup.md).

User customizations live at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Pareto/` (`configRoot` is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). When that directory exists, its PREFERENCES.md (for example default sources, sweep size, or sources to skip) overrides the defaults in `Intents/Run.md`; when it is absent, the defaults stand.

## Gotchas

- **YouTube search costs 100 quota units per call** out of a 10,000 daily default. One run makes four searches plus cheap stats calls, so about 25 full runs a day before quota errors; a quota error shows as a failed youtube source, never a failed run.
- **A viral hit also beats its channel baseline** (a 3M-view video on a 50k channel), so outlier alone flagged 73 of 100 items as frontier on the first real run. A frontier candidate needs both measured reach outside the top third of its source and outlier ≥ 0.6; sources with no reach signal never qualify except Research picks.
- **GitHub search for a software category returns cracked-software lure repos** ("SketchUp-Pro-Download-2026", "ZBrush-Activator"; second real run, 3D modeling, 2026-09-25). These are malware bait. Rank drops repos whose names match the lure pattern or that have under 10 stars; never link one in a report.
- **One shared word let off-topic content in**: "3D modeling software" admitted 3D-printing Shorts on "3d" alone. Items must contain 60% of the topic terms (both of two, two of three). Phrase topics as the category ("3D modeling software"), not as a judgment ("best 3D modeling system"), because "best" and "system" match everything.
- **Percentiles are computed over on-topic items only.** A viral off-topic video once took the top outlier slot from the real one in testing; the relevance floor runs before any scoring.
- **The "top-reach" line in Check is the top third of reach within a source.** A decile cut never fires on small sources.
- **Perplexity `last_updated` is the crawl date, not the publish date.** Used as a fallback it dated a 2025-09 arXiv paper to 2026-09 (first real run, 2026-09-25). The collector now leaves such items undated; date claims in the report come from the page itself.
- **YouTube transcripts come from the Gemini watch pass on the public URL, never from scraped captions.** A video the watch pass refuses is named in the report as unread; the run never retries it through another route.

## Examples

**Example 1: A topic sweep**
```
User: "Pareto agentic coding"
→ Run intent
→ ~/Downloads/pareto-agentic-coding-<date>.md: past meta, current meta, frontier, who to follow
```

**Example 2: Phrased as a question**
```
User: "Where are the big thinkers going on personal AI infrastructure?"
→ Same intent; the console summary leads with the one-sentence shift and two names
```
