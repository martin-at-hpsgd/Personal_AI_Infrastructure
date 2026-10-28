#!/usr/bin/env bun
/**
 * VideoPiiGate.ts — scan a finished video for PII and sensitive content before it ships.
 *
 * Why: the realistic leak in a talking-head + screen-share recording is something that
 * flashed on screen (an invoice, an address bar, a credential, a Messages window, a
 * calendar) or something said out loud (a phone number, a home address). Nothing in any
 * publishing path looked for it. This gate does, on every export, clip, and upload, for
 * well under a dollar an hour of video.
 *
 * How: the PII prompt and schema run through Assay's video judge (LIFEOS/ASSAY/VideoJudge.ts), which owns the
 * Gemini upload, the request, the Google egress check and the cleanup. Long videos are split into stream-copied chunks (default 30 min) so each request stays
 * far under the model's context; each chunk's REAL ffprobe duration accumulates into
 * global timestamps. Uploaded files are deleted from Google's store after the scan.
 *
 * This is model judgment, not a pattern detector. Exit 1 means "review these with
 * timestamps", never "blocked" — the principal decides. Exit 0 never skips other gates.
 *
 * Lives in LIFEOS/TOOLS because it is consumed across skills: video skill (export + clips),
 * social-platform skill post.ts, broadcast skill post/article, and project publish scripts (a production app publisher).
 *
 * CLI:
 *   bun VideoPiiGate.ts <file.mp4> [--chunk-min 30] [--low] [--model <id>] [--json] [--out <report.json>]
 *   --low    request MEDIA_RESOLUTION_LOW (~100 tok/s instead of ~300; cheaper, may miss small print)
 * Exit:    0 = clean · 1 = findings to review · 2 = usage/probe/API error
 *
 *   bun VideoPiiGate.ts approve-skip <video...> --reason "<why>" [--hours N≤24]
 *            authorize shipping these exact bytes unscanned (scanner down). Interactive terminal outside any agent session only (approveSkipRefusal); binds sha256;
 *            expires. Without it, every pipeline's --skip-pii blocks.
 *
 * Library (for publishing pipelines inside ~/.claude):
 *   import { videoPiiGate, isVideoPath } from "LIFEOS/TOOLS/VideoPiiGate"
 *   const g = await videoPiiGate(files, { reviewed, skip, skipReason, log })   // → { ok, status, message, reports, approvals? }
 *
 * Env: GOOGLE_API_KEY from ~/.claude/.env (canonical), read by VideoJudge.
 *
 * @version 1.2.2
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { CROSS_VENDOR } from "./models";
import { invariant, InvariantViolation } from "./Invariant";
import { lifeosPath } from "./Paths";
import { assertVideoJudgeReady, deleteVideoFile, judgeVideo, type VideoJudgeDeps } from "../ASSAY/VideoJudge";

const VIDEO_EXT = new Set([
  ".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".mpg", ".mpeg", ".mpe", ".m2v", ".m2ts", ".mts", ".vob",
  ".3gp", ".3g2", ".flv", ".f4v", ".wmv", ".asf", ".ogv", ".mxf", ".qt", ".dv", ".divx",
]);

/**
 * Audio extensions whose real files share a video container's header (MP4 ftyp, Ogg, ASF): the header cannot tell an
 * audio cut from a video, so the extension decides and an audio cut stays on its own path. Every other extension,
 * a .pdf or .txt included, is sniffed by content, because a video renamed to one of them must still be scanned.
 */
const AUDIO_SHARING_VIDEO_HEADER_EXT = new Set([".m4a", ".m4b", ".ogg", ".oga", ".opus", ".wma"]);

/** ISO-BMFF major brands that are audio or still images, not video. Any other ftyp brand counts as video. */
const NON_VIDEO_FTYP = new Set(["M4A ", "M4B ", "M4P ", "F4A ", "F4B ", "heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1", "avif", "avis", "crx ", "jp2 ", "jpx "]);

/** Extension check only: a known video container extension. Use isVideoFile to decide what the gate scans. */
export function isVideoPath(p: string): boolean {
  return VIDEO_EXT.has(extname(p).toLowerCase());
}

/**
 * True when a file's first bytes are a video container header (ISO-BMFF with a non-audio, non-image brand; Matroska/WebM;
 * RIFF AVI; FLV; ASF; MPEG program or transport stream; Ogg). An extension never excuses a file from the sniff, except
 * the audio extensions whose real files share a video header (AUDIO_SHARING_VIDEO_HEADER_EXT); files that cannot be
 * read are not sniffed. This is what keeps a video whose extension the list misses, or a video renamed to .pdf or
 * .txt, from passing the gate unscanned.
 */
export function sniffsAsVideo(p: string): boolean {
  if (AUDIO_SHARING_VIDEO_HEADER_EXT.has(extname(p).toLowerCase())) return false;
  let head: Buffer;
  try {
    if (!statSync(p).isFile()) return false;
    const fd = openSync(p, "r");
    try { head = Buffer.alloc(400); head = head.subarray(0, readSync(fd, head, 0, head.length, 0)); } finally { closeSync(fd); }
  } catch { return false; }
  const ascii = (a: number, b: number) => head.subarray(a, b).toString("latin1");
  if (head.length >= 12 && ascii(4, 8) === "ftyp") return !NON_VIDEO_FTYP.has(ascii(8, 12));
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return true;                 // Matroska / WebM
  if (head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "AVI ") return true;  // AVI
  if (head.length >= 4 && ascii(0, 3) === "FLV" && head[3] === 1) return true;              // FLV
  if (head.length >= 8 && head.readUInt32BE(0) === 0x3026b275 && head.readUInt32BE(4) === 0x8e66cf11) return true; // ASF / WMV
  if (head.length >= 4 && head.readUInt32BE(0) === 0x000001ba) return true;                 // MPEG program stream
  // MPEG transport stream: a sync byte every 188 bytes. Three syncs when the sample is long enough, so a text file that
  // happens to hold a 'G' at 0 and 188 is not mistaken for one.
  if (head.length >= 189 && head[0] === 0x47 && head[188] === 0x47 && (head.length < 377 || head[376] === 0x47)) return true;
  if (head.length >= 4 && ascii(0, 4) === "OggS") return true;                              // Ogg (Theora); .ogg/.opus audio never reach here
  return false;
}

/** What the gate scans: a known video extension, or a file whose content is a video container. */
export function isVideoFile(p: string): boolean {
  return isVideoPath(p) || sniffsAsVideo(p);
}

// ---------- ffmpeg helpers ----------
function probeDuration(path: string): number {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8" }).trim();
  const d = Number(out);
  invariant(Number.isFinite(d) && d > 0, `ffprobe returned a non-positive duration for ${path}: ${out}`);
  return d;
}

/** Stream-copy split. Cuts land on keyframes, so chunk durations are re-probed, never assumed. */
function splitVideo(path: string, chunkSec: number, dir: string): string[] {
  const pattern = join(dir, "chunk-%03d.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-i", path, "-c", "copy", "-map", "0", "-f", "segment",
    "-segment_time", String(chunkSec), "-reset_timestamps", "1", pattern], { stdio: ["ignore", "ignore", "pipe"] });
  const files = execFileSync("ls", [dir], { encoding: "utf8" }).split("\n").filter(f => f.startsWith("chunk-")).sort().map(f => join(dir, f));
  invariant(files.length > 0, "segmenter produced no chunks");
  return files;
}

// ---------- scan ----------
export type Finding = {
  t: number;            // seconds, global
  end?: number;
  category: string;     // name | address | phone | email | financial | credential | id-number | health | minor | private-person | other
  severity: "high" | "medium" | "low";
  channel: "visual" | "audio";
  what: string;         // what was seen/heard (describe, don't reproduce secrets verbatim)
  where: string;        // on-screen location or "spoken"
};

export type Report = {
  file: string;
  durationSec: number;
  model: string;
  lowRes: boolean;
  parts: number;
  tokens: number;
  elapsedSec: number;
  uploadedFilesDeleted: boolean;
  findings: Finding[];
  verdict: "CLEAN" | "REVIEW";
};

const PROMPT = `You are a pre-publication privacy reviewer for a creator's video. Watch AND listen to the whole video. Report every moment where personally identifiable or sensitive information appears ON SCREEN (browser tabs, terminal output, email, Messages/chat windows, calendars, invoices, dashboards, notifications, address bars, file paths with usernames, API keys/tokens/passwords, account numbers, QR codes) or is SPOKEN (home address, phone number, email, financial figures tied to a person, health details, a private third party's full name, a child's name, credentials).

Rules:
- The creator saying their OWN first/last name, company name, or public handles is NOT a finding. Public figures named in commentary are NOT findings.
- Secrets (API keys, tokens, passwords, cookies, connection strings): report category "credential" with severity "high", describe WHERE and WHAT KIND, and never reproduce the secret itself.
- Be precise about timestamps (seconds from the start of THIS file). If something persists, give start and end.
- Prefer precision over recall for low-severity items; prefer recall over precision for high-severity items (credentials, financial/account numbers, home address, health, minors).
- If nothing qualifies, return an empty findings array.`;

const SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          t: { type: "number" },
          end: { type: "number" },
          category: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          channel: { type: "string", enum: ["visual", "audio"] },
          what: { type: "string" },
          where: { type: "string" },
        },
        required: ["t", "category", "severity", "channel", "what", "where"],
      },
    },
  },
  required: ["findings"],
};

/**
 * The model's answer as findings, or a thrown error when it is not a complete scan result. A missing or non-array `findings`,
 * or a finding without a finite start time, a known severity and channel and its text fields, is a malformed scan: reading it
 * as "no findings" would let an unparseable answer certify a video CLEAN. An empty array is the only clean answer.
 */
export function parseFindings(parsed: unknown): Finding[] {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("model scan result is not a JSON object");
  const list = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(list)) throw new Error("model scan result has no findings array (a missing or non-array findings field is a malformed scan, not a clean one)");
  return list.map((f, i) => {
    const at = `finding ${i}`;
    if (typeof f !== "object" || f === null || Array.isArray(f)) throw new Error(`${at} is not an object`);
    const o = f as Record<string, unknown>;
    if (typeof o.t !== "number" || !Number.isFinite(o.t) || o.t < 0) throw new Error(`${at} has no valid start time t`);
    if (o.end !== undefined && (typeof o.end !== "number" || !Number.isFinite(o.end) || o.end < 0)) throw new Error(`${at} has an invalid end time`);
    if (o.severity !== "high" && o.severity !== "medium" && o.severity !== "low") throw new Error(`${at} has an unknown severity`);
    if (o.channel !== "visual" && o.channel !== "audio") throw new Error(`${at} has an unknown channel`);
    for (const k of ["category", "what"] as const) if (typeof o[k] !== "string" || !(o[k] as string).trim()) throw new Error(`${at} has no ${k}`);
    if (typeof o.where !== "string") throw new Error(`${at} has no where`);
    return o as unknown as Finding;
  });
}

export type ScanOpts = { chunkMin?: number; low?: boolean; model?: string; log?: (s: string) => void; deps?: VideoJudgeDeps };

/** Scan one video. Throws on API/probe errors. Always deletes what it uploaded. */
export async function scanVideo(file: string, opts: ScanOpts = {}): Promise<Report> {
  const chunkMin = opts.chunkMin ?? 30;
  const low = opts.low ?? false;
  const model = opts.model ?? CROSS_VENDOR.geminiResearcher;
  const log = opts.log ?? (() => {});
  invariant(chunkMin > 0, "chunkMin must be positive");
  // Egress, kill switch and key are checked before any probing or splitting, as the key check always was.
  const KEY = assertVideoJudgeReady({ model, caller: "VideoPiiGate", key: opts.deps?.key });

  const t0 = Date.now();
  const totalDur = probeDuration(file);
  // Google Files API refuses uploads over 2 GiB (HTTP 413). A 4K master runs ~5 MB/s, so a 30-minute
  // chunk is ~9 GB; size the chunk by bytes as well as minutes (2026-09-16, 7 GB final hit 413).
  const MAX_UPLOAD_BYTES = 1.9 * 1024 ** 3;
  const bytesPerSec = statSync(file).size / Math.max(1, totalDur);
  const chunkSec = Math.max(60, Math.min(chunkMin * 60, Math.floor(MAX_UPLOAD_BYTES / bytesPerSec)));
  const tmp = mkdtempSync(join(tmpdir(), "piigate-"));
  const uploaded: string[] = [];
  try {
    const parts = totalDur > chunkSec ? splitVideo(file, chunkSec, tmp) : [file];
    const durs = parts.map(probeDuration);
    const offsets: number[] = [];
    durs.reduce((acc, d, i) => { offsets[i] = acc; return acc + d; }, 0);
    log(`PiiGate · ${basename(file)} · ${(totalDur / 60).toFixed(1)} min · ${parts.length} part(s) · model ${model}${low ? " · low-res" : ""}`);

    // allSettled, not all: a rejection must not end the scan (and run the cleanup below, and remove the chunks) while
    // other parts are still uploading. Every part finishes, deleting its own upload, before the first error is thrown.
    const scanPart = async (p: string, i: number) => {
      log(`  [${i + 1}/${parts.length}] uploading ${(statSync(p).size / 1e6).toFixed(0)} MB…`);
      const j = await judgeVideo(p, {
        prompt: PROMPT, schema: SCHEMA, model, lowRes: low, temperature: 0, caller: "VideoPiiGate",
        displayName: `piigate-${basename(file)}-${i}`, onUploaded: (n) => uploaded.push(n),
      }, { ...(opts.deps ?? {}), key: KEY });
      const findings = parseFindings(j.parsed);
      log(`  [${i + 1}/${parts.length}] ${findings.length} finding(s) · deleted=${j.deleted}`);
      return { i, findings, usage: j.usage, deleted: j.deleted };
    };
    const settled = await Promise.allSettled(parts.map(scanPart));
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failed) throw failed.reason;
    const results = settled.map((s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof scanPart>>>).value);

    const findings: Finding[] = results.flatMap(r => r.findings.map(f => ({
      ...f,
      t: Math.round((Number(f.t) || 0) + offsets[r.i]),
      ...(f.end !== undefined ? { end: Math.round((Number(f.end) || 0) + offsets[r.i]) } : {}),
    }))).sort((a, b) => a.t - b.t);
    const tokens = results.reduce((s, r) => s + (r.usage?.totalTokenCount ?? 0), 0);

    return {
      file, durationSec: Math.round(totalDur), model, lowRes: low, parts: parts.length, tokens,
      elapsedSec: Math.round((Date.now() - t0) / 1000),
      uploadedFilesDeleted: results.every(r => r.deleted),
      findings, verdict: findings.length ? "REVIEW" : "CLEAN",
    };
  } catch (e) {
    // Never leave the principal's video in Google's store on a failed run.
    await Promise.all(uploaded.map(n => deleteVideoFile(n, KEY, { fetch: opts.deps?.fetch })));
    throw e;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function formatFindings(r: Report): string {
  const lines = [`${r.findings.length ? "⚠️  REVIEW" : "✅ CLEAN"} — ${r.findings.length} finding(s) · ${r.tokens.toLocaleString()} tokens · ${r.elapsedSec}s`];
  for (const f of r.findings) {
    lines.push(`  ${fmtTime(f.t)}${f.end ? `–${fmtTime(f.end)}` : ""}  [${f.severity.toUpperCase()} ${f.category} ${f.channel}] ${f.what} — ${f.where}`);
  }
  if (!r.uploadedFilesDeleted) lines.push("  ⚠️ one or more uploaded files could not be deleted from the Files API — clean up manually");
  return lines.join("\n");
}

/**
 * What the gate decided. Only "clean" and "reviewed" mean a scan ran and passed. "skipped" means a skip was
 * asked for with no authorization on record for these exact bytes: no scan ran, and it BLOCKS (ok:false).
 * "excepted" means no scan ran but every video's exact bytes carry a separate, unexpired authorization
 * (approvePiiSkip, whose CLI runs only at an interactive terminal outside an agent session): an authorized exception,
 * never a pass of the scan.
 * "none" means no video was among the files; "refused" blocks the publish (findings, scan failure, unrecordable skip).
 */
export type PiiGateStatus = "none" | "clean" | "reviewed" | "excepted" | "skipped" | "refused";
export interface PiiGateResult { ok: boolean; status: PiiGateStatus; message: string; reports: Report[]; skipReason?: string; approvals?: string[] }

/** Where every used PII-scan exception is recorded, whichever pipeline used it. */
export function piiSkipLedgerPath(): string {
  return process.env.LIFEOS_PII_SKIP_LEDGER || lifeosPath("MEMORY", "OBSERVABILITY", "pii-skips.jsonl");
}

/**
 * Where skip authorizations live. Deliberately no env override: the gate reads its authority from the install's
 * own state, so pointing a variable at a self-written file authorizes nothing.
 */
export function piiSkipApprovalsPath(): string {
  return lifeosPath("MEMORY", "STATE", "pii-skip-approvals.jsonl");
}

/** The longest an authorization may stay valid. A record claiming a longer window is ignored, however it was written. */
export const PII_SKIP_APPROVAL_MAX_HOURS = 24;

export interface PiiSkipApproval { id: string; at: string; expires: string; reason: string; sha256: string; file: string; bytes: number }

/** sha256 of a file, read in 8 MB chunks so a long video never loads whole. */
export function fileSha256(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
    for (;;) { const n = readSync(fd, buf, 0, buf.length, null); if (n === 0) break; hash.update(buf.subarray(0, n)); }
  } finally { closeSync(fd); }
  return hash.digest("hex");
}

/**
 * Authorize shipping these exact video bytes without a PII scan (the scanner is down). Binds each file's sha256, so
 * a later edit to the file is not covered. Valid for `hours` (default and maximum PII_SKIP_APPROVAL_MAX_HOURS).
 * The CLI `approve-skip` is the front door and refuses without an interactive terminal or inside an agent session
 * (approveSkipRefusal); pipelines never call this. The function itself does not check, so tests can write fixtures.
 * Limit: the approvals file is ordinary user state, so code running as the user can import this or append a record
 * directly. The terminal check keeps an agent or pipeline off the CLI path; it is not an enforcement boundary. What
 * stops an exception from going unseen is the used-exception ledger (piiSkipLedgerPath), written on every skip.
 */
export function approvePiiSkip(files: string[], reason: string, o: { hours?: number; now?: number } = {}): PiiSkipApproval[] {
  const hours = o.hours ?? PII_SKIP_APPROVAL_MAX_HOURS;
  const now = o.now ?? Date.now();
  invariant(files.length > 0, "a PII skip authorization needs at least one video");
  invariant(typeof reason === "string" && reason.trim().length > 0, "a PII skip authorization needs a non-blank reason");
  invariant(Number.isFinite(hours) && hours > 0 && hours <= PII_SKIP_APPROVAL_MAX_HOURS, `a PII skip authorization lasts at most ${PII_SKIP_APPROVAL_MAX_HOURS} hours`);
  invariant(Number.isFinite(now), "a PII skip authorization needs a valid time");
  const records = files.map((f): PiiSkipApproval => {
    const file = resolve(f);
    invariant(isVideoFile(file), `not a video: ${file}`);
    const st = statSync(file);
    invariant(st.isFile(), `not a file: ${file}`);
    const sha256 = fileSha256(file);
    invariant(/^[0-9a-f]{64}$/.test(sha256), "sha256 must be 64 hex characters");
    return {
      id: `${new Date(now).toISOString().replace(/[-:.]/g, "")}-${sha256.slice(0, 12)}`,
      at: new Date(now).toISOString(), expires: new Date(now + hours * 3_600_000).toISOString(),
      reason: reason.trim(), sha256, file, bytes: st.size,
    };
  });
  const path = piiSkipApprovalsPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return records;
}

/** True when a parsed line is a well-formed authorization whose window is within the cap. Anything else authorizes nothing. */
function isValidApproval(r: unknown): r is PiiSkipApproval {
  if (r === null || typeof r !== "object" || Array.isArray(r)) return false;
  const o = r as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.reason !== "string" || !o.reason.trim()) return false;
  if (typeof o.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(o.sha256)) return false;
  if (typeof o.at !== "string" || typeof o.expires !== "string") return false;
  const at = Date.parse(o.at), exp = Date.parse(o.expires);
  return Number.isFinite(at) && Number.isFinite(exp) && exp > at && exp - at <= PII_SKIP_APPROVAL_MAX_HOURS * 3_600_000;
}

/** The unexpired authorization covering this file's current bytes, or null (no file, no ledger, no match, expired). */
export function findPiiSkipApproval(file: string, now = Date.now()): PiiSkipApproval | null {
  let sha: string;
  try { sha = fileSha256(resolve(file)); } catch { return null; }
  return findPiiSkipApprovalForSha(sha, now);
}

/**
 * The unexpired authorization covering these bytes by sha256, or null. For a pipeline that holds the hash of bytes it
 * already sent and no local copy (YouTubeUpload publish of an uploaded video).
 */
export function findPiiSkipApprovalForSha(sha: string, now = Date.now()): PiiSkipApproval | null {
  if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) return null;
  let text: string;
  try { text = readFileSync(piiSkipApprovalsPath(), "utf8"); } catch { return null; }
  let found: PiiSkipApproval | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r: unknown;
    try { r = JSON.parse(line); } catch { continue; }
    if (!isValidApproval(r) || r.sha256 !== sha) continue;
    if (Date.parse(r.at) <= now && now < Date.parse(r.expires)) found = r;
  }
  return found;
}

/** Append one used-exception record. Throws when it cannot be written; the gate then refuses the skip. */
export function recordPiiSkip(videos: string[], reason: string, approvals: string[] = []): void {
  invariant(videos.length > 0 && videos.every((v) => typeof v === "string" && v.length > 0), "a PII skip record needs the unscanned videos");
  invariant(reason.trim().length > 0, "a PII skip record needs a non-blank reason");
  const path = piiSkipLedgerPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({
    at: new Date().toISOString(), reason, videos: videos.map((v) => resolve(v)), approvals,
    caller: process.argv[1] ? basename(process.argv[1]) : "unknown", pid: process.pid,
  }) + "\n");
}

/**
 * Why `approve-skip` must not run in this process, or null when it may. Two things have to hold: stdin is an interactive
 * terminal, and the process is not inside an agent session. A terminal alone proves nothing, since an agent can run a
 * command under a pseudo-terminal; its child still inherits the agent's session variables, which a person's own
 * terminal does not carry. This is a guard against the agent path, not proof of a human: the authorization stays
 * a deliberate act at the principal's own terminal.
 */
export function approveSkipRefusal(env: Record<string, string | undefined>, stdinIsTTY: boolean | undefined): string | null {
  if (!stdinIsTTY) return "run it yourself in an interactive terminal. approve-skip does not run from a pipeline.";
  if (env.CLAUDECODE || env.CLAUDE_AGENT_SDK_VERSION || Object.keys(env).some((k) => k.startsWith("CLAUDE_CODE_") && env[k])) {
    return "this shell belongs to an agent session. Run it in your own terminal, outside the agent; approve-skip does not run from an agent's shell.";
  }
  return null;
}

const APPROVE_HINT =`To authorize an exception (scanner down), the principal runs, in the principal's own terminal: bun LIFEOS/TOOLS/VideoPiiGate.ts approve-skip <video> --reason "<why the scan cannot run>"`;

/**
 * Publishing-pipeline helper. Scans every video among `files` (isVideoFile: a video extension, or a video container
 * header under an unlisted extension); audio, images and text are ignored.
 *   reviewed=true → findings are acknowledged by the principal; pass with a note.
 *   skip=true     → no scan. Passes (status "excepted") only when every video's exact bytes carry an unexpired
 *                   authorization from approvePiiSkip; the reason comes from that record (a caller's skipReason is
 *                   recorded beside it but authorizes nothing). Without one it blocks with status "skipped".
 *                   Every used exception is recorded in piiSkipLedgerPath(); one that cannot be recorded is refused.
 */
export async function videoPiiGate(
  files: string[],
  o: { reviewed?: boolean; skip?: boolean; skipReason?: string; log?: (s: string) => void; scan?: ScanOpts } = {},
): Promise<PiiGateResult> {
  const log = o.log ?? ((s: string) => console.log(s));
  const videos = files.filter(isVideoFile);
  if (videos.length === 0) return { ok: true, status: "none", message: "", reports: [] };
  if (o.skip) {
    const now = Date.now();
    const found = videos.map((v) => ({ v, a: findPiiSkipApproval(v, now) }));
    const missing = found.filter((x) => !x.a).map((x) => basename(x.v));
    if (missing.length) {
      const m = `⛔ PII gate skip blocked for ${missing.length} video(s) (${missing.join(", ")}): no scan ran and no unexpired authorization covers these exact bytes. An unscanned video never passes on a flag or a caller's reason alone. ${APPROVE_HINT}`;
      log(m); return { ok: false, status: "skipped", message: m, reports: [] };
    }
    const approvals = found.map((x) => x.a!);
    const callerReason = (o.skipReason ?? "").trim();
    const reason = [...new Set(approvals.map((a) => a.reason.trim()))].join(" | ") + (callerReason ? ` (caller: ${callerReason})` : "");
    const ids = approvals.map((a) => a.id);
    try {
      recordPiiSkip(videos, reason, ids);
    } catch (e: any) {
      if (e instanceof InvariantViolation) throw e;
      const m = `⛔ PII gate skip refused for ${videos.length} video(s): the exception could not be recorded in ${piiSkipLedgerPath()} (${e?.message ?? e}). An unrecorded skip never passes.`;
      log(m); return { ok: false, status: "refused", message: m, reports: [] };
    }
    const m = `⚠️  PII gate NOT RUN for ${videos.length} video(s): authorized exception ${ids.join(", ")}. Reason: ${reason}. Recorded in ${piiSkipLedgerPath()}. Do not make this routine.`;
    log(m); return { ok: true, status: "excepted", message: m, reports: [], skipReason: reason, approvals: ids };
  }
  const reports: Report[] = [];
  for (const v of videos) {
    try {
      const r = await scanVideo(v, { ...(o.scan ?? {}), log: o.scan?.log ?? (() => {}) });
      reports.push(r);
      log(`🔎 PII gate · ${basename(v)}: ${formatFindings(r)}`);
    } catch (e: any) {
      const m = `❌ PII gate could not scan ${basename(v)}: ${e?.message ?? e}. Fix and retry. If Gemini is down, --skip-pii passes only for bytes the principal has authorized. ${APPROVE_HINT}`;
      log(m); return { ok: false, status: "refused", message: m, reports };
    }
  }
  const flagged = reports.filter(r => r.findings.length);
  if (flagged.length && !o.reviewed) {
    const m = `⛔ ${flagged.length} video(s) have PII findings above. Review them; if they are acceptable, re-run with --pii-reviewed.`;
    log(m); return { ok: false, status: "refused", message: m, reports };
  }
  if (flagged.length) log(`✅ PII findings acknowledged (--pii-reviewed) — proceeding.`);
  return { ok: true, status: flagged.length ? "reviewed" : "clean", message: "", reports };
}

// ---------- CLI ----------
if (import.meta.main && Bun.argv[2] === "approve-skip") {
  // The authorization is a separate act from the publish: a person at an interactive terminal, never a pipeline
  // or an agent's shell (whose stdin is not a TTY). It binds the exact bytes and expires.
  const argv = Bun.argv.slice(3);
  const files: string[] = [];
  let reason = "", hours = PII_SKIP_APPROVAL_MAX_HOURS;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "--reason") reason = argv[++i] ?? "";
    else if (t === "--hours") hours = Number(argv[++i]);
    else if (!t.startsWith("--")) files.push(t);
  }
  const usage = `usage: bun VideoPiiGate.ts approve-skip <video...> --reason "<why the scan cannot run>" [--hours N≤${PII_SKIP_APPROVAL_MAX_HOURS}]`;
  const refusal = approveSkipRefusal(process.env, process.stdin.isTTY);
  if (refusal) { console.error(`approve-skip refused: ${refusal}`); process.exit(2); }
  if (!files.length || !reason.trim() || !Number.isFinite(hours) || hours <= 0 || hours > PII_SKIP_APPROVAL_MAX_HOURS) { console.error(usage); process.exit(2); }
  try {
    for (const a of approvePiiSkip(files, reason, { hours })) {
      console.log(`authorized ${a.file} (sha256 ${a.sha256.slice(0, 12)}…, ${a.bytes} bytes) until ${a.expires} · ${a.id}`);
    }
    process.exit(0);
  } catch (e: any) {
    console.error(`approve-skip failed: ${e?.message ?? e}`);
    process.exit(2);
  }
} else if (import.meta.main) {
  type Args = { file: string; chunkMin: number; low: boolean; model?: string; json: boolean; out?: string };
  const USAGE = "usage: bun VideoPiiGate.ts <file.mp4> [--chunk-min 30] [--low] [--model <id>] [--json] [--out <report.json>]\nexit: 0 clean · 1 findings to review · 2 error";
  if (Bun.argv.includes("-h") || Bun.argv.includes("--help")) { console.log(USAGE); process.exit(0); }
  const a: Args = { file: "", chunkMin: 30, low: false, json: false };
  const argv = Bun.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--json") a.json = true;
    else if (t === "--low") a.low = true;
    else if (t === "--chunk-min") a.chunkMin = Number(argv[++i]);
    else if (t === "--model") a.model = argv[++i];
    else if (t === "--out") a.out = argv[++i];
    else if (!t.startsWith("--") && !a.file) a.file = t;
  }
  if (!a.file || !Number.isFinite(a.chunkMin) || a.chunkMin <= 0) { console.error(USAGE); process.exit(2); }
  try {
    const report = await scanVideo(a.file, { chunkMin: a.chunkMin, low: a.low, model: a.model, log: a.json ? () => {} : (s) => console.error(s) });
    if (a.out) writeFileSync(a.out, JSON.stringify(report, null, 2));
    if (a.json) console.log(JSON.stringify(report, null, 2));
    else console.log("\n" + formatFindings(report));
    process.exit(report.findings.length ? 1 : 0);
  } catch (e: any) {
    console.error(`PiiGate error: ${e?.message ?? e}`);
    process.exit(2);
  }
}
