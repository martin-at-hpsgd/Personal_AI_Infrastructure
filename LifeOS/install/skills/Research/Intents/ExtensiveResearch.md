# ExtensiveResearch

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Output format

A verified, confidence-tagged research report from 7 explorers and 2 blind verifiers across all five vendors, plus community voices when lived experience matters.

## Ideal State

- The report draws on all five vendors (Claude, Gemini, OpenAI/Codex, Grok, Perplexity), each contributing at least one of the 7 explorers + 2 verifiers; a roster missing OpenAI or Grok is incomplete unless the response names why (Grok swapped out because the question carried Restricted Data).
- The verifiers worked blind to the explorers: their prompts are topic-level, and they had no access to explorer reasoning, only the topic and their own research.
- Seven unique explorer angles, each a diverse research direction, and the two verification angles existed before any agent launched.
- When the request carries a sentiment or lived-experience signal, the report also quotes real people's experiences from Reddit and X with URLs, alongside the nine agents' findings.
- Every explorer finding is cross-referenced against the verifier results, its confidence set by the synthesis rules in the Tool contract, and every conflict between explorers or with verifiers shows both sides.
- Every delivered URL passed the verifier in `../UrlVerificationProtocol.md` (the page body checked against the key phrase its citation depends on, not only by status), and a URL that does not support its claim was dropped.
- The report arrives within the 120-second hard timeout with non-responsive agents named, and both the saved report and the returned answer carry what Output format names, research metrics included.

## Anti-criteria

- Community slots never replace the vendor roster; both verifiers stay when they run.
- Grok's brief never carries anything but public material; when the question carries Restricted Data its slot becomes a ClaudeResearcher slot and the response says so.
- No finding is promoted to `[HIGH]` when the verifiers timed out.
- No URL is delivered when its page does not support the claim it is cited for.

## Inputs

- User says "extensive research" or "do extensive research"
- Deep-dive analysis needed
- Comprehensive multi-domain coverage required

## Tool contract

**Mode:** 7 explorers + 2 verifiers across all five vendors (Claude, Gemini, OpenAI/Codex, Grok, Perplexity) | + community slot on lived-experience questions | **Timeout:** 120 seconds

The explorer-verifier split follows Nomad (arXiv:2603.29353): **7 explorers** for breadth, **2 verifiers** for trustworthiness.

```
All 9 agents launch simultaneously in one message.
Verifier prompts are topic-level (not claim-level) so they work without explorer results.
Synthesis cross-references explorer findings against verifier findings with confidence tags.
```

Agents pre-filter their URLs before returning (see agent Self-Verification sections). That pre-filter verifies nothing: every URL that reaches the synthesis goes through `../UrlVerificationProtocol.md` (`Tools/VerifyUrls.ts`) before delivery.

**Source routing check** (`../SourceRoutingProtocol.md`): scan the user's request for sentiment or lived-experience signals: "fans thought", "ratings of", "best | worst | favorite", "reactions to", "consensus on", event + recent date, or any question whose answer depends on what people who tried it experienced (patients, users, owners, customers choosing between providers or products).

- **Signal fires → add community slots (never replace the vendor roster).** Walk the API-first cascade in `../SourceRoutingProtocol.md`:
  - **Slot A (Reddit, Tier-1 API):** general-purpose subagent calls the Reddit JSON API via Bash + `curl -A "LifeOS-Research/1.0"` against 2-4 relevant subreddits (`search.json?q=…&restrict_sr=1&sort=top&t=all` for evergreen questions, `top.json?t=week` for events). If the API rate-limits or returns 403, report it. Returns verbatim quotes with thread URLs and scores. Persist raw JSON to `MEMORY/RESEARCH/{date}_{slug}/`.
  - **Slot B (X / Twitter):** use the installed X reader/search skill if one exists (check local skills first); otherwise X API v2 recent-search with `X_BEARER_TOKEN` in an `Authorization` header. Slots A and B may share one agent.
  - **Slot C (YouTube, optional):** Data API v3 if `YOUTUBE_API_KEY` is set; otherwise `fabric -y` on the top 3 videos, with comments reported as a gap.
- **No signal → the nine-agent roster below, unchanged.**

Verification angles: "verify the most important claims about [topic]" and "find contradictory evidence about [topic]". When the source routing signal fired, the community slot(s) launch in the same message as the nine agents below.

**One message launching all agents:**

```typescript
// === EXPLORERS (7 agents, five vendors) ===

// Claude - 2 threads (academic depth, strategic analysis)
Agent({ subagent_type: "ClaudeResearcher", description: "[topic] angle 1", prompt: "Search for: [angle 1]. Tag each finding with confidence: [HIGH], [MED], or [LOW]. Return findings." })
Agent({ subagent_type: "ClaudeResearcher", description: "[topic] angle 2", prompt: "Search for: [angle 2]. Tag each finding with confidence: [HIGH], [MED], or [LOW]. Return findings." })

// Gemini - 2 threads (multi-perspective, cross-domain)
Agent({ subagent_type: "GeminiResearcher", description: "[topic] angle 3", prompt: "Search for: [angle 3]. Tag each finding with confidence: [HIGH], [MED], or [LOW]. Return findings." })
Agent({ subagent_type: "GeminiResearcher", description: "[topic] angle 4", prompt: "Search for: [angle 4]. Tag each finding with confidence: [HIGH], [MED], or [LOW]. Return findings." })

// OpenAI - 1 thread (primary sources: studies, official data, docs)
Agent({ subagent_type: "CodexResearcher", description: "[topic] angle 5", prompt: "Search for: [angle 5 — primary-source angle]. Tag each finding [HIGH]/[MED]/[LOW] with a verified URL. Return findings." })

// Grok - 1 thread (what's being said on X). PUBLIC material only in the brief;
// if the question carries Restricted Data, make this a ClaudeResearcher slot and say so in the response.
Agent({ subagent_type: "Grok", description: "[topic] angle 6", prompt: "Research this PUBLIC question: [angle 6 — current discourse and practitioner chatter on X]. Cross-check with WebSearch/WebFetch, verify every URL, tag each finding [HIGH]/[MED]/[LOW]. Return findings." })

// Contrarian - 1 thread (counter-consensus, fact-based)
Agent({ subagent_type: "ClaudeResearcher", description: "[topic] angle 7", prompt: "Search for: [angle 7 — contrarian/counter-consensus framing]. Prefer durable facts over trending narrative. Tag each finding with confidence: [HIGH], [MED], or [LOW]. Return findings." })

// === VERIFIERS (2 agents) ===
// These independently check the most important claims about the topic.
// They have no access to explorer reasoning — only the topic and their own research.

Agent({ subagent_type: "PerplexityResearcher", description: "verify [topic] claims", prompt: "Independently verify the most commonly cited facts, statistics, and claims about [topic]. For each claim you find, check if it's supported by primary sources. Tag each as [HIGH] (confirmed), [MED] (plausible), or [LOW] (unconfirmed). Focus on quantitative claims and dates — these are most likely to be wrong." })
Agent({ subagent_type: "ClaudeResearcher", description: "find contradictions about [topic]", prompt: "Search for contradictory evidence, debunked claims, and common misconceptions about [topic]. What do people get wrong? What's the contrarian view with evidence? Tag each finding with confidence: [HIGH], [MED], or [LOW]." })
```

Each agent gets one focused angle and returns as soon as it has findings. **Hard timeout: 120 seconds**, then proceed with whatever has returned.

**Synthesis rules:**

- **Upgrade/downgrade confidence** (tags as defined in `Verify.md` § Output format): Explorer claim `[MED]` + verifier confirmed → `[HIGH]`. Explorer claim `[HIGH]` + verifier contradicted → `[CONFLICT]`
- **URL check:** every remaining URL goes through the verifier in `../UrlVerificationProtocol.md`; an UNSUPPORTED result is unverified until the page itself has been read, and a URL that does not support its claim is dropped.

Results take ~60-90 seconds; the verifiers run in parallel with the explorers.

When agents or checks fail:

- If verifier agents time out → follow the timeout rule in `Verify.md` § Graceful Degradation, and report the findings as not verifier-checked
- If only 1 explorer returns → skip cross-check; the URL check still runs
- If the parallel URL check fails → the sequential fallback in `../UrlVerificationProtocol.md`

## Output format

**Saved report** (the research artifact under `MEMORY/RESEARCH/`):
```markdown
## Executive Summary
[2-3 sentence overview]

## Verified Findings
### [Theme 1]
- [HIGH] Finding (confirmed by: explorer + verifier)
- [MED] Finding (single source, not independently verified)

### [Theme 2]
- [HIGH] Finding (multiple explorers agree)
- [CONFLICT] Finding A vs Finding B (see Conflicts section)

## Unique Insights by Source
- **Claude**: [analytical depth + contrarian perspectives]
- **Gemini**: [cross-domain connections]
- **OpenAI/Codex**: [primary-source findings]
- **Grok**: [X discourse, LOW until confirmed]
- **Community**: [verbatim experiences from Reddit/X, when the slot ran]
- **Verifiers**: [what was confirmed/refuted]

## Conflicts & Low-Confidence Items
⚠️ CONFLICT on [topic]:
  Explorer (ClaudeResearcher): [claim] — [source]
  Verifier (PerplexityResearcher): [contradicting claim] — [source]
  Status: Unresolved

📉 LOW CONFIDENCE:
- [claim] — could not independently verify
```

**The returned answer.** The response shape is the system output format; the content carries:

- The synthesized answer first, by theme, with confidence tags.
- Each conflict and each low-confidence item, with both sides and their sources.
- Verbatim community experiences with URLs, when the community slot ran.
- The path to the saved report.
- Research metrics:

```markdown
📈 RESEARCH METRICS:
- Total Agents: 9 (7 explorers + 2 verifiers) + N community
- Explorer Types: Claude(3), Gemini(2), Codex(1), Grok(1)
- Verifier Types: Perplexity(1), Claude(1)
- Findings: N HIGH | N MED | N LOW | N CONFLICT
- URLs verified: N/N
```
