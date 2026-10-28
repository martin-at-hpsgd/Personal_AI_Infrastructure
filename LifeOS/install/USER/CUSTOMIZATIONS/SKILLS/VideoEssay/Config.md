---
provenance: template
version: 1.0.0
---

# VideoEssay config for Alex Example

`Config.json` in this directory holds the machine settings every VideoEssay stage tool reads (through `Tools/Lib.ts` `loadSkillConfig`); this file says what they mean. Every value in both files is made up; replace each with yours. The full field table, with defaults, is `skills/VideoEssay/Setup.md` § Fill in, and `bun skills/VideoEssay/Tools/Setup.ts --check` names any missing or malformed key.

## Files

- `Config.json`: fonts, portraits, runs root, blog base URL, narrators, colours and badge copy (keys below).
- `EssayStyle.md`: the writing rules the Argue intent holds every essay to, when `Config.json` `styleFile` names it.
- `da-portrait.png`, `author.png`: the square portraits `avatar` and `presenter.avatar` name. Not shipped; add your own.

## Config.json keys

| Key | Required | Example value |
|-----|----------|---------------|
| `fonts.<face id>` | yes, every face id in `Tools/Theme.ts` `FACES` | `~/Fonts/ExampleSerif-Regular.otf` |
| `avatar` | no | `da-portrait.png` |
| `runsRoot` | no | `~/Videos/essay-runs` (outside every git repo) |
| `blogBaseUrl` | voice mode | `https://blog.example.com/posts/` |
| `possessive` | no | `their` |
| `presenter.avatar` / `label` / `badge` | voice mode / no / no | `author.png` / `ALEX` / `a` |
| `narrators.da.reader` / `badge` / `seed` / `takes` | no | `NOVA` / `b` / `100` / `2` |
| `styleFile` | no | `EssayStyle.md` |
| `fontFamilies.<face id>` | no | `Example Serif` |
| `colors` | no | `accent` `#1E3A8A`, `highlight` `#FDE68A`, `paper` `#F5F0E6`, `paperInk`, `darkInk` |
| `badge.header` / `andNot` / `struck` / `wordsLine` | no | `READ ALOUD` / `AND NOT` / `A SUMMARY` / `{LABEL}'S OWN WORDS` |
| `skipParagraphs` | no | `^[^A-Za-z0-9]*Filed under:` |
