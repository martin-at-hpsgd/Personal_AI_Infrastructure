# TrustedInputGate

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Gotchas · Output format · Examples

Completes a flow that needs OS-level trusted input, where the target filters synthesized `CGEvent`s and accepts only events with real hardware (HID) source state.

## Ideal State

- `--trusted` was used only after synthetic input (the bridge's standard `click` / `type` / `keys`) was observed failing, and the report names that observed symptom.
- `interceptor macos trust` showed `accessibility` as `granted` before any `--trusted` call; when it was `denied`, the deep link from `trust --walkthrough` was surfaced to the user.
- `interceptor macos frontmost` was checked immediately before each `--trusted` call, and the report shows frontmost before and after each one.
- The gate's acceptance was read for explicitly (a success banner, a new DOM element, a network call) and is in the report.

## Anti-criteria

- Never reaches for `--trusted` reflexively; measure first.
- Never bypasses the bridge's sensitive frontmost-app rejection; it is surfaced.
- New code never uses the deprecated `--os` alias.
- No browser verb runs without `--context "$INTERCEPTOR_TEST_CONTEXT_ID"`.

## Inputs

`--trusted` is the answer when:
- The synthetic call returns successfully but the target acts as if nothing happened.
- The target is a native gate that checks `CGEventSourceGetSourceStateID` against `kCGEventSourceStateHIDSystemState`.
- The target is a webapp that reads `isTrusted` via a cached per-instance own property captured at boot, so the prototype override does not reach it.
- A page you are authorized to test uses hardware-sourced input checks that reject standard input (a custom keyboard widget, for example).

`--trusted` flips the bridge to post events through `CGEvent.post(.cghidEventTap)` with `kCGEventSourceStateHIDSystemState`, which the OS treats as real hardware input.

## Safety gates

### Verify permissions first

```bash
interceptor macos trust
```

Response keys are camelCase (verified on 1.0.21: `accessibility`, `screenRecording`, `microphone`, `speechRecognition`; there is NO `inputMonitoring` field):
- `accessibility` — must be `granted`. Without it, `CGEvent` posting fails silently, so any `--trusted` / AX-input flow no-ops until the grant lands. Probe `trust` before assuming a `--trusted` call did anything.
- `screenRecording` — granted enables capture; not strictly needed for input gates.
- `microphone` — separate consent, not required here.

If accessibility is `denied`, surface the deep link from `trust --walkthrough` so the user can grant it.

- **Banking and payment pages end the run.** On a banking, payment or card-entry page, or when a page presents a human-verification challenge, the run stops and reports it; `--trusted` is never used to get past either. The principal completes that step.
- **Sensitive frontmost-app gate.** The bridge rejects `type` / `keys` / `click x,y` / `drag` when frontmost is a denylisted bundle (Keychain, 1Password, Dashlane, LastPass, Bitwarden, System Settings, Chase, Bank of America, Wells Fargo). Surface the rejection — do not bypass.

## Tool contract

Synthetic events (the bridge's standard `click` / `type` / `keys`) work on almost everything, so try them first. For webapps the next escalation is usually the browser-side trust marker below, not `--trusted`; reserve `--trusted` for native HID-source-state checks.

`--trusted` is canonical; `--os` is the deprecated alias (renamed in v0.13.3) and emits a warning.

```bash
# Type with HID source state, delivered as keyboard input
interceptor macos type "..." --trusted

# Send keystrokes with HID source state
interceptor macos keys "Meta+S" --trusted

# Browser side — for sites that reject in-page synthetic events
interceptor act <ref> --trusted --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```

These follow the user's current frontmost app (legacy HID semantics — that's how real keyboards work). For per-PID delivery, prefer the AX path with refs, or `--app` / `--pid` flagged input.

### Browser-side equivalent (when `--trusted` is overkill)

Dispatch synthetic events carrying the trust marker via `eval --main`:

```javascript
const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
evt.__interceptor_trust = true;
element.dispatchEvent(evt);
```

Combined with the pre-load `userActivation` override (already installed via `inject-net.ts` at `document_start`), this satisfies transient-activation and per-event `isTrusted` requirements on pages under test without going to OS-level CGEvents.

## Gotchas

- **`--trusted` follows current frontmost.** If the user clicked away mid-flow, your keys go to the wrong app. Verify with `interceptor macos frontmost` immediately before each `--trusted` call.
- **Reaching for `--trusted` reflexively.** The historical reflex "site checks `isTrusted` → use `--trusted`" is no longer correct on most sites. The pre-load `userActivation` override + `__interceptor_trust` marker handles the vast majority.
- **Forgetting Accessibility consent.** `CGEvent.post` silently no-ops without it. If a `--trusted` call returns success but nothing happens, check `trust` first.

## Output format

Report:
- Why `--trusted` was needed (the observed symptom of synthetic failing)
- The exact call (`type` / `keys` / `act --trusted`)
- `frontmost` before and after each `--trusted` call (proof of correct targeting)
- The success indicator from the gate (banner text, new element, response status)
- Whether Accessibility TCC was granted before the call

## Examples

Browser verbs (`open`, `read`, `act`) carry `--context "$INTERCEPTOR_TEST_CONTEXT_ID"` in a command that sources `preferences.env` first; PreToolGuard's InterceptorContextGuard denies one that does not. `macos` verbs drive native apps and take no context.

```bash
# 1. Navigate to the trusted-input page
interceptor open <trusted-input-fixture-url> --context "$INTERCEPTOR_TEST_CONTEXT_ID"

# 2. Identify the gate
interceptor read --tree-only --context "$INTERCEPTOR_TEST_CONTEXT_ID"

# 3. If standard `type` doesn't satisfy the gate, escalate:
interceptor macos keys "Tab" --trusted                  # focus the input
interceptor macos type "expected text" --trusted        # HID-level keystrokes

# 4. Verify the page accepted the input
interceptor read --text-only --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```
