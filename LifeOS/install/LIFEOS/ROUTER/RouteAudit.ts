#!/usr/bin/env bun
/**
 * @version 1.0.0
 * RouteAudit.ts — did the last N sessions actually delegate, or did the carrier do it all?
 *
 * Router ISA R7. Ground truth is the harness transcript (`message.model` + `message.usage`
 * on every assistant message, `tool_use` blocks for dispatches) and codex's own rollout
 * logs (~/.codex/sessions/**\/rollout-*.jsonl, cumulative `total_token_usage`). Our own
 * dispatch logging is never the source: a silently-downgraded or wrapper-answered dispatch
 * shows up here as the model that really ran.
 *
 * Two rates the principal asked for ("are we actually delegating to lower
 * models like we're supposed to based on the router"):
 *   delegationRate — heavy sessions (≥ TOOL_CALL_THRESHOLD tool calls) with ≥1 dispatch to
 *                    any delegate lane (hooks/lib/delegation.ts DELEGATE_TYPES).
 *   offCarrierRate — heavy sessions where some dispatched work RAN off the carrier: a codex
 *                    lane (Astra/Sol/Terra/Luna/Pentest) or a Claude subagent on sonnet/haiku.
 *                    Fable→Fable and Fable→Opus count as delegation but not as down-motion.
 *
 * Codex attribution: a rollout belongs to the ONE session whose window [first, last]±slop
 * covers its start AND dispatched an agent mapped to the rollout's model; among candidates the one
 * that started latest before the rollout wins. Never split, never double-counted.
 *
 * Execution shape (F3, R73–R77): each session is inline, agents or workflow, read from the main
 * transcript's own tool calls, and the audit reports outcome by shape: minutes to the first edit,
 * corrections per 100 judged turns, and Errata complaints joined by session id.
 *
 * Usage: bun LIFEOS/ROUTER/RouteAudit.ts [--sessions N] [--days D] [--rows] [--json]
 *   (also `bun LIFEOS/ROUTER/Router.ts audit …`). Env for tests: ROUTE_AUDIT_PROJECTS,
 *   ROUTE_AUDIT_CODEX.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DELEGATE_TYPES, isDirectDispatch, TOOL_CALL_THRESHOLD } from "../../hooks/lib/delegation";
import { rolloutRoots as codexRolloutRoots } from "../TOOLS/CodexUsage";
import { CROSS_VENDOR, CURRENT, WORK_LADDER, cmpClaudeVersion, parseClaudeId } from "../TOOLS/models";
import { readAll, type TurnRecord } from "../TOOLS/TurnOutcomes";
import { ERRATA_DIR, ErrataStore } from "../ERRATA/Store";
import { lifeosPath } from "../TOOLS/Paths";

// Terra and Luna stay so transcripts from before 2026-10-07 still count as codex dispatches.
export const CODEX_TYPES = new Set(["Astra", "Sol", "Terra", "Luna", "Pentest", "CodexResearcher", "Gemini", "Grok", "GeminiResearcher"]);
const LOWER_CLAUDE_RE = /sonnet|haiku/i;
const SLOP_MS = 5 * 60_000;
const MIN_TRANSCRIPT_BYTES = 2000;
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
/** Errata kinds that record something going wrong; praise, questions and feature requests do not. */
const COMPLAINT_KINDS = new Set(["complaint", "bug", "correction", "incident"]);
/**
 * R57: each router lane's rung, so a pick is "below the carrier" only when its rung is under the turn's own
 * carrier (a sonnet pick in a Sonnet session is the carrier's own lane, not a hand-off). Sol sits at Sonnet's
 * rank (2026-09-29); Astra beside Opus on the max rung; Terra and Luna are the retired lower rungs Haiku took
 * over (2026-10-07), the same mapping Assay's laneOfAgent uses.
 */
export const LANE_RANK: Readonly<Record<string, number>> = {
  luna: 1, terra: 1, haiku: 1,
  sonnet: 2, sol: 2,
  opus: 3, astra: 3,
  fable: 4,
};
const INLINE_REASON = "🔀 INLINE:";

/**
 * R57: whether a main-loop text block states an INLINE reason. The reason is its own line, `🔀 INLINE: <reason>`, with
 * words after the colon. The marker quoted inside a sentence or a code span, written inside a fenced block, left bare,
 * or followed only by the `<reason>` placeholder states no reason, and the turn stays ignored.
 */
export function statesInlineReason(text: string): boolean {
  let fenced = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced || !line.startsWith(INLINE_REASON)) continue;
    const reason = line.slice(INLINE_REASON.length).trim();
    if (/[\p{L}\p{N}]/u.test(reason) && !/^<[^>]*>\.?$/.test(reason)) return true;
  }
  return false;
}

export type Shape = "inline" | "agents" | "workflow";
export const SHAPES: readonly Shape[] = ["inline", "agents", "workflow"];

export interface ShapeOutcome {
  sessions: number;
  medianMinutesToFirstEdit: number | null;
  judged: number;
  corrected: number;
  corrections_per_100: number | null;
  reason?: string;
  medianSubagents: number | null;
  abandoned: number;
  complaints: number;
  complaintsPer10: number | null;
}

export interface SessionRow {
  id: string;
  project: string;
  when: string;
  firstMs: number;
  lastMs: number;
  mainModel: string;
  mainOut: number;
  turns: number;
  toolCalls: number;
  dispatches: Record<string, number>;
  delegateDispatches: number;
  subOut: Record<string, number>;
  codexTokens: Record<string, number>;
  heavy: boolean;
  delegated: boolean;
  offCarrier: boolean;
  outcomes: { corrected: number; re_asked: number; accepted: number; abandoned: number; unresolved: number };
  shape: Shape;
  minutesToFirstEdit: number | null;
  subagents: number;
  errataComplaints: number;
}

/** R57: below-carrier picks whose turn is in the audited transcripts, and how many that same turn followed. */
export interface PickFollowThrough {
  picks: number;
  /** dispatched + inline */
  followed: number;
  /** the turn dispatched the picked lane: an Agent/Task subagent of that lane, or a direct worker leg */
  dispatched: number;
  /** no dispatch to the lane, but the turn stated one `🔀 INLINE:` reason */
  inline: number;
  ignored: number;
  /** followed / picks as a percentage; null with no picks */
  rate: number | null;
}

export interface Audit {
  sessions: number;
  range: { from: string; to: string };
  heavy: number;
  heavyDelegated: number;
  heavyOffCarrier: number;
  delegationRate: number;
  offCarrierRate: number;
  mainByModel: Record<string, number>;
  subByModel: Record<string, number>;
  /** Claude subagent output on an id older than CURRENT for its tier: an alias that resolved behind the registry. */
  staleSubModels: Record<string, number>;
  codexByModel: Record<string, number>;
  unattributed: number;
  agentTypes: Record<string, number>;
  topRungShare: number;
  /** The model the top-rung share measures: the main loop's biggest by output tokens in this window. */
  topModel: string;
  outcomeByDelegation: {
    delegated: { sessions: number; judged: number; corrected: number; corrections_per_100: number | null; reason?: string };
    notDelegated: { sessions: number; judged: number; corrected: number; corrections_per_100: number | null; reason?: string };
  };
  outcomeByShape: Record<Shape, ShapeOutcome>;
  pickFollowThrough: PickFollowThrough;
  rows: SessionRow[];
}

export interface AuditOptions {
  projectsDir: string;
  codexDir?: string;
  sessions?: number;
  sinceMs?: number;
  /** Only sessions last written before this (Router ISA R169: the week before, for the week-over-week target). */
  untilMs?: number;
  heavyThreshold?: number;
  /** Errata ledger dir. Unset reads no Errata; defaultOptions points it at the live ledger. */
  errataDir?: string;
  /** router-decisions.jsonl (R57). Unset reads no picks; defaultOptions points it at the live log. */
  decisionsPath?: string;
}

export interface Rollout { start: number; model: string; tokens: number }

function add(o: Record<string, number>, k: string, v: number): void { o[k] = (o[k] ?? 0) + v; }

export function listSessions(projectsDir: string): Array<{ id: string; file: string; dir: string; project: string; mtime: number }> {
  const out: Array<{ id: string; file: string; dir: string; project: string; mtime: number }> = [];
  if (!existsSync(projectsDir)) return out;
  for (const p of readdirSync(projectsDir)) {
    if (p.includes("-subagents-")) continue; // workflow/subagent sidechains are not sessions
    const pd = join(projectsDir, p);
    let st; try { st = statSync(pd); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(pd)) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = join(pd, f);
      let fs; try { fs = statSync(fp); } catch { continue; }
      if (fs.size < MIN_TRANSCRIPT_BYTES) continue;
      out.push({ id: f.slice(0, -6), file: fp, dir: pd, project: p, mtime: fs.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function rolloutRoots(codexDir: string | undefined): string[] {
  const roots = codexDir ? [codexDir] : codexRolloutRoots();
  const homes = process.env.ROUTE_AUDIT_CODEX_HOMES;
  if (homes && existsSync(homes)) {
    try { for (const d of readdirSync(homes)) roots.push(join(homes, d, "sessions")); }
    catch { /* no homes dir */ }
  }
  return [...new Set(roots)].filter((r) => existsSync(r));
}

export function readRollouts(roots: string[]): Rollout[] {
  const rolls: Rollout[] = [];

  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      if (!e.startsWith("rollout-") || !e.endsWith(".jsonl")) continue;
      const txt = readFileSync(p, "utf8");
      const ts = txt.slice(0, 2000).match(/"timestamp":"([^"]+)"/)?.[1];
      const model = txt.match(/"model":"([^"]+)"/)?.[1] ?? "?";
      const idx = txt.lastIndexOf('"total_token_usage"');
      const tokens = idx >= 0 ? Number(txt.slice(idx).match(/"total_tokens":(\d+)/)?.[1] ?? 0) : 0;
      rolls.push({ start: ts ? Date.parse(ts) : st.mtimeMs, model, tokens });
    }
  };

  for (const root of roots) walk(root);
  return rolls;
}

const modelAgents = new Map<string, Set<string>>();
for (const agent of new Set([...Object.values(WORK_LADDER).flat(), ...CODEX_TYPES])) {
  const key = agent[0].toLowerCase() + agent.slice(1);
  const model = CROSS_VENDOR[key];
  if (model) {
    const agents = modelAgents.get(model) ?? new Set<string>();
    agents.add(agent);
    modelAgents.set(model, agents);
  }
}
/**
 * Lane words a model id carries, so a rollout from before a registry bump (an older `-sol` id after the sol lane moved on) still finds its lane.
 * Derived from the registry, never listed here: a lane has a word when its own CROSS_VENDOR id ends in `-<lane>`. A lane whose id
 * carries no such word (a fixed `-latest` alias) is still found by the exact registry match in modelAgents.
 */
const LANE_WORDS: ReadonlyArray<[RegExp, string]> = Object.entries(CROSS_VENDOR)
  .filter(([lane, id]) => /^[a-z]+$/.test(lane) && id.endsWith(`-${lane}`))
  .map(([lane]) => [new RegExp(`-${lane}\\b`), lane]);
/** The agent types that could have produced a rollout of `model`: exact registry matches, plus every agent of the lane its id names. */
export function agentsForModel(model: string): Set<string> {
  const out = new Set(modelAgents.get(model) ?? []);
  for (const [re, lane] of LANE_WORDS) if (re.test(model)) for (const [m, agents] of modelAgents) if (m === CROSS_VENDOR[lane]) agents.forEach(a => out.add(a));
  return out;
}

/** Subagent transcripts: `<session>/subagents/*.jsonl` plus Workflow tool agents one level down in `subagents/workflows/<run>/` (R73). */
function subagentFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
  const wf = join(dir, "workflows");
  if (existsSync(wf)) for (const run of readdirSync(wf)) {
    const rd = join(wf, run);
    try { if (!statSync(rd).isDirectory()) continue; } catch { continue; }
    // Only agent transcripts: each run folder also holds the Workflow tool's journal.jsonl, which is no agent (R78).
    for (const f of readdirSync(rd)) if (f.startsWith("agent-") && f.endsWith(".jsonl")) files.push(join(rd, f));
  }
  return files;
}

/** Output tokens by model, the earliest edit any subagent made (R75), and how many subagents ran (R78). */
function readSubagents(dir: string): { byModel: Record<string, number>; firstEditMs: number; count: number } {
  const byModel: Record<string, number> = {};
  let firstEditMs = NaN;
  const files = subagentFiles(dir);
  for (const file of files) {
    for (const l of readFileSync(file, "utf8").split("\n")) {
      if (!l.includes('"assistant"')) continue;
      let j: any; try { j = JSON.parse(l); } catch { continue; }
      if (j.type !== "assistant") continue;
      add(byModel, j.message?.model ?? "?", j.message?.usage?.output_tokens ?? 0);
      const t = j.timestamp ? Date.parse(j.timestamp) : NaN;
      if (Number.isNaN(t)) continue;
      for (const c of j.message?.content ?? []) {
        if (c?.type === "tool_use" && EDIT_TOOLS.has(c.name) && (Number.isNaN(firstEditMs) || t < firstEditMs)) firstEditMs = t;
      }
    }
  }
  return { byModel, firstEditMs, count: files.length };
}

/**
 * R57: what one main-loop turn did with the work: the lanes it dispatched, whether it stated an INLINE reason, and
 * the carrier model that answered it (the turn's first assistant line with a real model).
 */
type TurnEvidence = Map<string, { lanes: Set<string>; inline: boolean; carrier: string | null }>;

/** The router lane an agent type runs on ("Sonnet", "SonnetHigh" → sonnet), or null. Agents are named for their model. */
export function laneOfAgent(type: string): string | null {
  const t = type.toLowerCase();
  for (const lane of Object.keys(LANE_RANK)) if (t.startsWith(lane)) return lane;
  return null;
}

/**
 * R57: the rung of the model carrying a turn. A Claude id ranks by its tier; a codex front door's model ranks by the
 * lane its name carries ("gpt-6.1-sol" → sol). Null when the model is unknown, so the pick cannot be judged.
 */
export function carrierRank(model: string | null): number | null {
  if (!model) return null;
  const tier = parseClaudeId(model)?.tier;
  if (tier) return LANE_RANK[tier] ?? null;
  for (const lane of Object.keys(LANE_RANK)) if (new RegExp(`(^|[^a-z])${lane}([^a-z]|$)`).test(model.toLowerCase())) return LANE_RANK[lane]!;
  return null;
}

/**
 * R57: join router-decisions.jsonl to the audited transcripts by session and turn. A pick counts only when its turn
 * appears in an audited transcript and its lane's rung is below that turn's carrier: a same-rank or higher pick asks
 * for no hand-off, and a turn whose carrier is unknown cannot be judged. A holdout row showed no route line, so it is
 * never counted against the carrier.
 */
export function pickFollowThrough(decisionsPath: string | undefined, evidence: Map<string, TurnEvidence>): PickFollowThrough {
  const out: PickFollowThrough = { picks: 0, followed: 0, dispatched: 0, inline: 0, ignored: 0, rate: null };
  if (!decisionsPath || !existsSync(decisionsPath)) return out;
  const seen = new Set<string>();
  for (const l of readFileSync(decisionsPath, "utf8").split("\n")) {
    if (!l.startsWith("{")) continue;
    let d: any; try { d = JSON.parse(l); } catch { continue; }
    if (typeof d.session !== "string" || typeof d.turn !== "string") continue;
    const key = `${d.session}\u0000${d.turn}`;
    if (seen.has(key)) continue; // one decision per turn: the first row is the front door's
    seen.add(key);
    if (d.holdout === true || typeof d.lane !== "string" || LANE_RANK[d.lane] === undefined) continue;
    const ev = evidence.get(d.session)?.get(d.turn);
    if (!ev) continue;
    const carrier = carrierRank(ev.carrier);
    if (carrier === null || LANE_RANK[d.lane]! >= carrier) continue;
    out.picks++;
    if (ev.lanes.has(d.lane)) out.dispatched++;
    else if (ev.inline) out.inline++;
    else out.ignored++;
  }
  out.followed = out.dispatched + out.inline;
  out.rate = out.picks === 0 ? null : Math.round((out.followed / out.picks) * 1000) / 10;
  return out;
}

export function auditSessions(opts: AuditOptions): Audit {
  const threshold = opts.heavyThreshold ?? TOOL_CALL_THRESHOLD;
  const evidenceBySession = new Map<string, TurnEvidence>();
  const outcomesBySession = new Map<string, TurnRecord[]>();
  for (const record of readAll()) {
    const records = outcomesBySession.get(record.session) ?? [];
    records.push(record);
    outcomesBySession.set(record.session, records);
  }
  let picked = listSessions(opts.projectsDir);
  if (opts.sinceMs) picked = picked.filter((s) => s.mtime >= opts.sinceMs!);
  if (opts.untilMs) picked = picked.filter((s) => s.mtime < opts.untilMs!);
  if (opts.sessions) picked = picked.slice(0, opts.sessions);
  const roots = rolloutRoots(opts.codexDir);
  const rollouts = readRollouts(roots);
  const complaintsBySession = new Map<string, number>();
  const errata = opts.errataDir ? new ErrataStore(opts.errataDir, join(opts.errataDir, "tenants")).all() : [];
  for (const e of errata) {
    // Capture.ts writes the session under context; a top-level session_id is the schema's optional field.
    const sid = (e.context as { session_id?: string | null } | undefined)?.session_id ?? (e as { session_id?: string | null }).session_id;
    if (sid && COMPLAINT_KINDS.has(e.kind)) complaintsBySession.set(sid, (complaintsBySession.get(sid) ?? 0) + 1);
  }

  const rows: SessionRow[] = [];
  for (const s of picked) {
    let first = Infinity, last = 0, mainOut = 0, turns = 0, toolCalls = 0;
    let firstPromptMs = NaN, firstEditMs = NaN, workflowCalls = 0, agentCalls = 0;
    const mainModels: Record<string, number> = {};
    const dispatches: Record<string, number> = {};
    const turns_: TurnEvidence = new Map();
    let currentTurn: string | null = null;
    for (const l of readFileSync(s.file, "utf8").split("\n")) {
      if (!l.startsWith("{")) continue;
      let j: any; try { j = JSON.parse(l); } catch { continue; }
      // R57: the harness stamps main-loop USER lines (the prompt and each tool result) with the prompt's id, the same id
      // the router logs as `turn`; assistant lines carry none and belong to the turn of the user line before them.
      // Sidechain lines are a subagent's, never the main loop's.
      if (j.isSidechain !== true && typeof j.promptId === "string") currentTurn = j.promptId;
      const pid = j.isSidechain === true ? null : currentTurn;
      const ev = pid ? (turns_.get(pid) ?? turns_.set(pid, { lanes: new Set(), inline: false, carrier: null }).get(pid)!) : null;
      const t = j.timestamp ? Date.parse(j.timestamp) : NaN;
      if (!Number.isNaN(t)) { first = Math.min(first, t); last = Math.max(last, t); }
      if (j.type === "user" && typeof j.message?.content === "string") { turns++; if (Number.isNaN(firstPromptMs)) firstPromptMs = t; }
      if (j.type !== "assistant" || !j.message) continue;
      if (ev && ev.carrier === null && typeof j.message.model === "string" && j.message.model !== "<synthetic>") ev.carrier = j.message.model;
      const o = j.message.usage?.output_tokens ?? 0;
      add(mainModels, j.message.model ?? "?", o); mainOut += o;
      for (const c of Array.isArray(j.message.content) ? j.message.content : []) {
        if (ev && c?.type === "text" && typeof c.text === "string" && statesInlineReason(c.text)) ev.inline = true;
        if (c?.type !== "tool_use") continue;
        toolCalls++;
        if (c.name === "Workflow") workflowCalls++;
        if (EDIT_TOOLS.has(c.name) && Number.isNaN(firstEditMs)) firstEditMs = t;
        if (c.name === "Agent" || c.name === "Task") {
          agentCalls++;
          const type = String(c.input?.subagent_type ?? "general-purpose");
          add(dispatches, type, 1);
          const lane = laneOfAgent(type);
          if (ev && lane) ev.lanes.add(lane);
        }
        // A leg now goes down in one Bash call (OPERATIONAL_PREFERENCES § Model selection, R31). The delegation
        // meter has counted that as a dispatch since 2026-09-19; the audit had not, so every Worker.ts hand-off
        // read as one more mechanical call on the carrier and the meter reported the opposite of the truth.
        else if (c.name === "Bash" && isDirectDispatch(String(c.input?.command ?? ""))) {
          const m = /\bWorker\.ts\s+(luna|terra|sol|astra)\b/i.exec(String(c.input?.command ?? ""));
          const lane = m ? m[1].toLowerCase() : "";
          add(dispatches, lane ? lane[0].toUpperCase() + lane.slice(1) : "Sol", 1);
          if (ev) ev.lanes.add(lane || "sol");
          agentCalls++;
        }
      }
    }
    evidenceBySession.set(s.id, turns_);
    const mainModel = Object.entries(mainModels).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "?";
    const sub = readSubagents(join(s.dir, s.id, "subagents"));
    const subOut = sub.byModel;
    if (!Number.isNaN(sub.firstEditMs) && (Number.isNaN(firstEditMs) || sub.firstEditMs < firstEditMs)) firstEditMs = sub.firstEditMs;
    const delegateDispatches = Object.entries(dispatches).filter(([k]) => DELEGATE_TYPES.has(k)).reduce((a, [, v]) => a + v, 0);
    const heavy = toolCalls >= threshold;
    const outcomes = { corrected: 0, re_asked: 0, accepted: 0, abandoned: 0, unresolved: 0 };
    for (const record of outcomesBySession.get(s.id) ?? []) {
      if (record.outcome === null) outcomes.unresolved++;
      else outcomes[record.outcome === "re-asked" ? "re_asked" : record.outcome]++;
    }
    const shape: Shape = workflowCalls > 0 ? "workflow" : agentCalls > 0 ? "agents" : "inline";
    const minutesToFirstEdit = Number.isNaN(firstEditMs) || Number.isNaN(firstPromptMs) ? null : Math.round((firstEditMs - firstPromptMs) / 6_000) / 10;
    rows.push({
      id: s.id, project: s.project, when: new Date(s.mtime).toISOString().slice(0, 10), firstMs: first, lastMs: last,
      mainModel, mainOut, turns, toolCalls, dispatches, delegateDispatches, subOut, codexTokens: {},
      heavy, delegated: delegateDispatches > 0, offCarrier: false, outcomes,
      shape, minutesToFirstEdit, subagents: sub.count, errataComplaints: complaintsBySession.get(s.id) ?? 0,
    });
  }

  // codex attribution: one owner per rollout
  const codexCandidates = rows.filter((r) => Number.isFinite(r.firstMs));
  let unattributed = 0;
  // Only rollouts inside the audited window can be unattributed; one from before the window is simply out of scope.
  const windowStart = Math.min(...codexCandidates.map((r) => r.firstMs)) - SLOP_MS, windowEnd = Math.max(...codexCandidates.map((r) => r.lastMs)) + SLOP_MS;
  for (const roll of rollouts) {
    const agents = agentsForModel(roll.model);
    const owner = codexCandidates
      .filter((r) => [...agents].some((agent) => r.dispatches[agent] > 0) && roll.start >= r.firstMs - SLOP_MS && roll.start <= r.lastMs + SLOP_MS)
      .sort((a, b) => b.firstMs - a.firstMs)[0];
    if (owner) add(owner.codexTokens, roll.model, roll.tokens);
    else if (roll.start >= windowStart && roll.start <= windowEnd) unattributed += roll.tokens;
  }
  const codexObservable = roots.length > 0;
  for (const r of rows) {
    const lowerClaude = Object.entries(r.subOut).some(([m, v]) => LOWER_CLAUDE_RE.test(m) && v > 0);
    const codexRan = Object.values(r.codexTokens).some((v) => v > 0);
    const codexAsked = Object.keys(r.dispatches).some((k) => CODEX_TYPES.has(k));
    r.offCarrier = lowerClaude || codexRan || (codexAsked && !codexObservable); // no rollout log to read → the ask is the evidence
  }

  const mainByModel: Record<string, number> = {}, subByModel: Record<string, number> = {}, codexByModel: Record<string, number> = {}, agentTypes: Record<string, number> = {};
  let heavy = 0, heavyDelegated = 0, heavyOffCarrier = 0;
  const outcomeByDelegation = {
    delegated: { sessions: 0, judged: 0, corrected: 0, corrections_per_100: null as number | null },
    notDelegated: { sessions: 0, judged: 0, corrected: 0, corrections_per_100: null as number | null },
  };
  for (const r of rows) {
    add(mainByModel, r.mainModel, r.mainOut);
    for (const [m, v] of Object.entries(r.subOut)) add(subByModel, m, v);
    for (const [m, v] of Object.entries(r.codexTokens)) add(codexByModel, m, v);
    for (const [k, v] of Object.entries(r.dispatches)) add(agentTypes, k, v);
    if (r.heavy) {
      heavy++; if (r.delegated) heavyDelegated++; if (r.offCarrier) heavyOffCarrier++;
      const bucket = r.delegated ? outcomeByDelegation.delegated : outcomeByDelegation.notDelegated;
      bucket.sessions++;
      bucket.corrected += r.outcomes.corrected;
      bucket.judged += r.outcomes.corrected + r.outcomes.re_asked + r.outcomes.accepted;
    }
  }
  const outcomeByShape = Object.fromEntries(SHAPES.map((shape) => {
    const heavyRows = rows.filter((r) => r.heavy && r.shape === shape);
    const edits = heavyRows.map((r) => r.minutesToFirstEdit).filter((m): m is number => m !== null).sort((x, y) => x - y);
    const judged = heavyRows.reduce((n, r) => n + r.outcomes.corrected + r.outcomes.re_asked + r.outcomes.accepted, 0);
    const corrected = heavyRows.reduce((n, r) => n + r.outcomes.corrected, 0);
    const complaints = heavyRows.reduce((n, r) => n + r.errataComplaints, 0);
    const median = (xs: number[]): number | null => {
      if (xs.length === 0) return null;
      const m = Math.floor(xs.length / 2);
      return xs.length % 2 ? xs[m] : Math.round(5 * (xs[m - 1] + xs[m])) / 10;
    };
    const out: ShapeOutcome = {
      sessions: heavyRows.length,
      medianMinutesToFirstEdit: median(edits),
      medianSubagents: median(heavyRows.map((r) => r.subagents).sort((x, y) => x - y)),
      abandoned: heavyRows.reduce((n, r) => n + r.outcomes.abandoned, 0),
      complaints,
      judged, corrected,
      corrections_per_100: judged < 20 ? null : Math.round(1000 * corrected / judged) / 10,
      ...(judged < 20 ? { reason: "judged<20" } : {}),
      complaintsPer10: heavyRows.length === 0 ? null : Math.round(100 * complaints / heavyRows.length) / 10,
    };
    return [shape, out];
  })) as Record<Shape, ShapeOutcome>;
  const staleSubModels = staleClaudeModels(subByModel);
  const claudeTotal = Object.values(mainByModel).reduce((a, b) => a + b, 0) + Object.values(subByModel).reduce((a, b) => a + b, 0);
  const topModel = Object.entries(mainByModel).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "?";
  const topTokens = (mainByModel[topModel] ?? 0) + (subByModel[topModel] ?? 0);
  const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);
  const outcomeRate = (bucket: typeof outcomeByDelegation.delegated) => bucket.judged < 20
    ? { ...bucket, corrections_per_100: null, reason: "judged<20" }
    : { ...bucket, corrections_per_100: Math.round(1000 * bucket.corrected / bucket.judged) / 10 };
  return {
    sessions: rows.length,
    range: { from: rows[rows.length - 1]?.when ?? "", to: rows[0]?.when ?? "" },
    heavy, heavyDelegated, heavyOffCarrier,
    delegationRate: pct(heavyDelegated, heavy),
    offCarrierRate: pct(heavyOffCarrier, heavy),
    mainByModel, subByModel, staleSubModels, codexByModel, unattributed, agentTypes,
    topRungShare: pct(topTokens, claudeTotal),
    topModel,
    outcomeByDelegation: { delegated: outcomeRate(outcomeByDelegation.delegated), notDelegated: outcomeRate(outcomeByDelegation.notDelegated) },
    outcomeByShape,
    pickFollowThrough: pickFollowThrough(opts.decisionsPath, evidenceBySession),
    rows,
  };
}

/** Ids whose tier has a newer CURRENT (some Sonnet dispatches ran the previous Sonnet in sessions on an older harness). */
export function staleClaudeModels(byModel: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [m, v] of Object.entries(byModel)) {
    const p = parseClaudeId(m);
    if (p?.tier && v > 0 && cmpClaudeVersion(m, CURRENT[p.tier]) < 0) out[m] = v;
  }
  return out;
}

export function formatAudit(a: Audit, withRows = false): string {
  const fmt = (o: Record<string, number>): string => Object.entries(o).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${v.toLocaleString()}`).join("  ") || "none";
  const out: string[] = [];
  out.push(`sessions=${a.sessions}  range=${a.range.from}..${a.range.to}`);
  out.push(`heavy (≥${TOOL_CALL_THRESHOLD} tool calls)=${a.heavy}  delegated=${a.heavyDelegated} (${a.delegationRate}%)  off-carrier=${a.heavyOffCarrier} (${a.offCarrierRate}%)`);
  out.push(`top-rung share of Claude output tokens: ${a.topRungShare}%`);
  out.push(`main loop out: ${fmt(a.mainByModel)}`);
  out.push(`subagents out: ${fmt(a.subByModel)}`);
  out.push(`stale subagent models (behind CURRENT): ${fmt(a.staleSubModels)}`);
  out.push(`codex (attributed, in+out): ${fmt(a.codexByModel)}`);
  out.push(`codex unattributed (in+out): ${a.unattributed.toLocaleString()}`);
  out.push(`dispatches: ${fmt(a.agentTypes)}`);
  out.push("Outcome by delegation");
  out.push(Object.entries(a.outcomeByDelegation).map(([name, bucket]) => `${name}: sessions=${bucket.sessions} judged=${bucket.judged} corrected=${bucket.corrected} ${bucket.corrections_per_100 === null ? bucket.reason! : `rate=${bucket.corrections_per_100}`}`).join("  "));
  out.push("Outcome by shape (heavy sessions)");
  out.push(SHAPES.map((shape) => {
    const o = a.outcomeByShape[shape];
    const rate = o.corrections_per_100 === null ? o.reason ?? "judged<20" : `rate=${o.corrections_per_100}`;
    return `${shape}: sessions=${o.sessions} judged=${o.judged} corrected=${o.corrected} abandoned=${o.abandoned} ${rate} firstEditMin=${o.medianMinutesToFirstEdit ?? "none"} subagents=${o.medianSubagents ?? "none"} complaints=${o.complaints} (per10sessions=${o.complaintsPer10 ?? "none"})`;
  }).join("  "));
  const p = a.pickFollowThrough;
  out.push(p.picks === 0
    ? "below-carrier picks: none"
    : `below-carrier picks: ${p.followed} of ${p.picks} followed (dispatched ${p.dispatched}, INLINE ${p.inline}, ignored ${p.ignored}) · ${p.rate}%`);
  if (withRows) {
    out.push("");
    for (const r of a.rows) out.push(`${r.when} ${r.id.slice(0, 8)} ${r.mainModel.replace("claude-", "")} out=${r.mainOut} calls=${r.toolCalls} ${r.shape}${r.heavy ? " HEAVY" : ""}${r.delegated ? " delegated" : ""}${r.offCarrier ? " off-carrier" : ""} ${JSON.stringify(r.dispatches)}`);
  }
  return out.join("\n");
}

export function defaultOptions(argv: string[]): AuditOptions {
  const home = process.env.HOME ?? "";
  const num = (flag: string): number | undefined => { const i = argv.indexOf(flag); return i >= 0 ? Number(argv[i + 1]) : undefined; };
  const days = num("--days");
  return {
    projectsDir: process.env.ROUTE_AUDIT_PROJECTS ?? join(home, ".claude", "projects"),
    codexDir: process.env.ROUTE_AUDIT_CODEX || undefined,
    sessions: num("--sessions") ?? (days ? undefined : 128),
    sinceMs: days ? Date.now() - days * 86_400_000 : undefined,
    errataDir: process.env.ROUTE_AUDIT_ERRATA ?? ERRATA_DIR,
    decisionsPath: process.env.LIFEOS_ROUTER_DECISIONS_LOG || lifeosPath("MEMORY", "OBSERVABILITY", "router-decisions.jsonl"),
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const a = auditSessions(defaultOptions(argv));
  if (argv.includes("--json")) console.log(JSON.stringify(a, null, 2));
  else console.log(formatAudit(a, argv.includes("--rows")));
}
