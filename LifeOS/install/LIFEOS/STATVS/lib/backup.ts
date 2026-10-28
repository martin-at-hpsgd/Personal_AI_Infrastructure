/**
 * STATVS backup and restore drill (ISC-62).
 *
 * The record is machine-local, so it is the one copy of what happened. `backup` encrypts every system and
 * personal segment with age to the recipient that already seals `~/.claude/.env` (read from
 * `.env.age.meta.json`, so a scheduled run never touches the Keychain) and writes the ciphertext under
 * a local folder under the STATVS state dir, together with every object (payloads over 64 KB) those rows point
 * to. `offsite` then copies the changed ciphertext, and the manifest encrypted the same way, to the private R2
 * bucket under `statvs-backup/`, and deletes there what the local backup dropped. Nothing goes into a git repo:
 * the record is kept forever (ISC-107), and a git history would keep a redacted object's ciphertext forever too. A file is re-encrypted only when its bytes change, so a sealed day is written once, and a
 * backed-up file whose live file is gone (a redacted object) is dropped from the backup. Customer segments are never backed up here: an app's data stays with
 * the app and its own backup.
 *
 * `restoreDrill` decrypts the whole backup into a fresh directory with the Keychain identity, checks every
 * segment against the manifest, runs `verify` on the restored record, and checks each restored segment is
 * the live segment or an earlier prefix of it (the record only appends). It never writes the live record.
 * `fetchOffsite` downloads the R2 copy into a fresh folder, so the same drill proves the offsite copy alone (ISC-108).
 * @version 1.1.0
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getClaudeDir } from "../../TOOLS/Paths";
import { invariant } from "../../TOOLS/Invariant";
import { createHash } from "node:crypto";
import { listSegments, statvsDir, statvsStateDir, statvsTestRoot, verify } from "./record";

const AGE_HEADER = "age-encryption.org/v1";
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const RECIPIENT = /^age1(pq1)?[a-z0-9]+$/;
const BACKED_UP = ["system", "personal"] as const;

export interface BackupManifest {
  v: 1;
  recipient: string;
  /** Record-relative path (a segment, or objects/xx/<hash>.json) -> plaintext fingerprint and the ciphertext path under the backup dir. */
  segments: Record<string, { sha256: string; bytes: number; cipher: string }>;
}

export interface BackupResult {
  dir: string;
  written: string[];
  unchanged: number;
  segments: number;
  objects: number;
  /** Backed-up files dropped because their live file is gone. */
  removed: string[];
}

export interface RestoreDrillResult {
  ok: boolean;
  restored: number;
  /** Restored segments identical to the live segment. */
  exact: number;
  /** Restored segments that are an earlier prefix of a live segment still being appended to. */
  prefix: number;
  /** Live segments with no backup yet (written since the last backup). */
  not_backed_up: string[];
  verify_ok: boolean;
  problems: string[];
}

/** Env STATVS_BACKUP_DIR, else under `bun test` the per-process temp root (the record.ts test arm), else `backup` in the STATVS state dir (outside every repo). */
export function backupDir(): string {
  if (process.env.STATVS_BACKUP_DIR) return resolve(process.env.STATVS_BACKUP_DIR);
  const test = statvsTestRoot();
  return resolve(test ? join(test, "backup") : join(statvsStateDir(), "backup"));
}

/** The age recipient that seals .env; public, so reading it needs no secret. */
export function sealRecipient(): string {
  const meta = JSON.parse(readFileSync(join(getClaudeDir(), ".env.age.meta.json"), "utf8")) as { recipient?: unknown };
  invariant(typeof meta.recipient === "string" && RECIPIENT.test(meta.recipient), ".env.age.meta.json must carry an age recipient");
  return meta.recipient;
}

function real(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) { tail.unshift(cur.slice(dirname(cur).length + 1)); cur = dirname(cur); }
  return join(realpathSync(cur), ...tail);
}

function assertSeparate(record: string, backup: string): void {
  const r = real(record), b = real(backup);
  invariant(r !== b && !b.startsWith(r + "/") && !r.startsWith(b + "/"), "the backup dir and the record must never overlap");
}

/** Writes only inside `root`, the backup dir or the restore drill's temp dir, never the live record. */
function writeAtomic(root: string, path: string, data: Uint8Array | string): void {
  invariant(resolve(path).startsWith(resolve(root) + "/"), "a backup or restore write stays inside its own dir");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

function readManifest(dir: string): BackupManifest | null {
  const p = join(dir, "manifest.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as BackupManifest;
}

export function encrypt(plain: Uint8Array, recipient: string): Uint8Array {
  const p = Bun.spawnSync(["age", "-r", recipient], { stdin: plain, stdout: "pipe", stderr: "pipe" });
  invariant(p.exitCode === 0, `age encrypt failed: ${p.stderr.toString().trim()}`);
  const out = new Uint8Array(p.stdout);
  invariant(Buffer.from(out.subarray(0, AGE_HEADER.length)).toString("utf8") === AGE_HEADER, "age output must be an age v1 envelope");
  return out;
}

function decrypt(cipherPath: string, identity: string): Uint8Array | null {
  const p = Bun.spawnSync(["age", "-d", "-i", "/dev/stdin", cipherPath], { stdin: Buffer.from(identity + "\n"), stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0 ? new Uint8Array(p.stdout) : null;
}

/** Decrypt ciphertext held in memory. The identity stays on stdin, so the ciphertext goes through a private temp file. */
export function decryptBytes(cipher: Uint8Array, identity: string): Uint8Array | null {
  invariant(Buffer.from(cipher.subarray(0, AGE_HEADER.length)).toString("utf8") === AGE_HEADER, "only an age v1 envelope is written out to decrypt");
  const tmp = mkdtempSync(join(tmpdir(), "statvs-open-"));
  try {
    const f = join(tmp, "c.age");
    writeFileSync(f, cipher, { mode: 0o600 });
    return decrypt(f, identity);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The identity that opens .env.age, from the login Keychain. Never printed, never on argv. USER may be unset in a workflow step, so the account falls back to `id -un`. */
export function keychainIdentity(): string | null {
  const p = Bun.spawnSync(["security", "find-generic-password", "-a", process.env.USER || Bun.spawnSync(["id", "-un"], { stdout: "pipe" }).stdout.toString().trim(), "-s", "lifeos-age-identity", "-w"], { stdout: "pipe", stderr: "pipe" });
  const id = p.exitCode === 0 ? p.stdout.toString().trim() : "";
  return /^AGE-SECRET-KEY-(PQ-)?1/.test(id) ? id : null;
}

export function backup(opts: { recordDir?: string; dir?: string; recipient?: string } = {}): BackupResult {
  const record = resolve(opts.recordDir ?? statvsDir());
  const dir = resolve(opts.dir ?? backupDir());
  assertSeparate(record, dir);
  const recipient = opts.recipient ?? sealRecipient();
  invariant(RECIPIENT.test(recipient), "backup needs an age recipient");
  const prev = readManifest(dir);
  // A new recipient means every segment is re-encrypted to it, so no file is left readable only by an old key.
  const manifest: BackupManifest = { v: 1, recipient, segments: prev && prev.recipient === recipient ? { ...prev.segments } : {} };
  const written: string[] = [];
  let unchanged = 0;
  const segs = listSegments(record, [...BACKED_UP]);
  const want = new Map<string, string>();
  const objs = new Set<string>();
  for (const seg of segs) {
    want.set(seg.rel, seg.abs);
    for (const m of readFileSync(seg.abs, "utf8").matchAll(/"obj":"([0-9a-f]{64})"/g)) objs.add(m[1]!);
  }
  for (const h of objs) {
    const rel = `objects/${h.slice(0, 2)}/${h}.json`;
    if (existsSync(join(record, rel))) want.set(rel, join(record, rel));
  }
  for (const [rel, abs] of want) {
    const plain = new Uint8Array(readFileSync(abs));
    const hash = sha256(plain);
    const cipher = `${rel}.age`;
    const known = manifest.segments[rel];
    if (known && known.sha256 === hash && existsSync(join(dir, cipher))) { unchanged++; continue; }
    invariant(!cipher.startsWith("customer/"), "customer segments never leave their app");
    writeAtomic(dir, join(dir, cipher), encrypt(plain, recipient));
    manifest.segments[rel] = { sha256: hash, bytes: plain.length, cipher };
    written.push(rel);
  }
  const removed: string[] = [];
  for (const [rel, entry] of Object.entries(manifest.segments)) {
    if (want.has(rel) || existsSync(join(record, rel))) continue;
    invariant(resolve(join(dir, entry.cipher)).startsWith(dir + "/"), "a dropped backup file must sit inside the backup dir");
    if (existsSync(join(dir, entry.cipher))) unlinkSync(join(dir, entry.cipher));
    delete manifest.segments[rel];
    removed.push(rel);
  }
  if (written.length > 0 || removed.length > 0 || !prev || prev.recipient !== recipient) writeAtomic(dir, join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { dir, written, unchanged, segments: segs.length, objects: objs.size, removed };
}

export function restoreDrill(opts: { recordDir?: string; dir?: string; identity?: string } = {}): RestoreDrillResult {
  const record = resolve(opts.recordDir ?? statvsDir());
  const dir = resolve(opts.dir ?? backupDir());
  const problems: string[] = [];
  const result = (extra: Partial<RestoreDrillResult>): RestoreDrillResult =>
    ({ ok: false, restored: 0, exact: 0, prefix: 0, not_backed_up: [], verify_ok: false, problems, ...extra });
  const manifest = readManifest(dir);
  if (!manifest) { problems.push(`no backup manifest in ${dir}`); return result({}); }
  const identity = opts.identity ?? keychainIdentity();
  if (!identity) { problems.push("no age identity in the Keychain (service lifeos-age-identity)"); return result({}); }
  const tmp = mkdtempSync(join(tmpdir(), "statvs-restore-"));
  invariant(real(tmp) !== real(record) && !real(tmp).startsWith(real(record) + "/") && !real(record).startsWith(real(tmp) + "/"), "the restore dir must never overlap the live record");
  try {
    let restored = 0, exact = 0, prefix = 0;
    for (const [rel, entry] of Object.entries(manifest.segments)) {
      const plain = decrypt(join(dir, entry.cipher), identity);
      if (!plain) { problems.push(`${rel}: could not decrypt`); continue; }
      if (sha256(plain) !== entry.sha256 || plain.length !== entry.bytes) { problems.push(`${rel}: decrypted bytes do not match the manifest`); continue; }
      writeAtomic(tmp, join(tmp, rel), plain);
      restored++;
      const livePath = join(record, rel);
      if (!existsSync(livePath)) { problems.push(`${rel}: in the backup but missing from the live record`); continue; }
      const live = readFileSync(livePath);
      if (live.length === plain.length && live.equals(Buffer.from(plain))) exact++;
      else if (live.length > plain.length && live.subarray(0, plain.length).equals(Buffer.from(plain))) prefix++;
      else problems.push(`${rel}: restored bytes are not the live segment or a prefix of it`);
    }
    const v = verify({ dir: tmp, classes: true });
    // The backup holds system and personal segments only, but a seal anchor (in the system class) exists for a sealed
    // segment of every class, so the restored copy rightly lacks the target of an anchor for a class never backed up.
    // Every other problem, and a gone segment of a backed-up class, still fails the drill.
    const verifyProblems = v.problems.filter((p) => {
      const gone = /: sealed segment (\S+) is gone$/.exec(p);
      return !(gone && !(BACKED_UP as readonly string[]).includes(gone[1]!.split("/")[0]!));
    });
    for (const p of verifyProblems) problems.push(`verify: ${p}`);
    const not_backed_up = listSegments(record, [...BACKED_UP]).map((s) => s.rel).filter((rel) => !manifest.segments[rel]);
    return { ok: problems.length === 0 && restored > 0, restored, exact, prefix, not_backed_up, verify_ok: verifyProblems.length === 0, problems };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Offsite (ISC-108) ──

/** A private store that holds only ciphertext: the R2 bucket in production, a folder in tests. */
export interface OffsiteStore {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

export const OFFSITE_PREFIX = "statvs-backup/";
const OFFSITE_MANIFEST = `${OFFSITE_PREFIX}manifest.json.age`;

export interface OffsiteResult {
  uploaded: string[];
  unchanged: number;
  /** Offsite files deleted because the local backup dropped them (a redacted object). */
  deleted: string[];
  /** The encrypted manifest read back from the store is the bytes just sent. */
  manifest_verified: boolean;
}

/** A folder standing in for the bucket (tests, and STATVS_OFFSITE_DIR). Keys are paths under it. */
export function dirOffsite(root: string): OffsiteStore {
  const at = (key: string) => {
    const p = resolve(root, key);
    invariant(p.startsWith(resolve(root) + "/"), "an offsite key stays inside its folder");
    return p;
  };
  return {
    async put(key, body) { mkdirSync(dirname(at(key)), { recursive: true }); writeFileSync(at(key), body); },
    async get(key) { return existsSync(at(key)) ? readFileSync(at(key)) : null; },
    async delete(key) { rmSync(at(key), { force: true }); },
  };
}

const isAge = (b: Uint8Array) => Buffer.from(b.subarray(0, AGE_HEADER.length)).toString("utf8") === AGE_HEADER;

/**
 * Copy the local backup to the store: each ciphertext whose bytes changed since its last upload (fingerprints in
 * offsite.json beside the manifest), then the manifest, age-encrypted like everything else, so the bucket holds only
 * ciphertext. Files the local backup dropped are deleted offsite too. Run after `backup`.
 */
export async function offsite(store: OffsiteStore, opts: { dir?: string } = {}): Promise<OffsiteResult> {
  const dir = resolve(opts.dir ?? backupDir());
  const manifest = readManifest(dir);
  invariant(manifest, `no backup manifest in ${dir}; run backup first`);
  const statePath = join(dir, "offsite.json");
  const sent = (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {}) as Record<string, string>;
  const uploaded: string[] = [], deleted: string[] = [];
  let unchanged = 0;
  const live = new Set<string>();
  for (const [rel, entry] of Object.entries(manifest.segments)) {
    live.add(entry.cipher);
    const bytes = readFileSync(join(dir, entry.cipher));
    const fp = sha256(bytes);
    if (sent[entry.cipher] === fp) { unchanged++; continue; }
    invariant(isAge(bytes), "only age ciphertext leaves this machine");
    await store.put(OFFSITE_PREFIX + entry.cipher, bytes);
    sent[entry.cipher] = fp;
    uploaded.push(rel);
  }
  for (const cipher of Object.keys(sent)) {
    if (live.has(cipher)) continue;
    await store.delete(OFFSITE_PREFIX + cipher);
    delete sent[cipher];
    deleted.push(cipher);
  }
  const sealedManifest = Buffer.from(encrypt(new Uint8Array(readFileSync(join(dir, "manifest.json"))), manifest.recipient));
  await store.put(OFFSITE_MANIFEST, sealedManifest);
  const back = await store.get(OFFSITE_MANIFEST);
  writeAtomic(dir, statePath, JSON.stringify(sent, null, 1) + "\n");
  return { uploaded, unchanged, deleted, manifest_verified: !!back && back.equals(sealedManifest) };
}

/** Download the offsite copy into `into` (a fresh folder) as a backup dir the restore drill can read. */
export async function fetchOffsite(store: OffsiteStore, into: string, identity: string): Promise<{ ok: boolean; files: number; problems: string[] }> {
  invariant(real(into) !== real(statvsDir()) && !real(into).startsWith(real(statvsDir()) + "/") && !real(statvsDir()).startsWith(real(into) + "/"), "an offsite fetch never writes into the live record");
  const problems: string[] = [];
  const sealed = await store.get(OFFSITE_MANIFEST);
  if (!sealed) return { ok: false, files: 0, problems: ["no offsite manifest"] };
  const tmp = join(into, ".manifest.age");
  writeAtomic(into, tmp, sealed);
  const plain = decrypt(tmp, identity);
  rmSync(tmp, { force: true });
  if (!plain) return { ok: false, files: 0, problems: ["the offsite manifest could not be decrypted"] };
  const manifest = JSON.parse(Buffer.from(plain).toString("utf8")) as BackupManifest;
  let files = 0;
  for (const [rel, entry] of Object.entries(manifest.segments)) {
    const body = await store.get(OFFSITE_PREFIX + entry.cipher);
    if (!body) { problems.push(`${rel}: missing offsite`); continue; }
    writeAtomic(into, join(into, entry.cipher), body);
    files++;
  }
  writeAtomic(into, join(into, "manifest.json"), plain);
  return { ok: problems.length === 0, files, problems };
}

/** STATVS_OFFSITE_DIR when set, none under \`bun test\` (no test reaches the bucket), else the private R2 bucket the Archive uses. */
export async function offsiteStore(): Promise<OffsiteStore | null> {
  if (process.env.STATVS_OFFSITE_DIR) return dirOffsite(process.env.STATVS_OFFSITE_DIR);
  if (statvsTestRoot()) return null;
  const { r2Store } = await import("../../ARCHIVE/Archive");
  const s = await r2Store(process.env.LIFEOS_ARCHIVE_BUCKET || "lifeos-archive");
  invariant(typeof s.delete === "function", "the R2 store can delete");
  return { put: s.put, get: s.get, delete: s.delete };
}
