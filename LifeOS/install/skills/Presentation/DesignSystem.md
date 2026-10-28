# Default design system — the deck-mode slide register

**Contents:** Override · Tokens · Type roles · The footer band · Signature elements · The nine archetypes · Archetype selection judgment · On-slide copy rules · Rendering gotchas

A neutral default register for deck-mode slides: dark slate grounds, white content slides, one accent color, a gray header band on content slides, and a footer band carrying the presenter's mark, name and date line, and the page number.

## Override

When `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Presentation/DesignSystem.md` exists (`configRoot` is `$CLAUDE_CONFIG_DIR`, else `~/.claude`), it replaces this file's Tokens, Type roles, Footer band and Signature elements with the install's own brand register. Read that file instead of those sections. The archetype classes, the `.v` wrapper contract, the selection judgment and the rendering gotchas below hold under any register, because the install template's `theme.css` and `deck.html` implement them.

**Canvas model (Keynote-style):** every slide is a bounded 1280×720 canvas on a `#161616` surround; bands, grounds, and the footer live inside the canvas. Sections are fixed 720px boxes (`center: false`); reveal letterboxes any non-16:9 window in charcoal, and at 16:9 fullscreen the canvas fills the screen exactly.

Canonical CSS: the install template's `theme.css`. Canonical markup: its `deck.html` (template in `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Presentation/Template/`), one slide of every archetype. The engine (reveal.js + editor.js + Present.ts) is register-agnostic; never fork it per design.

## Tokens

| Token | Value |
|---|---|
| Dark ground (title/section/statement/close, footer band) | `#1E293B` |
| Dark inset panel (title slides) | `#334155` |
| Header band | `#E2E8F0` |
| Band title | `#0F172A` |
| Content body ground | `#FFFFFF` |
| Body/bullet gray | `#475569` |
| Accent (bullets, chart series) | `#2563EB` |
| Footer name/date + separator | `#CBD5E1` |
| Footer mark | `#94A3B8` |
| Caps on dark grounds | `#CBD5E1` |
| Captions | `#94A3B8` |
| Surround outside the canvas | `#161616` |

## Type roles

| Role | Face | CSS family |
|---|---|---|
| Band titles (content slides) | serif display, `<em>` for italic emphasis words | `Georgia, serif` |
| Band subtitle | the band-title face, small | `Georgia, serif` |
| Title-slide + section caps | sans caps, letterspaced white | `system-ui, sans-serif` |
| Body + bullets | sans, gray | `system-ui, sans-serif` |
| Column headers (two-col) | sans caps, band-title color | `system-ui, sans-serif` |
| Footer name/date | sans light, mixed case | `system-ui, sans-serif` |
| Page number | sans, white | `system-ui, sans-serif` |
| Code | monospace | `ui-monospace, monospace` |

Licensed fonts belong in the install template's `fonts/`, never in the skill.

## The footer band

Ratios are fractions of slide height H, applied by `fitFooter()` in deck.html (which glues the band to the rendered slide rect):

- Band: bottom 10% of the canvas, the dark ground.
- Cluster (mark + name | date + page number) sits right-aligned, its center a little below the band's geometric center.
- Mark about 2.3%H tall, gap about 1.7%H to the name.
- Name/date `<presenter name> | <Month Year>` at about 1.5%H font, inset about 8%H from the canvas right edge; the name comes from the install's `Config.md` byline.
- Page number (bare current number, `slideNumber: 'c'`) at about 1.7%H font, white, inset about 4%H.

## Signature elements

Gray header band (113px of the 720px canvas) with the band title + small subtitle indented to the template master's position · accent-colored bullet glyphs · dark footer band per above · dark title slides with inset panel · fade transitions only · no progress bar.

## The nine archetypes

| Archetype | Classes | Ground | Reach for it when |
|---|---|---|---|
| Title | `slide-title` | dark + panel | Deck opener, exactly once |
| Section | `slide-section` | dark | A named movement in the arc |
| Statement | `slide-statement` | dark | The idea fits one sentence worth pausing on |
| Bullets | `slide-bullets slide-banded` | band + white | Genuinely parallel items, **max 4** |
| Two-column | `slide-two slide-banded` (cols use `h4`) | band + white | A real dichotomy |
| Quote | `slide-quote` | white | The line people will quote back |
| Art/Figure | `slide-art slide-banded` | band + white | Text left, figure right |
| Chart | `slide-chart slide-banded` | band + white | The numbers are the argument |
| Close | `slide-close` | dark | Deck closer, exactly once |

The dark grounds come from the section classes in `theme.css`, never a reveal background attribute (§ Rendering gotchas).

**Banded slides**: `h3` is the band title (use `<em>` on one or two emphasis words, never the whole line); optional `p.sub` is the small subtitle under it.

**The `.v` wrapper (a markup contract every deck follows):** every section except `slide-title` wraps its content in `<div class="v">…</div>`; band `h3`, `p.sub`, and `aside.notes` stay outside it. The wrapper is what vertically centers the content block in its zone (band→footer on white slides, canvas→footer on dark slides) for any content height; never hand-tune vertical position per deck. On title slides the `.panel` is the centered block. Content outside a `.v` renders top-pinned.

## Archetype selection judgment

The content picks the archetype, never the reverse:

- A statement that fits one line **never** becomes bullets. If a list has fewer than 3 genuinely parallel items, it's a statement or a two-column.
- Section slides only where the narrative genuinely turns.
- Figures/art earn their place or stay out; the pattern is a big right-side figure balancing a short left column.
- Charts only when the numbers are the argument; inline SVG, the accent color as the series on white, recessive grid, selective labels.
- Slides carry the punchline; notes carry the paragraph.

## On-slide copy rules

- The speaker's writing style binds when the install names one (PREFERENCES.md): plain declaratives, closed em-dashes, no marketing register.
- Band titles are Title Case with one italic emphasis word; statements are sentence-case crafted lines.
- Max 4 bullets per bullets slide.

## Rendering gotchas

- **Never use `data-background-color`**: grounds are section CSS (`.reveal .slides .slide-*`), bounded to the canvas. Reveal backgrounds paint the whole window and break the Keynote canvas model.
- **Scope every ground/band rule to `.reveal .slides`**: reveal mirrors section classes onto its viewport-spanning `.slide-background` divs, so an unscoped `.slide-banded::before` paints a stray band across the window top (2026-07-14 bug, found by pixel audit).
- The band is drawn by `::before` on `.slide-banded`; band title/subtitle are absolutely positioned; don't wrap them in other containers.
- The footer is `#footer-bar` + reveal's slide-number, glued to the slide rect by `fitFooter()` in deck.html; it survives any window shape, so don't convert it to static viewport units.
