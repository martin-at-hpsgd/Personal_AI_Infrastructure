---
name: Research
evals:
  manual:
    reason: "research quality depends on whether sources support the requested claims and the synthesis represents uncertainty honestly"
    falsifier: "the reviewer finds a cited source does not support its claim, a material counter-source is omitted, or confidence is overstated"
metadata:
  short-description: "Find, identify, and investigate topics or products with multi-source agents and verified URLs. Use ArXiv for papers and ExtractWisdom for insights."
version: 1.8.0
description: Multi-agent web research with verified URLs and confidence-tagged output at four depths. USE WHEN research, do research, quick research, extensive research, deep investigation, find information, investigate, extract alpha, analyze content, retrieve content, AI trends, enhance content, extract knowledge, web scraping, YouTube extraction, map landscape, competitive analysis, find it, find this, find this product, identify this, what is this, what's that thing, track down, locate, help me find, I can't find X online, can't find it online, source this, best X in a place, what's good in <city>, trip or itinerary planning, things to do, is X open, hours, where is X, venue or resort policies — never substitute raw WebSearch/WebFetch for a find/identify/investigate/look-up request. NOT FOR entity background, papers (ArXiv), JSON entity extraction, wisdom extraction (ExtractWisdom), raw page fetching or crawling (BrightData).
---

# Research

**Contents:** Ideal State · Intent Routing · Tool contract · Output format · Data & Config · Gotchas · References

Researches a topic across multiple sources and verifies every claim before delivery. Four depth modes scale from a single fast lookup to a multi-session investigation: Quick (1 Perplexity call, ~10-15s), Standard (four vendors cross-checked as parallel tool calls in the session, ~30-60s), Extensive (7 explorers + 2 independent verifiers, ~60-90s), and Deep Investigation (progressive iteration with a persistent vault, ~3-60min). Output is confidence-tagged: [HIGH] [MED] [LOW] [CONFLICT].

A lone research agent fails in two quiet ways. It hallucinates URLs, confident links that go nowhere and cost the whole report its trust. And it answers from one angle, parroting the first few search results and missing conflicts, gaps, and what real people thought; asked "what did fans think of X", it hands back promoter copy dressed as consensus. This skill runs several vendors in parallel (as tool calls at Quick and Standard, as researcher agents at Extensive and Deep), cross-checks and independently verifies their findings, checks every URL before it ships, and routes sentiment questions to community sources first.

**Vendor diversity scales with effort.** Quick is one vendor, Standard four, Extensive and Deep all five. Each vendor's model comes from a different training distribution, so the more a question is worth, the more independent distributions check it.

## Ideal State

- Every URL in a delivered answer was fetched and its page supports the claim it is cited for; a link that could not be verified was dropped, never shipped.
- The depth matches the ask: "research" alone ran Standard, Quick ran only on an explicit quick request or an everyday look-up, and each tier's vendor roster was complete (a higher tier never drops a vendor a lower tier uses), or the answer says which slot was swapped and why.
- Findings carry `[HIGH]` `[MED]` `[LOW]` `[CONFLICT]` tags from cross-checking, and a disagreement between sources is shown with both sides rather than averaged away.
- A sentiment or lived-experience answer rests on the communities first (each platform's official API, then a licensed data product only where the platform has no API, then web search for context), quotes people verbatim with their thread URLs, and carries the disappointments alongside the praise.
- A claim that a venue exists, is open, keeps certain hours, or books a certain way matches the official page of the venue or its host property.
- A request this skill should not own left it: entity background to an OSINT skill, papers to ArXiv, an X URL through the X-URL gate with the path taken named in the answer.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **QuickResearch** | "quick research", "minor research", everyday look-ups (venue, hours, travel, best-of); 1 Perplexity call, 1 query, no agent | `Intents/QuickResearch.md` |
| **StandardResearch** | "research", "do research", "research this": the DEFAULT; Claude + Gemini + Perplexity + OpenAI/Codex cross-checked as parallel tool calls in the session, no agents; + Grok when X is a plausible source | `Intents/StandardResearch.md` |
| **ExtensiveResearch** | "extensive research", "deep research", "comprehensive research"; all five vendors, 7 explorers + 2 verifiers, + a community slot on lived-experience questions | `Intents/ExtensiveResearch.md` |
| **DeepInvestigation** | "deep investigation", "investigate [topic]", "map the [X] landscape"; progressive deepening into a persistent vault, loop-compatible | `Intents/DeepInvestigation.md` |
| **DeepVerifiedResearch** | deep verified or fact-checked research: claim-level adversarial verification, the slowest tier (Tool contract below) | `Intents/DeepVerifiedResearch.mjs` |
| **Verify** | Verify research findings / cross-check claims / confidence scoring | `Intents/Verify.md` |
| **ExtractAlpha** | Extract alpha / deep analysis / highest-alpha insights | `Intents/ExtractAlpha.md` |
| **Retrieve** | Difficulty accessing content (JavaScript-rendered pages, multi-page pulls, a site that refuses automated access) | `Intents/Retrieve.md` |
| **YoutubeExtraction** | YouTube URL extraction (use `fabric -y URL` immediately) | `Intents/YoutubeExtraction.md` |
| **WebScraping** | Web scraping | `Intents/WebScraping.md` |
| **ClaudeResearch** | Claude WebSearch only (free, no API keys) | `Intents/ClaudeResearch.md` |
| **InterviewResearch** | Interview preparation (surprise-maximizing questions, style from PREFERENCES.md) | `Intents/InterviewResearch.md` |
| **AnalyzeAiTrends** | AI trends analysis | `Intents/AnalyzeAiTrends.md` |
| **Fabric** | Use Fabric patterns (242+ specialized prompts); "enhance content" or "improve this" runs `improve_writing` here | `Intents/Fabric.md` |
| **ExtractKnowledge** | Extract knowledge from content | `Intents/ExtractKnowledge.md` |

| File | Read when |
|------|-----------|
| `SourceRoutingProtocol.md` | Step 0 of every research intent: the sentiment, technical and discourse signals, the per-platform API → vendor data product (no-API platforms only) → web-search cascade, and the sentiment-mode output shape |
| `UrlVerificationProtocol.md` | before delivering any URL: the one verifier, `Tools/VerifyUrls.ts`, which checks each URL's body for the key phrase its citation rests on; `bun test ./skills/Research/Tests` is its self-test |
| `QuickReference.md` | comparing modes: roster, speed, and the verification each mode adds |
| `Setup.md` | first-time setup: the vendor accounts and keys each depth uses, the optional community sources, and a read-only check || `Intents/research.mjs` | EXPERIMENTAL deterministic port of Standard + Extensive, not a route: no real research goes here until a smoke run lands (Tool contract below) |
| `References/WorkflowScripts.md` | explaining DeepVerifiedResearch voting, running the `research.mjs` smoke test, or changing the orchestration (rosters, verifiers, voters; holds the Anthropic drift check) |
| `References/Examples.md` | unsure which intent a request lands on (worked examples) |
| `Templates/` | DeepInvestigation domain packs: `Templates/MarketResearch.md` (Companies, Products, People, Technologies, Trends, Investors) and `Templates/ThreatLandscape.md` (Threat Actors, Campaigns, TTPs, Vulnerabilities, Tools, Defenders); with no match the intent builds entity categories from the landscape research |

## Tool contract

Verification runs in three layers, inspired by Nomad (arXiv:2603.29353). `Intents/Verify.md` holds the full protocol.

| Layer | What | Where |
|-------|------|-------|
| **Self-Verification** | Each researcher agent drops URLs it cannot reach and tags confidence before returning; this is a pre-filter, never the verification of record, and every delivered URL still passes `Tools/VerifyUrls.ts` (`UrlVerificationProtocol.md`) | Extensive, Deep (Quick and Standard run no agents) |
| **Cross-Check** | Synthesis step detects conflicts and cross-references findings | Standard, Extensive, Deep |
| **Independent Verification** | Dedicated verifier agents with no access to explorer reasoning | Extensive, Deep only |

**DeepVerifiedResearch** runs through the `Workflow` tool: `Workflow({scriptPath: 'skills/Research/Intents/DeepVerifiedResearch.mjs', args: {question: '...'}})`, with `args` passed as an object, never a JSON string. It is slower than Extensive (~150-190s vs ~60-90s); reach for it only when claims must be bulletproof. Its votes judge each claim on the explorer's quote and never fetch the page, so its result returns `urlVerification: pending` with `urlCheckPairs`; run those through `Tools/VerifyUrls.ts` before delivering any of its URLs.

**`Intents/research.mjs`** is EXPERIMENTAL and not a route until one smoke run lands (command in `References/WorkflowScripts.md`); `StandardResearch.md` and `ExtensiveResearch.md` stay the default path.

## Output format

- Findings carry `[HIGH]` `[MED]` `[LOW]` `[CONFLICT]` tags; sentiment-routed answers use the tier-of-agreement shape in `SourceRoutingProtocol.md` § Output Format When Sentiment-Routed.
- Working files (temporary work artifacts) go in the current work item directory, `~/.claude/LIFEOS/MEMORY/WORK/{current_work}/`, which ties them to the work item for learning and context.
- Research artifacts (permanent) go in `~/.claude/LIFEOS/MEMORY/RESEARCH/YYYY-MM/YYYY-MM-DD_[topic]/`.

## Data & Config

Before executing, check for user customizations at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Research/` (configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). When the directory exists, its PREFERENCES.md, configurations and resources override the defaults here; when it does not, the skill defaults stand.

First-time setup (vendor accounts, keys, the `codex` tool) is in [Setup.md](Setup.md).

## Gotchas

- **X/Twitter-URL gate, checked before anything else.** Scan the prompt for `x\.com|twitter\.com` (e.g. `rg -q 'x\.com|twitter\.com'` on the request text) before spawning any research agents. X blocks WebFetch and generic scraping, so generic research agents pointed at the URL burn turns and return nothing. When the gate fires, take the first path below that is actually available, and say in the response which path you took and why; a silent skip is a failure:
  1. A dedicated X/Twitter reader skill, if one is installed — it is the highest-fidelity path.
  2. `X_BEARER_TOKEN` in the environment → read the post via X API v2 directly.
  3. The principal's own exported X data, if provided.
  4. None of the above → tell the user plainly that X does not allow automated reads here and ask them to paste the post text. Then research the *substance* normally.
  Research the rest of the request either way: one unreadable X URL never cancels the whole task.
- **Recap journalism is not fan sentiment.** Press articles invent consensus, fabricate timestamps, and parrot promoter copy, so on a community-sentiment question X goes through the X-URL gate ladder above and recap web search stays the *secondary* source. Quick mode can return recap-only and miss the actual fan data; pull Reddit directly rather than waiting to be asked again.
- **API first, a licensed data product second where there is no API, web search last; never invert.** For every platform, try the official API path (Reddit JSON, X API v2 if `X_BEARER_TOKEN` is set, YouTube Data API v3 if `YOUTUBE_API_KEY` is set) before a vendor data product (BrightData, or a data-product skill the install carries). A vendor product is the fallback for platforms with no API, within each platform's terms; for Reddit and X, when the API path is unavailable or rate-limited, the run reports it rather than switching routes. A vendor product also covers data shapes the API does not expose (YouTube transcripts use `fabric -y` even when the Data API key is set). The cascade inversion is the recurring failure mode. `SourceRoutingProtocol.md` § Cascade Priority has the per-platform table.
- **A refused page is reported, not worked around (principal, 2026-10-12, revised).** A 403, a bot wall, a CAPTCHA or a login wall on a cited source means the site does not allow automated access. The run tags that finding unverified, names the URL and the reason in the response, and looks for the same fact in another source, the site's official API, or a copy the principal can open. A page that only fails because it renders client-side is read in a real browser through Interceptor. Paid vendor products (Bright Data, Apify actors) need the principal's yes first, except a single cheap call, and are used within the target site's terms.
- **Everyday look-ups are research too, and route to Quick (2026-09-30).** Some questions never say "research": "best <thing> in <place>", "a plan for our trip", "can non-guests use <venue>'s facilities", "where is this venue". Sent to raw WebSearch, single-summary answers put wrong claims in a plan that a Quick run caught (closed days, departed staff, changed booking channels). Unless the principal asks for depth, treat a travel, venue, or best-of question as Quick mode.
- **For "does it exist / is it open", the venue's own page wins (2026-09-30).** A single search answer can deny a venue that its host property's own page lists. When a claim is about whether a venue exists, its hours, or how to book, check the official site of the venue or its host property before stating it.
- **An Extensive run with only Anthropic, Google and Perplexity agents is a failed roster (2026-09-26).** A run left OpenAI and Grok out because both were gated on narrow technical/discourse signals. Every vendor runs at the top tier. Grok's brief stays public-only; when the question carries Restricted Data, its slot becomes a Claude slot and the response says so.
- **Due diligence, background checks and people lookup go to a dedicated OSINT/entity-investigation skill, not Research.** Research handles general investigation; entity-specific deep investigation belongs to that skill.
- **"extract alpha" routes to the ExtractAlpha intent, not the ExtractWisdom skill.** They are different things.
- **`DeepVerifiedResearch.mjs` is a Workflow-tool script, not a markdown intent.** Invoke it with the `Workflow` tool (`scriptPath`), never by reading it and "doing the steps": dedup, fetch-budget, vote-counting, and the abstention guard exist to run deterministically in code. Running it spawns many agents and live web calls, so it is opt-in multi-agent: confirm with the principal (or use `args.test: true` for a small smoke run) rather than firing a full ~30–95-agent run unprompted.

## References

- Skills this one uses: **BeCreative** (deep thinking for extract alpha), **BrightData** (single-URL fetches, crawls and search results through the vendor's documented products).
