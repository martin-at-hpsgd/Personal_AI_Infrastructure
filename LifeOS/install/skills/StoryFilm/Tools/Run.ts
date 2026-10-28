#!/usr/bin/env bun
/**
 * Run.ts — the whole pipeline after the storyboard is written.
 *
 *   bun Run.ts --run <slug|dir> [--from stage] [--to stage] [--force] [--no-captions] [--concurrency N] [--workers N] [--end-line text] [--deliver [--critique file]]
 *
 * Stages, in order: lint → bible → shots → narrate → build → verify → sheet. `verify` reads the film back and runs the
 * Assay video eval set on it (as Intents/Produce.md declares it, under `## Evals`) side by side; either failing fails it. That order bounds `--from`/`--to` (a
 * resume after an edit re-does only what its inputs changed anyway — every stage is hash-cached). The run itself has two
 * legs: after lint, bible → shots and narrate run side by side (narration reads only Beats.json), and build starts only
 * when both legs have passed their checks. A failed leg stops the run before build; the other leg is allowed to finish
 * so its cached work survives, and every failed leg is reported. A narrate-only range (`--from narrate --to narrate`)
 * needs no Storyboard.json, so narration can start right after Intake while the storyboard is still being written. `--deliver` hands the film to ArtDirection's Deliver.ts, which refuses without a passing, fresh critique
 * (Out/Critique.json, or --critique <file>) and a passing Proof receipt; on success the film and its review sheets land in
 * <downloads>/<slug>/. Nothing reaches the downloads folder any other way.
 * Intake and the storyboard are not stages here: Intake.ts creates the run, and the Storyboard intent writes
 * Storyboard.json — Run.ts refuses to start without it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { deliverChecked, type DeliveryResult } from "../../ArtDirection/Tools/Deliver.ts";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { argValue, expandHome, hasFlag, loadBeats, loadRun, loadStoryboard, resolveRunDir, runPaths } from "./Lib.ts";
import { lintStoryboard } from "./StoryboardLint.ts";
import { paintBible, verifyBible } from "./Characters.ts";
import { paintShots, verifyShots } from "./Shots.ts";
import { narrateAndVerify } from "./Narrate.ts";
import { render, stageRun } from "./Build.ts";
import { verify } from "./Verify.ts";

/** The intent this pipeline executes; its `## Evals` section names the video eval set and the checks it switches off. */
export const EVAL_INTENT = join(import.meta.dir, "..", "Intents", "Produce.md");

/**
 * The Assay video eval set on the film, through VideoEssay's `Run.ts eval` command: a process boundary rather than an
 * import, so the two skills stay separate release units (Decisions 2026-09-17).
 */
export function evalCommand(video: string, intent: string = EVAL_INTENT): string[] {
  return ["bun", join(import.meta.dir, "..", "..", "VideoEssay", "Tools", "Run.ts"), "eval", "--video", video, "--intent", intent];
}

/** Run the eval set and relay its lines to `log`; resolves to its exit code (0 clean, 1 blocking, 2 usage). */
export async function runEvalSet(video: string, log: StageLog): Promise<number> {
  const p = Bun.spawn(evalCommand(video), { stdout: "pipe", stderr: "pipe" });
  const lines = async (s: ReadableStream<Uint8Array>) => { const t = await new Response(s).text(); if (t.trim()) log(t.trimEnd().split(/\r?\n/).map((l) => `[eval] ${l}`).join("\n")); };
  const [code] = await Promise.all([p.exited, lines(p.stdout), lines(p.stderr)]);
  return code;
}

export const STAGES = ["lint", "bible", "shots", "narrate", "build", "verify", "sheet"] as const;
export type Stage = (typeof STAGES)[number];

export function stageRange(from?: string, to?: string): Stage[] {
  const a = from ? STAGES.indexOf(from as Stage) : 0, b = to ? STAGES.indexOf(to as Stage) : STAGES.length - 1;
  invariant(a >= 0 && b >= 0 && a <= b, `bad stage range ${from ?? "lint"}..${to ?? "sheet"} (stages: ${STAGES.join(" → ")})`);
  return STAGES.slice(a, b + 1);
}

/** The two legs that run side by side after lint. Build waits for both. */
export const VISUAL_LEG: readonly Stage[] = ["bible", "shots"];
export const NARRATION_LEG: readonly Stage[] = ["narrate"];

export interface StagePlan { before: Stage[]; visual: Stage[]; narration: Stage[]; after: Stage[] }

/** Splits a selected range into what runs first, the two parallel legs, and what waits for both. */
export function planStages(stages: readonly Stage[]): StagePlan {
  const at = (s: Stage) => STAGES.indexOf(s);
  return {
    before: stages.filter((s) => at(s) < at("bible")),
    visual: stages.filter((s) => VISUAL_LEG.includes(s)),
    narration: stages.filter((s) => NARRATION_LEG.includes(s)),
    after: stages.filter((s) => at(s) > at("narrate")),
  };
}

/** Every stage but narration reads Storyboard.json; narration reads only Beats.json and run.json. */
export function requiresStoryboard(stages: readonly Stage[]): boolean { return stages.some((s) => !NARRATION_LEG.includes(s)); }

export type StageLog = (text: string) => void;
export type StageHandlers = Record<Stage, (log: StageLog) => Promise<void>>;

/** A stage's log: every line it writes goes out prefixed `[stage] `, as VideoEssay's Run.ts relays its stages. */
export function stageLog(stage: Stage, write: (line: string) => void = (line) => console.log(line)): StageLog {
  return (text) => { for (const line of text.split(/\r?\n/)) write(`[${stage}] ${line}`); };
}

/**
 * Runs the selected stages in the pipeline's shape: `before` in order, then the visual leg and the narration leg side by
 * side, then `after` in order once both legs are done. Each stage gets its own prefixed log (stageLog), so the two legs'
 * interleaved lines stay attributable. Promise.allSettled lets a healthy leg finish when the other fails
 * (no stage can be cancelled mid-write, and its cached output is what the retry reuses); every failed leg is reported
 * through onLegFailure and the first failure is rethrown unchanged, so nothing after the legs runs.
 */
export async function runStages(stages: readonly Stage[], handlers: StageHandlers, hooks: { onStage?: (stage: Stage) => void; onLegFailure?: (leg: string, error: unknown) => void; write?: (line: string) => void } = {}): Promise<void> {
  const plan = planStages(stages);
  const runInOrder = async (list: readonly Stage[]) => { for (const stage of list) { hooks.onStage?.(stage); await handlers[stage](stageLog(stage, hooks.write)); } };
  await runInOrder(plan.before);
  const legs = [{ name: plan.visual.join(" → "), stages: plan.visual }, { name: plan.narration.join(" → "), stages: plan.narration }].filter((l) => l.stages.length);
  const settled = await Promise.allSettled(legs.map((l) => runInOrder(l.stages)));
  const failures = settled.flatMap((r, i) => (r.status === "rejected" ? [{ leg: legs[i].name, error: r.reason as unknown }] : []));
  for (const f of failures) hooks.onLegFailure?.(f.leg, f.error);
  if (failures.length) throw failures[0].error;
  await runInOrder(plan.after);
}

export function downloadsDir(): string { return expandHome(process.env.LIFEOS_DOWNLOADS_DIR ?? "~/Downloads"); }

/**
 * Delivers the rendered film through Deliver.ts, the one path to the downloads folder for an artistic artifact: it
 * throws, copying nothing, unless the critique of exactly these bytes passed and a Proof receipt clears them.
 */
export async function deliverFilm(o: { video: string; slug: string; downloads: string; critique?: string }): Promise<DeliveryResult> {
  invariant(existsSync(o.video), `no film at ${o.video}: run the build stage first`);
  return deliverChecked({ artifact: o.video, critique: o.critique, to: join(o.downloads, o.slug) });
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const runArg = argValue(argv, "--run");
  if (!runArg) { console.error("usage: Run.ts --run <slug|dir> [--from stage] [--to stage] [--force] [--no-captions] [--concurrency N] [--workers N] [--end-line text] [--deliver [--critique file]]"); process.exit(2); }
  const dir = resolveRunDir(runArg);
  const paths = runPaths(dir);
  invariant(existsSync(paths.beats), `no Beats.json in ${dir} — run Intake.ts first`);
  const stages = stageRange(argValue(argv, "--from"), argValue(argv, "--to"));
  if (requiresStoryboard(stages)) invariant(existsSync(paths.storyboard), `no Storyboard.json in ${dir} — run the Storyboard intent first`);
  const force = hasFlag(argv, "--force");
  const concurrency = Number(argValue(argv, "--concurrency")) || undefined;
  const workers = Number(argValue(argv, "--workers")) || undefined;
  const t0 = Date.now();
  const stamp = () => `[${Math.round((Date.now() - t0) / 1000)}s]`;
  const handlers: StageHandlers = {
    lint: async (log) => {
      const problems = lintStoryboard(loadBeats(dir), loadStoryboard(dir));
      for (const p of problems) log(`✗ ${p}`);
      invariant(!problems.length, `storyboard has ${problems.length} problem(s)`);
      log(`✓ storyboard lints clean (${loadStoryboard(dir).shots.length} shots)`);
    },
    bible: async (log) => {
      await paintBible(dir, { force, log });
      const r = await verifyBible(dir);
      invariant(r.ok, `bible failed: ${r.problems.join("; ")}`);
    },
    shots: async (log) => {
      await paintShots(dir, { force, concurrency, log });
      const r = await verifyShots(dir);
      invariant(r.ok, `shots failed: ${r.problems.join("; ")}`);
    },
    narrate: async (log) => {
      await narrateAndVerify(dir, { force, log });
    },
    build: async (log) => {
      const { plan, projectDir, trimmed } = await stageRun(dir, { captions: !hasFlag(argv, "--no-captions"), endLine: argValue(argv, "--end-line") });
      log(`✓ staged ${plan.paintings.length} beats (${trimmed} paper-trimmed) · ${plan.total.toFixed(1)}s`);
      const res = await render(projectDir, paths.video, { workers, logPath: paths.renderLog });
      log(`✓ ${paths.video} (${Math.round(res.ms / 1000)}s)`);
    },
    verify: async (log) => {
      // The film's own read-back and the Assay video eval set side by side: the set reads the film as a bare video and
      // writes only Out/film.mp4.eval/ and its receipt, so nothing the two write is shared.
      const [r, code] = await Promise.all([verify(dir, { log }), runEvalSet(paths.video, log)]);
      invariant(r.ok, "film failed verification");
      invariant(code === 0, `film failed the Assay video eval set (exit ${code}): ${paths.video}.eval/video-eval.json`);
    },
    sheet: async (log) => {
      const r = await verify(dir, { only: "sheet", log });
      invariant(r.ok, "review sheets failed");
    },
  };
  await runStages(stages, handlers, {
    onStage: (stage) => console.log(`\n── ${stage} ${stamp()}`),
    onLegFailure: (leg, error) => console.error(`✗ ${leg} failed ${stamp()}: ${error instanceof Error ? error.message : String(error)}`),
  });
  if (hasFlag(argv, "--deliver")) {
    try {
      const result = await deliverFilm({ video: paths.video, slug: loadRun(dir).slug, downloads: downloadsDir(), critique: argValue(argv, "--critique") });
      for (const file of result.files) console.log(`✓ ${file.dest}`);
      if (result.flagLine) console.log(`Proof: ${result.flagLine}. Say so when presenting.`);
    } catch (error) {
      console.error(`✗ not delivered: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }
  console.log(`\n✓ done ${stamp()}`);
}
