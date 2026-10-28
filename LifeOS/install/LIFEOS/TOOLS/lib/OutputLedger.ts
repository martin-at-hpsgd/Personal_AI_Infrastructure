/**
 * OutputLedger — the one writer of output lines (assay-everywhere ISC-32, Design.md §4).
 *
 * One line per output that crossed a boundary (handed to the principal, sent, published, deployed),
 * appended to MEMORY/OBSERVABILITY/outputs-YYYY-MM.jsonl (USER data repo through the MEMORY
 * symlink), file mode 0600. The line is what Errata joins to: output.run_id -> the run line in
 * MEMORY/SKILLS/execution.jsonl, output.receipt_id -> the assay receipt, and later an erratum's
 * context.output_ids -> this line.
 *
 * WHEN TO CALL IT: from PostToolUse, after the tool has SUCCEEDED, and from a send or publish
 * tool only after its transmit call returned. The hash is computed here from the bytes actually
 * on disk at call time, so the line describes the post-state artifact, never the intent. A
 * PreToolUse caller would record an output that may never exist; do not do that. Gates (S4) call
 * this too, but it is deliberately not wired into any gate yet.
 *
 * WHAT IT NEVER STORES: content. Only the sha256, the byte count, and a redacted target class.
 * A target is a class such as "email", "url" or "path:downloads", never an address; a value that
 * still looks like an address (an @, a slash, a scheme, whitespace) fails an invariant. Use
 * redactTarget() to turn a raw destination into a class.
 *
 * Failure contract: a missing or unreadable artifact is an expected failure and returns
 * { ok: false, error }; a malformed line (bad enum, bad hash, address-shaped target) is a
 * programmer error and throws InvariantViolation before anything is written.
 *
 * TOCTOU (S4): a gate that approved bytes before the tool ran passes them as `approved_sha256`. The line is written from
 * the bytes that landed; when they differ from the approved sha the decision becomes "allowed-labelled" with reason
 * "post-state sha differs from proofed sha", receipt_id is null, and the result carries `mismatch: true` (the caller raises a Vigil event).
 *
 * STATVS dual-write (STATVS ISA F16, step 1 of the five-step migration): after the ledger line lands, the same output is
 * appended to the record's `output` stream through LIFEOS/STATVS/lib/quality.ts recordOutput (ids, sha, classes; no
 * content, no reason text). The ledger keeps writing exactly as before and stays the store Errata reads. The record write
 * is loaded lazily, only when a line is actually written, so a hook that imports this file and writes nothing pays no
 * engine load; a record that refuses, spools or throws is logged and never fails recordOutput.
 *
 * @version 1.2.0
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { invariant } from "../Invariant.ts";
import { getLifeosDir } from "../Paths.ts";
import { BOUNDARIES } from "./ProofReceipt.ts";

export const OUTPUT_SCHEMA_VERSION = 1;

/** The one boundary list, shared with the receipt's destination (ProofReceipt.ts owns the spelling). */
export { BOUNDARIES };
/** "other" is any regular file whose type has no Proof method: it is still an output, recorded unproofed. */
export const KINDS = ["video", "image", "audio", "text", "page", "doc", "diff", "other"] as const;
export const DECISIONS = ["allowed", "allowed-labelled", "blocked", "overridden"] as const;

export type OutputBoundary = (typeof BOUNDARIES)[number];
export type OutputKind = (typeof KINDS)[number];
export type OutputDecision = (typeof DECISIONS)[number];

/** The caller's input. `artifact` is a path to the file whose bytes are hashed. */
export type OutputInput = {
  session_id: string;
  turn?: string | null;
  run_id?: string | null;
  skill?: string | null;
  workflow?: string | null;
  isa?: string | null;
  boundary: OutputBoundary;
  /** downloads | open | artifact | gmail | x | discord | broadcast | blog | cf-deploy | ... */
  channel: string;
  kind: OutputKind;
  /** A redacted class (see redactTarget), never an address. */
  target: string;
  artifact: string;
  receipt_id?: string | null;
  decision: OutputDecision;
  reason: string;
  /** The sha256 a gate approved before the tool ran. A landed sha that differs downgrades the decision (TOCTOU). */
  approved_sha256?: string | null;
  /** Test seam. */
  now?: Date;
  /** Test seam; LIFEOS_OUTPUT_LEDGER_DIR also redirects it. */
  dir?: string;
};

/** The line as written (Design.md §4). Optional fields are present as null when unknown. */
export type OutputLine = {
  v: typeof OUTPUT_SCHEMA_VERSION;
  output_id: string;
  ts: string;
  session_id: string;
  turn: string | null;
  run_id: string | null;
  skill: string | null;
  workflow: string | null;
  isa: string | null;
  boundary: OutputBoundary;
  channel: string;
  kind: OutputKind;
  target: string;
  sha256: string;
  bytes: number;
  receipt_id: string | null;
  decision: OutputDecision;
  reason: string;
};

export type RecordResult = { ok: true; line: OutputLine; file: string; mismatch: boolean } | { ok: false; error: string };

/** The reason recorded when the landed bytes are not the bytes a gate approved. */
export const POST_STATE_MISMATCH_REASON = "post-state sha differs from proofed sha";

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const TARGET_CLASS = /^[a-z0-9][a-z0-9_.-]{0,31}(:[a-z0-9][a-z0-9_.-]{0,31}){0,2}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REASON_MAX = 240;
// A5 / F-I4: shapes that identify a person, a machine or a file. Neither target nor reason may carry one.
const EMAIL_SHAPE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const URL_SHAPE = /[a-z][a-z0-9+.-]*:\/\//i;
const PATH_SHAPE = /(?:^|[\s("'=:,])~?\/[A-Za-z0-9._-]+|(?:^|[\s("'=:,])~(?:\/|$)|\b[A-Za-z]:\\/;
const IPV4_SHAPE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const IPV6_SHAPE = /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b|[0-9a-f]{0,4}::[0-9a-f]{0,4}/i;

/** The first identifying shape in a string ("email" | "url" | "path" | "ip"), or null when it carries none. */
export function identifyingShape(s: string): string | null {
  if (EMAIL_SHAPE.test(s)) return "email";
  if (URL_SHAPE.test(s)) return "url";
  if (PATH_SHAPE.test(s)) return "path";
  if (IPV4_SHAPE.test(s) || IPV6_SHAPE.test(s)) return "ip";
  return null;
}

export function ledgerDir(): string {
  if (process.env.LIFEOS_OUTPUT_LEDGER_DIR) return process.env.LIFEOS_OUTPUT_LEDGER_DIR;
  // Under `bun test` with no override the ledger is a per-process temp dir, so a gate or hook test can never write the real one (same rule as LabelStore).
  if (process.env.NODE_ENV === "test") return join(tmpdir(), `lifeos-output-ledger-test-${process.pid}`);
  return join(getLifeosDir(), "MEMORY", "OBSERVABILITY");
}

export function ledgerFile(ts: Date, dir = ledgerDir()): string {
  return join(dir, `outputs-${ts.toISOString().slice(0, 7)}.jsonl`);
}

/**
 * Reduce a raw destination to a class that cannot identify a person or a path.
 * Email addresses become "email"; URLs become "url"; local paths become "path:<dir class>"
 * (downloads, desktop, documents, tmp, home, other); anything else is "other".
 */
export function redactTarget(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "other";
  if (/^[^\s@/]+@[^\s@/]+$/.test(s)) return "email";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return "url";
  if (s.startsWith("/") || s.startsWith("~")) {
    const home = homedir();
    const abs = s.startsWith("~") ? join(home, s.slice(1)) : resolve(s);
    if (abs.startsWith(join(home, "Downloads") + "/")) return "path:downloads";
    if (abs.startsWith(join(home, "Desktop") + "/")) return "path:desktop";
    if (abs.startsWith(join(home, "Documents") + "/")) return "path:documents";
    if (abs.startsWith("/tmp/") || abs.startsWith("/private/tmp/") || abs.startsWith("/var/folders/")) return "path:tmp";
    if (abs.startsWith(home + "/")) return "path:home";
    return "path:other";
  }
  return "other";
}

/** sha256 and byte count of exactly the bytes read, in 1 MiB chunks so a film does not load into memory. */
function hashFile(path: string): { sha256: string; bytes: number } {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let bytes = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      bytes += n;
    }
    return { sha256: hash.digest("hex"), bytes };
  } finally {
    closeSync(fd);
  }
}

/** Asserts a line is well formed. Throws InvariantViolation; nothing has been written yet. */
export function assertOutputLine(line: OutputLine): void {
  invariant(line.v === OUTPUT_SCHEMA_VERSION, "output line carries schema version 1");
  invariant(/^out_[0-9a-f-]{36}$/.test(line.output_id), "output_id is a generated out_<uuid>");
  invariant(Number.isFinite(Date.parse(line.ts)), "output line ts is a valid timestamp");
  invariant(typeof line.session_id === "string" && line.session_id.length > 0, "an output line names its session");
  invariant((BOUNDARIES as readonly string[]).includes(line.boundary), "boundary is one of handoff|send|publish|deploy|isa-close");
  invariant(TOKEN.test(line.channel), "channel is a plain token");
  invariant((KINDS as readonly string[]).includes(line.kind), "kind is one of video|image|audio|text|page|doc|diff|other");
  invariant(
    TARGET_CLASS.test(line.target) && !/[@/\\\s]|:\/\//.test(line.target) && identifyingShape(line.target) === null,
    "target is a redacted class, never an address, a path or an IP",
  );
  invariant(SHA256.test(line.sha256), "sha256 is 64 lowercase hex characters");
  invariant(Number.isInteger(line.bytes) && line.bytes >= 0, "bytes is a non-negative integer");
  invariant((DECISIONS as readonly string[]).includes(line.decision), "decision is one of allowed|allowed-labelled|blocked|overridden");
  invariant(typeof line.reason === "string" && line.reason.length > 0 && line.reason.length <= REASON_MAX, `reason is 1..${REASON_MAX} characters`);
  invariant(identifyingShape(line.reason) === null, "reason never carries an address, a path or an IP");
  invariant(line.receipt_id === null || line.receipt_id.length > 0, "receipt_id is null or non-empty");
  invariant(line.run_id === null || line.run_id.length > 0, "run_id is null or non-empty");
}

/** Append one output line for the file at input.artifact. Call after the tool succeeded. */
export function recordOutput(input: OutputInput): RecordResult {
  const artifact = resolve(input.artifact);
  let st;
  try { st = statSync(artifact); } catch { return { ok: false, error: "artifact-missing" }; }
  if (!st.isFile()) return { ok: false, error: "artifact-not-a-file" };
  let digest: { sha256: string; bytes: number };
  try { digest = hashFile(artifact); } catch { return { ok: false, error: "artifact-unreadable" }; }

  const now = input.now ?? new Date();
  invariant(input.approved_sha256 == null || SHA256.test(input.approved_sha256), "approved_sha256 is null or 64 lowercase hex characters");
  const mismatch = input.approved_sha256 != null && input.approved_sha256 !== digest.sha256;
  const downgrade = mismatch && (input.decision === "allowed" || input.decision === "allowed-labelled");
  const line: OutputLine = {
    v: OUTPUT_SCHEMA_VERSION,
    output_id: `out_${randomUUID()}`,
    ts: now.toISOString(),
    session_id: input.session_id,
    turn: input.turn ?? null,
    run_id: input.run_id ?? null,
    skill: input.skill ?? null,
    workflow: input.workflow ?? null,
    isa: input.isa ?? null,
    boundary: input.boundary,
    channel: input.channel,
    kind: input.kind,
    target: input.target,
    sha256: digest.sha256,
    bytes: digest.bytes,
    // A receipt that does not describe the landed bytes is not this output's receipt.
    receipt_id: mismatch ? null : input.receipt_id ?? null,
    decision: downgrade ? "allowed-labelled" : input.decision,
    reason: downgrade ? POST_STATE_MISMATCH_REASON : input.reason,
  };
  assertOutputLine(line);

  const dir = input.dir ?? ledgerDir();
  const file = ledgerFile(now, dir);
  try {
    mkdirSync(dir, { recursive: true });
    const existed = existsSync(file);
    appendFileSync(file, JSON.stringify(line) + "\n", { encoding: "utf8", mode: 0o600 });
    if (existed) chmodSync(file, 0o600); // tighten a file an older writer left loose
  } catch (e) {
    return { ok: false, error: `ledger-unwritable: ${e instanceof Error ? e.message : String(e)}` };
  }
  // A scratch ledger (a dir argument or LIFEOS_OUTPUT_LEDGER_DIR) mirrors only into a scratch record: under bun test the
  // record is a temp dir, and STATVS_DIR names one explicitly. The live ledger always mirrors into the live record.
  if (mirrorsToRecord(input.dir)) recordOnStatvs(line);
  return { ok: true, line, file, mismatch };
}

type QualityModule = typeof import("../../STATVS/lib/quality.ts");
let quality: QualityModule | null | undefined;
/** The record's quality writers, loaded on first use; null (logged once) when the module cannot load. */
function qualityModule(): QualityModule | null {
  if (quality === undefined) {
    try { quality = require("../../STATVS/lib/quality.ts") as QualityModule; }
    catch (e) { quality = null; console.error(`[OutputLedger] STATVS quality writer unavailable: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return quality;
}

/** True when this write should reach the record: a write to the live ledger (by default or by its path), or to any ledger while the record itself is a scratch one. */
export function mirrorsToRecord(dirArg?: string): boolean {
  if (process.env.NODE_ENV === "test" || process.env.STATVS_DIR) return true;
  return resolve(dirArg ?? ledgerDir()) === resolve(getLifeosDir(), "MEMORY", "OBSERVABILITY");
}

const ID_SHAPE = /^[^\s\u0000-\u001f]{1,160}$/;
/**
 * Dual-write one ledger line to the record's `output` stream. Only fields the record's contract accepts are passed (a
 * receipt id that is not a sha256 key, or a skill or session that is not id-shaped, is left out rather than refusing the
 * row). Never throws: the ledger line already landed, and a record fault must not undo the caller's success.
 */
export function recordOnStatvs(line: OutputLine): void {
  try {
    const q = qualityModule();
    if (!q) return;
    q.recordOutput({
      output_id: line.output_id,
      sha256: line.sha256,
      boundary: line.boundary,
      channel: line.channel,
      kind: line.kind,
      decision: line.decision,
      target: line.target,
      ...(line.skill && ID_SHAPE.test(line.skill) ? { skill: line.skill } : {}),
      ...(ID_SHAPE.test(line.session_id) ? { session_id: line.session_id } : {}),
      ...(line.receipt_id && SHA256.test(line.receipt_id) ? { receipt_id: line.receipt_id } : {}),
    });
  } catch (e) {
    console.error(`[OutputLedger] STATVS output row not written: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The ledger read for verification: every line, plus every reason the read is incomplete. A missing ledger dir is an
 * empty ledger (nothing was ever written); an unreadable dir or file, or a line that is not a JSON object, is an error.
 * Auditors must treat any error as "cannot verify", never as a clean ledger.
 */
export function readOutputLinesChecked(dir = ledgerDir()): { lines: OutputLine[]; errors: string[] } {
  const lines: OutputLine[] = [];
  const errors: string[] = [];
  let names: string[];
  try { names = readdirSync(dir); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { lines, errors };
    return { lines, errors: [`ledger dir unreadable: ${(e as Error).message}`] };
  }
  for (const f of names.filter((n) => /^outputs-\d{4}-\d{2}\.jsonl$/.test(n)).sort()) {
    let text: string;
    try { text = readFileSync(join(dir, f), "utf8"); } catch (e) { errors.push(`${f} unreadable: ${(e as Error).message}`); continue; }
    text.split("\n").forEach((l, i) => {
      if (!l.trim()) return;
      let v: unknown;
      try { v = JSON.parse(l); } catch { errors.push(`${f}:${i + 1} is not valid JSON`); return; }
      if (!v || typeof v !== "object" || Array.isArray(v)) { errors.push(`${f}:${i + 1} is not a JSON object`); return; }
      lines.push(v as OutputLine);
    });
  }
  return { lines, errors };
}

/** Every parseable line of every outputs-*.jsonl in the ledger dir, oldest file first. Read side for Errata joins and tests. Lenient: verification uses readOutputLinesChecked. */
export function readOutputLines(dir = ledgerDir()): OutputLine[] {
  try {
    return readdirSync(dir)
      .filter((f) => /^outputs-\d{4}-\d{2}\.jsonl$/.test(f))
      .sort()
      .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").flatMap((l) => {
        if (!l.trim()) return [];
        try { return [JSON.parse(l) as OutputLine]; } catch { return []; }
      }));
  } catch { return []; }
}
