# Storyboard.json

```json
{
  "bible": {
    "style": "one line: medium, paper, line, wash, light, and the accent rule tying each color to a meaning",
    "characters": {
      "<id>": { "name": "Display Name", "desc": "what a portraitist needs; age as an instruction about the face; what they must NOT carry", "key": "Name", "kind": "person" },
      "<id>": { "name": "the bead", "desc": "an object that must be recognizable in every shot", "key": "bead", "kind": "object" }
    },
    "places": {
      "<id>": { "name": "the kitchen", "desc": "layout, light, the details that identify it" }
    }
  },
  "shots": [
    { "beat": "b01", "prompt": "the painted frame for this paragraph", "refs": ["<character id>", "<place id>"], "motion": "push", "focus": { "x": 0.5, "y": 0.45 } }
  ]
}
```

- `characters` and `places` ids are lowercase snake or single words; `style` is reserved for the style plate.
- `key` is the word the lint looks for in prompts to require the ref. Default: the first capitalized word of `name` (possessive stripped), else the last word. Set it explicitly for "the boss", "Ana's mother", "the bead (X)".
- `kind`: `person` (default for characters; a three-view sheet), `object` (a three-distance sheet), `place` (default for places; an empty establishing view).
- `motion` ∈ `push | pull | pan-left | pan-right | tilt-up | tilt-down | hold`. `hold` still breathes (a tiny push) so the verifier's motion check passes; a true freeze is never rendered.
- `focus` is optional, unit coordinates from the top-left; the move keeps this point near the center.
- Exactly one shot per beat; `StoryboardLint.ts` refuses a missing or duplicated beat, an unknown ref or motion, a named character without its ref, a focus outside the unit square, and any prompt that asks for text (text, caption, title, lettering, words, logo, signature, watermark, label, headline, written). A phrase like "no text" inside the prompt is allowed but unnecessary: every image call appends the no-text instruction itself.
