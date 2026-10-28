# Assay

Status: bun ~/.claude/LIFEOS/TOOLS/Secrets.ts has CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN · optional

## What it does

Assay checks AI output against what was asked. Code assertions run first and cost nothing. Fuzzy checks go to a calibrated model judge, to a fast yes/no question layer (the judgment layer), or to you. Suites run each case several times and report pass^k, pass@k and confidence intervals. Code assertions, text suites and A/B comparisons work on a bare install. Image judging and the judgment layer need the accounts below.

## Fill in

Mostly nothing. Eval suites ship under `skills/Assay/Suites/`, and your own live in your user folder. Three optional files under your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`):

- `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Assay/PREFERENCES.md` and `config.json`, which the skill reads before it runs. Identity-bound suites and calibration sets live in that folder too. `config.json` keys: `config_change_suite` (the suite run after a behaviour-defining file changes, default `core-dispositions`) and `ocr_signature_mask` (required by the `ocr-word-ratio` image assert, which errors naming the file and key when it is missing: `false` for no mask, the shipped template value, or `{"x0": 0.8, "y0": 0.85}` to blank the bottom-right corner from those fractions of width and height so a signature stamp on your images is not read as garbled text). `PREFERENCES.md` holds your judge-provider rulings, such as which vendors may see private images, under `## Judge providers`. Two more files there are optional: `IdentityTerms.json` (key `terms`, a list of extra user names Proof's safety scan treats as your own home path, so `/Users/<term>/` in an output fails a send, publish or deploy; the template ships `{"terms": []}`, and absent means none) and `Proof/standing-<kind>.json` (your standing Proof checks per output kind, key `checks`; `Proof.ts miss` writes them, absent means none).
- `LIFEOS/USER/CONFIG/vision-judge.json`, which chooses the image judge per suite. Made-up example:

```json
{
  "version": 1,
  "suites": {
    "my-hero-images": { "provider": "openai", "level": "medium" },
    "my-layout-check": { "provider": "panel" }
  }
}
```

A suite with no entry uses the default panel: OpenAI and Anthropic both judge each image, and it passes only when both pass.
- `LIFEOS/USER/CONFIG/assay-callers.json`, the registry of judgment-layer callers. The installer scaffolds it with the shipped callers; edit it only if you use that layer.

## Accounts and secrets

| Name | Needed for | Account to open |
|---|---|---|
| the `claude` command, logged in | text judges (`Judge.ts`), through `LIFEOS/TOOLS/Inference.ts` and the signed-in `claude` CLI | A Claude subscription |
| the `codex` command, logged in to ChatGPT (`codex login`, which writes `~/.codex/auth.json`) | the OpenAI half of the image judge panel, run as `codex exec -i` through the signed-in `codex` CLI; without the login that seat is unavailable | A ChatGPT subscription |
| `GOOGLE_API_KEY` | Gemini: image pairwise and tournaments, suites whose `vision-judge.json` entry names Google, and the public-material fallback | A Google AI Studio account (aistudio.google.com) |
| `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` | the judgment layer's engine, a model on Cloudflare Workers AI | A Cloudflare account; the token needs Workers AI access |

The judgment layer calls the Workers AI REST API directly, so you deploy no Worker. Without the Cloudflare pair every judgment-layer call stops with a `no-key` error and writes that to its log; nothing else in Assay is affected. After editing `.env`, run `bun ~/.claude/LIFEOS/TOOLS/Secrets.ts seal`.

## Prove it works

```bash
cd ~/.claude
bun LIFEOS/TOOLS/Secrets.ts has CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN
test -f ~/.codex/auth.json && echo codex-login yes
bun LIFEOS/ASSAY/QuestionSystem.ts validate LIFEOS/ASSAY/fixtures/question-system.example.json
bun LIFEOS/ASSAY/Engine.ts probe
bun skills/Assay/Tools/SuiteManager.ts
```

Success: the first command prints `yes` for each key you set up, and the second prints `codex-login yes` when the OpenAI image seat can run. The third prints `valid (0 warning(s))` and works with no key at all. The fourth makes one live call to the judgment engine and prints JSON with a `model`, a `request_id` and a `latency_ms`; without the Cloudflare pair it fails with a `no-key` error naming the missing credentials. The last lists your eval suites with their case counts and last result (`SUITES (N)`).
