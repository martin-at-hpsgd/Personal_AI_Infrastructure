# Instagram

Images, Reels and carousels posted to Instagram.

## Ideal State

- The post is published to a Creator or Business Instagram account with a caption within the 2,200-character limit.
- Every post carries media: an image, a single video posted as a Reel, or a carousel of 2–10 items, and that media meets the Hard requirements under Output format.
- A Reel is posted from a local video file the user owns (an editor's export, a video made in-session, or the copy a platform lets the owner download of their own upload), because `--media` takes local paths only; that file meets the Reel spec (MP4/MOV, 3s–15min, ≤ 300MB, 9:16 recommended) and passed the video PII gate before upload.

## Anti-criteria

- Never reposts a video the user does not own, and never pulls a video off a hosting site with a downloader. Given only a link, the run asks for the local file rather than fetching it.
- Never attempts a text-only post; Instagram has no text-only posts.
- Never mixes image and video in one carousel; mixed carousels are not supported in v1.

## Inputs

| Property | Value |
|----------|-------|
| Auth Type | Instagram Login (graph.instagram.com), long-lived token |
| Token Expiry | 60 days (refresh with `Tools/InstagramAuth.ts refresh`) |
| Account | Must be Creator or Business (personal can't publish) |

## Tool contract

```bash
# Preview: add --dry-run to any of these
bun ~/.claude/skills/Broadcast/src/index.ts post \
  --content "CAPTION_HERE" \
  --media ./photo.jpg \
  --platforms instagram \
  --dry-run

# Single image
bun ~/.claude/skills/Broadcast/src/index.ts post \
  --content "CAPTION_HERE" --media ./photo.jpg --platforms instagram

# Reel
bun ~/.claude/skills/Broadcast/src/index.ts post \
  --content "CAPTION_HERE" --media ./clip.mp4 --platforms instagram

# Carousel (2–10 images)
bun ~/.claude/skills/Broadcast/src/index.ts post \
  --content "CAPTION_HERE" --media ./a.jpg,./b.jpg,./c.jpg --platforms instagram

# Reel from your own exported video: check length and size first (3s–15min, ≤ 300MB)
ffprobe -v error -show_entries format=duration,size -of default=nw=1 ./my-video.mp4
bun ~/.claude/skills/Broadcast/src/index.ts post \
  --content "CAPTION_HERE" --media ./my-video.mp4 --platforms instagram --dry-run
# The post's PII gate scans the file; drop --dry-run to publish
```

## Gotchas

| Issue | Solution |
|-------|----------|
| "requires at least one image or video" | Instagram has no text-only posts — add `--media` |
| "requires R2 staging" | Set `BROADCAST_R2_*` in `~/.claude/.env` (Auth intent) |
| Token expired (OAuthException) | `bun Tools/InstagramAuth.ts refresh` (or re-run `exchange` if past 60 days) |
| Container status ERROR/EXPIRED | Usually a bad media spec — check aspect/size/format against the limits above |
| "Not configured" | Run `Tools/InstagramAuth.ts` (see Auth intent) |

## Output format

Hard requirements (Instagram-specific):

- **Images must be JPEG.** PNG/WebP are auto-converted to JPEG before upload (via `sips`/`ffmpeg`). JPEG ≤ 8MB, width 320–1440px, aspect 4:5 to 1.91:1.
- **Single video posts as a Reel.** MP4/MOV, 3s–15min, ≤ 300MB, 9:16 recommended.
- **Carousel = 2–10 items**, one media type per carousel.
- **Media is served from a public URL.** Meta fetches the file — it does not accept a binary upload. The adapter stages each file to R2, hands Meta the URL, and deletes it after publishing, or after a failed publish. A delete that fails is printed as a warning with the still-public URL and object key, so you can remove it by hand. This needs `BROADCAST_R2_*` env set (see Auth intent).
