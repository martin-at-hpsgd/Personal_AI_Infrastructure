# LifeOS

**Contents:** What it does · Fill in · Accounts and secrets · Prove it works

Status: `bun <configRoot>/skills/LifeOS/Tools/PulseHealth.ts audit --config-root <configRoot>` (`<configRoot>` is the config dir `DetectEnv` reports) · optional (only a distribution that serves its own installer, wants its own spinner verbs, or keeps its USER templates elsewhere needs it)

## What it does

This skill installs and onboards a user into LifeOS: it detects the OS and harness, wires hooks with permission, scaffolds the USER tree, runs the TELOS interview, checks an install (Doctor), updates or removes it, and reports bugs upstream. It runs with no set-up at all. The config below is for three cases only: you serve `INSTALL.md` and `install/install.sh` from your own host, you want your own spinner verbs deployed in place of the shipped neutral list, or your USER templates live somewhere other than the installed release, so the Pulse audit (`Tools/PulseHealth.ts audit`) should compare against them.

## Fill in

### `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/LifeOS/Config.md`

A made-up example:

```markdown
---
version: 1.0.0
---

# LifeOS Config

| Key | Value |
|-----|-------|
| `install_host` | `example.com` |
| `spinner_verbs_file` | `spinnerVerbs.json` in this directory |
| `pulse_templates_dir` | `~/Downloads/lifeos-release/LifeOS/install/USER` |
```

| Key | Required | What it is |
|-----|----------|------------|
| `install_host` | only if you distribute an installer | The host that serves `INSTALL.md` at `/install` and `install/install.sh` at `/install.sh`. `SKILL.md`, `INSTALL.md` and `install/install.sh` name the host this release is published from; substitute your host wherever you publish those files. |
| `spinner_verbs_file` | no | Names the spinner-verb file beside `Config.md`. The file name is fixed: `Tools/DeployComponents.ts --components spinnerverbs` reads `spinnerVerbs.json` from this directory when it exists and deploys it instead of the shipped neutral list. |
| `pulse_templates_dir` | no | The USER template tree `Tools/ScaffoldUser.ts` copies missing files from and `Tools/PulseHealth.ts audit` compares your `USER/` against when it lists templates with no copy. Default `<configRoot>/skills/LifeOS/install/USER`, where the bootstrap installer leaves the release; set it only when your templates live somewhere else, such as a release unpacked by hand or a source tree that builds releases. `~` expands. An explicit `ScaffoldUser.ts --skill-root` wins over it. A set value that does not exist makes ScaffoldUser exit 1 and the audit's templates check print NOT RUN, both naming this file and key. |

### `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/LifeOS/spinnerVerbs.json` (optional)

Shaped like the `spinnerVerbs` setting in Claude Code's `settings.json`:

```json
{ "mode": "replace", "verbs": ["Exampling", "Tinkering", "Pondering"] }
```

A present file with invalid JSON or no `verbs` array stops the `spinnerverbs` component with a blocker naming the file and key; it never falls back silently to the shipped list. Delete the file to go back to the shipped list.

## Accounts and secrets

None. `Tools/Report.ts` files issues, discussions and pull requests through your own `gh` login (`gh auth login`); it holds no key of its own.

## Prove it works

Check the spinner-verb file the way the deploy step will read it:

```bash
bun -e 'const f=`${process.env.CLAUDE_CONFIG_DIR ?? process.env.HOME + "/.claude"}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/LifeOS/spinnerVerbs.json`; const v=JSON.parse(await Bun.file(f).text()); if(!Array.isArray(v.verbs)) throw new Error(`${f}: no verbs array`); console.log(`ok: ${v.verbs.length} verbs, mode ${v.mode}`)'
```

Success prints `ok: <n> verbs, mode replace`. A missing file throws `ENOENT`, which is fine when you keep the shipped list.

Check Pulse, read-only (on another harness, set `root` to the config dir `DetectEnv` reports):

```bash
root="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
bun "$root/skills/LifeOS/Tools/PulseHealth.ts" audit --config-root "$root"
```

It prints one line per check (`✓` pass, `!` a template with no `USER/` copy, `✗` fail, `–` NOT RUN with the reason) and exits non-zero only when a check that ran failed. On a healthy install the last line reads `✓ service http://127.0.0.1:31337/healthz → 200`.

Check the installer host answers, reading `install_host` from your `Config.md`:

```bash
host=$(sed -n "s/^| \`install_host\` | \`\\(.*\\)\` |\$/\\1/p" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/LifeOS/Config.md")
curl -fsSI "https://$host/install.sh" | head -1
```

Success is an `HTTP/2 200` line.
