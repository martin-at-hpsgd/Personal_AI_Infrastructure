# Reproduce

**Contents:** Ideal State · Anti-criteria · Output format · Inputs · Safety gates · Tool contract · Gotchas

Reproduces a reported bug in real Chrome before any code is read, capturing console, network and visual state as the primary evidence.

## Ideal State

- A real-Chrome observation of the affected page, in the isolated test profile by default, existed before any code was read or any theory formed.
- What the page should do was taken from the app's ISA `## Features` block for the reported area (resolved through PROJECTS.md), and when that block is absent the absence is reported as a finding.
- The path to the feature in the findings comes from the live running page and its accessibility tree.
- The evidence set exists: a `Tools/Capture.sh` screenshot that was read, the failed-resource probe, `interceptor net log --json` checked for 404s on JS/CSS bundles, failed API calls, CORS errors and mixed content warnings, and `interceptor read --text-only` compared against the expected content.
- Before any code was touched, the findings were documented in the Output format shape, and code analysis started only after that, from hypotheses grounded in the browser evidence.
- When the debugging session was over (bug reproduced and evidence captured, not between probes), `CleanupTabs.sh` closed the tabs left in the test profile.

## Anti-criteria

- No code is read and no theory is formed before the page has been opened and seen.
- "curl returns 200" is never reported as reproduction.
- No selector or click-path map is persisted, and no selectors are invented to make up for a missing ISA `## Features` block.
- Never falls back to the Default profile; routes to the main profile only if the bug is specifically tied to the operator's signed-in session and they said so.

## Output format

Before touching any code, document:
- What the page actually shows (screenshot evidence)
- Console errors found (with specific error messages)
- Network failures (with specific URLs and status codes)
- Gap between expected and actual state

Only then proceed to code analysis, with hypotheses grounded in the browser evidence.

## Inputs

- **Expected behavior: the ISA `## Features` block.** PROJECTS.md maps the domain or app to its ISA. Each `### F<n>` carries a `Why:` (what the feature is for) and the `## Test Strategy` rows carry the verify assertion (what "working" looks like). That intent is the half an agent cannot see on the page: it can see a button, not that the dashboard tab is supposed to show today's figures with fresh data.
- **The path to the feature: found live.** Drive the real page and read the accessibility tree (`interceptor macos tree` / the ReadAxTree intent). Routes and selectors rot on every refactor, and a stored map caps the agent and needs a drift-checker of its own; the ISA holds the intent, the live AX tree holds the path.

## Safety gates

The run starts with the shared preflight in SKILL.md § Gotchas (`Tools/EnsureTestProfile.sh`, which auto-launches a closed test window on exit 5/6 and proceeds only after the pinned-UUID match passes); a non-zero exit ends it with the message surfaced verbatim. Reproduce in the isolated profile by default.

## Tool contract

```bash
# 1. Open the affected page (isolated profile), before reading any code
interceptor open "<BUG_URL>" --context "$INTERCEPTOR_TEST_CONTEXT_ID"

# 2. Visual state: read the printed image path; is the reported bug visible?
bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/Capture.sh" "<BUG_URL>"
```

### 3. Failed resource check (public issue #2088, @Steffen025: this probe reads the resource timeline, not the console)

```bash
interceptor eval "(() => {
  const entries = performance.getEntriesByType('resource').filter(e => e.name.includes('.js') || e.name.includes('.css'));
  const failed = entries.filter(e => e.transferSize === 0 && e.decodedBodySize === 0);
  return JSON.stringify({ failedResources: failed.map(e => e.name) });
})()" --main --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```

Then the network log:

```bash
interceptor net log --json --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```

Look for 404s on JS/CSS bundles (missing build artifacts, a common root cause of blank-screen deploys), failed API calls (500s, timeouts), CORS errors, and mixed content warnings.

### 4. Page content

```bash
interceptor read --text-only --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```

Compare visible text against what's expected; empty or missing sections indicate rendering failures.

### 5. Close the tabs when the session is over

```bash
bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/CleanupTabs.sh"
```

## Gotchas

- This intent exists because of real production incidents where hours were spent on code analysis and wrong-theory fixes were shipped to prod — when the actual cause (missing JS chunks, 404s on bundles, CORS errors) was visible in the browser console in under a minute. Reproduce first, theorize second.
- For authenticated pages, Interceptor uses your real Chrome sessions automatically.
