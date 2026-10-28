/**
 * SendGate — the check that lives inside every send and publish tool (assay-everywhere ISC-11, ISC-31, ISC-32; Design.md §6).
 *
 * Nothing leaves this machine under the principal's name, or to another person, without a passing proof of the exact bytes
 * being sent. The check is a library call made by the tool immediately before its network call, so it holds whoever runs
 * the tool: an interactive session, a launchd job, an employee agent, a daemon. A hook cannot promise that; a tool can.
 *
 * THREAT MODEL, stated once: the real security boundary is the uid. The agent runs as the same user as this code, so
 * anything it can read or write, this gate cannot hide. The guard is a DETERRENT (a PreToolUse path guard, signed tokens,
 * session binding) plus a DETECTOR (an append-only mint log that auditOverrides cross-checks against the output ledger,
 * a critical Vigil event on any mismatch). Admission never depends on state the agent can write without detection:
 * a stored receipt is never trusted to admit (the code tier always runs on the exact bytes), and an override token is an
 * HMAC under a Keychain key. A text guard cannot see `bun -e` or a script file that writes the state dir; the HMAC and the
 * tripwire are what cover that.
 *
 * What sendGate does with `{ channel, destination, body, attachments }`:
 *   1. Hashes the exact bytes (the body, and each attachment separately) and stores a content-addressed copy under the
 *      proof dir (0600), so what is proofed is byte-for-byte what is transmitted.
 *   2. ALWAYS runs Proof's code tier in-process, at the send's own destination, on those exact bytes (about 0.1 s). No
 *      judge runs inside a gate: the judge function handed to Proof throws, so any model check reads unavailable. A stored
 *      receipt is never an admission: it may only add an earned-judge no (a non-code fail finding) and can never lower a
 *      code fail. A tool that sets `toPrincipal` (every recipient is the principal's own address or line) proofs at
 *      hand-off, where the principal's own home path only flags; a real secret still fails there.
 *   3. A code fail, an earned no, or an unavailable measurement is `ok:false`; unearned flags are `ok:true` and returned
 *      for the caller to print.
 *   4. Fails CLOSED. Any exception inside the gate is `ok:false` ("send gate errored, nothing sent") plus a Vigil event that
 *      carries the channel, the kind and a sha prefix, never the body, an address or a path.
 *   5. A blocked send writes a pending record to the SendGate state dir (outside the USER repo, 0700/0600). Only the
 *      principal's own prompt, in the session that hit the block, can turn a pending record into a one-use, 15-minute,
 *      HMAC-signed override token bound to channel + destination (hooks/SendOverride.hook.ts, maintainer-side, not shipped); every mint is logged to an (maintainer-side; not in the public release)
 *      append-only mint log; auditOverrides() proves each `overridden` ledger line has a matching mint. The PreToolUse guard
 *      denies the agent any Bash/Write/Edit that touches the state dir. Headless callers cannot override, and a headless
 *      block is a high Vigil event.
 *
 * After the caller transmits successfully it calls recordSent / recordSentAll (or uses gatedTransmit, which does both),
 * which writes one OutputLedger line per item: sha256, bytes and a redacted target class, never content or an address.
 *
 * Doc: LIFEOS/DOCUMENTATION/Assay/AssaySystem.md § Sends and publishes.
 *
 * @version 1.1.0
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { invariant } from "../Invariant.ts";
import { getClaudeDir, getLifeosDir } from "../Paths.ts";
import { receiptDir, receiptHeadSha, receiptId, receiptProblem, SHA_LOOKUP_MAX_FILES, mayPresentSha, shaIndexDir, unindexedReceipts, type ProofFinding, type ProofReceipt } from "./ProofReceipt.ts";
import { identifyingShape, ledgerDir, readOutputLinesChecked, recordOutput, type OutputDecision, type OutputKind } from "./OutputLedger.ts";
import { outputKind } from "./ProofKinds.ts";
import { loadVigilEmit } from "./VigilOptional.ts";

export type SendDestination = "send" | "publish";
/** The destination a proof ran at: a send's own, or "handoff" for a message addressed only to the principal. */
type ProofDestination = SendDestination | "handoff";
export type GateKind = OutputKind;

export type GateInput = {
  /** A plain token naming the tool: gmail, x, discord, broadcast, imessage, omny. */
  channel: string;
  destination: SendDestination;
  /** The exact bytes the tool will transmit (for an email: the canonical text with the subject in it). */
  body: string | Uint8Array;
  kind?: GateKind;
  /** A redacted class for the ledger ("email", "x", "discord", "slack", "imessage"), never an address. */
  recipientClass?: string;
  /** Absolute paths of files transmitted beside the body; each is hashed and proofed on its own. */
  attachments?: string[];
  /**
   * True when every recipient is the principal's own address or line: a message to the principal is a hand-off, not an
   * outward send. The proof then runs at destination "handoff" (the principal's own home path only flags; a real secret
   * still fails) and a hand-off receipt admits it. The caller decides this from config, never from the message text.
   */
  toPrincipal?: boolean;
};

export type GateItem = { role: "body" | "attachment"; sha256: string; receipt_id: string; file: string; decision: "allowed" | "allowed-labelled" | "overridden" };
export type GateOk = { ok: true; receipt_id: string; sha256: string; reason: string; flags: ProofFinding[]; /** ISC-24: some admitted item had no ideal-state check pass; the send is labelled, never "proofed". */ unmeasured?: boolean; overridden: boolean; items: GateItem[]; channel: string; destination: ProofDestination; kind: GateKind; target: string };
export type GateBlocked = { ok: false; reason: string; findings: ProofFinding[]; sha256: string | null; proofCommand: string | null; file: string | null };
export type GateResult = GateOk | GateBlocked;

export type GateDeps = {
  /** SendGate state (pending records, tokens, override log). Default ~/.local/state/lifeos/sendgate or LIFEOS_SENDGATE_DIR. */
  stateDir?: string;
  /** Where the exact bytes proofed live. Default ~/.local/state/lifeos/send-proof or LIFEOS_SENDGATE_PROOF_DIR. */
  proofDir?: string;
  /** Output ledger dir; LIFEOS_OUTPUT_LEDGER_DIR also redirects it. */
  ledgerDir?: string;
  /** Vigil emitter; the default is LIFEOS/VIGIL/Emit.ts. */
  emit?: (event: Record<string, unknown>) => void;
  now?: () => Date;
  /** Treat the caller as headless (no override honored). Default: LIFEOS_NOTIFICATION_CHANNEL === "headless". */
  headless?: boolean;
  /** Session id stamped on pending records (default CLAUDE_SESSION_ID). */
  sessionId?: string;
  /** HMAC key for override tokens and mint records. Test seam only: the default is the macOS Keychain item. */
  mintKey?: string;
  /** Where the override-minting hook would be installed. Default: the hooks directory of the Claude home. */
  hooksDir?: string;
  /** Test seam: replaces Proof's runProof. */
  runProofFn?: (o: { artifact: string; destination: ProofDestination; judgeManyFn: () => Promise<never> }) => Promise<unknown>;
};

export const TOKEN_TTL_MS = 15 * 60_000;
export const PENDING_MAX_AGE_MS = 60 * 60_000;
const HEX64 = /^[0-9a-f]{64}$/;
const CHANNEL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const TARGET_CLASS = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
const SEND_DESTS: readonly string[] = ["send", "publish"];

export function sendGateStateDir(deps: Pick<GateDeps, "stateDir"> = {}): string {
  if (deps.stateDir) return deps.stateDir;
  if (process.env.LIFEOS_SENDGATE_DIR) return process.env.LIFEOS_SENDGATE_DIR;
  // Under `bun test` with no override the state is a per-process temp dir, so a test can never write the real one.
  if (process.env.NODE_ENV === "test") return join(tmpdir(), `lifeos-sendgate-test-${process.pid}`);
  return join(homedir(), ".local", "state", "lifeos", "sendgate");
}
export function sendGateProofDir(deps: Pick<GateDeps, "proofDir"> = {}): string {
  if (deps.proofDir) return deps.proofDir;
  if (process.env.LIFEOS_SENDGATE_PROOF_DIR) return process.env.LIFEOS_SENDGATE_PROOF_DIR;
  if (process.env.NODE_ENV === "test") return join(tmpdir(), `lifeos-send-proof-test-${process.pid}`);
  return join(homedir(), ".local", "state", "lifeos", "send-proof");
}

const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
function privateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}
function writePrivate(file: string, data: string | Uint8Array): void {
  writeFileSync(file, data, { mode: 0o600 });
  chmodSync(file, 0o600);
}
const isHeadless = (deps: GateDeps): boolean => deps.headless ?? process.env.LIFEOS_NOTIFICATION_CHANNEL === "headless";

// ── Vigil (never throws, never carries a body, an address or a path) ──────────

function vigil(kind: GateKind | "n/a", channel: string, shaPrefix: string, what: string, deps: GateDeps, severity: "high" | "critical" = "high"): void {
  try {
    const now = (deps.now ?? (() => new Date()))();
    const safeChannel = CHANNEL.test(channel) ? channel : "unknown";
    const event = {
      id: randomUUID(), source: "sendgate", ts: now.toISOString(), kind: "security", severity,
      title: what.slice(0, 120),
      summary: `channel=${safeChannel} kind=${kind} sha=${shaPrefix}`,
      ref: null, url: null, privacy_class: "public",
      dedup_key: `sendgate:${what.replace(/[^a-z]+/gi, "-").toLowerCase().slice(0, 40)}:${safeChannel}:${shaPrefix}:${Math.floor(now.getTime() / 3_600_000)}`,
    };
    if (deps.emit) { deps.emit(event); return; }
    try { loadVigilEmit()?.(event as never); } catch { /* the outbox is best effort */ }
  } catch { /* a monitoring failure never changes the gate's answer */ }
}

// ── Pending records and override tokens ───────────────────────────────────────

export type PendingRecord = { id: string; sha: string; shas: string[]; channel: string; destination: SendDestination; reason: string; ts: string; session_id?: string };
export type OverrideToken = { pending_id: string; shas: string[]; channel: string; destination: SendDestination; session_id: string; minted_at: string; expires_at: string; hmac: string };

const pendingDir = (deps: GateDeps) => join(sendGateStateDir(deps), "pending");
const tokenDir = (deps: GateDeps) => join(sendGateStateDir(deps), "tokens");
export const MINT_KEY_SERVICE = "lifeos-sendgate-mint";
const MINT_LOG = "mints.jsonl";

const sessionIdOf = (deps: GateDeps): string => deps.sessionId ?? process.env.CLAUDE_SESSION_ID ?? "";

/**
 * The HMAC key: the macOS login Keychain item `lifeos-sendgate-mint`. `create` makes it on the first mint; the consume
 * side never creates one (no key means no token can verify, so nothing is admitted). Tests inject `deps.mintKey`.
 * No environment override exists: a key an agent could set for one command would let it sign its own token.
 */
export function mintKey(deps: GateDeps = {}, create = false): string | null {
  if (deps.mintKey !== undefined) return deps.mintKey.length >= 8 ? deps.mintKey : null;
  const read = (): string | null => {
    try { const k = execFileSync("security", ["find-generic-password", "-s", MINT_KEY_SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim(); return k.length >= 16 ? k : null; } catch { return null; }
  };
  const have = read();
  if (have || !create) return have;
  try { execFileSync("security", ["add-generic-password", "-a", "lifeos", "-s", MINT_KEY_SERVICE, "-w", randomBytes(32).toString("hex")], { stdio: ["ignore", "ignore", "ignore"], timeout: 5000 }); } catch { /* raced or denied: read below decides */ }
  return read();
}

type Signed = Pick<OverrideToken, "pending_id" | "shas" | "channel" | "destination" | "session_id" | "minted_at" | "expires_at">;
/** HMAC-SHA256 over (pending_id, shas, channel, destination, session_id, minted_at, expires_at), hex. */
export function signToken(t: Signed, key: string): string {
  return createHmac("sha256", key).update(JSON.stringify([t.pending_id, t.shas, t.channel, t.destination, t.session_id, t.minted_at, t.expires_at])).digest("hex");
}
function hmacOk(t: Signed & { hmac?: unknown }, key: string): boolean {
  if (typeof t.hmac !== "string" || !HEX64.test(t.hmac)) return false;
  if (!Array.isArray(t.shas) || typeof t.pending_id !== "string" || typeof t.channel !== "string" || typeof t.destination !== "string" || typeof t.session_id !== "string" || typeof t.minted_at !== "string" || typeof t.expires_at !== "string") return false;
  const want = Buffer.from(signToken(t, key), "hex"), got = Buffer.from(t.hmac, "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}

function writePending(rec: PendingRecord, deps: GateDeps): void {
  invariant(HEX64.test(rec.sha) && rec.shas.length > 0 && rec.shas.every((s) => HEX64.test(s)), "a pending send record names sha256 hashes");
  invariant(CHANNEL.test(rec.channel) && SEND_DESTS.includes(rec.destination), "a pending send record names a channel token and a send destination");
  invariant(rec.reason.length > 0 && rec.reason.length <= 500, "a pending send record carries a bounded reason");
  const dir = privateDir(pendingDir(deps));
  writePrivate(join(dir, `${rec.id}.json`), JSON.stringify(rec));
  // Old records are noise; the dir stays small.
  const cutoff = Date.parse(rec.ts) - 24 * 3_600_000;
  for (const f of readdirSync(dir)) { try { if (statSync(join(dir, f)).mtimeMs < cutoff) unlinkSync(join(dir, f)); } catch { /* raced */ } }
}

/** Pending records, newest first. */
export function listPending(deps: GateDeps = {}): PendingRecord[] {
  const dir = pendingDir(deps);
  if (!existsSync(dir)) return [];
  const out: PendingRecord[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as PendingRecord;
      if (r && typeof r.id === "string" && Array.isArray(r.shas) && r.shas.every((s) => HEX64.test(s)) && Number.isFinite(Date.parse(r.ts))) out.push(r);
    } catch { /* unreadable record: ignored */ }
  }
  return out.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}

/**
 * A send tool run from Bash has no session id, so its block is written with none and no override could ever release it.
 * The PostToolUse side of that Bash call knows the session: it passes the call's output, and every pending record with no
 * session whose `Block <sha8>` line appears in that output, written in the last ten minutes, is stamped with the
 * session. Matching on the printed sha prefix ties the record to the exact call that printed it.
 */
export function stampPendingSession(output: string, sessionId: string, deps: GateDeps = {}, now = Date.now()): number {
  if (!sessionId || !output.includes("Block ")) return 0;
  const shown = new Set([...output.matchAll(/\bBlock ([0-9a-f]{8})\b/g)].map((m) => m[1]!));
  if (shown.size === 0) return 0;
  let n = 0;
  for (const r of listPending(deps)) {
    if (r.session_id || !shown.has(r.sha.slice(0, 8)) || now - Date.parse(r.ts) > 600_000) continue;
    invariant(sessionId.length <= 200, "a session id is bounded");
    writePrivate(join(privateDir(pendingDir(deps)), `${r.id}.json`), JSON.stringify({ ...r, session_id: sessionId }));
    n++;
  }
  return n;
}

/** True when a token was ever minted for this pending record (live or used): one override per block. */
export function tokenExists(pendingId: string, deps: GateDeps = {}): boolean {
  const dir = tokenDir(deps);
  return existsSync(join(dir, `${pendingId}.json`)) || existsSync(join(dir, `${pendingId}.used`));
}

/**
 * Mint the one-use, 15-minute, HMAC-signed token for a pending record, and append one line to the mint log. Called only
 * by the principal-prompt hook. Returns null when a token already exists for the record or no key can be had.
 */
export function mintToken(rec: PendingRecord, deps: GateDeps = {}): OverrideToken | null {
  if (tokenExists(rec.id, deps)) return null;
  const key = mintKey(deps, true);
  if (!key) return null;
  const now = (deps.now ?? (() => new Date()))();
  const base: Signed = { pending_id: rec.id, shas: rec.shas, channel: rec.channel, destination: rec.destination, session_id: rec.session_id ?? "", minted_at: now.toISOString(), expires_at: new Date(now.getTime() + TOKEN_TTL_MS).toISOString() };
  invariant(base.shas.length > 0 && base.shas.every((s) => HEX64.test(s)), "a token names sha256 hashes");
  invariant(CHANNEL.test(base.channel) && SEND_DESTS.includes(base.destination), "a token binds a channel token and a send destination");
  invariant(Date.parse(base.expires_at) - Date.parse(base.minted_at) === TOKEN_TTL_MS, "a token lives exactly 15 minutes");
  const token: OverrideToken = { ...base, hmac: signToken(base, key) };
  const dir = privateDir(tokenDir(deps));
  writePrivate(join(dir, `${rec.id}.json`), JSON.stringify(token));
  // The tripwire's other half: every legitimate mint leaves one append-only line the ledger audit can match.
  const logDir = privateDir(sendGateStateDir(deps));
  appendFileSync(join(logDir, MINT_LOG), JSON.stringify({ ...token }) + "\n", { mode: 0o600 });
  chmodSync(join(logDir, MINT_LOG), 0o600);
  return token;
}

/**
 * A live, correctly signed token covering every sha and bound to this channel + destination, consumed atomically
 * (rename) so a token admits exactly one send. A token whose HMAC does not verify is never consumed and never admits.
 */
function consumeToken(shas: string[], channel: string, destination: SendDestination, deps: GateDeps): OverrideToken | null {
  const dir = tokenDir(deps);
  if (!existsSync(dir)) return null;
  const key = mintKey(deps, false);
  if (!key) return null;
  const now = (deps.now ?? (() => new Date()))().getTime();
  const session = sessionIdOf(deps);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let t: OverrideToken;
    try { t = JSON.parse(readFileSync(join(dir, f), "utf8")) as OverrideToken; } catch { continue; }
    if (!t || !Array.isArray(t.shas) || !(Date.parse(t.expires_at) > now)) continue;
    if (!hmacOk(t, key)) continue;
    if (t.channel !== channel || t.destination !== destination) continue;
    if (!shas.every((s) => t.shas.includes(s))) continue;
    // Session binding: a token minted for one session never releases a send from another, and a consumer with no
    // session id at all admits nothing.
    if (!session || t.session_id !== session) continue;
    try { renameSync(join(dir, f), join(dir, f.replace(/\.json$/, ".used"))); } catch { continue; } // another caller won it
    return t;
  }
  return null;
}

// ── The gate ─────────────────────────────────────────────────────────────────

const KIND_EXT: Record<string, string> = { text: ".txt", page: ".html", doc: ".txt", image: ".png", audio: ".mp3", video: ".mp4", diff: ".txt" };

type Item = { role: "body" | "attachment"; bytes: Uint8Array; sha: string; file: string };

function toolHint(channel: string): string { return CHANNEL.test(channel) ? channel : "tool"; }

function blockedFindings(receipt: ProofReceipt | null): ProofFinding[] {
  return (receipt?.findings ?? []).filter((f) => f.severity === "fail" || f.severity === "unavailable");
}

/**
 * Every earned failure (a failed check from a tier that really ran, never the code tier) in ANY stored receipt that
 * describes exactly these bytes. Read before this send's own code-only receipt exists, so that receipt can neither
 * shadow an older earned failure in a newest-first lookup nor be mistaken for evidence itself. Read-only, bounded
 * by file count and time, never throws. A scan that cannot cover the whole store (too many files, out of time, the
 * directory or a receipt unreadable) says so with `complete: false`, and the gate refuses rather than admitting on a
 * partial look: a match it never read is not "no earned failure".
 */
export type EarnedScan = { findings: ProofFinding[]; complete: true } | { findings: ProofFinding[]; complete: false; why: string };
/** How long a send may spend reading the receipt store before it is held as incomplete. */
export const SEND_SCAN_BUDGET_MS = 8000;

export { receiptHeadSha };

export function earnedFailuresBySha(sha: string, dir: string = receiptDir(), budgetMs = 1000, maxFiles = SHA_LOOKUP_MAX_FILES, clock: () => number = () => performance.now()): EarnedScan {
  const out: ProofFinding[] = [];
  try {
    if (!HEX64.test(sha)) return { findings: out, complete: false, why: "the bytes have no valid sha256" };
    if (!existsSync(dir)) return { findings: out, complete: true }; // no store yet: nothing was ever recorded
    const deadline = clock() + budgetMs;
    // ISC-43: an indexed receipt can describe these bytes only if by-sha/<sha>/ points at it; a receipt the index does
    // not list could describe any bytes, so it is read in full. Every receipt read gets the same checks as before.
    const pointed = join(shaIndexDir(dir), sha);
    const names = [...new Set([
      ...(existsSync(pointed) ? readdirSync(pointed).filter((x) => HEX64.test(x)).map((x) => `${x}.json`) : []),
      ...unindexedReceipts(dir),
    ])];
    if (names.length > maxFiles) return { findings: out, complete: false, why: `the receipt store holds ${names.length} receipts, past the ${maxFiles} the gate can read` };
    for (const n of names) {
      if (clock() > deadline) return { findings: out, complete: false, why: `the receipt scan ran past its ${budgetMs} ms budget` };
      // Proof writes receipts pretty-printed with the top-level sha256 as the third key, inside the first few hundred
      // bytes. When the head shows that key holding other bytes' sha, the receipt describes other bytes and the rest
      // of it is never read (reading a very large store can run past the send budget and hold every send). A head with
      // no such key (another layout, a torn file) falls through to the full read below.
      const headSha = receiptHeadSha(join(dir, n));
      if (headSha !== null && headSha !== sha) continue;
      let text: string;
      try { text = readFileSync(join(dir, n), "utf8"); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // removed between listing and read
        return { findings: out, complete: false, why: `receipt ${n.slice(0, 8)} is unreadable` };
      }
      // A receipt for these bytes carries `"sha256": "<sha>"` verbatim, so a file without the sha text cannot match;
      // skipping its parse changes no verdict and keeps a ~1 GB store inside the budget (a full parse of
      // thousands of receipts can run past the budget and hold every send).
      // JSON may spell the same sha with \u escapes, which the text test cannot see, so a file holding any escape is
      // parsed too (S059 final review: an escaped sha skipped a receipt for these exact bytes). JSON.stringify writes
      // \u only for control characters and lone surrogates, so this adds a parse for almost no stored receipt.
      if (!text.includes(sha) && !text.includes("\\u")) continue;
      let raw: unknown;
      // A file that holds this sha but cannot be parsed, or parses as a receipt for these bytes that the validator
      // rejects, may be the one record of an earned failure: the scan cannot say "none" past it (S059). Receipts are
      // written by rename, so a torn one is damage or tampering, never a write in progress. The send is held until
      // the file is repaired or removed.
      try { raw = JSON.parse(text); } catch {
        return { findings: out, complete: false, why: `receipt ${n.slice(0, 8)} holds these bytes' sha but is malformed and cannot be parsed` };
      }
      if (!raw || typeof raw !== "object" || (raw as { sha256?: unknown }).sha256 !== sha) {
        // The head named these bytes but the parsed receipt names others: a duplicate key or a damaged file. The
        // proof writer (JSON.stringify) never writes that, so the scan cannot call it "not these bytes" (S059).
        if (headSha === sha) return { findings: out, complete: false, why: `receipt ${n.slice(0, 8)} names these bytes' sha in its head but parses as a receipt for other bytes` };
        continue;
      }
      const problem = receiptProblem(raw);
      if (problem !== null) return { findings: out, complete: false, why: `receipt ${n.slice(0, 8)} for these bytes is invalid: ${problem}` };
      for (const f of (raw as ProofReceipt).findings ?? []) if (f.severity === "fail" && f.tier !== "code") out.push(f);
    }
    return { findings: out, complete: true };
  } catch (e) {
    return { findings: out, complete: false, why: `the receipt store could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function proofItem(item: Item, destination: ProofDestination, deps: GateDeps): Promise<{ ok: true; receipt_id: string; flags: ProofFinding[]; reason: string; unmeasured: boolean } | { ok: false; reason: string; findings: ProofFinding[] }> {
  // B1: no admission by receipt. The code tier always runs, in-process, on the exact bytes at this send's destination.
  // A stored receipt is state the agent could have written (same uid), so it never admits and never softens a code fail.
  const run = deps.runProofFn ?? (async (o: { artifact: string; destination: ProofDestination; judgeManyFn: () => Promise<never> }) => {
    const { runProof } = await import("../../../skills/Assay/Tools/Proof.ts");
    return runProof(o as never);
  });
  // Earned failures are collected from the store BEFORE this send writes its own code-only receipt for the same bytes.
  // No file cap: the live store passed 5,000 receipts in 2026-10, and a capped scan holds the send (fail closed).
  // With the store indexed this reads only the receipts for these bytes plus any unindexed ones (ISC-43).
  const priorScan = earnedFailuresBySha(item.sha, receiptDir(), SEND_SCAN_BUDGET_MS, Number.POSITIVE_INFINITY);
  if (!priorScan.complete) return { ok: false, reason: `the earned-failure check could not finish (${priorScan.why}), so the send is held`, findings: priorScan.findings };
  const priorEarned = priorScan.findings;
  // No judge runs inside a gate: a model check that is asked for reads unavailable, never a pass.
  await run({ artifact: item.file, destination, judgeManyFn: async () => { throw new Error("no judge runs inside a send gate"); } });
  const v = await mayPresentSha(item.file, item.sha);
  if (!v.ok) return { ok: false, reason: v.reason, findings: blockedFindings(v.receipt) };
  // A stored receipt (any destination) may only ADD earned findings: a non-code fail from a judge that really ran.
  const earned = priorEarned;
  if (earned.length > 0) return { ok: false, reason: `an earned check said no: ${[...new Set(earned.map((f) => f.check))].join(", ")}`, findings: earned };
  return { ok: true, receipt_id: receiptId(item.file), flags: v.flags, reason: v.reason, unmeasured: v.unmeasured === true };
}

function classTarget(input: GateInput): string {
  const r = (input.recipientClass ?? "").toLowerCase();
  if (TARGET_CLASS.test(r)) return r;
  const c = input.channel.toLowerCase();
  return TARGET_CLASS.test(c) ? c : "other";
}

function pruneProofDir(dir: string, nowMs: number): void {
  try { for (const f of readdirSync(dir)) { try { if (nowMs - statSync(join(dir, f)).mtimeMs > 24 * 3_600_000) unlinkSync(join(dir, f)); } catch { /* raced */ } } } catch { /* absent */ }
}

/** The proof command for a file, in the exact form the principal or the DA can run. */
export function proofCommand(file: string, destination: ProofDestination): string {
  return `bun skills/Assay/Tools/Proof.ts run --artifact ${file} --destination ${destination}`;
}

export async function sendGate(input: GateInput, deps: GateDeps = {}): Promise<GateResult> {
  let shaPrefix = "none";
  let kind: GateKind = input.kind ?? "text";
  try {
    invariant(CHANNEL.test(input.channel), "a send names its channel as a plain token");
    invariant(SEND_DESTS.includes(input.destination), "a send gate destination is send or publish");
    invariant(input.toPrincipal === undefined || typeof input.toPrincipal === "boolean", "toPrincipal is a boolean the tool computed");
    const proofDest: ProofDestination = input.toPrincipal === true ? "handoff" : input.destination;
    const bodyBytes = typeof input.body === "string" ? new TextEncoder().encode(input.body) : input.body;
    kind = input.kind ?? "text";
    const proofDir = privateDir(sendGateProofDir(deps));
    pruneProofDir(proofDir, (deps.now ?? (() => new Date()))().getTime());

    const items: Item[] = [];
    // The proofed copy is keyed by sha AND a per-call id: two identical sends in flight each own their copy, so one's
    // recordSent/discardSent can never unlink the other's before it is recorded.
    const callId = randomUUID().slice(0, 8);
    const add = (role: Item["role"], bytes: Uint8Array, ext: string): Item => {
      const sha = sha256(bytes);
      const file = join(proofDir, `${sha}-${callId}-${items.length}${ext}`);
      invariant(HEX64.test(sha), "an item sha256 is 64 hex characters");
      writePrivate(file, bytes);
      invariant(statSync(file).size === bytes.length, "the proofed copy is the byte length of what will be sent");
      const it = { role, bytes, sha, file };
      items.push(it);
      return it;
    };
    const body = add("body", bodyBytes, KIND_EXT[kind] ?? ".txt");
    shaPrefix = body.sha.slice(0, 8);
    const missing: string[] = [];
    for (const a of input.attachments ?? []) {
      if (!isAbsolute(a) || !existsSync(a) || !statSync(a).isFile()) { missing.push(basename(a)); continue; }
      add("attachment", new Uint8Array(readFileSync(a)), extname(a).toLowerCase() || ".bin");
    }
    if (missing.length) {
      return writeBlock(input, items, `attachment not found: ${missing.join(", ")}`, [], deps);
    }

    const done: { item: Item; r: Awaited<ReturnType<typeof proofItem>> }[] = [];
    for (const item of items) done.push({ item, r: await proofItem(item, proofDest, deps) });
    const failed = done.filter((d) => !d.r.ok);
    const flags = done.flatMap((d) => (d.r.ok ? d.r.flags : []));
    const unmeasured = done.some((d) => d.r.ok && d.r.unmeasured);

    if (failed.length === 0) {
      const gi: GateItem[] = done.map((d) => ({ role: d.item.role, sha256: d.item.sha, receipt_id: (d.r as { receipt_id: string }).receipt_id, file: d.item.file, decision: flags.length || unmeasured ? "allowed-labelled" : "allowed" }));
      return { ok: true, receipt_id: gi[0]!.receipt_id, sha256: body.sha, reason: (done[0]!.r as { reason: string }).reason, flags, ...(unmeasured ? { unmeasured } : {}), overridden: false, items: gi, channel: input.channel, destination: proofDest, kind, target: classTarget(input) };
    }

    // Blocked. The principal's override token (minted only by their own prompt) is the one way through.
    const failedShas = [...new Set(failed.map((d) => d.item.sha))];
    if (!isHeadless(deps) && consumeToken(failedShas, input.channel, input.destination, deps)) {
      logOverride(input, failedShas, deps);
      const gi: GateItem[] = done.map((d) => ({ role: d.item.role, sha256: d.item.sha, receipt_id: d.r.ok ? d.r.receipt_id : receiptId(d.item.file), file: d.item.file, decision: d.r.ok ? "allowed" : "overridden" }));
      return { ok: true, receipt_id: gi[0]!.receipt_id, sha256: body.sha, reason: "principal override", flags, overridden: true, items: gi, channel: input.channel, destination: proofDest, kind, target: classTarget(input) };
    }
    const first = failed[0]!;
    const why = (first.r as { reason: string }).reason;
    return writeBlock(input, items, why, failed.flatMap((d) => (d.r.ok ? [] : d.r.findings)), deps, failedShas, first.item.file);
  } catch (e) {
    vigil(kind, input.channel, shaPrefix, "Send gate errored, nothing sent", deps);
    return { ok: false, reason: `send gate errored, nothing sent (${e instanceof Error ? e.name : "error"})`, findings: [], sha256: null, proofCommand: null, file: null };
  }
}

function writeBlock(input: GateInput, items: Item[], reason: string, findings: ProofFinding[], deps: GateDeps, shas?: string[], file?: string): GateBlocked {
  const list = shas ?? [items[0]!.sha];
  const bodyFile = file ?? items[0]!.file;
  const now = (deps.now ?? (() => new Date()))();
  // S4: a headless block can never be overridden, so nobody is looking at it. Say so, content-free, at high severity.
  if (isHeadless(deps)) vigil(input.kind ?? "text", input.channel, list[0]!.slice(0, 8), "Headless send blocked, no override possible", deps);
  try {
    writePending({ id: `p_${now.getTime().toString(36)}_${randomUUID().slice(0, 8)}`, sha: list[0]!, shas: list, channel: input.channel, destination: input.destination, reason: reason.replace(/\s+/g, " ").slice(0, 400) || "blocked", ts: now.toISOString(), session_id: sessionIdOf(deps) }, deps);
  } catch (e) {
    if (e instanceof Error && e.name === "InvariantViolation") throw e;
    /* a state dir that cannot be written only means no override is possible */
  }
  recordBlockedSend(input, items.filter((it) => list.includes(it.sha)), reason, deps);
  return { ok: false, reason, findings, sha256: list[0]!, proofCommand: proofCommand(bodyFile, input.toPrincipal === true ? "handoff" : input.destination), file: bodyFile };
}

/**
 * One output line with decision "blocked" per blocked item, written from the proofed copy the gate already holds (the bytes
 * that would have gone out). The copy stays: the override and re-proof road reads it. Never throws and never changes the block.
 */
function recordBlockedSend(input: GateInput, blocked: Item[], reason: string, deps: GateDeps): void {
  for (const it of blocked) {
    try {
      const clip = `blocked by SendGate: ${reason.replace(/\s+/g, " ")}`.slice(0, 240);
      recordOutput({
        session_id: sessionIdOf(deps) || "send-tool", boundary: input.destination, channel: input.channel,
        kind: it.role === "body" ? (input.kind ?? "text") : ((outputKind(it.file) as OutputKind | null) ?? "text"), target: classTarget(input),
        artifact: it.file, receipt_id: null, decision: "blocked",
        reason: identifyingShape(clip) === null ? clip : "blocked by SendGate: the proof check failed",
        approved_sha256: null, now: (deps.now ?? (() => new Date()))(), dir: deps.ledgerDir,
      });
    } catch { /* a ledger error costs the line, never the block */ }
  }
}

function logOverride(input: GateInput, shas: string[], deps: GateDeps): void {
  try {
    const dir = privateDir(sendGateStateDir(deps));
    const now = (deps.now ?? (() => new Date()))();
    appendFileSync(join(dir, "overrides.jsonl"), JSON.stringify({ ts: now.toISOString(), channel: input.channel, destination: input.destination, shas: shas.map((s) => s.slice(0, 12)) }) + "\n", { mode: 0o600 });
    chmodSync(join(dir, "overrides.jsonl"), 0o600);
  } catch { /* the output line records the override too */ }
}

/** True when the principal-prompt hook that mints override tokens is present in this install's hooks directory. */
export function overrideMinterInstalled(deps: Pick<GateDeps, "hooksDir"> = {}): boolean {
  return existsSync(join(deps.hooksDir ?? join(getClaudeDir(), "hooks"), "SendOverride.hook.ts")); // private minter, not shipped: false on a public install
}

/** What a tool prints and exits non-zero with when the gate says no. Never contains the body. */
export function formatBlocked(g: GateBlocked, tool: string, deps: Pick<GateDeps, "hooksDir"> = {}): string {
  const lines = [`SEND BLOCKED (${toolHint(tool)}): ${g.reason}`];
  for (const f of g.findings.slice(0, 8)) lines.push(`  - ${f.check}: ${String(f.message).replace(/\s+/g, " ").slice(0, 160)}`);
  if (g.sha256) lines.push(`Block ${g.sha256.slice(0, 8)}`);
  if (g.file) lines.push(`Exact bytes checked: ${g.file}`);
  if (g.proofCommand) lines.push(`Clear it (fix the content, then the tool re-checks it): ${g.proofCommand}`);
  // The override path exists only where the hook that mints tokens is installed; a public install does not ship it.
  if (g.sha256 && overrideMinterInstalled(deps)) lines.push("Only the principal can override: they say \"send it anyway\" in the session, then re-run the same command.");
  lines.push("Nothing was sent.");
  return lines.join("\n");
}

// ── After the transmit ───────────────────────────────────────────────────────

export type SentMeta = { /** The exact proofed copy this item was admitted on (GateItem.file). Without it the copy is looked up by sha. */ file?: string; channel: string; destination: ProofDestination; sha256: string; receipt_id: string; decision: OutputDecision; reason: string; target?: string; kind?: GateKind; skill?: string | null; session_id?: string };

/** One output line for a transmitted item. Call only after the transmit returned. Never throws: the message is already gone. */
export function recordSent(m: SentMeta, deps: GateDeps = {}): { ok: true } | { ok: false; error: string } {
  try {
    invariant(HEX64.test(m.sha256), "recordSent needs a sha256 hex digest");
    const dir = sendGateProofDir(deps);
    let file: string | null = null;
    if (m.file) {
      // The caller's exact copy, only when it is a direct child of the proof dir and named for this sha.
      invariant(dirname(resolve(m.file)) === resolve(dir) && basename(m.file).startsWith(m.sha256), "the proofed copy is this item's own file in the proof dir");
      file = existsSync(m.file) ? m.file : null;
    } else {
      const f = existsSync(dir) ? readdirSync(dir).find((n) => n.startsWith(m.sha256)) : undefined;
      file = f ? join(dir, f) : null;
    }
    if (!file) {
      vigil(m.kind ?? "text", m.channel, m.sha256.slice(0, 8), "Output line not written: proofed copy missing", deps);
      return { ok: false, error: "proofed copy missing" };
    }
    const r = recordOutput({
      session_id: m.session_id ?? process.env.CLAUDE_SESSION_ID ?? "send-tool", skill: m.skill ?? null,
      boundary: m.destination, channel: m.channel, kind: m.kind ?? (outputKind(file) as OutputKind | null) ?? "text", target: m.target ?? "other",
      artifact: file, receipt_id: m.receipt_id, decision: m.decision, reason: m.reason.slice(0, 200),
      approved_sha256: m.sha256, dir: deps.ledgerDir,
    });
    try { unlinkSync(file); } catch { /* pruned later */ }
    if (!r.ok) {
      vigil(m.kind ?? "text", m.channel, m.sha256.slice(0, 8), "Output line not written after a send", deps);
      return { ok: false, error: r.error };
    }
    if (r.mismatch) vigil(m.kind ?? "text", m.channel, m.sha256.slice(0, 8), "Sent bytes differ from proofed bytes", deps);
    return { ok: true };
  } catch (e) {
    // Deliberate exception to "never catch an InvariantViolation into a typed error": this runs AFTER the bytes were
    // transmitted, so a throw here could make a caller retry and send twice. The violation is loud instead (Vigil, above).
    vigil(m.kind ?? "text", m.channel, m.sha256.slice(0, 8), "Output line not written after a send", deps);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * recordSent for every item the gate admitted. The body's line is first. Every result is checked: a failed item has already
 * emitted its own content-free Vigil event, and a batch with any failure emits one more naming the counts. Never throws.
 */
export function recordSentAll(g: GateOk, extra: { skill?: string | null } = {}, deps: GateDeps = {}): { ok: boolean; recorded: number; failed: number } {
  let recorded = 0, failed = 0;
  for (const it of g.items) {
    const r = recordSent({
      file: it.file, channel: g.channel, destination: g.destination, sha256: it.sha256, receipt_id: it.receipt_id,
      decision: it.decision,
      reason: g.overridden ? "principal override" : g.flags.length ? `proofed, ${g.flags.length} unearned flag(s) shown` : g.unmeasured ? "admitted unmeasured: no ideal-state check passed" : "proofed, no code fail",
      target: g.target, kind: it.role === "body" ? g.kind : undefined, skill: extra.skill,
    }, deps);
    if (r.ok) recorded++; else failed++;
  }
  if (failed > 0) vigil(g.kind, g.channel, g.sha256.slice(0, 8), `Output lines not written: ${failed} of ${g.items.length}`, deps);
  return { ok: failed === 0, recorded, failed };
}

/** Drop the proofed copies of a send that was admitted but failed to transmit. */
export function discardSent(g: GateOk): void {
  for (const it of g.items) { try { unlinkSync(it.file); } catch { /* gone */ } }
}

/**
 * The one call a send tool makes: gate, transmit, record. The transmit closure runs only after an `ok`, and the output
 * line is written only after it returned. A throw from the transmit discards the proofed copies and rethrows.
 */
export async function gatedTransmit<T>(input: GateInput, transmit: (g: GateOk) => Promise<T>, deps: GateDeps = {}, extra: { skill?: string | null } = {}): Promise<{ ok: true; gate: GateOk; result: T; recorded: boolean } | GateBlocked> {
  const g = await sendGate(input, deps);
  if (!g.ok) return g;
  let result: T;
  try { result = await transmit(g); } catch (e) { discardSent(g); throw e; }
  const rec = recordSentAll(g, extra, deps);
  return { ok: true, gate: g, result, recorded: rec.ok };
}

// ── Relay: messages to the principal's own line are notifications, not outward ─

const digits = (s: string): string => s.replace(/\D/g, "");

/** True only when `to` is exactly one of the principal's own numbers in the bridge's 0600 config. Unreadable config means not own. */
export function isOwnLine(to: string, deps: { configPath?: string; numbers?: string[] } = {}): boolean {
  try {
    const want = digits(to);
    if (want.length < 7) return false;
    let numbers = deps.numbers;
    if (!numbers) {
      const cfgPath = deps.configPath ?? join(getLifeosDir(), "USER", "RELAY", "state", "bridge-config.json");
      const raw = JSON.parse(readFileSync(cfgPath, "utf8")) as { ownChannels?: { numbers?: string[] } };
      numbers = raw.ownChannels?.numbers ?? []; // only the principal's own numbers count; allowFrom is who may text in, not who is the principal
    }
    return numbers.some((n) => digits(String(n)) === want);
  } catch { return false; }
}

// ── The tripwire: every overridden ledger line must trace to a mint ──────────

export type AuditResult = { checked: number; unmatched: { sha: string; ts: string }[] };
const AUDIT_SKEW_MS = 5 * 60_000;

/**
 * Every output-ledger line whose decision is `overridden` must have a mint-log entry: a signed mint whose shas include the
 * line's sha, minted at or before the line, and not expired more than a small skew before it. A mint-log line whose HMAC
 * does not verify does not count. Any unmatched line emits one critical Vigil event (sha prefix only). Uid is the boundary:
 * an agent that can write the ledger and the mint log AND read the Keychain key can fake both; this detects the cheap forgeries.
 */
export function auditOverrides(deps: GateDeps = {}): AuditResult {
  const read = readOutputLinesChecked(deps.ledgerDir ?? ledgerDir());
  // A ledger the audit cannot read whole proves nothing: fail loud (the /ic caller records a scan error, exit 2), never "checked 0".
  if (read.errors.length > 0) {
    vigil("n/a", "ledger", "unread", `Override audit could not read the output ledger (${read.errors.length} error${read.errors.length === 1 ? "" : "s"})`, deps, "critical");
    throw new Error(`auditOverrides: the output ledger could not be read whole, so overrides cannot be verified: ${read.errors.slice(0, 3).join("; ")}`);
  }
  const lines = read.lines.filter((l) => l.decision === "overridden");
  const logFile = join(sendGateStateDir(deps), MINT_LOG);
  const mints: OverrideToken[] = [];
  const key = mintKey(deps, false);
  if (existsSync(logFile)) {
    for (const raw of readFileSync(logFile, "utf8").split("\n")) {
      if (!raw.trim()) continue;
      try { const t = JSON.parse(raw) as OverrideToken; if (key && hmacOk(t, key)) mints.push(t); } catch { /* a torn line matches nothing */ }
    }
  }
  const unmatched: AuditResult["unmatched"] = [];
  for (const l of lines) {
    const at = Date.parse(l.ts);
    const hit = mints.some((m) => m.shas.includes(l.sha256) && Date.parse(m.minted_at) - AUDIT_SKEW_MS <= at && at <= Date.parse(m.expires_at) + AUDIT_SKEW_MS);
    if (!hit) { unmatched.push({ sha: l.sha256, ts: l.ts }); vigil(l.kind, l.channel, l.sha256.slice(0, 8), "Override with no matching mint", deps, "critical"); }
  }
  return { checked: lines.length, unmatched };
}

// ── PreToolUse deny rule: the agent never touches the state dir ───────────────

function resolvedWithin(p: string, root: string): boolean {
  const real = (x: string): string => { try { return realpathSync(x); } catch { return resolve(x); } };
  // A path that does not exist yet is resolved through its deepest existing parent, so a symlinked component cannot hide it.
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur) && dirname(cur) !== cur) { tail.unshift(basename(cur)); cur = dirname(cur); }
  const target = join(real(cur), ...tail);
  const r = real(root);
  return target === r || target.startsWith(r + sep);
}

/** The state dirs a write must never reach: the SendGate state dir, by its configured and its default location. */
function protectedRoots(deps: GateDeps = {}): string[] {
  return [...new Set([sendGateStateDir(deps), join(homedir(), ".local", "state", "lifeos", "sendgate")])];
}

const STATE_DIRNAME = "sendgate";
const lc = (x: string): string => x.toLowerCase();
/** Lexical or realpath containment, case-insensitive (the default macOS volume ignores case). */
function within(p: string, root: string): boolean {
  if (resolvedWithin(p, root)) return true;
  const a = lc(normalize(resolve(p))), r = lc(normalize(resolve(root)));
  return a === r || a.startsWith(r + sep);
}

/** Expand ~, $HOME and ${HOME} wherever a path can start: at the start, after whitespace, quotes, =, : and other separators. */
function expandHome(t: string, home: string): string {
  return t.replace(/(^|[\s"'=:;|&(<>`,])~(?=\/|$|[\s"'])/g, (_m, pre: string) => pre + home).replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home);
}
/** Join adjacent quoted fragments ("send""gate", 'send'"gate") and drop escape backslashes. */
function unglue(t: string): string {
  let prev = "";
  let cur = t;
  while (prev !== cur) { prev = cur; cur = cur.replace(/(["'])(["'])/g, ""); }
  return cur.replace(/\\(?=\S)/g, "");
}

/**
 * True when a Write/Edit/MultiEdit target, or anything in a Bash command, resolves into the SendGate state dir.
 * Defends in layers, all text-level (a deterrent, not a boundary; uid is the boundary):
 *  - paths are home-expanded, normalised (. and ..), realpath-resolved and compared case-insensitively;
 *  - a Bash command is unglued first ("send""gate" becomes sendgate), then every token is resolved against the working
 *    directory, which follows each `cd`/`pushd` earlier in the same command;
 *  - a command naming the two SENDGATE env overrides, the state dir's literal location, or a path segment called sendgate
 *    after a variable or any prefix the tokenizer cannot resolve, is refused outright.
 * What text cannot see: `bun -e`, a script file, a glob, `$(printf ...)`. The HMAC on override tokens and the mint-log
 * tripwire (auditOverrides) are what cover those.
 */
export function touchesSendGateState(args: { paths?: string[]; command?: string }, deps: GateDeps = {}): boolean {
  const roots = protectedRoots(deps);
  const home = homedir();
  for (const p of args.paths ?? []) if (typeof p === "string" && p && roots.some((r) => within(expandHome(p, home), r))) return true;
  const cmd = args.command;
  if (typeof cmd !== "string" || !cmd) return false;
  const text = unglue(expandHome(cmd, home));
  if (/LIFEOS_SENDGATE_(?:PROOF_)?DIR/i.test(text)) return true;
  if (/\bsecurity\b[^\n]*lifeos-sendgate-mint/i.test(text)) return true;
  if (/\.local\/state\/lifeos\/sendgate(?![-\w])/i.test(text)) return true;
  if (roots.some((r) => lc(text).includes(lc(r)))) return true;
  if (/\/sendgate(?:\/|$|[\s;|&)])/i.test(text.replace(/["'`]/g, "").replace(/\/+/g, "/"))) return true;
  let cwd = process.cwd();
  const stripQ = (t: string): string => t.replace(/^["']+|["']+$/g, "");
  for (const seg of text.split(/&&|\|\||;|\n|\|/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    if ((words[0] === "cd" || words[0] === "pushd") && words[1] && !words[1].startsWith("-")) {
      const dest = stripQ(words[1]);
      if (!/[$`]/.test(dest)) cwd = resolve(cwd, dest);
      if (roots.some((r) => within(cwd, r))) return true;
      continue;
    }
    for (const raw of seg.split(/[\s"'`()<>=,:]+/)) {
      const tok = stripQ(raw);
      if (!tok || /[$*?\[{]/.test(tok)) continue;
      if (!(tok.includes("/") || tok === "." || tok === ".." || lc(tok) === STATE_DIRNAME)) continue;
      const abs = isAbsolute(tok) ? tok : resolve(cwd, tok);
      if (roots.some((r) => within(abs, r))) return true;
    }
  }
  return false;
}
