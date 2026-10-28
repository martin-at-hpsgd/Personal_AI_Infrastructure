# Research Workflow scripts

How the two Workflow-tool scripts in `Intents/` work, and why their verification stages are built the way they are. SKILL.md § Tool contract holds the invocation and the opt-in rule; this file holds the detail a run consults when it needs to explain a result, run the smoke test, or change a script.

## DeepVerifiedResearch

**DeepVerifiedResearch** runs through the `Workflow` tool: `Workflow({scriptPath: 'skills/Research/Intents/DeepVerifiedResearch.mjs', args: {question: '...'}})`, with `args` passed as an object, never a JSON string. It does not replace Extensive; it is slower (measured ~150-190s vs Extensive's ~60-90s) because claim-level verification needs one extra serial hop: claims cannot be voted on until they are extracted. Reach for it only when claims must be bulletproof. Each extracted claim is attacked by three skeptics from different lenses (quote-support, contradiction, source-strength) and survives only on a quorum of non-refuting votes (all-abstain never survives); a written synthesis then frames the survivors with [HIGH]/[MED]/[LOW]/[CONFLICT] tags and refuted-claim transparency. Dedup, ranking, vote-counting, and the abstention guard run deterministically in the script.

### Why the voters are native Claude

**Deep-verified voters are native Claude, diverse by lens, not by vendor.** A 2026-06-02 smoke test showed the external-API LifeOS researchers (Gemini, Perplexity and Grok) do not honor the Workflow structured-output contract: schema-forced, they complete without emitting a verdict, so cross-vendor voters all abstained and every claim died 0-0. Voters are therefore native workflow agents (reliable StructuredOutput), made diverse by attack lens (quote-support / contradiction / source-strength). The same lesson applies to the search and fetch stages: keep schema-gated phases on native agents. Multi-vendor diversity belongs in `research.mjs` (text-returning researchers), not in the schema-gated verification engine. A claim survives only when a majority of the pool (2 of 3) votes refuted=false and fewer than the kill threshold refute. Refuting votes and abstentions never count toward that quorum, so all-abstain and a one-accept, one-refute, one-abstain split both die (guards the false-survive bug).

## research.mjs (experimental)

**`Intents/research.mjs`** (EXPERIMENTAL, not yet run in the harness) ports Standard + Extensive into a Workflow-tool script: fixed researcher roster, single batch URL-verify, cross-checked synthesis. It is parse-verified and contract-checked but has not had a live harness run, so `StandardResearch.md` and `ExtensiveResearch.md` stay the default path and no real research routes through the `.mjs` until one smoke run lands. The smoke run: `Workflow({ scriptPath: "skills/Research/Intents/research.mjs", args: { question: "<trivial test>", depth: "standard" } })`. Once it runs clean, drop this experimental caveat.

## Changing the orchestration

**Official anchor (drift check):** this skill's orchestrator-worker shape matches Anthropic's published architecture, [How we built our multi-agent research system](https://www.anthropic.com/engineering/built-multi-agent-research-system) (2025-06-13). When changing the orchestration itself (rosters, verifier layers, the `.mjs` ports; not on routine research runs), re-fetch that post and compare: it names lessons we may not have adopted yet (e.g. async agent coordination). Advisory only: report divergence, never auto-adopt; an unreachable URL never blocks anything.
