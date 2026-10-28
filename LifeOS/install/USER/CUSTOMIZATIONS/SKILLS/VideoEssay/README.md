---
provenance: template
version: 1.0.0
---

# VideoEssay private data

Files the `VideoEssay` skill reads from this directory. Every value here is made up; replace each with yours. Field-by-field setup: `skills/VideoEssay/Setup.md` § Fill in.

| File | Read by | Shape |
|------|---------|-------|
| `Config.md` | the person filling this in | what each `Config.json` key means, with example values |
| `Config.json` | every stage tool through `Tools/Lib.ts` `loadSkillConfig` | fonts (one file per face id; absolute, `~/`, or relative to this directory), portraits, runs root, blog base URL, narrators, colours, badge copy |
| `EssayStyle.md` | the Argue intent, when `Config.json` `styleFile` names it | a Markdown list of the writing rules every essay is held to |
| `da-portrait.png`, `author.png` | the presence badge | square portraits, named by `avatar` and `presenter.avatar`; not shipped, add your own |
