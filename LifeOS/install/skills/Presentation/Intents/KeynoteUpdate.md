# KeynoteUpdate

Changes an existing Keynote deck: a rebuilt `.key` whose notes are still READ.md word for word and where only the asked-for slides changed.

## Ideal State

- `--verify` passes after the rebuild: the notes are still READ.md word for word.
- The build printed that Keynote reads every animation as starting by itself (`KeynotePlayback.ts`), and reported no iCloud copy.
- KEYNOTE.json changed only for the slides or sections that were asked for or edited. Diff it before and after.
- Moved sections kept their titles and images, and every heading in READ.md is still the exact first-slide title of its talking point.
- Any slide whose art was cleared or newly briefed has been drawn through `KeynoteArt.md`, or the speaker is told it still shows a placeholder.
- The exported slides for what changed have been looked at. The whole deck was re-exported and passed its slides critique, because `Deliver.ts` refuses a deck with any file newer than its critiqued slides. It then reached the speaker's review folder through `Deliver.ts` (`../References/QualityLoop.md`).

## Anti-criteria

- The deck never reaches the speaker's review folder by a plain copy.
- No slide or section the speaker did not ask about, and did not edit, gets a new design.
- No lasting change is made inside Keynote; it goes in READ.md or into a section's design (`../References/TalkFiles.md`).
- Slide numbers and talking point numbers are never swapped: `--move` takes talking point numbers, `--set` and `--redo-art` take slide numbers.

## Inputs

Use this when a deck already exists for the talk (its KEYNOTE.json sits next to READ.md) and the speaker wants something changed: a talking point moved, the talk file reprocessed after edits, a title or bullet reworded, an image swapped, a slide turned into a diagram, or art redone.

Each section's design is keyed by a hash of its sentences, so the deck's order is always the talk file's order. Moving a section in READ.md moves its slides, with titles and images intact. A section whose text changed gets a new design, and the designer is shown the closest earlier design so it keeps whatever still fits. A section the speaker deleted simply drops out. The file's Markdown structure is the talk's structure (`../References/TalkFiles.md`): a heading added in the file starts a new talking point titled with that heading, and `--move` carries a point's heading with it and rewrites part headings wherever the outline changes. The deck remembers its output path and images folder, so every command below needs only `--read`.

## Tool contract

```bash
T=~/.claude/skills/Presentation/Tools/Keynote.ts
bun $T --read <READ.md> --list                          # slide numbers, sections, types, art types, titles
bun $T --read <READ.md> --move 12 --to 4                # move talking point 12 to position 4 (rewrites READ.md, keeps a .bak)
bun $T --read <READ.md> --set 17 title "<new title>"    # exact edit, no model: title|sub|bullets ("a|b|c")|image|art|kind|art-type
bun $T --read <READ.md> --set 17 art-type diagram       # make slide 17 a technical diagram
bun $T --read <READ.md> --redo-art 17,23                # clear those images so KeynoteArt draws them again
bun $T --read <READ.md> --section 9 --direction "…"     # model redesign of one talking point
bun $T --read <READ.md>                                 # rebuild; edited sections redesign themselves
bun $T --read <READ.md> --verify                        # notes read back == READ.md
```

### Intent to action

| Speaker says | Action |
|--------------|--------|
| "move this slide up here", "put the X point before Y" | `--list` to find the talking point numbers, `--move N --to M`, rebuild |
| "reprocess this, I changed the file", "here's the new talk file" | write the file to READ.md if it came inline, then rebuild; report which sections were redesigned |
| "change the title of slide N to …", "drop that bullet" | when slide N is the first slide of a talking point with a heading, edit that heading in READ.md; otherwise `--set N title …`. `--set N bullets "a\|b"` for bullets. Rebuild |
| "use this image on slide N" | copy the image into the images folder, `--set N image <file>`, rebuild |
| "show the real film here", "find footage of X", "use a photo of Y" | `--set N art-type media` and `--set N art "<the footage, the moment>"`, then `MediaSourcing.md`, rebuild |
| "make slide N a diagram", "slide N should explain the loop" | `--set N art-type diagram` and `--set N art "<components, connections, insight>"`, then KeynoteArt for that slide, rebuild |
| "show slide M again here" (a deliberate callback) | `--set N image <slide M's image>` and `--set N reprise yes`, rebuild |
| "redo the art on slide N" | `--redo-art N`, then KeynoteArt `--only N`, rebuild |
| "different take on that point" | `--section <talking point> --direction "…"`, then KeynoteArt for any new briefs, rebuild |
