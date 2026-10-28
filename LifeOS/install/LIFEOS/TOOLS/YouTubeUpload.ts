#!/usr/bin/env bun
/**
 * YouTubeUpload.ts — upload a video to the principal's YouTube channel, set its
 * thumbnail, and flip its privacy, through the YouTube Data API v3.
 *
 * Auth: the Google Desktop OAuth client (USER/CONFIG/CREDENTIALS/google/client_secret.json) plus
 * YOUTUBE_OAUTH_REFRESH_TOKEN from ~/.claude/.env (minted by
 * LIFEOS/TOOLS/Conveyor/YouTubeAuth.ts with youtube + youtube.upload scopes).
 * Token values are never printed.
 *
 * Usage:
 *   bun YouTubeUpload.ts upload --file <mp4> --title "<t>" [--description-file <txt>]
 *       [--tags "a,b,c"] [--category 28] [--privacy private|unlisted|public]
 *       --thumbnail <png|jpg> [--language en] [--json] [--pii-reviewed | --skip-pii --reason "<why>"]
 *     → refuses (exit 2) without --thumbnail; then runs the video PII gate (LIFEOS/TOOLS/VideoPiiGate.ts) on the file BEFORE anything leaves
 *       the machine; findings refuse the upload until the principal has read them and it is re-run
 *       with --pii-reviewed. --skip-pii bypasses the scan (Gemini down), never routine: it needs --reason "<why>"
 *       AND an unexpired authorization for the file's exact bytes (VideoPiiGate.ts approve-skip, run by the
 *       principal in his own terminal); both are printed and recorded. A file that is not a video is refused.
 *       Then uploads (resumable, 8 MB chunks, resumes on 308), sets the thumbnail,
 *       reads the video back and prints id + watch URL + status. The scan result and the sha256 of the
 *       uploaded file are recorded against the video id (MEMORY/STATE/youtube-pii.jsonl) for `publish`.
 *   bun YouTubeUpload.ts thumbnail --id <videoId> --file <png|jpg>
 *   bun YouTubeUpload.ts status --id <videoId> [--json]
 *   bun YouTubeUpload.ts list [--max 25] [--json]
 *     → the channel's most recent uploads with id, title, publishedAt, privacy and description.
 *   bun YouTubeUpload.ts set-description --id <videoId> --description-file <txt>
 *     → fetches the current snippet, swaps only the description, videos.update, read-back.
 *   bun YouTubeUpload.ts set-title --id <videoId> --title "<t>"
 *     → same shape: swaps only the title, videos.update, read-back.
 *   bun YouTubeUpload.ts publish --id <videoId> --privacy public|unlisted|private --yes [--no-promote]
 *       [--file <the uploaded mp4>] [--pii-reviewed | --skip-pii --reason "<why>"]
 *     → privacy changes are a write to a live public channel: --yes is required.
 *       Going public or unlisted needs PII evidence for the uploaded bytes: a clean or reviewed scan of the
 *       sha256 `upload` recorded, or --file to scan the local copy now, which must hash to that sha256.
 *       Otherwise it refuses (exit 1). --skip-pii --reason passes only with an unexpired approve-skip authorization
 *       for the uploaded sha256; a video with no recorded upload sha256 cannot be skipped.
 *       A video going public for the first time also gets its standing paid promotion
 *       (YouTubePromote.ts auto; shape and on/off in USER/CONFIG/google-ads.json). --no-promote skips it.
 *   bun YouTubeUpload.ts comment --id <videoId> --text "<t>"
 *     → posts a top-level comment as the channel (commentThreads.insert, needs the
 *       youtube.force-ssl scope — re-run YouTubeAuth.ts if the token predates it), read-back.
 *       PINNING has no API: pin in the browser (Interceptor, watch page or Studio comments).
 *   bun YouTubeUpload.ts watermark-unset --yes
 *     → removes the channel-wide video watermark (watermarks.unset on the authorized channel); --yes required. YouTube
 *       draws it bottom-right over every video, where the DA badge sits (principal directive, 2026-10-24: remove it).
 *   bun YouTubeUpload.ts delete --id <videoId> --yes
 *     → PERMANENT (video, views, comments); --yes required; confirms gone via read-back.
 *
 * Assay gate (principal directive, 2026-10-24): `upload` (the video, and its --thumbnail), `thumbnail`, and `publish` to public or
 *   unlisted each refuse bytes with no passing Assay receipt (ProofReceipt.releaseAdmission, bound by sha256; any receipt
 *   for the same bytes that records a failure refuses). A video needs its VideoEval receipt, and the refusal prints
 *   bun ~/.claude/skills/VideoEssay/Tools/Run.ts eval --video <file> --intent <intent.md>; other files print the Proof
 *   command. On upload and on publish the gate re-measures the video bytes itself (LIFEOS/TOOLS/lib/VideoRecheck.ts: the
 *   code tier fresh, the skip list from the intent file, the DA essay badge origin rule). The gate runs before the PII scan,
 *   so a refused video never reaches Gemini. Open unearned flags are admitted and printed.
 *
 * Exit: 0 ok · 1 API/gate failure · 2 bad input.
 *
 * Every upload is created PRIVATE, whatever --privacy says; the requested --privacy public|unlisted is applied only after
 * the post-upload integrity check (stat and sha256 of the scanned snapshot) passes. Default privacy is PRIVATE: the sanctioned shape is upload private → thumbnail →
 * read back → `publish --privacy public --yes` once the watch page has been checked.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync, chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readSync, readFileSync, rmSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { invariant } from "./Invariant.ts";
import { getClaudeDir, lifeosPath } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { findPiiSkipApprovalForSha, isVideoFile, videoPiiGate } from "./VideoPiiGate";
import {
  admitReceipt, receiptId, releaseAdmission, videoEvalCommand, type PresentVerdict, type ProofReceipt, type ReleaseAdmission, type ReleaseBoundary,
} from "./lib/ProofReceipt";
import { recordOutput, type RecordResult } from "./lib/OutputLedger";
import { recheckCodeTier, recheckLine, recheckProblem } from "./lib/VideoRecheck";

const CLIENT_PATH = lifeosPath("USER", "CONFIG", "CREDENTIALS", "google", "client_secret.json");
const ENV_PATH = join(getClaudeDir(), ".env");
const CHUNK = 8 * 1024 * 1024;
const API = "https://www.googleapis.com/youtube/v3";

type Args = Record<string, string | boolean>;
function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : "";
  const args: Args = {};
  for (let i = cmd ? 1 : 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i++; }
  }
  return { cmd, args };
}
const { cmd, args } = parseArgs(process.argv.slice(2));
const asJson = args.json === true;
function die(msg: string, code = 2): never { console.error(`YouTubeUpload: ${msg}`); process.exit(code); }

// ── Video PII gate (OPERATIONAL_PREFERENCES § Content pipeline: every video publishing path runs it before upload) ──
// The scan is bound to bytes: `upload` records the sha256 of the file it sent, and `publish` accepts only a clean or
// reviewed scan of that same sha (a `--file` must hash to it). A skip needs `--reason`, which is recorded and printed.
export type PiiStatus = "clean" | "reviewed" | "skipped";
/** stage "upload": the file `upload` sent (its sha256 is the video's bytes). stage "publish": a scan or skip at publish. */
export interface PiiRecord { videoId: string; stage: "upload" | "publish"; file?: string; bytes?: number; sha256?: string; pii: PiiStatus; reason?: string; at: string }
export function piiLedgerPath(): string {
  return process.env.LIFEOS_YOUTUBE_PII_LEDGER || lifeosPath("MEMORY", "STATE", "youtube-pii.jsonl");
}
export function recordPiiScan(rec: Omit<PiiRecord, "at">): void {
  invariant(/^[\w-]{6,}$/.test(rec.videoId), `PII record needs a YouTube video id, got ${rec.videoId}`);
  invariant(rec.stage === "upload" || rec.stage === "publish", `PII record stage must be upload|publish, got ${rec.stage}`);
  invariant(["clean", "reviewed", "skipped"].includes(rec.pii), `PII status must be clean|reviewed|skipped, got ${rec.pii}`);
  invariant(rec.sha256 === undefined || /^[0-9a-f]{64}$/.test(rec.sha256), "PII record sha256 must be a sha256 hex digest");
  invariant(rec.pii === "skipped" || rec.sha256 !== undefined, "a clean or reviewed PII record needs the sha256 of the scanned file");
  invariant(rec.stage !== "upload" || (rec.sha256 !== undefined && Number.isInteger(rec.bytes) && rec.bytes! > 0 && !!rec.file), "an upload PII record needs the uploaded file, its size and its sha256");
  invariant(rec.pii !== "skipped" || (typeof rec.reason === "string" && rec.reason.trim().length > 0), "a skipped PII scan needs a --reason");
  const path = piiLedgerPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({ ...rec, at: new Date().toISOString() }) + "\n");
}
function piiRecords(videoId: string): PiiRecord[] {
  let raw = "";
  try { raw = readFileSync(piiLedgerPath(), "utf8"); } catch { return []; }
  const out: PiiRecord[] = [];
  for (const line of raw.split("\n")) {
    try {
      const r = JSON.parse(line) as PiiRecord;
      if (r?.videoId === videoId) out.push(r);
    } catch { /* not a record */ }
  }
  return out;
}
/** The sha256 of the bytes `upload` sent for this video, or null when no upload of it is recorded. */
export function uploadedShaFor(videoId: string): string | null {
  const up = piiRecords(videoId).filter((r) => r.stage === "upload" && typeof r.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.sha256));
  return up.at(-1)?.sha256 ?? null;
}
/** The newest clean or reviewed scan of the uploaded bytes (same sha256). A skipped scan, or a scan of other bytes, is no evidence. */
export function piiClearedFor(videoId: string): PiiRecord | null {
  const sha = uploadedShaFor(videoId);
  if (!sha) return null;
  return piiRecords(videoId).filter((r) => r.sha256 === sha && (r.pii === "clean" || r.pii === "reviewed")).at(-1) ?? null;
}
export type PublishPiiDecision = "none" | "scan" | "cleared" | "skipped" | "refuse" | "unbound" | "mismatch" | "no-reason" | "unauthorized";
/**
 * What `publish` must do before a privacy write: nothing (going private); bypass, only with a reason AND an unexpired
 * VideoPiiGate authorization (approve-skip) for the uploaded sha ("unbound" when no upload sha is recorded,
 * "unauthorized" when none covers it); with --file, the file must hash to the uploaded sha ("unbound" / "mismatch"),
 * then a recorded clean scan of that sha is accepted or the file is scanned now; without --file, a recorded scan or refuse.
 */
export function publishPiiDecision(privacy: string, o: { fileSha?: string; skip: boolean; reason?: string; uploadedSha: string | null; cleared: PiiRecord | null; skipApproved?: boolean }): PublishPiiDecision {
  if (privacy === "private") return "none";
  if (o.skip) {
    if (!o.reason || !o.reason.trim()) return "no-reason";
    if (!o.uploadedSha) return "unbound";
    return o.skipApproved === true ? "skipped" : "unauthorized";
  }
  if (o.fileSha !== undefined) {
    if (!o.uploadedSha) return "unbound";
    if (o.fileSha !== o.uploadedSha) return "mismatch";
    return o.cleared ? "cleared" : "scan";
  }
  return o.cleared ? "cleared" : "refuse";
}
/** sha256 of a file, read in 8 MB chunks so a long video never loads whole. */
export function fileSha256(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    for (;;) { const n = readSync(fd, buf, 0, buf.length, null); if (n === 0) break; hash.update(buf.subarray(0, n)); }
  } finally { closeSync(fd); }
  return hash.digest("hex");
}
/** The --reason a --skip-pii must carry; refuses (exit 2) without one. */
function skipReason(): string | undefined {
  if (args["skip-pii"] !== true) return undefined;
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (!reason) die(`--skip-pii needs --reason "<why the scan cannot run>"; the reason is recorded in ${piiLedgerPath()}`);
  process.stderr.write(`⚠️  PII gate SKIPPED (--skip-pii). Reason: ${reason}. Do not make this routine.\n`);
  return reason;
}
/** Scan a video before it leaves the machine. Refuses (exit 1) on findings without --pii-reviewed, or when the scan cannot run. */
async function piiGateFile(file: string, reason: string | undefined): Promise<PiiStatus> {
  invariant(existsSync(file), `video file missing: ${file}`);
  const skip = reason !== undefined, reviewed = args["pii-reviewed"] === true;
  // A file the gate does not see as a video would pass it as status "none", scanned or skipped alike, so it never ships.
  requireVideoFile(file);
  const gate = await videoPiiGate([file], { reviewed, skip, skipReason: reason, log: (s) => process.stderr.write(`${s}\n`) });
  if (!gate.ok) die(`PII gate refused ${file}. ${gate.message}`, 1);
  if (skip) return "skipped";
  return gate.reports.some((r) => r.findings.length) ? "reviewed" : "clean";
}
/**
 * Scan the local copy at publish time and return its PII status, but only when the bytes scanned are the bytes that
 * were hashed: the stat taken before hashing, and the sha256, must both be unchanged after the scan. A publish scan
 * used to record the pre-scan hash, so a file swapped while Gemini looked at it certified bytes nobody scanned
 *. Throws, recording nothing, when the file changed.
 */
export async function scanBoundToHash(snapshot: ScannedFileSnapshot, scan: (file: string) => Promise<PiiStatus>, rehash: (path: string) => string = fileSha256, statNow: (path: string) => ScannedFile["stat"] = statSync): Promise<PiiStatus> {
  const pii = await scan(snapshot.path);
  const changed = snapshotChangeProblem({ ...snapshot, pii }, statNow(snapshot.path)) ?? (rehash(snapshot.path) !== snapshot.sha256 ? `${snapshot.path} no longer hashes to the sha256 checked before the scan` : null);
  if (changed) throw new Error(`${changed}; no PII clearance is recorded. Rerun publish once the file is stable.`);
  return pii;
}
/** A file's identity before a scan: its path, sha256 and stat. */
export type ScannedFileSnapshot = Omit<ScannedFile, "pii" | "reason">;

/** `admit` (the Assay gate) runs after the PII decision and any recorded skip, and before a scan sends the video to Gemini. */
async function publishPiiGate(admit: () => Promise<void>): Promise<void> {
  const id = str("id"), privacy = str("privacy");
  const file = str("file", false) ? resolve(str("file", false)) : undefined;
  if (file) invariant(existsSync(file), `video file missing: ${file}`);
  const reason = privacy === "private" ? undefined : skipReason();
  // stat BEFORE hashing: a write during the hash moves mtime/ctime, which the post-scan check sees.
  const st0 = file ? statSync(file) : undefined;
  const fileSha = file && privacy !== "private" && reason === undefined ? fileSha256(file) : undefined;
  const uploadedSha = uploadedShaFor(id);
  // A skip at publish needs the same separate authorization as every other pipeline's skip, bound to the uploaded bytes.
  const approval = reason !== undefined && uploadedSha ? findPiiSkipApprovalForSha(uploadedSha) : null;
  const decision = publishPiiDecision(privacy, { fileSha, skip: args["skip-pii"] === true, reason, uploadedSha, cleared: piiClearedFor(id), skipApproved: approval !== null });
  if (decision === "unauthorized") die(`refusing to make ${id} ${privacy} unscanned: no unexpired authorization covers its uploaded bytes (sha256 ${uploadedSha!.slice(0, 12)}…). A --skip-pii reason alone authorizes nothing. Scan it with --file <the uploaded mp4>, or the principal runs, in the principal's own terminal: bun LIFEOS/TOOLS/VideoPiiGate.ts approve-skip <the uploaded mp4> --reason "<why the scan cannot run>"`, 1);
  if (decision === "refuse") die(`refusing to make ${id} ${privacy}: no PII scan of its uploaded bytes is recorded. Pass --file <the uploaded mp4> to scan it now (or --skip-pii --reason "<why>", loudly, if Gemini is down).`, 1);
  if (decision === "unbound") die(`refusing to make ${id} ${privacy}: no upload of it is recorded with a sha256, so neither --file nor a skip authorization can be tied to the video's bytes. Re-upload through this tool.`, 1);
  if (decision === "mismatch") die(`refusing to make ${id} ${privacy}: ${file} is not the file that was uploaded (sha256 ${fileSha!.slice(0, 12)}… ≠ uploaded ${uploadedSha!.slice(0, 12)}…).`, 1);
  if (decision === "no-reason") die(`--skip-pii needs --reason "<why>"`);
  if (decision === "skipped") recordPiiScan({ videoId: id, stage: "publish", sha256: uploadedSha!, pii: "skipped", reason: `${approval!.reason} (authorization ${approval!.id}; caller: ${reason})` });
  await admit();
  if (decision === "scan") {
    const snapshot: ScannedFileSnapshot = { path: file!, sha256: fileSha!, stat: { size: st0!.size, mtimeMs: st0!.mtimeMs, ctimeMs: st0!.ctimeMs, ino: st0!.ino } };
    let pii: PiiStatus;
    try { pii = await scanBoundToHash(snapshot, (f) => piiGateFile(f, undefined)); }
    catch (e) { die(`refusing to make ${id} ${privacy}: ${(e as Error).message}`, 1); }
    recordPiiScan({ videoId: id, stage: "publish", file: file!, bytes: st0!.size, sha256: fileSha!, pii: pii! });
  }
}
function str(k: string, required = true): string {
  const v = args[k];
  if (typeof v !== "string") { if (required) die(`--${k} is required`); return ""; }
  return v;
}

// ── Assay receipt gate (principal directive, 2026-10-24: nothing leaves without its eval set) ──
// Nothing reaches YouTube without a fresh Assay receipt for its exact bytes: the video at upload, the thumbnail when it
// is set, and the uploaded bytes when a video goes public or unlisted. The rule is ProofReceipt.releaseAdmission, the
// one Deliver.ts applies too: every receipt in the store for the sha is read and any recorded failure refuses; a video
// needs its VideoEval receipt (evaluator "video-eval"), with switch-offs only from allowlisted intents of its own
// pipeline and no judges-off skip; an unmeasured receipt is refused for public or unlisted and admitted with a printed
// line for a private upload. The stored receipt can only add failures: on upload (the snapshot) and on publish (a local
// copy of the uploaded bytes) VideoRecheck re-measures the bytes itself (fresh, no memo, no stored result, no receipt;
// skip list from the intent file; the DA essay badge admits only VideoEssay Full or Explainer), and refuses on its own.
export const PROOF_TOOL = join(getClaudeDir(), "skills", "Assay", "Tools", "Proof.ts");
const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.split("'").join(`'\\''`)}'`);
/** The exact command that writes the receipt this gate reads, for a file that is not a video. */
export function proofCommand(file: string): string {
  return `bun ${shellQuote(PROOF_TOOL)} run --artifact ${shellQuote(resolve(file))} --destination publish`;
}
/** The command that writes the receipt for `file`: VideoEval through Run.ts for a video, Proof for anything else. */
export function fixCommand(a: ReleaseAdmission, file: string): string {
  return a.video ? (a.fix ?? videoEvalCommand(file)) : proofCommand(file);
}
export type AssayAdmission = ReleaseAdmission;
/** The release rule over one receipt verdict, as ProofReceipt.admitReceipt states it (no rule lives here). */
export function admissionFrom(v: PresentVerdict, name: string, boundary: ReleaseBoundary = "public"): AssayAdmission {
  return admitReceipt(v, { name, artifact: null, boundary });
}
/** May these exact bytes go where `boundary` says? ProofReceipt.releaseAdmission, with the sha the caller computed. Read-only. */
export async function assayAdmission(file: string, sha256?: string, boundary: ReleaseBoundary = "public"): Promise<AssayAdmission> {
  const abs = resolve(file);
  return releaseAdmission({ artifact: abs, sha256: sha256 ?? fileSha256(abs), boundary });
}
/** Refuse (exit 1) with the command that produces the receipt, or print the admission line. Returns the admitted receipt and sha256. */
async function requireAssay(action: string, file: string, sha256: string | undefined, boundary: ReleaseBoundary): Promise<{ sha: string; admission: AssayAdmission }> {
  const sha = sha256 ?? fileSha256(resolve(file));
  const a = await assayAdmission(file, sha, boundary);
  if (!a.ok) die(`refusing to ${action} ${file}: no passing Assay receipt for these exact bytes (${a.reason}). Produce it with: ${fixCommand(a, file)}`, 1);
  process.stderr.write(a.line ? `Assay: ${a.line}. Say so when presenting.\n` : `Assay: ${a.reason}\n`);
  return { sha, admission: a };
}

/** What the gate admitted, carried to the output line written once the bytes have left: the receipt's file and whether a line was owed. */
export type AdmittedVideo = { receiptArtifact: string; labelled: boolean };
let uploadAdmitted: AdmittedVideo | null = null;
let publishAdmitted: (AdmittedVideo & { local: string }) | null = null;

/**
 * The output line for a video that left for YouTube (OutputLedger, the existing writer): boundary publish (send for a
 * private upload), channel youtube, kind video, the bytes sent, the admitting receipt's store key. Written after the
 * transmit or privacy write returned, so an Errata complaint about the video joins to its receipt. Never throws.
 */
export function recordYouTubeOutput(artifact: string, admitted: AdmittedVideo, boundary: "send" | "publish"): RecordResult {
  try {
    return recordOutput({
      session_id: process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "no-session",
      boundary, channel: "youtube", kind: "video", target: "youtube", artifact,
      receipt_id: receiptId(admitted.receiptArtifact), decision: admitted.labelled ? "allowed-labelled" : "allowed",
      reason: admitted.labelled ? "sent with open flags or an unmeasured receipt, named at the gate" : "admitted by its Assay receipt and the code-tier re-measure",
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    try { process.stderr.write(`output ledger: the YouTube line was not written: ${error}\n`); } catch { /* stderr closed */ }
    return { ok: false, error };
  }
}

/** A file the PII gate does not see as a video is refused before anything else reads it. */
function requireVideoFile(file: string): void {
  if (!isVideoFile(file)) die(`PII gate scans video files only; ${file} has neither a video extension nor a video container header`, 1);
}
/**
 * The upload's admission, run on the snapshot BEFORE the PII scan, so a refused video never reaches Gemini: the stored
 * receipt (releaseAdmission), then the code tier re-run on the snapshot bytes, then the thumbnail's receipt.
 */
async function uploadAdmission(source: string, snap: VideoSnapshot, privacy: string): Promise<string | undefined> {
  requireVideoFile(snap.path);
  const boundary: ReleaseBoundary = privacy === "private" ? "upload-private" : "public";
  const { admission } = await requireAssay("upload", source, snap.sha256, boundary);
  invariant(admission.receipt !== null, "an admitted upload has the receipt it was admitted on");
  const c = await recheckCodeTier(source, snap.path, admission.receipt);
  const problem = recheckProblem(c);
  if (problem) die(`refusing to upload ${source}: ${problem}. Fix the render, then: ${fixCommand(admission, source)}`, 1);
  process.stderr.write(`Assay: ${recheckLine(c)}\n`);
  uploadAdmitted = { receiptArtifact: admission.receipt.artifact, labelled: admission.line !== null };
  const thumb = str("thumbnail", false);
  return thumb ? (await requireAssay("set as the thumbnail", resolve(thumb), undefined, boundary)).sha : undefined;
}
/** `publish` to public or unlisted: the uploaded bytes (sha256 recorded by `upload`) must carry a passing receipt, checked before any PII scan. */
async function publishAssayGate(): Promise<void> {
  const id = str("id"), privacy = str("privacy");
  if (privacy === "private") return;
  const sha = uploadedShaFor(id);
  if (!sha) die(`refusing to make ${id} ${privacy}: no upload of it is recorded with a sha256, so no Assay receipt can be tied to its bytes. Re-upload through this tool.`, 1);
  const file = piiRecords(id).filter((r) => r.stage === "upload" && r.sha256 === sha).at(-1)?.file;
  const a = await releaseAdmission({ artifact: file ?? null, sha256: sha, boundary: "public", video: true, name: file ? basename(file) : id });
  if (!a.ok) die(`refusing to make ${id} ${privacy}: no passing Assay receipt for its uploaded bytes (${a.reason}). Produce it with: ${a.fix ?? videoEvalCommand(file ?? "<the uploaded mp4>")}`, 1);
  invariant(a.receipt !== null, "an admitted publish has the receipt it was admitted on");
  // The gate re-measures the uploaded bytes itself (VideoRecheck): a local copy that still hashes to the uploaded sha256,
  // --file first, then the file `upload` recorded. With neither on this machine, nothing can be re-measured: refuse.
  const local = [str("file", false) ? resolve(str("file", false)) : null, file ?? null].find((p) => p !== null && existsSync(p) && fileSha256(p) === sha) ?? null;
  if (!local) die(`refusing to make ${id} ${privacy}: the uploaded bytes (sha256 ${sha.slice(0, 12)}…) are not on this machine to re-measure. Pass --file <the uploaded mp4>.`, 1);
  const c = await recheckCodeTier(local, local, a.receipt);
  const problem = recheckProblem(c);
  if (problem) die(`refusing to make ${id} ${privacy}: ${problem}. Fix the render, then: ${a.fix ?? videoEvalCommand(local)}`, 1);
  process.stderr.write(a.line ? `Assay: ${a.line}. Say so when presenting.\n` : `Assay: ${a.reason}\n`);
  process.stderr.write(`Assay: ${recheckLine(c)}\n`);
  publishAdmitted = { local, receiptArtifact: a.receipt.artifact, labelled: a.line !== null };
}

/**
 * The refresh token in .env text. YouTubeAuth.ts appends a fresh line on every authorization, so the
 * LAST entry is the current one (dotenv's own last-wins rule); the first would pin a revoked token.
 */
export function refreshTokenFromEnvText(text: string): string | null {
  const lines = text.split("\n").filter((l) => l.startsWith("YOUTUBE_OAUTH_REFRESH_TOKEN="));
  const line = lines[lines.length - 1];
  if (!line) return null;
  const v = line.slice("YOUTUBE_OAUTH_REFRESH_TOKEN=".length).trim().replace(/^["']|["']$/g, "");
  return v || null;
}

function loadRefreshToken(): string {
  const fromEnv = process.env.YOUTUBE_OAUTH_REFRESH_TOKEN;
  if (fromEnv) return fromEnv;
  if (!existsSync(ENV_PATH)) die(`no YOUTUBE_OAUTH_REFRESH_TOKEN in env and ${ENV_PATH} missing`);
  const token = refreshTokenFromEnvText(readFileSync(ENV_PATH, "utf8"));
  if (!token) die("YOUTUBE_OAUTH_REFRESH_TOKEN not set — run LIFEOS/TOOLS/Conveyor/YouTubeAuth.ts");
  return token;
}

async function accessToken(): Promise<string> {
  if (!existsSync(CLIENT_PATH)) die(`OAuth client missing at ${CLIENT_PATH}`);
  const client = JSON.parse(readFileSync(CLIENT_PATH, "utf8")).installed;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id, client_secret: client.client_secret,
      refresh_token: loadRefreshToken(), grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(30000),
  });
  const j = (await r.json()) as Record<string, string>;
  if (!r.ok || !j.access_token) die(`token refresh failed (${r.status}): ${j.error ?? "no access_token"}`, 1);
  const scope = j.scope ?? "";
  invariant(scope.includes("youtube.upload") || scope.includes("auth/youtube"), "refresh token lacks the youtube/youtube.upload scope");
  return j.access_token;
}

async function api(token: string, method: string, path: string, body?: unknown, raw?: { data: Uint8Array; contentType: string }) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(raw ? { "Content-Type": raw.contentType } : body ? { "Content-Type": "application/json" } : {}),
    },
    body: raw ? new Blob([raw.data as BlobPart]) : body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(raw ? 120000 : 30000),
  });
  const text = await r.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!r.ok) die(`${method} ${path} → ${r.status}: ${json?.error?.message ?? text.slice(0, 300)}`, 1);
  return json;
}

async function readBack(token: string, id: string) {
  const j = await api(token, "GET", `/videos?part=snippet,status,contentDetails,processingDetails&id=${encodeURIComponent(id)}`);
  const v = j?.items?.[0];
  invariant(v, `video ${id} not found on read-back`);
  return {
    id: v.id, url: `https://www.youtube.com/watch?v=${v.id}`, title: v.snippet?.title,
    privacy: v.status?.privacyStatus, uploadStatus: v.status?.uploadStatus,
    processing: v.processingDetails?.processingStatus, duration: v.contentDetails?.duration,
    thumbnail: v.snippet?.thumbnails?.maxres?.url ?? v.snippet?.thumbnails?.high?.url ?? null,
    madeForKids: v.status?.selfDeclaredMadeForKids ?? null, category: v.snippet?.categoryId,
  };
}

/** The channel's most recent uploads, newest first, with their descriptions. */
async function listUploads(token: string, max: number) {
  const ch = await api(token, "GET", "/channels?part=contentDetails&mine=true");
  const uploads = ch?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  invariant(uploads, "could not resolve the channel's uploads playlist");
  const items: any[] = [];
  let pageToken = "";
  while (items.length < max) {
    const page = await api(token, "GET", `/playlistItems?part=snippet,status&playlistId=${uploads}&maxResults=${Math.min(50, max - items.length)}${pageToken ? "&pageToken=" + pageToken : ""}`);
    for (const it of page?.items ?? []) {
      items.push({
        id: it.snippet?.resourceId?.videoId, title: it.snippet?.title, publishedAt: it.snippet?.publishedAt,
        privacy: it.status?.privacyStatus ?? null, description: it.snippet?.description ?? "",
      });
    }
    pageToken = page?.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return items.slice(0, max);
}

/** Sends exactly the bytes whose Assay receipt was admitted (`admittedSha256`, from requireAssay); changed bytes are refused. */
async function setThumbnail(token: string, id: string, file: string, admittedSha256: string) {
  invariant(existsSync(file), `thumbnail file missing: ${file}`);
  invariant(/^[0-9a-f]{64}$/.test(admittedSha256), "a thumbnail is set only with the sha256 its Assay receipt was admitted for");
  const bytes = statSync(file).size;
  invariant(bytes > 0 && bytes <= 2 * 1024 * 1024, `thumbnail must be ≤ 2 MB for the API (got ${(bytes / 1e6).toFixed(2)} MB) — downscale/compress first`);
  const ct = /\.png$/i.test(file) ? "image/png" : "image/jpeg";
  const data = new Uint8Array(readFileSync(file));
  invariant(createHash("sha256").update(data).digest("hex") === admittedSha256, `thumbnail ${file} changed after its Assay receipt was checked; nothing was sent`);
  const r = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(id)}&uploadType=media`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": ct }, body: data, signal: AbortSignal.timeout(120000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) die(`thumbnails.set → ${r.status}: ${j?.error?.message ?? "unknown"}`, 1);
  return j?.items?.[0]?.maxres?.url ?? j?.items?.[0]?.high?.url ?? "set";
}

/**
 * No chapter markers, when the channel says so: LIFEOS/USER/CONFIG/youtube.json {"noChapterMarkers": true}.
 * Absent or false, descriptions pass through untouched. YouTube turns three or more lines that begin with a timestamp, the first at 00:00, into a
 * chapter bar. A description that would do that is refused; sections stay as the ✓ topic list.
 * --allow-chapters overrides for a deliberate exception and says so.
 */
function channelRefusesChapters(): boolean {
  try {
    const file = lifeosPath("USER", "CONFIG", "youtube.json");
    return existsSync(file) && (JSON.parse(readFileSync(file, "utf8")) as { noChapterMarkers?: unknown }).noChapterMarkers === true;
  } catch { return false; }
}

function assertNoChapterMarkers(description: string): void {
  if (!channelRefusesChapters()) return;
  const stamped = description.split("\n").filter((l) => /^\s*\d{1,2}:\d{2}(:\d{2})?\b/.test(l));
  const wouldRenderChapters = stamped.length >= 3 && stamped.some((l) => /^\s*0?0:00(:00)?\b/.test(l));
  if (!wouldRenderChapters) return;
  if (args["allow-chapters"] === true) {
    console.error(`⚠ --allow-chapters: description carries ${stamped.length} timestamp lines; YouTube will render a chapter bar`);
    return;
  }
  die(
    `description carries ${stamped.length} timestamp lines starting at 00:00, which YouTube renders as chapter markers. ` +
      `Chapters are off on this channel (USER/CONFIG/youtube.json): keep the sections as the ✓ topic list without timestamps, or pass --allow-chapters for a deliberate exception.`,
    3,
  );
}

/**
 * The file as it stood when hashed and scanned; the upload must send exactly that (ctime cannot be set back).
 * `path` is what is scanned and sent; `source`, when set, is the file the principal named, of which `path` is a snapshot.
 */
export interface ScannedFile { path: string; source?: string; sha256: string; pii: PiiStatus; reason?: string; stat: { size: number; mtimeMs: number; ctimeMs: number; ino: number } }

// ── Immutable upload snapshot ──
// The scan and the upload read one private copy of the video, never the mutable source path, so a file re-rendered or
// swapped after the scan cannot be what YouTube receives. The copy is a clone where the filesystem allows (APFS), so a
// long video costs no extra disk until the source is rewritten.
const SNAPSHOT_PREFIX = ".ytupload-";
/** A private, read-only copy of a video: `path` in its own 0700 directory `dir`, hashed and stat-ed after the copy. */
export type VideoSnapshot = ScannedFileSnapshot & { source: string; dir: string };

/**
 * Copy `source` to a 0400 file in a fresh 0700 `.ytupload-*` directory under the first writable parent (its own
 * directory first, so the copy can be a clone on the same volume, then the temp dir), keeping the file name so the
 * extension check still applies, and hash the copy. Everything downstream reads the copy.
 */
export function snapshotVideo(source: string, parents: string[] = [dirname(resolve(source)), tmpdir()]): VideoSnapshot {
  const src = resolve(source);
  const st = statSync(src);
  invariant(st.isFile() && st.size > 0, `video file is not a non-empty regular file: ${src}`);
  let dir: string | null = null;
  let lastErr: unknown = null;
  for (const parent of parents) {
    try { dir = mkdtempSync(join(parent, SNAPSHOT_PREFIX)); break; } catch (e) { lastErr = e; }
  }
  invariant(dir !== null, `could not create an upload snapshot directory under ${parents.join(", ")}: ${(lastErr as Error)?.message ?? lastErr}`);
  try {
    chmodSync(dir, 0o700);
    const copy = join(dir, basename(src));
    copyFileSync(src, copy, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE);
    chmodSync(copy, 0o400);
    const cst = lstatSync(copy);
    invariant(cst.isFile() && cst.size > 0, `upload snapshot of ${src} is not a non-empty regular file`);
    const sha256 = fileSha256(copy);
    return { path: copy, source: src, dir, sha256, stat: { size: cst.size, mtimeMs: cst.mtimeMs, ctimeMs: cst.ctimeMs, ino: cst.ino } };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Remove a snapshot made by `snapshotVideo`. Refuses any directory that is not one of ours; a second call is a no-op. */
export function disposeVideoSnapshot(snap: VideoSnapshot): void {
  invariant(basename(snap.dir).startsWith(SNAPSHOT_PREFIX), `refusing to remove ${snap.dir}: not an upload snapshot directory`);
  invariant(dirname(snap.path) === snap.dir, `refusing to remove ${snap.dir}: ${snap.path} is not its snapshot file`);
  let st;
  try { st = lstatSync(snap.dir); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  invariant(st.isDirectory(), `refusing to remove ${snap.dir}: not a real directory`);
  rmSync(snap.dir, { recursive: true, force: true });
}

/**
 * Snapshot `source`, run `admit` on the snapshot (its sha256 is known; the Assay gate runs here), PII-scan the snapshot
 * only once admitted, and hand exactly that snapshot to `send`. A refused video therefore never reaches the PII
 * scanner. The snapshot is removed afterwards, including when the process exits mid-way (a refusal exits through `die`).
 */
export async function scanAndUploadSnapshot<T>(
  source: string, scan: (path: string) => Promise<PiiStatus>, send: (scanned: ScannedFile) => Promise<T>, reason?: string,
  admit?: (snap: VideoSnapshot) => Promise<void>,
): Promise<T> {
  const snap = snapshotVideo(source);
  const onExit = () => { try { disposeVideoSnapshot(snap); } catch { /* exiting anyway */ } };
  process.once("exit", onExit);
  try {
    if (admit) await admit(snap);
    const pii = await scan(snap.path);
    return await send({ path: snap.path, source: snap.source, sha256: snap.sha256, stat: snap.stat, pii, ...(reason ? { reason } : {}) });
  } finally {
    process.off("exit", onExit);
    disposeVideoSnapshot(snap);
  }
}
/** `thumbnailSha256` is the sha256 the thumbnail's Assay receipt was admitted for; a thumbnail without it is never sent. */
export interface UploadOptions { title: string; description: string; tags: string[]; privacy: string; category: string; language: string; thumbnailFile?: string; thumbnailSha256?: string; /** What the Assay gate admitted: the upload writes its output line with it. */ admitted?: AdmittedVideo }

/**
 * The visibility every upload is created with. Bytes leave the machine private no matter what was requested; the requested
 * visibility is applied only after the post-upload integrity check passes (see `applyRequestedVisibility`).
 */
export const UPLOAD_INITIAL_PRIVACY = "private" as const;

/** Why the file on disk is not the snapshot that was scanned, or null when it is the same file. */
export function snapshotChangeProblem(scanned: ScannedFile, after: { size: number; mtimeMs: number; ctimeMs: number; ino: number }): string | null {
  const s0 = scanned.stat;
  if (after.size !== s0.size || after.mtimeMs !== s0.mtimeMs || after.ctimeMs !== s0.ctimeMs || after.ino !== s0.ino)
    return `${scanned.path} changed while it was being scanned or uploaded`;
  return null;
}

let PRIVACY_POLL_MS = 5000;
/** Test hook: shorten the wait between privacy read-backs. */
export function __setPrivacyPollMs(ms: number): void { PRIVACY_POLL_MS = ms; }

/** Flip a private upload to the requested visibility and confirm by read-back. A no-op for private. */
export async function applyRequestedVisibility(token: string, id: string, privacy: string): Promise<void> {
  if (privacy === UPLOAD_INITIAL_PRIVACY) return;
  await api(token, "PUT", `/videos?part=status`, { id, status: { privacyStatus: privacy, selfDeclaredMadeForKids: false, embeddable: true, license: "youtube" } });
  // the status write is accepted before videos.list reflects it; poll briefly (observed ~5-10s lag)
  let back = await readBack(token, id);
  for (let i = 0; i < 6 && back.privacy !== privacy; i++) {
    await new Promise((res) => setTimeout(res, PRIVACY_POLL_MS));
    back = await readBack(token, id);
  }
  invariant(back.privacy === privacy, `read-back privacy ${back.privacy} ≠ requested ${privacy}`);
}

/** Send the scanned file through a resumable session created PRIVATE. Failures throw, so `main` prints them and exits 1 and a test can observe them. */
async function resumableSend(token: string, scanned: ScannedFile, o: UploadOptions): Promise<{ id: string; size: number }> {
  const file = scanned.path;
  const size = statSync(file).size;
  invariant(size > 0, "video file is empty");
  const meta = {
    snippet: { title: o.title, description: o.description, tags: o.tags, categoryId: o.category, defaultLanguage: o.language, defaultAudioLanguage: o.language },
    // Always private on the way in: a public or unlisted video must not be reachable before the integrity check passes.
    status: { privacyStatus: UPLOAD_INITIAL_PRIVACY, selfDeclaredMadeForKids: false, embeddable: true, license: "youtube" },
  };
  // 1. open a resumable session
  const init = await fetch(`https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": String(size),
    },
    body: JSON.stringify(meta),
    signal: AbortSignal.timeout(30000),
  });
  if (!init.ok) throw new Error(`resumable init → ${init.status}: ${(await init.text()).slice(0, 300)}`);
  const session = init.headers.get("location");
  invariant(session, "no resumable session URL returned");

  // 2. stream the file in chunks; 308 = keep going, 200/201 = done
  const fd = openSync(file, "r");
  let offset = 0; let result: any = null; let attempts = 0;
  process.stderr.write(`YouTubeUpload: uploading ${(size / 1e6).toFixed(0)} MB\n`);
  try {
    while (offset < size) {
      const len = Math.min(CHUNK, size - offset);
      const buf = new Uint8Array(len);
      readSync(fd, buf, 0, len, offset);
      const end = offset + len - 1;
      let r: Response;
      try {
        r = await fetch(session, {
          method: "PUT",
          headers: { "Content-Length": String(len), "Content-Range": `bytes ${offset}-${end}/${size}` },
          body: buf,
          signal: AbortSignal.timeout(120000),
        });
      } catch (e) {
        // A dropped socket mid-chunk throws instead of returning a status (killed a 16.8 GB upload
        // at first hit, 2026-09-01). Same recovery as a 5xx: back off, ask the session where it
        // left off, continue.
        if (attempts >= 5) throw new Error(`chunk PUT network failure after ${attempts} retries: ${e}`);
        attempts++;
        await new Promise((res) => setTimeout(res, 1000 * 2 ** attempts));
        try {
          const q = await fetch(session, { method: "PUT", headers: { "Content-Length": "0", "Content-Range": `bytes */${size}` }, signal: AbortSignal.timeout(30000) });
          const range = q.headers.get("range");
          offset = range ? Number(range.split("-")[1]) + 1 : offset;
        } catch { /* keep the current offset; the next chunk PUT retries it */ }
        continue;
      }
      if (r.status === 308) {
        const range = r.headers.get("range");
        offset = range ? Number(range.split("-")[1]) + 1 : end + 1;
        attempts = 0;
        process.stderr.write(`\r  ${((offset / size) * 100).toFixed(1)}%`);
      } else if (r.ok) {
        result = await r.json(); offset = size;
        process.stderr.write("\r  100%\n");
      } else if ((r.status >= 500 || r.status === 429) && attempts < 5) {
        attempts++;
        await new Promise((res) => setTimeout(res, 1000 * 2 ** attempts));
        // ask the session where it left off
        const q = await fetch(session, { method: "PUT", headers: { "Content-Length": "0", "Content-Range": `bytes */${size}` }, signal: AbortSignal.timeout(30000) });
        const range = q.headers.get("range");
        offset = range ? Number(range.split("-")[1]) + 1 : offset;
      } else {
        throw new Error(`chunk PUT → ${r.status}: ${(await r.text()).slice(0, 300)}`);
      }
    }
  } finally { closeSync(fd); }
  invariant(result?.id, "upload finished without a video id");
  return { id: result.id as string, size };
}

/**
 * Upload `scanned` as a PRIVATE video, verify the bytes on disk are still the scanned snapshot (stat and sha256), record the
 * PII scan, and only then apply the requested visibility. A changed file leaves the video private and unrecorded.
 */
export async function performUpload(token: string, scanned: ScannedFile, o: UploadOptions, rehash: (path: string) => string = fileSha256) {
  const file = scanned.path;
  invariant(existsSync(file), `video file missing: ${file}`);
  invariant(["private", "unlisted", "public"].includes(o.privacy), "--privacy must be private|unlisted|public");
  invariant(!o.thumbnailFile || /^[0-9a-f]{64}$/.test(o.thumbnailSha256 ?? ""), "a thumbnail is set only with the sha256 its Assay receipt was admitted for; nothing was uploaded");
  // Before any byte leaves: the file must still be the scanned snapshot, or nothing is sent at all.
  const before = snapshotChangeProblem(scanned, statSync(file)) ?? (rehash(file) !== scanned.sha256 ? `${file} no longer hashes to the scanned sha256` : null);
  if (before) throw new Error(`${before}; nothing was uploaded.`);
  const { id, size } = await resumableSend(token, scanned, o);
  const changed = snapshotChangeProblem(scanned, statSync(file)) ?? (rehash(file) !== scanned.sha256 ? `${file} no longer hashes to the scanned sha256` : null);
  if (changed) throw new Error(`${changed}; video ${id} stays private and has no PII record. Delete it and upload again.`);
  recordPiiScan({ videoId: id, stage: "upload", file: resolve(scanned.source ?? file), bytes: size, sha256: scanned.sha256, pii: scanned.pii, ...(scanned.reason ? { reason: scanned.reason } : {}) });

  // 3. thumbnail (optional), 4. requested visibility, only now, 5. read back
  let thumb: string | null = null;
  if (o.thumbnailFile) thumb = await setThumbnail(token, id, o.thumbnailFile, o.thumbnailSha256 ?? "");
  await applyRequestedVisibility(token, id, o.privacy);
  const back = await readBack(token, id);
  invariant(back.privacy === o.privacy, `read-back privacy ${back.privacy} ≠ requested ${o.privacy}`);
  if (o.admitted) recordYouTubeOutput(file, o.admitted, o.privacy === "private" ? "send" : "publish");
  return { ...back, thumbnailSet: thumb, bytes: size };
}

async function upload(token: string, scanned: ScannedFile, thumbnailSha256?: string) {
  const file = scanned.path;
  invariant(existsSync(file), `video file missing: ${file}`);
  const title = str("title");
  invariant(title.length > 0 && title.length <= 100, "title must be 1–100 chars");
  const descFile = str("description-file", false);
  const description = descFile ? readFileSync(descFile, "utf8") : str("description", false);
  invariant(description.length <= 5000, "description must be ≤ 5000 chars");
  invariant(!/[<>]/.test(description), "YouTube rejects < and > in descriptions");
  assertNoChapterMarkers(description);
  const tags = str("tags", false) ? str("tags", false).split(",").map((t) => t.trim()).filter(Boolean) : [];
  const privacy = str("privacy", false) || "private";
  invariant(["private", "unlisted", "public"].includes(privacy), "--privacy must be private|unlisted|public");
  const category = str("category", false) || "28";
  const language = str("language", false) || "en";
  const out = await performUpload(token, scanned, { title, description, tags, privacy, category, language, thumbnailFile: str("thumbnail", false) || undefined, thumbnailSha256, ...(uploadAdmitted ? { admitted: uploadAdmitted } : {}) });
  if (asJson) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`✅ uploaded ${out.id}  ${out.url}`);
    console.log(`   title    ${out.title}`);
    console.log(`   privacy  ${out.privacy} · upload ${out.uploadStatus} · processing ${out.processing ?? "?"}`);
    console.log(`   thumb    ${out.thumbnailSet ?? "(none set)"}`);
  }
}

async function main() {
  if (!cmd) die("command required: upload | thumbnail | status | set-description | set-title | comment | publish | delete");
  // The PII gate runs before the OAuth token is fetched: nothing touches the channel until it passes.
  // The scan and the upload both read one immutable snapshot of --file, so the bytes sent are the bytes scanned.
  if (cmd === "upload") {
    const path = resolve(str("file"));
    invariant(existsSync(path), `video file missing: ${path}`);
    const reason = skipReason();
    const privacy = str("privacy", false) || "private";
    invariant(["private", "unlisted", "public"].includes(privacy), "--privacy must be private|unlisted|public");
    // Every video carries its own thumbnail, made by its thumbnail intent and passed here: a video uploaded bare shows
    // YouTube's auto-picked frame (principal directive, 2026-10-25).
    if (!str("thumbnail", false)) die("refusing to upload without --thumbnail <jpg|png>: every video carries the thumbnail its intent made (a failed thumbnail is fixed, not skipped)", 2);
    // Order: snapshot and its sha256, then the Assay gate (stored receipt + code tier re-run on those bytes), and only
    // then the PII scan, which sends the video to Gemini; the OAuth token is fetched last.
    let thumbSha: string | undefined;
    return scanAndUploadSnapshot(path, (p) => piiGateFile(p, reason), async (scanned) => upload(await accessToken(), scanned, thumbSha), reason,
      async (snap) => { thumbSha = await uploadAdmission(path, snap, privacy); });
  }
  // The Assay gate runs before the PII gate here too, so a refused video is never scanned by Gemini at publish.
  if (cmd === "publish" && args.yes === true) await publishPiiGate(publishAssayGate);
  const thumbSha = cmd === "thumbnail" ? (await requireAssay("set as the thumbnail", resolve(str("file")), undefined, "public")).sha : "";
  const token = await accessToken();
  if (cmd === "thumbnail") {
    const id = str("id"); const url = await setThumbnail(token, id, resolve(str("file")), thumbSha);
    const back = await readBack(token, id);
    console.log(asJson ? JSON.stringify({ ...back, thumbnailSet: url }, null, 2) : `✅ thumbnail set on ${id} → ${url}`);
    return;
  }
  if (cmd === "list") {
    const max = Number(str("max", false) || "25");
    invariant(Number.isInteger(max) && max > 0 && max <= 500, "--max must be 1..500");
    const rows = await listUploads(token, max);
    if (asJson) { console.log(JSON.stringify(rows, null, 2)); return; }
    for (const r of rows) console.log(`${r.id}  ${(r.publishedAt ?? "").slice(0, 10)}  ${r.privacy ?? "?"}  ${r.title}`);
    return;
  }
  if (cmd === "status") {
    const back = await readBack(token, str("id"));
    console.log(asJson ? JSON.stringify(back, null, 2) : `${back.id} · ${back.privacy} · upload ${back.uploadStatus} · processing ${back.processing} · ${back.url}`);
    return;
  }
  if (cmd === "set-description") {
    const id = str("id");
    const description = readFileSync(str("description-file"), "utf8");
    invariant(description.length > 0 && description.length <= 5000, "description must be 1–5000 chars");
    invariant(!/[<>]/.test(description), "YouTube rejects < and > in descriptions");
    assertNoChapterMarkers(description);
    const cur = await api(token, "GET", `/videos?part=snippet&id=${encodeURIComponent(id)}`);
    const snippet = cur?.items?.[0]?.snippet;
    invariant(snippet, `video ${id} not found`);
    snippet.description = description;
    await api(token, "PUT", `/videos?part=snippet`, { id, snippet });
    // videos.list can serve a stale replica for a few seconds after the write
    let got = "";
    for (let i = 0; i < 6; i++) {
      const check = await api(token, "GET", `/videos?part=snippet&id=${encodeURIComponent(id)}`);
      got = check?.items?.[0]?.snippet?.description ?? "";
      if (got.trim() === description.trim()) break;
      await new Promise((res) => setTimeout(res, 5000));
    }
    invariant(got.trim() === description.trim(), "description read-back does not match what was sent after 30s");
    console.log(asJson ? JSON.stringify({ id, descriptionChars: got.length }, null, 2) : `✅ description updated on ${id} (${got.length} chars)`);
    return;
  }
  if (cmd === "set-title") {
    const id = str("id");
    const title = str("title").trim();
    invariant(title.length > 0 && title.length <= 100, "title must be 1–100 chars");
    invariant(!/[<>]/.test(title), "YouTube rejects < and > in titles");
    const cur = await api(token, "GET", `/videos?part=snippet&id=${encodeURIComponent(id)}`);
    const snippet = cur?.items?.[0]?.snippet;
    invariant(snippet, `video ${id} not found`);
    snippet.title = title;
    await api(token, "PUT", `/videos?part=snippet`, { id, snippet });
    let got = "";
    for (let i = 0; i < 6; i++) {
      const check = await api(token, "GET", `/videos?part=snippet&id=${encodeURIComponent(id)}`);
      got = check?.items?.[0]?.snippet?.title ?? "";
      if (got === title) break;
      await new Promise((res) => setTimeout(res, 5000));
    }
    invariant(got === title, "title read-back does not match what was sent after 30s");
    console.log(asJson ? JSON.stringify({ id, title: got }, null, 2) : `✅ title updated on ${id}: ${got}`);
    return;
  }
  if (cmd === "publish") {
    const id = str("id"); const privacy = str("privacy");
    invariant(["private", "unlisted", "public"].includes(privacy), "--privacy must be private|unlisted|public");
    if (args.yes !== true) die(`refusing to change privacy of ${id} without --yes (this is a live channel write)`);
    const before = await readBack(token, id);
    await api(token, "PUT", `/videos?part=status`, { id, status: { privacyStatus: privacy, selfDeclaredMadeForKids: false, embeddable: true, license: "youtube" } });
    // the status write is accepted before videos.list reflects it — poll briefly (observed ~5–10s lag)
    let after = await readBack(token, id);
    for (let i = 0; i < 6 && after.privacy !== privacy; i++) {
      await new Promise((res) => setTimeout(res, 5000));
      after = await readBack(token, id);
    }
    invariant(after.privacy === privacy, `privacy read-back ${after.privacy} ≠ requested ${privacy} after 30s`);
    if (publishAdmitted && privacy !== "private") recordYouTubeOutput(publishAdmitted.local, publishAdmitted, "publish");
    console.log(asJson ? JSON.stringify({ before: before.privacy, after }, null, 2) : `✅ ${id} ${before.privacy} → ${after.privacy}  ${after.url}`);
    // Standing directive: every video that goes public gets one promotion. YouTubePromote `auto`
    // owns the shape, the on/off switch and the one-per-video rule; --no-promote skips it for this call.
    // A promotion failure never un-publishes or fails the publish: it is reported and left for a retry.
    if (privacy === "public" && before.privacy !== "public" && args["no-promote"] !== true) {
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync("bun", [join(import.meta.dir, "YouTubePromote.ts"), "auto", "--video", id, "--title", after.title], { encoding: "utf-8" });
      const tail = ((r.stdout ?? "") + (r.stderr ?? "")).trim().split("\n").slice(-2).join(" | ");
      console.error(r.status === 0 ? `📣 promote: ${tail}` : `⚠️ promote FAILED (video is still public; retry: bun YouTubePromote.ts auto --video ${id} --title "<title>"): ${tail}`);
    }
    return;
  }
  if (cmd === "comment") {
    const id = str("id"); const text = str("text");
    invariant(text.trim().length > 0, "comment text must not be empty");
    const j = await api(token, "POST", "/commentThreads?part=snippet", { snippet: { videoId: id, topLevelComment: { snippet: { textOriginal: text } } } });
    const cid = j?.id; invariant(cid, "commentThreads.insert returned no id");
    const back = await api(token, "GET", `/commentThreads?part=snippet&id=${encodeURIComponent(cid)}`);
    const got = back?.items?.[0]?.snippet?.topLevelComment?.snippet;
    invariant(got?.textOriginal === text, `comment ${cid} read-back text mismatch`);
    console.log(asJson ? JSON.stringify({ commentId: cid, videoId: id, author: got.authorDisplayName, text }, null, 2) : `✅ comment ${cid} on ${id} as ${got.authorDisplayName} — pin it in the browser (no API for pinning)`);
    return;
  }
  if (cmd === "watermark-unset") {
    if (args.yes !== true) die("refusing to remove the channel watermark without --yes (it changes every video on the channel)");
    const ch = await api(token, "GET", "/channels?part=id,snippet&mine=true");
    const channel = ch?.items?.[0];
    invariant(channel?.id, "no channel for the authorized account");
    await api(token, "POST", `/watermarks/unset?channelId=${encodeURIComponent(channel.id)}`);
    console.log(asJson ? JSON.stringify({ watermark: "unset", channelId: channel.id, channel: channel.snippet?.title }, null, 2) : `✅ watermark removed from ${channel.snippet?.title} (${channel.id})`);
    return;
  }
  if (cmd === "delete") {
    const id = str("id");
    if (args.yes !== true) die(`refusing to DELETE ${id} without --yes (irreversible: video, views, and comments are permanently destroyed)`);
    const before = await readBack(token, id);
    await api(token, "DELETE", `/videos?id=${encodeURIComponent(id)}`);
    // videos.list on a deleted id returns an empty items array — confirm it is gone
    let gone = false;
    for (let i = 0; i < 6 && !gone; i++) {
      const j = await api(token, "GET", `/videos?part=status&id=${encodeURIComponent(id)}`);
      gone = !j?.items?.length;
      if (!gone) await new Promise((res) => setTimeout(res, 5000));
    }
    invariant(gone, `video ${id} still listed 30s after delete`);
    console.log(asJson ? JSON.stringify({ deleted: id, wasTitle: before.title, wasPrivacy: before.privacy }, null, 2) : `✅ DELETED ${id} ("${before.title}", was ${before.privacy})`);
    return;
  }
  die(`unknown command ${cmd}`);
}
if (import.meta.main) main().catch((e) => { console.error(`YouTubeUpload: ${e?.message ?? e}`); process.exit(1); });
