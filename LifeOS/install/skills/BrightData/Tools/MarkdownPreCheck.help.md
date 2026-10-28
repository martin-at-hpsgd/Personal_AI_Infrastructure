# MarkdownPreCheck.ts - Help Documentation

The Cloudflare `Accept: text/markdown` pre-check and the tier label for the FourTierScrape intent, as code with fixture tests (`MarkdownPreCheck.test.ts`).

## Quick Start

```bash
# Probe a URL for server-side markdown before the tier chain
bun ~/.claude/skills/BrightData/Tools/MarkdownPreCheck.ts check "https://example.com/pricing"

# Same, as one JSON line (markdown, signals, tokens, and the body when markdown)
bun ~/.claude/skills/BrightData/Tools/MarkdownPreCheck.ts check "https://example.com/pricing" --json

# Print the first output line for the tier that retrieved the page
bun ~/.claude/skills/BrightData/Tools/MarkdownPreCheck.ts label "https://example.com/pricing" 2
bun ~/.claude/skills/BrightData/Tools/MarkdownPreCheck.ts label "https://example.com/pricing" 4 --why "JavaScript shell at Tier 3"
```

## Commands

### `check <url> [--json]`

Fetches the URL with `Accept: text/markdown` and applies the three signals: a `Content-Type` containing `text/markdown`, an `x-markdown-tokens` header, or a body that opens with YAML frontmatter (`---`) or a `# ` heading rather than `<!DOCTYPE`/`<html`. Any one signal means markdown, but only on a 2xx response: a 404, 500 or other non-2xx status is an error body and never counts, whatever its headers say.

- Exit 0: markdown detected on a 2xx response. Prints the pre-check label, the token count when present, then the body.
- Exit 1: no signal, a non-2xx status, or the fetch failed. Proceed to Tier 1.
- Exit 2: usage error.

### `label <url> <precheck|1|2|3|4> [--why "<reason>"]`

Prints the first line of the delivered output. Tier 3 and Tier 4 require `--why` with a one-line reason for escalating, and exit 2 without it.

### `robots <url>`

Fetches `/robots.txt` for the URL's host once and evaluates the path for the `LifeOS-BrightData` agent (its own group first, then `*`; longest pattern wins; `*` and `$` wildcards are supported). Run it before the pre-check and before every Light Crawl URL.

- Exit 0: allowed, or the host has no robots.txt.
- Exit 3: disallowed, or robots.txt is unreachable with a 5xx. The retrieval ends and the refusal is reported with the URL.
- Exit 2: usage error.

## Tests

```bash
# Fixture tests live in the maintainer source tree and are not in the public release.
bun test ./skills/BrightData
```

Synthesized fixtures only; no site is fetched.
