#!/usr/bin/env bash
# LaunchTestProfile.sh — open Chrome's dedicated non-default profile in its own window.
#
# Why this exists: the operator's Default Chrome profile holds the tabs they're actively
# working in (and the tabs their DA has been driving). Routine live testing goes to a
# separate Chrome profile so the agent never disturbs that window — BUT the test profile
# is signed into the accounts the tooling under test needs, so live testing of
# authenticated tooling actually works.
#
# Mechanism: --profile-directory tells the existing Chrome installation which profile
# sub-directory to use. Same Chrome process tree, same root certificates, same native
# messaging hosts — different cookies, different tabs, different window. The operator
# creates the profile once via Chrome's avatar menu (top-right corner) and signs it into
# whichever accounts the agent needs to test against.
#
# This is the correct isolation boundary: separate WINDOW + separate COOKIE JAR, not
# separate user-data-dir. A `--user-data-dir` would be a fully sandboxed Chrome with no
# sessions — useless for verifying authenticated tools.

set -euo pipefail

if [ "${CODEX_SANDBOX:-}" = "seatbelt" ]; then
    echo "[LaunchTestProfile] Codex sandbox blocks macOS desktop services. Re-run this command through approved execution outside the sandbox; no browser was launched." >&2
    exit 10
fi

# Source per-machine USER customizations so INTERCEPTOR_TEST_CHROME_PROFILE
# resolves from the single canonical home (preferences.env), not a guessed
# default. The preflight sources this too; this script must not rely on the
# preflight having run first.
USER_PREFS="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env"
if [ -f "$USER_PREFS" ]; then
    # shellcheck disable=SC1090
    . "$USER_PREFS"
fi

# NO default profile. Defaulting to any concrete profile name (e.g. "Profile 1")
# is a working-profile-leak vector — on a machine where the test profile has a
# different index, Profile 1 may be a working profile. Refuse rather than
# guess: opening the wrong --profile-directory drops a tab in the operator's
# monitoring window.
CHROME_PROFILE="${INTERCEPTOR_TEST_CHROME_PROFILE:-}"
BROWSER="${INTERCEPTOR_TEST_BROWSER:-Google Chrome}"
START_URL="${1:-about:blank}"

# Cold-start placement. --window-position/--window-size are read from the browser
# process's OWN command line, so they only take effect when this launch starts the
# browser; forwarded through a running instance's singleton they are ignored. The
# running-instance case is covered by Tools/PinTestWindow.sh, which EnsureTestProfile.sh
# runs on every READY. Same var for both: INTERCEPTOR_TEST_WINDOW_BOUNDS="l,t,w,h".
WIN_ARGS=()
if [ -n "${INTERCEPTOR_TEST_WINDOW_BOUNDS:-}" ]; then
    IFS=, read -r _L _T _W _H <<EOF
${INTERCEPTOR_TEST_WINDOW_BOUNDS}
EOF
    if [[ "$_L" =~ ^-?[0-9]+$ && "$_T" =~ ^-?[0-9]+$ && "$_W" =~ ^[0-9]+$ && "$_H" =~ ^[0-9]+$ ]]; then
        WIN_ARGS=("--window-position=${_L},${_T}" "--window-size=${_W},${_H}")
    fi
fi

if [ -z "$CHROME_PROFILE" ]; then
    cat >&2 <<EOF
LaunchTestProfile.sh: FAIL — no test profile configured.

  INTERCEPTOR_TEST_CHROME_PROFILE is unset/empty. Set it in
    ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env
  to the dedicated Interceptor test profile's on-disk directory name (e.g.
  "Profile N" — map directory -> friendly name via
  ~/Library/Application Support/Google/Chrome/Local State, profile.info_cache).

  Refusing to launch: defaulting to any concrete profile could open the
  operator's working/monitoring profile by accident.
EOF
    exit 2
fi

case "$(uname -s)" in
    Darwin)
        # Direct binary, not `open -a … --args`: when the browser is ALREADY
        # RUNNING, `open` silently drops the --args (macOS behavior), so the
        # profile window never opens and the isolation gate times out waiting
        # for the context. Invoking the binary directly forwards the args to
        # the running instance via Chrome's process singleton — the profile
        # window opens whether or not the browser was already up.
        # (Public PR #1487, credit @anikinsasha.)
        CHROME_BIN="${INTERCEPTOR_TEST_BROWSER_BIN:-/Applications/${BROWSER}.app/Contents/MacOS/${BROWSER}}"
        if [ -x "$CHROME_BIN" ]; then
            "$CHROME_BIN" \
                --profile-directory="$CHROME_PROFILE" \
                --new-window ${WIN_ARGS[@]+"${WIN_ARGS[@]}"} \
                "$START_URL" >/dev/null 2>&1 &
            exit 0
        fi
        # Fallback (binary not at the expected path): reliable only when the
        # browser is not already running.
        exec open -a "$BROWSER" --args \
            --profile-directory="$CHROME_PROFILE" \
            --new-window ${WIN_ARGS[@]+"${WIN_ARGS[@]}"} \
            "$START_URL"
        ;;
    Linux)
        # Honor the same override the Darwin branch reads (public issue #1971, @bytebyrobert).
        CHROME_BIN="${CHROME_BIN:-${INTERCEPTOR_TEST_BROWSER_BIN:-google-chrome}}"
        # Background it like Darwin: on a cold start this process IS the browser,
        # and a foreground exec blocks EnsureTestProfile's connect poll until
        # Chrome quits. public issue #2218, @corobis
        "$CHROME_BIN" \
            --profile-directory="$CHROME_PROFILE" \
            --new-window ${WIN_ARGS[@]+"${WIN_ARGS[@]}"} \
            "$START_URL" >/dev/null 2>&1 &
        exit 0
        ;;
    *)
        echo "LaunchTestProfile.sh: unsupported OS $(uname -s)" >&2
        exit 1
        ;;
esac
