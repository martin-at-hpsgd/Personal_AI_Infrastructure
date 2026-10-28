# Sync

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Output format · Examples

A two-way comparison of local dotfiles and the repository that shows the differences and lets the user choose the sync direction.

## Ideal State

- Repository status is shown clearly after `git fetch origin main`: uncommitted changes, and whether the clone is behind, ahead of, or in sync with GitHub, each state paired with the intent that resolves it (Pull when behind, Push when ahead), never a raw `git push` or `git pull` that would skip Push's privacy check and gitleaks scan.
- The differences between local and repository are displayed: the `.zshrc` and tracked `.config` files that differ or are missing at home (SKILL.md § Tool contract, Compare local and repo), and the first 20 lines of the `.zshrc` diff.
- For each differing file the recommendation says which side changed, judged from content and git history: a home copy that equals a version the repository committed means the repository moved on (Restore); a home copy that matches no committed version means local edits (Push); files going both ways mean manual review. File modification times play no part, since a checkout resets the clone's.
- The available actions are listed, so the user knows which intent to run next.

## Anti-criteria

- No files are modified during the sync process: it only compares (read-only), and the push or restore runs only when the user chooses that intent.

## Inputs

The config keys: run the Config command in SKILL.md § Data & Config first; it stops the intent when `Config.md` or a key is missing.

## Tool contract

### 1. Verify Repository Exists

```bash
if [ ! -d $DOTFILES_DIR ]; then
    echo "Repository not found. Run the Pull intent first."
    exit 1
fi

cd $DOTFILES_DIR
```

### 2. Fetch Latest from GitHub

```bash
git fetch origin main
```

### 3. Check Repository Status

```bash
echo "=== Repository Status ==="
git status --short
git rev-list --left-right --count origin/main...HEAD   # prints "<behind> <ahead>"
```

Behind means run the Pull intent, then Sync again, since the comparison reads the clone's files. Ahead means run the Push intent.

### 4. Compare Local and Repository

```bash
echo "=== .zshrc Comparison ==="
echo "Differences (first 20 lines):"
diff -u .zshrc ~/.zshrc | head -20 || echo "✅ Files are identical"
```

Then run Compare local and repo from SKILL.md § Tool contract.

### 5. Which side changed

For each file step 4 listed as `differs:`:

```bash
in_history() {   # exit 0 when ~/$1 equals a version of $1 the repository committed
  for c in $(git log --format=%H origin/main -- "$1"); do
    git show "$c:$1" 2>/dev/null | cmp -s - "$HOME/$1" && return 0
  done
  return 1
}
if in_history "$f"; then echo "repo newer: $f → Restore"; else echo "local edits: $f → Push"; fi
```

## Output format

```
=== Repository Status ===
0 0   (in sync with GitHub)

=== .zshrc Comparison ===
Differences (first 20 lines):
<diff lines>
differs: .zshrc
differs: .config/<tool>/<file>

=== Recommendation ===
local edits: .zshrc → Push
local edits: .config/<tool>/<file> → Push

=== Available Actions ===

Option 1: Push local → repository
  Use intent: Push
  When: Local files are newer and you want to save them

Option 2: Pull repository → local
  Use intent: Restore
  When: Repository is newer and you want to use those settings

Option 3: Review differences more carefully
  Command: diff -u .zshrc ~/.zshrc | less

Option 4: Do nothing
  When: Files are in sync or differences are intentional
```

## Examples

### Decision Matrix

| Situation | Evidence | Action | Intent |
|-----------|----------|--------|----------|
| Local files edited since the last push | Home copy matches no committed version | Push to repo | `Push` |
| Repo updated from another machine | Home copy equals an older committed version | Restore from repo | `Restore` |
| Files identical | Compare prints nothing | No action needed | - |
| Unsure / Conflicting changes | Files go both ways | Manual review | See Option 3 |
