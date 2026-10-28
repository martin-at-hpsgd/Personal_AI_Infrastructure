# Row Classification

How Scaffold derives a criterion's `## Test Strategy` row type when the answer is not a plain deterministic check (`Intents/Scaffold.md` § Row classification). The row type is derived, never picked by taste. Three questions per criterion:

| Question | Yes | No |
|----------|-----|----|
| **Deterministic?** Can a tool say no without a model: a status code, a file, a count, an exit code, a string? | an assert row: `bun-test` / `bun-property` / `bash` / `curl` / `screenshot` | continue |
| **Single output or a ranking?** Is the criterion about one output's quality, or about which of several candidates is best? | single → an `eval` row (`suite:<name>`, a rubric) | ranking → a `pairwise` row (`Tournament.ts`, a flipped bracket) |
| **Decomposable?** Which parts of "good" are asserts (banned phrasings, structure, length, required content) and what is the judged residue after them? | write the asserts as stage-1 rows and the judge as a stage-2 row; the residue is what the judge grades, nothing more | the whole criterion is judged: name why in the row's check cell, and expect the residue report to ask again |

Nothing deterministic, no output to judge yet → `manual`, naming the falsifier in prose; ISAGate flags a manual row whose criterion text names a class it could decompose (a URL, a file, a count, an exit code, a string), because that criterion wanted an assert. An `eval` row names a suite, and the suite reports itself `provisional` on every surface until the judge holds an earned calibration record; the runner, never the scaffold, says a judge is calibrated.
