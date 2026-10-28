#!/usr/bin/env bun
/**
 * VoiceJudge — the reading half of the voice check.
 *
 * VoiceGate counts what can be counted. This grades what only a reader catches:
 * whether the author is actually present, whether the enthusiasm is real,
 * whether the piece sounds like a person thinking or like an encyclopedia with
 * dramatic line breaks.
 *
 * Grading runs through the Assay skill's judge so the rubric contract, the
 * forced-structured verdict and the Unknown-to-miss escape hatch are shared
 * rather than reimplemented. Judge level is `high` and distinct from whatever
 * generated the draft, per Anthropic's judge-is-not-the-generator practice.
 *
 * Exit codes: 0 pass · 1 fail · 2 did not run (usage error, no config, no exemplars).
 *
 * Usage:
 *   bun VoiceJudge.ts <draft> [--short] [--json] [--threshold 0.7]
 *
 * --short grades a post (X, LinkedIn, Discord) against PostExemplars.md with the
 * SHORT_DIMENSIONS set. Never run the long-form set on a post: it rewards the
 * hedged 40-word sentence, which is the opposite of how short posts read.
 *
 * The exemplars come from <voice_dir> in the skill config (WritingConfig.ts).
 * The few example phrases the rubrics quote are install config too; with none
 * set, the rubrics point the judge at the exemplars instead.
 */

import { join } from "node:path";
import { judgeAssertion } from "../../Assay/Tools/Judge.ts";
import { extractProse } from "./VoiceMetrics.ts";
import { CONFIG_PATH, SETUP_PATH, loadOrExit, type WritingConfig } from "./WritingConfig.ts";

type Dimension = { id: string; weight: number; rubric: string };
type JudgeExamples = WritingConfig["judge"];

/** A parenthetical list of example phrases, or a pointer to the exemplars when unset. */
const eg = (examples: string | undefined, fallback: string): string => `(${examples ?? fallback})`;

/**
 * The long-form register rubric. The default holds no taste of its own: it
 * grades the draft's register against the author's exemplars. A writer's
 * preferred register is taste and lives in the skill's USER PREFERENCES.md as a
 * `## Register rubric` section (read by WritingConfig.ts), which replaces this
 * default, or drops the dimension with a body of `none`.
 */
export const DEFAULT_REGISTER_RUBRIC = `Does the emotional register match the author's exemplars?

5 — The draft carries the same emotional register as the exemplar passages, whatever that register is, and the stakes land on concrete images rather than abstractions.
3 — Close to the exemplars' register, but flatter or more heightened than the author usually writes.
1 — A clearly different register from the exemplars, or a register that does not fit the material.`;

/**
 * Dimensions derived from the corpus, one per failure the broken post exhibited.
 * Each rubric anchors 1 and 5 to concrete observable behaviour so the judge is
 * scoring the text rather than its own taste.
 */
export function longDimensions(ex: JudgeExamples = {}): Dimension[] {
  return [
  {
    id: "author_present",
    weight: 2,
    rubric: `Is the author IN this piece?

5 — The author states their own relationship to the material: what they think, what they have written before, what they got wrong, what excites them. First person carries real content, not just narration.
3 — Some first person, but it reports rather than commits. Could have been written about the author.
1 — Neutral third-party exposition. An encyclopedia entry. No stake, no opinion, no history.

Score the presence of a specific person with a specific history, not the word count of "I".`,
  },
  {
    id: "sentence_reach",
    weight: 2,
    rubric: `Do the sentences reach far enough to carry an argument?

5 — Long explanatory sentences${ex.sentenceReach ? ` (${ex.sentenceReach} words)` : ""} do the real work, with subordinate clauses and em-dash asides, and short sentences land as payoffs after them.
3 — Mostly medium sentences; a few reach, but the argument is carried by accumulation rather than by any single sentence.
1 — Every sentence is short and self-contained. Staccato. Fragments stacked like bricks. Nothing is allowed to develop across a sentence.

Score the RANGE and whether length is used purposefully.`,
  },
  {
    id: "thinking_out_loud",
    weight: 2,
    rubric: `Does this read like someone thinking, or like someone reciting a finished result?

5 — Hedges and qualifiers appear naturally ${eg(ex.hedges, "the kinds the reference passages use")}. The author admits uncertainty and limits. Ideas arrive with their rough edges.
3 — Mostly polished, with occasional softening.
1 — Every sentence is a finished verdict. No uncertainty, no qualification, no visible thought.`,
  },
  ...(ex.register === null ? [] : [{ id: "register", weight: 1, rubric: ex.register ?? DEFAULT_REGISTER_RUBRIC }]),
  {
    id: "no_negation_scaffolding",
    weight: 1,
    rubric: `Does the prose state what things ARE?

5 — Claims are made positively. The reader is never asked to hold a wrong idea before getting the right one.
3 — One or two constructions that set up a negative before the positive.
1 — Argument is built on "it's not X, it's Y", "the question isn't...", "this isn't about..." repeatedly.

Quoted material from other people is exempt — do not penalise a quotation.`,
  },
  {
    id: "sounds_like_author",
    weight: 3,
    rubric: `Holistic: would a regular reader of this author believe they wrote this?

You have been given exemplar passages from the author's published work. Compare against those directly.

5 — Matches the exemplars in rhythm, stance and habit, at the author's usual quality.
3 — Plausibly the author on a flat day, or the author imitated by someone competent.
1 — Clearly a different writer, or generic prose with no author in it. The specific failure to watch for: prose that is technically clean, plainly worded, and completely impersonal, arranged in short paragraphs for drama.

Be strict. A 4 means you would not have flagged it; a 3 means something felt off.`,
  },
  ];
}

/** Long-form dimensions with no install examples; kept for importers. */
export const DIMENSIONS: Dimension[] = longDimensions();

/**
 * The short-form register rubric. Like the long-form default it holds no taste
 * of its own: it grades the post's register against the author's reference
 * posts. A writer's preferred short-form register lives in the skill's USER
 * PREFERENCES.md as `## Short register rubric` (read by WritingConfig.ts),
 * which replaces this text; a body of exactly "none" drops the dimension.
 */
export function defaultShortRegisterRubric(ex: JudgeExamples = {}): string {
  return `Does the feeling come through as itself, in the register of the author's reference posts?

5 — Excitement reads as excitement ${eg(ex.excitement, "the way the reference posts show it")}, worry reads as worry ${eg(ex.worry, "the same")}. Stakes land on something concrete.
3 — Close to the reference posts' register, but flatter or more heightened than the author usually writes.
1 — A register the reference posts never use, or one that does not fit the material. Ends on an abstraction.`;
}

/**
 * Short-form dimensions (X, LinkedIn, Discord): graded against PostExemplars.md,
 * the author's real posts. The long-form set rewards 40-word hedged sentences,
 * which is the opposite of how short posts read: direct, plain, spoken.
 */
export function shortDimensions(ex: JudgeExamples = {}): Dimension[] {
  return [
  {
    id: "author_present",
    weight: 2,
    rubric: `Is the author IN this post?

5 — The author says what they read, built, think, or worry about. First person carries a real stake.
3 — Some first person, but it reports. Could be anyone.
1 — A press release or an explainer. No person in it.`,
  },
  {
    id: "direct_plain",
    weight: 3,
    rubric: `Does it say the thing straight, in plain words, the way a person talks?

5 — First line is the point. Plain words ${eg(ex.plainWords, "the everyday words the reference posts use")}. Short paragraphs. Stops when the point is made. No setup, no wind-up, no polish.
3 — Mostly plain, with a couple of lines built to sound good rather than to say something.
1 — Marketing shape: a hook, a padded middle, a call to action. Sentences arranged for a beat. Abstract nouns of the kind a vendor blog uses. Product talking points paraphrased.

Penalise any line that exists for rhythm rather than meaning, any reaction-then-reveal (the writer announces their reaction before the fact), and any phrase a vendor blog would use.`,
  },
  ...(ex.shortRegister === null ? [] : [{ id: "register", weight: 1, rubric: ex.shortRegister ?? defaultShortRegisterRubric(ex) }]),
  {
    id: "no_negation_scaffolding",
    weight: 1,
    rubric: `Does it state what things ARE?

5 — Claims are positive. The reader never holds a wrong idea before the right one.
3 — One "not X, it's Y" style setup.
1 — Built on "it's not X, it's Y", "the question isn't", "this isn't about".

Quoted material is exempt.`,
  },
  {
    id: "sounds_like_author_posts",
    weight: 3,
    rubric: `Holistic: would someone who follows this account believe the author posted this?

You have the author's real posts as reference. Compare directly.

5 — Matches the reference posts in rhythm, stance, and word choice, at the author's usual quality.
3 — Plausibly the author on a flat day, or a competent imitation.
1 — A different writer, or generic copy with nobody in it. The failures to watch for: vendor copy in first person; clean plain sentences with nobody in them; a post shaped like an ad.

Be strict. 4 means you would not have flagged it.`,
  },
  ];
}

/** Short-form dimensions with no install examples; kept for importers. */
export const SHORT_DIMENSIONS: Dimension[] = shortDimensions();

export interface DimensionVerdict {
  id: string;
  score: number;
  passed: boolean;
  weight: number;
  reason: string;
}

export interface JudgeReport {
  draft: string;
  weighted_score: number;
  threshold: number;
  passed: boolean;
  dimensions: DimensionVerdict[];
}

export async function judgeVoice(
  draftText: string,
  draftLabel: string,
  threshold = 0.7,
  mode: "long" | "short" = "long",
  cfg: WritingConfig = loadOrExit("VoiceJudge"),
): Promise<JudgeReport> {
  const exemplarName = mode === "short" ? "PostExemplars.md" : "Exemplars.md";
  const dims = mode === "short" ? shortDimensions(cfg.judge) : longDimensions(cfg.judge);
  const exemplarsPath = join(cfg.voiceDir, exemplarName);
  const exemplarsFile = Bun.file(exemplarsPath);
  if (!(await exemplarsFile.exists())) {
    console.error(`VoiceJudge: not configured — no exemplars at ${exemplarsPath}. Author the voice directory named by voice_dir in ${CONFIG_PATH} (Corpus.md, Exemplars.md, PostExemplars.md for posts, then BuildVoiceProfile.ts for VoiceProfile.json); see ${SETUP_PATH}.`);
    process.exit(2);
  }
  const exemplars = await exemplarsFile.text();
  const prose = extractProse(draftText);

  // Exemplars ride with every rubric so the judge compares against the author's
  // real writing rather than its own prior of "good blog prose". An install can
  // add one standing note to every short-form rubric (for example, how its
  // posts in a recurring series must open, so the judge does not mark them down).
  const shortNote = mode === "short" && cfg.judge.shortNote ? `\n\n${cfg.judge.shortNote}` : "";
  const withExemplars = (rubric: string): string =>
    `${rubric}${shortNote}\n\n---\n## REFERENCE — verbatim ${mode === "short" ? "posts from the author's own X account" : "passages from the author's own published work"}\n\n${exemplars}`;

  // A malformed verdict is a transient tooling failure, not a voice failure, and
  // scoring it 0 fails an otherwise-good draft for the judge's own hiccup. Retry
  // twice before letting it stand. A genuine "unknown:" verdict is a different
  // thing — Judge.ts already routes that to a miss, and it is left alone.
  const gradeOnce = (d: Dimension) =>
    judgeAssertion(
      prose,
      { type: "llm-rubric", value: withExemplars(d.rubric), threshold, weight: d.weight },
      { level: "high", timeout: 90_000 },
    );

  const isToolingFailure = (reason: string): boolean =>
    /unparseable verdict|judge error/i.test(reason);

  const dimensions = await Promise.all(
    dims.map(async (d): Promise<DimensionVerdict> => {
      let r = await gradeOnce(d);
      for (let attempt = 0; attempt < 2 && isToolingFailure(r.reason); attempt++) {
        r = await gradeOnce(d);
      }
      return {
        id: d.id,
        score: r.score,
        passed: r.passed,
        weight: d.weight,
        reason: isToolingFailure(r.reason) ? `JUDGE UNAVAILABLE after 3 attempts — ${r.reason}` : r.reason,
      };
    }),
  );

  const totalWeight = dimensions.reduce((a, d) => a + d.weight, 0);
  const weighted = dimensions.reduce((a, d) => a + d.score * d.weight, 0) / totalWeight;

  return {
    draft: draftLabel,
    weighted_score: Math.round(weighted * 1000) / 1000,
    threshold,
    // Every dimension must clear the bar. A strong holistic score cannot cover a
    // collapsed one — that is how the broken post passed every check it had.
    passed: weighted >= threshold && dimensions.every((d) => d.passed),
    dimensions,
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const files = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--threshold");

  if (!files[0]) {
    console.error("usage: VoiceJudge.ts <draft> [--short] [--json] [--threshold 0.7]");
    process.exit(2);
  }

  const threshold = Number(arg("--threshold") ?? 0.7);
  const mode = argv.includes("--short") ? "short" : "long";
  const report = await judgeVoice(await Bun.file(files[0]).text(), files[0], threshold, mode);

  if (argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nVOICE JUDGE (${mode}) — ${report.passed ? "PASS" : "FAIL"}`);
    console.log(`draft: ${report.draft}`);
    console.log(`score: ${report.weighted_score} (threshold ${report.threshold})\n`);
    for (const d of report.dimensions) {
      console.log(`  ${d.passed ? "✓" : "✗"} ${d.id.padEnd(26)} ${d.score.toFixed(2)}  (w${d.weight})`);
      console.log(`      ${d.reason.replace(/\s+/g, " ").slice(0, 200)}`);
    }
    console.log();
  }
  process.exit(report.passed ? 0 : 1);
}
