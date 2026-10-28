# Quality loop

Nothing this skill makes reaches the speaker as a first draft. Visual work goes through `Skill("ArtDirection")`: a direction round before new or large work, the critique panel (`skills/ArtDirection/Tools/Critique.ts`) scoring against its rubric, and iteration on the named defects until the bar or a reported shortfall. Record the speaker's verdict with `skills/ArtDirection/Tools/Calibrate.ts`.

Critique.ts judges images and video, never a deck file, so a deck is judged by its slides as images. Export them (`Keynote.ts --export <talk folder>/keynote-png`; for an HTML deck, screenshots of every slide in `<talk folder>/deck-png`). Then run `Critique.ts --image <first slide> --images '<that folder>/*.png' --brief <Brief.json with kind "slides"> --out <talk folder>`, which writes `Critique.json` beside the deck.

- **A Keynote deck** is handed over with `Deliver.ts --artifact "<talk folder>/<Talk>.key" --to <review folder>` after `Proof.ts run --artifact <first slide>`. Deliver accepts a `.key` package only on a passing `slides` critique whose scored slide still has its critiqued bytes, with no file in the deck newer than that slide. Edit the deck after export and it refuses until the slides are exported and critiqued again. It also refuses a destination that already holds a deck of that name.
- **An HTML deck** is served, not copied, so its hand-over is the URL once the critique passes.

