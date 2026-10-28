---
provenance: template
version: 1.0.0
---

# Presentation — Config

Principal-identity tokens for decks. The default design system lives in the
skill (a custom one goes in this directory as `DesignSystem.md`); only the byline, closing contact line, and blog paths come
from here. `Template/deck.html` ships placeholder byline and contact lines; fill
them from these keys when producing a real deck.

## SPEAKER

Used on the title slide (`SPEAKER.NAME · SPEAKER.SITE`) and the closing slide
(`SPEAKER.SITE · SPEAKER.HANDLE · SPEAKER.ORG`).

- `SPEAKER.NAME`: {{PRINCIPAL_FULL_NAME}}
- `SPEAKER.SITE`: example.com — your personal site, shown without scheme
- `SPEAKER.HANDLE`: @YOUR_HANDLE — the handle you want on the closing slide
- `SPEAKER.ORG`: Your Company — organization name on the closing slide
- `SPEAKER.ORG_URL`: https://example.com — link target for the organization name

## BLOG

Local paths so decks can quote your own posts from disk (WebFetch refuses to
reproduce your own published posts verbatim) and reuse existing header art.

- `BLOG.POSTS_DIR`: ~/Projects/<your-site>/blog — directory holding your published posts as markdown
- `BLOG.ART_DIR`: ~/Projects/<your-site>/public/images/blog — directory holding post header art

Leave a BLOG key pointing at a directory that does not exist if you have no
blog; the deck intent then skips post lookup and generates art fresh.
