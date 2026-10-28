---
name: Webdesign
evals:
  manual:
    reason: "interface quality must be judged in a real browser against the requested hierarchy, interaction, and visual system"
    falsifier: "the reviewer finds a required state unusable, visually incoherent, inaccessible, or absent from the rendered interface"
metadata:
  short-description: "Design and implement web UI, prototypes, artboard variants, and design-system sync. Use Art for illustrations and HyperFrames for video."
version: 1.3.3
description: Designs and integrates web interfaces via DirectDesign (inline, Anthropic frontend-design philosophy, the default) or NativeDesign (/design artboards plus /design-sync design-system sync). USE WHEN web design, UI design, artboards, design variants, create prototype, design system, design sync, redesign site, mockup, landing page, dashboard design, design-to-code, frontend design, polish UI, design audit, brutalist/editorial/retro UI. NOT FOR illustrations/logos (Art), video (HyperFrames).
license: Complete terms in LICENSE.txt
---

# Webdesign

Design interfaces using DirectDesign for in-code work, or NativeDesign for artboard variants and design-system sync. Respect existing app tokens and components; redesign only when requested. Both paths share the aesthetic doctrine in `References/FrontendDesignPhilosophy.md` and the same quality loop.

## Ideal State

- Every design lands as working code (or a picked artboard implemented) in the host app's framework, diffed against its existing tokens and components; a full redesign happens only when the user asked for one, and replacing existing UI otherwise is flagged and confirmed first.
- The result looks made for its subject and its host app, never like a generic AI page: a named register, none of the forbidden defaults in `References/FrontendDesignPhilosophy.md`.
- The path fits the ask: DirectDesign for in-code work, NativeDesign for comparing looks or design-system sync, and an ambiguous ask gets both paths offered by name, never routed silently.
- Nothing reaches the principal as a first draft (principal directive, 2026-09-17): before it is shown, the rendered result has an Interceptor capture and an ArtDirection critique that passed the bar, or a reported shortfall.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **DirectDesign** (default, bundle `direct`) | in-code UI design or a self-contained page; short ad-hoc design asks, "make a nice design", "do the design yourself", frontend aesthetics, brutalist/editorial/retro/maximalist UI | `Intents/DirectDesign.md` |
| **NativeDesign** (bundle `native`) | artboards, "show me variants", "give me a few directions", "pick a design", mockup, prototype, "claude design", `/design`, `/design-sync`, design-system sync | `Intents/NativeDesign.md` |

DirectDesign fits one pass that lands as code in an existing codebase or as a self-contained page, including when claude.ai access is unavailable. NativeDesign fits when the principal should compare genuinely divergent looks side by side, review visually before implementation, or the job is design-system sync. Illustrations and logos go to Art: brand assets are authored SVG, never generated UI output.

Uncertain routing or the full reference loads bundle `full`. The direct bundle includes the full aesthetic reference and the DirectDesign intent, so its doctrine read is already satisfied; do not fetch the same bytes again. NativeDesign retains its original prerequisites and approvals.

| File | Read when |
|------|-----------|
| `References/CompleteGuide.md` | the loader fails, or the `full` bundle: integration-aware operation, preflight, the dated gotchas |
| `References/FrontendDesignPhilosophy.md` | any DirectDesign run or NativeDesign brief: the aesthetic doctrine, registers, type pairs, forbidden defaults |
| `References/InputFormats.md` | writing a design brief, importing a design system, choosing iterate vs restart |
| `References/ClaudeDesignCapabilities.md` | what Claude Design and `/design` can and cannot do, access, known limits |
| `References/SiteLaunch.md` | public-site builds and launch completion |
| `README.md` | the public-facing intro to the skill |
| `Setup.md` | first-time setup: Interceptor test context for the rendered check, and Claude Design access for NativeDesign |

## Tool contract

Load context with the deterministic loader before executing an intent:
`bun "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/TOOLS/ContextLoad.ts" Webdesign load BUNDLE`

It returns the selected instructions and their required sections with source hashes; follow every returned requirement. Use `list` to discover sections and bundles, and `search "query"` to search the indexed source; a failed search does not establish absence, so broaden it or load `full`. If the loader fails, read `References/CompleteGuide.md` and the relevant intent directly. Do not proceed with a partial load.

Verification and the quality loop:

- Browser evidence uses Interceptor's `verify` bundle, including all its isolation and safety requirements. An unavailable verifier leaves the result explicitly unverified.
- Capture the rendered page with `Tools/VerifyDesign.ts` or `skills/Interceptor/Tools/Capture.sh`.
- `Skill("ArtDirection")` runs a direction council before new or large work; then the cross-vendor critique panel (`skills/ArtDirection/Tools/Critique.ts`) scores the capture against the rubric and names defects, and this skill iterates on those defects until the bar or reports the shortfall.
- A file handed over through Downloads goes through `skills/ArtDirection/Tools/Deliver.ts`, which refuses without a passing, fresh critique and a Proof receipt.
- Record the principal's verdict with `skills/ArtDirection/Tools/Calibrate.ts`.
- Public-site builds and launch completion also load `References/SiteLaunch.md`; component edits and standalone mockups do not require registration.

## Data & Config

First-time setup (accounts, keys, files to fill in): [Setup.md](Setup.md).

User design preferences (color palette, typography, spacing grid, animation timing, framework defaults, the last shipped sites) live at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Webdesign/PREFERENCES.md` (configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). When present they feed every brief, DirectDesign inline, or the NativeDesign artboard brief and design-system project, and bias the register choice without binding it. Never substitute generic defaults for configured preferences. Without preferences, choose freshly each session and rotate registers across runs.

## Gotchas


## Examples

```
User: "Redesign the Example App page /app/reports/weekly inside the existing app shell — it looks like trash"
→ DirectDesign, framework-matched-diff
→ The page uses the app's own components and tokens, reads as designed rather than a plain table, and ships with its screenshot and a passing critique
```

```
User: "Design and build example.com, a public content site for the course. Deploy only after I look."
→ DirectDesign plus References/SiteLaunch.md
→ A rendered site with a committed register, launch criteria in the project ISA, and the deploy held for the principal's yes
```

```
User: "Pull this repo's design system into Claude Design"
→ NativeDesign, sync leg
→ The design-system project holds the repo's real tokens and components, so later artboards start from the brand
```
