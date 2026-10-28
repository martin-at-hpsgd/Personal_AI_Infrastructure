# FindSources

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Output format · Examples · References

Ranked recommendations of new sources to add to upgrade monitoring, each ready to add.

## Ideal State

- Candidates span YouTube channels, blogs and newsletters, GitHub repositories, and community resources and forums, or stay within the type or category the user named (AI Development, Agent Patterns, Tool Building, Security, Productivity).
- Every candidate's rating reflects its type's criteria: YouTube channels on content relevance to LifeOS infrastructure, update frequency (active vs dormant), content quality and depth, and unique perspective or expertise; blogs and newsletters on relevance to LifeOS goals, technical depth, update frequency, and signal-to-noise ratio; GitHub repositories on active maintenance, good documentation, patterns applicable to LifeOS, and TypeScript preferred (stack alignment).
- Every candidate carries its weighted score and the priority tier that score earns under the Output format.
- The recommendations follow the Output format: each source with its type, URL, relevance, content focus, update frequency, and a ready-to-add JSON entry, plus how to add sources.
- YouTube channels the user approves are merged into the user's `youtube-channels.json` in CUSTOMIZATIONS alongside the existing entries, and the addition is confirmed; approved non-YouTube sources are noted for the next LifeOS release per How to Add Sources.

## Anti-criteria

- No source is added before the user approves the recommendations.
- Sources are added to the USER directory, never the base skill; personal monitoring preferences stay private.

## Inputs

Source categories the user may name:

| Category | Examples |
|----------|----------|
| **AI Development** | Claude tutorials, AI coding workflows |
| **Agent Patterns** | Multi-agent systems, orchestration |
| **Tool Building** | CLI tools, MCP servers, integrations |
| **Security** | AI security, prompt injection, safety |
| **Productivity** | Developer workflows, automation |

## Safety gates

Nothing is written to `youtube-channels.json` until the user approves the recommendations.

## Tool contract

The user config is `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Upgrade/youtube-channels.json`, shape `{"channels": [...]}`. Approved channels are appended to the `channels` array and every existing entry is kept. When the file is absent it is created as `{"channels": []}` first (no base list ships).

## Output format

For each potential source, score:

| Criterion | Weight | Score (1-5) |
|-----------|--------|-------------|
| Relevance to LifeOS | 30% | |
| Content Quality | 25% | |
| Update Frequency | 20% | |
| Unique Value | 15% | |
| Stack Alignment | 10% | |

**Priority Assignment:**
- Score ≥ 4.0 → 🔥 HIGH - Add immediately
- Score 3.0-3.9 → 📌 MEDIUM - Consider adding
- Score < 3.0 → 💡 LOW - Monitor occasionally

```markdown
# New Source Recommendations
**Discovery Date:** [date]

## 🔥 HIGH PRIORITY (Add Now)

### [Source Name]
**Type:** YouTube / Blog / GitHub / Other
**URL:** [url]
**Relevance:** [Why this matters for LifeOS]
**Content Focus:** [What they cover]
**Update Frequency:** [How often they post]

**To Add:**
```json
{
  "name": "[Source Name]",
  "url": "[url]",
  "priority": "HIGH",
  "description": "[What this source covers]"
}
```

---

## 📌 MEDIUM PRIORITY (Consider)

[Similar format]

---

## 💡 LOW PRIORITY (Optional)

[Similar format]

---

## How to Add Sources

### For YouTube Channels:
Edit `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Upgrade/youtube-channels.json`; create it first if absent with `{"channels": []}` (no base list ships).

### For Other Sources:
Currently, non-YouTube sources are monitored via the base `sources.json`.
To request additions to base Anthropic monitoring, note them for next LifeOS release.
```

## Examples

```
User: "find new upgrade sources"
→ FindSources
→ Ranked recommendations across YouTube, blogs, GitHub and forums, each scored and carrying a ready-to-add JSON entry
```

```
User: "find YouTube channels about MCP servers"
→ FindSources, scoped to the Tool Building category
→ MCP-focused channels only, scored and tiered
```

```
User: "add that channel"
→ FindSources, after approval
→ The channel is merged into the user's youtube-channels.json and the addition is confirmed
```

## References

New sources feed the **Upgrade** intent's monitoring; a discovered source can go to **ResearchUpgrade** for a deep dive.
