// callredact.ts — secret redaction for phone-call transcripts and spoken text.
// Extracted from the retired voicellm-fullaccess module (voice-line decommission,
// 2026-09-20) so outbound booking calls keep the same content-level backstop.

// Content-level backstop (Max F1/F3): even an allowed, non-hidden file can hold
// a hardcoded secret. Redact obvious key material before any file text is
// returned (and therefore before it can be spoken aloud).
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN[^-]+PRIVATE KEY-----[\s\S]*?-----END[^-]+PRIVATE KEY-----/g,
  /AKIA[0-9A-Z]{16}/g,
  /AGE-SECRET-KEY-1[0-9A-Z]{20,}/gi,
  /AIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g, // sk-, sk-proj-, sk-ant- (underscore + hyphen — Max round3)
  /\b[srp]k_(live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // bare JWT
  /\b1\/\/[A-Za-z0-9_-]{20,}/g, // Google refresh token
  /\bgith(ub)?_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[uspro]_[A-Za-z0-9]{20,}/g, // ghp_/gho_/ghu_/ghs_/ghr_
  /https:\/\/discord(app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/gi, // creds in a URL (postgres://user:pass@)
  // JSON-quoted OR bare key = value. The closing quote can sit between the key
  // name and the colon, so allow an optional quote there (Max C1/C2). Covers
  // access_token / refreshToken / client_secret / api_key / password / auth / pat / dsn.
  /((?:access|refresh|client|api|private|secret|auth|signing)[_-]?(?:token|key|secret)?|password|passwd|token|secret|pat|dsn|apikey)["']?\s*[:=]\s*["']?[^\s"']{10,}/gi,
  // Format-agnostic backstop (Max round3): a 40+ char unbroken token/base64 run
  // is a credential or hash, never prose. Redact it regardless of surrounding
  // context. English words top out near 20 chars, so false positives are rare.
  /\b[A-Za-z0-9_-]{40,}\b/g,
]
export function redactSecrets(text: string): string {
  let out = text
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]")
  return out
}
