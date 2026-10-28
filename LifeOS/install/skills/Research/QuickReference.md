# Research Quick Reference

## Four Research Modes

| Trigger | Mode | Config | Verification | Speed |
|---------|------|--------|-------------|-------|
| "quick research", "minor research" | Quick | 1 Perplexity call, no agent | Self-verification + Tier 1: every delivered URL fetched and matched, the venue's own page for existence and hours | ~10-15s |
| "do research", "research this" | Standard | 4 vendors (Claude + Gemini + Perplexity + OpenAI/Codex) + cross-check; + Grok when X is a plausible source | Self-verification + cross-check synthesis | ~30-60s |
| "extensive research" | Extensive | 7 explorers + 2 verifiers (9 agents) | Self-verification + 2 dedicated verifier agents, run in parallel with the explorers | ~60-90s |
| "deep investigation", "investigate [topic]" | Deep | Progressive iteration + verification | Self-verification + profile spot-check (iterative mode) | ~3-60min |

**Confidence tags:** `[HIGH]` `[MED]` `[LOW]` `[CONFLICT]`

See `Intents/Verify.md` for the full verification protocol, `Intents/ExtractAlpha.md` for the extract-alpha output shape, and `Intents/Retrieve.md` for retrieving hard-to-fetch content (built-in tools first, then a real browser through Interceptor, then a vendor data product within the site's terms; a site that refuses automated access is reported).
