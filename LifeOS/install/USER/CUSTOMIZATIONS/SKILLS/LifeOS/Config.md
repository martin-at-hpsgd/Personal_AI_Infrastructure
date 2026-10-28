---
provenance: template
version: 1.1.0
---

# LifeOS Config

Read at run time by the `LifeOS` skill. `SKILL.md`, `INSTALL.md` and `install/install.sh` name the install host as `example.com`. Tools read the backticked start of the `Value` column, so edit that column; a key whose row is removed falls back to its default.

| Key | Value | Meaning |
|-----|-------|---------|
| `install_host` | `example.com` | The host that serves `INSTALL.md` at `/install` and `install/install.sh` at `/install.sh` |
| `spinner_verbs_file` | `spinnerVerbs.json` | Optional. A file beside this one, shaped `{ "mode": "replace", "verbs": ["Exampling", "Tinkering"] }`; when it exists, the `spinnerverbs` component deploys it instead of the shipped neutral list |
| `pulse_templates_dir` | `~/.claude/skills/LifeOS/install/USER` | Optional. The USER template tree `Tools/ScaffoldUser.ts` copies missing files from and `Tools/PulseHealth.ts audit` compares `USER/` against (an explicit `ScaffoldUser.ts --skill-root` wins). The value shown is the default, where the installer leaves the release; change it only when your templates live elsewhere, such as `~/Downloads/lifeos-release/LifeOS/install/USER` |
