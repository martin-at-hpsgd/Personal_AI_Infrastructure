#!/usr/bin/env bun
/**
 * @version 1.6.2
 * CrossVendorAudit.ts — Astra audit-mode tool (cross-vendor audit; formerly the Forge agent's audit mode, before that Cato)
 *
 * Bundles ISA + artifacts + tool-activity tail, pipes to
 * Assay's agentic judge (LIFEOS/ASSAY/AgenticJudge.ts: CROSS_VENDOR.sol from models.ts since 2026-10-12, read-only,
 * ephemeral), with the verdict JSON schema-enforced by the CLI (strict: additionalProperties:false,
 * all props required). Runs the judge's doctor preflight. Parses the JSON
 * response, appends to MEMORY/VERIFICATION/cato-findings.jsonl (filename kept for
 * track-record continuity), emits parsed JSON to stdout.
 *
 * Usage:
 *   bun CrossVendorAudit.ts --slug <slug> [--artifact <path>]...
 *   bun CrossVendorAudit.ts --payload <emitted LifeOS dir> [--focus <payload-relative path>]...
 *   bun CrossVendorAudit.ts --shard <staged shard dir> [--slug <slug>] [--shard-id <id>] [--shard-hash <sha256>]
 *   Any mode takes --strict: exit 1 unless the printed verdict is "pass" (skipped, concerns, fail and error all
 *   exit non-zero). Without it the exit code stays 0 on any parsed verdict, as before.
 *
 * --shard audits ONE slice of a release delta (private-maintenance-tooling-not-included/Release/audit.ts stages each as
 * <audits>/shards/<id>/payload/{00-context,NN-delta}.txt beside a .shadow-state.json carrying shardId and
 * shardHash). <dir> may be the shard dir or its payload/ subdir. The shard prompt asks only for leaks and
 * install-breakers in the slice and forbids reporting out-of-slice files as missing; the shardHash is
 * re-derived from the delta bytes and must match the recorded one; the verdict echoes shardId and shardHash.
 *
 * Algorithm Rule 2a (v3.27-era). Elected during VERIFY on high-stakes runs.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, appendFile, mkdir, stat } from "node:fs/promises";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { codexHomesRoot } from "./lib/CacheDir";
import { confinedPath } from "./lib/Boundary";
import { invariant } from "./Invariant";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { CROSS_VENDOR } from "./models";
import { agenticArgs, agenticJudge, agenticPreflight, buildIsolatedHome, isolatedHomePath, removeIsolatedHome, removeIsolatedHomeSync, resolveAgenticBin } from "../ASSAY/AgenticJudge";
import { getLifeosDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

const HOME = homedir();
const LIFEOS_DIR = getLifeosDir();
const WORK_DIR = join(LIFEOS_DIR, "MEMORY", "WORK");
const FINDINGS_LOG = join(LIFEOS_DIR, "MEMORY", "VERIFICATION", "cato-findings.jsonl");
const TOOL_ACTIVITY_LOG = join(LIFEOS_DIR, "MEMORY", "OBSERVABILITY", "tool-activity.jsonl");
// The judge CLI is resolved by Assay's AgenticJudge (env override, PATH, common install dirs; public issue #1500).
const CODEX_BIN = resolveAgenticBin();

// ISOLATED CODEX HOME — the fix for a lane that was silently not cross-vendor
// (2026-07-25). The user's real $CODEX_HOME hosts a SEPARATE LifeOS-for-Codex
// installation: `AGENTS.md` tells codex to load that install's DA identity and
// system prompt, `hooks.json` has a session_start injector, and the same file
// carries "Never read from ... any LifeOS installation outside ~/.codex".
// Consequences, both reproduced directly before this was written: the auditor
// answered in the DA's persona complete with the LifeOS banner — so it shared
// exactly the Anthropic-family framing the audit exists to escape — and it
// DECLINED to read the ~/.claude artifact it was pointed at. A run like that
// still returns a verdict, which is the dangerous part: "cross-vendor pass" on
// an audit that never read the work and was not independent.
//
// CODEX_HOME is the one lever that drops AGENTS.md, hooks, skills and config in
// a single move. Auth is the only thing worth keeping, and it is SYMLINKED, never
// copied — no credential is duplicated onto disk. Verified: under the isolated
// home the same probe returns the file contents with no persona and no refusal.
// Config-key overrides were tried first and are NOT sufficient — disabling
// `model_instructions_file` + `features.hooks` removed the persona but the
// refusal survived via the still-loaded skills tree.
// Under the 0700 cache root, never tmpdir(): the home holds the audit's session rollouts (round 22).
/** A distinct isolated Codex home for each audit process. */
export function auditCodexHome(pid = process.pid, homesRoot = codexHomesRoot()): string {
  return isolatedHomePath("audit", pid, homesRoot);
}

const removeCodexHome = removeIsolatedHome;
const removeCodexHomeSync = removeIsolatedHomeSync;

/**
 * Builds one process's isolated Codex home without touching another audit's home.
 * The fixed-name directory is only a stale pre-1.4.30 artifact and is safe to remove.
 */
export async function buildIsolatedCodexHome(
  home = auditCodexHome(),
  homesRoot = codexHomesRoot(),
  realAuth = join(HOME, ".codex", "auth.json"),
): Promise<string> {
  await removeCodexHome(join(homesRoot, "audit"));
  // Absent auth.json = the user authenticates codex via OPENAI_API_KEY, which
  // the env carries anyway. Nothing to link; the isolated home still works.
  return buildIsolatedHome(home, realAuth);
}

async function cleanupIsolatedCodexHome(home: string): Promise<void> {
  try { await removeCodexHome(home); } catch { /* best effort */ }
}

function installExitCleanup(home: string): () => void {
  const cleanup = () => {
    try { removeCodexHomeSync(home); } catch { /* best effort */ }
  };
  process.once("exit", cleanup);
  return () => process.off("exit", cleanup);
}

// Release bundles carry the full payload manifest (~2.6k paths) plus focus files; 80k left no
// room for a 98 KB retirement manifest (8.1.3 cut). Still far under the audit model's context.
const BUNDLE_TOKEN_CAP = 120_000;
const CHARS_PER_TOKEN = 4; // rough estimate for bundle sizing
const BUNDLE_CHAR_CAP = BUNDLE_TOKEN_CAP * CHARS_PER_TOKEN;
const CODEX_TIMEOUT_MS = 300_000;
const TOOL_ACTIVITY_TAIL_LINES = 200;
const ARTIFACT_PER_FILE_CAP = 30_000 * CHARS_PER_TOKEN;
const VERDICT_SCHEMA_PATH = join(LIFEOS_DIR, "MEMORY", "VERIFICATION", "audit-verdict.schema.json");

// codex --output-schema enforces OpenAI strict structured-output rules: EVERY
// object needs "additionalProperties": false AND every property in "required"
// (optional fields become nullable via a type-union, never omitted). A permissive
// schema returns HTTP 400 invalid_json_schema and the audit silently skips — so
// this is deliberately strict. Mirrors the AuditResponse shape the model emits.
const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "criticality", "findings", "blind_spots_surfaced", "model_used", "tokens_used"],
  properties: {
    verdict: { type: "string", enum: ["pass", "concerns", "fail"] },
    criticality: { type: ["string", "null"], enum: ["high", "medium", "low", null] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "isc_ref", "issue", "evidence"],
        properties: {
          severity: { type: "string", enum: ["critical", "warning", "info"] },
          isc_ref: { type: ["string", "null"] },
          issue: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
    blind_spots_surfaced: { type: "array", items: { type: "string" } },
    model_used: { type: "string" },
    tokens_used: { type: "integer" },
  },
} as const;

export const AUDIT_PROMPT = `You are an independent cross-vendor auditor. The Claude-family executor and reviewer have already signed off on this work. Your job is to find what THEY missed — specifically Anthropic-family blind spots they share (format conventions, API contract readings, RLHF preferences, constitutional biases).

Audit this ISA against its ISC criteria. For each criterion:
 1. Is there concrete evidence of completion in the artifacts?
 2. Is the evidence consistent with the stated claim?
 3. Are there failure modes the same-family reviewers would share that are present here?

Signal over noise. If there is nothing to flag, say so explicitly with "findings": []. Do not manufacture concerns. Your credibility depends on surfacing real Anthropic-family blind spots, not on inflating finding counts.

Output ONLY this JSON on one line, no markdown, no prose, no preamble:

{"verdict":"pass|concerns|fail","criticality":"high|medium|low","findings":[{"severity":"critical|warning|info","isc_ref":"ISC-N or null","issue":"...","evidence":"..."}],"blind_spots_surfaced":["..."],"model_used":"${CROSS_VENDOR.sol}","tokens_used":0}`;

export const RELEASE_AUDIT_PROMPT = `You are an independent cross-vendor auditor for a public software release. The Claude-family executor, a full set of deterministic security gates, and a Claude-family reviewer have already signed off. Your job is to find what THEY missed — Anthropic-family blind spots they share.

The bundle contains: the gate record (.shadow-state.json), a file manifest of the shipped payload, and the full text of the highest-risk and recently-changed files. Audit against these five criteria:
 1. Identity/secret leakage beyond the known-benign class (public voice IDs, bot handles, model IDs, and public repo URLs are NOT findings).
 2. Dangling internal references — a shipped file referencing a path absent from the manifest.
 3. Retired capabilities presented as live.
 4. Install coherence — version strings consistent across the installer copies shown.
 5. Reputation: reputational exposure a hostile journalist would quote about the publisher (a well-known security researcher): deception or impersonation (spoofed clients, user agents or crawlers, an AI voice or agent allowed to pose as human), evading terms of service, rate limits or bot checks, paid or AI-ghostwritten content presented as independent, people-lookup or surveillance without consent guardrails, coded or biased framing (for example demographics offered as an explanation of crime), compliance or safety claims the shipped code does not enforce, and crude language or snark about named people or companies. Quote the line; a neutral capability with its guardrails stated is not a finding.

Known-benign by design (NOT findings): the installer's LIFEOS_REPO="\${LIFEOS_REPO:-OWNER/REPO}" placeholder in BOTH install.sh copies — this cut is private staging; the publish intent (CreateRelease Step 1) substitutes the real owner/name before anything reaches the public repo, and the served installer at the public URL carries the substituted value. Also benign: references to private underscore-skills or private paths that carry the literal qualifier "NOT in the public release payload" with skip-if-absent guidance — that banner is the release gates' sanctioned convention for documenting an optional private integration, not an escaped dangling reference.

Signal over noise. If there is nothing to flag, say so explicitly with "findings": []. Do not manufacture concerns.

Set each finding's isc_ref to the criterion it falls under: "criterion-1" (a leak), "criterion-2" (breaks a stranger's install in one of the ways criterion 2 lists), "criterion-3" (reputation), or "other" for a real defect outside all three (a runtime bug in one feature, a doc slip). A leak or an install breaker makes the verdict fail; reputation and other findings alone make it concerns.

Output ONLY this JSON on one line, no markdown, no prose, no preamble:

{"verdict":"pass|concerns|fail","criticality":"high|medium|low","findings":[{"severity":"critical|warning|info","isc_ref":"criterion-1|criterion-2|criterion-3|other","issue":"...","evidence":"..."}],"blind_spots_surfaced":["..."],"model_used":"<model>","tokens_used":0}`;

// Always-bundled high-risk surfaces of a release payload, relative to its root.
// These are where the two proven cross-vendor escapes lived (nested installer
// copies, template files) plus the contract files every install executes.
const RELEASE_CORE_FILES = [
  "SKILL.md",
  "INSTALL.md",
  "install/install.sh",
  "install/CLAUDE.template.md",
  "install/skills/LifeOS/SKILL.md",
  "install/skills/LifeOS/install/install.sh",
  "install/skills/LifeOS/install/CLAUDE.template.md",
];

function walkPayload(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      // lstat, never stat: a symlinked directory is listed as an entry but not
      // descended, so a link out of the payload cannot pull outside names or bytes in.
      if (lstatSync(full).isDirectory()) stack.push(full);
      else out.push(relative(root, full));
    }
  }
  return out.sort();
}

/**
 * Absolute path of a payload-relative file, proven to stay inside the payload.
 * Rejects absolute paths and `..` escapes lexically, then realpath-checks the
 * result so a symlink (file or directory component) cannot leave the canonical
 * payload root. Returns null when the file does not exist; throws when it
 * exists but resolves outside the root.
 */
export function confinedPayloadPath(payloadDir: string, rel: string): string | null {
  if (!rel || isAbsolute(rel) || rel.includes("\0")) throw new Error(`payload path must be relative and non-empty: ${JSON.stringify(rel)}`);
  const lexRoot = resolve(payloadDir);
  const lexFull = resolve(lexRoot, rel);
  if (lexFull !== lexRoot && !lexFull.startsWith(lexRoot + sep)) throw new Error(`payload path escapes the payload root: ${rel}`);
  if (!existsSync(lexFull) && !isDanglingLink(lexFull)) return null;
  let realFull: string;
  try { realFull = realpathSync(lexFull); }
  catch { throw new Error(`payload path cannot be resolved (dangling symlink?): ${rel}`); }
  const realRoot = realpathSync(lexRoot);
  if (realFull !== realRoot && !realFull.startsWith(realRoot + sep)) throw new Error(`payload path resolves outside the payload root via a symlink: ${rel}`);
  return realFull;
}

function isDanglingLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

export async function buildReleaseBundle(payloadDir: string, focus: string[]): Promise<string> {
  const files = walkPayload(payloadDir);
  const manifest = files.map((f) => `${f}`).join("\n");
  const gateRecordPath = join(resolve(payloadDir, ".."), ".shadow-state.json");
  const gateRecord = existsSync(gateRecordPath) ? await readFile(gateRecordPath, "utf8") : "(gate record not found)";

  const sections: string[] = [
    "===== GATE RECORD (.shadow-state.json — independently inspectable; the build gates + emit gates recorded here) =====",
    gateRecord.slice(0, 12_000),
    "",
    `===== PAYLOAD MANIFEST (${files.length} files, sorted, COMPLETE — before reporting any file as absent, re-search this manifest for its exact basename) =====`,
    manifest,
    "",
  ];
  const bundled = new Set<string>();
  for (const rel of [...RELEASE_CORE_FILES, ...focus]) {
    if (bundled.has(rel)) continue;
    const full = confinedPayloadPath(payloadDir, rel); // throws on escape; null when absent
    if (full === null) { sections.push(`===== FILE ${rel} =====`, "(absent from payload)", ""); continue; }
    bundled.add(rel);
    // Unreadable or over-cap files block the audit: a pass on a bundle with a
    // silently cut or missing file would be a pass on evidence nobody sent.
    let text: string;
    try { text = await readFile(full, "utf8"); }
    catch (err) { throw new Error(`release bundle cannot read ${rel}: ${(err as Error).message}`); }
    if (text.length > ARTIFACT_PER_FILE_CAP) throw new Error(`release file ${rel} is ${text.length} chars, over the ${ARTIFACT_PER_FILE_CAP} per-file cap; the audit would truncate it`);
    sections.push(`===== FILE ${rel} =====`, text, "");
  }
  sections.push("===== AUDIT INSTRUCTIONS =====", RELEASE_AUDIT_PROMPT);
  const bundle = sections.join("\n");
  // Truncation would cut the focus files, which sit last; fail instead.
  if (bundle.length > BUNDLE_CHAR_CAP) throw new Error(`release bundle is ${bundle.length} chars, over the ${BUNDLE_CHAR_CAP} cap; split the --focus files across runs`);
  return bundle;
}

/** Why a release-mode audit cannot honestly run with these inputs, or null. */
export function releaseInputError(payloadDir: string, focus: string[], artifacts: string[]): string | null {
  if (artifacts.length) return `--artifact is ignored in --payload mode; pass payload-relative files with --focus instead: ${artifacts.join(", ")}`;
  const absent: string[] = [];
  for (const rel of focus) {
    try { if (confinedPayloadPath(payloadDir, rel) === null) absent.push(rel); }
    catch (err) { return `--focus path rejected: ${(err as Error).message}`; }
  }
  if (absent.length) return `--focus takes payload-relative file paths; not found in the payload: ${absent.join(" | ")}`;
  return null;
}

// ---- shard mode ------------------------------------------------------------------------------------------------
// One slice of a release delta (private-maintenance-tooling-not-included/Release/audit.ts stages it). The whole-payload prompt above asks
// about dangling references against the full manifest, which a delta slice cannot answer; this prompt audits only
// what the slice shows.
export const SHARD_AUDIT_PROMPT = `You are an independent cross-vendor auditor for a public software release. The Claude-family executor, a full set of deterministic security gates, and a Claude-family reviewer have already signed off. Your job is to find what THEY missed — Anthropic-family blind spots they share.

This bundle is ONE SLICE (a shard) of the release delta against the last public release. ADDED files appear in full, MODIFIED files appear as unified diffs (the + and - lines are the change; unmarked lines are unchanged context that already shipped publicly), REMOVED and MODE-CHANGE entries are listed, and BINARY entries show only a hash. Audit only what this slice shows, against these three criteria:
 1. Leaks of private data that must never reach a public repo: personal identity (real names, email addresses, phone numbers, street addresses, family or household details), customer, sponsor, or contact data, secrets (API keys, tokens, passwords, private keys, credentials of any shape), and private infrastructure (internal hostnames or IPs, private repo URLs, account or tenant IDs, tunnel names, home-directory paths naming a real user).
 2. Code or docs that would break a stranger's install: hardcoded paths, usernames, or machine assumptions that only hold on the owner's machine, required references to private skills or private paths, unfilled or half-filled placeholders, and version strings that disagree inside this slice.
 3. Reputation: reputational exposure a hostile journalist would quote about the publisher (a well-known security researcher): deception or impersonation (spoofed clients, user agents or crawlers, an AI voice or agent allowed to pose as human), evading terms of service, rate limits or bot checks, paid or AI-ghostwritten content presented as independent, people-lookup or surveillance without consent guardrails, coded or biased framing (for example demographics offered as an explanation of crime), compliance or safety claims the shipped code does not enforce, and crude language or snark about named people or companies. Quote the line; a neutral capability with its guardrails stated is not a finding.

Files outside this slice exist and are not shown. Do NOT report a path as missing, absent, or dangling merely because it is not in this slice; a reference to a file you cannot see is not a finding. Report a context line of a diff only if it is plainly a leak.

Known-benign by design (NOT findings): public voice IDs, bot handles, model IDs, and public repo URLs; the installer's LIFEOS_REPO="\${LIFEOS_REPO:-OWNER/REPO}" placeholder (this cut is private staging; the publish step substitutes the real owner and name); and references to private underscore-skills or private paths that carry the literal qualifier "NOT in the public release payload" with skip-if-absent guidance.

Signal over noise. If there is nothing to flag, say so explicitly with "findings": []. Do not manufacture concerns.

Set each finding's isc_ref to the criterion it falls under: "criterion-1" (a leak), "criterion-2" (breaks a stranger's install in one of the ways criterion 2 lists), "criterion-3" (reputation), or "other" for a real defect outside all three (a runtime bug in one feature, a doc slip). A leak or an install breaker makes the verdict fail; reputation and other findings alone make it concerns.

Output ONLY this JSON on one line, no markdown, no prose, no preamble:

{"verdict":"pass|concerns|fail","criticality":"high|medium|low","findings":[{"severity":"critical|warning|info","isc_ref":"criterion-1|criterion-2|criterion-3|other","issue":"...","evidence":"..."}],"blind_spots_surfaced":["..."],"model_used":"<model>","tokens_used":0}`;

const SHARD_DELTA_RE = /^\d+-delta\.txt$/;
const SHARD_ID_RE = /^[A-Za-z0-9._~+-]{1,160}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export interface ShardInput {
  shardId: string;
  /** sha256 of the delta files joined with "\n": the same hash audit.ts records, re-derived from the bytes. */
  shardHash: string;
  bundle: string;
  deltaFiles: number;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

/**
 * Reads a staged shard and builds its audit bundle. Throws a plain Error naming the problem when the shard
 * cannot be audited honestly: missing dir, no delta files, an unsafe id, a recorded shardHash that does not
 * match the bytes, a file the per-file cap would silently slice, or a bundle over the cap.
 */
export function prepareShard(shardDir: string, overrides: { shardId?: string; shardHash?: string } = {}): ShardInput {
  const given = resolve(shardDir);
  if (!existsSync(given) || !statSync(given).isDirectory()) throw new Error(`shard dir not found: ${shardDir}`);
  const filesDir = existsSync(join(given, "payload")) && statSync(join(given, "payload")).isDirectory() ? join(given, "payload") : given;
  const names = readdirSync(filesDir).filter((n) => n.endsWith(".txt")).sort();
  const deltaNames = names.filter((n) => SHARD_DELTA_RE.test(n));
  if (!deltaNames.length) throw new Error(`no NN-delta.txt files in ${filesDir}; nothing to audit`);
  const read = (n: string): string => {
    const text = readFileSync(join(filesDir, n), "utf8");
    // A longer file would be silently sliced by the per-file cap and audited incompletely; refuse instead.
    if (text.length > ARTIFACT_PER_FILE_CAP) throw new Error(`shard file ${n} is ${text.length} chars, over the ${ARTIFACT_PER_FILE_CAP} per-file cap; re-shard`);
    return text;
  };
  const context = names.includes("00-context.txt") ? read("00-context.txt") : "";
  const deltas = deltaNames.map((n) => ({ name: n, text: read(n) }));
  const shardHash = createHash("sha256").update(deltas.map((d) => d.text).join("\n")).digest("hex");

  const state = [join(filesDir, ".shadow-state.json"), join(filesDir, "..", ".shadow-state.json")].map(readJsonObject).find((o) => o) ?? {};
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  const ctxId = /^SHARD (\S+) \(/m.exec(context)?.[1];
  const shardId = overrides.shardId ?? str(state.shardId) ?? ctxId;
  if (!shardId || !SHARD_ID_RE.test(shardId)) throw new Error(`shard id is missing or unsafe (${JSON.stringify(shardId)}); pass --shard-id or stage .shadow-state.json`);
  if (ctxId && ctxId !== shardId) throw new Error(`shard id ${shardId} disagrees with 00-context.txt (${ctxId})`);
  const declared = overrides.shardHash ?? str(state.shardHash);
  if (declared !== undefined && !SHA256_RE.test(declared)) throw new Error(`recorded shardHash is not a sha256: ${declared}`);
  if (declared !== undefined && declared !== shardHash) throw new Error(`shardHash mismatch: recorded ${declared.slice(0, 12)}, delta bytes hash to ${shardHash.slice(0, 12)}; the staged shard changed after it was recorded`);

  const sections: string[] = [
    "===== SHARD =====",
    `shardId: ${shardId}`,
    `shardHash: ${shardHash}`,
    `delta files: ${deltas.length}`,
    "",
  ];
  if (context) sections.push("===== SHARD CONTEXT =====", context, "");
  for (const d of deltas) sections.push(`===== DELTA ${d.name} =====`, d.text, "");
  sections.push("===== AUDIT INSTRUCTIONS =====", SHARD_AUDIT_PROMPT);
  const bundle = sections.join("\n");
  // Truncation would cut the instructions, which sit last; fail instead.
  if (bundle.length > BUNDLE_CHAR_CAP) throw new Error(`shard bundle is ${bundle.length} chars, over the ${BUNDLE_CHAR_CAP} cap; re-shard`);
  return { shardId, shardHash, bundle, deltaFiles: deltas.length };
}

type CodexRun = { stdout: string; stderr: string; code: number | null };

/** Runs the shard bundle through `runner` (the codex call; stubbed in tests) and stamps shardId and shardHash on the verdict. */
export async function auditShard(shard: ShardInput, runner: (bundle: string) => Promise<CodexRun>): Promise<AuditResponse & { shardId: string; shardHash: string }> {
  const { stdout, stderr, code } = await runner(shard.bundle);
  let resp: AuditResponse;
  if (code === 124) resp = { verdict: "skipped", reason: `codex timeout at ${CODEX_TIMEOUT_MS / 1000}s` };
  else if (code !== 0) resp = { verdict: "skipped", reason: `codex exit ${code}: ${stderr.slice(0, 200)}` };
  else {
    resp = extractJSON(stdout);
    if (resp.tokens_used && !resp.cost_usd_est) resp.cost_usd_est = estimateCost(resp.tokens_used);
  }
  // Stamped last: the echoed ids come from the staged shard, never from model output.
  return { ...resp, shardId: shard.shardId, shardHash: shard.shardHash };
}

interface Args {
  slug: string;
  /** Extra files to bundle beyond the ISA's `## Decisions` references. */
  extraArtifacts: string[];
  /** Release mode: audit an emitted payload directory instead of an ISA. */
  payload?: string;
  /** Release mode: payload-relative files to bundle in full (the cut's delta). */
  focus: string[];
  /** Shard mode: a staged release-delta shard dir (see the header). */
  shard?: string;
  shardId?: string;
  shardHash?: string;
}

interface AuditResponse {
  verdict: "pass" | "concerns" | "fail" | "skipped" | "error";
  criticality?: "high" | "medium" | "low";
  findings?: Array<{ severity: string; isc_ref: string | null; issue: string; evidence: string }>;
  blind_spots_surfaced?: string[];
  model_used?: string;
  tokens_used?: number;
  cost_usd_est?: number;
  reason?: string;
  /** Source files actually bundled for the auditor. 0 means the verdict rests on
   *  the ISA text alone. public issue #1716, @xmasyx */
  artifacts_bundled?: number;
  /** Why a model "pass" was downgraded: the evidence bundle was missing, cut or empty. */
  incomplete_evidence?: string[];
  override_note?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { extraArtifacts: [], focus: [] };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--slug") args.slug = argv[++i];
    // --artifact may repeat. The `## Decisions` scrape only finds files the ISA
    // happens to name in backticks, which is fine for a code change and useless
    // for a release cut — the thing under audit there is a payload the ISA never
    // enumerates. This lets the caller point the audit at what actually shipped.
    else if (argv[i] === "--artifact") (args.extraArtifacts as string[]).push(argv[++i]);
    // Release mode: --payload <emitted LifeOS dir> [--focus <payload-relative path>]...
    // Replaces the agent-wrapper dispatch for release cuts (2026-08-03): the bundle
    // rides stdin so codex never reads the filesystem — no staged copies, no
    // path-isolation refusals, no mailbox loops. One bounded call, one verdict.
    else if (argv[i] === "--payload") args.payload = argv[++i];
    else if (argv[i] === "--focus") (args.focus as string[]).push(argv[++i]);
    else if (argv[i] === "--shard") args.shard = argv[++i];
    else if (argv[i] === "--shard-id") args.shardId = argv[++i];
    else if (argv[i] === "--shard-hash") args.shardHash = argv[++i];
  }
  if (args.shard && args.payload) throw new Error("--shard and --payload are separate modes; pass one");
  if (args.payload && !args.slug) args.slug = `release-${resolve(args.payload).split("/").filter(Boolean).slice(-2, -1)[0] ?? "unknown"}`;
  if (!args.slug && !args.shard) throw new Error("--slug required (or --payload <dir> or --shard <dir>)");
  return args as Args;
}

async function readISA(slug: string): Promise<string> {
  // Read order: ISA.md (canonical, v4.1.0+) → PRD.md (legacy alias, retired at v4.2.0).
  const dir = join(WORK_DIR, slug);
  const isaPath = join(dir, "ISA.md");
  const legacyPath = join(dir, "PRD.md");
  const path = existsSync(isaPath) ? isaPath : existsSync(legacyPath) ? legacyPath : null;
  if (!path) throw new Error(`ISA not found in ${dir} (tried ISA.md and legacy PRD.md)`);
  return await readFile(path, "utf8");
}

export async function readArtifacts(
  slug: string,
  isa: string,
  extra: string[] = [],
): Promise<{ text: string; count: number; incomplete: string[] }> {
  const paths = new Set<string>();
  // Reasons the evidence is not the whole of what was asked for. A non-empty
  // list can never end in a "pass" (see evidenceGaps / downgradePassOnGaps).
  const incomplete: string[] = [];
  for (const e of extra) {
    let p = e;
    if (p.startsWith("~/")) p = join(HOME, p.slice(2));
    paths.add(resolve(p));
  }

  // Extract file paths referenced in ISA ## Decisions section.
  const decisionsMatch = isa.match(/## Decisions\n([\s\S]*?)(?=\n## |\n---|\n*$)/);
  if (decisionsMatch) {
    const decisions = decisionsMatch[1];
    // Source-language coverage: the original alternation was TS/web-only, so an
    // ISA whose Decisions cited only .swift/.py/.go files bundled ZERO source and
    // the audit still returned a verdict — a cross-vendor "pass" on the ISA text
    // alone. public issue #1716, @xmasyx
    const pathPattern =
      /`([~/][^\s`]+\.(?:ts|md|json|yaml|yml|tsx|jsx|js|txt|swift|py|rs|go|java|kt|c|h|cc|cpp|hpp|m|mm|rb|php|sh|sql|toml))`/g;
    let match;
    while ((match = pathPattern.exec(decisions))) {
      let p = match[1];
      if (p.startsWith("~/")) p = join(HOME, p.slice(2));
      paths.add(resolve(p));
    }
  }

  if (paths.size === 0) {
    return {
      text: "(no artifacts: none passed via --artifact and no file references in ## Decisions)",
      count: 0,
      incomplete: ["no source artifacts were bundled (none passed via --artifact and no file references in ## Decisions)"],
    };
  }

  const chunks: string[] = [];
  let totalChars = 0;
  for (const p of paths) {
    if (!existsSync(p)) { incomplete.push(`artifact missing: ${p}`); continue; }
    let stats;
    try { stats = await stat(p); } catch (err) { incomplete.push(`artifact unreadable: ${p} (${(err as Error).message})`); continue; }
    if (!stats.isFile()) { incomplete.push(`artifact is not a regular file: ${p}`); continue; }
    let content: string;
    try { content = await readFile(p, "utf8"); }
    catch (err) { incomplete.push(`artifact unreadable: ${p} (${(err as Error).message})`); continue; }
    if (content.length > ARTIFACT_PER_FILE_CAP) {
      incomplete.push(`artifact truncated at ${ARTIFACT_PER_FILE_CAP} chars: ${p}`);
      content = content.slice(0, ARTIFACT_PER_FILE_CAP) + "\n[TRUNCATED]";
    }
    const block = `--- FILE: ${p} ---\n${content}\n`;
    // reserve half the bundle for other sections
    if (totalChars + block.length > BUNDLE_CHAR_CAP / 2) { incomplete.push(`artifact dropped, bundle budget exhausted: ${p}`); continue; }
    chunks.push(block);
    totalChars += block.length;
  }
  if (chunks.length === 0) incomplete.push("no source artifacts were bundled (none readable)");
  return chunks.length > 0
    ? { text: chunks.join("\n"), count: chunks.length, incomplete }
    : { text: "(no readable artifacts found)", count: 0, incomplete };
}

/**
 * Evidence gaps that forbid a pass: whatever readArtifacts could not bundle in
 * full, plus a bundle the size cap trimmed after the fact.
 */
export function evidenceGaps(incomplete: string[], bundle: string): string[] {
  const gaps = [...incomplete];
  if (bundle.includes("[TRUNCATED - bundle size cap]")) gaps.push("artifacts trimmed to fit the bundle size cap");
  return gaps;
}

/** A pass over incomplete evidence is not a pass: fail closed to "concerns" and say why. */
export function downgradePassOnGaps<T extends { verdict: string }>(resp: T, gaps: string[]): T {
  if (gaps.length === 0 || resp.verdict !== "pass") return resp;
  return {
    ...resp,
    verdict: "concerns",
    incomplete_evidence: gaps,
    override_note: `verdict downgraded from pass: the audit evidence was incomplete (${gaps.slice(0, 5).join("; ")})`,
  } as T;
}

async function readToolActivityTail(slug: string): Promise<string> {
  if (!existsSync(TOOL_ACTIVITY_LOG)) return "(tool-activity.jsonl not found)";
  const content = await readFile(TOOL_ACTIVITY_LOG, "utf8");
  const lines = content.trim().split("\n");
  const recent = lines.slice(-500); // look at last 500 lines total
  const filtered = recent.filter((l) => l.includes(slug)).slice(-TOOL_ACTIVITY_TAIL_LINES);
  return filtered.length > 0 ? filtered.join("\n") : "(no tool-activity lines for this slug)";
}

// v6.6.0: extract principal_stated_goal from ISA frontmatter as a leading section
// in every bundle path, so Astra reads the literal anchor before the ISA, artifacts,
// or tool tail. Returns formatted section or empty string when absent.
function extractGoalSection(isa: string): string {
  const frontmatterMatch = isa.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return "";
  const goalLine = frontmatterMatch[1].match(/^principal_stated_goal:\s*"((?:[^"\\]|\\.)*)"/m);
  if (!goalLine || !goalLine[1]) return "";
  return [
    "===== PRINCIPAL STATED GOAL =====",
    "(v6.4.0 literal — evidence anchor, not optimization target. Audit derived content against this.)",
    goalLine[1],
    "",
  ].join("\n");
}

export function assembleBundle(isa: string, artifacts: string, toolTail: string): string {
  const goalSection = extractGoalSection(isa);
  let bundle = [
    goalSection,
    "===== ISA =====",
    isa,
    "",
    "===== OUTPUT ARTIFACTS =====",
    artifacts,
    "",
    "===== TOOL ACTIVITY TAIL =====",
    toolTail,
    "",
    "===== AUDIT INSTRUCTIONS =====",
    AUDIT_PROMPT,
  ].filter(s => s !== "").join("\n");

  // If over cap, drop tool-tail first, then trim artifacts.
  if (bundle.length > BUNDLE_CHAR_CAP) {
    bundle = [
      goalSection,
      "===== ISA =====",
      isa,
      "",
      "===== OUTPUT ARTIFACTS =====",
      artifacts,
      "",
      "===== TOOL ACTIVITY TAIL =====",
      "(dropped — bundle size cap)",
      "",
      "===== AUDIT INSTRUCTIONS =====",
      AUDIT_PROMPT,
    ].filter(s => s !== "").join("\n");
  }
  if (bundle.length > BUNDLE_CHAR_CAP) {
    const overshoot = bundle.length - BUNDLE_CHAR_CAP;
    const trimmed = artifacts.slice(0, Math.max(0, artifacts.length - overshoot - 100));
    bundle = [
      goalSection,
      "===== ISA =====",
      isa,
      "",
      "===== OUTPUT ARTIFACTS (trimmed) =====",
      trimmed + "\n[TRUNCATED - bundle size cap]",
      "",
      "===== TOOL ACTIVITY TAIL =====",
      "(dropped — bundle size cap)",
      "",
      "===== AUDIT INSTRUCTIONS =====",
      AUDIT_PROMPT,
    ].filter(s => s !== "").join("\n");
  }
  return bundle;
}

// The isolated home carries no config.toml, so codex fell back to reasoning effort
// "none" and the audit ran as a no-reasoning call. Pin the Astra lane's documented
// effort on the command line instead. public issue #2276, @christauff
export const AUDIT_REASONING_EFFORT = "low";

/** The judge CLI argv for one audit run (Assay's agentic transport, this lane's model and effort). */
export function codexExecArgs(schemaPath: string): string[] {
  return agenticArgs({ schemaPath, model: CROSS_VENDOR.sol, reasoningEffort: AUDIT_REASONING_EFFORT });
}

// The model run is Assay's AgenticJudge (read-only sandbox, ephemeral, private home, env scrub, schema enforced,
// kill timer). This keeps only the audit's own shape: the bundle goes in, a stdout/stderr/code triple comes out.
async function invokeCodex(bundle: string, schemaPath: string, auditHome: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const r = await agenticJudge({
    prompt: bundle, schemaPath, home: auditHome, bin: CODEX_BIN, model: "sol",
    reasoningEffort: AUDIT_REASONING_EFFORT, timeoutMs: CODEX_TIMEOUT_MS,
  });
  // A judge that never ran (inference disabled, no transport) has no exit code: report it as a failed exit.
  if (!r.ok && r.code === null) return { stdout: "", stderr: r.error ?? "agentic judge did not run", code: 1 };
  return { stdout: r.stdout, stderr: r.stderr, code: r.code };
}

function extractJSON(rawStdout: string): AuditResponse {
  // Codex CLI wraps output with session metadata. Find the JSON object.
  const jsonMatch = rawStdout.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (!jsonMatch) {
    return { verdict: "skipped", reason: "no JSON in codex output" };
  }
  try {
    return JSON.parse(jsonMatch[0]) as AuditResponse;
  } catch (err) {
    return { verdict: "skipped", reason: `parse error: ${(err as Error).message}` };
  }
}

function estimateCost(tokens: number): number {
  // GPT-5 class rough: $0.015/1K combined. Conservative.
  return +(tokens * 0.000015).toFixed(4);
}

/**
 * The payload-relative path a finding's path token names, or null. Only the exact path, the path re-anchored under a
 * skill the finding names, or a proven equivalent counts: the token with leading segments the carrier mangles (a
 * `~/.claude/` prefix becomes `claude/...`) stripped, keeping at least the parent directory, found as-is or under
 * `install/`. A file that merely shares the basename in another directory is never a disproof.
 * Only the named carrier manglings of the home prefix are stripped (S084, ISA 20261015-security-p1-batch2), each
 * anchored at the START of the token: `claude/` or `.claude/` (what `~/.claude/` becomes), `Users/<name>/.claude/`,
 * `home/<name>/.claude/` and `root/.claude/` (an absolute home path). A `.claude` segment anywhere else is an
 * ordinary directory, and an arbitrary leading directory is never dropped, so `a/b/Dir/f.ts` is not proven by an
 * unrelated `Dir/f.ts`. Every candidate is confined to the payload by Boundary.confinedPath, so `..` or a symlink
 * that lands outside the payload never counts as evidence of what the payload contains.
 */
export function homePrefixStripped(token: string): string | null {
  // An absolute home path (`/Users/<name>/.claude/…`) or a tilde one (`~/` plus the same layout) is the same mapping.
  const segs = token.replace(/^~\//, "").replace(/^\//, "").split("/");
  let n = 0;
  if (segs[0] === "claude" || segs[0] === ".claude") n = 1;
  else if ((segs[0] === "Users" || segs[0] === "home") && segs[1] && segs[2] === ".claude") n = 3;
  else if (segs[0] === "root" && segs[1] === ".claude") n = 2;
  return n ? segs.slice(n).join("/") : null;
}

export function resolveClaimedPath(payloadRoot: string, token: string, skills: string[]): string | null {
  const exists = (p: string) => {
    const real = confinedPath(payloadRoot, p);
    return real !== null && existsSync(real);
  };
  for (const p of [token, ...skills.map((s) => `install/skills/${s}/${token}`)]) if (exists(p)) return p;
  const rest = homePrefixStripped(token);
  // Keep at least the parent directory: a bare basename is never a disproof.
  if (rest === null || rest.split("/").length < 2) return null;
  for (const p of [rest, `install/${rest}`]) if (exists(p)) return p;
  return null;
}

/**
 * Every path a finding names, each as the WHOLE token the carrier wrote (S084 round 2, ISA
 * 20261015-security-p1-batch2). The text is split only on whitespace and on quoting, bracketing and list punctuation;
 * a token is a path claim when it holds a `/` and ends in a file extension, after a trailing sentence mark and a
 * `:line[:col]` suffix are dropped. Nothing inside a token is ever skipped: the old pattern matched a substring, so
 * `missing+lib/Boundary.ts` became the claim `lib/Boundary.ts`, which resolved, and a real absence was disproven.
 * A token with characters no payload path has simply fails to resolve, which keeps the finding standing.
 *
 * Round 3: a `#fragment` or `?query` tail (`dir/F.ts#L42`, `a/b.md?plain=1`) is cut off, as HEAD's pattern did.
 * A token that holds a `/` and a file extension but still does not end in one after that (`dir/F.ts…`,
 * `dir/F.ts~`) is never dropped: it is kept whole as a claim, so it cannot resolve and the finding stands. Dropping
 * it let a resolving path beside it carry the finding to a pass.
 */
export function claimedPathTokens(text: string): string[] {
  const out: string[] = [];
  // Sentence marks a carrier writes after a path, typographic ones included (an ellipsis, a closing curly quote).
  const SENTENCE = /[.:!?…”’]+$/;
  const LINE = /:\d+(?::\d+)?(?:[-–]\d+)?$/;
  for (const split of text.split(/[\s`"'()[\]{}<>,;|]+/)) {
    // Markdown emphasis around the token (`**dir/F.ts**`, `*dir/F.ts*.`) is markup, not part of the path (parity
    // with HEAD's pattern, which never read `*` into a path). Only the outer runs go; a `*` inside a token stays.
    const raw = split.replace(/^\*+/, "").replace(/\*+([.:!?…”’]*)$/, "$1");
    if (!raw.includes("/")) continue;
    const t = raw.replace(SENTENCE, "").replace(/[#?].*$/, "").replace(SENTENCE, "").replace(LINE, "");
    if (t.includes("/") && /\.\w{1,5}$/.test(t)) out.push(t);
    // The extension must sit in the last segment, so a bare URL host (`https://x.com/a`) stays out, as at HEAD.
    else if (/\.\w{1,5}(?!\w)/.test(raw.slice(raw.lastIndexOf("/") + 1))) out.push(raw.replace(SENTENCE, "") || raw);
  }
  return out;
}

/**
 * Every path substring the pre-S084 pattern read as a claim (final round, ISA 20261015-security-p1-batch2). The
 * absence check treats these as claims too, beside the whole tokens, so it is never looser than that pattern: a
 * path it caught inside a longer token (`dir/Missing.ts/README`, `A.ts#dir/Missing.ts`) still has to resolve.
 * Adding claims only makes a disproof harder, because every claim must resolve.
 */
export function legacyPathClaims(text: string): string[] {
  return [...text.matchAll(/[\w-]+(?:\/[\w.-]+)+\.\w{1,5}/g)].map((m) => m[0]);
}

type AbsenceFinding = { issue: string; evidence: string; disproven_paths?: string[] };

/**
 * Absence-claim post-check (7.38.2 cut): the carrier asserted a file was "missing from the manifest" that provably
 * ships. A finding is disproven only when it claims a FILE is absent from the payload and EVERY path it names
 * resolves in the payload through resolveClaimedPath; when every finding is disproven, the verdict becomes a pass
 * with an override note. Returns the number of disproven findings. Mutates `parsed` (its findings and verdict).
 */
export function markDisprovenAbsences(parsed: Pick<AuditResponse, "verdict" | "findings" | "override_note">, payloadRoot: string): number {
  const findings = (parsed.findings ?? []) as AbsenceFinding[];
  if (!findings.length) return 0;
  const ABSENCE_CLAIM = /\babsent|\bmissing|contains? no\b|includes? no\b|appears? nowhere|not (?:appear|present|in the (?:payload|manifest))/i;
  let disprovenCount = 0;
  for (const f of findings) {
    const text = `${f.issue} ${f.evidence}`;
    if (!ABSENCE_CLAIM.test(text)) continue;
    // The absence must be claimed ABOUT A FILE (Max audit, 7.39.7 cut): the
    // keyword alone also matches "X.ts is missing input validation", where the
    // absent thing is code, not a file — that finding names one path, the path
    // exists, and the whole claim got annotated disproven. Require payload-level
    // absence language, so a code-property critique never enters this path.
    // Anchored, not bare keywords (Max audit, 7.39.8 cut): bare "payload" also
    // means the HTTP sense ("missing validation of the request payload") and bare
    // "no file" matches inside "no filesystem", so a code-property critique could
    // re-enter the very path this guard closes.
    // Every alternative stays anchored to FILE-absence phrasing. A free-floating
    // `no file\b` re-opened the hole (Max audit, 7.39.9 cut): it correctly stopped
    // matching "no filesystem" but still matched code-property critiques like
    // "performs no file locking" / "no file size limit".
    if (!/(in|from|to) the (payload|manifest|shipped tree)|ships? nowhere|nowhere in the (payload|manifest|shipped tree)|no file (named|called|matching|at|with)\b/i.test(text)) continue;
    // Every path token, whole (claimedPathTokens), plus every substring the pre-S084 pattern read (legacyPathClaims),
    // so no claim that pattern made is ever dropped; relative ones are re-anchored under any install/skills/<Skill>/
    // that one of the finding's own path tokens names.
    const tokens = [...new Set([...claimedPathTokens(text), ...legacyPathClaims(text)])];
    // Any install/skills/<Skill>/ the text names, a bare directory mention included, as at HEAD (S084 parity).
    const skills = [...new Set([...text.matchAll(/install\/skills\/([\w-]+)\//g)].map((m) => m[1]))];
    // EVERY named path must resolve, not merely one (7.39.6 cut): the carrier
    // writes findings of the form "the manifest contains A but no B", and a
    // first-match rule disproved the claim using A — the file the finding
    // itself said was present — without ever testing B. Outcome happened to be
    // correct that time; the logic would have auto-passed a real absence.
    // A basename match elsewhere was removed: even a unique
    // basename in the wrong directory disproved a real absence and passed the audit.
    const resolvedPaths: string[] = [];
    let allResolved = tokens.length > 0;
    for (const t of tokens) {
      const hit = resolveClaimedPath(payloadRoot, t, skills);
      if (hit) resolvedPaths.push(hit);
      else allResolved = false;
    }
    if (allResolved) { f.disproven_paths = [...new Set(resolvedPaths)]; disprovenCount++; }
  }
  // Filesystem truth outranks a model's read of a 100K-char manifest: when every
  // finding rests on a disproven absence claim, the verdict is a pass, recorded
  // with the disproof so the override is auditable (two hallucinated-absence
  // blocks on the 7.38.2/7.38.3 cuts drove this).
  if (disprovenCount === findings.length && parsed.verdict !== "pass") {
    invariant(findings.every((f) => Array.isArray(f.disproven_paths) && f.disproven_paths.length > 0), "markDisprovenAbsences: a pass override needs a disproof on every finding");
    parsed.verdict = "pass";
    parsed.override_note =
      `verdict downgraded from concerns/fail: all ${disprovenCount} finding(s) claimed absent paths that exist in the payload (see disproven_paths)`;
  }
  return disprovenCount;
}

async function appendFinding(slug: string, response: AuditResponse, tier: string): Promise<void> {
  await mkdir(join(LIFEOS_DIR, "MEMORY", "VERIFICATION"), { recursive: true });
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    slug,
    tier,
    cato_verdict: response.verdict,
    criticality: response.criticality ?? null,
    unique_findings_count: response.findings?.length ?? 0,
    tokens: response.tokens_used ?? 0,
    cost_usd: response.cost_usd_est ?? estimateCost(response.tokens_used ?? 0),
    skipped: response.verdict === "skipped",
    reason: response.reason ?? null,
  });
  await appendFile(FINDINGS_LOG, line + "\n", "utf8");
}

function extractTier(isa: string): string {
  const m = isa.match(/^effort:\s*(\w+)/m);
  return m ? m[1] : "unknown";
}

async function writeVerdictSchema(): Promise<string> {
  await mkdir(join(LIFEOS_DIR, "MEMORY", "VERIFICATION"), { recursive: true });
  await writeFile(VERDICT_SCHEMA_PATH, JSON.stringify(VERDICT_SCHEMA), "utf8");
  return VERDICT_SCHEMA_PATH;
}

// Preflight: Assay's agenticPreflight (`codex doctor --json`, fail-open, 30s cap).
const codexDoctor = (auditHome: string) => agenticPreflight(auditHome, CODEX_BIN);

/** The last verdict this process printed; --strict turns it into the exit code. */
let emittedVerdict: string | undefined;
function emit(resp: { verdict: string }): void {
  emittedVerdict = resp.verdict;
  console.log(JSON.stringify(resp));
}

/**
 * --strict exit code: 0 only for a printed "pass". skipped, concerns, fail, error and no verdict at all exit 1,
 * so a caller that reads only the exit code can never take a skipped audit for a pass. A non-zero code stays.
 */
export function strictExitCode(code: number, verdict: string | undefined): number {
  if (code !== 0) return code;
  return verdict === "pass" ? 0 : 1;
}

async function main(): Promise<number> {
  const code = await run();
  return process.argv.includes("--strict") ? strictExitCode(code, emittedVerdict) : code;
}

async function run(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(JSON.stringify({ verdict: "error", reason: (err as Error).message }));
    return 2;
  }

  // Shard mode: validate and hash the staged shard before any codex setup, so a bad shard is a deterministic
  // input error (exit 1) and never costs a model call.
  let shardInput: ShardInput | null = null;
  if (args.shard) {
    try {
      if (args.focus.length || args.extraArtifacts.length) throw new Error("--focus and --artifact are not used in --shard mode; the shard dir is the whole input");
      shardInput = prepareShard(args.shard, { shardId: args.shardId, shardHash: args.shardHash });
    } catch (err) {
      emit({ verdict: "error", reason: (err as Error).message });
      return 1;
    }
    args.slug = args.slug || `release-shard-${shardInput.shardId}`;
  }
  const stamp = <T extends object>(r: T): T => (shardInput ? { ...r, shardId: shardInput.shardId, shardHash: shardInput.shardHash } : r);

  if (!existsSync(CODEX_BIN)) {
    const resp = stamp({ verdict: "skipped" as const, reason: "codex CLI not found on PATH, $CODEX_BIN, or common install dirs" });
    await appendFinding(args.slug, resp, "unknown");
    emit(resp);
    return 0;
  }

  // Reject invalid release inputs before creating an isolated home. Besides
  // avoiding needless setup, this gives callers deterministic input errors
  // without requiring a usable Codex runtime.
  if (args.payload) {
    if (!existsSync(args.payload)) {
      emit({ verdict: "error", reason: `payload dir not found: ${args.payload}` });
      return 1;
    }
    const inputError = releaseInputError(resolve(args.payload), args.focus, args.extraArtifacts);
    if (inputError) {
      emit({ verdict: "error", reason: inputError });
      return 1;
    }
  }

  const auditHome = auditCodexHome();
  const removeExitCleanup = installExitCleanup(auditHome);
  try {
    await buildIsolatedCodexHome(auditHome);
    const doctor = await codexDoctor(auditHome);
  if (!doctor.healthy) {
    const resp = stamp({ verdict: "skipped" as const, reason: `codex doctor: ${doctor.summary}` });
    await appendFinding(args.slug, resp, "unknown");
    emit(resp);
    return 0;
  }

  if (shardInput) {
    const schemaPath = await writeVerdictSchema();
    // model_used is the model this call asked codex for, never the model's self-report: the 8.621.0-measure3 Lane A run
    // carried six spellings of one model (gpt-6, GPT-6, gpt-6-sol, gpt-6.1, gpt-6.1-sol) from the answers themselves.
    const resp = { ...(await auditShard(shardInput, (b) => invokeCodex(b, schemaPath, auditHome))), model_used: CROSS_VENDOR.sol };
    await appendFinding(args.slug, resp, "release-shard");
    emit(resp);
    return 0;
  }

  let bundle: string;
  let tier = "release";
  // Zero bundled source is invisible in the verdict otherwise: the audit reads
  // the ISA and passes. Reported alongside the verdict so a zero reads as the
  // warning it is. public issue #1716, @xmasyx
  let artifactCount: number | null = null;
  let artifactGaps: string[] = [];
  if (args.payload) {
    try {
      bundle = await buildReleaseBundle(resolve(args.payload), args.focus);
    } catch (err) {
      // An escaping path, an unreadable or over-cap file: no honest bundle exists, so no verdict.
      emit({ verdict: "error", reason: (err as Error).message });
      return 1;
    }
  } else {
    let isa: string;
    try {
      isa = await readISA(args.slug);
    } catch (err) {
      const resp = { verdict: "error" as const, reason: (err as Error).message };
      emit(resp);
      return 1;
    }
    tier = extractTier(isa);
    const [artifacts, toolTail] = await Promise.all([
      readArtifacts(args.slug, isa, args.extraArtifacts),
      readToolActivityTail(args.slug),
    ]);
    artifactCount = artifacts.count;
    bundle = assembleBundle(isa, artifacts.text, toolTail);
    artifactGaps = evidenceGaps(artifacts.incomplete, bundle);
  }

  const schemaPath = await writeVerdictSchema();
  const { stdout, stderr, code } = await invokeCodex(bundle, schemaPath, auditHome);
  if (code === 124) {
    const resp = { verdict: "skipped" as const, reason: `codex timeout at ${CODEX_TIMEOUT_MS / 1000}s` };
    await appendFinding(args.slug, resp, tier);
    emit(resp);
    return 0;
  }
  if (code !== 0) {
    const resp = { verdict: "skipped" as const, reason: `codex exit ${code}: ${stderr.slice(0, 200)}` };
    await appendFinding(args.slug, resp, tier);
    emit(resp);
    return 0;
  }

  const parsed = downgradePassOnGaps(extractJSON(stdout), artifactGaps);
  // Absence-claim post-check (7.38.2 cut): the carrier asserted a file was
  // "missing from the manifest" that provably ships — an 80K-token bundle makes
  // needle lookups unreliable, and a hallucinated absence blocks a clean cut.
  // Any finding whose evidence names a payload-relative path that DOES exist in
  // the shipped tree gets deterministically annotated as disproven.
  if (args.payload) markDisprovenAbsences(parsed, resolve(args.payload));
  if (parsed.tokens_used && !parsed.cost_usd_est) {
    parsed.cost_usd_est = estimateCost(parsed.tokens_used);
  }
  if (artifactCount !== null) parsed.artifacts_bundled = artifactCount;
  await appendFinding(args.slug, parsed, tier);
  emit(parsed);
  return 0;
  } finally {
    removeExitCleanup();
    await cleanupIsolatedCodexHome(auditHome);
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(JSON.stringify({ verdict: "error", reason: err.message }));
    process.exit(1);
  });
}
