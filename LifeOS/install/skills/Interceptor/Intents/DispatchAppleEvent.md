# DispatchAppleEvent

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Gotchas · Output format · Examples

An Apple Event delivered to a named macOS app by bundle id, with its return value, without bringing the app to the foreground.

## Ideal State

- The AppleScript runs against the target app named by its bundle identifier, and its return value (URL, title, message id, etc.) is reported with the bundle id and script that ran.
- The user's frontmost app is the same before and after the dispatch, and the report shows both as proof that focus did not change.
- When a TCC Apple Events consent dialog appeared, it was surfaced to the user and the result confirmed after they answered.
- When the target app has scripting disabled behind a preference (such as Microsoft Office's "Allow AppleScript" toggle), the error is surfaced to the user.

## Anti-criteria

- The AppleScript block never contains `activate`.
- Never silently falls back when AppleScript is disabled in the target app.

## Inputs

A named macOS app and the AppleScript verb to send it: open a URL in Brave, read the active tab URL, make a new tab, list the running documents in TextEdit, or any verb against a specific bundle.

## Safety gates

**Do not include `activate` in the AppleScript block.** It is the most common mistake: `activate` foregrounds the app, which `intent dispatch` exists to avoid.

## Tool contract

### The recipe

```bash
interceptor macos intent dispatch --bundle <id> --script '<applescript>'
```

The `<id>` is the bundle identifier (look up via `interceptor macos apps` if you don't know it). The `<applescript>` is a single line or block that runs in the context of the target app.

### Common bundle ids

| App | Bundle id |
|---|---|
| Brave Browser | `com.brave.Browser` |
| Google Chrome | `com.google.Chrome` |
| Safari | `com.apple.Safari` |
| Mail | `com.apple.mail` |
| Notes | `com.apple.Notes` |
| Finder | `com.apple.finder` |
| Music | `com.apple.Music` |

### TCC: first dispatch prompts for Apple Events consent

The first time the bridge sends an Apple Event to a given target app, macOS prompts the user with a consent dialog. Subsequent dispatches are silent. To pre-prompt for several apps in one go:

```bash
interceptor macos intent warmup com.brave.Browser com.apple.mail com.apple.Notes
```

It fires a no-op event against each bundle id, so all consent prompts surface up front instead of mid-workflow.

## Gotchas

- **`tell application "X" to launch then open …`.** `launch` without `activate` is generally fine, but on cold-launch some AppKit apps still self-activate via `kAEOpenApplication`. If you need a guaranteed-cold-launch with no focus change, this is a platform limitation, not an interceptor bug.
- **AppleScript disabled in the target app.** Some apps gate scripting behind a preference (Microsoft Office's "Allow AppleScript" toggle). Surface the error to the user; don't silently fall back.
- **Quoting.** AppleScript strings use double quotes, so wrap the whole `--script` in single quotes. If the script itself needs single quotes, escape with `'\''`.

## Output format

Report:
- The bundle id and script that ran
- The return value (URL, title, message id, etc.)
- Frontmost app before and after — proof that focus did not change
- If a TCC consent dialog appeared: surface that to the user and confirm after they answered

## Examples

```bash
# Open a URL in Brave (no activation)
interceptor macos intent dispatch --bundle com.brave.Browser \
  --script 'tell application id "com.brave.Browser" to open location "https://example.com"'

# Read the active tab URL of Brave
interceptor macos intent dispatch --bundle com.brave.Browser \
  --script 'tell application "Brave Browser" to URL of active tab of front window'

# New tab in Brave to a specific URL
interceptor macos intent dispatch --bundle com.brave.Browser \
  --script 'tell application "Brave Browser" to tell front window to make new tab with properties {URL:"https://example.com"}'

# Compose a Mail message
interceptor macos intent dispatch --bundle com.apple.mail \
  --script 'tell application "Mail" to make new outgoing message with properties {subject:"hi", content:"body"}'
```

None of those touch the user's frontmost app.
