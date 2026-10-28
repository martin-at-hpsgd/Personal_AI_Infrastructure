# HyperFrames

Status: command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null && test -d ~/.cache/lifeos/hyperframes && echo ok · required

## What it does

HyperFrames makes short animated videos from code: an HTML page with one GSAP timeline is stepped frame by frame and encoded to MP4. The assistant plans the scenes first, builds the page, checks stills, then renders. Every render goes through a local wrapper that pins the HyperFrames version and blocks its network calls. A fresh machine needs ffmpeg, a one-time download of the pinned HyperFrames tools, and, only for the narrated and film-review features, a key or two.

## Fill in

Nothing to write by hand for a basic animation. Optional files, under your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`):

- `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/HyperFrames/LaunchFilmReferences.md`: only for launch films. One line per reference film you want the new film measured against. A made-up example:

```markdown
- Example Launch Film (https://example.com/launch-film): fast kinetic type, 4 picture changes per 10 s.
```

- `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/HyperFrames/Theme.json`: only if you want a house look. A partial theme merged over the neutral default in `Tools/Theme.ts`; its keys mirror `DEFAULT_THEME` (`colors`, `typography`, `motion`, `spacing`, `effects`, `borderRadius`). An unknown key, a wrong type or a named font family stops with the file and key. A made-up example:

```json
{ "colors": { "accent": "#e11d48", "accentLight": "#fb7185", "accentDark": "#be123c" } }
```

- `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/HyperFrames/PREFERENCES.md`: prose taste the skill reads before composing: presets, music placement (the skill already keeps music out from under anyone talking), capture rules, and whether `Tools/WatchFilm.ts` may send private cuts to its vendor (public films only when this says nothing).
- `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md`: the Art skill's aesthetic notes, loaded before composing. Load-bearing only if you want a house look.

Projects live outside every git repo, in `$LIFEOS_HYPERFRAMES_DIR` (default `~/HyperFrames/<slug>/`). Finished videos reach `$LIFEOS_DOWNLOADS_DIR` (default `~/Downloads/`) through the ArtDirection delivery tool. The download cache for the pinned tools is `$LIFEOS_HYPERFRAMES_CACHE` (default `~/.cache/lifeos/hyperframes`).

## Accounts and secrets

Basic animations need no account and no key.

- Install ffmpeg and ffprobe: `brew install ffmpeg`. The render checks stop with "install it (brew install ffmpeg)" when either is missing from your PATH.
- Run `bun ~/.claude/LIFEOS/TOOLS/HyperFrames/HyperFrames.ts install` once. It fetches the pinned HyperFrames CLI and its headless Chrome from npm and Chrome for Testing, then prints a JSON line with `"ok":true`. This is the only unsandboxed network step; later renders run offline.
- `FISH_API_KEY` in `~/.claude/.env`, from a Fish Audio account: only for generated narrated shorts (the GeneratedContentVideo intent). Image scenes in that intent use the Art skill, which has its own setup.
- `GOOGLE_API_KEY` in `~/.claude/.env`, from a Google AI Studio account: only for `Tools/WatchFilm.ts`, which has Gemini watch a public film and write notes.
- Check a key without printing it: `bun ~/.claude/LIFEOS/TOOLS/Secrets.ts has FISH_API_KEY GOOGLE_API_KEY`.

## Prove it works

```bash
command -v ffmpeg ffprobe
bun ~/.claude/skills/HyperFrames/Tools/Scaffold.ts --dir ~/HyperFrames/setup-check --title "Setup check"
bun ~/.claude/LIFEOS/TOOLS/HyperFrames/HyperFrames.ts check --project ~/HyperFrames/setup-check
```

Success: the first line prints two paths, the scaffold prints a check mark for `index.html` and `vendor/gsap.min.js`, and the check prints `{"ok":true,"errors":0,"warnings":0}`. If the check reports the pinned tools are not runnable, run the `install` command above and try again. Delete `~/HyperFrames/setup-check` afterward. To see a picture, take one still with `HyperFrames.ts snapshot --project ~/HyperFrames/setup-check --at 1 --out-dir ~/HyperFrames/setup-check/stills`, which prints a JSON line with `"ok":true` and writes `frame-00-at-1s.png` there.
