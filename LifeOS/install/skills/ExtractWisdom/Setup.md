# ExtractWisdom

Status: command -v fabric >/dev/null && command -v yt-dlp >/dev/null && echo ok · optional

## What it does

ExtractWisdom reads an article, interview, podcast or video and writes the best ideas, quotes and contrarian takes in sections named for that content. Pasted text, files and article links need nothing: the assistant fetches the page's raw HTML itself. Only YouTube links need setup, because the transcript comes from the `fabric` program, which in turn needs `yt-dlp`.

## Fill in

Nothing to write. Optional preferences go in `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/ExtractWisdom/PREFERENCES.md` under your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`). Without the YouTube pieces, paste the transcript or save it to a file and point the skill at that.

## Accounts and secrets

No account or `~/.claude/.env` key for the skill itself. For YouTube links, install the same two programs the Fabric skill uses: `fabric` (`go install github.com/danielmiessler/fabric/cmd/fabric@latest`) and `yt-dlp` on your PATH. The Fabric guide, `skills/Fabric/Setup.md`, covers both, including `fabric --setup`. Sites that block a plain fetch are escalated to the BrightData skill, which has its own setup.

## Prove it works

```bash
command -v fabric yt-dlp
fabric --version
```

Success: the first command prints two paths and the second prints a version such as `v1.4.479`. Then ask your assistant to "extract wisdom from" a public YouTube link. Success is a set of sections named for that video, each bullet drawn from what was said, ending with a one-sentence takeaway. If `command -v` prints fewer than two paths, only article, file and pasted-text extraction will work.
