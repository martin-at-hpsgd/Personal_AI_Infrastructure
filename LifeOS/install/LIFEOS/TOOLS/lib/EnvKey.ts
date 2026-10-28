/**
 * EnvKey.ts — legacy env-key resolution for DA-neutral key names.
 *
 * Shipped code names its env keys with neutral tokens (`DA_LINE_PASSPHRASE`,
 * `ANTHROPIC_API_KEY_OPTIN_DA_BILLING`, `ELEVENLABS_PRINCIPAL_VOICE_CLONE_ID`).
 * An existing install may still carry the older per-name form, where the `DA`
 * segment was the DA's name and the `PRINCIPAL` segment was the principal's
 * first name. That legacy name is computed here at runtime from the configured
 * identity, never written as a literal, so a live `.env` keeps working
 * untouched.
 *
 * Usage at a call site keeps the canonical key visible as a literal (the env
 * template generator only sees `process.env.<KEY>` reads):
 *
 *   const v = process.env.DA_LINE_PASSPHRASE ?? readLegacyEnv("DA_LINE_PASSPHRASE")
 *
 * File-based readers (DALine.ts reads `.env` text directly) use
 * `resolveEnvKeyIn(key, text)` to pick whichever candidate the file holds.
 */

import { getDAName, getPrincipalName } from "../../../hooks/lib/identity"

/** Upper-case env token for a display name: "Ada Example" → "ADA_EXAMPLE". */
export function envToken(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")
}

/** The DA's name as an env-key segment (from identity, never a literal). */
export function daEnvToken(): string {
  return envToken(getDAName())
}

/** The principal's first name as an env-key segment. */
export function principalEnvToken(): string {
  return envToken(getPrincipalName().trim().split(/\s+/)[0] ?? "")
}

/**
 * The legacy per-name key for a neutral key: the `DA` segment becomes the DA
 * token and the `PRINCIPAL` segment becomes the principal token. Returns null
 * when the key has no neutral segment or the substitution is a no-op.
 */
export function legacyEnvKey(key: string): string | null {
  const da = daEnvToken()
  const principal = principalEnvToken()
  const segs = key.split("_").map((s) => (s === "DA" && da ? da : s === "PRINCIPAL" && principal ? principal : s))
  const legacy = segs.join("_")
  return legacy !== key ? legacy : null
}

/** Canonical key first, then its computed legacy name (when one exists). */
export function envKeyCandidates(key: string): string[] {
  const legacy = legacyEnvKey(key)
  return legacy ? [key, legacy] : [key]
}

/**
 * Read the legacy-named value for `key` from `source` (default process.env).
 * Call sites read the canonical key themselves and fall back to this.
 */
export function readLegacyEnv(key: string, source: Record<string, string | undefined> = process.env): string | undefined {
  const legacy = legacyEnvKey(key)
  if (!legacy) return undefined
  const v = source[legacy]
  return v === undefined || v === "" ? undefined : v
}

/** First candidate present in `source` (canonical wins), else the canonical value. */
export function readEnvKey(key: string, source: Record<string, string | undefined> = process.env): string | undefined {
  const v = source[key]
  if (v !== undefined && v !== "") return v
  return readLegacyEnv(key, source)
}

/** Which candidate name a `.env` text already holds; the canonical name when none does. */
export function resolveEnvKeyIn(key: string, envText: string): string {
  for (const cand of envKeyCandidates(key)) {
    if (new RegExp(`^${cand}=`, "m").test(envText)) return cand
  }
  return key
}
