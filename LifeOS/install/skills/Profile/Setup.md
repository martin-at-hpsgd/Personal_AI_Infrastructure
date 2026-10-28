# Profile

**Contents:** What it does · Fill in · Accounts and secrets · Prove it works

Status: `bun ~/.claude/LIFEOS/TOOLS/HeaderMirror.ts --check` · optional

## What it does

Profile shows, edits and resets your User Model: one markdown file, `~/.claude/LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md`, that every LifeOS session loads at startup so the assistant knows who you are, how you like to work, and your standing preferences. View prints it, Edit changes the sections you name and stamps `last_updated`, and Clear backs it up to `~/Downloads` and resets it to a blank template after you say yes. The file is never deleted, because startup imports it.

It needs nothing beyond a LifeOS install. A fresh install already carries a starter copy of the file; if it is missing, the Edit intent creates it from the blank template.

## Fill in

One file: `~/.claude/LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md`. You can fill it by asking ("update my profile: I prefer metric units"), through the Interview skill, or by editing it directly. Worked example on made-up values:

```markdown
---
last_updated: 2026-01-15T09:00:00.000Z
last_updated_by: Echo
convention: lifeos-freshness-v1

core:
  name: Jordan Example
  pronunciation: JOR-dun
  timezone: America/Chicago

voice_clone:
  provider: ""
  voice_id: ""
  voice_name: ""

preferences:
  temperature_unit: celsius

tech_stack:
  package_manager: bun
  language: TypeScript
---

# Principal Identity

## Quick Reference

- **Name:** Jordan Example
- **Role:** Independent landscape architect
- **Location / timezone:** Midwest US, America/Chicago

## Worldview

- Prefers evidence over anecdote; changes their mind when shown data.

## Work Patterns & Communication

- Short answers first, detail on request. Mornings are for deep work.

## Preferences

- **Units:** metric
- **Tools:** command line first; plain text over rich formats
```

| Part | What reads it |
|------|---------------|
| `core` (`name`, `pronunciation`, `timezone`) | The identity loader in `hooks/lib/identity.ts`, as a fallback: the `[principal]` table in `LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml` wins when it sets them. |
| `voice_clone` | Only the model, through the generated header-mirror block. Leave the values empty if you have no cloned voice. |
| `preferences`, `tech_stack` | The identity loader, for skills that personalize output. |
| The sections below the header | The model, every session. Add your own sections; Edit keeps whatever headings you use. |

Edit the YAML header for facts code reads, never the generated `<!-- header-mirror -->` block in the body: `HeaderMirror.ts` rewrites that block from the header, because the startup import strips the header before the model sees it. Leave out health, relationship and financial details unless you want every session to carry them.

## Accounts and secrets

None. The file lives in your private USER tree and never needs a key.

## Prove it works

Read-only:

```bash
bun ~/.claude/LIFEOS/TOOLS/HeaderMirror.ts --check
```

It exits 0 when the generated block in every startup file, this one included, matches its YAML header, and exits 1 naming the file when a block is missing or stale (an edit to the header that has not been mirrored yet). Then ask "show my profile": the View intent prints the file, and the facts you filled in should be there. A new session is needed before edits reach the startup context.
