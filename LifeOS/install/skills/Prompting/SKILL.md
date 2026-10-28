---
name: Prompting
evals:
  manual:
    reason: "a reusable prompt must be judged for whether it captures the supplied intent, constraints, and output contract"
    falsifier: "the reviewer finds the prompt omits a material requirement or its output contract cannot guide the intended downstream task"
metadata:
  short-description: "Generate, compose, or optimize reusable prompts and templates, including system prompts. Produces prompts, not final domain content."
version: 1.1.40
description: "Meta-prompting standard library for generating, optimizing, and composing prompts programmatically via Standards, Handlebars Templates, and Tools; output is always a prompt to use elsewhere, not final content. USE WHEN meta-prompting, template generation, prompt optimization, prompt engineering, write a prompt, create system prompt, Handlebars template. NOT FOR generating final content (use the appropriate domain skill), or any eval: judge prompts, rubrics, scoring, grading or comparing outputs all run through Assay, the one eval system."
---

# Prompting - Meta-Prompting & Template System

**Contents:** Ideal State · Anti-criteria · Intent Routing · Data & Config · Gotchas · Examples · References

Generates, optimizes, and composes prompts programmatically. It's the standard library for prompt engineering — other skills call it when they need to build or improve a prompt. The output is always a prompt to be used elsewhere, never the final content itself.

**Philosophy:** Prompts that write prompts. Structure is code, content is data. Meta-prompting enables dynamic composition where the same template with different data generates specialized agents, workflows, and evaluation frameworks.

## Ideal State

- Every prompt this library generates or optimizes articulates the ideal state, not the procedure: WHAT done looks like as testable outcomes, the CONSTRAINTS, and the high-quality TOOLS available, with the specificity moved to the outcome so the prompt is more precise, not vaguer.
- In every prompt this library generates or optimizes, the only HOW that survives is the four keep-classes (safety-gate, verified-gotcha, tool-contract, output-format-contract); every other procedural line failed the test of whether a smarter model would make it unnecessary. Deterministic tools (`*.ts`) are exempt. The full standard is `Standards.md` § Ideal-State Prompting.
- A prompt composed from data keeps structure as code and content as data: a Handlebars template under `Templates/` rendered with a data object, or from a .yaml or .json file, through `RenderTemplate.ts`.
- A reusable prompt captures the supplied intent, constraints, and output contract; its output contract can guide the intended downstream task; and it was tested before it was declared ready.
- When `Standards.md` is authored or audited (not on routine template renders), both official anchors were fetched and every place our standards diverge from the current official guidance is flagged.

## Anti-criteria

- No reasoning choreography ("first analyze, then consider, then decide") in a prompt this library generates or optimizes: it is BLE-violating scaffolding that caps a capable model and rots as models improve.
- Meta-prompting never produces the final deliverable: it generates PROMPTS, not content.
- No template or prompt depends on specific model quirks; templates stay model-agnostic.
- No generated prompt is declared ready untested: a prompt that looks good may perform poorly.
- Standards drift is reported, never auto-adopted, and an unreachable anchor URL never blocks the work.

## Intent Routing

Library skill, no `Intents/` directory. Requests route to the tools and reference docs:

| Intent | Trigger | File |
|--------|---------|------|
| **RenderTemplate** (tool) | render a template, compose a prompt from data, Handlebars template | `Tools/RenderTemplate.ts` |
| **ValidateTemplate** (tool) | validate a template | `Tools/ValidateTemplate.ts` |
| **Standards** (reference) | prompt engineering standards, best practices, prompt optimization | `Standards.md` |

| File | Read when |
|------|-----------|
| `Standards.md` | writing, optimizing or auditing any prompt: the ideal-state standard, the keep-classes, signal-to-noise, Anthropic and research-backed practice |
| `References/WritingGreatSkills.md` | the prompt is a skill or intent: invocation load, information hierarchy, completion criteria, pruning |
| `Templates/` | composing a prompt from data: Primitives (Briefing, Structure, Gate, Roster, Voice) (evals and judges are not composed here; they run through Assay, `LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § One eval system), `Data/` presets, and `Templates/README.md` for the template system |
| `Setup.md` | first-time setup: the one package the template tools need (`handlebars`) and a read-only check |

## Data & Config

**Before executing, check for user customizations at:**
`<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Prompting/`
configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`.

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there. These override default behavior. If the directory does not exist, proceed with skill defaults.

First-time setup for the template tools is in [Setup.md](Setup.md).

## Gotchas

- **`Tools/` is the only tool directory.** A byte-identical stale copy under `Templates/Tools/` was removed on 2026-10-14 (LOSIntegrity cruft sweep); edit and import `Tools/`, which `Tools/RenderTemplate.test.ts` covers.

## Examples

### Example 1: Using Briefing Template (compose an agent brief)

`renderTemplate(templatePath, data)` takes a path under `Templates/` and a data object and returns the text. `renderTemplate({ templatePath, dataPath })` renders from a .yaml or .json file instead.

```typescript
// Render a structured agent brief from data before launching general-purpose
import { renderTemplate } from '${LIFEOS_SKILL_DIR}/Tools/RenderTemplate.ts';

const prompt = renderTemplate('Primitives/Briefing.hbs', {
  briefing: { type: 'research' },
  agent: { id: 'EN-1', name: 'Skeptical Thinker', personality: {...} },
  task: { description: 'Analyze security architecture', questions: [...] },
  output_format: { type: 'markdown' }
});
```

### Example 2: Ideal-state brief from a data file (outcomes, constraints, tools)

The data states what done looks like, the limits, and the tools; it carries no steps.

```yaml
# Data: attack-surface-brief.yaml
briefing: { type: analysis }
agent: { id: SEC-1, name: Attack Surface Reviewer }
context:
  summary: Review the public API of the billing service before launch.
  background: "Tools available: the repo checkout, rg, and read-only staging credentials."
  constraints:
    - Read-only; no writes to staging or production.
    - Findings cite file:line or a reproducible request.
task:
  description: Report the external attack surface of the billing service.
  deliverables:
    - Every external entry point is listed with its auth requirement.
    - Each finding carries a severity and a reproducible request or file:line.
    - Entry points that could not be checked are named, with the reason.
output_format: { type: markdown }
```

```bash
# Relative paths are looked up under Templates/ first, then the current directory (so attack-surface-brief.yaml can sit where you run this).
bun run ${LIFEOS_SKILL_DIR}/Tools/RenderTemplate.ts \
  --template Primitives/Briefing.hbs \
  --data attack-surface-brief.yaml --preview
```

## References

- `LIFEOS/DOCUMENTATION/Agents/AgentSystem.md` — agent briefs are the general-purpose agent plus a brief rendered from `Templates/Primitives/Briefing.hbs`.

**Official anchors (drift check):** the two authoritative Anthropic sources this skill's standards derive from. They change with each model family, which is why `Standards.md` is checked against them when it is authored or audited:
- Prompt engineering: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview
- Context engineering: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

**Research foundation:** every source behind the standards, with links, is listed once in `Standards.md` § References and § Prompt Templating System › References.
