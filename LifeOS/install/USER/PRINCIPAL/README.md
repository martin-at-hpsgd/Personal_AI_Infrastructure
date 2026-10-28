---
provenance: template
version: 1.0.0
---

# PRINCIPAL — who you are, for your DA

Everything in this directory describes you. Your DA loads the concise file at every session start and reaches for the rest when a task needs it. The Interview intent writes the first versions (ask your DA to run the interview); edit any file by hand afterwards, the files are yours.

| File | What it holds | Who reads it |
|---|---|---|
| `PRINCIPAL_IDENTITY.md` | The short identity reference: name, location, timezone, role, worldview, preferences, working style. Keep it concise; detail goes in the files below. | Loaded at every session start through `CLAUDE.md` |
| `PRINCIPAL_MEMORY.md` | The hot memory layer: standing rules and facts about you that must survive between sessions, one line each. | Every session; the memory system curates it |
| `RESUME.md` | Career history and credentials. | Research and writing skills, when installed, for your background |
| `WRITINGSTYLE.md` | How you write: sentence habits, words you use and avoid, rhythm. | Anything that drafts as you, once a writing skill is installed |
| `RHETORICALSTYLE.md` | The rhetorical moves you reach for, with examples from your own prose. | The Pulse user index; a writing skill when installed |
| `Quotes.txt` | Lines of your own you would stand behind, one per line. | The statusline rotates them; writing skills use them for voice matching |
| `PRONUNCIATIONS.json` | How the voice server should say names and terms; `PRONUNCIATIONS.md` explains the format. | The Pulse voice server |
| `VOICE/` | The measured model of your writing voice, built from prose you actually wrote. See its README. | A writing skill's voice gate and judge; dormant until one is installed |

Two rules. Nothing here is loaded by a public release; it is yours alone. And the identity file is the only one that must exist for the system to boot; every other file can start as the shipped template and grow.
