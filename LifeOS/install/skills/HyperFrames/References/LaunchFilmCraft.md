# Launch Film Craft

What the code-built launch films people are praising have in common, measured and watched shot by shot (September 2026, five films, 15–157 s, all built by a frontier model writing HTML/JS/Canvas animation that a browser captured and ffmpeg encoded). No video-generation model is involved in any of them. The principal's own reference pack, with links and per-film numbers, is in the customization directory (`LaunchFilmReferences.md`).

## The shape

- **Short.** 15–46 s for a product launch. Past a minute it is an essay or a music video, and it has to earn that with a much denser picture.
- **Music drives the edit, not a voice.** None of the five has a voiceover. Every visual change lands on a kick, snare or synth hit, and each on-screen action has its own sound: clicks, typewriter clacks, whooshes on camera moves, sub-bass hits on hard cuts, a ding on the final number. The copy lives in on-screen type.
- **The picture changes every 1–3 s.** Four of five change picture 3–9 times per 10 s; the slowest, a 46 s product walkthrough, still changes every 5 s. A held frame is never still: it keeps a slow 5–10% push, a counter ticking, or a grid drifting.
- **One idea per card, 1–6 words.** Longer text is either a UI prop you are not meant to read, or micro-copy.

## The look

- **Type is the hero.** Headline words fill 50–80% of the frame width, often bleeding off the edge, in a heavy or condensed sans. Next to them sits 10–12 px monospace micro-copy: scene numbers, timecode, frame counters, coordinates in the frame corners. The size contrast between the two is what reads as designed.
- **Two or three colours plus one saturated accent.** Cream, black and red-orange; black, white and yellow; white, navy and one electric blue. Flat backgrounds. The accent marks the one thing to look at.
- **Contrast is high and the world changes.** Backgrounds flip light to dark between scenes, and the brightest frame is near white. A whole film in one dim colour at one depth reads as a single long shot, however well each frame is made.
- **In the kinetic-type films the product is rebuilt, not screen-recorded.** They rebuild the UI as separate components (a chat bubble, a card, a slider, a chart) on an empty field, so each one animates on its own, and show one component at a time, large. Never a full page, and never a scrolling screen. Our films do not rebuild the product: four rebuilt-UI films were rejected on 2026-09-29, so every product shot is a real capture used as a plate, with only a control that has to move rebuilt (§ "When the product is the point" below, and `Intents/LaunchVideo.md` Ideal State).
- **The core idea becomes a picture.** The best films draw the product's claim as a visual system and then flip it. For example, a grid of mostly empty squares at 31% fills to 94%, a giant word gets struck through, or a scattered word snaps together. That flip is the reveal.

## Motion techniques that read as expensive

Each of these is a few lines of GSAP or CSS:

- Masked vertical reveals. Text rises from behind an `overflow: hidden` edge; there are no opacity fades on headlines.
- `expo.out` for entrances, `expo.inOut` for camera moves, `elastic`/`back` overshoot only for physical objects, and 0.04–0.05 s staggers across groups.
- Match cuts on a persistent object. A dot, a word or a card holds its screen position while everything around it changes, so the cut hides inside continuous motion.
- Camera pushes through a letter's counter or a UI element into the next scene.
- Monospace tabular numbers for counters, so digits never jitter. Split-flap or rolling-digit changes add to the effect.
- A leading spark or dot pinned to the tip of a stroke as a line or graph draws.
- Fill-to-outline toggles on big type, which add variety without new assets.
- Animated grain over everything, reseeded every frame, which stops flat colour looking digital. Seed it from the frame number, because the seam refuses unseeded randomness.
- Velocity-matched motion blur on fast objects, and a few frames of anticipation before a fast move.

## When the product is the point: the real-product film

Kinetic type sells a mood. A product launch also has to show the product doing its job, and it has to show the *real* product. The strongest code-built product films work like a Screen Studio recording.

- **The whole film stays inside one continuous session of the real app.** A soft gradient ground sits behind the app window. The camera zooms in on the input, pans to the result, and pulls back. There are no slide-deck cuts between disconnected scenes.
- **The real UI is the plate.** Use real screenshots of the product, captured at 2x, as the base layer. Rebuild only the one component that has to move, match it pixel for pixel against the screenshot, and place it at the measured position. A full HTML rebuild of the whole app drifts from the real thing and reads as a mockup.
- **Declutter for a viewer with a short attention span.** Remove toolbars and side chrome that don't serve the beat, shorten any typed query, and zoom until the text is large.
- **The product does the thing, one step at a time.** A query types out, a loading state appears, results pop in one by one with real logos and pictures, and the camera moves to the result. Proof is visual (a bar chart, a before/after), never a bare number.
- **Big centred statements are rare and earned.** For example: "No subscription", a pause, "No contract", then a zoom out to the detail.

HeyGen's own `product-launch-video` skill (`github.com/heygen-com/hyperframes`, its `product-launch-video` skill directory) builds these films as a pipeline with a human gate at each layer: a text storyboard with shot, caption and purpose; static HTML wireframe frames reviewed as a grid, with feedback pinned per frame and applied in one batch; animation scene by scene, one worker per scene from a shared design spec and exact numeric handoffs at every cut; and snapshots compared on both sides of every cut before render. It also covers capture, a design system from a preset and transitions. We do not take its per-scene workers: one author holds the whole film (below, and `Intents/LaunchVideo.md` Anti-criteria).

## How they were made

- **The real brief is long.** "One prompt" is the marketing line. The strong films came from a brief that named the product, its assets, a style the author already liked (reference frames, a named film), the music, and an order to keep iterating until it stops looking cheap.
- **One author holds the whole film.** A single agent built each film as one composition. Its authors describe the process as the agent gathering references, then iterating on its own renders. None of them split the film into parallel segments.
- **Style is pointed at, not described.** The author who got the best result the second time did it by pointing at a specific style they liked.
