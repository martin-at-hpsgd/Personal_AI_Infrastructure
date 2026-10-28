# DesignDocumentCheck

Checks a DesignDocument output (`Intents/DesignDocument.md`) against the parts of its contract that code can judge, and renders every Mermaid block through the Mermaid CLI (`mmdc`), a real parser. Whether the document is specific to its input and faithful to a pasted design stays a judged check in the `fabric-designdocument` suite.

## Usage

```bash
bun skills/Fabric/Tools/DesignDocumentCheck.ts <file|-> [--no-render] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--no-render` | Skip rendering the diagrams (shape checks only) |
| `--json` | Print `{ok, title, sections, diagrams, rendered, problems}` |
| `--help` | Print usage |

## Checks

- The first line is `# Design Document: {system name}`. Nothing comes before it, and the document is never wrapped in a code fence.
- Exactly the five sections, in order: `## BUSINESS POSTURE`, `## SECURITY POSTURE`, `## DESIGN`, `## RISK ASSESSMENT`, `## QUESTIONS & ASSUMPTIONS`.
- Each section holds its `###` sub-sections in order, and no others (sub-heading names match case-insensitively):
  - BUSINESS POSTURE: an opening paragraph, then Business priorities and Business risks.
  - SECURITY POSTURE: Existing security controls, Accepted risks, Recommended security controls, Security requirements.
  - DESIGN: C4 CONTEXT, C4 CONTAINER, C4 DEPLOYMENT.
  - RISK ASSESSMENT: Critical business processes, Data to protect.
  - QUESTIONS & ASSUMPTIONS: BUSINESS POSTURE, SECURITY POSTURE, DESIGN.
- Every non-DESIGN sub-section holds only top-level `- ` bullets, at least one. There are no sub-bullets, numbered items or commentary lines.
- Every existing control opens on `security control:`. Every accepted risk opens on `accepted risk:`, and `accepted risk: none stated` is allowed.
- Every question bullet ends its question with `?`, and later in the same bullet gives `Assumed: {default}`. A sentence of context may sit between the two.
- Each C4 view holds one `mermaid` code fence followed by one table. The table's columns are exactly Name, Type, Description, Responsibilities, Security controls, then comes a separator row, then at least two rows of five non-empty cells. Every Name appears in that view's diagram text, matched as lower-case words with punctuation and Mermaid line breaks (`<br/>`) ignored, and also with any parenthetical removed.
- There are no code fences other than `mermaid`, no headings deeper than `###`, and no bold or italic markdown outside code (`**`, `__`, `*word*`, `_word_`). Snake_case and inline code are not italics.
- Unless `--no-render` is set, every diagram renders through `mmdc`. All blocks render in one Chrome launch, and only when that fails is each block rendered alone, so the failure names its view.

## Exit codes

- `0`: the shape holds and every diagram renders.
- `1`: a rule failed or a diagram does not render. Each failure prints as one `✗` line.
- `2`: bad usage, unreadable input, `mmdc` not installed, or `mmdc` did not finish within 120 seconds.

## Gotchas

- 2026-10-25: Chrome under `mmdc` hangs at launch and times out after 30 seconds when the calling process is itself inside a macOS `sandbox-exec` profile, because Chrome's own sandbox cannot nest there. The checker therefore passes a Puppeteer config with `--no-sandbox` (the configuration the Mermaid CLI documents for containers) and pins Mermaid's `securityLevel` to `strict`, which sanitizes labels before rendering.
- A render pass costs one Chrome launch, about 11 to 17 seconds on the machine where this was measured. `--no-render` is for re-checking shape after a text-only edit to a draft whose diagrams already rendered.
