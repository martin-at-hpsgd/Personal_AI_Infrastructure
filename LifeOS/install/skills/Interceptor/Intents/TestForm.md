# TestForm

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Output format

Discovers, fills, submits and verifies a form on any page, in the isolated test profile, through semantic element finding.

## Ideal State

- Every form field was filled through a semantic selector or ref found on the live page by its role (`textbox`, `combobox`, `checkbox`, `radio`, `spinbutton`, `slider`, `switch`), and every browser verb carried the pinned isolated test context.
- A pre-submit capture (`Capture.sh --current`) was read and showed the fields populated correctly with no validation errors showing.
- After submission, the outcome was established from the page text, the network log and a result capture, covering each item in Output format.
- When the optional edge cases are run, empty required fields, an invalid email format and a very long input were each submitted and the result read.
- After all form scenarios were done and evidence captured, `CleanupTabs.sh` closed the tabs the test opened in the test profile.

## Anti-criteria

- Never falls back to the Default profile when the preflight gate exits non-zero; test submissions stay away from any real auth state in the operator's main session.
- Screenshots never go through raw `interceptor screenshot`.

## Inputs

A page with a signup, login or contact form to test after a change: validation behavior (required fields, email format), whether the submission reaches the correct API endpoint, or a form on an authenticated page where agent-browser can't reach.

## Safety gates

Run the preflight in SKILL.md § Gotchas before any browser verb. `EnsureTestProfile.sh` runs the gate and auto-launches the test profile if it isn't open (exit 5/6), proceeding only after the pinned-UUID match passes; a non-zero exit ends the run with its message surfaced verbatim. Every browser verb below passes `--context "$INTERCEPTOR_TEST_CONTEXT_ID"`, and screenshots go through `Tools/Capture.sh`.

## Tool contract

### Open and discover

```bash
interceptor open "<PAGE_URL>" --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor find "" --role textbox --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor find "" --role combobox --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor find "" --role checkbox --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor tree --context "$INTERCEPTOR_TEST_CONTEXT_ID"    # or the full element tree
```

### Fill

```bash
# By semantic selector (preferred — survives DOM changes)
interceptor type "textbox:Email" "test@example.com" --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor type "textbox:Name" "Test User" --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor select "combobox:Country" "United States" --context "$INTERCEPTOR_TEST_CONTEXT_ID"

# By element ref (from tree output)
interceptor act e5 "test@example.com" --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor act e8 "Test User" --context "$INTERCEPTOR_TEST_CONTEXT_ID"

# Checkboxes and radio buttons
interceptor click "checkbox:Terms and Conditions" --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor click "radio:Monthly Plan" --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```

- Semantic selectors (`"textbox:Email"`) use accessible role + name. A field with no accessible name is findable only by ref ID; consider fixing the accessibility.
- `interceptor type` clears the field before typing. Use `interceptor type <ref> "text" --append` to add to existing content.
- For dropdowns/selects, use `interceptor select <ref> "value"` instead of click-based selection.
- For password fields, use `interceptor act <ref> "value" --trusted` for OS-level HID-sourced input (formerly `--os`, now a deprecated alias). It supplies hardware-sourced input for sites that check `isTrusted` against HID source state. It does not apply on banking, payment or human-verification pages, where the run stops (see TrustedInputGate).

### Verify pre-submit, submit, verify result

```bash
bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/Capture.sh" --current    # read the printed path: fields populated, no validation errors

interceptor click "button:Submit" --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor wait-stable --context "$INTERCEPTOR_TEST_CONTEXT_ID"
# or: interceptor keys "Enter" --context "$INTERCEPTOR_TEST_CONTEXT_ID"

interceptor read --text-only --context "$INTERCEPTOR_TEST_CONTEXT_ID"    # success/error messages
interceptor net log --json --context "$INTERCEPTOR_TEST_CONTEXT_ID"      # the API request the submit triggered: endpoint and payload shape
bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/Capture.sh" --current             # the result page
```

`Capture.sh --current` shoots the already-open page in the pinned context.

### Edge cases (optional)

```bash
# Empty required fields — submit without filling
interceptor click "button:Submit" --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor read --text-only --context "$INTERCEPTOR_TEST_CONTEXT_ID"  # Check for validation messages

# Invalid email format
interceptor type "textbox:Email" "not-an-email" --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor click "button:Submit" --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor read --text-only --context "$INTERCEPTOR_TEST_CONTEXT_ID"

# Very long input
interceptor type "textbox:Name" "A very long name that might break layout assumptions in the form" --context "$INTERCEPTOR_TEST_CONTEXT_ID"
bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/Capture.sh" --current
```

### Cleanup

```bash
bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/CleanupTabs.sh"
```

## Output format

- Success confirmation message or redirect
- API call to the expected endpoint with correct method (POST/PUT)
- Response status code (200/201 for success)
- Any error messages or validation failures
