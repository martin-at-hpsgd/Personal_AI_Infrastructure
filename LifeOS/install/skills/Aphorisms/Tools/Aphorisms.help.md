# Aphorisms.ts

Deterministic checks over the aphorism collection, and the raw article text FindAphorism analyses. Reads only; every write to the collection goes through the Edit tool.

```bash
bun ~/.claude/skills/Aphorisms/Tools/Aphorisms.ts check [--db <path>] [--prefs <path>] [--history-since YYYY-MM-DD] [--json]
bun ~/.claude/skills/Aphorisms/Tools/Aphorisms.ts fetch <url>
bun ~/.claude/skills/Aphorisms/Tools/Aphorisms.ts path
```

| Request | Command |
|---|---|
| "is the collection consistent", after any add or research batch | `check` |
| proof that a FindAphorism run recorded its set | `check --history-since <today>` |
| the text of a newsletter edition given as a URL | `fetch <url>` |
| "where is the collection" | `path` |

`check` fails (exit 1) on an exact duplicate quote (case and punctuation ignored), an entry missing its Author, Theme or Context line, a Theme Index heading that is not a category in SKILL.md § Taxonomy or a bullet of the user's `PREFERENCES.md` § Approved categories (`--prefs` points at another file), a Theme Index name with no entry, or an entry author with no Theme Index line. Index names may carry a parenthetical disambiguator (`Robin S. Sharma (I CAN)`); it is ignored when matching. `--history-since` also fails when the Newsletter Usage History has no `### YYYY-MM-DD` run on or after that date.

`fetch` pulls the raw HTML and prints the page title and the text of its `<article>`, else `<main>`, else `<body>`, with scripts, styles, nav, header, footer and aside dropped. Exit 3 when the page cannot be fetched or yields no text.

The collection path is `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Aphorisms/aphorisms.md` under the config root when that file exists, else the skill's `Database/aphorisms.md`; `--db` overrides both. Exit codes: 0 ok, 1 check errors, 2 usage error or missing database, 3 fetch failed.
