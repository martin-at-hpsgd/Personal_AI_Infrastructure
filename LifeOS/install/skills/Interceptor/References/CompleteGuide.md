# Interceptor — Real-Browser Automation + macOS Computer Use

**Contents:** What It Does · The Problem · How It Works · Compound Commands (Preferred) · Command Reference (moved) · Key Rules · Delegating to Agents · Examples · Gotchas

> **First rule:** if you are about to ask the operator to do something in a browser (open a URL, click, fill a form, log in, paste a value), drive it yourself with Interceptor instead. The exceptions are a step that needs a secret you do not hold, such as an unknown password or a hardware 2FA tap, and any OAuth or consent screen: drive the flow up to that exact point, then show the operator the requesting client, the scopes and the account, and let the operator approve. Surface only that one human-only action. Narrating clickwork a human has to perform is the failure this skill exists to prevent.

## What It Does

Interceptor drives the real Chrome/Brave browser from inside it, and drives native macOS apps when the bridge is installed. Six capability classes, each its own verb tree: visual capture, DOM read, JS eval, network capture, input, and record/replay. It drives a real Chrome profile, so pages behave as they do for you, stays logged into your real sessions, and is the mandatory tool for visual deploy verification.

## The Problem

Headless browser tools run as a separate browser instance with no auth, so they can't reach anything you're signed into, and a page can render differently for them than for the browser you actually use. And when a page breaks — a blank screen after mount, a hydration mismatch, cards that flash and vanish — a screenshot tells you nothing about why. Interceptor solves all three: it operates through the actual browser UI, uses your real signed-in sessions, and reads the live DOM, console errors, and network traffic to explain failures a screenshot can't.

## How It Works

**Tool:** `interceptor` CLI — Chrome/Brave extension that controls the real browser from inside, plus a macOS bridge that drives native apps, OS-level input, and full VM lifecycle.
**Repo:** https://github.com/Hacker-Valley-Media/Interceptor
**Install:** the signed `Interceptor-Browser-<v>.pkg` / `Interceptor-Full-<v>.pkg` from the upstream releases page, or `interceptor upgrade --full` on an existing install. Building from source is optional — see `Intents/Update.md`.
**Chrome extension:** the signed installer registers it for you. If you build from source instead, `Tools/Pin.sh` copies the built `extension/dist` into `~/.claude/skills/Interceptor/Extension/` — that directory does **not** ship with the skill, `Pin.sh` creates it — and Chrome loads it via "Load unpacked". Provenance is recorded in `Extension/PINNED_FROM.txt` (source path, manifest version, content SHA256, timestamp). Chrome disables unpacked extensions on every manifest bump, so after any source rebuild the copy must be **re-pinned and reloaded**. It does NOT auto-follow upstream.
**Version floor: `interceptor >= 0.23.16`** (the one floor this guide states; `Capture.sh` is written to work from 0.23.16 up, and it avoids the flags that 0.23.30+ rejects). The installed binary on the reference machine is 1.0.21, stock upstream with no local patches. `Tools/PreflightIsolation.sh` enforces the same floor (`MIN_VERSION="0.23.16"`). `screenshot --save` writes to the CLI's cwd on stock builds, and 0.23.23+ rejects `--out` on browser screenshots, so `Tools/Capture.sh` stages `--save` in a private cwd (the local `screenshot --save --out` cherry-pick was retired 2026-09-06). Upstream is a three-surface control plane: Browser, macOS, and iOS (`interceptor ios *`, see Current surfaces & verbs). Tab lifecycle (named-group reuse, idle-group close) is under Key Rules, Tab hygiene.

### Capabilities Overview — Six Verb Trees

Each row is an independent capability class. Each one uses a different WebSocket message type at the daemon→extension boundary, so a wedge on one rarely affects the others. **When debugging a broken page, every row is a separate diagnostic path — never bail on Interceptor because `screenshot` hangs without trying `eval`, `net log`, or `monitor` first.**

| Verb tree | Top-level verbs | What you get |
|-----------|-----------------|--------------|
| **VISUAL** | `screenshot` (DOM-render default — works backgrounded), `screenshot --region`, `screenshot --pixel --full` (window must be visible) | PNG/WebP at any size, selector, region, or scroll-and-stitch full page. Route through `Tools/Capture.sh`, never raw `interceptor screenshot`. Zoom into fine detail with `Tools/Zoom.ts`. |
| **DOM READ** | `read [--markdown]`, `tree`, `text`, `html <ref>`, `find` | Accessibility tree, structured markdown, raw markup, refs |
| **JS EVAL** | `eval <code>`, `eval --main` | Run JavaScript in isolated or main world — **the way you read console errors, runtime exceptions, hydration warnings, and DOM state at runtime** |
| **NETWORK** | `net log`, `net headers`, `net export --format har\|pcapng\|json`, `override`, `headers add/remove` | Passive request capture without attaching a debugger; HAR 1.2 + pcapng for Wireshark |
| **INPUT** | `click`, `type`, `keys`, `act <ref> [--trusted]`, `drag`, `scroll`, `select`, `focus` | Browser + native macOS input; `--trusted` for OS-level HID source state. `click --selector <css>` clicks by CSS selector (0.23.6+), returns the clickable `e<ref>`, and auto-escalates to an OS-level click when the synthetic one is rejected |
| **RECORD/REPLAY** | `monitor start/stop`, `monitor export --plan`, `monitor export --format har` | Real user-flow capture as deterministic replay scripts; multi-session, browser + macOS AX events |

**Reading console errors** is a recipe, not a separate verb: inject a `console.error` / `window.error` listener via `eval --main`, store events on `window.__errs`, then `eval` again to read them back. Useful for hydration mismatches, React error boundaries, JS exceptions on load, and any silent runtime failure. **Triggering a reload between install and read loses the captured errors** — capture happens after load, so reproduce-by-reload doesn't help; instead capture forward from the next user action, or poll `getEventListeners(window)` / DOM mutation observers for evidence of failure.

**Why this matters in practice.** Hydration failures on Astro pages, blank-page after React mount, "cards flash and disappear" — all of these surface through `eval` reading the live DOM state and console captures, not through screenshots. A `screenshot` wedge does not block diagnosis; the page is still inspectable through every other verb tree.

### Current surfaces & verbs

What the tool does now, beyond the six verb trees:

- **Screenshot auto-fallback** — a failed DOM-render capture retries as `--pixel` (side effects disclosed in the result; `--no-fallback` opts out). This covers render failures (injection-blocked pages, mid-navigation), not silent mis-composites: the animated-page `--pixel`/DOM-geometry cross-check rule in OPERATIONAL_PREFERENCES still stands.
- **Half-open WebSocket detection** — a daemon keepalive-ack catches dead-but-open extension connections.
- **Deterministic tab targeting** — `tab close <id>` / `tab switch <id>` act on the id you pass (strictly numeric), never the working tab.
- **File upload** — any size, dropzones, native pickers.
- **Safari surface** and **MCP server** (`interceptor mcp install`) — both deliberately unused here: we drive the Chrome test profile via CLI.
- **a11y** — zero-area inline wrapper elements stay in the tree.
- **iOS** (`interceptor ios *`) — drive an owned, unlocked, Developer-Mode iPhone over WiFi via an on-device XCUITest runner (not WebDriverAgent). Verbs: `tree`, `find`, `click`, `type`, `scroll`, `screenshot`, `app launch|activate|terminate`. Setup is Xcode self-service or a no-Xcode `login` that re-signs the runner with your Apple ID.
- **`interceptor diagnose`** — one post-failure snapshot: daemon (with its real exec path), every connected context probed in parallel, monitor state. **Catches the daemon split-brain** — Chrome spawns one daemon binary while the CLI talks to another, previously a silent 15s timeout. Run it first when anything acts wedged.
- **`interceptor manifest`** — machine-readable specs for 50+ verbs (usage, flags, returns semantics). Discover the contract without scraping help text.
- **Per-agent tab groups** (`--group <label>` / `INTERCEPTOR_GROUP`) — pen each agent into its own colored, hard-isolated tab group so several agents share one browser with no cross-bleed. `interceptor group list|close <label>`. A second isolation layer alongside `--context`.
- **`interceptor save`** — pull raw bytes (Blob / ArrayBuffer / `blob:`) straight off a live page to disk without a downloads folder; returns a sha256.
- **`interceptor ocr`** / **`canvas ocr`** — offline Tesseract pixel OCR, bundled into the extension (no bridge, no macOS needed).
- **`interceptor macos cdp *`** — drive the web contents of Electron / Chromium desktop apps (Slack, VS Code, Notion, Descript) the same way as a browser tab.

**CLI contract:** arguments are order-independent (`open --text-only <url>` parses correctly), and browser-only installs hide the macOS/iOS verbs (`--all-surfaces` / `INTERCEPTOR_ALL_SURFACES` overrides). Bare `interceptor` / `--help` print a concise capability card; use `help <cmd>` or `interceptor manifest` for the full contract.

### Why Interceptor?

The reasons are under The Problem. In this skill, "Computer Use" means the optional macOS bridge extending the same control surface to native applications, OS-level input, and on-device VMs.

### Interceptor vs Apify vs BrightData — which one, by scale × auth

Three tools touch "get data from a page," but they don't overlap much. Pick by **how many pages** and **whether being logged in matters**, not by which you reached for last time.

- **Interceptor** — one real, signed-in browser you drive. Use it when being logged into your own session matters, a page only renders or behaves correctly in a real browser, or the job is interactive: a deploy to verify, an OAuth/login/form flow, a debug pass, or reading a *handful* of pages in your own signed-in session. The tell: these are pages you would open yourself, in your own account.
- **Apify** — managed cloud actors for **bulk** extraction from a named platform (Instagram, LinkedIn, TikTok, YouTube, Facebook, Google Maps, Amazon). Use it when you want hundreds-to-thousands of items, in parallel, structured, through actors that operate within each platform's terms (official APIs or data the platform licenses). The tell: you'd never open these by hand, and there's a per-platform actor for it.
- **BrightData** — 4-tier page fetching and crawling of an *arbitrary* site (no named actor), through Bright Data's documented products and within the site's terms.

One-line test: **one page you could log into → Interceptor; N items on a named platform within its terms → Apify; a whole arbitrary site that permits automated access → BrightData.** Interceptor is one browser on this Mac — it does not do managed parallelism, proxy pools, or per-platform extractors, and pushing thousands of profiles through it is serial, slow, and risks your real accounts. Don't reach for it to replace Apify's scale, or for Apify when you need to *be* the logged-in user on a page or two.

### Hard Prohibitions — Operative on Every Invocation

**Visual verification goes through Interceptor only. These are forbidden with no exceptions, because each one either takes input or focus away from the operator or yields evidence the isolation gate never checked:**

- **`screencapture`** — the raw macOS screenshot binary. Not as a primary tool, not as a fallback when Interceptor wedges, not "just for one screenshot." Forbidden.
- **`osascript` for Chrome control** — no `tell application "Google Chrome" to activate`, no `set frontmost of process`, no `set bounds of window`, no `set active tab index`, no `set index of window`, no other window-state mutation. Forbidden.
- **`osascript` System Events keystrokes** — no `key code`, no `keystroke`, no `key down`. These send input to whatever is focused, which steals from the operator. Forbidden.
- **Any focus pull in service of automation** — bringing Chrome (or any app) to the front so a screenshot will land is forbidden. The bridge's CGS / DOM-render paths capture without focus change.
- **Any window-state mutation** — moving, resizing, repositioning, or reordering Chrome windows is forbidden. The operator owns their window arrangement; the agent never touches it.
- **AppleScript-driven tab switching** — `set active tab index of window N` is doubly forbidden: it both pulls focus and changes which tab the operator is looking at.

**These rules survive Interceptor failures.** A wedged Interceptor is NOT a license to use raw OS tools. When Interceptor cannot deliver evidence, the recovery is to fix Interceptor (see WebSocket-wedge gotcha below) or to STOP and tell the operator the verification cannot be captured this run — never to fall back.

**One named carve-out: the `ComputerUse` skill is the single sanctioned caller of a non-Interceptor OS input path, evidence excluded.** Its vision leg drives pixel-only native-app work through a supervised, deny-listed, capped child process that Interceptor cannot address (no DOM, no usable AX handle). Two things do not move: every verify/evidence step still runs through Interceptor (the actor never grades itself), and the prohibitions above still bind everything outside that skill's runner. Any other raw OS path remains forbidden.

**Bridge-routed Computer Use is separate.** `interceptor macos open <app>`, `interceptor macos act <ref>`, `interceptor act <ref> --trusted` (formerly `--os`) and other bridge-routed actions go through the sanctioned bridge surface and are allowed when an intent explicitly requires native app control. The prohibition above is on (a) raw OS-level paths that bypass Interceptor entirely AND (b) focus-pulling purely in service of a screenshot.

### Preflight Isolation Gate (MANDATORY)

Before any `interceptor open|read|act|inspect|screenshot|navigate|tab|monitor|net|cookies|scroll|click|type` lands in Chrome, the workflow runs the gate. Prefer the **auto-recovering entry point** — it runs the gate and, if the test profile window just isn't open, launches it and re-verifies before returning:

```bash
bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/EnsureTestProfile.sh"   # runs the gate; on exit 5/6 waits out a grace window, refuses if a test-profile window already exists, and launches at most once per 90s machine-wide; prints READY on success
```

`EnsureTestProfile.sh` wraps `PreflightIsolation.sh` (the raw gate — still callable directly when you want no auto-launch). Both exit non-zero on any unrecoverable failure; on non-zero, STOP and surface — never fall back to Default. The gate asserts these invariants:

1. **Binary version >= 0.23.16** (the floor in Version floor above; `PreflightIsolation.sh` enforces it) — older builds silently ignore `--context` and fall back to whichever Chrome connection the daemon can find. That fallback is how a tab lands in the operator's Default window.
2. **The pinned test context is connected** — matched whole-field against the UUID column (not a substring grep, so a header or partial collision can't false-pass). Without it, the operator's Default profile is the only available target.
3. **Target is not Default.** The context the next command will hit is resolved and checked against Default and the `INTERCEPTOR_WORKING_PROFILE_IDS` deny-list before any tab is touched. A Default/working-profile match is a hard stop (exit 7).
4. **Extension freshness (graceful).** `Extension/PINNED_FROM.txt` (manifest version + content SHA256) is compared against the upstream `$INTERCEPTOR_SRC/extension/dist` **if present**. Mismatch → fail with re-pin remediation. Upstream absent (currently true) → WARN and continue. This does NOT key off `status --verbose` (that command exposes no extension-build field).

On failure the script prints a structured remediation message to stderr; surface it as written.

Exit codes (for handlers that need to discriminate):
- `2` — interceptor binary not on PATH
- `3` — version string unparseable
- `4` — version below minimum (upgrade via `Intents/Update.md`)
- `5` — no browser contexts connected (Chrome closed or extension dead)
- `6` — pinned test context missing (one-time profile setup needed)
- `7` — resolved target is Default or a working profile (hard stop)

The gate is doctrine. It runs unconditionally — for read-only public-page fetches, for authenticated tooling verification, for screenshot capture, for everything. There is no "safe to skip" case, because every silent fallback to Default is a violation of the operator's window.

### Isolation Doctrine (CRITICAL — hard rule; `--context` enforced in code by InterceptorContextGuard)

**What enforces this now (2026-10-24).** Nothing reads your Bash command any more. Until 2026-10-24 PreToolGuard's InterceptorContextGuard denied any `interceptor` browser verb whose context was not the pinned test context; that guard was retired in the native-security change (ISA `20261024-native-security`), and the fix is meant to live in the tool itself, so the interceptor CLI defaults to the pinned test context. Until that lands, the rule is yours to follow: pass `--context <id>` (or set `INTERCEPTOR_CONTEXT=`) on every browser verb, with the literal id from `preferences.env`, or `$INTERCEPTOR_TEST_CONTEXT_ID` in a command that sources `preferences.env` first (the Bash tool keeps no env between calls, so an unsourced variable expands to nothing). The local verbs (`status`, `contexts`, `tabs`, `session`, `diagnose`, `init`, `daemon`, `skills`, `manifest`, `research`, `upgrade`, `update`, `mcp`, `completion`, `help`, `version`) and the `macos` / `ios` surfaces need no context. `Tools/Capture.sh` and `Tools/PreflightIsolation.sh` call interceptor themselves with the pinned context.

**Every browser command runs against the pinned, isolated Interceptor test context — ALWAYS that context, NEVER the operator's Default profile, NEVER their working/monitoring profiles.** This is a constitutional rule, not a preference.

- **The target context is `INTERCEPTOR_TEST_CONTEXT_ID`** from `preferences.env`. It is commonly pinned to a raw context UUID. Name and UUID share ONE `chrome.storage.local` key: both survive Reload and a Chrome restart, both are wiped by Remove + Load Unpacked. The friendly name `interceptor-test` (set once in the extension popup) is still the better pin because a human can re-type it after a wipe, whereas a minted UUID cannot be restored (see UUID-rot below; public issue #2010, @dsather).
- **The isolation boundary is Chrome PROFILE, not user-data-dir.** The test profile lives inside the same Chrome installation as the operator's Default profile but with separate cookies, tabs, and window. It IS signed into the accounts the tooling under test needs (the services and dashboards you verify) — that's the whole point. A `--user-data-dir` sandbox would be useless because it has zero auth and can't reach any of the operator's signed-in tooling.
- **The operator's Default profile is read-only by default.** Never open a tab, click, type, navigate, or record in Default unless the operator explicitly says so ("verify in my Default profile", "use the main window"). When they do, route via `--context <default-id>` after `interceptor contexts` confirms the connection.
- **"Different app" is NOT a safety net — the operator's own browser may be Chrome too.** When the operator browses in a different application, mistaking their window for the test context is self-correcting. It isn't when both are Chrome. Then the ONLY thing separating their browsing from your automation is the profile pin, so treat every unrecognized Chrome context as theirs, and hand them a URL with `open -a "Google Chrome" "<url>"` (their normal profile) rather than by navigating a context you control.
- **One-time setup lives in `Intents/LaunchTestProfile.md`** — operator clicks Chrome's avatar menu → Add profile → signs in → loads the Interceptor extension → names the context in the popup.

**RETIRED behavior — never re-derive it.** The old "fall back to the first available / Default context when the pinned context isn't found" rule is DELETED. A missing or stale pinned context is a **hard stop with remediation**, never a fallback. There is no code path that auto-routes to Default.

**Why bare commands are unsafe.** With 2+ contexts connected the daemon hard-errors `multiple extensions connected, use --context <id>`. The moment the operator closes their other browser window (1 context left), a bare command silently auto-routes to whatever single context remains. So `--context "$INTERCEPTOR_TEST_CONTEXT_ID"` (or routing through `Tools/Capture.sh`) is mandatory on every browser verb, not optional, and InterceptorContextGuard denies a browser verb whose context is not the pinned one before it runs (see above).

**UUID rot — the real contract.** The context ID lives in ONE `chrome.storage.local` key: `getOrCreateContextId` reads it first and mints a UUID only when it is absent, so a name and a UUID have identical durability — Reload and Chrome restart keep either, Remove + Load Unpacked wipes either. There is NO auto-rebind anywhere in `Tools/`: a stale pin is a `Capture.sh` exit 6 (the preflight hard stop, its code propagated; exit 3 only when the context drops out after preflight passed) and the operator re-pins by hand — re-type `interceptor-test` in the popup (the name's whole advantage), or copy the newly minted UUID into `preferences.env`. A stale pin NEVER falls through to Default. *(public issue #2010, @dsather — the "guarded auto-rebind" this section used to promise never existed.)*

**Why this is doctrine, not preference.** The operator's Default profile holds the tabs they're actively working in and the tabs their DA has been driving. The cost of one extra flag on every command is zero. The cost of one stray test tab in their working window — a click, an unexpected redirect — is permanent and disruptive.

**Auto-recovery is sanctioned for context-not-connected — via `EnsureTestProfile.sh`, never a bare launch.** The contract:

- It only ever proceeds after `PreflightIsolation.sh` itself exits 0, which whole-field-matches the connected context against `INTERCEPTOR_TEST_CONTEXT_ID` and hard-denies Default/working profiles. Launching the wrong `--profile-directory` therefore can never cause the agent to drive it; preflight would still fail and `EnsureTestProfile` would still stop. The safety lives in the post-launch re-verification loop, NOT in trusting the profile arg.
- Exit 5/6 means "not connected right now", which a daemon restart, an extension reload, or a service-worker recycle also produces for a few seconds, so it never launches on the first miss. It polls the gate for a grace window (12s), refuses a second window when one of the test profile already exists (title suffix `- <Browser> - $INTERCEPTOR_TEST_CHROME_PROFILE_NAME`; wait and surface), and launches at most once per 90s machine-wide (`/tmp/interceptor-ensure-launch.lock`; a sibling session inside the cooldown waits for that launch). Only then does it launch the CONFIGURED test profile and re-run the gate until the pinned context connects. Mechanism and tunables: the header of `Tools/EnsureTestProfile.sh`; tests: `Tests/EnsureTestProfile.test.ts`.
- **Exit 7 (resolved target IS Default/working) and exit 8 (test context unset) NEVER trigger a launch** — those surface and stop.
- A *bare* `LaunchTestProfile.sh` with no re-verification is unsafe on its own: always go through `EnsureTestProfile.sh`.
- If the launch succeeds but the pinned context never connects (UUID rot after the extension was removed and re-added; a plain Reload keeps the id), it never rebinds to an unidentified UUID: `EnsureTestProfile` surfaces the one-time durable fix (name the context `interceptor-test` in the popup) and stops — it does not guess.
- Every READY runs `Tools/PinTestWindow.sh`, which lists windows of the PINNED context only (`interceptor window list --context`) and moves any that drifted back to `INTERCEPTOR_TEST_WINDOW_BOUNDS` (`left,top,width,height`, chrome.windows screen coordinates; unset = never moved). Never move a window by osascript; never move a window outside the pinned context.

Gotchas for this gate:

- *(2026-09-06)* The old first-miss launch, multiplied by a daemon restart loop and several parallel sessions, filled the test profile with blank windows. The grace window, window check and launch lock exist because of it.
- *(2026-09-07)* `--new-window` carries no position, so Chrome dropped each new test-profile window wherever the last-active window was, and the operator kept finding "the wrong browser" on the wrong screen. The launcher also passes `--window-position`/`--window-size` from `INTERCEPTOR_TEST_WINDOW_BOUNDS`, but those flags are read from the browser's own command line and are ignored when forwarded through a running instance — the post-READY pin is the path that works.

### Rendering-Lifecycle Gate — the hidden-tab trap (MANDATORY for motion/responsive work)

**Chrome suspends the entire rendering lifecycle for any tab whose window is not visible** — minimized, fully occluded by another window, or on an inactive Space. In that state:

| Still works (so measurements look fine) | Silently dead |
|---|---|
| `setTimeout` / `setInterval` (throttled to ~1/s) | `requestAnimationFrame` |
| `getBoundingClientRect()` — forces layout on demand | `ResizeObserver` |
| CSS media queries / static layout | `IntersectionObserver` |
| DOM reads, `screenshot` (DOM-render path) | CSS transitions + animations, lazy-load, scroll-reveal |

This is the dangerous kind of failure: nothing errors. A responsive or animated page returns confident, well-formed numbers showing *nothing happened*, and the natural conclusion is "the feature doesn't fire" or "it works, no change detected." Measured live 2026-07-30: over 5s with two real element resizes, the pinned test context reported `visibilityState: hidden`, **0 rAF ticks and 0 ResizeObserver callbacks**, while `setInterval` ticked 5 times.

**The rule: any claim about animation, transitions, ResizeObserver/IntersectionObserver behavior, lazy-loading, scroll-reveal, viewport-responsive layout, or WHETHER A REMOTE IMAGE LOADED MUST come from `Tools/VerifyViewport.ts`, never from the standard test context.** Driving a component's own recompute by hand to "prove" it works is testing your code with your own hand, not verifying the browser.

**"Is this image on the page" is a lifecycle claim, and it does not feel like one.** Lazy-loaded images are the most common asset on the web and they load through `IntersectionObserver`, which is suspended in a hidden tab — so `document.querySelectorAll("img")` returns an honest, confident, empty list for a page whose images are all fine. The reasoning that fails here is "I'm only asking whether an element exists, that's a plain DOM read." It isn't: existence of a lazy asset is a function of the lifecycle. *(2026-08-19: a published page was reported as missing its cover image, on a test-context eval finding no large images. `VerifyViewport.ts` found the cover immediately, at the exact dimensions uploaded.)*

```bash
bun "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/VerifyViewport.ts" check
bun "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/VerifyViewport.ts" probe <url> --widths 1440,1100,880 --expr @probe.js
bun "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/VerifyViewport.ts" shot  <url> --width 880 --out ~/Downloads/x.png
bun "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/VerifyViewport.ts" stop
```

**How it works, and why it can't be done any other way.** The anti-throttling switches (`--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`, `--disable-background-timer-throttling`) only take effect at **browser-process launch**, and one browser process serves one `--user-data-dir`. They therefore can never be applied to an already-running Chrome, and `--profile-directory` shares that process — so no amount of profile juggling fixes the operator's browser. VerifyViewport runs a **separate headless Chrome in its own `--user-data-dir`** with those flags. Headless creates no window at all, so it puts nothing on the operator's desktop and there is no window state left to depend on — while running the same renderer, with the full lifecycle live. `INTERCEPTOR_VERIFY_HEADFUL=1` gives a real (off-to-the-side) window when you need to watch a flow with your own eyes.

It is driven over **CDP** (`interceptor macos cdp`) rather than the extension, because `--load-extension` is dead in current Chrome (silently ignored — confirmed on 152, feature-flag workarounds included) and a custom `--user-data-dir` gets its own empty `NativeMessagingHosts`. Viewport size is set with `Emulation.setDeviceMetricsOverride`, a real layout-viewport change that fires the page's own observers **without moving, resizing, or focusing any window** — which is the whole point: verification must not depend on where the operator left their windows.

`check` and every `probe`/`shot` **assert** the lifecycle is live (`visibilityState === visible` AND rAF actually ticking) and exit non-zero otherwise. There is no degraded mode; a lifecycle failure is a hard stop, never a quiet measurement.

**Scope.** Authenticated pages and real sessions stay on the extension-driven test context — the verification instance has no logins. Use it for public pages whose *behavior over time* is what's under test.

### Install Modes

Two install modes, same CLI binary. Confirm with `interceptor status` and read the `mode:` line:

| Mode | What's installed | What unlocks |
|------|------------------|--------------|
| **`mode: full`** (default for this skill) | CLI + daemon + extension + Swift bridge `.app` + LaunchAgent | Browser automation **plus** Computer Use: AX tree, OS-level trusted input, ScreenCaptureKit, Vision OCR, Speech, NLP, Apple Events, OSLogStore, file watching, container runtime, **VM lifecycle** |
| **`mode: browser-only`** | CLI + daemon + extension | Browser automation only. `interceptor macos *` returns a structured `setup_required` error in under 1s. No TCC prompts. |

Promote a browser-only install with `interceptor upgrade --full`. Downgrade with `bash scripts/uninstall.sh --bridge-only`.

**Install channels:**
- `Interceptor-Browser-<v>.pkg` → `mode: browser-only`
- `Interceptor-Full-<v>.pkg` → `mode: full`
- `bash scripts/install.sh --browser-only|--full` → dev path
- Linux browser-only supported (Microsoft Edge and Vivaldi also recognized)

Operating rule: if the user asks for native and `status` reports `mode: browser-only`, respond *"I'm on a browser-only install. Run `interceptor upgrade --full` to enable that."* Don't run the macos command anyway to see what happens — the preflight short-circuits, but it wastes turns.

### Prerequisites

- Chrome or Brave (or Edge/Vivaldi on supported platforms) running with the Interceptor extension loaded — the signed `.pkg` installer registers it; on a from-source build, load it once via `chrome://extensions/` → Developer Mode → "Load unpacked" → the `Extension/` directory `Tools/Pin.sh` creates
- `interceptor` CLI in PATH (`/opt/homebrew/bin/interceptor`)
- `interceptor-daemon` in PATH (`/opt/homebrew/bin/interceptor-daemon`)
- Native messaging manifest registered (the signed `.pkg` does this; from source, `bash "$INTERCEPTOR_SRC"/scripts/install.sh --chrome --skip-extension`)
- **macOS bridge** as a LaunchAgent (full mode only) — see `Intents/Update.md`
- **Sparkle.framework** embedded in the bridge `.app` at `Contents/Frameworks/` (full mode, v0.10.0+) — the bridge links it for auto-update; the signed `.pkg` and `build-bridge.sh` both embed it, so no separate `/usr/local/Frameworks` copy is needed

Quick health check:

```bash
interceptor --version          # → "interceptor 1.0.21 (<hash>, <date>)" on the reference machine — 0.23.16+ is the floor (see Version floor above)
interceptor status             # → daemon: running, bridge: running, mode: full|browser-only
interceptor status --verbose   # → adds extension reachability (NO extension-build field; with 2+ contexts it nags "multiple extensions connected" even with --context)
interceptor contexts           # → list of connected browser contexts (multi-profile)
interceptor init               # → one-time write of ~/.config/interceptor/config.toml
```

### Background-First Contract

The whole product is background-first. Routine work never moves the user's focus.

| Surface | Verbs that move focus | Everything else |
|---|---|---|
| **Browser** | `open --activate`, `tab new --activate`, `tab switch <id>`, `window focus <id>` | Stays on whatever the operator was looking at — `click`, `type`, `read`, `inspect`, `screenshot`, `net`, `cookies`, `scroll`, `act`. New tabs land in the background by default. |
| **macOS** | `app activate <app>`, `open <app> --activate` | Stays on whatever was frontmost — `open` (no `--activate`), all input verbs, AX reads, capture, menu, intent dispatch, vision, overlays. |

If you call any verb not listed in the "moves focus" column and the frontmost changes, that's a bug.

**Reuse path:** `open --reuse` navigates the existing managed tab without leaving dead tabs behind. Preserves the reused tab's focus state — pair with `--activate` only when the user explicitly says to bring it forward.

### Multi-Context Routing

When multiple browser profiles are connected (e.g., personal Chrome + isolated test profile + work Brave), commands need to know which one to drive.

```bash
interceptor contexts                                          # List connected context IDs
interceptor open <url> --context "$INTERCEPTOR_TEST_CONTEXT_ID"  # Route to the isolated test profile (DEFAULT)
interceptor open <url> --context <main-id>                    # Route to the operator's personal Chrome (only when explicitly requested)
```

Zero or 2+ connected contexts fail fast with a structured error, and exactly one auto-routes silently (see Why bare commands are unsafe), so every browser verb carries `--context "$INTERCEPTOR_TEST_CONTEXT_ID"` or goes through `Tools/Capture.sh`.

Context IDs are set via the Interceptor extension popup (click the toolbar icon → Context ID field → Save). One-time setup; the daemon remembers across restarts. Set the friendly name `interceptor-test` here to end UUID rot.

### Computer Use — macOS Native Helper

The bridge is a Swift LaunchAgent that runs as the user and exposes capabilities the Chrome extension cannot provide on its own:

- **OS-level trusted input** (`interceptor act <ref> --trusted`, `macos type --trusted`, `macos keys --trusted` — posts events with HID source state, for apps and pages that accept only real user input)
- **Native macOS app control** (`interceptor macos open/read/act/inspect` — same surface as the browser, against any running app)
- **Accessibility tree** of any running app for inspection without screenshots
- **Screen capture beyond Chrome** (full-screen, off-tab, multi-display, occluded windows)
- **VM lifecycle** (`interceptor macos vm create/clone/start/exec/snapshot/restore/stop/delete` — Linux + macOS guests, replaces Lume/Tart/UTM)
- **Clipboard r/w**, audio listen + speech recognition, system notifications, Vision OCR, NLP, Apple Intelligence, HealthKit, display info
- **Apple Events dispatch** to named bundle IDs without activation
- **OSLogStore predicate queries**, filesystem search/watching, URL fetch
- **Monitor** (cross-app workflow recording with optional clipboard/files/network/log/notifications/speech channels and `--frames` screenshot capture)

**Status check:** `interceptor status` reports `bridge: running` with PID + socket when it's up, or `bridge: not running` with a hint when it isn't.

**Lifecycle (install / verify / troubleshoot / uninstall) lives in `Intents/Update.md`.** The Update intent handles binary placement, the `.app` bundle with its embedded Sparkle framework, LaunchAgent plist, `launchctl bootstrap`, and TCC prompts in the right order.

**Security model — read before installing:**

- Transport is a **UNIX domain socket** at `$TMPDIR/interceptor-bridge.sock` (the legacy `/tmp` path before 1.0.1; `Intents/Update.md` step 5). Local-only; no network listener.
- **No authentication on the socket.** Any local process running as your user can connect and execute every bridge action. macOS TCC permissions (Accessibility, Screen Recording, Microphone — the `trust` probe keys are `accessibility` / `screenRecording` / `microphone` / `speechRecognition`, no `inputMonitoring` field) are granted to the bridge once and inherited by every socket client.
- **Marginal risk is supply-chain:** a malicious local package gains a one-step path to OS-level input/screen/clipboard without needing its own permission grants.
- Single-user Mac threat model: acceptable, since anything running as you can already do this with effort. Multi-user Macs need socket hardening.

---

## Compound Commands (Preferred)

These collapse multi-step patterns into single invocations — fewer tool calls, fewer tokens. This is a flag catalog: every line below runs with `--context "$INTERCEPTOR_TEST_CONTEXT_ID"` appended in a command that sources `preferences.env` first, and InterceptorContextGuard denies it otherwise.

```bash
interceptor open <url>                              # Open + wait + return tree + text
interceptor open <url> --reuse                      # Navigate existing managed tab
interceptor open <url> --activate                   # Bring new/reused tab to front (explicit opt-in)
interceptor open <url> --tree-only|--text-only|--full|--no-wait|--include-frames
interceptor read                                    # Tree + text for active tab
interceptor read <ref>                              # Subtree
interceptor read --markdown                         # Render page as markdown (preserves headings/tables/emphasis)
interceptor read --markdown --text-only             # Markdown prose only, no tree
interceptor read --tree-only --tree-format compact  # Actionable refs only
interceptor read --include-style|--include-frames
interceptor act <ref>                               # Click + wait + return updated tree + diff
interceptor act <ref> "value"                       # Type + wait + return updated tree
interceptor act <ref> --trusted                     # OS-level HID-sourced input (was --os; --os is deprecated alias)
interceptor act <ref> --keys "Enter"                # Send keyboard shortcut
interceptor act <ref> --no-read                     # Skip post-action tree read
interceptor inspect                                 # Tree + text + network log + headers
interceptor inspect --net-only|--filter <pattern>
```

**`--trusted` vs `--os`:** `--trusted` is canonical; `--os` is a deprecated alias that emits a warning.

## Command Reference (moved)

The full per-verb CLI listing — macOS Native (Computer Use), VM Lifecycle, Core Browser Commands, Network/Exports, Recording (Session Monitor), Canvas, Scene Graph, LinkedIn, ChatGPT Agentic Bridge, Batch + Meta — lives in `References/CommandReference.md`. Quick pointers:

| Verb tree | Reference section |
|-----------|-------------------|
| `interceptor macos *` (native apps, AX, trusted input, Vision/Speech/NLP, Apple Events, logs, fs, overlay) | macOS Native (Computer Use) |
| `interceptor macos vm *` (Linux + macOS guests, gold image, clone/snapshot) | VM Lifecycle — plus `Intents/VmLifecycle.md` |
| `state`, `tree`, `find`, `click`, `type`, `navigate`, `tabs`, `screenshot`, `eval`, `style`, `cookies` | Core Browser Commands |
| `net log/headers/export`, `override`, `network *`, `sse *`, `headers *` | Network — Passive, CDP, and Exports |
| `monitor *` (record/replay) | Recording (Session Monitor) |
| `canvas *`, `scene *` | Canvas / Scene Graph |
| `linkedin *`, `chatgpt *`, `batch`, `status`, `contexts`, `init`, `upgrade` | LinkedIn / ChatGPT Bridge / Batch + Meta |

## Key Rules

- **Requires Chrome/Brave running** for browser commands — it's an extension, not a standalone binary.
- **Requires bridge running** for `act --trusted`, `macos *`, full-screen capture, VM lifecycle — `interceptor status` confirms.
- **Refs use eN syntax** — `e12` not `@e12`. Treat refs as short-lived; re-`read` or `find` after navigation, rerenders, or DOM mutations.
- **Cross-frame refs** — `read --include-frames` returns refs like `e<frameId>_<n>` for non-top frames.
- **Plain text by default.** `--json` only when piping into a script. Prose-trained models comprehend tree/text output better than dense JSON.
- **Daemon auto-starts** — first command launches it; no manual start needed.
- **Prefer compound commands** (`open`, `read`, `act`, `inspect`) over manual `tab new` + `wait` + `tree` chains.
- **Prefer structured reads over screenshots** unless the task is explicitly visual or pixel-based — tree/text/network/scene/AX data is faster, smaller, and more deterministic.
- **`--markdown` is the structured-prose surface** — preserves headings, tables, emphasis. Use instead of `--text-only` when visual hierarchy disambiguates the answer.
- **Verify with `frontmost` before/after.** Native workflows that promise no focus change should prove it.
- **Never `screencapture`. Never `osascript` for Chrome focus, bounds, tabs, or windows.** Forbidden under Hard Prohibitions. Survives Interceptor failures.
- **Anything lifecycle-dependent goes through `Tools/VerifyViewport.ts`** — animation, transitions, ResizeObserver/IntersectionObserver, lazy-load, scroll-reveal, viewport-responsive layout. The standard test context silently reports zero activity for all of these whenever its window isn't visible. See the Rendering-Lifecycle Gate section.
- **Screenshots go through `Tools/Capture.sh`, never raw `interceptor screenshot`.** Capture.sh runs the preflight gate, enforces the not-Default target check, hard-stops on a stale pin (preflight exit 6 — there is no rebind; re-pin by hand, public issue #2010, @dsather), prefers the DOM-render path, and writes review artifacts to `$LIFEOS_DOWNLOADS_DIR` (default `~/Downloads/` when unset).
- **Tab hygiene: prefer `open --group <label>` during a task, and run `CleanupTabs.sh` once at the end as the backstop.** With named-group reuse (default on), `interceptor open <url> --group <label>` navigates that group's most recent tab instead of opening a new one, so a 40-step automation leaves one tab, not forty. Ungrouped `open` still creates, because in the shared default group the most recent tab could be another agent's; `--reuse` opts in anywhere, `--no-reuse` forces a new tab, and `tab new` (the ⌘T verb) always creates. Under Claude Code, Codex, or Maestro the CLI gives each session a soft group `s-<hash16>` derived from the session id (or `INTERCEPTOR_SESSION_ID`), so bare `open` calls reuse that session's tab and concurrent lanes stay isolated; `--shared-group` opts out (0.23.37+). Idle managed groups auto-close after 10 min (0 disables), never touching the focused window's active tab, a pinned tab, an audible tab, or a window's last tab; closed tabs are ⌘⇧T / `interceptor session restore` recoverable. Both policies are set only from the extension popup, and `interceptor status --verbose` shows the resolved policy (`tabLifecycle` field). The backstop is `bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/CleanupTabs.sh"`: it closes non-active tabs in the PINNED test context only, keeps the active tab (window stays alive), honors `--keep-url <substr>`, refuses Default/working profiles, and exits 0 when the context isn't connected. *(Stale tabs piled up 2026-07-13, before the lifecycle policy existed.)*

## Delegating to Agents

When spawning agents for Interceptor work:

```
Agent(subagent_type="general-purpose", prompt="
  Use interceptor CLI for all browser and macOS automation work.
  Browser: open <url> --context "$INTERCEPTOR_TEST_CONTEXT_ID", read [--markdown], act eN, inspect. Screenshots go through Tools/Capture.sh, never raw screenshot.
  Native (macOS): macos open <app>, macos read, macos act <ref>, macos inspect, macos vm *.
  Compound commands preferred — they return tree + text in one call.
  Refs use eN syntax (no @ prefix) from tree output. Treat refs as short-lived.
  Background-first: only --activate and app activate move focus.
  PROFILE ISOLATION (MANDATORY GATE): the FIRST action of this task is
    bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/PreflightIsolation.sh"
  If that script exits non-zero, STOP and surface the message verbatim — do NOT
  fall back to operating against the Default profile, and do NOT use screencapture
  or osascript as substitutes. After the preflight returns OK, every browser
  command sources preferences.env in the same Bash call (the Bash tool keeps no
  env between calls, so an unsourced variable is denied):
    source "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env" && interceptor <verb> ... --context "$INTERCEPTOR_TEST_CONTEXT_ID"
  Never operate in the operator's main profile unless the parent agent explicitly says so.
  `act --trusted` for OS-level HID input (was --os).
  FINAL action after your work is done and evidence captured: run
    bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/CleanupTabs.sh"
  to close the tabs you opened in the test profile (keeps the active tab).
  [your specific task instructions here]
")
```

## Examples

- "Verify the blog deploy" → VerifyDeploy: preflight isolation gate, `interceptor open <url> --context "$INTERCEPTOR_TEST_CONTEXT_ID"`, `read --markdown`, capture via `Tools/Capture.sh`, report with evidence.
- "The menu animation looks off / does the checkout flow render clean" → ScrubFlow: record the flow to video, `bun Tools/FrameScrub.ts <recording> scrub --at <sec>`, Read the auto-flagged frame, cite the manifest. Motion/interaction ISCs require this or a flow-gallery, not a single still (Algorithm Rule 1).
- "Why is this page blank after deploy?" → Reproduce: open the page FIRST, `eval --main` console-error capture, `net log` for failed requests, then code analysis.
- "Record me approving this flow, then replay it nightly" → RecordFlow + ReplayFlow: `monitor start`, operator acts, `monitor export <sid> --plan`, replay the plan script later.

## Gotchas

- **Codex macOS sandbox launch failure (2026-09-09).** `CODEX_SANDBOX=seatbelt` blocks desktop-service access and direct Chrome launches can abort in `_RegisterApplication`. EnsureTestProfile, LaunchTestProfile, and VerifyViewport return exit 10 before attempting work in this environment. Re-run the same command using the harness's approved execution mechanism outside the sandbox. Do not unset the marker or retry the browser binary inside the sandbox. A daemon connection failure here does not establish a missing profile or extension.

- **`interceptor` dying instantly with rc=137 and ZERO output = invalid code signature, not a wedge.** The kernel SIGKILLs adhoc-signed binaries whose signature went stale (observed 2026-06-10 after a system event; both binaries affected). Diagnose: `cp` the binary to /tmp, `codesign -s - -f` the copy, run it — if the copy works, re-sign the real ones: `codesign -s - -f /opt/homebrew/bin/interceptor && codesign -s - -f /opt/homebrew/bin/interceptor-daemon`. BOTH must be re-signed — the CLI spawns `interceptor-daemon --standalone` and a still-broken daemon yields "daemon failed to start. Check /tmp/interceptor.log" with the log never created. *(2026-06-10.)*
- **Screenshot — how it actually works (0.22.2).** Route every capture through `Tools/Capture.sh`; the raw behavior below is what it wraps.
  - **Default `interceptor screenshot` is the DOM-render path** — a **dependency-free native renderer since v0.18.3** (`html-to-image` was removed; injected on demand via `executeScript`). It renders from the live DOM tree and does **NOT** require a foreground/visible tab — a backgrounded tab on another macOS Space or behind other windows is fine, and it's fail-fast (no more full-timeout hang on a backgrounded tab). The one visibility state it does refuse is a **minimized window** (both DOM-render and `--pixel` fail in the extension; `Tools/Capture.sh` exits 13 with an un-minimize message instead of misreading it as a wedge — public issue #2013, @dsather).
  - **`--pixel` is the opt-out** → legacy `captureVisibleTab`. It captures the window's *active* tab, so to capture a specific background tab it briefly activates it and restores focus — **the visible flash is by design**. `--pixel` REQUIRES the window non-minimized and visible; minimized → fast honest failure. Full-page `--pixel` rate-limits strips at 1100ms (Chrome's 2/sec cap) and stitches in the service worker.
  - **Reliability is the default path, not a flag.** There is no "reliable mode" toggle. The robustness today is the in-extension minimized-window preflight (fails fast instead of hanging ~30s) plus the CLI's 45s screenshot timeout. The `cli/lib/screenshot-selfheal.ts` wrapper is **dormant/unwired** — do not cite it.
  - **`--save` writes to the CLI's current working directory** and returns `filePath` (omits `dataUrl`). It does NOT write to any fixed directory — intents `cd` to their target dir first precisely because `--save` targets CWD. There is no `--output <path>` flag; positional path args are silently ignored. Per OPERATIONAL_PREFERENCES, review artifacts belong in `$LIFEOS_DOWNLOADS_DIR` (default `~/Downloads/` when unset), pipeline intermediates in `/tmp/`; `Tools/Capture.sh` standardizes this.
  - **Without `--save`, `screenshot` returns the full base64 `dataUrl` inline** — 10MB+ of PNG flooding the transcript. Always `--save` from an agent context.
  - Flags `--target-max-long-edge N` (clamp long edge, dodges the 16384 Skia ceiling), `--scale`, `--selector`, `--element N`, `--region X,Y,W,H` run inside DOM-render; `--clip` is a deprecated alias for `--region`.
- **DOM-render screenshots don't paint UA default widget chrome — button/input contrast bugs pass invisibly.** A bare `<button>` with no CSS `background` renders the UA's white/#efefef background in the real browser (worst on iOS Safari), but the DOM-render capture paints it as if transparent, so a white-on-white contrast bug looks fine in the screenshot (2026-08-07: a site's share buttons shipped unreadable on mobile after a clean-looking capture). Contrast claims on form controls need `getComputedStyle(...).backgroundColor` (transparent = UA bg will show) or a `--pixel` capture, never the DOM-render default. Textarea/input *values* set via property are likewise not painted.
- **DOM-render screenshots drop CSS pseudo-element generated content.** `::before`/`::after` content — CSS counters especially — renders in the live browser but vanishes from the default DOM-render capture, so a page can look broken in the screenshot while fine on screen. Confirm via `eval --main` geometry/computed-style before "fixing" the page; for content you author, prefer real DOM text over CSS counters. *(2026-07-11, found via a missing numbered rail that eval proved present.)*
- **DOM-render captures can fake text layout on pages that use `@font-face` web fonts.** The capture showed labels colliding, wrapping and ellipsised that live `getBoundingClientRect` reads and a `Tools/VerifyViewport.ts shot` compositor capture proved absent, and a design critique fed those captures scored the phantom collisions as critical defects. Probable cause (inferred, not proven): the renderer measures with substituted system fonts, so tracked uppercase labels come out wider. Confirm any wrap, overlap or ellipsis seen in a DOM-render capture with eval geometry or VerifyViewport before reporting it or handing it to a critique; appearance evidence for a web-font page comes from `VerifyViewport.ts shot` or `Capture.sh --pixel`. *(2026-09-24, a dashboard page verified by an independent reviewer.)*
- **`VerifyViewport.ts shot` can return another session's page.** The headless instance is one per machine, so a parallel session navigating it between your navigate and your capture wins: two `shot` calls on a local page (one `file://`, one served over HTTP) both came back as a different session's chart. Read every shot back and confirm it is your page before citing it; when another session holds the instance, use `Tools/Capture.sh <url>` in the pinned test context instead. *(2026-09-24.)*
- **DOM-render screenshot ignores scroll position by default.** `interceptor screenshot` captures from y=0 of the document — `window.scrollTo` / `scrollIntoView` / `keys End` do not move the screenshot frame. For tall pages, use `--region X,Y,W,H`, `--selector <css>`, `--element <ref>`, or `--pixel --full` (scroll-and-stitch, requires window visible). *(2026-04-27, still relevant 2026-06-17.)*
- **`click` on a checkbox can report `clicked [eN]` without toggling it.** Observed on real forms (2026-07-18): label-wrapped `<input type="checkbox">` — `click` succeeded, form posted with the box unchecked, and `act <ref>` on the same element errors "unsupported input type". Verify checkbox state after clicking (`eval --main '...checked'`), and when it didn't stick, set `checked=true` via `eval --main` on the form and submit the REAL form (`form.submit()`) — still the genuine session/CSRF/POST path. Never assume a reported click toggled state.
- **When two agent sessions share the test context, `--current` captures and bare `read`/`eval` follow the ACTIVE tab — which the other session keeps changing.** Same class as the `--pixel` wrong-page gotcha (2026-06-11), hit again 2026-07-18: `Capture.sh --current` shot the other session's tab. Always pass the URL to `Capture.sh <url>` (navigate-then-capture is atomic in the managed tab) and re-`open --reuse` before every read/eval burst; skip `CleanupTabs.sh` when another session's tabs live in the window — closing them is worse than leaving your one managed tab.
- **Multiple tabs at the same URL confuse routing without `--context`.** When two tabs both load `localhost:5180/`, `tab switch <id>` reports `ok` but the visually-active Chrome tab may not change. Either close duplicates, work from a freshly-opened single tab, or pass `--context <id>` to scope unambiguously.
- **`eval` is CSP-blocked on most sites.** Use `eval --main` to run in the page's main world. Even with `--main`, strict CSP (`script-src 'self'`) still blocks string-eval; pass small expressions, avoid `Function`-constructor patterns.
- **Bridge needs Sparkle.framework.** When rebuilding from source on Apple Silicon, the bridge won't load until `Sparkle.framework` is embedded in the `.app` at `Contents/Frameworks/`; a fresh clone can build without it, so ditto it into the path `build-bridge.sh` expects (`References/UpdateRecovery.md` § Bridge build on a cloud-synced machine) and rebuild. The running bridge is the `.app`-bundle binary at `~/.local/share/interceptor/interceptor-bridge.app/Contents/MacOS/interceptor-bridge` (LaunchAgent `com.interceptor.bridge`, plist `~/Library/LaunchAgents/com.interceptor.bridge.plist`), NOT `/usr/local/bin/interceptor-bridge` (stale copy). The Update intent handles this; symptom of forgetting is `bridge: not running` with `dyld[*]: Library not loaded: @rpath/Sparkle.framework/...` in `/tmp/interceptor-bridge.stderr.log`. *(2026-05-03, bridge topology corrected 2026-06-17.)*
- **Manifest version bump = manual extension reload + re-pin required (from-source installs).** Chrome does not auto-reload unpacked extensions, and the pinned `Extension/` copy does not auto-follow upstream. After a source rebuild, re-pin via the Update intent, then reload with `interceptor reload` (the zero-touch gotcha below); Load Unpacked again only when the card comes back disabled or missing. The extension `key` is deterministic so the extension ID stays stable across reloads. On a signed-`.pkg` install the installer handles this.
- **"native port disconnected" is NOT a screenshot error.** It's the daemon logging that Chrome's Native-Messaging stdio port dropped (extension SW recycled / Chrome closed); the daemon survives and falls through to its WebSocket transport. If neither WS nor relay is up, commands queue (cap 50) and time out. **Fix = reconnect the extension** (reload the tab / re-open the configured browser), not restarting the daemon.
- **"screenshot-runner.js could not load" = per-frame injection failure.** (The old "html-to-image library not loaded" error is gone — v0.18.3 replaced the library with a native renderer.) The page disallows script injection (`chrome://`, Web Store, PDF viewer, strict-CSP frame), the tab navigated mid-inject, OR — most common after a binary upgrade — a **stale loaded extension** whose bundled runner doesn't match the daemon. As of 0.22.37 a failed DOM-render capture **auto-falls back to `--pixel`** so you usually get an image anyway (result discloses the fallback; `--no-fallback` opts out) — but the stale-extension root cause still wants fixing: **reload the extension** — reinstall from the signed `.pkg`, or on a from-source install re-pin and Load Unpacked again from the pinned `Extension/` directory.
- **Daemon↔extension WebSocket can wedge in a half-alive state — try other verb trees BEFORE declaring Interceptor unusable.** Symptom: `status`/`contexts`/`tabs` answer (control-plane message types) while `screenshot`/`eval` hang at timeout (data-plane types). Each verb in the Capabilities Overview uses a different WebSocket message type, so a wedge on `screenshot` rarely affects `eval`, `net log`, `tree`, `read --markdown`, `monitor`, or `inspect`. Recovery ladder: (1) **swap the capture path** (pixel↔DOM-render — a different message type often unwedges) or substitute a verb from another capability class — `read --markdown` / `eval --main document.body.innerText` instead of `screenshot`, `net log` for failed requests; (2) restart the singleton daemon **by pid** — `kill "$(interceptor status | awk '/^daemon:/{d=1;next} d && /^pid:/{print $2; exit}')"` (the KeepAlive LaunchAgent respawns it; never `pkill -f interceptor-daemon`, which also kills Chrome's per-profile relay daemon and the invoking shell — public issue #2011, @dsather) + a single retry; (3) reload the extension (surface: *"Interceptor extension is wedged — please reload it from chrome://extensions/."*) and STOP. Only after all three fail, tell the operator verification cannot be captured — **never fall back to `screencapture` / `osascript`.** **The recurring mistake this catches: claiming "Interceptor is broken" after a single `screenshot` timeout when `eval` would have answered the question in one tool call.** *(2026-05-13, sharpened 2026-06-17.)*
- **Dead-bridge self-heal (macOS `macos_*` paths only — browser screenshot does NOT need the bridge).** "Loaded" ≠ "running" — probe the process via `interceptor status`, not just `launchctl list`:
  ```bash
  interceptor status | grep -A2 '^bridge:'                         # running + pid/socket, or not running
  launchctl print "gui/$(id -u)/com.interceptor.bridge" 2>&1 | grep -E 'state|program|pid'
  launchctl kickstart -k "gui/$(id -u)/com.interceptor.bridge"     # restart (loaded-but-dead)
  ```
  The agent runs the `.app`-bundle binary (`~/.local/share/interceptor/interceptor-bridge.app/Contents/MacOS/interceptor-bridge`), NOT `/usr/local/bin/interceptor-bridge` (that copy is stale). A SIGKILLed bridge with a stale ad-hoc signature restart-loops every ~5s (`ThrottleInterval`) — re-sign the `.app` MacOS binary, not the `/usr/local/bin` copy. `Tools/HealBridge.sh` wraps the loaded-but-dead detect + single kickstart. *(2026-06-17.)*
- **`AXEnhancedUserInterface` was removed from the bridge** (it foregrounded AppKit apps as a side effect of being interpreted as "VoiceOver active"). The bridge uses `AXManualAccessibility` exclusively for Electron wake-up. Stale guidance from old code that sets `AXEnhancedUserInterface` should be ignored.
- **`screenshot --pixel --tab <id>` can capture the WRONG page — `--pixel` follows the active tab.** `--pixel` is `captureVisibleTab`; it shoots whatever tab is visually active, and if the preceding tab activation didn't land, that's the operator's foreground tab, not your target (observed 2026-06-11: requested a localhost site under test, captured the operator's unrelated foreground site instead). Always Read the returned image and confirm it's the page you asked for before citing it as evidence — this is why `Tools/Capture.sh` reads back on the `--pixel` fallback path. This bleed can also capture a SENSITIVE operator window (2026-07-18: a `--pixel` recapture during deploy verification returned a live private admin dashboard the operator had open — forbidden to screenshot; file deleted on read-back). For re-verification recaptures of a page already open in the test tab, prefer the DOM-render default plus an asset byte-compare over another `--pixel` roll. Do NOT reach for AppleScript tab activation — banned under Hard Prohibitions. Instead answer through a non-visual verb tree (`read --markdown`, `eval --main`, `net log`), or follow the WebSocket-wedge recovery ladder above. *(2026-06-11; AppleScript workaround removed 2026-06-13.)*
- **A full-page screenshot cannot settle an appearance claim about fine detail — zoom first.** Images are downscaled to roughly 1568px on the long edge before the model sees them, so on a 2000px-wide page a 40px logo arrives as a smudge. Cropping the delivered screenshot does not recover it; the detail was destroyed upstream. `bun Tools/Zoom.ts <image> --x N --y N --w N --h N` crops from the full-resolution original and magnifies that region to the budget, so the pixels land on the thing under test. Reach for it whenever the claim is about a logo, glyph, font rendering, icon, or spacing of a few pixels — the class of claim behind the wrong-logo incidents (2026-07-19), where "the element is there" was confirmed while "it is the right element" was not. Coordinates are absolute pixels in the source image; a DOM-coordinate read (`eval`) gives you the region to pass. Backends: `magick`, else `ffmpeg`. *(public PR #1657, @elhoim.)*
- **Sensitive-app gate.** The bridge rejects `type`/`keys`/`click x,y`/`drag` when frontmost is a denylisted bundle (Keychain, 1Password, Dashlane, LastPass, Bitwarden, System Settings, Chase, Bank of America, Wells Fargo). Surface the rejection — do not bypass.
- **VM `paused-state` snapshots are gated.** `--paused-state` requires `validateSaveRestoreSupport()` to return true on the VM config. macOS guests support it; some Linux configurations don't. `--disk-only` always works.
- **TCC grants for VM hosts:** the bridge needs `com.apple.security.virtualization` entitlement. Move the bridge out of `~/Documents` or `~/Desktop` if `setup_required` complains about the install location.
- **Local extract.ts customization is obsolete.** The pre-v0.13 patch that bumped slice limits to 10M is no longer needed — upstream's `withTruncationMarker` + `--full` flag + per-action `maxChars` does it correctly with explicit truncation markers (`... (truncated: showed X of Y chars ...)`).
- **Stale binary silently routes to Default — the fallback incident (2026-05-23).** A rebuild that lands at `$INTERCEPTOR_SRC/dist/` but never gets copied into `/opt/homebrew/bin/` leaves the CLI at an old version. Old binaries do not recognize `--context` or the `contexts` subcommand — they accept the flag without error and proceed to route the command through whichever Chrome connection the daemon can find, which is normally the operator's Default profile. Symptom: agent calls `interceptor open <url> --context "$INTERCEPTOR_TEST_CONTEXT_ID"`, expects an isolated tab, gets a tab in the operator's working window. Detection: `interceptor --version` reports a version older than `0.16.0`, AND/OR `interceptor open --help` shows no `--context`-related flag, AND/OR `interceptor contexts` returns "unknown command". Mitigation: the **Preflight Isolation Gate** (above) hard-fails on version mismatch with exit code 4 — every intent runs it as step zero. Recovery is `Intents/Update.md` followed by `launchctl kickstart -k "gui/$(id -u)/com.interceptor.daemon"` (or `kill` the daemon pid from `interceptor status` — never `pkill -f interceptor-daemon`, public issue #2011, @dsather) so the LaunchAgent respawns the new daemon.

- **Building the bridge inside a cloud-synced directory breaks its code signature — the full signing dance.** If your source checkout lives in (or symlinks into) iCloud Drive, Dropbox, or Google Drive, sync **strips the built `.app`'s code-signature envelope** (`codesign -v` → "code has no resources but signature indicates they must be present"). Copying that bundle into place propagates the break and the bridge SIGKILL-loops (`launchctl print` → `last exit reason = OS_REASON_CODESIGNING`). **The real fix is to move the checkout onto local disk.** To repair an already-broken bundle, work on the LOCAL staged copy (`~/.local/share/interceptor/interceptor-bridge.app`), in order: `xattr -cr` it → `codesign --force --deep --sign - .../Contents/Frameworks/Sparkle.framework` → `codesign --force --sign - --entitlements "$INTERCEPTOR_SRC"/scripts/entitlements-bridge.plist` on **the MacOS binary, then the .app** (this is exactly build-bridge.sh's dev-signing fallback). Do NOT `codesign --deep` the whole app — it mis-signs nested Sparkle so `codesign -v` passes while the kernel still kills it.
- **`bash scripts/install.sh --chrome` re-clobbers a freshly-fixed bridge.** It chains into install-bridge.sh, which re-copies the original (still-broken) bundle over your fixed one. Re-sign AFTER running it — or don't run it again once the bridge is signed.
- **launchd `job state = spawn failed` after repeated `kickstart -k`.** Rapid restart cycles throttle launchd into a failed state (`runs` climbs; the binary runs fine when launched directly). Recovery is `launchctl bootout "gui/$(id -u)/com.interceptor.bridge"` then a fresh `launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.interceptor.bridge.plist` — NOT another kickstart.
- **The daemon runs as a persistent LaunchAgent (`com.interceptor.daemon`, added 2026-07-04) — this is the durable fix for the extension's "native keepalive ping failed / forcing reconnect" console spam.** That spam fires when the daemon is momentarily *down* (an upgrade, a crash, a `pkill`): the drop kills the extension's native-messaging relay port, and the SW logs `ping failed` until it reconnects. The relay architecture is otherwise healthy — one singleton owns the socket, each Chrome profile spawns a thin relay that bridges to it (`relay: registered with singleton` → `received ping, sending pong`). Keeping the singleton ALWAYS up (`RunAtLoad` + `KeepAlive`, plist `~/Library/LaunchAgents/com.interceptor.daemon.plist` → `/opt/homebrew/bin/interceptor-daemon --standalone`) means relays always find a live singleton, so reconnects succeed instantly instead of erroring. **On a daemon-binary upgrade, `launchctl kickstart -k "gui/$(id -u)/com.interceptor.daemon"`** to pick up the new binary (same pattern as the bridge). Verify: `interceptor status` daemon pid == the launchd pid, and a steady-state `/tmp/interceptor.log` window shows 0 `ping failed` / `forcing reconnect`. **Since 2026-09-06 the plist's KeepAlive is `{SuccessfulExit: false}`, not `true`.** 0.24.2 exits 0 when another singleton already holds port 19222 (`decideSingletonGate`), and `KeepAlive: true` turned that clean loss into a 5-second respawn loop (thousands of runs, a new daemon pid every few seconds) whose 0.23.16 losers unlinked the winner's socket — every CLI call then saw `no browser contexts connected` for a beat, and that beat is what launched the extra test-profile windows. A crash still respawns; a clean port loss stays down and the relay-spawned singleton serves. To hand the port back to launchd after a binary swap: `kill <standalone pid from interceptor status>; launchctl kickstart -k "gui/$(id -u)/com.interceptor.daemon"` in ONE command — any CLI call in between spawns a standalone on the now-free port and launchd loses again.
- **Ad-hoc re-signing the bridge resets its TCC grants.** A new ad-hoc signature is a new code identity, so Accessibility / Screen Recording / Microphone drop to `denied` and Computer Use stops until re-granted (`interceptor macos trust --walkthrough`, or System Settings → Privacy & Security). The browser surface is unaffected (extension-based, no TCC). The notarized `Interceptor-Full-<v>.pkg` keeps a stable Developer-ID identity across Sparkle updates and sidesteps all of this — prefer it for the bridge when TCC churn hurts.
- **A hidden tab reports zero animation/observer activity without erroring — and that reads exactly like "the feature is broken."** Before concluding a ResizeObserver, transition, lazy-load or scroll-reveal doesn't fire, check `document.visibilityState`; if it's `hidden`, every scheduled-rendering API is suspended and the observation is worthless. Re-run through `Tools/VerifyViewport.ts` (see the Rendering-Lifecycle Gate section). The tell that this bit you: measurements are internally consistent, counters sit at exactly 0 or 1, and manually invoking the page's own callback "fixes" it. *(2026-07-30, found while verifying a responsive nav; the pinned test window was parked on an inactive area of a secondary display.)*
- **`interceptor macos cdp raw <method> '<json>'` takes its params POSITIONALLY** — `--params`/`--param` both fail with `error: Invalid parameters`. Once more than one CDP context exists you must also pass `--context`; the daemon mints a URL-named alias context on every navigation, so pin the stable host-derived id (`cdp:127-0-0-1`) and prune the aliases. Every CLI response is prefixed with a `[id] → verb` trace line that must be stripped before JSON parsing — and it contains a `[`, so a naive `indexOf('[')` finds the trace, not the payload.
- **`interceptor macos windows --app "Google Chrome"` only enumerates the primary Chrome process's windows.** A second Chrome launched with its own `--user-data-dir` shares the bundle id but its windows never appear, so AX is not a usable channel for driving or observing it — use CDP.
- **`interceptor diagnose` is the first move when anything's wedged (0.22.2+).** It flags the daemon **split-brain**: the socket daemon (what the CLI talks to) vs the NMH manifest path (what Chrome spawns). Fix by pointing the manifest `path` at the canonical binary — `jq '.path="/opt/homebrew/bin/interceptor-daemon"'` over `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.interceptor.host.json` (+ the Brave one) — then kill the daemon pid from `interceptor status` (never `pkill -f interceptor-daemon` — it takes Chrome's relay daemon with it, public issue #2011, @dsather) and run one active command (`interceptor contexts`) to respawn from the right place. Two traps found live on the 0.22.37 upgrade *(2026-07-28)*: the Chrome NMH manifest is a **symlink into `$INTERCEPTOR_SRC/daemon/.generated/`** (install.sh recreates it pointing at the repo tree — replace it with a real file pointing at `/opt/homebrew/bin`), and a **stale standalone daemon from the old iCloud checkout** can survive `pkill -f interceptor-daemon`; kill it by pid from the diagnose output.
- **Overwriting `/opt/homebrew/bin/interceptor{,-daemon}` in place trips `OS_REASON_CODESIGNING`** — after `cp` over the old binaries, the `com.interceptor.daemon` LaunchAgent's spawn gets SIGKILLed by the kernel (`launchctl print` → `last exit reason = OS_REASON_CODESIGNING`) even though the build ad-hoc signed them. Re-sign the installed copies in place (`codesign --force --sign - /opt/homebrew/bin/interceptor-daemon` and `.../interceptor`), then `launchctl kickstart "gui/$(id -u)/com.interceptor.daemon"`. *(2026-07-28 upgrade; recurred 2026-08-10 as a burst of SIGKILL crash reports. Update intent step 3 (Path B, Install binaries atomically) is now the durable fix: stage → sign → atomic `mv`, never `cp` onto the live path.)*
- **A from-source bridge rebuild resets its TCC grants — and re-toggling the old row does NOT work.** The ad-hoc signature changes, so macOS drops Accessibility + Screen Recording for `interceptor-bridge` — symptom is a *running* bridge returning **empty a11y trees and `windows: []`** for every app, and `macos script run` timing out on the Apple Events prompt. Probe with `interceptor macos trust`. The stale System Settings rows are keyed to the OLD signature; toggling them changes nothing (verified live: stale records had accumulated). Fix: `tccutil reset Accessibility com.interceptor.bridge && tccutil reset ScreenCapture com.interceptor.bridge`, kickstart the bridge, run one `macos windows` call to re-register, then the human checks the FRESH rows ON in System Settings → Privacy & Security → Accessibility and Screen Recording (if absent, + add `~/.local/share/interceptor/interceptor-bridge.app`). Permanent fix: set `INTERCEPTOR_SIGNING_IDENTITY` to a real Developer ID before building so the signature — and TCC — survives rebuilds. *(2026-07-28 upgrade.)*
- **Extension reload after a manifest bump is zero-touch: `interceptor reload --context "$INTERCEPTOR_TEST_CONTEXT_ID"`.** It calls `chrome.runtime.reload()` in that context only, so the unpacked extension re-reads the freshly pinned `Extension/` at the new manifest version, `chrome.storage.local` (and with it the context id) survives, and `interceptor diagnose` reports `extension: connected (extension 0.24.2)` a second later — verified 0.23.16 → 0.24.2 on 2026-09-06 with the operator's other Chrome windows untouched. Never quit or relaunch the operator's Chrome for this (the 2026-07-28 "full Chrome quit" path is retired); fall back to `chrome://extensions` → reload only if the card comes back disabled.
- **codesign refuses anything written from a downloaded-terminal-lineage shell: `resource fork, Finder information, or similar detritus not allowed` (2026-09-06).** macOS stamps `com.apple.provenance` on every file a provenance-tagged process writes (a downloaded terminal app and every child, this harness's Bash included), `xattr -cr` cannot strip it from that lineage, and `ditto --noextattr` / `tar --no-xattrs` copies made by the same lineage get it right back. The bridge build therefore succeeds and its signature silently breaks (`code has no resources but signature indicates they must be present`, the ad-hoc path swallows the error). Sign from a process outside the lineage: Terminal.app, or a one-shot launchd job. `Intents/Update.md` step 6a carries the sequence; the single-file CLI and daemon binaries signed cleanly from the same shell (observed; the mechanism is not verified), only the bundle failed.
- **`Tools/Pin.sh` on bash 5.2+ — the tilde scrub was silently a no-op (fixed 2026-07-04).** `${SRC/#$HOME/~}` started tilde-expanding the replacement back to `/Users/<name>`, so `PINNED_FROM.txt` shipped an absolute home path and Pin.sh's own leak guard FATAL'd. Fixed to a quoted `~${SRC#$HOME}` form (`rel_home()`). If a re-pin FATALs on "absolute home path survived the scrub," check the bash version and that helper.

- **Auto-launch recovery (`EnsureTestProfile.sh`) — safety is the re-verification loop, not the profile arg (2026-07-07).** The loop, the UUID-rot stop and which exit codes may launch are under Isolation Doctrine. One limit lives only here: macOS `open -a "Google Chrome" --args --profile-directory=…` is a **no-op for the args when Chrome is already running** (it just activates) — `LaunchTestProfile.sh` sidesteps this via its direct-`CHROME_BIN` branch, which opens a new profile window even against a running Chrome; if a launch "succeeds" but no new window appears, that's the `open`-already-running case and the direct-binary branch is what actually works.

### Linux + Flatpak browser — the four-hour class (2026-07-19, Fedora)

All four surfaced in one session on Fedora with Chrome installed as a Flatpak
(`com.google.Chrome`, reached through a `~/.local/bin/google-chrome` shim that
adds `--filesystem=/tmp --filesystem=home --die-with-parent`). Read this block
before debugging a Linux install; the first symptom looks like a dead extension
and is not. *(public PR #1682, @pkumaschow.)*

- **A daemon socket created INSIDE a Flatpak sandbox is not connectable from the
  host CLI, even though the socket file is plainly visible.** `/tmp` is genuinely
  shared both directions (a host-written marker reads inside the sandbox and vice
  versa), so `ls -la /tmp/interceptor.sock` shows the file — and `interceptor
  status` reports `daemon: not running` in the same second. The endpoint lives in
  the sandbox's namespace; the visible file is a shadow. **The fix is a
  non-sandboxed browser**, not a Flatpak permission tweak. Native Vivaldi is one
  Interceptor supports; its relay's socket is host-accessible and the CLI connects
  immediately. Copy the NMH manifest to that browser's own dir first
  (e.g. `~/.config/vivaldi/NativeMessagingHosts/`).
- **A windowless orphaned Flatpak instance can hold port 19222 invisibly, and
  `pkill` on the PID you can see does not clear it.** The operator sees no Chrome
  window and reasonably reports "no Chrome is open" while
  `bwrap --args N -- chrome --profile-directory=X` is still alive with its daemon
  owning the port, starving every relay that starts afterwards — including a
  different browser's. `kill <pid>` on the visible child does not propagate
  through `bwrap`. **`flatpak kill com.google.Chrome` is the reliable clear.**
  Check for this whenever a relay reports the port held but no browser is
  visibly running.
- **The relay only attaches to a singleton it spawned itself; a losing duplicate
  unlinks the winner's socket on exit.** The log signature is
  `spawning detached standalone daemon` → `ws port 19222 already held ... exiting
  this duplicate` → `detached standalone daemon did not become ready before
  timeout` → `falling back to in-process singleton` → `exiting so the existing
  daemon serves everyone`. It never falls back to connecting as a plain ws
  client. Consequence: **CLI calls are self-destructive while another daemon owns
  the port** — each one auto-spawns a duplicate that deletes the live socket, so
  diagnosing the problem re-causes it. If the socket keeps vanishing, stop
  running CLI commands and fix ownership first. (Upstream-worthy: a daemon should
  never unlink a socket it did not create.)
- **`--load-extension` is dead (Chrome 137+; confirmed ignored on 150).** The
  profile comes up carrying only the five default component extensions. The
  `chrome://extensions` → Load unpacked picker is the only route — and in a
  Flatpak browser it goes through the XDG Document Portal, so the chosen path
  appears as `/run/flatpak/doc/<id>/...` in any error. That prefix is normal and
  is not the fault. **`~/.claude` is a dotfolder and GTK pickers hide dotfiles:
  press Ctrl+H in the picker** or the operator cannot navigate to the extension
  at all.

**Same footgun, port-shaped (2026-09-06, self-caught): `lsof -ti tcp:<port>` lists BOTH ends of every connection, so killing its output kills Chrome's relay daemon on the client side and drops the test context. Stop a local server with `lsof -ti tcp:<port> -sTCP:LISTEN` only; `EnsureTestProfile.sh` recovers the context if it already happened.**

**Agent-side footgun from the same session — kill by PID, never `pkill -f
interceptor-daemon`.** The pattern matches the invoking shell's own command line
(the command dies at exit 144 with truncated output, which reads like a wedge)
AND Chrome's per-profile relay daemon, whose death drops the extension's native
port. `interceptor status` prints the singleton's pid on the unindented `pid:`
line under `daemon:`; `kill` that one and the KeepAlive LaunchAgent respawns it:
`kill "$(interceptor status | awk '/^daemon:/{d=1;next} d && /^pid:/{print $2; exit}')"`.
`Tools/Capture.sh` does exactly this in its respawn step. *(public issue #2011,
@dsather.)*
