---
name: Visualize
metadata:
  short-description: "Visualizes anything as a short console summary plus a designed HTML page, with every fact labelled by where it came from."
version: 1.2.3
evals:
  deterministic:
    - command: "bun LIFEOS/TOOLS/SkillHygieneGate.ts --skill Visualize"
      falsifier: "the skill body carries a deny-list token or a home-path literal"
  manual:
    reason: "whether a map actually leaves its reader understanding the system needs a human reading it against the code"
    falsifier: "the reader finds a component, connection or risk on the page that the cited file does not support, or cannot say how the primary flow works after reading the console output"
description: Visualizes anything at all and never declines — a codebase, a physical setup, a timeline, a process, finances, a comparison, a concept, a URL, a dataset — as a short console summary plus a designed HTML page, every fact labelled with where it came from (a file quote, a URL, the principal's words, or general knowledge). USE WHEN visualize, visualize this, visualize my <anything>, visualize <project>, show me this visually, draw it, map it, lay it out, how does X work, explain this architecture, map this system, system map, architecture map, what are the moving parts, draw my setup, show me my plan, walk me through this codebase, diagram this project or ISA. NOT FOR a standalone generated illustration or header image with no visualize ask (Art), rendering an ISA page (ISA), turning session output into an artifact (HTML), or hand-drawn sketches (Excalidraw).
---

# Visualize

**Contents:** Ideal State · Intent Routing · Data & Config · Split of work · Gotchas · Examples

Points at a project, repo, directory or ISA and leaves the principal understanding how it works: a concise ASCII map in the console and a designed HTML explanation saved next to the code. The purpose is that nothing runs in production that nobody understands.

Points at a physical plan (a gear setup, a rig, a room, a purchase list) and leaves the principal seeing it: a to-scale top-down drawing with the cost split, the full order and the open decisions, every fact quoted from the plan document.

Anything else (an idea, a comparison, a dataset, a timeline, a process) becomes one hand-built concept page with a short console summary. The skill never declines.

## Ideal State

- Whatever is named gets visualized through the route that fits it (system map, physical plan or concept page), never declined and never squeezed into the wrong route.
- Every fact on a page says where it came from (a `file` or `file:line`, a verbatim plan quote, a URL, `computed`, the principal's words or `general knowledge`), and anything unconfirmed is labelled as such rather than stated.
- The console summary alone tells the principal what the thing is and the one thing worth acting on, and the page holds the full picture, looked at in a real renderer before delivery.
- The subject is only read: the page (and a plan's model under USER) are the only writes, and no secret value lands on any page.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **Visualize** | "visualize" on code, "how does X work", "map this system", "explain this architecture" | `Intents/Visualize.md` |
| **Plan** | "visualize" on a physical thing: "visualize my drum/studio/desk plan", "lay out my setup", "draw my rig", "show me my order" | `Intents/Plan.md` |
| **Concept** | "visualize" on anything that is neither code nor a physical plan: an idea, a scientific question, a comparison, a dataset, a timeline, a process | `Intents/Concept.md` |

| File | Read when |
|------|-----------|
| `Setup.md` | first-time setup: the optional `PREFERENCES.md` keys and where saved plans live |

## Data & Config

User customizations live at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Visualize/` (configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). When it exists, its PREFERENCES.md, configurations and resources override the defaults here, and plan models live under its `Plans/`; when absent, the defaults stand. PREFERENCES.md keys: `## Concept pages` → `Ground:` (the page ground Concept uses; default is whatever suits the subject). Setup: [Setup.md](Setup.md).

## Split of work

The model reads the target and writes one typed system-model JSON. `Tools/Visualize.ts` owns everything after that: it refuses models whose citations do not resolve, prints the ASCII, lays out the SVG, and writes the page. The model never hand-writes ASCII art or HTML, which keeps every map consistent and the grounding check in code.

- `bun ~/.claude/skills/Visualize/Tools/Visualize.ts --schema` prints the model shape with an example.
- Physical plans use `Tools/VisualizePlan.ts` with the same flags and the same split: the model writes a plan-model JSON (`--schema` shows it), and the tool checks every `{ file, quote }` against the plan document before drawing the page.
- Concept pages are the exception: the model hand-builds the page, because a fresh composition per subject is what makes them good. `Tools/Bake.ts` owns the mechanical parts: `--check` parses every inline script before any screenshot, and a bake writes a script-free copy for hosts that block scripts.
- Every browser check serves the page over a local HTTP server, because the Interceptor test profile cannot read `file://`.

Flags shared by both renderers (`--check` validates without writing):

| User says | Flag | Effect |
|-----------|------|--------|
| (default) | — | Console output + page in the `--root` directory |
| "just show me", "console only", "no HTML" | `--no-html` | Console output only |
| "put it in Downloads", "save it to X" | `--out-dir <dir>` | Page lands in that directory instead |
| "wider", "narrow terminal" | `--width <n>` | Console width (default 100) |

## Gotchas

- **"Visualize" on a physical plan is still this skill.** A request to visualize a drum-kit order was once built as a hand-written one-off page because the description only named code. The Plan route and renderer exist so that doesn't happen again. (2026-09-24)
- **Share hosts serve HTML under `Content-Security-Policy: sandbox`**, which blocks every script, and their preview page shows HTML as source. A scripted page uploaded raw renders blank; upload the baked copy and give the raw link. (2026-10-06) The same sandbox blocks new tabs, so a `target="_blank"` link does nothing on a plain click; `Bake.ts` strips those targets, so link rows only work in the baked copy. (2026-10-12)

## Examples

**Example 1: A half-forgotten service**
```
User: "visualize the monitoring layer"
→ Visualize intent
→ A console map naming its parts, main flow and top risk, and <dir>/Visualize-<slug>-<timestamp>.html where every part, link and risk cites its file
```

**Example 2: From an ISA**
```
User: "/visualize path/to/project/ISA.md"
→ Visualize intent
→ The ISA supplies intent and names, every component is grounded in the code the ISA points at, and the page lands next to the ISA
```

**Example 3: A gear plan**
```
User: "visualize my drum kit plan"
→ Plan intent
→ A to-scale top-down drawing with the cost split, the full order and the open decisions, every fact quoted from the order sheet; a cost that misses the stated total is flagged first
```

**Example 4: A comparison from the conversation**
```
User: "visualize the three options we just compared"
→ Concept intent
→ One designed page whose main figure draws the comparison, every fact source-tagged, and a console line naming the one non-obvious difference
```
