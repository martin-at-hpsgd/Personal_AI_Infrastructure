#!/usr/bin/env bun
/**
 * VoiceGate — score a draft against the corpus bands.
 *
 * The deterministic half of the voice check. It catches the countable failure:
 * prose that has collapsed into uniform short bricks with the author absent.
 * Whatever needs a reader instead of a counter is the judge's job, and both
 * have to pass before anything is published.
 *
 * Exit codes: 0 pass · 1 fail · 2 did not run (usage error, no config, no profile).
 *
 * Usage:
 *   bun VoiceGate.ts <draft> [--profile <VoiceProfile.json>] [--json]
 *
 * Without --profile the profile is <voice_dir>/VoiceProfile.json from the
 * skill config (WritingConfig.ts); with no config the gate stops and names
 * Setup.md. Exit 2 is never a pass.
 */

import { join } from "node:path";
import { measure, BANDED_METRICS, UnknownPatternError, type VoiceVector } from "./VoiceMetrics.ts";
import { resolveRules, UncountedRuleError, type ResolvedRules, type VoiceProfile } from "./BuildVoiceProfile.ts";
import { CONFIG_PATH, SETUP_PATH, loadOrExit, loadWritingConfig, WritingConfigMissing, type WritingConfig } from "./WritingConfig.ts";

/**
 * Metrics whose collapse defines the failure this gate exists to catch:
 * sentences that never reach, an author who never appears, no thinking-out-loud.
 *
 * Blocking is direction-aware on purpose. Machine prose fails these LOW, every
 * time — it shortens, flattens and depersonalises. Failing one HIGH means an
 * essay ran long or leaned hard on "I", which is inside the author's range and is
 * reported without blocking. The HIGH remedies are worded as descriptions, not
 * corrections: the author's own anchor piece (`anchor` in the profile) can sit
 * above p90 on exactly these metrics, so a "cut some" instruction there would
 * sand off what the author asked for.
 *
 * Calibration method: run the gate over the corpus itself and measure how often
 * the author's own published work would be rejected, then check that a known
 * collapsed draft still fails. Low-only blocking with a three-metric threshold
 * keeps the corpus false-positive rate low while machine-flattened prose, which
 * collapses most of the five, still fails. Recalibrate whenever the corpus
 * changes, and record the run in the install's config (Setup.md, Calibration log).
 */
const CORE: string[] = [
  "sent_len_p90",
  "sent_len_sd",
  "clauses_per_sentence",
  "hedge_density",
  "first_person_density",
];

/** How many core metrics may collapse before the draft fails. */
const CORE_FAIL_THRESHOLD = 3;

/** Below this, the vector is too noisy to judge. */
const MIN_WORDS = 300;

export interface Finding {
  metric: string;
  value: number;
  p10: number;
  p50: number;
  p90: number;
  direction: "low" | "high";
  core: boolean;
}

export interface GateResult {
  draft: string;
  word_count: number;
  passed: boolean;
  reasons: string[];
  findings: Finding[];
  hard_zero_hits: Record<string, number>;
  house_style_hits: Record<string, number>;
  vector: VoiceVector;
}

export function gate(vector: VoiceVector, profile: VoiceProfile): GateResult {
  const findings: Finding[] = [];

  for (const key of BANDED_METRICS) {
    const name = String(key);
    const band = profile.bands[name];
    if (!band) continue;
    const value = vector[key] as number;
    if (value >= band.p10 && value <= band.p90) continue;
    findings.push({
      metric: name,
      value,
      p10: band.p10,
      p50: band.p50,
      p90: band.p90,
      direction: value < band.p10 ? "low" : "high",
      core: CORE.includes(name),
    });
  }

  const hard_zero_hits: Record<string, number> = {};
  for (const name of profile.hard_zero) {
    const n = vector.banned_hits[name] ?? 0;
    if (n > 0) hard_zero_hits[name] = n;
  }

  const house_style_hits: Record<string, number> = {};
  for (const name of profile.house_style_only) {
    const n = vector.banned_hits[name] ?? 0;
    if (n > 0) house_style_hits[name] = n;
  }

  // Only a LOW core metric counts toward failure — see the CORE comment.
  const coreMisses = findings.filter((f) => f.core && f.direction === "low");
  const reasons: string[] = [];

  if (Object.keys(hard_zero_hits).length) {
    reasons.push(
      `forbidden constructions present: ${Object.entries(hard_zero_hits).map(([k, n]) => `${k}×${n}`).join(", ")}`,
    );
  }
  if (Object.keys(house_style_hits).length) {
    reasons.push(
      `house style: ${Object.entries(house_style_hits).map(([k, n]) => `${k}×${n}`).join(", ")}`,
    );
  }
  if (coreMisses.length >= CORE_FAIL_THRESHOLD) {
    reasons.push(
      `${coreMisses.length} core voice metrics collapsed: ${coreMisses.map((f) => `${f.metric} ${f.direction}`).join(", ")}`,
    );
  }
  if (vector.word_count < MIN_WORDS) {
    reasons.push(`draft is ${vector.word_count} words — under ${MIN_WORDS}, metrics are noisy; judge only`);
  }

  // Under MIN_WORDS the band metrics are noise (a 90-word post "collapses" on
  // sentence spread by construction), so only the deterministic constructions
  // block. The judge, in --short mode, is the voice check for posts.
  const blocking = Object.keys(hard_zero_hits).length > 0
    || Object.keys(house_style_hits).length > 0
    || (vector.word_count >= MIN_WORDS && coreMisses.length >= CORE_FAIL_THRESHOLD);

  return {
    draft: vector.source,
    word_count: vector.word_count,
    passed: !blocking,
    reasons,
    findings,
    hard_zero_hits,
    house_style_hits,
    vector,
  };
}

/**
 * The blocking lists the gate uses. A `hard_zero` or `house_style_only` key set
 * in the config outranks the list recorded in the profile, so changing it needs
 * no rebuild; an unset key leaves the profile's own list in force.
 *
 * Returns the names that would block but are not counted, which the caller
 * refuses: such a check could never fire.
 */
export function effectiveProfile(
  profile: VoiceProfile,
  rules: ResolvedRules,
  cfg?: Pick<WritingConfig, "voiceRules">,
): { profile: VoiceProfile; uncounted: string[] } {
  const hard_zero = cfg?.voiceRules.hardZero !== undefined ? rules.hardZero : profile.hard_zero;
  const house_style_only = cfg?.voiceRules.houseStyleOnly !== undefined ? rules.houseStyleOnly : profile.house_style_only;
  const uncounted = [...hard_zero, ...house_style_only].filter((n) => !rules.patterns.includes(n));
  return { profile: { ...profile, hard_zero, house_style_only }, uncounted };
}

/** Hedges and intensifiers named in two remedies; an install sets its own in config. */
const DEFAULT_REMEDY_HEDGES = "I think, probably, roughly, I'm not sure";
const DEFAULT_REMEDY_INTENSIFIERS = "really, a lot, the best part";

/** What to do about each metric, phrased as an action rather than a prohibition. */
export function remedies(cfg?: Pick<WritingConfig, "remedy">): Record<string, { low: string; high: string }> {
  const hedges = cfg?.remedy.hedges ?? DEFAULT_REMEDY_HEDGES;
  const intensifiers = cfg?.remedy.intensifiers ?? DEFAULT_REMEDY_INTENSIFIERS;
  const reach = cfg?.remedy.sentenceReach ? `run ${cfg.remedy.sentenceReach} words` : "run long";
  return {
  sent_len_p90: {
    low: `no sentence reaches far enough — let the explanatory sentences ${reach}, with the argument inside them`,
    high: "the long sentences never land — break one in three with a short payoff after it",
  },
  sent_len_sd: {
    low: "every sentence is about the same length — mix four-word punches with forty-word explanations",
    high: "wider swing than the corpus median — inside the author's range if the long ones carry argument and the short ones land as payoffs",
  },
  clauses_per_sentence: {
    low: "sentences are single-clause bricks — subordinate, qualify, use because/which/that",
    high: "too many clauses per sentence — split some out",
  },
  hedge_density: {
    low: `no thinking-out-loud — add ${hedges}`,
    high: "heavier hedging than the corpus median — inside the author's range when each hedge marks a real uncertainty rather than softening a claim the author holds",
  },
  first_person_density: {
    low: "the author is missing from their own piece — say what you think, what you did, what you got wrong",
    high: "more first person than the corpus median — inside the author's range for a piece about what they believe or did",
  },
  question_rate: { low: "ask the reader something real", high: "too many questions, answer some" },
  second_person_density: { low: "address the reader directly", high: "back off the you" },
  intensifier_density: { low: `show the enthusiasm as enthusiasm — ${intensifiers}`, high: "the excitement is doing the work the content should" },
  contraction_density: { low: "use contractions — it's, that's, don't, you're", high: "unusually informal even for this author" },
  initial_conjunction_rate: { low: "start some sentences with And, So, But, Plus", high: "too many conjunction openers in a row" },
  fragment_rate: { low: "a few fragments are fine", high: "fragments are stacking into staccato — give them finite verbs" },
  single_sentence_para_rate: { low: "some one-line paragraphs are part of the corpus habit", high: "almost every paragraph is one line — let some run 3-6 sentences" },
  para_len_mean: { low: "paragraphs are too thin to hold an argument", high: "paragraphs are running long" },
  short_sentence_rate: { low: "add some short punches", high: "too many short sentences in a row" },
  long_sentence_rate: { low: "add sentences over 25 words that carry real argument", high: "too much of the piece is long sentences" },
  sent_len_mean: { low: "sentences run short overall", high: "sentences run long overall" },
  sent_len_cv: { low: "rhythm is too even", high: "rhythm is erratic" },
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const files = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--profile");

  const draftPath = files[0];
  if (!draftPath) {
    console.error("usage: VoiceGate.ts <draft> [--profile <VoiceProfile.json>] [--json]");
    process.exit(2);
  }

  // An explicit --profile runs without the install config (generic remedy
  // examples); otherwise the config is required and names the voice directory.
  const explicitProfile = arg("--profile");
  let cfg: WritingConfig | undefined;
  if (explicitProfile) {
    try { cfg = loadWritingConfig(); } catch (e) { if (!(e instanceof WritingConfigMissing)) throw e; }
  } else {
    cfg = loadOrExit("VoiceGate");
  }
  const profilePath = explicitProfile ?? join(cfg!.voiceDir, "VoiceProfile.json");
  if (!(await Bun.file(profilePath).exists())) {
    console.error(`VoiceGate: not configured — no voice profile at ${profilePath}. Build it with BuildVoiceProfile.ts --manifest <voice_dir>/Corpus.md --out ${profilePath} (config: ${CONFIG_PATH}; guide: ${SETUP_PATH}).`);
    process.exit(2);
  }
  const REMEDY = remedies(cfg);
  let rules: ResolvedRules;
  try {
    rules = resolveRules(cfg?.voiceRules);
  } catch (e) {
    if (e instanceof UnknownPatternError || e instanceof UncountedRuleError) {
      console.error(`VoiceGate: not configured — ${e.message} (config: ${CONFIG_PATH}).`);
      process.exit(2);
    }
    throw e;
  }
  const effective = effectiveProfile(JSON.parse(await Bun.file(profilePath).text()) as VoiceProfile, rules, cfg);
  if (effective.uncounted.length) {
    console.error(`VoiceGate: not configured — ${profilePath} blocks on construction(s) that are not counted: ${effective.uncounted.join(", ")}. Rebuild the profile with BuildVoiceProfile.ts, or add them to banned_patterns in ${CONFIG_PATH}.`);
    process.exit(2);
  }
  const profile = effective.profile;
  const vector = measure(await Bun.file(draftPath).text(), draftPath, rules.patterns);
  const result = gate(vector, profile);

  if (argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.passed ? 0 : 1);
  }

  console.log(`\nVOICE GATE — ${result.passed ? "PASS" : "FAIL"}`);
  console.log(`draft:  ${result.draft} (${result.word_count} words)`);
  console.log(`corpus: ${profile.corpus.documents} documents, ${profile.corpus.total_words} words\n`);

  if (result.findings.length) {
    console.log("out of band:");
    for (const f of result.findings.sort((a, b) => Number(b.core) - Number(a.core))) {
      const tag = f.core ? "CORE" : "    ";
      const anchorValue = profile.anchor?.metrics[f.metric];
      const anchorNote = anchorValue === undefined ? "" : `, anchor ${anchorValue}`;
      console.log(`  ${tag} ${f.metric.padEnd(26)} ${String(f.value).padStart(7)}  (corpus ${f.p10}–${f.p90}, median ${f.p50}${anchorNote})  ${f.direction.toUpperCase()}`);
      const remedy = REMEDY[f.metric]?.[f.direction];
      if (remedy) console.log(`       → ${remedy}`);
    }
    console.log();
  }

  for (const [name, n] of Object.entries(result.hard_zero_hits)) {
    console.log(`  FORBIDDEN  ${name} ×${n}`);
  }
  for (const [name, n] of Object.entries(result.house_style_hits)) {
    console.log(`  HOUSE      ${name} ×${n}`);
  }

  if (result.reasons.length) {
    console.log("\nwhy:");
    for (const r of result.reasons) console.log(`  - ${r}`);
  }
  if (result.passed && !result.findings.length) console.log("clean — every metric inside the corpus band.");

  console.log();
  process.exit(result.passed ? 0 : 1);
}
