# AnimatedEssay Intent

**An Essay illustration that draws itself on in charcoal, then washes into colour, as a looping GIF.**

## Ideal State

- **The picture draws itself in the order the eye reads it.** The charcoal comes first, starting at the subject and spreading to the surroundings. The colour washes bloom in after the drawing, from the picture's colour centre.
- **It is the same picture.** The held frame is the original still: nothing added, cropped, recoloured or lost. The paper during the drawing is the page's exact paper, with no pale patch around the strokes.
- **It opens on the finished picture and loops cleanly.** Frame 0 is the complete still, because a GIF's first frame is its face in Keynote edit view, exports, PDFs and link previews. It holds for at least 3 s, fades to a faint charcoal underdrawing of itself, and the drawing and colour come back up to the opening frame.
- **It is shippable as a GIF.** It is 1600 px wide for a full slide or 1280 px for a split slide or blog header, about 9 MB measured at 1600 px (2026-10-01), with a poster PNG beside it.
- **It passed the quality loop on the GIF itself** and was delivered through `Deliver.ts`.

## Anti-criteria

- Never animates a still that has not passed its own Essay intent and critique; motion makes a weak composition more visible, not less.
- Never makes the picture or repeats its meaning work (CSE, the Step 5A deliberation): this intent only reveals a still the Essay intent made.
- Never builds from a background-cut, transparent still: the reveal needs the paper, and a transparent still has no ground to draw on.

## Inputs

A finished Essay still that has already passed its own intent and critique. Use it when someone asks for an animated essay image, an animated header, or "make this illustration draw itself", and when a deck's art pass picks the few slides that should move.

## Safety gates

- A deck carries at most three animated essay slides; `Presentation/Tools/Keynote.ts` refuses a fourth. A blog post carries one at most, the header.
- Motion on every essay image stops being noticed, so spend the three where motion lands the point: the opening image, the thesis, the close. Animated technical diagrams (TechnicalDiagrams § Animated Option) are not counted against this limit. In a Lecture Keynote deck every GIF starts by itself on slide entry; the build sets it.

## Tool contract

```bash
AE=~/.claude/skills/Art/Tools/AnimatedEssay.ts          # contract: Tools/AnimatedEssay.help.md
HF=~/.claude/LIFEOS/TOOLS/HyperFrames/HyperFrames.ts
P=${LIFEOS_HYPERFRAMES_DIR:-$HOME/HyperFrames}/<slug>   # outside every git repo

bun $AE build --image <essay-still.png> --dir $P --ground "#F5F5F0" [--draw 3.2] [--hold 3.5] [--force]   # --ground = the page or slide paper
bun $HF snapshot --project $P --at 1.6,3.0,4.2,<holdStart+1> --out-dir $P/Stills   # look at the reveal before rendering
bun $AE gif --dir $P [--width 1600] [--fps 15]          # Out/<slug>.gif, -poster.png, .mp4
```

### Quality loop and delivery

```bash
ART=~/.claude/skills/ArtDirection/Tools
bun $ART/Critique.ts --video $P/Out/<slug>.gif --brief <Brief.json>
bun ~/.claude/skills/Assay/Tools/Proof.ts run --artifact $P/Out/<slug>.gif
bun $ART/Deliver.ts --artifact $P/Out/<slug>.gif --to "${LIFEOS_DOWNLOADS_DIR:-$HOME/Downloads}"
```

Reuse the still's Essay brief and add one line: frames before the hold show a partial drawing on purpose. Without that line the panel scores every mid-reveal frame as unfinished.

## Gotchas

- **The reveal reads the still's pixels on a 48×27 grid.** A picture whose subject is a few thin lines in a large empty field reveals as a few scattered strokes. That is the right result: such a picture has little to draw.
- **GIF size is set by texture, not length.** Charcoal hatching dithers into many unique pixels. If a GIF runs past about 10 MB, lower `--width` before `--fps`, since the hold frames cost almost nothing.
- **Pass the destination's paper as `--ground`.** Without it the tool samples the still's paper, which can sit a few levels off the slide's ground; `gif` pins that colour into the palette, so it must be the slide's.
