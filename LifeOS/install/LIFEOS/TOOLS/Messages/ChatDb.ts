/**
 * ChatDb — read-only access to the macOS Messages database (`~/Library/Messages/chat.db`).
 *
 * The one sanctioned `bun:sqlite` read of a database another program owns
 * (LifeosSystemArchitecture AD-2). Opens read-only, never writes. Reading it
 * needs Full Disk Access, which is granted to the compiled `lifeos-messages`
 * binary alone (MessagesSync.ts), never to bun.
 *
 * @version 1.2.0
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { isVerificationCode as sharedIsVerificationCode } from "../lib/Boundary";

export const CHAT_DB = join(homedir(), "Library", "Messages", "chat.db");
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const TEXT_MAX = 600;

export interface RawRow {
  rowid: number;
  guid: string;
  date: number;
  is_from_me: number;
  text: string | null;
  body: Uint8Array | null;
  assoc: number;
  item_type: number;
  att: number;
  handle: string | null;
  chat: string | null;
  chat_name: string | null;
  style: number | null;
}

export interface TextMessage {
  rowid: number;
  guid: string;
  at: string;
  from: string;
  chat: string;
  chatId: string;
  group: boolean;
  text: string;
  attachments: boolean;
}

/** One line of thread context, either direction. */
export interface ThreadEntry { rowid: number; at: string; fromMe: boolean; from: string; text: string }

export interface ChatRef { rowid: number; id: string; name: string | null; style: number | null }

export interface AdmitOptions {
  excludeHandles: string[];
}

/** Messages stores dates as nanoseconds since 2001-01-01 (seconds on very old rows). */
export function appleDate(v: number): string {
  const ms = v > 1e12 ? v / 1e6 : v * 1000;
  return new Date(APPLE_EPOCH_MS + ms).toISOString();
}

/**
 * Recovers the plain string from an `attributedBody` typedstream blob. Since
 * Ventura most rows carry their text only here. Layout after the `NSString`
 * class name: 5 header bytes, then a length (one byte, or 0x81 + uint16 LE,
 * or 0x82 + uint32 LE), then UTF-8 bytes.
 */
export function decodeAttributedBody(blob: Uint8Array | null | undefined): string | null {
  if (!blob?.length) return null;
  const buf = Buffer.from(blob);
  const at = buf.indexOf("NSString");
  if (at < 0) return null;
  let i = at + "NSString".length + 5;
  if (i >= buf.length) return null;
  let len = buf[i]!;
  if (len === 0x81) { len = buf.readUInt16LE(i + 1); i += 3; }
  else if (len === 0x82) { len = buf.readUInt32LE(i + 1); i += 5; }
  else i += 1;
  if (i + len > buf.length) return null;
  return buf.subarray(i, i + len).toString("utf8");
}

export const normHandle = (h: string): string => h.trim().toLowerCase().replace(/[\s()\-.]/g, "");

/** Verification codes never leave the machine: dropped before anything reads them. The shared
 * detector (lib/Boundary) keeps the old numeric rule whole and adds alphanumeric codes such as
 * `A7K2Q9` and `7KQ2-M9XZ` (ISA 20261015-boundary-primitives, C9). */
export const isVerificationCode = (text: string): boolean => sharedIsVerificationCode(text);
/** Short-code senders (banks, carriers, 2FA services) are machines, not people. */
export const isShortCode = (handle: string): boolean => /^\d{3,6}$/.test(normHandle(handle));

const clip = (t: string) => t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX)}…` : t;
/** Plain text of a row; U+FFFC is the placeholder Messages leaves where an attachment sat. */
export const messageText = (row: RawRow): string => (row.text?.trim() || decodeAttributedBody(row.body)?.trim() || "").replace(/￼/g, "").trim();

/** Filters every kept row passes, either direction: no tapbacks or system rows, no machines, no excluded handles, no codes. */
function passes(row: RawRow, text: string, opts: AdmitOptions): boolean {
  if (row.assoc !== 0 || row.item_type !== 0) return false; // tapbacks, edits, group events
  const from = row.handle ?? "";
  if (!row.is_from_me && !from) return false;
  if (from && (isShortCode(from) || opts.excludeHandles.some((h) => normHandle(h) === normHandle(from)))) return false;
  return !(text && isVerificationCode(text));
}

/** A thread-context line for either direction; null for rows context should never carry. */
export function threadEntry(row: RawRow, opts: AdmitOptions): ThreadEntry | null {
  const text = messageText(row);
  if (!passes(row, text, opts) || (!text && !row.att)) return null;
  return { rowid: row.rowid, at: appleDate(row.date), fromMe: row.is_from_me === 1, from: row.is_from_me ? "me" : row.handle!, text: clip(text || "[attachment]") };
}

/** Keeps inbound messages from people; returns null for everything else. */
export function admit(row: RawRow, opts: AdmitOptions): TextMessage | null {
  if (row.is_from_me) return null;
  const text = messageText(row);
  if (!passes(row, text, opts) || (!text && !row.att)) return null;
  const from = row.handle!;
  const group = row.style === 43;
  return {
    rowid: row.rowid,
    guid: row.guid,
    at: appleDate(row.date),
    from,
    chat: group ? (row.chat_name || row.chat || "group") : "direct",
    chatId: row.chat ?? from,
    group,
    text: clip(text),
    attachments: row.att === 1,
  };
}

export function openReadOnly(path = CHAT_DB): Database {
  return new Database(path, { readonly: true });
}

export function maxRowId(db: Database): number {
  return (db.query("SELECT COALESCE(MAX(ROWID), 0) AS m FROM message").get() as { m: number }).m;
}

const ROW_COLUMNS = `m.ROWID AS rowid, m.guid AS guid, m.date AS date, m.is_from_me AS is_from_me,
           m.text AS text, m.attributedBody AS body,
           COALESCE(m.associated_message_type, 0) AS assoc, COALESCE(m.item_type, 0) AS item_type,
           COALESCE(m.cache_has_attachments, 0) AS att,
           h.id AS handle, c.chat_identifier AS chat, c.display_name AS chat_name, c.style AS style`;

/** Rows after `cursor`, oldest first, one row per message even when it joins several chats. */
export function rowsAfter(db: Database, cursor: number, limit = 500): RawRow[] {
  return db.query(`
    SELECT ${ROW_COLUMNS}
    FROM message m
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    LEFT JOIN chat c ON c.ROWID = cmj.chat_id
    WHERE m.ROWID > ?
    GROUP BY m.ROWID
    ORDER BY m.ROWID
    LIMIT ?`).all(cursor, limit) as RawRow[];
}

/** The `n` chats with the most recent activity. One pass over the join table; used once, at backfill. */
export function recentChats(db: Database, n: number): ChatRef[] {
  return db.query(`
    SELECT c.ROWID AS rowid, c.chat_identifier AS id, c.display_name AS name, c.style AS style
    FROM chat c JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
    GROUP BY c.ROWID ORDER BY MAX(cmj.message_id) DESC LIMIT ?`).all(n) as ChatRef[];
}

/** The last `n` rows of one chat, oldest first. */
export function chatHistory(db: Database, chat: ChatRef, n: number): RawRow[] {
  return (db.query(`
    SELECT ${ROW_COLUMNS}
    FROM chat_message_join cmj
    JOIN message m ON m.ROWID = cmj.message_id
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    JOIN chat c ON c.ROWID = cmj.chat_id
    WHERE cmj.chat_id = ?
    ORDER BY m.ROWID DESC LIMIT ?`).all(chat.rowid, n) as RawRow[]).reverse();
}
