#!/usr/bin/env bun
/**
 * Observe — LifeOS visibility into everything the Hermes sidecar does.
 *
 * Read-only aggregation over the live install's own records: the session and
 * message store (state.db), the cron execution history (cron/executions.db),
 * the agent error log, and the guard audit trail. One CLI answers the three
 * troubleshooting questions in order of zoom:
 *
 *   status    — is the sidecar healthy, and is it actually running LifeOS?
 *   failures  — every recent failure, classified by named cause
 *   sessions  — recent sessions with outcome markers
 *   trace     — one session reconstructed end-to-end
 *
 * Consumed by the Hermes skill intents and directly from the terminal:
 *   bun LIFEOS/HERMES/Observe.ts status [--json]
 *   bun LIFEOS/HERMES/Observe.ts failures [--days 7] [--json]
 *   bun LIFEOS/HERMES/Observe.ts sessions [--source photon|cron|cli] [--days 7] [--limit 20] [--json]
 *   bun LIFEOS/HERMES/Observe.ts trace <session-id> | --last [--source X] [--full] [--json]
 *
 * Invariants: install-generic (paths from HERMES_HOME, no instance literals);
 * every database opened readonly; credential files never read; an absent or
 * broken install degrades to structured emptiness, never a crash.
 */

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { analyzeGuardLog } from "./LogAnalysis";
import { checkHermesHealth } from "./Health";

const HERMES_HOME = process.env.HERMES_HOME || join(homedir(), ".hermes");
const STATE_DB = join(HERMES_HOME, "state.db");
const EXEC_DB = join(HERMES_HOME, "cron", "executions.db");
const ERROR_LOGS = [join(HERMES_HOME, "logs", "errors.log"), join(HERMES_HOME, "logs", "errors.log.1")];

const SOUL_BLOCK_MARK = "[BLOCKED:";

// ---------------------------------------------------------------------------
// helpers

/**
 * Read-only open with a WAL gotcha handled: a WAL-mode database whose -wal/-shm
 * sidecars are absent fails a readonly connection at first PREPARE (SQLITE_CANTOPEN),
 * not at open. Probe with a trivial query; on failure, snapshot the file (+ sidecars)
 * into a temp dir and read the copy — the live database is never opened writable
 * and never touched. The returned handle's close() also removes the snapshot.
 */
function roDb(path: string): Database | null {
  if (!existsSync(path)) return null;
  try {
    const db = new Database(path, { readonly: true });
    try {
      db.query("SELECT 1 FROM sqlite_master LIMIT 1").get();
      return db;
    } catch {
      db.close();
    }
  } catch {
    /* fall through to snapshot */
  }
  try {
    const dir = mkdtempSync(join(tmpdir(), "hermes-observe-"));
    const copy = join(dir, basename(path));
    copyFileSync(path, copy);
    for (const ext of ["-wal", "-shm"]) if (existsSync(path + ext)) copyFileSync(path + ext, copy + ext);
    const db = new Database(copy);
    const origClose = db.close.bind(db);
    db.close = (() => {
      origClose();
      rmSync(dir, { recursive: true, force: true });
    }) as typeof db.close;
    return db;
  } catch {
    return null;
  }
}

/**
 * Hermes 2026-08-15+ deduplicates session system prompts into a `system_prompts`
 * hash store and blanks the inline `sessions.system_prompt` column — a naive
 * read of the old column sees every session as prompt-less (and every
 * soul-blocked marker as gone). Resolve through the hash store when it exists;
 * fall back to the inline column on pre-migration databases.
 */
function soulPromptSql(db: Database): { select: string; join: string } {
  try {
    const has = db
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='system_prompts'")
      .get();
    if (has) {
      return {
        select: "COALESCE(NULLIF(s.system_prompt, ''), p.prompt, '')",
        join: "LEFT JOIN system_prompts p ON s.system_prompt_hash = p.hash",
      };
    }
  } catch {
    /* fall through */
  }
  return { select: "COALESCE(s.system_prompt, '')", join: "" };
}

function excerpt(s: unknown, n: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function iso(epochSeconds: number | null | undefined): string | null {
  if (!epochSeconds) return null;
  return new Date(epochSeconds * 1000).toISOString();
}

/** errors.log lines look like: `2026-08-15 09:44:29,240 WARNING [session_id] logger: message` */
function readErrorLogLines(): Array<{ ts: string; level: string; session: string | null; msg: string }> {
  const out: Array<{ ts: string; level: string; session: string | null; msg: string }> = [];
  for (const path of ERROR_LOGS) {
    if (!existsSync(path)) continue;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const m = line.match(/^(\d{4}-\d{2}-\d{2} [\d:,.]+)\s+(\w+)\s+(?:\[([^\]]+)\]\s+)?(.*)$/);
      if (m) out.push({ ts: m[1]!, level: m[2]!, session: m[3] ?? null, msg: m[4]! });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// sessions

export interface SessionRow {
  id: string;
  source: string;
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  messages: number;
  toolCalls: number;
  model: string | null;
  soulBlocked: boolean;
  handoffError: string | null;
}

export function listSessions(opts: { source?: string; days?: number; limit?: number } = {}): SessionRow[] {
  return querySessions(opts) ?? [];
}

/** Like listSessions, but null when the state DB is missing or the query failed, so a probe can tell "no sessions" from "could not look". */
export function querySessions(opts: { source?: string; days?: number; limit?: number } = {}): SessionRow[] | null {
  const db = roDb(STATE_DB);
  if (!db) return null;
  const days = opts.days ?? 7;
  const limit = opts.limit ?? 20;
  const cutoff = Date.now() / 1000 - days * 86_400;
  try {
    const sp = soulPromptSql(db);
    const where = ["s.started_at >= ?"];
    const params: (string | number)[] = [cutoff];
    if (opts.source) {
      where.push("s.source = ?");
      params.push(opts.source);
    }
    const rows = db
      .query(
        `SELECT s.id, s.source, s.title, s.started_at, s.ended_at, s.end_reason, s.message_count,
                s.tool_call_count, s.model, ${sp.select} AS system_prompt, s.handoff_error
         FROM sessions s ${sp.join} WHERE ${where.join(" AND ")}
         ORDER BY s.started_at DESC LIMIT ?`,
      )
      .all(...params, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      source: String(r.source),
      title: (r.title as string) ?? null,
      startedAt: iso(r.started_at as number),
      endedAt: iso(r.ended_at as number | null),
      endReason: (r.end_reason as string) ?? null,
      messages: Number(r.message_count ?? 0),
      toolCalls: Number(r.tool_call_count ?? 0),
      model: (r.model as string) ?? null,
      soulBlocked: String(r.system_prompt ?? "").startsWith(SOUL_BLOCK_MARK),
      handoffError: (r.handoff_error as string) ?? null,
    }));
  } catch {
    return null;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// failures

export interface FailureClass {
  cls: string;
  severity: "high" | "medium" | "low";
  count: number;
  detail: string;
  recommendation: string;
  samples: string[];
}

export interface FailureReport {
  available: boolean;
  windowDays: number;
  generatedAt: string;
  classes: FailureClass[];
}

export function analyzeFailures(days = 7): FailureReport {
  const classes: FailureClass[] = [];
  const cutoffSec = Date.now() / 1000 - days * 86_400;
  const cutoffIso = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  // 1. Soul blocked — sessions running WITHOUT the LifeOS constitution.
  const state = roDb(STATE_DB);
  if (state) {
    try {
      const sp = soulPromptSql(state);
      const r = state
        .query(
          `SELECT count(*) total,
                  sum(CASE WHEN ${sp.select} LIKE ? THEN 1 ELSE 0 END) blocked,
                  min(CASE WHEN ${sp.select} LIKE ? THEN s.started_at END) firstBlocked
           FROM sessions s ${sp.join} WHERE s.started_at >= ?`,
        )
        .get(`${SOUL_BLOCK_MARK}%`, `${SOUL_BLOCK_MARK}%`, cutoffSec) as Record<string, number>;
      if (r && Number(r.blocked) > 0) {
        const sample = state
          .query(`SELECT substr(${sp.select}, 1, 120) sp FROM sessions s ${sp.join} WHERE ${sp.select} LIKE ? ORDER BY s.started_at DESC LIMIT 1`)
          .get(`${SOUL_BLOCK_MARK}%`) as { sp: string } | null;
        classes.push({
          cls: "soul-blocked",
          severity: "high",
          count: Number(r.blocked),
          detail:
            `${r.blocked}/${r.total} sessions in ${days}d started with SOUL.md rejected by Hermes' prompt-injection scanner ` +
            `(since ${iso(r.firstBlocked) ?? "?"}). These sessions run with NO LifeOS constitution, identity, or skills routing — ` +
            `the sidecar is not "calling LifeOS" in any of them.`,
          recommendation:
            "Find what the scanner flags in SOUL.md (its own injection-defense doctrine quoting attack shapes is the usual trigger), " +
            "reshape that content in the renderer, re-mount, and confirm a fresh session's system_prompt no longer starts with " +
            `'${SOUL_BLOCK_MARK}'.`,
          samples: sample ? [sample.sp] : [],
        });
      }
    } catch {
      /* degrade */
    }
  }

  // 2. Approval-wall deaths — unattended turns stuck on pending_approval.
  const errLines = readErrorLogLines();
  const approval = errLines.filter((l) => l.ts >= cutoffIso && l.msg.includes('"pending_approval"'));
  if (approval.length > 0) {
    const bySession = new Map<string, number>();
    for (const l of approval) bySession.set(l.session ?? "?", (bySession.get(l.session ?? "?") ?? 0) + 1);
    classes.push({
      cls: "pending-approval-death",
      severity: "high",
      count: approval.length,
      detail:
        `${approval.length} tool calls in ${days}d returned status=pending_approval across ${bySession.size} sessions. ` +
        `On a cron or channel turn there is nobody to approve, so the task silently dies at that wall.`,
      recommendation:
        "For each blocked command class, either route it through an already-allowed path or add it to the approval allowlist " +
        "the mount owns in config.yaml (change Policy.ts / mount config and re-mount — never hand-edit).",
      samples: [...bySession.entries()].slice(0, 5).map(([s, n]) => `${s} (${n}×)`),
    });
  }

  // 3. Guard blocks — reuse the dedicated analyzer, surface its findings.
  const guard = analyzeGuardLog({ days });
  if (guard.totalBlocks > 0) {
    classes.push({
      cls: "guard-block",
      severity: guard.findings.some((f) => f.severity === "high") ? "high" : "medium",
      count: guard.totalBlocks,
      detail:
        `${guard.totalBlocks} guard blocks in ${days}d (${Object.entries(guard.byClass)
          .map(([k, v]) => `${k} ${v}`)
          .join(" · ")}). Findings: ${guard.findings.map((f) => f.title).join("; ") || "none"}.`,
      recommendation: "Run `bun LIFEOS/HERMES/LogAnalysis.ts` for per-rule findings; reshape hot rules in Policy.ts and re-mount.",
      samples: guard.topRules.slice(0, 5).map((r) => `${r.rule} (${r.count}×)`),
    });
  }

  // 4. Cron executions that failed outright.
  const exec = roDb(EXEC_DB);
  if (exec) {
    try {
      const rows = exec
        .query(
          `SELECT job_id, status, error, claimed_at FROM executions
           WHERE claimed_at >= ? AND status IN ('failed','unknown')
           ORDER BY claimed_at DESC`,
        )
        .all(cutoffIso) as Array<{ job_id: string; status: string; error: string | null; claimed_at: string }>;
      if (rows.length > 0) {
        classes.push({
          cls: "cron-failed",
          severity: "medium",
          count: rows.length,
          detail: `${rows.length} cron executions ended failed/unknown in ${days}d.`,
          recommendation: "Trace the matching cron session (`Observe.ts trace <session-id>`) and read the job's output dir under cron/output/<job-id>/.",
          samples: rows.slice(0, 5).map((r) => `${r.job_id} ${r.status} @ ${r.claimed_at.slice(0, 16)}${r.error ? ` — ${excerpt(r.error, 80)}` : ""}`),
        });
      }
    } catch {
      /* degrade */
    } finally {
      exec.close();
    }
  }

  // 5. Handoff errors — the reply never made it back to the channel.
  if (state) {
    try {
      const rows = state
        .query(
          `SELECT id, source, handoff_error FROM sessions
           WHERE started_at >= ? AND handoff_error IS NOT NULL AND handoff_error != ''
           ORDER BY started_at DESC LIMIT 10`,
        )
        .all(cutoffSec) as Array<{ id: string; source: string; handoff_error: string }>;
      if (rows.length > 0) {
        classes.push({
          cls: "handoff-error",
          severity: "high",
          count: rows.length,
          detail: `${rows.length} sessions failed to hand their result back to the originating platform — the work may have finished with the reply lost.`,
          recommendation: "Trace each session; check the platform's gateway log around the handoff timestamp.",
          samples: rows.slice(0, 5).map((r) => `${r.id} (${r.source}): ${excerpt(r.handoff_error, 80)}`),
        });
      }
    } catch {
      /* degrade */
    } finally {
      state.close();
    }
  }

  const order = { high: 0, medium: 1, low: 2 } as const;
  classes.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
  return { available: existsSync(HERMES_HOME), windowDays: days, generatedAt: new Date().toISOString(), classes };
}

// ---------------------------------------------------------------------------
// trace

export interface TraceEvent {
  ts: string | null;
  kind: "message" | "tool" | "guard-block" | "log-error";
  role?: string;
  tool?: string | null;
  flag?: string | null;
  text: string;
}

export interface Trace {
  found: boolean;
  session: SessionRow | null;
  soulBlocked: boolean;
  events: TraceEvent[];
}

export function traceSession(id: string, opts: { full?: boolean } = {}): Trace {
  const db = roDb(STATE_DB);
  if (!db) return { found: false, session: null, soulBlocked: false, events: [] };
  const cap = opts.full ? 4000 : 220;
  try {
    const sp = soulPromptSql(db);
    const s = db
      .query(
        `SELECT s.id, s.source, s.title, s.started_at, s.ended_at, s.end_reason, s.message_count,
                s.tool_call_count, s.model, ${sp.select} AS system_prompt, s.handoff_error
         FROM sessions s ${sp.join} WHERE s.id = ?`,
      )
      .get(id) as Record<string, unknown> | null;
    if (!s) return { found: false, session: null, soulBlocked: false, events: [] };

    const session: SessionRow = {
      id: String(s.id),
      source: String(s.source),
      title: (s.title as string) ?? null,
      startedAt: iso(s.started_at as number),
      endedAt: iso(s.ended_at as number | null),
      endReason: (s.end_reason as string) ?? null,
      messages: Number(s.message_count ?? 0),
      toolCalls: Number(s.tool_call_count ?? 0),
      model: (s.model as string) ?? null,
      soulBlocked: String(s.system_prompt ?? "").startsWith(SOUL_BLOCK_MARK),
      handoffError: (s.handoff_error as string) ?? null,
    };

    const events: TraceEvent[] = [];
    const msgs = db
      .query(
        `SELECT role, content, tool_name, tool_calls, timestamp, finish_reason
         FROM messages WHERE session_id = ? ORDER BY timestamp ASC`,
      )
      .all(id) as Array<Record<string, unknown>>;
    for (const m of msgs) {
      const content = String(m.content ?? "");
      const toolCalls = String(m.tool_calls ?? "");
      let flag: string | null = null;
      if (content.includes('"pending_approval"')) flag = "PENDING-APPROVAL";
      else if (content.includes("matches deny rule") || content.includes("BLOCKED")) flag = "GUARD-BLOCK";
      else if (content.includes('"exit_code": -1') || content.includes('"exit_code":-1')) flag = "TOOL-ERROR";
      events.push({
        ts: iso(m.timestamp as number),
        kind: String(m.role) === "tool" ? "tool" : "message",
        role: String(m.role),
        tool: (m.tool_name as string) ?? null,
        flag,
        text: excerpt(content || toolCalls, cap),
      });
    }

    // Correlate the agent error log by session tag.
    for (const l of readErrorLogLines()) {
      if (l.session === id) {
        events.push({ ts: l.ts.replace(",", "."), kind: "log-error", flag: l.level, text: excerpt(l.msg, cap) });
      }
    }

    // Guard blocks inside the session's time window (blocked.jsonl carries no session id).
    const start = (s.started_at as number) ?? 0;
    const end = (s.ended_at as number | null) ?? Date.now() / 1000;
    const blockedPath = join(HERMES_HOME, "plugins", "lifeos", "blocked.jsonl");
    if (existsSync(blockedPath)) {
      try {
        for (const line of readFileSync(blockedPath, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const b = JSON.parse(line) as { ts?: string; tool?: string; target?: string; reason?: string };
            const t = new Date(String(b.ts ?? "")).getTime() / 1000;
            if (t >= start && t <= end + 60) {
              events.push({
                ts: String(b.ts ?? null),
                kind: "guard-block",
                tool: String(b.tool ?? ""),
                flag: "GUARD-BLOCK",
                text: excerpt(`${b.target} — ${b.reason}`, cap),
              });
            }
          } catch {
            /* skip corrupt line */
          }
        }
      } catch {
        /* degrade */
      }
    }

    events.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")));
    return { found: true, session, soulBlocked: session.soulBlocked, events };
  } catch {
    return { found: false, session: null, soulBlocked: false, events: [] };
  } finally {
    db.close();
  }
}

export function lastSessionId(source?: string): string | null {
  const rows = listSessions({ source, days: 90, limit: 1 });
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// status

export function observeStatus() {
  const health = checkHermesHealth();
  const week = analyzeFailures(7);
  const state = roDb(STATE_DB);
  let sessions24h = 0;
  let soulBlocked24h = 0;
  if (state) {
    try {
      const sp = soulPromptSql(state);
      const r = state
        .query(
          `SELECT count(*) n, sum(CASE WHEN ${sp.select} LIKE ? THEN 1 ELSE 0 END) b
           FROM sessions s ${sp.join} WHERE s.started_at >= ?`,
        )
        .get(`${SOUL_BLOCK_MARK}%`, Date.now() / 1000 - 86_400) as { n: number; b: number };
      sessions24h = Number(r?.n ?? 0);
      soulBlocked24h = Number(r?.b ?? 0);
    } catch {
      /* degrade */
    } finally {
      state.close();
    }
  }
  return {
    hermesHome: HERMES_HOME,
    installPresent: existsSync(HERMES_HOME),
    health,
    sessions24h,
    soulBlocked24h,
    lifeosActuallyLoaded: sessions24h > 0 ? soulBlocked24h < sessions24h : null,
    failureClasses7d: week.classes.map((c) => ({ cls: c.cls, severity: c.severity, count: c.count })),
  };
}

// ---------------------------------------------------------------------------
// CLI

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "status";
  const json = argv.includes("--json");
  const days = Number(flag(argv, "--days")) || 7;

  if (cmd === "status") {
    const s = observeStatus();
    if (argv.includes("--assert-lifeos")) {
      // Bunker probe: sessions exist AND some ran without the LifeOS soul → the
      // sidecar is nominally up but not running LifeOS, which is the outage that
      // stayed invisible for 19 days. Windowed to 2h so it answers "is it failing
      // NOW" — red within one cron cycle of a regression, green within two hours
      // of a fix. A probe that could not look (unreadable DB) or saw nothing (no
      // sessions in the window) has proven nothing, so it exits 2 "unproven" and
      // never reads as green. Run it after a session cycle.
      const recent = querySessions({ days: 2 / 24, limit: 1000 });
      if (recent === null) {
        console.error("UNPROVEN: the Hermes state DB is missing or unreadable, so soul loading could not be checked");
        process.exit(2);
      }
      if (recent.length === 0) {
        console.error("UNPROVEN: no Hermes sessions in the last 2h, so soul loading was not exercised; run it after a session cycle");
        process.exit(2);
      }
      const blocked = recent.filter((r) => r.soulBlocked).length;
      const failing = recent.length > 0 && blocked > 0;
      console.log(failing ? `SOUL NOT LOADING: ${blocked}/${recent.length} sessions in 2h started [BLOCKED:` : `ok: ${recent.length} sessions 2h, 0 soul-blocked`);
      process.exit(failing ? 1 : 0);
    }
    if (json) console.log(JSON.stringify(s, null, 2));
    else {
      console.log(`hermes: ${s.health.status}  (${s.hermesHome})`);
      console.log(`sessions 24h: ${s.sessions24h}, soul-blocked: ${s.soulBlocked24h}${s.soulBlocked24h > 0 ? "  ⚠️ LifeOS constitution NOT loading" : ""}`);
      for (const p of s.health.problems ?? []) console.log(`problem: ${p}`);
      for (const c of s.failureClasses7d) console.log(`7d ${c.severity}: ${c.cls} ×${c.count}`);
    }
  } else if (cmd === "failures") {
    const r = analyzeFailures(days);
    if (argv.includes("--assert-no-approval-deaths")) {
      // Bunker probe: unattended turns dying on approval walls. Every hit is a
      // task that silently stopped with nobody present to approve.
      const c = r.classes.find((x) => x.cls === "pending-approval-death");
      console.log(c ? `${c.count} approval-wall deaths in ${days}d` : `ok: 0 approval-wall deaths in ${days}d`);
      process.exit(c ? 1 : 0);
    }
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`hermes failures, last ${r.windowDays}d — ${r.classes.length} classes`);
      for (const c of r.classes) {
        console.log(`\n[${c.severity}] ${c.cls} ×${c.count}\n  ${c.detail}\n  → ${c.recommendation}`);
        for (const smp of c.samples) console.log(`    · ${smp}`);
      }
    }
  } else if (cmd === "sessions") {
    const rows = listSessions({ source: flag(argv, "--source"), days, limit: Number(flag(argv, "--limit")) || 20 });
    if (json) console.log(JSON.stringify(rows, null, 2));
    else {
      for (const r of rows) {
        const marks = [r.soulBlocked ? "SOUL-BLOCKED" : null, r.handoffError ? "HANDOFF-ERR" : null, r.endReason].filter(Boolean).join(" ");
        console.log(`${r.startedAt}  ${r.source.padEnd(8)} ${r.id}  msgs=${r.messages} tools=${r.toolCalls}  ${marks}${r.title ? `  "${excerpt(r.title, 60)}"` : ""}`);
      }
      if (rows.length === 0) console.log("(no sessions in window — install absent or idle)");
    }
  } else if (cmd === "trace") {
    const id = argv.includes("--last") ? lastSessionId(flag(argv, "--source")) : argv[1];
    if (!id) {
      if (argv.includes("--last")) {
        console.log("(no sessions found — install absent or idle)");
        process.exit(0);
      }
      console.error("usage: Observe.ts trace <session-id> | --last [--source X]");
      process.exit(1);
    }
    const t = traceSession(id, { full: argv.includes("--full") });
    if (json) console.log(JSON.stringify(t, null, 2));
    else if (!t.found) console.log(`session not found: ${id}`);
    else {
      const s = t.session!;
      console.log(`session ${s.id}  source=${s.source} model=${s.model}\nstarted=${s.startedAt} ended=${s.endedAt} end_reason=${s.endReason ?? "-"}`);
      console.log(`soul: ${t.soulBlocked ? "⚠️ BLOCKED — ran WITHOUT LifeOS constitution/skills" : "loaded"}${s.handoffError ? `\nhandoff error: ${s.handoffError}` : ""}`);
      for (const e of t.events) {
        const tag = e.flag ? ` [${e.flag}]` : "";
        console.log(`${e.ts ?? "?"}  ${e.kind}${e.role ? `/${e.role}` : ""}${e.tool ? ` ${e.tool}` : ""}${tag}: ${e.text}`);
      }
    }
  } else {
    console.error(`unknown command: ${cmd}\nusage: Observe.ts status|failures|sessions|trace [options]`);
    process.exit(1);
  }
}
