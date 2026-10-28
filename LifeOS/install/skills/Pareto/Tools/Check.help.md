# Check.ts

Verify a Pareto report against the data it was built from.

```
bun ~/.claude/skills/Pareto/Tools/Check.ts <report.md> <ranked.json> [--collection collection.json]
```

Exit 1 with one line per failure when:

- a `## Past meta`, `## Current mainstream meta` or `## Where the forward thinkers are heading` section is missing;
- any URL in the report is absent from the ranked set (and the collection, when given);
- the past or current section has no link or no year;
- the frontier section has fewer than two links;
- every frontier link with a known reach sits in the top third of its source (a popularity summary).
