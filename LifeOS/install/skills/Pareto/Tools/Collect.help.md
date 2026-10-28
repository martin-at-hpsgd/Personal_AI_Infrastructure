# Collect.ts

Wide sweep for one topic across YouTube, GitHub and the web.

```
bun ~/.claude/skills/Pareto/Tools/Collect.ts "<topic>" [options]
```

| Flag | Default | Effect |
|---|---|---|
| `--sources a,b` | `youtube,github,web` | Collectors to run. `extra` alone means only the `--extra` file. |
| `--per-source N` | `100` | Rough candidate budget per source (each API caps its own page size). |
| `--extra file.json` | — | JSON array of `{url, title, description?, author?, published_at?}` merged as source `extra` (the Research handoff). |
| `--out file.json` | stdout | Where to write the collection. |

Env: `YOUTUBE_API_KEY`, `PERPLEXITY_API_KEY`; GitHub uses `gh`.

Output: `{topic, collected_at, sources: [{name, status, count, error?}], items: [{id, source, url, title, author, description, reach, reach_unit, author_baseline, published_at}]}`. Duplicate URLs collapse. Exit 1 only when every source failed.
