# SecurityValidation

A pre-post review of content headed for social media, so no sensitive information is published by accident.

## Ideal State

- Nothing published carries a credential or token, an internal, staging or private-repo URL, or private personal information (an email, phone number, physical address or SSN that was not meant to be public).
- Content that is empty, over a target platform's limit (X by weighted length), or broken (unclosed markdown, malformed URLs, control characters) is caught before the post, not after.
- Ordinary public content passes clean: a long URL path, a slug, or a word like "test" in prose is not flagged as a secret or an internal URL.
- A `ValidationResult` comes back with blocking issues as errors, non-blocking issues as warnings, and improvements as suggestions; security and quality errors block, context issues warn, and content that passes all checks is approved for posting.

## Anti-criteria

- Content is never approved for posting when API keys or tokens are detected, internal URLs are detected, credential patterns are found, the content is empty or whitespace only, or the content exceeds a platform limit with no truncation strategy.

## Safety gates

This review sits on top of the code gates inside `post`: SendGate's code-tier proof blocks a real secret in the exact bytes each platform receives, and the video PII gate scans attached video (SKILL.md § Gotchas). This intent catches what reads wrong to a person, so it judges context rather than matching strings blindly.

### Sensitive Data Detection

Scan content for:

**API Keys & Tokens**
- Pattern: `sk-`, `api_`, `token_`, `key_`, `secret_`
- AWS keys: `AKIA[0-9A-Z]{16}`
- GitHub tokens: `ghp_`, `gho_`, `ghu_`
- A run of more than 20 hex/base64 characters standing on its own, not inside a public URL path or slug

**URLs**
- Internal URLs: `localhost`, `127.0.0.1`, `192.168.`, `10.0.`
- Staging/dev URLs: a hostname containing `staging`, `dev`, `test` or `internal` (a path, slug or prose word with those letters is fine)
- Private repos: Non-public GitHub URLs

**Personal Information**
- Email addresses (unless intentional)
- Phone numbers
- Physical addresses
- SSN patterns: `\d{3}-\d{2}-\d{4}`

**Credentials**
- Username/password patterns
- Connection strings
- Database credentials

### Content Quality Checks

**Length Validation**
- Twitter: ≤ 280 chars (weighted, URLs = 23)
- Bluesky: ≤ 300 chars
- LinkedIn: ≤ 3000 chars
- Instagram caption: ≤ 2200 chars

**Formatting**
- No broken markdown (unclosed tags)
- No malformed URLs
- No control characters

### Context Validation

**Brand Safety**
- No unintended controversial content
- No content that could be misquoted
- No content that reveals business strategy

### Blocking Conditions

Blocking conditions are the Anti-criteria above. Warn but allow when:
- Content is near a limit (>90%)
- It contains URLs (verify they're public)
- It contains @mentions (verify correct handles)
- It contains hashtags (verify spelling)

## Output format

Return validation result:

```typescript
interface ValidationResult {
  valid: boolean;
  warnings: string[];  // Non-blocking issues
  errors: string[];    // Blocking issues
  suggestions: string[]; // Improvements
}
```

## Examples

```
🔍 Security Validation Results

✅ No sensitive data detected
✅ Content length OK for all platforms
⚠️  Warning: Content is close to Twitter limit (275/280 chars)

Recommendation: SAFE TO POST
```
