# Interceptor

Status: test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env && command -v interceptor >/dev/null && echo ok · required

## What it does

Interceptor lets the assistant drive a real Chrome window and, in full mode, native macOS apps, then check its own work with screenshots and page state. It never touches your everyday Chrome profile. Every browser command is sent to one dedicated test profile, and a preflight gate refuses to run unless that profile is connected. Before it works you need the `interceptor` program, a second Chrome profile with the Interceptor extension loaded, and one small settings file that names that profile.

## Fill in

**1. Install the program.** Install `Interceptor-Full-<version>.pkg` (browser and macOS control) or `Interceptor-Browser-<version>.pkg` (browser only) from the upstream releases page at https://github.com/Hacker-Valley-Media/Interceptor. Then check `interceptor --version`; the preflight requires 0.23.16 or newer. An existing browser-only install becomes full with `interceptor upgrade --full`. Full mode asks for macOS privacy permissions (Accessibility, Screen Recording and others); browser-only mode asks for none. Details: `References/CompleteGuide.md` § Install Modes.

**2. Make the test profile.** In Chrome, add a new profile (avatar, then Add) and name it something obvious. Chrome stores it in a folder called `Profile 1`, `Profile 2` and so on; `chrome://version` shows the exact name under Profile Path. Sign that profile into the sites you want the assistant to verify.

**3. Load the extension into that profile.** Open `chrome://extensions`, turn on Developer mode, choose Load unpacked, and pick the extension folder: `/Library/Application Support/Interceptor/extension` when you installed the signed `.pkg` (step 1), or `~/.claude/skills/Interceptor/Extension` if you built from source and ran `Tools/Pin.sh`, which creates that folder (it does not ship with the skill). Click the Interceptor toolbar icon, set Context ID to `interceptor-test`, and Save.

**4. Write preferences.env.** Copy `~/.claude/skills/Interceptor/preferences.env.example` to `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env` under your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`). A made-up example:

```bash
INTERCEPTOR_TEST_CONTEXT_ID="interceptor-test"
INTERCEPTOR_TEST_CHROME_PROFILE="Profile 2"
INTERCEPTOR_TEST_CHROME_PROFILE_NAME="Interceptor"
```

| Field | Meaning |
|---|---|
| `INTERCEPTOR_TEST_CONTEXT_ID` | Required. The Context ID you saved in the extension popup. No default; unset stops the preflight with exit 8. |
| `INTERCEPTOR_TEST_CHROME_PROFILE` | Required for auto-launch. The profile's folder name from step 2. |
| `INTERCEPTOR_TEST_CHROME_PROFILE_NAME` | Optional. The profile's display name as it ends every window title. It stops a second window opening when one is already open. |
| `INTERCEPTOR_TEST_BROWSER` | Optional. Browser app name, default `Google Chrome`. |
| `INTERCEPTOR_TEST_BROWSER_BIN` | Optional. Direct path to the browser binary. |
| `INTERCEPTOR_WORKING_PROFILE_IDS` | Optional. Comma-separated context IDs of your everyday profiles that must never be driven. |
| `INTERCEPTOR_TEST_WINDOW_BOUNDS` | Optional. Home bounds `left,top,width,height` the test window is snapped back to on every READY. Empty means it is never moved. |
| `INTERCEPTOR_MIN_STDDEV` | Optional. Blank-frame threshold for `Tools/Capture.sh`, default `0.017`. |
| `INTERCEPTOR_EXT_DIR` | Optional. Directory holding the unpacked extension; empty uses the skill's pinned `Extension/`. |
| `INTERCEPTOR_SRC` | Optional. Source checkout of the upstream repo, used by the freshness check and `Tools/Pin.sh`. |

## Accounts and secrets

No account and no `~/.claude/.env` keys. The only secrets are your own logins inside the test profile; sign in there yourself once. The profile data is kept by Chrome, not by this skill.

## Prove it works

```bash
source "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env"
bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/PreflightIsolation.sh"; echo "exit=$?"
interceptor status | head -3
```

Success: the preflight prints `[PreflightIsolation] OK — interceptor <version>, pinned context "<id>" connected and not denied.` and `exit=0`, and `interceptor status` shows a `mode:` line and `daemon: running`. A non-zero exit prints the exact fix: 2 program missing, 4 version too old, 5 or 6 test profile not connected (open it and check the Context ID), 8 context ID unset, 9 extension folder missing. To open the test window and wait for it, run `bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/EnsureTestProfile.sh"`, which prints `READY`.
