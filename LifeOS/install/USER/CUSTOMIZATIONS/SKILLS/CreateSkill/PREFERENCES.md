---
provenance: template
version: 1.0.0
---

# CreateSkill Preferences

Optional. Read by the CreateSkill skill (`skills/CreateSkill/SKILL.md` § Data & Config) before it scaffolds or edits a skill; it is read by the model, not parsed by code. Anything left out keeps the skill's defaults.

## Versioning mechanism

How a skill's `version:` gets bumped on this install. Default: CreateSkill never bumps a version itself; the release process does. Example: "Alex Example's install bumps skill versions only through `bun <your-release-tool> --skills`, run at release; never by hand."

## Scaffolding conventions

Install-specific defaults for new skills. Example: "new private skills on this install are named with a leading underscore; every new skill gets a `Setup.md`".
