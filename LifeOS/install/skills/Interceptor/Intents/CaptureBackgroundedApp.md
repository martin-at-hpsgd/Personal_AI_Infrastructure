# CaptureBackgroundedApp

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Gotchas · Output format

A screenshot of one named macOS app window, taken from the compositor without bringing the app to the foreground.

## Ideal State

- A screenshot of the named app's window is written to disk (WebP by default, `--format png` for archival fidelity) with a path-only result and its long edge clamped to the consuming model's auto-resize ceiling (the per-vendor values are in `Intents/ScreenshotForVlm.md` § Image budget).
- The capture works when the target window is occluded, minimized, on another Space, or just not frontmost.
- The user's focused window does not change: `interceptor macos frontmost` reports the same app before and after the capture.
- When the capture fails (a tray-only app with no window, or an app that disables window-server capture and returns empty or black), the failure is surfaced to the user.
- The report gives the file path written, the dimensions and on-disk size, the frontmost app before and after, and what was seen in the image.

## Anti-criteria

- Never calls `interceptor macos app activate` first, not even "to be safe"; the bridge's CGS path was designed not to need it.
- Never uses `--mode display` for an app-specific capture: it captures the visible composite, which has the wrong app on top.

## Inputs

A named macOS app ("screenshot of Brave / Signal / Mail / X") that may be occluded, minimized, on another Space, or just not frontmost.

## Safety gates

**Do not call `interceptor macos app activate` first.** The bridge uses `CGSHWCaptureWindowList` to pull the app's window directly from the compositor — works on occluded, minimized, and cross-Space windows.

## Tool contract

### The recipe

```bash
interceptor macos screenshot --app "Brave Browser" --save --target-max-long-edge 1568
```

That single call:
1. Resolves "Brave Browser" to a running app and its windows.
2. Captures the front window via `CGSHWCaptureWindowList` — no focus change.
3. Writes a WebP to disk and returns a path-only result (no inline base64).
4. Clamps the long edge to `--target-max-long-edge`; set it to the consuming model's ceiling from `Intents/ScreenshotForVlm.md` § Image budget.

### Verify nothing moved

```bash
interceptor macos frontmost                              # before
interceptor macos screenshot --app "Brave Browser" ...   # work
interceptor macos frontmost                              # after — should match
```

If `before` and `after` differ, something foregrounded the target. Suspect:
- You called `app activate` somewhere in the chain.
- An AppleScript block you ran contained `activate` or `reopen`.
- The app cold-launched (`open` against a not-running target may self-activate via `kAEOpenApplication`).

### Override the default

- `--window <ref>` — a specific window ref from `interceptor macos windows --app "X"`. Use when an app has multiple windows and you want a specific one.
- `--region X,Y,W,H` — sub-region of the captured window.
- `--format png` — archival fidelity; webp is the agent default.
- `--target-max-long-edge <px>` — a consumer whose ceiling differs (values: `Intents/ScreenshotForVlm.md` § Image budget).

## Gotchas

- **`--mode display`.** Do NOT use it for app-specific captures. It captures the visible composite, which by definition has the wrong app on top.
- **Window doesn't exist.** If the app has only a menu-bar icon (tray-only Electron app), capture fails. Run `interceptor macos windows --app "X"` first.
- **Apps that disable window-server capture** (some payment / 1Password sheets). Capture returns empty or black. Surface the failure to the user.

## Output format

Report:
- File path written
- Dimensions and on-disk size
- Frontmost app before and after (proof of no focus change)
- What you saw in the image (the visual finding)
