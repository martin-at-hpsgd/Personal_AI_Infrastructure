# Uninstall — manifest-keyed, reversible removal

Removes what LifeOS installed, and ONLY what LifeOS installed. The tool is `Tools/Uninstall.ts`; this intent is the consent wrapper around it. Nothing is deleted: everything removed is moved into one timestamped directory under the home directory, so the operation stays reversible until the user removes that directory themselves.

## Ideal State

- Exactly what LifeOS installed is moved into one timestamped trash directory, and the plan the user confirmed matches what the trash holds.
- The user decided the data question once, before apply, and the report names the trash path, the backups, and that deleting the trash is their own final step.
- A fresh session shows no LifeOS hook, alias or service left running.

## Anti-criteria

- Nothing is deleted; everything removed stays recoverable until the user deletes the trash directory.
- Default-keep on anything the user authored: user files, user skills, changed settings keys and `permissions.deny` stay.
- User data moves only on an explicit `--purge-user` choice, and even then it is moved, never deleted.
- Nothing is applied before the user confirmed the plan.

## Tool contract

1. **Plan (dry run, no writes)** — `bun Tools/Uninstall.ts`. It refuses a dev tree outright, and refuses when `LIFEOS/USER` or `LIFEOS/MEMORY` is a real directory or the data home sits inside the config root (only `--purge-user` may move user data). Its JSON plan names every hook entry, settings key, file, alias line and service it will move, plus `keepUserFiles`, `keepUserSkills` and `leftInPlace` for what stays.
2. **Confirm intent, and decide the data question ONCE** — show the plan in plain words: what goes, what stays (`keepUserFiles`, `keepUserSkills`, `leftInPlace`, and the data home at `<configDir>`), and the trash path. Ask now whether identity, TELOS, and memory should go too; the tool itself moves to the trash on apply, so a second run is not the default path. Wait for explicit confirmation.
3. **Apply** — `bun Tools/Uninstall.ts --apply --trash <the path the plan printed>`. On any failure the report names the failed step and the trash path.
4. **User data only on explicit request** — add `--purge-user` to the apply in step 3 when the user chose that in step 2. Even then the data home is moved into the same directory, never deleted. If they decide later, the report's `followUp` line is the exact command, run from the tool's copy in the trash.
5. **Verify** — `claude --debug` in a fresh terminal shows no LifeOS hook firing; `grep -E "LIFEOS_SYSTEM_PROMPT|lifeos\.ts"` over every rc file the plan's `alias` list named (`.zshrc`, `.bashrc`, `.bash_profile`, `.profile` by default) is empty, and the fish function `~/.config/fish/functions/lifeos.fish` is gone; `launchctl list | grep com.lifeos` (or `systemctl --user list-units | grep lifeos`) is empty; the trash directory holds what the plan said it would.
6. **Report** — the trash path and the backups, and that removing the trash directory is the user's own final step.
