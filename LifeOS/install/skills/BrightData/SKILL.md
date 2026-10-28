---
name: BrightData
evals:
  manual:
    reason: "Live escalation through curl, Interceptor and the Bright Data proxy needs observation of the retrieved content; the pre-check and the tier label are covered by MarkdownPreCheck's synthesized fixture tests, which run in the maintainer tree and are not part of the public release."
    falsifier: "The delivered markdown contains a block page or omits material source sections, the reported tier differs from the tool evidence, or a paid tier is used despite a successful cheaper retrieval without an explicit override."
metadata:
  short-description: "Fetch pages as markdown or crawl sites via plain requests, a real browser and Bright Data, within site terms. Excludes platform actors and logged-in UI work."
version: 1.3.3
description: 4-tier page fetching that moves from plain curl to curl with declared headers to a real browser through Interceptor to Bright Data's managed fetch product, single URL or multi-page crawl, output as markdown, within each target site's terms. USE WHEN Bright Data, scrape URL, web scraping, crawl site, extract page content, scrape whole site, spider domain, convert URL to markdown, page needs rendering. NOT FOR simple public content (WebFetch), social data with named actors, logged-in browser sessions (Interceptor), or multi-source investigation (Research).
---

# BrightData

Fetches a single URL (FourTierScrape) or crawls a whole site (Crawl), moving through four tiers only as far as each page needs, always within the target site's terms and robots.txt. A site that refuses automated access is reported, not worked around. Output is always markdown. A Cloudflare `Accept: text/markdown` pre-check runs before Tier 1 (recipe in FourTierScrape.md).

## Ideal State

- Every page comes back as clean markdown that matches its URL, labeled with the tier that actually retrieved it.
- Cost tracks need: free tiers are tried first, and paid Bright Data calls (Tier 4, whether for one URL or for the pages of a Light Crawl that need it, and Full Crawl) happen only when cheaper ones fail or the user confirms.
- A crawl returns a site map, the page contents and its stats, with failed pages named rather than silently missing.

## Intent Routing

| Intent | Trigger | File |
|----------|---------|------|
| FourTierScrape | "scrape/fetch/pull/get/retrieve [URL]", "fetch this page as markdown", "this page needs rendering", "use Bright Data to fetch" | `Intents/FourTierScrape.md` |
| Crawl | "crawl this site", "spider this domain", "map this website", "get all pages from", "scrape the whole site", "crawl all pages under /docs" | `Intents/Crawl.md` |

### References

| File | Read when |
|------|-----------|
| `Setup.md` | first-time setup: the free tiers, the paid Bright Data pieces (MCP server, API key, crawl dataset id), and a proof |

## The four tiers (tool contract)

| Tier | Tool | Wins on | Cost / latency |
|------|------|---------|----------------|
| 1 | plain `curl -sL`, raw HTML converted to markdown locally | public content | free · ~1-3s |
| 2 | curl + declared user agent and Accept headers | servers that need content negotiation | free · ~3-7s |
| 3 | Interceptor (real Chrome) | JavaScript-rendered / SPA pages | free · ~10-20s |
| 4 | Bright Data MCP `mcp__Brightdata__scrape_as_markdown` | managed rendering, region-specific fetches | Bright Data credits · ~5-15s |

Every tier returns the page itself. WebFetch is never a tier: it hands back a small model's summary of the page, not the page.

Skip-ahead: explicit "use Bright Data" → Tier 4; "use browser" → Tier 3; a domain that already failed Tier 1 for a non-refusal reason (empty body, timeout) → start at Tier 2. A CAPTCHA, block page or login wall at any tier ends the retrieval with a report. The exact curl header block, Cloudflare pre-check, and Interceptor commands live in `Intents/FourTierScrape.md`.

## Data & Config

User customizations live at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/BrightData/` (configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there; they override default behavior. If it does not exist, proceed with skill defaults. First-time setup (accounts, keys, config, a proof it works) is in [Setup.md](Setup.md).

The paid paths need pieces this skill does not install. Tier 4 needs the Bright Data MCP server, which supplies `mcp__Brightdata__scrape_as_markdown` and `scrape_batch`. Full Crawl needs `BRIGHT_DATA_API_KEY` and `BRIGHT_DATA_CRAWL_DATASET_ID` (the Crawl API dataset id from the Bright Data dashboard) in the environment. Before the first paid call, confirm the MCP tools are present in the session and that `bun LIFEOS/TOOLS/Secrets.ts has BRIGHT_DATA_API_KEY BRIGHT_DATA_CRAWL_DATASET_ID` prints `yes` for each key the call needs. When a piece is missing, stop at the last free tier and tell the user which piece is not configured; never report a Tier 4 or Full Crawl result that did not run.

## Gotchas

- **Bright Data proxy has usage costs.** Don't use Tier 4 for sites accessible via Tier 1-3.
- **Tier 4 is slower than the free tiers.** Allow extra time for its responses.
- **Credentials belong in `~/.claude/.env`** — BRIGHT_DATA_API_KEY (the name `Intents/Crawl.md` commands read). Check as Data & Config says instead of assuming the paid tiers work.

## Examples

- "Fetch example.com/pricing as markdown" → FourTierScrape. The pre-check returns HTML, Tier 1 returns an empty body, and Tier 2's declared headers get the page, delivered as markdown labeled Tier 2. If Tier 1 had returned a block page instead, the reply would report the block and stop.
- "Crawl the docs under docs.example.com/api/" → Crawl, a Light Crawl scoped to `/api/`, depth 3, at the default limit of 20 pages, which needs no confirmation (more than 20 does). Each page climbs the tiers on its own, and any page that needed Tier 4 is named in the stats with its cost.
- "Use Bright Data to fetch this region-specific listing" → FourTierScrape, skipping to Tier 4. If the MCP server is not registered, the reply says so and offers the best free-tier result.
