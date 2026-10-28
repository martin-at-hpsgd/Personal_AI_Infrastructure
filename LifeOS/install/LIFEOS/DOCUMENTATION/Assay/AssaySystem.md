---
version: 1.4.2
last_updated: 2026-10-26T00:00:00.000Z
last_updated_by: da
convention: lifeos-freshness-v1
---

# Assay: the eval system

> Assay answers one question about anything LifeOS produces: how close is this to the ideal state it was made for? It checks the output, cheapest check first, and writes one receipt bound to the exact bytes it checked. Gates read that receipt and never run a judge themselves.

The concept this doc serves is in `../LifeOs/HillClimbing.md`. That doc says why the loop exists. This one says what Assay does inside it, including its judgment layer (§ Judgment layer), which answers the fuzzy questions the second tier asks.

## What Assay owns

| Assay owns | Where |
|---|---|
| Every check on an output, from a word count to a model judge | `skills/Assay/Tools/Proof.ts`, `skills/Assay/Tools/Judge.ts` |
| The regression runner for skills, prompts and models (fixture cases, pass^k) | `skills/Assay/Tools/EvalRunner.ts` |
| The receipt: schema, validation, freshness, the verdict rule | `LIFEOS/TOOLS/lib/ProofReceipt.ts` |
| The label store and the definition of "earned" | `LIFEOS/TOOLS/lib/LabelStore.ts` |
| The send gate, which runs inside every send and publish tool | `LIFEOS/TOOLS/lib/SendGate.ts` |
| The table of which file kinds Proof can measure | `LIFEOS/TOOLS/lib/ProofKinds.ts` |
| The weekly label batch and the coverage reconciler | `LIFEOS/TOOLS/LabelBatch.ts`, `LIFEOS/TOOLS/OutputReconciler.ts` |
| The judgment layer: typed questions, probabilities, thresholds, `decide()`, the caller registry and ledger | `LIFEOS/ASSAY/Assay.ts` (§ Judgment layer) |
| The judge panel: several producers' outputs on one input, graded blind by judges from other vendors | `LIFEOS/ASSAY/Panel.ts` (§ Judge panel) |
| Evals written from an ISA: compile, merge, split, and the shared check libraries | `skills/Assay/Tools/Compile.ts`, `skills/Assay/Tools/CompileEstate.ts`, `skills/Assay/Libraries/` (§ Compile from an ISA) |
| Extraction (typed values out of text and images, through Clairic) and pipelines (code, extract, decide, write, measured against an LLM-only baseline) | `LIFEOS/ASSAY/Extract.ts`, `extract()` in `LIFEOS/ASSAY/Assay.ts`, `LIFEOS/ASSAY/QuestionSystem.ts` (§ Extraction, § Pipelines) |

## One eval system

Every eval and every judge in LifeOS runs through Assay. That covers a code assert on an output, a model that grades, scores, ranks, critiques or passes judgment on anything, a comparison of models, prompts or drafts, and a scheduled quality check. Assay is simply our name for evals (2026-10-13). Code that needs a judgment calls Assay's entry points (`Judge.ts`, `Tournament.ts`, `VisionJudge.ts`, `EvalRunner.ts`, `Proof.ts`, `Panel.ts`, the judgment layer in `Assay.ts`), and it carries no judge prompt or grading loop of its own. The caller owns only its rubric content, taken from its ISA or intent.

Assay holds to the Bitter Lesson the same as everything else. When a hand-rolled judge does a better job than Assay would (a stronger judge, a fairer protocol, a needed vendor), the fix is to move that capability into Assay so every eval gets it. It is never a reason to keep the judge outside. `LIFEOS/ASSAY/tests/OneEvalSystem.test.ts` (not in the public release) fails when a file outside Assay calls a model and carries grading language without importing Assay. Its allowlist holds only judges that are named, dated and waiting to migrate.

**One judge transport.** Every model call a judge makes goes through Assay's transport layer in `LIFEOS/ASSAY/`: `JudgeCall.ts` for text (`judgeText`, `namedJudge`) and images (`judgeImage`, with `skills/Assay/Tools/AnthropicVision.ts` and `OpenAIVision.ts` as its seats), `AgenticJudge.ts` for a read-only agentic audit that reads a tree (codex, strict schema), and `VideoJudge.ts` for video (Gemini Files API). A new vendor, model or modality is added there once. Vendor comes from the model id that answered (`vendorOf`), never a lane name. Callers outside Assay (the deploy reviewer, the cross-vendor audit, ArtDirection, JudgeArt, VideoMeaning, IsaLadder, VideoPiiGate) keep only their rubric and acceptance bar.

**Judge strength.** A judge is at least as capable as the work it grades. The rung of a model comes from the registry's own level tables (`levelOfModel`: Claude tiers through `EFFORT_MODEL`, OpenAI ids through the `openai<Level>` keys); a model with no rung there is unrated, and the report says so rather than counting it as a pass. Single-output judges stay capped at `high` unless the caller names the subject, and then the ceiling rises to the subject's rung (`judgeLevelForModel(judge, subject)`). A comparison panel defaults to the strongest judge each vendor offers, read from the registry's `STRONGEST` map in `models.ts` (`strongestJudge`; Fable, Sol and Argon today), and its report flags any judge below the strongest rated producer it graded. A vendor's declared strongest model rates at the top rung.

## What Assay never does

- It never produces what it checks. A model that wrote a draft does not grade that draft.
- It never checks the path, only the output. A skill that took an odd route to a good result passes.
- It never runs a model judge inside a gate. A gate looks up a recorded result.
- It never reads a judgment threshold. The judgment layer (§ Judgment layer) owns thresholds, and code asks its `decide()` whether an answer may act.
- It never lets an unearned check block. An unproven probability is a flag.
- It never stores a complaint. Errata stores complaints and joins to Assay's records.
- It never defines what done means. The ISA, or the ask itself, does that.

## What Assay reads and writes

| Reads | Writes |
|---|---|
| The artifact's bytes | Receipts, and a history line for every replaced receipt |
| The ask (a brief, a prompt) or the ISA it is measured against | The compile cache (checks compiled from an ask, keyed by the ask's hash) |
| Standing checks: one file per kind, one per skill | Standing checks, when a miss is recorded |
| Judgment-layer answers, through `decide()` | Proxy labels, when a flag is dismissed |
| The label store (to decide what has earned the right to block) | Output lines, from the gates and send tools (never from a skill) |
| The run state of the session (which skill is running) | Crop images for visual findings, beside the receipt |

The record schemas are in `Records.md`.

## The four tiers

Assay runs checks from the cheapest tier to the most expensive and stops climbing as soon as a cheaper tier can answer.

| Tier | What it checks | When it runs | Can it block? |
|---|---|---|---|
| Code | Anything countable or literal: a word count, a required or forbidden phrase, a file that is non-empty, OCR geometry, loudness, a secret in the output | Every proof, first, in well under a second for text | Yes. A code failure always blocks |
| Judgment layer (the `glance` tier) | A question that needs reading but not deep reading ("does this open on the main point?"). One batch per proof | Every proof, second. Never inside a gate | Only when the question has earned the right to decide. Otherwise it flags |
| Model judge | Hard or ambiguous calls: art critique, deploy review, regression suites | After delivery, as a profile behind `Judge.ts`, or at the end of a Development run and at deploy through `Review.ts`. Never inside a gate | Only when its calibration reads earned against the principal's labels. Otherwise it flags |
| Principal | Taste. The principal's reaction to delivered work | After delivery | Not a gate. A reaction becomes a label that calibrates the tiers above |

"Earned" has one definition, `earnedStatus` in `LabelStore.ts`. A judgment-layer question or a judge has earned the right to decide when enough of the principal's own right and wrong labels agree with it, above the bar the registry names for that caller. A dismissal and an agreement between two models never count. Where labels carry the true class (calibration does), each class needs at least two labels and better-than-coin agreement, so a judge that always gives one answer cannot earn. The weekly label batch asks only about flags, so it measures whether a flag is right when it fires; a check that flags everything collects "wrong" labels and never earns. A calibration result file is what binds labels to one judge chain, so labels with no record never read earned. The label store holds both kinds and marks the second kind as a proxy. A judge's calibration reads the same definition: `Calibration.calibrationStatus` derives `earned` from `earnedStatus` for the check `calibration:<suite>`, and `Review.ts` asks `calibrationStatus` for its reviewer lane. The pairwise calibrator (`PairwiseCalibrate.ts`) still keeps its own label set and its own result file; until it writes through `recordCalibrationLabels` its verdicts do not feed this definition.

On every install, raw sender commands in Bash are denied, so a send goes only through a send tool, and each send tool runs the send gate (§ The four boundaries, 2), which writes a `blocked` output line when it denies (`Records.md`). The per-call hook gates that also covered MCP and `Artifact*` tools (CommunicationSkillGuard, McpSendGateWrapper) were retired 2026-10-24: `ask` rules on the MCP send tools hold them now, and the send tools carry their own gate check. `LIFEOS/TOOLS/lib/McpWriteVerbs.ts` is read by `OutputReconciler.ts`, which counts MCP sends after the fact when it is run; its one rule treats a name as a read when it carries a read verb (get, list, read, search, query and the like) and no write verb anywhere, plus two exact-name draft tools. The delivery backstop records files that land in a delivery root by two scans. After every tool call, a fast scan looks at Downloads and Desktop wherever something changed (the top level and one folder down, by each folder's change time) and at any path the call named. Once a day the reconciler walks Downloads and Desktop completely (eight levels, each with its own budget); for Documents, iCloud Drive and cloud drives it checks only the paths the independent activity log names as DA writes, and never lists a cloud folder, because listing placeholders can download them. ProofGate, which used to gate hand-offs into Downloads and Desktop, was retired 2026-10-24; every root is recorded and none is gated. A file whose kind `ProofKinds.ts` does not know is recorded as "other". A blocked send-tool call writes a `blocked` output line too.

Receipts record the tier of every finding (`code`, `glance` or `judge`), so a reader can see which tier said what. Proof itself runs code and the judgment layer, plus two judges: the default layout class's panel questions on video, image and page runs (§ The default layout class), and the opt-in `run --escalate` judge for checks the judgment layer left unsure. The rest of the judge tier comes from the specialist checkers that write the same receipt: art critique, deploy review and the eval runner.

## How deep a check goes

Code picks the depth, never a model. `planDepth` in `LIFEOS/TOOLS/lib/EvalDepth.ts` (not in the public release) is a pure function over one table and answers in well under a millisecond. It reads where the output is going (the receipt's destination), its blast class, whether this skill version, intent hash and check set are new, each check's earned status, and memo hits (a finding already stored for these bytes, this check and this evaluator). A memo hit skips that check's judged layers; D0 runs every time regardless. The table below is `renderDepthTable()` pasted verbatim, and `EvalDepth.test.ts` fails when the two differ.

| Depth | Adds | When | Blocks |
|---|---|---|---|
| D0 | safety profile plus every compiled code assert | every output, skill run and ISA row, every time | yes, a code failure always blocks |
| D1 | one judgment-layer batch carrying every readable check | any output with a readable check that has no memoized finding | only through earned checks |
| D2 | anchored rubric judge on checks D1 left unsure or unearned | send, publish, deploy and isa-close: finished before the boundary. Hand-off and none: async from the judge queue, sampled at 25% unless novel or high blast | only through earned checks; async never blocks |
| D3 | champion tournament against the last accepted output | taste checks, skill or prompt changes, and climbs; never on delivery | never |
| D4 | The principal | only checks where tiers disagree or a likely false pass was found | never; the answer becomes a label |

Holdout: 10% of artifacts, chosen by a hash of the artifact's sha256, always get the next tier. Earned checks D1 settled also go to D2, and a hand-off's sampled-out D2 runs. Holdout work is async and never blocks.

The async layers go to the judge queue (`LIFEOS/TOOLS/lib/JudgeQueue.ts` (not in the public release)). A caller enqueues one job per artifact with its judged checks, and the job is refused for send, publish, deploy and isa-close unless it is holdout measurement, because those judges finish before the boundary. The `assay-judge-queue` workflow drains it: each job is judged through `Judge.ts` only if the file still holds the queued bytes, and its findings are appended to the artifact's receipt as post-delivery findings (`Records.md` § Append-only), always as flags, since the queue never decides. With no receipt for those bytes, the findings stay on the job's `done` line in the ledger (`MEMORY/STATE/Assay/judge-queue.jsonl`). A gate never imports the queue, and a test walks every gate's imports to hold that. `bun LIFEOS/TOOLS/lib/JudgeQueue.ts status` shows what is waiting.

## Kinds and what Proof measures

A kind comes from the file's extension. `ProofKinds.ts` is the only extension list in the system, and it also says which kinds Proof can really measure.

| Kind | Extensions | What Proof measures |
|---|---|---|
| video | mp4, mov, webm, mkv, m4v | Sampled frames: OCR presence and absence, prominence, overlay marks, price legibility, loudness, audible gate steps, and, when the source composition is given, a match between the film and that composition: word overlap on sampled frames, plus a pixel check (grayscale SSIM at 540 px wide, floor 0.93) that fails as `composition-pixels` when the film's pixels left the composition even if every word survived, for example after a font swap at compile time. Pixels are still compared when no frame has legible words, and a frame pair ffmpeg cannot compare is `unavailable`, never a pass |
| image | png, jpg, jpeg, webp, gif, tif, tiff, bmp | OCR, prominence, overlay marks, non-degenerate pixels |
| audio | wav, mp3, m4a, flac, aac, ogg, aiff | Loudness and audible gate steps |
| text | txt, md, markdown, json, csv | The text itself: non-empty, required and forbidden phrases, counts, judgment-layer questions, the safety scan |
| page | html, htm | The visible text, extracted in code with no browser, then the text checks. With a project directory a page also gets frames and OCR |
| doc | pdf, docx, doc, rtf, odt | Text extracted with `pdftotext` or `textutil`, then the text checks. No visual measurement |

Slide decks, Keynote files, spreadsheets and Pages files are not measurable. They are handed over with an `UNPROOFED` line the assistant must say aloud.

Two honesty rules hold for every kind. An extractor that fails (missing binary, encrypted PDF, a scan with no text layer) records an `unavailable` finding, never a pass. An OCR token read at low confidence never decides a check, so a frame where the deciding word reads only weakly is `unavailable` for that check.

## The default layout class

Every video, image and page run carries layout checks whether or not the ask mentions layout. They have reserved ids (the `layout-default-` prefix, like `safety-`), and no brief, standing check or checks file can drop or edit them; a compiled check of type `layout-fit` or `layout-judge` is dropped too. A brief can only add checks.

- **`layout-default-fit` (code).** With `--project` (a video or a page), `skills/HyperFrames/Tools/TextFit.ts` runs on the composition, and each finding of kind occluded, canvas-text, connector, align, clipped or frame is a code fail with its time, selector and detail. Without `--project` the check is recorded as not applicable, never as a pass.
- **`layout-default-judge` (judged).** The four questions of `skills/Assay/Suites/Capability/visual-layout.yaml` (not in the public release) are asked of up to 12 sampled frames through the VisionJudge panel, which is OpenAI plus Anthropic and never Google. A question both vendors fail is a blocking fail only once the suite's calibration record has earned; until then it is a flag. A question one vendor fails is always a flag, and a missing seat is `unavailable`. Each finding carries a whole-frame crop and the suite's calibration.
- **Where no judge runs.** After a safety fail the judge is withheld. A caller that runs inside a gate passes no layout judge, so the receipt records `not-run`, which is never counted as a pass.

## Compile from the ask

Most outputs have an ask: a prompt, a brief, a request. Proof can compile typed checks straight from it.

1. `run --ask <file|->` sends the ask to one model call on the cheapest lane that holds quality. The call returns checks, and each check must quote the line of the ask it came from. A check whose quote is not in the ask is dropped.
2. The result is cached by the hash of the compile version, the kind and the ask. `plan --ask` fills the same cache, so the compile can start as soon as the ask is known and the check at the boundary makes no model call.
3. Anything countable is code, never a judgment-layer question. A "fewer than 80 words" requirement compiles to a word-count check. A deterministic pre-pass pulls counts and bounds out of the ask by pattern before any model runs, and it rewrites a judgment question that is really a count.
4. If the compile cannot run, the proof still runs with the deterministic checks and records an `unavailable` finding named `compile`. The verdict can be a fail but never a clean pass.

A skill can also carry standing checks, grown from misses: when the principal catches something Proof did not, `miss --skill <Name>` appends a check to that skill's standing file, and it applies to every later proof of that skill's output. A check that is dismissed repeatedly with no matching complaint becomes a candidate for retirement.

## Compile from an ISA

Proof compiles checks from one ask. `skills/Assay/Tools/Compile.ts` compiles them from an ISA. It writes one eval for each criterion that has none (a `manual` or invalid row is not an eval) or whose wording changed since its eval was compiled, at the cheapest tier the criterion allows: code, the judgment layer (a `glance` row), an anchored rubric judge, or a pairwise tournament. A compound criterion is flagged to split instead of compiled. The model call runs at level `max` through Inference.ts, and Compile never writes the ISA.

- **Proposal, then merge.** `--write` puts the proposal in `Evals.proposed.md` beside the ISA. In the main session, `Compile.ts merge` folds in the Test Strategy rows, the `## Evals` blocks (each carrying its criterion's sha) and the ledger lines, and `Compile.ts split` applies the proposed splits as a `[container]` parent with `<id>.1`, `<id>.2` children. Both refuse, writing nothing, when the ISA changed since the proposal was compiled. `CompileEstate.ts` runs the compile over every in-scope ISA and never merges.
- **Shared check libraries.** `skills/Assay/Libraries/` holds the checks every output of a type needs (blog-post, code-change, image, video, web-app). An ISA pulls one in with `output:` in its frontmatter, or Compile infers it from `artifact:` or `url:`. Inherited checks compile in code with no model call, and one is switched off only with `disable: <library>.<check> because <reason>`.
- **Checked in code before it is shown.** Paths must resolve where Bunker runs them. A rubric grades one dimension and anchors every level. A judged eval whose output is a file or page gets a rubric stage followed by a pairwise stage against `champion:last-accepted`. A pairwise candidate must be this run's own output, written by an earlier stage of the same block. A recompile keeps every output and code gate the previous eval had. A criterion that fails is regenerated once with the reasons and then reported, and a broken block is never emitted. A red code row never lands on a ticked criterion; it lands as a manual `EVAL OWED` row.

Flags and exit codes: `skills/Assay/Tools/Compile.help.md`. The block format is `../ISA/ISAFormat.md` § What compiled evals add.

## Intents as the criteria source

Every skill intent opens with `## Ideal State` (testable outcome bullets) and `## Anti-criteria` (what must never happen), per `../Skills/SkillSystem.md` § Intent anatomy. Assay reads those bullets as the criteria for that intent's output, so the definition of done the model reads is the one its output is held to, and a miss sharpens one definition instead of three. Intents are parsed only through `LIFEOS/TOOLS/lib/IntentSections.ts`.

Every intent run executes its eval set before anything reaches anyone (principal directive, 2026-10-24). The set is the intent's own Ideal State and Anti-criteria checks plus every shared suite the intent names in a `## Evals` section, such as `video-eval` (`skills/Assay/Tools/VideoEval.ts`, 27 checks over a rendered video; flags in `skills/Assay/Tools/VideoEval.help.md`). VideoEval admits an intent only for bytes whose newest STATVS `render` row names that intent's pipeline, and `--composition` only when that row names the same project with a matching digest. Bytes with no row are refused under every intent and the refusal names the tool to re-run (Assay ISA ISC-116, ISC-120). A planted row never stands in for the DA essay badge (ISC-118). When an intent compiles for an image or a video, a minimum word or character count is dropped as a prose requirement (narration, script) because painted text is not that prose; a maximum still binds (`Proof.ts compileIntent`). Today the video pipelines (`VideoEssay/Tools/Run.ts eval`, StoryFilm's verify stage, `HyperFrames.ts render`) read `## Evals` and run that set; `Proof.ts run --intent` compiles the Ideal State and Anti-criteria checks. It runs cheapest tier first (§ The four tiers). A failed code check stops the output, and judges run in parallel only after the code tier passes. Judged findings are memoized by the bytes they judge, so a fix to one component re-runs only the checks that component touches, and the code tier for a two-minute video finishes in well under a minute. Delivery tools refuse without a passing receipt on the exact bytes (`skills/ArtDirection/Tools/Deliver.ts`, the send and hand-off gates in § The four boundaries). A video, image, page or document is never delivered or published on a self-review.

- **Per run (Proof).** `run --intent <intent.md>` turns each Ideal State bullet into a check and each Anti-criteria bullet into a must-not check, each quoting its bullet. A countable bullet becomes a code check; the rest are judgment-layer questions in the run's one batch. With an explicit `--skill` and no other ideal-state source, Proof uses the intent of that skill the session most recently read (from the tool log EventLogger writes). The receipt names the intent as its ideal state. An intent with no Ideal State falls back to the next source and records why.
- **Per skill (suites).** `skills/Assay/Tools/IntentRubric.ts` turns an intent, or every intent of a skill, into a suite rubric, tiering each bullet through Proof's one compiler (`compileIntent`). A countable bullet ("under 120 words", "at most 5 bullets") becomes deterministic `regex` or `not-regex` asserts, and an Anti-criteria count is the inverted bound. A readable bullet becomes one single-claim `llm-assert`, or a `not-llm-assert` for Anti-criteria. Every assert carries `derived_from: <intent>#IS-n|#AC-n` and, where one exists, a targeted fixture that breaks exactly that bullet (a code assert's fixture is synthesized and checked to fail; a judged assert's comes from the case or `--compile-fixtures`). There is no canned default fixture: a suite with none exits 1. A skill suite's rubric comes from its intents by default; hand-written asserts cover only what the bullets do not. The eval receipt names the intent when no ISA lineage is present.
- **Receipt shape.** The receipt schema admits `isa`, `ask` and `none` today. An intent is a small ISA, so an intent ideal state is recorded as `{kind: "isa", path, revision, criteria: [IS-1…, AC-1…], source: "intent", skill, intent}`, with `source` saying which it is.

## The safety profile and its destination rule

Every proof of a kind that has a body adds three code checks that no brief, plan or checks file can remove or edit: `safety-secret`, `safety-private-key` and `safety-home-path`. Check ids that start with `safety-` are reserved. A compiled, standing or hand-written check that tries to use one is dropped and named in the receipt's profile. The safety checks are never compiled by a model, and the compile prompt treats the artifact as untrusted evidence, so text inside an artifact cannot talk a safety check out of running.

The scan reads several views of the same bytes (raw, entity-decoded, visible text, normalized, base64 runs, whitespace-collapsed) so a simple encoding does not hide a hit. Values are masked in findings.

Severity depends on what was found and where the output is going. Every receipt carries a destination class: `handoff` (the default), `send`, `publish`, `deploy`, `isa-close` or `none`.

| Finding | Hand-off and other destinations | Send, publish, deploy |
|---|---|---|
| A real secret (a known secret shape with enough randomness, not placeholder-shaped) | Fail | Fail |
| A private-key block with a key body | Fail | Fail |
| A placeholder-shaped secret, or a bare key header | Flag | Flag |
| The real user's own home path | Flag | Fail |
| Any other user's home path | Flag | Flag |
| The documented install paths of the system | Not a finding | Not a finding |

The destination rule exists because a path in a file you read yourself harms nobody, and the same path in an email to someone else is a leak.

## Receipts

A receipt is Assay's verdict on one artifact, bound to the exact bytes by sha256. It also records what the artifact was measured against (an ISA path and revision, the sha256 of the ask, or an explicit "none" with a reason), the check-set version, the evaluator versions and the destination class.

- Freshness is by sha256, always. Size and modification time are never trusted, so a rewrite that keeps the size and restores the time reads as stale.
- A receipt is append-only. A later finding (a post-delivery judge, a principal catch) is added to the receipt with a time and a source. The verdict at the moment of the boundary run stays frozen in `verdict_at_boundary`, so a later catch reads as a false pass and does not rewrite history. A new boundary run for the same artifact moves the old receipt into a history file.
- The verdict is derived from the findings, never authored. A receipt that claims a pass its findings contradict fails validation, on write and on every read.
- The one verdict rule: a code-tier failure, a missing, stale or hand-edited receipt, an unmeasured check, or a "no" from an earned check means no. An unearned flag is recorded and named, and never blocks.
- A pass needs an ideal-state check that passed; the always-on safety checks do not count. A clean receipt where none passed is `admitted-flagged` when unearned flags carry it, and `unmeasured` when nothing flagged and only the safety checks ran. Neither is a pass. Gates admit both, `unmeasured` with an `UNMEASURED` line the assistant says when presenting, like `UNPROOFED`. A receipt stored as `pass` before this rule reads through `effectiveVerdict` as one of the two.

Four checkers write this receipt today: Proof (outputs), art critique (images and film), deploy review (a diff, keyed by the diff's hash) and the eval runner (a suite run). Development runs no longer write one (the climb tool that did was retired 2026-10-05), so Errata and HillClimb cannot yet join a complaint to a Development run. The full schema is in `Records.md`.

## The four boundaries

An output crosses into the world at four places. A rule sits at each. Every rule is a lookup of a recorded result, not a new judgment.

What a public install runs: the send gate inside each send tool (§ 2) is shipped and fails closed. The hand-off gate and its recorders (§ 1), the chat-connector send hook and the override minter (§ 2) are maintainer-side and not in the public release. On a public install nothing gates a hand-off, so run `bun skills/Assay/Tools/Proof.ts run --artifact <file>` before presenting a file, and a blocked send cannot be overridden: fix the content and re-run the send tool, which re-checks it.

### 1. Hand-off to the principal

The hand-off gate is a PreToolUse hook (maintainer-side; not in the public release). It looks for any way bytes reach the principal: opening a file, copying or moving into the delivery folders (Downloads and Desktop), a shell redirect, `tee` or a heredoc into them, a Write or Edit there, and an Artifact publish. It covers the class of ways, not a list of commands.

- The rule: the exact post-state bytes need a fresh receipt with no code failure and no earned failure. For a Write or Edit the gate computes the bytes the tool will leave behind. If the path has no receipt, it looks for a receipt anywhere in the store whose sha256 matches, so a file proofed in a scratch directory and copied into place is admitted.
- Denied: no receipt, a stale or hand-edited receipt, a code failure, an earned "no", or an unmeasured check. The denial names each file, why, and the exact Proof command that clears it.
- Allowed with a line of context: open unearned flags, dismissed flags, or a reference receipt. The assistant must say these when presenting the file.
- Allowed as `UNPROOFED`: a kind Proof cannot measure. The assistant must say so.
- Allowed as `UNMEASURED`: a fresh receipt on which no ideal-state check passed and nothing flagged, so only the always-on safety checks ran. The assistant must say so.
- `open` leaves text alone (opening text is editing) and ignores media older than 24 hours. Delivery paths are gated at any file age.
- The gate has a ten-second budget. Past it, files not yet verified are denied.
- A gate error fails open, loudly: the turn continues, a Vigil event is emitted, one context line says nothing was checked, and the output line records `allowed-labelled`.

The post-Bash backstop catches what the gate cannot parse. After every Bash call, a recorder scans the delivery folders for files that are new or changed and that no gate approval accounts for (an `ffmpeg`, `curl` or script writing into Downloads). Each one gets an output line with reason "landed outside the gate" and a Vigil event, and the assistant is told to proof the file before presenting it.

After a gated call succeeds, the output recorder hashes the bytes that landed and writes the output line. If the landed bytes differ from the bytes the gate approved, the line is `allowed-labelled` with receipt_id null and a Vigil event fires.

A substantial chat reply (300 words or more, or a fenced block over 40 lines) is also an output. It is logged, then proofed with the code tier at the next prompt. It is never blocked, and a short conversational reply gets no check at all.

### 2. Sends and publishes

The check lives inside each send tool, as a library call made immediately before the network call. That is why it holds for scheduled jobs, daemons and other agents, which no hook can promise. On the maintainer's install, chat-connector sends (Slack today) also go through a hook that calls the same library, and a tool name ending in `_draft` is exempt; that hook is not in the public release.

- Always re-checked. The gate runs Proof's code tier in process, at the send's own destination, on the exact bytes about to be transmitted, each attachment on its own. A stored receipt never admits a send. It can only add an earned "no" from a judge that really ran.
- No judge runs inside the gate.
- Fails closed. Any error inside the gate blocks the send and emits a Vigil event with the channel, kind and a hash prefix, never the body.
- A message addressed only to the principal is proofed as a hand-off, not a send, so the principal's own path only flags. A real secret still fails.
- A block writes a pending record and prints the exact bytes' location and the proof command. Where the override minter is installed it adds the line "Only the principal can override".
- Principal-only override (maintainer-side; not in the public release, so on a public install a block stays blocked). Only the principal's own prompt can release a block: an explicit phrase ("send it anyway", "override"), or a bare "y" when the block happened during the turn it answers. The hook mints a one-use, 15-minute token, signed with a key held in the operating system's keychain and bound to the channel, destination, session and the blocked hashes. Headless callers get no override, and a headless block is a high Vigil event.
- After a successful transmit, the tool writes one output line from the proofed copy of the bytes. A mismatch between sent and proofed bytes raises a Vigil event.

### 3. Deploys

Development Build and Modify runs end with the diff reviewer on the committed HEAD and fix its blockers inside the run. The deploy command calls it again before it ships and reviews only spans that no passing review covers. A model that did not write the change reviews it. A blocker stops the deploy, and so does a reviewer that cannot be reached; only `--waive-blockers "<reason>"` lets either through. Uncommitted files in scope stop it before any model call unless `--allow-dirty "<reason>"` is given, and that flag waives nothing else. A waived span never counts as reviewed, so the next review covers it again. `--accept` is retired. The review writes an assay receipt keyed by the diff's hash, with destination `deploy`. Review blockers appear in the receipt as fails only when the reviewer lane has earned that right, and as flags otherwise. `Review.ts audit` lists any deploy script that skips the review.

### 4. ISA close

The ISA gate reads the run ledger and runs no judge. For each criterion it finds the latest recorded result per row for the current criteria revision. A result recorded for an older revision is not evidence. A criterion with no Test Strategy row blocks close, and a criterion already checked off with no row blocks at any phase. Deferred criteria are counted, capped per ISA, and shown at close.

## Honesty rules

These three rules apply at every boundary.

Unavailable never passes. When a check could not be measured (a missing tool, a judgment-layer outage, a failed extraction, an exhausted budget), the finding is `unavailable`, the verdict is `unavailable`, and `Proof.ts` exits 2. At hand-off, a receipt with an unavailable verdict denies. A kind Proof cannot measure passes only with an `UNPROOFED` line. Nothing reads a missing evaluation as a pass.

Unearned flags never block. A judgment-layer "no" or a judge's "no" from a check that has not earned the right to decide is shown to the principal and recorded. Every flag the principal looks at can become a label. A flag dismissed to get something out the door is recorded as a proxy label that can never earn. A judgment-layer answer that is not confident either way is marked `unsure` and is a flag, never a pass.

Deterrent plus detector. The agent runs as the same operating-system user as the gates, so no gate is a wall. Each gate is a deterrent (a path guard, signed tokens, session binding, fail-closed sends) paired with a detector. The override mint log is cross-checked against the output ledger, and an override with no matching mint raises a critical Vigil event. The reconciler compares what the gates saw with what happened: files written, mail sent, pushes and deploys. An output that slipped around a gate shows up as a gap, not as a silence.

## Labels and calibration

One store holds every human verdict (`Records.md` has the schema). Promotion of a judgment question and a judge's earned status read only that store, and only from the principal's own right and wrong labels.

A short weekly batch asks the principal whether recent unearned flags were right, on real receipts, tied to the exact check. The principal's answers become principal labels. Labels do not arrive by accident, and that supply is what lets a check move from flagging to deciding.

## Coverage

The output ledger is written by the gates, so measuring coverage against it alone would be circular. The reconciler builds its denominator from events that happen whether or not a gate saw them: files written into the delivery folders, pushes, deploys and sends. It matches each event to an output line. Coverage is the share of reconciled events that carry a receipt, reported overall, by channel and by skill. An unmatched event is an escape, reported by kind, extension and hash prefix, never by name or path.

## Judge panel

When several producers answer the same input (models, prompts, drafts, lanes), `LIFEOS/ASSAY/Panel.ts` grades them against each other. The caller supplies the rubric, which comes from its own ISA, and the judges. The panel owns everything that keeps the comparison fair:

- Producer and vendor names are removed. Answers past the word budget are cut at the budget and marked. Labels are shuffled for each input and judge.
- A caller may also pass `plain: true` to `judgeOnce`, which runs every candidate through `plainForm` (`PLAIN_FORM` = `plain-form-v1`) before the judge reads it. The form is deterministic and keeps every word: headings and bold label lines become `Label:` lines, list markers, emphasis, code marks, table rules and fences go, each section joins into one paragraph, and dashes, quotes and ellipses take one form. It exists because formatting alone told the labs apart on the Gauntlet (2026-10-15), and a bench that judges through it records the form's version in its definition. `preferences` takes the caller's own counting rule as a third argument.
- One judge grades every candidate for an input in one pass, so the scale stays the same across candidates.
- Vendor comes from the model id that actually answered (`vendorOf`), never a lane name. A judge's grade never counts on a candidate from its own vendor. A preference between two candidates counts only from a judge outside both vendors.
- A malformed verdict is repaired if it is near-JSON and retried up to three times. One that never parses is recorded as unavailable, never as a low grade.
- Every judge gets a length check: the correlation between a candidate's length and its rank. It is flagged at |r| ≥ 0.5.
- Spreads across runs come from `skills/Assay/Tools/Stats.ts`. A lead is claimed only beyond two standard errors, and never from one run.

The panel's judges follow the judge-strength rule above, so they are the strongest model each vendor offers. It asks an anchored multi-dimension rubric in one call instead of one question per dimension. A paired comparison on 2026-10-13 (4 questions, 168 cells, Gemini judging each format twice) found split no more stable on rerun (0.26 against 0.27 points, interval includes zero) and further from the three-judge consensus (0.53 against 0.41, interval excludes zero) at seven times the calls. That is proxy evidence, because the consensus came from one-call judges; the check reruns on the principal's labels when they exist (Assay ISA ISC-78). Panel grades stay advisory until `Calibrate.ts` shows them agreeing with the principal's labels on a sample.

## Judgment layer

> Anywhere code has to make a fuzzy call, it asks the judgment layer one typed question and gets back a probability and a plain answer to "may I act on this." The layer owns everything that makes a judgment safe to use. The model that produces the number is an engine underneath it; today that engine is Clef-omni (§ Engine).

The judgment layer was a separate system named Glance until 2026-10-10, when it folded into Assay (principal, 2026-10-10: the judgment layer is part of the one eval system, Assay, and needs no name of its own). Its code lives in `LIFEOS/ASSAY/`, its criteria in `LIFEOS/ASSAY/ISA.md` (not in the public release). The word `glance` survives only as an identifier: the `glance` tier and row type, the `LIFEOS_GLANCE_*` environment variables, caller names such as `bunker-glance`, the Bunker `glance` stage keyword, the schema id `glance-question-system/v1`, the `glance-engine-bakeoff` workflow, and the `Glance*` names of a few exports and files.

**In the quality loop** (concept: `../LifeOs/HillClimbing.md`):

- **Owns:** the typed question, the probability, the threshold and `decide()`, effective mode, and the rule for earning authority.
- **Never does:** block on an unearned answer, write prose, replace a deterministic gate, or let any code act on a probability except through `decide()`.
- **Reads:** the caller registry and, to earn authority, human labels from the label store.
- **Writes:** one ledger line per call. Assay's receipts record the answers; the judgment layer never writes the receipt.

### The loop

1. A caller sends state and a map of typed questions: `choice` (one option from a set), `score` (a position on ordered levels), or `noul` (the probability that a yes/no question is yes). A noul answer resolves two-sided: the verdict is yes or no, and the confidence is the distance from a coin flip, so a confident no is as usable as a confident yes.
2. The layer checks the caller's sample rate and daily budget, asks the engine, and writes one ledger line whether the call worked or failed. A call the sample rate leaves out writes no line. The ledger never holds the state or the key.
3. `decide()` compares each answer to the threshold registered for that caller and question, and it is the only place a probability meets a threshold. It returns `act` (the only licence to act), `wouldAct` (what enforce would say, in every mode), `yes` (the raw reading at the registered cut), `effectiveMode`, the threshold and the reason.
4. A question in shadow always gets `act: false`. Its `wouldAct` is returned anyway, so a consumer may record a flag or a label candidate without reading a threshold itself. Answers are logged beside what actually happened, so an agreement rate exists before anything is allowed to act.
5. A caller moves to enforce only by a registry row that carries the agreement rate, the date, the model it was measured on, and the engine fingerprint it was promoted under. If the engine's model id or its fingerprint changes, that row goes back to shadow on its own (§ Engine evidence).

**Effective mode** is the lower of the caller's mode and the question's mode. A caller set to enforce whose questions are all shadow is shadow in effect, and `Assay.ts status` prints it that way, so the registry says what actually happens.

**Earning.** A question earns the right to act from human labels in the label store and from nothing else. Proxy labels (a dismissal to ship, a model's answer) and model-to-model agreement never count, and neither do labels that judged another engine's answers (§ Engine evidence). The one exception is a principal waiver: an enforce caller row may carry `waiver` (`by: "principal"`, `date`, `expires`, `reason`), which lets its questions act before labels earn them. A waiver lasts at most 31 days (`MAX_WAIVER_DAYS` in `Registry.ts`), and outside its window `decide()` returns `act: false` unless the labels have earned the question.

### Components

| Part | Where | Job |
|---|---|---|
| Front door | `LIFEOS/ASSAY/Assay.ts` | `judge()`, `judgeMany()`, `ask()`, `decide()`, budgets, the ledger, registry loading and validation, model-drift reverts. The CLI entry; it loads `Report.ts` only when the CLI runs, so a hook that imports `Assay.ts` never loads the reporting code |
| Measuring half | `LIFEOS/ASSAY/Report.ts` | Reports, threshold tuning, noul promotion, the agreement joins, status, outage alerts and the CLI verbs. `bun LIFEOS/ASSAY/Report.ts <verb>` is the same CLI as `Assay.ts <verb>` |
| Registry loader | `LIFEOS/ASSAY/Registry.ts` | The leaf module: the caller-registry shapes, where the registry lives and a raw read of it (`readRegistry`; `loadRegistry()` in `Assay.ts` adds the full validation); the live engine id (`liveEngineId`), stale stamps (`staleStamps`) and the canary fingerprint read (`currentFingerprint`). `registerQuestion` and `unregisterQuestion` live in `Assay.ts` |
| Extraction engine | `LIFEOS/ASSAY/Extract.ts` | The Clairic client only: field and answer types, the live-schema checks, image limits, the secret-shape refusal, the fetch, and the pure span check (`verifySpans`). Only `Assay.ts` imports its call (`callExtractor`); a test holds that |
| Engine | `LIFEOS/ASSAY/Engine.ts` | The vendor client only: Workers AI endpoint, credentials, question and answer types, media limits, redaction, the secret-value refusal, the fetch (`callEngine`, `redactForEngine`, `EngineError`, `EngineMedia`) |
| Registry | `USER/CONFIG/assay-callers.json` | Per caller: mode, thresholds per question, budgets, optional `sample_rate`, ground-truth join, enforce evidence. A top-level `defaults` row holds `min_labels` and `provisional_threshold`. Falls back to the legacy `jev-callers.json` (Jev retired 2026-10-10) |
| Ledger | `MEMORY/OBSERVABILITY/assay.jsonl` | One line per call; reports also read the legacy `jev-decisions.jsonl` (Jev retired 2026-10-10) so history remains visible |
| Question systems | `LIFEOS/ASSAY/QuestionSystem.ts` | The designed-system artifact: `validate`, `cases`, `run` (design-time measurement under the shadow caller `question-design`), `registry-row`, and `evaluate()`, which consuming code imports so design and production run the same policy |
| Engine canary | `LIFEOS/ASSAY/Fingerprint.ts` | Asks twenty fixed synthetic questions (`fixtures/engine-canary.json`) every day, hashes the rounded answers into the engine fingerprint, and runs the fingerprint-keyed drift check; the `assay-engine-fingerprint` workflow runs it (§ Engine evidence) |
| Engine bake-off | `LIFEOS/ASSAY/EngineBakeoff.ts` | Scores the engine and each second-option engine on the authored guard corpus; the `glance-engine-bakeoff` workflow runs it monthly (§ Second-option engines) |
| Haiku swap | `LIFEOS/ASSAY/HaikuSwap.ts` | Moves a call site that asked Haiku onto the judgment layer. The site asks the layer first and uses its answer only when the registry lets that question act; until then Haiku answers. Every pair of answers lands in `MEMORY/OBSERVABILITY/assay-haiku-pairs.jsonl`. `list <caller>` shows unlabelled pairs and `answer <caller> 1y 2n` records the principal's right and wrong labels, each tied to the engine that answered. While a caller acts, Haiku still answers 1 call in 10, and when the last 20 of those pairs agree under 85% the caller goes back to shadow and the drift event is written through STATVS `writeEvent()`, which hands it to Vigil |
| Replay (fixture form retired) | none; `LIFEOS/ASSAY/Replay.ts` (not in the public release) was deleted 2026-10-24 | `Assay.ts replay <rewind fixture>` used to replay a recorded moment against the PreToolUse guards. Those guards are retired, so the command now prints that and exits 2. Only `Assay.ts replay --review <case id>` runs, through `ReviewEntry.ts` (§ Replay) |
| Code reviewer evals | `LIFEOS/ASSAY/ReviewEntry.ts` | The code reviewer is evaluated through Assay. `Assay.ts replay --review <case id>` and `Assay.ts suite --review` call the suite in `LIFEOS/TOOLS/ReviewSuite.ts`, which replays past review misses on today's reviewer and on the model that missed them. `Assay.ts report` ends with a code reviewer block: the latest suite run, the catch rate per arm over admitted cases, and how often the `review-case-defect` judgment caller agrees with {{PRINCIPAL_NAME}}'s case labels. It only reads and makes no model call |
| Skill | `skills/Assay/` | `Skill("Assay")`; its CreateQuestions intent designs a question system for a decision problem, and `skills/Assay/References/QuestionDesign.md` is the design doctrine |
| Tests (source tree only; not in the release) | `LIFEOS/ASSAY/tests/` | The judgment-layer tests (`HookSmoke.ts` was retired 2026-10-25 with the two hooks it ran) |

The preferred overrides are `LIFEOS_GLANCE_CALLERS`, `LIFEOS_GLANCE_LOG`, and `LIFEOS_GLANCE_DISABLED`; their `LIFEOS_JEV_*` predecessors, named for Jev (retired 2026-10-10), remain accepted for one release.

### Engine

The engine is Clef-omni: Cloudflare's `@cf/cloudflare/clef-omni` on Workers AI, run on our own Cloudflare account. It replaced Jev (TypeSafe), retired 2026-10-10 (principal, 2026-10-10: Clef-omni everywhere, because it reads many input types). The model id lives only in `CROSS_VENDOR` in `LIFEOS/TOOLS/models.ts`, as the lane `assayEngine`; nothing else names it.

Why this engine:

- **Many input types.** It reads text, images, audio and video, so a question about a header image, a thumbnail, a voice note or a render goes through the same door as a question about a message.
- **Open weights.** The model is not tied to one vendor's closed service, so it can move to another host or run locally if Cloudflare stops being the right place.
- **Our own account.** Calls run on our Cloudflare account, which OPERATIONAL_PREFERENCES § Model selection names as a trusted vendor. A secret value never leaves on any lane.
- **Fast.** A text question answers in well under a second, and the hooks that ask on every prompt depend on that.
- **Same question types.** `choice`, `score` and `noul` keep the shape they had, so no caller changed.

**Media.** `ask()`, `judge()` and `judgeMany()` take a `media` option holding images, audio or video, sent to the engine beside the state. A `judgeMany()` item can carry its own `media`, which goes with that item only and replaces the batch-wide option for it. Limits, from the live model schema: up to 4 images (PNG, JPEG or WebP, 4 MiB each, 8 MiB together), up to 4 audio clips (8 MiB each), up to 2 videos (16 MiB each), and 16 MiB for audio and video together. The client checks bytes and counts before any fetch and refuses with an `EngineError` of kind `media`; only the server can check clip duration. Media goes to the engine and never into the ledger. The client scans question and state text for credential shapes but cannot scan media bytes, so a caller attaches only media it means to send.

**Client and credentials.** `LIFEOS/ASSAY/Engine.ts` holds the client. It reads `CLOUDFLARE_ACCOUNT_ID` and the one master Cloudflare token, `CLOUDFLARE_API_TOKEN`, from the environment or the canonical `.env`. No second Cloudflare token is read (Assay ISA ISC-69).

**Bake-off.** The engine is re-tested against the other Clef models every month (§ Second-option engines). The 2026-10-10 numbers, from the guard corpus and from the question-system comparison, are in the Decisions section of the 2026-10-01 clef-bakeoff work ISA (install state, not shipped).

### The caller contract

```ts
import { judge } from "../LIFEOS/ASSAY/Assay";

const r = await judge(state, { urgent: { type: "noul", instructions: "Does this express urgency?" } }, { caller: "my-caller" });
if (r.urgent.verdict.act) { /* only ever true for a registered enforce-mode caller over its threshold */ }
```

- More than one item is a batch, and a batch runs in parallel. See § Batches.
- Register the caller in the registry before its first call, with its ground-truth source and join key.
- Thresholds live only in the registry. `/ic --section glance-thresholds` fails on a numeric literal compared against a probability anywhere else; `jev-thresholds` remains an alias for one release (Jev retired 2026-10-10).
- A new question on a registered caller goes in through `registerQuestion(caller, id)` and comes out through `unregisterQuestion`. Both write the registry atomically and validate it first. Registration refuses an unknown caller or an id the caller already has, and fails when `defaults.provisional_threshold` is missing. The new question starts in shadow at that provisional value with no model recorded, so promotion to enforce refuses it until it is calibrated. `bunker miss` is the usual way in (§ The miss loop).
- Each call site declares fail-open or fail-closed. Either `LIFEOS_GLANCE_DISABLED=1` or the legacy `LIFEOS_JEV_DISABLED=1` (Jev retired 2026-10-10) must leave the caller's turn, eval, or job able to finish.
- Only the judgment layer imports the engine's call. Other code may import the engine's types, `redactForEngine`, `resolveApiKey` and `EngineError`, and nothing else; a test holds that allowlist.
- Every file that calls the judgment layer says so in its header: that it is a judgment caller, its caller name, and this doc's path. A test holds that too.
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

### Batches

One judgment takes well under a second and depends on no other judgment. Asking the same questions about many items is therefore a pool, never a loop (principal directive, 2026-09-18).

```ts
import { judgeMany } from "../LIFEOS/ASSAY/Assay";

const results = await judgeMany(items /* { key, state }[] */, questions, { caller: "my-caller" });
```

- `judgeMany()` is the only way to ask about more than one item. A `for` loop that awaits `judge()` is a bug: measured on 2026-09-18, a pool over more than twice as many mails finished in a small fraction of the time the loop took.
- The pool is 32 wide by default (`DEFAULT_CONCURRENCY`); pass `concurrency` to change it. Results come back in input order.
- One item failing never fails the batch. It is retried once and then returned with `error` set. A disabled engine, a missing key, or a spent budget is not retried.
- Every attempt writes its own ledger line, so the ledger, budgets, and reports see a batch as N ordinary calls. The budget check can overshoot by at most the pool width.
- Each `judgeMany()` result also carries the answering call's `latency_ms` and token `usage`; both are absent on an item that failed.
- From the shell, `ask-many` is the same door: one `{key, state}` JSON object per line in, one result per line out, timing on stderr.
- Several questions about one item still travel as one call with a question map. Parallelism is across items, never across questions.
- An item may carry `media` (images, audio, video) for the engine to read with that item's state. It goes to the engine and never into the ledger, the same as `ask()`'s media.

### Engine evidence

Every number the judgment layer acts on was measured on one engine's weights. When the engine changes, that evidence stops describing it. Four rules keep the evidence tied to the engine answering now (ISA `LIFEOS/ASSAY/ISA.md` (not in the public release) M7).

**The live engine id.** The engine id is the last path segment of `CROSS_VENDOR.assayEngine`, which today is `clef-omni`. That is also the model id Clef-omni returns and the value the ledger records as `model_versioned`. `Registry.liveEngineId()` is the one reader.

**Stamps.** Each threshold row records in `model` the engine its cut was measured on. `Assay.ts status` prints, under each caller's effective-mode line, the rows whose stamp is another engine or none (`  guard stamps: 2/3 not clef-omni (...)`), then one summary line for the whole registry. `report --caller` prints one line per such row under its header: `STAMP stale (cut on jev-1.13.0)` for a row cut on another engine (here Jev, retired 2026-10-10), and `STAMP uncalibrated` for a row never cut. A stale stamp is a flag, not a failure. The row keeps working in shadow and cannot be promoted until it is re-cut.

**Promotion and labels.** `promoteNoul` refuses, by invariant, a threshold whose `model` is not the live engine. A principal label on a check that names a caller and question records `engine`, the engine whose verdict it judged. `addLabel` fills it in when the writer does not: from the `evaluators.glance` of the Proof receipt the label names, or else the live engine. A label joined from a receipt run takes that run's engine. Rows written before the field existed read as their recorded `model` if they have one, and otherwise as `unknown`. For a caller registered in the registry, `earnedStatus` counts only labels from the live engine, and it reports how many judged another engine (`other_engine`). Labels earned on Jev (retired 2026-10-10) therefore never earn on Clef-omni. Keys outside the registry are not filtered, such as a deterministic check id or the model-judge key `proof-judge`.

**The fingerprint.** Clef-omni returns the bare id `clef-omni` with no version, so new weights under the same id are invisible to the model check. The daily canary closes that gap. `bun LIFEOS/ASSAY/Fingerprint.ts run` asks twenty fixed questions over invented public text through `ask()`, under the registered shadow caller `probe`. It rounds every answer to two decimals and hashes them into a fingerprint such as `fp1:3f2a…`. Clef-omni is deterministic between runs: on 2026-10-10, all 660 bake-off answers matched exactly across two runs. The same weights therefore give the same fingerprint. The run writes the fingerprint to `MEMORY/STATE/assay-engine-fingerprint.json`. A run in which any question failed writes nothing.

- `ask()` writes the current fingerprint into every ledger row as `engine_fingerprint`, including error rows, and writes null for a call to any other model. `model_versioned` stays the model id, so threshold stamps keep reading `clef-omni`.
- Promotion records the fingerprint on the threshold row and in `enforce_evidence`.
- `checkModelDrift` has two keys. One is the model id (the ledger's last `model_versioned`). The other is the fingerprint (the canary state, else the caller's last `engine_fingerprint`). An enforce row promoted under another fingerprint, or under none, goes back to shadow. It gets the same event a model change gets (written through STATVS `writeEvent()`, which hands it to Vigil), with `reverted.reason` set to `engine fingerprint changed`. The rewrite keeps the registry's `defaults` row.
- The canary runs the drift check after every run, so a fingerprint change reverts every enforce row on the same day.
- The `assay-engine-fingerprint` workflow runs the canary daily at 05:17 Pacific with `--vigil`, which now writes through STATVS `writeEvent()` (a refusal is logged, never thrown). The engine writes its run event, and the canary adds its own: info when the fingerprint is unchanged, high when it changed, and medium when the run was incomplete.

### Chains

Chains (`LIFEOS/ASSAY/Chain.ts`) combine the low-level model's writing and analysis with typed judgments. `rank` asks one question per candidate in a batch and orders every candidate by probability without taking action. `keepWhere` applies a ranked row's registry verdict; `filter` is `rank` plus `keepWhere`, retaining every row in shadow while recording what enforcement would drop and dropping only non-clearing rows for an enforce caller. `generateThenRank` has the low-level model generate JSON candidates through Inference at the low OpenAI level, then ranks them. `judgeThenEscalate` returns an enforceable judgment when it may act, otherwise runs the caller's escalation.

This is deliberately a split of responsibilities: the model writes and reads; the judgment layer judges; ordinary code applies the registry verdict. The first chain caller is `cortex-recall`, initially shadow, which re-ranks recalled sessions before the model reads a small selected set.

### Second-option engines

Clef-omni is the engine (§ Engine). Cloudflare's other Workers AI models, Clef and Clef-flash (ids in `CROSS_VENDOR.clef` and `clefFlash`), are kept as second options and re-tested as they improve (principal call, 2026-10-01; before Jev was retired 2026-10-10 it was the engine and all three Clef models were the second options). The judgment layer never calls them: no caller routes to them and `ask()` does not know they exist.

- `bun LIFEOS/ASSAY/EngineBakeoff.ts run [--fixtures PATH]` sends the synthesized guard corpus (the bundled `ASSAY/fixtures/guard-cases.jsonl` unless `--fixtures` names another; with no fixtures file it prints a usage error and exits 2), redacted as the live guard redacts it, to the engine (through `ask()` under the shadow caller `guard-calibration`) and to each alternate. The baseline row is the live engine (`PRODUCTION_ENGINE`, `clef-omni`). It scores every engine against the authored labels: accuracy at the registered cut through `decide()`, AUC, Brier, calibration error, failures, and latency from this machine. `report` rescores a recorded run and `history` prints one line per run.
- The fixture corpus is the only state the guard bake-off sends, and a test holds that.
- The `glance-engine-bakeoff` workflow runs it on the 1st of each month at 06:00 Pacific. Raw answers land in `MEMORY/OBSERVABILITY/assay-engine-bakeoff/` and one summary line in `assay-engine-bakeoff.jsonl`. When an alternate beats the engine on pooled AUC and Brier both, the run emits one Vigil event.
- First result (2026-10-01, three runs, when Jev was the engine; Jev retired 2026-10-10): Jev AUC 0.896, Brier 0.126, median 93ms; Clef 0.893, 0.128, about 700ms; Clef-flash 0.867, 0.148, about 600ms, with occasional 15-second timeouts. Clef reads images and Jev does not, which is the other reason to keep watching it.
- Clef-omni (added 2026-10-10, two runs): AUC 0.868, Brier 0.138, ECE 0.081, median about 280ms, p95 about 470ms. It is the fastest and steadiest Clef, but scores below Clef on quality; Jev, retired 2026-10-10, stayed at 0.896 and 0.125. The corpus is text only, so it says nothing about image judgments. Clef-omni became the engine on 2026-10-10 because it reads text, images, audio and video; the later numbers are in the bake-off ISA's Decisions (§ Engine).
- Real use cases (principal call, 2026-10-10): `bun LIFEOS/ASSAY/UseCaseBakeoff.ts run` scores the engine, the other Clef models and Opus on things we actually made, such as blog and social drafts, header images, thumbnails and video renders. Each case is labelled by the principal's own recorded verdict, never by a model. The corpus is `USER/ASSAY/usecase-corpus.jsonl`, built by `bun LIFEOS/ASSAY/UseCaseCorpus.ts build` from four sources: the principal's own Errata entries, Calibrate likes and dislikes, ArtDirection verdicts, and publication on the principal's site, which counts as approved. Each engine gets only the types it can read. The Clef models read text, images and video, and Opus reads all three, with video as sampled frames. An engine that cannot read a type shows "can't read", not a score. Art, thumbnails and renders we produced may go to Cloudflare. Text goes there only when it is already published, and the request builder enforces that in code. Screenshots and captures are never cases. The monthly workflow runs it after the guard bake-off.

### Extraction

The judgment layer has a second engine. Clef-omni answers multiple-choice questions: which option, how likely. Clairic (`CROSS_VENDOR.assayExtract`, Cloudflare Workers AI on our own account, preview since 2026-10-19) answers fill-in-the-blank questions: what value. Given a state (text, up to 4 images) and a map of typed fields, it returns one value per field in a single pass with no generated text. The value is copied from the state (with its span), computed from it (a total, a date difference), estimated inside declared bounds (a median with p10 and p90), or forecast per step. Every field also gets a `p_null`, and the value is null when the state does not hold it.

```ts
import { extract, extractMany } from "../LIFEOS/ASSAY/Assay";

const r = await extract(email, {
  amount_paid: { type: "number", unit: "USD", decimals: 2, instructions: "Total paid including tax" },
  order_id: { type: "text", instructions: "Order number" },
}, { caller: "my-caller" });
r.amount_paid.value; // 701.1, or null when absent
```

- **Field types:** `text`, `number`, `date`, `time`, `datetime`, `duration`, `list` (needs `items`: text, number or date), `estimate` and `forecast` (both need `min` and `max`; forecast also takes `horizon` and `interval`). Options `unit`, `integer`, `decimals`, `step`, `scale` and `null_threshold` follow the live model schema (`bun LIFEOS/ASSAY/Engine.ts schema --extract`).
- **Same door as `judge()`.** `extract()` goes through the same caller registry, budget, sample rate, disabled flag and ledger as `ask()`. Each call writes one ledger line with `tier: "extract"`. An unregistered caller is refused. `extractMany()` is the batch form, a pool like `judgeMany()`, results in input order, and one failed item never fails the batch.
- **Copied values are checked in code.** A `text` value, and each text item of a `list`, points at a span of the state. `extract()` slices the state at that span and compares. A value that does not match comes back `null` with `unverified: true`, so a misread can never be quietly acted on. Computed and estimated values have no span and are only as good as the confidence returned with them.
- **Secrets and media.** The Clairic client refuses secret-shaped state or field text before any fetch, like the Clef client, and checks image count and bytes against the live schema before sending.
- **No thresholds yet.** An extracted value is data, not a verdict, so it never passes through `decide()`. What code does with it is the policy's job (§ Pipelines).
- The 2026-10-19 probe on an invented email: order id and span right, 701.10 computed from $649 + $52.10, tracking number null at `p_null` 1.0, and the damage list missed (empty at confidence 0.16). That miss is why every pipeline is measured before use.

### Pipelines

A pipeline is the question-system format at schema v2 (`glance-question-system/v2`). It adds two optional blocks to the v1 format, so a v1 system is a v2 system with neither, and it behaves exactly as before. `QuestionSystem.ts` validates, runs and measures both.

A pipeline has four tiers, and each one is used only when it earns its place:

| Tier | Block | What runs | Example |
|---|---|---|---|
| Code | `deterministic` and `policy` | Plain code over facts | $20,000 ÷ 4 issues, compared with the rate card |
| Extract | `extract` | Clairic, one call per case | budget, issue count, start date out of a sponsor email |
| Decide | `stages` | Clef-omni, typed questions | is this a real sponsor, how urgent |
| Write | `write` | One LLM call through `Inference.ts` | the reply, written from the facts and decisions |

- **`extract`** is a list of fields, each with `id`, `type`, `instructions`, `purpose` (the need it serves), `reads` (the state fields it sees) and the Clairic options its type needs. An optional `tolerance` sets how close a number must be to count as right.
- **Extracted values become facts.** A scalar joins the facts map under its id, a `list` as `<id>.count`, and an `estimate` as its median plus `<id>.p10` and `<id>.p90`. Policy rules and stage conditions then compare them in code, with no model call. A question may also name an extracted field in `reads`, and its value is added to the state Clef sees.
- **`derive`** is the code tier's arithmetic: each entry is `id`, `op` (`div`, `mul`, `add`, `sub`, `min`, `max`), `of` (two operands: facts, joined extract names, or an earlier derive id) and `purpose`. Derived facts are computed in declared order right after extraction, and are null when an operand is null or a divisor is zero. The budget per placement is `{ "id": "per_placement", "op": "div", "of": ["budget_total_usd", "placements"] }`, then a policy rule compares it with the floor.
- **`write`** is one step: `id`, `purpose`, `instructions`, `inputs` (only declared state fields, facts, extracted fields and decisions), the Inference `level`, and an optional `when` (decision id → outcomes) so the writer runs only for the cases that owe text. Its output is the pipeline's text product. It never becomes a fact or a decision input, and Assay does not grade its own write output; that goes through Proof.
- **`fit.tiers`** lists the tiers the system uses. A system that needs only one tier names only that one.

**Measuring a pipeline.** `run` executes each case in tier order (code, extract, decide, write) and reports per tier the calls, latency and tokens. Cases may carry `expected_fields`, and the report scores each extract field: text ignoring case and runs of whitespace (single values and list items), `tolerance` for numbers, p10–p90 coverage for estimates. In a v2 system a twin pair may differ only on an expected extract value. `run --baseline llm [--llm-level <level>]` also asks one LLM call per case to answer the whole system (every decision, every extract field) from the raw state, and the report puts that **LLM-only baseline** beside the pipeline: accuracy per decision and per field, latency and tokens.

**The LLM-only baseline rule.** A pipeline is worth keeping only if it does the job at least as well as an LLM alone, for less. The design intent keeps a tier only when the holdout shows the pipeline within the caller's bar of the LLM-only baseline on every decision and field, at lower latency or tokens. When it is not, the system ships as the LLM-only call, and the design says why. The holdout runs once, as in v1.

### Designing a question system

A new use of the judgment layer starts from the decision, not from a question. The CreateQuestions intent in `skills/Assay/` turns one fuzzy decision into a question system: the facts code decides, the typed questions the engine is asked in one or more call stages, an ordered policy that combines their answers, thresholds set by the cost of each error, an escalation band, and a calibration plan. The system is a JSON file checked by `bun LIFEOS/ASSAY/QuestionSystem.ts validate`. It is measured by `run` against cases written and labelled by a different agent than the designer, with dev and holdout splits. The report compares the composed decision with one holistic baseline question and shows what each question adds by dropping it. `registry-row` prints the shadow caller row the consumer registers when it wires the system in. Design-time calls go through the `question-design` caller, which is always shadow. `bun LIFEOS/ASSAY/QuestionSystemBakeoff.ts run <system.json> --cases <cases.jsonl> [--engines clef-omni,clef,clef-flash,opus]` runs one frozen system on every engine through `LIFEOS/ASSAY/EngineJudge.ts` and prints one table; the Clef alternates stay fenced off real text unless the system id is on the synthesized-cases allowlist.

### `glance` rows

An ISA's `## Test Strategy` can point one criterion at the judgment layer with a row typed `glance`. That row is the second rung of the verification ladder the whole estate now runs on.

**The four-tier ladder.** Every check sits on one of four tiers, ordered by speed and by how much intelligence the verifier needs: `code`, `glance`, `judge`, `human`. Code is a tool that exits zero. The `glance` tier is one typed question to Assay's judgment layer, answered with a probability, far faster than a model judge (the sub-second figure was measured on the engine retired 2026-10-10 and not re-measured; `skills/Assay/References/QuestionDesign.md`). Judge is a model reading an output against anchored levels or a flipped bracket, in seconds to minutes. Human is the principal recognizing the thing on encounter. The tier is derived from the row's `type` and is never authored: the deterministic types give `code`, a `glance` row gives `glance`, `eval` and `pairwise` give `judge`, and `manual` gives `human`. A check sits at the lowest tier that can honestly answer it, and it drifts down the ladder as it earns labels: a human row becomes a `glance` row once the criterion carries labels, and a `glance` row becomes a code row once the question is sharp enough to be a tool. Two guards hold this in place. Only code runs on the blocking path, so no `glance`, `eval`, or `pairwise` row runs on the liveness lane or inside a deploy or close gate, and a judged row never gates a deterministic row of the same criterion. A gate runs no judge, but it reads recorded results: an earned judged row's latest fail keeps the criterion open at close. Every Feature also keeps at least one spanning criterion over the whole artifact at the consumer boundary, and `bunker test --tiers` flags a Feature whose leaves are all `glance` rows as `unspanned`. The `glance` row contract is fixed: type `glance`, a tool cell of the form `glance:<question-file>#<question-id>`, and a JSON question file beside the ISA under `Questions/`. That file carries one typed question and a bounded producer command that emits the structured state to judge. The registry threshold means confidence for every question type, so a noul resolves two-sided and carries a verdict plus the confidence behind it. A row under a shadow caller reports `shadow`, its own status, which counts as neither a pass nor a fail and cannot close a criterion. Every verdict records the sha256 of the artifact it judged, and the call is skipped when the artifact hash, the question, the threshold, and the engine model are all unchanged since the last verdict. Labels that came from a model or from the deterministic layer put the calibration record in the `proxy` state, which never reads earned.

The producer is bounded before it runs: an allowlisted command or a file inside the ISA's own directory, no shell composition, every vendor key stripped from its environment, and its output refused when `redactForEngine` finds a credential shape or the path touches a deny zone. A question file names `id`, `claim`, `kind` (`noul`, `score` or `choice`), `instructions`, the ordered `criteria` or `options` its kind requires, `state.producer`, and the `caller` whose registry row supplies the threshold. Schema and producer bounding live in `LIFEOS/TOOLS/lib/GlanceQuestion.ts`; dispatch lives in the Bunker runner.

**Budgets and sampling.** `budget.calls_per_day` and `budget.tokens_per_day` cap a caller's billed engine calls per UTC day. Only a row that reached the engine counts: a budget skip, a disabled engine or a missing key writes a ledger line but adds nothing to the day's usage counter. Without a sample rate the budget is spent on the day's first calls and everything after it is a skip. A shadow caller can set `sample_rate` (a number in (0, 1]) to spread the budget over the day instead: each call is asked only when a hash of the caller and the state falls under the rate, so the same state is always sampled the same way and the pick does not depend on arrival order. A sampled-out call throws `GlanceSampleSkip` (kind `budget`, so every handler treats it as a spend skip) and writes nothing. The rate is ignored while any of the caller's questions enforces, so sampling never drops a call whose answer acts. A good rate is the budget divided by a heavy day's attempted calls: the guard caller attempted 187 to 12,824 calls a day over 2026-09-26 to 10-09 against a 500-call budget, which puts its rate near 0.05.

**Report adapters.** `report --caller` computes agreement from the ground-truth join each row names. A join kept in a shared ledger (`ground_truth.ledger`) reads that ledger. Three callers have their own adapter. `bunker-glance` joins seed labels. `eval-judge` reads every persisted suite run under `MEMORY/STATE/Evals-Results` and compares the engine's verdict with the model judge's verdict on the same assertion over the same output, split by the judge's class with balanced accuracy; that is proxy ground truth, so it never earns enforce. `proof` compares the engine's `glance`-tier calls with the principal's verdicts on the same artifact bytes, through the right/wrong labels the label join derives (`LabelStore.deriveJoinedLabels`), and names any joined label not yet written. Each adapter also prints the label store line that decides earning. Any other join prints that it has no shared adapter.

### CLI

```
bun LIFEOS/ASSAY/Assay.ts status                 every caller: mode, rows, error rate, agreement, stale stamps; the engine fingerprint
bun LIFEOS/ASSAY/Assay.ts report --caller <name> [--days N]
bun LIFEOS/ASSAY/Assay.ts tune --caller <name> [--days N] [--step S] [--json]   recommend a threshold from the ground-truth join
bun LIFEOS/ASSAY/Assay.ts promote-noul --caller <name> --question <id> --seed <json>   the shadow-to-enforce step for a one-question caller; refuses unless labels have earned it
bun LIFEOS/ASSAY/Assay.ts alerts                 exit 1 when a caller's error rate is over its floor
bun LIFEOS/ASSAY/Assay.ts drift                  reverts enforce rows when the engine's model id or fingerprint changed
bun LIFEOS/ASSAY/Fingerprint.ts run [--json] [--vigil] [--dry-run]   the engine canary; `show` prints the current fingerprint
bun LIFEOS/ASSAY/Assay.ts callers [--check-docs]
bun LIFEOS/ASSAY/Assay.ts replay --review <case id> [--k N] [--max-calls N] [--json]   replay one missed code review on today's reviewer and on the model that missed it
bun LIFEOS/ASSAY/Assay.ts suite --review [--k N] [--max-calls N] [--dry-run] [--vigil] [--json]   the code reviewer's morning suite
bun LIFEOS/ASSAY/Assay.ts ask --state <text> --questions <json> [--caller name]
bun LIFEOS/ASSAY/Assay.ts ask-many --states <jsonl> --questions <json> [--caller name] [--concurrency N]
```

`bun LIFEOS/ASSAY/Engine.ts probe|schema` talk to the engine directly (`schema` prints the live input schema of the engine model; `schema --extract` prints Clairic's). Its `report|alerts|drift|callers|ask` forward to `Assay.ts`.

### Replay

`bun LIFEOS/ASSAY/Assay.ts replay <rewind fixture>` used to answer one question about a past miss: would today's harness still let it happen? It ran every recorded tool call through the PreToolUse guard dispatcher, and `LIFEOS/ASSAY/Replay.ts` (not in the public release) carried that logic (guard state, served effects, `--change` counterfactuals and a STATVS `replay` row). The dispatcher is retired and `Replay.ts` was deleted on 2026-10-24 (ISA 20261024-native-security), so the fixture form now prints that and exits 2, and no native rule replays a recorded call.

Only `replay --review <case id>` runs. `LIFEOS/ASSAY/ReviewEntry.ts` hands it to `LIFEOS/TOOLS/ReviewSuite.ts`, which rebuilds what one missed code review read and replays it on today's reviewer and on the model that missed it (`--k`, `--max-calls`, `--json`). `Assay.ts suite --review` runs the whole morning suite through the same door.

### Anti-doctrine

- The judgment layer never replaces a deterministic gate. Deny lists, zone lists, path matches, and asserts are layer one and never consult a model. An unearned judgment only flags; an earned confident no fails like a code check.
- It writes no text and does no work. Anything that needs prose, code, or a reason goes to a model.
- An authorized caller may use an enforceable judgment to select a work lane; the Router does so only when its caller-registry verdict permits action.
- A secret value is never sent. The engine client refuses state carrying a credential shape before any fetch.
- For a caller whose job is to correct the carrier, the carrier's own action is never the ground truth.

### Relationship to neighbours

- **Router**: the dispatch advisor is one judgment caller. Per-caller data class and the hook wiring are in `Router/RouterSystem.md` § The judgment lane.
- **Proof** (Assay's output layer): the `proof` caller, in shadow, asks one noul per compiled intent check. The state is derived from the produced artifact: OCR tokens with size, position and prominence, overlay geometry, or the text itself. The call is one `judgeMany` batch per run. An unearned answer (effective mode shadow) is a flag beside the code-tier checks: shown and recorded, never blocking. A confident no from an earned question (effective mode enforce) fails like a code check. Ground truth is the principal's verdict on the delivered artifact. See `skills/Assay/Intents/Proof.md`.
- **Eval suites**: judged rows ask the judgment layer first and pay for a model judge only under the confidence floor. An `llm-assert` resolves as one noul per claim (a three-claim assert is three questions in one call, and it passes only when every claim is true), an anchored `llm-rubric` as a score, and an unanchored rubric is never sent to it. Which tier and which question shape to pick: `skills/Assay/SKILL.md` § Choosing a check.
- **ISA and Bunker**: a `glance` row is a verifier class an ISA can name, sitting between `code` and `judge` on the four-tier ladder. See § `glance` rows, ISAFormat § *Verifier classes, lanes, and stages*, and BunkerSystem § *The row engine and Assay*.
- **Errata**: the live audit-labeling path persists its judgments separately from entry enrichment.
- **Socrates, a production app, mail**: planned callers, tracked in the adoption ISA. Cortex recall is live for `--judge` and `--answer`.

The adoption program covers every caller cluster and requires explicit absence review.

### Artifact labels from Bunker

Bunker label reports join criterion seeds to successful judgment answers by canonical ISA key, criterion ID, question ID, and SHA-256 of the serialized, redacted engine state; an attached request ID additionally selects that observation. Reports show labels, joined samples, agreement at the registry threshold, balanced accuracy, positive and negative counts, and a balanced-accuracy threshold recommendation. Balanced accuracy and its recommendation are unavailable when either class is missing. Proxy labels remain visible in measurement and do not earn calibration.

An `attested_by` equal to `principal` or containing `delegated by principal` is eligible for earned calibration when its measurement criteria pass; every other named attester is proxy.

A `glance` row may drop its `manual` sibling only once the criterion seed holds `min_labels` labels (per question, else the registry default). `bun LIFEOS/TOOLS/EvalCensus.ts --pairing` lists every row that falls short. Only `noul` labels count. A `choice` or `score` label carries an `expected` answer and never counts toward that floor, so those rows keep their manual sibling.

### The miss loop

A wrong judgment becomes one more question and one kept case, not a longer prompt. `bunker miss` writes the question file beside the ISA, keeps the state that fooled the judgment, registers the question in shadow through `registerQuestion`, and records the human label against that state's sha256. The command, its flags and its rollback are in `Bunker/BunkerSystem.md` § A judged miss becomes a kept question.

## Commands

Proof, from the repository root:

| Command | What it does |
|---|---|
| `bun skills/Assay/Tools/Proof.ts plan --ask <file\|-> --kind <kind>` | Compile checks from an ask and cache them |
| `bun skills/Assay/Tools/Proof.ts plan --brief <file> --kind <kind> --out <proof.json>` | Compile a brief into a checks file, and compare an optional plan against it |
| `bun skills/Assay/Tools/Proof.ts run --artifact <file> [--ask <file\|->] [--checks <proof.json>]` | Check an artifact and write its receipt. Optional `--skill`, `--isa`, `--criteria`, `--destination` and `--project` |
| `bun skills/Assay/Tools/Proof.ts run --artifact <file> --intent <intent.md>` | Check an artifact against a skill intent's Ideal State and Anti-criteria; the receipt names the intent |
| `bun skills/Assay/Tools/Proof.ts plan --intent <intent.md> --kind <kind>` | Show the checks an intent compiles to, with no model |
| `bun skills/Assay/Tools/Proof.ts receipt --artifact <file>` | Ask whether a fresh receipt admits the artifact. Exit 0 only if it does |
| `bun skills/Assay/Tools/Proof.ts reference --artifact <file> --reason "<why>"` | Record that a file is reference material, not a produced output |
| `bun skills/Assay/Tools/Proof.ts dismiss --artifact <file> --check <id> --reason "<why>"` | Record why an unearned flag does not apply (a proxy label) |
| `bun skills/Assay/Tools/Proof.ts miss --skill <Name> --check '<json>' --note "<what was caught>"` | Add a standing check for one skill. `--kind` adds one for a file kind |
| `bun skills/Assay/Tools/Proof.ts retire --skill <Name> --check <id> --reason "<why>"` | Retire a standing check for one skill. `--kind` retires one for a file kind |

Exit codes for Proof: 0 pass (flags allowed), 1 a code-tier failure or a plan drift, 2 a check could not be measured, 64 usage.

Other tools:

| Command | What it does |
|---|---|
| `bun skills/Assay/Tools/EvalRunner.ts -s <suite> [-t trials]` | Run a regression suite; exit 0 passed, 1 regressed, 2 evaluator unavailable |
| `bun skills/Assay/Tools/Compile.ts <ISA.md> [--dry-run] [--write] [--only ISC-n]` | Compile evals for the criteria that have none; `--write` puts the proposal in `Evals.proposed.md` beside the ISA |
| `bun skills/Assay/Tools/Compile.ts merge <ISA.md>` and `split <ISA.md>` | Fold the proposal's rows and blocks, or its splits, into the ISA (main session only; refuses if the ISA changed) |
| `bun skills/Assay/Tools/CompileEstate.ts` | Compile every in-scope ISA, never merging |
| `bun skills/Assay/Tools/IntentRubric.ts suite <intent.md\|skills/<Skill>> --name <suite> --prompt "<p>" --out <file>` | Build a suite whose rubric is the intent's Ideal State and Anti-criteria |
| `bun LIFEOS/TOOLS/LabelBatch.ts next` | Pick unlabelled unearned flags and print them as numbered questions |
| `bun LIFEOS/TOOLS/LabelBatch.ts answer <batch-id> 1y 2n 3s` | Record answers: y the flag was right, n it was wrong, s unsure |
| `bun LIFEOS/TOOLS/LabelBatch.ts stats` | Labels per week, principal against proxy |
| `bun LIFEOS/TOOLS/OutputReconciler.ts --since 24h` | Report coverage and escapes against the independent denominator |
| `bun LIFEOS/TOOLS/Review.ts audit` | List deploy scripts that skip the diff review |

## Related

- **Concept:** `../LifeOs/HillClimbing.md`, the one loop this system is the altimeter for.
- **Feeds me:** `../ISA/ISASystem.md` (the ideal state and its Test Strategy rows), § Judgment layer below (fast typed judgments, and the only reader of thresholds), `../Bunker/BunkerSystem.md` (runs ISA rows and keeps the run ledger the close gate reads), `../Testing/TestingDoctrine.md` (code tests that Assay's code tier sits beside).
- **I feed:** the HillClimb skill (`skills/HillClimb/`), whose climbs read EvalRunner run files for the headline, the train/test split and the noise floor; `../Errata/ErrataSystem.md` (joins complaints to output lines and receipts), `../Upgrades/UpgradesSystem.md` (misses and false passes become queue items), `../Vigil/VigilSystem.md` (gate errors, unproofed sends and overrides with no mint), `Records.md` (the schemas of everything Assay writes or joins).
- **ISA:** `../ISA/ISAFormat.md` for the criteria and Test Strategy rows that say what each check is measuring.
