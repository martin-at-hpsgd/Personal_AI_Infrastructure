# LaunchTestProfile

**Contents:** Ideal State · Anti-criteria · Output format · Inputs · Safety gates · Tool contract · Gotchas

The dedicated, signed-in Chrome test profile open in its own window and connected as the pinned Interceptor context, so live testing never touches the operator's Default profile.

## Ideal State

- The test profile is a separate Chrome profile inside the same user-data-dir (separate cookie jar, tabs and window), signed into the accounts the tooling under test needs, so authenticated flows can be tested.
- The preflight gate returned exit 0 before any browser command: binary version, daemon connection and context registration all checked, and `interceptor contexts` shows the test context.
- Every live-testing command routes via `--context "$INTERCEPTOR_TEST_CONTEXT_ID"` and lands in the test profile's window only; screenshots go through `Tools/Capture.sh`.
- The test window is launched through `Tools/EnsureTestProfile.sh`, which launches only when the test window is genuinely closed, never by agents calling the launcher directly.
- The report carries every Output format field, and a failure names its exact mode.

## Anti-criteria

- The agent never opens a tab, clicks, types, navigates, or records in the operator's Default profile unless the operator explicitly says so ("verify in my Default profile", "use the main window").
- A missing pinned context (test window closed, UUID rot) is a hard stop, not a fallback: the agent surfaces the preflight remediation and stops, never falling back to Default silently.
- Never uses a `--user-data-dir` sandbox for the test profile; the boundary is profile, not user-data-dir.
- Never adds `-n` (new instance) to the launch, and never names two contexts `interceptor-test`.
- The profile directory name is never written to `~/.zshrc`; `preferences.env` is its single canonical home.

## Output format

Report:
- Whether the test profile window appeared (PID, profile dir)
- Whether `interceptor contexts` shows `interceptor-test`
- Whether the first `open --context interceptor-test` returned tree + text
- If anything failed: the exact mode (profile not created yet, extension not loaded, context name not set, daemon doesn't see it)

## Inputs

This is the default for everything the agent does in a browser, and the window every live-testing intent (VerifyDeploy, Reproduce, TestForm, ReadAndExtract, RecordFlow, MultiPageCompare, OverrideXhr) lands in. Same Chrome installation and root cert store as the Default profile, with its own cookie jar, tabs and window, signed into the services the operator verifies with it.

## Safety gates

### Daily operation

Every session starts with the preflight gate, before any browser-touching step: read-only public-page fetches, authenticated tooling verification and screenshots alike.

```bash
# Agent's first action before any browser command — runs the gate and, only when the test
# window is genuinely closed, launches it once (grace poll + window probe + launch lock):
bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/EnsureTestProfile.sh" \
  || { echo "Preflight failed — STOP and surface to operator. Do not fall back."; exit 1; }

# Only after the preflight returns exit 0. The script sources preferences.env only in its own
# process, so the caller sources it too, on the same line (the Bash tool keeps no env between calls):
source "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env" && interceptor open "https://example.com" --context "$INTERCEPTOR_TEST_CONTEXT_ID"
source "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env" && interceptor read --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor act e5 --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor inspect --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```

The launcher invokes the browser binary directly with `--profile-directory` and `--new-window` (macOS `open -a … --args` silently drops the args when Chrome is already running); Chrome’s process singleton opens one new window for that profile. Agents should not call it directly — `Tools/EnsureTestProfile.sh` wraps it behind a reconnect grace window, an already-open-window probe (`INTERCEPTOR_TEST_CHROME_PROFILE_NAME`), and a machine-wide launch lock, because a bare launch on every disconnect is how the test profile filled with blank windows on 2026-09-06.

### Routing

- Every `open`, `read`, `act`, `inspect`, `monitor start`, `tab new` and `navigate` carries `--context "$INTERCEPTOR_TEST_CONTEXT_ID"`. The pinned ID lives in `preferences.env`; the literal `interceptor-test` friendly name only resolves once it's set in the extension popup.
- **Multi-context safety net.** With 2+ contexts connected, bare commands (no `--context`) hard-error. That fail-fast is a structural backstop, not the primary safety mechanism — the primary is passing the pinned `--context` on every verb. With one context left, a bare command silently auto-routes to whatever remains, including Default — which is why `--context` is required on every verb.

## Tool contract

### One-time setup (operator action)

#### 1. Create the test profile in Chrome

In the operator's main Chrome window: click the **avatar/profile picture in the top-right corner**, click **"Add"** (or **"+ Add Profile"** depending on Chrome version), choose **"Sign in"** (recommended — pulls bookmarks/extensions automatically) or **"Continue without an account"**, name it something obvious (`Interceptor-Test`), and pick an avatar so the window is clearly distinguishable from the Default one.

Chrome creates a new profile directory inside the existing user-data-dir, typically named `Profile 1` (or `Profile 2` if `Profile 1` already exists). Confirm the directory name in `~/Library/Application Support/Google/Chrome/Local State` under `profile.info_cache` — each profile entry's key is its directory name.

#### 2. Sign the profile into the operator's accounts

In the new profile window, sign into Google with the operator's account (or a delegated account with access to what you need to test), then the other services the agent will verify (GitHub, your hosting dashboard, your site or CMS admin, admin dashboards). 2FA each one once; sessions persist in this profile thereafter.

#### 3. Load the Interceptor extension into this profile

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked**.
4. Select the extension folder: `/Library/Application Support/Interceptor/extension` when you installed the signed `.pkg`, or, for a from-source build, `~/.claude/skills/Interceptor/Extension` — a **pinned copy** (not a symlink) of upstream `extension/dist`, captured by `Tools/Pin.sh`, which creates it (it does not ship with the skill); provenance in `Extension/PINNED_FROM.txt`. Chrome disables unpacked extensions on every manifest bump, so re-pin and reload after any binary upgrade — the copy does NOT auto-follow upstream.
5. Confirm the Interceptor card appears in this profile.

The extension's deterministic `key` field means the extension ID matches the one already in the Default profile — that's fine; the daemon allowlist already includes it.

#### 4. Name the context

Click the Interceptor toolbar icon in the new profile window. Set **Context ID** to:

```
interceptor-test
```

Save. The daemon now sees this connection as `interceptor-test` and routes commands with `--context interceptor-test` to this window.

#### 5. If your profile dir isn't the configured one

Set the directory name in `preferences.env`; a copy in `~/.zshrc` would be a second, unsynced source of truth the launcher and preflight can disagree with:

```bash
# Edit ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env:
#   export INTERCEPTOR_TEST_CHROME_PROFILE="Profile 2"   # whichever profile dir Chrome made
```

Or set it inline for a one-off launch (still keep `preferences.env` authoritative for daily use):

```bash
INTERCEPTOR_TEST_CHROME_PROFILE="Profile 2" bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/LaunchTestProfile.sh"
```

#### 6. Verify (via the canonical preflight)

The Preflight Isolation Gate checks binary version, daemon connection, and context registration in one shot — anything that would let a browser command leak into the Default profile.

```bash
bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/LaunchTestProfile.sh" "https://example.com"
# A new Chrome window opens for the test profile, navigates to example.com.

bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/PreflightIsolation.sh"
# Expect:
#   [PreflightIsolation] OK — interceptor <version>, pinned context "<pinned-id>" connected and not denied.
```

If the preflight fails, address the exact failure mode its remediation message names (extension not loaded, context ID not set, binary too old, daemon not connected); no live browser command runs until it returns exit 0.

```bash
# Only after preflight passes (source preferences.env so $INTERCEPTOR_TEST_CONTEXT_ID resolves):
source "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env"
interceptor open "https://example.com" --context "$INTERCEPTOR_TEST_CONTEXT_ID"
# Lands in the test profile's window only.
```

## Gotchas

- **Don't use `--user-data-dir` here.** That gives you a fully-sandboxed Chrome with no auth, which is useless for testing the operator's authenticated tooling. The right boundary is profile, not user-data-dir.
- **Extension reload after a bump.** A from-source `~/.claude/skills/Interceptor/Extension/` copy is pinned, not a symlink — after any binary upgrade, re-pin via `Tools/Pin.sh` (per the Update intent), then Load Unpacked again in **both** profiles (Default + test). With the signed `.pkg`, the installer refreshes `/Library/Application Support/Interceptor/extension`; reload the extension in each profile. Chrome disables unpacked extensions on every manifest version bump and never auto-refreshes them.
- **Context ID must be unique.** Two contexts named `interceptor-test` makes `--context` routing ambiguous. One test profile per context name.
- **Profile dir name confusion.** Chrome names the on-disk directories `Profile 1`, `Profile 2`, … even though you give the profile a friendly name like "Interceptor-Test". The launcher needs the on-disk name in `INTERCEPTOR_TEST_CHROME_PROFILE`; it has no default and refuses to launch without one.
- **Lock conflict if you force `-n`.** Don't add `-n` (new instance) to the `open` command — two Chrome processes can't share the same user-data-dir. The launcher relies on the existing Chrome handling `--profile-directory` natively.
- **Sign-in cookies expire.** Re-sign-in periodically. If a command fails with a 401/302-to-login, re-auth in the test profile and continue.
