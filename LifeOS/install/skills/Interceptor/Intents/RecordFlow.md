# RecordFlow

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract

Records a user workflow in the isolated test profile and exports it as a replayable plan script built on semantic selectors.

## Ideal State

- The monitor session was started on the confirmed starting page with a specific instruction naming the flow ("Signup flow from landing page through onboarding", not "signup test"); the instruction is stored with the session and appears in exports.
- A replay plan was exported with `interceptor monitor export <SESSION_ID> --plan` and saved to `skills/Interceptor/Flows/<flow-name>.sh` for the ReplayFlow intent, using semantic selectors (`role:name`) with `wait-stable` between actions that trigger DOM mutations.
- The saved plan's markers are handled before replay: every `# TODO` comment marking a masked password field has had its value substituted manually; every `# ref eN (no accessible name)` fallback is flagged as fragile, with a suggestion to add accessible names to the UI; the commented network cues showing which API calls each action triggered are kept.
- Before any recording, export or generated script left this machine, it was scrubbed by hand for card numbers, CVCs and expiries the extension's partial masking records in clear, and any real value was replaced.

## Anti-criteria

- Never falls back to the Default profile when the preflight gate exits non-zero: recording in the operator's main profile would capture their real session events and credentials.
- No recording, export or generated script leaves this machine before it has been scrubbed for card values the masking missed.

## Inputs

A user flow worth replaying: a critical path for regression testing (signup, payment, onboarding), a repeatable QA check from a manual walkthrough, a baseline of which endpoints fire during a flow, or a complex multi-step interaction to document.

## Safety gates

Run the preflight in SKILL.md § Gotchas before any verb; a non-zero exit ends the run with its message surfaced verbatim. Record only in the pinned isolated context: every `interceptor` verb below passes `--context "$INTERCEPTOR_TEST_CONTEXT_ID"` (from `preferences.env`).

Masking is partial and lives in the interceptor extension (`extension/src/content/monitor.ts` in the interceptor repo), not in this skill. A field is masked (`***N***`) only when it received a vault secret, is `type=password`, has an `autocomplete` starting `cc-`, or has a `name` containing card, cvv, cvc or credit. A card number, CVC or expiry field identified only by its label or `id`, with an ordinary `name` and no `cc-` autocomplete, is recorded in clear. Before any recording, export or generated script leaves this machine, scrub it by hand: `interceptor monitor export <sid> --json | rg -n "\b(?:\d[ -]?){13,19}\b|\b\d{3,4}\b.*(cvc|cvv)|(0[1-9]|1[0-2])/\d{2}"` and read every input event on a payment or card step; replace any real value before sharing.

## Tool contract

```bash
interceptor open "<START_URL>" --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor monitor start --instruction "<FLOW_DESCRIPTION>" --context "$INTERCEPTOR_TEST_CONTEXT_ID"

# Walk the flow with interceptor commands, or by hand in Chrome — the monitor captures real user actions too
interceptor act e5 --context "$INTERCEPTOR_TEST_CONTEXT_ID"                    # Click a button
interceptor act e12 "user@example.com" --context "$INTERCEPTOR_TEST_CONTEXT_ID"  # Type into a field
interceptor act e8 --keys "Enter" --context "$INTERCEPTOR_TEST_CONTEXT_ID"     # Press Enter

interceptor monitor stop --context "$INTERCEPTOR_TEST_CONTEXT_ID"    # session summary: events, mutations, network requests, duration
interceptor monitor list --context "$INTERCEPTOR_TEST_CONTEXT_ID"    # find the session ID
interceptor monitor export <SESSION_ID> --plan --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor monitor export <SESSION_ID> --plan --with-bodies --context "$INTERCEPTOR_TEST_CONTEXT_ID"    # adds network verification cues
```

The monitor records from Chrome's content script, so it sees real user events, not just interceptor-injected ones: every click, double-click and right-click (with element ref, role and accessible name), every input/change event (with values; passwords are auto-masked), keyboard shortcuts (Enter, Tab, Escape, arrows), form submissions, network requests correlated to the action that triggered them, and the DOM mutations each action caused.

The `--plan` export uses semantic selectors (`role:name` format), which survive DOM changes better than ref IDs. Save it to `skills/Interceptor/Flows/<flow-name>.sh`; the `Flows/` directory currently holds only a README, so recorded plans are the first artifacts there.

- Recordings are stored in JSONL format at the interceptor events path. Use `interceptor monitor export <sid> --json` for raw data.
- Session recordings persist across interceptor restarts but are per-machine (not synced).
- For live observation during recording: `interceptor monitor tail` streams events in real time.
