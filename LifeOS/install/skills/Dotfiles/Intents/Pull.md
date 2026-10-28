# Pull

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Output format

The latest dotfiles fetched from the private GitHub repository into the working clone, compared against local files, without overwriting local files.

## Ideal State

- `$DOTFILES_DIR` holds the private dotfiles repository at its latest commit: cloned when absent, otherwise updated with `git pull origin main`.
- After the clone or pull, and before any comparison, `git remote -v` showed `$DOTFILES_REPO` for fetch and push.
- The report shows the latest commit (`git log -1 --stat`), the repository location, when it was last updated, the `.zshrc` and tracked `.config` files that differ from home (SKILL.md § Tool contract, Compare local and repo) or that none do, and a pointer to the Restore intent for copying files home.
- Local files remain unchanged.

## Anti-criteria

- Never copies files to `~/`, overwrites `.zshrc` or `.config/`, modifies local configuration, or makes any destructive change; copying files home is the Restore intent, which backs up first.
- Never continues when `git remote -v` shows any repository other than `$DOTFILES_REPO`: stop before comparing.

## Inputs

The config keys: run the Config command in SKILL.md § Data & Config first; it stops the intent when `Config.md` or a key is missing.

## Safety gates

The remote check in the Tool contract runs right after the clone or pull and before any comparison; any repository other than `$DOTFILES_REPO` stops the intent.

## Tool contract

### 1. Check if Repo Already Cloned

```bash
if [ -d $DOTFILES_DIR ]; then
    echo "Repository already exists, pulling latest..."
    cd $DOTFILES_DIR
    git pull origin main
else
    echo "Cloning repository for first time..."
    mkdir -p "$(dirname "$DOTFILES_DIR")"
    git clone "$DOTFILES_REPO" "$DOTFILES_DIR"
fi
```

### 2. Verify Git Remote

```bash
cd $DOTFILES_DIR
git remote -v
```

Expected output:
```
origin	$DOTFILES_REPO (fetch)
origin	$DOTFILES_REPO (push)
```

Any other repository stops the intent.

### 3. Show Latest Commit

```bash
git log -1 --stat
```

### 4. Compare Repository vs Local Files

```bash
echo "=== .zshrc Comparison ==="
echo "Repository: $(wc -l .zshrc | awk '{print $1}') lines"
echo "Local:      $(wc -l ~/.zshrc | awk '{print $1}') lines"
echo ""
diff -u ~/.zshrc .zshrc | head -30 || echo "(Files are identical)"
```

Then run Compare local and repo from SKILL.md § Tool contract for the tracked `.config` files.

### 5. Show Summary of Changes

```bash
echo ""
echo "Repository is up-to-date at: $(pwd)"
echo "Last updated: $(git log -1 --format='%cd' --date=relative)"
echo ""
echo "To restore these files to your home directory, use the restore intent."
```

## Output format

```
Repository already exists, pulling latest...
Updating <old-hash>..<new-hash>
Fast-forward
 .zshrc | <N> ++++

origin	$DOTFILES_REPO (fetch)
origin	$DOTFILES_REPO (push)

=== .zshrc Comparison ===
Repository: <N> lines
Local:      <N> lines

(Files are identical)
differs: .config/<tool>/<file>

Repository is up-to-date at: $DOTFILES_DIR
Last updated: 2 hours ago

To restore these files to your home directory, use the restore intent.
```
