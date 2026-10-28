/**
 * DeliveredContext.ts — the one reader of what the principal actually texted (Tex ISA F19, ISC-233/234).
 *
 * The bridge's turn builder (LIFEOS/RELAY/bridge/thread.ts buildTurnPrompt) sends a text in one of three shapes:
 *
 *   view     `<chat>\n<view lines>\n</chat>\n<turn>\n<turn state>\n</turn>\n<request>`   (principal thread, F18)
 *   history  `## Delivered conversation context\n...\n## Current request\n<request>` (contacts, probes, no thread)
 *   bare     `<request>`                                                         (a resumed session)
 *
 * Every memory consumer (MemoryTurnStart, MemoryReviewer, SatisfactionCapture, PromptProcessing) reads a prompt
 * through readTextTurn, so the view or the history is never taken for the principal's words. Neither frame can be
 * forged from inside a message: view lines are flattened to one line each with every <chat>/<turn> tag defanged,
 * and history records are one JSON line each, so the FIRST boundary after the header is the real one and anything
 * after it is the request, even when the request quotes a marker.
 *
 * principalThreadDir prefers the marker the bridge writes when it opens the principal thread (thread.ts
 * writeActiveThreadMarker), because the bridge resolves once at startup and the shared resolver can pick another
 * prefix later. With no usable marker it falls back to the bridge's own resolver (thread.ts resolvePrincipalThread).
 * Either way the memory reviewer reads the log the bridge writes, without the phone number leaving this process.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { ConversationStore } from "../RELAY/bridge/conversation.ts";
import { THREAD_ROOT, readActiveThreadDir, resolvePrincipalThread, threadDir } from "../RELAY/bridge/thread.ts";

export type TextShape = "view" | "history" | "bare" | "unreadable";

export interface DeliveredTurn {
  /** What the principal sent this turn, byte for byte. Empty for an unreadable frame: nothing in it is theirs. */
  request: string;
  /** The message an explicit reply points at, as its text when it can be read, else "message N", or null. */
  replyTarget: string | null;
  /** Which frame carried the request. "bare" means no frame: the whole prompt is the request. */
  shape: TextShape;
}

export interface ReadOptions {
  /** Root a view's "Thread directory" must sit under before its zoom file is read. Defaults to the bridge's. */
  threadRoot?: string;
}

const HISTORY_HEADER = "## Delivered conversation context";
const HISTORY_MARKER = "\n## Current request\n";
const VIEW_OPEN = "<chat>\n";
/** The "\n" that ends "<chat>\n" (empty view) or the last view line, then the close and the turn's open. */
const VIEW_CLOSE = "\n</chat>\n<turn>\n";
const TURN_CLOSE = "\n</turn>\n";
const REPLY_CHARS = 2000;

/** The request, reply target and frame of any prompt; a prompt with no frame is returned whole as "bare". */
export function readTextTurn(text: string, options: ReadOptions = {}): DeliveredTurn {
  if (text.startsWith(VIEW_OPEN)) return readView(text, options.threadRoot ?? THREAD_ROOT);
  if (text.startsWith(HISTORY_HEADER)) return readHistory(text);
  return { request: text, replyTarget: null, shape: "bare" };
}

/** Just the principal's words: the request of a framed prompt, or the prompt itself. */
export function textRequest(text: string, options: ReadOptions = {}): string {
  return readTextTurn(text, options).request;
}

function unreadable(): DeliveredTurn { return { request: "", replyTarget: null, shape: "unreadable" }; }

function readHistory(text: string): DeliveredTurn {
  const at = text.indexOf(HISTORY_MARKER);
  if (at < 0) return unreadable();
  const raw = /^Explicit reply target: (.+)$/m.exec(text.slice(0, at))?.[1] ?? null;
  let replyTarget: string | null = raw;
  if (raw) {
    try {
      const j = JSON.parse(raw) as { text?: unknown };
      if (typeof j.text === "string") replyTarget = j.text;
    } catch { /* not JSON: the raw line is the best record of the target */ }
  }
  return { request: text.slice(at + HISTORY_MARKER.length), replyTarget, shape: "history" };
}

function readView(text: string, threadRoot: string): DeliveredTurn {
  const close = text.indexOf(VIEW_CLOSE, VIEW_OPEN.length - 1);
  if (close < 0) return unreadable();
  const turnStart = close + VIEW_CLOSE.length;
  const turnEnd = text.indexOf(TURN_CLOSE, turnStart - 1);
  if (turnEnd < 0) return unreadable();
  const turn = text.slice(turnStart, turnEnd);
  const request = text.slice(turnEnd + TURN_CLOSE.length);
  const reply = /^They replied to message (\d+): zoom it before answering\.$/m.exec(turn)?.[1];
  if (reply === undefined) return { request, replyTarget: null, shape: "view" };
  const dir = /^Thread directory: (.+) \(zoom files are in its zoom\/ folder\)$/m.exec(turn)?.[1];
  const replyTarget = (dir === undefined ? null : zoomedMessage(dir, Number(reply), threadRoot)) ?? `message ${reply}`;
  return { request, replyTarget, shape: "view" };
}

/** Message `id` whole from its zoom file, read only when the directory really sits under the thread root. */
function zoomedMessage(dir: string, id: number, threadRoot: string): string | null {
  if (!Number.isSafeInteger(id) || id < 0) return null;
  try {
    const real = realpathSync(dir);
    const root = realpathSync(threadRoot);
    if (!real.startsWith(root + sep)) return null;
    const candidate = join(real, "zoom", `${id}+1.txt`);
    if (!existsSync(candidate)) return null;
    // The final path is resolved too: a symlinked zoom/ folder or message file must not lead outside the thread
    // root. The read goes through the resolved path, which is confined to this thread's dir.
    const file = realpathSync(candidate);
    if (!file.startsWith(real + sep)) return null;
    // Zoom file: "message N · kind · date[ · re message R]\n\n<text>\n" (thread.ts messageZoom).
    const raw = readFileSync(file, "utf8");
    const body = raw.indexOf("\n\n");
    if (body < 0) return null;
    const message = raw.slice(body + 2).replace(/\n$/, "");
    return message.length > REPLY_CHARS ? `${message.slice(0, REPLY_CHARS)} …[truncated]` : message;
  } catch {
    return null; // an unreadable target degrades to its id, never to a failed turn
  }
}

/**
 * The principal thread's directory for an own-line sender, or null when no thread exists for it (a contact's text,
 * or a bridge that never opened one). The bridge's active-thread marker wins when it names this sender's thread and
 * its main/ exists (ISC-246). Otherwise it is the bridge's own resolver (resolvePrincipalThread: a prefix whose log
 * exists wins, the one with the most live transport records among them), so the reviewer and the bridge always pick
 * the same log. `store` defaults to the bridge's transport store, which this only reads.
 */
export function principalThreadDir(
  sender: string,
  root: string = THREAD_ROOT,
  store: { messages(sender: string, thread: string): unknown[] } = new ConversationStore(),
): string | null {
  if (!sender) return null;
  const marked = readActiveThreadDir(sender, root);
  if (marked !== null) return marked;
  const principal = resolvePrincipalThread([sender], store, root);
  if (!principal) return null;
  const dir = threadDir(principal.sender, principal.thread, root);
  return existsSync(join(dir, "main")) ? dir : null;
}
