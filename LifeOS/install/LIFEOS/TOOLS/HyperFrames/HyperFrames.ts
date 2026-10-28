#!/usr/bin/env bun
/**
 * HyperFrames seam: the one path every LifeOS video skill renders through.
 *
 *   bun HyperFrames.ts render   --project <dir> --out <file.mp4|webm|mov> [--fps 30] [--workers 1] [--quality standard]
 *                               [--variables vars.json] [--still] [--audio] [--skip-check] [--no-contrast] [--log render.log] [--gpu auto|hardware|software]
 *                               [--eval <intent.md> | --no-eval "<reason>"]
 *                               (a final encode, an mp4 at any quality but draft, runs the Assay video eval set as its intent's
 *                                `## Evals` declares it; the intent comes from --eval or the project's intent.json. Without the
 *                                eval runner (VideoEssay, not in the public release) a final encode skips the set as "not-installed"
 *                                and still renders. With it, a final encode with neither, and no --no-eval reason, exits 2 before
 *                                rendering. A blocking eval result
 *                                exits 1. The eval, or the skip and its reason, rides in the JSON as "eval". README § Eval.)
 *   bun HyperFrames.ts snapshot --project <dir> --at 0,1.5 --out-dir <dir> [--gpu auto|hardware|software] [--no-proof]
 *                               (every snapshot also proofs its own stills: the standing profile, plus <project>/proof.json when present;
 *                                the result rides in the output JSON as "proof" and never changes the exit code)
 *   bun HyperFrames.ts check    --project <dir> [--no-contrast] [--gpu auto|hardware|software]
 *   bun HyperFrames.ts bands    --wav narration.wav --fps 30 --out bands.json [--bands 8] [--spectrum 32]
 *   bun HyperFrames.ts stage-gsap --project <dir>
 *   bun HyperFrames.ts install
 *
 * Every render that passes validation writes its STATVS render row (recordSeamRender: pipeline HyperFrames, the intent
 * from --eval or the project's intent.json, the project dir and a digest of its files), the provenance VideoEval and the
 * release gates read before they admit the film under a HyperFrames intent or accept --composition for it.
 *
 * Exit codes: 0 done, 1 the work failed (check, probe, render or validation), 2 usage error.
 * Contract and gotchas: README.md beside this file.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { invariant } from "../Invariant";
import { getClaudeDir } from "../Paths";
import { recordRenderOf, type RecordRenderResult } from "../lib/RenderProvenance";
import { audioBands } from "./audio";
import { HYPERFRAMES_VERSION } from "./constants";
import { GPU_REQUESTS, resolveGpu, type GpuDecision, type GpuRequest } from "./gpu";
import { blankOf, CODEC_FOR, ffprobe, FLAT_MAX_VARIED, meanLevel, motionOf, sampleFrames, stillStats, stripProvenance, validateOutput, variedFraction, type MotionResult, type OutputFormat, type Validation } from "./media";
import { preflight, type Finding } from "./preflight";
import { probeTimelines, type ProbeResult } from "./probe";
import { ensureInstalled, runHyperFrames, stageGsap } from "./run";

export { audioBands, audioBandsScript, computeAudioBands } from "./audio";

/**
 * Proof on the stills a snapshot just took (skills/Assay/Intents/Proof.md). The earliest draft is where a defect costs seconds,
 * so the seam runs it every time: the kind's standing profile always, plus <project>/proof.json when the brief was compiled.
 * Advisory here: the result is reported, the snapshot still succeeds, and the presentation gates hold the line.
 */
export async function proofStills(projectDir: string, times: number[], firstStill: string | undefined): Promise<Record<string, unknown>> {
  const tool = resolve(import.meta.dir, "../../../skills/Assay/Tools/Proof.ts");
  if (!existsSync(tool) || !firstStill) return { skipped: existsSync(tool) ? "no still" : "Proof not installed" };
  const checks = join(projectDir, "proof.json");
  const argv = ["bun", tool, "run", "--artifact", firstStill, "--project", projectDir, "--at", times.join(","), "--json", ...(existsSync(checks) ? ["--checks", checks] : [])];
  const t0 = Date.now();
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 240_000);
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  clearTimeout(timer);
  try {
    const j = JSON.parse(out) as { receipt?: Record<string, unknown> } & Record<string, unknown>;
    const r = (j.receipt ?? j) as { verdict?: string; counts?: unknown; findings?: { check: string; severity: string; t?: number | null; message: string; crop?: string | null }[] };
    return {
      exit: code, ms: Date.now() - t0, verdict: r.verdict, counts: r.counts, checks: existsSync(checks) ? checks : "standing profile only (no proof.json)",
      findings: (r.findings ?? []).slice(0, 20).map((f) => ({ check: f.check, severity: f.severity, t: f.t ?? null, message: f.message, crop: f.crop ?? null })),
    };
  } catch {
    return { exit: code, ms: Date.now() - t0, error: "Proof output was not JSON", tail: out.slice(-400) };
  }
}
/**
 * The Assay video eval set on a finished render (`render --eval <intent.md>`), through VideoEssay's `Run.ts eval`: every
 * check but the ones the intent switches off with a reason, code tier first, judges after. Blocking, unlike proofStills: a
 * code failure, an earned judged no, or an unmeasured code check fails the render. Its log goes to stderr, so stdout stays
 * the one JSON line. The report lands at `<out>.eval/video-eval.json`. The project dir rides along as `--composition`,
 * so type-rendered reads the built composition the encode came from instead of being switched off.
 */
/** The runner behind the eval set. VideoEssay is not in the public release, so a public install has no runner. */
export const EVAL_RUNNER = resolve(import.meta.dir, "../../../skills/VideoEssay/Tools/Run.ts");

/** True when this install has the eval runner. A missing runner skips the eval set on default renders (decideEval). */
export function evalRunnerInstalled(runner = EVAL_RUNNER): boolean { return existsSync(runner); }

export function evalCommand(out: string, intent: string, project?: string): string[] {
  return ["bun", EVAL_RUNNER, "eval", "--video", resolve(out), "--intent", resolve(intent), ...(project ? ["--composition", resolve(project)] : [])];
}
export async function evalRender(out: string, intent: string, project?: string): Promise<{ exit: number; ms: number; report: string }> {
  const t0 = Date.now();
  const cmd = evalCommand(out, intent, project);
  if (!existsSync(cmd[1]!)) return { exit: 1, ms: 0, report: `the eval runner is not installed at ${cmd[1]}` };
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const relay = async (s: ReadableStream<Uint8Array>) => { for await (const chunk of s) process.stderr.write(chunk); };
  const [exit] = await Promise.all([proc.exited, relay(proc.stdout), relay(proc.stderr)]);
  return { exit, ms: Date.now() - t0, report: `${resolve(out)}.eval/video-eval.json` };
}

/**
 * Where a project records the intent its final encodes are made for: `<project>/intent.json`, `{"intent": "<path>"}`,
 * the path absolute, `~/`-rooted, or relative to ~/.claude. A builder that knows its intent writes it (SystemFilm.ts,
 * Scaffold.ts --intent), so `render` on that project runs the eval set with no flag. README § Eval.
 */
export const INTENT_RECORD = "intent.json";

/** An intent path as written in a record or passed to --eval: `~/` expands, a relative path tries `bases` in order (first that exists, else the first). */
export function resolveIntentPath(p: string, bases: string[]): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (isAbsolute(p)) return p;
  const tries = bases.map((b) => resolve(b, p));
  return tries.find((t) => existsSync(t)) ?? tries[0]!;
}

/** The intent the project records, null when it records none; a record that is not `{"intent": "<path>"}` is an error. */
export function recordedIntent(projectDir: string): { intent: string } | { error: string } | null {
  const file = join(resolve(projectDir), INTENT_RECORD);
  if (!existsSync(file)) return null;
  let j: unknown;
  try { j = JSON.parse(readFileSync(file, "utf8")); } catch (e) { return { error: `${file} is not JSON: ${(e as Error).message}` }; }
  const p = (j as { intent?: unknown } | null)?.intent;
  if (typeof p !== "string" || !p.trim()) return { error: `${file} must be {"intent": "<path to the intent .md>"}` };
  return { intent: resolveIntentPath(p.trim(), [getClaudeDir()]) };
}

/** Write the project's intent record. The path is stored relative to ~/.claude when it lies under it, so the record survives a moved home. */
export function recordIntent(projectDir: string, intent: string): string {
  const abs = resolve(intent);
  invariant(existsSync(abs) && abs.endsWith(".md"), `recordIntent: ${abs} is not an intent .md file`);
  invariant(existsSync(resolve(projectDir)), `recordIntent: no project at ${projectDir}`);
  const claude = getClaudeDir();
  const rel = relative(claude, abs);
  const stored = !rel.startsWith("..") && !isAbsolute(rel) ? rel : abs;
  const file = join(resolve(projectDir), INTENT_RECORD);
  writeFileSync(file, JSON.stringify({ intent: stored }, null, 2) + "\n");
  return file;
}

/**
 * Null when this output is a final encode, else why it is not. Final means an mp4 at any quality but draft: an mp4 is
 * what gets delivered, uploaded or cut into a film. A draft-quality mp4 is a preview; mov and webm are overlay and
 * intermediate formats that are composited into something else. GIFs and frame captures never come through `render`:
 * Art builds its GIFs from an mp4 it renders through the library call, and stills come from `snapshot`. Pure.
 */
export function notFinalReason(format: string, quality: string): string | null {
  if (format !== "mp4") return `a ${format} render is an overlay or intermediate, not a final encode`;
  if (quality === "draft") return "a draft-quality render is a preview, not a final encode";
  return null;
}

export type EvalDecision =
  | { action: "eval"; intent: string; source: "--eval" | "project" }
  | { action: "skip"; reason: string; source: "--no-eval" | "not-final" | "not-installed" }
  | { action: "refuse"; message: string };

/**
 * Whether `render` runs the eval set, decided before any frame renders. Order: both flags is a usage error; a
 * `--no-eval` reason skips any render (an empty reason, or one that is another flag, is refused); `--eval` evaluates any
 * render; a non-final render skips; a final encode on an install without the eval runner (`runnerInstalled: false`, a
 * public install, where VideoEssay does not ship) skips with source "not-installed" and still renders; otherwise a final
 * encode uses the project's recorded intent; with none, it is refused, naming both ways out. An explicit `--eval` is
 * never skipped: evalIntentProblem() refuses it when the runner is missing. Pure: the caller passes whether the runner exists.
 */
export function decideEval(o: { format: string; quality: string; project: string; evalIntent?: string; noEval?: string; recorded?: string | null; runnerInstalled?: boolean }): EvalDecision {
  if (o.evalIntent !== undefined && o.noEval !== undefined) return { action: "refuse", message: "pass --eval <intent.md> or --no-eval \"<reason>\", not both" };
  if (o.noEval !== undefined) {
    const reason = o.noEval.trim();
    if (!reason || reason.startsWith("--")) return { action: "refuse", message: "--no-eval needs its reason: --no-eval \"<why this render is not evaluated>\"" };
    return { action: "skip", reason, source: "--no-eval" };
  }
  if (o.evalIntent !== undefined) return { action: "eval", intent: o.evalIntent, source: "--eval" };
  const notFinal = notFinalReason(o.format, o.quality);
  if (notFinal) return { action: "skip", reason: notFinal, source: "not-final" };
  if (o.runnerInstalled === false) return { action: "skip", reason: `the eval runner is not installed at ${EVAL_RUNNER} (VideoEssay is not in this install), so this final encode renders without the video eval set`, source: "not-installed" };
  if (o.recorded) return { action: "eval", intent: o.recorded, source: "project" };
  return {
    action: "refuse",
    message: `a final mp4 encode runs the Assay video eval set, and this one names no intent: pass --eval <intent.md>, record the intent in ${join(o.project, INTENT_RECORD)} as {"intent": "<path>"}, or skip with --no-eval "<reason>" (a draft-quality render is not a final encode)`,
  };
}

/** The only intents a HyperFrames render is evaluated under: this install's skills/HyperFrames/Intents/*.md (symlinks resolved). */
export const HYPERFRAMES_INTENTS_DIR = resolve(import.meta.dir, "../../../skills/HyperFrames/Intents");

/** True when `intent` is a real file directly inside skills/HyperFrames/Intents/. A copy elsewhere, or a link out of it, is not. */
export function isHyperFramesIntent(intent: string): boolean {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const file = real(intent), dir = real(HYPERFRAMES_INTENTS_DIR);
  return file.endsWith(".md") && dirname(file) === dir;
}

/**
 * Null when `intent` can drive the eval set on a HyperFrames render (it exists, its `## Evals` names `video-eval`, every
 * switch-off has a reason, and it is one of skills/HyperFrames/Intents/*), else the problem. A camera intent such as
 * the video pipeline skill's ExportReliably switches off the motion checks a HyperFrames film is held to, so it is refused here (exit 2).
 */
export async function evalIntentProblem(intent: string): Promise<string | null> {
  if (!existsSync(intent) || !intent.endsWith(".md")) return `no intent .md file at ${intent}`;
  const runner = evalCommand("x.mp4", intent)[1]!;
  if (!existsSync(runner)) return `the eval runner is not installed at ${runner}; skip with --no-eval "<reason>"`;
  const lib = resolve(import.meta.dir, "../../../skills/Assay/Tools/VideoEval.ts");
  if (!existsSync(lib)) return `the video eval set is not installed at ${lib}; skip with --no-eval "<reason>"`;
  const { intentNamesEvalSet, intentEvalDisables } = (await import(lib)) as { intentNamesEvalSet: (t: string) => boolean; intentEvalDisables: (t: string) => unknown[] };
  const text = readFileSync(intent, "utf8");
  if (!intentNamesEvalSet(text)) return `${intent}: its ## Evals section does not name the video eval set (video-eval)`;
  try { intentEvalDisables(text); } catch (e) { return `${intent}: ${(e as Error).message}`; }
  if (!isHyperFramesIntent(intent)) return `${intent}: a HyperFrames render is evaluated only under an intent in ${HYPERFRAMES_INTENTS_DIR} (CapabilityVideo, ContentToAnimation, GeneratedContentVideo, LaunchVideo, SystemFilm); another pipeline's intent switches off checks this film is held to`;
  return null;
}

export { embedFonts, facesFromFamilies, facesFromRoles, injectFonts, registerAfterFonts, FontEmbedError } from "./fonts";
export { stageGsap, ensureInstalled } from "./run";
export { preflight } from "./preflight";
export { gpuCanary, resolveGpu, type GpuDecision, type GpuRequest } from "./gpu";
export { HYPERFRAMES_VERSION, GSAP_VERSION } from "./constants";

export type Quality = "draft" | "standard" | "looks" | "high" | "delivery";
export type Stage = "input" | "check" | "probe" | "render" | "strip" | "validate" | "snapshot";

export class HyperFramesError extends Error {
  constructor(public readonly stage: Stage, message: string, public readonly findings: Finding[] = [], public readonly logTail = "") {
    super(`[hyperframes:${stage}] ${message}${findings.length ? "\n" + findings.map(fmtFinding).join("\n") : ""}`);
    this.name = "HyperFramesError";
  }
}

export function fmtFinding(f: Finding): string {
  return `  ${f.severity === "error" ? "✗" : "⚠"} [${f.source}:${f.code}] ${f.message}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`;
}

/** Root composition attributes, read from the entry HTML. */
export interface RootMeta { id: string; width: number; height: number; durationSec: number | null; fps: number | null }

export function readRoot(projectDir: string, entry = "index.html"): RootMeta {
  const path = join(projectDir, entry);
  if (!existsSync(path)) throw new HyperFramesError("input", `no ${entry} in ${projectDir}`);
  const html = readFileSync(path, "utf8");
  const tag = /<[a-z][^>]*\bdata-composition-id\s*=\s*["']([^"']+)["'][^>]*>/i.exec(html);
  if (!tag) throw new HyperFramesError("input", `${entry} has no element with data-composition-id`);
  const attr = (name: string): number | null => {
    const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag[0]);
    const n = m ? Number(m[1]) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  };
  const width = attr("data-width"), height = attr("data-height");
  if (!width || !height) throw new HyperFramesError("input", `root composition "${tag[1]}" must declare data-width and data-height`);
  return { id: tag[1]!, width, height, durationSec: attr("data-duration"), fps: attr("data-fps") };
}

/** HyperFrames --json output is untyped CLI JSON (`any` on purpose); callers coerce each field they read. */
function parseJsonOutput(stdout: string, what: string): any {
  const start = stdout.indexOf("{");
  if (start < 0) throw new HyperFramesError("check", `${what} printed no JSON: ${stdout.slice(-300)}`);
  try { return JSON.parse(stdout.slice(start)); } catch (e) { throw new HyperFramesError("check", `${what} printed unparseable JSON: ${(e as Error).message}`); }
}

/** gpu: HyperFrames check drives its own Chrome, so it runs in the canary-chosen mode too (README § GPU). */
export interface CheckOptions { projectDir: string; contrast?: boolean; timeoutMs?: number; gpu?: GpuRequest }
export interface CheckResult { ok: boolean; findings: Finding[] }

/** HyperFrames warnings that mean the video will be wrong, promoted to errors. */
const PROMOTED = [/GSAP target .* not found/i, /Failed to load resource/i, /net::ERR_/i];

/** Our static preflight, then HyperFrames `lint`, then its browser `check`. Fails on any error. */
export async function check(opts: CheckOptions): Promise<CheckResult> {
  const projectDir = resolve(opts.projectDir);
  const findings = preflight(projectDir);
  if (findings.some((f) => f.severity === "error")) return { ok: false, findings };
  const gpuWant = gpuRequest(opts.gpu, undefined);
  const inst = await ensureInstalled();
  const lint = await runHyperFrames(["lint", projectDir, "--json"], { timeoutMs: opts.timeoutMs ?? 120_000 });
  const lintJson = parseJsonOutput(lint.stdout, "hyperframes lint");
  for (const f of (lintJson.findings ?? []) as any[]) findings.push({ source: "lint", severity: f.severity === "error" ? "error" : "warning", code: String(f.code), message: String(f.message), file: f.file, line: f.line });
  if (Number(lintJson.errorCount ?? 0) > 0 || lint.code !== 0) return { ok: false, findings };
  const args = ["check", projectDir, "--json"];
  if (opts.contrast === false) args.push("--no-contrast");
  const gpu = await decideGpu(inst.browserPath, gpuWant);
  const chk = await runHyperFrames(args, { timeoutMs: opts.timeoutMs ?? 300_000, extraEnv: { PRODUCER_BROWSER_GPU_MODE: gpu.mode } });
  const chkJson = parseJsonOutput(chk.stdout, "hyperframes check");
  let promoted = false;
  for (const section of ["runtime", "layout", "motion", "contrast"]) {
    for (const f of (chkJson[section]?.findings ?? []) as any[]) {
      const msg = String(f.message);
      const isPromoted = f.severity !== "error" && PROMOTED.some((re) => re.test(msg));
      promoted ||= isPromoted;
      if (f.severity === "info") continue;
      findings.push({ source: "check", severity: f.severity === "error" || isPromoted ? "error" : "warning", code: `${section}:${f.code}`, message: msg, file: f.sourceFile });
    }
  }
  const ok = chk.code === 0 && chkJson.ok === true && !promoted && !findings.some((f) => f.severity === "error");
  return { ok, findings };
}

export interface RenderOptions {
  projectDir: string;
  out: string;
  fps?: number;
  /** Chrome workers. Default 1: on macOS one worker streams frames into the encoder; more spool raw frames to disk (README § Workers). */
  workers?: number;
  quality?: Quality;
  /**
   * x264 constant rate factor (0–51, lower is sharper), passed as --crf over the quality preset's own (high = 15).
   * Text on flat paper wants a low one: the preset's deblock=1,1 smooths letter edges, and a low QP leaves it little to do.
   */
  crf?: number;
  /**
   * Output pixels per composition pixel: 2 renders a 1920x1080 (or 1080x1920) root at 4K through the CLI's --resolution
   * preset, so text and images keep full detail and YouTube serves its high-bitrate 4K encodes (principal directive, 2026-10-24: a
   * 1080p upload came out "massively blurry"). Default 1.
   */
  scale?: 1 | 2;
  format?: OutputFormat;
  variables?: Record<string, unknown>;
  /** Default true. A render whose sampled frames do not differ fails. Set false only for a deliberately still video. */
  expectMotion?: boolean;
  /** Default false. When true the output must carry a non-silent audio stream. */
  expectAudio?: boolean;
  /** Required when the root has no data-duration. */
  durationSec?: number;
  /** Skip check() when the caller just ran it on the same files. The probe and validation always run. */
  skipCheck?: boolean;
  contrast?: boolean;
  timeoutMs?: number;
  logPath?: string;
  motionSamples?: number;
  /**
   * HyperFrames/producer switches for the render process only (HF_* and PRODUCER_* keys; buildEnv refuses
   * anything else). Screenshot capture is on by default; `{ PRODUCER_FORCE_SCREENSHOT: "false" }` opts out (README § Capture modes).
   */
  extraEnv?: Record<string, string>;
  /** Default "auto": hardware when the GPU canary passes, SwiftShader when it does not (README § GPU). "hardware" fails on a failed canary. */
  gpu?: GpuRequest;
  /** The intent this encode is made for, recorded on its render row; absent: the project's intent.json, if any. */
  intent?: string;
}

/**
 * The seam's render row for a validated output: pipeline HyperFrames, the intent (the caller's, else the project's
 * intent.json), the project dir and the digest of its composition files. Written the moment the output passed
 * validation, so VideoEval and the gates can tie these exact bytes to this pipeline and this composition. A caller that
 * post-processes the file (VideoEssay's audio re-mux) or owns the film (StoryFilm) writes its own row for its final bytes.
 * Never throws: a row that cannot be written is logged, and the render still succeeds.
 */
export function recordSeamRender(out: string, projectDir: string, intent?: string): RecordRenderResult {
  let use = intent;
  if (!use) { const rec = recordedIntent(projectDir); if (rec && "intent" in rec) use = rec.intent; }
  return recordRenderOf(out, { pipeline: "HyperFrames", intent: use ?? null, composition: projectDir });
}

/** The CLI's 4K --resolution preset for a root of these dimensions; any other root cannot be rendered at scale 2. */
export function resolutionPreset(width: number, height: number): "landscape-4k" | "portrait-4k" {
  if (width === 1920 && height === 1080) return "landscape-4k";
  if (width === 1080 && height === 1920) return "portrait-4k";
  throw new HyperFramesError("input", `scale 2 needs a 1920x1080 or 1080x1920 root, got ${width}x${height}`);
}

export interface RenderResult { out: string; ms: number; check: CheckResult | null; probe: ProbeResult; gpu: GpuDecision; validation: Validation; motion: MotionResult | null; log: string }

function gpuLabel(gpu: GpuDecision): string {
  return `${gpu.mode} (requested ${gpu.requested}${gpu.canary ? `; canary ${gpu.canary.ok ? "passed" : "failed"}: ${gpu.canary.detail}` : ""})`;
}

/**
 * Choose the GPU mode through the canary. The mode reaches HyperFrames as PRODUCER_BROWSER_GPU_MODE,
 * so a caller may not set that key itself: the seam would lose the canary's answer.
 */
function gpuRequest(requested: GpuRequest | undefined, extraEnv: Record<string, string> | undefined): GpuRequest {
  const want = requested ?? "auto";
  if (!GPU_REQUESTS.includes(want)) throw new HyperFramesError("input", `gpu must be one of ${GPU_REQUESTS.join(", ")}, got "${want}"`);
  if (extraEnv && "PRODUCER_BROWSER_GPU_MODE" in extraEnv) throw new HyperFramesError("input", "set the GPU mode with the gpu option (auto, hardware, software), not PRODUCER_BROWSER_GPU_MODE in extraEnv");
  return want;
}

const warned = new WeakSet<GpuDecision>();

async function decideGpu(browserPath: string, want: GpuRequest): Promise<GpuDecision> {
  const gpu = await resolveGpu(browserPath, want);
  if (gpu.requested === "hardware" && !gpu.canary?.ok) {
    throw new HyperFramesError("probe", "hardware GPU was requested but the GPU canary failed", [{ source: "probe", severity: "error", code: "gpu-canary", message: gpuLabel(gpu) }]);
  }
  if (gpu.requested === "auto" && gpu.mode === "software" && !warned.has(gpu)) {
    warned.add(gpu);
    console.error(`[hyperframes:gpu] hardware compositing failed the canary; using SwiftShader. ${gpuLabel(gpu)}`);
  }
  return gpu;
}

const QUALITIES: readonly Quality[] = ["draft", "standard", "looks", "high", "delivery"];

/**
 * Default worker count from the composition's length. Under 20 s one worker wins (2026-09-24 bench: two were slower,
 * four only ~15% faster on 10 s); longer renders split across a third of the cores, capped at 8, and stream captures
 * (HF_CAPTURE_PARALLEL_STREAM, the fastest multi-worker row in the README table).
 */
export function autoWorkers(durationSec: number, cores = availableParallelism()): number {
  if (!(durationSec >= 20)) return 1;
  return Math.max(2, Math.min(8, Math.floor(cores / 3)));
}

/**
 * Render a composition to a validated, provenance-free file. Throws HyperFramesError at the
 * first failed stage. A rejected output is moved to `<name>.rejected.<ext>` so no caller ships it.
 */
export async function render(opts: RenderOptions): Promise<RenderResult> {
  const started = performance.now();
  const projectDir = resolve(opts.projectDir);
  const out = resolve(opts.out);
  const format: OutputFormat = opts.format ?? (extname(out).slice(1).toLowerCase() as OutputFormat);
  if (!(format in CODEC_FOR)) throw new HyperFramesError("input", `unsupported format "${format}" (mp4, webm, mov)`);
  if (extname(out).slice(1).toLowerCase() !== format) throw new HyperFramesError("input", `output ${out} does not end in .${format}`);
  const root = readRoot(projectDir);
  const fps = opts.fps ?? root.fps ?? 30;
  if (!Number.isInteger(fps) || fps < 1 || fps > 240) throw new HyperFramesError("input", `fps must be an integer 1..240, got ${fps}`);
  const durationHint = readRoot(projectDir).durationSec ?? opts.durationSec ?? 0;
  // Every video system renders through here, so long renders run in parallel by default: frame ranges are captured
  // across workers and stitched into one encode (principal directive, 2026-10-16).
  const workers = opts.workers ?? autoWorkers(durationHint);
  if (!Number.isInteger(workers) || workers < 1 || workers > 24) throw new HyperFramesError("input", `workers must be 1..24, got ${workers}`);
  const quality = opts.quality ?? "standard";
  if (!QUALITIES.includes(quality)) throw new HyperFramesError("input", `quality must be one of ${QUALITIES.join(", ")}`);
  if (opts.crf !== undefined && !(Number.isInteger(opts.crf) && opts.crf >= 0 && opts.crf <= 51)) throw new HyperFramesError("input", `crf must be an integer 0..51, got ${opts.crf}`);
  if (opts.crf !== undefined && format === "mov") throw new HyperFramesError("input", "crf does not apply to mov output");
  const durationSec = root.durationSec ?? opts.durationSec;
  if (!(durationSec && durationSec > 0)) throw new HyperFramesError("input", "the root has no data-duration and no durationSec was given; the output cannot be validated");
  const expectMotion = opts.expectMotion ?? true;
  const gpuWant = gpuRequest(opts.gpu, opts.extraEnv);

  const checked = opts.skipCheck ? null : await check({ projectDir, contrast: opts.contrast, gpu: gpuWant });
  if (checked && !checked.ok) throw new HyperFramesError("check", "composition failed check", checked.findings.filter((f) => f.severity === "error"));

  const inst = await ensureInstalled();
  const probe = await probeTimelines({ projectDir, browserPath: inst.browserPath, variables: opts.variables, expectMotion, width: root.width, height: root.height });
  if (!probe.ok) throw new HyperFramesError("probe", "timeline probe failed", probe.findings);
  const gpu = await decideGpu(inst.browserPath, gpuWant);

  mkdirSync(dirname(out), { recursive: true });
  const raw = join(dirname(out), `.${basename(out, extname(out))}.hf-raw.${format}`);
  const work = mkdtempSync(join(tmpdir(), "lifeos-hf-render-"));
  const scale = opts.scale ?? 1;
  const preset = scale === 2 ? resolutionPreset(root.width, root.height) : undefined;
  const args = ["render", projectDir, "--output", raw, "--format", format, "--fps", String(fps), "--workers", String(workers), "--quality", quality, ...(opts.crf !== undefined ? ["--crf", String(opts.crf)] : []), ...(preset ? ["--resolution", preset] : []), "--no-best-effort", "--strict"];
  if (opts.variables) {
    const varsFile = join(work, "variables.json");
    writeFileSync(varsFile, JSON.stringify(opts.variables));
    args.push("--variables-file", varsFile, "--strict-variables");
  }
  const timeoutMs = opts.timeoutMs ?? 120_000 + durationSec * 3_000;
  let log = "";
  try {
    // Screenshot capture is the default: draw-element capture shipped stale frames under load with exit 0
    // (2026-09-24: most of a batch of simultaneous renders on a loaded machine). A caller may opt back in with PRODUCER_FORCE_SCREENSHOT=false.
    const res = await runHyperFrames(args, { timeoutMs, extraEnv: { PRODUCER_FORCE_SCREENSHOT: "true", PRODUCER_BROWSER_GPU_MODE: gpu.mode, ...(workers > 1 ? { HF_CAPTURE_PARALLEL_STREAM: "true" } : {}), ...opts.extraEnv } });
    log = `# gpu: ${gpuLabel(gpu)}\n$ hyperframes ${args.join(" ")}\n${res.stdout}\n${res.stderr}`;
    if (opts.logPath) writeFileSync(opts.logPath, log);
    if (res.code !== 0 || !existsSync(raw)) {
      throw new HyperFramesError("render", res.timedOut ? `render timed out after ${timeoutMs} ms` : `hyperframes render exited ${res.code}`, [], tailOf(log));
    }
    await stripProvenance(raw, out, format);
  } finally {
    rmSync(raw, { force: true });
    rmSync(work, { recursive: true, force: true });
  }

  const reject = (stage: Stage, message: string, findings: Finding[]): never => {
    const rejected = join(dirname(out), `${basename(out, extname(out))}.rejected.${format}`);
    renameSync(out, rejected);
    throw new HyperFramesError(stage, `${message}; output moved to ${rejected}`, findings, tailOf(log));
  };
  const validation = await validateOutput(out, { format, width: root.width * scale, height: root.height * scale, fps, durationSec, audio: opts.expectAudio ?? false });
  if (!validation.ok) reject("validate", "output failed validation", validation.findings);
  const sample = await sampleFrames(out, durationSec, fps, opts.motionSamples ?? 12);
  const blank = blankOf(sample);
  if (!blank.ok) {
    reject("validate", "every sampled frame is one flat colour", [{ source: "validate", severity: "error", code: "blank-frames", message: `${blank.flat} of ${blank.total} frames at ${sample.times.join(", ")} s are flat (mean gray ${blank.meanLevels.join(", ")}); gpu ${gpuLabel(gpu)}. A compositor that draws nothing gives this (README § GPU)` }]);
  }
  let motion: MotionResult | null = null;
  if (expectMotion) {
    motion = motionOf(sample);
    if (!motion.ok) {
      reject("validate", "motion was expected but the rendered frames do not change", [{ source: "validate", severity: "error", code: "no-motion", message: `max changed-pixel fraction ${motion.maxChanged} across ${motion.times.length} frames at ${motion.times.join(", ")} s (needs ≥ 0.001)` }]);
    }
  }
  recordSeamRender(out, projectDir, opts.intent);
  return { out, ms: Math.round(performance.now() - started), check: checked, probe, gpu, validation, motion, log };
}

function tailOf(log: string, lines = 25): string {
  return log.split("\n").filter((l) => !l.includes("[Render:trace]") && !/Streaming frame|Capturing frame/.test(l)).slice(-lines).join("\n");
}

const FRAME_NAME = /^frame-\d+-at-.*\.png$/;

/** Modification time of every snapshot frame already in `dir`, so a repeat run can tell rewritten frames from stale ones. */
export function frameStamps(dir: string): Map<string, number> {
  return new Map(readdirSync(dir).filter((n) => FRAME_NAME.test(n)).map((n) => [n, statSync(join(dir, n)).mtimeMs]));
}

/** Frames the renderer wrote since `before`: new names, and existing names it overwrote (a repeat into the same directory). */
export function writtenFrames(dir: string, before: Map<string, number>): string[] {
  return readdirSync(dir)
    .filter((n) => FRAME_NAME.test(n) && (!before.has(n) || statSync(join(dir, n)).mtimeMs > before.get(n)!))
    .sort()
    .map((n) => join(dir, n));
}

export interface SnapshotOptions { projectDir: string; times: number[]; outDir: string; variables?: Record<string, unknown>; timeoutMs?: number; gpu?: GpuRequest }
export interface SnapshotResult { files: string[]; probe: ProbeResult; gpu: GpuDecision }

/**
 * Stills at exact times (thumbnails, review frames). Probe first; every PNG is checked for the
 * composition's size, and the set is refused when a still is fully transparent or every still is
 * one flat colour (renamed to `rejected-<name>.png`, so no caller picks them up).
 */
export async function snapshot(opts: SnapshotOptions): Promise<SnapshotResult> {
  const projectDir = resolve(opts.projectDir);
  const outDir = resolve(opts.outDir);
  const root = readRoot(projectDir);
  if (opts.times.length === 0) throw new HyperFramesError("input", "snapshot needs at least one time");
  for (const t of opts.times) {
    if (!Number.isFinite(t) || t < 0 || (root.durationSec !== null && t > root.durationSec)) throw new HyperFramesError("input", `snapshot time ${t} is outside 0..${root.durationSec ?? "?"} s`);
  }
  const gpuWant = gpuRequest(opts.gpu, undefined);
  const findings = preflight(projectDir).filter((f) => f.severity === "error");
  if (findings.length) throw new HyperFramesError("check", "composition failed preflight", findings);
  const inst = await ensureInstalled();
  const probe = await probeTimelines({ projectDir, browserPath: inst.browserPath, variables: opts.variables, expectMotion: false, width: root.width, height: root.height });
  if (!probe.ok) throw new HyperFramesError("probe", "timeline probe failed", probe.findings);
  const gpu = await decideGpu(inst.browserPath, gpuWant);
  mkdirSync(outDir, { recursive: true });
  const before = frameStamps(outDir);
  // runHyperFrames appends --describe false to every snapshot; callers can never pass --describe.
  const res = await runHyperFrames(["snapshot", projectDir, "--at", opts.times.join(","), "--output", outDir, "--no-end"], { timeoutMs: opts.timeoutMs ?? 180_000, extraEnv: { PRODUCER_BROWSER_GPU_MODE: gpu.mode } });
  if (res.code !== 0) throw new HyperFramesError("snapshot", `hyperframes snapshot exited ${res.code}`, [], tailOf(`${res.stdout}\n${res.stderr}`));
  const files = writtenFrames(outDir, before);
  if (files.length !== opts.times.length) throw new HyperFramesError("snapshot", `expected ${opts.times.length} new PNGs in ${outDir}, found ${files.length}`);
  for (const file of files) {
    const info = await ffprobe(file);
    const s = info.streams[0];
    if (!s || s.width !== root.width || s.height !== root.height) throw new HyperFramesError("snapshot", `${basename(file)} is ${s?.width}x${s?.height}, expected ${root.width}x${root.height}`);
    if (statSync(file).size === 0) throw new HyperFramesError("snapshot", `${basename(file)} is empty`);
  }
  const stills = await Promise.all(files.map(stillStats));
  const blank: Finding[] = [];
  files.forEach((file, i) => {
    if (stills[i]!.alphaMax === 0) blank.push({ source: "validate", severity: "error", code: "transparent-frame", message: `${basename(file)} is fully transparent: the compositor drew nothing` });
  });
  if (blank.length === 0 && stills.every((s) => variedFraction(s.gray) < FLAT_MAX_VARIED)) {
    blank.push({ source: "validate", severity: "error", code: "blank-frames", message: `every still is one flat colour (mean gray ${stills.map((s) => meanLevel(s.gray)).join(", ")})` });
  }
  if (blank.length) {
    for (const file of files) renameSync(file, join(dirname(file), `rejected-${basename(file)}`));
    throw new HyperFramesError("snapshot", `stills refused; gpu ${gpuLabel(gpu)} (README § GPU)`, blank, tailOf(`${res.stdout}\n${res.stderr}`));
  }
  return { files, probe, gpu };
}

// ─────────────────────────────────────────────────────────────── CLI

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const need = (name: string): string => {
    const v = flag(rest, name);
    if (!v) throw new UsageError(`--${name} is required`);
    return v;
  };
  const num = (name: string): number | undefined => {
    const v = flag(rest, name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number`);
    return n;
  };
  switch (cmd) {
    case "render": {
      const varsPath = flag(rest, "variables");
      const project = need("project"), out = need("out"), logPath = flag(rest, "log");
      // The eval decision comes first, so a final encode that names no intent is refused before minutes of rendering.
      const valueOf = (name: string): string | undefined => {
        if (!rest.includes(`--${name}`)) return undefined;
        const v = flag(rest, name);
        return v === undefined || (name === "eval" && v.startsWith("--")) ? "" : v;
      };
      const evalArg = valueOf("eval");
      if (evalArg === "") throw new UsageError("--eval needs the intent: --eval <intent.md>");
      const recorded = recordedIntent(project);
      if (recorded && "error" in recorded) throw new UsageError(recorded.error);
      const decision = decideEval({
        format: extname(out).slice(1).toLowerCase(), quality: flag(rest, "quality") ?? "standard", project,
        evalIntent: evalArg !== undefined ? resolveIntentPath(evalArg, [process.cwd(), getClaudeDir()]) : undefined,
        noEval: valueOf("no-eval"), recorded: recorded?.intent, runnerInstalled: evalRunnerInstalled(),
      });
      if (decision.action === "refuse") throw new UsageError(decision.message);
      if (decision.action === "eval") {
        const problem = await evalIntentProblem(decision.intent);
        if (problem) throw new UsageError(problem);
      }
      const evalLine = decision.action === "eval" ? `[hyperframes:eval] the video eval set runs on the encode, per ${decision.intent} (${decision.source})` : `[hyperframes:eval] not run (${decision.source}): ${decision.reason}`;
      console.error(evalLine);
      const res = await render({
        projectDir: project, out, fps: num("fps"), workers: num("workers"), quality: flag(rest, "quality") as Quality | undefined,
        variables: varsPath ? JSON.parse(readFileSync(varsPath, "utf8")) : undefined, expectMotion: !rest.includes("--still"), expectAudio: rest.includes("--audio"),
        durationSec: num("duration"), skipCheck: rest.includes("--skip-check"), contrast: !rest.includes("--no-contrast"), logPath,
        gpu: flag(rest, "gpu") as GpuRequest | undefined, ...(decision.action === "eval" ? { intent: decision.intent } : {}),
      });
      const ev = decision.action === "eval" ? { ...(await evalRender(res.out, decision.intent, project)), intent: decision.intent, source: decision.source } : undefined;
      if (logPath) appendFileSync(logPath, `\n${evalLine}\n${ev ? `[hyperframes:eval] exit ${ev.exit} in ${ev.ms} ms; report ${ev.report}\n` : ""}`);
      const evalOut = ev ?? (decision.action === "skip" ? { skipped: decision.reason, source: decision.source } : undefined);
      console.log(JSON.stringify({ ok: !ev || ev.exit === 0, out: res.out, ms: res.ms, gpu: res.gpu.mode, video: res.validation.info, motion: res.motion && { maxChanged: res.motion.maxChanged }, eval: evalOut }));
      return !ev || ev.exit === 0 ? 0 : 1;
    }
    case "snapshot": {
      const times = need("at").split(",").map(Number);
      const res = await snapshot({ projectDir: need("project"), times, outDir: need("out-dir"), gpu: flag(rest, "gpu") as GpuRequest | undefined });
      const proof = rest.includes("--no-proof") ? { skipped: "--no-proof" } : await proofStills(resolve(need("project")), times, res.files[0]);
      console.log(JSON.stringify({ ok: true, gpu: res.gpu.mode, files: res.files, proof }));
      return 0;
    }
    case "check": {
      const res = await check({ projectDir: need("project"), contrast: !rest.includes("--no-contrast"), gpu: flag(rest, "gpu") as GpuRequest | undefined });
      for (const f of res.findings) console.error(fmtFinding(f));
      console.log(JSON.stringify({ ok: res.ok, errors: res.findings.filter((f) => f.severity === "error").length, warnings: res.findings.filter((f) => f.severity === "warning").length }));
      return res.ok ? 0 : 1;
    }
    case "bands": {
      const fps = num("fps");
      if (!fps) throw new UsageError("--fps is required");
      const res = await audioBands({ wav: need("wav"), fps, out: need("out"), bands: num("bands"), spectrumSamples: num("spectrum") });
      console.log(JSON.stringify({ ok: true, frames: res.frameCount, bands: res.bands.count, spectrum: res.spectrum?.samples ?? 0 }));
      return 0;
    }
    case "stage-gsap":
      console.log(await stageGsap(resolve(need("project"))));
      return 0;
    case "install": {
      const inst = await ensureInstalled();
      console.log(JSON.stringify({ ok: true, version: inst.version, browser: inst.browserPath, pinned: HYPERFRAMES_VERSION }));
      return 0;
    }
    default:
      throw new UsageError(`unknown command "${cmd ?? ""}" (render, snapshot, check, bands, stage-gsap, install)`);
  }
}

class UsageError extends Error {}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    if (err instanceof HyperFramesError && err.logTail) console.error(`--- render log tail ---\n${err.logTail}`);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
}
