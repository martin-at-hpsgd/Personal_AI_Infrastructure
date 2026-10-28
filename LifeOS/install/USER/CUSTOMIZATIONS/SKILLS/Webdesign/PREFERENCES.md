---
provenance: template
version: 1.0.0
---

# Webdesign preferences

> Read after Step 0 of `skills/Webdesign/Intents/DirectDesign.md` (line 126) and folded into every NativeDesign brief (`SKILL.md` line 55). These values bias the design, they do not bind it: the intent still names an aesthetic register out loud before writing code, and rotates registers across sessions when this file gives no preference. No tool parses this file. Every section is optional.

## Preferred register

One or two names from the register list in `skills/Webdesign/References/FrontendDesignPhilosophy.md` (lines 26-45). Leave blank to let each session choose fresh.

- Preferred: (blank)
- Avoid: `glassmorphic / aurora`

## Color palette

Design tokens the brief should start from. Hex values.

- Ground: `#0d0d0f`
- Surface: `#16161a`
- Ink: `#f4f1ea`
- Muted ink: `#9a978f`
- Accent: `#8b5cf6`
- Accent contrast: `#f5c542`

## Typography

Named fonts, not families like "a nice serif". The philosophy file's pair table (lines 72-86) lists register-appropriate choices; the free equivalents at line 88 all load from Google Fonts.

- Display: (blank)
- Body: (blank)
- Mono: `JetBrains Mono`
- Never use: `Inter`, `Roboto`, `Arial`, `system-ui` as the display face

## Spacing grid

- Base unit: `8px`
- Content max width: `72rem`
- Section rhythm: `6rem` desktop, `4rem` mobile

## Animation timing

- Entrance duration: `400ms`
- Easing: `cubic-bezier(0.22, 1, 0.36, 1)`

## Overrides of upstream

Standing overrides of the upstream quality floor, read by `Intents/DirectDesign.md` and `References/FrontendDesignPhilosophy.md`. Leave this section out to keep upstream defaults (reduced motion respected, any page ground).

- Motion policy: for example "respect reduced motion" (upstream) or "motion ships for everyone"
- Default page ground: for example "light", "dark", or "choose per register"

## Framework defaults

What a greenfield prototype should be built with when the brief does not say.

- Framework: static HTML and CSS, single file
- Styling: hand-written CSS with custom properties; Tailwind only when the target project already uses it
- Deploy target: Cloudflare Worker with static assets

## Brand assets

- Logo and fonts: `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/brand/` (see its README)

## Shipped sites

The last few sites shipped, newest first, read by the variety check in `References/FrontendDesignPhilosophy.md` so a new design does not repeat their register, typeface or ground. Leave it empty to fall back to the most recent sites in your projects list.

- `https://example.com`: editorial register, Fraunces display over Source Serif body, dark ground
- `https://docs.example.com`: technical register, IBM Plex Sans and Plex Mono, light ground
