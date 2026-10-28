# Motion Design Philosophy — Authored, Not Templated

The seam README (`LIFEOS/TOOLS/HyperFrames/README.md`) is the mechanics: what breaks a render. This file is the taste: what separates motion someone designed from motion a template spat out. A composition can pass every seam check and still look generic — linear fades, everything sliding in from the left, text arriving on a metronome. That is the default-template look, and it is the thing to design against.

## What good motion looks like

A finished piece hits these, and you can point to where:

- **Nothing moves linearly that a physical object wouldn't.** Real things ease: they accelerate out of rest and settle into stop. Motion at constant velocity reads as machine-generated. Use a settling ease (`back.out`, `power3.out`, `elastic.out` sparingly) for anything that enters, lands, or reacts; reserve `ease: "none"` for genuinely mechanical motion (a progress bar, a clock hand, a continuous pan).
- **Every element enters for a reason and leaves for a reason.** An element appears because the narrative reached the moment it belongs to, and exits because that moment passed, not because a stagger timer fired. If you can't say why a thing arrives *now*, its timing isn't designed yet. With the meaning layer, the reason is written down: the Direction beat's rationale names the claim the element carries.
- **The eye is never asked to track two competing motions at once.** One focal movement per beat. When several things must change, stagger them so attention hands off cleanly, or move them as one grouped unit.
- **Type has a clear hierarchy and holds still long enough to read.** One dominant size, one supporting size, generous contrast between them. Text holds for as long as its length takes to read, never a fixed duration, and is stationary while being read; motion happens on the way in and the way out, never during the read. Motion that cuts a line off mid-read is worse than no motion.
- **Transitions are motivated by the content.** A cut, a wipe, a match-move exists because the two moments relate that way: a zoom into a detail, a push that means "next," a dissolve that means "meanwhile." A transition chosen for decoration announces the template.
- **Timing has texture, not a grid.** Holds and moves vary. Everything landing on an even beat is the metronome tell. Let some things snap fast and others settle slow; the contrast is what makes it feel composed.

## The default-template look — what to design against

| Tell | Why it reads as template | The move instead |
|------|--------------------------|------------------|
| Linear fades and slides everywhere | Constant velocity is physically impossible; the eye reads it as automated | A settling ease for entrances and reactions; `power` curves for controlled moves |
| Everything enters from the same edge | Uniform direction = one rule applied to all elements | Motivate direction by layout and meaning; vary it |
| Text on a metronome | Even spacing between reveals is the stagger-timer signature | Vary hold lengths; time reveals to the narrative beat |
| Uniform full-saturation motion | No focal point; the eye has nowhere to rest | One focal movement per beat; subordinate the rest |
| Decorative transitions between unrelated shots | The transition carries no meaning | Cut plainly, or use a transition the content motivates |
| Flat, evenly-lit, centered everything | Composition defaulted rather than chosen | Use the theme's spacing and hierarchy; compose asymmetry on purpose |

## Easing and timing discipline

- **Settling eases for life, power curves for control, `none` for machines.** `LIFEOS_THEME.motion.eases` in `Tools/Theme.ts` is the starting vocabulary: `settle` and `bouncy` give natural entrance and overshoot, `enter`/`exit`/`control` give precise starts and ends without a bounce. Never leave an entrance on GSAP's default curve without choosing it.
- **Overlap, don't queue.** The next element begins its entrance while the previous one is still settling. Place tweens with timeline position parameters (`"<0.15"`, absolute seconds) rather than chaining each to the end of the last.
- **Anticipation and settle read as quality.** A tiny scale-down before a scale-up, a small overshoot before rest: these micro-moves are most of what makes motion feel crafted. `back.out` gives settle; anticipation you add deliberately.

## Typography in motion

- **Two sizes, strong contrast.** A dominant line and a supporting line, with real size separation. The theme's `title`/`subtitle`/`heading`/`body` scale exists so you pick from a designed ramp instead of guessing.
- **Weight and space carry hierarchy as much as size.** Before scaling text up, try more weight or more surrounding space.
- **Animate the container, keep the glyphs still.** Move, fade, or scale the block that holds the text; don't animate letterforms individually during a read. Per-letter motion is an accent for a single hero moment, not a default treatment.

## Visual consistency

Pull palette, spacing, and type scale from the theme (`Tools/Theme.ts`, emitted as CSS custom properties by `themeCss()`) rather than inventing per-piece values. A piece where every scene shares one spacing rhythm and one color logic reads as designed; one where each scene reinvents its own reads as assembled. Deviate deliberately and locally, never by accident.

## The test

Watch it once with the sound off and ask: *could a template have produced this?* If the fades are linear, the reveals are evenly spaced, everything slides from one edge, and the transitions mean nothing, it needs another pass. If the motion eases, the timing has texture, one thing leads the eye per beat, and every entrance and transition has a reason, it was designed.
