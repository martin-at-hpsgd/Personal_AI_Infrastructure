---
name: Interceptor
evals:
  manual:
    reason: "real-browser verification requires inspecting the requested page or native app state in its actual session"
    falsifier: "the screenshot or inspected state fails to show the requested behavior, route, visual result, or browser-side evidence"
metadata:
  short-description: "Drive real-browser and macOS UI through DOM/AX handles; verify deploys, debug pages, inspect traffic, and complete logins. Pixel-only work: ComputerUse."
description: Real Chrome plus macOS Computer Use from inside the browser, real sessions; mandatory for visual deploy verification. USE WHEN verify deploy, confirm UI, screenshot verification, debug web, visual check, animation bug, console errors, JS errors, network traffic, HAR export, blank-page debug, what is happening on the page, authenticated page, reproduce bug, drive native app. NOT FOR pixel-only GUI work (ComputerUse), crawling (BrightData), scraping.
version: 4.5.4
---

# Interceptor

**Contents:** Ideal State · Intent Routing · Data & Config · Gotchas · Examples

Drives the real Chrome test profile and native macOS apps through the `interceptor` CLI and guarded wrappers.

## Ideal State

- Every browser action ran in the pinned isolated test context, only after that run's preflight gate exited 0; the operator's Default profile, windows and focus are untouched, and a gate failure ends the run instead of falling back.
- Browser work the operator would otherwise do by hand (open, click, fill, log in) was driven by the agent, up to the single step that needs a secret it does not hold or an OAuth or consent screen, where the operator sees the client, scopes and account and approves.
- Every "verified", "works" or "fixed" claim cites evidence from the real page or app: a structured read, console and network state, and a `Tools/Capture.sh` screenshot that was read; motion and lifecycle claims come from `Tools/VerifyViewport.ts` or a ScrubFlow gallery.
- A capture request gets one screenshot per width it names (usually 1440 and 390), each read back and confirmed to be the requested page, not another tab's or session's, and every element the request names is reported present or absent.
- A page called verified or live was judged as a whole at each width: overlapping, clipped or misplaced layout (cards over the header, a cut-off top) fails the claim even when the requested element is present.
- A fine-detail claim (logo, glyph, icon, a figure's limbs, hands and grip) rests on a `Tools/Zoom.ts` crop of the full-resolution capture, so an extra arm cannot pass on a downscaled view.
- When Interceptor could not deliver evidence, the report says verification was not captured; it never substitutes `screencapture`, `osascript` or file existence for visual evidence.
- Native-app work leaves the frontmost app unchanged, shown by `frontmost` before and after, and the tabs a run opened in the test profile are closed when it ends.

## Intent Routing

Before an intent runs, load its bundle:
`bun "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/TOOLS/ContextLoad.ts" Interceptor load BUNDLE`

Follow every requirement it returns; guide paths are relative to the skill root. Reload after compaction or a source change. Any truncation warning means the load failed, even if the `END CONTEXTLOAD` marker survived.

`list` shows sections and bundles; `search "query"` searches the indexed source; a failed search proves nothing (broaden it or load `full`). If the loader fails, read `References/CompleteGuide.md` and the relevant intent directly; never proceed on a partial load.

| Task | Bundle |
|---|---|
| Browser reads, interaction, or screenshot verification | `verify` |
| Motion, responsive behavior, or hidden-tab issues | `motion` |
| Native macOS application operations | `native` |
| Installation, platform troubleshooting, delegation, or a task no bundle fits or you are unsure of | `full` |

| Intent | Trigger | File |
|---|---|---|
| **LaunchTestProfile** | "test profile", "launch test profile", "isolated browser", "separate Chrome window", "start interceptor-test" | `Intents/LaunchTestProfile.md` |
| **VerifyDeploy** | "verify deploy", "check deploy", "confirm deploy", "deploy verification" | `Intents/VerifyDeploy.md` |
| **ScrubFlow** | "scrub flow", "record flow to video", "motion bug", "animation jank", "transition stutter", "flicker", "flow gallery", "catch motion a screenshot misses" | `Intents/ScrubFlow.md` |
| **Reproduce** | "reproduce", "reproduce bug", "debug page", "check page", "blank screen" | `Intents/Reproduce.md` |
| **ReadAndExtract** | "extract value", "read page", "pull a fact", "SPA state" | `Intents/ReadAndExtract.md` |
| **DriveRichEditor** | "drive Canva", "drive Docs", "drive Slides", "rich editor", "scene", "scene graph", "canvas-rendered" | `Intents/DriveRichEditor.md` |
| **OverrideXhr** | "override request", "request override", "force 500", "rewrite response", "mutate XHR" | `Intents/OverrideXhr.md` |
| **ScreenshotForVlm** | "screenshot for VLM", "VLM screenshot", "agent screenshot", "WebP 1568" | `Intents/ScreenshotForVlm.md` |
| **MultiPageCompare** | "compare pages", "multi-page compare", "facts across N pages", "designed by X vs Y" | `Intents/MultiPageCompare.md` |
| **CaptureBackgroundedApp** | "screenshot of Brave / Signal / Mail / X", "capture backgrounded app", "capture occluded window" | `Intents/CaptureBackgroundedApp.md` |
| **DriveBackgroundedApp** | "scroll Mail / type into TextEdit", "drive backgrounded app", "click without focus" | `Intents/DriveBackgroundedApp.md` |
| **DispatchAppleEvent** | "open URL in Brave", "Apple Event", "intent dispatch", "named app open" | `Intents/DispatchAppleEvent.md` |
| **ReadAxTree** | "AX tree", "accessibility tree", "what's in Cursor / Slack", "find a button in app" | `Intents/ReadAxTree.md` |
| **TrustedInputGate** | "trusted input", "OS-level input", "isTrusted", "site rejects synthetic input", "HID-source state" | `Intents/TrustedInputGate.md` |
| **VmLifecycle** | "create VM", "VM lifecycle", "linux VM", "macos VM", "gold image", "clone VM", "snapshot VM" | `Intents/VmLifecycle.md` |
| **RecordFlow** | "record flow", "record workflow", "capture flow", "monitor start" | `Intents/RecordFlow.md` |
| **RecordAndReplayMacFlow** | "record mac flow", "record native flow", "watch me do X in Cursor/Mail/Finder" | `Intents/RecordAndReplayMacFlow.md` |
| **ReplayFlow** | "replay flow", "replay", "regression check", "run flow" | `Intents/ReplayFlow.md` |
| **TestForm** | "test form", "fill form", "form test", "check form" | `Intents/TestForm.md` |
| **Update** | "update", "check version", "rebuild", "install bridge", "enable computer use" | `Intents/Update.md` |

| File | Read when |
|---|---|
| `References/CompleteGuide.md` | the doctrine behind every bundle: prohibitions, isolation and lifecycle gates, install modes, compound commands, key rules, delegation, gotchas |
| `References/CommandReference.md` | the per-verb CLI listing |
| `References/UpdateRecovery.md` | an Update (Path B) step fails its check, or the bridge is being uninstalled |
| `Setup.md` | first-time setup: the program install, the test Chrome profile and extension, and preferences.env |
| `Flows/` | saving a recorded browser flow (RecordFlow) or replaying one (ReplayFlow) |

## Data & Config

User customizations live at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/` ($CLAUDE_CONFIG_DIR or ~/.claude); anything there overrides the defaults, and its `preferences.env` (template `preferences.env.example`) sets `INTERCEPTOR_TEST_CONTEXT_ID`, the pinned test context. Secrets stay outside this skill.

First-time setup: [Setup.md](Setup.md).

## Gotchas

Every browser intent starts with this preflight (exit codes: `References/CompleteGuide.md` § Preflight Isolation Gate):

```bash
source "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env"
bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Interceptor/Tools/EnsureTestProfile.sh"
```

A non-zero exit ends the run; surface its message verbatim. Never fall back to raw screenshots or focus-changing OS commands. InterceptorContextGuard denies a browser verb unless `--context` is the pinned id (literal, or `$INTERCEPTOR_TEST_CONTEXT_ID` once that command sources `preferences.env`) and never runs the preflight (CompleteGuide § Isolation Doctrine).

## Examples

```
User: "Verify http://localhost:31337/review renders at 1440 and 390 widths"
→ VerifyDeploy, after `ContextLoad.ts Interceptor load verify` and the preflight
→ One read-back screenshot per width plus page state; every verb carried `--context <id>`
```

```
User: "The nav animation stalls when I resize"
→ ScrubFlow, after loading `motion`
→ Evidence from VerifyViewport or a flow gallery, never a hidden-tab measurement
```
