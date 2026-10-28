# CompileEstate.ts — compile every in-scope ISA

Runs Compile on each ISA in scope and writes its `Evals.proposed.md`. It never merges; merging is `bun Compile.ts merge <ISA>`, a main-session step. Scope comes from `LIFEOS/TOOLS/lib/IsaScope.ts`, the same resolver `EvalCensus.ts --without-eval` reads.

## Usage

```
bun skills/Assay/Tools/CompileEstate.ts [--scope projects,recent:14d] [--dry-run] [--concurrency N] [--json]
```

## Flags

- `--scope` comma list: `projects` (every ISA PROJECTS.md points at, any phase) and `recent:<N>d` (open ISAs, phase not complete/completed/done/archived/retired, whose file changed in the last N days). Default `projects,recent:14d`. Deduped by realpath.
- `--dry-run` lists the in-scope ISAs with per-ISA criterion counts; no model call.
- `--concurrency N` ISAs compiled at once (default 4).
- `--json` the full result.

## Skips

- `dirty`: the ISA has uncommitted changes (someone's work in flight). Never compiled; its criteria are counted as deferred in the summary.
- `pending-merge`: an `Evals.proposed.md` already waits beside it.
- `current`: Compile's own incremental state finds nothing to compile.

## Output

One line per ISA, unresolved PROJECTS.md pointers, then a summary: ISAs compiled, criteria compiled, splits, refusals, model calls, wall time, and what is left without an eval: splits and refusals for the main session, and criteria in dirty ISAs to compile after their owners commit. With those settled, `EvalCensus --without-eval` reaches 0.

## Exit codes

- `0` done.
- `1` an ISA had refusals or an error.
- `2` usage or scope error.
