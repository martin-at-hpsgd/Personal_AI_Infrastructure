# Status

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Output format

A quick, read-only status report of the dotfiles repository: remote, uncommitted changes, sync with GitHub, and local vs repository differences.

## Ideal State

- When no clone exists at `$DOTFILES_DIR`, the report says so and points to the Pull intent; otherwise it confirms the location.
- The remote section carries the Remote check's own line (SKILL.md § Tool contract): `OK: … private`, or the STOP line naming the current remote and what failed. Privacy comes from GitHub's `isPrivate` answer, never from matching `$DOTFILES_REPO_SLUG` inside the URL.
- Uncommitted changes in the clone are reported, with counts of modified, added, deleted and untracked files.
- Sync status with GitHub is shown as in sync, behind, ahead or diverged, with the commit counts and the last commit.
- The local-vs-repo section lists only the `.zshrc` and tracked `.config` files that differ or are missing at home, so untracked app data in `~/.config` never appears in it and never triggers a recommendation.
- The report ends naming the next intent: Pull when behind, Push when ahead or the clone has uncommitted changes, Sync when local and repo differ, or no action when everything is clean.

## Anti-criteria

- Makes no change to any file: it is read-only, and `git fetch origin main --quiet` only fetches latest info from GitHub without modifying local files.

## Inputs

The config keys: run the Config command in SKILL.md § Data & Config first; it stops the intent when `Config.md` or a key is missing.

## Tool contract

### 1. Check if Repository Exists

```bash
if [ ! -d $DOTFILES_DIR ]; then
    echo "❌ Repository not found at $DOTFILES_DIR"
    echo ""
    echo "Run the Pull intent to clone the repository."
    exit 1
fi

cd $DOTFILES_DIR
```

### 2. Verify Git Remote

```bash
echo "=== Git Remote ==="
git remote -v
```

Then run the Remote check from SKILL.md § Tool contract inside a subshell, `( … )`, so a STOP line becomes the report's warning and the report goes on.

### 3. Check Repository Status

```bash
echo ""
echo "=== Repository Status ==="
git status --short

if [ -z "$(git status --porcelain)" ]; then
    echo "✅ Working directory clean (no uncommitted changes)"
else
    echo "⚠️  You have uncommitted changes"
    echo ""
    echo "   Modified files: $(git status --short | grep '^M' | wc -l | tr -d ' ')"
    echo "   Added files: $(git status --short | grep '^A' | wc -l | tr -d ' ')"
    echo "   Deleted files: $(git status --short | grep '^D' | wc -l | tr -d ' ')"
    echo "   Untracked files: $(git status --short | grep '^??' | wc -l | tr -d ' ')"
fi
```

### 4. Check Sync with GitHub

```bash
# Fetch latest info from GitHub (doesn't modify local files)
git fetch origin main --quiet
git rev-list --left-right --count origin/main...HEAD   # prints "<behind> <ahead>"; both above 0 is diverged
```

### 5. Show Last Commit

```bash
git log -1 --format="%h - %s (%cr by %an)" --date=relative
```

### 6. Compare Local Files

```bash
echo "=== Local Files vs Repository ==="
```

Then run Compare local and repo from SKILL.md § Tool contract; no output means `.zshrc` and every tracked `.config` file match.

## Output format

```
=== Git Remote ===
origin	$DOTFILES_REPO (fetch)
origin	$DOTFILES_REPO (push)
OK: origin is $DOTFILES_REPO, private

=== Repository Status ===
⚠️  You have uncommitted changes

   Modified files: 1
   Added files: 0
   Deleted files: 0
   Untracked files: 0

=== Sync Status with GitHub ===
✅ IN SYNC: Repository matches GitHub (0 behind, 0 ahead)

=== Last Commit ===
<hash> - Update dotfiles <YYYY-MM-DD> (<age> by <author>)

=== Local Files vs Repository ===
differs: .zshrc
differs: .config/<tool>/<file>

=== Summary ===
📝 You have uncommitted changes in the repository
   → Consider: Commit changes, then run Push

📂 Local files differ from repository
   → Run: Sync to compare and decide direction
```

When the clone is clean, in sync and matches home, the summary is `✅ Everything is in sync - no action needed`.
