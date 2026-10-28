#!/usr/bin/env bun
/**
 * @version 1.3.1
 * ============================================================================
 * MODELMIX — session-scoped intelligence-rung mix for the statusline
 * ============================================================================
 *
 * WHY THIS EXISTS:
 * The ACTIVE roster answers "which rung is running right now". It does not
 * answer the question the principal actually asks of it: *is the system
 * genuinely dipping into the top rung when the work earns it, or is it
 * quietly riding the default all session?* One glance at
 * `FABLE 12%` next to `OPUS 84%` answers that; a lit/dim label cannot.
 *
 * WHAT IT MEASURES:
 * Share of OUTPUT TOKENS per rung across the session — the main-loop
 * transcript plus every subagent transcript spawned under it. Output tokens,
 * not call count, because a Haiku classification call and a deep Fable
 * analysis are not equal "uses" of intelligence; tokens generated is the
 * honest measure of how much work each rung actually did.
 *
 * PER-LANE SPLIT (2026-09-17):
 * Cross-vendor codex tokens now track per lane (astra/sol) extracted
 * from rollout model IDs, instead of lumping all into astra.
 *
 * GROUND TRUTH is the harness transcript (`message.model` + `message.usage`
 * on each assistant message), not our own logging — the harness records what
 * the API actually billed, so a silently-downgraded dispatch shows up as the
 * model that really ran.
 *
 * RUNG LABELS come from EFFORT_MODEL/CURRENT in models.ts. A lineup change
 * re-labels this automatically; no edit here.
 *
 * CROSS-VENDOR (Astra/CodexResearcher → OpenAI) spends tokens outside any
 * Claude transcript. Its ground truth is the codex CLI's own rollout logs
 * (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl), whose token_count events are
 * cumulative — the last one is the rollout's total. Attribution: a rollout
 * belongs to this session when its lifetime overlaps a cross-vendor subagent
 * transcript's [birth, mtime] window (±slop) — the transcripts never capture
 * the codex session id, so window overlap is the strongest available link.
 * The astra share joins the rung percentages in ONE denominator, so all five
 * sum to 100 (principal 2026-08-06: SOL renders a percentage like the rungs).
 *
 * KNOWN GAPS (deliberate, do not "fix" by guessing):
 *   - A concurrent OTHER session dispatching codex inside the same window
 *     would be co-attributed; single-principal use makes this rare, and
 *     measured-but-coarse beats invented-precise.
 *   - `Inference.ts` subprocess calls are not in the transcript and carry no
 *     token counts in model-verification.jsonl. They are out of the mix; the
 *     statusline's separate 300s FABLE-live probe still reads that file.
 *
 * PERFORMANCE: the statusline ticks every 5s and transcripts reach many MB.
 * Every file is read INCREMENTALLY from a stored byte offset, so a tick costs
 * O(bytes written since last tick), not O(session). State lives in
 * MEMORY/STATE/model-mix/<session>.json and is disposable — delete it and the
 * next run re-reads from zero.
 *
 * USAGE:
 *   bun ModelMix.ts --session <id>     # shell-eval: mix_max=8 mix_high=88 ...
 *   bun ModelMix.ts --session <id> --json
 * ============================================================================
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync, openSync, readSync, closeSync, lstatSync, realpathSync, renameSync, unlinkSync, writeSync, constants as fsConstants } from 'fs';
import { randomUUID } from 'crypto';
import { join, dirname, resolve } from 'path';
import { invariant, InvariantViolation } from './Invariant.ts';
import { EFFORT_MODEL, CURRENT, CROSS_VENDOR, type EffortLevel, type ClaudeTier } from './models.ts';
import { homedir } from "node:os";
import { getClaudeDir, getLifeosDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { rolloutRoots as codexRolloutRoots } from "./CodexUsage.ts";
import { codexHomesRoot } from "./lib/CacheDir";
import { readModelUse, laneForUse, USE_LANES, type UseLane } from "./lib/ModelUse";

/** Ladder lanes that only the per-session model-use log measures (direct and agent calls alike). */
export type LoggedLane = Exclude<UseLane, "astra" | "sol">;
export const LOGGED_LANES: LoggedLane[] = USE_LANES.filter((l): l is LoggedLane => l !== "astra" && l !== "sol");
const zeroLogged = (): Record<LoggedLane, number> => Object.fromEntries(LOGGED_LANES.map((l) => [l, 0])) as Record<LoggedLane, number>;

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
const PROJECTS_DIR = join(getClaudeDir(), 'projects');

/**
 * Resolved per call, not at import: the statusline and the tests both set
 * LIFEOS_DIR in the environment, and capturing it at module load silently
 * pinned every caller to whatever it was at import time.
 */
const stateDir = () =>
  join(getLifeosDir(), 'MEMORY', 'STATE', 'model-mix');

/** A session id usable as a filename: a plain token, no separators, no leading dot. */
export const isSafeSessionId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes('..');

/** Rungs in display order, low → max, matching the statusline ladder. */
export const RUNGS: EffortLevel[] = ['low', 'medium', 'high', 'max'];

/**
 * tier → rung, derived by inverting EFFORT_MODEL so models.ts stays the one edit point.
 * Several levels may share a tier (low and medium both resolve to sonnet since 2026-09-28);
 * the tier's tokens land on its HIGHEST level, so the ladder draws one SONNET rung, not two.
 */
const TIER_RUNG: Partial<Record<ClaudeTier, EffortLevel>> = {};
for (const level of RUNGS) TIER_RUNG[EFFORT_MODEL[level]] = level;
// Haiku (2026-10-07, HAI-4) carries the cheap decided work as the Haiku/HaikuMedium subagents. EFFORT_MODEL has no haiku
// level (Sonnet is its floor), so the otherwise empty low rung is Haiku's: its tokens are counted, not "unknown".
TIER_RUNG.haiku = 'low';
/** The tier each rung's tokens are attributed to, for labels: EFFORT_MODEL's, except low, which is Haiku's. */
export const RUNG_TIER: Record<EffortLevel, ClaudeTier> = { ...EFFORT_MODEL, low: 'haiku' };

/**
 * OpenAI-family subset ONLY, by pinned model prefix. crossVendorUsage() feeds
 * the ASTRA (astra) mix and measures tokens from codex rollout logs — a Gemini
 * or Grok dispatch matching the broad set would light SOL "used" for work
 * OpenAI never did (latent since geminiResearcher; material once the Grok
 * lane landed 2026-08-12).
 */
const OPENAI_CV_AGENTS = new Set(
  Object.keys(CROSS_VENDOR).filter(k => CROSS_VENDOR[k].startsWith('gpt-')).map(k => k.toLowerCase())
);

export interface Mix {
  tokens: Record<EffortLevel, number>;
  calls: Record<EffortLevel, number>;
  pct: Record<EffortLevel, number>;
  /** OpenAI output tokens per lane measured from attributed codex rollouts. */
  lanes: Record<'astra' | 'sol', number>;
  /** Per-lane percentages, sharing ONE denominator with pct — all rungs + lanes sum to 100. */
  lanePct: Record<'astra' | 'sol', number>;
  /** OpenAI output tokens measured from attributed codex rollouts (astra lane only). */
  astraTokens: number;
  /** The OpenAI flagship rung's share of the SAME denominator as pct — all five sum to 100. */
  astraPct: number;
  /** Output tokens per lane measured only from the model-use log (lib/ModelUse.ts). */
  logged: Record<LoggedLane, number>;
  /** Their shares, in the same denominator as pct and lanePct. */
  loggedPct: Record<LoggedLane, number>;
  total: number;
  crossVendor: boolean;
  unknownModels: string[];
}

const zero = (): Record<EffortLevel, number> => ({ max: 0, high: 0, medium: 0, low: 0 });

/**
 * Model ID → rung. Matches the tier NAME inside the ID (the tier name inside the id → opus),
 * which survives version bumps without touching CURRENT. Falls back to an exact
 * CURRENT lookup for IDs that don't carry their tier name.
 * Returns null for anything unrecognized — never guess a rung.
 */
export function rungForModel(model: string): EffortLevel | null {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const tier of Object.keys(CURRENT) as ClaudeTier[]) {
    if (m.includes(tier)) return TIER_RUNG[tier] ?? null;
  }
  for (const [tier, id] of Object.entries(CURRENT) as [ClaudeTier, string][]) {
    if (m === id.toLowerCase()) return TIER_RUNG[tier] ?? null;
  }
  return null;
}

/**
 * Percentages from token totals. Any rung with nonzero work rounds to at
 * LEAST 1% — a real Fable dip that rounds to 0% would defeat the whole point.
 * The largest rung absorbs the rounding error so the row always sums to 100.
 */
export function toPct<K extends string>(tokens: Record<K, number>): Record<K, number> {
  const keys = Object.keys(tokens) as K[];
  const total = keys.reduce((s, r) => s + tokens[r], 0);
  const pct = Object.fromEntries(keys.map(k => [k, 0])) as Record<K, number>;
  if (total <= 0) return pct;
  for (const r of keys) {
    if (tokens[r] > 0) pct[r] = Math.max(1, Math.round((tokens[r] / total) * 100));
  }
  const sum = keys.reduce((s, r) => s + pct[r], 0);
  if (sum !== 100) {
    const biggest = keys.reduce((a, b) => (tokens[a] >= tokens[b] ? a : b));
    pct[biggest] = Math.max(0, pct[biggest] + (100 - sum));
  }
  return pct;
}

interface FileState { offset: number; size: number; ids: string[] }
interface State {
  version: number;
  files: Record<string, FileState>;
  tokens: Record<EffortLevel, number>;
  calls: Record<EffortLevel, number>;
  unknownModels: string[];
}

const STATE_VERSION = 2;

function freshState(): State {
  return { version: STATE_VERSION, files: {}, tokens: zero(), calls: zero(), unknownModels: [] };
}

function loadState(path: string): State {
  try {
    const s = JSON.parse(readFileSync(path, 'utf-8')) as State;
    if (s?.version !== STATE_VERSION) return freshState();
    // Defensive: a hand-edited or partially-written state must not poison counts.
    if (!s.files || !s.tokens || !s.calls) return freshState();
    return s;
  } catch { return freshState(); }
}

/**
 * Read a file from `offset` to EOF, returning only COMPLETE lines. A transcript
 * is appended to while we read it, so the trailing partial line is left behind
 * and its bytes are not consumed — the next tick picks it up whole.
 */
function readNewLines(path: string, offset: number): { lines: string[]; offset: number } {
  const size = statSync(path).size;
  if (size <= offset) return { lines: [], offset };
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    const read = readSync(fd, buf, 0, buf.length, offset);
    const text = buf.subarray(0, read).toString('utf-8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return { lines: [], offset };
    return {
      lines: text.slice(0, lastNl).split('\n').filter(Boolean),
      offset: offset + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf-8'),
    };
  } finally { closeSync(fd); }
}

/**
 * Fold one transcript's new bytes into the running totals.
 *
 * DEDUPE: the harness writes one line per content block, so a single assistant
 * message (one API call, one usage record) appears on several consecutive
 * lines with identical `message.id` and identical usage. Counting lines would
 * multiply every rung by ~3. Duplicates are always adjacent, so a short ring
 * buffer of recent ids is enough — and it survives across ticks because it is
 * persisted with the offset.
 */
function foldFile(path: string, fs_: FileState, state: State): FileState {
  let { offset, ids } = fs_;
  const size = statSync(path).size;
  if (size < offset) { offset = 0; ids = []; }  // truncated/rotated → re-read
  const { lines, offset: newOffset } = readNewLines(path, offset);
  const seen = new Set(ids);
  for (const line of lines) {
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type !== 'assistant') continue;
    const msg = e.message;
    const id = msg?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id); ids.push(id);
    if (ids.length > 32) { const drop = ids.shift(); if (drop) seen.delete(drop); }
    const rung = rungForModel(msg?.model ?? '');
    if (!rung) {
      // `<synthetic>` is the harness's own placeholder on injected messages —
      // no API call, no tokens. Recording it as unknown would read as lineup
      // drift on every session.
      const unknown = String(msg?.model ?? '');
      if (unknown && unknown !== '<synthetic>' && !state.unknownModels.includes(unknown)) {
        state.unknownModels.push(unknown);
      }
      continue;
    }
    state.tokens[rung] += Number(msg?.usage?.output_tokens ?? 0);
    state.calls[rung] += 1;
  }
  return { offset: newOffset, size, ids };
}

/** Locate the session's main transcript: ~/.claude/projects/<slug>/<session>.jsonl */
function findTranscript(sessionId: string): string | null {
  if (!existsSync(PROJECTS_DIR)) return null;
  for (const slug of readdirSync(PROJECTS_DIR)) {
    const p = join(PROJECTS_DIR, slug, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Slop around a dispatch window: codex boots after the wrapper agent starts,
 * and its rollout file can flush after the wrapper's transcript stops moving.
 */
const WINDOW_SLOP_MS = 120_000;

/**
 * Rollout roots: the real codex home PLUS every isolated per-agent home under the cache root,
 * through CodexUsage.rolloutRoots() — the one resolver every reader shares (Router ISA R13).
 * Sol and Astra build runs execute in the isolated homes; until 2026-09-17 this
 * function scanned only ~/.codex/sessions unless a TEST env var was set, so every worker
 * dispatch measured 0 tokens and the ladder read FABLE 100%.
 *
 * Test overrides: CODEX_SESSIONS_DIR replaces the real home's sessions dir; CODEX_HOMES_DIR
 * replaces the isolated-homes root.
 */
const getRolloutRoots = (): string[] => {
  const home = process.env.CODEX_HOME || join(HOME, '.codex');
  // rolloutRoots(): [<home>/sessions, <homes>/<agent>/sessions …] — real home first, then every
  // isolated agent home (astra/, sol/, audit/ … plus the retired terra/ and luna/ homes, whose old rollouts are history and attribute to no lane). CODEX_HOMES_DIR swaps the homes root.
  const roots = codexRolloutRoots(home, process.env.CODEX_HOMES_DIR || codexHomesRoot());
  if (process.env.CODEX_SESSIONS_DIR) {
    // Test override: the real home's sessions dir is replaced, never added to.
    const real = join(home, 'sessions');
    return [process.env.CODEX_SESSIONS_DIR, ...roots.filter((r) => r !== real)].filter((r) => existsSync(r));
  }
  return roots;
};

interface CrossVendorUsage {
  used: boolean;
  lanes: Record<'astra' | 'sol', number>;
}

/**
 * Cross-vendor work is invisible to transcripts. The USED flag comes from the
 * subagent meta files; the TOKEN count from codex's own rollout logs, matched
 * by lifetime overlap with each cross-vendor subagent transcript's window
 * (the transcripts never capture the codex session id).
 */
function crossVendorUsage(subagentDir: string): CrossVendorUsage {
  const emptyLanes: Record<'astra' | 'sol', number> = { astra: 0, sol: 0 };
  if (!existsSync(subagentDir)) return { used: false, lanes: emptyLanes };
  let used = false;
  const windows: Array<[number, number]> = [];
  for (const f of readdirSync(subagentDir)) {
    if (!f.endsWith('.meta.json')) continue;
    try {
      const meta = JSON.parse(readFileSync(join(subagentDir, f), 'utf-8'));
      const type = String(meta?.agentType ?? '').toLowerCase();
      const custom = String(meta?.customAgentType ?? '').toLowerCase();
      if (!OPENAI_CV_AGENTS.has(type) && !OPENAI_CV_AGENTS.has(custom)
          && !String(meta?.model ?? '').toLowerCase().startsWith('gpt-')) continue;
      used = true;
      const transcript = join(subagentDir, f.replace(/\.meta\.json$/, '.jsonl'));
      if (!existsSync(transcript)) continue;
      const st = statSync(transcript);
      windows.push([(st.birthtimeMs || st.mtimeMs) - WINDOW_SLOP_MS, st.mtimeMs + WINDOW_SLOP_MS]);
    } catch { /* unreadable meta is not evidence of anything */ }
  }
  if (windows.length === 0) return { used, lanes: emptyLanes };
  return { used, lanes: rolloutTokensIn(windows) };
}

/**
 * Sum output tokens per lane of every codex rollout whose lifetime overlaps a window,
 * across all rollout roots (main home + isolated agent homes).
 * Rollout filenames stamp their start in LOCAL time (rollout-<ts>-<uuid>.jsonl,
 * verified 2026-08-06: an 18-26-03 filename opens with an 01:26Z first event),
 * and the day dirs are local dates — iterate days by calendar date, not 24h
 * steps, so a DST boundary cannot skip a dir.
 */
function rolloutTokensIn(windows: Array<[number, number]>): Record<'astra' | 'sol', number> {
  const roots = getRolloutRoots();
  const lanes: Record<'astra' | 'sol', number> = { astra: 0, sol: 0 };
  if (roots.length === 0) return lanes;
  const lo = Math.min(...windows.map(w => w[0]));
  const hi = Math.max(...windows.map(w => w[1]));
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const day = new Date(lo);
    day.setHours(0, 0, 0, 0);
    for (; day.getTime() <= hi; day.setDate(day.getDate() + 1)) {
      const pad = (n: number) => String(n).padStart(2, '0');
      const dir = join(root, String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        const m = f.match(/^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-[0-9a-f-]{36}\.jsonl$/);
        if (!m) continue;
        const start = new Date(m[1].replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3')).getTime();
        const p = join(dir, f);
        let mtime: number;
        try { mtime = statSync(p).mtimeMs; } catch { continue; }
        if (!windows.some(([a, b]) => start <= b && mtime >= a)) continue;
        const result = lastRolloutOutputTokens(p);
        if (result) lanes[result.lane] += result.outputTokens;
      }
    }
  }
  return lanes;
}

type Lane = 'astra' | 'sol';
const LANES: Lane[] = ['astra', 'sol'];

/**
 * Lane from a rollout's model ID. Exact match against the CROSS_VENDOR lane pins first, then the
 * lane name inside the id (survives a version bump). Anything else returns null and is NOT
 * counted: window overlap is coarse, and booking an unrelated or conformance rollout that
 * happens to overlap a dispatch window under ASTRA would count tokens OpenAI's flagship never spent.
 */
export function laneFromModel(model: string): Lane | null {
  const m = model.toLowerCase();
  if (!m) return null;
  for (const lane of LANES) {
    if (CROSS_VENDOR[lane] && m === CROSS_VENDOR[lane].toLowerCase()) return lane;
  }
  for (const lane of LANES) {
    if (m.includes(`-${lane}`)) return lane;
  }
  return null;
}

/**
 * The model id lives in the rollout's FIRST line (session_meta), which carries the full
 * instructions payload — 20 KB+ on a real codex run (verified 2026-09-17: first "model" at byte
 * 22152). A fixed 4 KB head read never reached it, so every rollout fell to the astra default.
 * Read the whole first line (capped), then fall back to any "model" in the text handed in.
 */
const HEAD_CAP = 1024 * 1024;
function rolloutModel(path: string, size: number, tailText: string): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(Math.min(HEAD_CAP, size));
    const read = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, read).toString('utf-8');
    const firstLine = text.slice(0, text.indexOf('\n') >= 0 ? text.indexOf('\n') : text.length);
    const m = firstLine.match(/"model":"([^"]+)"/) ?? text.match(/"model":"([^"]+)"/) ?? tailText.match(/"model":"([^"]+)"/);
    return m ? m[1] : '';
  } finally { closeSync(fd); }
}

/**
 * A rollout's token_count events are CUMULATIVE — the last one is the total.
 * Read only the tail: rollouts reach MB and the statusline ticks every 5s.
 * Returns { lane, outputTokens } or null if not found.
 */
function lastRolloutOutputTokens(path: string): { lane: Lane; outputTokens: number } | null {
  try {
    const size = statSync(path).size;
    // Tail first: the last token_count is the rollout's total.
    const offset = Math.max(0, size - 128 * 1024);
    const fd = openSync(path, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(size - offset);
      const read = readSync(fd, buf, 0, buf.length, offset);
      text = buf.subarray(0, read).toString('utf-8');
    } finally { closeSync(fd); }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"token_count"')) continue;
      try {
        const e = JSON.parse(lines[i]);
        const out = Number(e?.payload?.info?.total_token_usage?.output_tokens ?? 0);
        if (out > 0) {
          const lane = laneFromModel(rolloutModel(path, size, text));
          return lane ? { lane, outputTokens: out } : null;
        }
      } catch { /* clipped line at the tail boundary — keep scanning back */ }
    }
  } catch { /* rollout unreadable — count nothing rather than guess */ }
  return null;
}

/**
 * One state file per session accumulates forever otherwise. A session's mix is
 * only ever read while that session is open, so anything untouched for a week
 * is dead weight — and the cache is disposable, so dropping it costs nothing
 * but a re-read if the session somehow resumes.
 */
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Replace one session's cache file inside `dir`, by physical destination. The
 * directory is realpath'd before the boundary check; a destination that is a symlink (or anything but a
 * regular file) is refused, never followed; the bytes go to a temp file this call creates exclusively
 * with O_NOFOLLOW, and a rename swaps it in. Returns false when the write was refused.
 */
export function writeStateCache(dir: string, fileName: string, content: string): boolean {
  invariant(isSafeSessionId(fileName.replace(/\.json$/, '')) && fileName.endsWith('.json'), `ModelMix cache name is not a plain token: ${fileName}`);
  mkdirSync(dir, { recursive: true });
  const realDir = realpathSync(dir);
  const dest = join(realDir, fileName);
  invariant(dirname(dest) === realDir, `ModelMix state path escapes its directory: ${dest}`);
  try {
    const st = lstatSync(dest);
    if (st.isSymbolicLink() || !st.isFile()) return false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') return false;
  }
  const tmp = join(realDir, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  let renamed = false;
  try {
    try { writeSync(fd, content); } finally { closeSync(fd); }
    renameSync(tmp, dest);
    renamed = true;
  } finally {
    if (!renamed) { try { unlinkSync(tmp); } catch { /* already gone */ } }
  }
  return true;
}

/** A cache read follows no link: only a regular file at the destination is state. */
function isRegularFile(p: string): boolean {
  try { const st = lstatSync(p); return st.isFile() && !st.isSymbolicLink(); } catch { return false; }
}

function pruneState(dir: string): void {
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const p = join(dir, f);
    try { if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true }); } catch { /* racing another tick */ }
  }
}

export function computeMix(sessionId: string, transcriptOverride?: string): Mix {
  const emptyLanes = { astra: 0, sol: 0 };
  const empty: Mix = {
    tokens: zero(),
    calls: zero(),
    pct: zero(),
    lanes: emptyLanes,
    lanePct: { astra: 0, sol: 0 },
    astraTokens: 0,
    astraPct: 0,
    logged: zeroLogged(),
    loggedPct: zeroLogged(),
    total: 0,
    crossVendor: false,
    unknownModels: [],
  };
  // A session id becomes a filename under STATE_DIR: only a plain token may pass,
  // never path separators or "..".
  if (sessionId !== '' && !isSafeSessionId(sessionId)) return empty;
  const main = transcriptOverride ?? findTranscript(sessionId);
  if (!main || !existsSync(main)) return empty;

  const STATE_DIR = stateDir();
  const statePath = join(STATE_DIR, `${sessionId}.json`);
  invariant(
    dirname(resolve(statePath)) === resolve(STATE_DIR),
    `ModelMix state path escapes its directory: ${statePath}`,
  );
  const state = isRegularFile(statePath) ? loadState(statePath) : freshState();

  const subagentDir = join(dirname(main), sessionId, 'subagents');
  const files = [main];
  if (existsSync(subagentDir)) {
    for (const f of readdirSync(subagentDir)) {
      if (f.startsWith('agent-') && f.endsWith('.jsonl')) files.push(join(subagentDir, f));
    }
  }

  for (const f of files) {
    try {
      state.files[f] = foldFile(f, state.files[f] ?? { offset: 0, size: 0, ids: [] }, state);
    } catch { /* a file vanishing mid-session must not zero the whole mix */ }
  }

  try {
    writeStateCache(STATE_DIR, `${sessionId}.json`, JSON.stringify(state));
    pruneState(STATE_DIR);
  } catch (e) {
    if (e instanceof InvariantViolation) throw e; // an impossible state fails loud, never as a skipped cache
    /* best-effort cache; correctness does not depend on the write */
  }

  const cv = crossVendorUsage(subagentDir);
  // Calls outside every transcript, direct or from an agent's Bash (lib/ModelUse.ts). A Claude id adds to its rung
  // (Inference subprocesses never reach the transcript). Astra and Sol take the larger of rollout and log, since an
  // agent's Worker run appears in both; every other lane is measured by the log alone.
  const rungs = { ...state.tokens };
  const logged: Record<LoggedLane, number> = zeroLogged();
  const loggedCodex = { astra: 0, sol: 0 };
  const seen = new Set<string>();
  for (const use of readModelUse(sessionId)) {
    const rung = rungForModel(use.model);
    const lane = rung ? null : laneForUse(use.model);
    if (rung) rungs[rung] += use.output;
    else if (lane === "astra" || lane === "sol") loggedCodex[lane] += use.output;
    else if (lane) logged[lane] += use.output;
    if (rung || lane) seen.add(rung ?? lane!);
  }
  const lanes = { astra: Math.max(cv.lanes.astra, loggedCodex.astra), sol: Math.max(cv.lanes.sol, loggedCodex.sol) };
  // ONE denominator across all rungs + lanes (principal 2026-08-06 / 2026-09-17): every share sums to 100 together.
  const combined = toPct({ ...rungs, ...lanes, ...logged });
  const astraPct = combined.astra;
  const lanePct = { astra: combined.astra, sol: combined.sol };
  const loggedPct = Object.fromEntries(LOGGED_LANES.map((l) => [l, combined[l]])) as Record<LoggedLane, number>;
  const rungPct = Object.fromEntries(RUNGS.map((r) => [r, combined[r]])) as Record<EffortLevel, number>;
  const totalLaneTokens = lanes.astra + lanes.sol + LOGGED_LANES.reduce((s, l) => s + logged[l], 0);
  return {
    tokens: rungs,
    calls: state.calls,
    pct: rungPct as Record<EffortLevel, number>,
    lanes,
    lanePct,
    astraTokens: lanes.astra,
    astraPct,
    logged,
    loggedPct,
    total: RUNGS.reduce((s, r) => s + rungs[r], 0) + totalLaneTokens,
    crossVendor: cv.used || seen.has("astra") || seen.has("sol"),
    unknownModels: state.unknownModels,
  };
}

/**
 * The shell-eval text the CLI prints: mix_* are PERCENTAGES (same denominator); mix_*_used keeps the
 * used-flag so an attributed-but-unmeasured dispatch still lights the rung. No trailing newline.
 */
export function mixKvText(mix: Mix): string {
  const rungLines = RUNGS.map(r => `mix_${r}=${mix.pct[r]}`).join('\n');
  const laneLines = Object.entries(mix.lanePct)
    .map(([lane, pct]) => `mix_${lane}=${pct}`)
    .join('\n');
  const loggedLines = LOGGED_LANES.map(l => `mix_${l}=${mix.loggedPct[l]}`).join('\n');
  return `${rungLines}\n${laneLines}\n${loggedLines}\nmix_total=${mix.total}\nmix_astra_used=${mix.crossVendor ? 1 : 0}`;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const sessionId = arg('--session') ?? '';
  const transcript = arg('--transcript');

  if (!sessionId && !transcript) {
    console.error('usage: ModelMix.ts --session <id> [--transcript <path>] [--json]');
    process.exit(2);
  }

  const mix = computeMix(sessionId, transcript);

  if (argv.includes('--json')) {
    console.log(JSON.stringify(mix, null, 2));
  } else {
    // Shell-eval contract consumed by the statusline.
    console.log(mixKvText(mix));
  }
}
