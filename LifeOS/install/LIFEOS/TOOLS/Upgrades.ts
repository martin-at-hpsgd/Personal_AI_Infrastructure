#!/usr/bin/env bun
/**
 * @version 1.3.0
 * Upgrades.ts — the Upgrades store: every system-improvement candidate as one
 * typed record with a lifecycle, regardless of where it came from.
 *
 * CENSVS dual-write (CENSVS ISA F8, STATVS migration step 1): after each store
 * write succeeds, the same change is written as a `proposal:<id>` RES through
 * LIFEOS/CENSVS/res.ts: add → create, accept/reject/apply/verify/expire → move
 * (plus a set of ledger_id on apply). The store stays the truth: a RES write
 * that fails or is refused never fails the store write; it is counted in
 * `resDualWrite` and in `.res-dualwrite.json` beside the records. A move to
 * accepted lands in the record only when the caller passes the principal's
 * channel as `by` (`principal:<channel>`); any other writer's accept is refused
 * there and recorded on the `move` stream, so `compare things-proposal` shows it.
 *
 * Store:   LIFEOS/MEMORY/UPGRADES/records/<id>.md   (frontmatter + body)
 * Sidecar: LIFEOS/MEMORY/UPGRADES/.state.json       (claim-hash dedup)
 *
 * Lifecycle: recommended → accepted → applied → verified | rejected | expired
 * Sources:   directive | correction | upgrade-skill | algo-run | autonomous | manual | analysis (/a)
 *            (autonomous records live in WISDOM/FRAMES/_hypotheses/ and are
 *             merged in at the Pulse layer — the deriver's format is unchanged)
 *
 * The Ledger (MEMORY/SYSTEMUPDATES/) stays applied-only; `apply` here stamps
 * ledger_id so the pending half and the applied half point at each other.
 *
 * Consumed by: SatisfactionCapture.hook.ts (directive capture),
 * PULSE/modules/upgrades.ts (dashboard), skills/Upgrade + /algo intents
 * (persist recommendations), LIFEOS/TOOLS/CreateUpdate.ts (--upgrade-id).
 */

import { accessSync, closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeSync, type Stats } from "fs";
import { basename, join, resolve } from "path";
import { createHash, randomUUID } from "crypto";
import { invariant } from "./Invariant";
import { confinedPath } from "./lib/Boundary";
import { getLifeosDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { writeEventOnce as statvsWriteEventOnce } from "../STATVS/index";

// Normalize env path vars that Claude Code injects without shell expansion (LifeOS#1404)
for (const k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const v = process.env[k];
  if (v && /^\$\{?HOME\}?(\/|$)/.test(v)) process.env[k] = v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}

function storePaths() {
  // LIFEOS_UPGRADES_DIR redirects the store so a test never writes the live queue.
  const upgradesDir = process.env.LIFEOS_UPGRADES_DIR || join(getLifeosDir(), "MEMORY", "UPGRADES");
  return {
    upgradesDir,
    recordsDir: join(upgradesDir, "records"),
    stateFile: join(upgradesDir, ".state.json"),
    staleCache: join(upgradesDir, ".stale-cache.json"),
  };
}
const EXPIRY_DAYS = 30;
/** The store root as an absolute path, taken before any write holds a directory (a relative env value must never resolve against a held one). */
function storeRoot(): string {
  return resolve(storePaths().upgradesDir);
}
/** A minted id is `<15-char stamp>_<slug>-<6 hex>`; capping the slug keeps every minted id inside isValidUpgradeId's 200. */
const SLUG_MAX = 150;

export type UpgradeStatus = "recommended" | "accepted" | "applied" | "verified" | "rejected" | "expired";
export type UpgradeSource = "directive" | "correction" | "upgrade-skill" | "algo-run" | "autonomous" | "manual" | "coach" | "errata" | "assay-miss" | "hillclimb" | "review" | "evidence" | "analysis";

/** Runtime allow-lists: the TypeScript unions vanish at the CLI boundary, so the values are enforced here. */
export const UPGRADE_SOURCES: readonly UpgradeSource[] = ["directive", "correction", "upgrade-skill", "algo-run", "autonomous", "manual", "coach", "errata", "assay-miss", "hillclimb", "review", "evidence", "analysis"];
export const UPGRADE_STATUSES: readonly UpgradeStatus[] = ["recommended", "accepted", "applied", "verified", "rejected", "expired"];

/** An id becomes a filename: one safe path segment, no separators, no dot-dot, bounded. */
export function isValidUpgradeId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id) && !id.includes("..");
}

/** A frontmatter value must stay on one line: a newline lets a caller forge later keys (e.g. status). */
const hasLineBreak = (v: unknown): boolean => typeof v === "string" && /[\r\n\u2028\u2029]/.test(v);

export interface UpgradeInput {
  claim: string;                 // what should change (one sentence is fine)
  source: UpgradeSource;
  current_state?: string;        // what happens today
  recommendation?: string;       // the proposed encoding
  target_surface?: string;       // hook | doctrine | rule | skill | settings | context
  confidence?: number;           // 0-1
  session_id?: string;
  evidence?: string[];           // session ids, incident dirs, report paths, URLs
  // ── coach source (CoachReview.ts) — behavioral recs mined from corrections ──
  quote?: string;                // verbatim correction, in the principal's words. REQUIRED when source=coach (the record's anchor + Pulse headline).
  category?: string;             // voice | format | process | verification | delegation | judgment
}

export interface UpgradeRecord extends UpgradeInput {
  id: string;
  slug: string;
  status: UpgradeStatus;
  created: string;
  expires: string;
  ledger_id: string | null;
  notes: string[];
  filename: string;
}

interface StoreState {
  schema_version: number;
  claim_hashes: Record<string, { id: string; created: string }>;
}

// ── State sidecar ──

function loadState(): StoreState {
  const { stateFile } = storePaths();
  try {
    if (existsSync(stateFile)) {
      // A linked sidecar is read through only while it resolves to a regular file inside the store, so a
      // history kept elsewhere in the store still dedups; one leading out of the store is never read.
      // saveState replaces any link with a real file holding this state, never writing through it.
      const path = lstatSync(stateFile).isSymbolicLink() ? confinedStateTarget() : stateFile;
      if (path) return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch {}
  return { schema_version: 1, claim_hashes: {} };
}

/** The real path a linked `.state.json` resolves to, when that is a regular file inside the store (Boundary.confinedPath), else null. Read-only. */
function confinedStateTarget(): string | null {
  const root = realDir(storeRoot());
  if (!root) return null;
  const real = confinedPath(root, ".state.json");
  try { return real && statSync(real).isFile() ? real : null; } catch { return null; }
}

function saveState(st: StoreState): void {
  invariant(st && typeof st.claim_hashes === "object", "saveState: state has no claim_hashes map");
  const abs = storeRoot();
  mkdirSync(abs, { recursive: true });
  // Written inside the held store root and renamed over the leaf: a symlink planted at the sidecar is
  // replaced, never written through, and a root swapped after the check never receives the bytes.
  const refused = pinnedWrite(() => realDir(abs), ".state.json", JSON.stringify(st, null, 2), "replace");
  if (refused) throw new UpgradeStoreError(refused, "state sidecar");
}

export function claimHash(claim: string): string {
  const norm = claim.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

// ── Record I/O ──

function slugify(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 8).join("-");
  return slug.slice(0, SLUG_MAX).replace(/-+$/, "") || "upgrade";
}

function esc(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\n/g, " ");
}

function renderRecord(r: UpgradeRecord): string {
  // Persistent-state writer: every scalar that lands in the frontmatter is one line and
  // the enums hold. addUpgrade/setStatus validate first; reaching this is an impossible state.
  invariant(isValidUpgradeId(r.id), `renderRecord: invalid upgrade id ${JSON.stringify(r.id)}`);
  invariant(UPGRADE_STATUSES.includes(r.status), `renderRecord: invalid status ${r.status}`);
  // Legacy records carry retired sources (principal, session, ...); only a line break is impossible.
  invariant(typeof r.source === "string" && !hasLineBreak(r.source), `renderRecord: source contains a line break`);
  for (const [k, v] of Object.entries({ slug: r.slug, created: r.created, expires: r.expires, target_surface: r.target_surface, category: r.category, session_id: r.session_id, ledger_id: r.ledger_id, confidence: r.confidence }))
    invariant(!hasLineBreak(typeof v === "number" ? String(v) : v), `renderRecord: frontmatter field ${k} contains a line break`);
  const evidence = (r.evidence ?? []).map((e) => `  - "${esc(e)}"`).join("\n");
  // category/quote are emitted only when present, so non-coach records render
  // byte-identically to before this field pair existed.
  const category = r.category ? `category: ${r.category}\n` : "";
  const quote = r.quote ? `quote: "${esc(r.quote)}"\n` : "";
  return `---
id: ${r.id}
slug: ${r.slug}
status: ${r.status}
source: ${r.source}
created: ${r.created}
expires: ${r.expires}
confidence: ${r.confidence ?? 0.5}
target_surface: ${r.target_surface ?? "unknown"}
${category}${quote}session_id: ${r.session_id ?? ""}
ledger_id: ${r.ledger_id ?? ""}
evidence:
${evidence}
---

## Claim

${r.claim}

## Current State

${r.current_state ?? "(not stated)"}

## Recommendation

${r.recommendation ?? "(not yet drafted)"}

## Notes
${r.notes.map((n) => `\n- ${n}`).join("")}
`;
}

/**
 * The real records dir, confined against the store root (Boundary.confinedPath, symlinks resolved first),
 * or null. The trust boundary is the store, never the records dir itself: a `records` that is a link out
 * of the store resolves outside it and is refused, and so is one that collapses onto the store root.
 */
function realRecordsDir(abs: string = storeRoot()): string | null {
  const root = realDir(abs);
  if (!root) return null;
  const dir = confinedPath(root, "records");
  return dir && dir !== root ? dir : null;
}

/** The real path of an absolute directory path, or null when it does not resolve. */
function realDir(abs: string): string | null {
  try { return realpathSync(abs); } catch { return null; }
}

/** Resolve a record file to a real path inside the store's records dir, or null. Symlinks are dereferenced BEFORE the boundary check. */
function containedRecordPath(filename: string): string | null {
  if (!filename.endsWith(".md") || !isValidUpgradeId(filename.slice(0, -3))) return null;
  const dir = realRecordsDir();
  if (!dir) return null;
  const real = confinedPath(dir, filename);
  if (!real) return null;
  try { return statSync(real).isFile() ? real : null; } catch { return null; }
}

/**
 * Test seams, never set in production. afterResolve runs once the directory is confined and before its
 * inode is taken; afterConfine runs once the inode is taken and before the temp is created; beforeCommit
 * runs once the bytes are written and checked, just before link()/rename(). A race test swaps a parent or
 * plants a leaf link in any window.
 */
export const _recordWriteHooks: { afterResolve?: (dir: string, name: string) => void; afterConfine?: (dir: string, name: string) => void; beforeCommit?: (target: string) => void } = {};

/** Why a store write was refused. */
export type StoreWriteRefusal = "unsafe_record_path" | "record_path_exists";

/**
 * Thrown by addUpgrade, appendNote and the state sidecar write when the store itself cannot be written safely: a
 * records dir or root that leads out of the store, a link planted at the record name, a directory swapped
 * mid-write. It is a store fault, never a per-record outcome, so it is never returned in the
 * `{ created: false }` shape callers read as "already recorded" (CoachReview drops those).
 */
export class UpgradeStoreError extends Error {
  readonly reason: StoreWriteRefusal;
  constructor(reason: StoreWriteRefusal, what: string) {
    super(`Upgrades store refused to write ${what}: ${reason}`);
    this.name = "UpgradeStoreError";
    this.reason = reason;
  }
}

const sameInode = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;

/**
 * Write `name` inside the directory `resolveDir()` confines, or say why not. The process working directory
 * is never borrowed: it is process-wide (async fs work and Workers resolve relative paths against it) and
 * Node has no fchdir, so a borrowed cwd cannot be returned to its inode once its path is swapped.
 *
 * The directory is pinned by its first confined real path AND its inode. `stable()` holds only while the
 * path still confines to that same real path and that path still names that inode, so a parent or root
 * swapped at any point fails it (swapped away: the confined path changes or vanishes; swapped back: the
 * inode differs). It is checked before the temp is created, again after (with the temp proved to be the
 * file this write opened), and again after the commit, which must have put this write's inode at the name.
 *
 * Leaf: the temp is created O_EXCL|O_NOFOLLOW. create links the temp to the name, and link() fails with
 * EEXIST on anything already there (file, symlink, dangling link) without following it; replace renames
 * over the name, so a link there is replaced, never written through. A name this write committed is taken
 * back only while it still names this write's inode. The temp name is fixed-length, so it never outgrows a
 * valid record name.
 */
function pinnedWrite(resolveDir: () => string | null, name: string, body: string, mode: "create" | "replace"): StoreWriteRefusal | null {
  invariant(/^[^/\0]+$/.test(name) && name !== "." && name !== "..", `pinnedWrite: ${JSON.stringify(name)} is not one path segment`);
  const dir = resolveDir();
  if (!dir) return "unsafe_record_path";
  _recordWriteHooks.afterResolve?.(dir, name);
  let checked: Stats;
  try { checked = statSync(dir); } catch { return "unsafe_record_path"; }
  if (!checked.isDirectory()) return "unsafe_record_path";
  _recordWriteHooks.afterConfine?.(dir, name);
  const stable = (): boolean => {
    try { return resolveDir() === dir && sameInode(statSync(dir), checked); } catch { return false; }
  };
  const isOurs = (p: string, ours: Stats): boolean => {
    try { return sameInode(lstatSync(p), ours); } catch { return false; }
  };
  if (!stable()) return "unsafe_record_path";
  const tmpPath = join(dir, `.upgrades-${randomUUID()}.tmp`);
  const target = join(dir, name);
  // A replace keeps the permission bits of the regular file it replaces (an in-place rewrite did); a new
  // file, or a link at the name, gets 0600. Setuid, setgid and sticky bits are never carried over.
  let keepMode = 0o600;
  let present: Stats | null = null;
  if (mode === "replace") { try { const t = lstatSync(target); if (t.isFile()) { present = t; keepMode = t.mode & 0o777; } } catch { /* nothing there yet */ } }
  // A regular file this process may not write is refused with EACCES, as the in-place rewrite was; a
  // rename would replace it whatever its mode.
  if (present) accessSync(target, constants.W_OK);
  let fd: number;
  try { fd = openSync(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (e) {
    // A directory this process may not create in (a records dir 0500) still lets a writable record be
    // rewritten in place, as before: only the single-linked regular file checked at the name, opened
    // O_NOFOLLOW, in a directory that is still the store's. Any other open failure stays a refusal.
    const code = (e as NodeJS.ErrnoException).code;
    if (!present || (code !== "EACCES" && code !== "EPERM")) return "unsafe_record_path";
    if (!stable()) return "unsafe_record_path";
    let inPlace: number;
    try { inPlace = openSync(target, constants.O_WRONLY | constants.O_NOFOLLOW); }
    catch (e2) { if ((e2 as NodeJS.ErrnoException).code === "ELOOP") return "unsafe_record_path"; throw e2; }
    try {
      const st = fstatSync(inPlace);
      if (!st.isFile() || st.nlink !== 1 || !sameInode(st, present) || !stable()) return "unsafe_record_path";
      const bytes = Buffer.from(body, "utf8");
      ftruncateSync(inPlace, 0);
      let off = 0;
      while (off < bytes.length) off += writeSync(inPlace, bytes, off, bytes.length - off, off);
      fsyncSync(inPlace);
      return null;
    } finally { closeSync(inPlace); }
  }
  let ours: Stats | null = null;
  try {
    // Always set: the temp was created under the caller's umask, which can mask 0600 down to 0000.
    fchmodSync(fd, keepMode);
    ours = fstatSync(fd);
    const bytes = Buffer.from(body, "utf8");
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
    // The temp this write opened must be the one at the store's path, in a directory that is still the store's.
    if (!isOurs(tmpPath, ours) || !stable()) return "unsafe_record_path";
    _recordWriteHooks.beforeCommit?.(target);
    if (mode === "replace") {
      try { renameSync(tmpPath, target); } catch { return "unsafe_record_path"; }
    } else {
      try { linkSync(tmpPath, target); }
      catch (e) { return (e as NodeJS.ErrnoException).code === "EEXIST" ? "record_path_exists" : "unsafe_record_path"; }
    }
    if (!stable() || !isOurs(target, ours)) {
      // The directory stopped being the store's around the commit. A new name this write made is taken back.
      if (mode === "create" && isOurs(target, ours)) { try { unlinkSync(target); } catch { /* already gone */ } }
      return "unsafe_record_path";
    }
    return null;
  } finally {
    closeSync(fd);
    // Only this write's own temp is ever removed: a path swapped to name someone else's file is left alone.
    if (ours && isOurs(tmpPath, ours)) { try { unlinkSync(tmpPath); } catch { /* already gone */ } }
  }
}

/** Write one record file inside the store's records dir (see pinnedWrite), or say why not. */
function writeRecordFile(filename: string, body: string, mode: "create" | "replace"): StoreWriteRefusal | null {
  invariant(filename.endsWith(".md") && isValidUpgradeId(filename.slice(0, -3)), `writeRecordFile: invalid record filename ${JSON.stringify(filename)}`);
  const abs = storeRoot();
  return pinnedWrite(() => realRecordsDir(abs), filename, body, mode);
}

/**
 * The regular record of this id AND this claim already at its name, or null: a concurrent writer of the
 * same claim (or a retry after the sidecar was lost), not a store fault. A distinct claim that minted the
 * same id (same second, slug and 6-hex prefix) is a collision, never a duplicate: the caller gets a store
 * refusal and keeps it. Read-only.
 */
function sameRecordPresent(id: string, claim: string): UpgradeRecord | null {
  const dir = realRecordsDir();
  if (!dir) return null;
  try { if (!lstatSync(join(dir, `${id}.md`)).isFile()) return null; } catch { return null; }
  const present = parseRecord(`${id}.md`);
  return present?.id === id && claimHash(present.claim) === claimHash(claim) ? present : null;
}

function parseRecord(filename: string): UpgradeRecord | null {
  const fp = containedRecordPath(filename);
  if (!fp) return null;
  const content = readFileSync(fp, "utf-8");
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const fm: Record<string, any> = {};
  let arrKey: string | null = null;
  for (const line of m[1].split("\n")) {
    if (arrKey && /^\s+-\s/.test(line)) {
      fm[arrKey].push(line.replace(/^\s+-\s/, "").trim().replace(/^"|"$/g, ""));
      continue;
    }
    arrKey = null;
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) continue;
    // A repeated key is a forged or corrupted record (a later `status:` must never override
    // the one the store wrote), so the whole record is refused.
    if (Object.prototype.hasOwnProperty.call(fm, kv[1])) return null;
    if (kv[2].trim() === "" && kv[1] === "evidence") { fm[kv[1]] = []; arrKey = kv[1]; }
    else fm[kv[1]] = kv[2].trim();
  }
  const body = m[2];
  const section = (h: string) => {
    const re = new RegExp(`^##\\s+${h}\\s*\\n([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, "m");
    const sm = body.match(re);
    return sm ? sm[1].trim() : "";
  };
  if (!fm.id || !fm.status) return null;
  if (String(fm.id) !== filename.slice(0, -3)) return null; // the id inside must be the file's own id
  if (!UPGRADE_STATUSES.includes(fm.status as UpgradeStatus)) return null;
  return {
    id: String(fm.id),
    slug: String(fm.slug ?? fm.id),
    status: fm.status as UpgradeStatus,
    source: (fm.source ?? "manual") as UpgradeSource,
    created: String(fm.created ?? ""),
    expires: String(fm.expires ?? ""),
    confidence: Number(fm.confidence ?? 0.5),
    target_surface: String(fm.target_surface ?? "unknown"),
    // quote is stored quoted+escaped on one line; strip the wrapping quotes and
    // unescape the two sequences esc() produces (\" back to ").
    quote: fm.quote ? String(fm.quote).replace(/^"|"$/g, "").replace(/\\"/g, '"') : undefined,
    category: fm.category ? String(fm.category) : undefined,
    session_id: String(fm.session_id ?? ""),
    ledger_id: fm.ledger_id ? String(fm.ledger_id) : null,
    evidence: Array.isArray(fm.evidence) ? fm.evidence : [],
    claim: section("Claim"),
    current_state: section("Current State"),
    recommendation: section("Recommendation"),
    notes: section("Notes").split("\n").map((l) => l.replace(/^-\s*/, "").trim()).filter(Boolean),
    filename,
  };
}

// ── CENSVS dual-write ──

type ResApi = typeof import("../CENSVS/res");
type ResOutcome = { ok: true } | { ok: false; refused?: string; spooled?: true; reason?: string };

/** The writer every store-side RES row carries. GENERA's proposal kind names it as the owner of ledger_id. */
export const RES_WRITER = "tool:Upgrades";
/** A status change's writer: `<kind>:<name>`, one token. `principal:<channel>` is the principal's own channel. */
/** Upgrade source → proposal species, the mapping the read-only resolver uses (CENSVS/sources/upgrades.ts). */
const PROPOSAL_SPECIES: Readonly<Record<string, string>> = { errata: "errata", review: "review" };

/** The RES id of an Upgrades record. */
export function proposalId(id: string): string {
  return `proposal:${id}`;
}

/**
 * One store record as its proposal RES: title, state (the store's word; GENERA reads `recommended`
 * as `proposed`) and data. Pure, and the one mapping the dual-write, the seed and the slice share.
 */
export function proposalShape(r: UpgradeRecord): { title: string; state: UpgradeStatus; data: Record<string, unknown> } {
  const line = (r.claim ?? "").replace(/\s+/g, " ").trim();
  const title = (line.length > 160 ? `${line.slice(0, 159)}…` : line) || r.slug || r.id;
  const data: Record<string, unknown> = { species: PROPOSAL_SPECIES[r.source] ?? "upgrade", source_kind: r.source };
  if (r.created) data.created = r.created;
  if (r.expires) data.expires = r.expires;
  if (typeof r.confidence === "number" && Number.isFinite(r.confidence)) data.confidence = r.confidence;
  if (r.target_surface) data.target_surface = r.target_surface;
  if (r.ledger_id && r.ledger_id !== "null") data.ledger_id = r.ledger_id;
  return { title, state: r.status, data };
}

/** How the dual-write went in this process. `last` names the newest failure. */
export interface ResDualWriteCounts { ok: number; spooled: number; failed: number; skipped: number; last: string | null }
export const resDualWrite: ResDualWriteCounts = { ok: 0, spooled: 0, failed: 0, skipped: 0, last: null };

/** Test seam, never set in production: a stand-in for LIFEOS/CENSVS/res.ts. */
export const _resWriteHooks: { api?: ResApi } = {};

/**
 * Whether this process dual-writes. Off with LIFEOS_UPGRADES_RES=0. A redirected store (a test or a scratch
 * copy) writes RES rows only into a redirected record (STATVS_DIR, or the STATVS test arm under `bun test`):
 * its proposals must never land in the live record.
 */
export function resEnabled(): boolean {
  if (process.env.LIFEOS_UPGRADES_RES === "0") return false;
  if (process.env.LIFEOS_UPGRADES_DIR && !process.env.STATVS_DIR && process.env.NODE_ENV !== "test") return false;
  return true;
}

let resApi: ResApi | null | undefined;
/** res.ts is loaded on the first write, so a reader of the store (the per-turn stale line) never pays for STATVS. */
function loadRes(): ResApi {
  if (_resWriteHooks.api) return _resWriteHooks.api;
  if (resApi === undefined) {
    try { resApi = require("../CENSVS/res") as ResApi; }
    catch (e) { resApi = null; throw e; }
  }
  if (!resApi) throw new Error("LIFEOS/CENSVS/res.ts did not load");
  return resApi;
}

/** The STATVS event a failed RES dual-write raises (CENSVS ISC-66); there is no private counter file. */
export const RES_DUALWRITE_EVENT = "res-dualwrite-failed";

/** Record one failure as a STATVS event, deduplicated per hour, so a failure in a hook or a Pulse request is still seen later. Best effort. */
function noteResFailure(id: string, what: string, why: string): void {
  resDualWrite.failed++;
  resDualWrite.last = `${what} ${proposalId(id)}: ${why}`.slice(0, 500);
  try {
    const hour = new Date().toISOString().slice(0, 13);
    const short = (s: string) => s.replace(/[A-Za-z0-9_-]{40,}/g, (m) => `${m.slice(0, 12)}…`);
    statvsWriteEventOnce({
      ts: new Date().toISOString(), source: "upgrades", kind: "infra", severity: "low", privacy_class: "personal",
      title: `Upgrades RES dual-write failed (${what})`,
      dedup_key: `${RES_DUALWRITE_EVENT}:upgrades:${hour}`,
      summary: short(why).slice(0, 300),
      meta: { type: RES_DUALWRITE_EVENT, op: what, id_hash: createHash("sha256").update(id).digest("hex").slice(0, 12) },
    });
  } catch { /* the in-process count stands */ }
}

/** Run one store change's RES writes. Every outcome is counted; nothing here ever reaches the store caller. */
function mirror(id: string, what: string, fn: (api: ResApi) => ResOutcome[]): void {
  if (!resEnabled()) { resDualWrite.skipped++; return; }
  try {
    const out = fn(loadRes());
    const bad = out.find((r) => !r.ok && !r.spooled);
    if (bad && !bad.ok) noteResFailure(id, what, bad.refused ?? bad.reason ?? "refused");
    else if (out.some((r) => !r.ok && r.spooled)) resDualWrite.spooled++;
    else resDualWrite.ok++;
  } catch (e) {
    // The store write already stands (migration step 1: the store is the truth), so even an impossible state
    // in the RES writer is counted and shown here, never rethrown into the store's caller.
    const err = e as Error;
    noteResFailure(id, what, `${err?.name ?? "Error"}: ${err?.message ?? String(e)}`);
    if (err?.name === "InvariantViolation") console.error(`[Upgrades] RES dual-write hit an impossible state on ${proposalId(id)}: ${err.message}`);
  }
}

/** The RES of a record that is already in the store, created at the state the store held before this change when the record lacks it. */
function ensureProposal(api: ResApi, before: UpgradeRecord): ResOutcome | null {
  const sid = proposalId(before.id);
  if (Object.hasOwn(api.recordFold().res, sid)) return null;
  const s = proposalShape(before);
  return api.create(sid, { title: s.title, state: s.state, data: s.data }, { writer: RES_WRITER });
}

// ── Public API ──

/**
 * File one recommendation. Returns `{ created: true, id }`, or `{ created: false, ... }` for a rejected
 * input (`claim_too_short`, `invalid_*`) or a `duplicate` (with the existing id). A store that cannot be
 * written safely throws UpgradeStoreError instead: that is never a duplicate, and a caller that reads
 * `created: false` as "already recorded" must not silently drop the recommendation.
 */
export function addUpgrade(input: UpgradeInput): { created: boolean; id: string; reason?: string } {
  if (!input.claim || input.claim.trim().length < 10) return { created: false, id: "", reason: "claim_too_short" };
  if (!UPGRADE_SOURCES.includes(input.source)) return { created: false, id: "", reason: "invalid_source" };
  for (const f of ["target_surface", "category", "session_id"] as const)
    if (input[f] !== undefined && (typeof input[f] !== "string" || hasLineBreak(input[f]))) return { created: false, id: "", reason: `invalid_${f}` };
  if (input.confidence !== undefined && (typeof input.confidence !== "number" || !Number.isFinite(input.confidence))) return { created: false, id: "", reason: "invalid_confidence" };
  const st = loadState();
  const hash = claimHash(input.claim);
  if (st.claim_hashes[hash]) return { created: false, id: st.claim_hashes[hash].id, reason: "duplicate" };

  // A records path that cannot be made a directory (a dangling link, a file) is a store fault.
  try { mkdirSync(join(storeRoot(), "records"), { recursive: true }); }
  catch { throw new UpgradeStoreError("unsafe_record_path", "the records dir"); }
  const now = new Date();
  const stamp = now.toISOString();
  const idStamp = stamp.slice(0, 19).replace(/[-:T]/g, "").replace(/^(\d{8})(\d{6})$/, "$1-$2");
  const slug = slugify(input.claim);
  // The claim-hash suffix keeps ids unique for a BATCH writer (CoachReview, /algo)
  // that adds several records inside one second: the timestamp is second-precision
  // and the slug is only the first 8 words, so two distinct claims sharing that
  // prefix would otherwise collide on filename and silently overwrite. Distinct
  // claim → distinct hash → distinct id; a repeat claim is caught by the dedup above.
  const id = `${idStamp}_${slug}-${hash.slice(0, 6)}`;
  const record: UpgradeRecord = {
    ...input,
    claim: input.claim.trim().slice(0, 1000),
    id,
    slug,
    status: "recommended",
    created: stamp,
    expires: new Date(now.getTime() + EXPIRY_DAYS * 86400000).toISOString(),
    ledger_id: null,
    notes: [`${stamp} — created (source: ${input.source})`],
    filename: `${id}.md`,
  };
  // CL-1 falsifier ("a coach record that omits its quote") enforced at the store
  // boundary: a coach record MUST carry its verbatim anchor. CoachReview gates on
  // this upstream, so a violation here is an impossible state, not a user error.
  invariant(record.source !== "coach" || !!record.quote?.trim(), `coach upgrade ${id} written without a verbatim quote`);
  const refused = writeRecordFile(record.filename, renderRecord(record), "create");
  // The same id already filed as a regular record of the same claim is a concurrent writer of this claim
  // (or a retry after the sidecar was lost); anything else at the name is a fault.
  const present = refused === "record_path_exists" ? sameRecordPresent(id, record.claim) : null;
  if (present) {
    // Rebuild the claim history a lost sidecar dropped, so a retry in a later second (a new id) still dedups.
    st.claim_hashes[hash] = { id, created: present.created || stamp };
    saveState(st);
    return { created: false, id, reason: "duplicate" };
  }
  if (refused) throw new UpgradeStoreError(refused, `record ${id}`);
  st.claim_hashes[hash] = { id, created: stamp };
  saveState(st);
  // The RES is built from the record as the store reads it back, so the record and the store agree field for field.
  mirror(id, "create", (api) => {
    const stored = getUpgrade(id);
    if (!stored) return [{ ok: false, refused: "the record did not read back after its write" }];
    const s = proposalShape(stored);
    return [api.create(proposalId(id), { title: s.title, state: s.state, data: s.data }, { writer: RES_WRITER })];
  });
  return { created: true, id };
}

export function listUpgrades(filter?: { status?: string; source?: string }): UpgradeRecord[] {
  const { recordsDir } = storePaths();
  if (!existsSync(recordsDir)) return [];
  const out: UpgradeRecord[] = [];
  for (const f of readdirSync(recordsDir).filter((f) => f.endsWith(".md"))) {
    const r = parseRecord(f);
    if (!r) continue;
    if (filter?.status && r.status !== filter.status) continue;
    if (filter?.source && r.source !== filter.source) continue;
    out.push(r);
  }
  return out.sort((a, b) => b.created.localeCompare(a.created));
}

export function getUpgrade(id: string): UpgradeRecord | null {
  if (!isValidUpgradeId(id)) return null;
  return parseRecord(`${id}.md`);
}

const TRANSITIONS: Record<string, UpgradeStatus[]> = {
  recommended: ["accepted", "rejected", "expired", "applied"],
  accepted: ["applied", "rejected"],
  applied: ["verified"],
};

/**
 * Move one record to `status`. `by` names who decided it for the record's RES row (default RES_WRITER);
 * pass `principal:<channel>` only from code that relays the principal's own words, since GENERA lets only
 * that channel move a proposal to accepted. The store's own transitions are unchanged either way.
 */
export function setStatus(
  id: string,
  status: UpgradeStatus,
  opts?: { note?: string; ledger_id?: string }
): { ok: boolean; reason?: string } {
  if (!UPGRADE_STATUSES.includes(status)) return { ok: false, reason: "invalid_status" };
  if (opts?.ledger_id !== undefined && (typeof opts.ledger_id !== "string" || hasLineBreak(opts.ledger_id))) return { ok: false, reason: "invalid_ledger_id" };
  const r = getUpgrade(id);
  if (!r) return { ok: false, reason: "not_found" };
  const allowed = TRANSITIONS[r.status] ?? [];
  if (!allowed.includes(status)) return { ok: false, reason: `illegal_transition_${r.status}_to_${status}` };
  const before: UpgradeRecord = { ...r, notes: [...r.notes], evidence: [...(r.evidence ?? [])] };
  r.status = status;
  if (opts?.ledger_id) r.ledger_id = opts.ledger_id;
  const stamp = new Date().toISOString();
  r.notes.push(`${stamp} — ${status}${opts?.ledger_id ? ` (ledger: ${opts.ledger_id})` : ""}${opts?.note ? `: ${opts.note.replace(/[\r\n\u2028\u2029]+/g, " ")}` : ""}`);
  const { staleCache } = storePaths();
  const refused = writeRecordFile(r.filename, renderRecord(r), "replace");
  if (refused) return { ok: false, reason: refused };
  // Any status change invalidates the stale-summary cache so the per-turn ⏳
  // line never nags about an already-dispositioned record (Astra nit, 2026-08-17).
  try { if (existsSync(staleCache)) rmSync(staleCache); } catch { /* best-effort */ }
  mirror(id, `move ${before.status}>${status}`, (api) => {
    const sid = proposalId(id);
    const out: ResOutcome[] = [];
    const made = ensureProposal(api, before);
    if (made) { out.push(made); if (!made.ok) return out; }
    const note = opts?.note?.replace(/\s+/g, " ").trim();
    const moved = api.move(sid, status, { writer: (status === "accepted" ? (api as { principalWriter?: () => string | null }).principalWriter?.() : null) ?? RES_WRITER, from: before.status, ...(note ? { reason: note.slice(0, 200) } : {}) });
    out.push(moved);
    if (moved.ok && opts?.ledger_id) out.push(api.set(sid, { data: { ledger_id: opts.ledger_id } }, { writer: RES_WRITER }));
    return out;
  });
  return { ok: true };
}

/**
 * Append a note to a record WITHOUT changing its status — the recurrence-folding
 * primitive for CoachReview: a fresh correction that matches an existing pending
 * coach claim bumps a `recurred:` note on it (the Pulse card's recurrence count)
 * instead of minting a near-duplicate record. A store that cannot be written safely
 * throws UpgradeStoreError (as addUpgrade does): CoachReview treats `ok: false` as
 * "nothing to fold", so a refusal returned in that shape would drop the recurrence.
 */
export function appendNote(id: string, note: string): { ok: boolean; reason?: string } {
  const r = getUpgrade(id);
  if (!r) return { ok: false, reason: "not_found" };
  invariant(note.trim().length > 0, `appendNote on ${id} with an empty note`);
  r.notes.push(note.trim());
  const refused = writeRecordFile(r.filename, renderRecord(r), "replace");
  if (refused) throw new UpgradeStoreError(refused, `a note on record ${id}`);
  return { ok: true };
}

/**
 * Aging escalation (2026-08-17, improvement-pass P1): `recommended` records older
 * than `days` are the "sitting silently" set — six pass-#2 proposals aged 7 days
 * unadopted while their failure classes recurred. Surfaced per-turn via
 * staleSummaryCached() (LoadMemory injection) and on demand via the `stale` CLI.
 * Class-recurrence analysis stays /algo's job; aging is the deterministic tooth.
 */
export function staleRecommended(days = 14): UpgradeRecord[] {
  const cutoff = Date.now() - days * 86400000;
  return listUpgrades({ status: "recommended" }).filter(
    (r) => r.created && new Date(r.created).getTime() < cutoff
  );
}

/** Cheap per-turn summary — recomputes at most every `maxAgeMs`, else serves the cache. */
export function staleSummaryCached(maxAgeMs = 6 * 3600_000): { count: number; oldestDays: number } {
  const { staleCache } = storePaths();
  try {
    if (existsSync(staleCache)) {
      const c = JSON.parse(readFileSync(staleCache, "utf-8"));
      if (c?.computed && Date.now() - new Date(c.computed).getTime() < maxAgeMs)
        return { count: c.count ?? 0, oldestDays: c.oldestDays ?? 0 };
    }
  } catch { /* recompute */ }
  const rows = staleRecommended();
  const oldestDays = rows.length
    ? Math.floor((Date.now() - Math.min(...rows.map((r) => new Date(r.created).getTime()))) / 86400000)
    : 0;
  const out = { count: rows.length, oldestDays };
  try {
    const abs = storeRoot();
    mkdirSync(abs, { recursive: true });
    pinnedWrite(() => realDir(abs), basename(staleCache), JSON.stringify({ ...out, computed: new Date().toISOString() }), "replace");
  } catch { /* cache is best-effort */ }
  return out;
}

export function expireSweep(): number {
  const now = Date.now();
  let n = 0;
  for (const r of listUpgrades({ status: "recommended" })) {
    if (r.expires && new Date(r.expires).getTime() < now) {
      if (setStatus(r.id, "expired", { note: "TTL sweep" }).ok) n++;
    }
  }
  return n;
}

// ── CLI ──

function argVal(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function argAll(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag && args[i + 1]) out.push(args[i + 1]);
  return out;
}

/** Flags each status command reads. Any other flag is refused, never dropped: `reject --reason` once silently lost a batch of notes. */
export const STATUS_FLAGS: Record<string, string[]> = { accept: ["--note"], reject: ["--note"], apply: ["--note", "--ledger"], verify: ["--note"] };
export function unknownFlags(cmd: string, args: string[]): string[] {
  const allowed = STATUS_FLAGS[cmd];
  return allowed ? args.filter((a) => a.startsWith("--") && !allowed.includes(a) && a !== "--json") : [];
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  const json = args.includes("--json");
  const bad = unknownFlags(cmd ?? "", args);
  if (bad.length) { console.error(`Upgrades.ts ${cmd}: unknown flag ${bad.join(", ")}; accepted: ${STATUS_FLAGS[cmd!]!.join(", ")}`); process.exit(2); }
  switch (cmd) {
    case "add": {
      let res: ReturnType<typeof addUpgrade>;
      try {
        res = addUpgrade({
          claim: argVal(args, "--claim") ?? "",
          source: (argVal(args, "--source") ?? "manual") as UpgradeSource,
          current_state: argVal(args, "--current"),
          recommendation: argVal(args, "--recommendation"),
          target_surface: argVal(args, "--target"),
          confidence: argVal(args, "--confidence") ? Number(argVal(args, "--confidence")) : undefined,
          session_id: argVal(args, "--session"),
          evidence: argAll(args, "--evidence"),
        });
      } catch (e) {
        if (!(e instanceof UpgradeStoreError)) throw e;
        console.log(JSON.stringify({ created: false, id: "", reason: e.reason, error: e.message }));
        process.exit(1);
      }
      console.log(JSON.stringify(res));
      process.exit(res.created || res.reason === "duplicate" ? 0 : 1);
    }
    case "list": {
      const rows = listUpgrades({ status: argVal(args, "--status"), source: argVal(args, "--source") });
      if (json) console.log(JSON.stringify(rows.map(({ notes, ...r }) => r), null, 2));
      else for (const r of rows) console.log(`${r.status.padEnd(11)} ${r.source.padEnd(13)} ${r.id}  ${r.claim.slice(0, 80)}`);
      process.exit(0);
    }
    case "show": {
      const r = getUpgrade(args[0] ?? "");
      console.log(r ? JSON.stringify(r, null, 2) : "not found");
      process.exit(r ? 0 : 1);
    }
    case "accept":
    case "reject": {
      const res = setStatus(args[0] ?? "", cmd === "accept" ? "accepted" : "rejected", { note: argVal(args, "--note") });
      console.log(JSON.stringify(res));
      process.exit(res.ok ? 0 : 1);
    }
    case "apply": {
      const res = setStatus(args[0] ?? "", "applied", { ledger_id: argVal(args, "--ledger"), note: argVal(args, "--note") });
      console.log(JSON.stringify(res));
      process.exit(res.ok ? 0 : 1);
    }
    case "verify": {
      const res = setStatus(args[0] ?? "", "verified", { note: argVal(args, "--note") });
      console.log(JSON.stringify(res));
      process.exit(res.ok ? 0 : 1);
    }
    case "expire": {
      console.log(JSON.stringify({ expired: expireSweep() }));
      process.exit(0);
    }
    case "stale": {
      const days = argVal(args, "--days") ? Number(argVal(args, "--days")) : 14;
      const rows = staleRecommended(days);
      if (json) console.log(JSON.stringify(rows.map(({ notes, ...r }) => r), null, 2));
      else for (const r of rows) console.log(`${r.created.slice(0, 10)}  ${r.id}  ${r.claim.slice(0, 80)}`);
      process.exit(0);
    }
    case "stats": {
      const all = listUpgrades();
      const by = (k: "status" | "source") =>
        all.reduce<Record<string, number>>((acc, r) => ((acc[r[k] as string] = (acc[r[k] as string] ?? 0) + 1), acc), {});
      console.log(JSON.stringify({ total: all.length, by_status: by("status"), by_source: by("source") }, null, 2));
      process.exit(0);
    }
    case "res-status": {
      // Failures are STATVS events of type RES_DUALWRITE_EVENT (CENSVS ISC-66); this prints only this process's counts.
      console.log(JSON.stringify({ enabled: resEnabled(), event: RES_DUALWRITE_EVENT, ...resDualWrite }, null, 2));
      process.exit(0);
    }
    default:
      console.log("usage: Upgrades.ts add|list|show|accept|reject|apply|verify|expire|stale|stats|res-status");
      process.exit(cmd ? 1 : 0);
  }
}
