# CreateNarrativePoints

**Contents:** Ideal State · Anti-criteria · Output format · Inputs · Examples · References

A story-driven consulting narrative that delivers hard truths, presents evidence, establishes existential stakes, and offers a vision that demands courage to execute.

## Ideal State

- The narrative is a story with emotional arc, tension and resolution, not a bullet-point list, and it has all eight sections in order: Opening Context, The Bad News, The Evidence, The Stakes, The Pivot, The Requirements, The Vision, The Close.
- The Opening references the client's exact words/ask in their language ("you asked us"), names who is pushing for it and the underlying pressure/driver (funding raised, market pressure, growth mandate), and surfaces the real question they're afraid to ask directly.
- The Bad News is direct, with no hedging: it confirms what they suspected, escalates beyond their expectations ("it's actually worse"), and states the existential consequence plainly, with no hedge words, no qualifiers, no softening.
- The Evidence is specific and sourced: 8-12 problems (focus on the killers), each specific, not vague, each with a source (interview, data, observation), ordered by severity or logical chain, in active voice, present tense.
- The Stakes are existential, not incremental: they reference external pressure (competition, market), note the trajectory (getting worse, not better), and state the survival stakes plainly as the darkest moment of the arc.
- The Pivot provides genuine hope: a solution exists, but it demands something extraordinary, and partial execution = failure.
- The Requirements are concrete, not abstract: organizational changes (structure, reporting), behavioral changes (how leaders must act differently) and resource commitments (budget, time, attention), with the cost of the transformation made clear.
- The Vision is tangible and compelling: a concrete description of the solution architecture (visual if possible), escalating benefits (good → better → extraordinary), connected to their original goals.
- The Close assesses the opportunity, notes the timing, states the upside plainly, returns to the courage requirement and returns agency to them: they must choose.
- The overall arc has emotional movement (tension → release → agency), in the voice of tough love from a trusted advisor: direct but not cruel, honest but not hopeless, confrontational but supportive, confident but not arrogant, urgent but not panicked; it uses "you" and "your", states hard truths without softening, and backs up claims with evidence.

## Anti-criteria

- Never hedges with "maybe," "perhaps," "consider".
- No corporate buzzwords.
- Never negative without offering a path forward, and never ends on a negative note.
- Never overwhelms with too many problems (8-12 max).

## Output format

A markdown document headed `## TELOS Narrative: [Client Name]` with one `###` section per beat, in this order: Opening, The Bad News, The Evidence, The Stakes, The Pivot, The Requirements, The Vision, The Close. The Evidence is a numbered list of problems; The Requirements is a bulleted list; every other section is prose. The worked example under Examples is the shape and the voice.

## Inputs

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `source` | Yes | - | TELOS directory, analysis output, or context to analyze |
| `client_ask` | Yes | - | What the client originally asked for (in their words) |
| `vision` | No | - | The solution architecture/vision (if already defined) |

## Examples

```markdown
## TELOS Narrative: Example Co (synthetic, invented for illustration)

### Opening

You asked us to come in and assess whether Example Co can triple its customer base
in three years, which is what your investors expect after the last funding round.
You also wanted to know how serious the problems are and whether they will stop you.

### The Bad News

Yes, they are that serious, and some are worse than you expected. On the current
path, Example Co may not be independent in five years.

### The Evidence

Here are the problems:

1. Two teams from an earlier acquisition still run separate roadmaps (interview, six leads)
2. Most of the engineering budget goes to internal tooling, not to anything customers use (budget review)
3. Customer satisfaction is falling while uptime stays high, so customers do not see the value (survey data)
4. One product line converts almost none of its sales into renewals (billing data)
5. Customer data lives in several systems with no single view of any customer (systems inventory)
6. Priorities change every few weeks, and teams cannot say what is most important (interviews)
7. Nobody owns the customer journey from first contact to renewal (org chart review)

### The Stakes

A larger competitor is about to bundle your main feature into its free tier. These
problems are getting worse, not better, and together they make the next five years
a real risk for the company.

### The Pivot

There is a way through. It needs full commitment from every leader, because a partial
version of this plan will not work.

### The Requirements

Here is what full commitment means:

- Merge the two roadmaps into one team with one priority list
- Hold priorities for six months at a time, with three or fewer at once
- Move internal tooling work under the product teams that use it
- Name one owner for the customer journey

### The Vision

Here is what the solution looks like:

Write down the procedures and context for each department. Build an AI agent for
each one that can answer questions from people and from other agents. A top-level
agent can then ask any of them for current state: "What is our satisfaction trend?"
returns a synthesized answer in seconds. A customer-facing agent works the same way
across all accounts: "Which customers need attention this week?" returns a ranked
list with reasons.

### The Close

This architecture fits your goals, and the timing is right. If you commit to it,
you can triple your customer base without tripling your complexity.

It will take real courage to start. The choice is yours.
```

## References

- Evidence usually comes from InterviewExtraction output or a direct TELOS directory analysis; WriteReport renders the narrative for a board.
