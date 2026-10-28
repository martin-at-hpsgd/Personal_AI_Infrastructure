# Install LifeOS

**The primary way to install LifeOS is to give this document to your AI and say "install this."**

LifeOS is AI-native, so the install is too. You hand this file (or its link) to whatever AI assistant you already use, and it does the whole install for you — on your OS, on your harness, with your permission at every step. You can also read it yourself and follow along; it's the same document either way.

---

## For you (the human) — 10 seconds

Paste this to your AI — Claude Code, Cursor, Cline, Codex, Gemini CLI, or any coding assistant that can read files and run commands:

> **Read https://ourlifeos.ai/install and install LifeOS for me.**

Prefer a terminal? There's a shell shortcut for Claude Code on macOS/Linux:

```
curl -fsSL https://ourlifeos.ai/install.sh | bash
```

It places the skill, prints the next command, and starts Claude Code on your terminal (it reads `/dev/tty`, so the pipe from curl does not matter). With no terminal to hand over, or when it runs inside an agent, it only prints the next command. On an existing install that command is the update chain, not a fresh setup.

Everything below is written for the AI doing the install.

---

## For the AI assistant

You are installing LifeOS for your human. The install is **additive**: you touch only LifeOS's own files until they say yes to an integration step. Done looks like this:

- The newest LifeOS release is on disk, and `bun Tools/DetectEnv.ts` (run from the LifeOS skill directory) has reported the OS, the harness enum (`claude-code` / `opencode` / `hermes` / `cursor` / `openclaw` / `unknown`), the config root, and whether LifeOS is already present. **Every path you use comes from that output — don't assume `~/.claude` or any single harness.**
- The fetched skill's `Intents/Setup.md` ran to its end and rolled into `Intents/Interview.md`. Setup is the one install sequence: the component menu, every consent, the `lifeos` launch command, verification and the Doctor check all live there. Do not run its tools from this page first: running `DeployCore`, `ScaffoldUser`, `LinkUser`, `InstallHooks` or `ActivateImports` here and again in Setup asks your human twice for the same change, and it runs `ActivateImports` before Setup has placed the `CLAUDE.md` it edits.
- Your human has heard, plainly, which row of the table below they got.

### Capability gate — stop here if you fail it

You need to be able to (1) read and write files on this machine, and (2) run shell commands. If you cannot do both, **stop now**, begin nothing, and tell your human:

> "I can't install LifeOS from here — I don't have file and command access on your machine. Run this from a coding harness like Claude Code, Cursor, Cline, Codex, or Gemini CLI, or use the terminal shortcut on the install page."

### Prerequisites and the release

- **bun** runs the install tools (they're TypeScript). If `bun --version` fails, install it with your human's yes and re-check:
  - macOS / Linux: `curl -fsSL https://bun.sh/install | bash`
  - Windows: `powershell -c "irm bun.sh/install.ps1 | iex"`
- **git** and a network connection, to fetch the release. (Or use a local release directory if your human already has one.)

The public repo is `github.com/danielmiessler/LifeOS` (the same `owner/name` the release stamps as the `LIFEOS_REPO` default in `install/install.sh`). The release to fetch is its newest GitHub Release, tag `vX.Y.Z`: `https://github.com/danielmiessler/LifeOS/releases/latest` redirects to `.../releases/tag/vX.Y.Z`, and the tarball is `https://github.com/danielmiessler/LifeOS/archive/refs/tags/vX.Y.Z.tar.gz` (HTTPS, no auth). The skill is the `LifeOS/` directory inside it. The simplest correct fetch is the bootstrap, which resolves that tag, pins it to its commit, prints the tarball's sha256, and backs up any prior skill to `<configRoot>/.lifeos-skill-backups/` (never inside `skills/`, where the harness would load it as a second LifeOS skill):

```
curl -fsSL https://ourlifeos.ai/install.sh | LIFEOS_NO_LAUNCH=1 bash
```

`LIFEOS_VERSION=x.y.z` forces one tag, and `LIFEOS_SRC=<dir>` installs from a local release directory with no network. Run the command it prints, then, from the LifeOS skill directory, `bun Tools/DetectEnv.ts`.

### Harness integration

- **Claude Code** — `InstallHooks.ts --apply` (Setup step 7) merges the hook set into `settings.json`, backing it up first, and `ActivateImports.ts --apply` (Setup step 8) turns on the identity imports. The hooks light up the always-on behavior: the response format, the memory loop, per-turn context injection.
- **Any other harness** — you know your own harness better than this page does, so install LifeOS into it the way it loads context, a system prompt and lifecycle hooks. What you are wiring: the system prompt `<configRoot>/LIFEOS/LIFEOS_SYSTEM_PROMPT.md`, the routing table `CLAUDE.md`, and the hook set in `install/hooks/hooks.json` (`LIFEOS/CODEX/` holds a front door already built for Codex). Write only config your harness actually reads, and tell your human plainly what you wired and what it couldn't take.

---

## What you get on each setup (be honest about this)

| Harness / OS | Skill + USER data + Pulse | Always-on behavior (response format, memory loop, context injection) |
|---|---|---|
| **Claude Code — macOS / Linux** | ✅ | ✅ full (native hooks) |
| **Claude Code — Windows** | ✅ (USER tree links as a directory junction — no admin needed) | ✅ full |
| **Cursor / Cline / Codex / Gemini / other** | ✅ | ⚠️ as much as that harness supports; your AI tells you what it wired and what it couldn't |
| **Chat-only assistants (no files / no commands)** | ❌ | ❌ — install stops at the capability gate |

Full-doctrine features additionally depend on the external tools in the capability check (codex, browser, Cloudflare, Fish Audio). Without one, the dependent feature runs degraded **and says so** — it never silently pretends. The Doctor table is the live source of truth for what's on.

## Uninstall

`bun <configRoot>/skills/LifeOS/Tools/Uninstall.ts` prints the removal plan and writes nothing; the LifeOS skill's `Intents/Uninstall.md` is the consent wrapper around `--apply`. Removal is a move into one `~/.lifeos-uninstalled-<timestamp>/` directory, never a delete. Your personal tree, your own skills and `.env` stay unless your human chooses `--purge-user`, which also moves rather than deletes.

## Rules you must follow

- **Additive, never clobbering.** Only add what's missing; never overwrite or delete a populated dir or a file you didn't create.
- **Permission before every mutation.** Show the exact change; back up `settings.json` before editing it; wait for a yes. One documented exception: the `install.sh` bootstrap, by invocation, migrates stale pre-7.x launch aliases (rc backed up first; skip with `LIFEOS_SKIP_ALIAS=1`) and appends capture rules to the config-root `.gitignore` — running the bootstrap is the consent for those two bounded setup mutations. AI-led setup steps after the bootstrap always ask. This rule governs the install itself and holds whatever they choose from the component menu; **auto mode** (off by default, asked in Setup step 7) changes how the assistant asks *after* the install, never how you install it.
- **Never write a harness's config that it won't read.** Honest degrade beats an inert install.
- **The launch command loads the constitution — don't skip it.** A plain `claude` session gets CLAUDE.md but not `LIFEOS_SYSTEM_PROMPT.md`. The `lifeos` command (`Intents/Setup.md` step 8.5), or the harness's system-prompt flag, is what turns the operating contract on. Wire it, or the install is missing its whole constitutional layer.
- **Refuse to run inside the LifeOS source repo** (detected via source-repo markers). Never mutate a maintainer's live system.
- **One install = one principal.** LifeOS is a personal system: its identity, TELOS and memory describe exactly one person. A second person (or a second account for the same person) gets a separate install — its own config root (`CLAUDE_CONFIG_DIR`) and its own personal tree (`LIFEOS_CONFIG_DIR`, default `~/.config/LIFEOS`) — never a shared one. <!-- public issue #2035, @ozymandiasscz2 -->
