# Phase0Setup — first-run install bootstrap

A fresh or never-finished LifeOS install configured end to end through six setup targets (DA identity, Principal identity, voice IDs, credentials, first project, work repo) and a walk of every other shipped system, then handed to **ContextCheckin**. This is the one onboarding interview: the installer's `skills/LifeOS/Intents/Interview.md` hands off here and asks nothing itself.

A fresh install ships with the scaffold identity (`Aria` / `Your Name` in `LIFEOS_CONFIG.toml`), a generic voice ID, an empty `.env`, a sample-row PROJECTS table, and no `USER/WORK/work_repo.json`, so `WORK.REPO` points nowhere. Until Phase 0 runs, Pulse boots with the wrong DA name, identity placeholders stay unrendered in hooks and the system prompt, the voice server uses the public default voice, and the work pipeline crashes on the missing repo.

## Ideal State

- Phase 0 runs only when the scanner shows a Phase 0 target below 80% complete; when every target reads 80% or more, the intent is skipped for ContextCheckin.
- Each setup target in the Output format table is handled one question at a time: a target still on its bootstrap default is filled, a populated one is read back with "still right?", and a target the principal skips stays skipped.
- Each answer lands in the one file the table names for its target, so Pulse boots with the principal's DA name, identity, voice, credentials, first project and work repo (or the work pipeline explicitly disabled).
- DA and principal identity and every voice choice live only in `LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml`, the canonical store `hooks/lib/identity.ts` reads first; Pulse choices live only in the user tier `LIFEOS/USER/CONFIG/PULSE.user.toml`.
- Every system the release ships is covered: after the six targets, the system walk (0.7) goes through each system `SetupInventory.ts status` reports as `needs-setup` or `optional-off`, one at a time, with its setup guide, so nothing the installer laid down stays a placeholder unless the principal chose to leave it. The list comes from the shipped code through the setup manifest, never a list kept here, so a new system is covered the release it ships.
- By the handoff to ContextCheckin, the installed tree carries the real names (`skills/LifeOS/Tools/RenderIdentity.ts --apply --strict` exited 0), PRINCIPAL_TELOS.md was regenerated after the last target (it interpolates the principal name), and the Pulse freshness cache was invalidated.

## Anti-criteria

- No credential is echoed back in voice or text: capture is confirmed by key name only ("captured FISH_API_KEY"). Keys are entered with `bun LIFEOS/TOOLS/Secrets.ts set <KEY>` (no echo, 0600); a key pasted in chat anyway is stored the same way at once, with a request to clear it from scrollback.
- No identity or voice value is written to `DA_IDENTITY.md` or `PRINCIPAL_IDENTITY.md` frontmatter, `settings.json`, or the system-owned `LIFEOS/PULSE/PULSE.toml` (every update overwrites it, so neither its `[voice]` block nor a `[work] enabled = false` line there survives an update); those files take prose only, and the names in them arrive by rendering.
- No field the scanner scores as filled is asked about again, and no TELOS section is prompted here; that is ContextCheckin's job.
- No turn dumps several setup prompts at once.

## Tool contract

```bash
bun <configRoot>/LIFEOS/TOOLS/InterviewScan.ts --json   # the targets with phase == 0
```

After the identity and voice targets land in `LIFEOS_CONFIG.toml`, render them into the installed tree; exit 0 is the pass, and on exit 1 the report's `pending`, `error` and `next` name what is still missing:

```bash
bun <configRoot>/skills/LifeOS/Tools/RenderIdentity.ts --apply --strict
```

The system walk (0.7) reads the setup status of every shipped system; `--probe` also runs each system's own check:

```bash
bun <configRoot>/LIFEOS/TOOLS/SetupInventory.ts status --probe --json
```

```bash
bun <configRoot>/LIFEOS/TOOLS/GenerateTelosSummary.ts 2>/dev/null || true
curl -s -m 5 -X POST http://localhost:31337/api/freshness/invalidate > /dev/null 2>&1 || true
```

## Output format

### Setup targets

Each target writes to one file. Voice-confirms only on actual writes. The whole phase is skip-able if the principal already knows what they want and types it directly.

| # | Target | Files written | Skip-when |
|---|--------|---------------|-----------|
| 0.1 | **DA Identity** — name, full name, display name, color | `LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml` `[da]` (`name`, `full_name`, `display_name`, `color`); role and personality prose, if offered, go in the body of `USER/DIGITAL_ASSISTANT/DA_IDENTITY.md` | `[da] name` is no longer the scaffold `Aria` |
| 0.2 | **Principal Identity** — name (with pronunciation), timezone, hometown | `LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml` `[principal]` (`name`, `full_name`, `pronunciation`, `timezone`, `hometown`); role and focus prose, if offered, go in the Quick Reference body of `USER/PRINCIPAL/PRINCIPAL_IDENTITY.md` | `[principal] name` is no longer the scaffold `Your Name` |
| 0.3 | **Voice** — main DA voice: a Fish voice model, or voice off for now | `LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml` `[da.voices.main]` (`fish_reference_id`) | `fish_reference_id` is no longer the scaffold placeholder `YOUR_FISH_REFERENCE_ID` |
| 0.4 | **Inference and credentials** — inference needs no API key: `bun skills/LifeOS/Tools/DetectInference.ts --apply` finds the Claude and Codex logins already on the machine and writes the vendor file from them (no login found: name the login to run, `claude` or `codex login`). Optional keys, each skippable: FISH_API_KEY (voice), GH_TOKEN, STRIPE_KEY, each stored with `bun LIFEOS/TOOLS/Secrets.ts set <KEY>`, which reads it with echo off | `LIFEOS/USER/CONFIG/inference-vendor.json`; optional keys in `~/.claude/.env` (or `~/.config/LIFEOS/.env` symlink target) at mode 0600 | `inference-vendor.json` was written by DetectInference (`_source` is `DetectInference`) or edited by hand, and every optional key the user wanted reads `yes` on `bun LIFEOS/TOOLS/Secrets.ts has <KEY>` |
| 0.5 | **First project** — at least one row so PROJECTS routing works | `USER/PROJECTS.md` table + Routing Aliases | PROJECTS.md has ≥1 non-sample row |
| 0.6 | **Work repo** — private GitHub repo for issues OR explicit "skip + disable work pipeline" | `USER/WORK/work_repo.json` as `{"repo":"<owner/repo>"}` (the source of `WORK.REPO`; `hooks/lib/work-config.ts` verifies the repo is private with `gh` and writes the `privacy` block itself); or `work = false` under `[modules]` in `LIFEOS/USER/CONFIG/PULSE.user.toml` (the user tier wins over the shipped `[work] enabled` flag) | USER/WORK/work_repo.json `repo` points at an existing private repo |
| 0.7 | **Every other system** — walk the status report: for each system not `ready`, say what it does in one line (the manifest `summary`), then set it up from its guide, skip it, or leave it for later. Systems the principal skips are left `optional-off`, never nagged in the same session | whatever the system's guide names | `SetupInventory.ts status` shows `0 need setup` and every `optional and off` system was offered once |

Every TOML write edits only the named key in the named section, keeps the rest of the file byte for byte, and creates `PULSE.user.toml` from the release template when it is absent.

### Prompts

Opening, after the scan, names the six steps, the rough time, and the option to skip straight to TELOS:

> "Looks like a fresh setup — Phase 0 hasn't run. I'll walk through six setup steps that get Pulse working end-to-end: identity, voice, credentials, projects, work repo. Then we go through the other systems one at a time, and you can skip any. Roughly 5 minutes for the six, longer if you set up the rest now. Want to start, or skip Phase 0 and pick up at TELOS?"

Voice (0.3), when the principal has no specific voice in mind:

> "Want to pick a voice now — a Fish voice model — or leave voice off for now? You can change it later in LIFEOS_CONFIG.toml."

Transition:

> "Phase 0 done — Pulse is now configured with your identity. Moving to TELOS check-in, or break here?"
