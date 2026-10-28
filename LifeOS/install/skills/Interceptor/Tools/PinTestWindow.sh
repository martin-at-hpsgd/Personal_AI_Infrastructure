#!/usr/bin/env bash
# PinTestWindow.sh — snap the Interceptor test-profile window back to its home bounds.
#
# WHY: LaunchTestProfile.sh opens the test profile with --new-window and no position, so
# Chrome drops each new window wherever the last-active window was, and nothing ever put it
# back. The operator keeps a fixed spot for the test window (so a glance tells whose browser
# is whose); a drifted window reads as "the wrong browser" on the wrong screen. This script
# makes the placement idempotent: every time the test context is confirmed READY, any normal
# window of that context that is not at its home bounds is moved there.
#
# SAFETY: only windows of the PINNED context (INTERCEPTOR_TEST_CONTEXT_ID) are listed or
# moved, via the extension's own window API (`interceptor window list|resize --context`).
# The operator's working profiles are never enumerated, and no osascript is involved.
# Unset bounds = no-op (the public skill ships generic; bounds are per-machine).
#
# Config (preferences.env):
#   INTERCEPTOR_TEST_WINDOW_BOUNDS="left,top,width,height"
#     Screen coordinates as chrome.windows reports them: origin at the primary display's
#     top-left, y down, displays left of the primary are negative x. Read the current value
#     from `interceptor window list --context "$INTERCEPTOR_TEST_CONTEXT_ID"` once the window
#     is where you want it, and paste it here. Chrome clamps `top` under the menu bar, so
#     record the clamped value (e.g. 30, not 0) or the script will re-issue a no-op move.
#
# Usage:  bash Tools/PinTestWindow.sh          # exit 0 always unless bounds are malformed
#   Test seams: INTERCEPTOR_PIN_PREFS (prefs file), PATH (a fake `interceptor`).

set -uo pipefail

PREFS="${INTERCEPTOR_PIN_PREFS:-${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env}"
# shellcheck disable=SC1090
[ -f "$PREFS" ] && . "$PREFS"

BOUNDS="${INTERCEPTOR_TEST_WINDOW_BOUNDS:-}"
CTX="${INTERCEPTOR_TEST_CONTEXT_ID:-}"

log() { echo "[PinTestWindow] $*" >&2; }

[ -n "$BOUNDS" ] || exit 0
[ -n "$CTX" ] || { log "INTERCEPTOR_TEST_CONTEXT_ID unset — not pinning (never move an unpinned window)."; exit 0; }
command -v interceptor >/dev/null 2>&1 || exit 0

IFS=, read -r L T W H <<EOF
$BOUNDS
EOF
for v in "$L" "$T" "$W" "$H"; do
    if ! [[ "$v" =~ ^-?[0-9]+$ ]]; then
        log "malformed INTERCEPTOR_TEST_WINDOW_BOUNDS=\"$BOUNDS\" (want left,top,width,height)"; exit 2
    fi
done

# One line per normal window: "<id> <left> <top> <width> <height>".
LIST="$(interceptor window list --context "$CTX" 2>/dev/null)" || exit 0
ROWS="$(printf '%s' "$LIST" | bun -e '
let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
  // The CLI prefixes a "[<reqid>] → window_list" line; the payload is the array that starts a line.
  const m = /^\[(?:\s|\{|\])/m.exec(s); if (!m) return;
  const i = m.index;
  let wins; try { wins = JSON.parse(s.slice(i)); } catch { return; }
  for (const w of wins) if (w && w.type === "normal" && w.state !== "minimized" && Number.isInteger(w.id))
    console.log(w.id, w.left, w.top, w.width, w.height);
});' 2>/dev/null)" || exit 0

moved=0
while read -r id left top width height; do
    [ -n "${id:-}" ] || continue
    if [ "$left" = "$L" ] && [ "$top" = "$T" ] && [ "$width" = "$W" ] && [ "$height" = "$H" ]; then
        continue
    fi
    if interceptor window resize "$id" --left "$L" --top "$T" --width "$W" --height "$H" --context "$CTX" >/dev/null 2>&1; then
        log "window $id moved from ${left},${top} ${width}x${height} to ${L},${T} ${W}x${H}"
        moved=$((moved + 1))
    else
        log "window $id: resize failed — leaving it where it is"
    fi
done <<EOF
$ROWS
EOF
exit 0
