# AnimatedEssay.ts

Turns a finished Essay still into a looping GIF that draws itself on in charcoal, then washes into colour. Nothing is generated; the still is revealed.

## Commands

```bash
bun ~/.claude/skills/Art/Tools/AnimatedEssay.ts build --image <still.png> --dir <project> [--ground #F5F5F0] [--draw 3.2] [--hold 3.5] [--force]
bun ~/.claude/skills/Art/Tools/AnimatedEssay.ts gif   --dir <project> [--name <slug>] [--width 1280] [--fps 15]
```

- `build` takes `--ground #rrggbb`, the destination paper (default: sampled from the still). It writes `index.html` (a seam-contract composition at 1920 wide), `still.png` and `gray.png` (the charcoal layer, its paper matched to the still's ground), and `essay.json`, which records the ground colour, the ink and colour centres, the stroke count, and `duration` and `holdStart`. It also stages GSAP.
- `gif` renders `Out/<slug>.mp4` through the HyperFrames seam, then writes `Out/<slug>.gif` with a full-frame 256-colour palette and `Out/<slug>-poster.png` showing the complete image.

| Flag | Meaning |
|---|---|
| `--draw` | Seconds the charcoal takes to draw on (1.5–8, default 3.2) |
| `--hold` | Seconds the complete image holds before the loop fade (1.5–15, default 3.5) |
| `--width` | GIF width: 1600 for a full slide, 1280 for a split slide or blog header |

Exit: 0 done, 1 refused or failed, 2 usage error.

## Timeline

The charcoal hatch strokes draw on from the ink-weighted centre outward. The colour blooms in through a soft circle grown from the colour-weighted centre over 1.6 s. The image then holds, and finally fades over 0.7 s back to a faint charcoal underdrawing (opacity 0.15), which also shows in the first frame.
