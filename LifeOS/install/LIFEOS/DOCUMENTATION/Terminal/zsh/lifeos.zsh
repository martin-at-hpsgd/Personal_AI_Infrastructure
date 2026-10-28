# LifeOS shell layer for Helm — aliases and functions for LifeOS, herdr and the Helm splash.
# install.sh adds one line to ~/.zshrc that sources this file:
#   [[ -f "$HOME/.claude/LIFEOS/DOCUMENTATION/Terminal/zsh/lifeos.zsh" ]] && source "$HOME/.claude/LIFEOS/DOCUMENTATION/Terminal/zsh/lifeos.zsh"
# It is a link into the LifeOS tree, so updating LifeOS updates it. Nothing here overrides
# an alias or function you already defined before the source line; define your own first
# to keep it. Doc: LIFEOS/DOCUMENTATION/Terminal/Helm.md § Shell layer.
#
# Secrets stay out of the shell. Never `source ~/.claude/.env` from your rc file: it exports
# every key to every process you start. Tools that need a key load it themselves.

export LIFEOS_DIR="${LIFEOS_DIR:-$HOME/.claude/LIFEOS}"

# True when you have defined neither an alias nor a function by this name, so ours may take it.
_lifeos_free() { (( ! $+aliases[$1] && ! $+functions[$1] )); }

# Launch LifeOS (the installer also adds `lifeos`; these are short forms).
_lifeos_free lifeos && alias lifeos="bun \"$LIFEOS_DIR/TOOLS/lifeos.ts\""
_lifeos_free k      && alias k="bun \"$LIFEOS_DIR/TOOLS/lifeos.ts\""
_lifeos_free kr     && alias kr="k --resume"

# Jump into the tree.
_lifeos_free kd && alias kd="cd \"$LIFEOS_DIR\""
_lifeos_free km && alias km="cd \"$LIFEOS_DIR/MEMORY\""
_lifeos_free ku && alias ku="cd \"$LIFEOS_DIR/USER\""

# Herdr inside Helm (kitty): hand the Helm chords to herdr and collapse the kitty tab bar
# while the herdr client runs; herdr's own sidebar shows the sessions instead.
# Subcommands like `herdr status` pass straight through. The `function` keyword keeps an alias
# you named herdr or ha from expanding inside these declarations, which zsh rejects as a parse error.
if _lifeos_free herdr; then
  function herdr {
    local ui=0 hid=0
    case "$1" in
      ""|--session|--remote|--no-session|--handoff) ui=1 ;;
      session) [[ "$2" == attach ]] && ui=1 ;;
    esac
    if (( ui )) && [[ -n "$KITTY_WINDOW_ID" ]] && command -v kitten >/dev/null; then
      kitten @ set-user-vars --match "id:$KITTY_WINDOW_ID" in_herdr=1 2>/dev/null
      # TabBar.ts counts clients by shell pid, so the bar returns only when the last
      # herdr client in this kitty instance exits, never under one still running.
      bun ~/.config/kitty/TabBar.ts hide-on $$ >/dev/null 2>&1 && hid=1
      command herdr "$@"; local rc=$?
      kitten @ set-user-vars --match "id:$KITTY_WINDOW_ID" in_herdr= 2>/dev/null
      (( hid )) && bun ~/.config/kitty/TabBar.ts hide-off $$ >/dev/null 2>&1
      return $rc
    fi
    command herdr "$@"
  }
fi
_lifeos_free h && alias h="herdr"

# ha [session] — attach to a herdr session, starting it if it isn't running. No argument
# means the default session. A kitty relaunched from inside a herdr pane hands HERDR_* to
# every new window and herdr then refuses as "nested", so drop them, but only when no herdr
# process is actually above this shell.
if _lifeos_free ha; then
  function ha {
    local p=$$
    while [[ -n "$p" && "$p" != 1 ]]; do
      [[ "$(ps -o comm= -p $p)" == *herdr* ]] && { echo "ha: already inside herdr" >&2; return 1; }
      p=$(ps -o ppid= -p $p | tr -d ' ')
    done
    ( unset HERDR_ENV HERDR_PANE_ID HERDR_TAB_ID HERDR_WORKSPACE_ID HERDR_SOCKET_PATH HERDR_BIN_PATH
      if [[ -z "$1" || "$1" == default ]]; then herdr; else herdr --session "$1"; fi )
  }
fi

# Helm splash — branded boot card on a new kitty instance (once per KITTY_PID).
[[ -f ~/.config/kitty/splash.zsh ]] && source ~/.config/kitty/splash.zsh

unfunction _lifeos_free
