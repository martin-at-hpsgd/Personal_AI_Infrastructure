# Update Recovery

**Contents:** Daemon handoff recovery · Pin.sh fails on Finder-duplicate cruft · Bridge build on a cloud-synced machine · Bridge troubleshooting · Bridge uninstall · Extension manual reload · Background

> Conditional material for `Intents/Update.md` (Path B, from source): recovery when a step's check fails, the uninstall, and background on choices the intent makes. Each section names the Update step it belongs to.

## Daemon handoff recovery

Step 3 (install binaries atomically), when launchd refuses the new daemon or the kickstart loses the port race.

**Gotcha (1.0.7 → 1.0.21, 2026-09-29, macOS 27): `OS_REASON_CODESIGNING` + `needs LWCR update`.** After the atomic swap launchd refused the new ad-hoc daemon (`job state = spawn failed`, properties `managed LWCR`), and Chrome's relay spawned a `--standalone` in the gap. Fix: `launchctl bootout gui/$(id -u)/com.interceptor.daemon && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.interceptor.daemon.plist` (re-records the requirement), then kill the standalone by pid, wait for it to exit, and `kickstart -k`.

**Gotcha (1.0.1 → 1.0.7, 2026-09-21):** the one-liner above lost the race anyway. `kill` returns before the old singleton releases the port, so the kickstarted daemon exited 0 and the next CLI call spawned a `--standalone`. If launchd reads `state = not running` afterwards, wait for the old pid to exit before kickstarting, with no `interceptor` call in between:

```bash
P="$(interceptor status | awk '/^daemon:/{d=1;next} d && /^pid:/{print $2; exit}')"
kill "$P"; while kill -0 "$P" 2>/dev/null; do sleep 0.2; done; launchctl kickstart -k "gui/$(id -u)/com.interceptor.daemon"
```

## Pin.sh fails on Finder-duplicate cruft

Step 4 (pin the built extension), when `Pin.sh` exits non-zero mid-run.

**Gotcha (2026-08-07, 0.22.37 → 0.23.3):** `extension/dist/` is gitignored, so macOS Finder-duplicate cruft (`icon128 3.png`, `tesseract-core-simd-lstm 2.wasm` — a space then a digit before the extension) can accumulate there across builds. `bun run build` does NOT remove it. Those spaces break `Pin.sh`'s `xargs shasum` content-hash loop (line 56, unquoted), so Pin.sh dies under `set -e` **after** rsyncing the new manifest into `Extension/` but **before** rewriting `PINNED_FROM.txt` — leaving the pin inconsistent (new manifest, stale `PINNED_FROM.txt` version + SHA). Clean the cruft from source first, then re-pin:

```bash
find "$INTERCEPTOR_SRC"/extension/dist \( -name "* 2.*" -o -name "* 3.*" \) -delete
bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/Pin.sh"   # exit 0, prints "✓ pinned + scrubbed (v<X>, sha …)"
```

(Durable fix would quote line 56's loop like the leak-guard's `-print0` at line 69.)

## Bridge build on a cloud-synced machine

Step 6a, when the source checkout sits under a cloud-synced path and `codesign` reports detritus on Sparkle's `Downloader.xpc` from every shell.

```bash
# VERIFIED PATH (2026-09-29, 1.0.21): when the checkout sits under a cloud-synced folder (e.g. iCloud Drive),
# the File Provider stamps FinderInfo + fileprovider xattrs on every build file and codesign
# fails on Sparkle's Downloader.xpc ("detritus not allowed") from ANY shell. Build the bridge from
# a local-disk clone at the same commit instead: ~/.local/src/interceptor (git checkout <sha>).
# Run the build + sign + ditto-stage + tccutil reset + kickstart from Terminal.app
# (`osascript -e 'tell application "Terminal" to do script "bash <script>; exit"'`).
# Fresh-clone gotcha: build-bridge.sh looks for Sparkle only at
# .build/arm64-apple-macosx/release/Sparkle.framework, but the newer SwiftPM build puts it at
# .build/out/Products/Release/Sparkle.framework; without a ditto into the expected path the bundle
# ships with no Sparkle and launchd exits OS_REASON_DYLD. Result: TeamIdentifier set,
# `codesign --verify --strict` OK; TCC grants need one re-grant, then survive later rebuilds.
```

## Bridge troubleshooting

Step 6d, when 6b shows the bridge not running, restart-looping, or a VM command returns `setup_required`.

If `interceptor status` shows `bridge: not running` while `launchctl print` shows the agent loaded, the helper crashed on startup: check `/tmp/interceptor-bridge.stderr.log`, confirm the plist points at the `.app` MacOS binary (not the stale `/usr/local/bin` copy), then `kickstart -k`.

| Symptom | Cause | Fix |
|---------|-------|-----|
| `launchctl bootstrap` says "service already loaded" | Prior install lingering | `launchctl bootout "gui/$(id -u)/com.interceptor.bridge"` then re-bootstrap |
| `interceptor status` shows bridge not running | First-action TCC prompt blocked | Trigger any `act --trusted` once, accept macOS prompts in System Settings → Privacy & Security (Accessibility) |
| Socket exists but writes fail | macOS quarantine on the binary | `xattr -dr com.apple.quarantine ~/.local/share/interceptor/interceptor-bridge.app` |
| Bridge restart-loops every ~5s (`ThrottleInterval`) | Crash on launch, usually a missing entitlement or a stale ad-hoc signature on the binary the agent actually runs | `tail /tmp/interceptor-bridge.stderr.log`; re-sign the `.app` MacOS binary (`~/.local/share/interceptor/interceptor-bridge.app/Contents/MacOS/interceptor-bridge`), NOT the `/usr/local/bin` copy, then `launchctl kickstart -k "gui/$(id -u)/com.interceptor.bridge"` |
| "Update Error! An error occurred while running the updater" popup | Sparkle auto-check offered an upstream release; its signed pkg can't install over our self-signed bridge | `defaults write com.interceptor.bridge SUEnableAutomaticChecks -bool false`; update via `Intents/Update.md` instead |
| `dyld[*]: Library not loaded: @rpath/Sparkle.framework/...` in stderr | Sparkle.framework missing | Ditto Sparkle into the path `build-bridge.sh` expects (the fresh-clone note in § Bridge build on a cloud-synced machine), rebuild, then `launchctl kickstart -k "gui/$(id -u)/com.interceptor.bridge"` |
| `setup_required: virtualization entitlement missing` on VM commands | Bridge needs `com.apple.security.virtualization` | Rebuild with `scripts/build-bridge.sh`; verify entitlement is present |
| `setup_required: bridge install location` on VM commands | Bridge installed under `~/Documents` or `~/Desktop` | Move bridge `.app` outside cloud-synced dirs |

## Bridge uninstall

Step 6e.

```bash
launchctl bootout "gui/$(id -u)/com.interceptor.bridge"
rm ~/Library/LaunchAgents/com.interceptor.bridge.plist
rm -rf ~/.local/share/interceptor/interceptor-bridge.app   # the bundle the agent actually runs
sudo rm -f /usr/local/bin/interceptor-bridge               # remove the stale copy if a prior install left one
sudo rm -rf /usr/local/Frameworks/Sparkle.framework        # only if a prior install staged it here
rm -f "${TMPDIR}interceptor-bridge.sock" "${TMPDIR}interceptor-bridge.pid"
rm -f /tmp/interceptor-bridge.sock /tmp/interceptor-bridge.pid   # legacy path, pre-1.0.1 bridges
rm -f /tmp/interceptor-bridge.stdout.log /tmp/interceptor-bridge.stderr.log
```

Optional: revoke macOS permissions in System Settings → Privacy & Security (Accessibility, Screen Recording, Microphone) by removing the `interceptor-bridge` entry from each list.

## Extension manual reload

Step 7, only if the card comes back disabled or missing after the zero-touch `interceptor reload`.

1. Open `chrome://extensions`, enable Developer Mode.
2. **Delete** the existing Interceptor card (don't just hit reload — if the manifest `key` changed, the extension ID changed and the old card is dead).
3. **Load unpacked** → `~/.claude/skills/Interceptor/Extension` (the copy `Tools/Pin.sh` created in step 4 — NOT a symlink; it does not auto-follow upstream, so it must be re-pinned after every build). A signed `.pkg` install already registered the extension — skip this step.
4. Accept any new permission prompts (`userScripts`, etc.).
5. **Re-pin the context.** Remove + Load Unpacked wipes the extension's `chrome.storage.local`, and the context ID (name or UUID — one key) goes with it. Click the Interceptor toolbar icon in the test-profile window, set Context ID to `interceptor-test`, Save, and confirm `INTERCEPTOR_TEST_CONTEXT_ID` in `preferences.env` matches. There is no auto-rebind: until this is done `Capture.sh` exits 6 at preflight. A plain Reload keeps the key, so this step is only needed after a Remove. *(public issue #2010, @dsather.)*

## Background

The old local 10M-slice patch on `extension/src/content/data/extract.ts` is obsolete since v0.13.0 (upstream `withTruncationMarker` + per-action `maxChars`): `read` now appends `... (truncated: showed X of Y chars ...)` when capped, and `read --full` widens to 200 K. Drop it if it is still in your stash.

**Why not `interceptor update` (0.23.x):** the top-level self-updater (user-initiated check + Sparkle background auto-check; `interceptor update status` shows the feed) replaces `/opt/homebrew/bin` binaries underneath the `com.interceptor.daemon` LaunchAgent and the pinned extension, skipping the atomic install, the re-pin and the reload. There are no local patches to protect (stock upstream since 2026-09-06): build from source per Path B, or install the signed pkg deliberately as one motion.

Sparkle and the self-signed bridge (step 6a): a self-signed bundle no longer accepts Sparkle updates from the upstream feed (different identity) — expected; the Update intent is the update path. The built Info.plist still ships SUEnableAutomaticChecks=true, so Sparkle finds each upstream release, and clicking Install ends in "Update Error! An error occurred while running the updater" (the guided-pkg installer rejects the ad-hoc/self-signed host). Keep the per-user override off; Sparkle reads user defaults before Info.plist, and the domain survives rebuilds (2026-09-29).

**Sparkle auto-update** (v0.10.0+) — the `.app` bundle includes Sparkle for in-place updates. The bridge polls upstream feed on launch.
