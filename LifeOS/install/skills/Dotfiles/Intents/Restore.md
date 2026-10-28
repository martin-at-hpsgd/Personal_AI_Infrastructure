# Restore

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Output format

Dotfiles copied from the private repository to the local home directory, which overwrites local files, behind a backup and the user's confirmation.

## Ideal State

- A timestamped backup of the current `~/.zshrc`, the `~/.config` directories named in `DOTFILES_CONFIG_DIRS` (SKILL.md § Tool contract, Backup copy) and every tracked `.config` file present at home, secret files excluded, was created successfully in `$DOTFILES_BACKUPS` before any change.
- The user confirmed the restore before any file was overwritten, after seeing the backup location and the `.zshrc` and tracked `.config` files that will change.
- The files restored came from `$DOTFILES_REPO` at its latest commit: `git remote -v` showed it before the pull.
- After the copy, `.zshrc` and every tracked `.config` file at home match the repository, checked file by file over `git ls-files .config`, so the verification can pass on a machine whose `~/.config` also holds untracked app data.
- The shell can be reloaded without errors, and the user has the reload commands for their own terminal and the backup location; a rollback runs Restore from a backup in SKILL.md § Tool contract.

## Anti-criteria

- Never overwrites `~/.zshrc` or `~/.config/` without first creating the timestamped backup.
- Never overwrites before the user confirms: ask, and wait for the answer before proceeding.
- Never restores from a wrong repository: stop when `git remote -v` does not show `$DOTFILES_REPO`.
- Never proceeds when the clone at `$DOTFILES_DIR` is missing; the Pull intent clones it first.
- Never copies an untracked or ignored file from the clone home: only `.zshrc` and the files `git ls-files .config` lists are restored.

## Inputs

The config keys: run the Config command in SKILL.md § Data & Config first; it stops the intent when `Config.md` or a key is missing.

## Safety gates

This intent overwrites `~/.zshrc` and the tracked `~/.config/` files with the repository's versions. The remote check, the timestamped backup and the user's confirmation in the Tool contract below all complete before either restore step overwrites anything.

## Tool contract

### 1. Verify Repository Exists

```bash
if [ ! -d $DOTFILES_DIR ]; then
    echo "❌ Repository not found!"
    echo "Run the Pull intent first to clone the repository."
    exit 1
fi

cd $DOTFILES_DIR
```

### 2. Verify Git Remote

```bash
git remote -v
```

Expected output:
```
origin	$DOTFILES_REPO (fetch)
origin	$DOTFILES_REPO (push)
```

A wrong repository stops the intent.

### 3. Update Repository to Latest

```bash
git pull origin main
```

### 4. Show What Will Be Restored

```bash
echo "=== Files to be restored ==="
echo "  .zshrc: $(wc -l .zshrc | awk '{print $1}') lines"
echo "  Last modified: $(git log -1 --format='%cd' --date=short -- .zshrc)"
echo "  Last modified: $(git log -1 --format='%cd' --date=short -- .config)"
echo "  .zshrc: $(wc -l ~/.zshrc 2>/dev/null | awk '{print $1}' || echo 'not found') lines"
```

Then run Compare local and repo from SKILL.md § Tool contract: its lines are the files this restore will change.

### 5. Create Timestamped Backup

Run the Backup copy from SKILL.md § Tool contract. It sets `$backup_dir`, which the confirmation and the rollback name, and `$backup_ok`. Step 8 restores every tracked `.config` file, and `DOTFILES_CONFIG_DIRS` need not name every tracked directory, so add the tracked files that exist at home to the same backup, then step 8 never overwrites a file the backup lacks:

```bash
git ls-files .config | sed 's|^\.config/||' > "$TMPDIR/dotfiles-tracked.txt"
rsync -a --ignore-missing-args --exclude='.env' --exclude='.env.*' --exclude='*.oauth' --exclude='*oauth*.json' \
    --exclude='*token*.json' --exclude='client_secret*.json' --exclude='credentials*' --exclude='auth.json' \
    --files-from="$TMPDIR/dotfiles-tracked.txt" ~/.config/ "$backup_dir/.config/" \
    && echo "✅ Backed up the tracked .config files" || { echo "❌ tracked .config backup failed"; backup_ok=0; }
```

When `$backup_ok` is not `1` the backup is incomplete: stop here, report which copy failed, and overwrite nothing.

### 6. User Confirmation

Present this to the user and wait for the answer before step 7:
```
⚠️  READY TO RESTORE DOTFILES

This will:
1. Copy .zshrc → ~/.zshrc (OVERWRITES existing)
2. Copy the tracked .config files → ~/.config/ (OVERWRITES existing)

Backup created at: [backup_dir path]

DO YOU WANT TO PROCEED?
- Yes: Restore files from repository
- No: Cancel and keep current files
```

### 7. Restore .zshrc (if confirmed)

```bash
echo "=== Restoring .zshrc ==="
cp .zshrc ~/.zshrc
echo "✅ Restored ~/.zshrc"
echo "   Lines: $(wc -l ~/.zshrc | awk '{print $1}')"
```

### 8. Restore the tracked .config files (if confirmed)

Copy only the files git tracks, the same list Push copies up. The clone's `.config` can also hold untracked or ignored files, such as a `.env` that Push's file-name filter caught and ignored, and those never go home. The secret-file exclusions match the backup's, so a secret file is never overwritten without a backup.

```bash
echo ""
echo "=== Restoring .config ==="
git ls-files .config | sed 's|^\.config/||' > "$TMPDIR/dotfiles-tracked.txt"
rsync -av --exclude='.env' --exclude='.env.*' --exclude='*.oauth' --exclude='*oauth*.json' \
    --exclude='*token*.json' --exclude='client_secret*.json' --exclude='credentials*' --exclude='auth.json' \
    --files-from="$TMPDIR/dotfiles-tracked.txt" .config/ ~/.config/
echo "✅ Restored the tracked ~/.config files"
```

Never copy the clone's whole `.config/` directory home (see SKILL.md § Gotchas).

### 9. Verify Restoration

```bash
echo "=== Verification ==="
if diff -q ~/.zshrc .zshrc > /dev/null 2>&1; then
    echo "✅ .zshrc matches repository"
else
    echo "⚠️  .zshrc differs from repository (unexpected)"
fi
```

Then run Compare local and repo from SKILL.md § Tool contract. No output means every tracked `.config` file matches; any line it prints is a file the restore did not land. A secret-named file (`.env`, a token or credentials file) that the repo tracks is skipped by step 8 and shows here; Push keeps those out of the repo, so untrack it there.

### 10. Post-Restore Actions

```bash
echo ""
echo "=== Post-Restore Actions ==="
echo ""
echo "1. Reload shell configuration:"
echo "   source ~/.zshrc"
echo ""
echo "2. Restart terminal or run:"
echo "   exec zsh"
echo ""
echo "3. If issues occur, roll back to this backup (the Dotfiles rollback"
echo "   backs up the current files and asks first):"
echo "   $backup_dir"
echo ""
echo "4. Backup is preserved at:"
echo "   $backup_dir"
```

A later rollback, from any backup, follows Restore from a backup in SKILL.md § Tool contract.

## Output format

```
=== Files to be restored ===
  .zshrc: <N> lines
  Last modified: <YYYY-MM-DD>
differs: .zshrc
differs: .config/<tool>/<file>

✅ Backed up .zshrc
✅ Backed up .config/editor
✅ Backed up .config/terminal
✅ Backed up .config/shell-tool
Backup complete at: $DOTFILES_BACKUPS/<YYYYMMDD_HHMMSS>

⚠️  READY TO RESTORE DOTFILES

[User confirms]

=== Restoring .zshrc ===
✅ Restored ~/.zshrc
   Lines: <N>

=== Restoring .config ===
✅ Restored the tracked ~/.config files

=== Verification ===
✅ .zshrc matches repository

=== Post-Restore Actions ===
1. Reload shell: source ~/.zshrc
2. Restart terminal: exec zsh
3. Backup preserved at: $DOTFILES_BACKUPS/<YYYYMMDD_HHMMSS>
```
