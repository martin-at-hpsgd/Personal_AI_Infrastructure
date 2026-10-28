#!/usr/bin/env bash
# EnsureTestProfile.sh — make the Interceptor test context available, auto-launching
# the CONFIGURED test profile window only when it is genuinely not open.
#
# WHY THIS IS SAFE (the invariant that reverses the old "never auto-launch" rule):
#   We ONLY ever succeed (exit 0) after PreflightIsolation.sh itself exits 0, which
#   whole-field-matches the connected context against INTERCEPTOR_TEST_CONTEXT_ID and
#   hard-denies Default/working profiles. So launching the WRONG window can never cause
#   the agent to drive it — preflight would still fail and this script would still stop.
#   The safety comes from the post-launch RE-VERIFICATION loop, not from trusting the
#   --profile-directory argument. Exit 7 (resolved target IS Default/working) and exit 8
#   (test context unset) NEVER trigger a launch.
#
# WHY IT NO LONGER LAUNCHES ON EVERY DISCONNECT (2026-09-06, the window storm):
#   Preflight exit 5/6 means "the pinned context is not connected RIGHT NOW", which is
#   also what a daemon restart, an extension reload, or a service-worker recycle looks
#   like for a few seconds. The old script launched a new `--new-window` on the first
#   miss, so every flap across five parallel sessions produced another blank window in
#   the test profile. Three guards now sit between a miss and a launch, in order:
#     1. GRACE   — poll the gate for INTERCEPTOR_ENSURE_GRACE_S before deciding anything;
#                  a transient disconnect recovers here with zero launches.
#     2. WINDOW  — ask the macOS bridge whether a window of the test profile already
#                  exists (title suffix "- <Browser> - <ProfileName>"). If it does, the
#                  context will reconnect on its own or the extension is dead; either way
#                  a second window is never the fix. Wait, then surface. Advisory: when
#                  the bridge is absent, errors, or lists nothing, the answer is UNKNOWN
#                  and the lock below is the guard — never an automatic launch decision.
#     3. LOCK    — one launch per INTERCEPTOR_ENSURE_LAUNCH_COOLDOWN_S machine-wide
#                  (/tmp lock dir, mkdir-atomic). A second session inside the cooldown
#                  waits for the first session's launch to connect instead of launching.
#
# Contract: prints "READY" to stdout + exits 0 when the pinned test context is connected
# and safe. On any non-recoverable condition, surfaces the preflight remediation to
# stderr and exits with preflight's own code. Never falls back to Default. Never narrates.
#
# Usage:  bash Tools/EnsureTestProfile.sh        # ensure ready, auto-launch if needed
#         EnsureTestProfile.sh && interceptor open <url> --context "$INTERCEPTOR_TEST_CONTEXT_ID"
#
# Tunables (env or preferences.env): INTERCEPTOR_ENSURE_POLL_S (2), INTERCEPTOR_ENSURE_GRACE_S (12),
#   INTERCEPTOR_ENSURE_WINDOW_WAIT_S (30), INTERCEPTOR_ENSURE_CONNECT_WAIT_S (18),
#   INTERCEPTOR_ENSURE_LAUNCH_COOLDOWN_S (90), INTERCEPTOR_TEST_CHROME_PROFILE_NAME (the profile's
#   display name as Chrome shows it in window titles, e.g. "Interceptor"; unset = window probe skipped).
# Test seams (never set outside Tests/): INTERCEPTOR_ENSURE_PREFS, INTERCEPTOR_ENSURE_PREFLIGHT,
#   INTERCEPTOR_ENSURE_LAUNCHER, INTERCEPTOR_ENSURE_LOCK_DIR, INTERCEPTOR_ENSURE_PIN.
# Placement: every READY runs Tools/PinTestWindow.sh (INTERCEPTOR_TEST_WINDOW_BOUNDS; no-op unset).

set -uo pipefail

# A restricted Codex shell cannot reach the desktop services; retrying launches
# Chrome into that same sandbox and aborts during application registration.
if [ "${CODEX_SANDBOX:-}" = "seatbelt" ]; then
    echo "[EnsureTestProfile] Codex sandbox blocks macOS desktop services. Re-run this command through approved execution outside the sandbox; no browser was launched." >&2
    exit 10
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFS="${INTERCEPTOR_ENSURE_PREFS:-${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env}"
# shellcheck disable=SC1090
[ -f "$PREFS" ] && . "$PREFS"

PREFLIGHT="${INTERCEPTOR_ENSURE_PREFLIGHT:-$DIR/PreflightIsolation.sh}"
LAUNCH="${INTERCEPTOR_ENSURE_LAUNCHER:-$DIR/LaunchTestProfile.sh}"
LOCK="${INTERCEPTOR_ENSURE_LOCK_DIR:-/tmp/interceptor-ensure-launch.lock}"
POLL_S="${INTERCEPTOR_ENSURE_POLL_S:-2}"
GRACE_S="${INTERCEPTOR_ENSURE_GRACE_S:-12}"
WINDOW_WAIT_S="${INTERCEPTOR_ENSURE_WINDOW_WAIT_S:-30}"
CONNECT_WAIT_S="${INTERCEPTOR_ENSURE_CONNECT_WAIT_S:-18}"
COOLDOWN_S="${INTERCEPTOR_ENSURE_LAUNCH_COOLDOWN_S:-90}"
BROWSER="${INTERCEPTOR_TEST_BROWSER:-Google Chrome}"
PROFILE="${INTERCEPTOR_TEST_CHROME_PROFILE:-}"
PROFILE_NAME="${INTERCEPTOR_TEST_CHROME_PROFILE_NAME:-}"

TMP="$(mktemp -t interceptor-ensure.XXXXXX)"
trap 'rm -f "$TMP"' EXIT

log() { echo "[EnsureTestProfile] $*" >&2; }

# Every READY exit passes through here. The pin snaps any drifted window of the PINNED test
# context back to INTERCEPTOR_TEST_WINDOW_BOUNDS (Tools/PinTestWindow.sh; no-op when unset).
# It is advisory: a pin failure never turns a READY into a failure.
PIN="${INTERCEPTOR_ENSURE_PIN:-$DIR/PinTestWindow.sh}"
ready() {
    [ -f "$PIN" ] && INTERCEPTOR_PIN_PREFS="$PREFS" bash "$PIN" || true
    cat "$TMP" >&2
    if [ $# -gt 0 ]; then echo "READY ($1)"; else echo "READY"; fi
    exit 0
}

# Run the isolation gate; capture its output + exit code.
run_preflight() { bash "$PREFLIGHT" >"$TMP" 2>&1; return $?; }

# Poll the gate for up to $1 seconds. 0 = connected (READY is the caller's to print).
# LAST_RC keeps each poll's own exit code. Anything other than 0, 5 or 6 (for example a newly
# fatal 7 = Default/working target, or 8 = test context unset) ends the wait at once and the
# caller surfaces it through bail_if_fatal: it never turns into a launch.
LAST_RC=0
wait_for_context() {
    local budget="$1" waited=0
    while true; do
        run_preflight; LAST_RC=$?
        [ "$LAST_RC" -eq 0 ] && return 0
        if [ "$LAST_RC" -ne 5 ] && [ "$LAST_RC" -ne 6 ]; then return 1; fi
        # awk keeps fractional seconds portable (macOS bash 3.2 has no float arithmetic).
        if awk -v w="$waited" -v p="$POLL_S" -v b="$budget" 'BEGIN{ exit !((w + p) > b) }'; then
            return 1
        fi
        sleep "$POLL_S"
        waited="$(awk -v w="$waited" -v p="$POLL_S" 'BEGIN{ print w + p }')"
    done
}

# After a failed wait_for_context: a non-recoverable preflight code stops the script untouched.
bail_if_fatal() {
    if [ "$LAST_RC" -ne 5 ] && [ "$LAST_RC" -ne 6 ]; then
        log "preflight exit $LAST_RC appeared while waiting and is not a launchable condition — surfacing, not launching."
        cat "$TMP" >&2
        exit "$LAST_RC"
    fi
}

# Does a window of the test profile already exist?
#   0 = yes   1 = no (Chrome windows listed, none carry the profile suffix)   2 = unknown
# Chrome titles its windows "<page> - <Browser> - <Profile display name>"; the bridge's
# window list is the only focus-free way to read them (Local State is not readable from a
# sandboxed shell). Any error, empty list, or unset profile name is UNKNOWN, never "no".
test_window_open() {
    [ -n "$PROFILE_NAME" ] || return 2
    command -v interceptor >/dev/null 2>&1 || return 2
    local out
    out="$(interceptor macos windows --app "$BROWSER" 2>/dev/null)" || return 2
    printf '%s' "$out" | grep -q '"title"' || return 2
    if printf '%s' "$out" | grep -F -q -- "- ${BROWSER} - ${PROFILE_NAME}\""; then
        return 0
    fi
    return 1
}

lock_age_s() {
    local m now
    m="$(stat -f %m "$LOCK" 2>/dev/null || stat -c %Y "$LOCK" 2>/dev/null)" || { echo 999999; return; }
    now="$(date +%s)"
    echo $(( now - m ))
}

# --- 0. the gate, once ---------------------------------------------------------------
run_preflight; rc=$?
if [ "$rc" -eq 0 ]; then
    ready
fi

# Only "context not connected" conditions are recoverable here.
#   5 = no contexts connected at all   6 = pinned test context not connected
# Everything else (7 target-deny, 8 unset config, 2/3/4 binary/version, 9 no extension)
# surfaces and stops.
if [ "$rc" -ne 5 ] && [ "$rc" -ne 6 ]; then
    log "preflight exit $rc is not a launchable condition — surfacing, not launching."
    cat "$TMP" >&2
    exit "$rc"
fi

# --- 1. GRACE: a transient disconnect recovers on its own ---------------------------
log "test context not connected (exit $rc) — waiting up to ${GRACE_S}s for it to reconnect before touching any window…"
if wait_for_context "$GRACE_S"; then
    ready "reconnected without a launch"
fi
bail_if_fatal

# --- 2. WINDOW: never open a second window of the test profile -----------------------
test_window_open; win=$?
if [ "$win" -eq 0 ]; then
    log "a \"$PROFILE_NAME\" window of $BROWSER is already open but its Interceptor context is not connected — NOT launching another. Waiting up to ${WINDOW_WAIT_S}s for the extension to reconnect…"
    if wait_for_context "$WINDOW_WAIT_S"; then
        ready "existing window reconnected"
    fi
    bail_if_fatal
    cat "$TMP" >&2
    log "the test-profile window is open, but the pinned context never connected within ${WINDOW_WAIT_S}s."
    log "  The extension in that window is dead, disabled, or re-registered under a new ID — a second window cannot fix that."
    log "  Check: interceptor diagnose --no-skills-hint   (extension: connected?)"
    log "  Then, in the test-profile window: chrome://extensions → Interceptor → reload; if the card is disabled or missing,"
    log "  Load Unpacked from the pinned Extension/ dir and set Context ID = \"interceptor-test\" in the popup (re-pin)."
    log "  Not launching — a duplicate window is the failure this script exists to prevent."
    exit 6
fi
[ "$win" -eq 2 ] && log "window probe unavailable (bridge absent, no windows listed, or INTERCEPTOR_TEST_CHROME_PROFILE_NAME unset) — relying on the launch lock."

# --- 3. LOCK: one launch per cooldown, machine-wide ---------------------------------
if [ -z "$PROFILE" ]; then
    log "test context not connected (exit $rc) AND INTERCEPTOR_TEST_CHROME_PROFILE is unset —"
    log "  cannot auto-launch. Set it in $PREFS to the test profile's on-disk dir (e.g. \"Profile 2\")."
    cat "$TMP" >&2
    exit "$rc"
fi

# The cooldown check, the stale-lock takeover and the lock creation run as ONE step under a
# short-lived guard (mkdir-atomic). Without it two sessions can both see an expired lock; one
# replaces it and starts launching, and the other then deletes that fresh lock and launches too.
GUARD="${LOCK}.guard"
GUARD_STALE_S=30
HAVE_GUARD=0
release_guard() { if [ "$HAVE_GUARD" -eq 1 ]; then rmdir "$GUARD" 2>/dev/null || true; HAVE_GUARD=0; fi; }
trap 'rm -f "$TMP"; release_guard' EXIT
acquire_guard() {
    local tries=0
    while ! mkdir "$GUARD" 2>/dev/null; do
        # A guard older than GUARD_STALE_S belongs to a crashed holder (the critical section is a few syscalls).
        local gm gnow
        gm="$(stat -f %m "$GUARD" 2>/dev/null || stat -c %Y "$GUARD" 2>/dev/null)" || gm=""
        gnow="$(date +%s)"
        if [ -n "$gm" ] && [ $(( gnow - gm )) -gt "$GUARD_STALE_S" ]; then rmdir "$GUARD" 2>/dev/null || true; continue; fi
        tries=$(( tries + 1 ))
        [ "$tries" -gt 100 ] && return 1
        sleep 0.1
    done
    HAVE_GUARD=1
    return 0
}

LAUNCH_OWNER=0
if acquire_guard; then
    if [ -d "$LOCK" ] && [ "$(lock_age_s)" -lt "$COOLDOWN_S" ]; then
        release_guard
    else
        # Stale lock (older than the cooldown) is taken over inside the guard; nobody can interleave.
        [ -d "$LOCK" ] && rm -rf "$LOCK"
        if mkdir "$LOCK" 2>/dev/null; then
            date -u +%Y-%m-%dT%H:%M:%SZ > "$LOCK/launched-at" 2>/dev/null || true
            LAUNCH_OWNER=1
        fi
        release_guard
    fi
fi

if [ "$LAUNCH_OWNER" -ne 1 ]; then
    if [ -d "$LOCK" ]; then
        log "another session launched the test profile $(lock_age_s)s ago (cooldown ${COOLDOWN_S}s) — waiting for that window to connect instead of launching again…"
    else
        log "a sibling session is launching right now — waiting for its window to connect…"
    fi
    if wait_for_context "$CONNECT_WAIT_S"; then
        ready "joined a launch in progress"
    fi
    bail_if_fatal
    cat "$TMP" >&2
    log "a launch $(lock_age_s)s ago has not produced the pinned context. Not launching again inside the cooldown."
    log "  Check: interceptor diagnose --no-skills-hint; if the window is open, re-pin per the remediation above."
    exit 6
fi

# --- 4. LAUNCH, exactly once -----------------------------------------------------------
log "no test-profile window found — launching \"$PROFILE\" and waiting up to ${CONNECT_WAIT_S}s for it to connect…"
# LaunchTestProfile.sh opens ONLY the configured profile and refuses to guess a default.
if ! bash "$LAUNCH" "about:blank" >/dev/null 2>&1; then
    log "LaunchTestProfile.sh failed to launch \"$PROFILE\" — surfacing."
    exit "$rc"
fi

if wait_for_context "$CONNECT_WAIT_S"; then
    ready "auto-launched"
fi
bail_if_fatal

# Launched, but the pinned context never connected within the window. Almost always UUID rot
# (the extension was removed and re-added → its storage key was wiped → a NEW context UUID;
# a plain Reload keeps it). Do NOT proceed on an unverified context.
cat "$TMP" >&2
log "launched \"$PROFILE\" but the pinned test context did not connect within ${CONNECT_WAIT_S}s."
log "  Most likely UUID rot: the Interceptor extension was removed + re-added and the test profile now has a NEW context ID."
# Name and UUID share one storage key (public issue #2010, @dsather): neither survives Remove + Load
# Unpacked; the name is simply re-typed, which is the whole reason to pin it. No auto-rebind exists.
log "  Re-pin by hand (a name can be re-typed after a wipe; a UUID cannot):"
log "    1. In the test-profile window, click the Interceptor toolbar icon."
log "    2. Set Context ID = \"interceptor-test\" → Save."
log "    3. Set INTERCEPTOR_TEST_CONTEXT_ID=\"interceptor-test\" in $PREFS."
log "  Not proceeding — never drive an unverified context (it could be the operator's window)."
exit 6
