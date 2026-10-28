---
version: 1.0.2
---

# Core config (settings, rules and small switches)

Status: `bun LIFEOS/TOOLS/LifeosConfig.ts` · required

## What it does

Core config is the set of files in `LIFEOS/USER/CONFIG/` that every other system reads to learn how your install is set up. The two that must be right are `LIFEOS_CONFIG.toml`, which holds your name, timezone, your assistant's name and voice, and where your folders live, and `OPERATIONAL_PREFERENCES.md`, your own working rules, which the assistant reads at the start of every session. The system's general rules ship with LifeOS; this file is where your preferences go.

Several small files sit beside them. Most do nothing until you choose to change them, and each ships in a safe "not configured" state:

| File | What it is |
|---|---|
| `STANDING_FACTS.md` | A few one-line facts that are added to every turn, such as capabilities you already have, so the assistant stops rediscovering them. |
| `settings.user.json` | Your overlay on the harness settings. Shipped as `{}`, which changes nothing. |
| `notifications.json` | The most unrequested interruptions per day you will accept. Shipped at 12, which is also the built-in default. |
| `delivery-roots.json` | The folders where finished files land, watched by the output reconciler. Shipped as Downloads, Desktop, Documents and iCloud Drive. |
| `deploy-registration-gate.json` | Optional checks run after you deploy a site. Shipped empty, which skips them. |
| `LocalPatches.json` | A list of edits you keep on shipped files. Shipped empty, because most installs never need one. |

`README.md` and `FILES.md` in the same folder describe the rest of the folder, file by file.

## Fill in

The interview writes the first version of `LIFEOS_CONFIG.toml` (see Identity.md): ask your DA to run the LifeOS interview, or type `/LifeOS interview`. By hand, the sections are:

| Section | Keys |
|---|---|
| `[principal]` | `name` and `timezone` are required. `pronunciation`, `hometown` and `currency` (a code such as `USD` or `EUR`) are optional. |
| `[da]` | `name` is required. `full_name`, `display_name` and `color` are optional. |
| `[da.voices.main]` | `fish_reference_id` (the Fish Audio voice model id) is the one voice setting that matters. `voice_id` is an optional marker Fish resolvers use to recognize the voice. `fish_speed` tunes the pace; `voice_name` and `volume` are optional. See Voice.md. |
| `[integrations.*]` | One table per integration. The Cloudflare table names the environment variable that holds the token. |
| `[paths]` | `user_dir` and `projects_dir`, where your files and code projects live. The defaults are `~/.claude/LIFEOS/USER` and `~/Projects`. |

Entries in `OPERATIONAL_PREFERENCES.md` are short bullets under headings such as tool preferences, repo conventions, deployment and one heading per domain you work in. It is one file that loads every session. A preference says what you want and belongs there; a step that says how belongs only as a safety gate, a tool contract or a verified gotcha, and gotchas go under § Gotchas. Write an entry when you catch yourself correcting the assistant twice. The history behind an entry lives in git.

For settings, do not edit the generated `~/.claude/settings.json`. At the start of each session LifeOS rebuilds it from `settings.system.json` plus your `settings.user.json`, and your overlay wins any conflict. The merge rules, from `LIFEOS/TOOLS/MergeSettings.ts`: objects merge key by key, a plain value or array in your overlay replaces the system one, `{ "__merge": "append", "values": [...] }` adds to an array, and `{ "__merge": "remove" }` drops a key. For example, this adds one permission and keeps the system list:

```json
{ "permissions": { "allow": { "__merge": "append", "values": ["Bash(bun test:*)"] } } }
```

The overlay is read only from `LIFEOS/USER/CONFIG/settings.user.json`; a copy placed at the top of `~/.claude` is ignored.

For the small switches, change a value only if you want to. In `notifications.json`, lower `interruptions_per_day` to be interrupted less. In `delivery-roots.json`, edit the `roots` list; a file that parses replaces the built-in list, and deleting the file restores it. In `deploy-registration-gate.json`, fill in `project` and `files` only if you keep an analytics registry file in a repo, and list a `{prefix, reason}` pair under `workersDevExempt` for any workers.dev-only worker that needs no registration. Each file's `_docs` line says exactly what its code reads.

## Accounts and secrets

Nothing in this folder holds a secret. Tokens and API keys live in `~/.claude/.env`, and the config names the variable, never the value. Check that a key exists without printing it:

```bash
bun LIFEOS/TOOLS/Secrets.ts has CLOUDFLARE_API_TOKEN   # prints "CLOUDFLARE_API_TOKEN yes" or "... no"
bun LIFEOS/TOOLS/Secrets.ts keys                       # lists the names stored, never values
```

The plaintext `.env` stays on your machine and out of git. If you keep `~/.claude` in git and want an encrypted copy of `.env` to travel with it, `bun LIFEOS/TOOLS/Secrets.ts init` creates the key in your macOS login Keychain and `bun LIFEOS/TOOLS/Secrets.ts seal` writes the encrypted copy; run `seal` again after each change to `.env`, and `Secrets.ts status` says whether the copy is current. Credential files for Google and similar services go in `CONFIG/CREDENTIALS/`, which you create with owner-only permissions when you need it.

## Prove it works

```bash
bun LIFEOS/TOOLS/LifeosConfig.ts     # prints the resolved config as JSON; exit 0 means it is valid, exit 1 prints what is wrong
bun LIFEOS/TOOLS/MergeSettings.ts --system ~/.claude/settings.system.json --user ~/.claude/LIFEOS/USER/CONFIG/settings.user.json --check ~/.claude/settings.json
bun LIFEOS/TOOLS/StandingFacts.ts check    # confirms the standing-facts card agrees with your settings
```

The first command must exit 0, and the names it prints should be yours. The second reports "no differences" when `settings.json` matches what the merge would produce from your two settings files; it only compares and writes nothing. If the printed config still shows "Your Name" or "Aria", the interview has not run yet.
