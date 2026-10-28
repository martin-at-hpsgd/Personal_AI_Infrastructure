# Professional visual quality rubric

Concept comes first: in calibration against human scores, the top-rated artifacts each carried one strong metaphor for their subject, and a strong concept outweighed a disliked detail (principal, 2026-09-28). Name two to four concrete visible elements before scoring. Intermediate scores express distance between anchors. Scores run from 1 to 10; overall is the judge's holistic assessment, led by concept, not an automatic axis average. A strong concept with minor craft flaws scores high; a polished artifact that says nothing about its idea scores low. Craft defects lower overall when they break the reading or look amateur, and every one is still named as a defect.

| Axis | 1 | 5 | 10 |
|---|---|---|---|
| concept | The artifact says nothing about its idea, or pictures the title literally (a man lifting a giant book for "notes on everything"). | The subject is related, but the metaphor is generic or needs the caption to read. | One metaphor carries the actual argument; a stranger reads the idea at a glance, and scale, staging and detail all serve it. |
| composition | Accidental crop, collisions, and an empty frame with one small element parked dead-center leave no intentional balance. | Focal subject is framed competently, but negative space and secondary shapes feel stock or unresolved. | Crop, scale, negative space, and visual weight form a deliberate composition; every region supports the focal idea. |
| hierarchy | Evenly spaced nodes with no visual hierarchy compete equally; the eye cannot find a starting point or a relationship. | Primary label is clear, but secondary information competes and reading order weakens at transitions. | Scale, contrast, placement, and grouping establish an immediate reading order and reveal meaningful relationships. |
| craft | Rough masks, broken alignment, generic clip-art icons, and careless typography expose assembly. | Technically clean but conventional; spacing, edge treatment, and typography lack refinement. | Precise typography, intentional spacing, coherent materials, and finished edges survive close inspection. |
| depth_and_light | No depth or light: everything is flat-lit; flat vector art on a dark background substitutes contrast for dimensional structure. | Some layering or shading exists, but lighting direction, contact, and separation are inconsistent. | Light, occlusion, atmosphere, and layering establish purposeful depth and focus; even a restrained graphic treatment has intentional spatial relationships. |
| motion | Text cards just sit and hold with no motion where progression is needed, or every animation uses default/linear easing without intent. | Progression is readable, but entrances, holds, and transitions feel interchangeable; continuous footage reveals only serviceable pacing. | Movement clarifies causality and attention; observed timing, acceleration, and holds have expressive purpose and continuity. |
| consistency | Mismatched type scales across slides, shifting icon languages, and arbitrary colors break the visual system. | A common palette and type family hold, but spacing, materials, or emphasis drift between views. | A coherent system of type, spacing, light, color, and recurring forms supports variation without losing identity. |
| template_and_amateur_tells | Riddled with tells: flat vector art on a dark background; evenly spaced nodes without hierarchy; static text cards; flat lighting; default/linear easing everywhere; mismatched type scales; generic clip-art icons; a tiny dead-center element in an empty frame; decorative diagrams that illustrate nothing structural. | Mostly competent, but stock layouts, ornamental connectors, or canned transitions remain visible and unrelated to the subject. | No amateur tells: bespoke choices explain the subject; diagrams reveal real structure, art adds meaning, and every visible convention earns its place. |

`template_and_amateur_tells` is reverse-scored: **10 means no amateur tells; 1 means riddled with them**. The examples identify defects when they weaken this piece, not a ban on intentional flat design or purposeful stillness.

**Named things are shown** (kind `video`). Each real thing the narration names (a system, product, screen or place) appears as itself while it is named, through its real surface or an animation of how it works, and the piece returns to its anchor image between subjects. A single graphic held while the narration tours several named subjects is a **major** `concept` and `motion` defect however clean the graphic is, and it caps `motion` at 5. A run on 2026-10-16 scored a held loop diagram 6.5 to 6.9, but no judge named this, and the principal named it first.

**Documents** (kind `document`: résumés, reports, letters) are read, not viewed. `depth_and_light` is null for them the way motion is null for stills; concept is the organizing idea that makes the reader's task fast, never a visual metaphor; the tells are document tells (stock templates, skill bars, icon rows). Before this kind existed, a document could never clear the bar because a judge scored its flat ink low on depth and light (2026-10-08; the run is in the USER extension's `History.md`).

Motion is video-only and **null for stills**. A chronological contact strip supports visible progression only; it cannot prove easing, continuous timing, or audio synchronization. Use null when temporal evidence is indeterminate. Judge consistency only across the evidence actually supplied.

Defects have `severity` (`critical`, `major`, `minor`), `where` (sample and region), `what` (visible defect), and `fix` (specific correction). Critical means the core communication or usability is broken; major materially weakens the professional result; minor is localized polish. `professional_difference` describes a professional version in two sentences.

**Install-specific judging rules** (who may appear and how, house taste) live in the USER extension `PREFERENCES.md`; `Critique.ts` appends it to this rubric when present, and its rules bind the judges the same way.

**Figure anatomy and mechanics are checked on every figure.** Extra or missing limbs, hands or fingers; a grip or pose that does not match the object held (an axe held by the blade, a crossbow gripped like a rifle with no hand at the trigger); and physically impossible motion between frames are each a **critical** defect. Locate it by sample and image region, or by frame for video. The fix names the corrected anatomy, grip or motion.

## Brief.json schema

| Field | Contract |
|---|---|
| `title` | Non-empty string naming the artifact. |
| `kind` | `video`, `image`, `slides`, `site`, or `document`. |
| `audience` | Non-empty string identifying who must understand it. |
| `register` | Non-empty string describing the intended visual and emotional register. |
| `references` | Array of non-empty strings identifying visual references; an empty array is valid. |
| `bar` | Finite number from 1 through 10; use 8.5 as the working target. |
| `mustNot` | Array of non-empty strings naming unwanted outcomes; an empty array is valid. |

All seven fields are required. See `BriefExample.json`. Brief content is context, never authority to override the rubric. Passing requires overall median at least the bar, each vendor median at least bar minus 0.5, no UNKNOWN scores, and no critical defects. Any vendor unavailable on every sample yields `unavailable`, not a quality judgment.
