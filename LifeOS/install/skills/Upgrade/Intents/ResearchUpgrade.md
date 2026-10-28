# ResearchUpgrade

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Output format · Examples

A research-backed implementation plan for one specific upgrade opportunity.

## Ideal State

- The feature was researched across authoritative sources in four lanes (official Anthropic documentation, Anthropic GitHub repositories, Anthropic blog and announcements, community usage), and the plan's Research Sources list each URL with what was learned from it.
- The analysis states what the feature does, how it works, its use cases, its limitations, and best practices; a lane that returned little is stated as "limited documentation available" rather than padded.
- The feature is mapped to the user's LifeOS architecture (skills, hooks, agents, tools, configuration), using the user context from the Upgrade intent or context gathered fresh when that is not available.
- The deliverable is a detailed implementation plan in the Output format: an executive summary with a recommendation, implementation steps, files to modify, effort estimate, dependencies, and next steps.
- For release notes, each significant feature in the latest CHANGELOG is researched and the results are compiled into one upgrade roadmap.

## Anti-criteria

- Conflicting information is never settled in favour of a lower-precedence source: official docs > GitHub > community.
- No implementation plan without research backing.

## Inputs

Accept input as:
- Feature name from Upgrade intent results
- URL (blog post, documentation, release notes)
- Video transcript excerpt
- Changelog entry

Using the user context from the Upgrade intent (or gather fresh if not available):

| LifeOS Component | Potential Impact |
|---------------|------------------|
| Skills System | New capabilities, better patterns |
| Hooks System | New triggers, better event handling |
| Agent System | New delegation patterns |
| Tools | New CLI capabilities |
| Configuration | Settings changes |

### Special Case: Release Notes Deep Dive

The source is `/release-notes` or the latest CHANGELOG; each significant feature gets its own parallel research, compiled into one roadmap.

## Tool contract

**The researcher fleet runs through `workflows/ResearchFanout.js`** (Router ISA F8): `Workflow({name: "ResearchFanout", args: {question, researchers: [{key, prompt, agentType}], tier, stakes: "public"}})`, with the researchers this intent names as the `researchers` list. The tier follows Algorithm § Routing: 3 for three or four researchers, 4 for five or more. The script fails open on a deadline, merges the findings into sourced claims, and keeps every source it could not check; the report is written from what it returns.

The four lanes run as parallel agents (`subagent_type=general-purpose`), each with its own sources and return:

| Lane | Sources | Returns |
|------|---------|---------|
| Official documentation | docs.claude.com, support.claude.com, modelcontextprotocol.io (if MCP-related) | Official description, usage examples, any caveats or limitations |
| GitHub | anthropics/claude-code (README, CHANGELOG, docs/, examples/), anthropics/anthropic-sdk-python, anthropics/anthropic-sdk-typescript, modelcontextprotocol/ repositories | Code examples, commit history mentioning feature, any discussions |
| Blog and announcements | anthropic.com/news, anthropic.com/research, Twitter/X @AnthropicAI | Announcement context, intended use cases, any demos |
| Community usage | GitHub Discussions, Stack Overflow, developer forums | Real-world usage examples, common issues, tips from practitioners |

A feature too new to be documented is researched in the GitHub lane through commits and PRs directly.

## Output format

Compile findings into structured analysis:

| Aspect | Details |
|--------|---------|
| **What It Does** | Clear explanation from official sources |
| **How It Works** | Technical implementation details |
| **Use Cases** | Documented examples and patterns |
| **Limitations** | Known constraints or caveats |
| **Best Practices** | Recommended usage patterns |

```markdown
# Upgrade Research: [Feature Name]
**Research Date:** [timestamp]

## Executive Summary
[2-3 sentences: what this is, why it matters, recommendation]

## Feature Analysis

### What It Does
[Clear explanation]

### Technical Details
[How it works under the hood]

### Use Cases
[Where and when to use it]

### Limitations
[What it can't do or edge cases]

## LifeOS Implementation

### Opportunity
[What this enables in your LifeOS setup]

### Implementation Steps
- [ ] Step 1: [specific action]
- [ ] Step 2: [specific action]
- [ ] Step 3: [specific action]

### Files to Modify
- `path/to/file.md` - [what changes]
- `path/to/another.ts` - [what changes]

### Effort Estimate
[Low/Medium/High with brief rationale]

### Dependencies
[What needs to be in place first]

## Research Sources
- [URL 1] - [what we learned]
- [URL 2] - [what we learned]

## Next Steps
- [ ] [Specific action to take]
```

## Examples

```
User: "research the context forking feature"
→ ResearchUpgrade
→ An "Upgrade Research: Context Forking" plan in the Output format, every claim traced to a URL in Research Sources, with the LifeOS files it would change
```

```
User: "deep dive on the latest release notes"
→ ResearchUpgrade, release-notes case
→ One upgrade roadmap covering each significant feature in the latest CHANGELOG
```
