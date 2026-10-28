# Input Formats

**Contents:** The Ideal Brief · Aesthetic Direction · Reference Images · Importing a Design System (native-first) · Codebase Preparation (for design-system extraction) · Prompt Length Sweet Spot · Iteration vs Restart · Examples of Effective Briefs

How to prepare briefs, reference materials, and codebases so Claude Design produces the best output on the first pass.

## The Ideal Brief

An effective Claude Design brief has five parts:

1. **Purpose** — what the interface does, who uses it (1 sentence)
2. **Aesthetic direction** — one committed register (brutally minimal, maximalist chaos, editorial, retro-futuristic, etc.)
3. **Constraints** — framework, responsive tier, a11y tier, dark-mode, specific elements required
4. **Differentiation** — the one memorable detail that makes this not-generic
5. **Scope** — sections, key components, must-haves / must-nots

### Template

```
PURPOSE: A [thing] for [audience] that helps them [core job].

AESTHETIC: [one direction — brutalist / editorial / retro-futuristic / minimal / etc.]
Rationale: [why this fits the audience and job]

CONSTRAINTS:
- Framework: [next / astro / vitepress / react-vite / vanilla]
- Responsive: mobile-first, breakpoints at 640/768/1024/1280
- Accessibility: WCAG 2.1 AA
- Dark mode: [yes / no / both]
- Typography: [pair or "your choice"]

DIFFERENTIATION: [the one memorable element]

SCOPE:
- Section 1: [purpose, key content]
- Section 2: [purpose, key content]
- Must-haves: [list]
- Must-NOTs: [list]
```

## Aesthetic Direction

The AESTHETIC line names one register from `References/FrontendDesignPhilosophy.md` § Aesthetic registers, or one designed true to the brief. Blending two is fine; picking three guarantees muddled output.

Claude Design (like any model) defaults to generic when the brief is vague, so the brief names what to avoid (`FrontendDesignPhilosophy.md` § Forbidden defaults (the AI-slop list); Space Grotesk is overused) and what to deliver:

- Distinctive display + body font pair (name both)
- Dominant color + sharp accents (specify hex or named)
- Asymmetric or grid-breaking layout
- One orchestrated animation moment (not scattered micro-interactions)

## Reference Images

Feeding 1-5 reference images dramatically lifts first-pass quality. Best practices:

- **Mood over copy** — reference the vibe, not the content. "This kind of gridded editorial feel" not "copy this site."
- **Mix sources** — one website screenshot + one poster + one architecture photo produces richer outputs than three website screenshots.
- **Label each image** — "ref-1-type.png is for typography; ref-2-color.png is for palette; ref-3-layout.png is for composition."
- **Avoid AI-generated references** — they amplify the generic. Use real human-designed sources.

## Importing a Design System (native-first)

Build the design system from your real code (`/design-sync` pull, or a Claude Design import), not from a Figma file. Order of preference:

1. **Link the GitHub repo** — Claude Design reads components and tokens straight from code, so the system matches what ships. Best path when the design system lives in a repo.
2. **Local codebase path** — same idea for code not yet pushed; curate the bundle (below).
3. **Component + token files** — upload a focused folder of UI components and token sources (`tokens.json`, CSS variables, `tailwind.config.*`).
4. **Brand assets / guide** — logos, fonts, PDF or PPTX style guide.

Never import via `.fig` exports, and no Figma round-trip in either direction: code and tokens in the repo are the source of truth, and the skill is deliberately not coupled to Figma.

## Codebase Preparation (for design-system extraction)

Before feeding a codebase (or repo link) to Claude Design:

1. **Curate** — don't upload the whole repo. Pull 20-50 focused files.
2. **Include** — `tailwind.config.*`, `src/styles/`, `src/components/ui/`, primary layout components, `package.json`.
3. **Exclude** — `node_modules/`, `dist/`, `build/`, `.next/`, `public/` (unless it has brand assets), test files.
4. **Include brand** — logos (SVG preferred), custom font files, any brand guide PDF.
5. **Flag ambiguity** — if the codebase has two incompatible button styles or three competing color palettes, tell Claude Design upfront ("the codebase is mid-migration; prefer the newer `*.v2.*` files").

## Prompt Length Sweet Spot

- **Too short** (<50 words) — generic output, defaults everywhere
- **Sweet spot** (100-300 words) — directed output, most detail filled
- **Too long** (>500 words) — Claude Design starts ignoring parts of the brief

If a brief starts exceeding 300 words, split into phases: first brief for prototype, follow-up refinements for details.

## Iteration vs Restart

| Situation | What to do |
|-----------|-----------|
| Prototype is 80% right, small fixes needed | Iterate on the artboard with specific adjustments |
| Aesthetic is wrong | Restart with a sharper aesthetic direction |
| Structure is wrong (missing sections, wrong flow) | Restart with a fuller scope section in the brief |
| "Just not loving it" | Restart — the brief was underspecified; don't refine your way to the right answer |

## Examples of Effective Briefs

### Brief 1 — Brutalist portfolio

> PURPOSE: A single-page portfolio for a print-focused graphic designer.
> AESTHETIC: Brutalist. Raw, unstyled, type-led. Think early Ray Gun magazine.
> CONSTRAINTS: Framework astro, mobile-first, a11y AA, dark-only, serif display + mono body (no sans).
> DIFFERENTIATION: Oversized page number bleeding off the left edge of every section.
> SCOPE: Hero with name + date, 8 work samples in irregular asymmetric grid, contact strip at bottom. No nav, no footer, no social icons.

### Brief 2 — Minimalist SaaS dashboard

> PURPOSE: An admin dashboard for content moderators on a social platform. They review 50-200 items per shift.
> AESTHETIC: Industrial minimal. Dense information, mono for data, sans for chrome.
> CONSTRAINTS: React+Vite+shadcn, desktop-first (1440+ primary), AA contrast, dark default with light toggle, IBM Plex Sans + Plex Mono.
> DIFFERENTIATION: A unified command palette (⌘K) that's visible on first load for 2 seconds, then minimizes — guides users to the keyboard-first workflow.
> SCOPE: Item queue (list + detail split view), filters sidebar, action toolbar, keyboard shortcut legend. No marketing content, no avatars, no "welcome back" chrome.
