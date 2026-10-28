# Update

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Gotchas

Brings the installed interceptor (CLI, daemon, Chrome extension and, in full mode, the macOS bridge) to a newer release and proves the whole pipeline works, defaulting to the full Computer Use install; `--browser-only` skips the bridge. The normal install and upgrade path is the signed `.pkg` from the upstream releases page, or `interceptor upgrade --full` on an existing install. Build from source only when you need an unreleased commit or are developing against the repo; that path is Path B below.

## Ideal State

- The end-to-end check passes on either path: `--version`, `status`, `status --verbose`, `contexts`, `diagnose --no-skills-hint`, `PreflightIsolation.sh` exit 0, and `interceptor open "https://example.com"` in the test context returning tree plus extracted text; the report gives the installed version and the `mode:` line.
- On a from-source build, the CLI and daemon were installed atomically (staged, ad-hoc signed, `mv`-renamed into `/opt/homebrew/bin`): `codesign --verify -v /opt/homebrew/bin/interceptor-daemon` exits 0, launchd shows a live pid with no `OS_REASON_CODESIGNING` exit, and that pid equals the `pid:` line under `daemon:` in `interceptor status`.
- A from-source build's extension was re-pinned with `Tools/Pin.sh` (exit 0, `Extension/PINNED_FROM.txt` showing the new `Manifest version:` and a fresh `Pinned at:`) and the extension was reloaded (the zero-touch `interceptor reload --context "$INTERCEPTOR_TEST_CONTEXT_ID"` first, the manual path in step 7 only if the card comes back disabled or missing), with the test context id surviving or re-pinned.
- The native messaging host manifest lists the current extension ID and its `path` points at `/opt/homebrew/bin/interceptor-daemon`, so `interceptor diagnose --no-skills-hint` reports no binary split-brain.
- In full mode (the default), the bridge runs from the `.app` bundle under `~/.local/share/interceptor/` through the `com.interceptor.bridge` LaunchAgent, and `interceptor status` shows it running, not just loaded; `--browser-only` skips the bridge.

## Anti-criteria

- Never `cp` over the live installed binaries.
- Upstream's `interceptor update` self-updater is not used.
- Never quit or relaunch the operator’s Chrome for an extension bump.
- Never `pkill -f interceptor-daemon`, which also kills Chrome's relay daemon; the singleton is restarted by pid.
- The stale `/usr/local/bin/interceptor-bridge` copy is never installed, pointed at by a plist, or re-signed.
- The source checkout is never kept in a cloud-synced directory (iCloud Drive, Dropbox, Google Drive).

## Inputs

- Install modes and channels (signed pkgs, `bash scripts/install.sh --browser-only` / `bash scripts/install.sh --full`, `interceptor upgrade --full`): `References/CompleteGuide.md` § Install Modes. Mode is recorded in `~/.config/interceptor/config.toml`; `interceptor status` echoes the active `mode:` line. Browser-only also supports Microsoft Edge, Vivaldi and Linux hosts.
- Path B reads `$INTERCEPTOR_SRC`, your clone of https://github.com/Hacker-Valley-Media/Interceptor (`Tools/Pin.sh` reads the same variable).

## Safety gates

The bridge security model (local UNIX socket, no socket authentication, TCC grants inherited by every socket client, supply-chain as the marginal risk) is in `References/CompleteGuide.md` § Computer Use — macOS Native Helper; read it before installing. Two additions for this intent:

- Multi-user Macs need socket hardening (chmod 700 of the socket as a post-start plist hook).
- **Binary provenance:** the Developer-ID-signed `.pkg` (Path A) is the default. A from-source build (Path B, from `$INTERCEPTOR_SRC/interceptor-bridge/Sources/`) is ad-hoc signed, for development only.

## Tool contract

### Path A — signed installer

Install `Interceptor-Full-<v>.pkg` (or `Interceptor-Browser-<v>.pkg`) from the upstream releases page, or promote an existing browser-only install with `interceptor upgrade --full`. The installer places the extension, the native messaging host and the bridge `.app`. Then run the end-to-end check below.

### Path B — from source

#### 0. Point at your source checkout

```bash
export INTERCEPTOR_SRC=/path/to/your/interceptor
```

Keep it on local disk: cloud sync strips the code-signature envelope off built `.app` bundles, which makes the macOS bridge SIGKILL-loop on launch.

#### 1. Pull latest

```bash
cd "$INTERCEPTOR_SRC" && git fetch origin && git status -uno
```

With local diffs, stash around the pull:

```bash
cd "$INTERCEPTOR_SRC" && \
  git stash push -m "local patches" -- '<paths>' && \
  git pull --ff-only origin main && \
  git stash pop
```

Upstream force-pushes are rare (common before v0.10), so plain `git pull --ff-only` usually works. If one happened, inspect what would be lost, then:

```bash
cd "$INTERCEPTOR_SRC" && git reset --hard origin/main
```

#### 2. Install dependencies, then build

```bash
cd "$INTERCEPTOR_SRC" && bun install
```

```bash
cd "$INTERCEPTOR_SRC" && bun run build       # or: bash scripts/build.sh
```

`bun install` runs before every build because upstream may add deps; the build fails with "Could not resolve" otherwise. Outputs: `dist/interceptor` (CLI), `daemon/interceptor-daemon` (native messaging host), `extension/dist/` (Chrome extension), `dist/interceptor-bridge` (bare Swift binary, macOS full mode) and `dist/interceptor-bridge.app` (`.app` bundle with Sparkle.framework embedded).

#### 3. Install binaries atomically

The `com.interceptor.daemon` LaunchAgent (`KeepAlive`) respawns the daemon every 5s. A plain `cp` over the installed binary exposes a half-written or stale-signed file to those respawns, and taskgated SIGKILL-loops every attempt (`OS_REASON_CODESIGNING`) until the copy completes — 92 crash reports in one window on 2026-08-10, similar burst 2026-08-07. Stage, sign, then `mv`:

The install directory is wherever the current `interceptor` already lives, since the daemon LaunchAgent and the NMH manifest point there. On a first install it falls back to Apple Silicon Homebrew's `/opt/homebrew/bin` when that exists, else `/usr/local/bin` (Intel, or no Homebrew; creating it may need `sudo`). Everywhere else in this intent, `/opt/homebrew/bin` stands for `$BIN`.

```bash
BIN="$(dirname "$(command -v interceptor 2>/dev/null || { [ -d /opt/homebrew/bin ] && echo /opt/homebrew/bin/interceptor || echo /usr/local/bin/interceptor; })")"
mkdir -p "$BIN" || { echo "Cannot create $BIN — create it (sudo mkdir -p \"$BIN\") and put it on PATH"; exit 1; }
cp "$INTERCEPTOR_SRC"/dist/interceptor            "$BIN"/.interceptor.new
cp "$INTERCEPTOR_SRC"/daemon/interceptor-daemon   "$BIN"/.interceptor-daemon.new
codesign --force --sign - "$BIN"/.interceptor.new
codesign --force --sign - "$BIN"/.interceptor-daemon.new
mv -f "$BIN"/.interceptor.new          "$BIN"/interceptor
mv -f "$BIN"/.interceptor-daemon.new   "$BIN"/interceptor-daemon
# Hand the port to launchd in ONE command: kill the running singleton by pid and kickstart
# before any CLI call can spawn a standalone on the freed port (0.24.2 exits 0 when the
# port is held, and the plist’s KeepAlive is {SuccessfulExit:false}, so a lost race stays lost).
kill "$(interceptor status | awk '/^daemon:/{d=1;next} d && /^pid:/{print $2; exit}')"; launchctl kickstart -k "gui/$(id -u)/com.interceptor.daemon"
```

If launchd refuses the new ad-hoc daemon (`OS_REASON_CODESIGNING` with `needs LWCR update`, `job state = spawn failed`) or the kickstarted daemon loses the port race (`state = not running`, a `--standalone` holding the port), recover per `References/UpdateRecovery.md` § Daemon handoff recovery.

Verify with `launchctl print "gui/$(id -u)/com.interceptor.daemon" | grep -E 'pid|last exit'` plus the codesign and pid checks in the Ideal State. Launchd owns the singleton; a relay-spawned standalone owning it is the 2026-09-06 window-storm precondition.

#### 4. Pin the built extension

`Tools/Pin.sh` copies the built `extension/dist/` into `~/.claude/skills/Interceptor/Extension/`, **creating that directory on first run** (it does not ship with the skill). Chrome loads that stable copy rather than the build tree, because a rebuild rewrites `dist/` in place and Chrome disables an unpacked extension when the manifest version changes underneath it. Re-pin after every build:

```bash
bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/Pin.sh"
```

`Pin.sh` rsyncs `dist/` → `Extension/`, **scrubs absolute home paths** that esbuild bakes into bundled JS (the `__dirname` literal in CommonJS wrappers → `"."`), regenerates `PINNED_FROM.txt` with a relative source path, and exits non-zero if any absolute home path survives.

If `Pin.sh` dies after rsyncing the new manifest but before rewriting `PINNED_FROM.txt` (stale version and SHA), Finder-duplicate cruft in `extension/dist/` is the cause: delete it with `find "$INTERCEPTOR_SRC"/extension/dist \( -name "* 2.*" -o -name "* 3.*" \) -delete` and re-pin (`References/UpdateRecovery.md` § Pin.sh fails on Finder-duplicate cruft).

#### 5. Re-register native messaging

The NMH must list the new extension ID before the reload in step 7.

```bash
cd "$INTERCEPTOR_SRC" && bash scripts/install.sh --chrome --skip-extension
```

The script regenerates `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.interceptor.host.json` with the current allowed extension IDs. `--skip-extension` is right for Chrome because branded Chrome ignores `--load-extension`.

**1.0.1 gotcha (2026-09-14): `install.sh --chrome --skip-extension` does MORE than the NMH.** In full mode it also (a) copies the freshly built ad-hoc `dist/interceptor-bridge.app` over `~/.local/share/interceptor/interceptor-bridge.app` and kickstarts the LaunchAgent, which resets the bridge's TCC grants (Accessibility + Screen Recording read `denied` afterwards; re-grant in System Settings, see 6a/6c), and (b) writes the NMH `path` as `$INTERCEPTOR_SRC/daemon/interceptor-daemon` (the build tree), the split-brain the end-to-end check catches. After running it, rewrite `path` in the generated manifest (`daemon/.generated/com.interceptor.host.json`, the file the Chrome/Brave symlinks point at) back to `/opt/homebrew/bin/interceptor-daemon`. If you only want the NMH refreshed, that one-line edit plus adding the new ID to `allowed_origins` is the whole step; skip the script.

**Bridge runtime files moved (1.0.1):** the bridge socket/pid now live in the per-user temp dir (`$TMPDIR/interceptor-bridge.sock`), not `/tmp`. The 1.0.1 CLI still detects an older bridge at the legacy `/tmp` path, so a bridge can lag one release; `interceptor status` shows whichever it found.

#### 6. Bridge — macOS native helper (Computer Use)

Required for `--full` mode; skipped only for `--browser-only`. The bridge unlocks OS-level trusted input, native app control via the accessibility tree, ScreenCaptureKit, Vision OCR, Speech, NLP, Apple Events, OSLogStore, file watching, **VM lifecycle** and the container runtime.

##### 6a. Install (`.app`-bundle topology)

The LaunchAgent points at the `.app`-bundle binary, not a bare copy in `/usr/local/bin`:

```
ProgramArguments[0] = ~/.local/share/interceptor/interceptor-bridge.app/Contents/MacOS/interceptor-bridge
```

The signed-`.pkg` install lands the `.app` bundle there (Sparkle.framework embedded in `Contents/Frameworks/`, no separate `/usr/local/Frameworks` copy needed). For a dev build, stage the freshly built bundle:

```bash
# 0. Build the bridge under a STABLE signing identity so TCC grants survive future rebuilds.
#    Any Apple-issued identity in the login keychain works (Apple Development is enough for
#    a local bridge); ad-hoc signing resets Accessibility + Screen Recording on EVERY rebuild.
#    The one-time switch from ad-hoc to a real identity resets TCC once — see 6c.
INTERCEPTOR_SIGNING_IDENTITY="$(security find-identity -p codesigning -v | sed -nE 's/.*"(Apple Development: [^"]+|Developer ID Application: [^"]+)".*/\1/p' | head -1)" \
  bash "$INTERCEPTOR_SRC"/scripts/build-bridge.sh
# Keep Sparkle's auto-check off: a self-signed bridge cannot install upstream updates and pops
# "Update Error!" on Install (why: References/UpdateRecovery.md § Background):
defaults write com.interceptor.bridge SUEnableAutomaticChecks -bool false
#
# SIGN FROM OUTSIDE THE HARNESS LINEAGE. Files written by a provenance-tagged shell (a downloaded terminal app,
# the agent's Bash) carry com.apple.provenance, which codesign rejects as detritus and which that
# lineage cannot strip. Run the sign + stage + TCC-reset sequence from a shell outside that lineage —
# Terminal.app is the expected one (untested; the script prints "attrs left", which must be 0): xattr -cr the .app, sign Sparkle helpers → Sparkle.framework → MacOS binary
# (--entitlements) → .app, `codesign --verify --strict`, ditto into ~/.local/share/interceptor,
# `tccutil reset Accessibility com.interceptor.bridge && tccutil reset ScreenCapture com.interceptor.bridge`,
# kickstart, then re-grant both in System Settings. Verify: `codesign -dv <app>` shows the identity.

# On a machine whose checkout sits under a cloud-synced path (detritus on Sparkle's Downloader.xpc
# from ANY shell, or a fresh clone missing Sparkle): References/UpdateRecovery.md § Bridge build on a cloud-synced machine.

# 1. Stage the .app bundle (no sudo — lives under $HOME)
mkdir -p ~/.local/share/interceptor
rm -rf ~/.local/share/interceptor/interceptor-bridge.app
cp -R "$INTERCEPTOR_SRC"/dist/interceptor-bridge.app \
      ~/.local/share/interceptor/interceptor-bridge.app

# 2. Write LaunchAgent plist into $HOME (no sudo) — points at the .app MacOS binary
cat > ~/Library/LaunchAgents/com.interceptor.bridge.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.interceptor.bridge</string>
    <key>ProgramArguments</key><array><string>$HOME/.local/share/interceptor/interceptor-bridge.app/Contents/MacOS/interceptor-bridge</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
    <key>StandardOutPath</key><string>/tmp/interceptor-bridge.stdout.log</string>
    <key>StandardErrorPath</key><string>/tmp/interceptor-bridge.stderr.log</string>
    <key>ThrottleInterval</key><integer>5</integer>
</dict>
</plist>
PLIST

# 3. Load it as the user (no sudo — uid is captured at script-call time)
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.interceptor.bridge.plist
```

`launchctl bootstrap` exits 1 on success — that's fine; verify with 6b.

##### 6b. Verify, and restart a dead bridge

`launchctl list` showing the label only proves the agent is loaded; probe the process with `interceptor status`.

```bash
interceptor status | grep -A2 '^bridge:'          # running + pid/socket, or not running
launchctl print "gui/$(id -u)/com.interceptor.bridge" 2>&1 | grep -E 'state|program|pid'
ls -la "${TMPDIR}interceptor-bridge.sock"         # → srwxr-xr-x <user> staff
```

From 1.0.1 the socket is at `$TMPDIR/interceptor-bridge.sock` (step 5); a bridge one release behind may still sit at the legacy `/tmp` path, so check whichever path `interceptor status` reports. Restart a loaded-but-dead bridge (if it dies again on startup: `References/UpdateRecovery.md` § Bridge troubleshooting):

```bash
launchctl kickstart -k "gui/$(id -u)/com.interceptor.bridge"
```

`interceptor status --verbose` reports extension **reachability** only — it does NOT expose an extension-build version field, so don't try to key a freshness check off it. With 2+ contexts connected it will nag `not reachable — multiple extensions connected` even with `--context` passed; that's expected, not a failure.

##### 6c. First-run config

```bash
interceptor init                       # Writes starter ~/.config/interceptor/config.toml
interceptor contexts                   # Lists connected browser contexts
interceptor macos trust                # Probes TCC grants for the bridge
interceptor macos trust --walkthrough  # Deep-links to System Settings for missing grants
```

The `trust` probe keys are `accessibility`, `screenRecording`, `microphone` and `speechRecognition` (verified on 1.0.21); there is no `inputMonitoring` field.

##### 6d. Troubleshoot

Symptom → cause → fix table for a bridge that will not load, run or update: `References/UpdateRecovery.md` § Bridge troubleshooting.

##### 6e. Uninstall

Commands to boot out the agent, remove the plist, the `.app` bundle, the stale `/usr/local/bin` copy, and the socket, pid and log files: `References/UpdateRecovery.md` § Bridge uninstall.

#### 7. Reload the extension without touching the operator’s Chrome

Chrome won't auto-refresh an unpacked extension, so reload whenever `Extension/manifest.json` changed (especially `version` or `key`). Zero-touch first (verified 0.23.16 → 0.24.2, 2026-09-06):

```bash
interceptor reload --context "$INTERCEPTOR_TEST_CONTEXT_ID"     # chrome.runtime.reload() in the test context only; context id survives
interceptor diagnose --no-skills-hint                          # expect: extension: connected  (extension <version>)
```

**Manifest `key` change (0.24.2 → 1.0.1, verified 2026-09-14 on the maintainer machine):** the same `reload --context` still works. Chrome re-registers the unpacked copy under the new store ID (`gomcpnagjjlhehnkoobkjgnkbleiooed`) with EMPTY settings, so the context comes back under a fresh UUID. Restore the pinned name with `interceptor contexts rename "$INTERCEPTOR_TEST_CONTEXT_ID" --context <fresh-uuid>` (name is the positional, the target is the flag) and confirm with `interceptor contexts --verbose`. No chrome://extensions visit, no Remove + Load unpacked. The NMH must already list the new ID (step 5) BEFORE the reload.

Manual fallback, only if the card comes back disabled or missing after the zero-touch reload: the six steps in `References/UpdateRecovery.md` § Extension manual reload (Remove the card, Load unpacked from `~/.claude/skills/Interceptor/Extension`, re-pin the `interceptor-test` context). A signed `.pkg` install already registered the extension.

If only JS/HTML inside the extension dir changed (no manifest changes), clicking the reload arrow on the existing card is enough.

### End-to-end check (both paths)

```bash
interceptor --version
interceptor status
interceptor status --verbose
interceptor contexts
interceptor diagnose --no-skills-hint    # 0.22.2+: daemon exec path, per-context probe, split-brain check
bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/PreflightIsolation.sh"   # nonzero = stop; the test context is not connected
source "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env"  # INTERCEPTOR_TEST_CONTEXT_ID
interceptor open "https://example.com" --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```

`status` reports both `daemon` and `bridge` lines (bridge shows "not running" under `--browser-only`, which is fine). `diagnose` prints the daemon's real exec path and flags a **binary split-brain** (Chrome spawns one daemon binary while the CLI talks to another). On a mismatch, point the NMH manifest `path` at `/opt/homebrew/bin/interceptor-daemon` and restart the singleton by pid (`kill "$(interceptor status | awk '/^daemon:/{d=1;next} d && /^pid:/{print $2; exit}')"` — never `pkill -f interceptor-daemon`, which also kills Chrome's relay daemon; public issue #2011, @dsather). Bridge-signing, cloud-sync and launchd-throttle recovery are in 6a and 6d.

## Gotchas

- **Unknown flags are rejected on browser commands from 0.23.30** (exit 1; `INTERCEPTOR_LAX_FLAGS=1` downgrades the rejection to a warning). `screenshot --out` was one of them — `Tools/Capture.sh` no longer passes it and stages captures in a private cwd instead. If a one-off command or an older wrapper still sends a dropped flag after an upgrade, set `INTERCEPTOR_LAX_FLAGS=1` only while you fix the caller. *(public PR #2015, @mj-deving.)*
