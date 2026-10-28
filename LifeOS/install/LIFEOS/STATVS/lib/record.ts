/**
 * STATVS record engine — append, scan, verify, seal, redact, spool, counters.
 *
 * Layout: <statvsDir>/<class>/<YYYY-MM-DD UTC>/<writer-slug>.jsonl, and for customer
 * rows <statvsDir>/customer/<app>/<YYYY-MM-DD UTC>/<writer-slug>.jsonl. Each segment
 * carries its own hash chain; the chain covers data_hash, never data, so a redaction
 * scrub (data → null) keeps it valid. Payloads over 64 KB live once in objects/.
 *
 * Locking and the clock: every write to any of a writer's segments (append, seal, redact
 * scrub) holds that writer's kernel lock (flock, <stateDir>/writers/<slug>.lock), and the
 * writer's hybrid logical clock (<stateDir>/writers/<slug>.hlc) is advanced under it. So
 * (hlc, writer) is unique across the whole record, not just within one segment (ISC-21),
 * and a dead holder never stalls anyone: the kernel drops its lock at once.
 *
 * Failure contract: append() never throws for operational failures (disk, permissions,
 * lock timeout). It spools the validated input to <stateDir>/spool.jsonl. Order is kept:
 * while anything is spooled, append() first drains the spool (a bounded batch, with
 * per-entry progress that survives a crash), and if the spool is not empty afterwards the
 * new input is spooled behind it rather than written ahead of it. Refusals (unregistered
 * stream, credential-shaped value, personal data in a public/system/customer row,
 * customer row without app or on a non-customer stream, a `subject` whose kind is not in
 * GENERA or whose key looks personal or credential-shaped, an `op` outside GENERA's OPS or
 * without a subject) return { ok:false, refused }. The row hash covers `subject` and `op`
 * like every other envelope field (CENSVS ISA F3).
 * Only an InvariantViolation — an impossible state — escapes.
 *
 * Tests: under `bun test` (NODE_ENV=test) with STATVS_DIR unset, the record and its state
 * are a per-process temp dir, so no fixture reaches the live record (ISC-189).
 *
 * Prune (ISC-196): deletes sealed single-stream segments past an explicit window, only after
 * that day's restore drill passed, and only behind a `statvs` tombstone naming each segment and
 * its seal hash, which verify accepts in place of the seal anchor's segment. Every registered
 * stream is kept forever (Q-1, ISC-107), so only a stream registered with a window could be pruned.
 *
 * @version 1.5.0
 */

import {
  closeSync,
  constants as FS,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  fstatSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, relative, sep, isAbsolute } from "node:path";
import { lifeosPath } from "../../TOOLS/Paths";
import { invariant, InvariantViolation } from "../../TOOLS/Invariant";
import { canonicalJson, quarantineTornTail, rowHash, sha256, tailState, tailStateFd, withKernelLock } from "../../TOOLS/lib/LedgerCore";
import { credentialRefusal } from "./refuse";
import { streamDef } from "../streams";
import { GENERA, OPS, parseSubject, validSubject } from "../../CENSVS/genera";
import type { AppendResult, Counters, PrivacyClass, ScanResult, StatvsInput, StatvsRow } from "./types";
import { PRIVACY_CLASSES } from "./types";

// ── Paths ──

/**
 * The test arm (ISC-189), the rule Vigil's State.ts already has: under `bun test` with
 * STATVS_DIR unset, the record and its state live in a per-process temp dir, so every
 * STATVS writer (events, decisions, collect state, consumers) stays off the live record
 * and the live state dir without each suite having to set anything.
 */
const testArm = () => process.env.NODE_ENV === "test" && !process.env.STATVS_DIR;
const TEST_ROOT = () => join(tmpdir(), `lifeos-statvs-test-${process.pid}`);
/**
 * The per-process temp root every STATVS test arm uses (record, state, backups, view outputs).
 * Each path keeps its own env override; the arm applies only under `bun test` (NODE_ENV=test).
 */
export function statvsTestRoot(): string | null {
  return process.env.NODE_ENV === "test" ? TEST_ROOT() : null;
}
/** The record: env STATVS_DIR, else the test arm's temp record under `bun test`, else <LifeOS dir>/MEMORY/STATVS, resolved exactly as the work-events log is (LIFEOS_DIR, CLAUDE_CONFIG_DIR). */
export function statvsDir(): string {
  if (testArm()) return resolve(TEST_ROOT(), "record");
  return resolve(process.env.STATVS_DIR || lifeosPath("MEMORY", "STATVS"));
}
const STATE_BASE = () => join(homedir(), ".local/state/lifeos/statvs");
/** The install's own default record (what statvsDir() is with no override), whose local state lives at STATE_BASE. */
const HOME_RECORD = () => resolve(lifeosPath("MEMORY", "STATVS"));
/**
 * Local state (spool, counters, quarantine, writer locks and clocks): env STATVS_STATE_DIR,
 * else ~/.local/state/lifeos/statvs for the home record, and a subdirectory keyed by the
 * record's path for any other record, so two installs never share a spool or seed marker.
 * Under the test arm the base is the per-process temp dir instead, owned by the temp record.
 */
export function statvsStateDir(): string {
  return stateDirFor(statvsDir());
}
/** The state dir of any record dir: the base for the record it belongs to by default, a hashed subdirectory for every other record. */
function stateDirFor(dir: string): string {
  const d = resolve(dir);
  const explicit = process.env.STATVS_STATE_DIR ? resolve(process.env.STATVS_STATE_DIR) : null;
  const test = !explicit && testArm();
  const base = explicit ?? (test ? join(TEST_ROOT(), "state") : STATE_BASE());
  const owner = explicit || test ? statvsDir() : HOME_RECORD();
  return d === owner ? base : join(base, "records", sha256(d).slice(0, 12));
}
const spoolPath = () => join(statvsStateDir(), "spool.jsonl");
const drainingPath = () => join(statvsStateDir(), "spool.draining.jsonl");
const progressPath = () => join(statvsStateDir(), "spool.draining.progress");
const countersPath = () => join(statvsStateDir(), "counters.json");
const quarantineDir = () => join(statvsStateDir(), "quarantine");
const writersDir = (root: string) => join(stateDirFor(root), "writers");

export const LARGE_PAYLOAD_BYTES = 65536;
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const NULL_HASH = sha256("null");
const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;
const SEVERITIES = ["info", "low", "medium", "high", "critical"];
/** Kernel lock: nobody is ever stale, so the deadline only bounds a wait on a live holder. Short jittered retries hand it over quickly. */
const APPEND_LOCK = { deadlineMs: 2000, retryMs: 2 };
/** Spooled entries one append() drains before writing its own row; the rest waits for the next append. */
const DRAIN_BATCH = 200;
/** Field order a row is written in. verify checks it, so a rewrite that reorders keys is caught. */
const ROW_KEYS = ["v", "id", "seq", "hlc", "ts", "writer", "stream", "class", "app", "kind", "severity", "title", "session", "ref", "subject", "op", "data", "data_hash", "obj", "flags", "prev", "hash"];

export function writerSlug(writer: string): string {
  return writer.replace(/[^A-Za-z0-9_.-]/g, "_");
}
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function within(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}
/**
 * The real path `p` will be written at, confined to the record after dereferencing every
 * symlink in its directory chain (Code invariants: realpath before the boundary check).
 * Creates the directory. Throws a plain Error when a symlink leads outside the record or
 * the file itself is a symlink: the caller spools or refuses.
 */
function confinedPath(root: string, p: string): string {
  invariant(within(root, p), `path must be inside the record: ${p}`);
  mkdirSync(root, { recursive: true });
  mkdirSync(dirname(p), { recursive: true });
  const rootReal = realpathSync(root);
  const parentReal = realpathSync(dirname(p));
  if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) throw new Error(`path resolves outside the record: ${p}`);
  const real = join(parentReal, basename(p));
  try { if (lstatSync(real).isSymbolicLink()) throw new Error(`refusing to follow a symlink: ${p}`); } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") throw e;
  }
  return real;
}
export function segmentPath(dir: string, cls: PrivacyClass, date: string, writer: string, app?: string): string {
  const file = `${writerSlug(writer)}.jsonl`;
  return cls === "customer" ? join(dir, "customer", app ?? "", date, file) : join(dir, cls, date, file);
}

// ── Hybrid logical clock ──

function parseHlc(hlc: string): { ms: number; c: number } {
  const m = /^(\d{13})\.(\d{4})$/.exec(hlc);
  if (!m) throw new Error(`malformed hlc in segment tail: ${hlc}`);
  return { ms: Number(m[1]), c: Number(m[2]) };
}
function fmtHlc(ms: number, c: number): string {
  return `${String(ms).padStart(13, "0")}.${String(c).padStart(4, "0")}`;
}
export function nextHlc(last: string | null, now: number): string {
  if (!last) return fmtHlc(now, 0);
  const l = parseHlc(last);
  let ms = Math.max(now, l.ms);
  let c = ms === l.ms ? l.c + 1 : 0;
  if (c > 9999) { ms = l.ms + 1; c = 0; }
  return fmtHlc(ms, c);
}
function readClock(path: string): string | null {
  try {
    const t = readFileSync(path, "utf8").trim();
    return /^\d{13}\.\d{4}$/.test(t) ? t : null;
  } catch { return null; }
}

// ── Counters ──

const ZERO: Counters = { refused: 0, spooled: 0, quarantined: 0, drained: 0 };

export function counters(): Counters {
  try {
    const c = JSON.parse(readFileSync(countersPath(), "utf8")) as Partial<Counters>;
    return { ...ZERO, ...c };
  } catch {
    return { ...ZERO };
  }
}

function bumpCounter(name: keyof Counters, n = 1): void {
  try {
    withKernelLock(countersPath() + ".lock", () => {
      const c = counters();
      c[name] += n;
      invariant(Number.isInteger(c[name]) && c[name] >= 0, `counter ${name} must stay a non-negative integer`);
      const tmp = `${countersPath()}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(c) + "\n");
      renameSync(tmp, countersPath());
    }, { deadlineMs: 500, retryMs: 2 });
  } catch (e) {
    if (e instanceof InvariantViolation) throw e;
    /* counters are best-effort; the record is the truth */
  }
}

// ── Refusal detectors ──

const PERSONAL_RES: RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/, // email address
  /\b\d+(?:\.\d+)?\s*(?:bpm|kg|kgs|lbs?|mg\/dl|mmhg|kcal)\b/i, // raw health value
  /[$€£]\s?\d/, // money
  /\b\d+(?:\.\d+)?\s*(?:usd|eur|gbp)\b/i, // money, spelled currency
];

/** Why a public/system/customer row's text is refused as personal or tenant data, or null. */
export function personalRefusal(text: string): string | null {
  return PERSONAL_RES.some((re) => re.test(text)) ? "Personal data refused in a public, system or customer row" : null;
}

/** A content digest under a key that names it as one (bodyHash, last_hash, sha256…) is a hash, not a secret. */
const DIGEST_VALUE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST_KEY = /(?:hash|sha1|sha256|digest|checksum)$/i;

/** Every string in a payload (keys and values), as lines, minus values that are named content digests. */
function payloadText(v: unknown, key = "", out: string[] = []): string[] {
  if (typeof v === "string") { if (!(DIGEST_VALUE.test(v) && DIGEST_KEY.test(key))) out.push(v); }
  else if (typeof v === "number" || typeof v === "bigint") out.push(String(v));
  else if (Array.isArray(v)) for (const x of v) payloadText(x, key, out);
  else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) { out.push(k); payloadText(x, k, out); }
  return out;
}

function refuse(reason: string): AppendResult {
  bumpCounter("refused");
  return { ok: false, refused: reason };
}

// ── Objects ──

function objectPath(dir: string, h: string): string {
  return join(dir, "objects", h.slice(0, 2), `${h}.json`);
}

/** An object's stored text, or null when it is absent. */
export function objectText(h: string, dir = statvsDir()): string | null {
  const p = objectPath(dir, h);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/**
 * One line checked on its own, as verify checks it: the bytes are the row's serialization, its hash recomputes, and
 * its data (inline, or `object` for a row whose payload lives in one) matches data_hash. The row, or null.
 */
export function rowIntact(line: string, object?: string): StatvsRow | null {
  let row: StatvsRow;
  try { row = JSON.parse(line) as StatvsRow; } catch { return null; }
  if (!row || typeof row !== "object" || JSON.stringify(row) !== line || row.v !== 1) return null;
  if (typeof row.hash !== "string" || row.hash !== rowHash(String(row.prev), hashInput(row as unknown as Record<string, unknown>))) return null;
  if (row.data !== null) return sha256(canonicalJson(row.data)) === row.data_hash ? row : null;
  if (row.obj) return object !== undefined && sha256(object) === row.data_hash ? row : null;
  return row;
}

function writeObject(dir: string, h: string, content: string): void {
  invariant(/^[a-f0-9]{64}$/.test(h) && sha256(content) === h, "object name must be the sha256 of its content");
  const p = confinedPath(dir, objectPath(dir, h));
  if (existsSync(p)) return;
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content, { flag: "wx" });
  renameSync(tmp, p);
}

/**
 * Store a body in the record's object store under its sha256 and return the hash (CENSVS ISC-55): content a row
 * names by hash in its data, such as a turn's uncommitted changes. It stays local: the shipper sends rows, and
 * prune, redact and backup act only on objects a row's `obj` names, so a body is removed only by hand.
 */
export function putObject(content: string, dir = statvsDir()): string {
  invariant(typeof content === "string", "an object body is a string");
  const h = sha256(content);
  writeObject(dir, h, content);
  return h;
}

// ── Segment writing ──

type RowFields = Omit<StatvsRow, "v" | "id" | "seq" | "hlc" | "prev" | "hash">;

/**
 * Per-process memory of the row this process last appended to each segment, keyed by
 * path and valid only while the file's inode and size are exactly what that append
 * left. Any other writer's append, a quarantine or a redact rewrite changes one of them,
 * and the tail is read from disk again.
 */
const tailCache = new Map<string, { ino: number; size: number; row: StatvsRow }>();

function parseRowLine(line: string, seg: string): StatvsRow {
  let row: StatvsRow;
  try { row = JSON.parse(line) as StatvsRow; } catch { throw new Error(`unparseable last row in ${seg}`); }
  if (!row || typeof row !== "object" || typeof row.hash !== "string" || typeof row.hlc !== "string" || typeof row.seq !== "number") {
    throw new Error(`last row of ${seg} is not a STATVS row`);
  }
  return row;
}

function isRowShaped(s: string): boolean {
  try {
    const r = JSON.parse(s);
    return !!r && typeof r === "object" && typeof r.hash === "string" && typeof r.hlc === "string";
  } catch {
    return false;
  }
}

/** Hash input for a row: every field except hash and data. */
function hashInput(row: Record<string, unknown>): Record<string, unknown> {
  const { hash: _h, data: _d, ...rest } = row;
  return rest;
}

function buildRow(last: StatvsRow | null, f: RowFields, hlc: string): StatvsRow {
  const seq = last ? last.seq + 1 : 1;
  const prev = last ? last.hash : "genesis";
  invariant(!last || hlc > last.hlc, `hlc must strictly increase within a segment (${last?.hlc} → ${hlc})`);
  invariant(Number.isInteger(seq) && seq >= 1, "seq must be a positive integer");
  invariant(PRIVACY_CLASSES.includes(f.class), `class must be one of ${PRIVACY_CLASSES.join(", ")}`);
  const id = "s" + sha256(`${f.writer}\0${f.class}\0${f.app ?? ""}\0${hlc}`).slice(0, 24);
  const row: Record<string, unknown> = { v: 1, id, seq, hlc, ts: f.ts, writer: f.writer, stream: f.stream, class: f.class };
  for (const k of ["app", "kind", "severity", "title", "session", "ref", "subject", "op"] as const) if (f[k] !== undefined) row[k] = f[k];
  row.data = f.data;
  row.data_hash = f.data_hash;
  if (f.obj !== undefined) row.obj = f.obj;
  if (f.flags && f.flags.length > 0) row.flags = f.flags;
  row.prev = prev;
  row.hash = rowHash(prev, hashInput(row));
  return row as unknown as StatvsRow;
}

/** The writer lock and clock that guard every segment named `<slug>.jsonl` in this record. */
function writerFiles(root: string, seg: string): { lock: string; clock: string } {
  const slug = basename(seg, ".jsonl");
  invariant(SAFE_NAME.test(slug), `segment file must be a writer slug: ${seg}`);
  const d = writersDir(root);
  return { lock: join(d, `${slug}.lock`), clock: join(d, `${slug}.hlc`) };
}

/** Run `action` under the writer lock of `seg`. Throws a plain Error when the lock cannot be taken. */
function underWriterLock<T>(root: string, seg: string, action: () => T): T {
  const { lock } = writerFiles(root, seg);
  const res = withKernelLock(lock, action, APPEND_LOCK);
  if (!res.ok) throw new Error(res.message);
  return res.value;
}

const DECLINED = Symbol("declined");

/**
 * Append one row to a segment under its writer's lock. `build` receives the last row
 * (after a torn tail is healed or quarantined) and returns the row's fields, or null to
 * decline. Throws a plain Error on operational failure; the caller spools.
 */
function writeToSegment(root: string, seg: string, build: (last: StatvsRow | null) => RowFields | null, durable = false): StatvsRow | typeof DECLINED {
  invariant(within(root, seg) && seg.endsWith(".jsonl"), `segment must be a .jsonl file inside the record: ${seg}`);
  const { clock } = writerFiles(root, seg);
  return underWriterLock(root, seg, () => {
    const real = confinedPath(root, seg);
    // One fd reads the tail and appends (O_APPEND: reads at any offset, writes always at the end). O_NOFOLLOW: never a symlink.
    const flags = FS.O_RDWR | FS.O_APPEND | FS.O_CREAT | FS.O_NOFOLLOW;
    let fd = openSync(real, flags, 0o644);
    try {
      let stat = fstatSync(fd);
      const cached = tailCache.get(seg);
      let last: StatvsRow | null;
      if (cached && cached.ino === stat.ino && cached.size === stat.size) {
        last = cached.row;
      } else {
        let st = tailStateFd(fd);
        if (st.torn.length > 0) {
          if (isRowShaped(st.torn)) {
            writeSync(fd, "\n");
            st = { line: st.torn, torn: "", size: st.size + 1 };
          } else {
            closeSync(fd);
            if (quarantineTornTail(real, quarantineDir(), { tmpPath: `${real}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}` }) > 0) bumpCounter("quarantined");
            fd = openSync(real, flags, 0o644);
            st = tailStateFd(fd);
          }
          stat = fstatSync(fd);
        }
        last = st.line !== null ? parseRowLine(st.line, seg) : null;
      }
      const fields = build(last);
      if (!fields) return DECLINED;
      // The writer's clock runs across all its segments, so (hlc, writer) never repeats (ISC-21).
      const base = [last?.hlc ?? null, readClock(clock)].filter((h): h is string => h !== null).sort().pop() ?? null;
      const hlc = nextHlc(base, Date.now());
      const row = buildRow(last, fields, hlc);
      const buf = Buffer.from(JSON.stringify(row) + "\n", "utf8");
      invariant(buf.indexOf(10) === buf.length - 1, "a row must serialize to exactly one line");
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
      if (durable) fsyncSync(fd);
      tailCache.set(seg, { ino: stat.ino, size: stat.size + buf.length, row });
      try { writeFileSync(clock, hlc); } catch { /* the segment tail still bounds the clock */ }
      return row;
    } finally {
      closeSync(fd);
    }
  });
}

// ── Validation ──

const ENVELOPE = ["writer", "stream", "class", "app", "kind", "severity", "title", "session", "ref", "subject", "op", "ts"] as const;

/**
 * Why a row's `subject` or `op` is refused, or null (CENSVS ISA F3, ISC-14..16). The subject must
 * name a GENERA kind and a key that carries no personal-looking content (on every class); a natural
 * key must not be credential-shaped and, on a public, system or customer row, must pass the same
 * personal-data check as the rest of the envelope. An opaque key is already held to OPAQUE_KEY_RE
 * by validSubject, so it skips the credential check that would mistake a long minted hex id for a
 * digest. An op must be one of GENERA's OPS and needs a subject to act on.
 */
function subjectRefusal(raw: StatvsInput, cls: PrivacyClass): string | null {
  if (raw.subject !== undefined) {
    if (typeof raw.subject !== "string") return "subject must be a string";
    const bad = validSubject(raw.subject);
    if (bad) return `subject refused: ${bad}`;
    const p = parseSubject(raw.subject)!;
    if (GENERA[p.kind]!.key === "natural") {
      if (credentialRefusal(p.key, { slugs: true })) return "Credential-shaped subject refused";
      if (cls !== "personal" && personalRefusal(p.key)) return "Personal data refused in a public, system or customer row's subject";
    }
  }
  if (raw.op !== undefined) {
    if (raw.subject === undefined) return "op requires a subject";
    if (typeof raw.op !== "string" || !(OPS as readonly string[]).includes(raw.op)) return `op must be one of ${OPS.join(", ")}`;
  }
  return null;
}

interface Prepared {
  input: StatvsInput; // envelope fields only, ts fixed
  cls: PrivacyClass;
  data: unknown;
  canonical: string;
  flags: string[];
}

/**
 * Why append() would refuse this input, or null when it would take it. The same checks
 * append() runs first, with no row written, so a writer that must touch another store before
 * the record can learn the record's answer up front.
 *
 * By default it is pure. With `count: true` a refusal also bumps the `refused` counter, exactly
 * as append() does for the same input, for a writer that asks here instead of calling append():
 * the drill's refused figure (ISC-57) then counts the row either way.
 */
export function rowRefusal(input: StatvsInput, opts: { count?: boolean } = {}): string | null {
  const p = prepare(input);
  if (typeof p !== "string") return null;
  if (opts.count === true) bumpCounter("refused");
  return p;
}

/** Check an input against every refusal rule. Returns the prepared append, or the refusal reason. Never writes. */
function prepare(raw: StatvsInput, extraFlags: string[] = []): Prepared | string {
  if (!raw || typeof raw !== "object") return "input must be an object";
  if (typeof raw.writer !== "string" || raw.writer.length === 0) return "writer is required";
  const def = typeof raw.stream === "string" ? streamDef(raw.stream) : null;
  if (!def) return `unregistered stream: ${String(raw.stream)}`;
  const cls: PrivacyClass = raw.class ?? "personal";
  if (!PRIVACY_CLASSES.includes(cls)) return `unknown privacy class: ${String(raw.class)}`;
  for (const k of ["kind", "title", "session", "ref", "severity", "app"] as const) {
    if (raw[k] !== undefined && typeof raw[k] !== "string") return `${k} must be a string`;
  }
  if (raw.app !== undefined && (!SAFE_NAME.test(raw.app) || raw.app === "." || raw.app === "..")) return `app must match ${SAFE_NAME.source}`;
  if (cls === "customer" && !raw.app) return "customer rows require app";
  // Tenant rows travel only on streams registered for them, and those streams carry nothing else (ISC-3).
  if (cls === "customer" && def.class !== "customer") return `stream ${raw.stream} is not registered for customer rows`;
  if (def.class === "customer" && cls !== "customer") return `stream ${raw.stream} carries only customer rows`;
  if (raw.severity !== undefined && !SEVERITIES.includes(raw.severity)) return `severity must be one of ${SEVERITIES.join(", ")}`;
  const subj = subjectRefusal(raw, cls);
  if (subj) return subj;

  const now = Date.now();
  const flags = [...extraFlags];
  let ts = new Date(now).toISOString();
  if (raw.ts !== undefined) {
    const t = typeof raw.ts === "string" ? Date.parse(raw.ts) : NaN;
    if (Number.isNaN(t)) return `ts is not a date: ${String(raw.ts)}`;
    if (t - now > FUTURE_TOLERANCE_MS) { if (!flags.includes("clock-clamped")) flags.push("clock-clamped"); }
    else ts = new Date(t).toISOString();
  }

  const data = raw.data === undefined ? null : raw.data;
  const canonical = canonicalJson(data);
  const envelopeText = [raw.writer, raw.app, raw.severity, raw.kind, raw.title, raw.session, raw.ref].filter((s): s is string => typeof s === "string");
  const contentText = [...payloadText(data), ...envelopeText].join("\n");
  const cred = credentialRefusal(contentText, { slugs: true });
  if (cred) return cred;
  if (cls === "public" || cls === "system" || cls === "customer") {
    const pers = personalRefusal(contentText);
    if (pers) return pers;
  }
  const input: StatvsInput = { writer: raw.writer, stream: raw.stream, class: cls, data };
  for (const k of ENVELOPE) if (k !== "writer" && k !== "stream" && k !== "class" && raw[k] !== undefined) (input as unknown as Record<string, unknown>)[k] = raw[k];
  input.ts = ts;
  return { input, cls, data, canonical, flags };
}

/** A customer app whose name differs only in case from an existing tenant directory (APFS folds case), or null. */
function caseCollision(root: string, app: string): string | null {
  let names: string[];
  try { names = readdirSync(join(root, "customer")); } catch { return null; }
  const clash = names.find((n) => n !== app && n.toLowerCase() === app.toLowerCase());
  return clash ? `app ${app} differs only in case from existing tenant ${clash}` : null;
}

/** Write a prepared row. Throws a plain Error on operational failure. Returns a refusal string for a write-time refusal. */
function writePrepared(p: Prepared, opts: AppendOptions): StatvsRow | string {
  const root = statvsDir();
  if (p.cls === "customer") {
    const clash = caseCollision(root, p.input.app!);
    if (clash) return clash;
  }
  const dataHash = sha256(p.canonical);
  let rowData: unknown = p.data;
  let obj: string | undefined;
  if (Buffer.byteLength(p.canonical, "utf8") > LARGE_PAYLOAD_BYTES) {
    writeObject(root, dataHash, p.canonical);
    rowData = null;
    obj = dataHash;
  }
  const i = p.input;
  const fields: RowFields = {
    ts: i.ts!, writer: i.writer, stream: i.stream, class: p.cls,
    app: i.app, kind: i.kind, severity: i.severity, title: i.title,
    session: i.session, ref: i.ref, subject: i.subject, op: i.op,
    data: rowData, data_hash: dataHash, obj, flags: p.flags,
  };
  // A segment sealed while this append waited (it captured yesterday's date just before
  // midnight UTC) is never appended to: the row goes to today's segment instead.
  let date = utcDate(Date.now());
  for (let attempt = 0; attempt < 2; attempt++) {
    const seg = segmentPath(root, p.cls, date, i.writer, i.app);
    const row = writeToSegment(root, seg, (last) => (last && isSeal(last) ? null : fields), opts.durable === true);
    if (row !== DECLINED) return row;
    const next = utcDate(Date.now());
    if (next === date) break;
    date = next;
  }
  throw new Error(`segment for ${i.writer} on ${date} is sealed`);
}

// ── Append ──

export interface AppendOptions {
  /** fsync the segment after the write. Off by default (ISC-27 latency target). */
  durable?: boolean;
  /**
   * Never drain the spool first: while rows are spooled, this row queues behind them in one write. For a caller on a
   * deadline, such as a gate writing its refusal before it exits (ISC-116); the next ordinary append drains it.
   */
  noDrain?: boolean;
}

function spool(p: Prepared, reason: string): AppendResult {
  // Only the validated envelope is spooled: stray properties on the caller's object never reach disk (ISC-55).
  const entry = { sid: Math.random().toString(36).slice(2, 14), input: p.input, flags: p.flags };
  try {
    const line = JSON.stringify(entry) + "\n";
    invariant(line.indexOf("\n") === line.length - 1, "a spool entry must serialize to one line");
    const r = withKernelLock(spoolPath() + ".lock", () => {
      const fd = openSync(spoolPath(), FS.O_WRONLY | FS.O_APPEND | FS.O_CREAT | FS.O_NOFOLLOW, 0o600);
      try { writeSync(fd, line); } finally { closeSync(fd); }
    }, { deadlineMs: 1000, retryMs: 2 });
    if (!r.ok) throw new Error(r.message);
  } catch (e) {
    if (e instanceof InvariantViolation) throw e;
    return { ok: false, refused: `record and spool both unwritable: ${reason}; ${(e as Error)?.message ?? String(e)}` };
  }
  bumpCounter("spooled");
  return { ok: false, spooled: true, reason };
}

function spoolPending(): boolean {
  return existsSync(spoolPath()) || existsSync(drainingPath());
}

function readProgress(): number {
  try {
    const n = Number(readFileSync(progressPath(), "utf8").trim());
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch { return 0; }
}
function writeProgress(n: number): void {
  invariant(Number.isInteger(n) && n >= 0, "spool progress must be a non-negative integer");
  const tmp = `${progressPath()}.tmp-${process.pid}`;
  writeFileSync(tmp, String(n));
  renameSync(tmp, progressPath());
}

/** Was this spooled entry already written (a drain that crashed right after the append, before recording progress)? */
function alreadyWritten(sid: string, p: Prepared): boolean {
  const seg = segmentPath(statvsDir(), p.cls, utcDate(Date.now()), p.input.writer, p.input.app);
  try {
    const line = tailState(seg).line;
    if (!line) return false;
    const r = JSON.parse(line) as StatvsRow;
    return Array.isArray(r.flags) && r.flags.includes(`spool:${sid}`);
  } catch { return false; }
}

/** The spool and its drain files are only ever moved, written or deleted inside the state dir. */
function assertSpoolInStateDir(): void {
  const dir = resolve(statvsStateDir());
  for (const f of [spoolPath(), drainingPath(), progressPath()]) invariant(resolve(dirname(f)) === dir, `spool file outside the STATVS state dir: ${f}`);
}

/** The previous engine's drain files (spool.draining-<pid>-<ts>.jsonl), adopted so their entries are not stranded. */
function adoptLegacyDraining(): boolean {
  let names: string[];
  try { names = readdirSync(statvsStateDir()).filter((n) => /^spool\.draining-\d+-\d+\.jsonl$/.test(n)).sort(); } catch { return false; }
  if (names.length === 0) return false;
  assertSpoolInStateDir();
  renameSync(join(statvsStateDir(), names[0]!), drainingPath());
  writeProgress(0);
  return true;
}

interface DrainResult { complete: boolean; reason?: string }

/**
 * Drain up to `limit` spooled entries into the record, oldest first. One drainer at a time
 * (kernel lock, one attempt: a busy drain makes this caller spool behind it). Progress is
 * recorded after every entry, so a drainer killed mid-way loses nothing: the next drain
 * resumes at the recorded entry, skipping it if its row already landed.
 */
function drainSpool(limit = DRAIN_BATCH): DrainResult {
  assertSpoolInStateDir();
  const r = withKernelLock(join(statvsStateDir(), "spool.drain.lock"), (): DrainResult => {
    let done = 0;
    try {
      for (;;) {
        if (!existsSync(drainingPath())) {
          const m = withKernelLock(spoolPath() + ".lock", () => {
            if (!existsSync(spoolPath())) return false;
            renameSync(spoolPath(), drainingPath());
            writeProgress(0);
            return true;
          }, { deadlineMs: 1000, retryMs: 2 });
          if (!m.ok) return { complete: false, reason: m.message };
          if (!m.value && !adoptLegacyDraining()) return { complete: true };
        }
        const lines = readFileSync(drainingPath(), "utf8").split("\n").filter((l) => l.length > 0);
        let i = Math.min(readProgress(), lines.length);
        let checkedResume = false;
        for (; i < lines.length; i++) {
          if (done >= limit) return { complete: false, reason: "spool drain batch limit reached" };
          const line = lines[i]!;
          let entry: { sid?: string; input?: StatvsInput; flags?: string[] } | null = null;
          try { entry = JSON.parse(line); } catch { entry = null; }
          // The previous engine spooled the bare input; wrap it.
          if (entry && !entry.input && (entry as unknown as StatvsInput).writer) entry = { sid: sha256(line).slice(0, 12), input: entry as unknown as StatvsInput, flags: [] };
          if (!entry || !entry.input || typeof entry.sid !== "string") {
            try {
              mkdirSync(quarantineDir(), { recursive: true });
              writeFileSync(join(quarantineDir(), `spool-malformed-${Date.now()}-${process.pid}.txt`), line + "\n", { flag: "a" });
              bumpCounter("quarantined");
            } catch { /* best-effort */ }
            writeProgress(i + 1);
            continue;
          }
          const p = prepare(entry.input, [...(Array.isArray(entry.flags) ? entry.flags.filter((f) => typeof f === "string" && !f.startsWith("spool:")) : []), `spool:${entry.sid}`]);
          if (typeof p === "string") { bumpCounter("refused"); writeProgress(i + 1); continue; }
          if (!checkedResume) {
            checkedResume = true;
            if (alreadyWritten(entry.sid, p)) { writeProgress(i + 1); continue; }
          }
          const w = writePrepared(p, {}); // throws on operational failure: progress stays at i
          if (typeof w === "string") bumpCounter("refused");
          else done++;
          writeProgress(i + 1);
        }
        unlinkSync(drainingPath());
        try { unlinkSync(progressPath()); } catch { /* absent */ }
      }
    } catch (e) {
      if (e instanceof InvariantViolation) throw e;
      return { complete: false, reason: `spool drain stopped: ${(e as Error)?.message ?? String(e)}` };
    } finally {
      if (done > 0) bumpCounter("drained", done);
    }
  }, { deadlineMs: 0 });
  if (!r.ok) return { complete: false, reason: "another process is draining the spool" };
  return r.value;
}

/** Append one row. Never throws for operational failures; see the module header. */
export function append(input: StatvsInput, opts: AppendOptions = {}): AppendResult {
  const p = prepare(input);
  if (typeof p === "string") return refuse(p);
  if (spoolPending()) {
    if (opts.noDrain) return spool(p, "queued behind the spool without draining it");
    const d = drainSpool();
    // Earlier rows are still waiting: this one queues behind them, so order holds.
    if (!d.complete) return spool(p, d.reason ?? "earlier rows are still spooled");
  }
  try {
    const w = writePrepared(p, opts);
    if (typeof w === "string") return refuse(w);
    return { ok: true, row: w };
  } catch (e) {
    if (e instanceof InvariantViolation) throw e;
    return spool(p, (e as Error)?.message ?? String(e));
  }
}

// ── Segments ──

export interface Segment {
  /** path relative to the record root */
  rel: string;
  abs: string;
  class: PrivacyClass;
  app?: string;
  date: string;
}

function dirs(p: string): string[] {
  try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; }
}
function jsonlFiles(p: string): string[] {
  try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(".jsonl")).map((d) => d.name).sort(); } catch { return []; }
}

export function listSegments(dir = statvsDir(), classes?: PrivacyClass[]): Segment[] {
  const out: Segment[] = [];
  for (const cls of PRIVACY_CLASSES) {
    if (classes && !classes.includes(cls)) continue;
    const base = join(dir, cls);
    const add = (dateDir: string, date: string, app?: string) => {
      for (const f of jsonlFiles(dateDir)) {
        const abs = join(dateDir, f);
        out.push({ rel: relative(dir, abs).split(sep).join("/"), abs, class: cls, app, date });
      }
    };
    if (cls === "customer") for (const app of dirs(base)) for (const date of dirs(join(base, app))) add(join(base, app, date), date, app);
    else for (const date of dirs(base)) add(join(base, date), date);
  }
  return out;
}

function readFrom(path: string, offset: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (offset >= size) return Buffer.alloc(0);
    const buf = Buffer.allocUnsafe(size - offset);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, offset + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

// ── Scan ──

export interface ScanOptions {
  streams?: string[];
  classes?: PrivacyClass[];
  since?: Record<string, number>;
  dir?: string;
  /** Skip every segment dated before this (UTC YYYY-MM-DD), so a reader of recent rows never opens the whole record. */
  fromDate?: string;
}

/** Read rows across segments, sorted by (hlc, writer). A malformed line is reported and skipped; every other line and segment is still read (ISC-67). */
export function scan(opts: ScanOptions = {}): ScanResult {
  const dir = opts.dir ? resolve(opts.dir) : statvsDir();
  const rows: StatvsRow[] = [];
  const offsets: Record<string, number> = {};
  const problems: string[] = [];
  for (const seg of listSegments(dir, opts.classes)) {
    if (opts.fromDate && seg.date < opts.fromDate) continue;
    const start = opts.since?.[seg.rel] ?? 0;
    let buf: Buffer;
    try { buf = readFrom(seg.abs, start); } catch (e) { problems.push(`${seg.rel}: unreadable: ${(e as Error).message}`); continue; }
    const lastNl = buf.lastIndexOf(10);
    offsets[seg.rel] = start + lastNl + 1;
    if (lastNl < 0) continue;
    const lines = buf.subarray(0, lastNl).toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line) continue;
      let row: StatvsRow;
      try { row = JSON.parse(line) as StatvsRow; } catch { problems.push(`${seg.rel}: malformed line ${i + 1} after offset ${start}`); continue; }
      if (!row || typeof row !== "object" || typeof row.hlc !== "string") { problems.push(`${seg.rel}: non-row line ${i + 1} after offset ${start}`); continue; }
      if (opts.streams && !opts.streams.includes(row.stream)) continue;
      rows.push(row);
    }
  }
  rows.sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : 0));
  return problems.length > 0 ? { rows, offsets, problems } : { rows, offsets };
}

// ── Verify ──

function isSeal(r: StatvsRow): boolean {
  return r.stream === "statvs" && r.kind === "seal";
}
function isTombstone(r: StatvsRow): boolean {
  return r.stream === "statvs" && r.kind === "redact";
}
function isAnchor(r: StatvsRow): boolean {
  return r.stream === "statvs" && r.kind === "seal-anchor";
}
function isPruneTombstone(r: StatvsRow): boolean {
  return r.stream === "statvs" && r.kind === "prune";
}
/** The (segment, seal hash) pairs a prune tombstone names, as "<segment rel>\0<seal hash>". */
function prunedKeys(r: StatvsRow | null): string[] {
  if (!r || !isPruneTombstone(r) || !r.data || typeof r.data !== "object") return [];
  const segs = (r.data as { segments?: unknown }).segments;
  if (!Array.isArray(segs)) return [];
  return segs.flatMap((x) => {
    const e = x as { segment?: unknown; seal_hash?: unknown };
    return typeof e?.segment === "string" && typeof e.seal_hash === "string" ? [`${e.segment}\0${e.seal_hash}`] : [];
  });
}
function tombstoneTarget(r: StatvsRow | null): string | null {
  if (!r || !isTombstone(r) || !r.data || typeof r.data !== "object") return null;
  const t = (r.data as { target?: unknown }).target;
  return typeof t === "string" ? t : null;
}

/** Every tombstone target in the record right now (a fresh read). */
function collectTombstones(dir: string): Set<string> {
  const out = new Set<string>();
  for (const seg of listSegments(dir, ["system"])) {
    let raw: string;
    try { raw = readFileSync(seg.abs, "utf8"); } catch { continue; }
    if (!raw.includes('"kind":"redact"')) continue;
    for (const l of raw.split("\n")) {
      if (!l.includes('"kind":"redact"')) continue;
      try { const t = tombstoneTarget(JSON.parse(l) as StatvsRow); if (t) out.add(t); } catch { /* reported by the main pass */ }
    }
  }
  return out;
}

/** Top-level keys appear in the writer's order (ROW_KEYS), so a reordered rewrite of a line is caught. */
function keyOrderOk(row: Record<string, unknown>): boolean {
  let at = -1;
  for (const k of Object.keys(row)) {
    const i = ROW_KEYS.indexOf(k);
    if (i <= at) return false;
    at = i;
  }
  return true;
}

export interface VerifyOptions {
  dir?: string;
  /** Also check that every row matches its segment's class, and customer segments hold one app. */
  classes?: boolean;
}

export function verify(opts: VerifyOptions = {}): { ok: boolean; problems: string[] } {
  const dir = opts.dir ? resolve(opts.dir) : statvsDir();
  const problems: string[] = [];
  const parsed: { seg: Segment; raw: string; lines: string[]; rows: (StatvsRow | null)[] }[] = [];
  const tombstoned = new Set<string>();
  /** object hash → ids of rows that point at it */
  const objRefs = new Map<string, string[]>();
  const anchors: { at: string; row: StatvsRow }[] = [];
  /** Segments a retention prune deleted on purpose, each with the seal hash it had (ISC-196). */
  const pruned = new Set<string>();

  for (const seg of listSegments(dir)) {
    let raw: string;
    try { raw = readFileSync(seg.abs, "utf8"); } catch (e) { problems.push(`${seg.rel}: unreadable: ${(e as Error).message}`); continue; }
    if (raw.length > 0 && !raw.endsWith("\n")) problems.push(`${seg.rel}: torn final line`);
    const body = raw.endsWith("\n") ? raw.slice(0, -1) : raw.slice(0, raw.lastIndexOf("\n") + 1).replace(/\n$/, "");
    const lines = body.length > 0 ? body.split("\n") : [];
    const rows = lines.map((l) => {
      try { const r = JSON.parse(l); return r && typeof r === "object" ? (r as StatvsRow) : null; } catch { return null; }
    });
    rows.forEach((r, i) => {
      const t = tombstoneTarget(r);
      if (t) tombstoned.add(t);
      if (r && typeof r.obj === "string") objRefs.set(r.obj, [...(objRefs.get(r.obj) ?? []), r.id]);
      if (r && isAnchor(r)) anchors.push({ at: `${seg.rel}:${i + 1}`, row: r });
      for (const k of prunedKeys(r)) pruned.add(k);
    });
    parsed.push({ seg, raw, lines, rows });
  }

  /** Problems that only hold if no tombstone exists; re-checked against a fresh read below (a redact may run during verify). */
  const pendingNoTombstone: { id: string; msg: string }[] = [];
  const segByRel = new Map(parsed.map((p) => [p.seg.rel, p]));

  for (const { seg, raw, lines, rows } of parsed) {
    let prevRow: StatvsRow | null = null;
    let chainKnown = true;
    let offset = 0;
    const segHasScrub = rows.some((r) => r && tombstoned.has(r.id));
    for (let i = 0; i < lines.length; i++) {
      const at = `${seg.rel}:${i + 1}`;
      const row = rows[i];
      const lineStart = offset;
      offset += Buffer.byteLength(lines[i]!, "utf8") + 1;
      if (!row) { problems.push(`${at}: unparseable line`); chainKnown = false; prevRow = null; continue; }
      if (JSON.stringify(row) !== lines[i] || !keyOrderOk(row as unknown as Record<string, unknown>)) problems.push(`${at}: bytes are not the row's serialization`);
      if (row.v !== 1) problems.push(`${at}: schema v=${String(row.v)}`);
      if (typeof row.hash !== "string" || row.hash !== rowHash(String(row.prev), hashInput(row as unknown as Record<string, unknown>))) {
        problems.push(`${at}: row hash mismatch`);
      }
      if (chainKnown) {
        const expPrev = prevRow ? prevRow.hash : "genesis";
        const expSeq = prevRow ? prevRow.seq + 1 : 1;
        if (row.prev !== expPrev) problems.push(`${at}: chain break (prev does not match the previous row's hash)`);
        if (row.seq !== expSeq) problems.push(`${at}: seq ${row.seq}, expected ${expSeq}`);
        if (prevRow && !(row.hlc > prevRow.hlc)) problems.push(`${at}: hlc does not increase`);
      }
      if (!("data" in row)) problems.push(`${at}: data field missing`);
      else if (row.data !== null) {
        if (sha256(canonicalJson(row.data)) !== row.data_hash) problems.push(`${at}: data does not match data_hash`);
        // A tombstone names this row, yet its content is still here: the redaction never finished (ISC-65).
        if (tombstoned.has(row.id)) problems.push(`${at}: tombstoned row ${row.id} still holds its data (rerun redact)`);
      } else if (row.obj) {
        const p = objectPath(dir, row.obj);
        if (existsSync(p)) {
          if (sha256(readFileSync(p, "utf8")) !== row.data_hash) problems.push(`${at}: object ${row.obj} does not match data_hash`);
          const others = (objRefs.get(row.obj) ?? []).filter((id) => !tombstoned.has(id));
          if (tombstoned.has(row.id) && others.length === 0) problems.push(`${at}: tombstoned row ${row.id} still has its object ${row.obj} (rerun redact)`);
        } else if (!tombstoned.has(row.id)) pendingNoTombstone.push({ id: row.id, msg: `${at}: object ${row.obj} missing with no tombstone` });
      } else if (row.data_hash !== NULL_HASH && !tombstoned.has(row.id)) {
        pendingNoTombstone.push({ id: row.id, msg: `${at}: data scrubbed with no tombstone naming ${row.id}` });
      }
      if (isSeal(row)) {
        const d = (row.data ?? {}) as { rows?: unknown; last_hash?: unknown; bytes_hash?: unknown };
        if (d.rows !== i || d.last_hash !== (prevRow ? prevRow.hash : "genesis")) problems.push(`${at}: seal does not match the rows it seals`);
        if (i !== lines.length - 1) problems.push(`${seg.rel}: rows appended after the seal at line ${i + 1}`);
        // Any byte change before the seal (a reordered key inside data included) is caught; a tombstoned scrub is the one allowed change.
        if (typeof d.bytes_hash === "string" && !segHasScrub) {
          const before = Buffer.from(raw, "utf8").subarray(0, lineStart);
          if (sha256(before.toString("utf8")) !== d.bytes_hash) problems.push(`${seg.rel}: sealed bytes changed (sha256 differs from the seal)`);
        }
      }
      if (opts.classes) {
        if (row.class !== seg.class) problems.push(`${at}: class ${row.class} in a ${seg.class} segment`);
        if (seg.class === "customer" && row.app !== seg.app) problems.push(`${at}: app ${String(row.app)} in the ${seg.app} customer segment`);
      }
      prevRow = row;
      chainKnown = true;
    }
  }

  // Seal anchors live outside the sealed segment, so truncating a sealed segment (seal row and all) or re-sealing it is caught (ISC-7).
  for (const { at, row } of anchors) {
    const d = (row.data ?? {}) as { segment?: unknown; rows?: unknown; seal_hash?: unknown };
    if (typeof d.segment !== "string" || typeof d.rows !== "number" || typeof d.seal_hash !== "string") { problems.push(`${at}: malformed seal anchor`); continue; }
    const target = segByRel.get(d.segment);
    const sealRow = target?.rows[d.rows] ?? null;
    // A segment deleted by prune is satisfied only by a tombstone naming it with this exact seal; any other deletion still fails (ISC-7).
    if (!target && pruned.has(`${d.segment}\0${d.seal_hash}`)) continue;
    if (!target) problems.push(`${at}: sealed segment ${d.segment} is gone`);
    else if (!sealRow || !isSeal(sealRow) || sealRow.hash !== d.seal_hash) problems.push(`${d.segment}: no longer matches its seal anchor (${at})`);
  }

  if (pendingNoTombstone.length > 0) {
    const fresh = collectTombstones(dir);
    for (const p of pendingNoTombstone) if (!fresh.has(p.id)) problems.push(p.msg);
  }
  return { ok: problems.length === 0, problems };
}

// ── Seal ──

/**
 * Seal every unsealed segment dated before `today` (UTC) with a final row carrying its row
 * count, last hash and the sha256 of every byte before the seal (ISC-61), then record an
 * anchor for each seal in the record's own `statvs` stream, outside the sealed segment.
 */
export function seal(opts: { dir?: string; today?: string } = {}): { sealed: string[] } {
  const dir = opts.dir ? resolve(opts.dir) : statvsDir();
  const today = opts.today ?? utcDate(Date.now());
  const sealed: string[] = [];
  const anchors: { segment: string; rows: number; seal_hash: string }[] = [];
  for (const seg of listSegments(dir)) {
    if (seg.date >= today) continue;
    const row = writeToSegment(dir, seg.abs, (last) => {
      if (!last || isSeal(last)) return null;
      const bytes = readFileSync(confinedPath(dir, seg.abs), "utf8");
      const data = { rows: last.seq, last_hash: last.hash, bytes_hash: sha256(bytes) };
      return {
        ts: new Date().toISOString(), writer: last.writer, stream: "statvs", class: seg.class, app: seg.app,
        kind: "seal", data, data_hash: sha256(canonicalJson(data)),
      };
    });
    if (row !== DECLINED) {
      sealed.push(seg.rel);
      anchors.push({ segment: seg.rel, rows: row.seq - 1, seal_hash: row.hash });
    }
  }
  for (const a of anchors) {
    const anchorSeg = segmentPath(dir, "system", utcDate(Date.now()), "statvs");
    const data = { segment: a.segment, rows: a.rows, seal_hash: a.seal_hash };
    const r = writeToSegment(dir, anchorSeg, () => ({
      ts: new Date().toISOString(), writer: "statvs", stream: "statvs", class: "system",
      kind: "seal-anchor", data, data_hash: sha256(canonicalJson(data)),
    }));
    invariant(r !== DECLINED, "an anchor builder never declines");
  }
  return { sealed };
}

// ── Redact ──

function findRow(dir: string, id: string): { seg: Segment; row: StatvsRow } | null {
  const needle = `"id":${JSON.stringify(id)}`;
  for (const seg of listSegments(dir)) {
    let raw: string;
    try { raw = readFileSync(seg.abs, "utf8"); } catch { continue; }
    if (!raw.includes(needle)) continue;
    for (const l of raw.split("\n")) {
      if (!l.includes(needle)) continue;
      try { const r = JSON.parse(l) as StatvsRow; if (r.id === id) return { seg, row: r }; } catch { /* skip */ }
    }
  }
  return null;
}

export interface RedactResult { ok: boolean; message?: string; views?: string[] }

/**
 * Redact a row (ISC-24, ISC-65): append a tombstone (once; a rerun reuses it), scrub the
 * row's data to null in place under its writer's lock, delete its object if nothing else
 * references it, and drop every view checkpoint and output that folded its segment. Every
 * step is idempotent, and verify reports a tombstoned row that still holds data, so a
 * redaction cut short is visible and finished by running redact again.
 */
export function redact(id: string, reason: string): RedactResult {
  const dir = statvsDir();
  if (typeof id !== "string" || !/^s[a-f0-9]{24}$/.test(id)) return { ok: false, message: `not a row id: ${id}` };
  if (typeof reason !== "string" || reason.trim().length === 0) return { ok: false, message: "a reason is required" };
  const found = findRow(dir, id);
  if (!found) return { ok: false, message: `no row with id ${id}` };
  if (found.row.stream === "statvs") return { ok: false, message: "STATVS's own seal and tombstone rows are not redactable" };

  if (!collectTombstones(dir).has(id)) {
    const t = append({ writer: "statvs", stream: "statvs", class: "system", kind: "redact", data: { target: id, reason } });
    if (!t.ok) return { ok: false, message: "refused" in t ? `tombstone refused: ${t.refused}` : `tombstone spooled: ${t.reason}` };
  }

  const seg = found.seg.abs;
  try {
    underWriterLock(dir, seg, () => {
      const real = confinedPath(dir, seg);
      const lines = readFileSync(real, "utf8").split("\n");
      const idx = lines.findIndex((l) => l.includes(`"id":${JSON.stringify(id)}`));
      if (idx < 0) throw new Error(`row ${id} vanished from ${found.seg.rel}`);
      const row = JSON.parse(lines[idx]!) as StatvsRow;
      if (row.data === null) return; // already scrubbed
      const before = row.hash;
      row.data = null;
      invariant(row.hash === before && row.data_hash === found.row.data_hash, "a scrub changes only data");
      lines[idx] = JSON.stringify(row);
      const tmp = `${real}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
      writeFileSync(tmp, lines.join("\n"), { flag: "wx" });
      renameSync(tmp, real);
      tailCache.delete(seg);
    });
  } catch (e) {
    if (e instanceof InvariantViolation) throw e;
    return { ok: false, message: `tombstone written, scrub not done (rerun redact): ${(e as Error).message}` };
  }

  if (found.row.obj) {
    const needle = `"obj":"${found.row.obj}"`;
    // A redacted row keeps its obj pointer, so only rows not yet tombstoned (this one included) still use the payload.
    const tombstoned = collectTombstones(dir);
    const stillUsed = listSegments(dir).some((s) => {
      try {
        return readFileSync(s.abs, "utf8").split("\n").some((l) => {
          if (!l.includes(needle)) return false;
          try { return !tombstoned.has((JSON.parse(l) as { id: string }).id); } catch { return true; }
        });
      } catch { return false; }
    });
    if (!stillUsed) {
      try {
        const p = confinedPath(dir, objectPath(dir, found.row.obj));
        try { unlinkSync(p); } catch { /* already gone */ }
      } catch (e) {
        if (e instanceof InvariantViolation) throw e;
        return { ok: false, message: `scrubbed, object not removed (rerun redact): ${(e as Error).message}` };
      }
    }
  }

  // Views folded from this segment may hold the content in their checkpoint state or output.
  const { invalidateViewsFor } = require("./views") as typeof import("./views");
  const views = invalidateViewsFor(found.seg.rel);
  return { ok: true, views };
}

/** The row with this id as it stands now (its data null once redacted), or null. */
export function rowById(id: string, dir = statvsDir()): StatvsRow | null {
  if (typeof id !== "string" || !/^s[a-f0-9]{24}$/.test(id)) return null;
  return findRow(resolve(dir), id)?.row ?? null;
}

// ── Prune ──

/**
 * Did the restore drill pass on `day` (UTC)? `Statvs.ts restore-drill` appends its `statvs` row
 * only when the drill passed; the row must also say verify was green.
 */
export function restoreDrillPassed(day = utcDate(Date.now()), dir = statvsDir()): boolean {
  return scan({ dir, streams: ["statvs"], classes: ["system"], fromDate: day }).rows.some((r) =>
    r.kind === "restore-drill" && typeof r.ts === "string" && r.ts.slice(0, 10) === day
    && !!r.data && typeof r.data === "object" && (r.data as { verify_ok?: unknown }).verify_ok === true);
}

export interface PruneOptions {
  /** The one stream whose rows are past retention. Required; a `forever` stream is refused (ISC-107). */
  stream: string;
  /** Rows older than this many whole days are past retention. Required. */
  days: number;
  dryRun?: boolean;
  now?: number;
  dir?: string;
}

export interface PruneSegment { segment: string; seal_hash: string; rows: number }

export interface PruneResult {
  ok: boolean;
  message?: string;
  cutoff?: string;
  /** Deleted (or, on a dry run, deletable) segments, each with the seal hash the tombstone names. */
  deleted: PruneSegment[];
  kept: { segment: string; why: string }[];
}

/**
 * Delete sealed segments dated before the cutoff whose every row belongs to `stream` (ISC-196).
 *
 * Nothing runs unless that day's restore drill passed (S14). A segment holding any row of another
 * stream (still in retention) is kept, and so is an unsealed one. One `statvs` tombstone row naming
 * every deleted segment with its seal hash is appended BEFORE anything is deleted, so a crash leaves
 * a tombstoned segment that a rerun deletes, never a deletion with no tombstone. `verify` accepts a
 * seal anchor whose segment is gone only when such a tombstone names it with the same seal hash.
 *
 * Code only: every registered stream is kept forever (Q-1, ISC-107), and no job calls this.
 */
export function prune(opts: PruneOptions): PruneResult {
  const dir = opts.dir ? resolve(opts.dir) : statvsDir();
  const kept: PruneResult["kept"] = [];
  const fail = (message: string): PruneResult => ({ ok: false, message, deleted: [], kept });
  // The tombstone goes through append(), which writes only to statvsDir(). Deleting segments in
  // any other record would leave that record with no tombstone and a failing verify, so a prune
  // of another record is refused; a dry run of it only plans and stays open.
  const same = (a: string, b: string) => { try { return realpathSync(a) === realpathSync(b); } catch { return resolve(a) === resolve(b); } };
  if (!opts.dryRun && !same(dir, statvsDir())) return fail(`prune writes its tombstone to the live record (${statvsDir()}), so it can only delete there; ${dir} is another record`);
  if (typeof opts.stream !== "string" || !streamDef(opts.stream)) return fail(`unregistered stream: ${String(opts.stream)}`);
  if (opts.stream === "statvs") return fail("stream statvs holds seals, anchors and tombstones and is never pruned");
  // The record is kept forever (principal directive, 2026-10-16): a stream registered `forever` is never pruned (ISC-107).
  if (streamDef(opts.stream)!.retention === "forever") return fail(`stream ${opts.stream} is kept forever and is never pruned`);
  if (!Number.isInteger(opts.days) || opts.days < 1) return fail("--days must be a whole number of days, at least 1");
  const now = opts.now ?? Date.now();
  const today = utcDate(now);
  if (!restoreDrillPassed(today, dir)) return fail(`today's restore drill (${today}) has not passed; run Statvs.ts restore-drill first`);
  const cutoff = utcDate(now - opts.days * 86_400_000);

  const plan: { seg: Segment; entry: PruneSegment; objs: string[] }[] = [];
  for (const seg of listSegments(dir)) {
    if (seg.date >= cutoff) continue;
    let raw: string;
    try { raw = readFileSync(seg.abs, "utf8"); } catch (e) { kept.push({ segment: seg.rel, why: `unreadable: ${(e as Error).message}` }); continue; }
    const rows: StatvsRow[] = [];
    let bad = false;
    for (const l of raw.split("\n")) {
      if (!l) continue;
      try { rows.push(JSON.parse(l) as StatvsRow); } catch { bad = true; break; }
    }
    const last = rows[rows.length - 1];
    if (bad) { kept.push({ segment: seg.rel, why: "holds an unparseable line" }); continue; }
    if (!last || !isSeal(last) || !raw.endsWith("\n")) { kept.push({ segment: seg.rel, why: "not sealed" }); continue; }
    const others = [...new Set(rows.slice(0, -1).map((r) => r.stream).filter((s) => s !== opts.stream))];
    if (others.length > 0) { kept.push({ segment: seg.rel, why: `holds rows of ${others.join(", ")}` }); continue; }
    if (rows.length < 2) { kept.push({ segment: seg.rel, why: "holds only its seal" }); continue; }
    plan.push({ seg, entry: { segment: seg.rel, seal_hash: last.hash, rows: last.seq - 1 }, objs: rows.flatMap((r) => (typeof r.obj === "string" ? [r.obj] : [])) });
  }
  const deleted = plan.map((p) => p.entry);
  if (opts.dryRun || plan.length === 0) return { ok: true, cutoff, deleted, kept };

  invariant(same(dir, statvsDir()), "a prune tombstone lands in the record it prunes");
  const tomb = append({
    writer: "statvs", stream: "statvs", class: "system", kind: "prune",
    title: `Prune ${opts.stream}: ${plan.length} segments before ${cutoff}`,
    data: { stream: opts.stream, days: opts.days, cutoff, segments: deleted },
  }, { durable: true });
  if (!tomb.ok) return fail("refused" in tomb ? `tombstone refused: ${tomb.refused}` : `tombstone spooled, nothing deleted: ${tomb.reason}`);

  const done: PruneSegment[] = [];
  for (const p of plan) {
    try {
      underWriterLock(dir, p.seg.abs, () => {
        const real = confinedPath(dir, p.seg.abs);
        const st = tailState(real);
        const tail = st.line !== null && st.torn.length === 0 ? (JSON.parse(st.line) as StatvsRow) : null;
        if (!tail || !isSeal(tail) || tail.hash !== p.entry.seal_hash) throw new Error("segment changed since it was planned");
        invariant(within(realpathSync(dir), real) && real.endsWith(".jsonl"), `a pruned segment lies inside the record: ${real}`);
        unlinkSync(real);
        tailCache.delete(p.seg.abs);
      });
      done.push(p.entry);
    } catch (e) {
      if (e instanceof InvariantViolation) throw e;
      kept.push({ segment: p.seg.rel, why: `not deleted (tombstoned; rerun prune): ${(e as Error).message}` });
      continue;
    }
    try { if (readdirSync(dirname(p.seg.abs)).length === 0) rmdirSync(dirname(p.seg.abs)); } catch { /* best-effort */ }
  }
  // Payload objects that only the deleted segments pointed at go too.
  const objs = new Set(plan.filter((p) => done.some((d) => d.segment === p.entry.segment)).flatMap((p) => p.objs));
  if (objs.size > 0) {
    const used = new Set<string>();
    for (const s of listSegments(dir)) {
      try { for (const m of readFileSync(s.abs, "utf8").matchAll(/"obj":"([a-f0-9]{64})"/g)) used.add(m[1]!); } catch { /* unreadable: keep every object */ for (const o of objs) used.add(o); }
    }
    for (const o of objs) {
      if (used.has(o)) continue;
      try { unlinkSync(confinedPath(dir, objectPath(dir, o))); } catch (e) { if (e instanceof InvariantViolation) throw e; }
    }
  }
  return { ok: kept.every((k) => !k.why.startsWith("not deleted")), cutoff, deleted: done, kept };
}
