# BeCreative

Status: test -f ~/.codex/auth.json && echo ok · optional

## What it does

BeCreative produces ideas that are not the model's most probable answer: it generates several distinct candidates in one pass and surfaces the strongest, or expands a small seed corpus into a larger, measurably more diverse one. Six of its seven intents run on the model you are already talking to, with nothing to set up. `SyntheticDataExpansion` also scores diversity with `Tools/Diversity.ts`, which is offline.

The seventh, `TechnicalCreativity`, deliberately asks two vendors for five solutions each and merges them, because one model's "diverse" set shares that model's defaults. It refuses to run on one vendor alone. The Anthropic half uses your Claude login. The OpenAI half is the part that needs setup.

## Fill in

Nothing to write in a file. The OpenAI half runs through `LIFEOS/TOOLS/Inference.ts --vendor openai`, which calls the `codex` command-line tool using a ChatGPT subscription login stored in `~/.codex/auth.json`. Install the tool and sign in once:

```bash
bun install -g @openai/codex
codex login
```

To make a different vendor the default for other unattended work, see `LIFEOS/DOCUMENTATION/Setup/Inference.md`. TechnicalCreativity passes `--vendor` on each call, so it does not depend on that default.

## Accounts and secrets

- A ChatGPT subscription (the OpenAI half signs in through `codex login`; no API key is used on this path and nothing goes in `~/.claude/.env`).
- A logged-in `claude` command for the Anthropic half, which every LifeOS install already has.
- Without the OpenAI login the OpenAI call fails with `codex CLI not found` or `no ChatGPT subscription login (~/.codex/auth.json); an API key is never used`, and `TechnicalCreativity` cannot produce its two-vendor set. Do not substitute a second Anthropic call: the intent forbids a one-vendor set. The other six intents are unaffected.

## Prove it works

```bash
test -f ~/.codex/auth.json && command -v codex && echo "openai lane ready"
bun ~/.claude/LIFEOS/TOOLS/Inference.ts --help
bun ~/.claude/skills/BeCreative/Tools/Diversity.ts index <(echo '["red apple pie recipe","blue ocean wave pattern","fast sorting algorithm"]')
```

The first prints the path to `codex` and `openai lane ready`; with either piece missing it prints nothing. The second prints the one-line usage (`Usage: bun Inference.ts [--level low|medium|high|max] [--vendor openai|anthropic|anthropic-api] ...`) and exits 1 by design, since no prompt was given. The third runs the offline diversity tool on three made-up ideas and prints one line, `{"file":"/dev/fd/…","n":3,"meanPairwiseSimilarity":0,"diversityIndex":1}`, because the three share no words. To prove the OpenAI lane end to end, make one small live call, which uses your subscription: `bun ~/.claude/LIFEOS/TOOLS/Inference.ts --level low --vendor openai --no-fallback "Reply with one word." "Say OK."` should print a short answer. Then ask your assistant for "technical creativity: three ways to dedupe a 10 GB log" and expect solutions labelled with the vendor that produced each.
