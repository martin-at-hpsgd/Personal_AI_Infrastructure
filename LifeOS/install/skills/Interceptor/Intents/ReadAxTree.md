# ReadAxTree

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Gotchas · Output format · Examples

The accessibility tree of a macOS app, read without bringing the app to the foreground, with the refs and labels the task needs.

## Ideal State

- The app's AX tree is read while the user's frontmost app stays the same, and the report shows the frontmost app before and after.
- The report names the app read, the number of nodes returned, and the refs and labels relevant to what the user asked.
- The returned tree is narrow (depth 4–6, `--filter interactive` when looking for something to act on); a deeper or wider tree is returned only when the target needs it.
- When an app that gates AX on visibility needed a brief raise, `frontmost` was captured first, the previous frontmost restored with `app activate <previous-frontmost>` afterwards, and the focus change surfaced to the user.

## Anti-criteria

- Never sets or expects `AXEnhancedUserInterface`: it foregrounded AppKit apps and was removed.
- Never passes `--filter labels`; the `tree` verb takes only `--filter interactive|all`.
- A menu-bar-only app with no AX window is never reported as not running without checking `interceptor macos apps`.

## Inputs

A macOS app that may be backgrounded, occluded or just not focused, and what to learn from its UI: a button label, window title, a text field's current value, the structure of a menu.

## Tool contract

**The bridge handles Electron's AX wake-up for you.** Electron apps (Slack, Discord, Cursor, Brave, Notion, VS Code) gate their AX tree on visibility for performance. Interceptor fires `AXManualAccessibility` to wake them up — no focus change.

### The recipe

```bash
interceptor macos tree --app "Cursor" --filter interactive --depth 6
```

That call resolves "Cursor" to a running app and its main window, fires `AXManualAccessibility = true` on the app element (Chromium-specific signal — wakes the tree without activating), walks the AX tree to depth 6, filters to interactive elements only, and returns refs (`e5`, `e7`, …) and labels.

### Filter options

- `--filter interactive` — clickable, editable, focusable elements only. Default for "find me something to act on".
- `--filter all` — every element, including decorative. Bigger output.

The `tree` verb advertises only `--filter interactive|all` in its usage line (verified on 1.0.21, default interactive). There is no `--filter labels` value — don't pass it. For "what does this window say", use `--filter all` and read the labels off the returned nodes.

### Depth tuning

Default 4–6 is enough for most apps. Increase when:
- The target is a deep menu (`--depth 10` or more for nested submenus).
- You need to descend into a sidebar's nested rows (`--depth 8`).

Decrease when you only need the window-level structure (`--depth 2`).

## Gotchas

- **Wake-up signal.** The bridge uses `AXManualAccessibility` exclusively. **`AXEnhancedUserInterface` was removed** because it foregrounded AppKit apps (it's the "VoiceOver is active" flag, which AppKit interprets as "raise main window"). Don't expect or set it; guidance from old code that does is wrong.
- **Apps that gate AX on visibility** (Signal is the classic example): `AXManualAccessibility` may not be enough, because the bridge cannot beat a deliberately-paused process loop. Brief-raise the app, capture `frontmost` first, do the read, then `app activate <previous-frontmost>` to restore. Surface the focus change to the user.
- **Reading too deep on a chatty app.** `--depth 20 --filter all` on VS Code returns thousands of nodes. Start narrow.
- **Refs from a stale tree.** AXObserver invalidates refs when the app rebuilds part of its tree. If `act <ref>` returns "stale ref", re-run `tree`.
- **"No visible windows" ≠ "not running".** A menu-bar-only app (tray app, Discord-in-tray) has no AX window but is still running. Use `interceptor macos apps` to confirm.

## Output format

Report:
- The app you read
- Number of nodes returned (sanity check)
- Refs and labels relevant to what the user asked
- Frontmost app before and after — proof that focus did not change

## Examples

```bash
# What's in the main Slack window?
interceptor macos tree --app "Slack" --filter interactive --depth 6

# Read just the menu bar of Brave
interceptor macos menu --app "Brave Browser"

# Find the AX ref of a specific button without scanning the whole tree
interceptor macos find "Send" --app "Slack" --role button

# Look at one ref in detail
interceptor macos inspect e7
```
