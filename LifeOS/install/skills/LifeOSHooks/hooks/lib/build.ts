/**
 * build.ts — the Claude Code build the plugin's type declarations were written by.
 *
 * .claude/types/claude-code.d.ts, generated per install from the running build's
 * plugin-authoring skill, names the build on its first line; this constant mirrors it so `session.start` can compare the
 * running build (`claude --version`, through the bridge) and warn when the
 * declarations are stale. Regenerate the types, then bump this, after every
 * Claude Code update.
 */
export const TYPES_BUILD = "2.1.299";

/** Builds older than this drop a hooks.json carrying `modules`; every hook is a passthrough there. */
export const MIN_BUILD = "2.1.250";

export function parseBuild(v: string): [number, number, number] | null {
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1 when a < b, 0 when equal, 1 when a > b; null when either does not parse. */
export function compareBuild(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseBuild(a);
  const pb = parseBuild(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}
