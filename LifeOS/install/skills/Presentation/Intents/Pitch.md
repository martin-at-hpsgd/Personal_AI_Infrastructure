# Pitch

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Output format · Examples · References

Product documentation turned into a sales pitch a buyer can retell: a first-person value story, talking points, an elevator pitch and a problem/solution/outcome summary, and, for a full package, a charcoal sketch carrying the same idea. Three modes, carried from the retired Sales skill (audit 2026-10-10): CreateNarrative (the pitch alone), CreateVisual (a sketch for an existing narrative or value proposition), and CreateSalesPackage (the whole pipeline).

## Ideal State

- A StoryExplanation run at 24-item length on the input existed before the narrative, framed around the PROBLEM the product solves, the TRANSFORMATION (before → after), why the customer should CARE, and the FEELING of using it.
- The story is an 8-24 point narrative, first person and conversational, about VALUE rather than features and centered on the customer's problem and outcome.
- The buyer can retell it after one hearing: it has a before, a shift and an after that survive being repeated by someone who heard it once.
- Every claim traces to a source line: each thing the narrative asserts about the product maps to a specific line in the docs, and the narrative states only what those lines support.
- Features appear only in service of why they matter to the buyer.
- The arc leads with the pain point, introduces the transformation, proves the value with concrete benefits, creates urgency (why now, the cost of waiting), and ends with the outcome.
- 3-5 key talking points, each a standalone, quotable value statement tied to a specific customer outcome.
- A 2-3 sentence elevator pitch a salesperson would actually say aloud, capturing the core value in 30 seconds.
- A Problem / Solution / Outcome summary, one sentence each.
- The whole is specific (concrete problems, outcomes and benefits from the docs), reads naturally aloud, and the sales team can use it immediately without edits.
- In CreateVisual and CreateSalesPackage, an emotional register with its warm:cool ratio was chosen from the Value Proposition Type table (or taken from the requested target emotion) before the visual concept, and a visual concept in the Scene Construction Template shape existed before the image prompt: concrete subjects are specific nouns from the value proposition, the metaphor captures the transformation, the composition is minimalist with centered subjects in empty space.
- The sketch renders the narrative's single emotional core in the same register, so story and sketch point at the same idea, and it passes the checks in Art's SalesVisual intent: register matches, subjects visible, minimalist, charcoal sketch aesthetic, transparent background, connectable to the value proposition.
- A CreateSalesPackage run produces its steps in pipeline order (narrative → register → concept → visual → compile) and compiles to the Sales Package format, with the Emotional Hook naming the register.

## Anti-criteria

- No invented capability and no rounded-up number: the pitch is only as strong as it is true.
- Not one sentence reads "it does X, and Y, and Z"; a sentence that reads like a spec sheet is rewritten as consequence.
- No generic marketing speak.
- The visual is never a montage of everything the product does and never competes with the pitch.
- No image delivered while a sales-visual check fails: a failing image is regenerated with an adjusted prompt.
- No filled-in background, no clean vectors or smooth linework, and no text in the image beyond the stamped signature.
- No art style other than the one Art's SalesVisual intent enforces (its charcoal gestural sketch) unless the principal asks for one.

## Inputs

- Any of: product documentation, feature specifications, technical descriptions, marketing copy to improve, a URL to a product page.
- CreateVisual takes a sales narrative or value-proposition summary, plus an optional target emotional response (derived from the table when absent).
- Customizations at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Presentation/` (PREFERENCES.md, configurations, resources) override these defaults when the directory exists.

## Tool contract

```
Skill("StoryExplanation") — 24-item length on the input content
Skill("Art") — SalesVisual intent: Value Proposition Type table, Scene Construction Template, sales prompt template,
               Generate.ts --intent=SalesVisual --model nano-banana-pro --size 2K --aspect-ratio 1:1 --remove-bg --signature
```

Generate.ts refuses a call that names no intent, and `--intent=Essay` loads the blog contract (post slug, `cse.md`, `composition.md`) a pitch does not have, so the sketch always runs through SalesVisual (2026-10-11).

CreateSalesPackage pipeline order:

```
PRODUCT DOCUMENTATION
        ↓
[1] STORY EXPLANATION — Extract narrative arc with StoryExplanation Skill
        ↓
[2] EMOTIONAL REGISTER — Match to emotion from the Value Proposition Type table
        ↓
[3] VISUAL CONCEPT — Derive scene from narrative + emotion (Scene Construction Template)
        ↓
[4] GENERATE VISUAL — Create charcoal sketch with Art Skill (SalesVisual intent)
        ↓
[5] COMPILE OUTPUT — Narrative + visual + talking points
```

A sales deck built from this pitch goes to CreateDeck.

## Output format

CreateNarrative:

```markdown
# Sales Narrative: [Product/Feature Name]

## The Story

[8-24 point narrative, first person, conversational]

## Key Talking Points

1. [First value statement]
2. [Second value statement]
3. [Third value statement]

## Elevator Pitch

"[2-3 sentence script]"

## Pain Point Summary

**Problem:** [One sentence describing the pain]
**Solution:** [One sentence describing the transformation]
**Outcome:** [One sentence describing success]
```

CreateVisual: a PNG with transparent background, charcoal gestural sketch aesthetic, capturing the emotional core of the value proposition, ready for sales decks, presentations and collateral.

CreateSalesPackage:

```markdown
# Sales Package: [Product/Feature Name]

## Sales Narrative

[8-24 point story explanation from Step 1]

## Visual Asset

[Image path or embedded image]

## Key Talking Points

1. [First major value point]
2. [Second major value point]
3. [Third major value point]

## Emotional Hook

**Register:** [Emotional register used]
**Core Message:** [One sentence that captures the feeling]

## Script Snippet

"[2-3 sentence elevator pitch version of the narrative]"
```

## Examples

```
User: "turn this technical doc into a sales pitch" [AI code review tool docs]
→ CreateNarrative: CSE-24 first, then an 8-point first-person story
  (1. Code review is broken, PRs get rubber-stamped … 8. Result: fewer production bugs, faster reviews, happier teams)
→ Talking points: senior-engineer understanding, not just pattern matching; catches what humans miss in PR reviews; learns your codebase patterns
```

```
User: "create a sales package for this product" [docs]
→ CreateSalesPackage: narrative → WONDER / DISCOVERY (40:60 warm:cool) → scene: human developer and AI figure examining the same code output
→ Charcoal sketch, transparent background, plus narrative, talking points, Emotional Hook and Script Snippet
```

```
User: "create a visual for this sales story"
→ CreateVisual: register from the narrative, concept from story + emotion, 1:1 charcoal gestural sketch with transparent background
```

## References

- `skills/Art/Intents/SalesVisual.md` — the register table, scene template, prompt template, CLI and pass checks.
- `skills/StoryExplanation/SKILL.md` — the 24-item story explanation.
