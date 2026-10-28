# Council

Status: test -f ~/.codex/auth.json && echo ok · optional

## What it does

Council runs a structured debate between four experts written for your topic, so the weak parts of an idea show up before you commit to it. `Debate` runs three rounds and ends in a synthesis; `Quick` runs one round and a Proceed, Reconsider or Need full debate call. Each member is one direct model call, and the members are split across two vendors so the debate does not share one lineage's blind spots.

The Anthropic members run on your Claude login, which every LifeOS install has. The OpenAI members run through `LIFEOS/TOOLS/Inference.ts --vendor openai --no-fallback`, which needs a ChatGPT subscription login. Without it the OpenAI members fail and the transcript names each one as missing; the debate still runs with the members that answered, but on one lineage.

## Fill in

Nothing to write in a file. Install the `codex` command-line tool and sign in once:

```bash
bun install -g @openai/codex
codex login
```

Member briefs are written fresh for each topic, so there are no personas to define. Your own defaults, if you want any, go in a `PREFERENCES.md` under `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Council/`, which overrides the skill's.

## Accounts and secrets

- A ChatGPT subscription, signed in with `codex login`, which stores the login in `~/.codex/auth.json`. No API key is used on this path and nothing goes in `~/.claude/.env`.
- A logged-in `claude` command for the Anthropic members.
- `--no-fallback` is deliberate: without it a failed OpenAI member would be answered by Anthropic and the council would quietly lose its second lineage.

## Prove it works

```bash
test -f ~/.codex/auth.json && command -v codex && echo "openai lane ready"
bun ~/.claude/LIFEOS/TOOLS/Inference.ts --help
```

The first prints the path to `codex` and `openai lane ready`; with either piece missing it prints nothing. The second prints the one-line usage (`Usage: bun Inference.ts [--level low|medium|high|max] [--vendor openai|anthropic|anthropic-api] ...`) and exits 1 by design, since no prompt was given. To prove the OpenAI lane end to end, make one small live call, which uses your subscription: `bun ~/.claude/LIFEOS/TOOLS/Inference.ts --level low --vendor openai --no-fallback "Reply with one word." "Say OK."` should print a short answer, while a missing login exits 1 with `no ChatGPT subscription login`. Then ask your assistant for "quick council check: should a small team pick WebSockets or server-sent events for live updates?" and expect four named members with short takes and a Proceed, Reconsider or Need full debate call, and any member that did not run on its requested vendor named as such.
