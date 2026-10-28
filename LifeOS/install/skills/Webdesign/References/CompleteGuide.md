# Webdesign — complete guide

## What It Does

Designs and integrates web interfaces via two paths. DirectDesign writes the design inline using Anthropic's open-source frontend-design philosophy, loaded from a local reference. NativeDesign drives the first-party Claude Design surface — the `/design` artboard workflow (research preview: editable artboard variants built on artifacts; pick one, tweak, implement) and `/design-sync` design-system sync. Default routing: short, ad-hoc, in-codebase work goes to DirectDesign; anything where the user should choose between looks, or where a codebase design system needs syncing, goes to NativeDesign.

## The Problem

Producing good web UI usually means either fighting a visual tool that can't touch your real codebase, or hand-coding from scratch and landing on the same generic defaults every time. This skill gives you both routes under one roof: inline design with a real aesthetic doctrine loaded when speed and in-codebase iteration matter, or native artboard variants when visual comparison and review matter — and routes to the right one based on the ask.

## How It Works

### Path 1 — DirectDesign (default workhorse; the DA writes the design inline)

The design is written directly with Anthropic's open-source `frontend-design` aesthetic doctrine loaded inline. The load-bearing prompt content is mirrored from `github.com/anthropics/skills/tree/main/skills/frontend-design` (MIT-licensed) into `References/FrontendDesignPhilosophy.md` — register list, anti-default rules, type pair recipes, motion vocabulary, color discipline. Self-contained: no runtime dependency, no browser, no auth. This is the path that has shipped every real design this skill has produced. Intent: `DirectDesign`.

### Path 2 — NativeDesign (first-party artboards + design-system sync)

The native `/design` skill (research preview, Aug 2026) brings Claude Design's artboard workflow into the CLI and Desktop, built on artifacts: generate genuinely divergent artboard variants, pick one, tweak it, have Claude implement it. `/design-sync` plus the `DesignSync` tool keep a codebase or component library in sync with a claude.ai/design design-system project — incrementally, never wholesale. This is also the deterministic successor to the retired Interceptor-driven ClaudeDesign path. Workflow: `NativeDesign`.

### Routing rule

- **Default to DirectDesign** for short, ad-hoc, in-codebase work — speed and in-context iteration.
- **Use NativeDesign** when the user wants to compare looks (artboard variants map directly onto the design-variety doctrine and the /v1-/v2-/v3 snapshot rule), wants visual review before implementation, or the job is design-system sync.
- Ambiguous intent → surface both paths by name and let the user pick; never silently route.

## Integration-Aware Operation

This skill is frequently called as a **sub-step of larger site work**. When invoked from a parent context, the skill accepts existing-project context (framework, token file, component directory, deployment target), produces output as **diffs against the existing app**, and respects existing design tokens and components — no overwrite unless a full redesign is explicitly requested. Both paths end code-shaped; NativeDesign's pick-and-implement step lands the chosen artboard the same diff-shaped way. Standalone greenfield asks produce a self-contained prototype and optionally scaffold a new app.

## Customization

User-specific design preferences (color palette, typography, spacing grid, animation timing, framework defaults) live at:

```
<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Webdesign/ (configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`)
├── PREFERENCES.md     # Design tokens, preferred frameworks
├── README.md
└── EXTEND.yaml
```

The skill reads PREFERENCES.md if present and passes those tokens into every brief — DirectDesign inline, or the NativeDesign artboard brief and design-system project.

## Intent Routing

| Intent | Trigger | File |
|----------|---------|------|
| **DirectDesign** *(Path 1 — default, inline)* | "make a nice design", "design this directly", "do the design yourself", "design something cool", "frontend aesthetics", "brutalist/editorial/retro/maximalist UI", any short ad-hoc design ask without "artboards" / "variants" / "claude design" | `Intents/DirectDesign.md` |
| **NativeDesign** *(Path 2 — artboards + sync)* | "/design", "artboards", "show me variants", "give me a few directions", "mockup", "prototype", "claude design", "/design-sync", "sync design system", "pull design system into Claude Design" | `Intents/NativeDesign.md` |

## Prerequisites (PREFLIGHT)

Path 1 (DirectDesign) needs nothing — no browser, no auth. Path 2 (NativeDesign) needs a Claude subscription that includes Claude Design, a harness build carrying the `/design` research-preview skill (`/update` if missing), and — for design-system sync — a claude.ai login with design scopes (or `/design-login`). Missing prerequisites → halt with a clear remediation step; never silently fall back.

## Gotchas

- **The upstream mirror rots without warning; check the commit, not the date.** Anthropic replaced `frontend-design` wholesale on 2026-09-03 (commit `41bbe19d`: register list and type tables gone, replaced by a subject-grounding + calibration-tells process). Our mirror was four months stale when a design run started. Before any design pass, run `gh api 'repos/anthropics/skills/commits?path=skills/frontend-design&per_page=1'` and compare against the `Imported:` line in `References/FrontendDesignPhilosophy.md`; a newer commit means refresh the mirror first (upstream verbatim in § Core Doctrine, intent-referenced tables in § Retained Reference, LifeOS overrides last). Upstream's "reduced motion respected" floor is overridden only when the principal's `PREFERENCES.md` § Overrides of upstream says so; never copy an override into an intent step.

- **Path 3 (ClaudeDesign via Interceptor) was retired 2026-08-17.** The native `/design` artboard workflow made the browser-automation route obsolete before it ever ran end-to-end. The seven intents plus `DriveClaudeDesign.ts`/`ProcessHandoffBundle.ts` and the bundle-spec references live in git history, not the tree. Do not rebuild a browser path for the design canvas.
- **`/design` is a research preview.** Availability and behavior vary by harness build. Verify the skill exists in-session before promising artboards; DirectDesign remains the proven default until a supervised NativeDesign run lands real gotchas here.
- **Artboard variants must genuinely diverge.** Brief each variant with a different register/typeface/composition per the design-variety doctrine — three saturations of one idea is a wasted fan-out. The pick step is the /v1-/v2-/v3 approval gate.
- **Native-first — code and tokens are the source of truth, Figma is not a dependency.** Import a design system by linking the repo or uploading token/component files, never a `.fig` export. No Figma round-trip in either direction.
- **`DesignSync` is incremental by contract.** One component at a time, never wholesale replace; writes require a `finalize_plan` locking exact paths. Project type is immutable — verify `PROJECT_TYPE_DESIGN_SYSTEM` via `get_project` before pushing, or `create_project` fresh.
- **Integration ≠ overwrite.** Output is diffs on top of existing code. A full redesign that replaces existing UI gets flagged and confirmed first.
- **Design-system-first is the token fix.** The biggest token sink is re-inferring the brand every pass and correcting it. Sync the design system once so every later generation reuses it instead of guessing — the single highest-leverage move against quota burn.
- **Session quotas.** Claude Design usage shares one pool with chat, Claude Code, and Cowork. Pro is thin for sustained design work; Max recommended.
- **Output fidelity ≠ production-ready.** Polished visuals still need a verification + a11y pass. Run `Tools/VerifyDesign.ts` post-integration; rendered results verify through Interceptor (real Chrome), two evidence classes for any live claim.
- **Vision doesn't guess.** Unspecified breakpoints, contrast requirements, or dark-mode behavior get defaults that may not match the target app. Be explicit in the brief (`References/InputFormats.md`).

## Examples

**Example 1: Variant fan-out for a landing page**
```
User: "Give me a few directions for the pricing page — editorial vs brutalist vs technical"
→ Invokes NativeDesign intent
→ Preflight: /design skill present, design system synced
→ Briefs three divergent artboards (different register, typeface, composition)
→ User picks one on the artboard surface, tweaks
→ Implements the pick as a diff against the repo; verifies via Interceptor
```

**Example 2: Fast in-codebase design**
```
User: "Design a settings panel for this app — keep it consistent with what's there"
→ Invokes DirectDesign intent
→ Loads References/FrontendDesignPhilosophy.md + project tokens
→ Writes the design inline as a diff; screenshots in-context
```

**Example 3: Sync a codebase design system**
```
User: "Pull this repo's design system into Claude Design"
→ Invokes NativeDesign intent (sync leg)
→ /design-sync pull from the repo; verifies target project type
→ Subsequent artboards start from the real tokens, not defaults
```
