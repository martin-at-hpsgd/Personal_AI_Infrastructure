#!/usr/bin/env bun
/**
 * WorkflowView.ts — one read-only model of every workflow run in a session: its agents by role, its
 * Feature lanes, and (when the launch args name an ISA) the ISA criteria each lane carries and which have landed.
 * WORKFLOWVIEW ISA F0. The workflow answer card (WorkflowCard.ts) is its only reader.
 *
 * Sources, each named by what it supplies:
 *   session transcript (tail window)   Workflow tool_use args, tool_result {workflowName, runId, taskId}, task-notification status
 *   <session>/subagents/workflows/<run>/journal.jsonl   started / result / failed per journal key
 *   <run>/agent-<id>.meta.json         agentType;  agent-<id>.jsonl: first record, last record, API-error ending
 *   <session>/workflows/<run>.json     the harness record written when a run completes: args, status, end time (read at most 1 MB)
 *   the ISA the launch args name       ticked criteria and the frontmatter slug
 *
 * Read-only: it never writes. Every transcript read is bounded to MAX_TRANSCRIPT_BYTES in total.
 * A malformed journal line is counted in `skipped`, never thrown.
 *
 * Run state comes only from the harness: a task-notification row decides (`completed` reads `finished`, any
 * other status reads as itself); with no row the run's completion record decides by the same rule; with
 * neither the run reads `running`. Nothing is guessed from idle time (2026-10-11: native /workflows owns stalls).
 */

import { existsSync, closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getClaudeDir } from "./Paths";

// ── types ───────────────────────────────────────────────────────────────────

/** running / finished, or a non-completed task-notification status shown as itself (`failed`, `killed`, ...). */
export type RunState = "running" | "finished" | (string & {});
export type AgentState = "running" | "done" | "refuted" | "passed" | "failed" | "needs_principal" | "parked";
export type LaneState = "queued" | "running" | "done" | "failed" | "needs_principal" | "parked";
export type CriterionStatus = "ticked" | "open" | "reported";

export interface Agent {
  /** The journal key: one entry per key, however many times it was started. */
  key: string;
  /** The agent of the key's latest attempt. */
  agentId: string;
  label: string;
  /** The journal phase, lower-cased (a phase-less label falls back to its prefix). */
  role: string;
  /** The `F<n>` that starts the label target; null joins the non-ISA group. */
  lane: string | null;
  /** From a `fix<n>` label prefix. */
  round: number | null;
  /** The middle segment of a three-segment label (`verify:Fable:F9 …`). */
  verifier: string | null;
  agentType: string | null;
  state: AgentState;
  /** The synthetic API-error text when the transcript ends on one. */
  died: string | null;
  attempts: number;
  startedAt: string | null;
  endedAt: string | null;
}

export interface Criterion { id: string; text: string; status: CriterionStatus }

export interface Lane {
  id: string;
  name: string;
  state: LaneState;
  reason: string | null;
  attempts: number;
  queued: boolean;
  agentKeys: string[];
  criteria: Criterion[];
}

export interface Run {
  runId: string;
  workflowName: string | null;
  taskId: string | null;
  transcriptDir: string;
  launchedAt: string | null;
  finishedAt: string | null;
  /** The task-notification status; null while no notification row was read. */
  endStatus: string | null;
  state: RunState;
  lastActivityAt: string | null;
  unlinked: boolean;
  /** `args` when the launch args name a readable ISA, null when unlinked. */
  linkedBy: "args" | null;
  /** The launch args' tier when it is an integer from 1 to 5, else null. */
  tier: number | null;
  isaSlug: string | null;
  isaPath: string | null;
  /** The whole ISA's ticked/total; null when unlinked. */
  progress: { ticked: number; total: number } | null;
  /** Across the lanes' criteria; null when unlinked. */
  criteria: { ticked: number; reported: number; open: number; total: number } | null;
  running: number;
  queued: number;
  roles: Record<string, { running: number; total: number }>;
  skipped: number;
  lanes: Lane[];
  agents: Agent[];
  /** Keys of agents whose label names no Feature. */
  nonIsa: string[];
}

export interface Model { session: string; now: string; skipped: number; runs: Run[] }

export interface ReadOptions {
  session: string;
  now?: string | number;
  configRoot?: string;
}

// ── bounded reads ───────────────────────────────────────────────────────────

export const MAX_TRANSCRIPT_BYTES = 128 * 1024;

const stats = new Map<string, number>();
export function resetReadStats(): void { stats.clear(); }
/** Bytes read per transcript path since the last reset. */
export function readStats(): Array<{ path: string; bytes: number }> { return [...stats].map(([path, bytes]) => ({ path, bytes })); }

function readAt(path: string, offset: number, length: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, offset);
    stats.set(path, (stats.get(path) ?? 0) + n);
    return buf.subarray(0, n).toString("utf8");
  } finally { closeSync(fd); }
}

/** The transcript's first and last records without reading more than MAX_TRANSCRIPT_BYTES in all. */
function windows(path: string): { head: string; tail: string; whole: boolean } | null {
  try {
    const size = statSync(path).size;
    if (size <= MAX_TRANSCRIPT_BYTES) { const t = readAt(path, 0, size); return { head: t, tail: t, whole: true }; }
    const half = MAX_TRANSCRIPT_BYTES / 2;
    return { head: readAt(path, 0, half), tail: readAt(path, size - half, half), whole: false };
  } catch { return null; }
}

/** The last MAX_TRANSCRIPT_BYTES of a transcript, starting on a line boundary. */
function tailWindow(path: string): { text: string; partialFirst: boolean } | null {
  try {
    const size = statSync(path).size;
    const len = Math.min(size, MAX_TRANSCRIPT_BYTES);
    return { text: readAt(path, size - len, len), partialFirst: size > len };
  } catch { return null; }
}

// ── small parsers ───────────────────────────────────────────────────────────

const TS_RE = /"timestamp":"(\d{4}-\d\d-\d\dT[^"]+)"/;
function isoOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
function obj(v: unknown): Record<string, unknown> | null { return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; }
function str(v: unknown): string | null { return typeof v === "string" && v ? v : null; }
function clip(s: string, n = 160): string { const one = s.replace(/\s+/g, " ").trim(); return one.length > n ? `${one.slice(0, n - 1)}…` : one; }

interface Times { startedAt: string | null; endedAt: string | null; died: string | null }

function agentTimes(path: string): Times {
  const w = windows(path);
  if (!w) return { startedAt: null, endedAt: null, died: null };
  const first = TS_RE.exec(w.head);
  let last: string | null = null;
  for (const m of w.tail.matchAll(new RegExp(TS_RE.source, "g"))) last = m[1]!;
  let died: string | null = null;
  const lines = w.tail.split("\n").filter((l) => l.trim());
  for (const line of lines.slice(-3).reverse()) {
    let r: Record<string, unknown> | null = null;
    try { r = obj(JSON.parse(line)); } catch { continue; }
    if (!r) continue;
    const msg = obj(r.message);
    if (r.isApiErrorMessage === true || msg?.model === "<synthetic>") {
      const content = Array.isArray(msg?.content) ? (msg!.content as unknown[]) : [];
      const text = content.map((c) => str(obj(c)?.text)).find(Boolean);
      died = clip(text ?? "API error", 200);
    }
    break;
  }
  return { startedAt: isoOf(first?.[1]), endedAt: isoOf(last), died };
}

export interface Label { prefix: string | null; round: number | null; verifier: string | null; lane: string | null; name: string }
export function parseLabel(label: string): Label {
  const parts = label.split(":");
  let prefix: string | null = null;
  let verifier: string | null = null;
  let target = label;
  // The middle segment is a verifier only when it is one bare token (`Fable`, `Astra`) that is not itself a
  // Feature id. `build:F1 Parser: edge cases` has a colon in the Feature name, so its second segment holds a
  // space and the whole remainder is the target.
  const mid = parts[1]?.trim() ?? "";
  if (parts.length >= 3 && mid && !/\s/.test(mid) && !/^F\d+$/.test(mid)) { prefix = parts[0]!.trim(); verifier = mid; target = parts.slice(2).join(":"); }
  else if (parts.length >= 2) { prefix = parts[0]!.trim(); target = parts.slice(1).join(":"); }
  const fix = prefix ? /^fix(\d+)$/i.exec(prefix) : null;
  const lane = /^(F\d+)\b/.exec(target.trim());
  return { prefix, round: fix ? Number(fix[1]) : null, verifier, lane: lane ? lane[1]! : null, name: lane ? target.trim().slice(lane[1]!.length).trim() : target.trim() };
}

// ── journal ─────────────────────────────────────────────────────────────────

interface Slot {
  key: string; agentId: string; label: string; phase: string; attempts: number;
  result: Record<string, unknown> | null; hasResult: boolean; failed: string | null; order: number;
}

function readJournal(path: string): { slots: Slot[]; skipped: number } {
  const slots = new Map<string, Slot>();
  let skipped = 0;
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return { slots: [], skipped: 0 }; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r: Record<string, unknown> | null = null;
    try { r = obj(JSON.parse(line)); } catch { r = null; }
    if (!r || typeof r.type !== "string") { skipped++; continue; }
    if (r.type === "started") {
      const key = str(r.key); const agentId = str(r.agentId);
      if (!key || !agentId) { skipped++; continue; }
      const prev = slots.get(key);
      slots.set(key, {
        key, agentId, label: typeof r.label === "string" ? r.label : "", phase: typeof r.phase === "string" ? r.phase : "",
        attempts: (prev?.attempts ?? 0) + 1, result: null, hasResult: false, failed: null, order: prev?.order ?? slots.size,
      });
    } else if (r.type === "result" || r.type === "failed") {
      const key = str(r.key);
      if (!key) { skipped++; continue; }
      const slot = slots.get(key);
      if (!slot) continue;
      // A result from a superseded attempt never lands on the current one.
      if (typeof r.agentId === "string" && r.agentId !== slot.agentId) continue;
      if (r.type === "result") { slot.hasResult = true; slot.result = obj(r.result); } else slot.failed = str(r.error) ?? str(r.message) ?? "failed";
    }
  }
  return { slots: [...slots.values()].sort((a, b) => a.order - b.order), skipped };
}

// ── session transcript ──────────────────────────────────────────────────────

interface Launch { runId: string; workflowName: string | null; taskId: string | null; at: string | null; toolUseId: string | null; args: unknown }
interface Notice { status: string; at: string | null }

function parseArgs(v: unknown): Record<string, unknown> | null {
  if (typeof v === "string") { try { return obj(JSON.parse(v)); } catch { return null; } }
  return obj(v);
}

function readMain(path: string | null): { launches: Launch[]; notices: Map<string, Notice> } {
  const launches: Launch[] = [];
  const notices = new Map<string, Notice>();
  const w = path ? tailWindow(path) : null;
  if (!w) return { launches, notices };
  const argsByUse = new Map<string, unknown>();
  const lines = w.text.split("\n");
  if (w.partialFirst) lines.shift();
  for (const line of lines) {
    if (!line.includes("workflowName") && !line.includes('"name":"Workflow"')) continue;
    let r: Record<string, unknown> | null = null;
    try { r = obj(JSON.parse(line)); } catch { continue; }
    if (!r) continue;
    const content = obj(r.message)?.content;
    const items = Array.isArray(content) ? content : [];
    for (const it of items) {
      const b = obj(it);
      if (b?.type === "tool_use" && b.name === "Workflow" && str(b.id)) argsByUse.set(b.id as string, obj(b.input)?.args);
    }
    const tur = obj(r.toolUseResult);
    if (tur && str(tur.runId)) {
      const res = items.map((i) => obj(i)).find((b) => b?.type === "tool_result");
      launches.push({ runId: tur.runId as string, workflowName: str(tur.workflowName), taskId: str(tur.taskId), at: isoOf(r.timestamp), toolUseId: str(res?.tool_use_id), args: undefined });
    }
  }
  for (const l of launches) if (l.toolUseId) l.args = argsByUse.get(l.toolUseId);
  // Completion rows are read from the raw window (a long result line may start before it).
  const re = /<task-id>([^<\s]+)<\/task-id>[\s\S]{0,400}?<status>([A-Za-z_]+)<\/status>/g;
  for (const m of w.text.matchAll(re)) {
    const idx = m.index ?? 0;
    const from = w.text.lastIndexOf("\n", idx) + 1;
    const to = w.text.indexOf("\n", idx);
    const at = isoOf(TS_RE.exec(w.text.slice(from, to < 0 ? undefined : to))?.[1]);
    const prev = notices.get(m[1]!);
    if (!prev || (at && prev.at && at < prev.at)) notices.set(m[1]!, { status: m[2]!, at });
  }
  return { launches, notices };
}

// ── ISA ─────────────────────────────────────────────────────────────────────

/** A Feature heading carries a trailing `(after: F0, F1)` ordering note; it is not part of the lane name. */
export function cleanLaneName(name: string): string { return name.replace(/\s*\(after:[^)]*\)\s*$/i, "").trim(); }

function readJson(path: string): unknown { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }

interface IsaRead { slug: string | null; ticked: Set<string>; total: number; texts: Map<string, string> }
/** A criterion line: `- [x] ISC-4: text` or `- [ ] C1 text`. The id is any letters-then-number token (or an `ISC-` word). */
const CRITERION_RE = /^\s*[-*+]\s+\[([ xX])\]\s+(ISC-[\w-]+|[A-Za-z]{1,8}-?\d[\w-]*)(?=[:\s]|$)[:\s]*(.*)$/gm;
function readIsa(path: string | null): IsaRead | null {
  if (!path) return null;
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  const slug = /^---\n[\s\S]*?^slug:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(text)?.[1] ?? null;
  const ticked = new Set<string>();
  const texts = new Map<string, string>();
  let total = 0;
  for (const m of text.matchAll(CRITERION_RE)) { total++; if (m[1] !== " ") ticked.add(m[2]!); if (!texts.has(m[2]!)) texts.set(m[2]!, m[3]!.trim()); }
  return { slug, ticked, total, texts };
}

// ── assembly ────────────────────────────────────────────────────────────────

function findSession(root: string, session: string): { dir: string | null; transcript: string | null } {
  if (!/^[\w.-]+$/.test(session)) return { dir: null, transcript: null };
  const projects = join(root, "projects");
  const probe = (p: string) => ({ dir: existsSync(join(projects, p, session)) ? join(projects, p, session) : null, transcript: existsSync(join(projects, p, `${session}.jsonl`)) ? join(projects, p, `${session}.jsonl`) : null });
  const first = probe(process.cwd().replace(/[/.]/g, "-"));
  if (first.dir || first.transcript) return first;
  let names: string[] = [];
  try { names = readdirSync(projects); } catch { return { dir: null, transcript: null }; }
  for (const n of names) { const p = probe(n); if (p.dir || p.transcript) return p; }
  return { dir: null, transcript: null };
}

/** The most a completion record is read: it carries the script and the result, so it can be large. */
export const MAX_RECORD_BYTES = 1024 * 1024;
interface RunRecord { args: Record<string, unknown> | null; name: string | null; status: string | null; endAt: string | null }

/** <sessionDir>/workflows/<runId>.json, read in at most MAX_RECORD_BYTES; absent, oversized-torn or malformed reads null. */
function readRecord(sessionDir: string | null, runId: string): RunRecord | null {
  if (!sessionDir || !/^[\w-]+$/.test(runId)) return null;
  const path = join(sessionDir, "workflows", `${runId}.json`);
  let text = "";
  try {
    const len = Math.min(statSync(path).size, MAX_RECORD_BYTES);
    const fd = openSync(path, "r");
    try { const buf = Buffer.alloc(len); const n = readSync(fd, buf, 0, len, 0); text = buf.subarray(0, n).toString("utf8"); } finally { closeSync(fd); }
  } catch { return null; }
  let r: Record<string, unknown> | null = null;
  try { r = obj(JSON.parse(text)); } catch { return null; }
  if (!r) return null;
  return { args: parseArgs(r.args), name: str(r.workflowName), status: str(r.status), endAt: isoOf(r.timestamp) };
}

function agentState(role: string, s: Slot, died: string | null): AgentState {
  if (s.failed) return "failed";
  if (!s.hasResult) return died ? "failed" : "running";
  const r = s.result;
  if (role === "verify") return r?.refuted === true ? "refuted" : r?.refuted === false ? "passed" : "done";
  const st = r?.state;
  return st === "needs_principal" || st === "parked" ? st : "done";
}

/** A lane id is exactly a Feature id. */
const LANE_ID_RE = /^F\d+$/;

export function readWorkflowView(opts: ReadOptions): Model {
  const nowMs = opts.now === undefined ? Date.now() : typeof opts.now === "number" ? opts.now : Date.parse(opts.now);
  const root = opts.configRoot ?? getClaudeDir();
  const { dir: sessionDir, transcript } = findSession(root, opts.session);
  const { launches, notices } = readMain(transcript);

  const wfRoot = sessionDir ? join(sessionDir, "subagents", "workflows") : null;
  const runIds = new Set<string>(launches.map((l) => l.runId));
  try { if (wfRoot) for (const n of readdirSync(wfRoot)) if (n.startsWith("wf_")) runIds.add(n); } catch { /* no workflows */ }

  const runs: Run[] = [];
  let skippedTotal = 0;
  for (const runId of runIds) {
    const mine = launches.filter((l) => l.runId === runId).sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
    const latest = mine[mine.length - 1] ?? null;
    const launchedAt = mine[0]?.at ?? null;
    const dir = wfRoot ? join(wfRoot, runId) : runId;
    const argsLaunch = [...mine].reverse().find((l) => parseArgs(l.args));
    // The completion record fills in the args when the transcript window held no launch row (the row scrolled out).
    const record = readRecord(sessionDir, runId);
    const args = (argsLaunch ? parseArgs(argsLaunch.args) : null) ?? record?.args ?? null;
    let workflowName = mine.find((l) => l.workflowName)?.workflowName ?? record?.name ?? null;
    if (!workflowName && sessionDir) {
      try { const f = readdirSync(join(sessionDir, "workflows", "scripts")).find((n) => n.endsWith(`-${runId}.js`)); if (f) workflowName = f.slice(0, -`-${runId}.js`.length); } catch { /* no scripts */ }
    }

    // agents
    const { slots, skipped } = readJournal(join(dir, "journal.jsonl"));
    skippedTotal += skipped;
    const agents: Agent[] = [];
    const results = new Map<string, Record<string, unknown> | null>();
    const activity: number[] = [];
    for (const s of slots) {
      const lab = parseLabel(s.label);
      const role = (s.phase.trim() || (lab.prefix ?? "agent").replace(/\d+$/, "") || "agent").toLowerCase();
      const times = existsSync(join(dir, `agent-${s.agentId}.jsonl`)) ? agentTimes(join(dir, `agent-${s.agentId}.jsonl`)) : { startedAt: null, endedAt: null, died: null };
      const meta = obj(readJson(join(dir, `agent-${s.agentId}.meta.json`)));
      const agentType = str(meta?.agentType);
      const state = agentState(role, s, times.died);
      agents.push({
        key: s.key, agentId: s.agentId, label: s.label, role, lane: lab.lane, round: lab.round, verifier: lab.verifier, agentType, state,
        died: times.died ?? (s.failed && s.failed !== "failed" ? clip(s.failed, 200) : null),
        attempts: s.attempts, startedAt: times.startedAt, endedAt: state === "running" ? null : times.endedAt,
      });
      results.set(s.key, s.result);
      for (const t of [times.startedAt, times.endedAt]) if (t) activity.push(Date.parse(t));
    }

    // run state: a notification row decides (`completed` reads finished, any other status reads as itself); with
    // no row in the window the completion record's status stands in by the same rule; with neither the run is running.
    const rowNotice = latest?.taskId ? notices.get(latest.taskId) ?? null : null;
    const notice: Notice | null = rowNotice ?? (record?.status ? { status: record.status, at: record.endAt } : null);
    const lastActivityMs = Math.max(...activity, launchedAt ? Date.parse(launchedAt) : -Infinity);
    const lastActivityAt = Number.isFinite(lastActivityMs) ? new Date(lastActivityMs).toISOString() : null;
    const endStatus = notice?.status ?? null;
    const finishedAt = notice?.at ?? null;
    const state: RunState = !notice ? "running" : notice.status.toLowerCase() === "completed" ? "finished" : notice.status;

    // tier: the launch args' integer 1-5, else null
    const tier = args && Number.isInteger(args.tier) && (args.tier as number) >= 1 && (args.tier as number) <= 5 ? (args.tier as number) : null;

    // ISA binding: only the launch args' `isa` path links a run to its ISA (F4).
    const argIsa = args ? str(args.isa) : null;
    const argIsaPath = argIsa ? (argIsa.startsWith("/") ? argIsa : join(root, argIsa)) : null;
    const argRead = argIsaPath ? readIsa(argIsaPath) : null;
    const argsLinked = !!argIsa && !!argRead;
    // A lane's `feature` is a Feature id (`F<n>`); any other string is dropped, so a lane id is never free text.
    const argLaneSpecs = argsLinked && args && Array.isArray(args.lanes)
      ? (args.lanes as unknown[]).map((l) => obj(l)).filter((l): l is Record<string, unknown> => !!l && LANE_ID_RE.test(str(l.feature) ?? "")).map((l) => ({
        feature: l.feature as string, name: cleanLaneName(str(l.name) ?? ""),
        criteria: (Array.isArray(l.criteria) ? l.criteria : []).filter((c): c is string => typeof c === "string" && !!c),
      }))
      : [];
    const isaPath = argsLinked ? argIsaPath : null;
    const isa = argsLinked ? argRead : null;

    const laneIds: string[] = [];
    for (const a of agents) if (a.lane && !laneIds.includes(a.lane)) laneIds.push(a.lane);
    const argLane = (id: string) => { const a = argLaneSpecs.find((l) => l.feature === id); return a ? { name: a.name, criteria: a.criteria.map((cid) => ({ id: cid, text: isa?.texts.get(cid) ?? "" })) } : undefined; };
    for (const l of argLaneSpecs) if (!laneIds.includes(l.feature)) laneIds.push(l.feature);

    const lanes: Lane[] = laneIds.map((id) => {
      const mineA = agents.filter((a) => a.lane === id);
      const bl = argLane(id);
      const reported = new Set<string>();
      for (const a of mineA) {
        if (a.role !== "build" && a.role !== "fix") continue;
        const g = results.get(a.key)?.green;
        if (Array.isArray(g)) for (const x of g) if (typeof x === "string") reported.add(x);
      }
      const criteria: Criterion[] = (bl?.criteria ?? []).map((c) => ({ id: c.id, text: c.text, status: isa?.ticked.has(c.id) ? "ticked" : reported.has(c.id) ? "reported" : "open" }));
      const queued = mineA.length === 0;
      const roundVerifies = mineA.slice(mineA.findLastIndex((a) => a.role !== "verify") + 1).filter((a) => a.role === "verify");
      let laneState: LaneState; let reason: string | null = null;
      const failedA = mineA.find((a) => a.state === "failed");
      const needs = mineA.find((a) => a.state === "needs_principal");
      const parked = mineA.find((a) => a.state === "parked");
      if (failedA) { laneState = "failed"; reason = failedA.died ?? "agent failed"; }
      else if (needs) { laneState = "needs_principal"; const s = results.get(needs.key)?.summary; reason = typeof s === "string" ? clip(s) : null; }
      else if (parked) { laneState = "parked"; const s = results.get(parked.key)?.summary; reason = typeof s === "string" ? clip(s) : null; }
      else if (queued) laneState = "queued";
      else if (state !== "finished" && state !== "running" && !(roundVerifies.length > 0 && roundVerifies.every((a) => a.state === "passed"))) { laneState = "failed"; reason = `run ${state}`; }
      else if (mineA.some((a) => a.state === "running")) laneState = "running";
      else if (state === "finished" || (roundVerifies.length > 0 && roundVerifies.every((a) => a.state === "passed"))) laneState = "done";
      else laneState = "running";
      return {
        id, name: bl?.name || (() => { const a = mineA[0]; return a ? cleanLaneName(parseLabel(a.label).name) : ""; })(), state: laneState, reason,
        attempts: Math.max(0, ...mineA.map((a) => a.attempts)), queued, agentKeys: mineA.map((a) => a.key), criteria,
      };
    });
    const critAll = lanes.flatMap((l) => l.criteria);
    const roles: Record<string, { running: number; total: number }> = {};
    for (const a of agents) { const t = (roles[a.role] ??= { running: 0, total: 0 }); t.total++; if (a.state === "running") t.running++; }

    runs.push({
      runId, workflowName, taskId: latest?.taskId ?? null, transcriptDir: dir, launchedAt: launchedAt ?? agents.map((a) => a.startedAt).filter((t): t is string => !!t).sort()[0] ?? null,
      finishedAt, endStatus, state, lastActivityAt,
      unlinked: !argsLinked, linkedBy: argsLinked ? "args" : null, tier,
      isaSlug: isa?.slug ?? null, isaPath,
      progress: isa ? { ticked: isa.ticked.size, total: isa.total } : null,
      criteria: argsLinked ? { ticked: critAll.filter((c) => c.status === "ticked").length, reported: critAll.filter((c) => c.status === "reported").length, open: critAll.filter((c) => c.status === "open").length, total: critAll.length } : null,
      running: agents.filter((a) => a.state === "running").length, queued: lanes.filter((l) => l.queued).length, roles, skipped, lanes, agents,
      nonIsa: agents.filter((a) => !a.lane).map((a) => a.key),
    });
  }
  runs.sort((a, b) => (a.launchedAt ?? "9").localeCompare(b.launchedAt ?? "9") || a.runId.localeCompare(b.runId));
  return { session: opts.session, now: new Date(nowMs).toISOString(), skipped: skippedTotal, runs };
}
