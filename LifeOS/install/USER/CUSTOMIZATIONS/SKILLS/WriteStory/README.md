---
provenance: template
version: 1.0.0
---

# WriteStory — USER customizations

Declared in `skills/WriteStory/SKILL.md` lines 101-108. Everything personal to your fiction lives here; the skill tree holds frameworks only. No tool parses any of it; intents read these files as prose.

| Path | Read by | Shipped as |
|------|---------|------------|
| `PREFERENCES.md` | `SKILL.md` line 107 (default genre, aesthetic, voice); `Intents/WriteChapter.md` line 10 via `AestheticProfiles.md` | template |
| `projects/<book-slug>/` | every intent; see `projects/README.md` for the two files each book keeps | `README.md` only |
