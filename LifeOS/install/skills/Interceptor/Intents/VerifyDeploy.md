# VerifyDeploy

**Contents:** Ideal State · Anti-criteria · Output format · Safety gates · Tool contract · Gotchas

Verifies a deployment in real Chrome with a four-probe evidence bundle (DOM read, console errors, network failures, screenshot) for every route type the site serves.

## Ideal State

- The URL list holds one real URL for every route or template type the site serves (home, list, each detail/content type such as post, essay, product or profile, and any error or auth page changed) plus every page the change touched, taken from the site's route table or sitemap, and the report names the list.
- For every URL in the list, all four probes ran and were captured: A the DOM read, B console errors from an injected collector read back after the page was exercised, C network failures, D a `Tools/Capture.sh` screenshot that was read.
- Every screenshot was judged as a whole page at its width, top of the viewport included: overlapping, clipped or misplaced layout (cards over the header, overlapping text, a cut-off top) fails that URL even when the requested content is present, and an anomaly in the capture counts as a page failure until a second capture (`Capture.sh --full` or `VerifyViewport.ts shot`) shows the page without it (principal, 2026-10-07: on a product page, cards covered the header in the agent's own capture, it was called a screenshot quirk, and it shipped as verified).
- Probe E (`VerifyViewport.ts`) ran when the change involves layout at different widths, animation, transitions, lazy-loaded or remote images, scroll reveals, or any claim that depends on the page's own observers; Probe F (`SocialCard.ts`) ran on every shareable public page, a page is skipped only when it is not shareable (login wall, API host, noindex), and the report says so.
- The ISC is marked `[x]` only when all four probes are captured and clean (or noise-only under the noise rules) for every URL in the list, plus Probe E and Probe F where they apply, citing DOM content, console, network and screenshot path per URL and the E and F results.
- Once the evidence bundle was captured, `CleanupTabs.sh` closed the tabs this verification opened.

## Anti-criteria

- A screenshot alone is never reported as full verification, and clean logs alone are never verification either.
- A verdict never covers a URL that did not go through the probes.
- Never verifies the console by installing the collector and then reloading, and never reads `window.__interceptor_errors` cold as evidence.
- Probes A–C are never skipped because D failed: a screenshot wedged after one auto-heal retry is marked `[DEFERRED-VERIFY]` and surfaced while A–C are still reported.
- When a probe shows a real failure, the browser evidence is reported before any fix is attempted, never a theory from code.
- Never falls back to the Default profile, never routes to the operator's main profile silently, and never calls raw `interceptor screenshot`.

## Output format

The four probes are one conjunctive piece of evidence, not alternatives: pixels cannot show a hydration mismatch, a silent JS exception, or a 404 on a lazy-loaded chunk, and clean logs cannot show that the page rendered. The three non-visual probes use independent WebSocket message types, so a screenshot wedge does not block them.

Per URL in the list:

- DOM content confirmed (the shipped heading, copy or component), console clean or noise-only, network clean or noise-only, and the screenshot path with the whole-page judgment at that width.
- Probe E and Probe F results where they apply, or the reason F was skipped.
- `[DEFERRED-VERIFY]` on the visual portion when the screenshot wedged, with A–C still reported.
- On any real failure: the specific console, network or visual evidence, before any fix.

## Safety gates

The run starts with the shared preflight in SKILL.md § Gotchas; a non-zero exit ends it with the gate's message surfaced verbatim. `Tools/EnsureTestProfile.sh` auto-launches a closed test window (exit 5/6) and only succeeds after the pinned-UUID match and Default-deny pass; call `Tools/PreflightIsolation.sh` directly when you want the gate with no auto-launch.

If the page **requires the operator's signed-in session** (verification of their own authenticated tooling), say so explicitly and route to their main profile via `--context <main-id>` after confirming with `interceptor contexts` — never silently.

## Tool contract

### 1. Build the URL list, then open each target (in the isolated profile)

Steps 1 through 7 run once per URL in the list, not once per deploy. Take the list from the site's route table or sitemap, never from memory.

```bash
interceptor open "<DEPLOY_URL>" --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```

Navigates, waits for DOM stability, returns the element tree + visible text in one call. Pass the pinned UUID from `preferences.env`, never the literal `interceptor-test`: that friendly name does not resolve on this machine until set in the extension popup. Local dev URLs carry the scheme: `http://localhost:PORT`, never bare `localhost:PORT`.

For pages that load slowly (heavy SPAs, SSR hydration):

```bash
interceptor open "<DEPLOY_URL>" --context "$INTERCEPTOR_TEST_CONTEXT_ID" --timeout 10000
```

### 2. Probe A — DOM read (content check)

```bash
interceptor read --markdown --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```

The shipped heading/copy/component is present; no error banners, no blank areas that should have content, no "404"/"500"/"not found" in visible text.

### 3. Probe B — console errors (inject, act, read back)

There is no pre-installed error collector. `window.__interceptor_errors` does not exist unless you install it; reading it cold always returns `[]` and proves nothing.

```bash
# 3a. Install the collector (after the page is loaded)
interceptor eval "window.__errs=[];window.addEventListener('error',e=>window.__errs.push({m:e.message,s:(e.error&&e.error.stack||'').slice(0,300)}));window.addEventListener('unhandledrejection',e=>window.__errs.push({m:String(e.reason).slice(0,300)}));(function(o){console.error=function(){window.__errs.push({c:[...arguments].map(String).join(' ').slice(0,300)});return o.apply(console,arguments)}})(console.error);'installed'" --main --context "$INTERCEPTOR_TEST_CONTEXT_ID"

# 3b. Exercise the page — click the main nav, trigger the changed feature, or wait for lazy loads
interceptor wait-stable --context "$INTERCEPTOR_TEST_CONTEXT_ID"

# 3c. Read back
interceptor eval "JSON.stringify(window.__errs||[])" --main --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```

**Gotcha:** a reload wipes the collector and the errors, so install after load and capture forward from the next action. Errors that fired during initial load are catchable only via Probe A symptoms (blank areas) and Probe C (failed requests). Installing the collector on `about:blank` first and then navigating is not supported.

**Noise rule:** pre-existing third-party noise (ad blockers, extensions, known benign warnings) is reported but does not fail verification; errors originating from your origin's scripts do.

### 4. Probe C — network failures

```bash
interceptor net log --context "$INTERCEPTOR_TEST_CONTEXT_ID" --limit 100
```

Fail on 404s on same-origin JS/CSS chunks (missing build artifacts), 4xx/5xx on same-origin API endpoints, and CORS errors on resources you control. Third-party 4xx (trackers, ads) is noted, not failing.

### 5. Probe D — screenshot

```bash
bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/Capture.sh" "<DEPLOY_URL>"
# long pages:
bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/Capture.sh" "<DEPLOY_URL>" --full
```

`Capture.sh` re-runs the isolation gate, routes to the pinned context, prefers the DOM-render path (no foreground needed), and prints the absolute saved-image path on its only stdout line. Read that image. Raw `interceptor screenshot` loses the deny-Default guard and CWD-destination handling.

**Flow gallery (multi-step flows).** One end-state screenshot proves the last page rendered, not the screens before it, so a broken state mid-flow (a failed validation, an empty intermediate step, a wrong redirect) goes unseen. For signup, checkout, vote or onboarding, run `Capture.sh` at each step and keep the shots ordered with a step label (`01-landing`, `02-form-filled`, `03-confirm`, …), then read them in sequence. This extends Probe D; it does not replace probes A–C. Bugs that exist only in motion (animation, transition, flicker) go to `ScrubFlow`; a gallery of stills cannot see a stutter.

### 6. Probe E — rendering lifecycle and viewport (VerifyViewport)

The standard test profile can sit behind another window, where Chrome suspends `requestAnimationFrame`, `ResizeObserver` and transitions and the other probes report a confident "nothing happened". `VerifyViewport.ts` runs a separate always-rendering Chrome and fails (non-zero) if the lifecycle is not live:

```bash
bun "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/VerifyViewport.ts" probe "<DEPLOY_URL>" --widths 1440,390 --expr '<js that returns the fact you claim>'
bun "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/VerifyViewport.ts" shot "<DEPLOY_URL>" --width 390 --out <path>
```

A remote-image or animation claim made without this probe is unverified. It drives public pages only; authenticated pages stay on the extension-driven profile.

### 7. Probe F — social card (public pages)

A page can render perfectly and still have no `twitter:card`, no `og:image`, or an image under 1200x600; the DOM and screenshot probes cannot see the link card X and LinkedIn will draw.

```bash
bun "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/TOOLS/SocialCard.ts" "<DEPLOY_URL>"          # one page
bun "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/TOOLS/SocialCard.ts" <host>                    # bare host also samples deep pages from the sitemap
```

Exit 1 means a broken card: report the tool's problem lines as the evidence.

### 8. Tab hygiene (final step)

```bash
bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/CleanupTabs.sh"
```

Keeps the active tab and only ever touches the pinned test context. Pass `--keep-url <substr>` if a tab must survive for a follow-up check.

## Gotchas

- **Content/archive sites: verify the content pages, not just the shell.** An SPA answers 200 with the full shell for every path, and list/tab views render from metadata — so a homepage pixel plus tab reads can all pass while every detail page ships raw code. *(2026-07-15: a content site's homepage was pixel-verified clean while all 21 essay pages shipped as tag soup.)* The sweep must open at least one page of every route/template type (especially detail/content pages) in the real browser, and content sites additionally run a deterministic render gate over the full built payload before any done-claim. The gate is a build-time script in the site's own repo that fails on escaped tags, raw markdown artifacts, relative URLs, and missing paragraph structure.
