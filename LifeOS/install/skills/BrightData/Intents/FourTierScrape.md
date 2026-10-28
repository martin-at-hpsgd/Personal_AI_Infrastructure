# Four-Tier URL Content Scraping

**Contents:** Ideal State · Anti-criteria · Tool contract · Output format · References

The URL's content in clean markdown, labeled with the tier that retrieved it. Start cheap, escalate only on failure: the tier that succeeds first is the answer.

## Ideal State

- The URL's content is delivered in clean markdown, prefixed with which tier succeeded (Tier 1/2/3/4), and for Tier 3/4 with a one-line note on why escalation was needed.
- The delivered content is readable, matches the URL, and has no major missing sections.
- Retrieval started cheap and escalated only on failure: the Cloudflare markdown pre-check ran before the tier chain, and the tier that succeeded first is the one whose content was delivered.
- When the pre-check detects markdown (any of its three signals), that body is used directly and the tiers are skipped, with `x-markdown-tokens` captured as token-count metadata when present.
- When Tier 4 also fails, the user is told the site is down, login-gated, paywalled, geo-restricted, or refuses automated access, with the URL to double-check.

## Anti-criteria

- Never uses Tier 4 (the Bright Data proxy, which has usage costs) for a site accessible via Tier 1-3; a paid tier is never used despite a successful cheaper retrieval without an explicit override such as "use Bright Data".
- Never uses Playwright: Playwright is banned across LifeOS, and Tier 3 is Interceptor.
- Never continues past a site's explicit refusal: a CAPTCHA, block page, login wall or robots.txt disallow ends the retrieval, and the refusal is reported with the URL. Every request is made within the target site's terms; no tool reads a site's terms, so knowing them is the operator's job.
- The delivered markdown never contains a block page in place of the content, and the reported tier never differs from the tool evidence.

## Tool contract

### Step 0: robots.txt

Before the pre-check and every tier, run `bun skills/BrightData/Tools/MarkdownPreCheck.ts robots "[URL]"`. Exit 3 means the site disallows the path: the retrieval ends and the refusal is reported with the URL. Tier 3 and Tier 4 are never used on a page whose body is a bot challenge or CAPTCHA, because the managed fetch clears challenges where the agent cannot see them; only a page that is empty because it needs JavaScript escalates. The `robots` command is the only code check here, and it runs only when the agent runs it: spotting a block page, CAPTCHA or login wall at each tier, and keeping Tier 3 and Tier 4 off a challenge page, is the agent's own reading of the page, with no code gate behind it.

### Pre-check: Cloudflare markdown negotiation

Before the tier chain, probe for server-side markdown via Cloudflare's [Markdown for Agents](https://blog.cloudflare.com/markdown-for-agents/). Non-Cloudflare sites ignore the header and return HTML — zero downside.

```bash
bun skills/BrightData/Tools/MarkdownPreCheck.ts check "[URL]"          # exit 0 markdown (body printed), 1 → Tier 1
curl -sL -H "Accept: text/markdown" "[URL]" | head -5                # the raw probe, when the tool is unavailable
```

**Markdown detected (any of these) → use the body directly, skip the tiers:**
1. `Content-Type` header contains `text/markdown`
2. `x-markdown-tokens` header present (capture it as token-count metadata)
3. Body starts with YAML frontmatter (`---`) or a markdown heading (`# `) instead of `<!DOCTYPE`/`<html` — Cloudflare's CDN sometimes reports `content-type: text/html` even when the body is markdown

~80% fewer tokens than HTML-to-markdown conversion, ~1-3s, free. HTML or error → proceed to Tier 1.

### Tier 1 — plain curl

Take the raw HTML the pre-check already returned, or fetch it with `curl -sL -A "LifeOS-BrightData/1.0" "[URL]"`, extract the body in a bun script and convert it to markdown. Never WebFetch here: it returns a small model's summary, not the page, and that summary would be delivered labeled as the page. Real content → Output. A block page, CAPTCHA or login wall → stop and report it. Empty body or timeout → Tier 2.

### Tier 2 — curl with standard request headers

The same fetch with the ordinary request headers a client declares: a user agent that names this tool, content negotiation and compression. It helps with servers that reject a request that has no Accept header; it is not a way past a refusal.

```bash
curl -L -A "LifeOS-BrightData/1.0" \
  -H "Accept: text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.8, */*;q=0.7" \
  -H "Accept-Language: en-US,en;q=0.9" \
  --compressed \
  "[URL]"
```

HTML returned → convert to markdown → Output. Empty or JS-required → Tier 3. Block page or CAPTCHA → stop and report it.

### Tier 3 — Interceptor (real Chrome)

Renders JavaScript pages and keeps the session of the Chrome profile it drives, so the page appears as it does for the user.

```bash
interceptor open "<url>"        # renders JS, returns tree + flat text
interceptor read --text-only    # extract rendered text
```

Rendered text → convert to markdown → Output. A CAPTCHA, block page or login wall → stop and report it.

### Tier 4 — Bright Data MCP

Bright Data's managed fetch product (`scrape_as_markdown`): hosted rendering and geo-targeted requests, documented by the vendor and billed to your account. Use it for pages that need managed rendering or a specific region, within the target site's terms. It has usage costs, so it comes last.

```
mcp__Brightdata__scrape_as_markdown  with URL: [user-provided URL]
```

Success → Output. If the MCP server is not registered, stop with the best free-tier result and say Tier 4 is not configured (SKILL.md § Data & Config).

### Tier label

```bash
bun skills/BrightData/Tools/MarkdownPreCheck.ts label "[URL]" <precheck|1|2|3|4> [--why "<one-line reason>"]
```

Prints the first line of the Output format. Tier 3 and Tier 4 refuse to print without `--why`. Both the pre-check and the label have fixture tests in the maintainer source tree (not in the public release): `bun test ./skills/BrightData`.

### Intent-to-Flag Mapping

| Intent need | Command |
|-------------|---------|
| Cloudflare markdown pre-check | `MarkdownPreCheck.ts check "[URL]"` (`--json` for one JSON line) |
| Label from the pre-check | `MarkdownPreCheck.ts label "[URL]" precheck` |
| Label for Tier 1 or 2 | `MarkdownPreCheck.ts label "[URL]" 1` / `2` |
| Label for Tier 3 or 4 with the escalation note | `MarkdownPreCheck.ts label "[URL]" 3 --why "<reason>"` |

## Output format

```markdown
Successfully retrieved content from [URL] using Tier [1/2/3/4]

[Content in markdown format...]
```

When the pre-check returned markdown, the first line names the pre-check instead of a tier; Tier 3 and Tier 4 append `(escalated: <reason>)`. `MarkdownPreCheck.ts label` prints this line.

## References

- `SKILL.md`: the tier table (tool + cost) and the skip-ahead rules.

- `Crawl.md` — multi-page site crawling (calls this intent for its starting URL and as fallback).
