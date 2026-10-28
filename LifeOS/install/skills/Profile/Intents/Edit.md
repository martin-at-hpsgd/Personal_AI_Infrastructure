# Edit

Edit the user's profile.

## Ideal State

- The requested change lands in `~/.claude/LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md` as an edit to specific sections the file already has, and all existing data the user did not explicitly ask to change is preserved.
- A change to a header fact (`core`, `voice_clone`, `preferences`, `tech_stack`; readers in SKILL.md § Data & Config) lands in that frontmatter key and the header-mirror block is regenerated. A change to name, pronunciation or timezone also lands in `LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml` `[principal]`, which wins over the frontmatter.
- When the file does not exist, it is created from the blank template under Output format (the same template Clear writes).
- A specific request is applied directly; only an open-ended request ("edit my profile") gets the current contents and a question about what to change.
- After any edit, the frontmatter carries `last_updated` set to now (ISO-8601) and `last_updated_by` set to the DA's name.

## Anti-criteria

- Never overwrites the entire file; edits specific sections.
- Never imposes the template's headings on an existing file.
- Never writes `last_reviewed` or `last_reviewed_by`: only a principal review (the Interview skill's ContextCheckin) does, and the staleness grade is computed from it.
- Never changes the `## Memory-System Proposals` queue at the bottom of the real file; the memory curation loop owns it.

## Tool contract

The frontmatter bump is `bumpContextTimestamp(filePath, by)` in `LIFEOS/TOOLS/TelosFreshness.ts`.

After a header-fact change, `bun LIFEOS/TOOLS/HeaderMirror.ts` rewrites the generated block in the body from the frontmatter.

## Output format

The blank template, created when the file does not exist (Clear writes the same one):

```markdown
---
last_updated: [now, ISO-8601]
last_updated_by: [DA name]
convention: lifeos-freshness-v1

core:
  name: ""
  pronunciation: ""
  timezone: ""

voice_clone:
  provider: ""
  voice_id: ""
  voice_name: ""

preferences:
  temperature_unit: ""

tech_stack:
  package_manager: ""
  language: ""
---

# Principal Identity

## Quick Reference

- **Name:** [name]
- **Role:** [your role]
- **Location / timezone:** [where]

## Worldview

- [position 1]

## Work Patterns & Communication

- [how you like to work and communicate]

## Preferences

- **Units:** [metric or imperial]
- **Tools:** [tool preferences]
```
