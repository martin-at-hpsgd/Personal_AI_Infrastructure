# AdversarialValidation

Competing agents plus a critic produce a synthesis superior to any single proposal through adversarial refinement (Battle of Bots).

## Ideal State

- Competing proposals from 2-3 distinct perspectives exist before the critique, each a complete, specific and defensible solution that optimizes for its own persona's priorities and genuinely represents its perspective as a real alternative, not a strawman.
- In the three-round protocol, the proposals were produced on different vendors where possible, so they do not share one model's defaults, and the critic ran at `--level max` on the vendor that wrote the fewest proposals, so no proposal is judged only by its own lineage.
- A critique of every proposal exists before the synthesis and covers what each got right (genuine strengths, specific), what each got wrong (flaws, gaps, what it conveniently ignored, where its perspective blinds it), the uncomfortable truth none of them addressed, and which has the strongest foundation and why.
- For every proposal, the critique names at least one real flaw that would change its outcome if left unfixed, not just a nitpick, and acknowledges at least one real strength; it is harsh but fair.
- The final output is a single unified solution that addresses the valid criticisms, incorporates the best elements from each proposal, and resolves the tensions between perspectives.
- The synthesis beats every individual proposal on the flaws the critique named, rather than blending them, and the final output withstands scrutiny.
- Remaining trade-offs are acknowledged honestly, without pretending tensions are fully resolved.
- If no synthesis is clearly superior, the output says so.
- A single-prompt run outputs a brief summary of the three proposals, the key critique points, and the final synthesized recommendation with clear rationale.

## Anti-criteria

- Proposals that are too similar (not enough diversity).
- A critic that is too gentle or too destructive: the goal is truth, not destruction.
- A "synthesis" that is just one proposal with minor tweaks.
- Trade-offs handwaved away.
- A performative critique: a final solution that would read the same if the critique had never run.

## Tool contract

**Three-round protocol:**

1. Round 1, competing proposals: launch 2-3 personas in parallel to produce competing solutions, each on a different vendor where possible (`Inference.ts --vendor openai|anthropic --level high`, or an `Agent` spawn when a persona needs tools).
2. Round 2, critique: a critic reads all proposals and critiques each. Run the critic at `--level max` on the vendor that wrote the fewest proposals.
3. Round 3, collaborative synthesis: the original agents read the critique and collaborate on a final solution.

**Single-prompt run:** one prompt carries all three rounds, with Proposal A (Pragmatist): prioritizes ease of implementation and quick wins; Proposal B (Idealist): prioritizes best practices and long-term quality; Proposal C (Skeptic): prioritizes risk reduction and failure prevention.

Typical persona sets: architecture decisions — Engineer (implementation ease, maintainability), Architect (scalability, patterns, long-term), Security (attack surface, vulnerabilities); feature specs — Product (user value, simplicity), Engineer (feasibility, complexity), QA (testability, edge cases); content — Subject Matter Expert (accuracy, depth), Audience Representative (clarity, engagement), Editor (structure, flow).

## Examples

### Example: API Design Decision

**Problem:** "Design authentication flow for our new API"

**Round 1 Proposals:**

**Proposal A (Pragmatist):** JWT with 24-hour expiry, refresh tokens, standard claims. Quick to implement, well-understood pattern.

**Proposal B (Idealist):** OAuth 2.0 with PKCE, short-lived access tokens (15 min), secure token storage, audit logging. Industry best practice.

**Proposal C (Skeptic):** API keys with rate limiting, IP allowlisting, manual rotation. Minimal attack surface, easy to revoke.

**Round 2 Critique:**

- A is fast but JWT secrets are hard to rotate, 24h is too long
- B is gold standard but massive implementation overhead for current team size
- C is secure but doesn't scale to public API use case

Uncomfortable truth: None addressed the question of "what happens when we NEED to revoke all tokens immediately?"

**Round 3 Synthesis:**

Start with A's JWT approach (pragmatic), add B's short-lived tokens (15 min) and audit logging (security), implement C's emergency revocation list (skeptic's concern). Defer full OAuth until public API launch.

## References

**Related Intents:** `ParallelAnalysis.md` for stress-testing existing arguments, including the synthesized result of this intent; BeCreative's `TreeOfThoughts` intent for exploring branches before committing.
