# Debate

**Contents:** Ideal State · Anti-criteria · Inputs · Output format · Tool contract

A full structured multi-agent debate on one topic: three rounds and a visible round-by-round transcript ending in a council synthesis.

## Ideal State

- The transcript shows the full intellectual journey in order: the council header, Round 1 initial positions, Round 2 responses and challenges, Round 3 synthesis, then the Council Synthesis, each in the shape under Output format.
- Every round-2 and round-3 turn answers a prior member by name, taking up their actual point rather than restating its own opening; a debate where round 2 could swap with round 1 unnoticed produced no friction and added nothing.
- At least one member's stance shifts or sharpens under pressure; if all four agreed from the start and stayed there, the topic didn't warrant a council.
- The synthesis resolves rather than summarizes: it names the surviving position, the strongest objection still unanswered against it, and what evidence or change would flip the verdict.

## Anti-criteria

- No forced consensus: remaining disagreements are stated, because forced consensus is worse than acknowledged tension.

## Inputs

- Topic or question to debate
- Optional: Custom council member descriptions (otherwise written for the topic)

## Output format

Post each round as its responses complete. Every member answer follows `OutputFormat.md` § Output Requirements.

```markdown
## Council Debate: [Topic]

**Council Members:** [List member names with their one-line role descriptions]
**Rounds:** 3 (Positions -> Responses -> Synthesis)

### Round 1: Initial Positions

**[Agent 1 Name] ([trait description]):**
[Response]

**[Agent 2 Name] ([trait description]):**
[Response]

**[Agent 3 Name] ([trait description]):**
[Response]

**[Agent 4 Name] ([trait description]):**
[Response]

### Round 2: Responses & Challenges

**[Agent 1 Name]:**
[Responds to specific points from Round 1]

**[Agent 2 Name]:**
[Responds to specific points from Round 1]

[...]

### Round 3: Synthesis

**[Agent 1 Name]:**
[Final position, areas of agreement/disagreement]

[...]

### Council Synthesis

**Areas of Convergence:**
- [Points where 3+ agents agreed]
- [Shared concerns or recommendations]

**Remaining Disagreements:**
- [Points still contested between agents]
- [Trade-offs that couldn't be resolved]

**Recommended Path:**
[Based on convergence and weight of arguments, the recommended approach is...]
```

## Tool contract

Write four different member briefs tailored to the topic and run each as a direct call, split across vendors, at `--level high` (`max` when depth was asked for). All four run in parallel within a round (`CouncilMembers.md` § Launch). Each member's prompt is its brief plus the block for that round; rounds 2 and 3 carry the transcript so far.

### Round 1

```
COUNCIL DEBATE - ROUND 1: INITIAL POSITIONS

Topic: [The topic being debated]

[Full topic context — include relevant background, data, quotes, etc. that the agent needs to form an informed opinion]

Give your initial position on this topic from your specialized perspective.
- Speak in first person as your character
- Be specific and substantive (100-150 words)
- State your key concern, recommendation, or insight
- You'll respond to other council members in Round 2
```

### Round 2 (carries the Round 1 transcript)

```
COUNCIL DEBATE - ROUND 2: RESPONSES & CHALLENGES

Topic: [The topic being debated]

Here's what the council said in Round 1:
[Full Round 1 transcript]

Now respond to the other council members:
- Reference specific points they made ("I disagree with [Name]'s point about X...")
- Challenge assumptions or add nuance
- Build on points you agree with
- Maintain your specialized perspective
- 100-150 words

The value is in genuine intellectual friction -- engage with their actual arguments.
```

### Round 3 (carries the Round 1 + Round 2 transcripts)

```
COUNCIL DEBATE - ROUND 3: SYNTHESIS

Topic: [The topic being debated]

Full debate transcript so far:
[Round 1 + Round 2 transcripts]

Final synthesis from your perspective:
- Where does the council agree?
- Where do you still disagree with others?
- What's your final recommendation given the full discussion?
- 100-150 words

Be honest about remaining disagreements -- forced consensus is worse than acknowledged tension.
```

A full debate usually takes a few minutes, and longer when the topic runs deep. This describes typical runs; it is not a cutoff.
