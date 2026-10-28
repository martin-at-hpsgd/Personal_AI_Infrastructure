# Claude Design Capabilities

What Claude Design and the `/design` surface can and cannot do, for NativeDesign briefs. Source: the official Anthropic announcement at https://www.anthropic.com/news/claude-design-anthropic-labs (April 17, 2026) and related coverage. Every capability here is a per-build fact: verify it in-session before promising it.

## What It Is

Claude Design is an Anthropic Labs product accessed at **claude.ai/design** and in the Claude desktop app sidebar (all paid tiers, as of the June 2026 update). There is no public REST API. We don't track or pin the underlying model — we drive whatever is live.

- **`/design` skill (research preview, August 2026).** Announced by @ClaudeDevs on X, 2026-08-17 (status 2089471692762673408; first-party account, high confidence): brings Claude Design's artboard workflow into the CLI and Desktop, **built on artifacts**. Running `/design` produces **editable artboards** for a UI — multiple variants — the user picks one, tweaks it, then has Claude implement it. It superseded the browser-automation route to the design canvas (Path 3, retired the same day).
- **`/design-sync` and the `DesignSync` tool.** A native tool surface in current harness builds syncs a design-system project with the codebase (list/read → `finalize_plan` → write/delete; incremental by contract). Design scopes come from the claude.ai login or `/design-login`.
- **June 2026 update** (third-party coverage, not in Anthropic's official release notes; medium confidence until verified in the harness): design-system imports from a GitHub repo, design files, or raw uploads, with output validated against the system before it is shown; bidirectional `/design-sync` (pull the codebase design system in, push built output back); a WYSIWYG canvas editor.

## Access

| Tier | Access |
|------|--------|
| **Free / Starter** | No access |
| **Pro** | Included — standard usage limits (insufficient for sustained pro use) |
| **Max** | Included — recommended for daily professional use |
| **Team** | Included |
| **Enterprise** | OFF by default; admins enable in Organization settings |

As of the June 2026 update, Claude Design usage shares one pool with claude.ai chat, Claude Code, and Cowork — it is no longer a separate quota.

## Known Limits (as of launch, April 2026)

- **Generic aesthetic without a design system** — if onboarding is skipped, output drifts toward generic defaults.
- **Edge cases require explicit prompting** — responsive breakpoints, contrast ratios, dark-mode behavior all need to be called out.
- **No animation output** — Lottie, Rive, WebGL shaders beyond declarative CSS/JS are not first-class outputs.
- **No precision print output** — professional designers have reported it misses pixel-level constraints for print work.
- **No real-time multiplayer collaboration.** Sharing is async via URL.
- **High token burn** — generation is heavy and draws from the shared pool; sustained use exhausts Pro-tier limits fast.
