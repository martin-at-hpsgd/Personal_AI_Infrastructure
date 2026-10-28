/**
 * @version 1.0.0
 * Store.ts — the evidence index: schema, and the streaming, incremental build from transcripts.
 *
 * The index is derived. Delete evidence.sqlite and `build` recreates it from the harness transcripts
 * (`projects/<project>/<session>.jsonl` and `<session>/subagents/**.jsonl`) plus the router decision
 * log. Nothing here is a ledger of its own.
 *
 * Span shape follows the OpenTelemetry GenAI semantic conventions where a name exists:
 *   spans       one `turn` span per typed prompt (gen_ai.operation.name = invoke_agent)
 *   chat_spans  one per model response, keyed by the response id (gen_ai.operation.name = chat)
 *   tool_calls  one per tool_use block, keyed by the call id (gen_ai.operation.name = execute_tool)
 * Columns without an OTel name carry a `lifeos.` prefix or a plain name.
 *
 * Incremental: `files` keeps a byte offset per transcript and for the router log. A file whose size
 * equals its offset is not opened. Only complete lines are consumed, so a line still being written is
 * read on the next build. A file that shrank is purged and re-read from byte 0.
 */
import { Database } from "bun:sqlite";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "fs";
import { basename, dirname, join } from "path";
import { invariant } from "../TOOLS/Invariant";
import { ORIGINS, classifyOrigin, isTypedPrompt, isUserInterrupt, promptText, type Origin } from "./Classify";
import { readReaction } from "./Reactions";
import { DECISIONS_VERSION, rebuildDecisions } from "./Decisions";

/** 3 (2026-10-09): router_rows.holdout and decisions.holdout, the router holdout arm (ISC-28). */
export const SCHEMA_VERSION = 3;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('main','subagent','router')),
  offset INTEGER NOT NULL, cur_span_id TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spans (
  span_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_span_id TEXT, name TEXT NOT NULL,
  "gen_ai.operation.name" TEXT NOT NULL, "gen_ai.conversation.id" TEXT NOT NULL,
  "gen_ai.agent.id" TEXT, "gen_ai.agent.name" TEXT,
  prompt_id TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('human','peer','task','headless','test')), origin_signal TEXT NOT NULL,
  entrypoint TEXT, is_sidechain INTEGER NOT NULL, prompt_chars INTEGER NOT NULL, file TEXT NOT NULL,
  prompt_offset INTEGER
);
CREATE INDEX IF NOT EXISTS spans_trace ON spans (trace_id, start_time);
CREATE INDEX IF NOT EXISTS spans_file ON spans (file);
CREATE TABLE IF NOT EXISTS chat_spans (
  span_id TEXT PRIMARY KEY, parent_span_id TEXT NOT NULL, start_time TEXT NOT NULL,
  "gen_ai.operation.name" TEXT NOT NULL, "gen_ai.provider.name" TEXT NOT NULL,
  "gen_ai.request.model" TEXT, "gen_ai.response.model" TEXT, "gen_ai.response.id" TEXT NOT NULL,
  "gen_ai.usage.input_tokens" INTEGER, "gen_ai.usage.output_tokens" INTEGER,
  "gen_ai.usage.cache_read.input_tokens" INTEGER, "gen_ai.usage.cache_creation.input_tokens" INTEGER,
  "lifeos.request.effort" TEXT, "lifeos.attribution_skill" TEXT, "lifeos.cost_usd" REAL
);
CREATE INDEX IF NOT EXISTS chat_parent ON chat_spans (parent_span_id, start_time);
CREATE TABLE IF NOT EXISTS tool_calls (
  span_id TEXT PRIMARY KEY, parent_span_id TEXT NOT NULL, start_time TEXT NOT NULL,
  "gen_ai.operation.name" TEXT NOT NULL, "gen_ai.tool.name" TEXT NOT NULL, "gen_ai.tool.call.id" TEXT NOT NULL,
  skill TEXT, subagent_type TEXT, run_in_background INTEGER, worker_lane TEXT
);
CREATE INDEX IF NOT EXISTS tool_parent ON tool_calls (parent_span_id);
CREATE TABLE IF NOT EXISTS router_rows (
  offset INTEGER PRIMARY KEY, ts TEXT NOT NULL, session TEXT, turn TEXT, source TEXT, lane TEXT, agent TEXT,
  effort TEXT, level TEXT, binding INTEGER, think_skill TEXT, front_door TEXT, holdout INTEGER
);
CREATE INDEX IF NOT EXISTS router_turn ON router_rows (turn);
CREATE INDEX IF NOT EXISTS router_session ON router_rows (session, ts);
CREATE TABLE IF NOT EXISTS decisions (
  span_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt_id TEXT NOT NULL, origin TEXT NOT NULL,
  join_method TEXT NOT NULL CHECK (join_method IN ('turn_id','session_ts','none')), router_offset INTEGER, router_ts TEXT,
  pick_lane TEXT, pick_agent TEXT, pick_effort TEXT, pick_level TEXT, pick_think TEXT, pick_binding INTEGER,
  act_model TEXT, act_effort TEXT, act_agents TEXT NOT NULL, act_skills TEXT NOT NULL, act_think TEXT NOT NULL,
  act_input_tokens INTEGER, act_output_tokens INTEGER, act_cost_usd REAL,
  lane_match INTEGER, agent_match INTEGER, effort_match INTEGER, think_match INTEGER, holdout INTEGER
);
CREATE TABLE IF NOT EXISTS scores (
  span_id TEXT NOT NULL, source TEXT NOT NULL, value REAL NOT NULL, confidence REAL, ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scores_span ON scores (span_id);
CREATE TABLE IF NOT EXISTS reactions (
  span_id TEXT PRIMARY KEY, next_span_id TEXT, has_next INTEGER NOT NULL CHECK (has_next IN (0,1)), next_gap_ms INTEGER,
  frustration INTEGER, frustration_score INTEGER, correction TEXT CHECK (correction IN ('signals','reformulation')),
  approval INTEGER, praise INTEGER, reask_jaccard REAL, interrupted INTEGER NOT NULL DEFAULT 0, next_chars INTEGER
);
CREATE INDEX IF NOT EXISTS reactions_next ON reactions (next_span_id);
CREATE TABLE IF NOT EXISTS votes (
  span_id TEXT NOT NULL, fn TEXT NOT NULL, vote INTEGER CHECK (vote IN (0,1)), eligible INTEGER NOT NULL CHECK (eligible IN (0,1)),
  PRIMARY KEY (span_id, fn)
);
`;

export function openDb(path: string, opts: { readonly?: boolean } = {}): Database {
  if (opts.readonly) {
    if (!existsSync(path)) throw new Error(`no evidence index at ${path}; run: bun LIFEOS/EVIDENCE/Project.ts build`);
    return new Database(path, { readonly: true });
  }
  assertEvidencePath(path);
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(DDL);
  db.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  const v = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
  if (v !== String(SCHEMA_VERSION)) { db.close(); throw new Error(`evidence index at ${path} is schema ${v}, code is ${SCHEMA_VERSION}; delete it and run build`); }
  return db;
}

/** The index may only be written inside a directory named EVIDENCE, symlinks resolved first. */
function assertEvidencePath(path: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const real = realpathSync(dir);
  invariant(basename(real) === "EVIDENCE", `evidence index must live in an EVIDENCE directory, got ${real}`);
}

export interface BuildOptions { db: string; projects: string; router: string; since: string; pricing?: string }
export interface Counts { spans: number; chat_spans: number; tool_calls: number; router_rows: number; decisions: number; reactions: number; scores: number }
export interface BuildSummary {
  since: string; files_seen: number; files_read: number; bytes_read: number; lines_parsed: number;
  router_bytes_read: number; decisions_rebuilt: boolean; counts: Counts; origins: Record<string, number>; wall_ms: number;
}

interface Pricing { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }

function loadPricing(path: string | undefined): Map<string, Pricing> {
  const out = new Map<string, Pricing>();
  if (!path || !existsSync(path)) return out;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { return out; }
  const models = (parsed as { models?: Record<string, Partial<Pricing>> })?.models;
  if (!models || typeof models !== "object") return out;
  for (const [id, p] of Object.entries(models)) {
    if ([p.input, p.output, p.cacheRead, p.cacheWrite5m, p.cacheWrite1h].every((v) => typeof v === "number")) out.set(id, p as Pricing);
  }
  return out;
}

/** Transcript files modified on or after `sinceMs`, sorted so a rebuild visits them in the same order. */
export function listTranscripts(projects: string, sinceMs: number): Array<{ path: string; kind: "main" | "subagent" }> {
  const out: Array<{ path: string; kind: "main" | "subagent" }> = [];
  const fresh = (p: string) => { try { return statSync(p).mtimeMs >= sinceMs; } catch { return false; } };
  const walkSub = (dir: string) => {
    let ents: import("fs").Dirent[];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walkSub(p);
      else if (e.name.endsWith(".jsonl") && fresh(p)) out.push({ path: p, kind: "subagent" });
    }
  };
  let projectDirs: string[] = [];
  try { projectDirs = readdirSync(projects); } catch { return out; }
  for (const proj of projectDirs) {
    const pd = join(projects, proj);
    let ents: import("fs").Dirent[];
    try { ents = readdirSync(pd, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = join(pd, e.name);
      if (e.isFile() && e.name.endsWith(".jsonl")) { if (fresh(p)) out.push({ path: p, kind: "main" }); }
      else if (e.isDirectory()) walkSub(join(p, "subagents"));
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

interface Pending { span: string; offset: number | null; start: string; text: string | null }

/** The prompt text of the transcript line starting at `offset`, read back for a reaction; null when unreadable. */
function promptAt(path: string, offset: number): string | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const parts: Buffer[] = [];
    const buf = Buffer.allocUnsafe(64 * 1024);
    for (let pos = offset; ;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      const nl = buf.subarray(0, n).indexOf(NL);
      if (nl !== -1) { parts.push(Buffer.from(buf.subarray(0, nl))); break; }
      parts.push(Buffer.from(buf.subarray(0, n)));
      pos += n;
    }
    const row = JSON.parse(Buffer.concat(parts).toString("utf8"));
    return row?.type === "user" ? promptText(row.message?.content) : null;
  } catch { return null; } finally { closeSync(fd); }
}

const CHUNK = 8 * 1024 * 1024;
const NL = 10;

/** Streams complete lines from `start`. Returns the offset just past the last complete line. */
function streamLines(path: string, start: number, size: number, onLine: (line: Buffer, lineStart: number) => void): number {
  const fd = openSync(path, "r");
  let consumed = start;
  try {
    let carry: Buffer = Buffer.alloc(0);
    let pos = start;
    const buf = Buffer.allocUnsafe(CHUNK);
    while (pos < size) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let s = 0;
      for (let i = data.indexOf(NL, s); i !== -1; i = data.indexOf(NL, s)) {
        if (i > s) onLine(data.subarray(s, i), consumed);
        consumed += i - s + 1;
        s = i + 1;
      }
      carry = Buffer.from(data.subarray(s));
    }
  } finally {
    closeSync(fd);
  }
  return consumed;
}

const PAT_ASSISTANT = Buffer.from('"type":"assistant"');
const PAT_USER = Buffer.from('"type":"user"');
const PAT_PROMPT = Buffer.from('"promptId"');
const PAT_TOOLRESULT = Buffer.from('"toolUseResult":');

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function build(opts: BuildOptions): BuildSummary {
  const t0 = performance.now();
  invariant(/^\d{4}-\d{2}-\d{2}$/.test(opts.since), `--since must be YYYY-MM-DD, got ${opts.since}`);
  const sinceIso = `${opts.since}T00:00:00.000Z`;
  const sinceMs = Date.parse(sinceIso);
  const db = openDb(opts.db);
  const pricing = loadPricing(opts.pricing);
  const prevSince = (db.query("SELECT value FROM meta WHERE key = 'since'").get() as { value: string } | null)?.value;
  invariant(!prevSince || prevSince === opts.since, `index was built with --since ${prevSince}; delete ${opts.db} to rebuild with ${opts.since}`);
  db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('since', ?)").run(opts.since);

  const q = {
    file: db.query("SELECT offset, cur_span_id FROM files WHERE path = ?"),
    putFile: db.query("INSERT OR REPLACE INTO files (path, kind, offset, cur_span_id, updated_at) VALUES (?, ?, ?, ?, ?)"),
    purgeChat: db.query("DELETE FROM chat_spans WHERE parent_span_id IN (SELECT span_id FROM spans WHERE file = ?)"),
    purgeTools: db.query("DELETE FROM tool_calls WHERE parent_span_id IN (SELECT span_id FROM spans WHERE file = ?)"),
    purgeReactions: db.query("DELETE FROM reactions WHERE span_id IN (SELECT span_id FROM spans WHERE file = ?)"),
    purgeVotes: db.query("DELETE FROM votes WHERE span_id IN (SELECT span_id FROM spans WHERE file = ?)"),
    purgeSpans: db.query("DELETE FROM spans WHERE file = ?"),
    pending: db.query("SELECT r.span_id, s.prompt_offset, s.start_time FROM reactions r JOIN spans s USING (span_id) WHERE s.file = ? AND r.has_next = 0 ORDER BY s.start_time DESC, s.span_id DESC LIMIT 1"),
    reactOpen: db.query("INSERT OR IGNORE INTO reactions (span_id, has_next, interrupted) VALUES (?, 0, 0)"),
    reactClose: db.query("UPDATE reactions SET next_span_id = ?, has_next = 1, next_gap_ms = ?, frustration = ?, frustration_score = ?, correction = ?, approval = ?, praise = ?, reask_jaccard = ?, next_chars = ? WHERE span_id = ? AND has_next = 0"),
    interrupt: db.query("UPDATE reactions SET interrupted = 1 WHERE span_id = ?"),
    purgeRouter: db.query("DELETE FROM router_rows"),
    span: db.query(`INSERT OR IGNORE INTO spans (span_id, trace_id, parent_span_id, name, "gen_ai.operation.name", "gen_ai.conversation.id", "gen_ai.agent.id", "gen_ai.agent.name", prompt_id, start_time, end_time, origin, origin_signal, entrypoint, is_sidechain, prompt_chars, file, prompt_offset) VALUES (?, ?, ?, 'turn', 'invoke_agent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    spanEnd: db.query("UPDATE spans SET end_time = ? WHERE span_id = ? AND end_time < ?"),
    chat: db.query(`INSERT INTO chat_spans (span_id, parent_span_id, start_time, "gen_ai.operation.name", "gen_ai.provider.name", "gen_ai.request.model", "gen_ai.response.model", "gen_ai.response.id", "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_creation.input_tokens", "lifeos.request.effort", "lifeos.attribution_skill", "lifeos.cost_usd") VALUES (?, ?, ?, 'chat', 'anthropic', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (span_id) DO UPDATE SET "gen_ai.usage.input_tokens" = excluded."gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens" = excluded."gen_ai.usage.output_tokens", "gen_ai.usage.cache_read.input_tokens" = excluded."gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_creation.input_tokens" = excluded."gen_ai.usage.cache_creation.input_tokens", "lifeos.cost_usd" = excluded."lifeos.cost_usd", "lifeos.attribution_skill" = COALESCE(chat_spans."lifeos.attribution_skill", excluded."lifeos.attribution_skill")`),
    tool: db.query(`INSERT OR IGNORE INTO tool_calls (span_id, parent_span_id, start_time, "gen_ai.operation.name", "gen_ai.tool.name", "gen_ai.tool.call.id", skill, subagent_type, run_in_background, worker_lane) VALUES (?, ?, ?, 'execute_tool', ?, ?, ?, ?, ?, ?)`),
    router: db.query("INSERT OR REPLACE INTO router_rows (offset, ts, session, turn, source, lane, agent, effort, level, binding, think_skill, front_door, holdout) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  };

  const summary: BuildSummary = {
    since: opts.since, files_seen: 0, files_read: 0, bytes_read: 0, lines_parsed: 0, router_bytes_read: 0,
    decisions_rebuilt: false, counts: emptyCounts(), origins: {}, wall_ms: 0,
  };
  const nowIso = () => new Date().toISOString();

  const files = listTranscripts(opts.projects, sinceMs);
  summary.files_seen = files.length;
  for (const f of files) {
    let size: number;
    try { size = statSync(f.path).size; } catch { continue; }
    const rec = q.file.get(f.path) as { offset: number; cur_span_id: string | null } | null;
    let offset = rec?.offset ?? 0;
    let cur: string | null = rec?.cur_span_id ?? null;
    if (rec && size === offset) continue;
    const ingest = db.transaction(() => {
      if (rec && size < offset) {
        q.purgeChat.run(f.path); q.purgeTools.run(f.path); q.purgeReactions.run(f.path); q.purgeVotes.run(f.path); q.purgeSpans.run(f.path);
        offset = 0; cur = null;
      }
      const agentName = f.kind === "subagent" ? subagentType(f.path) : null;
      const fileAgentId = f.kind === "subagent" ? basename(f.path, ".jsonl").replace(/^agent-/, "") : null;
      // The human turn still waiting for the next human prompt in this session (main transcripts only).
      // Its prompt text is never stored: a later build re-reads it from the transcript at prompt_offset.
      let pending: Pending | null = null;
      if (f.kind === "main") {
        const p = q.pending.get(f.path) as { span_id: string; prompt_offset: number | null; start_time: string } | null;
        if (p) pending = { span: p.span_id, offset: p.prompt_offset, start: p.start_time, text: null };
      }
      const end = streamLines(f.path, offset, size, (line, lineStart) => {
        const isAssistant = line.indexOf(PAT_ASSISTANT) !== -1;
        if (!isAssistant && !(line.indexOf(PAT_USER) !== -1 && line.indexOf(PAT_PROMPT) !== -1 && line.indexOf(PAT_TOOLRESULT) === -1)) return;
        let row: Record<string, any>;
        try { row = JSON.parse(line.toString("utf8")); } catch { return; }
        summary.lines_parsed++;
        const ts = str(row.timestamp);
        if (!ts) return;
        if (row.type === "user") {
          if (isUserInterrupt(row)) { if (pending && ts >= sinceIso) q.interrupt.run(pending.span); return; }
          if (!isTypedPrompt(row)) return;
          if (ts < sinceIso) { cur = null; pending = null; return; }
          const session = str(row.sessionId);
          if (!session) return;
          const promptId: string = row.promptId;
          const isSub = f.kind === "subagent";
          const agentId = isSub ? (str(row.agentId) ?? fileAgentId) : null;
          const spanId = isSub ? `${agentId}:${promptId}` : `${session}:${promptId}`;
          const text = promptText(row.message?.content);
          const { origin, signal } = classifyOrigin(row, text, isSub);
          invariant((ORIGINS as readonly string[]).includes(origin), `origin ${origin} is not one of ${ORIGINS.join(",")}`);
          const res = q.span.run(spanId, session, isSub ? `${session}:${promptId}` : null, session, agentId, agentName, promptId, ts, ts, origin, signal, str(row.entrypoint), row.isSidechain === true ? 1 : 0, text.length, f.path, lineStart);
          if (res.changes > 0) summary.origins[origin] = (summary.origins[origin] ?? 0) + 1;
          cur = spanId;
          if (res.changes > 0 && f.kind === "main" && origin === "human") {
            if (pending) {
              const own = pending.text ?? (pending.offset === null ? null : promptAt(f.path, pending.offset));
              const r = readReaction(own, text);
              // File order is the session order; a resumed or forked transcript can carry an earlier timestamp, so a negative gap is recorded as unknown.
              const raw = Date.parse(ts) - Date.parse(pending.start);
              const gap = Number.isFinite(raw) && raw >= 0 ? raw : null;
              q.reactClose.run(spanId, gap, r.frustration, r.frustration_score, r.correction, r.approval, r.praise, r.reask_jaccard, r.next_chars, pending.span);
            }
            q.reactOpen.run(spanId);
            pending = { span: spanId, offset: lineStart, start: ts, text };
          }
          return;
        }
        if (row.type !== "assistant" || !cur || ts < sinceIso) return;
        const msg = row.message ?? {};
        const msgId = str(msg.id);
        if (!msgId) return;
        const responseModel = str(msg.model);
        if (responseModel === "<synthetic>") return;
        const u = msg.usage ?? {};
        const input = num(u.input_tokens), output = num(u.output_tokens), cacheRead = num(u.cache_read_input_tokens), cacheCreate = num(u.cache_creation_input_tokens);
        const requested = str(row.requestedModel) ?? responseModel;
        q.chat.run(msgId, cur, ts, requested, responseModel, msgId, input, output, cacheRead, cacheCreate, str(row.perTurnEffort) ?? str(row.effort), str(row.attributionSkill), costOf(pricing, responseModel ?? requested, u));
        q.spanEnd.run(ts, cur, ts);
        for (const b of Array.isArray(msg.content) ? msg.content : []) {
          if (b?.type !== "tool_use" || !str(b.id) || !str(b.name)) continue;
          const input_ = b.input ?? {};
          const isAgent = b.name === "Agent" || b.name === "Task";
          const worker = b.name === "Bash" && typeof input_.command === "string" ? /Worker\.ts\s+([a-z]+)/.exec(input_.command)?.[1] ?? null : null;
          q.tool.run(b.id, cur, ts, b.name, b.id, b.name === "Skill" ? str(input_.skill) : null, isAgent ? (str(input_.subagent_type) ?? "general-purpose") : null, isAgent ? (input_.run_in_background === true ? 1 : 0) : null, worker);
        }
      });
      invariant(end >= offset && end <= size, `offset ${end} outside [${offset}, ${size}] for ${f.path}`);
      summary.bytes_read += end - offset;
      if (end > offset) summary.files_read++;
      q.putFile.run(f.path, f.kind, end, cur, nowIso());
    });
    ingest();
  }

  // Router decision log: same offset bookkeeping, keyed by the byte offset of each line.
  if (existsSync(opts.router)) {
    const size = statSync(opts.router).size;
    const rec = q.file.get(opts.router) as { offset: number } | null;
    let offset = rec?.offset ?? 0;
    if (!rec || size !== offset) {
      db.transaction(() => {
        if (rec && size < offset) { q.purgeRouter.run(); offset = 0; }
        const end = streamLines(opts.router, offset, size, (line, lineStart) => {
          let r: Record<string, any>;
          try { r = JSON.parse(line.toString("utf8")); } catch { return; }
          const ts = str(r.ts);
          if (!ts || ts < sinceIso) return;
          q.router.run(lineStart, ts, str(r.session), str(r.turn), str(r.source), str(r.lane), str(r.agent), str(r.effort), str(r.level),
            typeof r.binding === "boolean" ? (r.binding ? 1 : 0) : null, str(r.think?.skill), str(r.frontDoor),
            typeof r.holdout === "boolean" ? (r.holdout ? 1 : 0) : null);
        });
        invariant(end >= offset && end <= size, `router offset ${end} outside [${offset}, ${size}]`);
        summary.router_bytes_read = end - offset;
        q.putFile.run(opts.router, "router", end, null, nowIso());
      })();
    }
  }

  if (summary.bytes_read > 0 || summary.router_bytes_read > 0 || !hasDecisions(db)) {
    rebuildDecisions(db);
    summary.decisions_rebuilt = true;
  }
  summary.counts = countRows(db);
  summary.wall_ms = Math.round(performance.now() - t0);
  db.close();
  return summary;
}

/** True when decision rows exist and were computed by the current rules. */
function hasDecisions(db: Database): boolean {
  const v = db.query("SELECT value FROM meta WHERE key = 'decisions_version'").get() as { value: string } | null;
  return v?.value === DECISIONS_VERSION;
}

function subagentType(path: string): string | null {
  const meta = path.replace(/\.jsonl$/, ".meta.json");
  try { return str(JSON.parse(readFileSync(meta, "utf8"))?.agentType); } catch { return null; }
}

function costOf(pricing: Map<string, Pricing>, model: string | null, u: Record<string, any>): number | null {
  if (!model) return null;
  const p = pricing.get(model.replace(/\[.*\]$/, ""));
  if (!p) return null;
  const create = num(u.cache_creation_input_tokens) ?? 0;
  const c1h = num(u.cache_creation?.ephemeral_1h_input_tokens) ?? 0;
  const c5m = num(u.cache_creation?.ephemeral_5m_input_tokens) ?? Math.max(0, create - c1h);
  const usd = ((num(u.input_tokens) ?? 0) * p.input + (num(u.output_tokens) ?? 0) * p.output + (num(u.cache_read_input_tokens) ?? 0) * p.cacheRead + c5m * p.cacheWrite5m + c1h * p.cacheWrite1h) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

function emptyCounts(): Counts { return { spans: 0, chat_spans: 0, tool_calls: 0, router_rows: 0, decisions: 0, reactions: 0, scores: 0 }; }

export function countRows(db: Database): Counts {
  const c = emptyCounts();
  for (const t of Object.keys(c) as Array<keyof Counts>) c[t] = (db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  return c;
}

export type { Origin };
