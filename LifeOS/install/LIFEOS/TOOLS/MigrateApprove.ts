#!/usr/bin/env bun
/**
 * @version 1.4.2
 */
// Normalize env path vars Claude Code may inject unexpanded — literal $HOME/${HOME}
// in LIFEOS_DIR/LIFEOS_CONFIG_DIR/PROJECTS_DIR resolves to a shadow dir (#1404 / PR #1451, author jbmml).
for (const __k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const __v = process.env[__k];
  if (__v && /^\$\{?HOME\}?(\/|$)/.test(__v)) process.env[__k] = __v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}


/**
 * MigrateApprove — review and commit proposed migration chunks from external
 * sources. Paired with MigrateScan.ts which enqueues proposals.
 *
 * Each proposal has a proposed_target. the principal can approve (commit as-proposed),
 * modify (change target before commit), skip (drop), or bulk-approve trusted
 * targets.
 *
 * Commits write the chunk content to the target file with a provenance line
 * indicating source_file + source_section + timestamp.
 *
 * Refusals enforced here, not left to the caller:
 *   - UNCLEAR and memory/feedback targets never commit.
 *   - PRINCIPAL_IDENTITY.md and anything under IDEAL_STATE/ are protected: they
 *     commit only through a single-item --approve/--modify that also passes
 *     --confirm-protected <same id>. Bulk commands never write them.
 *   - --approve-all skips proposals under BULK_MIN_CONFIDENCE (0.60) and
 *     leaves them pending for a single-item approve.
 *   - A chunk whose normalized text already appears in the target is skipped
 *     as a duplicate and left pending (reject it with --reject).
 *   - A target with a ".." segment, or one whose nearest existing parent
 *     resolves (symlinks dereferenced) outside LIFEOS_DIR and its USER/MEMORY
 *     data roots (themselves symlinks in the live layout), never commits; the
 *     proposal stays pending.
 *   - Anything not committed stays in the queue; nothing is silently dropped.
 *
 * Usage:
 *   bun MigrateApprove.ts --review                   Show all pending proposals
 *   bun MigrateApprove.ts --summary                  High-level routing summary
 *   bun MigrateApprove.ts --approve <id>             Commit single proposal
 *   bun MigrateApprove.ts --approve <id> --confirm-protected <id>
 *                                                    Commit a proposal targeting a protected file
 *   bun MigrateApprove.ts --modify <id> --target X   Change target then commit
 *   bun MigrateApprove.ts --reject <id>              Drop single proposal
 *   bun MigrateApprove.ts --approve-target <target>  Bulk approve all proposals for target (never protected)
 *   bun MigrateApprove.ts --approve-all              Commit pending proposals at >=60% confidence (never protected)
 *   bun MigrateApprove.ts --reset                    Clear queue (use carefully)
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, readdirSync, realpathSync, statSync, lstatSync } from "fs";
import { TelosLockTimeout, withTelosLock } from "./TelosLock";
import { join, dirname, basename, sep } from "path";
import { homedir } from "node:os";
import { getLifeosDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { bumpMemoryGeneration } from "./MemoryRetriever";
import { invariant } from "./Invariant";

// Normalize env path vars that Claude Code injects without shell expansion (LifeOS#1404)
for (const k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const v = process.env[k];
  if (v && /^\$\{?HOME\}?(\/|$)/.test(v)) process.env[k] = v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}


const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
const LIFEOS_DIR = getLifeosDir();
const QUEUE_FILE = join(LIFEOS_DIR, "MEMORY", "MIGRATION", "migration-proposals.jsonl");
const COMMITTED_LOG = join(LIFEOS_DIR, "MEMORY", "MIGRATION", "committed.jsonl");

/** --approve-all commits nothing below this classification confidence. */
export const BULK_MIN_CONFIDENCE = 0.6;

type Proposal = {
  id: string;
  timestamp: string;
  source_file: string;
  source_section: string;
  content_preview: string;
  content_full: string;
  proposed_target: string;
  classification_confidence: number;
  classification_reasons: string[];
  alternatives: string[];
  status: "pending" | "approved" | "rejected" | "modified";
};

type CommitOutcome =
  | { kind: "committed"; path: string }
  | { kind: "duplicate"; path: string }
  | { kind: "refused"; reason: string };

/**
 * A protected target is load-bearing private context: PRINCIPAL_IDENTITY.md or
 * any path with an IDEAL_STATE segment. Matched case-insensitively on path
 * segments so `TELOS/IDEAL_STATE/HEALTH.md`, `USER/TELOS/ideal_state/x.md` and
 * `USER/PRINCIPAL/PRINCIPAL_IDENTITY.md` all count.
 */
export function isProtectedTarget(target: string): boolean {
  const segs = target.replace(/\\/g, "/").split("/").filter(Boolean).map((s) => s.toUpperCase());
  if (segs.length === 0) return false;
  return segs.includes("IDEAL_STATE") || segs[segs.length - 1] === "PRINCIPAL_IDENTITY.MD";
}

/** Lowercase, collapse all whitespace runs to one space, trim. */
export function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** True when the normalized chunk text appears inside any normalized haystack. */
export function isAlreadyPresent(content: string, haystacks: string[]): boolean {
  const needle = normalizeForDedupe(content);
  if (needle.length === 0) return false;
  return haystacks.some((h) => normalizeForDedupe(h).includes(needle));
}

/**
 * The canonical form of a path that may not exist yet: realpath of its nearest existing ancestor with the
 * missing remainder re-attached. Null when an existing entry cannot be resolved (a dangling or looping link):
 * its real destination is unknown, so it is never judged unprotected.
 */
export function canonicalDestination(p: string): string | null {
  const tail: string[] = [];
  let probe = p;
  for (;;) {
    try { return join(realpathSync(probe), ...[...tail].reverse()); } catch { /* absent or unresolvable */ }
    try { lstatSync(probe); return null; } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
    }
    const up = dirname(probe);
    if (up === probe) return p;
    tail.push(basename(probe));
    probe = up;
  }
}

/**
 * True when the full destination is protected, judged by its lexical path AND its canonical path (nearest
 * existing ancestor dereferenced, missing remainder attached). A new note under a symlink alias of
 * IDEAL_STATE is protected before anything is created. Unresolvable means protected.
 */
export function protectedByPath(targetPath: string): boolean {
  if (isProtectedTarget(targetPath)) return true;
  const canonical = canonicalDestination(targetPath);
  return canonical === null || isProtectedTarget(canonical);
}

function loadQueue(): Proposal[] {
  if (!existsSync(QUEUE_FILE)) return [];
  return readFileSync(QUEUE_FILE, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Proposal);
}

function saveQueue(queue: Proposal[]): void {
  const dir = dirname(QUEUE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(QUEUE_FILE, queue.map((p) => JSON.stringify(p)).join("\n") + (queue.length ? "\n" : ""));
}

function logCommit(entry: Record<string, unknown>): void {
  const dir = dirname(COMMITTED_LOG);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(COMMITTED_LOG, JSON.stringify(entry) + "\n");
}

function resolveTargetPath(target: string): string {
  return join(LIFEOS_DIR, target);
}

/** True when any path segment of the proposed target is "..", on either separator. */
export function hasParentSegment(target: string): boolean {
  return target.split(/[\\/]/).includes("..");
}

/**
 * True when targetPath, after dereferencing symlinks on its nearest existing
 * ancestor, sits at or under realpath(rootDir). A not-yet-existing target is
 * judged by the parent it would be created in.
 */
export function isContainedIn(targetPath: string, rootDir: string): boolean {
  let root: string;
  try {
    root = realpathSync(rootDir);
  } catch {
    return false;
  }
  let probe = targetPath;
  while (!existsSync(probe)) {
    const up = dirname(probe);
    if (up === probe) return false;
    probe = up;
  }
  let real: string;
  try {
    real = realpathSync(probe);
  } catch {
    return false;
  }
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The top-level data roots of the LifeOS tree. In the live layout these are
 * symlinks into the private USER data repo (`LIFEOS/{USER,MEMORY}` →
 * `~/.config/LIFEOS/USER`), so their real paths sit outside realpath(LIFEOS_DIR)
 * and must count as roots of their own.
 */
export const LIFEOS_DATA_ROOTS = ["USER", "MEMORY"] as const;

/**
 * True when targetPath sits inside the LifeOS tree: under LIFEOS_DIR itself or
 * under the real path of one of its data roots (LIFEOS_DATA_ROOTS). Only the
 * top-level data-root links are honored; a symlink nested below any root that
 * points elsewhere is still judged outside.
 */
export function isInLifeosTree(targetPath: string, lifeosDir: string = LIFEOS_DIR): boolean {
  if (isContainedIn(targetPath, lifeosDir)) return true;
  return LIFEOS_DATA_ROOTS.some((name) => {
    const dataRoot = join(lifeosDir, name);
    return existsSync(dataRoot) && isContainedIn(targetPath, dataRoot);
  });
}

/** Every markdown file directly inside a knowledge target dir (its existing notes). */
function knowledgeDirTexts(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readFileSync(join(dir, f), "utf-8"));
}

/**
 * Commit one proposal. `confirmedProtected` is true only when the caller is a
 * single-item command whose --confirm-protected value matched this proposal.
 */
function commitProposal(p: Proposal, confirmedProtected: boolean): CommitOutcome {
  if (p.proposed_target === "UNCLEAR") {
    return { kind: "refused", reason: "Cannot commit UNCLEAR proposal. Use --modify first." };
  }

  if (p.proposed_target === "memory/feedback") {
    return {
      kind: "refused",
      reason:
        "Refusing memory/feedback: harness auto-memory is disabled and a feedback memo is a missed system patch. " +
        "Use --modify to retarget this chunk to a constitutional surface (an operational rule, a hook, a settings permission, " +
        "or a skill's Gotchas) or to MEMORY/KNOWLEDGE/<Domain>.",
    };
  }

  if (normalizeForDedupe(p.content_full ?? "").length === 0) {
    return { kind: "refused", reason: "Proposal has no content to commit. Use --reject." };
  }

  if (hasParentSegment(p.proposed_target)) {
    return { kind: "refused", reason: `Refusing target ${p.proposed_target}: a ".." segment can leave the LifeOS tree. Use --modify with a target under ${LIFEOS_DIR}.` };
  }
  const targetPath = resolveTargetPath(p.proposed_target);
  if (!isInLifeosTree(targetPath)) {
    return { kind: "refused", reason: `Refusing target ${p.proposed_target}: it resolves outside ${LIFEOS_DIR} (a symlinked parent counts). Use --modify with a target inside the tree.` };
  }
  const isProtected = isProtectedTarget(p.proposed_target) || protectedByPath(targetPath);
  if (isProtected && !confirmedProtected) {
    return {
      kind: "refused",
      reason:
        `Refusing protected target ${p.proposed_target}: PRINCIPAL_IDENTITY.md and IDEAL_STATE/ take a per-item yes. ` +
        `After the principal approves this chunk, run: bun MigrateApprove.ts --approve ${p.id.slice(0, 8)} --confirm-protected ${p.id.slice(0, 8)}`,
    };
  }

  const provenance = `\n<!-- migrated ${new Date().toISOString()} from ${p.source_file} :: ${p.source_section} -->\n`;
  const entry = `${provenance}${p.content_full}\n`;

  // Knowledge dir = new file per chunk
  if (p.proposed_target.startsWith("MEMORY/KNOWLEDGE/")) {
    if (isAlreadyPresent(p.content_full, knowledgeDirTexts(targetPath))) {
      return { kind: "duplicate", path: targetPath };
    }
    if (!existsSync(targetPath)) mkdirSync(targetPath, { recursive: true });
    const slug = p.source_section
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase()
      .slice(0, 40);
    const filePath = join(targetPath, `migrated_${slug}_${p.id.slice(0, 8)}.md`);
    const type = p.proposed_target.split("/").pop()?.toLowerCase().replace(/s$/, "") || "idea";
    const content = `---
title: ${p.source_section}
type: ${type}
tags: [migrated]
created: ${new Date().toISOString().slice(0, 10)}
source: "${p.source_file}"
---

${p.content_full}
`;
    invariant(isInLifeosTree(filePath), `knowledge note ${filePath} resolves outside ${LIFEOS_DIR}`);
    invariant(!existsSync(filePath), `knowledge note ${filePath} already exists; a migration commit never overwrites a note`);
    invariant(!protectedByPath(filePath) || confirmedProtected, `protected note ${filePath} reached the write without a per-item confirm`);
    writeFileSync(filePath, content);
    logCommit({ ...p, committed_at: new Date().toISOString(), target_path: filePath });
    bumpMemoryGeneration();
    return { kind: "committed", path: filePath };
  }

  // Regular TELOS / USER files = append
  if (!existsSync(targetPath)) {
    return { kind: "refused", reason: `Target file does not exist: ${targetPath}` };
  }
  // The duplicate check, the read and the append run under the shared TELOS
  // lock, so a concurrent TELOS writer cannot land between them and be lost.
  // A busy lock refuses the chunk loudly and leaves it pending; a batch moves on.
  let appended: boolean;
  try {
    appended = withTelosLock(targetPath, (lock) => {
      const existing = readFileSync(targetPath, "utf-8");
      if (isAlreadyPresent(p.content_full, [existing])) return false;
      invariant(isInLifeosTree(targetPath), `append target ${targetPath} resolves outside ${LIFEOS_DIR}`);
      invariant(!isProtected || confirmedProtected, `protected target ${targetPath} reached the write without a per-item confirm`);
      const next = existing + entry;
      invariant(next.startsWith(existing), "append must preserve the existing target content byte for byte");
      invariant(lock.held(), `lock on ${targetPath} was lost before the append`);
      writeFileSync(targetPath, next);
      return true;
    });
  } catch (err) {
    if (err instanceof TelosLockTimeout) return { kind: "refused", reason: err.message };
    throw err;
  }
  if (!appended) return { kind: "duplicate", path: targetPath };
  logCommit({ ...p, committed_at: new Date().toISOString(), target_path: targetPath });
  bumpMemoryGeneration();
  return { kind: "committed", path: targetPath };
}

function reportOutcome(p: Proposal, o: CommitOutcome): void {
  const short = p.id.slice(0, 8);
  if (o.kind === "committed") console.log(`✅ Committed ${short} to ${o.path}`);
  else if (o.kind === "duplicate")
    console.log(`⏭️  Skipped ${short}: its text already appears in ${o.path}. Left pending; drop it with --reject ${short}.`);
  else console.error(`⛔ ${short}: ${o.reason}`);
}

/** Resolve an id prefix to exactly one pending proposal, or explain why not. */
function findOnePending(queue: Proposal[], id: string | undefined): { idx: number } | { error: string } {
  if (!id || id.startsWith("--")) return { error: "Missing proposal id." };
  const hits = queue.map((p, i) => ({ p, i })).filter(({ p }) => p.id.startsWith(id) && p.status === "pending");
  if (hits.length === 0) return { error: `No pending proposal matching id: ${id}` };
  if (hits.length > 1) return { error: `Id prefix ${id} matches ${hits.length} pending proposals; use a longer prefix.` };
  return { idx: hits[0].i };
}

// ─── Commands ───

function cmdReview(): number {
  const queue = loadQueue();
  const pending = queue.filter((p) => p.status === "pending");
  if (pending.length === 0) {
    console.log("✅ No pending proposals.");
    return 0;
  }
  console.log(`═══ ${pending.length} pending proposals ═══\n`);
  for (const p of pending) {
    const conf = Math.round(p.classification_confidence * 100);
    const icon = p.proposed_target === "UNCLEAR" ? "❓" : isProtectedTarget(p.proposed_target) ? "🔒" : conf >= BULK_MIN_CONFIDENCE * 100 ? "✅" : "⚠️";
    console.log(`${icon}  ${p.id.slice(0, 8)}  →  ${p.proposed_target}  (${conf}%)`);
    console.log(`    Source: ${p.source_file} :: ${p.source_section}`);
    console.log(`    Preview: ${p.content_preview}${p.content_full.length > 160 ? "..." : ""}`);
    if (p.alternatives.length) console.log(`    Alternatives: ${p.alternatives.slice(0, 3).join(", ")}`);
    console.log(``);
  }
  console.log(`Approve: bun MigrateApprove.ts --approve <id>`);
  console.log(`Protected (🔒, after a per-item yes): bun MigrateApprove.ts --approve <id> --confirm-protected <id>`);
  console.log(`Modify:  bun MigrateApprove.ts --modify <id> --target <new_target>`);
  console.log(`Reject:  bun MigrateApprove.ts --reject <id>`);
  console.log(`Bulk:    bun MigrateApprove.ts --approve-target <target>`);
  return 0;
}

function cmdSummary(): number {
  const queue = loadQueue();
  const pending = queue.filter((p) => p.status === "pending");
  const by: Record<string, { count: number; avg_conf: number }> = {};
  for (const p of pending) {
    by[p.proposed_target] = by[p.proposed_target] || { count: 0, avg_conf: 0 };
    by[p.proposed_target].count += 1;
    by[p.proposed_target].avg_conf += p.classification_confidence;
  }
  console.log(`═══ Migration Queue Summary ═══\n`);
  console.log(`Total pending: ${pending.length}\n`);
  for (const [target, { count, avg_conf }] of Object.entries(by).sort((a, b) => b[1].count - a[1].count)) {
    const conf = Math.round((avg_conf / count) * 100);
    console.log(`  ${target.padEnd(38)}  ${String(count).padStart(3)} chunks  (${conf}% avg confidence)`);
  }
  return 0;
}

function cmdApprove(id: string | undefined, confirmProtected: string | undefined): number {
  const queue = loadQueue();
  const found = findOnePending(queue, id);
  if ("error" in found) {
    console.error(found.error);
    return 1;
  }
  const p = queue[found.idx];
  const outcome = commitProposal(p, confirmProtected !== undefined && confirmProtected === id);
  reportOutcome(p, outcome);
  if (outcome.kind !== "committed") return 1;
  queue.splice(found.idx, 1);
  saveQueue(queue);
  return 0;
}

function cmdModify(id: string | undefined, newTarget: string, confirmProtected: string | undefined): number {
  const queue = loadQueue();
  const found = findOnePending(queue, id);
  if ("error" in found) {
    console.error(found.error);
    return 1;
  }
  const p = { ...queue[found.idx], proposed_target: newTarget, status: "modified" as const };
  const outcome = commitProposal(p, confirmProtected !== undefined && confirmProtected === id);
  reportOutcome(p, outcome);
  if (outcome.kind !== "committed") return 1;
  queue.splice(found.idx, 1);
  saveQueue(queue);
  return 0;
}

function cmdReject(id: string | undefined): number {
  const queue = loadQueue();
  const found = findOnePending(queue, id);
  if ("error" in found) {
    console.error(found.error);
    return 1;
  }
  queue.splice(found.idx, 1);
  saveQueue(queue);
  console.log(`🗑️  Rejected ${id}`);
  return 0;
}

/** Commit each candidate; return the ids that committed. Never commits a protected target. */
function commitBatch(candidates: Proposal[]): Set<string> {
  const committed = new Set<string>();
  for (const p of candidates) {
    const outcome = commitProposal(p, false);
    reportOutcome(p, outcome);
    if (outcome.kind === "committed") committed.add(p.id);
  }
  return committed;
}

function cmdApproveTarget(target: string | undefined): number {
  if (!target || target.startsWith("--")) {
    console.error("--approve-target requires <target>");
    return 1;
  }
  if (isProtectedTarget(target)) {
    console.error(
      `⛔ Refusing bulk approve of protected target ${target}: PRINCIPAL_IDENTITY.md and IDEAL_STATE/ commit one chunk at a time ` +
      `with --approve <id> --confirm-protected <id>, after the principal's yes on that chunk.`,
    );
    return 1;
  }
  const queue = loadQueue();
  const matching = queue.filter((p) => p.proposed_target === target && p.status === "pending");
  if (matching.length === 0) {
    console.log(`No pending proposals for target ${target}`);
    return 0;
  }
  console.log(`Committing ${matching.length} proposals for ${target}...`);
  const committed = commitBatch(matching);
  saveQueue(queue.filter((p) => !committed.has(p.id)));
  console.log(`✅ Committed ${committed.size}/${matching.length} proposals for ${target}; ${matching.length - committed.size} left pending`);
  return 0;
}

function cmdApproveAll(): number {
  const queue = loadQueue();
  const pending = queue.filter((p) => p.status === "pending");
  const unclear = pending.filter((p) => p.proposed_target === "UNCLEAR");
  const protectedOnes = pending.filter((p) => p.proposed_target !== "UNCLEAR" && isProtectedTarget(p.proposed_target));
  const lowConf = pending.filter(
    (p) =>
      p.proposed_target !== "UNCLEAR" &&
      !isProtectedTarget(p.proposed_target) &&
      !(Number.isFinite(p.classification_confidence) && p.classification_confidence >= BULK_MIN_CONFIDENCE),
  );
  const skip = new Set([...unclear, ...protectedOnes, ...lowConf].map((p) => p.id));
  const candidates = pending.filter((p) => !skip.has(p.id));

  if (candidates.length === 0 && skip.size === 0) {
    console.log("No pending proposals to bulk-approve.");
    return 0;
  }
  console.log(`Committing ${candidates.length} proposals at ≥${BULK_MIN_CONFIDENCE * 100}% confidence...`);
  const committed = commitBatch(candidates);
  saveQueue(queue.filter((p) => !committed.has(p.id)));

  console.log(`✅ Committed ${committed.size}/${candidates.length}`);
  if (lowConf.length) {
    console.log(`⚠️  Skipped ${lowConf.length} under ${BULK_MIN_CONFIDENCE * 100}% confidence (approve one at a time with --approve <id>):`);
    for (const p of lowConf)
      console.log(`    ${p.id.slice(0, 8)}  →  ${p.proposed_target}  (${Math.round((Number(p.classification_confidence) || 0) * 100)}%)`);
  }
  if (protectedOnes.length) {
    console.log(`🔒 Skipped ${protectedOnes.length} protected (PRINCIPAL_IDENTITY / IDEAL_STATE; per-item --confirm-protected):`);
    for (const p of protectedOnes) console.log(`    ${p.id.slice(0, 8)}  →  ${p.proposed_target}`);
  }
  if (unclear.length) console.log(`❓ ${unclear.length} UNCLEAR left for manual routing`);
  return 0;
}

function cmdReset(): number {
  saveQueue([]);
  console.log("Queue cleared.");
  return 0;
}

// ─── Main ───

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

function main(args: string[]): number {
  const confirmProtected = flagValue(args, "--confirm-protected");
  if (args.includes("--confirm-protected") && (args.includes("--approve-all") || args.includes("--approve-target"))) {
    console.error("--confirm-protected is per-item only: use it with --approve <id> or --modify <id>, never a bulk command.");
    return 1;
  }
  if (args.includes("--review")) return cmdReview();
  if (args.includes("--summary")) return cmdSummary();
  if (args.includes("--approve-all")) return cmdApproveAll();
  if (args.includes("--approve-target")) return cmdApproveTarget(flagValue(args, "--approve-target"));
  if (args.includes("--approve")) return cmdApprove(flagValue(args, "--approve"), confirmProtected);
  if (args.includes("--modify")) {
    const target = flagValue(args, "--target");
    if (!target) {
      console.error("--modify requires --target <new_target>");
      return 1;
    }
    return cmdModify(flagValue(args, "--modify"), target, confirmProtected);
  }
  if (args.includes("--reject")) return cmdReject(flagValue(args, "--reject"));
  if (args.includes("--reset")) return cmdReset();
  console.log("Usage:");
  console.log("  bun MigrateApprove.ts --review");
  console.log("  bun MigrateApprove.ts --summary");
  console.log("  bun MigrateApprove.ts --approve <id> [--confirm-protected <id>]");
  console.log("  bun MigrateApprove.ts --modify <id> --target <new> [--confirm-protected <id>]");
  console.log("  bun MigrateApprove.ts --reject <id>");
  console.log("  bun MigrateApprove.ts --approve-target <target>");
  console.log("  bun MigrateApprove.ts --approve-all");
  console.log("  bun MigrateApprove.ts --reset");
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
