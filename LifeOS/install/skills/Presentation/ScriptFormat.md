# Lecture script format

A lecture lives in one `SCRIPT.md`. `Tools/Build.ts` reads this file, validates it, and writes the deck. Write slide numbers in order. The tool doesn't renumber them.

```markdown
## 1 — Title
TYPE: title
TITLE: The Talk's Name
SUB: One line under it
BYLINE: Speaker · site
READ:
Hi, I'm the speaker.

I want to talk about one idea tonight.

---

## 2 — The claim
TYPE: statement
TITLE: Tech is more predictable than you think.
READ:
A big part of this talk hinges on one idea.

The future of tech is more predictable than we think.
```

## Fields

| Field | Use |
|-------|-----|
| `## <n> — <name>` | Starts a slide. The name is for you and shows up as an HTML comment. |
| `TYPE` | One of `title`, `statement`, `section`, `bullets`, `two-col`, `art`, `video`, `quote`, `close`. |
| `TITLE` / `SUB` | The words on screen. Keep them short, because the audience is listening, not reading. |
| `IMG` | Used by `art` slides. Takes a path relative to the deck (`images/x.jpg`), or `inline:<path>` to embed an SVG file (path relative to SCRIPT.md). |
| `VIDEO` | Used by `video` slides. Takes a path relative to the deck and plays muted, autoplayed and looped. |
| `BULLET` | Repeatable. Gives the text column on `art`/`video`, the list on `bullets`, or the quote text on `quote` (first BULLET). |
| `L:` / `R:` | Columns on a `two-col` slide. The first line of each is the column header. |
| `CITE` | The source line: under the quote on a `quote` slide, small at the bottom left on an `art` or `video` slide. A picture's credit goes here, never in `SUB`. |
| `BYLINE` / `CONTACT` | Shown on `title` and `close` slides. |
| `READ:` | The spoken text. Write each sentence on its own line, with a blank line between. A slide needs at least 1 sentence and at most 5. |
| `FULL:` / `NOTE:` | Optional. Reference material for the author, such as the raw dictation. It's ignored by the build and never spoken. Put it last in the slide. |

## Contract enforced by Build.ts

- Every slide has 1–5 READ lines. Fewer or more is an error.
- Each line is one sentence. A line holding two sentences is an error. Common abbreviations like "Dr." and "U.S." are allowed.
- A sentence over 20 words is an error. Over 15 words gets a warning.
- `art` slides need an `IMG` and `video` slides need a `VIDEO`.
- The speaker notes render one paragraph per sentence, with space between them.
