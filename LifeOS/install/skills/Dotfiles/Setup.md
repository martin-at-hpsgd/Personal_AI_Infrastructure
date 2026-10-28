# Dotfiles

Status: bun ~/.claude/skills/Dotfiles/Tools/Config.ts --check · optional

## What it does

Keeps your shell and editor configuration (`~/.zshrc` and a set of directories under `~/.config`) in a private GitHub repository. It pushes your local files up, pulls them down on a new machine, compares the two sides, restores from the repository with a backup first, and makes plain local backups. Every push first confirms that the remote is the repository you configured and that GitHub reports it as private, then scans the staged diff and every unpushed commit with gitleaks, and stops on any hit or when gitleaks is not installed. A pull or restore never overwrites a file before a timestamped backup exists and you confirm.

It needs git, the GitHub CLI signed in to your account, gitleaks, a private repository you created, and one config file that names the repository and the directories to manage.

## Fill in

One file: `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Dotfiles/Config.md`. Every intent runs `Tools/Config.ts`, which reads the Keys table and refuses to continue when the file or a required key is missing. Smallest working example:

```markdown
# Dotfiles Config

## Keys

| Key | Value | Notes |
|-----|-------|-------|
| `DOTFILES_DIR` | `~/dotfiles` | Working clone of the private repo. |
| `DOTFILES_BACKUPS` | `~/dotfiles-backups` | Local timestamped backups. |
| `DOTFILES_REPO` | `git@github.com:alex-example/dotfiles.git` | Private remote. |
| `DOTFILES_CONFIG_DIRS` | `git htop tmux` | Directories under ~/.config to back up and restore. |
```

| Key | Required | Meaning |
|-----|----------|---------|
| `DOTFILES_DIR` | yes | Where the working clone lives (or will be cloned). `~` and `$HOME` are expanded. |
| `DOTFILES_BACKUPS` | yes | Where timestamped local backups go. Never sent to GitHub. |
| `DOTFILES_REPO` | yes | The remote URL the clone must point at. The Push intent refuses to run if `origin` differs. |
| `DOTFILES_CONFIG_DIRS` | yes | Space-separated bare directory names under `~/.config` that Backup and Restore copy. Push and Pull use the repository's tracked list instead. |
| `DOTFILES_REPO_SLUG` | no | The `owner/name` of the repository. Derived from `DOTFILES_REPO` when absent. |

Write each value in backticks, as above; `Config.ts` reads only backticked values in the second column, and each `DOTFILES_CONFIG_DIRS` entry must be a bare name (letters, digits, `.`, `_`, `-`). An environment variable with the same name as a key overrides the table for one run. There are no built-in defaults.

## Accounts and secrets

- A GitHub account and a **private** repository for the dotfiles (create it empty, then clone it to `DOTFILES_DIR`).
- The GitHub CLI (`gh`) signed in as that account: run `gh auth login`.
- An SSH key or credential helper that lets git write to that repository.
- gitleaks installed (`brew install gitleaks`). The Push intent stops when it is missing.
- No env keys are needed in `~/.claude/.env`.

## Prove it works

```bash
bun ~/.claude/skills/Dotfiles/Tools/Config.ts --check
```

This reads only `Config.md`; it touches no repository or file. With the example above it exits 0 and prints (`<home>` stands for your home directory):

```
DOTFILES_DIR=<home>/dotfiles
DOTFILES_BACKUPS=<home>/dotfiles-backups
DOTFILES_REPO=git@github.com:alex-example/dotfiles.git
DOTFILES_CONFIG_DIRS=git htop tmux
DOTFILES_REPO_SLUG=alex-example/dotfiles
OK: config loaded from <your-config-root>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Dotfiles/Config.md
```

With a missing or incomplete `Config.md` it prints what is missing, points at this guide and exits 1. Then say "dotfiles status" to the assistant: the Status intent reports the remote, whether it is the configured private repository, and any differences from your local files, without changing anything.
