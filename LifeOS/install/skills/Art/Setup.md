# Art

Status: bun ~/.claude/LIFEOS/TOOLS/Secrets.ts has GOOGLE_API_KEY · required

## What it does

Art makes static images (blog headers, diagrams, infographics, comics, icons, wallpapers) by sending a prompt built from one of its named intents to an image model. The default model is Nano Banana Pro on the Google Gemini API; `flux` and `nano-banana` run on Replicate. The animated-diagram tool draws strokes from a spec and renders them through the HyperFrames video skill, with no image model and no key; it needs HyperFrames working, so set that up first if you want GIFs. Finished images are checked and handed over through the ArtDirection skill, which has its own setup guide.

## Fill in

Three things on your machine, then the optional config files under `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/` (the installer puts a starter for each there; if one is missing, `bun ~/.claude/skills/LifeOS/Tools/ScaffoldUser.ts --apply` copies any missing starter file into place and never overwrites one you have edited).

1. Install the tool's dependencies, declared in `skills/Art/Tools/package.json` (image generation uses `@google/genai` and `replicate`):

```bash
cd ~/.claude/skills/Art/Tools && bun install
```

2. For blog headers (`--thumbnail`) and background removal (`--remove-bg`), install `rembg`. `Generate.ts` looks for it at `~/.local/bin/rembg`, or at the path in the `REMBG_BIN` environment variable:

```bash
pipx install rembg
```

3. For the signature stamp on essay headers and for `CutHero.ts`, install ImageMagick so the `magick` command exists (`CutHero.ts` looks at `/opt/homebrew/bin/magick`, or at `MAGICK_BIN`). The signature font, SignPainter, ships with macOS.

Optional: a `PREFERENCES.md` at `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/` (starter installed with the others) sets your house style. Its sections, all optional:

- **Default model** and **Output location**: the model an intent uses when it names none, and where images are staged.
- **Core aesthetic** and **Color palette**: your look, influences, primary and secondary accent hex values and paper ground; they replace the intents' default palette.
- **Typography**: your font for each type role the intents name (wedge-serif title and subtitle, geometric-sans labels, condensed-italic insights, hand-lettered display); prompts name these faces. Font files for the animated-diagram tool go in `DiagramFonts.json` (below).
- **Character design**: how people in images are drawn; replaces the skill's default figure treatment (a varied cast whose appearance each prompt names). Optional keys: recurring characters, a figure treatment sentence every prompt with people carries verbatim, casting rules, and figure-study references with a stroke density for the Essay round fixes.
- **Figure style**: how figures in comics, comparisons and frameworks are built (construction, influences, an illustrator reference for diagrams that look corporate); replaces those intents' default of simplified, stylized editorial figures.
- **Scene composition**: staging rules (camera height, depth layers, where the subject sits, what a background may hold); move them into `SceneConstruction.md` when they grow.
- **Signature**: the signature face and any faces you reject for it.
- **Wallpaper**: the LogoWallpaper and EmbossedLogoWallpaper look: aesthetic, bright and muted palettes, off-palette hues to forbid, taste references for the atmosphere, a description of your mark, your terminal background tint, and the command that applies a wallpaper (`<command> <output-name>`; without one the intents report the saved path).
- **Vendors**: which image vendors this install allows.
- **Reference images**: where your style references live.
- **Brand assets**: your logo, wordmark, favicon and social image, kept in `brand/` beside the file (see `brand/README.md`); the wallpaper intents and any brand-bearing run load them from there.

Without it the skill uses a production-quality editorial look.

Optional: `DiagramFonts.json`, read by `Tools/AnimatedDiagram.ts`. One entry per type role, every role optional: `title` (the diagram title, usually a serif italic), `subtitle` (the line under it), `label` (node and edge labels), `insight` (the 1-3 callouts) and `signature` (the DA-name stamp). Each role takes `path` (a font file; `~` expands; a `.ttc` collection must be extracted to one face first), `weight` (default 400) and `style` (`normal` or `italic`, default `normal`). A missing role uses a generic family; a configured file that does not exist fails the build by name. The template points at macOS system faces (Georgia, Verdana, Arial Narrow); replace them with yours.

```json
{ "title": { "path": "~/Library/Fonts/ExampleSerif-Italic.otf", "style": "italic" }, "label": { "path": "~/Library/Fonts/ExampleSans-Bold.otf", "weight": 700 } }
```

Optional: `DiagramTheme.json`, read by `Tools/AnimatedDiagram.ts`: the animated-diagram palette, any of `ground`, `ink`, `charcoal`, `purple` (primary accent tone), `teal` (secondary accent tone), `paper` (box fill), `purpleFill`, `tealFill`, `signature`, each `#rrggbb` or `rgb()`/`rgba()`, with `ground` opaque (alpha 1 or none). Without it the shipped neutral palette applies; an unknown key or a non-colour fails the build naming the file and key.

Optional: `ArtConfig.json`, read by `Tools/Generate.ts` and `Tools/EvalRound.ts`:

- `thumbnailGround`: the `#RRGGBB` page ground that `--thumbnail` listing thumbnails and transparent eval candidates are flattened onto (default `#F5F5F0`).
- `signature`: `fontFile`, `fontName` and `fill` for the DA-name stamp (default the macOS SignPainter face in semi-transparent charcoal).
- `contractOverrides`: per intent, `mandates` (regexes a prompt must match, replacing the intent's) and `bans` (regexes added to its bans), e.g. your own palette words for Essay.
- `variants`: named `contractOverrides` sets layered on top with `--variant <name>`.

Without it the shipped defaults apply; with it, a missing key uses the default and prints a warning naming the file and key.

## Accounts and secrets

Add these to `~/.claude/.env`:

| Name | Needed for | Account to open |
|---|---|---|
| `GOOGLE_API_KEY` | `nano-banana-pro`, the default model | A Google AI Studio account (aistudio.google.com), with an API key |
| `REPLICATE_API_TOKEN` | the `flux` and `nano-banana` models only | A Replicate account (replicate.com), with an API token |

`REPLICATE_API_TOKEN` is optional if you only use the default model. After editing `.env`, run `bun ~/.claude/LIFEOS/TOOLS/Secrets.ts seal`.

## Prove it works

```bash
bun ~/.claude/LIFEOS/TOOLS/Secrets.ts has GOOGLE_API_KEY REPLICATE_API_TOKEN
bun ~/.claude/skills/Art/Tools/Generate.ts --help
bun ~/.claude/skills/Art/Tools/Generate.ts --intent=Visualize --dry-run --model nano-banana-pro --prompt "Three boxes joined by arrows" --size 2K --aspect-ratio 16:9 --output "$TMPDIR/art-check.png"
command -v rembg magick
```

Success: the first command prints `yes` for `GOOGLE_API_KEY` (and for `REPLICATE_API_TOKEN` if you use flux). The second prints the usage text. The third prints `DRY RUN: argument/intent validation passed` and exits 0 without loading a key or calling an API. The last prints a path for each binary you installed in steps 2 and 3; a missing line means that feature will fail with an install message.
