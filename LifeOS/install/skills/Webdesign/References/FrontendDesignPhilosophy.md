# Frontend Design Philosophy

**Contents:** Core Doctrine (upstream, current) · Retained Reference (from the 2026-05 upstream; superseded upstream, kept for the workflows) · LifeOS Extensions

> **Attribution.** The aesthetic doctrine in this file is mirrored from Anthropic's open-source `frontend-design` skill, MIT-licensed.
> Source: https://github.com/anthropics/skills/tree/main/skills/frontend-design
> Authors: Prithvi Rajasekaran, Alexander Bricken (Anthropic).
> License: MIT (see Webdesign/References/FrontendDesignPhilosophy.LICENSE.txt for full terms).
> Imported: 2026-09-03 from upstream commit `41bbe19d` ("Update frontend-design skill to avoid generic design defaults", #1713). Previous import 2026-05-08. The upstream text was replaced wholesale in that commit; § Core Doctrine below is the current upstream verbatim, § Retained Reference keeps the prior version's register list and type recipes because the `🎨 AESTHETIC:` and `🔠 TYPE:` lines in `Intents/DirectDesign.md` draw on them, and § LifeOS Extensions carries the LifeOS-specific overrides, clearly marked.

This file is the load-bearing reference for the **DirectDesign** workflow and the brief source for **NativeDesign** artboards. The intents route here for the actual aesthetic content.

---

## Core Doctrine (upstream, current)

Approach this as the design lead at a design studio known for giving every client a distinct visual identity that is not mistaken for anyone else's. This client has already rejected proposals that felt cliché or templated, and is paying for a distinctive point of view: make deliberate, opinionated choices about palette, typography, and layout that are specific to this brief, and take aesthetic risk if justified.

### Ground your designs in the subject matter

If the brief does not identify what the product or subject matter is, identify it yourself before designing, and confirm with the client. You can come up with one concrete subject, the design's audience, and the design's primary job, as a proposal. If there's any information in your memory about the client's preferences or context about what they're building, use that as a hint. The subject's industry, subject matter, materials, and vernacular are where distinctive visual choices come from — a design for a toy for girls aged 8–11 will be very aesthetically different from a dashboard for financial analysts. Build with the brief's real content and subject matter throughout.

### Design principles

For web designs, the hero is the first thing viewers will see. Open with the most characteristic thing in the subject's world, in the form that is most appropriate: a headline, an image, an animation, a live demo, an interactive moment, or other treatments. Be deliberate with your choice: a big number with a small label, supporting stats, and a gradient accent is the default treatment, so only use it if that's truly the best option.

Typography carries the personality of the page. You don't need a different typeface for display or headline text and body content: use one family or two, and if two, make them clearly distinct.

Choose your typefaces deliberately, not the default families you would reach for on any other project, and set a clear type scale following the default guidance of The Elements of Typographic Style with intentional weights, widths, and spacing. When type is used as a headline or visual element, use the type treatment itself as an active part of the design, not a neutral delivery vehicle for the content.

Default to line lengths of less than 80 characters. Serif typefaces can have slightly longer line lengths; give serif body text slightly more line-height than a sans-serif.

Avoid these default typographic treatments; they are the commonest tells of a generated page:
- Accenting just a single word or phrase in a headline, like putting one word in italic/bold or a different color.
- Using all caps for labels.
- Adding unnecessary typographic labels above content.

Visual structure is information. Structural devices like outlines, borders, numbering, eyebrows, dividers, labels, etc., encode useful information about the content rather than decorate it. Many generic designs use numbered markers (01 / 02 / 03), but that's only appropriate if the content actually is a sequence — like a stepped process or a timeline. Before adding numbered markers, check the content really is a sequence.

Use non-user-triggered motion sparingly and deliberately, only to draw attention. A single orchestrated moment — one page-load sequence or one reveal — lands better than scattered effects; fade-and-slide-up entrances on each section and hover transitions on every card are the generic default and read as AI-generated. Motion that answers a person's action (opening, expanding, confirming) is welcome when it shows what changed.

Consider written content carefully. Often a design brief may not contain real content, and it's up to you to come up with copy and placeholder content. Copy can make a design feel as templated as the design itself. See the below section on writing for more guidance.

### Process: plan, review against the brief, build, critique

For calibration, AI-generated design right now clusters around some traits:
1. a warm cream background (near #F4F1EA) with a high-contrast serif display and a terracotta or warm-clay accent (often near #D97757 — Anthropic's own Claude-interaction accent, so on a user's brief it reads as a tell);
2. a near-black background with a single bright acid-green or vermilion accent;
3. a broadsheet-style layout with hairline rules, zero border-radius, and dense newspaper-like columns;
4. the SaaS-card kit: content chopped into identical rounded cards, one border-radius on everything regardless of hierarchy, the same soft grey shadow (rgba(0,0,0,.1)) under each, and gradient washes as decoration;
5. template chrome that appears whatever the subject: a tracked-out ALL-CAPS eyebrow label above every heading; meta strings joined with middle dots ('A · B · C'); labels built as 'WORD — fragment' with a spaced em dash; tinted near-black (#0B0B0B, #111) standing in for black; a monospace face for small data labels; a '→' appended to link and button text.

All traits are legitimate for some briefs, but they are defaults rather than choices, and they appear regardless of subject. Where the brief pins down a visual direction, follow it exactly — the brief's own words always win, including when it asks for one of these looks. Where it leaves an axis free, don't spend that freedom on one of these defaults. As with a hired human designer, there's often a careful balance between doing what you're good at and taking each project as a chance to experiment and learn.

Work in two passes. First, brainstorm a short design plan based on the client's design brief: create a compact token system with color, type, layout, and principles.
- Color: describe the core base palette as 4–6 named hex values.
- Type: the typefaces and their roles.
- Layout: a layout concept, using one-sentence prose descriptions and ASCII wireframes to ideate and compare. Include alignment guidance; should the content be left aligned, center aligned, justified?
- Principles: the high-level guidance for what makes this page unique.

Then review that plan against the brief before building: if any part of it reads like the generic default you would produce for any similar page (work through a similar prompt to see if you arrive somewhere similar) rather than a choice made for this specific brief — revise that part, say what you changed and why. Only after you've confirmed the relative uniqueness of your design plan should you start to write the code, following the revised plan.

When writing the code, be careful of structuring your CSS selector specificities. It's easy to generate CSS classes that cancel each other out (especially with a type-based selector like .section and an element-based selector like .cta). This can happen often with padding/margin between sections.

### Restraint and self-critique

Spend your boldness in one place. Let one element be the memorable thing, keep everything around it quiet and disciplined, and cut any decoration that does not serve the brief. Build to a quality floor without announcing it: responsive down to mobile, visible keyboard focus, reduced motion respected, visually accessible, harmonious color palettes. Critique your own work as you build, taking screenshots to review if your environment supports it — a picture is worth 1000 tokens. Consider Chanel's advice: before leaving the house, take a look in the mirror and remove one accessory. Human creatives have memory and always try to do something new, so if you have a space to quickly jot down notes about what you've tried, it can help you in future passes.

### More on writing in design

Words appear in a design for one reason: to make it easier to understand and use. They are design content, not decoration. Bring the same intentionality and minimalism to copywriting that you would bring to spacing and color. Before writing anything, ask what the design needs to say, and how it can best be said to help the person navigate the experience.

Write from the end user's perspective. Name things by what users will understand in simple language, not by how the system is built. A user manages notifications, not webhook config. Describe what something is or does in plain terms rather than selling it. Being specific and legible to new users is always better than being clever.

Use active voice as default. A CTA says exactly what happens when it is used: "Save changes," not "Submit." An action keeps the same name through the whole flow, so the button that says "Publish" produces a toast that says "Published." The vocabulary of an interface is the signposting for someone navigating the product. Cohesion and consistency are how people learn their way around.

Treat failure and emptiness as moments for direction, not mood. Explain what went wrong and how to fix it, in the interface's voice rather than a person's. Errors don't apologize, and they are never vague about what happened. An empty screen is an invitation to act.

Keep the tone conversational: plain verbs, sentence case, no filler, with tone matched to the brand and the audience. Let each written element do exactly one job.

---

## Retained Reference (from the 2026-05 upstream; superseded upstream, kept for the workflows)

The 2026-09 upstream dropped its register list, type-pair table, and timing table in favor of the process above. `Intents/DirectDesign.md` still asks for an explicit register and a named type pair, and the NativeDesign variant briefs use the register list to force divergence, so the tables stay here as a menu. They are inspiration, never a closed list, and the Core Doctrine's calibration list above outranks any row that has become a default.

### Aesthetic registers

- **Brutally minimal** — type, white space, almost no color, ruthless discipline
- **Maximalist chaos** — layered, dense, controlled overload, magazine-spread energy
- **Retro-futuristic** — 80s sci-fi, scanlines, CRT glow, vector-line illustrations
- **Organic / natural** — irregular shapes, hand-feel, soft edges, paper textures
- **Luxury / refined** — generous space, restrained palette, exquisite typography, slow motion
- **Playful / toy-like** — saturated color, chunky type, bouncy springs, oversized shapes
- **Editorial / magazine** — serif display, asymmetric grid, rule lines, body-text discipline
- **Brutalist / raw** — concrete textures, monospace, exposed grids, deliberate ugliness
- **Art deco / geometric** — symmetry, gold/black, fan motifs, axial composition
- **Soft / pastel** — washed palette, rounded corners, gentle shadows, breathable layouts
- **Industrial / utilitarian** — high-contrast, monospace, grid-locked, dieter-rams discipline
- **Glassmorphic / aurora** — translucent layers, blurred backdrops, gradient washes (deploy carefully — this is the cliché trap)
- **Swiss / international** — Helvetica family, strict grid, red accent, rationalist
- **Y2K / chrome** — bevels, gradients, Word-Art adjacent, controlled-tasteless
- **Solar-punk / organic-futurism** — plants + tech, warm + lush, optimistic
- **Cyberpunk / neon** — saturated cyan/magenta, scan effects, slab type, urban
- **Ghibli / hand-illustrated** — gentle gradients, soft suns, layered scenery, narrative warmth
- **Memphis / 80s graphic** — squiggle, polka dot, jazz triangles, primary color
- **Dark academia** — leather, brass, serif, oxblood, antique map textures
- **Or design one true to the brief** — these are inspiration, not a closed list

Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work — the key is intentionality, not intensity.

### Type pair recipes by register

| Register | Display | Body | Mono |
|----------|---------|------|------|
| Editorial | GT Sectra, Playfair Display, Canela, Söhne Breit | Söhne, Tiempos Text, Lyon Text | Söhne Mono |
| Brutalist | Neue Haas Grotesk, Suisse Int'l Mono, Berthold Akzidenz | IBM Plex Sans, JetBrains Mono | JetBrains Mono, Berkeley Mono |
| Retro-futuristic | VT323, Major Mono, Departure Mono | Space Mono, IBM Plex Mono | IBM Plex Mono |
| Maximalist | Migra, Migra Italic, Druk, Reckless | Untitled Sans, Söhne | Berkeley Mono |
| Luxury | Canela, Söhne Breit, Editor's Note | Tiempos Text, Söhne | — |
| Playful | Migra Italic, Reckless Neue, Recoleta | DM Sans, Söhne | Mono Lisa |
| Swiss | Neue Haas Grotesk, Helvetica Now | Helvetica Now Text, Söhne | — |
| Y2K / chrome | Druk Wide, Migra, Heroic Condensed | Söhne Breit, Söhne | — |
| Cyberpunk | Druk, JetBrains Mono Bold, Departure Mono | Inter Tight, IBM Plex Sans | JetBrains Mono |
| Dark academia | EB Garamond, Cormorant, IM Fell | Cormorant, EB Garamond, Lora | — |
| Solar-punk | Reckless, Cooper, Recoleta | Söhne, DM Sans | — |
| Hand-illustrated | Caveat, Borel, Reenie Beanie | Söhne, Newsreader | — |

Free equivalents on Google Fonts: Fraunces, JetBrains Mono, EB Garamond, Cooper Hewitt, Public Sans, Bodoni Moda, Big Shoulders, Azeret Mono, Karla, Instrument Serif, Bricolage Grotesque, Familjen Grotesk, Sora, Syne, Unbounded, Gloock, Young Serif, Anybody, Schibsted Grotesk. Space Grotesk is overused. Inter on white is the AI-slop tell.

### Motion timing (when motion is earned)

| Use | Duration | Easing |
|-----|----------|--------|
| Hover state changes | 150-200ms | `ease-out` / `cubic-bezier(0.16, 1, 0.3, 1)` |
| Modal / sheet open | 250-400ms | `ease-out` / spring |
| Page-transition reveals | 600-1200ms | spring or custom cubic-bezier |
| Hero / decorative loops | 4-12s | linear or sinusoidal |
| Scroll-triggered reveals | 600-900ms with 80ms stagger | `ease-out` |

Never animate body text while it is being read, form labels or inputs, or anything that delays user action by more than 300ms without payoff. One orchestrated moment beats scattered micro-interactions (Core Doctrine § Design principles).

### Forbidden defaults (the AI-slop list)

- **Fonts:** Inter, Roboto, Arial, Helvetica (default), system-ui, sans-serif as the choice
- **Colors:** purple gradient on white, indigo-to-pink, cream + terracotta, near-black + one acid green, default Tailwind gray-100/gray-900 only
- **Layouts:** centered card on flat color, hero + 3-column features + CTA, broadsheet hairlines-and-columns as a reflex, default Tailwind UI templates
- **Components:** shadcn defaults shipped without aesthetic customization, lucide-react icons used without scale/stroke variation, identical rounded cards with the same soft shadow
- **Chrome:** tracked-out ALL-CAPS eyebrows, middle-dot meta strings, 'WORD — fragment' labels, '→' appended to links, monospace for every small data label, numbered 01/02/03 markers on non-sequences
- **Shadows:** `shadow-md` / `shadow-lg` Tailwind defaults, `0 2px 4px rgba(0,0,0,0.1)`
- **Border radius:** uniform `rounded-lg` everywhere
- **Spacing:** default Tailwind `space-y-4` rhythm without intent

### What "done" looks like

1. The aesthetic register is immediately legible — a designer could name it within 3 seconds
2. Typography is intentional — the pair is named, not default
3. Color is committed — palette stated, contrast verified, accent restrained
4. Motion is purposeful — every animation can be defended in one sentence
5. Spatial composition has a point of view — the layout is not a generic stack
6. Backgrounds have texture or depth — solid white/black is a choice, not a default
7. Code is production-grade — runs without errors, passes basic a11y, no lorem placeholders
8. Differentiation is named — there is one memorable element you can point at

---

## LifeOS Extensions

These extensions are LifeOS-specific (not in the upstream Anthropic source). They handle integration into the wider LifeOS workflow, and where they contradict the upstream text they win.

### Overrides of upstream (install preferences)

- **Install overrides come from PREFERENCES.md.** The principal's standing overrides of upstream defaults (motion policy, default page ground) are in `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Webdesign/PREFERENCES.md` § Overrides of upstream; when that section exists it wins over the upstream quality floor here, and when it is absent upstream stands.
- **Variety is checked against real data, not memory.** Before shipping, name the register, typeface, and alignment. Check the last 2–3 shipped sites (the `## Shipped sites` list in `USER/CUSTOMIZATIONS/SKILLS/Webdesign/PREFERENCES.md`; when it is empty or absent, the most recent sites in the projects list), inspect their `font-family` and ground declarations, and avoid repeating their type pairings.
- **Data-heavy pages are where the calibration tells bite hardest.** Leaderboards, dashboards, and stat pages reach reflexively for monospace data labels, all-caps eyebrows, middle-dot meta strings, and hairline broadsheet rules. On those pages treat every one of those as a decision to defend in the plan, not a default to inherit.

### Verification — Interceptor screenshot

Upstream's "take screenshots to review" is a gate here, not a suggestion: web output is verified through the **Interceptor skill** before done is declared, because real Chrome catches the rendering issues that "code looks right" misses. The screenshot criteria and the output contracts live in `Intents/DirectDesign.md`; the preferences that bias the register live in `SKILL.md` § Data & Config; the choice between DirectDesign and NativeDesign is `SKILL.md` § Intent Routing.
