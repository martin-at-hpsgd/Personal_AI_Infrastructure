---
provenance: template
version: 1.0.0
---

# Standing Facts

Short, always-true facts about your setup that {{DA_NAME}} should never have to
rediscover. Everything between the two HTML markers below is injected into
EVERY turn by `hooks/LoadMemory.hook.ts`, so keep it to a handful of one-line
bullets. Prose outside the markers is never injected.

Rules for the card:

- One fact per bullet, starting with `- `. Only bullet lines are read
  (`LIFEOS/TOOLS/StandingFacts.ts readFacts`).
- Name capabilities you already have, so the DA reaches for them instead of
  rebuilding or asking ("you already have Discord webhook access").
- Do not write which model the session runs on. `StandingFacts.ts check` flags
  any line that claims a carrier and disagrees with `settings.json`.
- Feed it from real misses: `bun LIFEOS/TOOLS/StandingFacts.ts candidates`
  lists recent capability incidents the card does not cover yet.

<!-- FACTS BEGIN -->
- My name is {{PRINCIPAL_FULL_NAME}}; my DA is {{DA_NAME}}.
- Secrets live in `~/.claude/.env`, in credential files under `USER/CONFIG/CREDENTIALS/`, or in the macOS Keychain where a skill's Config.md says so; skills read them from there, never from prompts.
- Pulse runs at localhost:31337; voice notifications go through its `/notify` endpoint.
- My code projects live under `~/Projects/`.
<!-- FACTS END -->
