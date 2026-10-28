# HTML decks

Verified failures from HTML decks: lecture decks built by `Build.ts` and deck-mode decks on the install template.

## Gotchas

**Any HTML deck:**

- **Speaker view needs HTTP and a real S keypress.** On `file://` the notes popup breaks, and Chrome blocks popups that a script opens. Serve the deck and have the speaker press S themselves.
- **The text-only shell loads reveal.js from a CDN.** It won't work offline at a venue. For a real presentation, build against a template that ships its own `vendor/` copy of reveal.js.

**Deck mode (HTML template):**

- **Template fonts are often licensed to one person.** They stay in the install's customization `Template/` and never enter the skill, a public repo or a shared artifact.
- **Interceptor `--pixel` follows the active tab.** A capture can grab whatever page is in front (2026-07-14, twice). Use `--reuse --activate` and look at every image before judging it; the same applies to `interceptor reload`.
- **Interceptor DOM-render screenshots draw fallback fonts.** The live page renders the webfonts, the DOM capture substitutes system faces (proved 2026-07-14). Judge type only from `--pixel` captures.
- **Chrome rejects retail desktop OTFs** served over HTTP; they 200 and silently fail `@font-face`. Convert to woff2 (`uvx --with brotli --from fonttools`) and add `local()` sources first.
- **Never flex-center slide content.** Reveal sets inline `display:block` on the live section. Centering comes from the `.v` wrapper in `DesignSystem.md`; content outside it pins to the top. Reveal also mirrors section classes onto its window-spanning backgrounds (`DesignSystem.md` § Rendering gotchas).
- **A white background in a capture means the deck is broken** (theme.css or fonts did not load), not that the design is minimal.
- **Never leave edit mode on while capturing.** Every element is contentEditable and one stray keystroke changes copy (2026-07-14: an "s" landed in a deck title). Diff the copy after any editor session.
- **Read the speaker's own posts from disk, not WebFetch.** The fetch model refuses to reproduce them verbatim; the path is in `Config.md`.
- **Formatters turn `&mdash;` into a literal dash in deck.html.** Sweep for both forms when fixing copy.
