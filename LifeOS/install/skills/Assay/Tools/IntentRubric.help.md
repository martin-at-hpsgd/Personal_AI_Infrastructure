# IntentRubric.ts — an intent's Ideal State as a suite rubric

Every skill intent opens with `## Ideal State` (testable outcome bullets) and `## Anti-criteria` (what must never happen); `LIFEOS/DOCUMENTATION/Skills/SkillSystem.md` § Intent anatomy. IntentRubric turns those bullets into the rubric a skill's eval suite grades on, in the suite format `EvalRunner.ts` already reads, so the definition of done the model reads is the one its output is scored against. Every bullet is tiered through Proof's one compiler (`compileIntent`). Deterministic except `--compile-fixtures`, which makes one model call per case at the top level through Inference.ts. Intents are parsed only through `LIFEOS/TOOLS/lib/IntentSections.ts`.

## Commands

```
bun skills/Assay/Tools/IntentRubric.ts rubric <intent.md | skills/<Skill>> [--json]
bun skills/Assay/Tools/IntentRubric.ts suite <intent.md | skills/<Skill>> --name <suite-name> (--prompt "<p>" [--prompt ...] | --cases <cases.yaml>)
    [--system-prompt-file <path>] [--judge-level low|medium|high] [--type capability|regression] [--trials N] [--threshold 0.75] [--compile-fixtures] [--out <file.yaml> [--force]] [--json]
```

- `rubric` prints each intent's assert list as YAML (`--json`: one object per intent with `gap` set when it has no Ideal State). Exit 1 when no intent in the source has Ideal State bullets.
- `suite` builds a whole suite and validates it with `SuiteManager.validateSuite` before printing or writing. `--out` writes atomically and refuses an existing file without `--force`. With no `--out`, the YAML goes to stdout.
- `--judge-level` pins the judge level in the suite. Omit it for EvalRunner's calibrated-cheap default ('low' with an earned calibration record, else 'high'); a pinned 'low' on an uncalibrated suite runs provisional, as any explicit level does.
- The source is one intent file (`skills/<S>/Intents/<I>.md`, or the `SKILL.md` of a skill with no `Intents/`) or a skill directory (every `Intents/*.md`, sorted). An intent with no Ideal State bullets is skipped with a line on stderr, never silently.

- `--compile-fixtures` writes, per case, one output for each bullet that breaks exactly that bullet and meets the rest (`compileFixtures`, level `max`); fixtures a case brings in `fixtures:` win.

Exit: 0 ok · 1 no usable Ideal State, no adversarial fixture, or the generated suite does not validate · 64 usage.

## What the rubric is

Each bullet goes through `Proof.compileIntent` (kind `text`), the same tiering Proof uses at run time:

- A countable bullet ("under 120 words", "at most 5 bullets", "between 3 and 6 headings") becomes deterministic `regex` / `not-regex` asserts with `required: true` and `metric` naming the count type. The regexes count the way Proof does (words carrying a letter or digit, trimmed characters, Proof's bullet/heading/link/sentence/paragraph patterns), with atomic steps so a miss never backtracks exponentially. An Anti-criteria count is the inverted bound ("more than 3 links" holds the output to at most 3).
- A readable bullet becomes one single-claim `llm-assert` (`value: [<bullet>]`); a readable Anti-criteria bullet one `not-llm-assert` (`value: ["The output does what this anti-criterion forbids: \"<bullet>\""]`), which passes when the judge says FALSE. UNKNOWN is a miss either way (Judge.ts).
- A countable bullet that also asks something the count cannot see ("at most 5 bullets, each naming a primary source") keeps a judged assert for the bullet beside its code asserts. A bullet the compiler drops (a count with no code counter, such as "at most 5 items") falls back to a judged assert. No bullet is ever ungraded.
- Every assert carries `derived_from: <intent path>#IS-n` or `#AC-n`. The path is repo-relative under `~/.claude` (absolute elsewhere). `EvalRunner.suiteIdealState` reads that lineage, and `Calibrate.ts --residue` sees no unlineaged judged assert.
- Every assert carries a targeted `fixture` when one exists: an output that breaks exactly that bullet. A code assert's fixture is synthesized and checked to fail its assert before it ships. A judged assert's fixture comes from the case or `--compile-fixtures`, and is kept only when it passes every deterministic assert of the case.

## Cases

Cases come from real use, never invented ones (CreateSuite § Sourcing; `FailureToCase.ts` drafts them from failures). `--prompt` gives one case per prompt and needs a single-intent source. `--cases <file.yaml>` takes a list (or `{cases: [...]}`) of:

```yaml
- id: tides_outline            # optional; default <intent>_<n>
  prompt: "Outline a post on tides."
  intent: Outline              # required when the source has several intents
  negative: true               # optional should-NOT case
  reference: "<source text>"   # optional: added to every judged assert as the REFERENCE the judge grades against
  fixtures:                    # optional targeted fixtures, keyed by bullet id; each breaks exactly that bullet
    IS-1: "<an outline whose sections have no purpose line>"
  adversarial_output: "..."    # optional; defaults to the first judged bullet's fixture
  assert:                      # optional hand-written asserts for what the bullets do not cover
    - { type: not-icontains, value: "lorem" }
```

Each case gets its intent's rubric first, then its own asserts. A judged suite needs an adversarial fixture (SuiteManager rejects one without). The case's `adversarial_output` is its own, else the first judged bullet's fixture. There is no canned default: with no fixture at all, `suite` exits 1 and names the fix (bring `fixtures:` or pass `--compile-fixtures`).

## Gotchas

- Regenerate the suite when the intent changes: the rubric is a copy of the bullets at generation time, and the header comment records each intent's sha256 prefix. A rubric edit also makes any calibration record stale (Calibrate).
- A bullet that describes something invisible in one text answer (a file written, a tool called) cannot pass single-shot. Sharpen the bullet to an observable outcome, or run that intent in the agentic lane (RunAgentic).
- The judged asserts are single-claim `llm-assert`s, so each reaches the judgment layer as one noul before any model judge; they never need anchors. Countable bullets are code here and in Proof (`--intent`) alike: one compiler.
- Suites generated before v2.0.0 still carry one judged assert per bullet and may carry the old canned fixture. They are not rewritten; regenerate one to move it to the tiered rubric.
