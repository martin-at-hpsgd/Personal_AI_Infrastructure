#!/usr/bin/env bun
/**
 * @version 0.1.1
 * ReviewReplay — rebuilds exactly what a past code review read, so a later miss can be replayed against it
 * (review-miss-evals ISA, F3).
 *
 * A review's input is the diff Review.ts built from its base to the working tree. It is rebuilt from:
 *   1. the stored diff (`Proof/receipts/artifacts/review-<fingerprint>.diff`), when its sha256 is the review's fingerprint;
 *   2. git, for a review of committed work: a shared clone at the review's head, the same collectDiff, the same hash.
 * Anything else is unrebuildable, with the reason, never skipped in silence (ISC-10). The reviewed repo is only read:
 * the clone is `--shared` into a temp dir, so the repo's tree, index, refs and worktree list never change (ISC-27).
 *
 * USAGE:
 *   bun ReviewReplay.ts inputs [--json] [--limit N]   every review record: which can be rebuilt, from where, and why not
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invariant } from "./Invariant";
import { collectDiff, EMPTY_TREE, stateDir } from "./Review";
import { receiptDir } from "./lib/ProofReceipt";

/** The fields a rebuild needs, from a review record (full ids) or a STATVS `review` row (12-hex ids, 16-hex fingerprint). */
export interface ReviewRef { repoRoot: string; scope: string; base: string; head: string; dirty: boolean; fingerprint: string; status: string; ts?: string; reusedFrom?: string }

export type Rebuilt =
  | { ok: true; source: "artifact" | "git"; text: string; fingerprint: string }
  | { ok: false; reason: string };

const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const HEX = /^[0-9a-f]+$/;

function gitRun(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

/** A full object id for a short or full one, or null. The empty tree is a tree, not a commit. */
function resolveId(repo: string, id: string): string | null {
  // Only an object id resolves. A ref name (HEAD, main, a tag) would resolve to now and could pull in later commits (ISC-26).
  if (!/^[0-9a-f]{7,40}$/.test(id)) return null;
  if (EMPTY_TREE.startsWith(id)) return EMPTY_TREE;
  const r = gitRun(repo, ["rev-parse", "--verify", "--quiet", `${id}^{commit}`]);
  return r.ok ? r.out.trim() : null;
}

/** Decrypts an age file in-process. The default reads the LifeOS identity from the Keychain (Secrets.ts openSealedFile). */
export type OpenSealed = (path: string) => Uint8Array;
let defaultOpen: OpenSealed | null = null;
const openSealedDefault: OpenSealed = (p) => {
  defaultOpen ??= (require("./Secrets") as { openSealedFile: OpenSealed }).openSealedFile;
  return defaultOpen(p);
};

/**
 * The stored diff whose name starts with this fingerprint (full or 16-hex prefix) and whose bytes hash to it.
 * A diff that carried a secret is kept as `review-<fingerprint>.diff.age` (STATVS migration ISC-88), so for any
 * fingerprint one of the two names exists; the encrypted one is decrypted and held to the same hash (ISC-35).
 */
function storedDiff(fingerprint: string, artifactsDir: string, open: OpenSealed): { text: string; fingerprint: string } | { undecryptable: string } | null {
  if (!HEX.test(fingerprint) || !existsSync(artifactsDir)) return null;
  const prefix = `review-${fingerprint}`;
  const names = fingerprint.length === 64
    ? [`${prefix}.diff`, `${prefix}.diff.age`].filter((n) => existsSync(join(artifactsDir, n)))
    : readdirSync(artifactsDir).filter((n) => n.startsWith(prefix) && (n.endsWith(".diff") || n.endsWith(".diff.age")));
  let undecryptable: string | null = null;
  for (const n of names) {
    const sealed = n.endsWith(".age");
    let buf: Buffer;
    try { buf = sealed ? Buffer.from(open(join(artifactsDir, n))) : readFileSync(join(artifactsDir, n)); } catch (e) { undecryptable = (e as Error).message.slice(0, 120); continue; }
    const h = sha256(buf);
    // The name is only a hint; the bytes must hash to the fingerprint the review recorded.
    if (h.startsWith(fingerprint) && n === `review-${h}.diff${sealed ? ".age" : ""}`) return { text: buf.toString("utf8"), fingerprint: h };
  }
  return undecryptable ? { undecryptable } : null;
}

export function rebuildInput(ref: ReviewRef, opts: { artifactsDir?: string; openSealed?: OpenSealed } = {}): Rebuilt {
  invariant(HEX.test(ref.fingerprint) && ref.fingerprint.length >= 16, "a review ref carries at least a 16-hex fingerprint");
  if (ref.status === "covered") return { ok: false, reason: "covered: no model read it; its input is the covering pass's" };
  const stored = storedDiff(ref.fingerprint, opts.artifactsDir ?? join(receiptDir(), "artifacts"), opts.openSealed ?? openSealedDefault);
  if (stored && "text" in stored) return { ok: true, source: "artifact", ...stored };
  if (stored && ref.dirty) return { ok: false, reason: `stored diff is encrypted and could not be decrypted (${stored.undecryptable})` };
  if (ref.dirty) return { ok: false, reason: "uncommitted work and no stored diff" };
  if (ref.repoRoot.startsWith("[withheld") || ref.scope.startsWith("[withheld")) return { ok: false, reason: "repo path or scope was withheld from the STATVS row; rebuild from the review record" };
  if (!existsSync(join(ref.repoRoot, ".git")) && !gitRun(ref.repoRoot, ["rev-parse", "--git-dir"]).ok) return { ok: false, reason: "repo not on this machine" };
  const head = resolveId(ref.repoRoot, ref.head);
  const base = resolveId(ref.repoRoot, ref.base);
  if (!head) return { ok: false, reason: `head ${ref.head.slice(0, 12)} is not in the repo` };
  if (!base) return { ok: false, reason: `base ${ref.base.slice(0, 12)} is not in the repo` };
  const tmp = mkdtempSync(join(tmpdir(), "review-replay-"));
  try {
    const clone = join(tmp, "repo");
    // --shared reads the repo's objects in place and writes nothing back to it.
    if (!gitRun(tmp, ["clone", "--quiet", "--shared", "--no-checkout", ref.repoRoot, clone]).ok) return { ok: false, reason: "shared clone failed" };
    if (!gitRun(clone, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", head]).ok) return { ok: false, reason: "checkout of head failed" };
    let text: string;
    try { text = collectDiff(clone, ref.scope, base).text; } catch (e) { return { ok: false, reason: `git error: ${(e as Error).message.slice(0, 120)}` }; }
    const h = sha256(text);
    // Git rebuilds only committed state. Uncommitted .gitattributes or repo config outside the scope, or an older diff builder, change the text without making the scope dirty.
    if (!h.startsWith(ref.fingerprint)) return { ok: false, reason: "rebuilt diff does not match the fingerprint (an older diff builder, or uncommitted attributes or config outside the scope at review time)" };
    const diff = { text };
    return { ok: true, source: "git", text: diff.text, fingerprint: h };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Every review record under the review state dir, and the ones that could not be read. */
export function allRecords(): { recs: Array<ReviewRef & { file: string }>; unreadable: Array<{ file: string; reason: string }> } {
  const root = stateDir();
  const recs: Array<ReviewRef & { file: string }> = [];
  const unreadable: Array<{ file: string; reason: string }> = [];
  if (!existsSync(root)) return { recs, unreadable };
  for (const repo of readdirSync(root)) {
    const d = join(root, repo);
    try { if (!statSync(d).isDirectory()) continue; } catch { unreadable.push({ file: repo, reason: "dangling entry in the review state dir" }); continue; }
    for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) {
      try {
        const r = JSON.parse(readFileSync(join(d, f), "utf8")) as ReviewRef;
        recs.push({ repoRoot: r.repoRoot, scope: r.scope, base: r.base, head: r.head, dirty: !!r.dirty, fingerprint: r.fingerprint, status: r.status, ts: r.ts, ...(r.reusedFrom ? { reusedFrom: `${repo}/${String(r.reusedFrom).split("/").pop()}` } : {}), file: `${repo}/${f}` });
      } catch (e) { unreadable.push({ file: `${repo}/${f}`, reason: `unreadable record: ${(e as Error).message.slice(0, 80)}` }); }
    }
  }
  return { recs, unreadable };
}

export function inventory(limit = Infinity): { total: number; bySource: Record<string, number>; unrebuildable: Array<{ file: string; reason: string }> } {
  const bySource: Record<string, number> = {};
  const all = allRecords();
  const unrebuildable: Array<{ file: string; reason: string }> = [...all.unreadable];
  if (all.unreadable.length) bySource.unrebuildable = all.unreadable.length;
  const recs = all.recs.slice(0, limit);
  for (const r of recs) {
    let res: Rebuilt;
    try { res = HEX.test(r.fingerprint ?? "") ? rebuildInput(r) : { ok: false, reason: "record has no fingerprint" }; } catch (e) { res = { ok: false, reason: `error: ${(e as Error).message.slice(0, 120)}` }; }
    if (res.ok) bySource[res.source] = (bySource[res.source] ?? 0) + 1;
    else { bySource.unrebuildable = (bySource.unrebuildable ?? 0) + 1; unrebuildable.push({ file: r.file, reason: res.reason }); }
  }
  return { total: recs.length + all.unreadable.length, bySource, unrebuildable };
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== "inputs") { console.error("usage: bun ReviewReplay.ts inputs [--json] [--limit N]"); process.exit(2); }
  const li = rest.indexOf("--limit");
  const limit = li >= 0 ? Number(rest[li + 1]) : Infinity;
  if (!(limit > 0)) { console.error("--limit takes a positive number"); process.exit(2); }
  const inv = inventory(limit);
  if (rest.includes("--json")) { console.log(JSON.stringify(inv, null, 2)); process.exit(0); }
  console.log(`Review inputs: ${inv.total} records`);
  for (const [k, v] of Object.entries(inv.bySource)) console.log(`  ${k}: ${v}`);
  const reasons: Record<string, number> = {};
  for (const u of inv.unrebuildable) reasons[u.reason] = (reasons[u.reason] ?? 0) + 1;
  for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`    ${v} × ${k}`);
}
