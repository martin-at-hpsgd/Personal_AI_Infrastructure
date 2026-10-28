/**
 * Format caps shared by every hook that enforces the response format.
 * FormatGate (blocks) and DriftReminder (nags) must measure against the same
 * number, so it lives here once instead of as a literal in each hook.
 * public issue #2166, @IvanLeontev-stack
 */

/** Maximum em-dashes allowed in authored prose (code and blockquotes excluded). */
export const EM_DASH_MAX = 2;

/**
 * Bullets touching each other: two list items at the same indent with no blank line between them
 * (system prompt § Format Rules, Layout: "bullets ... with a blank line between items"). Returns how many
 * such pairs the prose has. Fenced code is skipped; a sub-bullet directly under its parent is nesting, not a
 * packed pair. Pure. (principal directive, 2026-10-26, after a harvest
 * report packed its Analysis bullets with the rule already in the prompt.)
 */
export function packedBulletPairs(text: string): number {
  const lines = text.replace(/```[\s\S]*?```/g, "").split("\n");
  const item = /^(\s*)(?:[-*+]|\d+\.)\s+\S/;
  let pairs = 0;
  for (let i = 1; i < lines.length; i++) {
    const a = item.exec(lines[i - 1]);
    const b = item.exec(lines[i]);
    if (a && b && a[1].length === b[1].length) pairs++;
  }
  return pairs;
}
