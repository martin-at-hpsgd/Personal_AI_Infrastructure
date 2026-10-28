#!/usr/bin/env bash
# Helm — the kitty layer LifeOS runs herdr inside: theme, fonts, key passthrough, remote socket.
# Ships with LifeOS. Run it from this directory; it clones nothing and needs no network
# beyond Homebrew. Upstream kitty is installed unmodified — Helm is a config layer, not a fork.
set -euo pipefail

# Argument contract (round-20 audit): no argument installs; --help prints usage; anything else
# refuses with exit 2 before Homebrew, ~/.config/kitty, or ~/Applications are touched.
usage() { echo "Usage: bash install.sh            # install Helm (kitty + config layer + Helm.app, herdr config, shell layer, Hammerspoon hotkeys)"; echo "       bash install.sh --help     # this text"; }
if [ "$#" -gt 0 ]; then
  case "$1" in
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
fi

HELM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Deliberately NOT XDG_CONFIG_HOME-aware: kitty.conf, the watcher, and TabBar.ts all
# reference ~/.config/kitty by absolute path, so linking anywhere else would satisfy kitty
# while every helper inside the config silently dangled.
KITTY_CONF_DIR="$HOME/.config/kitty"

echo "⎈ Helm install"

# 1. kitty + font. A kitty installed outside brew (direct download) is fine — we only
#    shell out to brew when kitty is genuinely absent, so a non-brew install is not clobbered.
if [[ "$(uname)" == "Darwin" ]]; then
  if ! command -v kitty >/dev/null && [[ ! -d /Applications/kitty.app ]]; then
    command -v brew >/dev/null || { echo "Homebrew required (or install kitty yourself): https://brew.sh"; exit 1; }
    brew install --cask kitty
  fi
  if command -v brew >/dev/null && ! brew list --cask font-hack-nerd-font &>/dev/null; then
    brew install --cask font-hack-nerd-font || echo "  note: font install failed — install a Nerd Font yourself for the icons"
  fi
else
  command -v kitty >/dev/null || { echo "Install kitty first: https://sw.kovidgoyal.net/kitty/"; exit 1; }
fi

# 2. Back up whatever is already there — real directory OR an existing symlink (a dotfiles
#    manager's pointer counts; losing it silently would be rude) — then link the terminal config in.
#    The link points into the LifeOS tree, so a LifeOS update updates Helm too.
mkdir -p "$(dirname "$KITTY_CONF_DIR")"
if [[ -L "$KITTY_CONF_DIR" ]]; then
  PREVIOUS="$(readlink "$KITTY_CONF_DIR")"
  if [[ "$PREVIOUS" != "$HELM_DIR/kitty" ]]; then
    echo "  existing kitty config symlink pointed at: $PREVIOUS"
    echo "    (replacing the link only — nothing at that path is touched)"
  fi
elif [[ -e "$KITTY_CONF_DIR" ]]; then
  BACKUP="$KITTY_CONF_DIR.pre-helm.$(date +%Y%m%d%H%M%S)"
  mv "$KITTY_CONF_DIR" "$BACKUP"
  echo "  existing config backed up → $BACKUP"
fi
ln -sfn "$HELM_DIR/kitty" "$KITTY_CONF_DIR"
echo "  config linked: $KITTY_CONF_DIR → $HELM_DIR/kitty"

# 3. macOS app wrapper so it lives in Spotlight/Dock as "Helm".
#    The kitty path is resolved now rather than assumed, so a non-/Applications install works.
if [[ "$(uname)" == "Darwin" ]]; then
  if [[ -x /Applications/kitty.app/Contents/MacOS/kitty ]]; then
    KITTY_BIN=/Applications/kitty.app/Contents/MacOS/kitty
  else
    KITTY_BIN="$(command -v kitty || true)"
  fi
  if [[ -n "$KITTY_BIN" ]]; then
    APP="$HOME/Applications/Helm.app"
    mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
    cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Helm</string>
  <key>CFBundleIdentifier</key><string>io.helm.terminal</string>
  <key>CFBundleExecutable</key><string>helm</string>
  <key>CFBundleIconFile</key><string>helm</string>
</dict></plist>
PLIST
    # %q quotes the path: resolving via `command -v` means it can now contain spaces.
    printf '#!/usr/bin/env bash\nexec %q "$@"\n' "$KITTY_BIN" > "$APP/Contents/MacOS/helm"
    chmod +x "$APP/Contents/MacOS/helm"
    # The icon is optional: a payload without assets/ still gets a working Helm.app.
    if [[ -f "$HELM_DIR/assets/helm.icns" ]]; then
      cp "$HELM_DIR/assets/helm.icns" "$APP/Contents/Resources/helm.icns"
    else
      echo "  note: assets/helm.icns not found — Helm.app uses the default icon"
    fi
    touch "$APP"   # Finder and the Dock re-read the icon
    echo "  Helm.app created in ~/Applications"
  else
    echo "  note: kitty binary not found — skipping the Helm.app wrapper"
  fi
fi

# 4. helm command on PATH (doctor/update); bun optional but recommended for TabBar.ts
HELM_ON_PATH=1
if command -v helm >/dev/null && [[ "$(command -v helm)" != "$HOME/.local/bin/helm" ]]; then
  echo "  ⚠ another 'helm' is already on your PATH ($(command -v helm)) — likely Kubernetes Helm."
  echo "    Skipping the PATH link. Run this one directly: $HELM_DIR/bin/helm"
  HELM_ON_PATH=0
elif [[ -e "$HOME/.local/bin/helm" && ! -L "$HOME/.local/bin/helm" ]]; then
  # A real file already sits at the exact path we'd link — a Kubernetes Helm installed
  # here is common, and ln -sfn would destroy it silently. Never clobber a real binary.
  echo "  ⚠ a real file already exists at ~/.local/bin/helm — leaving it alone."
  echo "    Run this one directly: $HELM_DIR/bin/helm"
  HELM_ON_PATH=0
else
  mkdir -p "$HOME/.local/bin"
  # An existing symlink here survives as a file but changes what `helm` MEANS, so say so
  # rather than repointing in silence — same courtesy the config-link step extends.
  if [[ -L "$HOME/.local/bin/helm" ]]; then
    PREV_HELM="$(readlink "$HOME/.local/bin/helm")"
    [[ "$PREV_HELM" != "$HELM_DIR/bin/helm" ]] && echo "  note: ~/.local/bin/helm pointed at $PREV_HELM — repointing it at Helm"
  fi
  ln -sfn "$HELM_DIR/bin/helm" "$HOME/.local/bin/helm"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) echo "  ⚠ ~/.local/bin is not on your PATH — add it, or run $HELM_DIR/bin/helm directly"
       HELM_ON_PATH=0 ;;
  esac
fi
command -v bun >/dev/null || echo "  note: install bun (https://bun.sh) so the tab bar can hide while herdr runs"
if command -v herdr >/dev/null; then
  # Closing a herdr session focuses the one above, not herdr's default below. Re-linking
  # an already linked plugin just refreshes it, so this is safe on every run.
  herdr plugin link "$HELM_DIR/herdr/select-above" >/dev/null && echo "✓ herdr select-above plugin linked" \
    || echo "  ⚠ could not link the herdr select-above plugin — run: herdr plugin link $HELM_DIR/herdr/select-above"
else
  echo "  note: herdr is the workspace layer and this script does not install it — get it from https://herdr.dev"
fi

# 5. herdr config: COPIED (not linked) because it is yours to edit, and only when you have
#    none. An existing config.toml is never touched; compare against the template yourself.
HERDR_CONF="${XDG_CONFIG_HOME:-$HOME/.config}/herdr/config.toml"
if [[ -e "$HERDR_CONF" ]]; then
  echo "  herdr config exists — left alone (template: $HELM_DIR/herdr/config.toml)"
else
  mkdir -p "$(dirname "$HERDR_CONF")"
  cp "$HELM_DIR/herdr/config.toml" "$HERDR_CONF"
  echo "✓ herdr config installed → $HERDR_CONF"
fi

# 6. Shell layer: one guarded source line in ~/.zshrc. The snippet never overrides an alias
#    or function you already defined, so adding it is safe on an existing setup.
ZSH_LAYER="$HELM_DIR/zsh/lifeos.zsh"
ZSHRC="${ZDOTDIR:-$HOME}/.zshrc"
if grep -qF "Terminal/zsh/lifeos.zsh" "$ZSHRC" 2>/dev/null; then
  echo "  shell layer already sourced from ${ZSHRC/#$HOME/~}"
else
  printf '\n# LifeOS shell layer (terminal): aliases, the herdr wrapper, the splash.\n[[ -f %q ]] && source %q\n' "$ZSH_LAYER" "$ZSH_LAYER" >> "$ZSHRC"
  echo "✓ shell layer sourced from ${ZSHRC/#$HOME/~} (open a new shell to pick it up)"
fi

# 7. Hammerspoon hotkeys (optional, macOS). Linked like the kitty config, so a LifeOS update
#    updates them; init.lua gets one guarded require. Hammerspoon itself is not installed here.
if [[ "$(uname)" == "Darwin" ]]; then
  if [[ -d /Applications/Hammerspoon.app || -d "$HOME/Applications/Hammerspoon.app" ]]; then
    HS_DIR="$HOME/.hammerspoon"
    mkdir -p "$HS_DIR"
    if [[ -e "$HS_DIR/lifeos.lua" && ! -L "$HS_DIR/lifeos.lua" ]]; then
      echo "  ⚠ a real file exists at ~/.hammerspoon/lifeos.lua — leaving it alone"
    else
      ln -sfn "$HELM_DIR/hammerspoon/lifeos.lua" "$HS_DIR/lifeos.lua"
      grep -qE '^[^-]*require\(?[[:space:]]*"lifeos"' "$HS_DIR/init.lua" 2>/dev/null \
        || grep -qF 'pcall(require, "lifeos")' "$HS_DIR/init.lua" 2>/dev/null \
        || printf '\n-- LifeOS hotkeys (terminal): new session, voice mute, voice mode.\npcall(require, "lifeos")\n' >> "$HS_DIR/init.lua"
      echo "✓ Hammerspoon hotkeys linked — reload Hammerspoon (menu bar icon → Reload Config)"
    fi
  else
    echo "  note: Hammerspoon adds LifeOS hotkeys (new session, voice mute) — brew install --cask hammerspoon, then run this again"
  fi
fi

if [[ "$HELM_ON_PATH" == "1" ]]; then
  echo "✓ Done. Launch Helm.app (or kitty). 'helm doctor' checks the install."
else
  echo "✓ Done. Launch Helm.app (or kitty). Check the install with: $HELM_DIR/bin/helm doctor"
fi
