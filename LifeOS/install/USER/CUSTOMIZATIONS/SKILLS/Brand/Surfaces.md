---
provenance: template
version: 2.0.0
---

# Brand Surfaces

The public-surface inventory the **BrandUpdate** and **UpdateIdeasPage** intents read at run time. `skills/Brand/Tools/Check.ts` validates this file and both intents refuse to run without it. The skill body never hardcodes a surface; everything it needs is here. Setup guide: `skills/Brand/Setup.md`.

## Source-of-truth reads

What your brand currently IS. Each backticked `.md` path is checked for existence relative to your config root.

| Key | Value |
|-----|-------|
| Focus / missions | `LIFEOS/USER/PROJECTS.md` |
| Bio facts | `LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md` |
| Freshest posts | blog feed, `$BLOG_FEED` below |

## Variables

| Variable | Value |
|----------|-------|
| `$BLOG_REPO` | `~/alex-blog` |
| `$BLOG_URL` | `https://blog.example.com` |
| `$BLOG_FEED` | `https://blog.example.com/rss.xml` |
| `$IDEAS_URL` | `https://blog.example.com/ideas` |
| `$IDEAS_SRC` | `$BLOG_REPO/content/ideas.md` |
| `$GITHUB_ORG` | `alex-example` |

## Surface inventory

Delete rows you do not have; add rows for surfaces you do. Every row needs an Update mechanism and a Gate, or the sweep cannot close it.

| # | Surface | Where | Update mechanism | Gate | Project row |
|---|---------|-------|------------------|------|-------------|
| 1 | GitHub profile front page | `github.com/alex-example/alex-example` (README) | clone → edit → push | Approval before push | — |
| 2 | Blog about page | `$BLOG_REPO` → blog.example.com/about | edit → project deploy command | Approval; Interceptor screenshot after deploy | Blog |
| 3 | Studio site | `~/Projects/studio-site` → studio.example.com | project deploy command | Approval; Interceptor screenshot | Studio Site |
| 4 | Flagship repo README | `github.com/alex-example/widgetkit` | direct edit + push | Approval | — |
| 5 | Product docs | docs.example.com | release only | Never ad-hoc | Widgetkit Docs |
| 6 | X bio | `x.com/alexexample` | paste-ready copy | Owner approves | — |
| 7 | LinkedIn bio | `linkedin.com/in/alex-example` | no API: Interceptor drive or paste-ready copy | Owner executes/approves | — |
| 8 | Ideas page | `$IDEAS_URL` | blog deploy + push | Interceptor pixels; owner approves before deploy | Blog |

Inventory rows that name a project row follow that project's deploy doctrine; the skill never invents a new deploy path.

## Surface notes

Rules for specific surfaces or for your naming history. The skill reads these before a sweep.

- Row 4's repository is generated from `widgetkit-core`; edit the source, never the README directly.
- Row 5 publishes only with a release; flag drift into the next release.
- "Gadgetkit" was the product's name until 2025. It is never the primary name for anything; the old repository redirects to the current one.
- The blog feed is `$BLOG_FEED`; `/feed.xml` and `/atom.xml` return 404.

## Writing audit

Optional. Name the audit your install runs on prose you publish in your voice (a skill, a checker command, or "read it aloud against the style guide"). When this section is absent the intents report that no audit ran.

## Ideas page

Optional; needed only by the UpdateIdeasPage intent.

| Key | Value |
|-----|-------|
| Source file | `$IDEAS_SRC` |
| Live URL | `$IDEAS_URL` |
| Deploy | `bun run deploy` from `$BLOG_REPO`, then push the main branch |
| Page structure | Intro paragraph, one table per theme, then a numbered archive |
| Row format | One-line idea with a `[Title](/posts/slug)` link; bump the "Last updated" line and the `updated` frontmatter value every run |
| Body format | Markdown with frontmatter |

### Traps

- `content/archive/ideas.md` is an older page at a different URL, not the live ideas page. Open the live page and compare before editing.
- Never link posts whose frontmatter says `draft: true`.

### Idea sources (priority order)

| Source | How to read | What counts |
|--------|-------------|-------------|
| Notes inbox | `cat ~/Notes/ideas-inbox.md` | Lines you wrote yourself |
| Recent blog posts | `curl -s "$BLOG_FEED"` | Posts that are really ideas worth cross-listing |

### Ownership filter

Only lines you wrote yourself go on the page. Anything clipped from other authors in the notes inbox (marked `clip:`) never does. When a line's origin is unclear, ask or drop it.
