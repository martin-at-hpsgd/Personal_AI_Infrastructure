#!/usr/bin/env bun
/**
 * @version 1.6.3
 * 1.6.2 (2026-10-16, STATVS migration Lane E2): the deferred-close event is written through STATVS writeEvent
 * (hooks/lib/handoff-state writeStatvsEvent) instead of Vigil Emit.ts; VIGIL_DIR no longer applies here.
 * 1.6.1 (2026-10-15, security P1 batch 2 final round 2, S040): when the strict read fails (a malformed
 * line in the current turn), the gate looks once more over the readable lines, as the live hook read
 * them, and returns a block it finds; anything short of a block is still `deferred`. A malformed line
 * after a failing close therefore blocks as before instead of only deferring.
 * 1.6.0 (2026-10-15, security P1 batch 2 S039/S040): a MultiEdit of an ISA this turn is an ISA write
 * (transcript-evidence emits no edit event for MultiEdit, so ISAFoldGate's transcriptToolCalls bridge
 * reports it), and the turn is read through parseTurnEvents({ strict: true }). An evaluation that cannot
 * run (unreadable transcript, a malformed line in the current turn, any throw outside the per-ISA check)
 * goes through runGate("advise"): one Vigil hook-error event, one stderr line, and an explicit `deferred`
 * status naming the unchecked obligation instead of a silent pass.
 * 1.5.0 (2026-10-14, persistence leg): a close check that throws is held
 * even when its retry cannot be recorded; the harness loop guard (stop_hook_active) bounds it.
 * ISAGate.hook.ts — deterministic ISA structural gate at the close transition (Stop).
 *
 * Thesis: the ISA doctrine's STRUCTURAL promises (mechanical progress count,
 * fog empty at close, every criterion anchored to the stated goal) were enforced by
 * a markdown checklist the model may or may not run — so they leaked into closed
 * ISAs at scale (92 no-anchors, 60 no-anti, 14 fog-at-complete; 2026-07-23 audit).
 * This gate makes the un-gameable subset mechanical.
 *
 * Firing rule — BLOCK iff ALL hold; any failure ⇒ PASS (default pass):
 *   1. not a stop-hook recovery pass (loop guard)
 *   2. an ISA.md was Edit/MultiEdit/Written THIS TURN (so legacy files are never gated
 *      retroactively — ISC-20 of the upgrade: the gate applies to new closes only)
 *   3. that ISA is at `phase: complete` on disk — except H8b (checked-without-row,
 *      2026-09-30), which blocks at every phase: a box checked on an assert-era
 *      ISA whose criterion has no Test Strategy row at all
 *   4. ISAGate.gateReport finds ≥1 HARD violation (progress-format / fog-at-complete
 *      / anchors-missing / H8 assert-coverage: an assert-era ISA (started ≥ 2026-08-31)
 *      closing with a criterion that has zero Test Strategy rows). The `manual` row is the
 *      escape valve that keeps H8 honest — a visible exception, never a fake probe —
 *      so manual-only criteria pass and are listed as advisories. Every other
 *      count-shaped check stays advisory and NEVER blocks (the Goodhart line).
 *      At a close the gate also READS the Bunker run ledger for the current criteria
 *      revision (ISC-15): a latest recorded fail, or deferrals over `defer_cap`, are hard;
 *      unrecorded criteria are advisory. No judge runs here; it only reads recorded results.
 *
 * Errors: an ISA that vanished mid-turn is skipped. An exception while checking an ISA that
 * IS at a close blocks, with the error in the message: a close the gate could not check is
 * not a pass. Before close, an exception in that per-ISA check stays fail-open. Anything
 * else that stops the evaluation (an unreadable transcript, a malformed line in the current
 * turn, a throw while collecting candidates) is an advise-gate failure: runGate records a
 * Vigil hook-error and the gate returns `deferred` naming the unchecked obligation (S040).
 *
 * Retry bound: each block counts against the session's ISAGate obligation (three
 * retries, hooks/lib/obligation-state.ts). Once exhausted the gate stops blocking and
 * returns `deferred`; a close that still has hard violations (or still errors) is
 * written to MEMORY/STATE/isa-gate-deferred.jsonl and to STATVS as one event, so it is
 * recorded, never silently passed. StopGates surfaces `deferred`; it does not block.
 * The Goodhart-killed prose-quality Stop-block is NOT revived here: only binary
 * structural facts a throwaway entry cannot satisfy are hard. Env kill: ISAGATE_OFF=1.
 *
 * TRIGGER: Stop (dispatched by StopGates.hook.ts)
 */

import { parseTurnEvents, turnStartMs, type TxEvent } from "./lib/transcript-evidence";
import { closeEvidenceIdentity, frontmatter, gateReport, isAtClose } from "../LIFEOS/TOOLS/ISAGate";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { lifeosPath } from "../LIFEOS/TOOLS/Paths";
import { createHash, randomUUID } from "node:crypto";
import { findActiveSessionByUUID, isIsaPath, isaRevision } from "./lib/isa-utils";
import { invariant } from "../LIFEOS/TOOLS/Invariant";
import {
  checkObligation,
  recordEvaluation,
  isExhausted,
} from "./lib/obligation-state";
import { recordGateRun, registeredGates } from "../LIFEOS/TOOLS/GateReach";
import { runGate } from "./lib/gate-run";
import { writeStatvsEvent } from "./lib/handoff-state";
import { transcriptToolCalls, type ToolCall } from "./ISAFoldGate.hook";

/** One event through STATVS writeEvent (STATVS migration Lane E2). Written after the gate decided, so it never changes a decision (STATVS ISC-58). */
function emitEvent(event: Record<string, unknown>): void {
  try { writeStatvsEvent(event); } catch { /* STATVS is optional in public installs; a monitoring failure never changes the gate's answer. */ }
}

// A Bash command counts as this session writing an ISA only when it is shaped
// like a write: an in-place edit, a redirect, tee, a move or copy, or a bun
// script/eval (the usual way files get rewritten here). A read (`cat`, `rg`)
// never gates, so another session's close during this turn can't block us.
const WRITE_SHAPED = /(^|\s)-i\b|>>?|\btee\b|\bmv\b|\bcp\b|\bbun\s+(-e|--eval|run|\S+\.ts)\b|Bun\.write|writeFile/;

export function bashIsaCandidates(events: TxEvent[], cwd: string, startMs: number | null): string[] {
  if (startMs === null) return [];
  const paths = new Set<string>();
  const expand = (p: string) => p.replace(/^~(?=\/|$)|^\$HOME(?=\/|$)|^\$\{HOME\}(?=\/|$)/, homedir());
  for (const event of events) {
    if (event.tool !== "Bash" || event.command === undefined) continue;
    const command = event.command;
    const tokens = command.split(/[\s"'=;&|()<>]+/).filter(Boolean);
    const raw: string[] = [];
    // A worker dispatched with --slug writes that slug's ISA; that is a writer by definition.
    for (let i = 0; i < tokens.length - 1; i++) {
      if (tokens[i] === "--slug" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tokens[i + 1]!)) {
        raw.push(lifeosPath("MEMORY", "WORK", tokens[i + 1]!, "ISA.md"));
      }
    }
    if (WRITE_SHAPED.test(command)) {
      raw.push(...tokens.filter(isIsaPath));
      // Quoted paths may contain spaces; take them whole.
      for (const m of command.matchAll(/["']([^"']*(?:\/|^)(?:ISA\.md|[^"'\/]*\.isa\.md))["']/g)) raw.push(m[1]!);
    }
    // Relative paths resolve against the hook cwd AND every `cd <dir>` in the command.
    const bases = [cwd, ...[...command.matchAll(/(?:^|[;&|(]\s*)cd\s+("[^"]+"|'[^']+'|\S+)/g)]
      .map((m) => expand(m[1]!.replace(/^["']|["']$/g, "")))
      .map((d) => (isAbsolute(d) ? d : resolve(cwd, d)))];
    for (const token of raw) {
      const expanded = expand(token);
      const options = isAbsolute(expanded) ? [expanded] : bases.map((b) => resolve(b, expanded));
      for (const path of options) {
        try { if (existsSync(path) && statSync(path).mtimeMs >= startMs) paths.add(path); } catch { /* candidate vanished */ }
      }
    }
  }
  return [...paths];
}

// A single unchained read (`cat x/ISA.md`, `rg … ISA.md`) never makes its ISA a candidate.
const READ_ONLY_CMD = /^\s*(?:rg|grep|egrep|fgrep|cat|bat|head|tail|less|ls|eza|wc|stat|file)\b/;
const CHAINED = /[;&|`\n>]|\$\(/;
/** Upper bound on ISA stats per Stop, so a command naming many run slugs costs a bounded scan. */
export const WORK_SCAN_MAX = 64;

/**
 * Task ISAs written this turn by a Bash writer of any shape (audit shard ad #8):
 * bashIsaCandidates only sees write-SHAPED commands, so `node -e`, a python one-liner
 * or a script taking a path all slipped past it. This finds MEMORY/WORK/<slug>/ISA.md
 * by mtime instead, scoped to ISAs this turn's own non-read Bash commands name by slug
 * (plus this session's active run's ISA), so another session's close never gates this
 * one. Cost: one readdir of MEMORY/WORK, substring tests, and at most WORK_SCAN_MAX stats.
 */
export function workIsaCandidates(events: TxEvent[], startMs: number | null, sessionId?: string, workDir = lifeosPath("MEMORY", "WORK")): string[] {
  if (startMs === null) return [];
  const commands = events
    .filter((e) => e.tool === "Bash" && typeof e.command === "string" && !e.isToolError)
    .map((e) => e.command!)
    .filter((c) => !(READ_ONLY_CMD.test(c) && !CHAINED.test(c)));
  if (!commands.length) return [];
  const slugs = new Set<string>();
  try {
    const text = commands.join("\n");
    for (const name of readdirSync(workDir)) {
      if (name.length >= 6 && text.includes(name)) slugs.add(name);
      if (slugs.size >= WORK_SCAN_MAX) break;
    }
  } catch { /* no MEMORY/WORK: nothing to find */ }
  try {
    const active = sessionId ? findActiveSessionByUUID(sessionId) : null;
    if (active?.slug && slugs.size < WORK_SCAN_MAX) slugs.add(active.slug);
  } catch { /* registry unreadable: mention scope still applies */ }
  const out: string[] = [];
  for (const slug of slugs) {
    const path = join(workDir, slug, "ISA.md");
    try { if (statSync(path).mtimeMs >= startMs) out.push(path); } catch { /* no ISA in that run */ }
  }
  return out;
}

/**
 * ISA paths a MultiEdit named in the current turn (S039). transcript-evidence turns Edit, Write and
 * NotebookEdit into edit events but not MultiEdit, so the transcriptToolCalls bridge supplies these
 * until it does. Counted whatever its result: a candidate only means "evaluate this ISA", never a pass.
 */
export function multiEditIsaPaths(calls: ToolCall[]): string[] {
  const out = new Set<string>();
  for (const c of calls) {
    if (c.name !== "MultiEdit") continue;
    const p = c.input.file_path;
    if (typeof p === "string" && p && isIsaPath(p)) out.add(p);
  }
  return [...out];
}

function realOf(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

function recordDeferred(sessionId: string, path: string, revision: string, hard: string[]): void {
  const dir = process.env.ISAGATE_STATE_DIR || lifeosPath("MEMORY", "STATE");
  const key = `${path}:${revision}`;
  const seenPath = join(dir, `isa-gate-deferred-seen-${createHash("sha256").update(sessionId).digest("hex").slice(0, 12)}.json`);
  const seen: string[] = existsSync(seenPath) ? JSON.parse(readFileSync(seenPath, "utf8")) : [];
  if (seen.includes(key)) return;
  const record = { ts: new Date().toISOString(), session_id: sessionId, isa: path, revision, hard };
  invariant(Number.isFinite(Date.parse(record.ts)) && !!sessionId && !!path && !!revision && hard.length > 0 && hard.every(Boolean), "deferred ISA gate record is valid");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "isa-gate-deferred.jsonl"), JSON.stringify(record) + "\n");
  const slug = basename(dirname(path));
  const event = {
    id: randomUUID(), source: "isa-gate", ts: record.ts, kind: "other" as const,
    severity: "medium" as const, privacy_class: "personal" as const,
    ref: null, url: null, title: `ISA closed past its gate: ${slug}`,
    summary: `Hard violations: ${hard.join(", ")}. Fix: bun LIFEOS/TOOLS/ISAGate.ts on the ${slug} ISA (full path in isa-gate-deferred.jsonl).`,
    dedup_key: `isa-gate-deferred:${createHash("sha256").update(path).digest("hex").slice(0, 12)}:${revision.slice(0, 12)}`,
  };
  invariant(event.id.length > 0 && event.dedup_key.length > 0 && event.summary.includes("bun LIFEOS/TOOLS/ISAGate.ts"), "deferred ISA gate event is valid");
  emitEvent(event);
  const next = [...seen, key];
  invariant(next.length > 0 && next.every((x) => typeof x === "string" && x.length > 0), "deferred ISA gate seen set is valid");
  // Unique tmp + rename: a concurrent Stop never reads a half-written seen set (audit shard ad #11).
  const tmp = `${seenPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(next) + "\n");
  renameSync(tmp, seenPath);
}

/**
 * The gate. An evaluation that cannot run is an advise-gate failure (S040): runGate records one
 * Vigil hook-error event and one stderr line, and the gate returns an explicit `deferred` status
 * naming the unchecked obligation, so the Stop is never silently cleared.
 */
export async function run(input: any): Promise<object | null> {
  if (process.env.ISAGATE_OFF === "1") return null;
  const r = await runGate("advise", "ISAGate", () => evaluate(input, false));
  if (r.status === "ok") return r.value;
  // The strict check could not run (a malformed line, say). An ISA the readable lines show as written
  // with hard violations is blocked as the live hook blocked it; anything short of a block stays deferred.
  try {
    const v = await evaluate(input, true);
    if (v && (v as { decision?: unknown }).decision === "block") return v;
  } catch { /* the deferral below stands */ }
  return {
    decision: "deferred",
    message:
      `ISAGate could not check this turn (${r.reason}). Any ISA written this turn is structurally unchecked: ` +
      `run bun LIFEOS/TOOLS/ISAGate.ts on it and fix what it reports before calling it closed.`,
  };
}

/**
 * One evaluation. Strict: an unreadable transcript or a malformed current turn is an unknown turn, never
 * an empty one (strict parseTurnEvents throws on both, and so does the bridge that reports MultiEdit
 * calls). Lenient (run's second look after a strict failure): malformed lines are skipped, as the live
 * hook skipped them, and only a block it returns is used.
 */
async function evaluate(input: any, lenient: boolean): Promise<object | null> {
  if (!lenient) recordGateRun("hook:ISAGate.hook", { result: "executed" });
  const transcriptPath = input?.transcript_path;
  const sessionId = input?.session_id;
  if (!transcriptPath || !sessionId) return null;
  const events = lenient ? parseTurnEvents(transcriptPath) : parseTurnEvents(transcriptPath, { strict: true });
  const turn = transcriptToolCalls(transcriptPath, "turn", { lenient });
  if (!turn.ok) throw new Error(turn.reason);

  // ISA files Edit/MultiEdit/Written this turn using the shared path recognizer
  const startMs = turnStartMs(transcriptPath);
  const isaPaths = [
    ...new Set(
      [...events
        .filter((e) => e.kind === "edit" && isIsaPath(e.target))
        .map((e) => e.target), ...multiEditIsaPaths(turn.calls),
        ...bashIsaCandidates(events, input?.cwd || process.cwd(), startMs),
        ...workIsaCandidates(events, startMs, sessionId)],
    ),
  ];
  if (!isaPaths.length) return null;
  const seenReal = new Set<string>();

  const offenders: { path: string; hard: string[]; obligation?: string }[] = [];
  const deferredGates: string[] = [];

  for (const p of isaPaths) {
    if (!existsSync(p) || seenReal.has(realOf(p))) continue; // one ISA, one evaluation, whatever its spelling
    seenReal.add(realOf(p));

    // Get ISA revision for obligation tracking
    let body: string;
    try { body = readFileSync(p, "utf8"); } catch { continue; } // vanished mid-turn: nothing to gate
    // A close is read from the frontmatter with the gate library's own parser, so
    // `phase: "Complete"` closes and a quoted `phase: complete` in the body does not (#9).
    const atClose = isAtClose(frontmatter(body));
    let rev: string;
    try {
      // At a close the gate also reads recorded evidence: new evidence is a new revision (#10).
      rev = atClose ? isaRevision(`${body}\0${closeEvidenceIdentity(p, body)}`) : isaRevision(body);
    } catch {
      rev = isaRevision(body);
    }
    if (!rev) continue;
    try {

    // Check if we should evaluate this gate for this ISA
    const obligation = checkObligation(sessionId, "ISAGate", p, rev);

    // Skip evaluation if:
    // 1. Already resolved for this revision
    // 2. Unresolved but retries exhausted
    // Otherwise evaluate
    if (obligation.resolved) {
      recordEvaluation(sessionId, "ISAGate", p, rev, true);
      continue;
    }

    if (isExhausted(sessionId, "ISAGate")) {
      if (atClose) {
        let hardCodes: string[];
        try {
          const report = gateReport(p);
          hardCodes = report.blocks ? report.hard.map((h) => h.code) : [];
        } catch {
          hardCodes = ["gate-error"]; // could not check the close: record it, never pass it silently
        }
        if (hardCodes.length) {
          try { recordDeferred(sessionId, p, rev, hardCodes); } catch { /* observability must not block Stop */ }
        }
      }
      deferredGates.push(p);
      continue;
    }

    // Gate logic: only gate genuine closes
    if (!atClose) {
      // Before close, only H8b blocks: a checked criterion with no Test Strategy row.
      const open = gateReport(p).hard.filter((h) => h.code === "checked-without-row");
      if (open.length) {
        offenders.push({ path: p, hard: open.map((h) => `[${h.code}] ${h.message}`) });
        recordEvaluation(sessionId, "ISAGate", p, rev, false);
      } else {
        recordEvaluation(sessionId, "ISAGate", p, rev, true);
      }
      continue;
    }

    // Check for hard violations
    const r = gateReport(p);
    const violationCodes = new Set([...r.hard, ...r.advisory].map((violation) => violation.code));
    for (const gate of registeredGates().filter((gate) => gate.startsWith("ISAGate."))) {
      recordGateRun(gate, { subject: p, result: violationCodes.has(gate.slice("ISAGate.".length)) ? "violation" : "pass" });
    }
    if (r.blocks) {
      offenders.push({ path: p, hard: r.hard.map((h) => `[${h.code}] ${h.message}`) });
      recordEvaluation(sessionId, "ISAGate", p, rev, false);
    } else {
      recordEvaluation(sessionId, "ISAGate", p, rev, true);
    }
    } catch (err) {
      if (!atClose) continue; // before close the gate stays fail-open
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      // The retry is counted when the obligation state takes the write. When it cannot
      // (unwritable state), the harness's own loop guard bounds the block instead: the
      // re-stop right after this block carries stop_hook_active and passes, so an
      // unchecked close is held once per stop, never passed silently and never looped.
      let counted = true;
      try { recordEvaluation(sessionId, "ISAGate", p, rev, false); } catch { counted = false; }
      if (counted || input?.stop_hook_active !== true) {
        offenders.push({ path: p, hard: [`[gate-error] the close check threw (${msg})${counted ? "" : " and the gate's retry state could not be written"}; a close the gate could not check is not a pass — run bun LIFEOS/TOOLS/ISAGate.ts on this ISA and fix what it reports`] });
      }
    }
  }

  // Emit combined block if violations found
  if (offenders.length > 0) {
    const lines = offenders.flatMap((o) => [
      `  ${o.path.replace(homedir(), "~")}`,
      ...o.hard.map((h) => `    ❌ ${h}`),
    ]);
    return {
      decision: "block",
      reason:
        `ISA structural gate — an ISA written this turn has hard violations (at a close: phase complete or a milestone close; at any phase: a checked criterion with no Test Strategy row):\n` +
        lines.join("\n") +
        `\n\nThese are structural facts, not judgment calls. Fix the ISA (graduate/kill fog, add anchors_to, write progress as M/N), or set phase back to climbing if it isn't actually done. Advisories (bundled/event/uncovered criteria) are surfaced by \`bun LIFEOS/TOOLS/ISAGate.ts <isa>\` and do NOT block.`,
    };
  }

  // Emit deferred status if retries exhausted
  if (deferredGates.length > 0) {
    const gates = deferredGates.map((p) => `  ${p.replace(homedir(), "~")}`).join("\n");
    return {
      decision: "deferred",
      message: `ISA structural gate — retry limit exhausted for:\n${gates}\n\nUnresolved obligation persists. Check the ISA and fix structural violations, then try again.`,
    };
  }

  return null;
}
