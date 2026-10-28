/**
 * env-expand — the one write-time transform for the payload's settings `env` values.
 *
 * The harness injects env values verbatim with no shell expansion, so InstallSettings
 * expands them when it writes settings.json, and Uninstall applies the same transform
 * to recognise the values it placed. Side-effect free so both can import it.
 */

/** Expand a LEADING $HOME / ${HOME} / ~ path segment. Mid-string refs are left alone. */
export function expandLeadingHome(value: string, home: string): string {
  if (!home) return value;
  if (value === "$HOME" || value === "${HOME}" || value === "~") return home;
  if (value.startsWith("$HOME/")) return home + value.slice("$HOME".length);
  if (value.startsWith("${HOME}/")) return home + value.slice("${HOME}".length);
  if (value.startsWith("~/")) return home + value.slice(1);
  return value;
}

/**
 * The template writes the default config root as `$HOME/.claude`. A value under it is
 * rebased onto the actual config root first (so `--config-root <dir>` moves LIFEOS_DIR
 * with the settings), then any remaining leading home reference is expanded.
 */
export function expandEnvValue(value: string, home: string, configRoot: string): string {
  const m = value.match(/^(?:\$HOME|\$\{HOME\}|~)\/\.claude(?=\/|$)/);
  if (m && configRoot) return configRoot.replace(/\/+$/, "") + value.slice(m[0].length);
  return expandLeadingHome(value, home);
}
