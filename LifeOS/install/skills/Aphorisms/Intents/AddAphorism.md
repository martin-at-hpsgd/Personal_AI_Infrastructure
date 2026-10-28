# Add Aphorism to Database

**Contents:** Ideal State · Anti-criteria · Inputs · Output format · Examples · References

A verified, attributed, theme-tagged aphorism written into the aphorism database with its context, the Theme Index updated, and the addition confirmed to the user.

## Ideal State

- The written quote matches a source found with WebSearch, word for word and author for author: common misattributions are ruled out, an "Unknown" or uncertain author is confirmed as such, and a paraphrased, remembered or partial quote appears in its exact full wording with its correct source.
- The entry is new to the database. An exact duplicate is not written; the user hears which section already holds it and gets the offer to update its context or themes. A similar quote (same author, similar message) or a paraphrase (different wording, same meaning) is in the database only when the user, shown the existing entry, said to add it anyway.
- The entry carries 1-3 specific, accurate primary themes from the categories in SKILL.md § Taxonomy, fewer accurate themes preferred over many vague ones, chosen with the newsletter topics it would fit in mind, unless the user chose a new category or no theme when offered the options for a quote that fits no existing theme.
- The entry's context gives the source (book title, speech, interview, letter, etc., with the year if known), the background (circumstances, original intended meaning, why it is significant) and the relevance for the audience (how it applies to modern life, its connection to TELOS philosophy, the practical wisdom it provides).
- The entry is in the entry format in SKILL.md § Database and placed in the right section: an existing theme section alphabetically by author, the thinker's own section for a key thinker named in PREFERENCES.md § Key thinkers, or the Initial Collection chronologically for a general quote not from a key thinker.
- The Theme Index lists the author alphabetically under every theme the quote carries, author names only, so the quote is immediately findable by FindAphorism for newsletter matching and by SearchAphorisms for its themes.
- The user received the confirmation summary naming the quote, author, themes, the sections updated and the database stats.
- A batch of quotes lands in a single Edit in which every quote was verified, themed and given context one by one, the Theme Index is updated once, and the user receives one batch summary.
- A quote named without its text ("Add Spinoza's quote about freedom through understanding") is researched to its exact wording; when several quotes match, the options go to the user and the selected version is added.
- An update to an existing quote finds the entry in the database, adds the researched context to it, and confirms the update to the user.

## Anti-criteria

- No exact duplicate is ever created in the database.
- An update that adds context to an existing quote never changes its themes or attribution unless the user asked for that change.
- No new section (a new category or author collection) and no new theme category is created without proposing it to the user first. An approved theme category is recorded in PREFERENCES.md § Approved categories (SKILL.md § Taxonomy) before any entry uses it.
- A quote research shows to be misattributed is never written under the false attribution: the user chooses between adding it as 'Unknown' with a note about the misattribution, skipping it, or researching similar authentic quotes. An author that cannot be verified is recorded as 'Unknown' or 'Disputed' with the note, never asserted.

## Inputs

- Required: the quote text in its exact wording (or enough to research it) and the author.
- Optional, researched when not given: themes, context, and source (book, speech, interview).

## Output format

**Summary for User:**

```markdown
✅ **Aphorism Added Successfully**

**Quote:** "[quote text]"
**Author:** [Author Name]
**Themes:** [Theme 1], [Theme 2]

**Added to:**
- Main Collection: [Section name]
- Theme Index: Updated [N] theme(s)

**Database Stats:**
- Total aphorisms: [N]
- Authors: [N]
- Themes covered: [N]

**Ready to use in:** Newsletter recommendations, theme searches
```

**Misattributed quote:**

```markdown
User: "Add Einstein quote: 'Everyone is a genius...'"
Research: Actually from Unknown author, falsely attributed to Einstein

Response: "This quote is commonly misattributed to Einstein but has no verified source. Would you like to:
1. Add it as 'Unknown' with note about misattribution
2. Skip adding this quote
3. Research similar authentic Einstein quotes"
```

**Quote that fits no existing theme:**

```markdown
"This quote about [topic] doesn't fit our existing themes well. Options:
1. Add to closest theme: [Theme X]
2. Create new theme category: [Proposed Theme]
3. Add to general collection without specific theme

Which would you prefer?"
```

## Examples

**User:** "Add this quote: 'The important thing is not to stop questioning. Curiosity has its own reason for existing.' - Einstein"

Verified as from Einstein's 1955 interview, not in the database, themed Curiosity & Intelligence (primary) and Learning & Education (secondary). In this example Einstein is not among the key thinkers in PREFERENCES.md § Key thinkers, so the entry goes into the Initial Collection chronologically:

```markdown
**"The important thing is not to stop questioning. Curiosity has its own reason for existing."**
- Author: Albert Einstein
- Theme: Curiosity & Intelligence, Learning & Education
- Context: From 1955 interview "Old Man's Advice to Youth." Emphasizes intrinsic value of curiosity beyond practical applications.
```

Theme Index after the add:

```markdown
**Curiosity & Intelligence:**
- Aaron Swartz, Dorothy Parker, Albert Einstein
```

Other theme calls: "The cure for boredom is curiosity. There is no cure for curiosity." (Dorothy Parker) is Curiosity & Intelligence, then Passion & Enthusiasm. "Walk away from anything or anyone who takes away from your joy." is Present Moment, then Stoicism & Control (choosing what affects you).

Context example: "You have power over your mind - not outside events." Source: Meditations by Marcus Aurelius (Book 12, written ~170 AD). Background: personal reflections written on military campaign. Relevance: the Stoic dichotomy of control, foundational to mental strength and resilience.

## References

- Entry, Theme Index and usage formats: SKILL.md § Database. Theme categories: SKILL.md § Taxonomy.
- Bulk import: gather quotes with `Intents/ResearchThinker.md`, then batch-add them here with the same checks per quote.
