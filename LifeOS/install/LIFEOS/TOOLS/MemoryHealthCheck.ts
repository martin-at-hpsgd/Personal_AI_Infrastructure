#!/usr/bin/env bun
/**
 * @version 1.3.19
 * MemoryHealthCheck.ts — Autonomic memory subsystem health check.
 *
 * Detects regressions that would silently kill the autonomic memory loop:
 *   - hook code files missing on disk
 *   - hooks de-registered from settings.system.json (the source of truth)
 *   - hooks de-registered from settings.json (the live runtime)
 *   - last reviewer run too stale (default 7 days)
 *   - review-state.json missing or unreadable
 *   - reviewer subprocess never fired (count is 0 historically)
 *
 * Output: JSON to stdout. Exit 0 = healthy; exit 1 = at least one warning;
 * exit 2 = at least one CRITICAL (subsystem is structurally broken).
 *
 * Appends one row per invocation to MEMORY/OBSERVABILITY/memory-health.jsonl
 * so health is observable over time, not just at point-in-time.
 *
 * Used by:
 *   - hooks/MemoryHealthGate.hook.ts (Stop chain — runs on every turn end)
 *   - CLI:  bun LIFEOS/TOOLS/MemoryHealthCheck.ts
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { invariant } from "./Invariant";
import { parseMemoryContent, read as memoryRead, BEGIN_MARKER, END_MARKER } from "./MemoryWriter";
import { assessCortexEvidence, collectCortexEvidence } from "./CortexHealth";
import { atomicWriteJSON } from "../PULSE/lib/atomic-write";
import { hookCommandScript } from "./LifeosUpgrade";
import { homedir } from "node:os";
import { getClaudeDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

// CLI script, not a library: the checks below run at module top level and end in
// process.exit. Spawn it (MemoryHealthGate does); never import it.
if (!import.meta.main) {
  throw new Error("MemoryHealthCheck.ts is a CLI script with top-level side effects — spawn it via bun, never import it.");
}

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
const CLAUDE = process.env.CORTEX_HEALTH_ROOT || getClaudeDir();
const HOOKS_DIR = join(CLAUDE, "hooks");
const TOOLS_DIR = join(CLAUDE, "LIFEOS/TOOLS");
const OBS_DIR = join(CLAUDE, "LIFEOS/MEMORY/OBSERVABILITY");

const SETTINGS_LIVE = join(CLAUDE, "settings.json");
const SETTINGS_SYSTEM = join(CLAUDE, "settings.system.json");
const REVIEW_STATE = join(OBS_DIR, "review-state.json");
const HEALTH_LOG = join(OBS_DIR, "memory-health.jsonl");
// Two artifacts, two names (public issue #1983, @spazbg): the reviewer writes one
// summary row per run to reviewer-runs.jsonl and a per-run debug DIRECTORY at
// reviewer-runs/. One constant served both, so CHECK 9 readFileSync'd the
// directory, hit EISDIR, and its empty catch turned every reviewer-streak
// finding (failing, EAT_CAP, all-skips, healthy) into silence.
const REVIEWER_RUNS_DIR = join(OBS_DIR, "reviewer-runs");
const REVIEWER_RUNS_LOG = join(OBS_DIR, "reviewer-runs.jsonl");
// Refused writes are `memory/rejected` events in the Cortex ledger (MemoryWriter.logRejectedWrite); the old
// OBSERVABILITY/memory-writes.jsonl log is retired.
const MEMORY_WRITES_LOG = join(CLAUDE, "LIFEOS/MEMORY/LEDGER/cortex-events.jsonl");

// Post-BLE layout (2026-07-11): MemoryTurnStart is the ONE registered
// UserPromptSubmit memory hook; it imports LoadMemory + MemoryDeltaSurface,
// so those must exist on disk but are no longer registered themselves.
// MemoryReviewFire (Stop) owns the whole review cadence — MemoryReviewTrigger
// is dead and pending deletion; do not require it.
const REQUIRED_HOOK_FILES = [
  "MemoryTurnStart.hook.ts",
  "LoadMemory.hook.ts",
  "MemoryDeltaSurface.hook.ts",
  "MemoryReviewFire.hook.ts",
  "MemoryHealthGate.hook.ts",
];

// The registration check keys on what must literally appear in settings.
// MemoryDeltaSurface's clobber protection (the 2026-06-06 5-day silent death,
// 787f66ef7) transfers to MemoryTurnStart, which now carries the surface: a
// clobbered MemoryTurnStart registration goes critical and nags in chat.
const REQUIRED_REGISTRATIONS = [
  "MemoryTurnStart.hook.ts",
  "MemoryReviewFire.hook.ts",
  "MemoryHealthGate.hook.ts",
];

const REQUIRED_TOOLS = [
  "MemorySystem.ts",
  "MemoryReviewer.ts",
  "MemoryWriter.ts",
  "MemoryRetriever.ts",
  "MemoryTypes.ts",
  "MemoryStatus.ts",
  "MemoryHealthCheck.ts",
  "MutationTier.ts",
];

const STALE_REVIEW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type Severity = "ok" | "warn" | "critical";

interface Finding {
  id: string;
  severity: Severity;
  message: string;
  detail?: any;
}

const findings: Finding[] = [];

function add(id: string, severity: Severity, message: string, detail?: any) {
  findings.push({ id, severity, message, ...(detail !== undefined ? { detail } : {}) });
}

// CHECK 1: hook code files present on disk
for (const h of REQUIRED_HOOK_FILES) {
  const p = join(HOOKS_DIR, h);
  if (!existsSync(p)) {
    add(`hook-file-missing:${h}`, "critical", `Required hook file missing on disk: ${h}`, { path: p });
  } else {
    add(`hook-file-present:${h}`, "ok", `Hook file present: ${h}`);
  }
}

// CHECK 2: tool files present on disk
for (const t of REQUIRED_TOOLS) {
  const p = join(TOOLS_DIR, t);
  if (!existsSync(p)) {
    add(`tool-file-missing:${t}`, "critical", `Required tool file missing on disk: ${t}`, { path: p });
  } else {
    add(`tool-file-present:${t}`, "ok", `Tool file present: ${t}`);
  }
}

// CHECK 3: hooks registered in the settings the harness actually reads.
//
// The effective runtime is settings.json (the live/merged file the harness
// loads); settings.system.json is only ONE input layer to that merge. A
// skill-payload / public install legitimately registers hooks via another layer
// — or omits the autonomic-memory loop entirely — so requiring the memory hooks
// LITERALLY in settings.system.json produced a false CRITICAL on fresh installs
// (#1402). Intent comes from settings.system.json; truth comes from the
// effective settings.json:
//   - present in the effective settings.json  -> OK, whatever layer set it.
//   - intended (in system) but MISSING from live -> CRITICAL (real clobber — the
//     2026-06-06 MemoryDeltaSurface regression this check exists to catch).
//   - not intended AND absent from live -> WARN: this install does not run the
//     autonomic memory loop (expected on a public skill install), never CRITICAL.
// Registration is read from the PARSED hooks block, never by searching the raw text: a hook name that appears in a
// deny rule, a tip or an env value must not count. A hook is registered when a command entry under one of its
// expected events runs a script whose file name is exactly the hook's.
const REGISTRATION_EVENTS: Record<string, string[]> = {
  "MemoryTurnStart.hook.ts": ["UserPromptSubmit", "SessionStart"],
  "MemoryReviewFire.hook.ts": ["Stop", "SessionEnd"],
  "MemoryHealthGate.hook.ts": ["Stop", "SessionEnd"],
};
/**
 * The script a hook command actually executes, or null when the command is not a plain invocation: the one
 * hook-command parser in LifeosUpgrade.ts. Shell control syntax makes a command opaque,
 * and so does any bun flag that does not run the script (`--help`, `--version`, `-e`, `--print`), so a command
 * that only prints usage is never attested as an active hook (S092). Re-exported for existing importers.
 */
export { hookCommandScript };
function commandRuns(command: unknown, file: string): boolean {
  const script = hookCommandScript(command);
  return script !== null && (script === file || script.endsWith("/" + file));
}
function readHookRegistrations(filePath: string): Set<string> | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    const hooks = parsed && typeof parsed === "object" ? (parsed as { hooks?: unknown }).hooks : undefined;
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return new Set();
    const found = new Set<string>();
    for (const h of REQUIRED_REGISTRATIONS) {
      for (const event of REGISTRATION_EVENTS[h] ?? []) {
        const groups = (hooks as Record<string, unknown>)[event];
        if (!Array.isArray(groups)) continue;
        for (const g of groups) {
          const entries = g && typeof g === "object" ? (g as { hooks?: unknown }).hooks : undefined;
          if (!Array.isArray(entries)) continue;
          if (entries.some((e) => e && typeof e === "object" && (e as { type?: unknown }).type === "command" && commandRuns((e as { command?: unknown }).command, h))) found.add(h);
        }
      }
    }
    return found;
  } catch {
    return null;
  }
}

const systemHooks = readHookRegistrations(SETTINGS_SYSTEM);
const liveHooks = readHookRegistrations(SETTINGS_LIVE);

if (liveHooks === null) {
  add("settings-missing:settings.json", "critical",
      `settings.json (effective runtime) not found or unreadable at ${SETTINGS_LIVE}`);
}

for (const h of REQUIRED_REGISTRATIONS) {
  const inLive = liveHooks?.has(h) ?? false;
  const intended = systemHooks?.has(h) ?? false;
  if (inLive) {
    add(`settings-hook-present:${h}`, "ok", `${h} registered in the effective settings.json.`);
  } else if (intended) {
    // Registered in the source layer but clobbered out of the live runtime.
    add(`settings-hook-missing:${h}`, "critical",
        `${h} is in settings.system.json but NOT in the effective settings.json — de-registered from the live runtime. Regression source.`,
        { system: SETTINGS_SYSTEM, live: SETTINGS_LIVE, hook: h });
  } else {
    // Not registered in any layer: this install does not run the autonomic
    // memory loop (expected on a public skill-payload install) — not a failure.
    add(`settings-hook-absent:${h}`, "warn",
        `${h} is not registered in any settings layer — autonomic memory loop not enabled on this install.`,
        { hook: h });
  }
}

// CHECK 3b: delta-surface liveness — curation writing while the chat surface
// is dead is exactly the 5-day silent failure of 2026-06-06→11. The surface
// hook touches a heartbeat file on every invocation; if the newest autonomic
// memory write is >24h newer than the heartbeat, the surface isn't running.
{
  const HEARTBEAT_FILE = join(CLAUDE, "LIFEOS/MEMORY/STATE/delta-surface-heartbeat");
  const WRITES_FILE = join(CLAUDE, "LIFEOS/MEMORY/LEDGER/cortex-events.jsonl");
  try {
    let lastWriteTs = 0;
    if (existsSync(WRITES_FILE)) {
      const tail = readFileSync(WRITES_FILE, "utf-8").trim().split("\n").slice(-50);
      for (const l of tail) {
        try {
          const r = JSON.parse(l);
          const isWriteRow = r.kind === undefined || r.kind === "memory/set";
          if (isWriteRow && r.updated_by === "MemorySystem.add" && r.ts) lastWriteTs = Math.max(lastWriteTs, Date.parse(r.ts));
        } catch { /* skip bad row */ }
      }
    }
    if (lastWriteTs > 0) {
      const hbTs = existsSync(HEARTBEAT_FILE)
        ? Date.parse(readFileSync(HEARTBEAT_FILE, "utf-8").trim())
        : 0;
      if (!hbTs || lastWriteTs - hbTs > 24 * 60 * 60 * 1000) {
        add("delta-surface-dead", "critical",
            "Curation is writing memory but MemoryDeltaSurface has not surfaced anything in >24h — chat visibility is dead (check settings registration).",
            { lastWrite: new Date(lastWriteTs).toISOString(), heartbeat: hbTs ? new Date(hbTs).toISOString() : "never" });
      } else {
        add("delta-surface-alive", "ok", "Delta surface heartbeat is current relative to memory writes.");
      }
    } else {
      add("delta-surface-no-data", "warn", "No MemorySystem.add rows in the ledger tail; delta-surface liveness cannot be judged (fresh install, rotated log, or curation never ran).");
    }
    // Absolute arm: surface and writer can die together, freezing both clocks
    // minutes apart so the relative arm passes forever (public issue #2180, @selinium).
    const hbAbs = existsSync(HEARTBEAT_FILE) ? Date.parse(readFileSync(HEARTBEAT_FILE, "utf-8").trim()) : 0;
    if (hbAbs && Date.now() - hbAbs > 72 * 60 * 60 * 1000) {
      add("delta-surface-stale", "warn", `MemoryDeltaSurface heartbeat is ${Math.round((Date.now() - hbAbs) / 3_600_000)}h old.`, { heartbeat: new Date(hbAbs).toISOString() });
    }
  } catch (err) {
    add("delta-surface-check-error", "warn", `Liveness check failed: ${(err as Error).message}`);
  }
}

// CHECK 3c: ledger fold drift (curated ⟺ folded). Committed edits and edits
// that drop nothing are adopted at the next memory write (or by CommitOwn), so
// drift that survives here is an uncommitted edit that dropped entries, or a
// broken chain. Entries-region drift or a broken hash chain is CRITICAL; byte-only drift (out-of-band frontmatter,
// e.g. the release version bumper) is a warn that self-heals at the next
// curation write. Absent ledger = pre-adoption install, not a failure.
{
  try {
    const { verifyAll, FOLD_OWNED } = await import("./CortexLedger");
    const report = verifyAll();
    if (report.status === "unverified") {
      // No ledger events means nothing was checked. That is fine on a true pre-genesis install (no fold-owned
      // memory file exists yet), but when the fold-owned files are already there an empty ledger leaves them
      // unanchored, so the invariant is silently off: warn, never "ok".
      const ledgerRoot = process.env.CORTEX_LEDGER_ROOT || getClaudeDir();
      const present = FOLD_OWNED.filter((rel: string) => existsSync(join(ledgerRoot, rel)));
      if (present.length === 0) {
        add("ledger-not-initialized", "ok", "Cortex ledger has no events yet (pre-genesis install) — fold invariant not yet armed.");
      } else {
        add("ledger-unverified", "warn",
            `Cortex ledger has no events but ${present.length} fold-owned file(s) exist (${present.join(", ")}) — curated ⟺ folded is unverified. Anchor them with bun LIFEOS/TOOLS/CortexLedger.ts genesis.`,
            { rows: report.rows, files: present });
      }
    } else if (report.status === "critical") {
      const bad = report.files.filter((f) => f.status !== "ok" && f.status !== "byte-drift");
      add("ledger-fold-drift", "critical",
          `curated ⟺ folded violated: ${bad.map((f) => `${f.file}: ${f.status}${f.detail ? ` (${f.detail})` : ""}`).join("; ")} — record the edit with bun LIFEOS/TOOLS/CortexLedger.ts adopt (commit it first, or add --force to accept dropped entries)`,
          { rows: report.rows });
    } else if (report.status === "warn") {
      add("ledger-byte-drift", "warn",
          "fold matches entries but not bytes (out-of-band frontmatter/body edit) — folds in at the next curation write.",
          { rows: report.rows });
    } else {
      add("ledger-fold-verified", "ok", `curated ⟺ folded holds (${report.rows} events).`);
    }
  } catch (err) {
    add("ledger-verify-error", "critical", `Ledger verification failed: ${(err as Error).message}`);
  }
}

// CHECK 4: review-state.json exists and is readable
let lastReviewAt: string | null = null;
if (!existsSync(REVIEW_STATE)) {
  add("state-missing", "warn", "review-state.json does not exist yet — reviewer never fired.");
} else {
  try {
    const state = JSON.parse(readFileSync(REVIEW_STATE, "utf-8"));
    lastReviewAt = state.last_review_at || null;
    add("state-readable", "ok", "review-state.json readable.", {
      turn_count: state.turn_count_since_last_review,
      last_review_at: state.last_review_at,
      pending_review: state.pending_review,
    });
  } catch (err) {
    add("state-corrupt", "critical", `review-state.json corrupt: ${(err as Error).message}`);
  }
}

// CHECK 5: last reviewer run not too stale
if (lastReviewAt) {
  const ageMs = Date.now() - new Date(lastReviewAt).getTime();
  if (ageMs > STALE_REVIEW_MS) {
    const ageDays = Math.round(ageMs / (24 * 60 * 60 * 1000));
    add("review-stale", "warn",
        `Last reviewer fire was ${ageDays} days ago — autonomic loop may be stuck.`,
        { last_review_at: lastReviewAt, age_days: ageDays });
  } else {
    add("review-fresh", "ok", `Last reviewer fire is recent (${lastReviewAt}).`);
  }
}

// CHECK 6: at least one historical reviewer run exists
if (existsSync(REVIEWER_RUNS_DIR)) {
  try {
    const runs = readdirSync(REVIEWER_RUNS_DIR).filter(r => statSync(join(REVIEWER_RUNS_DIR, r)).isDirectory());
    if (runs.length === 0) {
      add("no-historical-runs", "warn", "reviewer-runs/ directory exists but is empty — reviewer has never run successfully.");
    } else {
      add("historical-runs-present", "ok", `${runs.length} historical reviewer run(s) captured.`, { count: runs.length });
    }
  } catch (err) {
    // A check that cannot read its own evidence says so instead of going quiet (public issue #1983, @spazbg).
    add("reviewer-runs-unreadable", "warn", `CHECK 6 could not read its evidence: ${REVIEWER_RUNS_DIR}`, { path: REVIEWER_RUNS_DIR, error: err instanceof Error ? err.message : String(err) });
  }
} else {
  add("no-runs-dir", "warn", "reviewer-runs/ directory does not exist yet.");
}

// CHECK 7: memory files present
const PRINCIPAL_MEM = join(CLAUDE, "LIFEOS/USER/PRINCIPAL/PRINCIPAL_MEMORY.md");
const DA_MEM = join(CLAUDE, "LIFEOS/USER/DIGITAL_ASSISTANT/DA_MEMORY.md");
if (!existsSync(PRINCIPAL_MEM)) add("principal-memory-missing", "critical", "PRINCIPAL_MEMORY.md missing.");
else add("principal-memory-present", "ok", "PRINCIPAL_MEMORY.md present.");
if (!existsSync(DA_MEM)) add("da-memory-missing", "critical", "DA_MEMORY.md missing.");
else add("da-memory-present", "ok", "DA_MEMORY.md present.");

// CHECK 7.5: marker structural sanity — exactly one BEGIN and one END, in order.
// The corruption this catches (END-before-BEGIN plus a duplicate-END stack growing
// +1 per write) blinded every strict reader to 0 entries while cap-pressure kept
// reporting green headroom. Structural damage must be a RED signal, not silence;
// the next canonical MemoryWriter write heals it. (public PR #1593, @anikinsasha)
for (const [label, path] of [["principal", PRINCIPAL_MEM], ["da", DA_MEM]] as const) {
  if (!existsSync(path)) continue;
  try {
    const lines = readFileSync(path, "utf-8").split("\n").map(l => l.trim());
    const begins = lines.filter(l => l === BEGIN_MARKER).length;
    const ends = lines.filter(l => l === END_MARKER).length;
    const beginAt = lines.indexOf(BEGIN_MARKER);
    const endAt = lines.indexOf(END_MARKER);
    const inverted = beginAt !== -1 && endAt !== -1 && endAt < beginAt;
    if (begins === 1 && ends === 1 && !inverted) {
      add(`markers-ok:${label}`, "ok", `${label} memory markers well-formed (1 BEGIN, 1 END, in order).`);
    } else {
      add(
        `markers-corrupt:${label}`,
        "critical",
        `${label} memory markers malformed (${begins} BEGIN, ${ends} END${inverted ? ", END before BEGIN" : ""}) — readers may load nothing. The next MemoryWriter curation write heals it.`,
        { begins, ends, inverted },
      );
    }
  } catch (e) {
    add(`markers-unreadable:${label}`, "warn", `Could not read ${label} memory for marker check: ${(e as Error)?.message}`);
  }
}

// CHECK 7.6: pending silent loss — entries on disk that read() excludes as invalid.
// The reviewer's set-overwrite submits read()'s `entries`, so anything excluded here
// is erased by the next write with no trace in any log. Surface it while it still exists.
for (const [label, path] of [["principal", PRINCIPAL_MEM], ["da", DA_MEM]] as const) {
  if (!existsSync(path)) continue;
  try {
    const r = memoryRead(path);
    if ("code" in r) continue;
    if (r.dropped_invalid.length > 0) {
      add(
        `pending-silent-loss:${label}`,
        "warn",
        `${label} memory has ${r.dropped_invalid.length} on-disk entr${r.dropped_invalid.length === 1 ? "y" : "ies"} that read() excludes as invalid — the next curation write erases them silently.`,
        { dropped: r.dropped_invalid },
      );
    }
  } catch { /* probe IO errors are recorded by CHECK 7.5, never crash the run */ }
}

// CHECK 8: cap-pressure — the exact failure class that sat silent for two weeks.
// A file AT cap can't accept new memory; near-cap means the next curation must
// consolidate or it jams. (Eviction now works, so this is a warning not a freeze.)
// Counts via the shared lenient parser: the old regex returned 0 on a corrupted
// file, which reported full headroom on a file nobody could read.
function entryCount(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    return parseMemoryContent(readFileSync(path, "utf-8")).entries.length;
  } catch {
    return 0;
  }
}
for (const [label, path] of [["principal", PRINCIPAL_MEM], ["da", DA_MEM]] as const) {
  const n = entryCount(path);
  // Full is only a WARN now — eviction works, so the next curation consolidates.
  // The CRITICAL signal is CHECK 9 (a reviewer actually dropping a fact on EAT_CAP).
  if (n >= 46) add(`cap-pressure:${label}`, "warn", `${label} memory at ${n}/48 — next curation must consolidate to make room.`, { count: n });
  else add(`cap-ok:${label}`, "ok", `${label} memory has headroom (${n}/48).`);
}

// CHECK 9: reviewer failures — recent runs that errored or hit EAT_CAP. An
// EAT_CAP in a dispatch is the cap-jam actively dropping a real fact on the floor.
if (existsSync(REVIEWER_RUNS_LOG)) {
  try {
    const tail = readFileSync(REVIEWER_RUNS_LOG, "utf-8").trim().split("\n").filter((l) => l.trim()).slice(-5);
    const parsedRows = tail.map((l) => { try { const r = JSON.parse(l); return r && typeof r === "object" && !Array.isArray(r) ? r : null; } catch { return null; } });
    const recent = parsedRows.filter(Boolean);
    const malformedRows = parsedRows.length - recent.length;
    // A malformed row is missing evidence, never a healthy run.
    if (malformedRows > 0) add("reviewer-log-malformed", "warn", `${malformedRows} of the last ${tail.length} reviewer-run rows are malformed — reviewer health cannot be established from them.`, { path: REVIEWER_RUNS_LOG, malformed: malformedRows });
    const skips = recent.filter((r: any) => r.skipped === true);
    const failed = recent.filter((r: any) => (r.ok === false || r.parse_ok === false) && r.skipped !== true);
    // Skips are healthy no-ops individually, but an unbroken streak means the
    // reviewer never finds anything to curate — that's an extractor problem.
    if (recent.length >= 5 && skips.length === recent.length) add("reviewer-all-skips", "warn", `All last ${recent.length} reviewer runs skipped (nothing extracted) — check the exchange extractor.`, { skips: skips.length });
    const capDrops = recent.filter((r: any) =>
      Array.isArray(r?.dispatch_summary?.failures) &&
      r.dispatch_summary.failures.some((f: any) => String(f?.error || "").includes("EAT_CAP")));
    if (capDrops.length > 0) add("reviewer-eat-cap", "critical", `${capDrops.length} of last 5 reviewer runs dropped a fact on EAT_CAP — cap-jam actively losing memory.`, { runs: capDrops.length });
    if (failed.length >= 3) add("reviewer-failing", "warn", `${failed.length} of last 5 reviewer runs failed (error/parse) — curation may be stalling.`, { failed: failed.length });
    else if (failed.length === 0 && capDrops.length === 0 && malformedRows === 0 && recent.length > 0) add("reviewer-healthy", "ok", "Recent reviewer runs completed cleanly.");
  } catch (err) {
    // Silence here is exactly how #1983 hid for weeks: say the evidence is unreadable (public issue #1983, @spazbg).
    add("reviewer-log-unreadable", "warn", `CHECK 9 could not read its evidence: ${REVIEWER_RUNS_LOG}`, { path: REVIEWER_RUNS_LOG, error: err instanceof Error ? err.message : String(err) });
  }
}

// CHECK 9.5: the index-policy marker is self-healing (public issue #2025, @MatiasBarboza).
// LIFEOS/CORTEX_INDEX_POLICY.json is the affirmative "no-index-v1 lexical baseline"
// marker CortexHealth wants when no index manifest exists. Its only producer was
// the installer's payload copy, so an update that lost it left `index-evidence-
// missing` warning forever with no operator remedy. "No manifest and no marker"
// is the stock default state, not a decision, so write the constant marker here
// (the one maintenance consumer) and name the file. Skipped when live writes are
// disabled or when the manifest path is present (an indexed install is not the
// default state, so leave its evidence alone).
const INDEX_POLICY = join(CLAUDE, "LIFEOS", "CORTEX_INDEX_POLICY.json");
const INDEX_MANIFEST = process.env.CORTEX_INDEX_MANIFEST || join(CLAUDE, "LIFEOS/MEMORY/INDEX/index-manifest.json");
if (process.env.CORTEX_HEALTH_NO_WRITE !== "1" && existsSync(dirname(INDEX_POLICY)) && !existsSync(INDEX_MANIFEST) && !existsSync(INDEX_POLICY)) {
  const marker = { schema: "lifeos-cortex-index-policy/v1", policy: "no-index-v1" };
  invariant(!existsSync(INDEX_POLICY) && !existsSync(INDEX_MANIFEST), "index-policy self-heal must only write when neither manifest nor marker exists");
  try {
    atomicWriteJSON(INDEX_POLICY, marker);
    add("policy-marker-written", "warn", `Wrote the default index-policy marker ${INDEX_POLICY} (no manifest and no marker were present; no-index-v1 lexical baseline). Nothing further to do.`, { path: INDEX_POLICY, ...marker });
  } catch (err) {
    add("policy-marker-write-failed", "warn", `Could not write the default index-policy marker ${INDEX_POLICY}; restore it from the release payload.`, { path: INDEX_POLICY, error: err instanceof Error ? err.message : String(err) });
  }
}

// CHECK 10: refused writes (stale-base guard, public PR #2097 @hjbrandt).
// The memory reviewer passes a fingerprint of the entries it read, and setEntries
// refuses (ESTALE_BASE) when the file's entries no longer match. Refusing writes
// indicates the review loop is not losing data, but a high refusal rate suggests
// edit/review races on the memory files. Counts rejections within 24h.
let refusedWriteCount = 0;
if (existsSync(MEMORY_WRITES_LOG)) {
  const nowMs = process.env.CORTEX_HEALTH_NOW ? Date.parse(process.env.CORTEX_HEALTH_NOW) : Date.now();
  const twentyFourHoursAgoMs = nowMs - 24 * 60 * 60 * 1000;
  try {
    const lines = readFileSync(MEMORY_WRITES_LOG, "utf8").trim().split("\n");
    for (const line of lines) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (row.rejected === true && (row.rejection_code === "ESTALE_BASE" || row.rejection_code === "ELOCK_HELD")) {
          const stamp = row.ts ?? row.timestamp; // ledger events carry `ts`
          const rowTimeMs = stamp ? Date.parse(stamp) : 0;
          if (rowTimeMs >= twentyFourHoursAgoMs) refusedWriteCount++;
        }
      } catch {
        // skip malformed rows
      }
    }
  } catch (err) {
    add("memory-writes-log-error", "warn", `Could not read ${MEMORY_WRITES_LOG}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
if (refusedWriteCount > 0) {
  add("refused-writes", "warn", `${refusedWriteCount} memory writes were refused (ESTALE_BASE/ELOCK_HELD) in the last 24h. Edit/review race detected on memory files.`, { refused_count: refusedWriteCount });
} else {
  add("refused-writes-none", "ok", "No refused memory writes in the last 24h.");
}

// F5: evidence-driven Cortex health. Paths and clock are injectable so tests never touch live state.
function cortexThresholdEnv(name: string): number | undefined {
  const raw = process.env[name]; if (raw === undefined || raw === "") return undefined;
  const value = Number(raw); if (!Number.isFinite(value) || value <= 0) { add("cortex-threshold-invalid", "critical", `${name} must be finite and greater than zero.`, { name, value: raw }); return undefined; }
  return value;
}
const retrievalStaleMs = cortexThresholdEnv("CORTEX_RETRIEVAL_STALE_MS");
const proposalBacklog = cortexThresholdEnv("CORTEX_PROPOSAL_BACKLOG");
const observabilityMaxAgeMs = cortexThresholdEnv("CORTEX_OBSERVABILITY_MAX_AGE_MS");
const cortexEvidence = collectCortexEvidence({ root: CLAUDE, nowMs: process.env.CORTEX_HEALTH_NOW ? Date.parse(process.env.CORTEX_HEALTH_NOW) : Date.now(), thresholds: {
  ...(retrievalStaleMs === undefined ? {} : { retrievalStaleMs }), ...(proposalBacklog === undefined ? {} : { proposalBacklog }),
  ...(observabilityMaxAgeMs === undefined ? {} : { observabilityMaxAgeMs }),
}, indexManifest: process.env.CORTEX_INDEX_MANIFEST });
const cortexAssessment = assessCortexEvidence(cortexEvidence);
for (const finding of cortexAssessment.findings) add(finding.id, finding.severity, finding.message, finding.evidence);

// SUMMARY
const criticals = findings.filter(f => f.severity === "critical");
const warns = findings.filter(f => f.severity === "warn");
const oks = findings.filter(f => f.severity === "ok");

const overall: Severity = criticals.length > 0 ? "critical" : warns.length > 0 ? "warn" : "ok";

// ACTIONS — the human-facing translation of non-ok findings, consumed by the
// statusline → attention stream and Pulse. Each is a short imperative; a
// finding that self-heals (next curation folds it in) maps to NO action, so
// surfaces only nag when a human can actually do something. A critical run
// always yields at least one action.
function actionFor(f: Finding): string | null {
  const id = f.id;
  if (id === "ledger-byte-drift" || id.startsWith("cap-pressure:")) return null; // next curation heals
  if (id === "proposal-backlog-high") {
    const pending = (f.detail as any)?.pending;
    return `Fold ${Number.isFinite(pending) ? pending : "the"} memory proposals`;
  }
  if (id.startsWith("observability-over-budget:")) return `Find why ${id.slice("observability-over-budget:".length)} is growing`;
  if (id.startsWith("observability-")) return "Check the observability logs";
  if (id === "reviewer-eat-cap") return "Memory cap-jam: run a curation now";
  if (id.startsWith("reviewer-") || id.startsWith("state-") || id === "review-stale") return "Check the memory reviewer";
  if (id.startsWith("index-")) return "Rebuild the memory index";
  if (id === "delta-surface-dead") return "Memory delta hook is dead: check hooks";
  if (id === "ledger-fold-drift") return "Adopt memory edits: CortexLedger adopt";
  if (id === "ledger-unverified") return "Anchor the memory ledger: CortexLedger genesis";
  if (f.severity === "critical") return "Run a memory health check";
  return null; // internals-only warn — lives in the log and the 🩺 nag
}
const actions = [...new Set(
  findings.filter(f => f.severity !== "ok").map(actionFor).filter((a): a is string => a !== null),
)].map(text => ({ text, severity: criticals.some(f => actionFor(f) === text) ? "critical" : "warn" }));
if (overall === "critical" && actions.length === 0) actions.push({ text: "Run a memory health check", severity: "critical" });

const report = {
  ts: new Date().toISOString(),
  overall,
  counts: { critical: criticals.length, warn: warns.length, ok: oks.length },
  actions,
  thresholds: cortexAssessment.thresholds,
  evidence: cortexEvidence,
  findings: findings.filter(f => f.severity !== "ok"),
  ok_summary: oks.map(o => o.id),
};

// Append to observability log
try {
  if (process.env.CORTEX_HEALTH_NO_WRITE === "1") throw new Error("health log write disabled");
  if (!existsSync(OBS_DIR)) mkdirSync(OBS_DIR, { recursive: true });
  appendFileSync(HEALTH_LOG, JSON.stringify(report) + "\n");
} catch (err) {
  // non-fatal
}

// Optional machine-readable report for fixture/automation consumers. Keep this
// separate from the append-only health log so CORTEX_HEALTH_NO_WRITE can disable
// live observability writes without suppressing an explicitly requested report.
try {
  if (process.env.CORTEX_HEALTH_REPORT_PATH) {
    atomicWriteJSON(process.env.CORTEX_HEALTH_REPORT_PATH, report);
  }
} catch {
  // Preserve the CLI existing stdout, stderr, and health-derived exit semantics.
}

await Bun.write(Bun.stdout, JSON.stringify(report, null, 2) + "\n");

if (overall === "critical") process.exit(2);
if (overall === "warn") process.exit(1);
process.exit(0);
