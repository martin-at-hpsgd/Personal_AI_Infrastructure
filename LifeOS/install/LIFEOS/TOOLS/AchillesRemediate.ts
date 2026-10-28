#!/usr/bin/env bun
/**
 * AchillesRemediate — the nightly fix-preparer for `agent`-class entries.
 *
 * The loop before this file: a weakness is found, registered, ticketed — and
 * then waits for a human who never comes (critical and high entries sat for
 * days, 2026-09-15). This job closes that gap for the class of entry
 * a worker can fix on its own: for every OPEN entry with `fix_class: agent`
 * it dispatches a codex worker (OpenAI lane, off the Anthropic subscription)
 * into a throwaway shared clone of the repo the entry belongs to, lets it fix
 * and test there, captures the diff as a PATCH ARTIFACT, and records the
 * result on the entry and its work-repo issue.
 *
 * Landing (2026-10-03, ISC-33/41/65): a ready patch for the LifeOS install
 * itself is landed on main by this job with no human step, only through
 * `applyPatch({ unattended: true })`, which refuses gate paths, a foreign
 * index, and a blocked or missing independent review, and commits only after
 * the scoped tests pass. A project-repo patch is NEVER applied here: it becomes
 * a "y ACH-NNNN" ask in the pass text, and the principal's "y" lands and ships
 * it. Nothing is deployed or pushed by this job.
 *
 * Escalation (ISC-30/43/46/69/70): blocked, needs_repo, false_positive, two
 * unresolved attempts, or a human-class open critical/high → fix_class human plus an evidence line, and
 * one new batched text per pass (Problem/Pick/Reply, under 400 characters as Vigil
 * delivers it), plus retries of earlier frozen texts. Each text's identity and
 * wording are saved before emission. Delivery is read back from
 * Vigil's notification rows and an undelivered text (failed, held, or silent)
 * is resent on the next pass, quiet hours included: quiet hours are Vigil's to
 * apply. Every copy of one escalation carries one story key (meta.key), so the
 * morning queue shows a night of held resends as one item, and delivery is
 * credited by that key (ISC-68): a `sent` row on any copy, or a later copy held
 * as "already texted", means the words reached him. A copy is resent for
 * silence only after the tick has run past it, so a tick outage never stacks
 * copies that a recovered tick would send together (ISC-31). An entry that
 * closes before its text is delivered drops out of the queue and the ping (ISC-51).
 *
 * Every run but a --dry-run leaves one Vigil line with its counts (ISC-61); a
 * run that throws leaves one high line naming the error and still exits
 * non-zero (ISC-67).
 *
 * Why a shared clone and a patch, not a branch: `~/.claude` commits directly
 * to main with no branches or worktrees (OPERATIONAL_PREFERENCES § Repo conventions),
 * and a worker writing into a live tree that other sessions share is the
 * 2026-09-10 incident (a builder reverted a peer's uncommitted files). The
 * clone is deleted after the diff is captured; the patch is the only artifact.
 *
 * Repo resolution: entries whose `affected` names a served domain map to the
 * PROJECTS.md row that serves it (path column); LifeOS-side sources (socrates,
 * atlas) map to the LifeOS install itself. Unresolvable → `needs_repo`, shown
 * to the principal, never guessed.
 *
 *   bun AchillesRemediate.ts [--dry-run] [--only ACH-0001] [--max 3] [--json] [--urgent]
 *   bun AchillesRemediate.ts --acceptance ACH-0001,ACH-0002   # exit 0 when each is closed, landed, patched, or escalated and delivered
 *   bun Achilles.ts apply <id>            # the principal's "y": lands a ready patch (main, tests, commit)
 *
 * State: LIFEOS/USER/SECURITY/ACHILLES/remediation.json (attempts per entry,
 * 24h cool-down). Patches: LIFEOS/MEMORY/ACHILLES/patches/<id>-<ts>.diff plus a
 * <id>-<ts>.report.md (the worker's report). Headless: never voice-notifies.
 *
 * @version 1.3.7
 */
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { getClaudeDir } from "./Paths";
import { invariant } from "./Invariant";
import { applyPatch, loadRegistry, registryPath, updateEntry, workIssueOf, type AchillesEntry, type ApplyOptions, type ApplyResult, type RefusalReason } from "./Achilles";
import { loadVigilEmit, vigilStatePath, type VigilEvent } from "./lib/VigilOptional";
import { runSandboxed, sandboxProfile, SANDBOX_UNAVAILABLE_CODE, type SandboxRunResult } from "./lib/Sandbox";

const CLAUDE = getClaudeDir();
const REGISTRY = registryPath();
const STATE = join(CLAUDE, "LIFEOS/USER/SECURITY/ACHILLES/remediation.json");
const PATCH_DIR = join(CLAUDE, "LIFEOS/MEMORY/ACHILLES/patches");
const PROJECTS_MD = join(CLAUDE, "LIFEOS/USER/PROJECTS.md");
const CODEX = join(CLAUDE, "LIFEOS/TOOLS/CodexProgress.ts");
export const COOLDOWN_MS = 24 * 3_600_000;
export const DEFAULT_MAX = 3;
export const WORKER_TIMEOUT_MS = 15 * 60_000;
/** Every Achilles text stays under this many characters (ISC-47); what does not fit waits for the next pass and the morning ping. */
export const TEXT_MAX = 400;
/** A text with no Vigil delivery row after this long counts as undelivered and is resent (ISC-50). */
export const DELIVERY_GRACE_MS = 30 * 60_000;
/** A lock older than this belongs to a dead run (the job's own timeout is one hour). */
export const LOCK_STALE_MS = 2 * 3_600_000;
export const URGENT_WINDOW_MS = 24 * 3_600_000;
const RUN_HISTORY = 10;

export type Outcome = "patch" | "no_change" | "false_positive" | "blocked" | "needs_repo" | "worker_failed" | "tests_failed" | "already_fixed";
/** `proof` and `commit` are set on an already_fixed attempt: the worker's proof command the loop re-ran green, and the fixing commit it named. */
export interface Attempt { at: string; outcome: Outcome; patch?: string; report?: string; repo?: string; note?: string; proof?: string; commit?: string }
/** An already-fixed close ask unanswered this long returns its entry to the queue (ISC-98). */
export const CLOSE_ASK_TTL_MS = 7 * 86_400_000;
/**
 * Why an entry went to the principal. Escalations: the four worker outcomes, plus a ready install patch the lander
 * refused for a reason that will not clear by itself (a reviewer blocker, a gate path, a patch that no longer lands).
 * Y asks (a ready patch the principal can land with one word): a project patch, and an install patch held by a refusal that may
 * clear by itself (a peer's staged or dirty files, the reviewer unreachable). ISA decision 2026-10-04.
 */
export type EscalationReason = "blocked" | "needs_repo" | "two_failures" | "two_unresolved" | "false_positive" | "human_class" | "review_blocked" | "gate_path" | "land_failed" | "project_patch" | "land_refused" | "review_unavailable" | "already_fixed";
/** The reasons that are y asks, never escalations. An already_fixed ask's "y" closes the entry (ISC-84). */
export const Y_ASK_REASONS: ReadonlySet<EscalationReason> = new Set(["project_patch", "land_refused", "review_unavailable", "already_fixed"]);
export interface EscalationRecord {
  id: string;
  kind: "escalation" | "y_ask";
  reason: EscalationReason;
  /** The pass that registered it; the pass that last texted it sets `event`. */
  pass: string;
  at: string;
  /** Vigil event id of the text that carries it; absent until a text is emitted (overflow, or the emit failed). */
  event?: string;
  sent_at?: string;
  text_hash: string;
  /** Story keys of every text that carried this escalation; a Vigil `sent` row on any of them delivers it (ISC-68). */
  keys?: string[];
  /** Vigil event ids of every intended copy, saved before emission, newest last. */
  events?: string[];
  delivered: boolean;
  decision?: string;
  /** Set when the entry closed (or left the registry) before any text about it was delivered: nothing is left to tell. */
  dropped?: "entry_closed";
  /** A medium or low escalation or y ask is never texted (ISC-86): a sent morning ping that listed it delivers it (ISC-99). */
  via?: "ping";
}
export interface RunSummary { at: string; pass: string; attempts: number; patches: number; escalations: number }
/** Frozen intent (ISC-72/74). Only the list of intended copy ids grows on retries; the original event and membership stay fixed. */
export interface EscalationText {
  key: string;
  event: VigilEvent;
  entries: Array<Pick<EscalationRecord, "id" | "kind" | "at">>;
  events: string[];
  /** Obsolete membership is retained for delivery reconciliation, but never resent. `merged`: a new escalation joined it in one replacement text (ISC-95). */
  cancelled?: "entry_closed" | "member_mismatch" | "merged";
}
export interface RemediationState { version: 1; attempts: Record<string, Attempt[]>; escalations?: EscalationRecord[]; texts?: EscalationText[]; runs?: RunSummary[] }

export function loadState(path = STATE): RemediationState {
  if (!existsSync(path)) return { version: 1, attempts: {} };
  const st = JSON.parse(readFileSync(path, "utf8")) as RemediationState;
  invariant(!(st.escalations?.length) || Array.isArray(st.texts), "escalation records require frozen texts");
  for (const r of st.escalations ?? []) {
    invariant(!(r.event || r.events?.length) || st.texts!.some((t) => t.entries.some((e) => sameEscalation(e, r))), `${r.id}: escalation records require frozen texts`);
  }
  return st;
}

const sameEscalation = (a: Pick<EscalationRecord, "id" | "kind" | "at">, b: Pick<EscalationRecord, "id" | "kind" | "at">) =>
  a.id === b.id && a.kind === b.kind && a.at === b.at;

function assertOneLiveText(st: RemediationState): void {
  for (const r of st.escalations ?? []) {
    const live = (st.texts ?? []).filter((t) => !t.cancelled && t.entries.some((e) => sameEscalation(e, r)));
    invariant(live.length <= 1, `${r.id}: one live text per escalation`);
  }
}
export function saveState(st: RemediationState, path = STATE): void {
  invariant(st.version === 1, "remediation state version must be 1");
  for (const [id, list] of Object.entries(st.attempts)) invariant(/^ACH-\d{4}$/.test(id) && Array.isArray(list), `bad attempt key ${id}`);
  for (const r of st.escalations ?? []) {
    invariant(/^ACH-\d{4}$/.test(r.id) && typeof r.delivered === "boolean" && r.text_hash.length > 0, `bad escalation record ${r.id}`);
    invariant(!r.delivered || !!r.event || r.via === "ping", `${r.id}: a delivered escalation names the event or the ping that carried it`);
    invariant(r.via === undefined || r.via === "ping" && r.delivered, `${r.id}: only a delivered record names the ping that delivered it`);
    invariant(!(r.delivered && r.dropped), `${r.id}: a delivered escalation is never dropped`);
  }
  const keys = (st.escalations ?? []).map((r) => `${r.id}:${r.kind}`);
  invariant(keys.length === new Set(keys).size, "one escalation record per entry and kind");
  for (const t of st.texts ?? []) {
    invariant(t.key.length > 0 && t.event.meta?.key === t.key && t.events.includes(t.event.id), "a frozen text retains its key and original event id");
    invariant(t.entries.length > 0 && t.entries.every((r) => /^ACH-\d{4}$/.test(r.id) && ["escalation", "y_ask"].includes(r.kind) && Number.isFinite(Date.parse(r.at))), "a frozen text names its escalation identities");
    invariant(t.events.every((id) => typeof id === "string" && id.length > 0) && t.events.length === new Set(t.events).size, "a frozen text retains every copy id exactly once");
    invariant(t.cancelled === undefined || t.cancelled === "entry_closed" || t.cancelled === "member_mismatch" || t.cancelled === "merged", "a cancelled text names why it was replaced");
    invariant(vigilTextBody(t.event.severity, t.event.title, t.event.summary).length < TEXT_MAX, "a frozen text stays under TEXT_MAX");
    invariant(t.event.severity === "high" || t.event.severity === "critical", "an Achilles text is emitted at high or critical");
  }
  invariant((st.texts ?? []).length === new Set((st.texts ?? []).map((t) => t.key)).size, "each frozen text has its own stable key");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(st, null, 2) + "\n");
  renameSync(tmp, path);
}

const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const isOpen = (e: AchillesEntry) => e.status === "open" || e.status === "in_progress";
const isUrgentSeverity = (e: AchillesEntry) => e.severity === "critical" || e.severity === "high";
/** An already-fixed close ask is open from its attempt until the principal answers it or seven days pass (ISC-85, ISC-98). */
export const openCloseAsk = (a: Attempt | undefined, now: number): boolean => a?.outcome === "already_fixed" && now - Date.parse(a.at) < CLOSE_ASK_TTL_MS;
const bySeverityThenAge = (a: AchillesEntry, b: AchillesEntry) => (SEV_RANK[a.severity]! - SEV_RANK[b.severity]!) || a.first_seen.localeCompare(b.first_seen) || a.id.localeCompare(b.id);
/** Two entries are the same weakness when their titles match after case, punctuation and spacing are dropped, and they name the same affected set. */
export const dedupeKey = (e: Pick<AchillesEntry, "title" | "affected">): string =>
  `${e.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}|${[...e.affected].map((a) => a.toLowerCase()).sort().join(",")}`;
/** Open entries that duplicate an older open entry (ISC-60): only the oldest of each group is ever dispatched or texted. */
export function duplicateIds(entries: AchillesEntry[]): Set<string> {
  const oldest = new Map<string, AchillesEntry>();
  for (const e of entries.filter(isOpen).sort((a, b) => a.first_seen.localeCompare(b.first_seen) || a.id.localeCompare(b.id))) if (!oldest.has(dedupeKey(e))) oldest.set(dedupeKey(e), e);
  return new Set(entries.filter((e) => isOpen(e) && oldest.get(dedupeKey(e))?.id !== e.id).map((e) => e.id));
}
/** An urgent pass (ISC-53) works only critical and high entries first seen in the last 24 hours. */
export const inUrgentWindow = (e: AchillesEntry, now: number): boolean => isUrgentSeverity(e) && now - Date.parse(e.first_seen) <= URGENT_WINDOW_MS;

/**
 * Which open entries the runner takes this pass: agent class, not a duplicate, not in cool-down,
 * no patch waiting, severity first and oldest within a severity (ISC-27, ISC-37), capped.
 */
export function selectEntries(entries: AchillesEntry[], st: RemediationState, now = Date.now(), max = DEFAULT_MAX, o: { urgent?: boolean } = {}): AchillesEntry[] {
  const dupes = duplicateIds(entries);
  return entries
    .filter((e) => isOpen(e) && e.fix_class === "agent" && !dupes.has(e.id))
    .filter((e) => !o.urgent || inUrgentWindow(e, now))
    .filter((e) => {
      const last = (st.attempts[e.id] ?? []).slice(-1)[0];
      if (!last) return true;
      if (last.outcome === "patch") return false; // a patch is waiting; do not pile a second one on
      if (last.outcome === "already_fixed") return !openCloseAsk(last, now); // a close ask is waiting on the principal (ISC-85); unanswered for 7 days, it is worked again (ISC-98)
      return now - Date.parse(last.at) >= COOLDOWN_MS;
    })
    .sort(bySeverityThenAge)
    .slice(0, max);
}

/**
 * The repo an entry's fix lives in. Served-domain entries → the PROJECTS.md row
 * whose URL cell names the domain (its path column). LifeOS-side sources → the
 * install. Anything else is `null`: never guess a repo for a worker.
 */
export function resolveRepo(e: Pick<AchillesEntry, "source" | "affected" | "source_ref">, projectsMd: string, claudeDir = CLAUDE, home = process.env.HOME ?? ""): string | null {
  const domains = e.affected.filter((a) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(a));
  const names = new Set(e.affected.map((a) => a.trim().toLowerCase()).filter(Boolean));
  for (const line of projectsMd.split("\n")) {
    if (!line.startsWith("| **")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const urlCell = cells[3] ?? "";
    // ISC-28: a project NAME in `affected` matches the row whose first cell names it, case-insensitively.
    const rowName = (cells[1] ?? "").match(/^\*\*([^*]+)\*\*/)?.[1]?.trim().toLowerCase() ?? "";
    if (!domains.some((d) => urlCell.includes(d)) && !(rowName && names.has(rowName))) continue;
    const m = (cells[2] ?? "").match(/`(~\/[^`]+|\/[^`]+)`/);
    if (m) return m[1]!.replace(/^~/, home);
  }
  if (e.source === "socrates" || e.source === "atlas") return claudeDir;
  return null;
}

/** The brief is the ideal state, not a procedure: what done looks like, the constraints, the report shape. */
export function buildBrief(e: AchillesEntry, repo: string): string {
  return [
    `You are fixing one registered weakness in the repository at ${repo} (a throwaway clone; you may edit freely).`,
    "",
    "## The entry",
    "```json",
    JSON.stringify({ id: e.id, title: e.title, description: e.description, severity: e.severity, source: e.source, source_ref: e.source_ref, affected: e.affected, cves: e.cves, evidence: e.evidence, links: e.links }, null, 2),
    "```",
    "",
    "## Done looks like",
    "- The condition the entry describes can no longer be observed, and you can name the command or probe that proves it.",
    "- Every behavior you changed has a test next to the existing tests, and the repo's own test command passes (find it in package.json, an ISA.md Test Strategy, or bunker.isa.md).",
    "- The diff is the smallest change that removes the cause. No drive-by refactors, no formatting churn, no new dependencies.",
    "",
    "## Constraints (never cross)",
    "- A verdict of already_fixed means the condition is already gone at this HEAD and you changed nothing: an EMPTY diff, a PROOF line that is one command the loop can re-run here (no shell operators, no pipes), and a FIXED-BY line naming the commit that fixed it when you can find it.",
    "- A verdict of blocked or false_positive means an EMPTY diff: if the cause lives outside this repo (a cloud index, a credential, a dashboard) or the finding is wrong, change nothing and say so. Softening an exit code, a check, or a test so the symptom disappears is never a fix.",
    "- TypeScript and bun only. Never npm, npx, python, perl, ruby.",
    "- Never deploy, push, commit, tag, or touch secrets, .env, wrangler secrets, or anything under LIFEOS/USER other than the file the entry names.",
    "- Never weaken a gate, guard, hook, test, or scanner check to make the finding go away. If the finding is a false positive, say so in the report and change nothing.",
    "- Never delete files you did not create.",
    "",
    "## Report (your final message, exactly this shape)",
    "## WORKER REPORT",
    "### VERDICT: fixed | already_fixed | false_positive | blocked",
    "### CHANGES: one line per file",
    "### PROOF: the command you ran, on this line; its last lines below",
    "### FIXED-BY: the fixing commit's sha (already_fixed only), or none",
    "### OPEN: anything a human must still do (deploy, credential, decision), or none",
    "### CO-AUTHOR: <model id> <noreply@vendor>",
  ].join("\n");
}

/**
 * One command's outcome. `terminated` says why the process did not run to its own exit (a signal, a timeout kill,
 * a spawn error, a sandbox that never ran): its exit code is then the runner's stand-in, not the program's (S079).
 */
export type SpawnResult = { code: number; out: string; err: string; terminated?: string };
/** Every command the loop runs goes through one of these, so a test can record each argv (ISC-35). */
export type SpawnFn = (argv: string[], cwd?: string, input?: string) => SpawnResult;
export type WorkerFn = (brief: string, clone: string, slug: string) => { code: number; final: string; err: string };

export const sh: SpawnFn = (argv, cwd, input) => {
  const p = spawnSync(argv[0]!, argv.slice(1), { cwd, input, encoding: "utf8", env: { ...process.env, LIFEOS_NOTIFICATION_CHANNEL: "headless", ACHILLES_ACTOR: "loop" }, maxBuffer: 64 * 1024 * 1024 });
  const terminated = p.signal ? `killed by ${p.signal}` : p.error ? String(p.error) : undefined;
  return { code: p.status ?? 1, out: p.stdout ?? "", err: p.stderr ?? "", ...(terminated ? { terminated } : {}) };
};

/**
 * The line lib/Sandbox.ts runSandboxed appends as the last line of `err` when the child was killed (a signal or its
 * timeout) or could not be spawned. Its result carries no structured field for this, so spawnResultOfSandboxRun is
 * the one place its contract is read; nothing reads child output for termination anywhere else (S079 round 2).
 */
const SANDBOX_TERMINATION_LINE = /^(killed by SIG[A-Z0-9]+\b.*|\w*Error: spawnSync\b.*)$/;

/**
 * A sandbox run as a SpawnResult. The runner reports a kill or a spawn error with a non-zero code (a signal's null
 * status becomes 1, a zero status with an error becomes 1) and its own line appended last, so a run that exits 0 is
 * one the child finished, whatever it printed. A non-zero run whose last stderr line is the runner's line is taken
 * as terminated: a child that prints that line itself and then exits non-zero is refused as well, which only ever
 * refuses a run that was already red. A sandbox that never ran is terminated.
 */
export function spawnResultOfSandboxRun(r: SandboxRunResult): SpawnResult {
  const last = r.err.trimEnd().split("\n").at(-1)?.trim() ?? "";
  const terminated = !r.ran ? "the sandbox did not run" : r.code !== 0 && SANDBOX_TERMINATION_LINE.test(last) ? last : undefined;
  return { code: r.code, out: r.out, err: r.err, ...(terminated ? { terminated } : {}) };
}

/** Why a run did not finish on its own, or undefined when it did. Only the runner's structured field says so. */
export function terminationOf(r: SpawnResult): string | undefined {
  return r.terminated;
}

/**
 * Environment variables worker-made code may see. Everything else in the parent environment (API keys, tokens,
 * session ids, anything a launchd job was handed) stays out: a test the worker wrote runs with only what a build
 * needs. Names are exact, so a new secret-bearing variable is excluded by default.
 */
const SANDBOX_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "BUN_INSTALL", "BUN_TMPDIR", "CI"];
export function sandboxEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { LIFEOS_NOTIFICATION_CHANNEL: "headless", ACHILLES_ACTOR: "loop" };
  for (const k of SANDBOX_ENV_KEYS) if (typeof base[k] === "string") env[k] = base[k]!;
  return env;
}

/**
 * The Seatbelt profile and runner live in lib/Sandbox.ts, shared with IscTier's unratified probes.
 * Re-exported here so the lander's callers and tests keep their names.
 */
export { sandboxProfile, SANDBOX_UNAVAILABLE_CODE };
export interface SandboxedSpawnOptions {
  /** Platform seam; defaults to process.platform. Only darwin has a confinement backend. */
  platform?: NodeJS.Platform;
  /** Sandbox binary seam; defaults to /usr/bin/sandbox-exec. */
  sandboxExec?: string;
  /** Existence seam for the sandbox binary; defaults to fs.existsSync. */
  exists?: (path: string) => boolean;
  /** Kill the run (SIGKILL) after this many ms; the run then reports failure. Unset means unbounded (the caller owns the clock). */
  timeoutMs?: number;
  /** Working directory used when the caller passes none. */
  defaultCwd?: string;
}
/**
 * Build the spawn seam for everything the worker's code can influence: its tests (judgeTests), its proof command,
 * and the lander's test run. Runs carry a scrubbed environment inside a Seatbelt sandbox (no external network,
 * writes only under the temp roots and the bun cache, no reads of keys or any .env file). Where the sandbox cannot
 * be applied (not macOS, or sandbox-exec missing) nothing runs and the result is a failure: never fails open.
 */
export function makeSandboxedSpawn(o: SandboxedSpawnOptions = {}): SpawnFn {
  return (argv, cwd, input) => {
    return spawnResultOfSandboxRun(runSandboxed(argv, { platform: o.platform, sandboxExec: o.sandboxExec, exists: o.exists, timeoutMs: o.timeoutMs, cwd: cwd ?? o.defaultCwd, input, env: sandboxEnv() }));
  };
}
export const shSandboxed: SpawnFn = makeSandboxedSpawn();

/** A throwaway shared clone at HEAD: the worker writes here and nowhere else. A failed clone is an attempt outcome, not a crash. */
export function makeClone(repo: string, scratch: string, spawn: SpawnFn = sh): { ok: true; path: string } | { ok: false; err: string } {
  rmSync(scratch, { recursive: true, force: true });
  const c = spawn(["git", "clone", "--shared", "--quiet", repo, scratch]);
  return c.code === 0 ? { ok: true, path: scratch } : { ok: false, err: `clone failed: ${(c.err || c.out).trim().slice(0, 200)}` };
}

export function runWorker(brief: string, clone: string, slug: string, timeoutMs = WORKER_TIMEOUT_MS, spawn: SpawnFn = sh): { code: number; final: string; err: string } {
  const r = spawn([process.execPath, CODEX, "--slug", slug, "--agent", "Sol", "--lane", "sol", "--reasoning-effort", "low", "--sandbox", "workspace-write", "--codex-home", "isolated", "--timeout-ms", String(timeoutMs)], clone, brief);
  return { code: r.code, final: r.out, err: r.err };
}

export function captureDiff(clone: string, spawn: SpawnFn = sh): string {
  spawn(["git", "add", "-A"], clone); // stage new files so they appear in the diff; the clone is discarded anyway
  return spawn(["git", "diff", "--cached", "--binary"], clone).out;
}

/**
 * Directories a unified diff touches, deduped in first-seen order: new sides (`+++ b/`), old sides
 * (`--- a/`, so a delete-only patch is scoped), both ends of a rename (ISC-63), and both paths of every
 * `diff --git` header, the only path a mode-only change or a binary patch carries.
 */
export function touchedDirs(diff: string): string[] {
  const dirs = new Set<string>();
  const add = (path: string) => { const parts = path.split("/"); parts.pop(); dirs.add(parts.length ? parts.join("/") : "."); };
  for (const line of diff.split("\n")) {
    const header = line.match(/^diff --git a\/(\S+) b\/(\S+)$/);
    if (header) { add(header[1]!); add(header[2]!); continue; }
    const side = line.match(/^(?:\+\+\+ b\/|--- a\/|rename from |rename to )(.+)$/);
    if (side) add(side[1]!);
  }
  return [...dirs];
}

/**
 * The test command that judges a patch. A project repo runs its own `test`
 * script. The LifeOS install is hundreds of test files with live-state suites that fail
 * for reasons outside any patch (the first live run, 2026-09-15, hit many foreign fails),
 * so there the judgment is scoped to the directories the diff touched — the
 * same rule a human applies by hand.
 */
export function testCommand(repo: string, diff: string, installDir = CLAUDE): string[] {
  if (repo === installDir) {
    const dirs = touchedDirs(diff).filter((d) => d !== ".").map((d) => `./${d}`);
    return dirs.length ? ["bun", "test", ...dirs] : ["bun", "test", "./"];
  }
  const pkg = join(repo, "package.json");
  if (existsSync(pkg)) {
    const j = JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> };
    const scripts = j.scripts ?? {};
    if (scripts.test) return plainBunTest(scripts) ?? ["bun", "run", "test"];
  }
  return ["bun", "test", "./"];
}

/**
 * A project's `test` script as a direct `bun test` argv, so judgeTests can ask it for a named
 * report and compare it against the unpatched tree (ISC-90). Only a script that is exactly
 * `bun test` plus repo-relative paths and `--name=value` flags qualifies; anything a shell would
 * interpret, a bare flag whose value might be the next word, a name filter (judgeTests adds its
 * own on the re-run), or a pre/post hook keeps `bun run test`, judged by exit code.
 */
function plainBunTest(scripts: Record<string, string>): string[] | null {
  if (scripts.pretest || scripts.posttest) return null;
  const words = scripts.test!.trim().split(/\s+/);
  if (words[0] !== "bun" || words[1] !== "test") return null;
  const args: string[] = [];
  for (const w of words.slice(2)) {
    if (/[&|;<>$`'"(){}*?[\]\\~!#]/.test(w)) return null;
    if (w.startsWith("-")) {
      if (!/^--[a-z][a-z0-9-]*=\S+$/.test(w) || /^--test-name-pattern=/.test(w)) return null;
      args.push(w);
      continue;
    }
    const rel = w.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (rel === "" || rel === ".") { args.push("./"); continue; }
    if (rel.startsWith("/") || rel.split("/").includes("..")) return null;
    args.push(`./${rel}`);
  }
  return ["bun", "test", ...args];
}

// ---------- test judgment (F11) ----------
// A patch is judged against the tree it changes, never by a bare exit code: the same scoped
// command runs on a clean clone at the unpatched HEAD and on the patched tree, and the two
// runs are compared test by test. A directory whose unrelated tests were already red no
// longer blocks every patch to it (2026-10-04), and a patch that deletes or
// skips a passing test can no longer pass by making the run quieter.

export type TestStatus = "passed" | "failed" | "skipped";
/** One named test's result. `name` is the full name `bun test -t` matches (describe chain and test, space-joined); empty for a file's own row. */
export interface TestResult { status: TestStatus; file: string; name: string }
/** Every named test of one run, or null when the run left nothing readable. */
export type TestReport = Map<string, TestResult> | null;
/** The row that stands for a file itself: red when the file fails to load or throws between tests. */
export const FILE_ROW = "(file)";

export interface TestJudgment {
  ok: boolean;
  /** "named" compares test by test; "exit_code" judges a command that cannot be asked for a named report; "unavailable" means no trustworthy baseline could be obtained, which always refuses the patch. */
  mode: "named" | "exit_code" | "unavailable";
  argv: string[];
  /** Tests still red, skipped or gone after the one re-run that a baseline-green or new test should not be. */
  newlyFailing: string[];
  /** Newly failing tests that passed on their one re-run. */
  flaky: string[];
  /** Tests already red on the unpatched tree; a patch is not refused for them. */
  baselineRed: string[];
  note: string;
}

export interface JudgeOptions {
  /** The scoped command from testCommand(). */
  argv: string[];
  /** A git repo whose HEAD is the unpatched tree. It is cloned and the clone is judged; the repo's own working tree is never run. */
  baselineRepo: string;
  /** The tree with the patch applied. */
  patchedDir: string;
  /** Every git and bun command goes through this, so a test can record or time-bound each one. */
  run?: SpawnFn;
  /**
   * The live tree whose ignored `node_modules` the judged trees borrow (by symlink): the baseline
   * clone always, and the patched tree too when it is not this live tree. A clone has no
   * dependencies, so without them a test that imports a package is red at load on both sides,
   * counts as already red, and a patch that breaks it is excused (ISC-102). Both callers set it:
   * the lander to its live repo, the preparer to the repo its worker's clone came from.
   */
  linkDepsFrom?: string;
}

const XML_ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (s: string): string => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent: string) => {
  if (ent[0] === "#") return String.fromCodePoint(ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10));
  return XML_ENTITY[ent.toLowerCase()] ?? m;
});
const attr = (attrs: string, key: string): string => unxml(new RegExp(`\\s${key}="([^"]*)"`).exec(attrs)?.[1] ?? "");

/**
 * `bun test --reporter=junit` output to named results. A test's key is its file, describe chain and
 * name joined by " > "; a repeated name in the same place gets " #2", " #3" in run order. Every file
 * in the report also gets a green FILE_ROW, which parseTestRun turns red for a file-level error.
 */
export function parseJunit(xml: string): Map<string, TestResult> {
  const out = new Map<string, TestResult>();
  const seen = new Map<string, number>();
  const suites: string[] = [];
  let open: { key: string; result: TestResult } | null = null;
  const commit = (key: string, result: TestResult) => {
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    out.set(n === 1 ? key : `${key} #${n}`, result);
  };
  for (const m of xml.matchAll(/<(\/?)(testsuite|testcase|failure|error|skipped)\b([^>]*?)(\/?)>/g)) {
    const [, close, tag, attrs, selfClose] = m as unknown as [string, string, string, string, string];
    if (tag === "testsuite") {
      if (close) suites.pop();
      else if (!selfClose) suites.push(attr(attrs, "name"));
      continue;
    }
    if (tag === "testcase") {
      if (close) { if (open) commit(open.key, open.result); open = null; continue; }
      const file = attr(attrs, "file") || suites[0] || "";
      const chain = [...suites.slice(1), attr(attrs, "name")];
      out.set(`${file} > ${FILE_ROW}`, { status: "passed", file, name: "" });
      const row = { key: `${file} > ${chain.join(" > ")}`, result: { status: "passed" as TestStatus, file, name: chain.join(" ") } };
      if (selfClose) commit(row.key, row.result);
      else open = row;
      continue;
    }
    if (open && !close) open.result.status = tag === "skipped" ? "skipped" : "failed";
  }
  return out;
}

/**
 * Files bun reports an error for outside any test: a file that throws while loading never
 * reaches the junit report at all, so its "# Unhandled error between tests" block in the
 * console output, under the file's header line, is the only place it shows.
 */
export function fileErrors(output: string): string[] {
  const out = new Set<string>();
  let current = "";
  for (const line of output.split("\n")) {
    const header = /^(\S.*?):$/.exec(line);
    if (header && /(test|spec)/i.test(header[1]!) && !/^(error|warning|note)\b/i.test(header[1]!)) { current = header[1]!; continue; }
    if (current && /^# Unhandled error between tests/.test(line)) out.add(current);
  }
  return [...out];
}

/** One run's report: the junit file plus file-level errors; an empty map when bun ran and matched nothing; null when nothing is readable. */
export function parseTestRun(xml: string | null, output: string): TestReport {
  let report: Map<string, TestResult>;
  if (xml !== null) report = parseJunit(xml);
  else if (/\bRan \d+ tests? across \d+ files?\b|had no matches|did not match any test files/.test(output)) report = new Map();
  else return null;
  for (const file of fileErrors(output)) report.set(`${file} > ${FILE_ROW}`, { status: "failed", file, name: "" });
  return report;
}

const NO_TESTS_MATCHED = /had no matches|did not match any test files|No tests found/;

/**
 * Whether a junit report was written to its end (S079, Sol 11): a <testsuites> root that closes, and every
 * <testsuite> and <testcase> inside it closed in order. A report its writer stopped partway through (a crash or a
 * kill mid-write) can still carry a red row that makes exit 1 look accounted for, but the rows after the cut were
 * never reported, so it is not a finished run. CDATA sections and comments are character data, never markup: a test
 * that prints `<testcase>` to stdout lands inside <system-out>'s CDATA and is not an opening tag (final round 2). One
 * left without its terminator runs to the end of the report, so closing tags hidden inside it do not count either.
 */
const NON_MARKUP = /<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<!--[\s\S]*?(?:-->|$)/g;

export function junitComplete(xml: string): boolean {
  const stack: string[] = [];
  let rooted = false;
  const markup = xml.replace(NON_MARKUP, () => " ");
  for (const m of markup.matchAll(/<(\/?)(testsuites|testsuite|testcase)\b[^>]*?(\/?)>/g)) {
    const [, close, tag, selfClose] = m as unknown as [string, string, string, string];
    if (close) { if (stack.pop() !== tag) return false; continue; }
    // One root, opened once; every suite and case sits inside it.
    if (tag === "testsuites") { if (rooted) return false; rooted = true; }
    else if (stack.length === 0) return false;
    if (!selfClose) stack.push(tag);
  }
  return rooted && stack.length === 0;
}

/**
 * Whether a `bun test` run finished and its report accounts for how it exited (S079): exit 0, exit 1 with at least
 * one red row to show for it, or exit 1 on a scope where bun found no tests at all. Any other exit (2, a timeout's
 * 124, a kill) and exit 1 with nothing red are a crashed, killed or partial run: its passing rows prove nothing,
 * so no judgment is built on them. A run its runner reports as terminated (terminationOf: the production runners
 * report a kill as exit 1) is refused before this is asked, in runReported.
 */
export function runComplete(code: number, report: TestReport, output: string): boolean {
  if (report === null) return false;
  if (code === 0) return true;
  if (code !== 1) return false;
  if ([...report.values()].some((r) => r.status === "failed")) return true;
  return report.size === 0 && NO_TESTS_MATCHED.test(output);
}

const isBunTest = (argv: string[]) => argv[0] === "bun" && argv[1] === "test";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Run a `bun test` command in `dir` with a junit report. Path arguments the tree does not have
 * are dropped (a directory the patch creates or deletes exists on one side only); when none is
 * left the run is an empty report, never a whole-tree run.
 */
function runReported(run: SpawnFn, dir: string, argv: string[], outfile: string): { code: number; report: TestReport; tail: string; complete: boolean } {
  const paths = argv.slice(2).filter((a) => a.startsWith("./"));
  const kept = paths.filter((a) => existsSync(join(dir, a)));
  if (paths.length > 0 && kept.length === 0) return { code: 0, report: new Map(), tail: "", complete: true };
  const args = argv.slice(2).filter((a) => !a.startsWith("./") || kept.includes(a));
  rmSync(outfile, { force: true });
  const p = run(["bun", "test", ...args, "--reporter=junit", `--reporter-outfile=${outfile}`], dir);
  const output = `${p.out}\n${p.err}`;
  const xml = existsSync(outfile) ? readFileSync(outfile, "utf8") : null;
  const report = parseTestRun(xml, output);
  // A report cut off mid-write is not a finished run, whatever rows it managed to carry (S079).
  const written = xml === null || junitComplete(xml);
  // A run that was killed, timed out or never spawned exits with the runner's stand-in code (exit 1, like a red run),
  // and whatever report it left was not written by a finished run: it is never complete, whatever its rows say (S079).
  const terminated = terminationOf(p);
  const tail = (terminated ? `${output.trim()}\n[run terminated: ${terminated}]` : output.trim()).slice(-300);
  return { code: p.code, report, tail, complete: terminated === undefined && written && runComplete(p.code, report, output) };
}

/** Give the baseline clone the live tree's dependency folders, at and above every scoped directory and inside it. */
function linkDeps(run: SpawnFn, live: string, clone: string, scope: string[]): void {
  const want = new Set<string>();
  for (const s of scope) {
    const parts = s.replace(/^\.\/?/, "").split("/").filter(Boolean);
    for (let i = 0; i <= parts.length; i++) want.add(join(...parts.slice(0, i), "node_modules"));
  }
  const ignored = run(["git", "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z", "--", ...scope], live);
  if (ignored.code === 0) for (const p of ignored.out.split("\0")) if (/(^|\/)node_modules\/$/.test(p)) want.add(p.slice(0, -1));
  for (const rel of want) {
    const target = join(live, rel);
    const link = join(clone, rel);
    if (existsSync(target) && !existsSync(link) && existsSync(dirname(link))) symlinkSync(target, link);
  }
}

/**
 * The one test judgment every caller uses (ISC-92): the preparer on the worker's clone, the
 * lander on the live tree. A patch passes when no test that passed on the unpatched tree is
 * red, skipped or gone after it, and no test is red after it that was not already red before
 * (a new test the patch adds must pass). Tests that newly fail are re-run once, alone, before
 * the patch is refused, so one flaky test cannot refuse a good patch (ISC-100). The baseline
 * always runs in a fresh clone of `baselineRepo` at HEAD, never in a working tree (ISC-101).
 *
 * A command that is not `bun test` (a project whose `test` script is more than a plain `bun test`,
 * see plainBunTest) cannot be asked for a named report, so it is judged as before: the patched
 * run must exit 0. A `bun test` whose baseline cannot be cloned or reported is refused ("unavailable"),
 * never passed on the patched run's exit code alone.
 *
 * It is a const, not a function declaration, so in this file the name followed by an open paren
 * appears only at the preparer's call: ISC-92's row counts the files that call it.
 */
export const judgeTests = (o: JudgeOptions): TestJudgment => {
  const run = o.run ?? sh;
  const verdict = (ok: boolean, mode: TestJudgment["mode"], note: string, rest: Partial<TestJudgment> = {}): TestJudgment =>
    ({ ok, mode, argv: o.argv, newlyFailing: [], flaky: [], baselineRed: [], note, ...rest });
  const exitOnly = (why: string): TestJudgment => {
    const p = run(o.argv, o.patchedDir);
    const terminated = terminationOf(p);
    const green = p.code === 0 && terminated === undefined;
    return verdict(green, "exit_code", `${why}; judged by exit code: ${green ? "green" : `exit ${p.code}${terminated ? ` (run terminated: ${terminated})` : ""}: ${`${p.err}\n${p.out}`.trim().slice(-300)}`}`);
  };
  if (!isBunTest(o.argv)) return exitOnly("not a bun test command, so no named report");

  const work = mkdtempSync(join(tmpdir(), "achilles-judge-"));
  try {
    const baseline = join(work, "baseline");
    const cloned = run(["git", "clone", "--shared", "--quiet", o.baselineRepo, baseline], work);
    // A patch is never judged green without a baseline to compare against: a failed baseline setup or report refuses it.
    if (cloned.code !== 0) return verdict(false, "unavailable", `no baseline: the baseline clone failed (${(cloned.err || cloned.out).trim().slice(0, 200)}); the patch is refused, not passed`);
    const scope = o.argv.slice(2).filter((a) => a.startsWith("./"));
    // The command's own --name=value flags (a project script's --preload, say) ride along on the re-run.
    const flags = o.argv.slice(2).filter((a) => a.startsWith("-"));
    if (o.linkDepsFrom) {
      const depScope = scope.length ? scope : ["./"];
      linkDeps(run, o.linkDepsFrom, baseline, depScope);
      // The lander judges the live tree itself, which already has its dependencies; the preparer's worker clone does not.
      if (!sameDir(o.patchedDir, o.linkDepsFrom)) linkDeps(run, o.linkDepsFrom, o.patchedDir, depScope);
    }
    const before = runReported(run, baseline, o.argv, join(work, "baseline.xml"));
    const after = runReported(run, o.patchedDir, o.argv, join(work, "patched.xml"));
    if (!after.report) return verdict(false, "named", `the patched run left no test report (exit ${after.code}): ${after.tail}`);
    if (!before.report) return verdict(false, "unavailable", `no baseline: the unpatched run left no readable test report (exit ${before.code}): ${before.tail}; the patch is refused, not passed`);
    // An incomplete run (crash, kill, timeout, or a failure its report does not show) proves nothing, on either side (S079).
    if (!after.complete) return verdict(false, "named", `the patched run did not finish cleanly (exit ${after.code}) and its report does not account for that; the patch is refused, not passed: ${after.tail}`);
    if (!before.complete) return verdict(false, "unavailable", `no baseline: the unpatched run did not finish cleanly (exit ${before.code}) and its report does not account for that; the patch is refused, not passed: ${before.tail}`);
    const B = before.report;
    const P = after.report;

    const baselineRed = [...B].filter(([, r]) => r.status === "failed").map(([k]) => k);
    const bad = new Set<string>();
    for (const [k, r] of B) if (r.status === "passed" && P.get(k)?.status !== "passed") bad.add(k);
    for (const [k, r] of P) if (r.status === "failed" && B.get(k)?.status !== "failed") bad.add(k);

    // The one re-run: a file that failed as a whole runs whole; otherwise only its red tests run, by name.
    const rerun = new Map<string, TestResult>();
    const redFiles = [...new Set([...bad].filter((k) => P.get(k)?.status === "failed" && P.get(k)!.name === "").map((k) => P.get(k)!.file))];
    const named = [...bad].map((k) => P.get(k)).filter((r): r is TestResult => r?.status === "failed" && r.name !== "" && !redFiles.includes(r.file));
    if (redFiles.length) {
      const r = runReported(run, o.patchedDir, ["bun", "test", ...flags, ...redFiles.map((f) => `./${f}`)], join(work, "rerun-files.xml"));
      // Only a re-run that finished may excuse a red test as flaky.
      if (r.complete) for (const [k, v] of r.report ?? []) if (redFiles.includes(v.file)) rerun.set(k, v);
    }
    if (named.length) {
      const files = [...new Set(named.map((r) => r.file))];
      const pattern = `^(?:${[...new Set(named.map((r) => escapeRe(r.name)))].join("|")})$`;
      const r = runReported(run, o.patchedDir, ["bun", "test", ...flags, ...files.map((f) => `./${f}`), "-t", pattern], join(work, "rerun-named.xml"));
      const wanted = new Set([...bad].filter((k) => P.get(k)?.status === "failed" && P.get(k)!.name !== ""));
      if (r.complete) for (const [k, v] of r.report ?? []) if (wanted.has(k)) rerun.set(k, v);
    }
    const flaky = [...bad].filter((k) => rerun.get(k)?.status === "passed");
    const newlyFailing = [...bad].filter((k) => !flaky.includes(k));
    const describe = (k: string) => `${k} (${P.get(k)?.status ?? "gone"})`;
    const tolerated = baselineRed.length ? `; ${baselineRed.length} already red on the unpatched tree` : "";
    if (newlyFailing.length) {
      return verdict(false, "named", `newly failing after the patch: ${newlyFailing.slice(0, 8).map(describe).join("; ")}${newlyFailing.length > 8 ? ` and ${newlyFailing.length - 8} more` : ""}${tolerated}`, { newlyFailing, flaky, baselineRed });
    }
    const passed = [...P.values()].filter((r) => r.status === "passed" && r.name !== "").length;
    return verdict(true, "named", `no test that passed before the patch broke (${passed} passing${flaky.length ? `; ${flaky.length} passed on re-run: ${flaky.slice(0, 3).join("; ")}` : ""}${tolerated})`, { flaky, baselineRed });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

/** The worker's own verdict line; a blocked or false-positive verdict means the diff is not a fix. */
export type WorkerVerdict = "fixed" | "already_fixed" | "false_positive" | "blocked" | "unknown";
export function workerVerdict(final: string): WorkerVerdict {
  const m = final.match(/###\s*VERDICT:\s*(already_fixed|fixed|false_positive|blocked)\b/i);
  return (m?.[1]?.toLowerCase() as WorkerVerdict | undefined) ?? "unknown";
}

/** The command on the report's PROOF line, verbatim (surrounding backticks dropped), or null when there is none. */
export function proofCommand(final: string): string | null {
  const m = final.match(/^###\s*PROOF:[ \t]*(.+)$/im);
  const cmd = m?.[1]?.trim().replace(/^`+|`+$/g, "").trim() ?? "";
  return cmd && !/^none$/i.test(cmd) ? cmd : null;
}
/** The fixing commit the worker named on its FIXED-BY line, or null. Only a hex sha is accepted, so it is safe as a git argument. */
export function fixedBy(final: string): string | null {
  return final.match(/^###\s*FIXED-BY:[ \t]*`?([0-9a-f]{7,40})\b/im)?.[1]?.toLowerCase() ?? null;
}
const GIT_READ_ONLY = new Set(["log", "show", "grep", "merge-base", "diff", "status", "rev-parse", "cat-file", "ls-files"]);
/**
 * A worker's proof command as an argv the loop may run itself, or null. The loop runs it outside the worker's sandbox, so
 * it is never handed to a shell: no shell operators, and only read-shaped programs (bun test, bun on a repo .ts file,
 * rg, grep, test, read-only git). Anything else is not re-runnable and the verdict stays unproven.
 */
/** Options that load or run code from elsewhere, point at another tree, or run a helper program: never part of a proof command. */
const PROOF_BAD_OPTION: Record<string, RegExp> = {
  bun: /^--?(preload|require|import|r|c|config|env-file|cwd|bunfig|inspect[\w-]*|watch|hot|define|loader|install|tsconfig-override|conditions|port)$/,
  rg: /^--?(pre|pre-glob|config-path|ignore-file|no-config)$/,
  grep: /^--?(exclude-from|file|f)$/,
  git: /^--?(exec-path|upload-pack|ext-diff|textconv|output|no-index|git-dir|work-tree|c)$/,
  test: /^$/,
};
/** An option is a bare flag, or flag=value with a value that holds no path separator and no parent reference. */
function proofOptionOk(prog: string, a: string): boolean {
  if (a === "--") return true;
  const m = /^(--?[A-Za-z][A-Za-z0-9-]*)(?:=(.*))?$/.exec(a);
  if (!m) return false;
  if (PROOF_BAD_OPTION[prog]?.test(m[1]!)) return false;
  return m[2] === undefined || !/[\/]|\.\./.test(m[2]);
}
export function proofArgv(cmd: string): string[] | null {
  if (/[|&;<>$`'"(){}\\!*?~\n]/.test(cmd)) return null;
  const argv = cmd.trim().split(/\s+/);
  const [prog, sub] = argv;
  if (argv.some((a) => /(^|\/)\.env\b|(^|\/)\.\.(\/|$)|^\//.test(a))) return null;
  if (prog && prog in PROOF_BAD_OPTION && argv.slice(1).some((a) => a.startsWith("-") && !proofOptionOk(prog, a))) return null;
  if (prog === "bun") return sub === "test" || (!!sub && /^(\.\/)?[\w./-]+\.ts$/.test(sub) && !sub.includes("..")) ? argv : null;
  if (prog === "rg" || prog === "grep" || prog === "test") return argv;
  if (prog === "git") return sub && GIT_READ_ONLY.has(sub) && !argv.some((a) => /^--(output|exec|upload-pack|ext-diff)/.test(a)) ? argv : null;
  return null;
}

export const DEPLOYS = join(CLAUDE, "LIFEOS/MEMORY/STATE/deploys.jsonl");
/**
 * Whether a project fix is live (ISC-97): is the fixing commit an ancestor of the head recorded by the repo's last deploy in
 * deploys.jsonl? A deploy row belongs to the repo when its dir is the repo or inside it. Always one plain sentence.
 */
export function deployedStatement(repo: string, commit: string | null, deploysPath = DEPLOYS, spawn: SpawnFn = sh): string {
  if (!commit) return "the worker named no fixing commit, so whether the fix is deployed is unknown";
  const root = existsSync(repo) ? realpathSync(repo) : resolve(repo);
  let last: { ts: string; head: string } | null = null;
  if (existsSync(deploysPath)) for (const line of readFileSync(deploysPath, "utf8").split("\n")) {
    try {
      const d = JSON.parse(line) as { ts?: unknown; dir?: unknown; head?: unknown };
      if (typeof d.dir !== "string" || typeof d.head !== "string" || !/^[0-9a-f]{7,40}$/.test(d.head)) continue;
      const dir = existsSync(d.dir) ? realpathSync(d.dir) : resolve(d.dir);
      if (dir === root || dir.startsWith(`${root}/`)) last = { ts: typeof d.ts === "string" ? d.ts : "", head: d.head };
    } catch { /* a torn or foreign line is skipped */ }
  }
  if (!last) return `fixing commit ${commit.slice(0, 9)}; no deploy of this repo is recorded, so it is not known to be live`;
  const anc = spawn(["git", "merge-base", "--is-ancestor", commit, last.head], repo);
  const where = `the last deployed revision ${last.head.slice(0, 9)}${last.ts ? ` (${last.ts})` : ""}`;
  if (anc.code === 0) return `fixing commit ${commit.slice(0, 9)} is in ${where}`;
  if (anc.code === 1) return `fixing commit ${commit.slice(0, 9)} is NOT in ${where}: it needs a deploy`;
  return `fixing commit ${commit.slice(0, 9)}: could not compare with ${where} (${(anc.err || anc.out).trim().slice(0, 120)})`;
}

// ---------- the pass text (ISC-39, ISC-47, ISC-48, ISC-52) ----------

export interface TextItem { id: string; kind: EscalationRecord["kind"]; reason: EscalationReason; title: string }
const WHY: Record<EscalationReason, string> = {
  blocked: "worker blocked", needs_repo: "no repo found", two_failures: "fix failed twice", human_class: "needs a human",
  two_unresolved: "two attempts without a fix", false_positive: "worker says false positive",
  review_blocked: "reviewer blocked patch", gate_path: "patch touches a gate", land_failed: "patch would not land",
  project_patch: "tested patch ready", land_refused: "land held: busy files", review_unavailable: "reviewer unreachable",
  already_fixed: "already fixed; proof re-ran green",
};
const PICK: Record<EscalationReason, string> = {
  blocked: "I work it by hand with you", needs_repo: "I map its repo, then retry", two_failures: "I debug it by hand",
  two_unresolved: "I debug it by hand", false_positive: "confirm the close",
  human_class: "I prep the steps for you", review_blocked: "I rework the patch with you", gate_path: "you review the patch by hand",
  land_failed: "I redo the patch on main", project_patch: "land the tested patch", land_refused: "retry the land once clear",
  review_unavailable: "land it without the review", already_fixed: "close it with the proof",
};
/** What a "y" does, said plainly: approve the plan the DA proposes, or land (and for a project, ship) the patch. */
const REPLY: Record<EscalationReason, string> = {
  blocked: "approves my plan", needs_repo: "approves my plan", two_failures: "approves my plan", human_class: "approves my plan",
  two_unresolved: "approves my plan", false_positive: "closes as false positive",
  review_blocked: "approves my plan", gate_path: "approves my plan", land_failed: "approves my plan",
  project_patch: "lands and ships it", land_refused: "lands it", review_unavailable: "lands it unreviewed",
  already_fixed: "closes it as fixed",
};
/**
 * What the loop does with a lander refusal. A refusal that may clear by itself is a y ask. A reviewer blocker or a
 * gate path is never a y ask, because the attended apply a "y" runs does neither check (OPERATIONAL_PREFERENCES: a blocker
 * stops the deploy). Anything else means the patch no longer lands as tested, which escalates too.
 */
export function refusalReason(r: RefusalReason): EscalationReason {
  if (r === "foreign_index" || r === "dirty_files") return "land_refused";
  if (r === "review_unavailable") return "review_unavailable";
  if (r === "review_blocked" || r === "gate_path") return r;
  return "land_failed";
}
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
export const textBlock = (i: TextItem): string =>
  [`Problem: ${i.id} ${clip(i.title.replace(/\s+/g, " ").trim(), 40)} (${WHY[i.reason]})`, `Pick: ${PICK[i.reason]}`, `Reply: y ${i.id} ${REPLY[i.reason]}`].join("\n");

/** The severity of the pass's text event; Vigil prints it upper-cased at the head of the text. A text carrying a critical entry is emitted at critical instead, which Vigil texts in quiet hours (ISC-94). */
export const PASS_SEVERITY: VigilEvent["severity"] = "high";
/**
 * The exact string Vigil puts on the phone for an ordinary text event (LIFEOS/VIGIL/Tick.ts, the
 * `${SEVERITY}: ${title} — ${summary}` body). ISC-47 is measured on this, never on the summary alone.
 */
export const vigilTextBody = (severity: VigilEvent["severity"], title: string, summary: string): string => `${severity.toUpperCase()}: ${title} — ${summary}`;

/**
 * The one text a pass sends (pure). The title carries the count; the summary carries the blocks.
 * Entries go in the order given until the next would push the delivered body (severity, title and
 * summary as Vigil joins them) to TEXT_MAX; the rest are named as waiting for the morning ping and the next pass.
 */
export function buildPassText(items: TextItem[], max = TEXT_MAX, severity: VigilEvent["severity"] = PASS_SEVERITY): { title: string; text: string; body: string; included: string[]; overflow: string[] } {
  const title = `Achilles: ${items.length} need${items.length === 1 ? "s" : ""} your call`;
  const compose = (k: number): string => {
    const rest = items.length - k;
    return [...items.slice(0, k).map(textBlock), ...(rest > 0 ? [`+${rest} more in the morning ping`] : [])].join("\n");
  };
  const size = (summary: string) => vigilTextBody(severity, title, summary).length;
  let k = items.length;
  while (k > 1 && size(compose(k)) >= max) k--;
  let text = compose(k);
  // One block alone is ~150 characters, so this clip is a guard, not a path: it keeps the bound absolute.
  if (size(text) >= max) text = clip(text, max - 1 - (size(text) - text.length));
  const body = vigilTextBody(severity, title, text);
  invariant(body.length < max, `pass text body ${body.length} is not under ${max}`);
  return { title, text, body, included: items.slice(0, k).map((i) => i.id), overflow: items.slice(k).map((i) => i.id) };
}

// ---------- delivery (ISC-31, ISC-50) ----------

/** One Vigil notification row: `ref` is the event it reports on, `decision` what the tick did with it, `key` the story key of that event. */
export interface Delivery { ref: string; decision: string; reason?: string; key?: string }
/** Vigil's reason for holding a copy of a story it texted in the last 72 hours: the words already reached him. */
export const ALREADY_TEXTED = "already texted about this in the last 72h";
/** Vigil's own rows, the same store `Vigil.ts list --source vigil --json` reads. */
export function readVigilDeliveries(): Delivery[] {
  const out: Delivery[] = [];
  for (const f of ["outbox.jsonl", "pulled.jsonl"]) {
    const p = vigilStatePath(f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.includes('"vigil"')) continue;
      try {
        const e = JSON.parse(line) as VigilEvent;
        if (e.source === "vigil" && e.ref && typeof e.meta?.decision === "string") out.push({ ref: e.ref, decision: e.meta.decision, ...(typeof e.meta.reason === "string" ? { reason: e.meta.reason } : {}), ...(typeof e.meta.key === "string" ? { key: e.meta.key } : {}) });
      } catch { /* a torn line is skipped; the next pass reads it whole */ }
    }
  }
  return out;
}

export interface PendingEscalation { id: string; key: string }
/** Unconsumed copies still in Vigil's outbox or pulled rows with no decision for their event id. A stale loop record or
 * a tick that died after holding a prior copy must never queue another copy beside one of these (ISC-31). */
export function readPendingEscalations(paths = [vigilStatePath("outbox.jsonl"), vigilStatePath("pulled.jsonl")], readerPath = vigilStatePath("reader.json")): PendingEscalation[] {
  const copies = new Map<string, PendingEscalation>();
  const decided = new Set<string>();
  let cursor: { ts: string; ids_at_ts: string[] } | undefined;
  if (existsSync(readerPath)) {
    const stored = JSON.parse(readFileSync(readerPath, "utf8"));
    invariant(typeof stored.ts === "string" && Array.isArray(stored.ids_at_ts) && stored.ids_at_ts.every((id: unknown) => typeof id === "string"), "Vigil reader cursor has a timestamp and event ids");
    cursor = stored;
  }
  for (const path of paths) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.includes('"achilles"') && !line.includes('"vigil"')) continue;
      try {
        const e = JSON.parse(line) as VigilEvent;
        if (e.source === "vigil" && e.ref && typeof e.meta?.decision === "string") decided.add(e.ref);
        else if (e.source === "achilles" && e.ref?.startsWith("achilles-escalation:") && typeof e.meta?.key === "string"
          && (!cursor || e.ts > cursor.ts || e.ts === cursor.ts && !cursor.ids_at_ts.includes(e.id))) copies.set(e.id, { id: e.id, key: e.meta.key });
      } catch { /* a torn line is skipped; the next pass reads it whole */ }
    }
  }
  return [...copies.values()].filter((e) => !decided.has(e.id));
}

/** Margin the tick must have run past a copy before that copy's silence counts: the tick reads the outbox after its own start time. */
const TICK_MARGIN_MS = 60_000;
/** When the Vigil tick last ran (its last-tick.json), or null when it never has. */
export function readLastTick(): number | null {
  try { const t = Date.parse((JSON.parse(readFileSync(vigilStatePath("last-tick.json"), "utf8")) as { ts?: string }).ts ?? ""); return Number.isFinite(t) ? t : null; } catch { return null; }
}

/**
 * Marks delivered texts and frees failed, held, or silent ones for a resend. Returns the records changed.
 *
 * Delivered (ISC-68): any Vigil `sent` row whose story key is one this escalation's texts carried, or whose ref is
 * any copy emitted for it, whatever event id it names; and a copy held with the exact 72-hour "already texted"
 * reason (which requires an earlier send). Same-batch suppression has a distinct reason and gives no credit.
 * Credit reads every copy, so a late `sent` row on a superseded copy counts.
 *
 * Freed for a resend (ISC-50): the CURRENT copy was held for any other reason (quiet hours, a ceiling) or failed;
 * or it has no row 30 minutes on AND the tick has run since it was emitted. While the tick is behind, the copy is
 * still waiting, and a second copy would reach the recovered tick in the same batch and be texted twice (ISC-31).
 */
export function reconcileDeliveries(records: EscalationRecord[], deliveries: Delivery[], now: number, lastTick: number | null = now): number {
  let changed = 0;
  for (const r of records) {
    if (r.delivered) continue;
    const keys = new Set(r.keys ?? []);
    const copies = new Set([...(r.events ?? []), ...(r.event ? [r.event] : [])]);
    const mine = deliveries.filter((d) => copies.has(d.ref) || (!!d.key && keys.has(d.key)));
    const reached = mine.find((d) => d.decision === "sent") ?? mine.find((d) => d.decision === "held" && d.reason === ALREADY_TEXTED);
    if (reached) {
      r.delivered = true;
      r.decision = reached.decision === "sent" ? "sent" : `delivered earlier (${ALREADY_TEXTED})`;
      r.event = reached.decision === "sent" ? reached.ref : (r.event ?? reached.ref);
      delete r.dropped;
      changed++;
      continue;
    }
    if (!r.event) continue;
    const current = deliveries.filter((d) => d.ref === r.event);
    const terminal = current.find((d) => d.decision === "failed" || d.decision === "held");
    const sentAt = Date.parse(r.sent_at ?? r.at);
    const silent = !current.length && now - sentAt >= DELIVERY_GRACE_MS && lastTick !== null && lastTick >= sentAt + TICK_MARGIN_MS;
    if (terminal || silent) { r.decision = terminal ? `${terminal.decision}${terminal.reason ? `: ${terminal.reason}` : ""}` : "no_row"; delete r.event; delete r.sent_at; changed++; }
  }
  return changed;
}

/**
 * The story key of one escalation text: a hash of the escalations it carries (entry, kind, and when each was
 * registered), so every resend of the same escalations shares one key and a later escalation of the same entry gets a new one.
 */
export const escalationKey = (carried: Array<Pick<EscalationRecord, "id" | "kind" | "at">>): string =>
  `achilles:escalation:${createHash("sha256").update(carried.map((r) => `${r.id}:${r.kind}:${r.at}`).sort().join("|")).digest("hex").slice(0, 16)}`;

// ---------- registry writes (through Achilles' own save, so its invariants run) ----------

/** Through Achilles' updateEntry: a fresh load per write, retried when another writer saved in between. */
const mutateEntry = (registryPath: string, id: string, fn: (e: AchillesEntry) => void): AchillesEntry => updateEntry(registryPath, id, fn);

/** Escalate (ISC-38, ISC-44): fix_class human plus an evidence line naming why; the entry then leaves selection. */
export function escalateEntry(registryPath: string, id: string, reason: EscalationReason, detail: string, now: number): AchillesEntry {
  return mutateEntry(registryPath, id, (e) => {
    invariant(!Y_ASK_REASONS.has(reason), "a y ask is not an escalation");
    e.fix_class = "human";
    e.evidence.push(`escalated to the principal ${new Date(now).toISOString()}: ${WHY[reason]}${detail ? ` (${clip(detail, 160)})` : ""}`);
  });
}

// ---------- acceptance (ISC-62) ----------

const CLOSED = new Set(["remediated", "accepted", "false_positive", "informational"]);
export function acceptance(ids: string[], entries: AchillesEntry[], st: RemediationState): { ok: boolean; rows: Array<{ id: string; ok: boolean; why: string }> } {
  const rows = ids.map((id) => {
    const e = entries.find((x) => x.id === id);
    if (!e) return { id, ok: false, why: "not in the registry" };
    if (CLOSED.has(e.status) && e.closed_at) return { id, ok: true, why: `closed ${e.status}` };
    const attempts = st.attempts[id] ?? [];
    if (attempts.some((a) => a.note?.startsWith("applied ")) || e.evidence.some((l) => l.startsWith("patch applied on main"))) return { id, ok: true, why: "applied commit" };
    // A patch the lander refused for good escalated its entry (fix_class human): it is not ready; the escalation text decides.
    if (attempts.slice(-1)[0]?.outcome === "patch" && e.fix_class !== "human") return { id, ok: true, why: "ready patch" };
    if ((st.escalations ?? []).some((r) => r.id === id && r.delivered)) return { id, ok: true, why: "delivered escalation" };
    return { id, ok: false, why: "no closure, commit, ready patch, or delivered escalation" };
  });
  return { ok: rows.length > 0 && rows.every((r) => r.ok), rows };
}

// ---------- single flight (ISC-54) ----------

/** O_EXCL lock beside the state file. Null when a live run holds it; a lock older than LOCK_STALE_MS is taken over. */
export function takeLock(lockPath: string, now = Date.now()): (() => void) | null {
  invariant(lockPath.endsWith(".lock") && Number.isFinite(now), "a remediation lock has a path and timestamp");
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }));
      closeSync(fd);
      return () => rmSync(lockPath, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let age = 0;
      try { age = Date.now() - statSync(lockPath).mtimeMs; } catch { continue; }
      if (age < LOCK_STALE_MS) return null;
      rmSync(lockPath, { force: true });
    }
  }
  return null;
}

// ---------- the pass ----------

export interface RemediateOptions {
  dryRun?: boolean; only?: string; max?: number; json?: boolean; urgent?: boolean;
  registryPath?: string; statePath?: string; patchDir?: string; installDir?: string;
  /** PROJECTS.md text; defaults to the live file. */
  projectsMd?: string;
  worker?: WorkerFn;
  emit?: (e: VigilEvent) => unknown;
  deliveries?: () => Delivery[];
  /** Undecided escalation copies in Vigil's outbox and pulled rows; injectable so tests never read live state. */
  pendingEscalations?: () => PendingEscalation[];
  /** When the Vigil tick last ran; defaults to its last-tick.json. */
  lastTick?: () => number | null;
  land?: (o: ApplyOptions) => Promise<ApplyResult>;
  spawn?: SpawnFn;
  now?: () => number;
  /** Work repo for issue comments; defaults to the work config. */
  workRepo?: string | null;
  /** The deploy ledger an already-fixed project ask reads (ISC-97); defaults to LIFEOS/MEMORY/STATE/deploys.jsonl. */
  deploysPath?: string;
  quiet?: boolean;
}
export interface PassResult {
  exit: number; skipped?: "locked"; pass: string; dry_run: boolean; considered: number;
  results: Array<{ id: string; outcome: Outcome; repo?: string; patch?: string; note?: string; landed?: string; refused?: string }>;
  escalated: string[]; texted: string[]; overflow: string[]; counts: { attempts: number; patches: number; escalations: number };
}

const isFailure = (a?: Attempt) => a?.outcome === "worker_failed" || a?.outcome === "tests_failed";
const twoFailures = (list: Attempt[]) => list.length >= 2 && isFailure(list.at(-1)) && isFailure(list.at(-2));
// An already-fixed attempt resolved itself into a close ask: it is not an unresolved attempt.
const twoUnresolved = (list: Attempt[]) => list.length >= 2 && list.slice(-2).every((a) => a.outcome !== "patch" && a.outcome !== "already_fixed");
const sameDir = (a: string, b: string) => { const r = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p)); return r(a) === r(b); };

export async function remediate(opts: RemediateOptions = {}): Promise<PassResult> {
  const now = opts.now ?? Date.now;
  const log = (l: string) => { if (!opts.quiet) console.error(`[achilles-remediate] ${l}`); };
  const registryPath = opts.registryPath ?? REGISTRY;
  const statePath = opts.statePath ?? STATE;
  const patchDir = opts.patchDir ?? PATCH_DIR;
  const installDir = opts.installDir ?? CLAUDE;
  const spawn = opts.spawn ?? sh;
  // Anything the worker's code can influence (its tests, its proof command) runs on the sandboxed seam, never on `sh`.
  const codeSpawn: SpawnFn = opts.spawn ?? shSandboxed;
  const worker: WorkerFn = opts.worker ?? ((b, c, s) => runWorker(b, c, s, WORKER_TIMEOUT_MS, spawn));
  const emitEvent = (e: VigilEvent) => {
    if (st) assertOneLiveText(st); // ISC-77 applies before every emission, including the outcome line.
    return opts.emit ? opts.emit(e) : loadVigilEmit()?.(e as never);
  };
  const land = opts.land ?? applyPatch;
  const passId = new Date(now()).toISOString().replace(/[-:.]/g, "").slice(0, 15) + "-" + randomUUID().slice(0, 8);
  const result: PassResult = { exit: 0, pass: passId, dry_run: !!opts.dryRun, considered: 0, results: [], escalated: [], texted: [], overflow: [], counts: { attempts: 0, patches: 0, escalations: 0 } };

  let emittedRunLine = false;
  const runLine = (severity: VigilEvent["severity"], full: string, extra: Record<string, string> = {}, key?: string) => {
    if (opts.dryRun || emittedRunLine) return;
    emittedRunLine = true;
    const c = result.counts;
    const title = `Achilles remediation${opts.urgent ? " (urgent)" : ""}: ${c.attempts} attempts, ${c.patches} patches, ${c.escalations} escalations`;
    // ISC-47: a high run line (a crash) reaches the phone, so the body Vigil composes stays under TEXT_MAX like the pass text.
    const summary = clip(full, TEXT_MAX - 1 - vigilTextBody(severity, title, "").length);
    invariant(vigilTextBody(severity, title, summary).length < TEXT_MAX, "run line body is not under TEXT_MAX");
    try {
      emitEvent({
        id: randomUUID(), source: "achilles", ts: new Date(now()).toISOString(), kind: "security", severity,
        title,
        summary, ref: `achilles-run:${passId}`, url: null, privacy_class: "personal", dedup_key: `achilles:run:${passId}`,
        meta: { attempts: c.attempts, patches: c.patches, escalations: c.escalations, texted: result.texted.length, waiting: result.overflow.length, urgent: !!opts.urgent, ...extra, ...(key ? { key } : {}) },
      });
    } catch (err) { log(`run line not queued: ${String(err).slice(0, 200)}`); }
  };

  let release: (() => void) | null = null;
  let outcome: { severity: VigilEvent["severity"]; summary: string; extra?: Record<string, string>; key?: string } | undefined;
  // Hoisted so a pass that throws can still save what it did (ISC-67): registry writes already made (an
  // escalation's fix_class human) must not lose the attempt and text records that go with them.
  let st: RemediationState | undefined;
  let records: EscalationRecord[] = [];
  const crashOutcome = (err: unknown) => {
    if (opts.dryRun) return;
    const msg = String(err instanceof Error ? `${err.name}: ${err.message}` : err).replace(/\s+/g, " ").slice(0, 300);
    if (st) {
      // The lander persists its applied marker before registry evidence. Merge that durable progress
      // into this pass's partial state so a later registry failure cannot erase a completed land.
      try {
        const durable = loadState(statePath);
        for (const [id, attempts] of Object.entries(durable.attempts)) for (const applied of attempts.filter((a) => a.note?.startsWith("applied "))) {
          const list = (st.attempts[id] ??= []);
          const same = list.find((a) => a.at === applied.at && a.outcome === applied.outcome && a.repo === applied.repo && a.patch === applied.patch);
          if (same) same.note = applied.note;
          else list.push(applied);
        }
      } catch (readErr) { log(`durable land progress not read after the crash: ${String(readErr).slice(0, 200)}`); }
      try { st.escalations = records; saveState(st, statePath); } catch (saveErr) { log(`state not saved after the crash: ${String(saveErr).slice(0, 200)}`); }
    }
    // If the pass already queued its escalation text, medium keeps a crash to one phone text (ISC-52).
    outcome = { severity: result.texted.length ? "medium" : "high", summary: `Pass ${passId} crashed: ${msg}`, extra: { error: msg }, key: `achilles:run:crash:${createHash("sha256").update(msg.replace(/\d+/g, "#")).digest("hex").slice(0, 16)}` };
  };
  try {
    let locked = false;
    if (opts.dryRun) {
      // A preview only inspects the lock: no directory creation, lock acquisition or stale-lock cleanup.
      try { locked = Date.now() - statSync(`${statePath}.lock`).mtimeMs < LOCK_STALE_MS; }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    } else { release = takeLock(`${statePath}.lock`, now()); locked = !release; }
    if (locked) {
      // ISC-54: no read or write of remediation.json; the guarded emitter also excludes a locked dry-run.
      log("another run holds the lock; exiting without touching state");
      result.skipped = "locked";
      outcome = { severity: "info", summary: `Pass ${passId} skipped: another remediation run holds the lock.`, extra: { skipped: "locked" } };
      return result;
    }
    const reg = loadRegistry(registryPath);
    st = loadState(statePath);
    records = (st.escalations ??= []);
    st.texts ??= [];
    const projects = opts.projectsMd ?? (existsSync(PROJECTS_MD) ? readFileSync(PROJECTS_MD, "utf8") : "");
    const dupes = duplicateIds(reg.entries);
    const inScope = (e: AchillesEntry) => !opts.urgent || inUrgentWindow(e, now());
    const hasRecord = (id: string, kind: EscalationRecord["kind"]) => records.some((r) => r.id === id && r.kind === kind && !r.dropped);
    // One record per entry and kind. A record still waiting for delivery keeps its place; a delivered (or dropped)
    // one is replaced, because a NEW escalation of the same entry is news and gets its own text (ISC-30, ISC-31).
    const record = (id: string, kind: EscalationRecord["kind"], reason: EscalationReason) => {
      const old = records.find((r) => r.id === id && r.kind === kind);
      if (old && !old.delivered && !old.dropped) return;
      const at = old ? Math.max(now(), Date.parse(old.at) + 1) : now();
      const fresh: EscalationRecord = { id, kind, reason, pass: passId, at: new Date(at).toISOString(), text_hash: "pending", delivered: false };
      if (old) records.splice(records.indexOf(old), 1, fresh); else records.push(fresh);
    };
    const escalate = (e: AchillesEntry, reason: EscalationReason, detail: string) => {
      if (opts.dryRun) { result.escalated.push(e.id); return; }
      escalateEntry(registryPath, e.id, reason, detail, now());
      e.fix_class = "human";
      record(e.id, "escalation", reason);
      result.escalated.push(e.id);
      result.counts.escalations++;
      log(`${e.id}: escalated (${WHY[reason]})`);
    };

    // 1. What earlier texts did: delivered ones are done; failed, held, or silent ones go out again.
    if (!opts.dryRun) {
      // ISC-80: every reopened drop is a new ask, at every severity and for both kinds. Renew before
      // reconciliation or dispatch so a cancelled text's delivery identities never reach the new ask.
      for (const r of records.slice()) if (r.dropped && reg.entries.some((e) => e.id === r.id && isOpen(e))) record(r.id, r.kind, r.reason);
      // Saved intent carries delivery identities even if the process died before its post-emission save.
      for (const t of st.texts ?? []) for (const r of records.filter((r) => t.entries.some((e) => e.id === r.id && e.kind === r.kind && e.at === r.at))) {
        r.keys = [...new Set([...(r.keys ?? []), t.key])];
        r.events = [...new Set([...(r.events ?? []), ...t.events])];
      }
      reconcileDeliveries(records, (opts.deliveries ?? readVigilDeliveries)(), now(), (opts.lastTick ?? readLastTick)());
      // ISC-98: an already-fixed close ask whose seven days ran out unanswered is withdrawn, so its entry is worked again
      // (selectEntries lets it through) and its waiting text, if any, is cancelled below as a member mismatch.
      for (const r of records.slice()) {
        if (r.kind !== "y_ask" || r.reason !== "already_fixed" || r.delivered) continue;
        if (!openCloseAsk(st.attempts[r.id]?.at(-1), now())) { records.splice(records.indexOf(r), 1); log(`${r.id}: close ask unanswered for 7 days; back in the queue`); }
      }
    }

    // Attempts already escalated once (and since handed back to the worker) are not news again until a new attempt ends unresolved.
    const escalatedSince = (id: string, at: string) => records.some((r) => r.id === id && r.kind === "escalation" && Date.parse(r.at) >= Date.parse(at));
    // 2. Escalations that need no worker: human-class criticals and highs, and persisted unresolved or false-positive attempts.
    for (const e of reg.entries.filter((x) => isOpen(x) && !dupes.has(x.id) && inScope(x)).sort(bySeverityThenAge)) {
      if (opts.only && e.id !== opts.only) continue;
      if (e.fix_class === "human" && isUrgentSeverity(e) && !hasRecord(e.id, "escalation")) escalate(e, "human_class", "human class at registration");
      else if (e.fix_class === "agent" && !escalatedSince(e.id, st.attempts[e.id]?.at(-1)?.at ?? "")) {
        const attempts = st.attempts[e.id] ?? [];
        if (attempts.at(-1)?.outcome === "false_positive") escalate(e, "false_positive", attempts.at(-1)?.note ?? "");
        else if (twoUnresolved(attempts)) escalate(e, twoFailures(attempts) ? "two_failures" : "two_unresolved", attempts.at(-1)?.note ?? "");
      }
    }

    const handleReady = async (e: AchillesEntry, a: Attempt): Promise<void> => {
      if (!a.repo || !a.patch) return;
      if (!sameDir(a.repo, installDir)) { record(e.id, "y_ask", "project_patch"); return; } // ISC-41: a project patch is asked, never applied
      saveState(st!, statePath); // the lander reads the ready attempt from the state file
      const r = await land({ id: e.id, registryPath, statePath, installDir, unattended: true }); // ISC-65
      const reread: RemediationState = loadState(statePath);
      records.splice(0, records.length, ...(reread.escalations ?? []));
      reread.escalations = records;
      st = reread;
      const row = result.results.find((x) => x.id === e.id);
      if (r.status === "applied") { if (row) row.landed = r.commit; log(`${e.id}: landed ${r.commit}`); return; }
      if (row) row.refused = `${r.reason}: ${clip(r.detail, 200)}`;
      log(`${e.id}: land refused (${r.reason})`);
      const why = refusalReason(r.reason);
      if (Y_ASK_REASONS.has(why)) record(e.id, "y_ask", why);
      else escalate(e, why, `${r.reason}: ${r.detail.replace(/\s+/g, " ")}`);
    };

    // ISC-71: finish saved ready patches before spending a new worker slot. A prior land result or decision
    // record stops recovery; land refusals are human decisions, never unattended retries.
    if (!opts.dryRun) for (const e of reg.entries.filter((x) => isOpen(x) && !dupes.has(x.id)).sort(bySeverityThenAge)) {
      if (opts.only && e.id !== opts.only) continue;
      const a = st.attempts[e.id]?.at(-1);
      if (a?.outcome !== "patch" || a.note?.startsWith("applied ") || records.some((r) => r.id === e.id && !r.dropped && Date.parse(r.at) >= Date.parse(a.at))) continue;
      result.results.push({ id: e.id, outcome: "patch", repo: a.repo, patch: a.patch, note: a.note });
      await handleReady(e, a);
    }

    // 3. Dispatch.
    let picked = selectEntries(reg.entries, st, now(), opts.max ?? DEFAULT_MAX, { urgent: opts.urgent });
    // --only bypasses cool-down and the cap, never the duplicate or ready-patch guards.
    if (opts.only) picked = reg.entries.filter((e) => e.id === opts.only && isOpen(e) && e.fix_class === "agent" && !dupes.has(e.id) && st!.attempts[e.id]?.at(-1)?.outcome !== "patch" && !openCloseAsk(st!.attempts[e.id]?.at(-1), now()));
    result.considered = picked.length;
    if (!opts.dryRun) { invariant(patchDir.length > 0, "patch directory is named"); mkdirSync(patchDir, { recursive: true }); }

    for (const e of picked) {
      const at = () => new Date(now()).toISOString();
      const repo = resolveRepo(e, projects, installDir);
      if (!repo || !existsSync(join(repo, ".git"))) {
        const a: Attempt = { at: at(), outcome: "needs_repo", note: repo ?? "no PROJECTS.md row serves the affected host or names the project" };
        result.results.push({ id: e.id, outcome: "needs_repo", note: a.note });
        if (opts.dryRun) continue;
        (st.attempts[e.id] ??= []).push(a);
        result.counts.attempts++;
        escalate(e, "needs_repo", a.note!); // ISC-30
        continue;
      }
      if (opts.dryRun) { result.results.push({ id: e.id, outcome: "patch", repo, note: "dry-run: would dispatch" }); continue; }

      const ts = at().replace(/[:.]/g, "-");
      const slug = `achilles-${e.id.toLowerCase()}-${ts}`;
      // The clone is a private repo: a per-run mkdtemp dir (0700), never a predictable name in the shared /tmp (round-24 audit).
      const scratch = join(mkdtempSync(join(tmpdir(), "achilles-remediate-")), slug);
      const cloned = makeClone(repo, scratch, spawn);
      let attempt: Attempt;
      if (!cloned.ok) {
        // A repo that cannot be cloned is this entry's failure, never the pass's: the rest of the pass still runs.
        rmSync(dirname(scratch), { recursive: true, force: true });
        attempt = { at: at(), outcome: "worker_failed", repo, note: cloned.err };
      } else try {
        const clone = cloned.path;
        const w = worker(buildBrief(e, clone), clone, slug);
        const reportPath = join(patchDir, `${e.id}-${ts}.report.md`);
        invariant(resolve(dirname(reportPath)) === resolve(patchDir), "worker report stays inside the patch directory");
        writeFileSync(reportPath, w.final || w.err.slice(-4000));
        const diff = captureDiff(clone, spawn);
        const verdict = workerVerdict(w.final);
        if (verdict === "false_positive") attempt = { at: at(), outcome: "false_positive", report: reportPath, repo, note: "worker verdict false_positive — principal must confirm the close; see report" };
        else if (w.code !== 0) attempt = { at: at(), outcome: "worker_failed", report: reportPath, repo, note: w.err.slice(-300) };
        else if (verdict === "blocked") attempt = { at: at(), outcome: "blocked", report: reportPath, repo, note: `worker verdict blocked${diff.trim() ? " (diff discarded)" : ""} — see report` };
        else if (verdict === "already_fixed" && !diff.trim()) {
          // ISC-84: the worker's word is not the proof. Its proof command is re-run here, in the unchanged clone at HEAD;
          // only a green re-run becomes a close ask. It runs without a shell and only when read-shaped (proofArgv). It is
          // bounded, like the test judgment, by the job's own one-hour timeout rather than a per-command one.
          const proof = proofCommand(w.final);
          const argv = proof ? proofArgv(proof) : null;
          const rerun = argv ? codeSpawn(argv, clone) : null;
          if (!proof || !argv || !rerun) attempt = { at: at(), outcome: "no_change", report: reportPath, repo, note: `worker said already fixed but ${proof ? `its proof is not a command the loop re-runs: ${clip(proof, 120)}` : "named no proof command"}` };
          else if (rerun.code !== 0) attempt = { at: at(), outcome: "no_change", report: reportPath, repo, note: `worker said already fixed; its proof failed on re-run (exit ${rerun.code}): ${clip(proof, 120)}` };
          else {
            const commit = fixedBy(w.final);
            // ISC-97: a project fix is only done for the principal when it is live, so the ask says whether it is deployed.
            const deployed = sameDir(repo, installDir) ? "" : deployedStatement(repo, commit, opts.deploysPath ?? DEPLOYS, spawn);
            attempt = { at: at(), outcome: "already_fixed", report: reportPath, repo, proof, ...(commit ? { commit } : {}), note: `proof re-ran green in a clean clone${deployed ? `; ${deployed}` : ""}` };
          }
        }
        else if (!diff.trim() || verdict !== "fixed") {
          // A diff under a non-fixed verdict is not a fix (first live run: the worker said "blocked"
          // and still softened the job's exit code). The diff is discarded.
          attempt = { at: at(), outcome: "no_change", report: reportPath, repo, note: verdict === "fixed" ? "worker changed nothing" : `worker verdict ${verdict}${diff.trim() ? " (diff discarded)" : ""} — see report` };
        } else {
          // The clone's HEAD is the unpatched tree (the worker's edits are uncommitted), so it is its own baseline.
          // The diff is already captured, so the dependency links judgeTests adds to the clone never enter it.
          const t = judgeTests({ argv: testCommand(repo, diff, installDir), baselineRepo: clone, patchedDir: clone, run: codeSpawn, linkDepsFrom: repo });
          const patchPath = join(patchDir, `${e.id}-${ts}.diff`);
          invariant(resolve(dirname(patchPath)) === resolve(patchDir) && diff.trim().length > 0, "a patch artifact contains a diff inside the patch directory");
          writeFileSync(patchPath, diff);
          attempt = t.ok
            ? { at: at(), outcome: "patch", patch: patchPath, report: reportPath, repo }
            : { at: at(), outcome: "tests_failed", patch: patchPath, report: reportPath, repo, note: t.note.slice(0, 300) };
        }
      } finally {
        rmSync(dirname(scratch), { recursive: true, force: true }); // the mkdtemp parent goes with the clone
      }
      (st.attempts[e.id] ??= []).push(attempt);
      result.counts.attempts++;
      result.results.push({ id: e.id, outcome: attempt.outcome, repo, patch: attempt.patch, note: attempt.note });
      log(`${e.id}: ${attempt.outcome}${attempt.note ? ` — ${attempt.note.slice(0, 120)}` : ""}`);

      if (attempt.outcome === "blocked") escalate(e, "blocked", attempt.note ?? ""); // ISC-30
      else if (attempt.outcome === "false_positive") escalate(e, "false_positive", attempt.note ?? ""); // ISC-70
      else if (attempt.outcome === "already_fixed") {
        // ISC-84/96: a close ask, its evidence carrying the proof command verbatim. The principal's "y" closes it; until then it is not dispatched (ISC-85).
        mutateEntry(registryPath, e.id, (x) => { x.evidence.push(`already fixed, asking to close: proof re-ran green in a clean clone: ${attempt.proof}${attempt.note?.includes("; ") ? `; ${attempt.note.slice(attempt.note.indexOf("; ") + 2)}` : ""}`); });
        record(e.id, "y_ask", "already_fixed");
        log(`${e.id}: already fixed; close ask raised`);
      }
      else if (twoUnresolved(st.attempts[e.id]!)) escalate(e, twoFailures(st.attempts[e.id]!) ? "two_failures" : "two_unresolved", attempt.note ?? ""); // ISC-43/69
      else if (attempt.outcome === "patch") {
        result.counts.patches++;
        mutateEntry(registryPath, e.id, (x) => { x.status = "in_progress"; x.evidence.push(`patch ready (tests pass in a clean clone): ${attempt.patch}`); });
        const workRepo = opts.workRepo !== undefined ? opts.workRepo : await defaultWorkRepo();
        if (workIssueOf(e) && workRepo) spawn(["gh", "issue", "comment", String(workIssueOf(e)), "--repo", workRepo, "--body", `Achilles remediation: a verified patch is ready (\`${attempt.patch}\`).`]);
        await handleReady(e, attempt);
      }
    }
    if (opts.dryRun) return result;

    // 4. Retry frozen texts independently, then compose at most one NEW text (ISC-52/72/74).
    const entryOf = new Map(reg.entries.map((e) => [e.id, e] as const));
    // ISC-51: an entry that closed (or left the registry) before its text was delivered has nothing left to tell.
    // ISC-81: closure is durable even while a cancelled copy is in flight; reopening renews its identity above.
    for (const r of records) {
      if (r.delivered) continue;
      const open = entryOf.has(r.id) && isOpen(entryOf.get(r.id)!);
      if (!open && !r.dropped) { r.dropped = "entry_closed"; log(`${r.id}: closed before its text was delivered; dropped from the queue`); }
    }
    const pending = (opts.pendingEscalations ?? readPendingEscalations)();
    const rememberPending = (r: EscalationRecord, copy: PendingEscalation) => {
      r.event = copy.id;
      r.events = [...new Set([...(r.events ?? []), copy.id])];
      r.keys = [...new Set([...(r.keys ?? []), copy.key])];
    };
    const frozen = (st.texts ??= []);
    const members = (t: EscalationText) => records.filter((r) => t.entries.some((e) => sameEscalation(e, r)));
    const needsAsking = (r: EscalationRecord) => !r.delivered && !r.dropped && !!entryOf.get(r.id) && isOpen(entryOf.get(r.id)!);
    const currentMembers = (t: EscalationText) => t.entries.map((e) => records.find((r) => sameEscalation(e, r)));
    // ISC-86: only a critical or high entry's escalation or y ask is ever texted; mediums and lows wait for the morning ping.
    const textable = (r: EscalationRecord) => { const e = entryOf.get(r.id); return !!e && isUrgentSeverity(e); };
    // ISC-87: the texts still waiting to reach him. At most one exists at any time.
    const undeliveredTexts = () => frozen.filter((t) => !t.cancelled && members(t).some((r) => !r.delivered && !r.dropped));
    const inLiveText = (r: EscalationRecord) => frozen.some((t) => !t.cancelled && t.entries.some((e) => sameEscalation(e, r)));
    // Validate the entire saved membership, including identities that no longer exist. Cancel first;
    // the single new-text queue below rebuilds all surviving asks together with new escalations.
    for (const t of frozen) {
      if (t.cancelled) continue;
      const current = currentMembers(t);
      if (current.every((r) => r?.delivered)) continue; // A completed text remains as sent history.
      if (current.some((r) => !r || !needsAsking(r) || !textable(r))) {
        t.cancelled = current.some((r) => r && (!entryOf.has(r.id) || !isOpen(entryOf.get(r.id)!))) ? "entry_closed" : "member_mismatch";
        saveState(st, statePath); // Cancellation must be durable before rebuilding or emitting anything.
      }
    }
    for (const r of records) {
      if (r.delivered || r.event || r.dropped) continue;
      const copy = pending.find((e) => (r.keys ?? []).includes(e.key) || e.key === escalationKey([r]));
      if (copy) rememberPending(r, copy);
    }
    const sendText = (t: EscalationText, event: VigilEvent) => {
      invariant(!t.cancelled && currentMembers(t).every((r) => !!r && needsAsking(r) && textable(r)), "every frozen member matches its current, textable escalation before emit");
      invariant(undeliveredTexts().every((x) => x === t), "at most one Achilles text is undelivered (ISC-87)");
      const carried = members(t);
      assertOneLiveText(st!);
      const pendingCopy = pending.find((e) => e.key === t.key);
      if (pendingCopy) {
        t.events = [...new Set([...t.events, pendingCopy.id])];
        for (const r of carried) rememberPending(r, pendingCopy);
        return;
      }
      invariant(carried.length > 0 && event.meta?.key === t.key, "an escalation copy uses its saved story");
      t.events = [...new Set([...t.events, event.id])];
      for (const r of carried) {
        r.keys = [...new Set([...(r.keys ?? []), t.key])];
        r.events = [...new Set([...(r.events ?? []), ...t.events])];
        r.text_hash = createHash("sha256").update(t.event.summary).digest("hex");
      }
      saveState(st!, statePath); // Durable intent MUST precede the external emission, including every retry's id.
      try { emitEvent(event); }
      catch (err) { log(`escalation text not queued: ${String(err).slice(0, 200)}`); return; }
      for (const r of carried) { r.event = event.id; r.sent_at = event.ts; }
      result.texted.push(...carried.map((r) => r.id));
    };
    const composeText = (queue: EscalationRecord[]): EscalationText => {
      // ISC-94: the queue is severity-first, so a critical member is always its first and always included.
      const severity: VigilEvent["severity"] = entryOf.get(queue[0]!.id)!.severity === "critical" ? "critical" : PASS_SEVERITY;
      const { title, text, included } = buildPassText(queue.map((r) => ({ id: r.id, kind: r.kind, reason: r.reason, title: entryOf.get(r.id)!.title })), TEXT_MAX, severity);
      const carried = queue.slice(0, included.length);
      const key = escalationKey(carried);
      const event: VigilEvent = {
        id: randomUUID(), source: "achilles", ts: new Date(now()).toISOString(), kind: "security", severity,
        title, summary: text, ref: `achilles-escalation:${passId}`, url: null, privacy_class: "personal", dedup_key: `achilles:escalation:${randomUUID()}`,
        meta: { key },
      };
      const t: EscalationText = { key, event, entries: carried.map(({ id, kind, at }) => ({ id, kind, at })), events: [event.id] };
      frozen.push(t);
      return t;
    };
    // ISC-95: a critical or high escalation raised after the waiting text was composed is news: the waiting text is cancelled
    // (Vigil holds any queued copy of it at send time, ISC-79) and one replacement covers its members and the new ones.
    // Overflow of the waiting text is not news: it waits for the next text after delivery. More than one waiting text
    // (state from before ISC-87) is merged the same way.
    const waitingTexts = undeliveredTexts();
    const news = records.filter((r) => needsAsking(r) && textable(r) && !inLiveText(r) && (!opts.only || r.id === opts.only)
      && waitingTexts.every((t) => Date.parse(r.at) > Date.parse(t.event.ts)));
    if (waitingTexts.length > 1 || (waitingTexts.length === 1 && news.length > 0)) {
      for (const t of waitingTexts) {
        t.cancelled = "merged";
        for (const r of members(t)) if (!r.delivered) { delete r.event; delete r.sent_at; }
      }
      saveState(st, statePath); // the cancellation is durable before the replacement is emitted
      log(`merged ${waitingTexts.length} waiting text(s) with ${news.length} new escalation(s) into one replacement`);
    }
    for (const t of frozen.slice()) {
      if (t.cancelled) continue;
      const waiting = members(t).filter((r) => !r.delivered && !r.dropped);
      if (!waiting.length || waiting.every((r) => !!r.event) || opts.only && !waiting.some((r) => r.id === opts.only)) continue;
      const id = randomUUID();
      sendText(t, { ...t.event, id, ts: new Date(now()).toISOString(), dedup_key: `achilles:escalation:${id}` });
    }
    const queue = records
      .filter((r) => !r.delivered && !r.event && !r.dropped && textable(r) && (!opts.only || r.id === opts.only)
        && !frozen.some((t) => !t.cancelled && t.entries.some((e) => e.id === r.id && e.kind === r.kind && e.at === r.at)))
      .sort((a, b) => bySeverityThenAge(entryOf.get(a.id)!, entryOf.get(b.id)!));
    // ISC-87: a new text only when none is waiting; what is queued meanwhile goes out after delivery (or merged, above).
    if (queue.length && undeliveredTexts().length === 0) {
      const t = composeText(queue);
      sendText(t, t.event);
    }
    result.overflow = records.filter((r) => !r.delivered && !r.event && !r.dropped && textable(r) && (!opts.only || r.id === opts.only)).map((r) => r.id);

    // 5. One Vigil line per run with its counts (ISC-61); medium when this run and the two runs before it that
    // attempted anything all worked entries and got nowhere. Runs with no attempts (most hourly urgent passes)
    // neither count toward the three nor break the streak, so the history keeps attempting runs only.
    const runs = (st.runs ??= []);
    if (result.counts.attempts > 0) runs.push({ at: new Date(now()).toISOString(), pass: passId, ...result.counts });
    st.runs = runs.filter((r) => r.attempts > 0).slice(-RUN_HISTORY);
    const last3 = st.runs.slice(-3);
    const stuck = result.counts.attempts > 0 && last3.length === 3 && last3.every((r) => r.patches === 0 && r.escalations === 0);
    st.escalations = records;
    saveState(st, statePath);
    outcome = { severity: stuck ? "medium" : "info", summary: stuck ? "Three runs in a row worked entries without producing a patch or an escalation." : `Pass ${passId}: ${result.texted.length} texted, ${result.overflow.length} waiting.` };
    return result;
  } catch (err) {
    // Persist partial progress while the lock is still held; the caller still exits non-zero (ISC-67).
    crashOutcome(err);
    throw err;
  } finally {
    try { release?.(); }
    catch (err) { crashOutcome(err); throw err; }
    finally { if (outcome) runLine(outcome.severity, outcome.summary, outcome.extra, outcome.key); }
  }
}

async function defaultWorkRepo(): Promise<string | null> {
  try {
    const { loadWorkConfig } = (await import(join(CLAUDE, "hooks/lib/work-config.ts"))) as { loadWorkConfig: () => { repo: string | null } };
    return loadWorkConfig().repo;
  } catch { return null; }
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const val = (n: string) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const known = new Set(["--dry-run", "--only", "--max", "--json", "--urgent", "--acceptance"]);
  const unknown = a.filter((x, i) => x.startsWith("--") && !known.has(x) && !(i > 0 && ["--only", "--max", "--acceptance"].includes(a[i - 1]!)));
  if (unknown.length) { console.error(`[achilles-remediate] unknown flag ${unknown.join(" ")}; refusing to run a full pass on a typo`); process.exit(2); }
  if (a.includes("--acceptance")) {
    const ids = (val("--acceptance") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const r = acceptance(ids, loadRegistry().entries, loadState());
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
  remediate({ dryRun: a.includes("--dry-run"), only: val("--only"), max: val("--max") ? Number(val("--max")) : undefined, json: a.includes("--json"), urgent: a.includes("--urgent") })
    .then((r) => { console.log(JSON.stringify(r, null, a.includes("--json") ? 2 : 0)); process.exit(r.exit); })
    .catch((err) => { console.error(`[achilles-remediate] fatal: ${String(err)}`); process.exit(1); });
}
