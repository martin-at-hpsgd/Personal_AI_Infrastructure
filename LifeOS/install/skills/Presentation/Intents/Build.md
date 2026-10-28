# Build

Rebuilds and serves a lecture whose `SCRIPT.md` already exists: a deck that matches the script exactly, validated and served, so the speaker can present from it.

## Ideal State

- The deck matches the lecture's `SCRIPT.md` exactly: Build exits 0 and reports the slide count, the word count and the minutes.
- `Build.ts --check` exits 0, every slide renders, and every slide's notes show as spaced lines.
- If any slide changed, at least one of the changed slides is captured in the browser with `?showNotes=true`.
- Every slide is captured into `<dir>/deck-png/` and passed a `slides` critique written to `<dir>/Critique.json` (`../References/QualityLoop.md`).
- The speaker gets the URL and the keys: **F** for fullscreen on the external display, **S** for speaker view on the laptop.

## Anti-criteria

- No lasting change is made in the deck itself; it goes in SCRIPT.md, the source the next build overwrites the deck from (`../References/TalkFiles.md`).
- The rebuilt deck never reaches the speaker without its `slides` critique.
- The deck server is never left running once the speaker is done with it.

## Tool contract

```bash
bun ~/.claude/skills/Presentation/Tools/Build.ts --script <dir>/SCRIPT.md          # validate + rebuild <dir>/deck
bun ~/.claude/skills/Presentation/Tools/Build.ts --deck <dir>/deck --serve [--port 7350]
```

If PREFERENCES names a deck server (one with an editor or a presenter app, for example), serve with that instead. Run the server in the background, and stop it once the speaker is done with it.

### Intent to flags

| Speaker says | Flags |
|--------------|-------|
| "just check it", "is it valid" | `--check` |
| "give me the script", "read-through" | `--text` |
| "sync", "rebuild", "I edited it" | (no flag) |
| "present it", "serve it" | `--deck <dir>/deck --serve` |

## Examples

**Edit and rebuild**
```
User: "I changed a few lines in the script, sync it"
→ Build: Build.ts --script SCRIPT.md (validate + render), serve, spot-check
→ Returns the URL plus any warnings about sentences that run long
```
