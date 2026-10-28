# Preview

Show the principal a draft article the way a reader will see it: a rendered page with headings, bold, lists and live links, opened in their own browser.

## Ideal State

- An HTML page in `~/Downloads/` rendered from the exact draft file, named `<slug>-draft-vN.html` so versions never overwrite each other.
- The header label names the piece's context (publication, project, draft number).
- File frontmatter does not appear on the page; the first visible heading is the article title.
- Every markdown link in the draft is a clickable link on the page, and the Sources block renders as a list.
- When the Interceptor skill is installed, the rendered pixels were looked at in its test profile before the page reached the principal; without it, the reply says the page was not checked visually.
- The page is open in the principal's own browser profile (the app named by `preview_browser` in the skill config), and the reply names the file path and the draft it came from.

## Anti-criteria

- Raw markdown in a browser tab is never offered as the preview.
- The page is never styled with hand-rolled CSS; it renders through the shared doc theme (`DocRender.ts`).
- The page is never opened for the principal with `--profile-directory` or in the Interceptor test profile.

## Tool contract

Render through the shared doc theme (the same source as the ISA renderer):

```bash
bun LIFEOS/TOOLS/DocRender.ts <draft.md> --label "<Context> · <Project> · draft vN" --output ~/Downloads/<slug>-draft-vN.html
```

Optional, when the Interceptor skill is installed (see Setup.md): verify in its test profile, then read the PNG:

```bash
bash skills/Interceptor/Tools/Capture.sh "file://$HOME/Downloads/<slug>-draft-vN.html" --full --out <scratchpad>/<slug>-vN.png
```

Open for the principal in their browser (`preview_browser` in the skill config; on macOS this reuses the frontmost window):

```bash
open -a "<browser>" "$HOME/Downloads/<slug>-draft-vN.html"
```

## Gotchas

- **Frontmatter must not reach the page.** DocRender strips YAML frontmatter; if metadata shows on the page as a heading, the renderer regressed.
- **The newest draft is not always the highest file number.** Confirm from the project's ISA or the file mtimes which draft is current before rendering.
