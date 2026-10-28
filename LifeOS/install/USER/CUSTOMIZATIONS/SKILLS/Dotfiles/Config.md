---
provenance: template
version: 1.1.0
---

# Dotfiles — Config

Read at the start of every `Dotfiles` intent by `Tools/Config.ts`, which exports the Keys table below into the shell and stops the intent when the file or a required key is missing. An environment variable with the same name as a key overrides the table for one run. There are no built-in defaults. Setup guide: `skills/Dotfiles/Setup.md`.

## Keys

| Key | Value | Notes |
|-----|-------|-------|
| `DOTFILES_DIR` | `~/dotfiles` | Working clone of your **private** dotfiles repo. `~` and `$HOME` are expanded. |
| `DOTFILES_BACKUPS` | `~/dotfiles-backups` | Timestamped local backups made before any overwrite. Never sent to GitHub. |
| `DOTFILES_REPO` | `git@github.com:alex-example/dotfiles.git` | The remote the clone must point at. The Push intent refuses to run if `origin` differs. |
| `DOTFILES_CONFIG_DIRS` | `git htop tmux` | Space-separated bare names of directories under `~/.config` that Backup and Restore copy. |

`DOTFILES_REPO_SLUG` (the `owner/name` of the repo, for example `alex-example/dotfiles`) is derived from `DOTFILES_REPO` unless you add a row for it.

## Rules

- The repository MUST be private. Confirm with `gh repo view alex-example/dotfiles --json isPrivate`.
- Never point `DOTFILES_DIR` at a public repo clone; the Push scan blocks `.env`, keys and tokens, but a public remote is refused outright.
