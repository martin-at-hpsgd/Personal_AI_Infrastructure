/**
 * Heartbeat iMessage leg — turns new rows from the Messages reader's inbox
 * (LIFEOS/TOOLS/Messages/MessagesSync.ts) into IMESSAGE findings, each once.
 *
 * The tick never opens chat.db: only the compiled reader holds Full Disk
 * Access. Message text, with the few lines before it in the same
 * conversation, goes to the model as a finding; the ledger gets
 * metadata only, never the text.
 *
 * @version 1.1.0
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getPrincipalName } from "../../../hooks/lib/identity.ts";
import { principalTimezone } from "../../TOOLS/lib/Timezone.ts";

export interface InboxRow { rowid: number; at: string; from: string; chat: string; chatId?: string; group: boolean; text: string; attachments: boolean }
export interface ThreadLine { rowid: number; at: string; fromMe: boolean; from: string; text: string }
export type Threads = Record<string, { messages: ThreadLine[] }>;
const CONTEXT_LINES = 4, CONTEXT_CHARS = 140;
export interface ImessageResult { findings: string[]; ledger: string[]; cursor: number }

export const INBOX_PATH = () => process.env.LIFEOS_MESSAGES_INBOX || join(homedir(), ".local", "state", "lifeos", "messages", "inbox.jsonl");

export const THREADS_PATH = () => process.env.LIFEOS_MESSAGES_THREADS || join(homedir(), ".local", "state", "lifeos", "messages", "threads.json");

export function readThreads(path = THREADS_PATH()): Threads {
  try { return JSON.parse(readFileSync(path, "utf8")).chats ?? {}; } catch { return {}; }
}

/** Who "fromMe" lines are attributed to: the principal's configured name, or "me" when identity is unreadable or empty. */
export function principalLabel(resolve: () => string = getPrincipalName): string {
  try { return resolve().trim() || "me"; } catch { return "me"; }
}

/** The lines just before this message in its conversation, oldest first, one line. */
export function contextFor(row: InboxRow, threads: Threads, me: string = principalLabel()): string {
  const lines = (row.chatId ? threads[row.chatId]?.messages ?? [] : []).filter((m) => m.rowid < row.rowid).slice(-CONTEXT_LINES);
  return lines.map((m) => `${m.fromMe ? me : m.from}: ${oneLine(m.text).slice(0, CONTEXT_CHARS)}`).join(" | ").replace(/"/g, "'");
}

export function readInbox(path = INBOX_PATH()): InboxRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as InboxRow]; } catch { return []; } });
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: principalTimezone() });
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * `cursor` is the last inbox rowid this tick already handed to the model; -1
 * means never run, which starts at the newest row so a fresh install does not
 * replay a week of texts.
 */
export function imessageFindings(rows: InboxRow[], cursor: number, threads: Threads = {}): ImessageResult {
  const top = rows.reduce((m, r) => Math.max(m, r.rowid), cursor);
  if (cursor < 0) return { findings: [], ledger: [], cursor: Math.max(top, 0) };
  const fresh = rows.filter((r) => r.rowid > cursor).sort((a, b) => a.rowid - b.rowid);
  return {
    findings: fresh.map((r) =>
      `IMESSAGE: from=${r.from} · ${r.group ? `group="${r.chat}"` : "direct"} · at=${hhmm(r.at)}` +
      ` · text="${oneLine(r.text).replace(/"/g, "'")}"${r.attachments ? " · +attachment" : ""}` +
      ((c) => c ? ` · earlier="${c}"` : "")(contextFor(r, threads))),
    ledger: fresh.map((r) => `IMESSAGE_SEEN: from=${r.from} · ${r.group ? "group" : "direct"} · at=${hhmm(r.at)} · chars=${r.text.length}`),
    cursor: top,
  };
}
