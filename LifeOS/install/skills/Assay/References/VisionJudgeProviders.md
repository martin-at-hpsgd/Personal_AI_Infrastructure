# Vision rubric providers

Image rubric judging defaults to the OpenAI + Anthropic panel: both vendors judge each trial, a case passes only when both pass, the score is the lower, and a missing vendor gives no verdict. Google is never the default seat. Every Gemini call passes the shared evaluator-egress check (`LIFEOS/TOOLS/lib/EvaluatorEgress.ts`), whose approved-vendor set decides whether Google may receive private material; the install's provider rulings and their dates live in `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Assay/PREFERENCES.md` § Judge providers. Gemini judges a rubric only when a suite's config entry names Google, or on public material through the fallback below. The blind describer sends private material to OpenAI vision and uses Gemini only on `--public`. Image pairwise comparison runs on Gemini alone, so it judges private material only when that egress check approves Google. Text judging retains its own configuration.

The optional `${LIFEOS_DIR}/USER/CONFIG/vision-judge.json` selects a provider only for named suites (`LIFEOS/TOOLS/lib/VisionJudgeConfig.ts`):

```json
{
  "version": 1,
  "suites": {
    "example-image-suite": {
      "provider": "openai",
      "level": "medium",
      "fallback": "google"
    }
  }
}
```

An absent file or unlisted suite uses the panel. A suite entry is exactly `{"provider":"panel"}`, `{"provider":"anthropic"}`, `{"provider":"google"}` (the egress guard still applies), or OpenAI on the medium candidate lane with an optional Google fallback as above; malformed configuration is refused. Configuration is routing, not permission to disclose private images. Do not activate a private suite until its image bytes and grading text are authorized for that provider.

The OpenAI adapter (`Tools/OpenAIVision.ts`) resolves `CROSS_VENDOR.openaiJudge` and runs one fresh `codex exec -i` turn on a ChatGPT subscription through `runCodexOnSubscription` in `LIFEOS/TOOLS/Inference.ts`: the `codex` CLI on PATH (or `~/.bun/bin/codex`), logged in so `~/.codex/auth.json` exists. The child runs on that CLI login; with no login the seat is unavailable. The turn carries only the rubric, anchors, effective reference, and the one attached image, with no conversation history. The alias alone does not establish account access, image support, or grading quality.

## Public capability probe

After authorization for the provider call, run:

```bash
bun ${LIFEOS_SKILL_DIR}/Tools/ProbeOpenAIVision.ts --run-public-probe
```

This command accepts no image path. It freshly synthesizes a red square on white and asks the medium candidate to identify its color and shape. A pass establishes only that this API lane interpreted that synthetic image; it does not certify private-image quality. A private-image calibration is a separate authorized operation.

## Failure and calibration behavior

Optional Google fallback applies only when OpenAI is unavailable or returns an invalid verdict, and only for public material; a private image never falls through to Google. A valid low score or UNKNOWN result is retained; neither triggers a search for a passing provider. Without fallback, an unavailable OpenAI evaluator produces no quality verdict. Identity and disabled-inference guards run before credentials or network access.

Trial rows retain requested and reported model provenance and identify fallback. Complete-trial reliability and unavailable-result handling remain enforced by ImageEvalRunner. Provider routing, model chain, image bytes, grading text, and executable pipeline bind calibration; a changed provider or implementation requires recalibration. Keep previous measurements as historical evidence rather than presenting them as current certificates.
