# ScreenshotForVlm

**Contents:** Ideal State · Anti-criteria · Safety gates · Tool contract · Output format

Takes one screenshot a vision-language model can read, only when pixels are genuinely the answer.

## Ideal State

- A screenshot exists only when pixels are genuinely the answer (visual layout, color, a chart artifact, a rendered glyph) and no structured read (`read`, `text`, `inspect`, `scene text`, `canvas log`, `macos tree`) could produce the same information.
- The capture is one command, `Tools/Capture.sh --current`, whose only stdout line is the absolute path of the saved PNG under `$LIFEOS_DOWNLOADS_DIR/Interceptor/` (default `~/Downloads/Interceptor/` when unset).
- A second look, when one is needed, is a `Tools/Zoom.ts` crop of that full-resolution capture, still 1 command and not a re-take.
- The report gives the saved path, dimensions and on-disk size, the actual visual finding, and whether the pixels answered the question.

## Anti-criteria

- No second exploratory screenshot after a first that did not answer the question; re-evaluate whether pixels are the answer instead.
- Never raw `interceptor screenshot`, and never a fallback to the Default profile when the preflight gate exits non-zero.
- A `--pixel --tab` capture is never trusted before the saved image is read back and confirmed to be the target page.

## Safety gates

Run the preflight in SKILL.md § Gotchas first; a non-zero exit ends the run with its message surfaced verbatim. `Tools/Capture.sh` re-runs the gate itself, routes only to `INTERCEPTOR_TEST_CONTEXT_ID`, and refuses Default and working profiles.

## Tool contract

Screenshots are a last-resort read surface: structured reads cost about 10× fewer tokens per turn and survive DOM churn better than pixels. Try these first, and if any returns the answer, you don't need pixels:

- `interceptor read --text-only --context "$INTERCEPTOR_TEST_CONTEXT_ID"` — cheapest read.
- `interceptor read --tree-only --context "$INTERCEPTOR_TEST_CONTEXT_ID"` — actionable refs.
- `interceptor inspect --context "$INTERCEPTOR_TEST_CONTEXT_ID"` — tree + text + passive network.
- `interceptor scene text <ref> --context "$INTERCEPTOR_TEST_CONTEXT_ID"` — text inside a rich editor.
- `interceptor canvas log <n> --context "$INTERCEPTOR_TEST_CONTEXT_ID"` — observer log of canvas draw calls.
- `interceptor macos tree --app "X"` — when the target is outside the page (macOS computer-use path; no browser context).

### Command Budget: 1 command

```bash
bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/Capture.sh" --current
```

`Capture.sh` runs `interceptor screenshot` on the DOM-render path with the pinned `--context` and `--save`, staged in a private cwd, and prints the saved-image path. No inline base64; the path re-reads on demand. Default DOM-render works from a backgrounded Chrome on a different macOS Space, no focus required; a blank or near-uniform frame is rejected (exit 12), never returned as success. Exit codes are in the header of `Tools/Capture.sh`.

The flags it accepts are `<url>` or `--current`, `--full` (full page), `--pixel`, `--scale N` (1-4), `--out PATH` and `--allow-unchecked`. Any other flag exits 2: it does not forward the underlying `interceptor screenshot` flags (`--format webp`, `--target-max-long-edge`, `--quality`, `--selector`, `--element <ref>`, `--region X,Y,W,H`).

### Image budget

Images are downscaled before the model sees them, so pixels past the consumer's ceiling buy nothing. Vendor ceilings:

- Sonnet — 1568 px
- Opus — 2576 px
- OpenAI — normalizes to 2048-then-768

Fine detail (a logo, a glyph, a few pixels of spacing) is destroyed by that downscale, so zoom from the full-resolution capture: `bun Tools/Zoom.ts <image> --x N --y N --w N --h N` (absolute pixels in the source image; `--budget` defaults to 1568).

### `--pixel`

Opts out of DOM-render to the legacy `captureVisibleTab` compositor path. It captures the window's *active* tab, so to shoot a specific background tab it briefly activates it and restores focus; **the visible flash is by design**. It requires the window non-minimized and visible; minimized → fast honest failure. Use it only when DOM-render fidelity is insufficient (compositor effects, hardware video frames, browser chrome itself, dark or animated pages DOM-render snaps blank before hydration). `--pixel --tab` can capture the WRONG page (it follows the active tab): read the saved image back and confirm it's the target before trusting it. `--pixel --full` scroll-and-stitches the full page, rate-limited at ~1100ms per viewport strip to clear Chrome's 2/sec `captureVisibleTab` cap. DOM-render is the engineered-robust path; `--pixel` is the fragile, flash-inducing opt-out.

## Output format

Report:
- The path written (Capture.sh's single stdout line, e.g. `"${LIFEOS_DOWNLOADS_DIR:-$HOME/Downloads}"/Interceptor/interceptor-capture-<ts>-<rand>.png`)
- Dimensions and on-disk size
- What you saw in the image (the actual visual finding, not "the page rendered")
- Whether the pixel evidence answered the question, or whether you still need another read
