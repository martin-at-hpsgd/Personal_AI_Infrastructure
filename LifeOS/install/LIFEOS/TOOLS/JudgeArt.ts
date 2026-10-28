#!/usr/bin/env bun
/**
 * JUDGEART - Vision-judge a batch of candidate art/thumbnails against a brief.
 *
 * The reusable judge loop behind thumbnail + art generation. Hand it N proof images
 * and the piece's brief; it takes MANY judge samples (lenses × trials), pools them
 * per image into a mean ± standard error, and ranks — but refuses to call a winner
 * when the gap between the top two sits inside the noise band. This is the fix for
 * a single stochastic judge call swinging ±0.6 run to run and flip-flopping a ~0.3
 * difference: average more samples, and never report a winner the noise can't support.
 *
 * Vision routes through Assay's one judge transport (LIFEOS/ASSAY/JudgeCall.ts, which
 * forwards to Inference.ts, subscription-billed) at a distinct judge level, mirroring the Assay doctrine that the judge is a stronger/different rung.
 *
 * USAGE
 *   bun JudgeArt.ts --brief "<video title + the argument>" \
 *     --images a-320.png,b-320.png [--bar 7.0] [--judges 2] [--trials 3] [--level high] [--json]
 *
 * Samples per image = judges (lens diversity) × trials (repeat for variance). Default
 * 2 × 3 = 6. Judge at THUMBNAIL SIZE: pass the 320-wide proofs, not the 1920 masters.
 *
 * OUTPUT (--json): { winner, tie, none_pass, bar,
 *   images:[{id,file,mean,se,sd,n,lowerBound,clearsBar}], feedback, samples:[...raw verdicts] }
 * Exit 0 when a clear winner clears the bar; exit 3 when none clear it or the top is a tie.
 */

import { judgeText } from '../ASSAY/JudgeCall.ts';
import { summarize } from '../../skills/Assay/Tools/Stats.ts';

interface Args {
  brief: string;
  images: string[];
  bar: number;
  judges: number;
  trials: number;
  level: 'low' | 'medium' | 'high' | 'max';
  json: boolean;
  rubric?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { brief: '', images: [], bar: 7.0, judges: 2, trials: 3, level: 'high', json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--brief') { a.brief = v; i++; }
    else if (k === '--images') { a.images = v.split(/[,\s]+/).filter(Boolean); i++; }
    else if (k === '--bar') { a.bar = parseFloat(v); i++; }
    else if (k === '--judges') { a.judges = parseInt(v, 10); i++; }
    else if (k === '--trials') { a.trials = parseInt(v, 10); i++; }
    else if (k === '--level') { a.level = v as Args['level']; i++; }
    else if (k === '--rubric') { a.rubric = v; i++; }
    else if (k === '--json') { a.json = true; }
  }
  return a;
}

const DEFAULT_RUBRIC = [
  'art quality & premium feel (not stock/clip-art)',
  "specificity to THIS piece's actual argument — a viewer who read it should recognise which one it is; generic category art is a fail",
  'legibility at thumbnail size — title readable, subject clear, not muddy',
  'composition & clean layout — left third dark enough for white type, no subject/text collision',
  'click-worthiness / stopping power in a feed, and emotional match to the title',
].map((c, i) => `${i + 1}. ${c}`).join('\n');

interface JudgeVerdict {
  scores: { id: number; overall: number; available: boolean; note?: string }[];
  fix: string;
}

export function validVerdict(value: unknown, count: number): value is JudgeVerdict {
  const v=value as JudgeVerdict;
  return !!v && Array.isArray(v.scores) && v.scores.length===count &&
    Array.from({length:count},(_,i)=>i+1).every(id=>v.scores.filter(s=>s.id===id).length===1) &&
    v.scores.every(s=>s.available===true && Number.isFinite(s.overall) && s.overall>=0 && s.overall<=10);
}

function judgeSystemPrompt(rubric: string): string {
  return [
    'You are a strict, discerning art director scoring candidate thumbnails/art before they ship.',
    'You are shown several images IN ORDER; the first attached image is id 1, the second id 2, and so on.',
    'Judge them at real viewing (thumbnail) size — how a viewer actually sees them in a feed.',
    'Score EACH image 0-10 overall (one decimal) against these weighted criteria:',
    rubric,
    'Be discerning: SPREAD the scores, never cluster them. Fail pretty-but-generic images.',
    'Return ONLY strict JSON, no prose, exactly this shape:',
    'Read every attached image. If any image is unavailable, set available:false; never invent a placeholder quality score.',
    '{"scores":[{"id":1,"available":true,"overall":<num>,"note":"<=12 words"}, ...one per image in order...],',
    '"fix":"the concrete art/text direction that would most improve the batch"}',
  ].join('\n');
}

async function runSample(lensIdx: number, args: Args, rubric: string): Promise<JudgeVerdict | null> {
  const sys = judgeSystemPrompt(rubric);
  const lens = lensIdx % 2 === 0
    ? 'Weight specificity-to-the-argument and stopping power most heavily.'
    : 'Weight craft, color harmony, and legibility at small size most heavily.';
  const user = [
    `BRIEF: ${args.brief}`,
    '',
    lens,
    '',
    `You are judging ${args.images.length} images, attached in order (id 1..${args.images.length}).`,
  ].join('\n');
  try {
    const res = await judgeText({ systemPrompt: sys, userPrompt: user, level: args.level, expectJson: true, imagePaths: args.images });
    if (!res.success) return null;
    const parsed = (res.parsed ?? JSON.parse(res.output)) as JudgeVerdict;
    if (!validVerdict(parsed,args.images.length)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Mean, standard error and sd of the pooled samples, from Assay's statistics (sd = sem x sqrt(n); 0 below two samples). */
function stats(xs: number[]): { mean: number; sd: number; se: number; n: number } {
  const s = summarize(xs, false);
  return { mean: s.mean, sd: s.sem * Math.sqrt(s.n), se: s.sem, n: s.n };
}
const r2 = (x: number) => Math.round(x * 100) / 100;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.brief || args.images.length < 1) {
    console.error('Usage: bun JudgeArt.ts --brief "<title + argument>" --images a.png[,b.png,...] [--bar 7.0] [--judges 2] [--trials 3] [--level high] [--json]');
    process.exit(2);
  }
  const rubric = args.rubric ?? DEFAULT_RUBRIC;

  // Samples = lenses × trials, all pooled. More samples → the mean stops swinging.
  const tasks: Promise<JudgeVerdict | null>[] = [];
  for (let lens = 0; lens < args.judges; lens++) {
    for (let t = 0; t < args.trials; t++) tasks.push(runSample(lens, args, rubric));
  }
  const verdicts = (await Promise.all(tasks)).filter((v): v is JudgeVerdict => v !== null);
  if (verdicts.length < 2) {
    console.error(`Too few judge samples returned (${verdicts.length}); cannot rank reliably.`);
    process.exit(1);
  }

  const images = args.images.map((file, i) => {
    const id = i + 1;
    const xs = verdicts.map((v) => v.scores.find((s) => s.id === id)?.overall).filter((x): x is number => typeof x === 'number');
    const s = stats(xs);
    const lowerBound = s.mean - s.se; // conservative: the score we're confident it's at least
    return { id, file, mean: r2(s.mean), sd: r2(s.sd), se: r2(s.se), n: s.n, lowerBound: r2(lowerBound), clearsBar: lowerBound >= args.bar };
  }).sort((a, b) => b.mean - a.mean);

  const [top, second] = images;
  // A winner is real only if it clears the bar AND its lead exceeds the combined noise of the top two.
  const gap = second ? top.mean - second.mean : 0;
  const noise = second ? top.se + second.se : top.se;
  const decisive = !second || gap > noise;
  const none_pass = !images.some((im) => im.clearsBar);
  const tie = !none_pass && !decisive;
  const winner = none_pass || tie ? null : top.id;

  const feedback = winner === null ? verdicts.map((v) => v.fix).filter(Boolean).slice(0, 3).join(' || ') : '';

  const out = { winner, tie, none_pass, bar: args.bar, samples_per_image: verdicts.length, images, feedback, verdicts };

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`\nJudged ${args.images.length} images · ${verdicts.length} samples each (${args.judges} lenses × ${args.trials} trials) · bar ${args.bar}:\n`);
    for (const im of images) {
      console.log(`  ${im.clearsBar ? '✅' : '❌'} id ${im.id}  ${im.mean} ± ${im.se}  (lb ${im.lowerBound}, n=${im.n})  ${im.file}`);
    }
    if (none_pass) console.log(`\n⚠️  NONE clear the bar (lower bound < ${args.bar}) — iterate.\n\nFEEDBACK:\n${feedback}\n`);
    else if (tie) console.log(`\n🤝 TIE at the top: id ${top.id} vs id ${second.id} differ by ${r2(gap)}, inside the ±${r2(noise)} noise band. No decisive winner — pick on other grounds or iterate.\n\nFEEDBACK:\n${feedback}\n`);
    else console.log(second ? `\n🏆 WINNER: id ${winner} (${top.file}) — ${top.mean} beats ${second.mean} by ${r2(gap)} > ±${r2(noise)} noise.\n` : `\nCandidate ${winner} clears the bar with lower bound ${top.lowerBound}.\n`);
  }
  process.exit(winner === null ? 3 : 0);
}

if(import.meta.main)main();
