# Setup — system integration (phase 1)

**Contents:** Ideal State · Anti-criteria · Tool contract · Gotchas

Wires LifeOS into the user's machine: the logistics half of setup, run before the Interview seeds anything.

## Ideal State

- LifeOS Core lands as one bundle after a single consent, and every enhancement except those the user declined by name is deployed, each idempotent and reversible.
- Every applied component is verified with the evidence its check names, and the closing report says which of the four evidence classes (the config tree resolves, hooks fire, the launch command is wired, no identity placeholder survives) were checked, which were skipped and why, and whether auto mode ended up on or off.
- Without hooks, the report says plainly that Core runs un-bannered and un-augmented; without the launch command, that Core launches un-constituted.
- The `lifeos` launch command is wired, or the user holds the one-line command to launch by hand.
- Pulse is checked: the closing report carries `Tools/PulseHealth.ts audit`'s status block with real counts, NOT RUN checks named as such.
- When the principal has an earlier install or a backup of one, its USER data, memory and keys come across through `Tools/ImportPrevious.ts`: missing files are filled, every conflict is put to the principal as a choice, no secret value is shown, and the Interview's ContextCheckin reviews what came over.
- Doctor ran once Core was placed; each broken capability was put to the user as now, later or never, and each "never" is recorded with `Doctor.ts decline <name>`, a permanent, silent off that is a legitimate way to run LifeOS.
- Setup ends by rolling into `Intents/Interview.md`.

## Anti-criteria

- Never mutates the author's source repo: `isDevTree` stops the run.
- Never clobbers a populated harness file, and nothing is installed system-wide (bun, a font, a package) without the user's yes; a missing prerequisite is a plain-language fix.
- Auto mode is never deployed on anything but a clear yes.
- Never copies an earlier install's files by hand and never overwrites a USER file during an import; which side wins a conflict is the principal's choice.
- Never claims a hooks-fire pass when hooks were not installed.

## Tool contract

Deployment is **two tiers**, and the install presents them that way:

- **LifeOS Core** (steps 4–6, 8, 8.5) — system prompt + base settings + `CLAUDE.md`/identity, the skills library and the LIFEOS runtime (Algorithm, documentation, tools, statusline, version, user-templates) deployed by `DeployCore` (step 4.5), **and the `lifeos` launch command that actually loads the system prompt** (step 8.5). This is LifeOS; it installs as one bundle after a single consent ("install LifeOS Core?"). Declining means not installing LifeOS at all.
- **Enhancements** (step 7) — hooks, statusline, tool tips, spinner verbs, agents, commands, workflows, Helm, Pulse, launchd jobs. All of them install by default, so a new install looks and works like the reference install from the first session, with placeholders where personal data goes until the Interview fills them in. The user may decline any by name. Each is independently deployable, idempotent, and reversible.

The skill ships everything for both tiers in its payload; nothing activates without the matching consent.

**Core consent text.** Show this before asking "install LifeOS Core?", in these words or your own, with every service, endpoint and pre-approval kept. The Core yes is only informed once the user has seen it. `Tools/Installer.f7.test.ts` derives the Core services (`Services.ts` rows with `optIn: false`), the Conduit sources, and the hosts in `install.sh` and `ModelSync.ts` from the code and fails when this text omits one.

> Installing LifeOS Core puts files under `~/.claude` and starts background services on this machine. This is all of it.
>
> **Background services Core starts** (macOS launchd; on Linux the ones with a systemd unit):
> - Pulse dashboard server (`com.lifeos.pulse`): serves the dashboard on `127.0.0.1:31337`, reachable only from this machine, and stays running.
> - Pulse menu-bar app (`com.lifeos.pulse-menubar`): macOS only; a menu-bar icon that shows status and opens the dashboard.
> - Pulse deriver (`com.lifeos.deriver`): once a day around 03:00 and at login, summarizes your local learning records with one inference call on your own model login.
> - Conduit (`com.lifeos.conduit`): every 120 seconds, records what you are working on. What it records is listed next.
> - Conduit insight builder (`com.lifeos.conduit.insight`): hourly, sends a short summary of what Conduit recorded to your model login and stores a one-paragraph read. It skips the call when nothing is new.
> - Model sync (`com.lifeos.modelsync`): daily at 05:10, downloads Anthropic's public model list and price table. It needs no key.
>
> **What Conduit records.** It stores everything on this machine under `LIFEOS/USER/CONDUIT/`, and keeps raw event logs for 30 days.
> - App focus: the name of the frontmost app at each poll. No window titles, no screen contents, no keystrokes.
> - Git commits: the subject line and time of new commits in the git repos you list. No repos are listed by default.
> - LifeOS sessions: the project name of each LifeOS work session, read from the local work log.
> - GitHub activity: your commits and pull request titles, read through your `gh` login. Off by default.
>
> The hourly read sends only app names with minutes, session names, commit subjects and pull request titles. It never sends file contents. Turn off any source, or all of Conduit, in `LIFEOS/USER/CONDUIT/config.json` (`enabled: false`).
>
> **Network endpoints Core contacts.**
> - `github.com`, `api.github.com`: fetching the release at install and at update.
> - `bun.sh`: only if bun is missing and you say yes to installing it.
> - `platform.claude.com`: the daily model sync.
> - Your model vendor: the hourly Conduit read and the daily deriver call go to Anthropic (Claude login) or OpenAI (Codex login), whichever CLI you signed in with.
> - `api.github.com` through `gh`: only if you turn on Conduit's GitHub source.
> - `localhost:31337`: Pulse, nothing beyond this machine.
>
> Core contacts nothing else on its own. A service that needs a key (voice, mail, calendar, Cloudflare) is named when you pick it.
>
> **Commands Core pre-approves.** Routine read, file and local git commands, listed in full under `permissions.allow` in `settings.json`. It does not pre-approve `bunx`, `bun run`, `git rm`, `git push`, `ssh`, `scp`, `rsync` or `curl`; each of those asks every time unless you turn on auto mode.
>
> You can decline any service by name. Declining Pulse means no dashboard, and it also turns off the SkillGuard and AgentGuard security checks, because they run only while Pulse is running.

**The mechanical part is one command.** Once the user has said yes to Core and to the step 7 list, run `bun Tools/InstallAll.ts --yes --json --components <the list minus their declines>` (`--decline-services <csv>` for core services they refused, `--no-hooks` if they declined hooks, `automode` in `--components` only after its own yes). Without `--yes` it prints the plan, which is the dry run to show the user. It runs steps 4–8, the first `Tools/RenderIdentity.ts --apply` pass of 9(d) and the USER-tree migrations, then installs the core background services and exits non-zero unless every one is loaded and Pulse answers `/healthz`; it is the command the release boot test runs. Read its `steps`, `services` and `error` fields for the step-9 report. What stays with you: the identity questions, step 8.5's alias, 9.5, 9.6, 10, and the strict 9(d) pass at the Interview hand-off.

1. **DetectEnv** — `bun Tools/DetectEnv.ts`. **If `isDevTree`, stop:** print the refusal and exit. **If `harness.confidence` is `"assumed"`, confirm the harness with the user before branching** — a leftover `~/.claude` must not send a non-Claude-Code install down the Claude Code path (hooks + `lifeos` alias both require the `claude` CLI).
2. **ScanConflicts** (read-only) — `bun Tools/ScanConflicts.ts`: existing hooks, skill-name collisions, a populated config tree. An existing `CLAUDE.md` is kept; merging into it is the user's decision.

### — LifeOS Core (steps 4–6, 8, 8.5; one consent) —

4–6. **Core placement** — InstallAll runs InstallSettings, DeployCore, ScaffoldUser and LinkUser; read each child report in its JSON. Facts you need when one fails:
   - `settings.json` comes only from `bun Tools/InstallSettings.ts`, never a hand copy: it expands `$HOME`/`~` in `env` values, and the harness injects env values verbatim (#1404/#1451), so a hand copy creates a real `$HOME/` junk directory at runtime.
   - LinkUser gives the USER tree and the config root local git history and never creates a remote (public issues #1897, #2036); report its `repo` and `configRepo`.
5b. **DetectInference** — `bun Tools/DetectInference.ts` (dry run), then `--apply` → writes `USER/CONFIG/inference-vendor.json` from the Claude and Codex CLI logins already on the machine. It never reads out a credential and keeps a hand-edited file. Optional keys go in with `bun LIFEOS/TOOLS/Secrets.ts set <KEY>` (no echo, 0600), never pasted into chat.
6b. **Import an earlier install (offered)** — ask once whether the principal has an earlier LifeOS install or a backup of one (DetectEnv's `existingInstall`, or the principal says so). If yes, run `bun Tools/ImportPrevious.ts --from <dir>` (dry run), show the counts, conflicts and missing key names, then `--apply`. For each conflict, offer to keep this install's file or take the old one (`destIsTemplate: true` means taking the old one loses nothing). For each name in `env.keysMissing`, run `bun LIFEOS/TOOLS/Secrets.ts set <KEY>`. Then run `bun Tools/Migrate.ts --from <the old install's VERSION> --apply` so imported v7 files are brought to the current layout, and `bun Tools/RenderIdentity.ts --apply` again so imported names render. The report's `next` ends at the Interview's ContextCheckin, which reviews the imported context.

### — Enhancements (step 7; everything by default, decline by name) —

7. **Enhancements** — install every component below by default. Tell the user in one short list what installs, and leave out only what they decline by name. Core has its own yes, given above. One yes to this list covers every enhancement on it; the user removes items by name before saying yes, because the experience they asked for is the whole one. Show the list with the network contact the defaults add beyond Core: the statusline weather segment sends the user's IP address to `ipinfo.io` and the resulting location to `open-meteo.com` (off with `preferences.statusline.weather: false` or by setting `location`), and the nerd font comes from Homebrew or `github.com/ryanoasis/nerd-fonts`. Auto mode is the exception, listed last and asked separately, because it changes how permission itself works. Two deployers back this, both `isDevTree`-refusing, idempotent, backup-before-write:

   | Component | What it deploys | Default |
   |-----------|-----------------|---------|
   | `hooks` | Algorithm nudges, memory, voice — most features need these | **default** |
   | `statusline` | `LIFEOS_StatusLine.sh` + `settings.json` `statusLine`; set `preferences.temperatureUnit` to the user's locale (payload default `celsius`); the weather segment calls ipinfo.io and open-meteo.com unless `location` is set, and `preferences.statusline.weather: false` turns both off (public issue #2151, @corobis) | **default** |
   | `tooltips` | `settings.json` `spinnerTipsOverride` — LifeOS Claude-Code tips, shipped public-clean in `install/settings.enhancements.json` | **default** |
   | `spinnerverbs` | `settings.json` `spinnerVerbs` — custom spinner verbs: a neutral list shipped in `install/settings.enhancements.json`, replaced by the user's own `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/LifeOS/spinnerVerbs.json` when that file exists | **default** |
   | `agents` | the shipped `agents/` tree (copyMissing, never overwrites) | **default** |
   | `commands` | the public slash commands (shipped in `install/commands/`, copyMissing, never overwrites) | **default** |
   | `workflows` | the public Workflow-tool scripts in `install/workflows/` (`UpgradeFanout.js`, which the Upgrade skill invokes by name; copyMissing, never overwrites — public issue #1953) | **default** |
   | `helm` | the reference terminal through `LIFEOS/DOCUMENTATION/Terminal/install.sh`: kitty + Helm config, the herdr config template (copied only when none exists), the shell layer sourced from `~/.zshrc`, Hammerspoon hotkeys when Hammerspoon is installed. Skipped, not failed, on Windows and on Linux without kitty | **default** |
   | `nerd font` | Hack Nerd Font installed, and the user's terminal set to draw with it — the statusline, the response format's section icons and the herdr sidebar are Nerd Font symbols, and without the font every one of them is a broken box | core |
   | `pulse` | the Pulse dashboard as a background service (`:31337`): `launchd` on macOS, `systemd --user` on Linux. A core service: `InstallAll.ts` installs it with the other core services unless declined | core |
   | `worksweep` / `derivedsync` | background jobs: `launchd` on macOS, `systemd --user` on Linux | **default** |
   | `automode` | `settings.json` `permissions.defaultMode: "auto"` + `skipAutoPermissionPrompt` + `skipDangerousModePermissionPrompt` — the assistant stops asking before file edits and command runs | **off unless explicitly asked for** |

   - **automode → ask separately, and default to no.** It is the only component `--all` never touches: `bun Tools/DeployComponents.ts --apply --components automode` is the only way it deploys, so it cannot ride in on "install everything". Ask once, in these words or your own, and do not sell it. This is the one source of the consent wording; `INSTALL.md`'s Rules point here:

     > There's one more thing you can turn on: **auto mode**. Right now I ask you before I edit a file or run a command. With auto mode on I stop asking — I can edit files and run commands under the roots you've configured (`~/.claude` and `~/Projects` by default) without a prompt each time.
     >
     > That's a good trade if you're one person on your own machine, running your own system. It's the wrong choice on a shared or work machine, or if you want to see each action before it happens.
     >
     > It adds no permission rule for anything that reaches off this machine, and `ssh`, `scp`, `rsync`, `curl` and `git push` stay off the allow list. It does not make them ask, though: in auto mode a classifier decides every command that is not on a list, and the shipped auto-mode settings treat `bunx`, `git`, `curl` and `wrangler` as routine in your workspace, so those can run without a prompt. What stays blocked in either mode is the deny list: force-pushes, `curl | sh`, `rm -rf` on your home or `~/.claude`, and reading `.env`. Other commands that can reach the network, such as `gh` or a script that makes a request, are not named anywhere.
     >
     > It's reversible whenever you want. `bun Tools/DeployComponents.ts --apply --components automode --revoke` puts the prompts back exactly as they are right now.
     >
     > Do you want it on? Leaving it off is the normal answer.

     **Anything other than a clear yes is a no.** Silence, "not sure", "maybe later", or a question you answered but they never came back to → leave it off and move on. The conservative settings are already in place; declining costs nothing and needs no action. Say which way it went in the step-9 report, so they know what they ended up with.

   - **nerd font → done means the user sees icons, not boxes, in the terminal they actually use.** The statusline, the response format's section marks and the herdr tab icons are Nerd Font symbols in the Private Use Area; a terminal not drawing with a Nerd Font shows each one as an empty box, and the user's first session looks broken. Installing the font is half of it: their terminal has to use it. How to get there on their OS and terminal is yours to work out, asking them where only they can act (a GUI font picker). Facts you need:
     - The font is **Hack Nerd Font**, the one the shipped Helm `kitty.conf` names, so Helm needs no further change. Use the Mono variant (`Hack Nerd Font Mono`) for other terminals; it keeps every symbol one cell wide.
     - Homebrew cask: `brew install --cask font-hack-nerd-font`. Without Homebrew, the pinned release is `https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/Hack.zip`.
     - A terminal loads fonts at launch, so an already-open window keeps showing boxes until it is restarted. If they want to keep their own font, a terminal's non-ASCII or fallback font setting pointed at the Nerd Font is enough.
     - Back up any terminal config file before you change it, and tell them what changed.
   - **hooks → `bun Tools/InstallHooks.ts --apply`** (Claude Code only; other harnesses per `INSTALL.md` § Harness integration). It backs up `settings.json`, reports `pruned` retired registrations and `missing` hook files, and never duplicates. SkillGuard and AgentGuard run only while Pulse is running.
   - **everything else → `bun Tools/DeployComponents.ts`** (dry run, then `--apply --all`, or `--components <csv>` naming what is left after a decline). Services use `launchd` on macOS and `systemd --user` on Linux and are skipped on Windows.
   - Core services the user explicitly declined (`--decline-services`) are recorded in `USER/CONFIG/services.json` so the workflow integrity check does not flag them as missing and later runs skip them. A service the user was never asked about is installed, never recorded as declined.
   - **Verify (two evidence classes)** per applied component: Pulse → `curl 127.0.0.1:31337/healthz` = 200; statusline/tooltips/spinnerverbs → re-read `settings.json` shows the key set; agents/commands/workflows → files present under `agents/` / `commands/` / `workflows/`; helm → `helm doctor` prints no `✗` line; nerd font → the font files are installed AND the user, in a restarted window of their terminal, says a line of Nerd Font symbols you print (`printf '\uf140 \uf0eb \uf071 \uf058\n'`) shows icons, not boxes (you cannot see their screen, so ask; boxes mean the terminal is not using the font yet); background jobs → `launchctl print gui/<uid>/<label>` (macOS) or `systemctl --user list-units --all` (Linux) shows the label loaded, the same check `DeployComponents.ts` `serviceLoaded()` runs; automode → re-read `settings.json` shows `permissions.defaultMode: "auto"` with both skip flags `true` if they said yes, and the mode absent with both flags `false` if they didn't.
8. **ActivateImports** — `bun Tools/ActivateImports.ts` (dry-run first, then `--apply`) → uncomment the identity `@`-imports in `CLAUDE.md`, each guarded by `existsSync` of the symlink-resolved target. Path literals stay as the canonical `@`-import form.
8.5. **Wire the launch command (Core)** — this is the step that makes LifeOS *load*. The constitutional layer — the response format, verification doctrine, security protocol, the whole operating contract — lives in `install/LIFEOS/LIFEOS_SYSTEM_PROMPT.md` and is **not** loaded by a plain `claude` session. It loads only when the harness is launched with that file appended to its system prompt. So installed LifeOS needs its own launch command; running vanilla `claude` gives you CLAUDE.md but **not** the constitution.

   The payload ships the launcher — `install/LIFEOS/TOOLS/lifeos.ts` — which spawns Claude with `--append-system-prompt-file <configRoot>/LIFEOS/LIFEOS_SYSTEM_PROMPT.md` (plus the banner and MCP-profile handling). Wire a `lifeos` command that calls it into your human's shell. **Show the exact line, back up the rc file first, wait for a yes.** Use the real `<configRoot>` from `DetectEnv` (e.g. `~/.claude`) — never hardcode a home path.

   - **Claude Code (zsh / bash)** — append to `~/.zshrc` (or `~/.bashrc`):
     ```
     alias lifeos='bun "<configRoot>/LIFEOS/TOOLS/lifeos.ts" -s "<configRoot>/LIFEOS/LIFEOS_SYSTEM_PROMPT.md"'
     ```
     fish: `alias lifeos "bun <configRoot>/LIFEOS/TOOLS/lifeos.ts -s <configRoot>/LIFEOS/LIFEOS_SYSTEM_PROMPT.md"; funcsave lifeos`. After this, **`lifeos` launches Claude with the constitution**; plain `claude` stays vanilla (which is fine — the user opts in by launching `lifeos`).

     **Upgrade path — migrate stale pre-7.x aliases.** Pre-7.x installs wired a `pai` launch alias (`cd ~/.claude && claude`, or `bun ~/.claude/PAI/ACTIONS/pai.ts`). The `PAI/` tree no longer exists and the bare-`claude` form launches without the constitution, so check the rc for these, and (with permission, rc backed up) comment them out and repoint the same alias name at the launcher above — the human's muscle-memory `pai` keeps working. `install.sh` does this automatically at bootstrap; do it here when the human ran setup without the bootstrap script. Never touch an alias containing `LIFEOS_SYSTEM_PROMPT` (current) or `WORKFLOWS/Actions/lifeos.ts` (the maintainer-side Workflows action CLI alias — that tree does not ship in the public payload, so if the string appears in an rc, leave it alone).

   - **Any other harness** — load the same file the way that harness takes a system prompt. If it has no way, load it as context and tell your human plainly that the constitution is loading as context, not as a system prompt.

   If your human declines the shell edit, give them the one-line launch command to run by hand so the constitution still loads:
   ```
   bun <configRoot>/LIFEOS/TOOLS/lifeos.ts -s <configRoot>/LIFEOS/LIFEOS_SYSTEM_PROMPT.md
   ```
8.6. **Pulse health** — `bun Tools/PulseHealth.ts audit` (read-only; `--json`). Its status block goes in the step-9 report, with any `–` NOT RUN check reported as not run. A user who rewrites a template copy marks it with `LIFEOS/PULSE/Tools/MarkCustomized.ts`.
9. **Verify (four evidence classes)** — (a) the config tree resolves (the identity `@`-imports load), always checked because it is Core; (b) if the user opted into `hooks`, a probe session shows the mode banner / context injection fire. If hooks were declined, skip (b) and say why it matters: the mode banner and the memory/voice loop are hook-enforced, so recommend hooks unless there is a reason to decline; (c) the **launch command is wired**: grep the shell rc for the `lifeos` alias, or confirm the user was handed the manual one-line launch.

   (d) **No identity placeholder survives.** `Tools/RenderIdentity.ts` is the one tool; never call `substituteTree` by hand (a bare `HOME` key once rewrote every `HOME` substring across 146 `.ts` files, public issue #1484, @docxology).

   - **Two passes, by design.** InstallAll's `--apply` pass fills what `LIFEOS_CONFIG.toml` already knows and leaves the scaffold names (`Aria`, `Your Name`) `pending`, because a rendered token is gone. The Interview hand-off's `--apply --strict` run is the gate, over the same seven surfaces Doctor's `identity-placeholders` probe checks.
   - On exit 1, read `error`, `next` and `survivors`, fix the config value named, and re-run; if survivors persist, say so rather than closing the install.
9.5. **Offer the Hermes sidecar (optional, never assumed)** — ask once, plainly: *"Want to install Hermes too, so you can talk to your LifeOS as an agent?"* It is a second front door onto this same install, not a second assistant; declining costs nothing and LifeOS never depends on it. If they accept, follow `References/HermesSidecar.md`: the pinned install, its own login, the evidence-based guard check, and the two things to tell them plainly.
9.6. **Doctor** — `bun <configRoot>/LIFEOS/TOOLS/Doctor.ts` (before or after the Interview). Relay its table; for each ❌ ask now, later or never. Now → run the fix it names and re-run (with permission, `--network` checks auth for capabilities already configured). Later → leave it; the runtime names it when a degraded capability is used. Never → `Doctor.ts decline <name>`. Declining `codex` disables cross-vendor audits and the MAX lane. `GETTING-STARTED.md` walks each tool for the human.
10. **Transition** — print: "Setup complete. Now let's get you into LifeOS —" and roll into `Intents/Interview.md`.

### Intent-to-Flag Mapping

| Situation | `Tools/RenderIdentity.ts` flags |
|---|---|
| ImportPrevious brought names in (6b) | `--apply` |
| Install lives somewhere other than `$CLAUDE_CONFIG_DIR` / `~/.claude` | `--config-root <dir>` |

| Situation | `Tools/ImportPrevious.ts` flags |
|---|---|
| Preview what an earlier install or backup would bring over, write nothing | `--from <dir>` |
| Copy the missing files once the principal has seen the preview | `--from <dir> --apply` |
| Read the report as data (counts, conflicts, missing key names, `next`) | add `--json` |
| Install lives somewhere other than `$CLAUDE_CONFIG_DIR` / `~/.claude` | `--config-root <dir>` |

| Situation | `Tools/Migrate.ts` flags |
|---|---|
| USER data was brought over from an earlier install (ImportPrevious), so its older shape needs migrating | `--from <that install's VERSION> --apply` |
| Preview those migrations first, write nothing | `--from <that install's VERSION>` |

| Situation | `Tools/DetectInference.ts` flags |
|---|---|
| Show which logins were found and the file it would write | (none) |
| Write `inference-vendor.json` from the logins found | `--apply` |
| Replace a hand-edited `inference-vendor.json` | `--apply --force` |

## Gotchas

- **Restoring a deleted page source is ScaffoldUser's job.** `Tools/ScaffoldUser.ts --apply` copies every missing file from the USER template tree and never overwrites one that exists, which covers what the retired standalone Pulse-setup Scaffold did (2026-10-13). The tree is `--skill-root <release>/LifeOS` when passed, else `pulse_templates_dir` in the skill's USER `Config.md`, else the shipped `install/USER/`; `PulseHealth.ts audit` compares against the same configured tree when it lists templates with no `USER/` copy.
- **`ActivateImports` fails until `CLAUDE.md` exists** (`{"ok":false,"error":"CLAUDE.md not found at ..."}`). `InstallSettings` places it in step 4, so step 8 is safe in this order; running `ActivateImports` ahead of Setup, as the old `INSTALL.md` sequence did, hit this (public discussion #1900 finding 3, @Patrickraveaux).
