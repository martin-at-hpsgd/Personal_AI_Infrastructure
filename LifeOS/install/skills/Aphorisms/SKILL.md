---
name: Aphorisms
evals:
  deterministic:
    - command: 'bun "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Aphorisms/Tools/Aphorisms.ts" check'
      falsifier: "the collection holds an exact duplicate quote, an entry missing its Author, Theme or Context line, a Theme Index heading off the Taxonomy list, or an author missing from or unknown to the Theme Index"
  manual:
    reason: "quote relevance, attribution, and avoidance of repetition depend on the requested theme and collection context"
    falsifier: "the reviewer finds a returned quote is misattributed, irrelevant to the request, or repeats a recorded prior use"
metadata:
  short-description: "Find, add, and organize aphorisms and quotes by author, theme, and prior use; research thinkers. Excludes creative writing and social posts."
version: 1.1.28
description: "Curated aphorism collection with CRUD: content-based matching, themed search, thinker research, and usage tracking to avoid repeating quotes. USE WHEN aphorism, quote, find a quote, research thinker, add aphorism, quote for newsletter, what did X say about, quote bank. NOT FOR creative writing, social posts, or the principal's own published words."
---

# Aphorisms

**Contents:** Ideal State · Intent Routing · Data & Config · Database · Taxonomy · Gotchas · Examples

Curated aphorism store with full CRUD. Its main job is a newsletter's recurring quote (an Aphorism of the Week, say): candidate quotes matched to that edition's themes that avoid recently used ones. It also adds quotes, searches the collection, and researches a thinker's quotes. Every intent reads and writes one collection file (§ Database), whose Theme Index and Newsletter Usage History keep quotes findable and fresh.

## Ideal State

- Every quote the skill returns or stores is attributed and verified: a misattributed or unverifiable quote is marked Unknown or Disputed, never asserted.
- Recommendations and search results match the request's themes, tone and query, best first (recommendations with their scores), and recommendations avoid quotes with a recent recorded use.
- Every addition, research batch and newsletter use lands in the database in the entry formats under § Database, with the Theme Index and the usage history updated in the same pass, so the other intents find it immediately.

## Intent Routing

| Intent | Trigger | File |
|----------|---------|------|
| FindAphorism | Find aphorism, quote for newsletter, Aphorism of the Week, match aphorism, suggest quote, aphorism recommendation, "what quote fits this", an opening or closing quote for a newsletter | `Intents/FindAphorism.md` |
| AddAphorism | Add quote, add aphorism, save quote, new aphorism, store quote | `Intents/AddAphorism.md` |
| ResearchThinker | Research thinker, find quotes from, what did X say, thinker quotes on, "find [author] aphorisms", building out a thinker section | `Intents/ResearchThinker.md` |
| SearchAphorisms | Search aphorisms, find quotes on, quotes about, quotes matching, what aphorisms, "show me [keyword] quotes", browsing for inspiration before the newsletter theme is known | `Intents/SearchAphorisms.md` |

| File | Read when |
|------|-----------|
| `Database/` | `aphorisms.md` is the starter collection, used only until the user's own copy exists (§ Database) |
| `Setup.md` | first-time setup: the user's collection and `PREFERENCES.md` |
| `Tools/` | `Aphorisms.ts`: `check` after any write to the collection, `fetch` for an edition given as a URL (`Tools/Aphorisms.help.md`) |

## Data & Config

User customizations live at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Aphorisms/` (`configRoot` is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). Every intent reads two files there before acting: `aphorisms.md`, the user's own collection (§ Database), and `PREFERENCES.md`, which names the default use (what the quotes are usually for), the philosophy themes quotes are scored against, and the key thinkers with their priority sources. When either is absent, the starter collection and the generic defaults here stand, and the intent says so. Setup: [Setup.md](Setup.md).

## Database

**Location:** `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Aphorisms/aphorisms.md` under the config root when it exists, else the starter `Database/aphorisms.md` in this skill (`bun skills/Aphorisms/Tools/Aphorisms.ts path` prints the one in use). Every intent reads it in full before choosing or writing anything, writes to it with the Edit tool, and runs `Aphorisms.ts check` after writing.

Sections: Initial Collection, one section per key thinker (PREFERENCES.md § Key thinkers), Theme Index, Newsletter Usage History. Each entry carries the full quote text, author, theme tags, and context with its source.

**Entry format** (AddAphorism and ResearchThinker write it; FindAphorism and SearchAphorisms read it):

```markdown
**"[Full quote text]"**
- Author: [Author Name]
- Theme: [Theme 1], [Theme 2], [Theme 3]
- Context: [Source and background]
```

An uncertain author is written as Unknown or Disputed, and a quote with several versions keeps the most commonly cited one:

```markdown
**"[Quote text]"**
- Author: Unknown (often attributed to [Name 1], [Name 2])
- Theme: [Themes]
- Context: This quote is commonly attributed to [Name] but cannot be verified. [Background on why quote is valuable despite uncertain origin]

**"[Primary version]"**
- Author: [Author Name]
- Theme: [Themes]
- Context: [Background]. Note: This quote appears in multiple variations; this is the most commonly cited version from [Source].
```

**Theme Index:** the author's name, alphabetically, under every theme the quote carries; names only, so an author appears once per theme.

```markdown
## Theme Index

**Curiosity & Intelligence:**
- Aaron Swartz, Dorothy Parker
```

**Newsletter Usage History** run, written by FindAphorism when it delivers a recommended set, newest last; `Selected` stays `pending` until the pick is known, then names it:

```markdown
## Newsletter Usage History

### 2025-11-20 · Edition "Overcoming Setbacks"
- Recommended: Tim Grover ("You don't have to love the hard work..."), Muhammad Ali ("I hated every minute of training..."), Confucius ("He who learns but does not think, is lost!...")
- Selected: Tim Grover ("You don't have to love the hard work..."), opening quote
```

A quote counts as used on a run's date when it is that run's Selected quote, or when it was recommended in a run whose Selected line is still `pending`.

## Taxonomy

**Theme categories.** These twelve, plus any the user approved in PREFERENCES.md § Approved categories, are the only Theme Index headings `Aphorisms.ts check` accepts; what each covers:

- **Work Ethic & Excellence** - Craft, mastery, high standards, results
- **Resilience & Strength** - Adversity, persistence, growth through challenge
- **Fear & Mindset** - Overcoming fear, reframing, mental approach
- **Passion & Enthusiasm** - Full commitment, love for craft, intensity
- **Progress & Competition** - Self-improvement, personal growth, benchmarks
- **Curiosity & Intelligence** - Learning, questioning, intellectual drive
- **Self-Investment** - Personal growth, skill building
- **Present Moment** - Mindfulness, appreciation, being here now
- **Learning & Education** - Knowledge acquisition, continuous improvement
- **Stoicism & Control** - Internal locus, acceptance, discipline
- **Risk & Action** - Courage, failure acceptance, experimentation
- **Adversity** - Challenges, setbacks, overcoming difficulty

Write these names. The database's Initial Collection sub-headings still use older names ("Competition & Progress", "Investment & Self-Development", "Present Moment & Enjoyment"); those are section headings, not categories. A new category, such as "Wisdom & Truth-Seeking", is proposed to the user and approved before any entry or Theme Index line uses it; on approval it is added as a `- Category Name` bullet under `## Approved categories` in the user's PREFERENCES.md, never to this list.

**Key thinkers** are the user's, listed with their focus and priority sources in PREFERENCES.md § Key thinkers; each has its own section in the database.

## Gotchas

- **A thinker section can hold only its placeholder** (`*Quotes to be added from research*`) until ResearchThinker fills it (seen 2026-10-09). Examples that name Feynman or Einstein quotes describe a target collection, not any current contents.
- **Recording must never wait for the pick.** The pick is usually made later, while drafting the edition, so a run that records only a same-session selection leaves the Newsletter Usage History empty across many runs. FindAphorism writes each delivered set as a run with `Selected: pending`; while few runs exist, freshness scores rest on little data. This install's history of the miss is in PREFERENCES.md § Install history.

## Examples

"I'm writing a newsletter about how major security breaches happen from ignoring basic security hygiene. Find me a good aphorism." → FindAphorism (worked through in `Intents/FindAphorism.md`).

"Add this quote: 'The important thing is not to stop questioning. Curiosity has its own reason for existing.' - Einstein" → AddAphorism; "Search aphorisms about learning and curiosity" → SearchAphorisms.

"Research Richard Feynman quotes about curiosity and scientific thinking" → ResearchThinker (worked through in `Intents/ResearchThinker.md`).
