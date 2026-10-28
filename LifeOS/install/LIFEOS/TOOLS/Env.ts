/**
 * Unified .env parser for LifeOS tools.
 * public issue #2100, @bowlax: five parsers disagreed on CRLF files and export
 * prefixes; this is the one they all use now. Semantics are the former
 * healthsync/store.ts parser (the one that was already correct): CRLF-safe,
 * `export ` prefix stripped, key must match [A-Za-z_][A-Za-z0-9_]*, whitespace
 * around `=` tolerated, one pair of matching surrounding quotes removed.
 */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const cleaned = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsAt = cleaned.indexOf("=");
    if (equalsAt <= 0) continue;
    const key = cleaned.slice(0, equalsAt).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = stripQuotes(cleaned.slice(equalsAt + 1));
  }
  return env;
}

export function stripQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1);
  return v;
}
