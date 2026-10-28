# Backup

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Output format

A timestamped local backup of the current dotfiles, created without pushing to GitHub.

## Ideal State

- A new timestamped directory `$DOTFILES_BACKUPS/<YYYYMMDD_HHMMSS>` exists, holding `~/.zshrc` (when present) and each directory named in `DOTFILES_CONFIG_DIRS` that exists under `~/.config`, not the entire `.config`.
- No secret file is in the backup: every `.config` copy excludes `.env`, `.env.*`, `*.oauth`, `*oauth*.json`, `*token*.json`, `client_secret*.json`, `credentials*` and `auth.json`.
- The backup holds a `BACKUP_INFO.txt` with its creation date, timestamp, hostname, the files included, and how to restore it: the rollback recipe in SKILL.md § Tool contract, which backs up the current files and asks before overwriting.
- The backup location, its contents, its total size and how to restore it are reported, and all available backups in `$DOTFILES_BACKUPS` are listed.
- The backup is local only and standalone from the Git repository: nothing is synced to GitHub, and no original file is modified.

## Anti-criteria

- Never pushes or syncs anything to GitHub; that is the Push intent.
- Never modifies the original `~/.zshrc` or `~/.config` files.
- Never backs up the whole config directory: a wider backup uses the dotfiles repo's tracked list (`git -C "$DOTFILES_DIR" ls-files .config`), never the whole directory.

## Inputs

The config keys: run the Config command in SKILL.md § Data & Config first; it stops the intent when `Config.md` or a key is missing.

## Tool contract

### 1. Copy the files

Run the Backup copy from SKILL.md § Tool contract. It sets `$timestamp` and `$backup_dir`.

### 2. Create Backup Metadata

```bash
cat > "$backup_dir/BACKUP_INFO.txt" << EOF
Dotfiles Backup
===============

Created: $(date)
Timestamp: $timestamp
Hostname: $(hostname)

Files Included:
- .zshrc ($(wc -l ~/.zshrc 2>/dev/null | awk '{print $1}' || echo '0') lines)
- .config/ (selective key directories)

Restore Instructions:
---------------------
Roll back with the Dotfiles skill's "Restore from a backup" recipe
(SKILL.md § Tool contract), using this backup:
  backup=$backup_dir
It backs up the current files first and asks before overwriting.
Afterwards, run exec zsh in your own terminal.

Notes:
------
This is a LOCAL backup only. Not pushed to GitHub.
EOF
```

### 3. Show Backup Summary

How to restore is reported by printing `BACKUP_INFO.txt`, which points at the one rollback recipe:

```bash
echo "Location: $backup_dir"
ls -lh "$backup_dir"
echo "Total size: $(du -sh "$backup_dir" | awk '{print $1}')"
cat "$backup_dir/BACKUP_INFO.txt"
```

### 4. List All Backups

```bash
ls -lhd "$DOTFILES_BACKUPS"/*/
```

### Wider backup — the repo's tracked list, never the whole directory

```bash
# Every config the dotfiles repo tracks, and nothing else
git -C "$DOTFILES_DIR" ls-files .config | sed 's|^\.config/||' > "$TMPDIR/dotfiles-tracked.txt"
# Same secret exclusions as the Backup copy: a tracked list can still name credential files.
rsync -a --ignore-missing-args --exclude='.env' --exclude='.env.*' --exclude='*.oauth' --exclude='*oauth*.json' \
    --exclude='*token*.json' --exclude='client_secret*.json' --exclude='credentials*' --exclude='auth.json' \
    --files-from="$TMPDIR/dotfiles-tracked.txt" ~/.config/ "$backup_dir/.config/"
```

### Cleanup Old Backups

```bash
# List backups by size
du -sh "$DOTFILES_BACKUPS"/*/ | sort -h

# Delete old backups (keep last 5). The directory must exist, or nothing runs:
# a failed cd must never leave rm -rf in whatever directory the shell is in.
[ -d "$DOTFILES_BACKUPS" ] && cd "$DOTFILES_BACKUPS" && ls -t | tail -n +6 | while IFS= read -r d; do rm -rf -- "$DOTFILES_BACKUPS/$d"; done
```

Restoring a backup follows Restore from a backup in SKILL.md § Tool contract.

## Output format

```
✅ Backed up .zshrc
✅ Backed up .config/editor
✅ Backed up .config/terminal
✅ Backed up .config/shell-tool
Backup complete at: $DOTFILES_BACKUPS/<YYYYMMDD_HHMMSS>

Location: $DOTFILES_BACKUPS/<YYYYMMDD_HHMMSS>
-rw-r--r--  1 user    staff   <size> <date-time> .zshrc
drwxr-xr-x  6 user    staff   <size> <date-time> .config
-rw-r--r--  1 user    staff   <size> <date-time> BACKUP_INFO.txt
Total size: <size>

<BACKUP_INFO.txt, restore instructions included>

drwxr-xr-x  5 user    staff   <size> <date-time> <YYYYMMDD_HHMMSS>/
drwxr-xr-x  5 user    staff   <size> <date-time> <YYYYMMDD_HHMMSS>/
```
