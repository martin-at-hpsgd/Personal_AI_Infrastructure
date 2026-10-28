/**
 * VideoRecheck — the gates' own measurement of a video's bytes, run after the stored receipt is admitted
 * (ProofReceipt.releaseAdmission) and before anything leaves: an upload or publish (YouTubeUpload.ts) or a hand-off
 * (ArtDirection Deliver.ts). Stored state can only add failures; this re-measures and refuses on its own findings.
 *
 * What it trusts: the bytes, and the intent FILE the receipt names (re-read and re-hashed). What it never trusts: the
 * receipt's opt_outs, its origin field, the finding memo, Out/verify.json or any other stored result. Concretely:
 *   - the skip list is the switch-offs the intent file declares (VideoEval.intentFileDisables), never the receipt's;
 *   - the intent file must still hash to the receipt's ideal_state.revision;
 *   - the VideoEval code tier re-runs with fresh:true (no memo, no fromVerify, no stored report), as a partial run that
 *     writes no receipt, the slow whisper check only after the rest is clean;
 *   - at least one check that reads the video's bytes (file, video or audio stream) must pass: a run in which only
 *     non-byte checks passed (type-config reads the type system, never the video) measured nothing;
 *   - every code check outside that skip list must be measured: one that comes back unavailable refuses, so a pass a
 *     gate relies on is always a pass it re-measured (stored passes may only add failures);
 *   - provenance (RenderProvenance): the newest STATVS render row for these bytes must name the intent's pipeline. Bytes
 *     with no row (a remux, a crop, a covered badge, a re-encode) are refused under every intent, naming the tool to
 *     re-run. The row also says where the run-reading checks look: a VideoEssay row's artifact (an Out/essay.mp4 that
 *     still hashes to these bytes) gives the run dir, and a row's composition (its digest must still match) is passed as
 *     --composition, so card-corners, duration, voice-wer, script-length and type-rendered are measurable here;
 *   - the origin rule (content, never path), a second and independent signal: VideoEval.badgeOrigin measures the DA essay
 *     avatar badge on the bytes, and badge-bearing bytes may be admitted only under VideoEssay Full or Explainer. A remux
 *     keeps the pixels, so it keeps the badge and the refusal;
 *   - outside tests, a store override (LIFEOS_PROOF_RECEIPTS, LIFEOS_VIDEO_EVAL_MEMO, STATVS_DIR) refuses (gateEnvProblem).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { invariant } from "../Invariant.ts";
import { DA_ESSAY_INTENTS, intentRelPath, isAssayReceipt, receiptIntent, type ProofReceipt } from "./ProofReceipt.ts";
import { compositionDigest, fileSha256, gateEnvProblem, provenanceProblem, type RenderHit, type RenderLookup } from "./RenderProvenance.ts";

const VIDEO_EVAL = "../../../skills/Assay/Tools/VideoEval.ts";
/** Inputs that are the video's own bytes; a check reading none of them measures something else (type system, config). */
export const BYTE_INPUTS: readonly string[] = ["file", "video-stream", "audio-stream"];
/** Code checks slow enough (whisper) to run only after every other code check is clean, so a bad cut refuses in seconds. */
export const SLOW_RECHECKS: readonly string[] = ["voice-wer"];

export type CheckLine = { id: string; status: string; detail: string };
export type VideoEvalRunner = (o: { video: string; run?: string; intent?: string; composition?: string; only: string[]; memo: false; fresh: true; judges: "never" }) => Promise<{ receipt: string | null; checks: CheckLine[] }>;
export type BadgeOrigin = (video: string) => Promise<{ ncc: number; present: boolean }>;
type CheckDefLike = { id: string; tier: string; inputs: readonly string[] };
export interface RecheckDeps {
  runner?: VideoEvalRunner;
  badge?: BadgeOrigin;
  /** The eval set's checks (VideoEval.CHECKS) and intent parser (VideoEval.intentFileDisables); loaded when absent. */
  checks?: readonly CheckDefLike[];
  intentDisables?: (intent: string) => { id: string; reason: string }[];
  /** The newest STATVS render row for some bytes (default: RenderProvenance.renderOf). */
  render?: RenderLookup;
  /** The environment the gate runs in (default process.env): outside tests a store override refuses. */
  env?: NodeJS.ProcessEnv;
}

/** What the re-measure found on the exact bytes, and why it refuses (`problem`), or null. */
export interface CodeTierRecheck {
  ran: string[];
  failed: { id: string; detail: string }[];
  passed: number;
  /** Passed checks that read the video's bytes. */
  measured: string[];
  unavailable: string[];
  /** Every check line the re-measure returned, as measured. */
  checks: CheckLine[];
  /** The skip list, from the intent file. */
  skipped: string[];
  intent: string | null;
  /** The render row the bytes were admitted on (pipeline, artifact, composition), or null when there was none. */
  render: RenderHit | null;
  /** The run dir and composition the run-reading checks were given, from the render row. */
  run: string | null;
  composition: string | null;
  badge: { ncc: number; present: boolean } | null;
  ms: number;
  problem: string | null;
}

/** The run dir a render belongs to (VideoEval's own rule: Out/ beside Script.json and Narration/timeline.json), or null. */
export function runDirOf(source: string): string | null {
  const out = dirname(resolve(source)), dir = dirname(out);
  return basename(out) === "Out" && existsSync(join(dir, "Script.json")) && existsSync(join(dir, "Narration", "timeline.json")) ? dir : null;
}

/**
 * Re-measure `bytes` (the exact file about to leave: an upload snapshot, or the artifact handed off) for the receipt
 * it was admitted on. `source` is the file the principal named; where the run-reading checks look (run dir, composition)
 * comes from the bytes' render row, never from where a file sits.
 * Never throws for a measurement problem: every one is returned in `problem`, which the caller refuses on.
 */
export async function recheckCodeTier(source: string, bytes: string, receipt: ProofReceipt, deps: RecheckDeps = {}): Promise<CodeTierRecheck> {
  const t0 = performance.now();
  const intent = receiptIntent(receipt);
  const result: CodeTierRecheck = { ran: [], failed: [], passed: 0, measured: [], unavailable: [], checks: [], skipped: [], intent, render: null, run: null, composition: null, badge: null, ms: 0, problem: null };
  const done = (problem: string | null): CodeTierRecheck => ({ ...result, problem, ms: Math.round(performance.now() - t0) });

  const envBad = gateEnvProblem(deps.env ?? process.env);
  if (envBad) return done(envBad);
  let VE: Record<string, unknown> | null = null;
  const ve = async () => (VE ??= (await import(VIDEO_EVAL)) as Record<string, unknown>);
  const checks = deps.checks ?? ((await ve()).CHECKS as CheckDefLike[]);
  const parse = deps.intentDisables ?? ((await ve()).intentFileDisables as RecheckDeps["intentDisables"]);
  const badge = deps.badge ?? ((await ve()).badgeOrigin as BadgeOrigin | undefined);
  const runner = deps.runner ?? ((await ve()).runVideoEval as unknown as VideoEvalRunner);

  // 1. The intent file, re-read: still the bytes the receipt was measured against, and the only source of the skip list.
  if (intent) {
    if (!existsSync(intent)) return done(`the intent the receipt names is gone: ${intent}`);
    const now = createHash("sha256").update(readFileSync(intent)).digest("hex");
    if (isAssayReceipt(receipt) && receipt.ideal_state.kind === "isa" && now !== receipt.ideal_state.revision) return done(`the intent ${intent} changed since the receipt (revision ${receipt.ideal_state.revision.slice(0, 12)}… ≠ now ${now.slice(0, 12)}…)`);
    try { result.skipped = (parse as NonNullable<RecheckDeps["intentDisables"]>)(intent).map((d) => d.id); }
    catch (e) { return done(`the intent ${intent} does not parse: ${(e as Error).message}`); }
  }
  // 1b. Provenance: the bytes are the receipt's, and their newest render row names the intent's pipeline.
  let sha: string;
  try { sha = fileSha256(bytes); } catch (e) { return done(`the bytes could not be read to hash: ${(e as Error).message}`); }
  if (sha !== receipt.sha256) return done(`the bytes about to leave (sha256 ${sha.slice(0, 12)}…) are not the bytes the receipt describes (${receipt.sha256.slice(0, 12)}…)`);
  const prov = provenanceProblem(sha, intent, { lookup: deps.render });
  result.render = prov.hit;
  if (prov.problem) return done(prov.problem);
  const hit = prov.hit!;
  const skip = new Set(result.skipped);
  const ids = checks.filter((c) => c.tier === "code" && !skip.has(c.id)).map((c) => c.id);
  invariant(ids.length > 0, "the VideoEval code tier has no check left to re-run");

  // 2. Origin, by content: the DA essay badge on the bytes admits only the DA essay intents. Runs beside the fast pass.
  const rel = intent ? intentRelPath(intent) : null;
  const originP: Promise<string | null> = (async () => {
    if (typeof badge !== "function") return "the DA essay badge detector (VideoEval.badgeOrigin) is not available, so the video's origin cannot be measured";
    try {
      result.badge = await badge(bytes);
    } catch (e) { return `the DA essay badge could not be measured on the bytes: ${(e as Error).message}`; }
    if (result.badge.present && !(rel && DA_ESSAY_INTENTS.includes(rel)))
      return `the bytes carry the DA essay badge (template match ${result.badge.ncc.toFixed(3)}), so they are a VideoEssay render and may be admitted only under ${DA_ESSAY_INTENTS.join(" or ")}; this receipt was measured under ${rel ?? intent ?? "no intent"}`;
    return null;
  })();

  // 3. Where the run-reading checks look, from the render row only (never from where the file happens to sit): a
  // VideoEssay row's artifact, while it still hashes to these bytes, gives the run dir; a row's composition, while it
  // still hashes to the digest the row recorded, is the built composition type-rendered reads.
  let run: string | null = null;
  if (hit.pipeline === "VideoEssay" && existsSync(hit.artifact)) {
    let same = resolve(hit.artifact) === resolve(bytes);
    if (!same) { try { same = fileSha256(hit.artifact) === sha; } catch { same = false; } }
    if (same) run = runDirOf(hit.artifact);
  }
  let composition: string | null = null, compositionNote = "";
  if (hit.composition) {
    let now: string | null = null;
    try { now = existsSync(join(hit.composition, "index.html")) ? compositionDigest(hit.composition) : null; } catch { now = null; }
    if (now && now === hit.composition_digest) composition = hit.composition;
    else compositionNote = `; the composition the render row names (${hit.composition}) ${now ? "changed since the render" : "is gone"}, so it was not read`;
  }
  result.run = run;
  result.composition = composition;
  void source; // the file the principal named; where the checks look comes from the render row, never from it

  // 4. The code tier, fresh, on the exact bytes. `only` makes it a partial run, which writes no receipt.
  const lines: CheckLine[] = [];
  let runError: string | null = null;
  for (const only of [ids.filter((id) => !SLOW_RECHECKS.includes(id)), ids.filter((id) => SLOW_RECHECKS.includes(id))]) {
    if (only.length === 0 || lines.some((c) => c.status === "fail")) continue;
    let r: Awaited<ReturnType<VideoEvalRunner>>;
    try {
      r = await runner({ video: bytes, ...(run ? { run } : {}), ...(intent ? { intent } : {}), ...(composition ? { composition } : {}), only, memo: false, fresh: true, judges: "never" });
    } catch (e) { runError = `the VideoEval code tier could not run on the exact bytes: ${(e as Error).message}`; break; }
    invariant(r.receipt === null, "the re-measure of the code tier wrote a receipt; it must only measure");
    lines.push(...r.checks);
    result.ran.push(...only);
  }
  const byteIds = new Set(checks.filter((c) => c.inputs.some((i) => BYTE_INPUTS.includes(i))).map((c) => c.id));
  result.checks = lines;
  result.failed = lines.filter((c) => c.status === "fail").map((c) => ({ id: c.id, detail: c.detail }));
  result.passed = lines.filter((c) => c.status === "pass").length;
  result.measured = lines.filter((c) => c.status === "pass" && byteIds.has(c.id)).map((c) => c.id);
  result.unavailable = lines.filter((c) => c.status === "unavailable").map((c) => c.id);
  const origin = await originP;

  if (origin) return done(origin);
  if (runError) return done(runError);
  if (result.failed.length) return done(`the VideoEval code tier, re-measured on the exact bytes, fails ${result.failed.length} check(s): ${result.failed.map((f) => `${f.id} (${f.detail})`).join("; ")}`);
  // Every code check the intent does not switch off must be measured: a gate admits only what it re-measured.
  if (result.unavailable.length) return done(`the VideoEval code tier, re-measured on the exact bytes, could not measure ${result.unavailable.length} check(s) the intent does not switch off, and a gate admits only what it re-measured: ${lines.filter((c) => c.status === "unavailable").map((c) => `${c.id} (${c.detail})`).join("; ")}${run ? "" : hit.pipeline === "VideoEssay" ? "; the render row's artifact no longer holds these bytes inside a run, so no run dir was read" : ""}${compositionNote}`);
  if (result.measured.length === 0) return done(`the VideoEval code tier, re-measured on the exact bytes, measured nothing on them: no check that reads the video passed (${result.passed} non-byte check(s) passed; ${result.unavailable.length} unavailable${result.unavailable.length ? `: ${result.unavailable.join(", ")}` : ""})`);
  return done(null);
}

/** Why a re-measure refuses, or null. */
export function recheckProblem(c: Pick<CodeTierRecheck, "problem">): string | null {
  return c.problem;
}

/** The one line a gate prints for an admitted re-measure. */
export function recheckLine(c: CodeTierRecheck): string {
  return `code tier re-measured on the exact bytes: ${c.measured.length} byte check(s) and ${c.passed - c.measured.length} other(s) passed${c.unavailable.length ? `, ${c.unavailable.length} unavailable (${c.unavailable.join(", ")})` : ""}${c.render ? `; rendered by ${c.render.pipeline} (render row ${c.render.ts})` : ""}${c.badge ? `; DA essay badge ${c.badge.present ? "present" : "absent"} (${c.badge.ncc.toFixed(3)})` : ""} in ${(c.ms / 1000).toFixed(1)} s`;
}
