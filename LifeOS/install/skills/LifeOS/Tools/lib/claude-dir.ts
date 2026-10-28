/**
 * The config-root resolver and the invariant assert the install tools use, kept inside the skill.
 *
 * These tools run from the install skill before LIFEOS/TOOLS exists, so they cannot import
 * `LIFEOS/TOOLS/Paths.ts` or `Invariant.ts`. `claudeDirFor` is a copy of `Paths.ts` `claudeDirFor`
 * (same precedence: CLAUDE_PLUGIN_ROOT, CLAUDE_CONFIG_DIR, dirname(LIFEOS_SKILLS_DIR), then ~/.claude);
 * a test pins it against the runtime copy whenever that copy is present.
 */

import { dirname, join } from "node:path";

/** Expands a leading `$HOME`, `${HOME}` or `~` against an explicit home directory. */
export function expandPathFrom(path: string, home: string): string {
  return path
    .replace(/^\$HOME(?=\/|$)/, () => home)
    .replace(/^\$\{HOME\}(?=\/|$)/, () => home)
    .replace(/^~(?=\/|$)/, () => home);
}

/** The Claude home for an explicit environment and home directory. */
export function claudeDirFor(env: Record<string, string | undefined>, home: string): string {
  if (env.CLAUDE_PLUGIN_ROOT) return expandPathFrom(env.CLAUDE_PLUGIN_ROOT, home);
  if (env.CLAUDE_CONFIG_DIR) return expandPathFrom(env.CLAUDE_CONFIG_DIR, home);
  if (env.LIFEOS_SKILLS_DIR) return dirname(expandPathFrom(env.LIFEOS_SKILLS_DIR, home));
  return join(home, ".claude");
}

export class InvariantViolation extends Error {
  constructor(message: string) {
    super(`INVARIANT VIOLATION: ${message}`);
    this.name = "InvariantViolation";
  }
}

/** Throws InvariantViolation when `condition` is falsy; narrows types when it passes. */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantViolation(message);
}
