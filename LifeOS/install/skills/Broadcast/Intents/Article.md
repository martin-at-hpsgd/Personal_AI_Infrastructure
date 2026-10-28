# Article

A markdown file published as an X Article, then the intro text posted with a video attached and the article linked.

## Ideal State

- The author writes the piece in their own editor, and one command puts it on X as a formatted Article: headings, bold, links, inline images and embedded posts intact. Nobody opens the X composer.
- The full long-form body is published through the Article endpoint; when an intro post accompanies it, that post lands carrying the video and the article link, and it never substitutes for the Article.
- When a cover is passed, it is a wide landscape image, because X shows an Article cover as a wide strip (about 5:2) and crops anything taller; its important subjects sit clear of the edges. When an existing piece is adapted, the cover is a wide version of its header that preserves the artwork's subject and style, and the original source image is kept intact.
- The cover file's actual dimensions, as measured before upload, are wide landscape, and its image visibly shows the intended subject before upload. After publishing, a real-browser look at the Article (the Interceptor skill if installed, else your own browser) shows the cover rendering correctly.
- The report links the intro post as read back from X and an article URL confirmed to resolve.
- When `--canonical <url>` was passed, the original post's URL went out as a bare-URL reply to the article, which X unfurls into a link card with a thumbnail.

## Anti-criteria

- A portrait or square header is never uploaded unchanged as the Article cover.
- Never runs with `--publish` before the principal has confirmed; publishing is public content under their name.
- The article is never published before the intro text is weight-validated, because articles have no delete endpoint and the reverse order can strand a public article with no post pointing at it.
- The canonical link is never put in the article body instead of the reply.

## Inputs

The `--file` markdown is converted as follows:

| Markdown | Becomes |
|----------|---------|
| `#` / `##` / `###` | `header-one` / `header-two` / `header-three` |
| `- item`, `1. item` | list item blocks |
| `> quote` | blockquote |
| `**bold**`, `*italic*`, `~~strike~~` | inline style ranges |
| `[text](url)` | link entity over the anchor text; the URL never shows in the body |
| `![alt](./local.png)` on its own line | uploaded image, inline in the article |
| an x.com status URL on its own line | embedded post |
| a fenced code block | code block |
| `---` | divider |

Images must be local paths — remote image URLs fail loudly rather than being skipped. Paths resolve relative to the markdown file.

The title comes from the leading `# Heading` unless `--title` overrides it.

## Safety gates

Publishing is public content under the principal's name. Confirm with them before running with `--publish`; drafts and dry runs need no approval.

## Tool contract

```bash
bun ${LIFEOS_SKILL_DIR}/src/index.ts article \
  --file ./piece.md \
  --cover ./cover.png \
  --intro "One or two lines of setup." \
  --video ./clip.mp4 \
  --publish

# With the canonical reply, and a dry run of both legs
bun ${LIFEOS_SKILL_DIR}/src/index.ts article --file ./piece.md --cover ./cover.png \
  --intro "One line of setup." --video ./clip.mp4 --canonical https://site.com/post --publish
bun ${LIFEOS_SKILL_DIR}/src/index.ts article --file ./piece.md --intro "Setup." --dry-run
```

Without `--publish` it stops at an unpublished draft and posts nothing — there is no link to point at yet. `--dry-run` previews both legs and creates, uploads and posts nothing on X. With `--video` it still runs the video PII scan first, which sends the clip to Google's Gemini API and needs `GOOGLE_API_KEY` (see "Video PII scan" in Setup.md); `--skip-pii` is for a Gemini outage, never routine use.

Use `X/Tools/article.ts` directly when only the Article is requested.

Order of operations (the command enforces it):

0. With `--video`: the video PII scan runs on the clip, dry runs included. Findings stop the command until you re-run with `--pii-reviewed`.
1. Intro text is weight-validated against the final post (the article link counts as 23 characters). A `--dry-run` prints its preview here and stops.
2. Images and cover upload.
3. The draft is created.
4. With `--publish`: the article publishes, then the intro post goes out carrying the video and the article URL.

Verification:

Read the intro post back and confirm the article URL resolves:

```bash
bun ~/.claude/skills/X/Tools/read.ts <post_id>
```

Canonical link: pass `--canonical <url>` with the original post's URL. The reply is best-effort: if it fails, the article and intro post are already public, so the command reports the failure and keeps going rather than unwinding.

## Gotchas

- **X Articles require X Premium on the account.**
- **X Articles are long-form, and publishing them is irreversible.** `article` converts markdown to X's `content_state` (DraftJS in snake_case) via `X/Tools/article.ts`, uploads inline images and the cover, drafts, then optionally publishes. X documents **no delete or edit endpoint** for a published article, so the command validates the intro post's weighted length BEFORE publishing — the reverse order can leave a public article with no post pointing at it. Without `--publish` it stops at a draft and posts nothing.

Never put the canonical link in the article body instead. A markdown link there renders as plain underlined text and gets no card.
