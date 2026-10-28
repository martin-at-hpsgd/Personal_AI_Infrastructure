# Telos

Status: test -f ~/.claude/LIFEOS/USER/TELOS/TELOS.md && echo ok · required

## What it does

Reads and updates your TELOS (mission, goals, beliefs, narratives, strategies and the rest) with a timestamped backup and a changelog line for every write, analyzes project folders for dependencies and bottlenecks, and writes a McKinsey-style report. The TELOS files are the only required setup; the report theme and fonts are optional taste.

## Fill in

Paths are under your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`).

**1. TELOS files (required)** at `LIFEOS/USER/TELOS/`. The installer puts the starter scaffold there (if files are missing, `bun ~/.claude/skills/LifeOS/Tools/ScaffoldUser.ts --apply` copies any missing starter file into place and never overwrites one you have edited); fill in `TELOS.md` first; the other files are optional and the update tool creates any valid one on first write. The full file list is in `SKILL.md` § Data & Config.

**2. Report theme (optional)** at `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Telos/`. With none of these the report uses the template's neutral theme.

| File | Meaning |
|---|---|
| `ReportTheme.ts` | Your palette and fonts. Same shape as `skills/Telos/ReportTemplate/theme.ts`: export `reportTheme` with `colors` (18 named colors: backgrounds, foreground, muted, borders, primary, accent, success, warning, destructive, callout), `fonts` (a CSS family stack for each role: `display`, `heading`, `body`, `accent`, `sans`) and `fontFaces` (one `{ family, src, weight, style }` per font file, `src` written as `/Fonts/<file>.woff2`). WriteReport copies it over the generated report's `theme.ts`. Start by copying the shipped `theme.ts` and changing values. |
| `Fonts/` | The `.woff2` files your `fontFaces` name, for faces you hold a license for. WriteReport copies them to the report's `public/Fonts/`. File names must match each `src` exactly, case included, or the deployed report falls back to the next family in the stack. |
| `PREFERENCES.md` § Report design | Names which face plays which role, in prose, for the model writing the report. |

The installer puts a filled `PREFERENCES.md` example at `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Telos/PREFERENCES.md` (`ScaffoldUser.ts --apply` copies any missing starter file into place and never overwrites one you have edited). To make `ReportTheme.ts`, copy `skills/Telos/ReportTemplate/theme.ts` whole and change the values; keep it self-contained (no import from `./theme`; copy the interfaces along if you want the types), because it replaces `theme.ts` and cannot import from it. A font entry on made-up values:

```ts
fonts: { display: ["Example Display", "system-ui", "sans-serif"], /* heading, body, accent, sans */ },
fontFaces: [{ family: "Example Display", src: "/Fonts/example-display-bold.woff2", weight: 700, style: "normal" }],
```

## Accounts and secrets

None. Report builds need Bun and the report template's dependencies (`bun install` in the generated report folder).

## Prove it works

```bash
bun ~/.claude/skills/Telos/Tools/UpdateTelos.ts   # no arguments: prints usage and the valid file list, exit 1 (by design)
```
