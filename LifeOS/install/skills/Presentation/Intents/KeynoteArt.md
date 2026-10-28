# KeynoteArt

Makes the art for a Keynote deck: an image for every ART NEEDED or DIAGRAM NEEDED slide, made through the Art skill's matching intent, critiqued through ArtDirection to its bar, and placed in the deck.

## Ideal State

- For a new talk, `art/Direction.md` from an ArtDirection council round existed before any slide art was drawn, and `art/cse.md` (the 24-point story explanation Art's Essay intent requires) existed before any essay art.
- `--status` shows no slide without art: every ART NEEDED or DIAGRAM NEEDED slide has an image from the matching Art intent (`essay` through `Essay`, `diagram` through `TechnicalDiagrams`), critiqued through ArtDirection and placed in the deck.
- Each piece matches its art type's row and its slide's shape as § Output format defines them: essay art is one visual metaphor for the line being spoken with no text, a diagram shows how the thing works with labelled components and no title block, and full-slide essay art is 16:9, full-slide diagrams 21:9, split slides 3:2.
- Animated essay art stays within the deck's limit (the style file's `animatedEssayMax`, three when it is absent), spent on the moments that carry the talk such as the opening, the thesis and the close, and every placed GIF starts on slide entry.
- Every placed image has been looked at on its slide in the exported PNGs: the title is readable, diagram labels are spelled right, and the paper matches the slide.
- Drawing and critique start as soon as the first deck build has marked the slides, without waiting for `MediaSourcing.md`, and run alongside its sourcing. Placing the winners into the deck is a single write that never overlaps a MediaSourcing placement (both rewrite `KEYNOTE.json`), and the rebuild waits for both legs.
- The speaker gets the count that passed the bar, the slides that fell short with their scores, and the deck path. Their verdicts on the art go through ArtDirection Calibrate.

## Anti-criteria

- A MEDIA NEEDED slide never gets generated art; it takes real footage through `MediaSourcing.md`.
- A diagram slide never routes to any Art intent but TechnicalDiagrams, nor an essay slide to any but Essay, and no prompt carries the slide title or a title block.
- A slide that already has an image is not drawn again unless its art was cleared.
- The per-slide art critiques never stand in for the deck's own slides critique.

## Output format

### Two kinds of art

| Art type | Art intent | What it looks like |
|----------|--------------|--------------------|
| `essay` | `Essay` | one visual metaphor for the line being spoken, in the deck's illustration style, no text |
| `diagram` | `TechnicalDiagrams` | how the thing works: 3–7 labelled components, arrows or layers or a loop, 1–2 italic insight callouts; no title block, since the slide has its title |

Full-slide essay art is 16:9 with the slide title's area left as bare paper. Full-slide diagrams are 21:9 panoramas the deck builder fits below the title, because a bold diagram fills its frame and will not leave a corner empty. Split slides are 3:2; their picture fills a column about as tall as it is wide, so a split diagram keeps to a few large labels. Each image's paper is mapped to the deck's ground colour so it sits on the slide without a seam.

### Animated art

A placed image may be a looping GIF; Keynote plays it on the slide, and every build sets it to start on slide entry (`KeynoteAutoplay.ts`), so the speaker never clicks to start one. Diagram slides take the animated diagram from Art TechnicalDiagrams § Animated Option, with no title block and no signature, 3:2 for split slides and 21:9 for full ones. Essay slides take Art `AnimatedEssay` made from the slide's passing still, and only a few: at most the style file's `animatedEssayMax` per deck (three when the key is absent), spent on moments such as the opening, the thesis and the close. `Keynote.ts` refuses one over the limit. Media clips are real footage, not essay art, and do not count toward the three. Copy the GIF into the images folder, then `Keynote.ts --set <slide> image <file>.gif` and rebuild. Keynote shows a GIF's first frame in edit view and in exports, and plays it in the show; the Art tools open every loop on the finished picture for that reason.

## Inputs

Use this after a Keynote deck is created or updated and some slides still show an ART NEEDED or DIAGRAM NEEDED placeholder. MEDIA NEEDED slides take real footage instead, through `MediaSourcing.md`.

In the talk folder's `art/` directory:

- `Direction.md`: the art direction from an ArtDirection council round (recurring visual vocabulary, compositions). Run the Direction intent first for a new talk.
- `cse.md`: a 24-point story explanation of the talk under NARRATIVE headings, which Art's Essay intent requires.
- `Brief.json` and `Brief-diagram.json`: ArtDirection critique briefs for essay art and for diagrams.

The style file carries `art.essayTechnique`, `art.diagramTechnique` and `art.paper`, and optionally the essay-scene taste `art.bannedWords` and `art.sceneRules` (neutral default: none).

## Tool contract

```bash
A=~/.claude/skills/Presentation/Tools/KeynoteArt.ts
bun $A --read <READ.md> --status                 # which slides need art, and their last result
bun $A --read <READ.md>                          # compose, draw, critique, place every slide that needs art
bun $A --read <READ.md> --only 17,23             # just those slides
bun $A --read <READ.md> --compose-only           # write and dry-run the prompts, draw nothing
bun ~/.claude/skills/Presentation/Tools/Keynote.ts --read <READ.md> --export <dir>/keynote-png   # rebuild after
```

Each slide climbs up to four rounds of two candidates. A round's defects feed the next round's prompt. Passing art goes through Proof and ArtDirection Deliver into the images folder; art still below the bar after four rounds is placed as the best attempt and reported.
