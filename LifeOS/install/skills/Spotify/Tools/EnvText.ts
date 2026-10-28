/**
 * EnvText.ts — pure helper behind Spotify.ts persistEnv: append or replace
 * KEY=value lines in env-file text without touching other lines.
 */

/** Replace or append each `KEY=value`. Values are literal: `$&`, `$'`, `$1` are never expanded. */
export function applyEnvUpdates(input: string, updates: Record<string, string>): string {
  let text = input;
  for (const [k, v] of Object.entries(updates)) {
    const line = `${k}=${v}`;
    const re = new RegExp(`^\\s*(?:export\\s+)?${k}\\s*=.*$`, "m");
    text = re.test(text) ? text.replace(re, () => line) : text + (text.endsWith("\n") || text === "" ? "" : "\n") + line + "\n";
  }
  return text;
}
