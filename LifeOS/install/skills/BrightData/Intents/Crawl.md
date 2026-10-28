# Crawl Intent

**Contents:** Ideal State · Anti-criteria · Safety gates · Inputs · Tool contract · Output format · Examples · References

Multiple pages of a website crawled by following links, with their content and a site map returned as structured results, through Light Crawl (each page through the four tiers, cheapest first) or Full Crawl (the Bright Data Crawl API for entire sites).

## Ideal State

- The mode fits the scale: Light Crawl for a section of a site or specific content (1-50 pages), Full Crawl for entire site maps; when the user says "crawl" without scope, they were asked how many pages or what section before a mode was chosen.
- For both modes the delivery holds a hierarchical site map of the crawl structure, each page's content in the requested format, and summary stats (pages crawled, depth, time taken, cost); a Full Crawl also reports total pages crawled, the total cost estimate ($1.50/1K pages), any errors encountered, and a site map derived from crawled URLs.
- Pages that returned empty or error content are flagged; a Light Crawl page that fails all 4 tiers is logged as failed while the crawl continues, and a Full Crawl partial failure delivers what was crawled and lists the failed URLs.
- A Light Crawl stays in scope: same-domain links only unless the user requests external ones, inside any URL path scope the user specified, deduplicated, and stopped when the queue is empty, the page limit is reached, or the depth limit is reached.
- When more than 50% of Light Crawl pages fail, the user is warned and Full Crawl is suggested; a Full Crawl timeout ends with an offer to increase wait time or try Light Crawl for smaller scope.
- A large result set comes with an offer to write it to a file.

## Anti-criteria

- No Light Crawl exceeding 20 pages and no Full Crawl (it involves Bright Data API costs) starts without the user's confirmation first.
- No Light Crawl goes past its hard cap of 50 pages (cost/time control).
- Never crawls anchors (#), mailto:, tel:, javascript:, or static assets (.css, .js, .png, .jpg, .svg, .pdf).

## Safety gates

The confirmations under Anti-criteria are the gate; quote these costs when asking. Light Crawl figures are the worst case, every page reaching Tier 4; pages retrieved on a free tier cost nothing.

### Cost Considerations

| Mode | Cost | Time |
|------|------|------|
| Light Crawl (10 pages) | ~$0.06 | 30-60 seconds |
| Light Crawl (30 pages) | ~$0.18 | 1-3 minutes |
| Light Crawl (50 pages) | ~$0.30 | 2-5 minutes |
| Full Crawl (100 pages) | ~$0.15 | 1-3 minutes |
| Full Crawl (1000 pages) | ~$1.50 | 5-15 minutes |
| Full Crawl (10K pages) | ~$15.00 | 15-60 minutes |

## Inputs

- Starting URL (required)
- Crawl scope: specific section, depth limit, or full site
- Output format preference (markdown, HTML, JSON)
- For Full Crawl: `BRIGHT_DATA_API_KEY` and `BRIGHT_DATA_CRAWL_DATASET_ID` in the environment (checked as SKILL.md § Data & Config says; when either is absent, Full Crawl stops and says which)

## Tool contract

### Mode Selection

| Mode | Pages | Method | Cost | Best For |
|------|-------|--------|------|----------|
| **Light Crawl** | 1-50 pages | FourTierScrape per page + link extraction loop; MCP `scrape_batch` only for pages that reach Tier 4 | free on Tiers 1-3, ~$0.006/page at Tier 4 | Section of a site, specific content |
| **Full Crawl** | 50-unlimited | Bright Data Crawl API (HTTP POST) | $1.50/1K pages | Entire site maps, comprehensive extraction |

### Light Crawl (Agent-Driven)

Every page goes through the FourTierScrape intent (robots.txt check first, then cheapest tier first), with iterative link discovery. Pages that fail Tiers 1-3 are held and fetched together through MCP `scrape_batch` (up to 10 URLs per call), so the paid tier runs only for the pages that need it.

### Light Crawl: seed page

Fetch the starting URL with the FourTierScrape intent and extract its internal `<a href="...">` links.

Deduplicate URLs by normalizing trailing slashes and query params.

### Light Crawl: batch loop

Fetch queued pages through Tiers 1-3, then send the pages still failing to `mcp__Brightdata__scrape_as_markdown` or `scrape_batch` in batches of up to 10, adding each fetched page's new internal links to the queue. Without the MCP server, those pages are logged as failed and the crawl continues.

**Limits:** the starting URL is depth 0 and each link hop adds one; default max depth 3 (override with user preference). Default page limit 20, the most a Light Crawl may reach without confirmation; the user can ask for more ("crawl up to 40 pages"), which needs their confirmation under Anti-criteria and stops at the 50-page cap.

If rate limited, add a 2-second delay between batches.

### Full Crawl (Bright Data Crawl API)

For large-scale site crawling. Uses Bright Data's dedicated Crawl API via HTTP POST. Before the trigger, run `MarkdownPreCheck.ts robots "[start URL]"`; exit 3 ends the crawl with the refusal reported. The trigger below sends no robots option, so the Crawl API does not check robots.txt for the pages it discovers: read the site's `/robots.txt` and write `url_filter` so it excludes every path disallowed for `LifeOS-BrightData` (its own group, else `*`). A site whose disallow rules cannot be expressed in one filter is crawled with Light Crawl instead, which checks robots.txt for every URL.

### Full Crawl: trigger

```bash
curl -X POST "https://api.brightdata.com/datasets/v3/trigger?dataset_id=${BRIGHT_DATA_CRAWL_DATASET_ID}&format=json" \
  -H "Authorization: Bearer ${BRIGHT_DATA_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '[{
    "url": "[STARTING_URL]",
    "crawl_depth": [DEPTH],
    "url_filter": "[REGEX_PATTERN]",
    "format": "markdown"
  }]'
```

**Key parameters:**
- `url` — Starting URL for the crawl
- `crawl_depth` — How many link hops to follow (default: 3)
- `url_filter` — Regex to restrict which URLs to crawl (e.g., `"https://example\\.com/docs/.*"`)
- `format` — Output format: `markdown`, `html`, `json`, `ld_json`
- `include_errors` — Set to `true` for detailed error logs

### Full Crawl: monitor

The API returns a `snapshot_id`. Poll for completion:

```bash
curl -X GET "https://api.brightdata.com/datasets/v3/progress/${SNAPSHOT_ID}" \
  -H "Authorization: Bearer ${BRIGHT_DATA_API_KEY}"
```

**Status values:** `running`, `ready`, `failed`

- Poll every 10 seconds
- Timeout after 5 minutes for small sites, 15 minutes for large
- Report progress to user: "Crawling in progress... X pages collected so far"

### Full Crawl: retrieve

Once status is `ready`:

```bash
curl -X GET "https://api.brightdata.com/datasets/v3/snapshot/${SNAPSHOT_ID}?format=json" \
  -H "Authorization: Bearer ${BRIGHT_DATA_API_KEY}"
```

Results come as an array of page objects, each with URL and content.

API auth failure → check the `BRIGHT_DATA_API_KEY` environment variable; an unknown dataset error → check `BRIGHT_DATA_CRAWL_DATASET_ID`.

## Output format

```markdown
## Crawl Results: [domain]
**Pages crawled:** [N]
**Depth reached:** [N]
**Starting URL:** [URL]

### Site Map
- [URL 1] (depth 0)
  - [URL 2] (depth 1)
  - [URL 3] (depth 1)
    - [URL 4] (depth 2)

### Page Contents

#### [URL 1]
[markdown content]

#### [URL 2]
[markdown content]
...
```

## Examples

- **Section:** "crawl all pages under docs.example.com/api/" → Light Crawl, url_filter `/api/`, depth 3, the default page limit of 20, so no confirmation is needed.
- **Whole site:** "crawl the entire site at smallbusiness.com" → Full Crawl, confirm cost first, depth 3, no filter.
- **Scoped competitive:** "get competitor.com's product pages" → Full Crawl, url_filter `"https://competitor\\.com/products/.*"`, depth 2.

## References

- **FourTierScrape.md** — Single-page scraping (used internally by Light Crawl for the starting URL and as fallback)
