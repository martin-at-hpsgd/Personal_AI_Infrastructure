# Push

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Output format

The current local dotfiles (.zshrc and the tracked .config/ files) committed and pushed to the private GitHub dotfiles repository.

## Ideal State

- No pull, commit or push ran before the Remote check (SKILL.md § Tool contract) printed `OK: … private`: origin equals `$DOTFILES_REPO` and `gh repo view --json isPrivate` returned `true`; the whole check was re-run just before the push.
- gitleaks exited 0 on the staged diff (`--staged --pre-commit`) and on every unpushed commit (`--log-opts="origin/main..HEAD"`); gitleaks not installed means stop.
- The repository's `.zshrc` is a copy of `~/.zshrc` and its tracked `.config/` files are copies of their `~/.config/` sources; a new config entered the repo by name, only when asked.
- No sensitive file (`.env`, OAuth, token or credentials file) is in any pushed commit; a sensitive file the name filter caught is removed from the index (`git rm --cached`, so `git add -u` cannot restage it), the filter finds none in the staged set, and the file is covered by a rule in `.config/.gitignore`, which holds each rule once.
- The commit message carries the date and names every changed file, the commit reached GitHub through `git push origin main`, and `git log -1 --oneline` shows it.

## Anti-criteria

- Never pushes to a public repository, or to any remote other than `$DOTFILES_REPO`, because a pushed secret cannot be recalled; any `STOP` line ends the intent: no pull, no commit, no push.
- Never syncs the whole config directory; only the `.config` files git already tracks are copied (see SKILL.md § Gotchas).
- Never stages everything; untracked content stays out unless it was added by name as a new config.
- Never skips the gitleaks scan, and never passes a gitleaks allowlist flag to get past it.
- Never continues while the file-name filter detects sensitive files (STOP), and never pushes a secret already committed locally before that commit is rewritten.

## Inputs

The config keys: run the Config command in SKILL.md § Data & Config first; it stops the intent when `Config.md` or a key is missing.

## Safety gates

Four gates in the Tool contract below, in this order: the Remote check before anything else, the file-name filter on the changed files, the gitleaks scan of the staged diff, and the re-run Remote check plus the gitleaks scan of every unpushed commit just before the push. Each STOP line ends the intent.

## Tool contract

### 1. Safety Verification — the remote is the configured repo AND GitHub says it is private

Run the Remote check in SKILL.md § Tool contract before any other step. Any `STOP` line ends the intent: no pull, no commit, no push.

### 2. Pull Latest Changes

```bash
cd $DOTFILES_DIR
git pull origin main
```

### 3. Sync .zshrc

```bash
cp ~/.zshrc .zshrc
wc -l ~/.zshrc .zshrc
```

### 4. Sync .config — tracked files only

The repo decides what is a dotfile. Copy only the files git already tracks:

```bash
git ls-files .config | sed 's|^\.config/||' > "$TMPDIR/dotfiles-tracked.txt"
rsync -a --ignore-missing-args --files-from="$TMPDIR/dotfiles-tracked.txt" ~/.config/ .config/
```

Never sync the whole config directory. It also holds application data, credentials, OAuth files and session state, and a whole-directory copy lands all of it in the clone one staging command away from the remote (see SKILL.md § Gotchas).

### 4b. Add a new config (only when asked)

A new tool's config enters the repo by name, after reading it:

```bash
mkdir -p .config/<tool> && cp ~/.config/<tool>/<file> .config/<tool>/<file>
git add .config/<tool>/<file>
```

If the tool's directory also holds logs, sockets, caches or state, add an ignore rule that keeps only the config file (`<tool>/*` then `!<tool>/<file>`) in `.config/.gitignore`.

### 5. Review Changes

```bash
git status --short
git diff .zshrc | head -50
```

Check for sensitive file names (a quick filter; the content scan in step 7b is the gate):
```bash
git status --short | grep -E "\.env|\.oauth|\.token|credentials"
```

A hit stops the push until step 6 has unstaged the file and ignored it.

### 6. Update .gitignore (if needed)

When sensitive files appear, add each missing exclusion once, so repeated runs never stack duplicate rules:

```bash
for rule in '.env' '.env.*' '*.oauth' '*.token' '*credentials*' 'logs/' '*.log' 'cache/' '<app-data-dir>/'; do
  grep -qxF -- "$rule" .config/.gitignore 2>/dev/null || echo "$rule" >> .config/.gitignore
done
```

Then take each sensitive file out of the index. `git rm --cached` drops it whether it was newly staged or already tracked; a plain `git reset` leaves a tracked file in the index, where step 7's `git add -u` stages it again and an ignore rule never applies. The file stays on disk:
```bash
git rm -r -q --cached --ignore-unmatch -- .config/<tool>/.env
git rm -r -q --cached --ignore-unmatch -- .config/<tool>/cache/
```

### 7. Stage Changes — tracked files only

```bash
git add -u
git status --short --untracked-files=normal | grep '^??'   # anything here stays out unless step 4b named it
# The file-name filter again, on exactly what is staged (deletions from step 6 excepted)
if git diff --cached --name-only --diff-filter=d | grep -E "\.env|\.oauth|\.token|credentials"; then
    echo "STOP: a sensitive file is staged; run step 6 for it"; exit 1
fi
```

Never stage everything. Untracked content in the clone is either a new config that step 4b adds by name, or something that does not belong in dotfiles.

### 7b. Secret scan of the staged content

A content scan of exactly what is about to be committed. `.zshrc` is copied whole in step 3, so an exported token in it reaches this diff; a file-name grep never sees it.

```bash
command -v gitleaks >/dev/null || { echo "STOP: gitleaks is not installed (brew install gitleaks); no push without a content scan"; exit 1; }
gitleaks git --staged --pre-commit --redact --no-banner . || { echo "STOP: gitleaks found a secret in the staged diff, or failed to run"; exit 1; }
```

On a finding: unstage the file (`git reset <file>`), remove the secret from the source (move it to the env file it belongs in), add an ignore rule if the whole file is sensitive, and re-run from step 3. Never skip the scan, and never pass a gitleaks allowlist flag to get past it.

### 8. Create Commit

The heredoc is unquoted so the date and the staged file list expand into the message:

```bash
git commit -F - <<EOF
Update dotfiles $(date +%Y-%m-%d)

$(git diff --cached --name-only | sed 's/^/- /')
EOF
```

### 9. Final Safety Check

Re-run the whole Remote check (visibility can change between steps), then scan every commit about to leave the machine, not just this one:

```bash
gitleaks git --log-opts="origin/main..HEAD" --redact --no-banner . || { echo "STOP: gitleaks found a secret in an unpushed commit, or failed to run"; exit 1; }
echo "PUSHING TO: $(git remote get-url origin)"
```

Push only when the Remote check printed `OK: … private` and this scan exited 0. A secret already committed locally needs the commit rewritten before any push.

### 10. Push to GitHub

```bash
git push origin main
```

### 11. Confirm Success

```bash
git log -1 --oneline
echo ""
echo "✅ Dotfiles pushed successfully to private repository"
```

## Output format

The report carries the fields in SKILL.md § Ideal State (files changed, repository verified, security result, commit hash, next intent). The command output looks like:

```
OK: origin is $DOTFILES_REPO, private
PUSHING TO: $DOTFILES_REPO

To $DOTFILES_REPO
   <old-hash>..<new-hash>  main -> main

<new-hash> Update dotfiles <YYYY-MM-DD>

✅ Dotfiles pushed successfully to private repository
```
