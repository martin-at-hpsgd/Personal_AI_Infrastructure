# ReplayFlow

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Output format

Replays a recorded user flow after a deploy or code change and reports, step by step, whether it still works.

## Ideal State

- Every step in the plan is reported as PASS, FAIL or REGRESSION.
- Every step of the plan ran in the pinned isolated test context, each Bash line sourcing `preferences.env` before using `--context "$INTERCEPTOR_TEST_CONTEXT_ID"`.
- After each action that triggered a page change, the expected state was confirmed with `interceptor read --text-only`, and an element that was missing or content that differed from expectations was flagged as a regression.
- When the optional network check runs on a plan with commented network cues (`# correlated fetch GET /api/...`), the log was compared against the original recording's baseline for endpoints that no longer fire, changed response status codes and new unexpected requests.
- The final state was captured with `Tools/Capture.sh --current` and the screenshot compared against the flow's expected end state.

## Anti-criteria

- Never falls back to the Default profile when the preflight gate exits non-zero.
- Screenshots never go through raw `interceptor screenshot`.
- A plan with `# TODO` password comments is not replayed until those values are substituted.

## Inputs

A recorded flow plan from `skills/Interceptor/Flows/` (or regenerated from a monitor session), replayed after a deploy, before merging UI changes, to verify a bug fix by replaying the flow that exposed it, or alongside VerifyDeploy. Flows recorded on one environment may need URL adjustments for another (staging vs production).

## Safety gates

Run the preflight in SKILL.md § Gotchas before any browser verb; a non-zero exit ends the run with its message surfaced verbatim. Every `interceptor` verb below, including the `batch` example, passes `--context "$INTERCEPTOR_TEST_CONTEXT_ID"`. Each Bash call is its own shell, so the variable is gone by the next call: every command below starts with `source …/preferences.env &&` on the same line, and the PreToolGuard denies a `--context "$INTERCEPTOR_TEST_CONTEXT_ID"` whose line does not source it first. Screenshots go through `Tools/Capture.sh`.

## Tool contract

### Locate and open

```bash
ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Flows/"
source "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env" && interceptor monitor export <SESSION_ID> --plan --context "$INTERCEPTOR_TEST_CONTEXT_ID"    # or regenerate from a monitor session
```

The plan script starts with a `interceptor tab new "<url>"` or `interceptor navigate "<url>"` command; run it as an `open`:

```bash
source "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env" && interceptor open "<START_URL>" --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```

### Execute step by step

```bash
# Example: click a button
source "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env" && interceptor act "button:Sign In" --context "$INTERCEPTOR_TEST_CONTEXT_ID"

# Example: type into a field
source "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env" && interceptor act "textbox:Email" "user@example.com" --context "$INTERCEPTOR_TEST_CONTEXT_ID"

# Example: wait for page update
source "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env" && interceptor wait-stable --context "$INTERCEPTOR_TEST_CONTEXT_ID"

# After each action that triggers a page change, verify the expected state
source "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env" && interceptor read --text-only --context "$INTERCEPTOR_TEST_CONTEXT_ID"

# Optional: network contracts, when the plan carries `# correlated fetch` cues
source "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env" && interceptor net log --json --context "$INTERCEPTOR_TEST_CONTEXT_ID"

# Final state: read the printed image path and compare it against the flow's expected end state
bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/Capture.sh" --current
```

- Semantic selectors (`role:name`) are more resilient than ref IDs (`e5`); prefer them in flow plans.
- If a selector fails, use `interceptor find "<name>"` to locate the element under its new name.
- Screenshots from replays can be compared against baseline screenshots for visual regression detection.

### Batch for known flows

For well-tested flows where you trust the commands:

```bash
source "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env" && interceptor batch '[
  {"type": "navigate", "url": "https://example.com"},
  {"type": "wait_stable"},
  {"type": "click", "ref": "button:Sign In"},
  {"type": "wait_stable"},
  {"type": "type", "ref": "textbox:Email", "value": "user@example.com"},
  {"type": "click", "ref": "button:Submit"}
]' --stop-on-error --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```

`--stop-on-error` halts on the first failure so you can diagnose the exact regression point.

## Output format

For each step in the plan, report:
- PASS: action succeeded, expected state confirmed
- FAIL: action failed or unexpected state detected
- REGRESSION: behavior changed from baseline
