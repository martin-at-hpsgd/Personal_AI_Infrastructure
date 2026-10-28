#!/usr/bin/env bun
/**
 * Run.ts — the production orchestrator. Everything after the essay and the script is
 * deterministic, so this runs it, resuming from any stage. When the build stage passes, the finished Out/essay.mp4 gets
 * its STATVS render row (pipeline VideoEssay, the run's intent: Compose.recordEssayRender), the provenance VideoEval and
 * the release gates require before they admit it under any VideoEssay intent. Each stage starts as soon as the
 * stages it depends on have passed (DEPS), so independent stages run side by side:
 *
 *   lint ─┬─ narrate ── score ─┐
 *         └─ capture ──────────┴─ build ─┬─ verify ── eval ── describe
 *                                        └─ thumbnail
 *
 *   bun Run.ts --run <slug|dir> [--from <stage>] [--to <stage>] [--force] [--captions] [--music ambient|pulse] [--accept-review-shortfall] [--polish]
 *   bun Run.ts eval (--run <slug|dir> | --video <file.mp4> --intent <intent.md>) [--intent <intent.md>] [--narration <file>] [--composition <hyperframes project>] [--judges auto|always|never] [--fresh]
 *
 * `eval` runs the Assay video eval set (VIDEO_EVAL_SET, skills/Assay/Tools/VideoEval.ts) on a finished render, minus the
 * checks the intent switches off with a reason under its `## Evals` section (each one written to the receipt's
 * opt_outs); a code failure, an earned judged no, or a code check that could not be measured fails it (exit 1); a judged
 * check not measured (a vendor down, or --judges never) leaves it unmeasured (exit 2), never passed. A video inside a run
 * is held to that run's own intent: --intent naming another is refused (exit 2), and so are bytes wearing the DA essay
 * badge under any intent but VideoEssay Full or Explainer, and a switch-off the intent's pipeline may not declare. It is this pipeline's `eval` stage, after verify (both write
 * Out/rendered-audio.wav and Out/whisper/, so they never run at once), and the HyperFrames seam (`render --eval`), the
 * StoryFilm verify stage and the Video intents call the same function on their own renders.
 *
 * Voice runs: clean → align → plan → meaning → lint → capture → build → verify → eval → describe, one
 * after another. `meaning` (Meaning.ts) directs the inserts from the post's meaning and compiles
 * Plan.json; a failed plan review stops the run unless --accept-review-shortfall; --polish adds one
 * polish round after a pass.
 *
 * Every stage is idempotent and content-cached by its own tool; `--force` passes
 * through to narrate/score/capture. `score` is a no-op unless the run has a Score.json
 * or `--music <preset>` generates one. A --from/--to window treats stages outside it as done.
 * After a stage fails no new stage starts; stages already running finish (their output stays
 * cached for the resume), every failure and every stage not run is reported, and the exit code
 * is the first failing stage's. Output lines carry their stage name, since stages interleave.
 */
import { basename, join, resolve } from "node:path";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { argValue, hasFlag, resolveRunDir, readJson, runPaths, type RunMeta } from "./Lib.ts";
import { CHECKS, EvalRefusal, VIDEO_EVAL_SET, inferRunDir, intentEvalDisables, intentNamesEvalSet, runIntent, runVideoEval, type EvalDisable } from "../../Assay/Tools/VideoEval.ts";
import { recordEssayRender } from "./Compose.ts";
import type { RecordRenderResult } from "../../../LIFEOS/TOOLS/lib/RenderProvenance.ts";

/**
 * After a stage settles: a passing build stage leaves a final Out/essay.mp4, which gets its render row now (VideoEssay,
 * the run's intent). Null for every other stage or a failed build. A row that cannot be written is logged by the writer
 * and never fails the run; the eval and the gates then refuse the bytes, naming this command to re-run.
 */
export function recordBuildRender(stage: Stage, runDir: string, code: number): RecordRenderResult | null {
  if (stage !== "build" || code !== 0) return null;
  const video = runPaths(runDir).video;
  return existsSync(video) ? recordEssayRender(video, runIntent(runDir)) : null;
}

export const STAGES = ["lint", "narrate", "score", "capture", "build", "verify", "eval", "thumbnail", "describe"] as const;
export const VOICE_STAGES = ["clean", "align", "plan", "meaning", "lint", "capture", "build", "verify", "eval", "describe"] as const;
export type Stage = (typeof STAGES)[number] | (typeof VOICE_STAGES)[number];
export type PipelineMode = "essay" | "voice";

/**
 * What each stage must wait for. Essay stages wait only for the stages whose files they read;
 * voice stages each rewrite what the next one reads (Script.json, timeline.json), so they stay a chain.
 */
export const DEPS: Record<PipelineMode, Readonly<Partial<Record<Stage, readonly Stage[]>>>> = {
  essay: {
    lint: [],
    narrate: ["lint"],                      // Script.json, once lint has passed it
    score: ["narrate"],                     // timeline.json and narration.wav
    capture: ["lint"],                      // Script.json visuals only; never the narration
    build: ["narrate", "score", "capture"], // narration.wav, timeline.json, bed.wav, Assets/
    verify: ["build"],                      // the render
    // Reads Script.json, but renders inside public/runs/<slug>/thumbnail/, which Build clears when it stages. Safe beside
    // verify: verify reads Out/essay.mp4 and writes Out/{frames,review,whisper}/, rendered-audio.wav, pii.json and
    // verify.json; thumbnail writes Out/thumbnail{,-320}.png. No shared file, browser or port.
    thumbnail: ["build"],
    // The Assay video eval set on the render. After verify, never beside it: it takes Verify's format, encode, detail,
    // speech and pii results from Out/verify.json when they measured the same bytes (so whisper and the PII upload run
    // once), and when they did not its WER check re-runs Verify's speech check, which writes Out/rendered-audio.wav and
    // Out/whisper/. It writes Out/eval/ and its receipt.
    eval: ["verify"],
    // Reads only Script.json and timeline.json, but Out/description.md is a deliverable: a failed verify or eval must not
    // leave a fresh one. It takes under a second and the run ends with the eval anyway, so the wait costs nothing.
    describe: ["eval"],
  },
  voice: {
    clean: [], align: ["clean"], plan: ["align"], meaning: ["plan"], lint: ["meaning"],
    capture: ["lint"], build: ["capture"], verify: ["build"], eval: ["verify"], describe: ["eval"],
  },
};

/** Stages to execute for a --from/--to window, in pipeline order. */
export function stagesFrom(from?: string, to?: string, mode: PipelineMode = "essay"): Stage[] {
  const stages: readonly Stage[] = mode === "voice" ? VOICE_STAGES : STAGES;
  const start = from ? stages.indexOf(from as Stage) : 0;
  const end = to ? stages.indexOf(to as Stage) : stages.length - 1;
  invariant(start >= 0, `unknown stage: ${from}`);
  invariant(end >= 0, `unknown stage: ${to}`);
  invariant(start <= end, `--from ${from} is after --to ${to}`);
  return stages.slice(start, end + 1);
}

export interface StageOpts { force?: boolean; captions?: boolean; music?: string; acceptReviewShortfall?: boolean; polish?: boolean }
export function stageCommand(stage: Stage, runDir: string, opts: StageOpts): string[] {
  const tool = (name: string) => join(import.meta.dir, name);
  const force = opts.force ? ["--force"] : [];
  switch (stage) {
    case "clean": return ["bun", tool("Clean.ts"), "--run", runDir];
    case "align": return ["bun", tool("Align.ts"), "--run", runDir, "--verify"];
    case "plan": return ["bun", tool("PlanBeats.ts"), "--run", runDir];
    case "meaning": return ["bun", tool("Meaning.ts"), "--run", runDir, ...force, ...(opts.acceptReviewShortfall ? ["--accept-review-shortfall"] : []), ...(opts.polish ? ["--polish"] : [])];
    case "lint": return ["bun", tool("ScriptLint.ts"), "--run", runDir];
    case "narrate": return ["bun", tool("Narrate.ts"), "--run", runDir, ...force];
    case "score": return ["bun", tool("Score.ts"), "--run", runDir, ...force, ...(opts.music ? ["--preset", opts.music] : [])];
    case "capture": return ["bun", tool("Capture.ts"), "--run", runDir, ...force];
    case "build": return ["bun", tool("Build.ts"), "--run", runDir, ...(opts.captions ? ["--captions"] : [])];
    case "verify": return ["bun", tool("Verify.ts"), "--run", runDir];
    case "eval": return ["bun", tool("Run.ts"), "eval", "--run", runDir];
    case "thumbnail": return ["bun", tool("Thumbnail.ts"), "--run", runDir];
    case "describe": return ["bun", tool("Describe.ts"), "--run", runDir];
  }
}

export interface StageFailure { stage: Stage; code: number }
export interface PipelineResult { code: number; failed: StageFailure[]; notRun: Stage[] }

/**
 * Run a window of stages, each as soon as its in-window dependencies have passed. `runStage`
 * resolves to the stage's exit code; a thrown error counts as exit 1. After the first failure no
 * new stage starts, and the running ones are awaited rather than killed.
 */
export async function runPipeline(stages: readonly Stage[], mode: PipelineMode, runStage: (stage: Stage) => Promise<number>, onFail: (f: StageFailure, error?: unknown) => void = () => {}): Promise<PipelineResult> {
  const window = new Set(stages);
  invariant(window.size === stages.length, `duplicate stage in window: ${stages.join(", ")}`);
  const deps = new Map<Stage, Stage[]>();
  for (const [i, s] of stages.entries()) {
    const declared = DEPS[mode][s];
    invariant(declared, `stage ${s} has no dependencies declared for ${mode} runs`);
    const inWindow = declared.filter((d) => window.has(d));
    for (const d of inWindow) invariant(stages.indexOf(d) < i, `${s} waits on ${d}, which comes after it in pipeline order`);
    deps.set(s, inWindow);
  }
  const pending: Stage[] = [...stages];
  const passed = new Set<Stage>();
  const failed: StageFailure[] = [];
  // Every stage pushes its result here the moment it settles. The loop drains ALL of them before it schedules, so a
  // failure that settled beside a success is seen before that success's dependents could start.
  const settled: { stage: Stage; code: number; error?: unknown }[] = [];
  let running = 0;
  let wake: () => void = () => {};
  for (;;) {
    if (!failed.length) {
      for (const s of pending.filter((p) => deps.get(p)!.every((d) => passed.has(d)))) {
        pending.splice(pending.indexOf(s), 1);
        running++;
        Promise.resolve().then(() => runStage(s)).then((code) => ({ stage: s, code }), (error: unknown) => ({ stage: s, code: 1, error }))
          .then((r) => { settled.push(r); wake(); });
      }
    }
    if (!running) break;
    if (!settled.length) await new Promise<void>((r) => { wake = r; });
    // One macrotask more, so stages that exited in the same instant (child exits arrive as separate events) are drained together.
    await new Promise<void>((r) => setImmediate(r));
    for (const { stage, code, error } of settled.splice(0)) {
      running--;
      if (code === 0) passed.add(stage);
      else { const f = { stage, code }; failed.push(f); onFail(f, error); }
    }
  }
  invariant(failed.length > 0 || pending.length === 0, `pipeline stalled with ${pending.join(", ")} unstarted and nothing failed`);
  return { code: failed[0]?.code ?? 0, failed, notRun: pending };
}

/**
 * Copy a child's output to ours line by line, each line prefixed with its stage name. A line ends at \n, \r\n or a
 * bare \r, so a progress line redrawn with \r comes through as it happens instead of waiting for the next newline;
 * each redraw becomes its own line, since an in-place redraw would overwrite whatever another stage printed meanwhile.
 */
export async function relay(stream: ReadableStream<Uint8Array>, prefix: string, write: (s: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  const emit = (final: boolean) => {
    const end = /\r\n|\r|\n/g;
    let from = 0;
    for (let m = end.exec(buf); m; m = end.exec(buf)) {
      // A \r as the last character may be the first half of a \r\n split across chunks: the next chunk decides.
      if (!final && m[0] === "\r" && m.index === buf.length - 1) break;
      const line = buf.slice(from, m.index);
      // An empty segment before a \r is a cursor reset, not a line; an empty one before a newline is a real blank line.
      if (line || m[0] !== "\r") write(`${prefix}${line}\n`);
      from = m.index + m[0].length;
    }
    buf = buf.slice(from);
  };
  const reader = stream.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    buf += decoder.decode(r.value, { stream: true });
    emit(false);
  }
  buf += decoder.decode();
  emit(true);
  if (buf) write(`${prefix}${buf}\n`);
}

// ---------- the Assay video eval set (principal directive, 2026-10-24: every video intent runs it) ----------

/**
 * The intent declaration (an intent's `## Evals` section, the set it names, the checks it switches off) is parsed in
 * skills/Assay/Tools/VideoEval.ts, which also writes every switch-off to the receipt; re-exported here for this skill's
 * callers and tests.
 */
export { VIDEO_EVAL_SET, evalsSection, intentEvalDisables, intentNamesEvalSet, type EvalDisable } from "../../Assay/Tools/VideoEval.ts";

export interface EvalSetResult { code: 0 | 1 | 2; verdict: string; report: string; receipt: string | null; disabled: EvalDisable[]; failing: string[]; unmeasured: string[]; judgedUnmeasured: string[]; ms: number }

/**
 * Run the video eval set on a finished render as `intent` declares it: every check but the ones it switches off (each
 * logged with its reason, recorded in the report and in the receipt's opt_outs), code tier first, judges only on a clean
 * code tier, memoized by the bytes each check reads. Code 1: a failed check (code, or an earned judged no) or a code
 * check that could not be measured. Code 2: nothing blocks, but a judged check was not measured (a vendor down, or
 * judges off), so the receipt reads unavailable and the video has no passing verdict. Throws when the intent does not
 * name the set or switches off a check id the set does not have; throws an EvalRefusal (IntentMismatch,
 * IntentOriginMismatch, SwitchOffRefused, ProvenanceRefused) when the video belongs to a run made for another intent,
 * wears the DA essay badge under an intent that is not VideoEssay Full or Explainer, the intent switches off a protected
 * check, or no render row says the intent's pipeline made these bytes (or ties --composition to them).
 */
export async function runEvalSet(o: { video?: string; run?: string; intent: string; judges?: "auto" | "always" | "never"; narration?: string; composition?: string; fresh?: boolean; log?: (s: string) => void }): Promise<EvalSetResult> {
  const log = o.log ?? ((s: string) => console.log(s));
  const intent = resolve(o.intent);
  if (!existsSync(intent)) throw new Error(`no intent at ${intent}`);
  const text = readFileSync(intent, "utf8");
  if (!intentNamesEvalSet(text)) throw new Error(`${intent} does not name the Assay video eval set (${VIDEO_EVAL_SET}) under "## Evals"`);
  const disabled = intentEvalDisables(text);
  const known = new Set(CHECKS.map((c) => c.id));
  const unknown = disabled.filter((d) => !known.has(d.id)).map((d) => d.id);
  if (unknown.length) throw new Error(`${basename(intent)} disables check id(s) the eval set does not have: ${unknown.join(", ")} (bun skills/Assay/Tools/VideoEval.ts list)`);
  const off = new Set(disabled.map((d) => d.id));
  const r = await runVideoEval({ video: o.video, run: o.run, intent, narration: o.narration, composition: o.composition, fresh: o.fresh, judges: o.judges ?? "auto", disables: disabled, log });
  invariant(r.checks.every((c) => !off.has(c.id)), "a check the intent disabled ran anyway");
  invariant(r.optOuts.filter((x) => x.kind === "intent-switch-off").length === disabled.length, "every switch-off is on the receipt");
  const report = JSON.parse(readFileSync(r.report, "utf8")) as { sha256?: string };
  invariant(report.sha256 === r.sha256, `the eval report at ${r.report} is not this run's`);
  const tmp = `${r.report}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...report, evalSet: VIDEO_EVAL_SET }, null, 2));
  renameSync(tmp, r.report);
  const failing = r.checks.filter((c) => c.status === "fail" || c.findings?.some((f) => f.severity === "fail")).map((c) => c.id);
  const unmeasured = r.checks.filter((c) => c.status === "unavailable" && c.tier === "code").map((c) => c.id);
  const judgedUnmeasured = r.checks.filter((c) => c.status === "unavailable" && c.tier !== "code").map((c) => c.id);
  const code = failing.length || unmeasured.length ? 1 : judgedUnmeasured.length ? 2 : 0;
  const t = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  log(`${code ? "✗" : "✓"} video eval set ${r.verdict} · code tier ${t(r.ms.code)} · judged ${t(r.ms.judged)} · total ${t(r.ms.total)}${failing.length ? ` · failing: ${failing.join(", ")}` : ""}${unmeasured.length ? ` · code checks not measured: ${unmeasured.join(", ")} (fix the input, or disable the check in the intent with its reason)` : ""}${judgedUnmeasured.length ? ` · judges not measured: ${judgedUnmeasured.join(", ")}` : ""}`);
  log(`  report: ${r.report}${r.receipt ? `\n  receipt: ${r.receipt}` : ""}`);
  return { code, verdict: r.verdict, report: r.report, receipt: r.receipt, disabled, failing, unmeasured, judgedUnmeasured, ms: r.ms.total };
}

/** `Run.ts eval …`: the eval set on a run's render or on any rendered file. Exit 0 clean, 1 blocking, 2 unmeasured, usage, or a refusal (another intent than the run's, a badge-bearing video under a non-essay intent, a disallowed switch-off). */
export async function evalMain(argv: string[]): Promise<number> {
  const run = argValue(argv, "--run"), video = argValue(argv, "--video");
  const judges = (argValue(argv, "--judges") ?? "auto") as "auto" | "always" | "never";
  if ((!run && !video) || !["auto", "always", "never"].includes(judges)) {
    console.error("usage: Run.ts eval (--run <slug|dir> | --video <file.mp4> --intent <intent.md>) [--intent <intent.md>] [--narration <file>] [--composition <hyperframes project>] [--judges auto|always|never] [--fresh]");
    return 2;
  }
  const runDir = run ? resolveRunDir(run) : video ? inferRunDir(resolve(video)) : null;
  const intent = argValue(argv, "--intent") ?? (runDir ? runIntent(runDir) ?? undefined : undefined);
  if (!intent) { console.error("Run.ts eval: name the intent the video was made for (--intent <intent.md>)"); return 2; }
  try {
    return (await runEvalSet({ run: run ? runDir! : undefined, video, intent, judges, narration: argValue(argv, "--narration"), composition: argValue(argv, "--composition"), fresh: hasFlag(argv, "--fresh") })).code;
  } catch (e) {
    console.error(`✗ video eval set: ${(e as Error).message}`);
    return e instanceof EvalRefusal ? 2 : 1;
  }
}

async function spawnStage(stage: Stage, cmd: string[]): Promise<number> {
  const prefix = `[${stage}] `;
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [code] = await Promise.all([
    p.exited,
    relay(p.stdout, prefix, (s) => process.stdout.write(s)),
    relay(p.stderr, prefix, (s) => process.stderr.write(s)),
  ]);
  return code;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === "eval") process.exit(await evalMain(argv.slice(1)));
  const runArg = argValue(argv, "--run");
  if (!runArg) { console.error("usage: Run.ts --run <slug|dir> [--from <stage>] [--to <stage>] [--force] [--captions] [--music ambient|pulse] [--accept-review-shortfall] [--polish]"); process.exit(2); }
  const dir = resolveRunDir(runArg);
  const opts: StageOpts = { force: hasFlag(argv, "--force"), captions: hasFlag(argv, "--captions"), music: argValue(argv, "--music"), acceptReviewShortfall: hasFlag(argv, "--accept-review-shortfall"), polish: hasFlag(argv, "--polish") };
  const t0 = Date.now();
  const metaPath = runPaths(dir).meta;
  const mode: PipelineMode = existsSync(metaPath) ? readJson<RunMeta>(metaPath).mode ?? "essay" : "essay";
  const result = await runPipeline(stagesFrom(argValue(argv, "--from"), argValue(argv, "--to"), mode), mode, async (stage) => {
    console.log(`\n━━ ${stage} ━━`);
    const code = await spawnStage(stage, stageCommand(stage, dir, opts));
    const row = recordBuildRender(stage, dir, code);
    if (row) console.log(row.ok ? `[build] render row written: VideoEssay ${row.sha256.slice(0, 12)}…` : `[build] no render row: ${row.why}`);
    if (code !== 0 || stage !== "capture" || mode !== "voice") return code;
    return spawnStage(stage, ["bun", join(import.meta.dir, "Capture.ts"), "--run", dir, "--verify"]);
  }, ({ stage, code }, error) => console.error(`✗ stage ${stage} failed (${code})${error ? `: ${error instanceof Error ? error.message : String(error)}` : ""}`));
  if (result.failed.length) {
    if (result.notRun.length) console.error(`· not run: ${result.notRun.join(", ")}`);
    console.error(`✗ run failed at ${result.failed.map((f) => f.stage).join(", ")}: nothing in ${dir}/Out is deliverable until a run passes`);
    process.exit(result.code);
  }
  console.log(`\n✓ pipeline done in ${Math.round((Date.now() - t0) / 1000)}s → ${dir}/Out`);
}
