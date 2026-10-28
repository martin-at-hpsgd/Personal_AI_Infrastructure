# MediaSourcing

Puts the real thing on screen for everything a talk names: footage, covers, screenshots and photos placed as `media` slides that start by themselves in the show.

## Ideal State

- Every MEDIA NEEDED slide has a GIF or still of the real thing, and every name in a `>` line or a listed reference is on screen when it is spoken.
- Each still's and clip's credit (film and year, site, publisher) is in the slide's `source` field (`--set <n> source "…"`), which prints small at the bottom left, and the subtitle says what the slide means. The fetched files stay square; the build rounds the 12 pt corners (`../References/KeynoteGotchas.md`).
- Covers are the edition being talked about, screenshots show the real current page, and no still is soft at slide size.
- Each clip is one moment of 4–6.5 seconds that reads at a glance: the character's face, the interface moving, the robot doing the thing the line says. Its first frame shows the subject, because Keynote shows the first frame in edit view and exports.
- Nothing on the clip competes with the slide: no frame of a finished GIF shows a channel watermark, end card, burned-in subtitle, letterbox bar (crop auto removes bars) or black speckle.
- The rebuilt deck's exported slides show each clip below its title, never under it.
- Sourcing (contact sheet, cuts) starts as soon as the first deck build has marked the MEDIA NEEDED slides, without waiting for `KeynoteArt.md`, and runs alongside its drawing. Each `--set <n> image` placement is a single write that never overlaps an art placement (both rewrite `KEYNOTE.json`), and the rebuild waits for both legs.
- The movies start on slide entry, proven from Keynote's own reading of the deck: `bun Tools/KeynotePlayback.ts <deck.key>` reports every animation as starting by itself.

## Anti-criteria

- A generated picture never stands in for something the audience could look up.
- A credit never goes in the subtitle.
- `KeynoteAutoplay.ts --check` passing is never reported as proof that the movies start by themselves: `KeynoteAutoplay.ts <deck> --check` reads only the patched archive flags and exits 0 even when movies still wait for a click.
- The deck or its clips are never published anywhere public without asking the speaker.
- Footage is sourced only from media you own or are licensed to use. A watermark is never cropped, blurred or otherwise removed; a clip that carries one is replaced by a different clip or a licensed source.

## Inputs

Use this when a talk names real things the audience should see (films, characters, products, people, places), or when READ.md carries a visual direction line asking for footage or images.

- **Visual direction lines.** A READ.md line starting with `>` (`../References/TalkFiles.md`), such as `> show a clip of WREN from The Quiet Engine`, reaches the section's designer and never the notes (`Keynote.ts`).
- **Named references.** A sentence that names a film, character, product or person ("WREN, the engineer's research partner") is an ask even without a direction line. When a section lists several, each gets its own slide, one sentence each.
- **The `media` art type.** The designer marks those slides `artType: media` with a brief naming the footage and the moment wanted. `--list` shows them as MEDIA NEEDED until an image is set.

## Tool contract

```bash
M=~/.claude/skills/Presentation/Tools/KeynoteMedia.ts
bun $M sheet <talk>/art/media/<name>.mp4                      # a timestamped contact sheet beside a local video
bun $M gif <talk>/art/media/<id>.mp4 --from <s> --to <s> --out <talk>/art/final/media-<name>.gif   # ≤6.5 s, crop auto, loops
bun $M still <talk>/art/media/<id>.mp4 --at <s> --out <talk>/art/final/media-<name>.jpg
bun $M cover "<title>" [--author "<name>"] --out <talk>/art/final/cover-<name>.jpg   # largest Open Library cover
K=~/.claude/skills/Presentation/Tools/Keynote.ts
bun $K --read <READ.md> --set <slide> image media-<name>.gif   # then rebuild; autoplay is applied on every build
bun $M --self-test
```

Footage is a local video file the speaker owns or is licensed to show: their own recording, or a clip from a source that licenses it for presentation, such as a studio's press kit or a licensed stock library. Put it in `<talk>/art/media/`, pick moments from the contact sheet, then confirm with a few full-size frames at the candidate times before cutting. Licensed sources tend to carry no overlay, though some add an end card in the last seconds. If a clip carries a watermark, choose a different moment or source and do not edit the mark out. When no licensed copy is at hand, the slide says so in the handoff rather than taking footage from elsewhere. `search` and `fetch` run only where the install carries its own footage lane; elsewhere they exit 3 and say they are not available in this install.

### Stills: covers, screenshots, photos

The brief's first word names the form (`cover:`, `screenshot:`, `photo:`, `logo:`, `footage:`).

| Form | Where the real one comes from |
|------|-------------------------------|
| The speaker's own book, product or site | `RealThings.json` in the install's customization folder. The build applies it; register anything new there once, with the best copy available. |
| Any other book | `bun $M cover "<title>" --author "<author>"` (Open Library), else the publisher's or the author's own page. |
| A website or app | A screenshot of the live page through the Interceptor skill at 1920×1080 or larger, cropped to the part being talked about. |
| A product, person or place | The maker's press image, the person's own published photo, or Wikimedia Commons. |

A still should have at least as many pixels as it will fill on the slide (about 840 px tall for a cover beside the title, 1680 px wide for a full-slide screenshot). The build warns when it is shown at more than 1.6× its size; look for a larger copy before accepting the warning.

## Gotchas

- **The obvious search result is often the wrong moment.** A clip titled after a character's best-known line can show only the people around it in a dark set, while a different scene shows the character itself in action. Look at the subject in the frames, not the title.
- **A 16:9 clip went full-bleed under its title** in an early build of the reference talk. `Keynote.ts` now keeps `media` slides below the title whatever their shape; keep a slide's `artType` set to `media` so that rule applies.
- **Check GIF frames with ffmpeg, which composites them properly.** ImageMagick's single-frame `gif[n]` shows false black speckles on optimized GIFs.
- **Clips are large.** A 6-second 1280-wide GIF runs 18–40 MB, so seven clips add about 200 MB to a deck. Pass `--width 960` or `--fps 12` when a deck must travel.
