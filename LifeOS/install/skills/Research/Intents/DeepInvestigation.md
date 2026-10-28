# DeepInvestigation

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Output format · References

A persistent research vault on a domain, built by progressive deepening: broad landscape, scored entity catalog, one deep-dive profile per iteration, until coverage gates pass.

## Ideal State

- All state lives in the vault on disk, and each run does what the vault's state calls for in the Resumption table under Tool contract (first iteration, continuation, or exit), so the intent stays stateless.
- On the first iteration, LANDSCAPE.md (from the Extensive Research pattern over the landscape angles), ENTITIES.md and INDEX.md exist in the Output format shapes before any entity deep-dive; the domain template pack, or the closest one, set the entity categories, or they were created dynamically from the landscape research when none matched.
- Every PENDING entity without a VALUE score carries VALUE and EFFORT scores in ENTITIES.md, and investigation follows the priority order.
- No category stays under 3 entities without a targeted discovery pass of 2-3 agents, and what that pass finds is in ENTITIES.md as PENDING and scored.
- Each deep dive produced one comprehensive profile of the highest-priority PENDING entity from the category's profile template, saved under its category, cross-linked to related entities, with ENTITIES.md marking it RESEARCHED with a profile link and INDEX.md listing it in navigation.
- In iterative mode, before the progress check, the profile's 2-3 most important quantitative claims (numbers, dates, percentages) were verified via a quick WebSearch or WebFetch, verified claims tagged `[HIGH]`, unverifiable claims `[LOW]`, and disagreements between agents noted as `[CONFLICT]`; in single-run mode that verification happens at the end when reviewing the full vault.
- Each run reports the Breadth and Depth gate result; when both pass, SUMMARY.md exists and INDEX.md carries the final statistics, and a single-run reports what was accomplished and what remains PENDING for a future iterative-mode run.
- The finished vault is self-contained, every profile cross-linked, and readable as a standalone knowledge base.

## Anti-criteria

- The intent never controls the loop: it reports pass/fail and the Algorithm decides whether to iterate.
- The landscape phase, the expensive one, never runs again after the first iteration; later iterations reference it cheaply.
- No iteration deep-dives more than one entity: quality over quantity.

## Inputs

**Mode:** Iterative progressive research | **Single-run or Iterative mode**

- User says "deep investigation", "investigate [topic]", "deep research on [market/landscape/domain]"
- Competitive analysis, market mapping, threat landscape, technology survey
- Any research that benefits from **iterative deepening** — broad discovery first, then progressively deeper dives on the most important entities
- User explicitly requests iterative mode research

## Safety gates

Before delivering any result with URLs, every URL goes through the verifier in `../UrlVerificationProtocol.md`, which checks the body for the key phrase the citation rests on; an unverified URL is never included, because research agents invent plausible ones.

## Tool contract

This intent implements a **progressive narrowing funnel**:

```
Iteration 1: Broad landscape → discover entities → score them → deep-dive the top one
Iteration 2: Read previous artifacts → pick next highest-value entity → deep-dive
Iteration 3+: Continue until coverage gates pass
```

**Single-run mode:** Completes one full cycle (landscape through first deep dive).
**Iterative mode:** The Algorithm's loop mechanism drives iterations.

All artifacts persist at:
```
~/.claude/LIFEOS/MEMORY/RESEARCH/{YYYY-MM}/{YYYY-MM-DD}_{topic-slug}/
```

**Resumption** (what the vault on disk says this run does):

| Vault state | This run |
|---|---|
| Neither LANDSCAPE.md nor ENTITIES.md exists | First iteration: landscape, then evaluate, discover and the first deep dive |
| PENDING entities with CRITICAL/HIGH value in ENTITIES.md | Continuation: deep-dive the next one |
| All CRITICAL/HIGH done, some category under 3 entities | Continuation: discover for the thin categories |
| Both coverage gates pass | Exit: report completion |

**Domain template pack:** `Templates/{domain}.md` matched to the user's topic (see References). The packs name phases by their old step numbers: Step 1 is the landscape, Step 3 entity discovery, Step 4 the entity deep dive.

**Launch Extensive Research (7 explorers + 2 verifiers = 9 agents):**

```
Use the Extensive Research pattern (7 explorers + 2 verifiers):

Angles should cover:
- Market/domain overview and structure
- Key players and competitive dynamics
- Recent developments and trends
- Historical context and evolution
- Adjacent domains and cross-cutting themes
- Contrarian views and underappreciated dynamics
```

**Priority Order for Investigation:**
1. CRITICAL + EASY (highest ROI)
2. CRITICAL + HARD (must-have despite difficulty)
3. HIGH + EASY (good ROI)
4. HIGH + HARD (worthwhile if time allows)
5. MEDIUM+ only after all CRITICAL/HIGH done

Check ENTITIES.md for categories with fewer than 3 entities. For each thin category:

**Launch 2-3 targeted researcher agents:**
```
Agent({
  subagent_type: "PerplexityResearcher",
  prompt: "Find 3-5 notable {entity_category} in the {domain} space.
           For each: name, one-line description, why they matter.
           Already known: {list existing entities in this category}.
           Find NEW ones not in that list."
})
```

**Launch focused research (3 agents, entity-specific — 4 when the entity is technical):**

> If the technical signal in `../SourceRoutingProtocol.md` fires (the entity is a framework, protocol, runtime, API, or tool rather than a person/company), add a `CodexResearcher` slot. Different vendor, so it breaks the Claude-family agreement on version numbers, flags, and API contracts — the exact facts a same-family pair gets confidently wrong together.

```
Agent({
  subagent_type: "ClaudeResearcher",
  prompt: "Deep research on {entity_name} in the context of {domain}.
           Focus on: {template_fields_for_this_category}
           Context: {1-paragraph from LANDSCAPE.md about this entity's category}
           Tag each finding with confidence: [HIGH], [MED], or [LOW].
           Return comprehensive findings organized by the template fields."
})

Agent({
  subagent_type: "PerplexityResearcher",
  prompt: "Find recent information about {entity_name}:
           latest news, funding, product launches, key hires, partnerships.
           Focus on developments in the last 12 months.
           Tag each finding with confidence: [HIGH], [MED], or [LOW]."
})

Agent({
  subagent_type: "GeminiResearcher",
  prompt: "Research {entity_name}: competitive position, strengths, weaknesses,
           how they compare to {list 2-3 related entities from ENTITIES.md}.
           What makes them distinctive in the {domain} landscape?
           Tag each finding with confidence: [HIGH], [MED], or [LOW]."
})
```

Profiles save to `vault/{Category}/{entity-slug}.md` and reference related entities with `Entity Name` links.

**Both gates must pass to exit:**

**Breadth Gate:**
```
For each entity category defined in LANDSCAPE.md:
  Count entities with status != SKIP
  PASS if count >= 3 for ALL categories
  FAIL if any category has < 3 entities
```

**Depth Gate:**
```
For all entities with VALUE = CRITICAL or HIGH:
  Count with status = RESEARCHED or SKIP
  PASS if ALL are RESEARCHED or SKIP
  FAIL if any are still PENDING
```

Both gates passing → SUMMARY.md (executive synthesis of all findings) and completion reported to the Algorithm's VERIFY phase. Either gate failing → `Coverage incomplete` reported to the VERIFY phase, and the Algorithm's iterative mode triggers the next iteration.

| Aspect | Single-Run | Iterative Mode |
|--------|-----------|-----------|
| Iterations | 1 | Algorithm-controlled (N turns) |
| Coverage | Landscape + first deep dive | Full breadth + depth gates |
| Exit | After the first deep dive | After both gates pass |
| Best for | Quick overview + top entity | Comprehensive investigation |
| Time | 3-5 minutes | 15-60 minutes (varies by domain) |

## Output format

**Produce LANDSCAPE.md:**

```markdown
# {Topic} Landscape

## Overview
[2-3 paragraph synthesis of the domain]

## Market/Domain Structure
[Segmentation, categories, size if applicable]

## Key Dynamics
[What forces shape this domain? What's changing?]

## Entity Categories
[From domain template pack or discovered dynamically]
- Category 1: [description, estimated entity count]
- Category 2: [description, estimated entity count]
- ...

## Initial Entity Discoveries
[Entities found during landscape research — transfer to ENTITIES.md]

## Sources
[Verified URLs only]
```

**Produce ENTITIES.md:**

```markdown
# Entity Catalog

## Status Legend
- **PENDING** — Discovered, not yet researched
- **RESEARCHED** — Full profile created in vault
- **SKIP** — Evaluated as not worth deep research

## Value Legend (market/domain impact)
- **CRITICAL** — Defines the domain. Must research.
- **HIGH** — Major player. Research if time allows.
- **MEDIUM** — Notable. Research in later iterations.
- **LOW** — Minor. Skip unless specifically relevant.

## Effort Legend (information accessibility)
- **EASY** — Abundant public information
- **MODERATE** — Good web presence, some digging needed
- **HARD** — Limited public info, requires deep searching

---

| Entity | Category | Status | Value | Effort | Profile |
|--------|----------|--------|-------|--------|---------|
| [name] | [category] | PENDING | — | — | — |
```

**Produce INDEX.md:**

```markdown
# {Topic} Research Vault

**Created:** {date}
**Domain Template:** {template name}
**Status:** IN PROGRESS

## Navigation
- [Landscape](LANDSCAPE.md)
- [Entity Catalog](ENTITIES.md)

## Profiles
[Updated as profiles are created]

## Coverage
- Categories: 0/{N} complete
- Entities: 0 RESEARCHED / {N} total
- CRITICAL/HIGH: 0 RESEARCHED / {N} pending
```

**Scoring examples** for the ENTITIES.md legends: CRITICAL means market leaders and category definers, essential to understanding the domain; LOW means marginal impact. EASY means public companies with abundant documentation and press coverage; HARD means stealth-mode or minimal coverage.

After a complete investigation, the vault contains:

```
{vault}/
  INDEX.md                  — Navigation hub with coverage stats
  LANDSCAPE.md              — Broad domain analysis (created once, referenced often)
  ENTITIES.md               — Master catalog with status tracking
  SUMMARY.md                — Executive synthesis (created on completion)
  Companies/                — Entity profiles by category
    company-a.md
    company-b.md
  Products/
    product-x.md
  People/
    person-y.md
  ...
```

## References

Templates live at `~/.claude/skills/Research/Templates/{DomainName}.md`; the available packs are listed in SKILL.md § Intent Routing (the `Templates/` row). Each template pack defines:
1. **Entity categories** for this domain (what types of things to discover)
2. **Profile templates** per category (what fields to research for each type)
3. **Evaluation criteria** (what makes something CRITICAL vs LOW in this domain)
4. **Search strategies** (domain-specific search tips for researchers)
