# Interview — hand-off to the Interview skill (phase 2)

Runs after Setup: hands onboarding to the Interview skill (`skills/Interview`, invoked as `Skill("Interview")`), then renders the captured identity and seeds Pulse. It asks no question of its own.

## Ideal State

- The Interview skill ran: its Phase0Setup captured the DA name and voice and the principal identity (`[principal]`, `da.name`, optional `da.full_name`/`display_name`/`color`, `da.voices.main.fish_reference_id`) into `CONFIG/LIFEOS_CONFIG.toml`, and its ContextCheckin captured TELOS current state and ideal state in `TELOS/TELOS.md`, with any external material the user handed over merged in.
- `bun Tools/RenderIdentity.ts --apply --strict` exits 0 after the interview: the real names, not the scaffold's `Aria` / `Your Name`, are rendered, and no identity placeholder survives on the surfaces Doctor checks.
- Pulse renders the user's real rings and state on first open, from `Tools/SeedPulse.ts --apply` (which writes `LIFEOS_STATE.json` and regenerates `PRINCIPAL_TELOS.md`).
- The close names what landed (DA name, identity, N goals, current and ideal captured), points at Pulse (`localhost:31337`), and says the interview can be re-run any time to go deeper.

## Anti-criteria

- This intent asks the user nothing; every onboarding question belongs to the Interview skill, so there is one interview and one set of answers.
- Identity and voice land only in `LIFEOS_CONFIG.toml`: never in `PRINCIPAL/PRINCIPAL_IDENTITY.md` or `DA_IDENTITY.md` frontmatter, `settings.json`, or the system-owned `PULSE.toml`.
- Never clobbers an answer the user already gave, and never writes a merged external source without confirming first.
- Never touches system files. RenderIdentity fills placeholders only and never enters the redistribution payload.
- Never seeds before Setup has run.

## Tool contract

The order matters: RenderIdentity needs the names the interview captures, and SeedPulse reads what both wrote.

1. **Confirm Setup ran** — the config tree exists (`LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml` is present, every write `existsSync`-guarded). Straight after `setup`, continue the same conversation; invoked standalone (`/LifeOS interview`), check this before anything else.
2. **Hand off** — invoke `Skill("Interview")`. Its routing probe sends a fresh install to Phase0Setup, then ContextCheckin. The user can say `skip` to any item and `done` to stop early; partial onboarding is valid (Pulse shows what it has).
3. **Render identity** — `bun Tools/RenderIdentity.ts --apply --strict` from the skill root. Exit 0 is the pass. On exit 1, read the report's `error` and `next`: `pending` names mean the interview did not capture them (go back to Phase0Setup's identity targets), and `survivors` names each surviving placeholder and its file.
4. **SeedPulse** — `bun Tools/SeedPulse.ts` (dry-run first, then `--apply`).

### Intent-to-Flag Mapping

| Situation | Flags |
|---|---|
| Preview what would be filled, write nothing | (none) or `--dry-run` |
| After the interview captured real names (the hand-off's run) | `--apply --strict` |
| Install lives somewhere other than `$CLAUDE_CONFIG_DIR` / `~/.claude` | `--config-root <dir>` |
| Identity kept in a different LIFEOS_CONFIG.toml | `--config <file>` |
