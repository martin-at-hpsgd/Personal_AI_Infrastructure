---
name: Council
evals:
  manual:
    reason: "the value of a debate depends on substantive disagreement and a defensible synthesis for the supplied decision"
    falsifier: "the reviewer finds the transcript lacks relevant opposing arguments or the conclusion ignores material evidence"
metadata:
  short-description: "Run collaborative multi-agent debates with visible rounds to weigh options and find a path. Use RedTeam for adversarial attack."
version: 1.2.2
description: "Multi-agent collaborative debate producing visible round-by-round transcripts with real intellectual friction — members are topic-briefed custom agents, run as a 3-round DEBATE or a 1-round QUICK check, to find the best path. USE WHEN council, debate, multiple perspectives, weigh options, deliberate, get different views, what would experts say, pros and cons. NOT FOR pure adversarial attack (use RedTeam)."
---

# Council

Runs a multi-agent debate. Topic-briefed members discuss a topic over rounds, respond to each other's actual points, and surface insights through real intellectual friction. You get a visible round-by-round transcript plus a synthesis. DEBATE runs three rounds; QUICK runs one for a fast perspective check.

One model gives one frame and one set of blind spots, and "pros and cons" gives a flat list with no one pushing back; distinct experts who disagree on the merits expose the weak parts of an idea before you commit.

## Ideal State

- Every council is four different topic-specific member briefs, written before the first round runs, each giving a name, the member's role/expertise, the stance they hold, and what they'll push on; no member is a bare built-in agent type with no persona.
- The members are split across vendors so the debate never shares one lineage's blind spots; a member that failed or did not run on its requested vendor is named in the transcript, never silently dropped or kept.
- Every member argues from the full context the request supplied (the measured facts, files, quotes and constraints), so positions engage the actual decision rather than a generic version of it.
- Members answer each other's actual points by name, and the transcript shows that friction round by round.
- The output ends in a usable verdict (a recommended path for DEBATE, proceed / reconsider / escalate for QUICK) that states remaining disagreement instead of forcing consensus.
- The answer delivered is the finished debate; no member's work is still running when it is handed over.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **Debate** | "council", "debate", full structured debate (3 rounds, transcript + synthesis) | `Intents/Debate.md` |
| **Quick** | "quick council check", fast perspective check (1 round, initial positions only) | `Intents/Quick.md` |

| File | Read when |
|------|-----------|
| `CouncilMembers.md` | writing member briefs, default perspective slots, and the launch command (vendor split, level, no fallback) |
| `OutputFormat.md` | length, tone and naming rules for every member answer, in both intents |
| `Setup.md` | first-time setup: the OpenAI login the second vendor needs, and a read-only check |

Council is collaborative-adversarial (debate to find the best path) and produces visible transcripts; pure adversarial attack is not a Council intent — redirect to the RedTeam skill.

## Data & Config

User customizations live at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Council/` (`configRoot` is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). When that directory exists, its PREFERENCES.md, configurations and resources override the defaults here; when it is absent, the defaults stand.

First-time setup for the vendor split is in [Setup.md](Setup.md).

## Integration

**Works well with:**
- **RedTeam** - Pure adversarial attack after collaborative discussion
- **Research** - Gather context before convening the council

## Gotchas

- There is no composition tool and no trait matrix. Members are inline briefs (`CouncilMembers.md` § The brief), each run as one direct call, with an `Agent` spawn only when the member must fetch something live; in the 2026-09-18 paired probe each subagent member cost about 100k tokens of injected context and one wrapped its answer in a report about itself (`CouncilMembers.md` § Launch).
- More agents ≠ better debate. 4-6 well-briefed agents outperform 12 generic ones.

## Examples

```
User: "Council: Should we use WebSockets or SSE?"
→ Debate intent: a real-time architect, a frontend-DX advocate, an ops skeptic and a researcher
→ A 3-round transcript ending in a recommended path, the strongest objection still standing, and what would flip it

User: "Quick council check: Is this API design reasonable?"
→ Quick intent: four API-relevant members
→ One round of 30-50 word takes and a Proceed / Reconsider / Need full debate call

User: "Council: Is AI overhyped?"
→ Debate intent: an AI builder, a security skeptic, a pragmatic engineer and an evidence analyst
→ A 3-round transcript where at least one stance sharpens under challenge, with disagreements left standing
```
