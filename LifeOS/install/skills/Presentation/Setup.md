# Presentation

Status: bun ~/.claude/skills/Presentation/Tools/RealThings.ts --list · optional

## What it does

The presentation skill makes talks, decks and sales pitches. In lecture mode it turns a talk file (`READ.md` or `SCRIPT.md`) into Keynote or HTML slides whose speaker notes are the talk word for word. In deck mode it builds a cue-card HTML deck on your own template and serves it with speaker view. In pitch mode it turns product docs into a value story and talking points. A lecture rendered to a plain HTML deck and the written parts of pitch mode need nothing. The pieces below unlock the Keynote lane, deck mode and the media tools.

## Fill in

Everything lives under `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Presentation/` in your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`). All of it is optional, and each piece unlocks one lane.

**1. Template/** for deck mode. A folder holding your deck markup and assets: `deck.html` (the canonical markup for the nine slide types, with the `<!-- SLIDES:START -->` and `<!-- SLIDES:END -->` markers the editor saves between), `theme.css`, `fonts/`, `images/`, and `vendor/` with your own copy of reveal.js, its notes plugin and `editor.js`, so the deck works offline at a venue. Fonts in a template are often licensed to one person, which is why the template lives here and never in the skill. Without a template, lecture mode still renders a plain deck that loads reveal.js from a CDN.

**2. RealThings.json** for things you name in a talk that should always show their real picture. A made-up example:

```json
{
  "things": [
    { "name": "Example Handbook",
      "aliases": ["the handbook"],
      "image": "real/example-handbook-cover.png",
      "what": "book cover" }
  ]
}
```

`image` is relative to the JSON file and the file must exist, or loading fails with a clear error. A missing registry is just an empty one.

**3. PREFERENCES.md and Config.md**, plain markdown. Preferences hold your template, theme, Keynote style file, the browser that opens a served deck (the system default when unset), where talks live and which quality gates you require. Config holds the identity printed in deck credits and the paths to your own published writing. Its keys:

- `SPEAKER.NAME`: your name, the byline on the title slide and the name/date line.
- `SPEAKER.SITE`: your personal site without the scheme, shown on the title and closing slides.
- `SPEAKER.HANDLE`: the social handle on the closing slide.
- `SPEAKER.ORG`: the organisation name on the closing slide.
- `SPEAKER.ORG_URL`: the link target for that organisation name.
- `BLOG.POSTS_DIR`: the directory holding your published posts as markdown, so a deck quotes them from disk instead of fetching them.
- `BLOG.ART_DIR`: the directory holding your posts' header art, reused before new art is generated.

A BLOG key that points at a directory that does not exist means you have no blog; the deck intent then skips post lookup and generates art fresh. A made-up example:

```markdown
# Presentation config

- `SPEAKER.NAME`: Alex Example
- `SPEAKER.SITE`: example.com
- `SPEAKER.HANDLE`: @alexexample
- `SPEAKER.ORG`: Example Labs
- `SPEAKER.ORG_URL`: https://example.com
- `BLOG.POSTS_DIR`: ~/Projects/example-site/blog
- `BLOG.ART_DIR`: ~/Projects/example-site/public/images/blog
```

**4. keynote-style.json**, optional, passed to the Keynote builder with `--style`. Every key is optional:

- `theme`: the name of a built-in Keynote theme.
- `ground` and `placeholder`: hex colours for the slide ground and for an empty picture slot.
- `artStyle`: a note on the art direction handed to the slide designer.
- `title`, `sub`, `bullets`, `caption` and `footer`: font tokens, each an object with `font` (an installed font name), `size` (points) and `color` (hex). A token you leave out keeps the readable default size in the theme's font. `caption` also styles the source line on media slides.
- `footer.text` and `footer.logo`: when `footer.text` is set, every slide carries that text and its page number in the footer token's type; `footer.logo` is the path to a small logo placed beside it, and the build stops with an error naming the path when that file is missing.
- `art`: a block for generated art, with `paper` (the paper colour), `essayTechnique` and `diagramTechnique` (the diagram technique sets the diagram colours), plus two optional taste keys for essay scenes: `bannedWords` (a list of words the scene composer must never use, for example `["robot", "glowing"]`) and `sceneRules` (extra sentences for it, for example `"At most two figures."`). Without them the composer bans no words and adds no rules, and `KeynoteArt.ts` says so on stderr.
- `animatedEssayMax`: the most essay slides per deck that may carry an animated GIF (three when absent).

```json
{
  "theme": "Basic White",
  "ground": "#F4F1EA",
  "title": { "font": "Example Serif", "size": 80, "color": "#222222" },
  "bullets": { "font": "Example Sans", "size": 48, "color": "#333333" },
  "footer": { "text": "Alex Example  |  May 2031", "font": "Example Sans", "size": 18, "color": "#888888", "logo": "/path/to/logo.png" }
}
```

## Accounts and secrets

No keys go in `~/.claude/.env` for this skill itself.

- Keynote lane: a Mac with the Keynote app. The builder drives it through `osascript`. The slide designer runs through the LifeOS inference tool (`LIFEOS/TOOLS/Inference.ts`, Anthropic lane), so that tool must be able to reach Claude.
- Art for slides comes from the Art skill, which has its own image-provider keys; set that up first if you want generated art.
- The Keynote build and the layout checks use ImageMagick's `magick` command for image sizes, ink cover, rounded corners and the pixel and look-alike gates (`brew install imagemagick` on a Mac); any deck with a picture needs it.
- Media sourcing for clips and stills uses the `ffmpeg` command-line tool on video files you already have; install it if you want film and video footage on slides. Use only footage you own or are licensed to show, and never remove a watermark.
- Deck-mode layout checks (`DeckCheck.ts --live`) measure slides in a real browser through the Interceptor skill, which needs Google Chrome.
- Serving a deck is local only: `Tools/Present.ts` binds `127.0.0.1` on port 7345.

## Prove it works

```bash
bun ~/.claude/skills/Presentation/Tools/RealThings.ts --list
bun ~/.claude/skills/Presentation/Tools/Build.ts --self-test
ls ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Presentation/Template
```

`RealThings.ts --list` prints each registered thing with the path of its picture, or `no real things registered` followed by the registry path when you have none, and exits 0 either way; a registered picture that is missing is an error naming the file. `Build.ts --self-test` is read-only and should end with `all passed`. The `ls` should show `deck.html`, `theme.css`, `fonts`, `images` and `vendor` if you set up deck mode. Then hand your assistant a short script and ask for a deck; success is a deck whose speaker notes are your sentences unchanged.
