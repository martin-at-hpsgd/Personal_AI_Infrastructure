# RunAgentic Intent

Multi-turn, tool-using evals — the agentic lane. Single-turn evals miss most agent failures (Anthropic webinar, 2026-07); when the property under test involves tool use, multi-step state, or a real harness, this lane replaces single-shot EvalRunner.

## Ideal State

- Real agent sessions ran each case against an actual harness, with a clean environment per trial and no state shared or accumulated between runs.
- Grades rest on outcomes (final environment state, the artifact produced), never on tool-call sequences.
- Judged verdicts are trusted only from a calibrated judge, the same doctrine as the single-shot lane.
- A case whose sandbox could not start reports as unavailable, never as a pass or a fail.
- Our suites stay in our own YAML; `claude plugin eval` is reached through a translation at the boundary.

## Anti-criteria

- Pass/fail decided by transcript analysis or by matching a tool-call path. Transcript analysis is legitimate only for QUALITY signals (turn count, token efficiency).
- Binding our suite format to `claude plugin eval`'s schema.
- Identity-bound or Restricted content published to claude.ai in the HTML report.
- `--scaffold` run on case files you did not author.
- A tool-dependent suite run tool-free by accident.

## Tool contract

`claude plugin eval` runs real agent sessions against eval cases and grades them — cases as `case.yaml` or `prompt.md + graders/*.md`, per-case runs (default 3), an LLM judge (default haiku), threshold-gated exit codes, and an ablation mode reporting the with/without score delta. Its flags and schema can change between Claude Code releases (see Gotchas).

```bash
# From inside a Claude session, clear the nesting guard so the run uses the signed-in claude CLI:
env -u CLAUDECODE -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN claude plugin eval <target> \
  --eval-dir evals --runs 3 --json results.json [--threshold 0.75] [--case '<glob>']

# Ablation (the with/without delta — the improvement primitive):
env -u CLAUDECODE -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN claude plugin eval <plugin> --ablation with-without

# Authoring: interview-driven suite scaffold
claude plugin eval init <name>
```

For dependent skills, `Tools/Agentic.ts` exports `runAgenticSuite(name, adapter, requiredContext, overrides, deps)`. The adapter runs the actual harness and returns output, executed model, context hashes and durable final-state evidence. Each trial gets its own scratch workspace. Suites declare `requires_context` to refuse accidental tool-free execution. This shares EvalRunner's asserts and judges and introduces no scheduled work. See `../References/Progressive.md`.

## Safety gates

- `--scaffold` runs author-supplied bash as you — only on case files you authored.
- Guard cost with `--max-cost-usd` on exploratory suites.
- Results publish an HTML report to claude.ai by default — pass `--no-publish` for anything containing identity-bound or Restricted content, and keep such cases out of this lane entirely when possible (contamination hygiene).

## Gotchas

- Flags can change between releases: every schema fact here dates to 2026-08-25; re-verify `--help` before relying on a flag in automation.
- Agentic cases that grant Bash need a sandbox that can start.
