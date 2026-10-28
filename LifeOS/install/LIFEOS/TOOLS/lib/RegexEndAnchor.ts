/**
 * Detector for the Python/PCRE end anchor `\Z` inside a JavaScript/TypeScript regex.
 *
 * JavaScript has no `\Z`: it reads it as a literal capital "Z", so a lookahead
 * like `(?=^##|\Z)` cuts the final section at its first capital Z, or drops it
 * when there is none. It shipped three times: WorkSweep goals (public issue
 * #2063, @markb0; fixed via #1919), InterviewScan sections, and the Pulse poller
 * job parser. The /ic lane `regex-end-anchor` (IntegrityCheck.ts) uses this.
 *
 * The pattern matches one or two backslashes, then Z, then a regex-closing
 * character (`)`, `|` or `/`). This source file stays clean by construction:
 * the only backslash-Z sequences in it are followed by a backtick or a space.
 */
export const REGEX_END_ANCHOR_RE = /\\{1,2}Z(?=[)|\/])/;

/** True when a source line is code (not a comment line) and carries the anchor. */
export function hasRegexEndAnchor(line: string): boolean {
  const code = line.trim();
  if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return false;
  return REGEX_END_ANCHOR_RE.test(line);
}
