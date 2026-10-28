# Search Aphorisms

**Contents:** Ideal State · Anti-criteria · Output format · Examples · References

Aphorisms from the database that match a theme, keyword, author, topic or combination query, best match first, each with why it matches and its usage history.

## Ideal State

- Every result matches every filter in the query, drawn from the whole database (every entry, the thinker sections and the Theme Index), best match first. Filters keep their plain meaning: exclude ("resilience quotes but not Rocky Balboa"), unused ("unused quotes about learning": never used, or last used more than 6 months ago), short ("short quotes about action": under 150 characters), source ("quotes from books, not movies": judged from the entry's context).
- Each result shows its usage from the Newsletter Usage History (last used date, or never used; what counts as a use: SKILL.md § Database). A query with no match says so and names the nearest themes, or offers to research the topic.

## Anti-criteria

- No result is returned that does not genuinely match the search query.

## Output format

```markdown
## Search Results: "[Query]" ([N] found)

### [N]. "[Full quote text]"
**Author:** [Author] · **Themes:** [Themes] · **Usage:** [Last used: date / Never used]
**Why it matches:** [Specific relevance to the query]
```

## Examples

"Search aphorisms about learning and curiosity" covers Learning & Education and Curiosity & Intelligence. It returns Aaron Swartz first, then Krishnamurti, Confucius and Gandhi:

```markdown
## Search Results: "learning and curiosity" (4 found)

### 1. "Be curious. Read widely. Try new things. What people call intelligence just boils down to curiosity."
**Author:** Aaron Swartz · **Themes:** Curiosity & Intelligence · **Usage:** Never used
**Why it matches:** Direct hit on curiosity, and reframes intelligence as curiosity in action.
```

## References

- Theme categories: SKILL.md § Taxonomy. The database: SKILL.md § Database.
- Results feed `Intents/FindAphorism.md` ("use result #3 for my newsletter"); a liked author or a theme gap goes to `Intents/ResearchThinker.md`, then `Intents/AddAphorism.md`.
