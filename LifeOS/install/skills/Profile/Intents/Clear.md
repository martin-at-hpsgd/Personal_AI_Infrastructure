# Clear

Reset the user's profile to the blank template, with confirmation and a backup. The file is never deleted: CLAUDE.md @-imports it at every startup.

## Ideal State

- Afterward `~/.claude/LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md` still exists with its contents replaced by the blank template from `Edit.md`, its frontmatter carrying `last_updated` set to now, `last_updated_by` set to the DA's name, `convention: lifeos-freshness-v1`, the header-fact keys present as blank placeholders, and no `last_reviewed` or `last_reviewed_by`, so the freshness grade shows the file as unreviewed.
- A backup at `~/Downloads/PRINCIPAL_IDENTITY.<timestamp>.md` existed and was verified non-empty before the file was overwritten.
- The user gave explicit confirmation to the reset prompt before anything was written.
- The closing message names the backup path, how to rebuild the profile (Edit intent or Interview skill) and both ways to restore the old one (copy the backup over the file, or a git checkout when the USER tree is a git repo and its previous state was committed).
- When the file does not exist, the user gets the no-profile-to-clear message and no reset runs.
- The confirmation prompt and the closing message both say that `LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml` `[principal]` (name, pronunciation, timezone) is left as it is and still wins over the frontmatter, so the user never believes those were reset.

## Anti-criteria

- Never edits `LIFEOS_CONFIG.toml`: its `[principal]` table requires a non-empty name and timezone (`LIFEOS/TOOLS/LifeosConfig.ts` throws otherwise), so blanking it would break every identity read. Changing those values is the Edit intent's job.
- Never deletes the file: startup imports it, so only its contents are replaced.
- Never resets without explicit confirmation.
- Never overwrites the file when the backup does not exist or is empty.

## Safety gates

The confirmation prompt, shown when the file exists:

```
This will erase the contents of ~/.claude/LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md and replace them with a blank template.
Future sessions load a blank profile until it is rebuilt. Your name, pronunciation
and timezone in LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml [principal] are not touched
and still win; change them with the Edit intent.
A backup is written to ~/Downloads first.

Confirm? (yes/no)
```

## Tool contract

The backup, taken on confirmation and checked non-empty before the template overwrite (Edit tool):

```bash
cp ~/.claude/LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md ~/Downloads/PRINCIPAL_IDENTITY.$(date -u +%Y%m%dT%H%M%SZ).md
```

## Output format

When the file does not exist:

```
No profile to clear — PRINCIPAL_IDENTITY.md doesn't exist.
```

After the reset:

```
Profile reset to the blank template. Backup: ~/Downloads/PRINCIPAL_IDENTITY.<timestamp>.md
Name, pronunciation and timezone in LIFEOS_CONFIG.toml [principal] were not changed; use the Edit intent for those.
Rebuild it with the Edit intent or the Interview skill. Restore the old one by copying the backup over the file, or, if your USER tree is a git repo and the previous state was committed, with `git -C ~/.config/LIFEOS/USER checkout -- PRINCIPAL/PRINCIPAL_IDENTITY.md`.
```

## Gotchas

- The file lives in the USER tree (`~/.config/LIFEOS/USER` in a standard install, reached through the `LIFEOS/USER` symlink). Git recovery applies only if your USER tree is a git repo, and only to committed state; the closing message offers the git route only when `git -C ~/.config/LIFEOS/USER rev-parse` succeeds. The ~/Downloads backup covers everything else.
