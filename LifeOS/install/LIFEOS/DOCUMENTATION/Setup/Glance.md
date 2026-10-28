---
version: 1.0.2
---

# Assay's judgment layer

Status: `bun LIFEOS/ASSAY/Assay.ts status` · optional

## What it does

Wherever LifeOS code has to make a fuzzy call ("is this message urgent?", "did this answer cover the ask?"), it asks Assay's judgment layer one typed question and gets back a probability and a yes or no on whether it may act. The model that produces the number is an engine called Clef-omni, a Cloudflare Workers AI model that reads text, images, audio and video, running underneath.

The judgment layer is careful by design. Every caller starts in shadow mode: its answers are logged next to what actually happened, but nothing acts on them. A caller moves to enforce only after its answers have been measured against human labels. So an empty registry is the right state for a new install, and nothing breaks without it: each call site is built so that its session, eval or job can still finish when the judgment layer is off.

## Fill in

`LIFEOS/USER/CONFIG/assay-callers.json` is the caller registry. The shipped file holds only a `defaults` row:

```json
{ "defaults": { "min_labels": 10, "provisional_threshold": 0.85 } }
```

`min_labels` is how many human labels a question needs before it can earn authority. `provisional_threshold` is the starting cut for a newly registered question. Every other top-level name is a caller, with its mode (`shadow` or `enforce`), thresholds per question, daily budget and the source of its ground-truth labels. You rarely write these by hand: the Assay skill's CreateQuestions intent designs a question set for a decision and emits a shadow registry row for you to add, and `bunker miss` registers new questions from judged misses.
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

## Accounts and secrets

The judgment layer needs a Cloudflare account with Workers AI. Put the account id in `~/.claude/.env` as `CLOUDFLARE_ACCOUNT_ID` and your Cloudflare API token as `CLOUDFLARE_API_TOKEN`, and seal it. That is the same one token every other Cloudflare tool in LifeOS uses; it needs Workers AI access, and the judgment layer reads no second Cloudflare token:

```bash
bun LIFEOS/TOOLS/Secrets.ts seal
bun LIFEOS/TOOLS/Secrets.ts has CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN   # prints "KEY yes" or "no" for each
```

The question text, state and any images, audio or video you send go to Cloudflare's Workers AI API on your own account. The client refuses any text that contains a secret-shaped value, but it cannot scan media bytes, so attach only media you mean to send. Without the credentials, a judgment call fails with `CLOUDFLARE_ACCOUNT_ID is not set`; call sites that are set to fail open carry on without the judgment.

Extraction (`extract()`, through Clairic) runs on the same account and token, so it needs no further setup.

## Prove it works

```bash
bun LIFEOS/ASSAY/Assay.ts status        # one line per registered caller: mode, calls in 24h, error rate, agreement
bun LIFEOS/ASSAY/Assay.ts callers       # callers in the registry, and any seen in the log but not registered
bun LIFEOS/ASSAY/Engine.ts probe        # one live call to the engine; proves the credentials and the network path
```

On a fresh install `status` prints nothing and exits 0, because the registry has no callers yet. That is the expected state, not a fault. `probe` is the real test of the credentials: it prints a model name, a request id and an answer for a harmless sentence, and exits 1 with `CLOUDFLARE_ACCOUNT_ID is not set` when the account id is missing.

To turn the judgment layer off for a session without removing anything, set `LIFEOS_GLANCE_DISABLED=1`.
