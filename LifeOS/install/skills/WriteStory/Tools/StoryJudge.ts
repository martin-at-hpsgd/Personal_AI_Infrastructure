#!/usr/bin/env bun
/**
 * StoryJudge.ts — model-graded fiction voice judge, plus a blind line-up.
 *
 * The goal is voice and quality: the draft should hold up beside published
 * fiction in voice and craft. Being undetectable as model-written is never the
 * goal and never the pass condition.
 *
 * The verdict is the blind voice line-up: paragraphs of the draft are paired
 * with corpus paragraphs of similar length and a judge is asked, in both
 * orders and without being told which is which, which one better carries the
 * voice and craft of published short fiction. The shortfall rate is the share
 * of judged pairs where the published paragraph won both times. The run passes
 * at or under --max-shortfall (0.6; parity is 0.5). --max-detect is accepted
 * as the older spelling of the same flag.
 *
 * --detect adds the older which-was-model line-up as a diagnostic: the share
 * of pairs where a judge named the draft as the model's both times. It is
 * printed beside the verdict and never decides a pass.
 *
 * The rubric diagnosis is advisory: six mechanism dimensions graded against
 * the exemplars, each with a reason, so the revision knows what to fix. It
 * is not the gate, because real authors' range (Mansfield's fragments,
 * Chekhov's free indirect summary) scores below 0.7 on it.
 *
 *   bun StoryJudge.ts <draft.md> [--pairs 8] [--seed 7] [--max-shortfall 0.6] [--detect] [--no-diagnose] [--json]
 *   bun StoryJudge.ts <draft.md> --diagnose-only [--threshold 0.7]
 *
 * Grading runs through the Assay skill's judge (never the generator's own turn).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lifeosUserDir } from "../../../LIFEOS/TOOLS/LifeosConfig.ts";
import { judgeAssertion, judgeTextPairwise } from "../../Assay/Tools/Judge.ts";
import { extractProse } from "./VoiceMetrics.ts";

const expand = (p: string) => p.replace(/^~/, process.env.HOME ?? "");
export const CORPUS_DIR = join(lifeosUserDir(), "CUSTOMIZATIONS", "SKILLS", "WriteStory", "Corpus");

export const DIMENSIONS: Array<{ id: string; weight: number; rubric: string }> = [
  {
    id: "scene_not_summary",
    weight: 2,
    rubric: `Is the story happening in scenes, or being summarised?

5 — The turns of the story happen in scenes: people in a place doing and saying things in order, with speech carrying the exchanges. Summary that moves a life along between scenes (years passing, a routine, a marriage) is fine and is how human stories are told.
3 — Scenes exist but some of the turns that matter happen in narrated summary; speech is thin or paraphrased where people should be talking.
1 — The turns happen off the page. Events that would be scenes in a human story are reported after the fact in narrated blocks; nobody speaks; the narrator tells us what happened instead of letting it happen.

Score where the TURNS happen, not the share of summary.`,
  },
  {
    id: "narrator_stays_inside",
    weight: 2,
    rubric: `Does the narrator stay with the character, or step outside to explain?

5 — The narrator tells THIS person's story in this person's terms: what they did, saw, said, thought, and what their life had been (a character's history, nature, and habits told in summary are inside, not outside). No clause that generalises to everyone/nobody/anyone/people. No line that explains what a moment means or what the reader should feel. Feeling, when named, is named once and plainly.
3 — Mostly inside; a few lines step out to interpret or to generalise ("the way anyone would", "nobody ever does", "it was the kind of X that Y", a gloss on what the scene just showed).
1 — The narrator keeps leaving the character to comment: universal claims about people, aphorisms, explanations of the emotion the scene already showed, lines addressed to the reader, meaning stated after it was shown.

Summarising a character's life is NOT stepping outside. Score only universal claims and glosses on meaning.`,
  },
  {
    id: "sentences_stop",
    weight: 1,
    rubric: `Do sentences deliver their fact and stop?

5 — Sentences end when the thing is said. Long sentences, semicolons and "and … and" are fine when each clause adds a fact; nothing is chained on for rhythm. Fragments are rare and are speech or thought, not effects.
3 — Some clauses chained on that add no fact (", which was …", ", the way …", a trailing phrase for cadence) and a few fragments used as beats, but most sentences are working sentences.
1 — Long chained sentences that keep adding clauses to sound literary, stacked fragments for punch, short declaratives in runs of three or four, lines whose word order exists for the cadence.

Score the sentences as sentences, ignoring content.`,
  },
  {
    id: "paragraph_endings",
    weight: 2,
    rubric: `How do the paragraphs end?

5 — On the last thing that happened or was said. The reader moves on because the scene moved on.
3 — A few paragraphs close on a shaped line (a short sting, a reversal, an aphorism, a "and that was that"), the rest end naturally.
1 — Most paragraphs close on a landing line built for the snap: a short sentence after long ones, a twist, a generalisation, a quotable phrase. The prose reads as a sequence of beats.

Read only the LAST sentence of each paragraph and score what share of them are shaped to land.`,
  },
  {
    id: "figures_earned",
    weight: 1,
    rubric: `Are images and figures rare and from this character's world?

5 — Comparisons are few, concrete, and things this person would actually think of. Adjectives are ordinary. No emotion is smuggled into objects ("the anxious corridor", "the indifferent rain").
3 — Some manufactured images (one striking metaphor per paragraph, a sensory swap like "the taste of copper"), but they do not crowd the plain sentences.
1 — Figures everywhere: transferred epithets, a metaphor per paragraph, "one perfect detail" placed like a prop, abstractions swapped for stock concrete images. The prose performs craft.

Score restraint, not skill.`,
  },
  {
    id: "matches_shelf",
    weight: 2,
    rubric: `Set beside the reference passages, does this carry the same voice and quality, a passage that belongs on the same shelf?

5 — Yes. It has the same unhurried plainness: a person, a place, things happening, speech, sentences that stop, endings that do not perform.
3 — Mixed. Stretches match the references; other stretches fall into generic "literary fiction" (evenly weighted sentences, tidy paragraph shapes, a feeling explained after it was shown).
1 — No. However clean, it is smooth, shaped, interpretive and general where the references are plain and particular.

Score the holistic match in voice and craft against the references only.`,
  },
];

export interface DimensionVerdict { id: string; score: number; passed: boolean; weight: number; reason: string }
export interface JudgeReport { draft: string; weighted_score: number; threshold: number; passed: boolean; dimensions: DimensionVerdict[] }

export async function judgeStory(draftText: string, label: string, threshold = 0.7): Promise<JudgeReport> {
  const exemplarsPath = `${CORPUS_DIR}/Exemplars.md`;
  let exemplars: string;
  try { exemplars = readFileSync(exemplarsPath, "utf8"); }
  catch { console.error(`StoryJudge: not configured — no exemplars at ${exemplarsPath} (see WriteStory SKILL.md § Data & Config).`); process.exit(2); }
  const prose = extractProse(draftText);
  const withExemplars = (rubric: string) => `${rubric}\n\n---\n## REFERENCE — verbatim passages of published human short fiction\n\n${exemplars}`;
  const isToolingFailure = (reason: string) => /unparseable verdict|judge error/i.test(reason);
  const gradeOnce = (d: (typeof DIMENSIONS)[number]) =>
    judgeAssertion(prose, { type: "llm-rubric", value: withExemplars(d.rubric), threshold, weight: d.weight }, { level: "high", timeout: 120_000 });
  const dimensions = await Promise.all(DIMENSIONS.map(async (d): Promise<DimensionVerdict> => {
    let r = await gradeOnce(d);
    for (let i = 0; i < 2 && isToolingFailure(r.reason); i++) r = await gradeOnce(d);
    return { id: d.id, score: r.score, passed: r.passed, weight: d.weight, reason: isToolingFailure(r.reason) ? `JUDGE UNAVAILABLE after 3 attempts — ${r.reason}` : r.reason };
  }));
  const total = dimensions.reduce((a, d) => a + d.weight, 0);
  const weighted = dimensions.reduce((a, d) => a + d.score * d.weight, 0) / total;
  return { draft: label, weighted_score: Math.round(weighted * 1000) / 1000, threshold, passed: weighted >= threshold && dimensions.every((d) => d.passed), dimensions };
}

// ---------- blind line-up ----------

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const paragraphs = (t: string) => extractProse(t).split(/\n\s*\n/).map((p) => p.trim()).filter((p) => words(p) >= 40 && words(p) <= 220);

/** Deterministic PRNG so a run is repeatable for a given seed. */
export function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

const CRAFT_ONLY = "Judge ONLY by how the sentences are written: whether the narrator stays with a person and reports what happened, or steps out to explain and generalise; whether sentences end when the fact is delivered or chain clauses for cadence; whether paragraphs end on the last thing that happened or on a line shaped to land; whether images are the character's or placed for effect. Do NOT use period, setting, subject matter (a story about technology is not evidence), names, dialect, or recognising the source as evidence; assume both could be from any era and any topic.";

/** The verdict's question: which passage better carries published fiction's voice and craft. */
export const MATCH_QUESTION = `Two passages of short fiction. Which candidate better carries the voice and craft of published literary short fiction? ${CRAFT_ONLY} The winner is the passage with the stronger voice and craft; tie only if they are genuinely level.`;

/** Diagnostic only (--detect): the older which-was-model question. It never decides a pass. */
export const DETECT_QUESTION = `One of these two passages is from a published short story by a human author; the other was written by a language model. Which candidate reads as the one written by the language model? ${CRAFT_ONLY} The winner is the machine-written candidate; tie only if you genuinely cannot tell.`;

export interface LineupOptions { judge?: typeof judgeTextPairwise; pool?: string[] }
interface LineupRow { draft: string; control: string; verdicts: string[]; counted: boolean; unavailable: boolean }
interface Lineup { pairs: number; judged: number; unavailable: number; counted: number; rate: number; rows: LineupRow[] }

export interface BlindResult { pairs: number; judged: number; unavailable: number; fell_short: number; shortfall_rate: number; max_shortfall: number; passed: boolean; rows: Array<{ draft: string; control: string; verdicts: string[]; fell_short: boolean; unavailable: boolean }> }
export interface DetectResult { diagnostic: true; pairs: number; judged: number; unavailable: number; detected: number; detection_rate: number; rows: Array<{ draft: string; control: string; verdicts: string[]; detected: boolean; unavailable: boolean }> }

/** One blind line-up. `against` is the winner pair (draft-first order, then control-first) that counts against the draft. */
async function lineup(draftText: string, question: string, against: ["A" | "B", "A" | "B"], pairs: number, seed: number, opts: LineupOptions): Promise<Lineup> {
  const r = rng(seed);
  const mine = paragraphs(draftText);
  if (mine.length < 2) throw new Error("draft has too few paragraphs of 40–220 words for a line-up");
  const pool: string[] = opts.pool ? [...opts.pool] : [];
  if (!opts.pool) {
    const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".md") && !/^(Corpus|Exemplars)\.md$/.test(f));
    for (const f of files) pool.push(...paragraphs(readFileSync(`${CORPUS_DIR}/${f}`, "utf8")));
  }
  const judge = opts.judge ?? judgeTextPairwise;
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const ask = async (x: string, y: string) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await judge(x, y, question, { level: "high", timeout: 90_000 }); }
      catch (e) { if (attempt === 2) return { winner: "tie" as const, reason: `judge unavailable: ${(e as Error).message}`, unavailable: true }; }
    }
    return { winner: "tie" as const, reason: "unreachable", unavailable: true };
  };
  const rows: LineupRow[] = [];
  const chosen = [...mine].sort(() => r() - 0.5).slice(0, pairs);
  for (const d of chosen) {
    const n = words(d);
    const near = pool.filter((p) => Math.abs(words(p) - n) <= Math.max(20, n * 0.3));
    const c = pick(near.length ? near : pool);
    const [ab, ba] = await Promise.all([ask(d, c), ask(c, d)]);
    // A judge that threw on every attempt is not a tie: the pair is unjudged and leaves the rate.
    const unavailable = "unavailable" in ab || "unavailable" in ba;
    const counted = !unavailable && ab.winner === against[0] && ba.winner === against[1];
    rows.push({ draft: d.slice(0, 80), control: c.slice(0, 80), verdicts: [`${ab.winner}: ${ab.reason}`, `${ba.winner}: ${ba.reason}`], counted, unavailable });
  }
  const counted = rows.filter((x) => x.counted).length;
  const unavailable = rows.filter((x) => x.unavailable).length;
  const judged = rows.length - unavailable;
  // No judged pair means no measurement: the rate is 1 so the verdict fails instead of passing on silence.
  const rate = judged > 0 ? Math.round((counted / judged) * 100) / 100 : 1;
  return { pairs: rows.length, judged, unavailable, counted, rate, rows };
}

/** The verdict: does the draft hold up beside published paragraphs in voice and craft? */
export async function blind(draftText: string, pairs = 8, seed = 7, maxShortfall = 0.6, opts: LineupOptions = {}): Promise<BlindResult> {
  // The published paragraph winning is "B" when the draft is shown first and "A" when it is shown second.
  const l = await lineup(draftText, MATCH_QUESTION, ["B", "A"], pairs, seed, opts);
  return {
    pairs: l.pairs, judged: l.judged, unavailable: l.unavailable, fell_short: l.counted, shortfall_rate: l.rate, max_shortfall: maxShortfall,
    passed: l.judged > 0 && l.rate <= maxShortfall,
    rows: l.rows.map(({ counted, ...row }) => ({ ...row, fell_short: counted })),
  };
}

/** Diagnostic only: how often a judge names the draft as the model's. It carries no pass condition. */
export async function detectRate(draftText: string, pairs = 8, seed = 7, opts: LineupOptions = {}): Promise<DetectResult> {
  const l = await lineup(draftText, DETECT_QUESTION, ["A", "B"], pairs, seed, opts);
  return {
    diagnostic: true, pairs: l.pairs, judged: l.judged, unavailable: l.unavailable, detected: l.counted, detection_rate: l.rate,
    rows: l.rows.map(({ counted, ...row }) => ({ ...row, detected: counted })),
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const flagsWithValue = new Set(["--threshold", "--pairs", "--seed", "--max-shortfall", "--max-detect"]);
  const files = argv.filter((a, i) => !a.startsWith("--") && !flagsWithValue.has(argv[i - 1]));
  if (!files.length) { console.error("usage: StoryJudge.ts <draft.md> [--pairs 8] [--seed 7] [--max-shortfall 0.6] [--detect] [--no-diagnose] [--json] | --diagnose-only [--threshold 0.7]"); process.exit(2); }
  const text = readFileSync(expand(files[0]), "utf8");
  const json = argv.includes("--json");
  const printDiagnosis = (rep: JudgeReport) => {
    console.log(`diagnosis (advisory): ${rep.weighted_score}`);
    for (const d of rep.dimensions) console.log(`  ${d.score >= 0.7 ? "✓" : "✗"} ${d.id} ${d.score} (w${d.weight})\n      ${d.reason}`);
  };
  if (argv.includes("--diagnose-only")) {
    const rep = await judgeStory(text, files[0], Number(arg("--threshold") ?? 0.7));
    if (json) console.log(JSON.stringify(rep, null, 2)); else printDiagnosis(rep);
    process.exit(0);
  }
  const diagnose = !argv.includes("--no-diagnose");
  const pairs = Number(arg("--pairs") ?? 8);
  const seed = Number(arg("--seed") ?? 7);
  const [res, rep, det] = await Promise.all([
    blind(text, pairs, seed, Number(arg("--max-shortfall") ?? arg("--max-detect") ?? 0.6)),
    diagnose ? judgeStory(text, files[0], 0.7) : Promise.resolve(null),
    argv.includes("--detect") ? detectRate(text, pairs, seed) : Promise.resolve(null),
  ]);
  if (json) console.log(JSON.stringify({ blind: res, diagnosis: rep, ...(det ? { detection: det } : {}) }, null, 2));
  else {
    console.log(`${res.passed ? "PASS" : "FAIL"} ${files[0]}\nVoice line-up: fell short ${res.fell_short}/${res.judged} judged (${res.shortfall_rate}) vs max ${res.max_shortfall}${res.unavailable ? `; ${res.unavailable}/${res.pairs} pairs unjudged, judge unavailable` : ""}\n`);
    for (const row of res.rows) console.log(`  ${row.unavailable ? "? unjudged  " : row.fell_short ? "✗ fell short" : "· held up   "}  ${row.draft}…\n      ${row.verdicts[0].slice(0, 220)}`);
    if (det) console.log(`\nDetection (diagnostic, never the verdict): named as the model ${det.detected}/${det.judged} judged (${det.detection_rate})`);
    if (rep) { console.log(""); printDiagnosis(rep); }
  }
  process.exit(res.passed ? 0 : 1);
}
