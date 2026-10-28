#!/usr/bin/env bun
/**
 * MessagesSync — copies new inbound iMessages from chat.db into a private inbox
 * file the 10-minute heartbeat reads. Compiled to `~/.local/bin/lifeos-messages`
 * and run by launchd (`com.lifeos.messages`) so Full Disk Access is granted to
 * this one binary, never to bun.
 *
 *   lifeos-messages            # sync once (what launchd runs)
 *   lifeos-messages status     # JSON: access, cursor, inbox size, last run
 *
 * Inbox:  ~/.local/state/lifeos/messages/inbox.jsonl (0600, outside every repo)
 * Threads: threads.json beside it — the last 20 lines of the 100 most recent
 *         conversations, both directions, so a reply is read in context. Filled
 *         once from chat.db (backfill), then only from new rows each run.
 * Log:    LIFEOS/MEMORY/OBSERVABILITY/messages-reader.jsonl — counts only, never text;
 *         Vigil's ops adapter reads it, so a lost grant surfaces as `denied`.
 * Config: LIFEOS/USER/CONFIG/heartbeat.json → imessage.{excludeHandles, retainDays}
 *
 * @version 1.1.1
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { invariant } from "../Invariant.ts";
import { getClaudeDir } from "../Paths.ts";
import { append } from "../../STATVS/index.ts";
import type { Database } from "bun:sqlite";
import { CHAT_DB, admit, chatHistory, maxRowId, normHandle, openReadOnly, recentChats, rowsAfter, threadEntry, type RawRow, type TextMessage, type ThreadEntry } from "./ChatDb.ts";

const LIFEOS_ROOT = process.env.LIFEOS_ROOT || getClaudeDir();
const DB_PATH = process.env.MESSAGES_DB || CHAT_DB;
const STATE_DIR = process.env.MESSAGES_STATE_DIR || join(homedir(), ".local", "state", "lifeos", "messages");
const OBS_LOG = process.env.MESSAGES_OBS_LOG || join(LIFEOS_ROOT, "LIFEOS", "MEMORY", "OBSERVABILITY", "messages-reader.jsonl");
const CONFIG_PATH = join(LIFEOS_ROOT, "LIFEOS", "USER", "CONFIG", "heartbeat.json");
const CURSOR = join(STATE_DIR, "cursor.json");
const INBOX = join(STATE_DIR, "inbox.jsonl");
const THREADS = join(STATE_DIR, "threads.json");
const CHATS = 100, PER_CHAT = 20;

export interface Thread { name: string | null; group: boolean; last: number; messages: ThreadEntry[] }
type Threads = Record<string, Thread>;

interface Cfg { excludeHandles: string[]; retainDays: number }
type Status = "ok" | "initialized" | "denied" | "error";

/**
 * Sender-exclusion policy. A file that does not exist means the policy was never
 * configured (empty exclusion list). A file that exists but cannot be read, parsed
 * or validated THROWS: capture must stop rather than run with the exclusions
 * silently dropped.
 */
export function config(path: string = CONFIG_PATH): Cfg {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { excludeHandles: [], retainDays: 7 };
    throw new Error(`sender-exclusion policy unreadable: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("sender-exclusion policy is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("sender-exclusion policy is not a JSON object");
  // Only an ABSENT key means "not configured"; an explicit null is an invalid policy and throws below.
  const im = parsed.imessage === undefined ? {} : parsed.imessage;
  if (im === null || typeof im !== "object" || Array.isArray(im)) throw new Error("sender-exclusion policy: imessage is not an object");
  if (im.excludeHandles !== undefined && (!Array.isArray(im.excludeHandles) || !im.excludeHandles.every((h: unknown) => typeof h === "string"))) {
    throw new Error("sender-exclusion policy: imessage.excludeHandles is not a list of strings");
  }
  return { excludeHandles: im.excludeHandles ?? [], retainDays: Number(im.retainDays) || 7 };
}

function readCursor(): number | null {
  try { const n = JSON.parse(readFileSync(CURSOR, "utf8")).rowid; return Number.isInteger(n) ? n : null; } catch { return null; }
}

function writeCursor(prev: number | null, next: number) {
  invariant(Number.isInteger(next) && next >= 0, "cursor is a non-negative integer");
  invariant(prev === null || next >= prev, "cursor never moves backwards");
  writeFileSync(CURSOR, JSON.stringify({ rowid: next, at: new Date().toISOString() }) + "\n", { mode: 0o600 });
}

function readInbox(): TextMessage[] {
  if (!existsSync(INBOX)) return [];
  return readFileSync(INBOX, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

function appendInbox(rows: TextMessage[], retainDays: number) {
  const cutoff = Date.now() - retainDays * 86_400_000;
  const kept = readInbox().filter((r) => Date.parse(r.at) >= cutoff && Number.isInteger(r?.rowid) && r.rowid > 0);
  for (const r of rows) invariant(Number.isInteger(r.rowid) && r.rowid > 0, "inbox record has a message rowid");
  rewriteInbox([...kept, ...rows]);
}

function rewriteInbox(all: TextMessage[]) {
  for (const r of all) invariant(Number.isInteger(r.rowid) && r.rowid > 0, "inbox record has a message rowid");
  const tmp = `${INBOX}.tmp`;
  writeFileSync(tmp, all.map((r) => JSON.stringify(r)).join("\n") + (all.length ? "\n" : ""), { mode: 0o600 });
  renameSync(tmp, INBOX);
}

function readThreads(): Threads | null {
  try { return JSON.parse(readFileSync(THREADS, "utf8")).chats ?? null; } catch { return null; }
}

function writeThreads(chats: Threads) {
  const ids = Object.keys(chats).sort((a, b) => chats[b]!.last - chats[a]!.last).slice(0, CHATS);
  const kept: Threads = Object.fromEntries(ids.map((id) => [id, chats[id]!]));
  for (const t of Object.values(kept)) invariant(t.messages.length <= PER_CHAT, "thread holds at most PER_CHAT lines");
  const tmp = `${THREADS}.tmp`;
  writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), chats: kept }) + "\n", { mode: 0o600 });
  renameSync(tmp, THREADS);
}

/** Adds one row to its conversation, creating it if new; returns whether anything changed. */
function addToThread(chats: Threads, row: RawRow, cfg: Cfg): boolean {
  const e = threadEntry(row, cfg);
  const id = row.chat ?? row.handle;
  if (!e || !id) return false;
  const t = chats[id] ??= { name: row.chat_name, group: row.style === 43, last: 0, messages: [] };
  if (t.messages.some((m) => m.rowid === e.rowid)) return false;
  t.messages.push(e);
  t.messages = t.messages.slice(-PER_CHAT);
  t.last = Math.max(t.last, e.rowid);
  return true;
}

/**
 * Apply the CURRENT sender exclusions to everything already persisted: inbox rows from or in a conversation with an
 * excluded handle, thread lines from one, and whole direct threads with one. Exclusions used to bind only rows captured
 * after they were added, so an exclusion added today left yesterday's messages in the caches the heartbeat feeds to a
 * model. Runs on every sync, before chat.db is opened, so it holds even when no new
 * rows arrive or the database grant is lost. Returns how many records were removed.
 */
export function purgeExcluded(cfg: Cfg): { inbox: number; threadLines: number; threads: number } {
  const excluded = new Set(cfg.excludeHandles.map(normHandle).filter(Boolean));
  const removed = { inbox: 0, threadLines: 0, threads: 0 };
  if (excluded.size === 0) return removed;
  const hit = (h: unknown): boolean => typeof h === "string" && excluded.has(normHandle(h));
  if (existsSync(INBOX)) {
    const rows = readInbox();
    const kept = rows.filter((r) => r !== null && typeof r === "object" && Number.isInteger(r.rowid) && r.rowid > 0 && !hit(r.from) && !hit(r.chatId));
    removed.inbox = rows.length - kept.length;
    // An unparseable line is dropped too: a record the filter cannot read is a record it cannot vouch for.
    const raw = readFileSync(INBOX, "utf8").split("\n").filter(Boolean).length;
    if (removed.inbox > 0 || raw !== rows.length) rewriteInbox(kept);
  }
  const chats = readThreads();
  if (chats) {
    let changed = false;
    for (const [id, t] of Object.entries(chats)) {
      if (!t.group && hit(id)) { removed.threads++; removed.threadLines += t.messages.length; delete chats[id]; changed = true; continue; }
      const keep = t.messages.filter((m) => !hit(m.from));
      if (keep.length !== t.messages.length) {
        removed.threadLines += t.messages.length - keep.length;
        changed = true;
        if (keep.length === 0) { removed.threads++; delete chats[id]; } else t.messages = keep;
      }
    }
    if (changed) writeThreads(chats);
  }
  return removed;
}

/** One-time read of the most recent conversations. */
function backfill(db: Database, cfg: Cfg): Threads {
  const chats: Threads = {};
  for (const chat of recentChats(db, CHATS)) for (const row of chatHistory(db, chat, PER_CHAT)) addToThread(chats, row, cfg);
  return chats;
}

function log(row: Record<string, unknown>) {
  mkdirSync(dirname(OBS_LOG), { recursive: true });
  appendFileSync(OBS_LOG, JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
}

export interface RunRow { status: Status; scanned: number; kept: number; cursor: number | null; threads?: number; backfilled?: boolean; ms: number; error?: string }
const SEVERITY: Partial<Record<Status, "medium" | "low">> = { denied: "medium", error: "low" };
const TITLE: Partial<Record<Status, string>> = { denied: "Messages reader lost Full Disk Access", error: "Messages reader run failed" };

/** One counts row per run in STATVS stream `messages` (STATVS ISC-95): never text, handles or chat ids (ISC-96). Returns null when the record took it, else why not; a refused or failed append never fails the run. */
export function record(row: RunRow, write: typeof append = append): string | null {
  invariant(["ok", "initialized", "denied", "error"].includes(row.status), `known reader status: ${row.status}`);
  invariant([row.scanned, row.kept, row.ms].every((n) => Number.isInteger(n) && n >= 0), "reader counts are non-negative integers");
  const data = { status: row.status, scanned: row.scanned, kept: row.kept, cursor: row.cursor, threads: row.threads ?? null, ms: row.ms, ...(row.backfilled ? { backfilled: true } : {}), ...(row.error ? { error: row.error } : {}) };
  const severity = SEVERITY[row.status];
  try {
    const r = write({ writer: "messages-reader", stream: "messages", class: "system", kind: "run", ...(severity ? { severity, title: TITLE[row.status] } : {}), data });
    return r.ok || "spooled" in r ? null : `refused: ${r.refused.slice(0, 200)}`;
  } catch (e) {
    return `failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
  }
}

const deniedError = (e: unknown): boolean => /authorization denied|unable to open|not permitted|EPERM|EACCES|SQLITE_CANTOPEN|SQLITE_AUTH/i.test(String((e as Error)?.message ?? e));

export function sync(): { status: Status; scanned: number; kept: number; cursor: number | null; threads?: number; backfilled?: boolean; error?: string } {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STATE_DIR, 0o700);
  const prev = readCursor();
  let cfg: Cfg;
  try {
    cfg = config();
  } catch (e) {
    // Fail closed: no capture, cursor untouched, so nothing is lost and the next good run catches up.
    return { status: "error", scanned: 0, kept: 0, cursor: prev, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
  // The current policy binds what is already stored, not only what arrives from now on.
  try {
    purgeExcluded(cfg);
  } catch (e) {
    return { status: "error", scanned: 0, kept: 0, cursor: prev, error: `exclusion purge failed: ${String((e as Error)?.message ?? e).slice(0, 160)}` };
  }
  let db;
  try {
    db = openReadOnly(DB_PATH);
    db.query("SELECT 1 FROM message LIMIT 1").get();
  } catch (e) {
    db?.close();
    const status: Status = deniedError(e) ? "denied" : "error";
    return { status, scanned: 0, kept: 0, cursor: prev, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
  try {
    let chats = readThreads();
    const backfilled = chats === null;
    if (chats === null) { chats = backfill(db, cfg); writeThreads(chats); }
    if (prev === null) {
      const top = maxRowId(db);
      writeCursor(null, top);
      return { status: "initialized", scanned: 0, kept: 0, cursor: top, threads: Object.keys(chats).length, backfilled };
    }
    let threadsChanged = false;
    let cursor = prev, scanned = 0;
    const kept: TextMessage[] = [];
    for (;;) {
      const batch = rowsAfter(db, cursor, 500);
      if (!batch.length) break;
      scanned += batch.length;
      for (const row of batch) { if (addToThread(chats, row, cfg)) threadsChanged = true; const m = admit(row, cfg); if (m) kept.push(m); }
      cursor = batch.at(-1)!.rowid;
      if (batch.length < 500) break;
    }
    if (kept.length || cursor !== prev) appendInbox(kept, cfg.retainDays);
    if (threadsChanged) writeThreads(chats);
    if (cursor !== prev) writeCursor(prev, cursor);
    return { status: "ok", scanned, kept: kept.length, cursor, threads: Object.keys(chats).length, backfilled };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  if (process.argv[2] === "status") {
    const inbox = readInbox();
    let access = "ok";
    try { const db = openReadOnly(DB_PATH); db.query("SELECT 1 FROM message LIMIT 1").get(); db.close(); } catch (e) { access = deniedError(e) ? "denied" : "error"; }
    const last = existsSync(OBS_LOG) ? readFileSync(OBS_LOG, "utf8").trim().split("\n").at(-1) : null;
    console.log(JSON.stringify({ access, note: access === "denied" ? "this process lacks Full Disk Access; launchd's reader has its own grant" : undefined, cursor: readCursor(), inbox: inbox.length, lastRun: last ? JSON.parse(last) : null }, null, 2));
  } else {
    const t0 = performance.now();
    const r = sync();
    const row: RunRow = { status: r.status, scanned: r.scanned, kept: r.kept, cursor: r.cursor, threads: r.threads, ...(r.backfilled ? { backfilled: true } : {}), ms: Math.round(performance.now() - t0), ...(r.error ? { error: r.error } : {}) };
    const statvs = record(row);
    log({ ...row, ...(statvs ? { statvs } : {}) });
    if (r.status === "error") process.exitCode = 1;
  }
}
