# Post

Content posted to the configured social media platforms.

## Ideal State

- Nothing secret, internal or private goes out: no credential or token, internal or staging URL, or personal information in any platform's text or media. The SecurityValidation intent reviewed the content for all of it. The code gates inside `post` back only part of that review: the send gate stops a real secret, a private key, your own home-directory path or an unreadable file in the exact text and media, and the video PII gate scans every video. Internal URLs and personal information in text rest on the review, and a LinkedIn link card's title, description and image (and a URL-only post's commentary, which is that fetched title) are fetched from the linked page at send time and never pass the gate (SKILL.md § Gotchas: the send gate and the video PII gate).
- The post went to the platforms the user specified; when none were specified, the user was asked which, and "all", "everywhere", "all three" or "all four" meant all four platforms (twitter, linkedin, bluesky, instagram).
- A dry run ran first and its preview was shown to the user and confirmed before the actual post, unless the user explicitly said "post now".
- Each platform's text meets the platform handling under Output format.
- When the broadcast is built around someone's video and Config.md sets `video_followup = true`, the loop is closed with the video on both platforms with no separate ask: on X a reply to the last tweet with the bare video URL alone so X renders the embed, and on LinkedIn a comment carrying the video link. With the key absent or `false` (the default), the follow-up is offered to the user and posted only on their yes.
- The report names which platforms succeeded, links to the posts, the embed reply (X) and link comment (LinkedIn) when one was posted, and any failures and why.
- For X, the report comes only after the returned post was read with `bun ~/.claude/skills/X/Tools/read.ts <tweet-url>` and every displayed expanded URL exactly matches the intended canonical URL; a CLI success exit alone is insufficient.
- When a platform fails, the other platforms still post, and the report gives the specific error for the failed platform with suggested fixes.

## Anti-criteria

- X text is never raw-sliced, truncated or given an appended ellipsis; the whole X post is rejected before sending when weighted length exceeds 280.
- The video link never goes in the LinkedIn post body; it goes in a comment.
- The `**` LinkedIn markup never reaches X, Bluesky or Instagram.

## Safety gates

Run the SecurityValidation intent on the content, then a dry run (skipped only when the user explicitly says "post now"), and confirm the preview with the user before the live post:

```bash
bun ~/.claude/skills/Broadcast/src/index.ts post \
  --content "CONTENT_HERE" \
  --platforms PLATFORM_LIST \
  --dry-run
```

## Tool contract

Once confirmed:

```bash
bun ~/.claude/skills/Broadcast/src/index.ts post \
  --content "CONTENT_HERE" \
  --platforms PLATFORM_LIST
```

| Flag | Description |
|------|-------------|
| `--content <text>` | Content to post |
| `--file <path>` | Load content from file |
| `--media <paths>` | Comma-separated local media files |
| `--platforms <list>` | Comma-separated platforms or "all" |
| `--dry-run` | Preview without posting |
| `--pii-reviewed` / `--skip-pii` | Video PII gate (SKILL.md § Gotchas) |
| `--linkedin-plain` | Skip the LinkedIn styling gate on purpose |

```bash
# Post with media (images or videos). Videos pass the PII gate first (LIFEOS/TOOLS/VideoPiiGate.ts):
# findings stop the post until you add --pii-reviewed; --skip-pii bypasses the scan loudly (scanner down only).
bun ${LIFEOS_SKILL_DIR}/src/index.ts post --content "Check this out!" --media ./image.jpg --platforms all
bun ${LIFEOS_SKILL_DIR}/src/index.ts post --content "New video!" --media ./video.mp4 --platforms twitter,bluesky

# Multiple images (Twitter/Bluesky support up to 4)
bun ${LIFEOS_SKILL_DIR}/src/index.ts post --content "Gallery" --media ./img1.jpg,./img2.jpg --platforms twitter
```

Video-anchored follow-up (opt-in):

When the broadcast is built around someone's video (a share, teaser, or reaction to a video), the video can follow on both platforms. Read `video_followup` in Config.md: `true` posts the follow-up below with no separate ask; absent or `false` (the default) asks the user first.

- **X:** after the thread, reply to the LAST tweet with the bare video URL alone so X renders the embed:

  ```bash
  echo '["<videoUrl>"]' | bun ~/.claude/skills/X/Tools/post.ts --reply-to <lastTweetId>
  ```

- **LinkedIn:** the main post keeps its own framing; the video link goes in a COMMENT, never the body (LinkedIn suppresses reach on body links):

  ```bash
  bun ~/.claude/skills/Broadcast/Tools/LinkedInComment.ts <shareUrn> "Video: <videoUrl>"
  ```

  The share URN is the `urn:li:share:...` in the post result. (Comment tool uses the v2 `socialActions` endpoint — the REST/partner endpoint 403s. See the tool's header.)

## Output format

The report carries what the Ideal State names. Platform handling:

- **Twitter (280 weighted chars):** weighted length, the shared `X/Tools/TwitterText.ts` validator and the `expanded_url` read-back follow the X gotcha in SKILL.md.
- **LinkedIn (3000 chars):** markdown is converted to LinkedIn's styled text; with `house_style = true` an unstyled post is refused (the LinkedIn styling gotcha in SKILL.md; `--linkedin-plain` overrides).
- **Bluesky (300 chars):** plain text, cut to fit before the send (`Intents/Bluesky.md`).
- **Instagram (2,200-char caption):** media required, so a text-only broadcast reports Instagram as skipped (`Intents/Instagram.md`).
