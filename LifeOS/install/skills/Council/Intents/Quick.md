# Quick

A fast single-round council perspective check, for sanity checks and quick feedback.

## Ideal State

- The output opens with the Quick Council header and gives every member's immediate take from one single parallel round: a key concern, insight, or recommendation, direct and specific, at 30-50 words max.
- A Quick Summary closes the check with the consensus (do they generally agree, and on what), any red flags raised, and a recommendation of Proceed, Reconsider, or Need full debate.
- When the quick check reveals significant disagreement or complex trade-offs, the output recommends escalating to a full 3-round council debate.

## Anti-criteria

- Quick never turns into a full debate: it stays a single round, and complex decisions escalate to DEBATE instead.

## Inputs

- Topic or question to evaluate
- Optional: Custom council members

## Output format

```markdown
## Quick Council: [Topic]

**Council Members:** [List member names with one-line roles]
**Mode:** Single round (fast perspectives)
```

```markdown
### Perspectives

**[Agent 1 Name] ([traits]):**
[Brief take]

**[Agent 2 Name] ([traits]):**
[Brief take]

**[Agent 3 Name] ([traits]):**
[Brief take]

**[Agent 4 Name] ([traits]):**
[Brief take]

### Quick Summary

**Consensus:** [Do they generally agree? On what?]
**Concerns:** [Any red flags raised?]
**Recommendation:** [Proceed / Reconsider / Need full debate]
```

### When to Escalate

If the quick check reveals significant disagreement or complex trade-offs, recommend:

```
This topic has enough complexity for a full council debate.
Run: "Council: [topic]" for 3-round structured discussion.
```

## Tool contract

All four members run in parallel, one direct call each at `--level medium`, split across vendors (`CouncilMembers.md` § Launch). Total time is 15-30 seconds for the single parallel round.

**Each member's prompt is its brief plus:**
```
QUICK COUNCIL CHECK

Topic: [The topic]

[Relevant context for the topic]

Give your immediate take from your specialized perspective:
- Key concern, insight, or recommendation
- 30-50 words max
- Be direct and specific

This is a quick sanity check, not a full debate.
```
