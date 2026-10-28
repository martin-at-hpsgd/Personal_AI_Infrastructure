# DirectDesign

A production-grade web interface written directly in code, with Anthropic's frontend-design philosophy loaded inline and a named aesthetic register it commits to.

## Ideal State

- The design follows `References/FrontendDesignPhilosophy.md` rather than AI defaults: grounded in the brief's subject, with none of its Forbidden Defaults and no calibration tell the brief did not ask for.
- The design commitments existed before the code and the code honors them. The `🎨 AESTHETIC:` line names one register, taken from the register list in `FrontendDesignPhilosophy.md` or designed true to the brief (the list is inspiration, never a closed list); when the brief implies a register it is named, and when it doesn't the choice is deliberate and rotates across sessions. The `📦 OUTPUT:` line names one of the five output contracts with its target file or path, and the `🔠 TYPE:`, `🎨 PALETTE:` and `🎬 MOTION:` lines (one named motion gesture) come from that register as constraints on the whole page.
- The register shows in every downstream decision on the rendered page: type pair, color palette, motion vocabulary, layout posture, background treatment.
- The code is real working code, not pseudocode, with no placeholder `lorem ipsum` unless that *is* the design joke.
- Implementation complexity matches the aesthetic vision: maximalist registers earn elaborate code (multiple gradients, layered effects, rich animation timelines); minimalist registers earn restraint (precision spacing, exact type ramp, almost no decoration).
- A whole page (every contract except a `framework-matched-diff` inside an existing app shell) has one memorable element, named in a comment at the top of the file (`// HERO: <thing someone will remember>`).
- Accessibility minimum: body text contrast meets WCAG AA on its surface and AAA on primary content surfaces; interactive elements have visible focus states; motion follows the upstream reduced-motion floor unless the principal's `PREFERENCES.md` § Overrides of upstream sets a different motion policy, which then wins.
- Before done is declared, an Interceptor screenshot of the rendered page was read and confirms: the type pair is rendering (fonts loaded, no fallback to system-ui); the palette is visibly committed (one accent, restrained core); motion fires on initial load / hover (not just static markup); the layout matches the chosen register (asymmetry / rhythm / density / restraint); the memorable element is actually memorable when seen.
- Public-site builds and launch completion also satisfy `References/SiteLaunch.md`, and its operational criteria stay open until their own evidence exists.
- Nothing reaches the principal as a first draft: the rendered page went through the ArtDirection quality loop named in `SKILL.md`.
- The hand-off is the four items in Output format, in order, and nothing else.

## Anti-criteria

- Designing without the philosophy loaded: losing the doctrine and reverting to AI defaults. The doctrine is the whole point of this intent.
- Leaving the register undeclared on screen: the model drifts into generic "modern clean" when the register isn't named.
- Picking the same register every session: convergence is the AI-slop signal. Vary deliberately.
- No generic AI-default tells: no `shadow-md` everywhere, no uniform `rounded-lg` everywhere, no `Inter` body, no purple-on-white gradient, no "centered card on flat color" as the entire layout (`FrontendDesignPhilosophy.md` Forbidden Defaults section).
- Saying `verified` without an Interceptor screenshot: that is a doctrine violation in LifeOS. The screenshot is the verification; "code looks right" is not verification.
- A failed screenshot check is never papered over by editing the criteria; the implementation is fixed.
- Maximalism without commitment: half-committed maximalism reads as cluttered. If you choose maximalist, *commit*: more layers, more motion, more density. Same for any register at any pole.
- The hand-off never adds narrative, a "what I did" section, or apologies for choices.

## Output format

Output line:
```
🎨 AESTHETIC: <register-name> — <one-sentence rationale tied to the brief>
```

State the deliverable shape up front. Pick one:

| Contract | When |
|----------|------|
| `single-file-html` | Portable demo, one `.html` with inline `<style>` and `<script>`. Fastest to review. |
| `react-tailwind` | A `.tsx` component using Tailwind v4 + `motion` (framer-motion). Lands in React apps. |
| `astro-component` | `.astro` for content sites and static-first pages. |
| `vue-sfc` | `.vue` single-file component. |
| `framework-matched-diff` | Patches against an existing codebase. Read the host's framework, styling system, and component conventions first, then emit a diff that matches them rather than importing this skill's defaults. |

Output line:
```
📦 OUTPUT: <contract> — <target file or path>
```

From the chosen register, lock in:

```
🔠 TYPE: display=<font>, body=<font>, mono=<font-or-N/A>
🎨 PALETTE: bg=<color>, fg=<color>, accent=<color>, [optional]=<color>
🎬 MOTION: <one named gesture e.g. "stagger-cascade page load", "hover slow-fade", "scroll reveal">
```

Reference `FrontendDesignPhilosophy.md` Type Pair Recipes table for register-appropriate combinations. Do not pick a font from a different register without a deliberate clash-as-design reason.

Output, in order:

1. **The file(s)** — written to disk at the path declared in the OUTPUT line.
2. **The aesthetic statement** — `AESTHETIC | TYPE | PALETTE | MOTION` lines, restated.
3. **The screenshot path** — wherever Interceptor saved the verification image.
4. **The memorable-element line** — one sentence on what makes this page stick.

## Inputs

The brief; for in-app work, the host project's framework, token file and component directory; and the preferences named in `SKILL.md` § Data & Config when that file exists.

## Tool contract

The doctrine read, when the direct bundle has not already supplied it:

```
Read("~/.claude/skills/Webdesign/References/FrontendDesignPhilosophy.md")
```

The verification capture:

```
Skill("Interceptor", "open <local URL or file> and screenshot the rendered page")
```

## References

`References/FrontendDesignPhilosophy.md` is the load-bearing source. It contains:
- The current upstream doctrine (imported 2026-09-03): ground the design in the subject, the five calibration tells of AI-generated pages, the plan → review-against-brief → build → critique process, restraint, and writing-as-design
- The retained register list and type-pair recipes (the AESTHETIC and TYPE lines draw on them)
- Forbidden defaults, motion timing, and the done checklist
- Install overrides: any standing override of upstream defaults (motion policy, default page ground) comes from `PREFERENCES.md` § Overrides of upstream; variety is checked against the last shipped sites by reading their CSS
