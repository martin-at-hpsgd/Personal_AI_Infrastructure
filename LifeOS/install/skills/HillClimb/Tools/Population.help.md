# Population.ts - Help Documentation

The randomness and generation record behind HillClimb's Ideate intent. Every draw a generation needs (proposers, far domains, the train misses a dreamer sees, recombination pairs, the measurement budget) comes from a seeded Fisher–Yates shuffle, and the seed is printed so the draw replays. A model is never asked to pick at random.

## Quick Start

```bash
bun ~/.claude/skills/HillClimb/Tools/Population.ts roster --climb <id> --n 6 --cases @train-misses.json
bun ~/.claude/skills/HillClimb/Tools/Population.ts generation <id> --proposals @gen.json --roster-seed <seed> --validate "bun apply-and-build.ts"
bun ~/.claude/skills/HillClimb/Tools/Population.ts allot --proposals @gen.json --budget 4 --judged p3,p1,p7
bun ~/.claude/skills/HillClimb/Tools/Population.ts generation <id> --void 2 --reason "validator broke in the apply step"
```

`help`, `--help`, `-h`, or `--help` after any command prints this file and draws nothing.

## Commands

### `roster`
Proposer slots across the creativity bands (`contemplate`, `daydream`, `dream`) and vendors (`openai`, `anthropic` by default). Each slot carries the `origin` its proposals name (`persona/band/vendor`), a persona, what it reads, how far it is invited to reach (never a size cap), its far domains, a starting operator, its Verbalized Sampling tail cutoff and, with `--cases`, the train misses it sees (all for contemplate, half for daydream, a third for dream). One dream slot is the wildcard, given a domain the climb has not drawn before.

What the code guarantees:

- `--n 3` or more gives every band.
- `--n 2` or more gives at least two vendors. A roster of two or more with one vendor is refused unless `--single-vendor "<reason>"` says why; the reason is printed in the roster.
- Bands are crossed with vendors: each band's slots rotate through the vendors, so a band with as many slots as there are vendors has every vendor, and `--n` at or above bands × vendors (6 with two vendors) has every band-vendor cell.
- Far domains are distinct across the roster while the pool of 30 lasts, so a roster asking for three or more far domains (any roster with all three bands) gets at least three.
- `--preset` (explore, the default; dream; directed; surgical) sets the band mix of the whole roster as far as those guarantees allow.

`--cases` takes a comma list, or `@file.json` holding an array of ids or of objects with an `id` field (an Assay run's `cases` rows work); any other row is refused rather than turned into text.

**Replay.** A roster depends on exactly these inputs: `--seed`, `--n`, `--preset`, `--vendors`, `--cases`, the used domains (`--used-domains`, plus the climb's `draws.jsonl` history with `--climb`), and `--single-vendor`. The same seed with the same inputs gives the same roster; change any input and the roster changes. Each concern draws from its own stream, so changing the cases moves only which misses each slot sees, and changing the used domains moves only the domains. Every roster prints a `replay` object listing those inputs and an `argv` that reproduces it without `--climb`. With `--climb`, the draw is appended to `<climb>/ideate/draws.jsonl` tagged with the climb's next generation number, which is printed as `generation`; that draw is the roster `generation` checks the proposals against. The default seed is `<climb>:roster:<next generation>`.

### `pick`
`--k` items drawn uniformly from `--from` (a comma list or `@file.json` array). `--below <p>` keeps only objects whose stated probability `p` is under the cutoff, filling from the rest only when the tail is short; the output says how many came from each.

### `pairs`
`--k` distinct pairs of rows for recombination. Rows are `{n, origin}` objects (the `archive <id>` or `digest <id> --train-only` rows) or `n:origin` strings. At least `--cross-origin` (default 0.2) of the pairs join different origins when the rows allow it.

### `allot`
Which proposals get measured. The judge's order (`--judged`, best first) fills part of `--budget` and the rest is drawn uniformly from the proposals the judge did not pick. `--random-share` (default 0.25) must be above 0 and at most 1; at least one slot is always drawn, so the judge never takes the whole budget (with a budget of 1 the one slot is drawn). With no `--judged`, the whole budget is drawn.

### `generation`
Persists one generation to `<climb>/ideate/gen-NNN.json` before any of it is measured. Each proposal needs `hypothesis`, `kind` (knob, wording, rule, structure, delete, add, import) and `origin`, and gets an `id` (`g<N>p<i>` unless it brought one) that `HillClimb.ts exp --generation <N> --proposal <id>` names when it is measured.

**Roster check.** The proposals are checked against the roster drawn for this generation (`roster --climb`; the latest draw for it, or the one named by `--roster-seed`). Every `origin` must be a slot's origin on that roster (case and spacing ignored), and the slots the proposals name must cover every band and every vendor the roster has. A generation with no recorded roster, an origin not on it, or fewer bands or vendors than it is refused unless `--off-roster "<reason>"` says why. The file records `roster` (seed and each slot's origin, band and vendor), `proposers` (bands and vendors covered, any missing, any off-roster origins) and `off_roster`. `HillClimb.ts exp --generation` then accepts only an origin on that roster.

**Kinds.** The kind list stays seven. A proposer's own word for a kind outside them goes in `kind_as_proposed`, beside the nearest canonical `kind`; a proposal whose `kind` is outside the seven is refused until it is mapped.

A proposal is refused if any key at any depth names held-out data: a key whose words (snake, kebab, dot or camel case) include test, val, validation, screen, holdout, held out, ci95 or p value (`metadata.test_score`, `valAccuracy`, `p_value`). Measurement words alone (value, score, delta, threshold) pass, so a target whose own grammar uses them is fine: a proposer briefed from `digest --train-only` never saw a held-out number to copy.

`--validate "<cmd>"` runs the target's own build check once per proposal: `sh -c <cmd>` with the proposal as JSON on stdin and in `$HILLCLIMB_PROPOSAL_FILE`, its id in `$HILLCLIMB_PROPOSAL_ID`, timed out after `--validate-timeout` seconds (default 120). Exit 0 means the proposal built into an applicable candidate. Each proposal records `build: {ok, exit, stderr, timed_out}`, and the generation lists `built` (measure these) and `failed_build` (recorded, never measured, never lost).

Each proposal is compared (token Jaccard) with every earlier hypothesis in the climb's ledger and earlier live generations. Verdicts: `collapsed` when more than half rephrase earlier ones (similarity at or above `--threshold`, default 0.6), `narrow` when fewer than three kinds appear (widen the next roster), else `diverse`.

**Void.** `generation <climb> --void <g> --reason "<text>"` withdraws a generation nothing was read from, such as one whose validator was broken. It is refused when any experiment row names generation g or one of its hypotheses, or any screen or test read does (`HillClimb.ts screen --generation <g>` records the generation on the read). The file is renamed `gen-NNN.void-<reason>.json` with `voided: {at, reason}` inside, so it is kept but no longer counts as an earlier generation, and when it was the last generation its number is reused.

## Exit codes

0 ok or diverse · 1 narrow or collapsed · 2 usage or runtime error (unknown climb, bad or unmapped kind, held-out field, malformed JSON, single-vendor roster without a reason, generation off its roster without `--off-roster`, void of a generation something was read from).

## Storage

`<HillClimb ledger>/<climb>/ideate/` (`draws.jsonl`, `gen-NNN.json`, `gen-NNN.void-<reason>.json`), realpath-confined inside the climb's own directory. The ledger root is `$HILLCLIMB_DIR`, else `<configRoot>/LIFEOS/MEMORY/STATE/HillClimb`.
