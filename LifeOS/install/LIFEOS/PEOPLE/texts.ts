/**
 * Texts - a person's recent iMessage/SMS lines, read from the Messages reader's
 * private state (threads.json + inbox.jsonl). People never opens chat.db: only
 * the reader binary holds Full Disk Access.
 * Concept: LIFEOS/DOCUMENTATION/People/PeopleSystem.md
 *
 * Text is shown only on the terminal. Any other channel (LIFEOS_NOTIFICATION_CHANNEL
 * set, as the iMessage bridge's sessions set it) answers people other than the
 * principal, so `texts` refuses there and `who` drops its `texts:` line.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { principalTimezone } from "../TOOLS/lib/Timezone";
import { phoneKey } from "./merge";

export type TextLine = { rowid: number; at: string; fromMe: boolean; from: string; text: string; chat?: string };
export type TextsResult = { ok: true; lines: TextLine[] } | { ok: false; reason: string };

const stateDir = () => process.env.MESSAGES_STATE_DIR || join(homedir(), ".local", "state", "lifeos", "messages");

/** True only on the principal's own terminal; every other channel may be answering someone else. */
export function onTerminal(): boolean {
  const ch = process.env.LIFEOS_NOTIFICATION_CHANNEL;
  return !ch || ch === "terminal";
}

/** A handle's comparison key: the country-aware phone key (merge.ts phoneKey), or a lowercased email. */
export function handleKey(h: string): string | null {
  const s = h.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("@")) return s;
  // Country context stays in the key: a last-ten-digits suffix would hand one person another country's texts.
  return phoneKey(s);
}

type ThreadEntry = { rowid: number; at: string; fromMe: boolean; from: string; text: string };
type Thread = { name: string | null; group: boolean; messages: ThreadEntry[] };
type InboxRow = { rowid: number; at: string; from: string; chatId: string; group: boolean; text: string };

/** Every text to or from someone holding one of `handles`, newest first. */
export function textsFor(handles: string[], limit = 20): TextsResult {
  const keys = new Set(handles.map(handleKey).filter((k): k is string => !!k));
  if (keys.size === 0) return { ok: false, reason: "no phone or email on this record" };
  const dir = stateDir();
  const threadsPath = join(dir, "threads.json");
  const inboxPath = join(dir, "inbox.jsonl");
  if (!existsSync(threadsPath) && !existsSync(inboxPath)) return { ok: false, reason: `no Messages state at ${dir}` };
  const hit = (h: string | null | undefined) => !!h && keys.has(handleKey(h) ?? "");
  const byRow = new Map<number, TextLine>();
  try {
    if (existsSync(threadsPath)) {
      const chats = (JSON.parse(readFileSync(threadsPath, "utf8")).chats ?? {}) as Record<string, Thread>;
      for (const [chatId, t] of Object.entries(chats)) {
        const direct = !t.group && hit(chatId);
        for (const m of t.messages ?? []) {
          // A direct chat with them: both directions. A group: only what they sent.
          if (direct || (t.group && !m.fromMe && hit(m.from))) {
            byRow.set(m.rowid, { ...m, ...(t.group ? { chat: t.name ?? "group" } : {}) });
          }
        }
      }
    }
    if (existsSync(inboxPath)) {
      for (const raw of readFileSync(inboxPath, "utf8").split("\n")) {
        if (!raw.trim()) continue;
        const r = JSON.parse(raw) as InboxRow;
        if (byRow.has(r.rowid) || !(hit(r.from) || (!r.group && hit(r.chatId)))) continue;
        byRow.set(r.rowid, { rowid: r.rowid, at: r.at, fromMe: false, from: r.from, text: r.text, ...(r.group ? { chat: "group" } : {}) });
      }
    }
  } catch (e) {
    return { ok: false, reason: `Messages state unreadable: ${String((e as Error)?.message ?? e).slice(0, 80)}` };
  }
  const lines = [...byRow.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.rowid - a.rowid));
  return { ok: true, lines: lines.slice(0, limit) };
}

/** `YYYY-MM-DD HH:mm` in the principal's current zone. */
export function stamp(iso: string, tz = principalTimezone()): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(iso)).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** The one `texts:` line `who` prints: count, latest time, the command. Never text. */
export function textsSummary(handles: string[], query: string): string {
  const r = textsFor(handles, Number.MAX_SAFE_INTEGER);
  if (!r.ok) return `  texts: unavailable (${r.reason})`;
  if (r.lines.length === 0) return "  texts: none in the Messages reader's window";
  return `  texts: ${r.lines.length}, latest ${stamp(r.lines[0]!.at)} ${principalTimezone()} | people texts "${query}"`;
}

export function renderTexts(name: string, lines: TextLine[]): string {
  const tz = principalTimezone();
  const out = [`${name} - ${lines.length} texts, newest first (${tz})`];
  for (const l of lines) {
    const who = l.fromMe ? "me" : "them";
    out.push(`  ${stamp(l.at, tz)} ${who}${l.chat ? ` [${l.chat}]` : ""}: ${l.text.replace(/\s+/g, " ").trim() || "(attachment)"}`);
  }
  return out.join("\n");
}
