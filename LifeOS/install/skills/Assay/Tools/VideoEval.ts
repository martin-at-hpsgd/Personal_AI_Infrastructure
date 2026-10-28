#!/usr/bin/env bun
/**
 * VideoEval — Assay's eval set for a DA-narrated or HyperFrames-rendered video: one command, cheapest tier first, one
 * assay receipt bound to the video's sha256.
 *
 *   bun skills/Assay/Tools/VideoEval.ts run --run <slug|dir> [--check id,id] [--judges auto|always|never] [--intent <file>] [--json]
 *   bun skills/Assay/Tools/VideoEval.ts run --video <file.mp4> [--intent <file>] [--narration <file.txt>] [--composition <hyperframes project>] [same flags]
 *   (--fresh: no memo and no stored result of any kind; every check re-measures the bytes)
 *   bun skills/Assay/Tools/VideoEval.ts list
 *
 * The set covers what the principal named on 2026-10-24 (watermark, voice, script, typography, animation quantity,
 * animation quality) plus format, encode, duration and PII. Every check has an id, a tier and an anchored bar (`list`).
 * Code checks run first, all at once; judged checks (VisionJudge's OpenAI + Anthropic panel, the video/audio judge,
 * Proof's judgment layer) run in parallel only after every code check passes (`--judges always` runs them anyway, for
 * a report). Each check's finding is memoized by the bytes it reads (the video or audio stream, the script, the
 * timeline, the logo, the built composition, its own code, and for judges the transport code and the panel's model
 * ids), so a re-run after changing one component re-measures only what that component touches, and a no-op re-run
 * calls no model. A judge's memo holds its raw answer; whether a "no" blocks is decided on every read (LabelStore), so a
 * question that earns its right to block blocks on a memo hit too.
 *
 * The intent decides the set. Its `## Evals` section names `video-eval` and may switch checks off, each with a reason
 * (`  - disabled: <id>, <id> — <reason>`); every switch-off is written to the receipt's opt_outs, and the receipt's
 * check_set.version is the sha over the FULL set, so a reduced run never reads as the full one. A video inside a
 * VideoEssay run is held to that run's own intent: naming another is refused (exit 2). `--judges never` records every
 * judged check as unavailable (with a judges-off opt-out), so the verdict can never read pass.
 *
 * A bare video (no run dir) still gets the visual judges, from frames sampled evenly across it, and script-intent, on
 * `--narration <file>` or the video's own whisper transcript. A full run writes the receipt through
 * ProofReceipt.writeReceipt and a report beside the run (Out/eval/video-eval.json); a `--check` run measures and
 * memoizes but writes no receipt, since a subset must never read as the whole set's verdict.
 *
 * Origin is read from the pixels, never a path: bytes wearing the DA essay badge (badgeOrigin) are evaluated only under
 * VideoEssay Full or Explainer, and every other intent is refused before anything is measured (IntentOriginMismatch). An
 * intent may switch off a protected check only when its pipeline's allowlist names it (switchOffProblems,
 * SwitchOffRefused). The receipt carries the origin it measured; gates re-measure it rather than trust it.
 *
 * Provenance is read from the record, never guessed (LIFEOS/TOOLS/lib/RenderProvenance.ts): an intent is admitted only
 * for bytes whose newest STATVS render row names that intent's pipeline (skills/<Pipeline>/Intents/*), and bytes with no
 * row (a remux, a crop, a covered badge, a re-encode) are refused under every intent, naming the producing tool to re-run
 * (ProvenanceRefused). The badge stays a second, independent signal. --composition is accepted only when the render row
 * for these bytes names that project and its digest still matches.
 *
 * Earned status is keyed by check id ({check_id}), the key the label join writes, and the receipt's profile lists every
 * check that made its own call as a bare id, so the join sees passes as well as failures.
 *
 * Exit: 0 no blocking finding, 1 a code fail (or an earned no), 2 something could not be measured, the intent is not
 * the run's own, the bytes' origin forbids the intent, or a switch-off is not allowed; 64 usage. Help: VideoEval.help.md.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { assayUserDir, getClaudeDir, getLifeosDir } from "../../../LIFEOS/TOOLS/Paths.ts";
import { loadLifeosConfig } from "../../../LIFEOS/TOOLS/LifeosConfig.ts";
import { CROSS_VENDOR } from "../../../LIFEOS/TOOLS/models.ts";
import { ASSAY_RECEIPT_SCHEMA, deriveVerdict, sha256File, writeReceipt, type AssayReceipt, type DestinationClass, type IdealStateRef, type ProofFinding, type ProofOptOut, type ProofTier } from "../../../LIFEOS/TOOLS/lib/ProofReceipt.ts";
import { earnedStatus } from "../../../LIFEOS/TOOLS/lib/LabelStore.ts";
import { compositionDigest, compositionFiles, compositionProblem, provenanceProblem } from "../../../LIFEOS/TOOLS/lib/RenderProvenance.ts";
import { resolveVisionJudge } from "../../../LIFEOS/TOOLS/lib/VisionJudgeConfig.ts";
import { Cdp, devtoolsUrl } from "../../../LIFEOS/TOOLS/HyperFrames/probe.ts";
import { ensureInstalled, sandboxed } from "../../../LIFEOS/TOOLS/HyperFrames/run.ts";
import { judgeVideo } from "../../../LIFEOS/ASSAY/VideoJudge.ts";
import { judgeImageRubric } from "./VisionJudge.ts";
import { anthropicJudgeModel } from "./AnthropicVision.ts";
import { beatFrameTime, encodeVerdict, loudnessCheck, verify, x264Settings } from "../../VideoEssay/Tools/Verify.ts";
import { FPS, HEIGHT, OUTPUT_SCALE, VOICE_TRUE_PEAK, WIDTH, configuredFaces, houseTypeProblems, houseTypeRolesPath, loadScript, loadTimeline, resolveRunDir, runPaths, type Script, type Timeline } from "../../VideoEssay/Tools/Lib.ts";
import { runMode, type RunMode } from "../../VideoEssay/Tools/Build.ts";
import { avatarPath, cornerLogoPath } from "../../VideoEssay/Tools/Setup.ts";
import { applyPronunciations, chunkHash, daVoice, loadPronunciations, type VoiceSettings } from "../../VideoEssay/Tools/Narrate.ts";
import * as M from "./VideoEvalChecks.ts";

export const VIDEO_EVAL_VERSION = "1.1.0";
export const MEMO_SCHEMA = "video-eval-memo/2";
const HERE = import.meta.dir;
const CODE = {
  checks: join(HERE, "VideoEvalChecks.ts"), runner: join(HERE, "VideoEval.ts"), verify: join(HERE, "../../VideoEssay/Tools/Verify.ts"),
  narrate: join(HERE, "../../VideoEssay/Tools/Narrate.ts"), theme: join(HERE, "../../VideoEssay/Tools/Theme.ts"), probe: join(HERE, "../../../LIFEOS/TOOLS/HyperFrames/probe.ts"),
};
/** The judge transports: the vision panel, the shared vendor calls under it, and the video/audio judge. Part of every judged check's version. */
export const JUDGE_CODE = [join(HERE, "VisionJudge.ts"), join(HERE, "../../../LIFEOS/ASSAY/JudgeCall.ts"), join(HERE, "../../../LIFEOS/ASSAY/VideoJudge.ts")];
const CAPTURE_TYPES = ["screenshot", "scroll", "zoom"];

// ---------- the intent's declaration (its `## Evals` section) ----------

/** The eval set every video intent names under `## Evals`: this file. */
export const VIDEO_EVAL_SET = "video-eval";
export interface EvalDisable { id: string; reason: string }

/** The body of an intent's `## Evals` section ("" when it has none). Headings inside fences are ignored. Pure. */
export function evalsSection(text: string): string {
  const out: string[] = [];
  let inside = false, fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^## \S/.test(line)) { if (inside) break; inside = /^## Evals\s*$/i.test(line); continue; }
    if (inside) out.push(line);
  }
  return out.join("\n");
}

/** True when the intent's `## Evals` section names the video eval set. Pure. */
export function intentNamesEvalSet(text: string): boolean {
  return new RegExp(`\\b${VIDEO_EVAL_SET}\\b`).test(evalsSection(text));
}

/**
 * The checks an intent switches off for its workflow: `## Evals` sub-bullets written
 * `  - disabled: <check-id>[, <check-id>…] — <reason>`. A disable without a reason throws, so a dimension that does not
 * apply is switched off with the reason it does not apply, never skipped silently. Pure.
 */
export function intentEvalDisables(text: string): EvalDisable[] {
  const out: EvalDisable[] = [];
  for (const line of evalsSection(text).split(/\r?\n/)) {
    const m = line.match(/^\s+[-*]\s+`?disabled`?\s*:\s*(.+?)\s*$/i);
    if (!m) continue;
    const cut = m[1].search(/\s[—–]\s/);
    const reason = cut >= 0 ? m[1].slice(cut + 3).trim() : "";
    if (!reason) throw new Error(`"${line.trim()}": a disabled check needs its reason after " — "`);
    for (const id of m[1].slice(0, cut).replace(/`/g, "").split(/[,\s]+/).filter(Boolean)) out.push({ id, reason });
  }
  return out;
}

/** The intent's switch-offs, read from its file: none when it does not name the set. */
export function intentFileDisables(intent: string): EvalDisable[] {
  const text = readFileSync(intent, "utf8");
  return intentNamesEvalSet(text) ? intentEvalDisables(text) : [];
}

/** A refusal to evaluate at all (exit 2): the video, the intent and the switch-offs do not belong together. No receipt is written. */
export class EvalRefusal extends Error {}

/** A VideoEssay run's video evaluated against an intent that is not the run's own (exit 2): the laundering path. */
export class IntentMismatch extends EvalRefusal {
  constructor(readonly given: string, readonly own: string, readonly runDir: string) {
    super(`${runDir} was made for ${relative(getClaudeDir(), own)}; it is not evaluated against ${relative(getClaudeDir(), given)} (drop --intent, or evaluate a video that is not this run's)`);
  }
}

/**
 * Bytes wearing the DA essay badge evaluated under an intent other than VideoEssay Full or Explainer (exit 2). The rule
 * reads pixels, never a path, so a remux, a rename or a copy outside the run dir is still a DA essay.
 */
export class IntentOriginMismatch extends EvalRefusal {
  constructor(readonly intent: string | null, readonly ncc: number | null, why: string) {
    super(why);
  }
}

/** Bytes the record does not say this intent's pipeline rendered, or a --composition the record does not tie to them (exit 2). */
export class ProvenanceRefused extends EvalRefusal {}

/** An intent switches off a protected check its pipeline may not switch off (exit 2). */
export class SwitchOffRefused extends EvalRefusal {
  constructor(readonly intent: string, readonly problems: string[]) {
    super(`${relative(getClaudeDir(), intent)} switches off what its pipeline may not: ${problems.join("; ")}`);
  }
}

// ---------- origin: what the bytes are, read from their pixels ----------

/** The only intents bytes wearing the DA essay badge may be evaluated or admitted under. */
export const ESSAY_ORIGIN_INTENTS = [resolve(HERE, "../../VideoEssay/Intents/Full.md"), resolve(HERE, "../../VideoEssay/Intents/Explainer.md")] as const;

/** One path's identity: symlinks dereferenced, so a link into the skills tree is the file it points at. */
function realOrResolved(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/** True when `intent` is VideoEssay Full or Explainer, the real files under this install's skills tree. */
export function isEssayOriginIntent(intent: string): boolean {
  const real = realOrResolved(intent);
  return ESSAY_ORIGIN_INTENTS.some((p) => realOrResolved(p) === real);
}

/** The pipeline an intent belongs to: its skill and file, only for an intent that really lives under skills/<Skill>/Intents/. */
export type IntentFamily = "essay" | "essay-voice" | "essay-other" | "hyperframes" | "storyfilm" | "camera" | "other";
export function intentFamily(intent: string): IntentFamily {
  const skills = realOrResolved(join(HERE, "../.."));
  const real = realOrResolved(intent);
  const rel = relative(skills, real);
  if (rel.startsWith("..") || rel.startsWith("/")) return "other";
  const [skill, dir, file, ...more] = rel.split("/");
  if (dir !== "Intents" || !file?.endsWith(".md") || more.length) return "other";
  if (skill === "VideoEssay") return isEssayOriginIntent(real) ? "essay" : file === "Voice.md" ? "essay-voice" : "essay-other";
  if (skill === "HyperFrames") return "hyperframes";
  if (skill === "StoryFilm") return "storyfilm";
  if (skill === cameraFootageSkill()) return "camera";
  return "other";
}

/**
 * The install's camera-footage skill, by directory name, from `camera_footage_skill` in the Assay USER config.
 * Unset (the default) means the install has none, so no intent reads as camera.
 */
let cameraSkillMemo: string | null | undefined;
export function cameraFootageSkill(): string | null {
  if (cameraSkillMemo !== undefined) return cameraSkillMemo;
  try {
    const v = JSON.parse(readFileSync(join(assayUserDir(), "config.json"), "utf8")).camera_footage_skill;
    cameraSkillMemo = typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    cameraSkillMemo = null;
  }
  return cameraSkillMemo;
}

/**
 * The checks no intent switches off unless its pipeline's allowlist names them. The rest (format, encode, loudness,
 * PII, the judges, type-config) stay each intent's own call, with its reason on the receipt.
 */
export const PROTECTED_CHECKS = [
  "duration", "voice-identity", "voice-wer", "voice-pace", "script-length", "script-intent", "visual-variety", "detail", "card-corners",
  "watermark-brand", "watermark-badge", "watermark-zone", "type-rendered", "motion-share", "motion-max-still", "visual-cadence",
] as const;
const RUN_ONLY = ["duration", "voice-identity", "voice-wer", "voice-pace", "script-length", "visual-variety", "detail", "card-corners", "watermark-brand", "watermark-badge", "watermark-zone"];
/** A HyperFrames or StoryFilm intent declares it carries no narration by switching off every narration check. */
const NO_NARRATION = ["voice-loudness", "voice-dead-air", "voice-naturalness"];

/**
 * Every protected switch-off the intent's pipeline may not declare. VideoEssay Full/Explainer (and its other intents):
 * none. Voice.md: the reader-badge, author-voice and held-page checks its Ideal State explains (visual-cadence still
 * blocks). HyperFrames and StoryFilm: only checks that need a VideoEssay run, script-intent only when the intent also
 * switches off every narration check, type-rendered only when no composition is given; never motion-share,
 * motion-max-still or visual-cadence. Camera-footage intents: what they declare (origin refuses badge-bearing bytes
 * under them). Any other intent: none. Pure but for resolving the intent's real path.
 */
export function switchOffProblems(intent: string, disabled: readonly EvalDisable[], o: { composition?: boolean } = {}): string[] {
  const family = intentFamily(intent);
  const off = new Set(disabled.map((d) => d.id));
  const allowed = new Set<string>();
  if (family === "essay-voice") for (const id of ["watermark-badge", "watermark-zone", "voice-identity", "voice-pace", "motion-share", "motion-max-still", "visual-variety"]) allowed.add(id);
  if (family === "hyperframes" || family === "storyfilm") {
    for (const id of RUN_ONLY) allowed.add(id);
    if (NO_NARRATION.every((id) => off.has(id))) allowed.add("script-intent");
    if (!o.composition) allowed.add("type-rendered");
  }
  if (family === "camera") for (const id of PROTECTED_CHECKS) allowed.add(id);
  const protectedIds = new Set<string>(PROTECTED_CHECKS);
  return [...off].filter((id) => protectedIds.has(id) && !allowed.has(id)).map((id) => {
    if (id === "type-rendered") return "type-rendered (a composition was given, so the type is read)";
    if (id === "script-intent" && (family === "hyperframes" || family === "storyfilm")) return `script-intent (only an intent with no narration, one that also switches off ${NO_NARRATION.join(", ")}, may)`;
    return `${id} (protected: a ${family} intent may not switch it off)`;
  });
}

/**
 * The DA essay badge on the bytes: the watermark-badge template (the avatar disc's unscrimmed top rows, masked to the
 * disc) matched at the badge corner within ±4 px, on 12 frames spread evenly from 1.5 s to the end, each cropped from a
 * 1080p area scale of the frame. `ncc` is the median frame score, so a stray frame neither hides nor fakes the badge;
 * `present` is ncc ≥ the watermark-badge pass bar. Measured fresh on every call, never memoized: a gate re-runs it on
 * the exact bytes it is about to admit. Throws when there is no avatar to match or the video cannot be decoded.
 */
export async function badgeOrigin(video: string): Promise<{ ncc: number; present: boolean }> {
  const avatar = avatarPath();
  if (!existsSync(avatar)) throw new Error(`no DA avatar at ${avatar}: the essay badge cannot be looked for`);
  const pad = 4, cw = BADGE.size + 2 * pad, ch = BADGE.topRows + 2 * pad;
  const probe = await sh(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", resolve(video)]);
  const d = Number(probe.out.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`no duration on ${video}`);
  const times = Array.from({ length: 12 }, (_, i) => Math.max(0, Math.min(d - 0.2, 1.5 + ((d - 2) * i) / 11)));
  const full = await gray(avatar, BADGE.size, BADGE.size, false);
  const tpl: M.Gray = { w: BADGE.size, h: BADGE.topRows, data: full.data.slice(0, BADGE.size * BADGE.topRows) };
  const mask = M.discMask(BADGE.size, BADGE.topRows, BADGE.size / 2, BADGE.size / 2, BADGE.size / 2 - 2, BADGE.topRows);
  const scores = await pool(times, 12, async (t) => {
    const r = await sh(["ffmpeg", "-v", "error", "-ss", t.toFixed(3), "-i", resolve(video), "-frames:v", "1", "-vf", `scale=${WIDTH}:${HEIGHT}:flags=area,crop=${cw}:${ch}:${BADGE.x - pad}:${BADGE.y - pad},format=gray`, "-f", "rawvideo", "-"], { bytes: true });
    invariant(r.raw.length === cw * ch, `badge crop at ${t.toFixed(2)} s came back ${r.raw.length} bytes, not ${cw * ch}`);
    return M.templateScore({ w: cw, h: ch, data: r.raw }, tpl, { x: pad, y: pad }, pad, mask).score;
  });
  const sorted = [...scores].sort((a, b) => a - b);
  const ncc = Number(((sorted[5] + sorted[6]) / 2).toFixed(4));
  return { ncc, present: ncc >= BARS.badgeNcc };
}

/** Why these bytes may not be evaluated under `intent` (null when they may). Origin unmeasured fails closed for any intent but Full/Explainer. */
export function originProblem(intent: string | null, origin: { ncc: number; present: boolean } | { error: string }): string | null {
  if (!intent || isEssayOriginIntent(intent)) return null;
  const name = relative(getClaudeDir(), intent);
  if ("error" in origin) return `the DA essay badge could not be looked for on these bytes (${origin.error}), so they are not evaluated under ${name}; only VideoEssay Full or Explainer evaluate a video whose origin is unknown`;
  if (!origin.present) return null;
  return `these bytes wear the DA essay badge (NCC ${origin.ncc.toFixed(3)} ≥ ${BARS.badgeNcc}): a DA video essay is evaluated only under skills/VideoEssay/Intents/Full.md or Explainer.md, never ${name}`;
}

// ---------- types ----------

export type Status = "pass" | "fail" | "flag" | "unavailable";
/** A judge's raw answer, as memoized: earning is applied on every read (judged()), never baked into the memo. */
export type JudgeAnswer = { question: string; ok: boolean; detail: string; models: string[]; scores?: Record<string, unknown> };
export type CheckResult = { status: Status; detail: string; metrics?: Record<string, unknown>; findings?: ProofFinding[]; passed?: number; models?: string[]; judge?: JudgeAnswer };
export type InputName = "file" | "video-stream" | "audio-stream" | "script" | "timeline" | "essay" | "intent" | "logo" | "avatar" | "type-system" | "voice-config" | "voice-records" | "assets" | "narration-text" | "pronunciations" | "composition" | "judge-panel";
export type CheckDef = {
  id: string;
  dimension: "format" | "watermark" | "voice" | "script" | "typography" | "animation quantity" | "animation quality" | "safety";
  tier: ProofTier;
  /** The anchored pass bar, in words, as the receipt and `list` show it. */
  bar: string;
  inputs: InputName[];
  /** Source files whose bytes are part of this check's version (its memo busts when they change). */
  code: string[];
  /** Needs a VideoEssay run dir (script, timeline, assets); on a bare video it is unavailable, never passed. */
  needsRun?: boolean;
  run: (ctx: EvalContext) => Promise<CheckResult>;
};

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const noop = () => {};

async function sh(cmd: string[], o: { allowFail?: boolean; bytes?: boolean } = {}): Promise<{ code: number; out: string; err: string; raw: Uint8Array }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [raw, err, code] = await Promise.all([new Response(p.stdout).arrayBuffer().then((b) => new Uint8Array(b)), new Response(p.stderr).text(), p.exited]);
  if (code !== 0 && !o.allowFail) throw new Error(`${basename(cmd[0])} ${cmd[1] ?? ""} exited ${code}: ${err.slice(-300).trim()}`);
  return { code, out: o.bytes ? "" : new TextDecoder().decode(raw), err, raw };
}

/** Run `fn` over items, at most `n` at a time, keeping order. */
async function pool<T, R>(items: readonly T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}

/** `n` times spread evenly inside (0, d): the midpoints of n equal slices. */
export function evenTimes(d: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => (d * (2 * i + 1)) / (2 * n));
}
/** One time every `every` seconds through d (the midpoint of each slice), capped at `max` evenly spread. */
export function everyTimes(d: number, every: number, max: number): number[] {
  return evenTimes(d, Math.max(1, Math.min(max, Math.round(d / every))));
}

type VerifyRecord = { verifiedAt?: string; sha256?: string; scriptSha256?: string; checks?: { name: string; ok: boolean; detail: string }[] };

// ---------- the context: what the checks read, each measured once ----------

export class EvalContext {
  readonly video: string;
  readonly runDir: string | null;
  readonly evalDir: string;
  readonly intent: string | null;
  /** A bare video's narration text (--narration); without it script-intent reads the whisper transcript. */
  readonly narrationFile: string | null;
  /** A HyperFrames project dir the caller names as the built composition this video was rendered from (--composition). */
  readonly compositionDir: string | null;
  /** fresh: no stored result of any kind is read (Out/verify.json, Verify's pii.json); every check measures these bytes. */
  readonly fresh: boolean;
  private cache = new Map<string, Promise<unknown>>();
  constructor(video: string, runDir: string | null, intent: string | null, narrationFile: string | null = null, o: { composition?: string | null; fresh?: boolean } = {}) {
    this.video = resolve(video);
    this.runDir = runDir;
    this.intent = intent;
    this.narrationFile = narrationFile ? resolve(narrationFile) : null;
    this.compositionDir = o.composition ? resolve(o.composition) : null;
    this.fresh = o.fresh === true;
    this.evalDir = runDir ? join(runDir, "Out", "eval") : `${this.video}.eval`;
    mkdirSync(this.evalDir, { recursive: true });
  }
  once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.cache.has(key)) this.cache.set(key, fn());
    return this.cache.get(key) as Promise<T>;
  }
  get scale(): number { return this.runDir ? OUTPUT_SCALE : 2; }
  script(): Script { invariant(this.runDir, "script needs a run dir"); return loadScript(this.runDir); }
  timeline(): Timeline { invariant(this.runDir, "timeline needs a run dir"); return loadTimeline(this.runDir); }
  mode(): RunMode { return this.runDir ? runMode(this.runDir) : "essay"; }

  probe(): Promise<{ streams: { codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string }[]; format: { duration: string } }> {
    return this.once("probe", async () => JSON.parse((await sh(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate:format=duration", "-of", "json", this.video])).out));
  }
  async duration(): Promise<number> { return Number((await this.probe()).format.duration); }
  /** Narration span: the first word's start to the last word's end, or the whole video with no timeline. */
  async narrationSpan(): Promise<[number, number]> {
    if (!this.runDir) return [0, await this.duration()];
    const tl = this.timeline();
    const words = tl.beats.flatMap((b) => b.words);
    return words.length ? [words[0].s, words[words.length - 1].e] : [0, tl.total];
  }

  /** sha256 of one input's bytes; "absent" when the input does not exist. */
  inputHash(name: InputName): Promise<string> {
    return this.once(`input:${name}`, async () => {
      const fileSha = (p: string | undefined | null) => (p && existsSync(p) ? sha(readFileSync(p)) : "absent");
      const paths = this.runDir ? runPaths(this.runDir) : null;
      switch (name) {
        case "file": return sha256File(this.video);
        case "video-stream":
        case "audio-stream": {
          const r = await sh(["ffmpeg", "-v", "error", "-i", this.video, "-map", name === "video-stream" ? "0:v:0" : "0:a:0?", "-c", "copy", "-f", "streamhash", "-hash", "sha256", "-"], { allowFail: true });
          const h = r.out.match(/SHA256=([0-9a-f]{64})/)?.[1];
          return h ?? (r.code === 0 ? "absent" : `error:${sha(r.err)}`);
        }
        case "script": return fileSha(paths?.script);
        case "timeline": return fileSha(paths?.timeline);
        case "essay": return fileSha(paths?.essay);
        case "intent": return fileSha(this.intent);
        case "logo": return fileSha(cornerLogoPath());
        case "avatar": return fileSha(avatarPath());
        case "type-system": {
          const roles = houseTypeRolesPath();
          const house = existsSync(roles) ? houseFaceFiles(JSON.parse(readFileSync(roles, "utf8")) as HouseRoles).map((p) => [p, fileSha(p)]) : [];
          return sha(JSON.stringify({ roles: fileSha(roles), faces: configuredFaces().map((f) => [f.id, f.path, fileSha(f.path)]), house }));
        }
        case "voice-config": { const v = loadLifeosConfig().da.voices.main; return sha(JSON.stringify({ voiceId: v?.voiceId ?? null, ref: v?.fishReferenceId ?? null, speed: v?.fishSpeed ?? 1, model: CROSS_VENDOR.fishVoice })); }
        case "voice-records": {
          if (!this.runDir) return "absent";
          return sha(JSON.stringify(this.timeline().beats.map((b) => fileSha(b.chunk.replace(/\.wav$/, ".voice.json")))));
        }
        case "assets": {
          if (!paths || !existsSync(paths.assets)) return "absent";
          return sha(JSON.stringify(readdirSync(paths.assets).filter((f) => f.endsWith(".meta.json")).sort().map((f) => [f, fileSha(join(paths.assets, f))])));
        }
        case "narration-text": {
          if (this.runDir) return sha(this.scriptNarration());
          // A bare video's narration is the file named, else the transcript: a function of the audio and the whisper model.
          return this.narrationFile ? sha(`file:${fileSha(this.narrationFile)}`) : sha(`whisper:${WHISPER_MODEL}:${await this.inputHash("audio-stream")}`);
        }
        case "pronunciations": return this.runDir ? sha(JSON.stringify(loadPronunciations(this.runDir))) : "absent";
        case "composition": {
          const c = this.composition();
          if ("missing" in c) return "absent";
          if (this.compositionDir) return compositionDigest(c.dir);
          return sha(JSON.stringify(["index.html", "essay.js", "props.json"].map((f) => fileSha(join(c.dir, f))).concat(fileSha(c.record))));
        }
        case "judge-panel": return sha(JSON.stringify(judgePanel()));
      }
    });
  }

  /** The spoken narration, beat by beat, as Script.json holds it: nothing else, so a word count counts only what is said. */
  scriptNarration(): string {
    return `${this.script().beats.map((b) => b.narration).join("\n\n")}\n`;
  }

  /** What script-intent reads: the run's Script.json narration, else --narration, else the video's whisper transcript. */
  narration(): Promise<{ text: string; source: string }> {
    return this.once("narration", async () => {
      if (this.runDir) return { text: this.scriptNarration(), source: "Script.json narration" };
      if (this.narrationFile) return { text: readFileSync(this.narrationFile, "utf8"), source: `--narration ${this.narrationFile}` };
      return { text: await this.transcript(), source: `whisper ${WHISPER_MODEL} transcript of the video` };
    });
  }

  /** The video's whisper transcript, once (the model and flags Verify's speech check uses). */
  transcript(): Promise<string> {
    return this.once("transcript", async () => {
      const dir = join(this.evalDir, "whisper");
      mkdirSync(dir, { recursive: true });
      const wav = join(dir, "audio.wav");
      await sh(["ffmpeg", "-y", "-v", "error", "-i", this.video, "-vn", "-ar", "16000", "-ac", "1", wav]);
      await sh(["whisper", wav, "--model", WHISPER_MODEL, "--language", "en", "--output_format", "txt", "--output_dir", dir, "--fp16", "False", "--verbose", "False"]);
      const text = readFileSync(join(dir, "audio.txt"), "utf8");
      rmSync(wav, { force: true });
      return text;
    });
  }

  /** Out/verify.json when Verify measured exactly these bytes (video and Script.json sha256 match), else null. */
  verifyRecord(): Promise<VerifyRecord | null> {
    return this.once("verify-record", async () => {
      if (!this.runDir || this.fresh) return null;
      const p = runPaths(this.runDir).verify;
      if (!existsSync(p)) return null;
      let rec: VerifyRecord;
      try { rec = JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
      if (!rec.sha256 || rec.sha256 !== (await this.inputHash("file"))) return null;
      if (!rec.scriptSha256 || rec.scriptSha256 !== (await this.inputHash("script"))) return null;
      return Array.isArray(rec.checks) ? rec : null;
    });
  }

  /**
   * The built composition this run's video was rendered from: the stage directory Out/render.json's props live in
   * (VideoEssay Build stages public/runs/<slug>/, Compose writes index.html there). Missing when there is no run, no
   * render record, or the stage was rebuilt after the render, since then it is not the composition the video came from.
   */
  composition(): { dir: string; record: string } | { missing: string } {
    if (this.compositionDir) {
      const dir = this.compositionDir, index = join(dir, "index.html");
      if (!existsSync(index)) return { missing: `no built composition at ${index} (--composition names a HyperFrames project dir)` };
      // A project edited after the encode is not the composition this video came from.
      const newest = Math.max(...compositionFiles(dir).map((f) => statSync(f).mtimeMs));
      if (newest > statSync(this.video).mtimeMs + 1000) return { missing: `the composition at ${dir} changed after this video was encoded (a project file is newer than the video)` };
      return { dir, record: index };
    }
    if (!this.runDir) return { missing: "a bare video: no VideoEssay run names the composition it was rendered from, and no --composition names a HyperFrames project" };
    const record = join(runPaths(this.runDir).out, "render.json");
    if (!existsSync(record)) return { missing: `no ${record}: the run has no render record naming its composition` };
    let props: unknown;
    try { props = (JSON.parse(readFileSync(record, "utf8")) as { props?: unknown }).props; } catch { props = undefined; }
    if (typeof props !== "string") return { missing: `${record} names no props file` };
    const dir = dirname(props), index = join(dir, "index.html");
    if (!existsSync(index)) return { missing: `no built composition at ${index}` };
    if (statSync(index).mtimeMs > statSync(record).mtimeMs + 1000) return { missing: `the composition at ${dir} was rebuilt after this render (index.html is newer than Out/render.json)` };
    return { dir, record };
  }

  /** Frames at 4 fps, 480x270 gray (MOTION), the whole video in one decode. */
  motionStack(): Promise<Uint8Array> {
    return this.once("motion", async () => (await sh(["ffmpeg", "-v", "error", "-i", this.video, "-an", "-vf", `fps=${M.MOTION.fps},scale=${M.MOTION.w}:${M.MOTION.h}:flags=area,format=gray`, "-f", "rawvideo", "-"], { bytes: true })).raw);
  }

  /** One gray frame at `t`, scaled to w×h (area). */
  async grayAt(t: number, w: number, h: number): Promise<M.Gray> {
    const r = await sh(["ffmpeg", "-v", "error", "-ss", t.toFixed(3), "-i", this.video, "-frames:v", "1", "-vf", `scale=${w}:${h}:flags=area,format=gray`, "-f", "rawvideo", "-"], { bytes: true });
    invariant(r.raw.length === w * h, `frame at ${t.toFixed(2)} s came back ${r.raw.length} bytes, not ${w * h}`);
    return { w, h, data: r.raw };
  }

  /** Twelve frames at 1080p, evenly spread from 1.5 s (after the furniture fades in) to the end. */
  sampleFrames(): Promise<{ t: number; g: M.Gray }[]> {
    return this.once("samples", async () => {
      const d = await this.duration();
      const times = Array.from({ length: 12 }, (_, i) => Math.min(d - 0.2, 1.5 + ((d - 2) * i) / 11));
      return pool(times, 8, async (t) => ({ t, g: await this.grayAt(t, WIDTH, HEIGHT) }));
    });
  }

  /** Each capture beat's midpoint frame at full output size, gray. */
  cardFrames(): Promise<{ id: string; t: number; g: M.Gray }[]> {
    return this.once("cards", async () => {
      const s = this.script(), tl = this.timeline();
      const beats = s.beats.filter((b) => CAPTURE_TYPES.includes((b.visual as { type?: string }).type ?? ""));
      return pool(beats, 6, async (b) => {
        const tb = tl.beats.find((x) => x.id === b.id);
        invariant(tb, `beat ${b.id} has no timeline entry`);
        const t = beatFrameTime(tb, !!(b as { chapter?: string }).chapter);
        return { id: b.id, t, g: await this.grayAt(t, WIDTH * this.scale, HEIGHT * this.scale) };
      });
    });
  }

  /** Integrated loudness and true peak of the audio, one ebur128 pass. */
  ebur(): Promise<{ log: string; I: number; tp: number }> {
    return this.once("ebur", async () => {
      const r = await sh(["ffmpeg", "-v", "info", "-nostats", "-i", this.video, "-vn", "-af", "ebur128=framelog=quiet:peak=true", "-f", "null", "-"], { allowFail: true });
      return { log: r.err, I: Number(r.err.match(/I:\s+(-?[\d.]+) LUFS/)?.[1] ?? NaN), tp: Number(r.err.match(/True peak:\s+Peak:\s+(-?[\d.]+)/)?.[1] ?? NaN) };
    });
  }

  /** The audio stream copied out (for the audio judge), once. */
  audioFile(): Promise<string> {
    return this.once("audio", async () => {
      const out = join(this.evalDir, "audio.m4a");
      await sh(["ffmpeg", "-y", "-v", "error", "-i", this.video, "-vn", "-c:a", "copy", out]);
      return out;
    });
  }

  /** Small color frames at 4 fps (320x180, letterboxed for any aspect), written once, for the judge evidence boards. */
  thumbs(): Promise<{ dir: string; at: (t: number) => string }> {
    return this.once("thumbs", async () => {
      const dir = join(this.evalDir, "thumbs");
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      await sh(["ffmpeg", "-v", "error", "-i", this.video, "-an", "-vf", `fps=4,${FIT(320, 180)}`, join(dir, "t%05d.png")]);
      const n = readdirSync(dir).filter((f) => f.endsWith(".png")).length;
      invariant(n > 0, "no thumbnail frames came out of the video");
      return { dir, at: (t: number) => join(dir, `t${String(Math.min(n, Math.max(1, Math.round(t * 4) + 1))).padStart(5, "0")}.png`) };
    });
  }
}

/** The files of a HyperFrames project that make up its composition (shared with the producers: RenderProvenance). */
export { compositionFiles };

/** Scale into w×h keeping the aspect, padded to exactly w×h, so a portrait or square video is never stretched. */
const FIT = (w: number, h: number) => `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=area,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`;
const WHISPER_MODEL = "base.en";

/** Every model id the judged checks' answers depend on, and the vision routing per suite. */
function judgePanel(): Record<string, unknown> {
  let anthropic: string;
  try { anthropic = anthropicJudgeModel(); } catch (e) { anthropic = `unresolved: ${(e as Error).message}`; }
  let vision: Record<string, unknown>;
  try { vision = Object.fromEntries(VISUAL_DIMS.map((d) => [d, resolveVisionJudge(`video-eval-${d}`)])); } catch (e) { vision = { error: (e as Error).message }; }
  return { openai: CROSS_VENDOR.openaiJudge, anthropic, gemini: CROSS_VENDOR.gemini, vision };
}

// ---------- the check set ----------

const pass = (detail: string, metrics?: Record<string, unknown>): CheckResult => ({ status: "pass", detail, metrics });
const fail = (detail: string, metrics?: Record<string, unknown>): CheckResult => ({ status: "fail", detail, metrics });
const unavailable = (detail: string): CheckResult => ({ status: "unavailable", detail });
const verdict = (ok: boolean, detail: string, metrics?: Record<string, unknown>): CheckResult => (ok ? pass(detail, metrics) : fail(detail, metrics));

/** One check of Verify.ts, run alone on this video without touching Out/verify.json. */
async function verifyOne(ctx: EvalContext, name: string): Promise<CheckResult> {
  invariant(ctx.runDir, "verify needs a run dir");
  const r = await verify(ctx.runDir, { only: name, persist: false, video: ctx.video, log: noop });
  const c = r.checks.find((x) => x.name === name);
  if (!c) return unavailable(`Verify ran no ${name} check (${r.checks.map((x) => `${x.name}: ${x.detail}`).join("; ")})`);
  return verdict(c.ok, c.detail);
}

/** Verify's own result for `name`, when Out/verify.json measured these exact bytes; null sends the check to measure itself. */
export async function fromVerify(ctx: EvalContext, name: string): Promise<CheckResult | null> {
  const rec = await ctx.verifyRecord();
  const c = rec?.checks?.find((x) => x.name === name);
  return c ? verdict(c.ok, `${c.detail} (Verify, same bytes, ${rec?.verifiedAt ?? "?"})`, { fromVerify: true }) : null;
}

export const LOGO_BOX = { left: 32, bottom: 32, height: 72 } as const; // Compose.ts CORNER_LOGO, px at 1080p
/** The essay badge's avatar disc (PagePresence PRESENCE: 200 px, ring 2, right 40, bottom 40), and its unscrimmed top rows. */
export const BADGE = { x: 1682, y: 842, size: 196, topRows: 100 } as const;
/** YouTube's bottom-right watermark zone at 1080p, and what may sit in it: the DA badge disc and its tie line. */
export const WATERMARK_ZONE = { zone: { x: 1640, y: 800, w: 280, h: 270 }, allowed: [{ x: 1676, y: 836, w: 208, h: 208 }, { x: 1640, y: 928, w: 40, h: 24 }] } as const;
export const BARS = { logoNcc: 0.8, badgeNcc: 0.8, zoneMax: 0.002, cornerMin: 16, werMax: 0.08, deadAirMax: 1.5, lengthTol: 0.15 } as const;

async function gray(file: string, w: number, h: number, alpha: boolean): Promise<M.Gray> {
  const r = await sh(["magick", file, ...(alpha ? ["-alpha", "extract"] : ["-colorspace", "gray"]), "-resize", `${w}x${h}!`, "-depth", "8", "gray:-"], { bytes: true });
  invariant(r.raw.length === w * h, `${basename(file)} resized to ${w}x${h} came back ${r.raw.length} bytes`);
  return { w, h, data: r.raw };
}

const NATURALNESS_PROMPT = "You are judging the narration track of a short explainer video, voiced by an AI narrator. Listen to the whole track. Score how natural it sounds on 1-5: 1 = robotic or glitchy (clipped or doubled words, artifacts, wrong stress, unnatural pauses), 3 = clear and usable but noticeably synthetic or rushed in places, 5 = sounds like a skilled human narrator throughout. Set natural true only at 4 or 5. Quote the timestamps of any defect in the reason.";
const NATURALNESS_SCHEMA = { type: "object", properties: { score: { type: "integer" }, natural: { type: "boolean" }, reason: { type: "string" } }, required: ["score", "natural", "reason"] };

export const VISUAL_DIMS = ["sharpness", "meaning", "variety", "polish", "typography"] as const;
export type VisualDim = (typeof VISUAL_DIMS)[number];

/** The five judged visual dimensions, each with anchored low, mid and high levels. Evidence comes from the run's beats, or evenly from a bare video. */
export const RUBRICS: Record<VisualDim, { evidence: string; rubric: string; anchors: Record<"1" | "3" | "5", string> }> = {
  sharpness: { evidence: "four native-resolution crops of 4K frames", rubric: "Sharpness and fidelity: each tile is a native-pixel crop of a 4K frame of the video. Are images, screenshots and text crisp at native size, free of blur, upscaling softness, compression blocks and smeared text?", anchors: { "1": "Visibly soft or blocky: text edges smeared, images upscaled or blurred, artifacts obvious at native size", "3": "Mostly crisp, but at least one tile shows softness, ringing or blocking a careful viewer notices", "5": "Every tile is crisp at native size: clean text edges, images at full fidelity, no compression artifacts" } },
  meaning: { evidence: "the motion strip (one row per beat, or per 24 s of a bare video, frames left to right through it)", rubric: "Motion carries meaning: each row is one stretch of the video in order (a narrated beat, or 24 seconds), frames left to right through it. Does the picture change when the idea changes, with movement that reveals, builds or points at the idea, rather than holding one static card or moving decoratively?", anchors: { "1": "Most rows repeat one frame: the picture sits still while the narration moves on, or the only motion is decorative", "3": "About half the rows build or reveal something; the rest hold one static card for the whole stretch", "5": "Nearly every row builds: elements arrive, highlight or transform in step with the idea, and no row holds one unchanging picture" } },
  variety: { evidence: "the contact sheet (one frame per beat, or one every 4 s of a bare video, in order)", rubric: "Variety: frames of the video in order (one per beat, or one every few seconds). Does the video vary its layouts, visual types and compositions to suit what is being said, rather than repeating one card treatment?", anchors: { "1": "Nearly every frame is the same layout or treatment", "3": "Two or three treatments alternate predictably, with runs of look-alike frames", "5": "Many distinct treatments, each suited to its moment, and no long run of look-alike frames" } },
  polish: { evidence: "four full frames of image and screenshot beats (four evenly spaced frames of a bare video)", rubric: "Polish: in these full frames, are image and screenshot cards finished (rounded corners, aligned edges and margins), is nothing clipped (captures cut mid-text, labels cut off), and is the type hierarchy clean?", anchors: { "1": "Hard square corners or clipped captures, misaligned elements, cramped or cut text", "3": "Clean overall with at least one visible flaw: square corners, a capture cut mid-line, or uneven margins", "5": "Studio finish: rounded cards, aligned edges, nothing clipped, clear hierarchy" } },
  typography: { evidence: "four full frames of text beats (four evenly spaced frames of a bare video)", rubric: "Typography: in these full frames, is the type set well? Look at hierarchy (one dominant line, supporting text clearly subordinate), size (every line legible on a phone), legibility (contrast against its ground, nothing cramped), casing (headings and labels in their case, no line set in all lowercase), and line breaks (no orphaned single word, no word split or clipped, no line running into an edge).", anchors: { "1": "Type fights itself: no clear hierarchy, text too small or low-contrast to read on a phone, all-lowercase or mixed casing, words orphaned, split or clipped", "3": "Readable with a visible hierarchy, but at least one frame shows a casing slip, an orphaned or awkward line break, or a line too small for a phone", "5": "A clear hierarchy in every frame, every line legible at phone size, consistent faces and casing, clean balanced line breaks" } },
};

export const CHECKS: CheckDef[] = [
  // ----- format -----
  { id: "format-4k", dimension: "format", tier: "code", bar: "h264 3840x2160, 30 fps on a VideoEssay run, with an aac audio track", inputs: ["file"], code: [CODE.runner, CODE.verify], run: async (ctx) => {
    const reused = await fromVerify(ctx, "format");
    if (reused) return reused;
    const { streams } = await ctx.probe();
    const v = streams.find((s) => s.codec_type === "video"), a = streams.find((s) => s.codec_type === "audio");
    const [n, d] = String(v?.r_frame_rate ?? "0/1").split("/").map(Number);
    const fps = d ? n / d : 0;
    const ok = !!v && v.codec_name === "h264" && v.width === 3840 && v.height === 2160 && (!ctx.runDir || Math.round(fps) === FPS) && a?.codec_name === "aac";
    return verdict(ok, `${v?.codec_name} ${v?.width}x${v?.height}@${fps.toFixed(2)} + ${a?.codec_name ?? "no audio"}`, { width: v?.width, height: v?.height, fps });
  } },
  { id: "encode", dimension: "format", tier: "code", bar: "x264 CRF rate control at or below CRF 12", inputs: ["file"], code: [CODE.runner, CODE.verify], run: async (ctx) => {
    const reused = await fromVerify(ctx, "encode");
    if (reused) return reused;
    const head = Buffer.from(await Bun.file(ctx.video).slice(0, 16 * 1024 * 1024).arrayBuffer()).toString("latin1");
    const v = encodeVerdict(x264Settings(head));
    return verdict(v.ok, v.detail);
  } },
  { id: "duration", dimension: "format", tier: "code", bar: "container duration = narration timeline ± 0.5 s", inputs: ["file", "timeline"], code: [CODE.runner], needsRun: true, run: async (ctx) => {
    const d = await ctx.duration(), t = ctx.timeline().total;
    return verdict(Math.abs(d - t) <= 0.5, `rendered ${d.toFixed(2)} s vs timeline ${t.toFixed(2)} s`, { duration: d, timeline: t });
  } },

  // ----- watermark -----
  { id: "watermark-brand", dimension: "watermark", tier: "code", bar: `the Config.json cornerLogo bottom-left on every sampled frame (template NCC ≥ ${BARS.logoNcc})`, inputs: ["video-stream", "logo"], code: [CODE.runner, CODE.checks], run: async (ctx) => {
    const logo = cornerLogoPath();
    if (!logo || !existsSync(logo)) return unavailable("no cornerLogo configured in the VideoEssay Config.json, so there is no brand mark to look for");
    const dim = (await sh(["magick", "identify", "-format", "%w %h", logo])).out.trim().split(" ").map(Number);
    const h = LOGO_BOX.height, w = Math.round((h * dim[0]) / dim[1]);
    const tpl = await gray(logo, w, h, true);
    const frames = await ctx.sampleFrames();
    const scores = frames.map((f) => M.templateScore(f.g, tpl, { x: LOGO_BOX.left, y: HEIGHT - LOGO_BOX.bottom - h }, 4).score);
    const worst = Math.min(...scores), at = frames[scores.indexOf(worst)].t;
    return verdict(worst >= BARS.logoNcc, `brand mark NCC ${worst.toFixed(3)} at worst (${at.toFixed(1)} s) over ${frames.length} frames, bar ${BARS.logoNcc}`, { scores });
  } },
  { id: "watermark-badge", dimension: "watermark", tier: "code", bar: `the DA badge (avatar disc) bottom-right on every sampled frame (template NCC ≥ ${BARS.badgeNcc})`, inputs: ["video-stream", "avatar"], code: [CODE.runner, CODE.checks], run: async (ctx) => {
    if (ctx.mode() === "voice") return unavailable("voice runs wear a badge design, not the essay avatar disc this template measures");
    const avatar = avatarPath();
    if (!existsSync(avatar)) return unavailable(`no avatar at ${avatar}`);
    const full = await gray(avatar, BADGE.size, BADGE.size, false);
    const tpl: M.Gray = { w: BADGE.size, h: BADGE.topRows, data: full.data.slice(0, BADGE.size * BADGE.topRows) };
    const mask = M.discMask(BADGE.size, BADGE.topRows, BADGE.size / 2, BADGE.size / 2, BADGE.size / 2 - 2, BADGE.topRows);
    const frames = await ctx.sampleFrames();
    const scores = frames.map((f) => M.templateScore(f.g, tpl, { x: BADGE.x, y: BADGE.y }, 4, mask).score);
    const worst = Math.min(...scores), at = frames[scores.indexOf(worst)].t;
    return verdict(worst >= BARS.badgeNcc, `DA badge NCC ${worst.toFixed(3)} at worst (${at.toFixed(1)} s) over ${frames.length} frames, bar ${BARS.badgeNcc}`, { scores });
  } },
  { id: "watermark-zone", dimension: "watermark", tier: "code", bar: `nothing but the DA badge in YouTube's bottom-right watermark zone (≤ ${BARS.zoneMax * 100}% of its other pixels off the ground)`, inputs: ["video-stream"], code: [CODE.runner, CODE.checks], run: async (ctx) => {
    const frames = await ctx.sampleFrames();
    const shares = frames.map((f) => M.zoneIntrusion(f.g, WATERMARK_ZONE.zone, WATERMARK_ZONE.allowed, M.medianLevel(f.g, { x: 0, y: 0, w: 200, h: 200 })));
    const worst = Math.max(...shares), at = frames[shares.indexOf(worst)].t;
    return verdict(worst <= BARS.zoneMax, `zone intrusion ${(worst * 100).toFixed(2)}% at worst (${at.toFixed(1)} s), bar ${BARS.zoneMax * 100}%`, { shares });
  } },

  // ----- voice -----
  { id: "voice-identity", dimension: "voice", tier: "code", bar: "every narration chunk spoken with [da.voices.main]: its .voice.json record names main's Fish reference and fish_speed, or (no record) its file hash is Narrate's chunk hash of the beat's spoken text in today's daVoice()", inputs: ["timeline", "voice-records", "voice-config", "script", "pronunciations"], code: [CODE.runner, CODE.checks, CODE.narrate], needsRun: true, run: (ctx) => voiceIdentity(ctx) },
  { id: "voice-wer", dimension: "voice", tier: "code", bar: `whisper transcript of the rendered audio vs the script, WER ≤ ${BARS.werMax * 100}%`, inputs: ["audio-stream", "script"], code: [CODE.runner, CODE.verify], needsRun: true, run: async (ctx) => (await fromVerify(ctx, "speech")) ?? verifyOne(ctx, "speech") },
  { id: "voice-loudness", dimension: "voice", tier: "code", bar: "integrated loudness on target: −16 ± 2 LUFS (essay), −14 ± 1 LUFS (voice)", inputs: ["audio-stream"], code: [CODE.runner, CODE.verify], run: async (ctx) => {
    const e = await ctx.ebur();
    if (!Number.isFinite(e.I)) return unavailable("ebur128 printed no integrated loudness");
    const c = loudnessCheck(ctx.mode() === "voice" ? "voice" : "essay", e.log);
    return verdict(c.ok, c.detail, { lufs: e.I });
  } },
  { id: "voice-true-peak", dimension: "voice", tier: "code", bar: `true peak ≤ ${VOICE_TRUE_PEAK + 0.5} dBTP`, inputs: ["audio-stream"], code: [CODE.runner], run: async (ctx) => {
    const e = await ctx.ebur();
    if (!Number.isFinite(e.tp)) return unavailable("ebur128 printed no true peak");
    return verdict(e.tp <= VOICE_TRUE_PEAK + 0.5, `true peak ${e.tp} dBTP (bar ≤ ${VOICE_TRUE_PEAK + 0.5})`, { truePeak: e.tp });
  } },
  { id: "voice-pace", dimension: "voice", tier: "code", bar: `median words/s within ±${M.PACE.rateTol * 100}% of ${M.PACE.baseWps} × fish_speed, every 12+-word beat within ±${M.PACE.beatTol * 100}% of the median`, inputs: ["timeline", "voice-config"], code: [CODE.runner, CODE.checks], needsRun: true, run: async (ctx) => {
    const stats = M.paceStats(ctx.timeline().beats);
    if (stats.perBeat.length === 0) return unavailable("no beat with 12 or more aligned words to measure a pace on");
    const speed = loadLifeosConfig().da.voices.main?.fishSpeed ?? 1;
    const v = M.paceVerdict(stats, speed);
    return verdict(v.ok, v.detail, { median: stats.median, spread: stats.spread });
  } },
  { id: "voice-dead-air", dimension: "voice", tier: "code", bar: `no silence over ${BARS.deadAirMax} s (below −40 dB) between the first and last narrated word`, inputs: ["audio-stream", "timeline"], code: [CODE.runner, CODE.checks], run: async (ctx) => {
    const r = await sh(["ffmpeg", "-v", "info", "-nostats", "-i", ctx.video, "-vn", "-af", `silencedetect=n=-40dB:d=${BARS.deadAirMax}`, "-f", "null", "-"], { allowFail: true });
    if (r.code !== 0) return unavailable(`silencedetect failed: ${r.err.slice(-200)}`);
    const [s, e] = await ctx.narrationSpan();
    const gaps = M.deadAir(M.parseSilences(r.err), s, e, BARS.deadAirMax);
    return verdict(gaps.length === 0, gaps.length ? `${gaps.length} silence(s) over ${BARS.deadAirMax} s inside the narration, first at ${gaps[0].start.toFixed(1)} s (${gaps[0].sec.toFixed(1)} s)` : `no silence over ${BARS.deadAirMax} s between ${s.toFixed(1)} s and ${e.toFixed(1)} s`);
  } },

  // ----- script -----
  { id: "script-length", dimension: "script", tier: "code", bar: `rendered length within ±${BARS.lengthTol * 100}% of Script.json targetMinutes`, inputs: ["file", "script"], code: [CODE.runner, CODE.checks], needsRun: true, run: async (ctx) => {
    const v = M.lengthVerdict(await ctx.duration(), ctx.script().targetMinutes as number | undefined, BARS.lengthTol);
    return verdict(v.ok, v.detail);
  } },

  // ----- typography -----
  { id: "type-config", dimension: "typography", tier: "code", bar: "every house type role in its house face and case in the configuration (TypeRoles.json)", inputs: ["type-system"], code: [CODE.runner], run: async () => {
    const path = houseTypeRolesPath();
    if (!existsSync(path)) return unavailable(`no house type system at ${path} to hold the type to`);
    const problems = houseTypeProblems(configuredFaces(), JSON.parse(readFileSync(path, "utf8")));
    return verdict(problems.length === 0, problems.length ? problems.join("; ") : "every type role is in its house face and case");
  } },
  { id: "type-rendered", dimension: "typography", tier: "code", bar: "every text element of the composition the video was rendered from is set in an embedded face that TypeRoles.json gives a role, at that face's weight, in its role's case; no text is all lowercase (code excepted)", inputs: ["composition", "type-system"], code: [CODE.runner, CODE.probe, CODE.theme], run: (ctx) => typeRendered(ctx) },

  // ----- animation quantity -----
  { id: "motion-share", dimension: "animation quantity", tier: "code", bar: `the picture moves ≥ ${M.MOTION.shareMin * 100}% of the time: 4 fps, badge column cut, a pair of frames moves when content differs by ≥ ${M.MOTION.diffMin} luma levels after the frames are aligned; slow camera drift (≤ ${M.MOTION.drift.tPx} px of ${M.MOTION.w} and ${M.MOTION.drift.scale * 100}% zoom per sample) and global brightness or contrast changes are excluded`, inputs: ["video-stream"], code: [CODE.runner, CODE.checks], run: async (ctx) => {
    const m = M.motionStats(M.frameDiffs(await ctx.motionStack(), M.MOTION.w, M.MOTION.h, M.MOTION.w * M.MOTION.badgeCut), M.MOTION.fps);
    return verdict(m.share >= M.MOTION.shareMin, `moving ${(m.share * 100).toFixed(1)}% of the time (bar ≥ ${M.MOTION.shareMin * 100}%)`, { share: m.share });
  } },
  { id: "motion-max-still", dimension: "animation quantity", tier: "code", bar: `never still more than ${M.MOTION.stillMaxSec} s (slow camera drift and global brightness changes over a held picture count as still)`, inputs: ["video-stream"], code: [CODE.runner, CODE.checks], run: async (ctx) => {
    const m = M.motionStats(M.frameDiffs(await ctx.motionStack(), M.MOTION.w, M.MOTION.h, M.MOTION.w * M.MOTION.badgeCut), M.MOTION.fps);
    const long = m.stills.filter((s) => s.sec > M.MOTION.stillMaxSec);
    const l = m.longest;
    return verdict(long.length === 0, `${long.length} still stretch(es) over ${M.MOTION.stillMaxSec} s${l ? `; longest ${l.sec.toFixed(2)} s at ${l.start.toFixed(2)}–${l.end.toFixed(2)} s` : ""} (${m.stills.filter((s) => s.sec >= 3).length} of 3 s or more)`, { longest: l?.sec ?? 0, over: long.map((s) => [s.start, s.end]) });
  } },
  { id: "visual-cadence", dimension: "animation quantity", tier: "code", bar: `the picture changes at least every ${M.MOTION.cadenceMaxSec} s of narration: a change is a frame that differs from the last change frame by ≥ ${M.MOTION.changeMin} levels after that frame is aligned to it (or less than ${M.MOTION.coverMin * 100}% of it is still covered), so slow camera drift and global brightness changes never add up to a change`, inputs: ["video-stream", "timeline"], code: [CODE.runner, CODE.checks], run: async (ctx) => {
    const changes = M.changeTimes(await ctx.motionStack(), M.MOTION.w, M.MOTION.h, M.MOTION.fps, M.MOTION.w * M.MOTION.badgeCut);
    const [s, e] = await ctx.narrationSpan();
    const g = M.longestUnchanged(changes, s, e);
    return verdict(g.sec <= M.MOTION.cadenceMaxSec, `longest stretch of narration with no picture change ${g.sec.toFixed(2)} s at ${g.start.toFixed(2)}–${g.end.toFixed(2)} s (bar ≤ ${M.MOTION.cadenceMaxSec} s; ${changes.length} changes)`, { longest: g.sec });
  } },
  { id: "visual-variety", dimension: "animation quantity", tier: "code", bar: `no more than ${M.MOTION.sameTypeMax} consecutive beats of the same visual type`, inputs: ["script"], code: [CODE.runner, CODE.checks], needsRun: true, run: async (ctx) => {
    const beats = ctx.script().beats;
    const r = M.sameTypeRun(beats.map((b) => String((b.visual as { type?: string }).type ?? "?")));
    return verdict(r.run <= M.MOTION.sameTypeMax, `longest run ${r.run} × ${r.type} from beat ${beats[r.at]?.id ?? "?"} (bar ≤ ${M.MOTION.sameTypeMax})`, { run: r.run });
  } },

  // ----- animation quality -----
  { id: "detail", dimension: "animation quality", tier: "code", bar: "every shown image file keeps ≥ 85% of its source's edge detail", inputs: ["video-stream", "script", "assets"], code: [CODE.runner, CODE.verify], needsRun: true, run: async (ctx) => (await fromVerify(ctx, "detail")) ?? verifyOne(ctx, "detail") },
  { id: "card-corners", dimension: "animation quality", tier: "code", bar: `every visible corner of every image/screenshot card rounded ≥ ${BARS.cornerMin} px at 1080p, a card found on every capture beat`, inputs: ["video-stream", "script", "timeline"], code: [CODE.runner, CODE.checks], needsRun: true, run: (ctx) => cardCorners(ctx) },

  // ----- judged -----
  { id: "voice-naturalness", dimension: "voice", tier: "judge", bar: "audio judge: natural, unhurried narration with no glitches, clipped words or robotic prosody (score ≥ 4 of 5)", inputs: ["audio-stream", "judge-panel"], code: [CODE.runner, ...JUDGE_CODE], run: async (ctx) => {
    const audio = await ctx.audioFile();
    const r = await judgeVideo(audio, { prompt: NATURALNESS_PROMPT, schema: NATURALNESS_SCHEMA, mimeType: "audio/mp4", caller: "VideoEval.voice-naturalness", displayName: "narration.m4a" });
    const p = r.parsed as { score?: unknown; natural?: unknown; reason?: unknown };
    if (typeof p?.score !== "number" || typeof p.natural !== "boolean") return unavailable(`audio judge returned no score: ${r.text.slice(0, 160)}`);
    return answer("voice-naturalness", NATURALNESS_PROMPT, p.score >= 4 && p.natural, `score ${p.score}/5, natural ${p.natural}: ${String(p.reason ?? "")}`, r.executedModel ? [r.executedModel] : [r.requestedModel], { score: p.score, natural: p.natural });
  } },
  { id: "script-intent", dimension: "script", tier: "glance", bar: "Proof run --intent: the narration (Script.json, or on a bare video --narration or its whisper transcript) meets the intent's Ideal State and Anti-criteria bullets", inputs: ["narration-text", "intent"], code: [CODE.runner, join(HERE, "Proof.ts")], run: (ctx) => scriptIntent(ctx) },
  ...VISUAL_DIMS.map((dim): CheckDef => ({
    id: `visual-judge-${dim}`, dimension: dim === "typography" ? "typography" : "animation quality", tier: "judge", bar: `VisionJudge panel (OpenAI + Anthropic) on ${RUBRICS[dim].evidence}: ${RUBRICS[dim].rubric.split(":")[0]} (score ≥ 4 of 5 from both)`,
    inputs: ["video-stream", "script", "timeline", "judge-panel"], code: [CODE.runner, ...JUDGE_CODE],
    run: async (ctx) => {
      const boards = await evidenceBoards(ctx);
      const r = await judgeImageRubric(boards[dim], RUBRICS[dim].rubric, RUBRICS[dim].anchors, { suite: `video-eval-${dim}`, threshold: 0.75 });
      if (r.unavailable) return unavailable(r.reason);
      const panel = (r.judge as { panel?: { provider?: string; executed_model?: string; requested_model: string; score?: number; passed?: boolean }[] } | undefined)?.panel ?? [];
      const scores = Object.fromEntries(panel.map((s) => [s.provider ?? s.requested_model, { score: s.score, passed: s.passed }]));
      return answer(`visual-judge-${dim}`, RUBRICS[dim].rubric, r.passed, `${r.reason} (evidence: ${basename(boards[dim])}, ${ctx.runDir ? "from the run's beats" : "sampled evenly from the bare video"})`, panel.map((s) => s.executed_model ?? s.requested_model), scores);
    },
  })),
  { id: "pii", dimension: "safety", tier: "judge", bar: "VideoPiiGate (video judge) finds no private data on screen or in the audio; findings are for review", inputs: ["file"], code: [CODE.runner, CODE.verify], run: async (ctx) => {
    const rec = await ctx.verifyRecord();
    const fromVerifyReport = rec?.checks?.find((c) => c.name === "pii")?.ok && ctx.runDir ? join(runPaths(ctx.runDir).out, "pii.json") : null;
    const report = fromVerifyReport && existsSync(fromVerifyReport) ? fromVerifyReport : join(ctx.evalDir, "pii.json");
    if (report !== fromVerifyReport) {
      rmSync(report, { force: true });
      const r = await sh(["bun", join(getLifeosDir(), "TOOLS", "VideoPiiGate.ts"), ctx.video, "--low", "--json", "--out", report], { allowFail: true });
      if (!existsSync(report) || r.code === 2) return unavailable(`PII gate did not run (exit ${r.code}): ${r.err.slice(-200).trim()}`);
    }
    const findings = (JSON.parse(readFileSync(report, "utf8")).findings ?? []) as { what?: string; t?: number }[];
    const via = report === fromVerifyReport ? " (Verify's gate run on these bytes)" : "";
    return findings.length ? { status: "flag", detail: `${findings.length} finding(s) for review in ${report}${via}: ${findings.slice(0, 3).map((f) => `${f.t ?? "?"} s ${f.what ?? ""}`).join("; ")}` } : pass(`no PII findings${via}`);
  } },
];

/** A judge's raw answer as a result: pass when it says yes, else a flag until judged() reads the question as earned. */
function answer(id: string, rubric: string, ok: boolean, detail: string, models: string[], scores?: Record<string, unknown>): CheckResult {
  const judge: JudgeAnswer = { question: `${id}@${sha(rubric).slice(0, 12)}`, ok, detail, models, ...(scores ? { scores } : {}) };
  return { status: ok ? "pass" : "flag", detail, models, judge };
}

/**
 * Whether a judged check has earned its right to block: LabelStore's earned status for its check id, the same key the
 * label join writes ({check_id}), so a principal verdict joined to a receipt counts here.
 */
export function earnedFromLabels(checkId: string): boolean {
  try { return earnedStatus({ check_id: checkId }).earned; } catch { return false; }
}

/** The check id a judge answer belongs to: its question is `<check id>@<rubric sha12>`. */
export function judgeCheckId(j: JudgeAnswer): string {
  return j.question.split("@")[0]!;
}

/** A judged answer, read now: a pass, an earned fail, or (unearned) a flag. Applied on every read, memo hits included. */
export function judged(raw: CheckResult, earned: (checkId: string) => boolean = earnedFromLabels, checkId?: string): CheckResult {
  const j = raw.judge;
  if (!j) return raw;
  if (j.ok) return { ...raw, status: "pass", detail: j.detail };
  const e = earned(checkId ?? judgeCheckId(j));
  return { ...raw, status: e ? "fail" : "flag", detail: `${j.detail}${e ? "" : " (unearned: a flag until calibrated against the principal's labels)"}` };
}

// ---------- the larger checks ----------

export async function voiceIdentity(ctx: EvalContext): Promise<CheckResult> {
  const main = loadLifeosConfig().da.voices.main;
  if (!main?.fishReferenceId) return unavailable("no [da.voices.main] fish_reference_id configured to compare against");
  const want = { fishReferenceId: main.fishReferenceId, fishSpeed: main.fishSpeed ?? 1 };
  let voice: VoiceSettings | null = null;
  try { voice = daVoice(); } catch { voice = null; }
  const runDir = ctx.runDir!;
  const script = ctx.script(), pron = loadPronunciations(runDir);
  const recorded: { id: string; record: M.ChunkVoice }[] = [];
  const byHash: string[] = [], mismatch: string[] = [], unknown: string[] = [];
  for (const b of ctx.timeline().beats) {
    const p = b.chunk.replace(/\.wav$/, ".voice.json");
    let record: M.ChunkVoice | null = null;
    try { record = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; } catch { record = null; }
    if (record) { recorded.push({ id: b.id, record }); continue; }
    // No record: the chunk file is named <id>.<hash>.wav, and Narrate's hash covers the spoken text, the voice id, the
    // model and the speed. Recompute it for today's voice; a match means this chunk was made by today's voice settings.
    const fileHash = basename(b.chunk).match(/\.([0-9a-f]{12})\.wav$/)?.[1];
    const sb = script.beats.find((x) => x.id === b.id);
    if (!voice || !fileHash || !sb) { unknown.push(b.id); continue; }
    const h = chunkHash(applyPronunciations(sb.tts ?? sb.narration, pron), voice);
    (h === fileHash ? byHash : mismatch).push(b.id);
  }
  const r = recorded.length ? M.voiceIdentity(recorded, want) : null;
  const wrong = [...(r?.wrong ?? []), ...mismatch], unsure = [...(r?.unknown ?? []), ...unknown];
  const how = `${recorded.length} by voice record, ${byHash.length} by Narrate chunk hash (voice_id ${voice?.voice_id ?? "?"}, speed ${voice?.speed ?? "?"}, ${CROSS_VENDOR.fishVoice})`;
  const metrics = { recorded: recorded.length, byHash: byHash.length, mismatch, unknown: unsure };
  if (wrong.length) return fail(`${wrong.length} chunk(s) not in [da.voices.main]: ${r?.wrong.length ? `record names another voice or speed on ${r.wrong.join(", ")}` : ""}${r?.wrong.length && mismatch.length ? "; " : ""}${mismatch.length ? `file hash is not today's chunk hash on ${mismatch.join(", ")}` : ""} (${how})`, metrics);
  if (unsure.length) return { status: "unavailable", detail: `voice unknown on ${unsure.join(", ")}: no record and the spoken text or hash could not be rebuilt (${how})`, metrics };
  return pass(`every chunk in [da.voices.main]: ${how}`, metrics);
}

export async function cardCorners(ctx: EvalContext): Promise<CheckResult> {
  const frames = await ctx.cardFrames();
  if (frames.length === 0) {
    return ctx.mode() === "voice" ? pass("a voice run: no capture cards to measure") : unavailable("no image or screenshot beats in this essay run, so there is no card corner to measure");
  }
  const rows: string[] = [], missed: string[] = [];
  let worst = Infinity;
  for (const f of frames) {
    const c = M.cardCorners(f.g, M.medianLevel(f.g, { x: 0, y: 0, w: 150 * ctx.scale, h: 150 * ctx.scale }));
    if (!c || c.radii.length === 0) { missed.push(f.id); continue; }
    const r = Math.min(...c.radii) * (1080 / f.g.h);
    worst = Math.min(worst, r);
    rows.push(`${f.id} ${r.toFixed(1)}`);
  }
  const miss = missed.length ? `; no measurable card on ${missed.join(", ")}` : "";
  if (rows.length && worst < BARS.cornerMin) return fail(`smallest corner radius ${worst.toFixed(1)} px at 1080p (bar ≥ ${BARS.cornerMin}): ${rows.join(", ")}${miss}`, { worst, missed });
  if (missed.length) return { status: "unavailable", detail: `no measurable card on capture beat(s) ${missed.join(", ")}${rows.length ? `; measured ${rows.join(", ")}` : ""}`, metrics: { missed } };
  return pass(`smallest corner radius ${worst.toFixed(1)} px at 1080p (bar ≥ ${BARS.cornerMin}): ${rows.join(", ")}`, { worst });
}

// ----- type-rendered: the composition's text, as the browser sets it -----

/** One text node as the browser set it: its computed face and case, and the block it sits in. */
export type RenderedText = { text: string; family: string; weight: string; style: string; transform: string; code: boolean; block: number };
export type HouseRoles = Record<string, { case?: string; /** The role's faces draw every letter as a capital (a caps font: lowercase source sets as small caps). */ drawsCaps?: boolean; faces?: { family?: string; file?: string; weight?: number; style?: string }[] } | string>;
type FaceLike = { id: string; family: string; weight: number; style: string; path: string };

/** Every TypeRoles.json face file, resolved the way the seam's roleFaces resolves it (a bare name under ~/Library/Fonts). */
export function houseFaceFiles(house: HouseRoles, fontsDir: string = join(homedir(), "Library", "Fonts")): string[] {
  const out: string[] = [];
  for (const r of Object.values(house)) {
    if (typeof r !== "object" || r === null) continue;
    for (const f of r.faces ?? []) if (f.file) out.push(isAbsolute(f.file) ? f.file : join(fontsDir, f.file));
  }
  return out;
}

/**
 * The faces a HyperFrames composition embeds, read from its own `@font-face` rules (2026-10-25: the check held every
 * HyperFrames film to VideoEssay's face table, so a film set wholly in house faces failed). A face is tied to a house
 * file by content: its decoded bytes must hash to a TypeRoles.json face file, so a substitute font registered under a
 * house family name never passes as a house face. A face no house file matches keeps an empty path. Pure but for reads.
 */
export function compositionFaces(html: string, house: HouseRoles, fontsDir: string = join(homedir(), "Library", "Fonts")): FaceLike[] {
  const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const files = new Map<string, string>();
  for (const p of houseFaceFiles(house, fontsDir)) if (existsSync(p)) files.set(digest(readFileSync(p)), p);
  const out: FaceLike[] = [];
  for (const m of html.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = m[1]!;
    const family = /font-family:\s*["']?([^;"']+?)["']?\s*;/.exec(body)?.[1]?.trim();
    const data = /url\(\s*["']?data:[^;,]+;base64,([A-Za-z0-9+/=]+)/.exec(body)?.[1];
    if (!family || !data) continue;
    const w = /font-weight:\s*([a-z]+|\d+)/.exec(body)?.[1] ?? "400";
    const weight = w === "bold" ? 700 : w === "normal" ? 400 : Number(w) || 400;
    const style = /font-style:\s*(italic|oblique)/.test(body) ? "italic" : "normal";
    out.push({ id: `${family}:${weight}:${style}`, family, weight, style, path: files.get(digest(Buffer.from(data, "base64"))) ?? "" });
  }
  return out;
}

/** The words house title case leaves lowercase (Theme.ts houseTitleCase's SMALL_WORDS). */
const TITLE_SMALL = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "if", "in", "nor", "of", "off", "on", "or", "per", "so", "the", "to", "up", "via", "vs", "yet"]);

/** The text as drawn: CSS text-transform applied. */
export function drawnText(text: string, transform: string): string {
  if (transform === "uppercase") return text.toUpperCase();
  if (transform === "lowercase") return text.toLowerCase();
  if (transform === "capitalize") return text.replace(/(^|\s)(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
  return text;
}

/** Words a house title-case line would have capitalized: lowercase-initial, not a small word, no digit or inner capital. */
export function titleCaseSlips(s: string): string[] {
  return s.split(/\s+/).filter((w) => {
    const core = w.replace(/^[^\p{L}\p{N}]+/u, "");
    if (!core || !/^\p{Ll}/u.test(core) || /\d/.test(core) || /\p{Lu}/u.test(core.slice(1))) return false;
    return !TITLE_SMALL.has(core.replace(/[^\p{L}'’]+$/u, "").toLowerCase());
  });
}

/**
 * Every way the rendered text leaves the house type system. Each node's computed family, weight and style must be one
 * of the composition's embedded faces, that face's file must sit in a TypeRoles.json role at that weight and style, and
 * the drawn text must hold one of its roles' case (upper: no lowercase letter; title: no title-case slip; sentence: free).
 * Each block (the nearest non-inline box) must carry a capital: nothing on screen is all lowercase. Text inside pre/code
 * keeps its literal case. Pure.
 */
export function renderedTypeProblems(nodes: readonly RenderedText[], faces: readonly FaceLike[], house: HouseRoles): { problems: string[]; checked: number; blocks: number } {
  const problems = new Set<string>();
  const snip = (s: string) => JSON.stringify(s.trim().replace(/\s+/g, " ").slice(0, 48));
  const roles = Object.entries(house).filter((e): e is [string, Exclude<HouseRoles[string], string>] => typeof e[1] === "object" && e[1] !== null);
  const blocks = new Map<number, { text: string; code: boolean }>();
  const faceRoles = (n: RenderedText) => {
    const family = n.family.split(",")[0].trim().replace(/^["']|["']$/g, "");
    const weight = Number(n.weight), style = n.style.startsWith("italic") || n.style.startsWith("oblique") ? "italic" : "normal";
    const face = faces.find((f) => f.family === family && f.weight === weight && f.style === style);
    const file = face ? basename(face.path) : "";
    // A role names its face by file name under ~/Library/Fonts or by absolute path (houseFaceFiles reads both).
    const mine = face ? roles.filter(([, r]) => (r.faces ?? []).some((x) => basename(x.file ?? "") === file && (x.weight ?? 400) === face.weight && (x.style ?? "normal") === face.style)) : [];
    return { family, weight, style, face, file, mine };
  };
  for (const n of nodes) {
    const fr = faceRoles(n);
    // A caps face sets lowercase source as capitals, so what the viewer reads is the upper-cased text.
    const capsFace = fr.mine.length > 0 && fr.mine.every(([, r]) => r.drawsCaps === true);
    const drawn = capsFace ? drawnText(n.text, n.transform).toUpperCase() : drawnText(n.text, n.transform);
    const b = blocks.get(n.block) ?? { text: "", code: true };
    blocks.set(n.block, { text: `${b.text}${drawn}`, code: b.code && n.code });
    const { family, style, face, file, mine } = fr;
    if (!face) { problems.add(`${snip(n.text)} is set in ${family} ${n.weight}${style === "italic" ? " italic" : ""}, not one of the composition's embedded faces`); continue; }
    if (mine.length === 0) { problems.add(`${snip(n.text)} is set in ${face.id} (${file} ${face.weight}), which no TypeRoles.json role holds`); continue; }
    if (n.code) continue;
    const holds = (c: string | undefined) => (c === "upper" ? !/\p{Ll}/u.test(drawn) : c === "title" ? titleCaseSlips(drawn).length === 0 : true);
    if (!mine.some(([, r]) => holds(r.case))) {
      const want = [...new Set(mine.map(([, r]) => r.case ?? "sentence"))].join(" or ");
      const slips = mine.some(([, r]) => r.case === "title") ? ` (${titleCaseSlips(drawn).slice(0, 4).join(", ")})` : "";
      problems.add(`${snip(n.text)} in ${face.id} (house ${mine.map(([k]) => k).join("/")}) is not in ${want} case${slips}`);
    }
  }
  for (const b of blocks.values()) if (!b.code && /\p{L}/u.test(b.text) && !/\p{Lu}/u.test(b.text)) problems.add(`${snip(b.text)} is all lowercase`);
  return { problems: [...problems], checked: nodes.length, blocks: blocks.size };
}

/** What the page reports once its timelines registered and its fonts loaded: every text node with its computed face. */
const TEXT_EXPR = `(() => {
  if (!(window.__timelines && Object.keys(window.__timelines).length) || document.fonts.status !== 'loaded') return { ready: false };
  const SVG = 'http://www.w3.org/2000/svg';
  const ids = new Map();
  const blockOf = (el) => {
    const t = el.closest('text');
    if (t && t.namespaceURI === SVG) return t;
    let b = el;
    while (b.parentElement && b !== document.body && getComputedStyle(b).display.startsWith('inline')) b = b.parentElement;
    return b;
  };
  const nodes = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const text = n.textContent || '';
    if (!text.trim()) continue;
    const el = n.parentElement;
    if (!el || el.closest('script,style,noscript,template')) continue;
    const cs = getComputedStyle(el), b = blockOf(el);
    if (!ids.has(b)) ids.set(b, ids.size);
    nodes.push({ text, family: cs.fontFamily, weight: cs.fontWeight, style: cs.fontStyle, transform: cs.textTransform, code: !!el.closest('pre,code'), block: ids.get(b) });
  }
  return { ready: true, nodes };
})()`;

/** Open the built composition in the seam's pinned headless Chrome (sandboxed, no network) and read its text. */
export async function renderedText(dir: string, budgetMs = 30_000): Promise<RenderedText[]> {
  const inst = await ensureInstalled();
  const profile = mkdtempSync(join(tmpdir(), "lifeos-video-eval-type-"));
  const chrome = Bun.spawn(sandboxed([
    inst.browserPath, "--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--allow-file-access-from-files",
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost", "--window-size=1920,1080", "about:blank",
  ]), { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  let cdp: Cdp | undefined;
  try {
    cdp = await Cdp.connect(await devtoolsUrl(chrome.stderr, 20_000), 10_000);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__hyperframes = window.__hyperframes || { getVariables() { return {}; } };" }, sessionId);
    await cdp.send("Page.navigate", { url: pathToFileURL(join(dir, "index.html")).href }, sessionId);
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      await Bun.sleep(200);
      const res = await cdp.send("Runtime.evaluate", { expression: TEXT_EXPR, returnByValue: true }, sessionId).catch(() => null);
      const v = res?.result?.value as { ready?: boolean; nodes?: RenderedText[] } | undefined;
      if (v?.ready && Array.isArray(v.nodes)) return v.nodes;
    }
    throw new Error(`the composition did not register its timeline and load its fonts within ${budgetMs} ms`);
  } finally {
    cdp?.close();
    chrome.kill("SIGKILL");
    await chrome.exited;
    rmSync(profile, { recursive: true, force: true });
  }
}

async function typeRendered(ctx: EvalContext): Promise<CheckResult> {
  const c = ctx.composition();
  if ("missing" in c) return unavailable(`no built composition to read the type from: ${c.missing}`);
  const path = houseTypeRolesPath();
  if (!existsSync(path)) return unavailable(`no house type system at ${path} to hold the type to`);
  // The seam's Chrome runs under sandbox-exec, which macOS refuses inside another sandbox (a sandboxed agent shell). Say
  // so in milliseconds instead of spending seconds provisioning a browser that cannot start.
  const probe = Bun.spawnSync(sandboxed(["/usr/bin/true"]), { stdout: "ignore", stderr: "pipe" });
  if (probe.exitCode !== 0) return unavailable(`the seam's network sandbox cannot start here (${probe.stderr.toString().trim().slice(0, 120) || `exit ${probe.exitCode}`}); run the eval from an unsandboxed shell to read the composition's type`);
  const nodes = await renderedText(c.dir);
  if (nodes.length === 0) return unavailable(`the composition at ${c.dir} drew no text to measure`);
  const house = JSON.parse(readFileSync(path, "utf8")) as HouseRoles;
  // A VideoEssay run sets its configured faces; any other composition is held to the faces it embeds itself.
  const faces = ctx.runDir ? configuredFaces() : compositionFaces(readFileSync(join(c.dir, "index.html"), "utf8"), house);
  const r = renderedTypeProblems(nodes, faces, house);
  const shown = r.problems.slice(0, 12).join("; ");
  return verdict(r.problems.length === 0, r.problems.length ? `${r.problems.length} type problem(s) in ${r.checked} text nodes: ${shown}${r.problems.length > 12 ? "; …" : ""}` : `all ${r.checked} text nodes in ${r.blocks} blocks set in a house face, weight and case`, { problems: r.problems.length, nodes: r.checked });
}

/** The judge evidence: native crops, the motion strip, the contact sheet, full frames. From the run's beats, or evenly from a bare video. */
export function evidenceBoards(ctx: EvalContext): Promise<Record<VisualDim, string>> {
  return ctx.once("boards", async () => {
    const dir = join(ctx.evalDir, "judge");
    mkdirSync(dir, { recursive: true });
    const d = await ctx.duration(), th = await ctx.thumbs();
    const clamp = (t: number) => Math.max(0, Math.min(d - 0.1, t));
    const grab = async (t: number, vf: string, out: string) => { await sh(["ffmpeg", "-y", "-v", "error", "-ss", clamp(t).toFixed(3), "-i", ctx.video, "-frames:v", "1", "-vf", vf, out]); return out; };
    const grid = async (files: string[], across: number, out: string) => {
      const rows: string[] = [];
      for (let i = 0; i < files.length; i += across) { const r = join(dir, `.row${i}-${basename(out)}`); await sh(["magick", ...files.slice(i, i + across), "+append", r]); rows.push(r); }
      await sh(["magick", ...rows, "-append", out]);
      for (const r of rows) rmSync(r, { force: true });
      return out;
    };
    let cropT: number[], fullT: number[], typeT: number[], strip: string[], sheet: string[];
    if (ctx.runDir) {
      const s = ctx.script(), tl = ctx.timeline();
      const mid = (id: string) => { const b = tl.beats.find((x) => x.id === id)!; return (b.start + b.end) / 2; };
      const picks = (ids: string[], n: number) => (ids.length <= n ? ids : Array.from({ length: n }, (_, i) => ids[Math.floor((i * ids.length) / n)]));
      const type = (b: Script["beats"][number]) => (b.visual as { type?: string }).type ?? "";
      const captures = s.beats.filter((b) => CAPTURE_TYPES.includes(type(b))).map((b) => b.id);
      const texts = s.beats.filter((b) => !CAPTURE_TYPES.includes(type(b)) && type(b) !== "read").map((b) => b.id);
      cropT = fullT = picks(captures.length >= 4 ? captures : s.beats.map((b) => b.id), 4).map(mid);
      typeT = picks(texts.length >= 4 ? texts : s.beats.map((b) => b.id), 4).map(mid);
      strip = tl.beats.flatMap((b) => Array.from({ length: 6 }, (_, i) => th.at(b.start + ((b.end + tl.gap - b.start) * (i + 0.5)) / 6)));
      sheet = tl.beats.map((b) => th.at((b.start + b.end) / 2));
    } else {
      // A bare video: four evenly spaced frames for the full-frame and crop judges, one frame every 4 s for the strip
      // and sheet (rows of six, so one row is 24 s), capped at 60 frames spread evenly.
      cropT = fullT = typeT = evenTimes(d, 4);
      strip = sheet = everyTimes(d, 4, 60).map((t) => th.at(t));
    }
    const crops = await Promise.all(cropT.map((t, i) => grab(t, "crop='min(960,iw)':'min(540,ih)':(iw-ow)/2:(ih-oh)*2/5", join(dir, `.crop${i}.png`))));
    const fulls = await Promise.all(fullT.map((t, i) => grab(t, FIT(960, 540), join(dir, `.full${i}.png`))));
    const types = await Promise.all(typeT.map((t, i) => grab(t, FIT(960, 540), join(dir, `.type${i}.png`))));
    const sharpness = await grid(crops, 2, join(dir, "sharpness.png"));
    const polish = await grid(fulls, 2, join(dir, "polish.png"));
    const typography = await grid(types, 2, join(dir, "typography.png"));
    const meaning = await grid(strip, 6, join(dir, "meaning.png"));
    const variety = await grid(sheet, ctx.runDir ? 4 : 6, join(dir, "variety.png"));
    for (const f of [...crops, ...fulls, ...types]) rmSync(f, { force: true });
    return { sharpness, polish, typography, meaning, variety };
  });
}

/** The intent a run executed: Essay.md kind explainer → Explainer, a voice run → Voice, else the full essay. */
export function runIntent(runDir: string): string | null {
  const intents = join(HERE, "../../VideoEssay/Intents");
  const essay = runPaths(runDir).essay;
  const kind = existsSync(essay) ? readFileSync(essay, "utf8").match(/^kind:\s*"?(\w+)"?/m)?.[1] : undefined;
  const name = runMode(runDir) === "voice" ? "Voice" : kind === "explainer" ? "Explainer" : existsSync(essay) ? "Full" : null;
  return name && existsSync(join(intents, `${name}.md`)) ? resolve(intents, `${name}.md`) : null;
}

/** Proof run --intent on the narration; its intent findings join this receipt under `script-intent/`. */
async function scriptIntent(ctx: EvalContext): Promise<CheckResult> {
  if (!ctx.intent) return unavailable("no intent named for this video (pass --intent)");
  let narration: { text: string; source: string };
  try { narration = await ctx.narration(); } catch (e) { return unavailable(`no narration text to hold to the intent: ${(e as Error).message}`); }
  if (!narration.text.trim()) return unavailable(`the narration (${narration.source}) is empty`);
  const artifact = join(ctx.evalDir, "narration.md");
  writeFileSync(artifact, narration.text);
  const r = await sh(["bun", join(HERE, "Proof.ts"), "run", "--artifact", artifact, "--intent", ctx.intent, "--destination", "none", "--json"], { allowFail: true });
  const start = r.out.indexOf("{");
  let receipt: { verdict?: string; findings?: ProofFinding[]; ideal_state?: { criteria?: string[] }; evaluators?: Record<string, string> } | null = null;
  try { receipt = start >= 0 ? JSON.parse(r.out.slice(start)) : null; } catch { receipt = null; }
  if (!receipt?.findings) return unavailable(`Proof run --intent produced no receipt (exit ${r.code}): ${r.err.slice(-240).trim()}`);
  const findings = receipt.findings.filter((f) => f.check.startsWith("intent-")).map(({ added_at: _a, source: _s, ...f }) => ({ ...f, check: `script-intent/${f.check}` }));
  const total = receipt.ideal_state?.criteria?.length ?? 0;
  const failedIds = new Set(findings.map((f) => f.check));
  const passed = Math.max(0, total - failedIds.size);
  const blocking = findings.some((f) => f.severity === "fail"), missing = findings.some((f) => f.severity === "unavailable");
  const status: Status = blocking ? "fail" : missing ? "unavailable" : findings.length ? "flag" : "pass";
  return { status, detail: `${passed} of ${total} intent bullets passed on the narration (${narration.source}; Proof verdict ${receipt.verdict}); ${findings.map((f) => `${f.check.replace("script-intent/", "")} ${f.severity}`).join(", ") || "no findings"}`, findings, passed, models: receipt.evaluators ? Object.values(receipt.evaluators) : [] };
}

// ---------- memo ----------

export function videoEvalMemoDir(): string {
  if (process.env.LIFEOS_VIDEO_EVAL_MEMO) return process.env.LIFEOS_VIDEO_EVAL_MEMO;
  if (process.env.NODE_ENV === "test") return join(tmpdir(), `lifeos-video-eval-memo-test-${process.pid}`);
  return join(getLifeosDir(), "MEMORY", "STATE", "Proof", "video-eval-memo");
}

/** A check's version: its own source, its bar, and the bytes of every code file it names. */
export function checkVersion(def: CheckDef): string {
  return sha(JSON.stringify({ run: def.run.toString(), bar: def.bar, tier: def.tier, code: def.code.map((f) => (existsSync(f) ? sha(readFileSync(f)) : "absent")) }));
}

/** The receipt's check_set.version: the sha over the FULL set (ids and versions), whatever an intent switched off. */
export function checkSetVersion(all: readonly CheckDef[]): string {
  return sha(JSON.stringify(all.map((c) => [c.id, checkVersion(c)])));
}

export type MemoEntry = { schema: typeof MEMO_SCHEMA; key: string; check: string; at: string; result: CheckResult };

export function memoKey(check: string, version: string, inputs: Record<string, string>): string {
  return sha(JSON.stringify({ schema: MEMO_SCHEMA, check, version, inputs }));
}

export function readMemo(dir: string, key: string, check: string): MemoEntry | null {
  const p = join(dir, `${key}.json`);
  if (!existsSync(p)) return null;
  try {
    const e = JSON.parse(readFileSync(p, "utf8")) as MemoEntry;
    return e.schema === MEMO_SCHEMA && e.key === key && e.check === check && e.result && e.result.status !== "unavailable" ? e : null;
  } catch { return null; }
}

/** Persist one measured result. An unavailable result is never memoized; a judged one is stored raw (before earning). */
export function writeMemo(dir: string, e: MemoEntry): void {
  invariant(/^[0-9a-f]{64}$/.test(e.key), "a memo entry is keyed by a sha256");
  invariant(e.result.status !== "unavailable", "an unmeasured result is never memoized");
  invariant(["pass", "fail", "flag"].includes(e.result.status) && typeof e.result.detail === "string", `memo entry for ${e.check} is malformed`);
  invariant(!e.result.judge || e.result.status === (e.result.judge.ok ? "pass" : "flag"), `memo entry for ${e.check} stores a judged answer after earning, not raw`);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${e.key}.json`), tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(e));
  renameSync(tmp, p);
}

// ---------- the run ----------

export type CheckRun = { id: string; dimension: CheckDef["dimension"]; tier: ProofTier; bar: string; status: Status | "not-run"; detail: string; ms: number; memo: boolean; metrics?: Record<string, unknown>; findings?: ProofFinding[]; passed?: number; models?: string[]; judge?: JudgeAnswer; optOut?: "judges-off" };
export type BadgeOrigin = { badge_ncc: number | null; badge_present: boolean | null };
export type EvalReport = { video: string; sha256: string; runDir: string | null; intent: string | null; origin: BadgeOrigin; ranAt: string; ms: { code: number; judged: number; total: number }; verdict: string; checks: CheckRun[]; disabled: EvalDisable[]; optOuts: ProofOptOut[]; receipt: string | null; report: string };
export type RunOptions = {
  video?: string; run?: string; only?: string[]; judges?: "auto" | "always" | "never"; intent?: string; narration?: string;
  /** The intent's switch-offs, when the caller parsed them; they must equal what the intent file declares. */
  disables?: EvalDisable[];
  destination?: DestinationClass; memo?: boolean; log?: (s: string) => void; checks?: CheckDef[];
  /** No memo read or write, and no stored result of any kind (Out/verify.json, Verify's pii.json): every check re-measures the bytes. */
  fresh?: boolean;
  /** A HyperFrames project dir: the built composition type-rendered reads (the seam passes the project it rendered). */
  composition?: string;
  /** Whether a judged check (by its check id) has earned its right to block (default: LabelStore, keyed {check_id}). */
  earned?: (checkId: string) => boolean;
};

const intentLabel = (intent: string) => relative(getClaudeDir(), intent);

export async function runVideoEval(o: RunOptions): Promise<EvalReport> {
  const t0 = performance.now(), log = o.log ?? noop;
  const runDir = o.run ? resolveRunDir(o.run) : o.video ? inferRunDir(resolve(o.video)) : null;
  const video = o.video ? resolve(o.video) : runDir ? runPaths(runDir).video : "";
  invariant(video && existsSync(video), `no video at ${video || "(none given)"}`);
  const own = runDir ? runIntent(runDir) : null;
  if (runDir && own && o.intent && resolve(o.intent) !== own) throw new IntentMismatch(resolve(o.intent), own, runDir);
  const intent = o.intent ? resolve(o.intent) : own;
  if (intent && !existsSync(intent)) throw new Error(`no intent at ${intent}`);
  const all = o.checks ?? CHECKS;
  const disabled = intent ? intentFileDisables(intent) : [];
  if (o.disables) invariant(JSON.stringify(o.disables) === JSON.stringify(disabled), `the switch-offs passed are not the ones ${intent ?? "(no intent)"} declares`);
  const known = new Set([...CHECKS, ...all].map((c) => c.id));
  const badOff = disabled.filter((d) => !known.has(d.id)).map((d) => d.id);
  if (badOff.length) throw new Error(`${basename(intent ?? "")} disables check id(s) the eval set does not have: ${badOff.join(", ")} (bun skills/Assay/Tools/VideoEval.ts list)`);
  if (intent) {
    const refused = switchOffProblems(intent, disabled, { composition: !!o.composition });
    if (refused.length) throw new SwitchOffRefused(intent, refused);
  }
  if (o.composition && !existsSync(join(resolve(o.composition), "index.html"))) throw new Error(`--composition ${o.composition}: no index.html there (name the HyperFrames project dir the video was rendered from)`);
  // Origin is read from the pixels before anything is measured, so badge-bearing bytes under another intent leave no receipt.
  const measured = await badgeOrigin(video).catch((e: Error) => ({ error: e.message }));
  const originBad = originProblem(intent, measured);
  if (originBad) throw new IntentOriginMismatch(intent, "error" in measured ? null : measured.ncc, originBad);
  const origin: BadgeOrigin = "error" in measured ? { badge_ncc: null, badge_present: null } : { badge_ncc: measured.ncc, badge_present: measured.present };
  // Provenance, from the record: an intent only for bytes its pipeline rendered; a composition only when the record ties it to them.
  const sha256 = await sha256File(video);
  if (intent) {
    const p = provenanceProblem(sha256, intent);
    if (p.problem) throw new ProvenanceRefused(p.problem);
  }
  if (o.composition) {
    const c = compositionProblem(sha256, o.composition);
    if (c) throw new ProvenanceRefused(c);
  }
  const off = new Set(disabled.map((d) => d.id));
  const unknown = (o.only ?? []).filter((id) => !all.some((c) => c.id === id));
  invariant(unknown.length === 0, `unknown check id(s): ${unknown.join(", ")} (run \`VideoEval.ts list\`)`);
  const offAsked = (o.only ?? []).filter((id) => off.has(id));
  if (offAsked.length) throw new Error(`${offAsked.join(", ")}: switched off by ${basename(intent ?? "")}`);
  const live = all.filter((c) => !off.has(c.id));
  const set = o.only?.length ? live.filter((c) => o.only!.includes(c.id)) : live;
  const ctx = new EvalContext(video, runDir, intent, o.narration ?? null, { composition: o.composition, fresh: o.fresh });
  void ctx.once("input:file", async () => sha256);
  const memoDir = videoEvalMemoDir(), useMemo = o.memo !== false && o.fresh !== true;
  const earned = o.earned ?? earnedFromLabels;
  const fileSha = ctx.inputHash("file");
  const base = (def: CheckDef) => ({ id: def.id, dimension: def.dimension, tier: def.tier, bar: def.bar });

  const runOne = async (def: CheckDef): Promise<CheckRun> => {
    const t = performance.now();
    if (def.needsRun && !runDir) return { ...base(def), status: "unavailable", detail: "needs a VideoEssay run dir (script, timeline, assets); this is a bare video", ms: 0, memo: false };
    try {
      const inputs = Object.fromEntries(await Promise.all(def.inputs.map(async (n) => [n, await ctx.inputHash(n)] as const)));
      const key = memoKey(def.id, checkVersion(def), inputs);
      const hit = useMemo ? readMemo(memoDir, key, def.id) : null;
      if (hit) return { ...base(def), ...judged(hit.result, earned, def.id), ms: Math.round(performance.now() - t), memo: true };
      const result = await def.run(ctx);
      if (useMemo && result.status !== "unavailable") writeMemo(memoDir, { schema: MEMO_SCHEMA, key, check: def.id, at: new Date().toISOString(), result });
      return { ...base(def), ...judged(result, earned, def.id), ms: Math.round(performance.now() - t), memo: false };
    } catch (e) {
      return { ...base(def), status: "unavailable", detail: `could not measure: ${(e as Error).message}`, ms: Math.round(performance.now() - t), memo: false };
    }
  };

  for (const d of disabled.filter((x) => all.some((c) => c.id === x.id))) log(`− ${d.id.padEnd(26)} switched off by ${basename(intent!)}: ${d.reason}`);
  const code = set.filter((c) => c.tier === "code"), judgedSet = set.filter((c) => c.tier !== "code");
  const tc = performance.now();
  const codeRuns = await Promise.all(code.map(runOne));
  const codeMs = Math.round(performance.now() - tc);
  for (const r of codeRuns) log(line(r));
  const codeFailed = codeRuns.some((r) => r.status === "fail");
  const judges = o.judges ?? "auto";
  const tj = performance.now();
  let judgedRuns: CheckRun[];
  if (judges === "never") {
    // Never a silent skip: each judged check is unmeasured, with a judges-off opt-out, so the verdict cannot read pass.
    judgedRuns = judgedSet.map((d) => ({ ...base(d), status: "unavailable", detail: "not measured: judges off (--judges never)", ms: 0, memo: false, optOut: "judges-off" }));
  } else if (judges === "auto" && codeFailed) {
    judgedRuns = judgedSet.map((d) => ({ ...base(d), status: "not-run", detail: "not run: a code check failed, and judges run only on a clean code tier (--judges always runs them anyway)", ms: 0, memo: false }));
  } else judgedRuns = await Promise.all(judgedSet.map(runOne));
  const judgedMs = Math.round(performance.now() - tj);
  for (const r of judgedRuns) log(line(r));
  const checks = [...codeRuns, ...judgedRuns];
  const optOuts: ProofOptOut[] = [
    ...disabled.filter((d) => all.some((c) => c.id === d.id)).map((d) => ({ selector: d.id, kind: "intent-switch-off", reason: `${intentLabel(intent!)}: ${d.reason}` })),
    ...judgedRuns.filter((r) => r.optOut === "judges-off").map((r) => ({ selector: r.id, kind: "judges-off", reason: "judges:never: judged check not run (--judges never)" })),
  ];
  const report = join(ctx.evalDir, o.only?.length ? "video-eval.partial.json" : "video-eval.json");
  const ranAt = new Date().toISOString();
  invariant((await fileSha) === sha256, "the video changed while it was being evaluated");
  let receiptPath: string | null = null;
  let verdictName = "partial (no receipt)";
  if (!o.only?.length) {
    const r = buildReceipt({ video, sha256, checks, ctx, ranAt, durationMs: Math.round(performance.now() - t0), destination: o.destination ?? "handoff", judges, setVersion: checkSetVersion(all), optOuts, origin, fresh: o.fresh === true });
    receiptPath = writeReceipt(r);
    verdictName = r.verdict;
  }
  const out: EvalReport = { video, sha256, runDir, intent, origin, ranAt, ms: { code: codeMs, judged: judgedMs, total: Math.round(performance.now() - t0) }, verdict: verdictName, checks, disabled, optOuts, receipt: receiptPath, report };
  writeFileSync(report, JSON.stringify(out, null, 2));
  return out;
}

function line(r: CheckRun): string {
  const mark = { pass: "✓", fail: "✗", flag: "⚑", unavailable: "?", "not-run": "·" }[r.status];
  return `${mark} ${r.id.padEnd(26)} ${String(r.ms).padStart(6)} ms${r.memo ? " (memo)" : "       "}  ${r.detail}`;
}

/** A video inside a run's Out/ belongs to that run. */
export function inferRunDir(video: string): string | null {
  const out = dirname(video);
  const dir = dirname(out);
  return basename(out) === "Out" && existsSync(join(dir, "Script.json")) && existsSync(join(dir, "Narration", "timeline.json")) ? dir : null;
}

/** The receipt VideoEval writes: an assay receipt plus the origin the bytes showed (gates never trust it; they re-measure with badgeOrigin). */
export type VideoEvalReceipt = AssayReceipt & { origin?: BadgeOrigin };

/** The skill an intent belongs to: skills/<Skill>/Intents/<Name>.md. */
export function intentSkill(intent: string): string {
  return basename(dirname(dirname(intent)));
}

export function buildReceipt(a: { video: string; sha256: string; checks: CheckRun[]; ctx: EvalContext; ranAt: string; durationMs: number; destination: DestinationClass; judges: string; setVersion: string; optOuts?: ProofOptOut[]; origin?: BadgeOrigin; fresh?: boolean }): VideoEvalReceipt {
  const findings: ProofFinding[] = [];
  let passed = 0;
  for (const c of a.checks) {
    if (c.status === "not-run") continue;
    if (c.findings) { findings.push(...c.findings); passed += c.passed ?? 0; continue; }
    if (c.status === "pass") { passed++; continue; }
    // A judged check skipped by judges-off is an unavailable finding at tier judge (the shared receipt contract).
    const tier: ProofTier = c.optOut === "judges-off" ? "judge" : c.tier;
    findings.push({ check: c.id, tier, severity: c.status === "fail" ? "fail" : c.status === "flag" ? "flag" : "unavailable", message: c.detail, derived_from: `${c.dimension}: ${c.bar}`, ...(c.status === "fail" && c.tier !== "code" ? { earned: true } : {}) });
  }
  const { verdict, counts } = deriveVerdict(findings, passed, ASSAY_RECEIPT_SCHEMA, 0);
  const st = statSync(a.video);
  const intent = a.ctx.intent;
  const ideal: IdealStateRef = intent
    ? ({ kind: "isa", path: intent, revision: sha(readFileSync(intent)), source: "intent", skill: intentSkill(intent), intent: basename(intent, ".md") } as IdealStateRef)
    : { kind: "none", reason: "bare video: no run dir names the intent it was made for" };
  const models = [...new Set(a.checks.flatMap((c) => c.models ?? []))];
  const optOuts = a.optOuts ?? [];
  invariant(optOuts.every((x) => x.selector && (x.kind === "intent-switch-off" || x.kind === "judges-off") && x.reason.includes(": ")), "every opt-out names its check, its kind and its source");
  invariant(a.checks.filter((c) => c.optOut === "judges-off").every((c) => optOuts.some((x) => x.selector === c.id && x.kind === "judges-off")), "a judges-off check carries its opt-out");
  const r: VideoEvalReceipt = {
    schema: ASSAY_RECEIPT_SCHEMA, artifact: a.video, sha256: a.sha256, size: st.size, mtimeMs: st.mtimeMs, kind: "video", ran_at: a.ranAt, run_id: randomUUID(), duration_ms: a.durationMs,
    checks_file: null,
    profile: [`video-eval@${VIDEO_EVAL_VERSION}`, `judges:${a.judges}`, ...(a.fresh ? ["mode:fresh"] : []), ...(intent ? [`intent:${intentSkill(intent)}/${basename(intent, ".md")}`] : []), `origin:${a.origin?.badge_present == null ? "unmeasured" : a.origin.badge_present ? "essay-badge" : "no-badge"}`, ...a.checks.map((c) => `${c.id}:${c.status}${c.memo ? "(memo)" : ""}`), ...optOuts.map((x) => `${x.selector}:off(${x.kind})`), ...profileRan(a.checks)],
    verdict, counts, findings, opt_outs: optOuts,
    ideal_state: ideal,
    check_set: { version: a.setVersion, source: CODE.runner },
    evaluators: { "video-eval": VIDEO_EVAL_VERSION, ...(models.length ? { judges: models.join(",") } : {}) },
    destination: a.destination,
    verdict_at_boundary: { verdict, counts, findings: findings.length, at: a.ranAt },
    origin: a.origin ?? { badge_ncc: null, badge_present: null },
  };
  invariant(r.sha256.length === 64, "the receipt binds the video's sha256");
  return r;
}

/**
 * The checks that ran and made their own call, as bare ids for the receipt's profile (LabelStore.recordedChecks reads a
 * bare id as "ran"; one with no finding under its id is a pass). A check whose findings carry sub-ids (script-intent's
 * `script-intent/<bullet>`) is listed only when it passed, since otherwise its own id has no finding and would read as a
 * pass it never made; its sub-findings make their own calls.
 */
export function profileRan(checks: readonly Pick<CheckRun, "id" | "status" | "findings">[]): string[] {
  return checks.filter((c) => c.status !== "not-run" && (!c.findings || c.status === "pass")).map((c) => c.id);
}

/** The exit code for a report: 1 blocking (a code fail or an earned no), 2 anything unmeasured, 0 otherwise. */
export function exitCode(r: Pick<EvalReport, "checks">): 0 | 1 | 2 {
  const blocking = r.checks.some((c) => c.status === "fail" || c.findings?.some((f) => f.severity === "fail"));
  const missing = r.checks.some((c) => c.status === "unavailable" || c.findings?.some((f) => f.severity === "unavailable"));
  return blocking ? 1 : missing ? 2 : 0;
}

// ---------- CLI ----------

function arg(argv: string[], flag: string): string | undefined { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; }

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === "list") {
    for (const c of CHECKS) console.log(`${c.id.padEnd(26)} ${c.tier.padEnd(6)} ${c.dimension.padEnd(18)} ${c.bar}`);
    process.exit(0);
  }
  const judges = (arg(argv, "--judges") ?? "auto") as "auto" | "always" | "never";
  if (cmd !== "run" || (!arg(argv, "--run") && !arg(argv, "--video")) || !["auto", "always", "never"].includes(judges)) {
    console.error("usage: VideoEval.ts run (--run <slug|dir> | --video <file>) [--check id,id] [--judges auto|always|never] [--intent <file>] [--narration <file>] [--composition <project dir>] [--destination handoff|send|publish|deploy|isa-close|none] [--no-memo] [--fresh] [--json]\n       VideoEval.ts list");
    process.exit(64);
  }
  const json = argv.includes("--json");
  try {
    const r = await runVideoEval({ run: arg(argv, "--run"), video: arg(argv, "--video"), only: arg(argv, "--check")?.split(",").filter(Boolean), judges, intent: arg(argv, "--intent"), narration: arg(argv, "--narration"), composition: arg(argv, "--composition"), fresh: argv.includes("--fresh"), destination: arg(argv, "--destination") as DestinationClass | undefined, memo: !argv.includes("--no-memo"), log: json ? noop : (s) => console.log(s) });
    if (json) console.log(JSON.stringify(r, null, 2));
    else console.log(`\n${r.verdict.toUpperCase()} · code tier ${(r.ms.code / 1000).toFixed(1)} s · judged ${(r.ms.judged / 1000).toFixed(1)} s · total ${(r.ms.total / 1000).toFixed(1)} s${r.optOuts.length ? ` · ${r.optOuts.length} opt-out(s) on the receipt` : ""}\nreceipt: ${r.receipt ?? "none (a --check run writes no receipt)"}\nreport:  ${r.report}`);
    process.exit(exitCode(r));
  } catch (e) {
    console.error(`VideoEval: ${(e as Error).message}`);
    process.exit(e instanceof EvalRefusal ? 2 : 64);
  }
}
