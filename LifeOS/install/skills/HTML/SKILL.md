---
name: HTML
evals:
  manual:
    reason: "the self-contained artifact must be reviewed in a browser for readable hierarchy, complete content, and requested visual treatment"
    falsifier: "the reviewer finds missing supplied content, broken layout, unreadable text, or a visual result that fails the requested artifact"
metadata:
  short-description: "Render completed analyses or reports as designed HTML artifacts through a deterministic renderer. Use ISARender for ISAs and Webdesign for web UI."
version: 1.0.5
description: Renders the current session output as a self-contained, designed HTML artifact via a deterministic renderer that owns all layout from typed JSON. USE WHEN /HTML, HTML artifact, render this as HTML, make this an HTML page, artifact of this analysis, designed HTML output. NOT FOR ISAs (ISARender.ts is the canonical ISA renderer), deployed sites or web apps, web UI design systems (Webdesign), static images or diagrams (Art), or writing the analysis itself.
---

# HTML

Turns whatever the session just produced into one self-contained, designed HTML file and publishes it as an Artifact. Deterministic split: the model's only job is distilling the session output into a typed content JSON and picking a design register; `Tools/Render.ts` owns every layout, typography, and color decision. Output is Artifact-CSP safe: inline CSS, fonts embedded as data URIs from local font files, zero external requests. The renderer command, block types and register table live in `Intents/Render.md`.

## Ideal State

- Any session output becomes one self-contained, Artifact-safe HTML file that makes zero external requests and renders for the owner.
- Layout, typography and color come entirely from `Tools/Render.ts` registers; the model supplies only typed content JSON, so no hand-styled one-off ships.
- The artifact is verified before hand-off — published through the Artifact tool and pixel-checked.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **Render** | `/HTML`, "HTML artifact", "render this as HTML" | `Intents/Render.md` |

## Data & Config

No user configuration: registers are defined in `Tools/Render.ts`, which embeds fonts found in `~/Library/Fonts`, `/Library/Fonts` or `/System/Library/Fonts/Supplemental` (macOS font folders; with none present it falls back to system font stacks). Publishing needs the Claude Code Artifact tool and its `artifact-design` skill; without them `Render.ts` still writes the local HTML file.

## Gotchas

- **DOM-render screenshot pipelines drop CSS pseudo-element generated content** (counters, `::before` labels render in the browser but vanish from DOM-render captures, and they're invisible to text extraction). Render.ts therefore emits all numbering and labels as real DOM text. Never add CSS counters to a register. (Discovered 2026-07-11.)
- **Artifacts block all external requests** — a Google Fonts `<link>` fails silently and you get the fallback stack. Embed via data-URI `@font-face` (Render.ts does this when the register's font file exists locally) or design on system stacks.
- **The artifact viewer wraps your file in its own document skeleton** — emit `<title>` + `<style>` + body content only; no `<!doctype>`/`<html>`/`<head>`/`<body>` tags.
- **A published artifact is private to its owner's claude.ai account** — verifying it in a browser signed into a different account/org 404s. Verify the render by serving the HTML file locally and capturing that; verify publication via the Artifact tool's `list` action.
- **Numbered section markers must mean something.** Render.ts numbers sections (document order — legitimate). Don't number list items unless the content is a true sequence; use `list` blocks with bold lead-ins instead.

## Examples

**Example 1: After a research or red-team session**
```
User: "/HTML"
→ Render intent
→ The session's findings, quotes and sources are published as a `dossier` artifact, its local render pixel-checked, and the URL handed over with a one-line description
```

**Example 2: Different subject, different register**
```
User: "render the quarterly cost analysis as HTML"
→ Render intent
→ A `ledger` artifact with tables and callouts, the register that fits a cost report
```
