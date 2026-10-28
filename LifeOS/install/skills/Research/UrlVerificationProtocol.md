# URL Verification Protocol

Applies to every research intent in this skill: every URL is verified before it goes into results, because one broken link costs the whole report its credibility. This file is the one verifier; Standard, Extensive and Deep point here.

## Why This Matters

Research agents (Perplexity, Gemini, Claude) often hallucinate URLs that look plausible but don't exist:
- URLs with correct domain but wrong path
- URLs with plausible article titles that were never published
- URLs combining real domains with fabricated paths
- URLs to articles that were deleted or moved

A status code alone proves only that something answered: a login wall, a soft 404 or an unrelated page also returns 200. And WebFetch returns a small model's summary of the page, never the page, so it cannot confirm that a citation is supported.

## Verification Intent

A URL goes into research results only when its page supports the claim it is cited for:

1. Pair each URL with the key phrase its citation rests on (a name, number or quote the claim needs).
2. Run the pairs through the verifier, in parallel:

```bash
# pairs.txt: one "url|key phrase" per line
bun skills/Research/Tools/VerifyUrls.ts pairs.txt
# a delivered answer: every URL in it, plus a check that it does not use the retired nine-field template
bun skills/Research/Tools/VerifyUrls.ts --answer answer.md
```

3. Act on each verdict:
   - **SUPPORTED** (the phrase is in the visible text of the page at the final URL, not only in a script, style or comment) stays.
   - **UNSUPPORTED** is not yet verified: read the page itself (raw fetch, or Interceptor for a page that renders with JavaScript) and keep the URL only if the page supports the claim.
   - **DEAD** (a non-2xx status, a login or "not found" page, or a redirect to the homepage) is removed. A not-found page is recognized by its title, its top headings, or the whole text of a near-empty page, never by article prose that merely discusses a 404 error.

A URL that cannot be verified is left out. If the finding was `[HIGH]` on the strength of that URL, it drops to `[MED]` (`Intents/Verify.md` § Output format).

**Fallback:** if the parallel run fails (too many concurrent connections), split the pairs file and run the parts one after another.

## Agent Self-Verification

Each researcher agent has a Self-Verification section that drops URLs it cannot reach before returning. That check is a pre-filter only. An agent's "it resolves" (a status code from curl, or a WebFetch summary) does not verify a citation under this protocol, for the reasons in § Why This Matters, so an agent-reported URL is never treated as already verified.

The orchestrator runs every URL that reaches the answer through `Tools/VerifyUrls.ts` before delivery, whatever the agent reported. An agent that wants its own URLs to arrive verified runs the same tool on its own pairs file; that is the only self-check this protocol accepts.
