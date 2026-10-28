/**
 * CoreSurface.ts — the ONE definition of the LifeOS "core change" surface.
 *
 * A change under one of these paths is version-relevant: ClassifyChange proposes a
 * bump level from it, UpdateKaiRepo's integrity gate treats a core change after the
 * audited commit as a stale audit (and scopes --committed-only to it), and the
 * VersionDrift hook nags when it drifts past the last tag. Before 2026-10-11 the list
 * lived in three files and drifted (UpdateKaiRepo lacked commands/, test/,
 * LIFEOS/PULSE/ and LIFEOS/ATLAS/). test/regression/core-surface-sync.test.ts asserts
 * all three import this module and none keeps a local copy.
 *
 * Entries ending in "/" are directory prefixes; the rest are exact repo-relative
 * paths. Every entry is also a valid git pathspec, so `git diff -- ...CORE_SURFACE`
 * and `isCorePath()` select the same files.
 *
 * MEMORY/ and USER/ are symlinked out of ~/.claude, so they never appear in this
 * repo's diff and need no exclusion here. Pure module: no I/O, no side effects.
 */

export const CORE_SURFACE: readonly string[] = Object.freeze([
  "hooks/",
  "LIFEOS/ALGORITHM/",
  "skills/",
  "settings.json",
  "CLAUDE.md",
  "LIFEOS/LIFEOS_SYSTEM_PROMPT.md",
  "LIFEOS/TOOLS/",
  "agents/",
  "commands/",
  "LIFEOS/PULSE/",
  "LIFEOS/ATLAS/",
  "test/",
  "LIFEOS/DOCUMENTATION/",
]);

/** True when a repo-relative path (forward slashes, no leading "./") is on the core surface. */
export function isCorePath(p: string): boolean {
  for (const entry of CORE_SURFACE) {
    if (entry.endsWith("/") ? p.startsWith(entry) : p === entry) return true;
  }
  return false;
}
