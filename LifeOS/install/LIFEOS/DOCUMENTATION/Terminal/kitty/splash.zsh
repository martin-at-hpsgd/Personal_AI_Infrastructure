# Helm splash — branded boot card for a fresh kitty instance.
# Sourced from ~/.zshrc. Fires once per kitty instance (sentinel keyed on
# KITTY_PID), interactive shells only, zero subprocesses — splits, tabs, and
# scp/rsync/CI shells print nothing.
() {
  [[ -o interactive ]] || return 0
  [[ -n $KITTY_WINDOW_ID && -n $KITTY_PID ]] || return 0
  local sentinel="${TMPDIR:-/tmp}/helm-splash-${KITTY_PID}"
  [[ -e $sentinel ]] && return 0
  : >| "$sentinel" 2>/dev/null || return 0

  # Tokyo Night Storm + Helm blue, truecolor
  local b=$'\e[38;2;122;162;247m'     # bright blue fill
  local s=$'\e[38;2;18;68;179m'       # Helm accent #1244B3 (shadow)
  local d=$'\e[38;2;86;95;137m'       # dim
  local r=$'\e[0m'

  print -r -- ""
  print -r -- "   ${b}██╗  ██╗███████╗██╗     ███╗   ███╗${r}"
  print -r -- "   ${b}██║  ██║██╔════╝██║     ████╗ ████║${r}"
  print -r -- "   ${b}███████║█████╗  ██║     ██╔████╔██║${r}"
  print -r -- "   ${s}██╔══██║██╔══╝  ██║     ██║╚██╔╝██║${r}"
  print -r -- "   ${s}██║  ██║███████╗███████╗██║ ╚═╝ ██║${r}"
  print -r -- "   ${s}╚═╝  ╚═╝╚══════╝╚══════╝╚═╝     ╚═╝${r}"
  print -r -- ""
  print -P -- "   ${s}⎈${r} ${d}the LifeOS terminal · %D{%a %b %d}${r}"
  print -r -- ""
}
