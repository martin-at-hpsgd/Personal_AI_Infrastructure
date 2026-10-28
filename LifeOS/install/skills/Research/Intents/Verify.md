# Verify

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Output format · References

Research findings checked by an independent verifier, every claim confidence-tagged and every contradiction flagged with both sides.

## Ideal State

- The verdicts come from a verifier independent of the explorer: it saw only the final claims, never the explorer's reasoning, and judged each atomic sub-claim on its own, so it carries no confirmation bias from the exploration.
- Verification effort goes to the claims most likely to be wrong, in the priority order under Tool contract (quantitative, causal, recency, specificity), not to general statements or widely-known facts.
- Every claim carries a confidence tag from the scoring table under Output format, and a claim with missing confidence metadata is `[LOW]`.
- When multiple agents' results are available, every pair of claims from any agents asserting opposite conclusions on the same topic is flagged `[CONFLICT]` with both claims and their sources in the conflict output format; a `[CONFLICT]` item may get one targeted follow-up query.
- The verification tier matches the research mode per the mode-to-tier mapping, and a timed-out agent, a failed URL check or a single returning agent is handled by the graceful-degradation rules under Tool contract.

## Anti-criteria

- The verifier does not resolve a conflict itself: both sides are presented with their sources.
- No empty sections: when no conflicts are detected, the conflict section is skipped entirely.

## Inputs

**Trigger:** Called by other intents (ExtensiveResearch, DeepInvestigation) or standalone via "verify these findings"

## Tool contract

### Verification Priority

1. **Quantitative claims** (numbers, percentages, dates) — most common hallucination target
2. **Causal claims** ("X causes Y") — often asserted without evidence
3. **Recency claims** ("as of 2026") — training data may be stale
4. **Specificity claims** (exact product names, version numbers, API parameters) — easily fabricated

### Verification Methods

**Tier 1: URL/Source Verification (fastest)**
- Every delivered URL through the one verifier in `../UrlVerificationProtocol.md`: the page body at the final URL carries the key phrase the claim rests on, or the page itself was read and supports it
- For existence, hours and booking claims, the official page of the venue or its host property

**Tier 2: Claim Spot-Check (medium)**
- Pick highest-impact sub-claims (quantitative, causal)
- WebSearch to independently confirm

**Tier 3: Full Independent Verification (slowest)**
- Spawn dedicated verifier agent with claims only (no reasoning)
- Agent independently researches each sub-claim, in parallel with the other agents

**Mode-to-tier mapping:**
| Research Mode | Verification Tier | Rationale |
|---------------|-------------------|-----------|
| Quick | Tier 1 | One agent, so every delivered URL is fetched and matched; the official venue page settles existence and hours (SKILL.md § Gotchas, 2026-09-30) |
| Standard | Tier 1 + synthesis cross-check | Lightweight |
| Extensive | Tier 1 + Tier 3 (2 verifier agents) | Full verification within 9-agent budget |
| Deep | Tier 1 + Tier 2 + Tier 3 | Iterative, verification between rounds |

### Graceful Degradation

- If verifier agents time out → nothing was independently verified by them: no finding is promoted on verifier evidence, and an explorer-assigned `[HIGH]` is capped at `[MED]` unless two agents from different vendors reached it independently
- If the parallel URL check fails (too many connections) → run it sequentially; an unchecked URL is still never delivered
- If only 1 agent returned results → skip cross-check; the Tier 1 URL check still runs

## Output format

### Confidence Scoring

This table is the one definition of the four tags; every mode tags against it.

| Tag | Meaning | Criteria |
|-----|---------|----------|
| `[HIGH]` | Independently confirmed | Confirmed by something other than the agent that first reported it: a second vendor's agent (Standard, Extensive explorers), a verifier (Extensive, Deep), or a fetched source that states it (WebFetch, document, the venue's own page) |
| `[MED]` | Reported, not independently confirmed | One agent's finding, plausible, with no second source; or some sub-claims confirmed and others unverifiable |
| `[LOW]` | Unverified | No confirmation found, contradicted by other sources, or a Grok-only finding not yet confirmed elsewhere |
| `[CONFLICT]` | Sources disagree | Two or more agents or sources made contradictory claims on this topic; both sides are shown |

**Default:** Missing confidence metadata = `[LOW]` (safe default). A `[HIGH]` whose only supporting URL is removed by the URL check drops to `[MED]`.

**Conflict output format:**
```
⚠️ CONFLICT on [topic]:
  Agent A (ClaudeResearcher): [claim] — [source]
  Agent B (GeminiResearcher): [claim] — [source]
  Resolution: [Unresolved | Resolved by Agent C | Resolved by source priority]
```

## References

The explorer-verifier pattern and the independence rule come from Nomad (arXiv:2603.29353), §3.7: "The verifier operates independently from the explorer. It does not have access to the explorer's reasoning, and only receives the final claims for evaluation."

### Integration Points

This intent is designed to be called by:
- **ExtensiveResearch.md** — 2 of 9 agents run as Tier 3 verifiers
- **DeepInvestigation.md** — Tier 2 verification between Investigate and Progress Check
- **StandardResearch.md** — Tier 1 inline during synthesis
- **Upgrade** — Can call Verify.md to validate upgrade recommendations
