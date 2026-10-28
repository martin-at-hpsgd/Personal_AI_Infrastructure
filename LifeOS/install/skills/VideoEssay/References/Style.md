# The video essay design system

**Contents:** Faces · Type roles · Colour · Frame and layout · Inserts · Diagrams · Reading camera · Motion · Chapter card · Badge · Thumbnail

A voice-mode video is the blog post come alive. The reading camera sits on the real post column, and every insert is another page of the same publication: the same sampled paper, the configured faces in fixed roles, no browser chrome and no decoration. The page-to-insert cut changes the ink, never the paper. Essay mode runs the same system on a flat dark ground.

`Tools/Theme.ts` is the source of truth. Every number and colour it exports is stated below, and `DesignAudit.ts --check style-doc` fails when one is missing. The faces and colours are the user's: `Config.json` `fonts` maps each face role to a font file and `colors` overrides any colour below (Setup.md § Faces and colours).

## Faces

Every face is embedded from the file `Config.json` `fonts` maps its id to. Nothing falls back to a system face, the badge included. Each id is its own embedded family under an internal role name; the three body-serif cuts share one family by weight and style. The page refuses to register its timeline unless every face is a loaded face in `document.fonts` with its exact family, weight and style, passes `document.fonts.check`, and measures a sample differently from both generic fallbacks (`Page.ts` `gateFonts`).

| Face id | What belongs there | Internal family | Weight / style |
|---|---|---|---|
| serif | body serif, regular | Essay Serif | 400 normal |
| serifBold | body serif, bold | Essay Serif | 700 normal |
| serifItalic | body serif, italic | Essay Serif | 400 italic |
| serifTabBold | body serif with tabular lining figures, bold | Essay Serif Tab | 700 normal |
| figures | display face for large figures, semibold | Essay Figures | 600 normal |
| sans | sans, regular | Essay Sans | 400 normal |
| sansTab | sans with tabular figures | Essay Sans Tab | 400 normal |
| caps | small-caps sans: lowercase source renders as small caps | Essay Small Caps | 400 normal |
| kicker | condensed all-caps face with tabular figures | Essay Caps Tab | 400 normal |
| kickerBold | condensed all-caps face, bold | Essay Caps | 700 normal |
| display | narrow all-caps display face for headings | Essay Caps Narrow | 400 normal |
| cite | condensed all-caps face for attributions | Essay Caps Condensed | 400 normal |
| quote | serif for quotations | Essay Quote | 400 normal |
| mono | monospace for code | Essay Mono | 400 normal |

The caps roles (`caps`, `kicker`, `kickerBold`, `display`, `cite`) expect caps faces: the composition lowercases source for the small-caps face and uppercases it for the all-caps faces (Type roles below). An ordinary face in those roles still renders, with the text in that case. Font files stay wherever you installed them. Setup validates the mapping and copies nothing; no font file is ever written into a git-tracked path.

## Type roles

Sizes are px at 1080p. Tracking is in em. A role marked lowercase or uppercase sets its source text in that case before the face draws it.

| Role | Face | Size | Leading | Tracking | Features, case | Used for |
|---|---|---|---|---|---|---|
| title | serifBold | 119 | 1.05 | 0 | lnum | title insert, chapter title (a two-line title steps down to 88 before it takes a third line) |
| subtitle | serifItalic | 56 | 1.25 | 0 | onum | title insert subtitle, secondary |
| heading | display | 72 | 1.1 | 0 | lowercase | points heading (the post's h2 role) |
| sentence | serif | 56 | 1.2 | 0 | onum | points, node labels, race lane labels |
| sentenceBold | serifBold | 56 | 1.2 | 0 | onum | diagram sources and sinks |
| claim | serif | 64 | 1.2 | 0 | onum | the stat claim |
| compareText | serif | 64 | 1.2 | 0 | onum | text compare columns |
| hero | figures | 340 | 0.9 | -0.01 | lnum tnum | the stat figure |
| figure | figures | 150 | 0.9 | 0 | lnum tnum | compare and race figures |
| tick | sansTab | 44 | 1 | 0 | tabular | data ticks, denominators, point numerals |
| kicker | kicker | 40 | 1.1 | 0.1 | uppercase | chapter kicker, compare labels, race ends, capture source |
| edge | caps | 44 | 1.05 | 0.05 | lowercase | diagram edge labels: the smallest size whose small-cap height (22 px) clears the label floor |
| quote | quote | 67 | 1.3 | 0 | onum | quote text, measure 1100–1400 |
| quoteSmall | quote | 56 | 1.3 | 0 | onum | a quote past four lines |
| quoteGlyph | quote | 119 | 1 | 0 | | the “ glyph, the frame's accent |
| cite | cite | 48 | 1.1 | 0 | lowercase | quote attribution |
| source | caps | 44 | 1.05 | 0.05 | lowercase | capture card domain |
| code | mono | 44 | 1.45 | 0 | | code, at most 60 columns |
| numeral | serifTabBold | 158 | 1 | 0 | lnum | chapter numeral, no leading zero |

The legibility floors: no insert text under 28 px, no stroke under 2 px. `DesignAudit.ts --check legibility` measures them on rendered frames.

## Colour

Voice mode sets its ink on the capture's own paper, sampled at build; `paper` is the ground when a run has no capture. Essay mode sets it on the flat dark `ground`. Dimmed elements go to solid `secondary`, never to alpha. A frame carries at most one accent element. Every text token is lifted to WCAG AA on the run's own ground (`readableOn`), so a darker capture paper never pulls the greys under 4.5:1.

The defaults below are `Theme.ts` `DEFAULT_PALETTE`; `Config.json` `colors` overrides any of them (`colors.paperInk.<token>`, `colors.darkInk.<token>`, and the three top-level keys).

| Token | Paper (voice) default | Dark (essay) default | Role |
|---|---|---|---|
| ground | sampled (`paper` `#F3F1EA` default) | `#0C0C0D` | the page and every insert |
| ink | `#1C1B19` | `#EDEDE8` | text, figures, shelves, ticks |
| secondary | `#6B6A63` | `#9E9E98` | kickers, labels, the dim state |
| muted | `#7A776C` | `#67675F` | the losing bar, unnamed lanes |
| rule | `#B9B8AB` | `#3B3B38` | tracks, hairlines, the capture border |
| connector | `#2A2824` | `#CFCFC9` | diagram curves and chevrons |
| accent | `#0F766E` | `#2DD4BF` | the one asserted element per frame |
| codeGround | paper darkened 4 L* | `#171717` | the code block |

The brand `accent` (default `#0D9488`) is the badge signal, the essay ring and its hairline, the progress line and the thumbnail border; Verify's presence check measures that colour. The read highlight is `highlight` (default `#FACC15`) at 0.3 opacity multiplied onto the paper, with a radius of 4 px and padding of 8 px across and 4 px down. A sentence's highlight is one shape of line boxes: consecutive lines meet at the middle of the gap between them, so boxes butt and never overlap, the 4 px padding holds on the outer edges, and only corners no neighbouring box continues are rounded. Highlighted code lines use the same tint. Code comments are `#8B949E`; everything else in a code block is ink, with no syntax colours.

## Frame and layout

- Frame 1920×1080. Graphics-safe box x 96, y 54, 1728 wide by 972 tall.
- Grid: 12 columns of 104 px with 40 px gutters, x 116 to 1804 (1688 px).
- Optical centre (960, 508). A settled block's glyph-tight ink box centres within ±38 px across and ±32 px down.
- Nothing reserves a column for the badge. The keep-out K is the badge box grown by 24 px to the frame's edge: x 1583, y 712, 337 by 368 in voice mode, read off the rendered badge in either mode. A block that meets K first rises by at most 32 px, never with its top above y 96; if it still meets K it re-lays with its right edge 24 px left of K (x 1559 in voice mode). Blocks never shift left to escape the badge.

Fill targets, measured on the settled ink box against the 1688 px grid and the 972 px safe height:

| Insert | Target |
|---|---|
| stat | figure cap height ≥ 0.21 of the frame; block height ≥ 0.45 |
| compare, numeric | width ≥ 0.9 |
| compare, text | width ≥ 0.85 |
| diagram | width ≥ 0.8 and height ≥ 0.4 |
| points | width or height ≥ 0.55 |
| quote | measure 1100 to 1400 px |
| title | width ≥ 0.55 |
| race | width ≥ 0.85 |
| code | width ≥ 0.6 |
| capture card | width ≥ 0.75 or height ≥ 0.8 |

Every type also meets the 55% width-or-height floor. Where the role sizes leave a sparse insert short of its target, the insert grows within a stated bound rather than float small: a short title grows up to 168 px, a sparse points list scales its type up to 1.4×, and a stat with no part-to-whole bar lets its figure grow up to 480 px.

## Inserts

- **stat.** One figure, centred, with the claim 40 px under it as one unit. A part-to-whole bar (1200 by 24, accent fill, ticks under it) is drawn only when the label or narration says "N of M". The figure's mask rises from the baseline on its word.
- **compare, numeric.** Two rows in spoken order on a shared zero baseline; the scale ends at 100 for percentages, otherwise at the larger value rounded up to a clean step. Both rows take one placement, the first that fits them both, so the figures read as a pair: figure beside the label, figure on the bar's line past its end, or figure on its own line over the bar's end. Every label sits 12 px over its own bar. The winner is accent, the loser muted. No difference bracket unless the narration states the difference.
- **compare, text.** Two columns, mirrored: the right column sets flush right, a 2 px rule in the gutter.
- **points.** At most five per state, a hanging numeral column 72 px left of the text, earlier items dimming to secondary when the voice moves on. No bullets.
- **quote.** The glyph, 24 px, the text, 40 px, the cite.
- **title.** Title and subtitle, centred, no accent, no rule.
- **race.** Labels right-aligned in x 116 to 516, 2 px tracks from x 556 to 1560, a lane every 120 px, at most 5 lanes. A 16 px dot travels each named lane in turn; gates are 2 by 32 ink ticks set across 0.92 of the track.
- **code.** Paper-ground block, 4 px radius, 48 px padding, no border or window furniture. Lines past 60 columns wrap under themselves.
- **capture card.** The capture flat at 1280 wide (76% of the grid) and at most 778 tall, a 2 px border, radius 4: the rule colour on paper, the muted ink on dark, where the rule would not show. The card's ground is the capture's own paper. At rest its text starts and ends on a paragraph boundary: the lines and pictures are read off the capture at build and grouped into paragraphs, a top edge that would cut a paragraph moves just above it (or, for a picture or a paragraph taller than the card, just below it), and the card is shortened to end just below the last paragraph it shows whole, padded by half the gap to the next (at most two x-heights). An edge fades over 48 px only when a single paragraph is taller than the card, and while the view moves both edges are 48 px fades. Its sides fade over the 32 px margin the text column is kept inside, so only what runs past the column (a wide nav row) meets a side. A page shown whole is shown at reading size: its body x-height 22 px, unless its text column would then run past the 32 px margins, in which case the column fits the card across (column, top and x-height are read off the capture's pixels at build). A zoom starts on the whole page and pushes once, over 900 ms, into its region, ending on the region and the text column together at the same reading size, never past 2.5 times the overview. The credit (kicker plus domain, tracked +6% and +5%, in secondary) sits flush with the card's left edge, 16 px under it.

## Diagrams

Layers by longest path, two barycentre sweeps, left to right. Columns are equal when every label fits them in three lines; otherwise each column takes the width its labels need and the slack is shared in proportion. Nodes are typographic: the label in the body serif at 56 px (bold for sources and sinks) over a 2 px shelf that runs the label's ink plus a 40 px tail (never past its column), 20 px under the last baseline (14 px cuts the descenders of a typical body serif). The sink's shelf turns 4 px accent when it arrives. Columns of two or more nodes spread from a 72 px gap up to 168 px until their ink is 410 px tall. Connectors are Béziers with controls at 0.45 of the run, leaving 14 px past the shelf, fanning ±12 px, arriving at ports 24 px apart, ending in 12 by 10 open chevrons 14 px short of the text. Edge labels are quieter than the nodes: the small-caps face at 44 px, +5%, secondary. One no wider than the 128 px gutter less 24 rides the line on a paper halo. A back edge's label sits 14 px under its run. Otherwise a label joins its target as one small-caps line 10 px above it, when it fits the column in one line and the target takes no more than two; any other label flies as a flag from a 2 px leader that rises out of its connector in the gutter before the target to a row above the graph (the first row 40 px over it). A graph with more than 4 nodes, more than 4 layers or any fit failure builds in states of at most 4 new nodes, each carrying the last state's new nodes as dimmed context moved by FLIP. A back edge runs 88 px under the graph.

## Reading camera

The post column is scaled so body text lands at up to 40 px on screen and the 1200 px column plus 64 px margins each side fits the safe width, then clipped to that column plus 64 px (`data-ve-post-clip`). The highlighted sentence stays in the band y 240 to 780; when the next one would leave it, the camera moves over 900 ms to put it at y 300. The camera never scrolls the post's last narrated line above y 780, so the closing paragraphs fill the frame down to the band's foot rather than rising into the top third over blank paper; a post whose narrated column ends above y 780 unscrolled is held with that column on the optical centre. The camera leads its sentence by 0.5 s so the move lands before the voice reaches it. The highlight is drawn inside the moving page, so it rides every camera move with its words. It slides between neighbouring sentences (the new first line within 2.5 line heights of the old last line) over 367 ms; a sentence farther down (past a quote, figure or heading) takes the highlight at once, so it never sweeps across the lines between while the camera moves. It is drawn only while its line is wholly on screen. Three paper edges lie over the page. At the top, paper is solid to y 16 and clear by y 110, so a line the camera carries off the top recedes rather than being sliced. At the foot, a full-width band fades in from y 990 and is solid from y 1060 down, so no page ink runs behind the badge's lower edge; the 1200 px column stays clear of the badge (x 1607) so the page can run down beside it. The page itself fades to paper over 24 px below its last narrated line (over 48 px when the capture ends sooner), so the notes and footer beyond the clip never show as a half line.

## Motion

Every value is a pure function of the frame, so any frame seeks to the same picture. Times snap to 30 fps frames.

| Move | Curve | Time |
|---|---|---|
| enter (block / text line) | cubic-bezier(0.22, 1, 0.36, 1) | 433 ms / 333 ms, rising 24 px |
| exit | cubic-bezier(0.4, 0, 1, 1) | 233 ms, falling 12 px |
| draw (connectors, bars, fills, rules) | cubic-bezier(0.65, 0, 0.35, 1) | 1.6 px/ms, 400–800 ms; bars 600 ms |
| camera, zoom, FLIP | cubic-bezier(0.65, 0, 0.35, 1) | 900 ms; FLIP 700 ms |
| highlight slide | cubic-bezier(0.45, 0, 0.2, 1) | 367 ms |
| dim | linear to solid secondary | 300 ms |
| hero figure mask | enter curve | 467 ms |
| race dot | draw curve | 2.4 px/ms, 350–900 ms |

Nothing starts more than 4 frames before its word. Unnamed list items stagger 90 ms. A settled insert holds until its last referring word plus the larger of 0.6 s per word on screen and 2 s, plus 1 s per multi-digit figure, then the page returns by ink swap: 233 ms out, 4 frames of bare paper (the exit's faded last frame counted), 333 ms back. Where no page can return (essay mode, or a chapter card next), an insert holds through its cut until the next ink is due, so no frame is bare beyond a swap's four. No insert starts in the last 5 s.

## Chapter card

Centred on x 960 and y 508: the "chapter" kicker, 24 px, the numeral, 40 px, the title, 56 px, the chapter ruler. The ruler is a 2 px hairline from x 480 to 1440 with a 2 by 20 tick at each chapter's real start and the current chapter redrawn as a 4 px accent segment (never under 8 px wide). Timing: kicker and numeral at 0, the ruler draws from 0.2 s over 0.6 s, title lines at 0.5 s staggered 0.08 s, the accent at 0.8 s over 0.4 s, exit at 2.8 s, or later when the beat's insert is not due yet, so the card leaves just in time for the four bare frames before it. The card runs 3.03 s rather than 2.6 s: 2.6 s leaves only 1.2 s of hold after the last build, under its own 1.6 s minimum.

## Badge

The geometry is fixed. Every design draws in a 360 by 400 space scaled by 0.78 into the box x 1607, y 736, 281 by 312, anchored at the frame's bottom-right. The highlighted sentence keeps 28 px of air above the badge's top edge. `Verify.ts` crops the signal rects below; `PagePresence.ts` paints from the same numbers.

| Variant | Ground | Signal (x, y, w, h) | Credit band (x, y, w, h) |
|---|---|---|---|
| a | light | 30, 280, 300, 40 | 30, 326, 300, 48 |
| b | dark | 312, 70, 36, 164 | 12, 244, 336, 48 |
| c | light | 46, 226, 268, 34 | 30, 322, 300, 48 |
| d | light | 30, 296, 300, 30 | 16, 334, 328, 48 |
| e | light | 22, 294, 312, 38 | 18, 342, 316, 48 |
| d-dark | dark | 30, 296, 300, 30 | 16, 334, 328, 48 |

A clone run's credit is the plain label "AI VOICE CLONE" in the design's credit band (3 × 16 px tall), with no vendor name and no logo: narration is synthesized on Fish Audio, and the credit must never name a vendor that did not make the voice. Every design prints the badge copy from `Config.json` `badge` (defaults in `Theme.ts` `DEFAULT_BADGE_COPY`): `wordsLine` with the label in place of `{LABEL}` ("ALEX'S OWN WORDS"), and the claim `andNot` plus `struck`, the struck text crossed out by a red rule. A line longer than its design's band steps down in size until it fits; each line holds at most 24 characters. The strike tile (d, d-dark) sets its words in the condensed caps faces: the header band (`header`, default "VIDEO ESSAY") and the headline in `kickerBold`, `andNot` in `kicker`, `struck` in `kickerBold` struck by a 4 px red rule, the credit in the small-caps face fitted to its band. Waveform bars are 2 px. No drop shadow; a 1 px hairline outlines the tile. Essay mode's presence is the avatar in a flat 2 px accent ring with nine bars on a solid scrim; its label is set in the small-caps face at 22 px, +8%, in secondary, joined to the ring by a 28 px accent hairline. No glows or shadows.

## Thumbnail

A 28 px accent border, the title one word per line in the bold condensed caps face (`kickerBold`) sized so its longest line fills about 52% of the width (light lines, then accent lines), the DA avatar bleeding off the right over its accent glow, the label pill in the small-caps face, on the dark palette's ground. The thumbnail keeps its glow: it is a separate artifact from the video, and the no-glow rule is written for frames.
