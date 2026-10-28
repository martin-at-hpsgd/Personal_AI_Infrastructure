---
provenance: template
version: 1.0.0
---

# Presentation — Preferences (this install)

Optional. Every line here overrides a skill default; delete a line to keep the default.

## Deck template and theme

- Template: the directory passed as `--template` on the first lecture build (for example `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Presentation/Template`). Without one the build uses its plain built-in shell.
- Design system: put a `DesignSystem.md` beside this file to override the skill's default register.

## Keynote

- Style file: `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Presentation/keynote-style.json`, passed as `--style` on the first Keynote build. Set `animatedEssayMax` there to change how many essay slides may be animated (three when absent).
- Real things: `RealThings.json` here registers your own book, product or site with its real picture.

## Serving

- Browser: not set, so the served deck opens in the system default browser (`open "http://localhost:<port>/"`). To pick one, replace this line with `Browser: <app name>` using a browser installed on this machine, and the deck opens with `open -a "<app name>" "http://localhost:<port>/"`.

## Where talks live

- `~/Talks/<yyyymmdd>-<slug>/` with the talk file and `deck/`.

## Gates this install requires

- Writing audit on the talk text before Alex Example sees it.
