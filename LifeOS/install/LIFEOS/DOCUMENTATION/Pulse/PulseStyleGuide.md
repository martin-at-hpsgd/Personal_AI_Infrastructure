---
last_updated: 2026-08-17T00:00:00Z
last_updated_by: da
convention: lifeos-freshness-v1
version: 1.0.4
---

# Pulse Style Guide — A Glass Sheet in a Night Room

> The standing visual system for every Pulse surface (2026-08-17 redo; exemplar-committed the same day — futuristic transparent-dashboard register, glossy glassy type). The live, rendered version of this guide is the dashboard's own `/styleguide` route — that page is built from the real chrome primitives, so it is both spec and regression canary. This doc records the rules; the tokens live in ONE place.

## Sources of truth

- **Tokens + material classes:** `LIFEOS/PULSE/Observability/src/app/globals.css` (`:root` block + `.glass` / `.glass-raised` / `.glass-sunken` / `.glass-hover` / `.page-enter` / `.data-glow`)
- **Primitives:** `src/components/ui/chrome.tsx` (PageShell, PageHeader, Panel, PanelHeader, StatTile, TabBar, Pill, EmptyState) — pages consume these, never hand-rolled cards
- **Live guide:** `http://localhost:31337/styleguide` (System nav → Style)

## The register

Futuristic transparent dashboard, kept human. Six rules:

1. **The page is a glass object in a room.** Every route renders as ONE floating frosted sheet (`.glass-sheet`, radius 28px, blur 42px, visible margins) over the backdrop; the app header is a detached floating glass capsule above it. Never full-bleed content on the ground.
2. **Glass is light, not paint.** Four tiers, all translucent, edge-lit (inset 1px white highlight) and shadowed into depth: `glass-sheet` (the page), `glass` (smoke-glass cards), `glass-raised` (palette/modals), `glass-sunken` (wells), plus `glass-silver` — the bright gradient KPI tier, at most one per view.
3. **One room, one grain.** The atmosphere is global: a super-dark-blue night interior on `body::before/::after` — warm pendant-lamp glow and bokeh discs as ACCENTS on the blue ground (2026-08-17: the base is never brown), a teal lounge note, vignette — plus SVG film grain on `html::before`. Pages never paint their own backdrops; the ground lives on `html` only and `body` stays transparent (paint order: an opaque body hides the negative-z backdrop).
4. **The human layer is non-negotiable.** Warm light everywhere the eye rests, film grain, the 13s breathing cycle, and the ember hairline under every PageHeader. Without these the futuristic frame reads sterile.
5. **Two voices, glossy display.** Page titles are glossy modern sans (SF-stack, weight 650, soft white glow); data is Triplicate mono with `data-glow`; narrative body stays Concourse. Voices never swap roles.
6. **Three motion gestures, no more.** Backdrop drift (90s/110s loops + breath), page-enter rise (480ms, PageShell), hover lift (−1px + edge brighten, 250ms). All CSS time-based (frame-rate independent). The shipped `globals.css` stills the page-enter rise under `prefers-reduced-motion: reduce`; whether an install drops or widens that gate is its own design preference. Body text never moves.

## Token names are the API

`--ground`, `--surface-1..3`, `--line-1..3`, `--ink-1..3`, `--accent-blue`, `--accent-soft`, `--ember`, the six life-dimension hues, and the glass knobs (`--glass-blur`, `--glass-edge`, `--glass-edge-hover`, `--glass-shadow`, `--sheet-bg`, `--sheet-blur`). Values may be retuned (the aurora→dusk-room pivot changed only values and backdrop layers); names are stable so 30+ consumer files never change. The DA accent blue stays the interactive accent; amber/ember is the atmosphere, never a status color.

## Don't

- No opaque hand-rolled card backgrounds; no second palette anywhere.
- No page-local backdrops or bespoke auroras.
- No light/near-white grounds.
- No purple-mesh-on-white glassmorphism clichés; the ember stays ambient, never a status color.
