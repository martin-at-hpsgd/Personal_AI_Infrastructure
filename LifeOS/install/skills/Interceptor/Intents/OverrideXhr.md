# OverrideXhr

**Contents:** Ideal State · Anti-criteria · Output format · Inputs · Safety gates · Tool contract · Gotchas

An HTTP request or response rewritten in flight (status, delay, body, params) in the isolated test profile, verified in the network log and cleared afterwards.

## Ideal State

- The preflight isolation gate (SKILL.md § Gotchas, after sourcing `preferences.env`) returned exit 0 before any browser verb ran, and every `interceptor` browser verb carried `--context "$INTERCEPTOR_TEST_CONTEXT_ID"`.
- The override is keyed on a substring that uniquely identifies the request, and real traffic for that pattern was observed in the network log before the override was installed.
- The network log after the trigger shows the override fired with the forced response; a miss led to one refined retry of install, trigger and verify, not a fresh `read` of the page.
- `interceptor override clear` ran at the end, with the EXIT trap as backstop, so no override outlives the run.
- The override is an extension override by default; a CDP `network` override is used only when the change needed request-body rewriting, WebSocket frame inspection, or raw pre-decode bytes.
- The report gives the Output format fields.

## Anti-criteria

- A non-zero preflight exit never falls back to the Default profile: the run stops and surfaces the message verbatim.
- Never overrides blind, and never uses `*` alone as a pattern: it overrides everything including extension traffic, and pages can hang.
- Never leaves an override uncleared: override rules survive across `open` calls and a crashed run, and silently mutate the next session's traffic.

## Output format

Report:
- The override key (URL pattern + what was changed)
- Observed response after triggering
- Whether the page's behavior matched expectations
- Whether `override clear` was called

## Inputs

Use this to test what the page does when the API returns 500 / 404 / slow, to change request parameters without rebuilding the UI, or to inject test data the backend can't produce.

## Safety gates

The run starts with the shared preflight in SKILL.md § Gotchas; this intent mutates live network traffic, so a wrong-profile run would rewrite requests in the operator's real session. Install the cleanup before the first override so overrides are cleared even if a step fails:

```bash
trap 'interceptor override clear --context "$INTERCEPTOR_TEST_CONTEXT_ID" 2>/dev/null' EXIT
```

Overrides persist across `open` calls and survive a crashed run; the trap is the backstop for the explicit `override clear` step.

## Tool contract

**Budget: 5 commands** — observe, install, trigger, verify, clear (opening the page comes first). If verify shows the override didn't fire, refine the pattern and retry install, trigger and verify once; response data lives in the network log, so don't reach for a fresh `read` to "check the page" first.

```bash
interceptor open <url> --context "$INTERCEPTOR_TEST_CONTEXT_ID"

# 1. Observe real traffic first; a unique substring of the URL is your override key
interceptor net log --filter <pattern> --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor net headers --filter <pattern> --context "$INTERCEPTOR_TEST_CONTEXT_ID"

# 2. Install (examples)
interceptor override "*api/search*" status=500 --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor override "*api/search*" delay=1000 --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor override "*api/search*" status=200 body='{"results":[]}' --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor override "*api/items*" params=count:5 --context "$INTERCEPTOR_TEST_CONTEXT_ID"

# 3. Trigger the request: act, click, type or navigate, each with --context "$INTERCEPTOR_TEST_CONTEXT_ID"

# 4. Verify the override fired: the response should match what you forced
interceptor net log --filter <pattern> --since 30s --context "$INTERCEPTOR_TEST_CONTEXT_ID"

# 5. Clear, always (the EXIT trap is only the backstop)
interceptor override clear --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```

The general install form is `interceptor override "<pattern>" status=... --context "$INTERCEPTOR_TEST_CONTEXT_ID"`.

### When to use CDP `network` instead

`interceptor override` uses the extension's declarativeNetRequest path — no debugger banner and no DevTools attach. Reach for `interceptor network on` + `interceptor network override` (each with `--context "$INTERCEPTOR_TEST_CONTEXT_ID"`) only when:
- You need request-body rewriting (extension overrides are URL/header-only for some sites).
- You need WebSocket frame inspection (passive `net` doesn't capture WS — see canvas-rendered notes for the MAIN-world WS patch).
- You need to observe raw bytes pre-decode.

CDP attach shows a "DevTools is debugging this tab" banner, and pages that watch for it behave differently.

### Network exports

For debrief or regression testing, export the captured traffic:

```bash
interceptor net export --format har --context "$INTERCEPTOR_TEST_CONTEXT_ID"                  # HAR 1.2 (any HAR viewer / DevTools import)
interceptor net export --format pcapng --context "$INTERCEPTOR_TEST_CONTEXT_ID"               # pcapng for Wireshark
interceptor net export --format json --out trace.json --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```

## Gotchas

- **Pattern too broad.** `*` alone overrides everything including extension traffic — pages can hang. Use a substring that uniquely identifies the request.
- **Forgetting `override clear`.** Override rules survive across `open` calls until explicitly cleared. A test that "passed last run" may be reading a stale override.
- **Override + cache.** Browsers cache. If you override `GET /api/foo` but the page reads from a `Cache-Control: max-age` response, the override doesn't fire. Reload with `?cb=<timestamp>` or use `interceptor navigate`.
