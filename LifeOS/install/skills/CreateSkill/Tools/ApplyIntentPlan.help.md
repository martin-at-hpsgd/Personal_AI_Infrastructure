# ApplyIntentPlan

Rebuilds one intent (or one SKILL.md with `--skill-md`) from a plan a model wrote, moving the original's lines verbatim. New prose is limited to the title, the summary, the Ideal State and Anti-criteria bullets, and at most three one-line connective sentences of 280 characters per section.

```bash
bun skills/CreateSkill/Tools/ApplyIntentPlan.ts --plan <plan.json> [--allow-out <tsv>] [--check] [--json] [--skill-md]
```

| Flag | Effect |
|---|---|
| `--plan <plan.json>` | The plan; its shape is the exported `IntentPlan` type, and unknown keys are refused |
| `--allow-out <tsv>` | Appends one IntentPreserve allow line per token the cuts removed, with the cut's reason |
| `--check` | Validates and prints the would-be file and allow lines; writes nothing |
| `--json` | `{ok, file, written, allow, warnings, demoted}`, or `{ok:false, errors}` |
| `--skill-md` | The target is a SKILL.md: free-form section titles, optional `summary`, optional `preamble` blocks |

```json
{ "file": "skills/X/Intents/Y.md", "sha256": "<sha256 of the file's current bytes>",
  "title": "Y", "summary": "One line: what this intent produces.",
  "frontmatter": { "keep": true, "contractRequires": [ { "id": "cse", "path": "…", "fields": ["…"], "produce": "…" } ] },
  "idealState": ["…", "…"], "antiCriteria": ["…"],
  "sections": [ { "title": "Tool contract", "blocks": [ { "from": 40, "to": 62 }, { "text": "short connective sentence" } ] } ],
  "cuts": [ { "from": 10, "to": 20, "reason": "choreography: numbered steps replaced by Ideal State bullets 1-3" } ] }
```

A plan is refused, with every problem listed and nothing written, unless the sha256 matches, every non-blank body line sits in exactly one block or cut, section titles are allowed and unique, moved ranges keep their fence state, and the result has zero IntentLint errors. A `#` or `##` heading inside a moved range becomes `###`. Dropping existing frontmatter needs `frontmatter.dropReason`.

Exit: 0 written or valid, 1 refused, 2 git or I/O error, 64 usage error.
