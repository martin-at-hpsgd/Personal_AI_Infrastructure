# InstallAll

One command that brings LifeOS up on this machine: the mechanical half of Setup on a fresh install, or of Update on an existing one, ending with the core background services loaded and Pulse answering on `:31337`.

```
bun Tools/InstallAll.ts                 # plan only: lists every step, changes nothing
bun Tools/InstallAll.ts --yes           # the single consent: run the whole chain
bun Tools/InstallAll.ts --yes --json    # same, one JSON report on stdout
bun Tools/InstallAll.ts --apply         # same as --yes
```

| Flag | Meaning |
|---|---|
| `--yes` | Run the chain. Without it (or `--apply`) nothing is written, and the plan reports `ok: false` with a `next` field, because nothing was installed. |
| `--apply` | Same as `--yes`; every sibling tool takes `--apply`. |
| `--json` | Print the full report as JSON (steps, each child's own report, services, retirements). |
| `--components <csv>` | Enhancements for `DeployComponents` (default: the documented set in Setup.md step 7). `automode` deploys only when named here. |
| `--decline-services <csv>` | Core services the user said no to; skipped now and recorded in `USER/CONFIG/services.json` so later runs skip them too. |
| `--no-hooks` | Skip `InstallHooks` (a harness without hooks, or the user declined them). |
| `--mode fresh\|upgrade` | Force the chain. Default: upgrade when `LIFEOS/VERSION`, `settings.json` and `LIFEOS/USER` exist. |
| `--config-root <dir>` | Install target (default `$CLAUDE_CONFIG_DIR`, else `~/.claude`). |
| `--skill-root <dir>` | The LifeOS skill whose tools run (default: this skill). |
| `--allow-dev` | Passed through to every tool; never use it on a real install. |

**Fresh chain:** InstallSettings → DeployCore → ScaffoldUser → LinkUser → InstallHooks → DeployComponents → ActivateImports → RenderIdentity → Migrate → core services.

**Upgrade chain:** Migrate --mark-from (records the old VERSION before the overlay rewrites it) → OverlaySystem → InstallHooks (only where hooks are already wired) → ScaffoldUser → LinkUser (links a real `LIFEOS/MEMORY` left by an older install; a no-op once both links hold) → statusline refresher → DeployComponents (only with `--components`) → ActivateImports → RenderIdentity → Migrate → core services, which restarts Pulse on the new code.

**Core services** are the `Services.ts` registry rows with `optIn: false` (Pulse, the menu-bar app, the deriver, Conduit and its insight builder, model sync; People where its adapter exists), installed with `Services.ts install --yes`. After the install every targeted label must be loaded and Pulse's `/healthz` must answer 200; otherwise the run fails and names the service.

**Migrate** runs the USER-tree migrations newer than the version this install came from, each once, backing up every file it replaces or moves (`Tools/Migrate.help.md`). It is a no-op on a fresh tree.

**RenderIdentity** fills what `LIFEOS_CONFIG.toml` already knows (version, time zone, voice) and leaves the scaffold names (`Aria`, `Your Name`) as tokens. The Interview hand-off runs `Tools/RenderIdentity.ts --apply --strict` again once the real names are captured.

Exit 0 only when every step passed and every core service is up; a plan exits 1. It stops at the first failing step. Every step is idempotent, so a second run is safe and changes nothing. The TELOS interview and the `lifeos` launch alias stay in the agentic Setup (`Intents/Setup.md`).
