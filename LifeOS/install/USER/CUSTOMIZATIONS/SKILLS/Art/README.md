---
provenance: template
version: 1.0.0
---

# Art — USER customizations

The Art skill checks this directory before every intent (`skills/Art/SKILL.md` § Data & Config) and applies what it finds over its defaults. The Markdown files are read as prose by the skill and its callers; the three JSON files are parsed by the skill's tools, and a bad key or value in one fails the run naming the file and key.

| Path | Read by | Shipped as |
|------|---------|------------|
| `PREFERENCES.md` | `Art/SKILL.md` § Data & Config, § Ideal State, § Tool contract and § Gotchas (aesthetic, typography, palette, figure treatment, signature, vendors, default model, output location, reference images); `HyperFrames/SKILL.md` (Customization) and `HyperFrames/Intents/ContentToAnimation.md` (video theming) | template |
| `ArtConfig.json` | `Tools/Generate.ts` and `Tools/EvalRound.ts` (page ground for thumbnails and eval candidates, signature face, per-intent prompt `mandates`/`bans`, named `variants`) | template |
| `DiagramTheme.json` | `Tools/AnimatedDiagram.ts` (animated-diagram palette: `ground`, `ink`, `charcoal`, `purple`, `teal`, `paper`, `purpleFill`, `tealFill`, `signature`) | template |
| `DiagramFonts.json` | `Tools/AnimatedDiagram.ts` (font file per type role: `title`, `subtitle`, `label`, `insight`, `signature`) | template (macOS system faces) |
| `brand/` | `Webdesign` briefs and any workflow that embeds your mark (`Art/Intents/EmbossedLogoWallpaper.md`, `Art/Intents/LogoWallpaper.md`) | `README.md` only; you add the assets |
| `CharacterSpecs.md` | `Art/SKILL.md` § Data & Config (character design specifications) | not shipped; optional, free-form prose |
| `SceneConstruction.md` | `Art/SKILL.md` § Data & Config (scene composition guidelines) | not shipped; optional, free-form prose |

Other skills keep their own reference-image folders under this directory. Each ships as a README describing what to put there; nothing in the public Art skill depends on them.

| Folder | Used by | You add |
|------|------|------|
| `HeadshotExamples/` | any thumbnail or headshot intent (`LIFEOS/TOOLS/PickExpression.ts`) | your approved reference photos |
| `YouTubeThumbnailExamples/` | the video skill SponsoredThumbnail `--compare` | locked exemplars per style |
