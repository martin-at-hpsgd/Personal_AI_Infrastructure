---
provenance: template
---

# Config — Credentials and LifeOS Configuration

This directory holds the structured config that LifeOS tools read at runtime:
credential pointers, project paths, integration settings. Treat it as the
single source of truth for "where does my stuff live and how do I authenticate."

## Files

| File | What it holds |
|------|----------------|
| `LIFEOS_CONFIG.toml` | The main config — projects directory, default temperature unit, integration toggles. |
| `anthropic-accounts.json` | Claude logins the status line and the Pulse `/usage` page report on. |
| `openai-accounts.json` | OpenAI (codex) logins the Pulse `/usage` page tracks. One `default` row for `~/.codex`; each other row logs in under `<configDirRoot>/<slug>`. |
| `overage.json` | `ceilingUsd`, your monthly cap for the emergency API lane. `0` means the built-in default. Shown on `/usage`. |

## Where credentials actually live

`LIFEOS_CONFIG.toml` itself does **not** store credentials. Secrets live in
two places:

- **`~/.claude/.env`** — environment variables (`FISH_API_KEY`,
  etc.). Pulse loads this on boot. The installer writes here when you
  complete the voice setup steps.
- **`~/.claude/LIFEOS/USER/CONFIG/CREDENTIALS/`** — credential JSON files (Google
  OAuth, AWS profiles, etc.). Create it on demand and `chmod 700` it.

`LIFEOS_CONFIG.toml` references these by path, never by value. That keeps
secrets out of any file that gets accidentally committed or shared.

## Customization

Open `LIFEOS_CONFIG.toml` and update:

- `[principal]` / `[da]` — your identity and your DA's name and voice.
- `[paths]` — where your code projects live.
- Any integration-specific blocks (`[integrations.*]`) added by skills you install.

The installer writes sensible defaults during the configuration step.
You only need to edit this file when you want to change a default or
add a new integration's settings.

## Privacy

Nothing in this directory ships in a public LifeOS release. The release
builder overlays a generic public-default scaffold; your customized
config stays on your machine.
