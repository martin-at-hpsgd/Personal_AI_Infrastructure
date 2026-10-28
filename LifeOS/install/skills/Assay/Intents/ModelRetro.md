# ModelRetro Intent

Which model did we like better, looking back over the real work each one did. Compare runs a controlled A/B on a suite; ModelRetro reads history: every session transcript, every Claude subagent, every codex rollout. It judges each turn by the principal's reaction in the next typed prompt.

## Ideal State

- The principal has a per-model table covering the window they asked about, split by role (main loop, Claude subagent, codex).
- One plain sentence says what the numbers do and do not support.
- For each model they want to look at, the turns it actually did are listed, unhappy ones first, so they can open the real work and judge it themselves.
- A difference between two models is called a difference only when their 95% intervals do not overlap; anything else is reported as no measurable difference.
- When the models' date ranges differ, the report says so, because models are confounded with eras and with the work they were given.

## Anti-criteria

- Calling a difference when the intervals overlap.
- Recommending a routing change from the rates without reading the samples.
- Treating a subagent or codex row as sole authorship of a turn.
- Reading a low unhappy rate as strong evidence of quality.

## Tool contract

```bash
bun ~/.claude/LIFEOS/ROUTER/ModelRetro.ts --days 30                         # per-model table
bun ~/.claude/LIFEOS/ROUTER/ModelRetro.ts --days 60 --model <id-fragment> --samples 20   # that model's turns
bun ~/.claude/LIFEOS/ROUTER/ModelRetro.ts --days 30 --json                  # for further analysis
# --min <n> sets the judged-turn floor below which rates are withheld (default 20); --no-codex skips rollout logs.
```

## Output format

Columns: `unhappy/100` is corrected plus frustrated per 100 judged turns, and `praise/100` is praise per 100, each with a Wilson 95% interval. A sample row gives the date, reaction, session id, the prompt, and the reply that judged it; the session id opens the transcript under `~/.claude/projects/`.

## Gotchas

- The labels are a deterministic phrase detector (`LIFEOS/ERRATA/Signals.ts`), precision-first. It misses quiet dissatisfaction and a silent redo, so a low unhappy rate is weak evidence of quality. Read the samples before recommending a routing change.
- Models are confounded with eras and with the work they were given. A model that carried the hardest or newest work, or ran while the harness was broken, looks worse for reasons that have nothing to do with the model. Say so whenever the date ranges differ.
- A turn credits every model that worked in it: one main-loop model plus each subagent or codex run that started inside it. Subagent and codex rows share the reaction with the main model that orchestrated them, so treat them as involvement, never sole authorship.
- Only interactive sessions count. Headless jobs have no typed reaction and are skipped. The last turn of every session is unjudged.
- A full 60-day window reads every transcript and rollout on disk, about a minute on a large history. Narrow `--days` when you only need recent models.
