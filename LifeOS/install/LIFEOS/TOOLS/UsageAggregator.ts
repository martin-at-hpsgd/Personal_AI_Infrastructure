#!/usr/bin/env bun
/**
 * @version 1.1.1
 * UsageAggregator.ts — roll Claude Code usage into a DURABLE per-day store.
 *
 *   bun ~/.claude/LIFEOS/TOOLS/UsageAggregator.ts            # aggregate → usage-daily.jsonl
 *   bun ~/.claude/LIFEOS/TOOLS/UsageAggregator.ts --dry-run  # print totals, write nothing
 *
 * WHY THIS EXISTS: raw session transcripts under ~/.claude/projects/ (per-session
 * .jsonl files) are pruned after ~5 days, so per-model token/cost history evaporates.
 * This tool reads
 * every source of truth and folds it into a permanent per-day rollup that the Pulse
 * Usage tab reads. Run nightly by launchd (com.lifeos.usage-aggregator).
 *
 * Idempotent BY RECOMPUTATION: it rebuilds the whole store from source each run, so
 * re-running never double-counts. Cross-source de-dup: any sessionId already counted
 * from session-costs.jsonl is skipped when scanning raw transcripts.
 *
 * SOURCES:
 *   1. MEMORY/OBSERVABILITY/session-costs.jsonl  — historical per-session rollup (has real cost); froze ~2026-04-16
 *   2. ~/.claude/projects/<proj>/*.jsonl (+ subagents/) — live raw transcripts (~5-day window); cost via price table
 *
 * OUTPUT: MEMORY/OBSERVABILITY/usage-daily.jsonl — one line per day, sorted:
 *   { date, messages, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
 *     totalTokens, costUsd, models: { <model>: { messages, totalTokens, costUsd } },
 *     automatic: { sessions, messages, totalTokens, costUsd } }
 *
 * 1.1.0 (2026-09-07, scheduled-tasks offload): prices come from models.ts pricingFor()
 * (the synced public table; the old inline table was 3× stale on Fable), cache writes are
 * priced by TTL from usage.cache_creation, duplicate stream lines are de-duped by requestId,
 * and each day carries an `automatic` sub-rollup: sessions whose id appears in
 * MEMORY/OBSERVABILITY/session-channels.jsonl with a non-desktop channel (written by
 * LoadContext.hook.ts at every headless/remote session start). Socrates SOC-0054 reads it.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getClaudeDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { CURRENT, pricingFor } from "./models";

const CLAUDE_DIR = getClaudeDir();
const OBS_DIR = join(CLAUDE_DIR, "LIFEOS", "MEMORY", "OBSERVABILITY");
const SESSION_COSTS = join(OBS_DIR, "session-costs.jsonl");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const OUT_PATH = join(OBS_DIR, "usage-daily.jsonl");
const CHANNELS_PATH = join(OBS_DIR, "session-channels.jsonl");

/** $/MTok from the synced pricing table; an unknown id prices at the current Opus row (conservative). */
export function priceFor(model: string) {
  const m = pricingFor(model) ?? pricingFor(CURRENT.opus);
  if (!m) return { in: 15, out: 75, cw5m: 18.75, cw1h: 30, cr: 1.5 }; // pricing table missing entirely
  const p = m.pricing;
  return { in: p.input, out: p.output, cw5m: p.cacheWrite5m, cw1h: p.cacheWrite1h, cr: p.cacheRead };
}

/** Cost of one assistant message. Cache writes price by TTL when the breakdown is present; Claude Code sessions default to the 1h TTL. */
export function messageCost(model: string, u: any): number {
  const p = priceFor(model);
  const inp = u.input_tokens || 0, out = u.output_tokens || 0, cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
  const cw5 = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const cw1 = u.cache_creation?.ephemeral_1h_input_tokens ?? (cw - cw5);
  return (inp * p.in + out * p.out + cr * p.cr + cw5 * p.cw5m + cw1 * p.cw1h) / 1_000_000;
}

/** Session ids recorded with a non-desktop channel (headless jobs, iMessage, ...). */
export function automaticSessions(path = CHANNELS_PATH): Set<string> {
  const out = new Set<string>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.sessionId && r.channel && r.channel !== "desktop") out.add(String(r.sessionId)); } catch { /* skip */ }
  }
  return out;
}

interface ModelAgg { messages: number; totalTokens: number; costUsd: number }
interface AutoAgg { sessions: number; messages: number; totalTokens: number; costUsd: number }
interface DayAgg {
  date: string;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
  models: Record<string, ModelAgg>;
  automatic: AutoAgg;
}

const byDay = new Map<string, DayAgg>();
const countedSessions = new Set<string>();
const AUTO = automaticSessions();
const autoSeenByDay = new Map<string, Set<string>>(); // date → automatic session ids already counted

function dayOf(ts: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(ts || "");
  return m ? m[1] : null;
}
function ensureDay(date: string): DayAgg {
  let d = byDay.get(date);
  if (!d) {
    d = { date, messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: 0, models: {}, automatic: { sessions: 0, messages: 0, totalTokens: 0, costUsd: 0 } };
    byDay.set(date, d);
  }
  return d;
}
function ensureModel(d: DayAgg, model: string): ModelAgg {
  let m = d.models[model];
  if (!m) { m = { messages: 0, totalTokens: 0, costUsd: 0 }; d.models[model] = m; }
  return m;
}

/** Fold the historical per-session rollup (real cost) into byDay. */
function ingestSessionCosts(): number {
  if (!existsSync(SESSION_COSTS)) return 0;
  let sessions = 0;
  for (const line of readFileSync(SESSION_COSTS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    const date = dayOf(r.firstTimestamp);
    if (!date) continue;
    if (r.sessionId) countedSessions.add(r.sessionId);
    sessions++;
    const d = ensureDay(date);
    // Automatic split: a subagent row carries the parent session in filePath; a main row in sessionId.
    const sid: string | undefined = /\/([0-9a-f-]{36})\/subagents\//.exec(String(r.filePath ?? ""))?.[1] ?? r.sessionId;
    if (sid && AUTO.has(sid)) {
      const s = autoSeenByDay.get(date) ?? new Set<string>();
      if (!s.has(sid)) { s.add(sid); autoSeenByDay.set(date, s); d.automatic.sessions++; }
      d.automatic.messages += r.messageCount || 0;
      d.automatic.totalTokens += r.totalTokens || 0;
      d.automatic.costUsd += r.costTotal || 0;
    }
    d.messages += r.messageCount || 0;
    d.inputTokens += r.inputTokens || 0;
    d.outputTokens += r.outputTokens || 0;
    d.cacheReadTokens += r.cacheReadTokens || 0;
    d.cacheCreationTokens += r.cacheWriteTokens || 0;
    d.totalTokens += r.totalTokens || 0;
    d.costUsd += r.costTotal || 0;
    const models: Record<string, number> = r.models || {};
    for (const [model, cnt] of Object.entries(models)) {
      const m = ensureModel(d, model);
      m.messages += cnt as number;
    }
    // Distribute session cost/tokens onto its primary model when we can't split per-model.
    if (r.primaryModel) {
      const m = ensureModel(d, r.primaryModel);
      m.totalTokens += r.totalTokens || 0;
      m.costUsd += r.costTotal || 0;
    }
  }
  return sessions;
}

/** All transcript files under projects/, including subagent transcripts. */
function transcriptFiles(): string[] {
  const files: string[] = [];
  let projDirs: string[] = [];
  try { projDirs = readdirSync(PROJECTS_DIR); } catch { return files; }
  for (const proj of projDirs) {
    const base = join(PROJECTS_DIR, proj);
    let st: ReturnType<typeof statSync>;
    try { st = statSync(base); } catch { continue; }
    if (!st.isDirectory()) continue;
    let entries: string[] = [];
    try { entries = readdirSync(base); } catch { continue; }
    for (const e of entries) {
      if (e.endsWith(".jsonl")) files.push(join(base, e));
    }
    // subagent transcripts one level down: <session>/subagents/agent-*.jsonl
    for (const e of entries) {
      const sub = join(base, e, "subagents");
      try {
        if (statSync(sub).isDirectory()) {
          for (const a of readdirSync(sub)) if (a.endsWith(".jsonl")) files.push(join(sub, a));
        }
      } catch { /* not a dir */ }
    }
  }
  return files;
}

/** Fold live raw transcripts into byDay (skipping sessions already counted). */
function ingestTranscripts(): { files: number; messages: number; automaticSessions: number } {
  let msgs = 0;
  const files = transcriptFiles();
  const auto = AUTO;
  const autoSeen = autoSeenByDay;
  for (const f of files) {
    let content: string;
    try { content = readFileSync(f, "utf8"); } catch { continue; }
    // A subagent transcript belongs to its parent session: <project>/<session>/subagents/agent-*.jsonl
    const parentSession = /\/([0-9a-f-]{36})\/subagents\//.exec(f)?.[1];
    const seenRequests = new Set<string>();
    for (const line of content.split("\n")) {
      if (!line.includes('"usage"')) continue;
      let r: any;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.type !== "assistant" || !r.message?.usage) continue;
      if (r.message.model === "<synthetic>") continue;
      const rid: string | undefined = r.requestId ?? r.message.id;
      if (rid) { if (seenRequests.has(rid)) continue; seenRequests.add(rid); } // streamed chunks repeat the usage block
      if (r.sessionId && countedSessions.has(r.sessionId)) continue; // de-dup vs session-costs
      const date = dayOf(r.timestamp);
      if (!date) continue;
      const model: string = r.message.model || "unknown";
      const u = r.message.usage;
      const inp = u.input_tokens || 0;
      const out = u.output_tokens || 0;
      const cr = u.cache_read_input_tokens || 0;
      const cw = u.cache_creation_input_tokens || 0;
      const total = inp + out + cr + cw;
      const cost = messageCost(model, u);
      const d = ensureDay(date);
      const sid: string | undefined = parentSession ?? r.sessionId;
      if (sid && auto.has(sid)) {
        const s = autoSeen.get(date) ?? new Set<string>();
        if (!s.has(sid)) { s.add(sid); autoSeen.set(date, s); d.automatic.sessions++; }
        d.automatic.messages++; d.automatic.totalTokens += total; d.automatic.costUsd += cost;
      }
      d.messages += 1;
      d.inputTokens += inp;
      d.outputTokens += out;
      d.cacheReadTokens += cr;
      d.cacheCreationTokens += cw;
      d.totalTokens += total;
      d.costUsd += cost;
      const m = ensureModel(d, model);
      m.messages += 1;
      m.totalTokens += total;
      m.costUsd += cost;
      msgs++;
    }
  }
  return { files: files.length, messages: msgs, automaticSessions: auto.size };
}

function round(d: DayAgg): DayAgg {
  d.costUsd = Math.round(d.costUsd * 1e6) / 1e6;
  d.automatic.costUsd = Math.round(d.automatic.costUsd * 1e6) / 1e6;
  for (const m of Object.values(d.models)) m.costUsd = Math.round(m.costUsd * 1e6) / 1e6;
  return d;
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const sc = ingestSessionCosts();
  const tr = ingestTranscripts();
  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).map(round);
  const totalCost = days.reduce((s, d) => s + d.costUsd, 0);
  const totalTokens = days.reduce((s, d) => s + d.totalTokens, 0);
  console.log(`[UsageAggregator] session-costs sessions=${sc}, transcript files=${tr.files}, live messages=${tr.messages}, automatic sessions known=${tr.automaticSessions}`);
  console.log(`[UsageAggregator] ${days.length} days, ${(totalTokens / 1e9).toFixed(2)}B tokens, $${totalCost.toFixed(2)} total`);
  if (dryRun) {
    console.log(`[UsageAggregator] --dry-run: not writing ${OUT_PATH}`);
    return;
  }
  mkdirSync(OBS_DIR, { recursive: true }); // absent on a fresh clone: git cannot track an empty dir (public PR #2030, @abseg)
  writeFileSync(OUT_PATH, days.map((d) => JSON.stringify(d)).join("\n") + "\n");
  console.log(`[UsageAggregator] wrote ${days.length} day-rows → ${OUT_PATH}`);
}

if (import.meta.main) main();
