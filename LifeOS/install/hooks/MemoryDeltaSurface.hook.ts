#!/usr/bin/env bun
/**
 * @version 1.0.19
 * MemoryDeltaSurface — UserPromptSubmit hook that makes the autonomic memory
 * loop VISIBLE in every response, Hermes-style.
 *
 * ALWAYS-ON (2026-06-11 redesign, principal-directed): every primary-session
 * prompt gets a `<lifeos-memory-delta>` block with one verbatim 🧠 MEMORY line:
 *
 *   - DELTA form (loop wrote since last surfaced turn):
 *     🧠 MEMORY: +3 learned · −1 dropped — "principal: …", "self: …" · C 5/8 fresh
 *   - HEARTBEAT form (no new writes):
 *     🧠 MEMORY: C (5/8 fresh) · due: TELOS.md (never reviewed) · last curation +3 → principal 4h ago
 *
 * The line answers the principal's two standing questions in one glance:
 * "are you keeping our framework fresh?" (delta / last-curation heartbeat) and
 * "how fresh is it?" (A–F grade + fresh count + stalest file from the
 * freshness cache). All values are computed HERE, deterministically — the
 * model only echoes the string (the 2026-05-28 model-self-computed line failed
 * compliance repeatedly; never go back).
 *
 * Two guards, both load-bearing, because for a change-only surface silence IS the healthy
 * state and a dead hook is indistinguishable from a quiet week: (1) this hook touches
 * MEMORY/STATE/delta-surface-heartbeat on every run and
 * MemoryHealthCheck flags it dead if memory writes continue while nothing surfaces;
 * (2) MemoryHealthCheck treats a missing settings registration as critical, which nags in
 * chat via the 🩺 line below. Never infer this hook's liveness from its output.
 *
 * Failure mode: any error → stderr + exit 0. Never block a prompt.
 * Subagent skip: the per-turn surface is for the principal's primary session.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { resolve as pathResolve, dirname } from "node:path";
import { isSubagentContext as isSubagent } from './lib/subagent';
import { isInstructionShaped } from '../LIFEOS/TOOLS/InjectionShapes';
import { getClaudeDir } from "./lib/paths"; // public issue #1665 @rogdex24, #1584 @ramazanpolat — aliased resolve sites missed by the 09-03 sweep
import { readTail } from "../LIFEOS/TOOLS/lib/LedgerCore";

const CLAUDE_ROOT = getClaudeDir();
const WRITES_LOG = pathResolve(CLAUDE_ROOT, "LIFEOS/MEMORY/LEDGER/cortex-events.jsonl");
const CURSOR = pathResolve(CLAUDE_ROOT, "LIFEOS/MEMORY/OBSERVABILITY/memory-delta-cursor.json");
const HEALTH_LOG = pathResolve(CLAUDE_ROOT, "LIFEOS/MEMORY/OBSERVABILITY/memory-health.jsonl");
const FRESHNESS_CACHE = pathResolve(CLAUDE_ROOT, "LIFEOS/USER/CACHE/freshness.json");
const HEARTBEAT = pathResolve(CLAUDE_ROOT, "LIFEOS/MEMORY/STATE/delta-surface-heartbeat");

// Only the autonomic write path counts as "the system adjusting itself".
const AUTONOMIC_WRITER = "MemorySystem.add";
// The ledger carries non-write kinds (checkpoint, memory/restore, memory/redact,
// proposal/apply) in the same stream; only a set is a write. Rows with no kind
// are legacy memory-writes.jsonl rows, still counted if the log is pointed back.
const WRITE_KIND = "memory/set";
const FRESHNESS_MAX_AGE_MS = 24 * 60 * 60 * 1000; // older cache → warn, don't lie
const LINE_HARD_CAP = 180;

interface WriteRow {
  ts: string;
  file: string;
  kind?: string;
  updated_by?: string;
  accepted?: number;
  additions?: string[];
  evictions?: string[];
}

function readCursor(): string {
  try {
    if (!existsSync(CURSOR)) return "";
    return JSON.parse(readFileSync(CURSOR, "utf8")).last_ts ?? "";
  } catch {
    return "";
  }
}

function writeCursor(ts: string): void {
  try {
    mkdirSync(dirname(CURSOR), { recursive: true });
    writeFileSync(CURSOR, JSON.stringify({ last_ts: ts }) + "\n", "utf8");
  } catch {
    /* best-effort */
  }
}

function touchHeartbeat(): void {
  try {
    mkdirSync(dirname(HEARTBEAT), { recursive: true });
    writeFileSync(HEARTBEAT, new Date().toISOString() + "\n", "utf8");
  } catch {
    /* best-effort — liveness guard only */
  }
}

function fileLabel(path: string): string {
  if (path.includes("PRINCIPAL_MEMORY")) return "principal";
  if (path.includes("DA_MEMORY")) return "self";
  if (path.includes("CONTACTS")) return "contacts";
  if (path.includes("PROJECTS")) return "projects";
  return "memory";
}

// Memory items can originate from external content (mail, web pages, pasted
// text). Echoing them verbatim into every prompt's context is an injection
// channel that bypasses tool-response scanning — so instruction-shaped samples
// are withheld, not rendered. (Advisor finding, 2026-06-11.)
//
// This is the DISPLAY half and it was, until 2026-08-19, the only half: an
// instruction-shaped entry was hidden from this line while still landing in the
// file and still loading on every turn. MemoryWriter now refuses such entries at
// the write, so this check is a backstop for anything already on disk. The
// patterns moved to LIFEOS/TOOLS/InjectionShapes so the two layers cannot drift.
function short(entry: string, max = 56): string {
  const t = entry.replace(/\s+/g, " ").trim();
  if (isInstructionShaped(t)) return "[withheld — instruction-shaped]";
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function ageStr(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Freshness segment from the statusline render cache. Never lies: a missing
 * or stale cache degrades to an explicit warning instead of confident numbers. */
/** "<grade> (<fresh>/<of> fresh)". fresh_count counts graded files only (auto-
 *  generated derivatives are excluded), so its denominator is graded_total; `total`
 *  is the fallback for a cache written before graded_total existed. */
export function freshnessFraction(f: { overall_grade?: unknown; fresh_count?: unknown; graded_total?: unknown; total?: unknown }): string {
  const grade = f.overall_grade ?? "?";
  const fresh = f.fresh_count ?? "?";
  const of = f.graded_total ?? f.total ?? "?";
  return `${grade} (${fresh}/${of} fresh)`;
}

function freshnessSegment(): string {
  try {
    if (!existsSync(FRESHNESS_CACHE)) return "freshness: no data";
    const age = Date.now() - statSync(FRESHNESS_CACHE).mtimeMs;
    const f = JSON.parse(readFileSync(FRESHNESS_CACHE, "utf8"));
    if (age > FRESHNESS_MAX_AGE_MS) return `⚠ freshness data ${ageStr(age)}`;
    return freshnessFraction(f);
  } catch {
    return "freshness: unreadable";
  }
}

/** The next action the principal should run, derived from the stalest tracked
 * file. Returns "<cmd> — <file> <why>" or null when nothing is due. Action-first
 * replacement for the old `due:` diagnostic — the line's job is to say what to
 * run, not to hand out a grade.
 * Two real command branches, not a rotting file→command map. */
function nextActionSegment(): string | null {
  try {
    if (!existsSync(FRESHNESS_CACHE)) return null;
    const f = JSON.parse(readFileSync(FRESHNESS_CACHE, "utf8"));
    const ms = f.most_stale;
    if (!ms?.name || (!ms.stale && ms.grade !== "F")) return null;
    const name = String(ms.name);
    const why = ms.why ? String(ms.why) : "stale";
    // TELOS / life-framework files refresh through the interview; everything
    // else is a plain review instruction the principal can act on directly.
    if (/telos/i.test(name)) return `/interview — ${name} ${why}`;
    return `review ${name} (${why})`;
  } catch {
    return null;
  }
}

/** Just the "N/M fresh" count (or the warning verbatim), grade letter dropped —
 * the A–F scold was the report-card feel the principal rejected. */
function freshCount(): string {
  const seg = freshnessSegment();
  const m = seg.match(/\((\d+\/\d+ fresh)\)/);
  return m ? m[1] : seg;
}

/** Latest critical health row → loud 🩺 nag (unchanged from v1). */
function criticalHealthLine(): string | null {
  try {
    if (!existsSync(HEALTH_LOG)) return null;
    // Only the last complete row matters; the log passed 64 MB and was read whole on every prompt (2026-10-16 native-unblock ISC-18).
    const tail = readTail(HEALTH_LOG);
    if (!tail) return null;
    const last = JSON.parse(tail);
    if (last?.overall !== "critical") return null;
    const blockers = (last.findings ?? [])
      .filter((f: any) => f.severity === "critical")
      .map((f: any) => f.message)
      .slice(0, 3);
    return `🩺 MEMORY HEALTH: CRITICAL — ${blockers.join(" · ") || `${last.counts?.critical ?? "?"} blocker(s)`}. Fix: bun ~/.claude/LIFEOS/TOOLS/MemoryHealthCheck.ts`;
  } catch {
    return null;
  }
}

/** Formatting only; no cursor, heartbeat or filesystem effects. */
export function memoryDeltaBlock(line: string): string {
  return `<lifeos-memory-delta>\n` +
    `Autonomic memory, computed deterministically by MemoryDeltaSurface.hook.ts. Render VERBATIM once as the response's 🧠 MEMORY line; never recompute or rephrase:\n` +
    `${line}\n</lifeos-memory-delta>\n`;
}

/** Returns the <lifeos-memory-health>? + <lifeos-memory-delta> blocks, or null. */
export function run(): string | null {
  let out = "";
  try {
    touchHeartbeat(); // liveness guard: MemoryHealthCheck flags a dead surface

    const cursor = readCursor();
    let maxTs = cursor;
    let learned = 0;
    let dropped = 0;
    const learnedSamples: string[] = [];
    const droppedSamples: string[] = [];
    let lastAutonomic: WriteRow | null = null;

    if (existsSync(WRITES_LOG)) {
      // Tail-bounded scan: rows are append-only chronological; cursor advances
      // every prompt, so only the tail can hold unsurfaced rows.
      const allLines = readFileSync(WRITES_LOG, "utf8").split("\n").filter((l) => l.trim().length > 0);
      for (const line of allLines.slice(-500)) {
        let row: WriteRow;
        try { row = JSON.parse(line); } catch { continue; }
        if (!row.ts) continue;
        if (row.updated_by !== AUTONOMIC_WRITER) continue;
        if (row.kind !== undefined && row.kind !== WRITE_KIND) continue;
        const isTestRow = (row.additions ?? []).some((e) => /SmokeTest|smoke-test/i.test(e));
        if (isTestRow) continue;
        lastAutonomic = row; // chronological — last one wins
        if (row.ts > maxTs) maxTs = row.ts;
        if (cursor && row.ts <= cursor) continue; // already surfaced
        const adds = row.additions ?? [];
        const evs = row.evictions ?? [];
        learned += adds.length;
        dropped += evs.length;
        for (const a of adds) if (learnedSamples.length < 2) learnedSamples.push(`${fileLabel(row.file)}: ${short(a)}`);
        for (const e of evs) if (droppedSamples.length < 1) droppedSamples.push(short(e));
      }
    }

    if (maxTs && maxTs !== cursor) writeCursor(maxTs);

    const healthLine = criticalHealthLine();
    if (healthLine) {
      out +=
        `<lifeos-memory-health>\n` +
        `Memory subsystem health is CRITICAL. Surface this line VERBATIM in your response so it cannot be ignored:\n` +
        `${healthLine}\n` +
        `</lifeos-memory-health>\n`;
    }

    // ── Compose the always-on line: an INSTRUCTION, not a report card ──
    // Lead with the next action when something is due; a quiet freshness
    // confirmation otherwise. Grade letter and "MEMORY:" label dropped from the
    // visible line — both read as a scold, not an action.
    const action = nextActionSegment(); // "/interview — TELOS.md never reviewed" | null
    const fc = freshCount(); // "1/8 fresh" | warning
    let line: string;

    if (learned > 0 || dropped > 0) {
      // DELTA: what just changed. Still points at the next action when one is due.
      const parts: string[] = [];
      if (learned > 0) parts.push(`+${learned} learned`);
      if (dropped > 0) parts.push(`−${dropped} dropped`);
      const changed = parts.join(", ");
      const samples = [...learnedSamples.map((s) => `"${s}"`), ...droppedSamples.map((s) => `−"${s}"`)];
      line = action
        ? `🧠 ${changed} · next: ${action}`
        : `🧠 ${changed}${samples.length ? ` — ${samples.join(", ")}` : ""} · ${fc}`;
    } else if (action) {
      // Something is due: the whole job of the line is to name the command.
      line = `🧠 Do next: ${action} · ${fc}`;
    } else if (lastAutonomic) {
      // Nothing due: quiet proof the loop is alive, no scold.
      // additions[] is NET-new entries; `accepted` is the post-overwrite total
      // (set-overwrite semantics) and would overstate. Only claim +N for real news.
      const age = ageStr(Date.now() - Date.parse(lastAutonomic.ts));
      const n = (lastAutonomic.additions ?? []).length;
      const what = n > 0 ? `+${n} new → ` : "ran → ";
      line = `🧠 memory ${fc} · last curation ${what}${fileLabel(lastAutonomic.file)} ${age}`;
    } else {
      line = `🧠 memory ${fc}`;
    }

    if (line.length > LINE_HARD_CAP) line = line.slice(0, LINE_HARD_CAP - 1) + "…";

    out += memoryDeltaBlock(line);
    return out;
  } catch (e) {
    process.stderr.write(`MemoryDeltaSurface error: ${(e as Error)?.message || String(e)}\n`);
    return out || null;
  }
}

if (import.meta.main) {
  if (!isSubagent()) {
    const out = run();
    if (out) process.stdout.write(out);
  }
  process.exit(0);
}
