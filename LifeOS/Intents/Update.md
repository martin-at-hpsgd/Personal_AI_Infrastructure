# Update — idempotent re-overlay after a version bump

Brings an existing install up to the current LifeOS version without touching the user's data. Safe to run repeatedly.

## Ideal State

- An update is one sequence, in this order: the release fetch, then `bun Tools/InstallAll.ts --yes --json`, then Doctor. An install from before 2026-10-08 whose Update step re-reads `Workflows/Update.md` reaches the same sequence through the signpost there.
- The USER-tree migrations newer than the install's from-version have run, each exactly once, before Doctor runs; a v7-era install with split TELOS files ends with one `TELOS.md` holding their content and the originals in a backup.
- An install that is behind is brought to the latest release tag, with system-owned files refreshed, identity placeholders re-rendered, nested dependencies installed, and `VERSION` written only after the completeness check passes.
- Every system-owned file that differed is backed up before it is overwritten, and the user hears which local edits to reconcile from those backups.
- The update report names each of the four evidence classes Setup step 9 requires, with its result: the identity imports resolve, hooks fire (or were skipped because this install never opted into hooks, said so), the `lifeos` launch command still points at the launcher with the system prompt, and no identity placeholder survives on the seven model-facing roots.
- An install that is current is reported "already current" from a comparison against the latest release, never against the on-disk payload.

## Anti-criteria

- Never removes user customizations, never overwrites user data, never deletes hooks the user added. The only files it overwrites are system-owned templates.
- Never rewrites or moves a USER file except through a Migrate ledger entry, and never before a backup copy of it has been written and read back; a Migrate dry run changes nothing.
- Never runs against the source repo (`isDevTree`).
- Never stops a stale LaunchAgent without the user's consent.

## Gotchas

- **Never diff the on-disk payload's version against the install marker.** The payload is what wrote the marker, so that comparison always says "already current" and the update never fetches anything (public PR #1519, @erf1nd0r). Both sides of the release check come from the distribution layer. The skill's frontmatter `version:` is the component line, never the release (SKILL.md § Gotchas), and there is no plugin manifest.
- **"Same as Setup" was read as the two obvious evidence classes**, and the substitution pass got skipped on every update. The verify step therefore names all four.

## Tool contract

1. **DetectEnv** — `bun Tools/DetectEnv.ts`. If `isDevTree`, stop: the source repo updates itself via git, not this intent.
2. **Release check** — both sides of the diff come from the distribution layer:
   - **Installed version**: read `<configRoot>/LIFEOS/VERSION` (the install marker, shipped since 7.1.1). Absent → the install predates the marker; treat it as behind and continue.
   - **Latest version**: read `tag_name` from `https://api.github.com/repos/<LIFEOS_REPO>/releases/latest` — the same endpoint the bootstrap resolves against (`LIFEOS_REPO` defaults in `install/install.sh`).
   - **Equal** → report "already current" and exit.
   - **Behind** → fetch the newer payload first: run the shipped bootstrap, `LIFEOS_NO_LAUNCH=1 bash <skillRoot>/install/install.sh` (the variable keeps it from starting a second session inside this one). It is additive — it replaces only the LifeOS skill dir and backs up the prior one under `<configRoot>/.lifeos-skill-backups/`, never inside `skills/`. It ends by printing the next command. Then re-read the new skill's `Intents/Update.md` and continue from its step 3 (steps may have changed between versions).
   - **Network unreachable** → say so and stop after re-running leg e of step 3, the only leg that works from the on-disk skill. Legs a–c all need a full fetched payload: on an installed system `<skillRoot>/install/` holds only the bootstrap files, so `OverlaySystem.ts` refuses with a `bootstrap-only` blocker, `InstallHooks.ts` fails with `payload hooks.json not found`, and `ScaffoldUser.ts` fails with `template USER not found`, until the fetch in the "Behind" branch has run. Those refusals are expected, not failures.
   <!-- public PR #2102, @hifiguy -->
3. **Run the update chain** — from the skill directory the fetch just placed, `bun Tools/InstallAll.ts --yes --json --config-root <configRoot>`. `--yes` is the one consent for the chain; without it only the plan prints. It runs legs a–f in order, restarts the core background services on the new code, stops at the first failing leg, and exits 0 only when every leg passed, each core service is loaded and Pulse answers. Every leg is idempotent: read its report in the output JSON, and retry one alone with its own `--apply` after reading its error. `--decline-services <csv>` and `--no-hooks` work as in Setup.

   a. **Re-overlay system** — refreshes system-owned files only (`Tools/SystemTrees.ts` plus `CLAUDE.md`, the system prompt, `settings.system.json`); never `USER/`, `LIFEOS/MEMORY/` or `settings.json`. Each differing file is backed up under `<configRoot>/.lifeos-overlay-backups/<run-timestamp>/<relative-path>.bak`; tell the user which local edits to reconcile from there. For each `staleServices` label, with the user's consent, run `launchctl bootout gui/$UID/<label>` and move its plist aside. Its report fields:
      - `retirements` — retired paths moved to `<configRoot>/.retired-<ts>/`, never deleted; report any `refused`.
      - `substitution` — identity re-rendered in the files the overlay wrote. `skipped: true` means raw tokens are left in the tree: fix the config before using the install.
      - `nestedDeps` — `bun install` for nested `package.json` manifests, so refreshed code has its packages.
      - `completeness` — every payload file has a counterpart. `VERSION` is written last and only on zero failures, so a partial update never claims the new version.
   b. **Re-merge hooks** — only for a Claude Code install that already carries LifeOS hook registrations: `bun Tools/InstallHooks.ts --apply`; report `pruned` and `missing`. Otherwise skip it and say hooks are not enabled for this install.
   c. **Scaffold new USER templates only** — `bun Tools/ScaffoldUser.ts --apply` adds template files new in this version and never overwrites the user's.
   d. **Schedule the statusline refresher** — `bun Tools/DeployComponents.ts --refresh-statusline --apply`; it acts only when the shipped statusline is wired. `ok: false` means the refresher is not scheduled: report it.
   e. **Re-activate imports** — `bun Tools/ActivateImports.ts --apply` for any newly-shipped identity import lines.
   f. **Migrate USER data** — `bun Tools/Migrate.ts --config-root <configRoot> --apply` runs each ledger migration newer than the install's from-version once (InstallAll records that version first with `--mark-from`). Read the `migrations` array and tell the user what changed and where its backup is (`<USER>/../.lifeos-migration-backups/`).
3b. **Moving from a backup or another machine** — an in-place update keeps USER untouched and needs no import. When the principal is restoring from a backup or moving machines, run Setup step 6b (`Tools/ImportPrevious.ts --from <dir>`, dry run, then `--apply`) before Doctor.
4. **Doctor** — `bun <configRoot>/LIFEOS/TOOLS/Doctor.ts` after the chain, never before it. It prints each capability as live, broken, declined or stale with the exact fix command for anything broken; relay that table and offer the fix. A capability the user declined is reported as declined, never as broken.
5. **Verify (four evidence classes)** — how each is checked on an update:
   - (a) **imports resolve** — load the identity `@`-imports in `CLAUDE.md` against the config tree.
   - (b) **hooks fire** — a probe session shows the mode banner / context injection.
   - (c) **launch command wired** — check the `lifeos` alias against `LIFEOS/TOOLS/lifeos.ts` and the system prompt; an overlaid CLAUDE.md and a stale alias are independent failures.
   - (d) **no identity placeholder survives** — `checkSurvivingPlaceholders` over the seven model-facing roots (`hooks/`, `commands/`, `agents/`, `LIFEOS/ALGORITHM`, `LIFEOS/LIFEOS_SYSTEM_PROMPT.md`, `CLAUDE.md`, `settings.json`), each `passed: true`. Leg a's substitution covers the files the overlay wrote; this is the gate on the result. If leg a reported `substitution.skipped`, run `bun Tools/RenderIdentity.ts --apply --strict` and require exit 0 before claiming the update is done.

### Intent-to-Flag Mapping

| Situation | `Tools/Migrate.ts` flags |
|---|---|
| Preview which migrations would run and what they would change, write nothing | (none) |
| Leg f of the update chain (InstallAll runs it) | `--config-root <configRoot> --apply` |
| Record the pre-upgrade version before the overlay rewrites `VERSION` (InstallAll runs it first) | `--mark-from <old VERSION> --apply` |
| USER data came from an older install through ImportPrevious | `--from <that install's VERSION> --apply` |
| The USER tree or template tree is somewhere non-default | `--user-dir <dir>` / `--templates <dir>` |
