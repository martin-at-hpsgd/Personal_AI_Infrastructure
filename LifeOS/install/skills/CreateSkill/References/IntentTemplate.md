# Intent and Skill Templates

**Contents:** Intent · Skill with intents · Single-intent skill (no `Intents/`) · Data & Config block · Standard bullets for common intent shapes · Intent-to-Flag Mapping example · Frontmatter `contract:` shape

The templates every new skill and intent starts from. `Tools/Scaffold.ts` reads the four fenced blocks below (`intent`, `skill`, `skill-single`, `data-config`) by their `template:` markers and fills the `{{...}}` slots (`{{Summary}}` is the `metadata.short-description` the Codex skill catalog shows, one plain sentence within the cap IntentLint enforces), so this file is the single source: change a template here and the scaffolder follows. The standard they encode is `LIFEOS/DOCUMENTATION/Skills/SkillSystem.md` § Intent anatomy; when the two disagree, that section wins and this file is corrected.

A scaffolded file carries only the required sections plus its `## Evals` line. Add an optional section only when the intent has something real to put in it, after `## Anti-criteria` and by convention in this order (unenforced; IntentLint checks only that each H2 is one of the allowed eight): `## Evals`, `## Inputs`, `## Safety gates`, `## Tool contract`, `## Gotchas`, `## Output format`, `## Examples`, `## References`. A `###` sub-heading inside one of them is fine. Any other H2 is either one of these or choreography to cut.

`## Evals` names the eval set the intent's output must pass (principal directive, 2026-10-24: every intent runs with an Assay eval set). Assay always compiles checks from the Ideal State and Anti-criteria; the scaffold's `- compiled: …` bullet says those are the whole set. When the output must also pass a shared set, add one bullet per set: `- library: <name>` for a check library in `skills/Assay/Libraries/` (a rendered video inherits `library: video`, a page `library: web-app`), or `- suite: <name>` for a suite under `skills/Assay/Suites/`. IntentLint refuses a name that does not exist, and an intent born with `## Evals` whose Ideal State has no bullet Assay can compile (a claim of three or more words).

## Intent

<!-- template:intent -->
~~~~markdown
# {{IntentName}}

<One line: what this intent produces.>

## Ideal State

- <A testable outcome of the deliverable, specific enough that a reader could show it failed.>
- <A second outcome: a quality the deliverable has, or an intermediate output that existed and was checked before the deliverable was built on it.>

## Anti-criteria

- <What must never happen: the wrong output, the forbidden side effect, the shortcut that looks like success.>

## Evals

- compiled: Assay checks every output against the Ideal State and Anti-criteria above.
~~~~

## Skill with intents

<!-- template:skill -->
~~~~markdown
---
name: {{SkillName}}
version: 1.0.0
description: {{Description}}
metadata:
  short-description: {{Summary}}
evals:
  pending: "<the real evidence being prepared, and the command, suite or reviewer that will verify this skill>"
---

# {{SkillName}}

<One paragraph: what the skill does, and the declarative facts its intents share.>

## Ideal State

- <What a good use of this skill delivers, as a testable outcome across its intents.>
- <A second outcome: the quality bar every output of this skill meets.>

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
{{RoutingRows}}

<!-- Every References/ and root .md file gets a row here once it exists: | File | Read when | -->
{{DataConfig}}
## Gotchas

_No gotchas documented yet. Add each failure here, dated, once it has been reproduced._

## Examples

**Example 1: <common use case>**
```
User: "<typical request>"
→ <IntentName> intent
→ <what the user gets back>
```
~~~~

## Single-intent skill (no `Intents/`)

<!-- template:skill-single -->
~~~~markdown
---
name: {{SkillName}}
version: 1.0.0
description: {{Description}}
metadata:
  short-description: {{Summary}}
evals:
  pending: "<the real evidence being prepared, and the command, suite or reviewer that will verify this skill>"
---

# {{SkillName}}

<One paragraph: what the skill produces.>

## Ideal State

- <A testable outcome of the deliverable, specific enough that a reader could show it failed.>
- <A second outcome: a quality the deliverable has, or an intermediate output that existed and was checked before the deliverable was built on it.>

## Anti-criteria

- <What must never happen: the wrong output, the forbidden side effect, the shortcut that looks like success.>

## Evals

- compiled: Assay checks every output against the Ideal State and Anti-criteria above.
{{DataConfig}}
## Gotchas

_No gotchas documented yet. Add each failure here, dated, once it has been reproduced._

## Examples

**Example 1: <common use case>**
```
User: "<typical request>"
→ <what the skill does>
→ <what the user gets back>
```
~~~~

## Data & Config block

<!-- template:data-config -->
~~~~markdown

## Data & Config

Personal data and config for this skill live in `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/{{SkillName}}/` (or the canonical USER home that already owns them), read at run time. The skill body names env var names, never values.
~~~~

## Standard bullets for common intent shapes

These are outcomes and never-lists, not steps. Copy the one that fits into the scaffolded intent and make it specific.

- **Substantive artifact (sufficiency).** Required for a new intent that produces a substantive artifact, skipped for a pure transform or a pure lookup (the live Algorithm's criterion 6, material ambiguity resolved before building: `LIFEOS/ALGORITHM/LATEST` names the current version; restated here as an outcome). Anti-criteria: `Never builds a structurally wrong artifact on speculation: when the inputs are clearly insufficient it asks at most three questions, with a "proceed" override, and waits; when they are workable but ambiguous it ships the best-effort version with one line in the form "⚠️ Picking X over Y because R; redirect if wrong."`
- **Required intermediate output.** Ideal State: `The <storyboard / CSE / scope map> existed and was checked before any <render / essay / recommendation> was built on it.` When the intermediate is a file, declare it in frontmatter `contract.requires` (`id`, `path`, non-empty `fields`, optional `produce`), which `LIFEOS/TOOLS/IntentContract.ts` verifies.
- **Calls a CLI tool.** `## Tool contract` carries the exact command and a `### Intent-to-Flag Mapping` table from what the user says to the flag it selects (mode, output, resource, post-processing), per `~/.claude/LIFEOS/DOCUMENTATION/Tools/CliFirstArchitecture.md`.
- **Read-only analysis.** Anti-criteria: `Never edits, creates or deletes a file in the target; findings are reported, never applied.`
- **Destructive or external action.** `## Safety gates` names the confirmation, the permission row, and what is checked before the action runs.

## Intent-to-Flag Mapping example

What a `### Intent-to-Flag Mapping` sub-heading under `## Tool contract` holds for an intent that calls a CLI tool. Users speak naturally; the intent translates to precise flags, so the tool's configuration stays exposed instead of one hardcoded pattern.

~~~~markdown
### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| "fast", "quick", "draft" | `--model sonnet` | Speed priority |
| (default), "best", "high quality" | `--model opus` | Quality priority |
| "JSON output" | `--format json` | Machine-readable |
| "detailed" | `--verbose` | Extra information |

Command, built from the mapping:

```bash
bun ToolName.ts \
  [FLAGS_FROM_INTENT_MAPPING] \
  --required-param "value"
```
~~~~

## Frontmatter `contract:` shape

```yaml
---
contract:
  requires:
    - id: storyboard
      path: work/{slug}/storyboard.md
      fields: [SHOTS, TIMING]
      produce: 'Write {path} with SHOTS and TIMING sections.'
---
```
