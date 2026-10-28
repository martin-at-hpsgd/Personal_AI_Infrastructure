---
provenance: template
version: 1.0.0
---

# Art preferences

> Loaded by the Art skill before any image intent (`skills/Art/SKILL.md` § Data & Config) and by the HyperFrames skill before composing video (`skills/HyperFrames/SKILL.md` § Data & Config). No tool parses this file; it is read as prose. Every section is optional. The model and output values are the shipped defaults. Code-read settings live in the JSON files beside this one: `ArtConfig.json` (thumbnail ground, signature face, contract overrides; read by `Generate.ts` and `EvalRound.ts`), `DiagramTheme.json` and `DiagramFonts.json` (read by `AnimatedDiagram.ts`).

## Default model

`skills/Art/Tools/Generate.ts` accepts `flux`, `nano-banana`, or `nano-banana-pro`. The skill uses this value when an intent does not name one (`SKILL.md` § Tool contract, `skills/Art/References/Models.md`).

- Default model: `nano-banana-pro`
- Size convention: `1K` / `2K` / `4K` for `nano-banana-pro`; aspect ratios such as `16:9` for `flux` and `nano-banana`

## Output location

Generated images land in `LIFEOS_DOWNLOADS_DIR` when that environment variable is set, otherwise `~/Downloads` (`DEFAULTS.output` in `Generate.ts`). Record any different staging directory here so intents write there.

- Output directory: `~/Downloads`
- Editorial and blog-header images carry the {{DA_NAME}} signature stamp, bottom-right (auto-on for the Essay intent, `--no-signature` opts out)

## Core aesthetic

The look every intent starts from unless the request names another style (`SKILL.md` § Ideal State). Describe it in your own words; the skill folds these sentences into its prompts.

- Visual style and influences: production-quality concept art for editorial and technical content; name two or three artists or studios you want it to feel like
- Line treatment and rendering: gestural, confident linework; sketch feel over polish
- Color palette and wash technique: dark grounds with one accent color and cool atmospheric washes
- Primary accent and paper ground: set under § Color palette
- Scale and composition: human-scale figures inside vast spaces

The HyperFrames skill reads these as prose before composing. Its machine-read theme is `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/HyperFrames/Theme.json` (a partial theme over its neutral defaults, see that skill's Setup.md); set the same accent and ground there so video matches your images. No shipped code needs editing.

## Color palette

The intents name colour by role. Set each role here; prompts use these values when the section exists, otherwise each intent's default palette applies. Put the same values in `DiagramTheme.json` for animated diagrams and the page ground in `ArtConfig.json` `thumbnailGround`.

- Primary accent (key components, insights, emphasis): Example Indigo `#2B4C7E`
- Secondary accent (flows, supporting elements): Example Green `#3A7D44`
- Warm wash (human or warm elements in painted intents): `#A0522D`
- Text and lines: Charcoal `#2D2D2D`
- Diagram ground (technical diagrams): `#F5F5F0`
- Blog page ground (inline images composite over it; thumbnails flatten onto it): `#F5F5F0`

## Character design

Recurring characters and how they must be drawn (age, build, clothing, palette, what never changes between images). Move this into `CharacterSpecs.md` in this directory if it grows past a few lines (`SKILL.md` § Data & Config).

- (none yet)
- Figure treatment sentence (optional): one sentence every prompt with people carries verbatim, e.g. "the figures are a varied cast of adults in work clothes, each one's skin tone, age and build named". Without it the skill default applies (a varied cast whose appearance each prompt names).
- Casting rules (optional): roles figures may or may not hold, e.g. "figures of different appearance never stand in a guard-vs-intruder pairing".
- Figure-study references (the Essay round fix table names these when figures come out flat or the image looks like generic AI art): two or three artists whose figure sketches you want, e.g. "like Example Studio concept sketches"; stroke density, e.g. "many overlapping strokes per figure".

## Figure style

Read by the Comics, Comparisons and Frameworks intents; replaces their neutral default (simplified, stylized editorial figures with adult proportions, minimal faces, emotion through gesture and silhouette).

- Figure construction (optional): how bodies and faces are built, e.g. "figures built from simple geometric shapes, adult proportions, minimal faces".
- Influences (optional): two or three artists or movements the figures should recall, e.g. "Example Studio editorial figures".
- Illustrator reference for diagrams that look corporate (optional), e.g. "Example Illustrator style".

## Scene composition

Rules for staging a scene: camera height, depth layers, where the subject sits in the frame, what a background may and may not contain. Move this into `SceneConstruction.md` if it grows (`SKILL.md` § Data & Config).

- (none yet)

## Typography

The intents name type by role. Name your face for each role; prompts use these names when the section exists. Font files for the animated-diagram tool go in `DiagramFonts.json` next to this file (roles `title`, `subtitle`, `label`, `insight`, `signature`, each `{ "path": "...", "weight": 400 }`).

| Role | Face |
|------|------|
| Title and subtitle (wedge serif, italic + regular) | Example Serif |
| Labels and category headers (geometric sans) | Example Sans |
| Insights and annotations (condensed italic) | Example Condensed |
| Hand-lettered display titles, quotes, big numbers | Example Display |

## Signature

- Signature face for essay headers: the macOS `SignPainter-HouseScript` default, or name your own
- Faces rejected for the signature: (none yet)

## Wallpaper

Read by the LogoWallpaper and EmbossedLogoWallpaper intents; every line replaces their neutral default (amber, copper and ice white on a warm near-black, no apply command).

- Aesthetic: dark geometric patterns with soft depth
- Taste references (optional): films, shows or artists the wallpaper atmosphere should recall, e.g. "Example Film cyberpunk atmosphere"
- Bright palette: Example Gold `#D4A017` (main lines), Example Slate `#5E6B7A` (accents), Example Ivory `#EDE6D6` (highlights); background `#101012`
- Muted palette: `#9C7A1E`, `#4A545F`, `#B8B2A4` on `#101012`
- Off-palette hues to forbid by name in prompts: (none yet)
- Mark: a one-line description of your logo's topology (which strokes are open, which elements are separate)
- Terminal tint: the background opacity your terminal applies, for example 0.85
- Apply command: a command that sets the wallpaper, called as `<command> <output-name>`; leave empty to have the path reported instead

## Vendors

Which image vendors this install allows. `Generate.ts` ships Google (`nano-banana-pro`, `nano-banana`) and Flux on Replicate.

- Allowed image vendors: Google, Replicate (Flux)

## Reference images

`Generate.ts` accepts up to 14 reference images per request (`--reference-image`, Nano Banana Pro only). List where yours live so intents can load them (`skills/Art/References/Models.md` § Reference images).

- Reference image locations: `~/Pictures/art-references/`
- Style examples by use case: blog header → `headers/`, framework diagram → `frameworks/`, comic → `comics/`
- Character and scene reference guidance: which files to attach when a recurring character or location appears

## Brand assets

Logo, wordmark, favicon, and social image live in `brand/` next to this file. See `brand/README.md` for the expected files.
