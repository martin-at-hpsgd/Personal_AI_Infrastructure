/**
 * previous-reply.ts — the end of the most recent assistant reply in a Claude Code transcript.
 *
 * Shared by the prompt router hook and the Stop-time judges (maintainer-side hooks; not in the public
 * release). It lives in hooks/lib so a shipped hook never imports a hook the release leaves out.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { redactForEngine } from "../../LIFEOS/ASSAY/Engine";
import { redact } from "../../LIFEOS/TOOLS/lib/Boundary";

/** How much of the transcript is ever read: its tail only, so a long session costs the same as a short one. */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
/** How much of the previous reply reaches the router; FrontDoor redacts and caps it again. */
export const PREVIOUS_REPLY_CHARS = 800;

/** The last `maxBytes` of a file as whole lines; the torn first line is dropped when the read starts mid-file. */
function readTail(path: string, maxBytes: number): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, size - length);
    const text = buf.subarray(0, read).toString("utf8");
    return size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { closeSync(fd); }
}

type TranscriptRow = { type?: unknown; isSidechain?: unknown; message?: { id?: unknown; content?: unknown } };
/** The text parts of a main-thread assistant row; [] for anything else (user rows, sidechains, tool-only rows). */
function assistantText(row: TranscriptRow): string[] {
  if (row.type !== "assistant" || row.isSidechain === true || !row.message || typeof row.message !== "object") return [];
  const content = row.message.content;
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content.filter((c): c is { type: "text"; text: string } => !!c && typeof c === "object" && (c as { type?: unknown }).type === "text" && typeof (c as { text?: unknown }).text === "string" && !!(c as { text: string }).text.trim()).map(c => c.text);
}

/**
 * The end of the most recent assistant reply in a Claude Code transcript, whitespace normalised,
 * redacted, last PREVIOUS_REPLY_CHARS kept. The harness writes one row per content block, so every
 * text row sharing the latest text-bearing message id is joined. Reads at most `maxBytes` from the
 * tail. Undefined when there is no such reply or anything fails: context is optional, a broken prompt is not.
 */
export function previousReplyFromTranscript(path: string, maxBytes = TRANSCRIPT_TAIL_BYTES): string | undefined {
  try {
    const rows: TranscriptRow[] = [];
    for (const line of readTail(path, maxBytes).split("\n")) {
      if (!line.trim()) continue;
      try { const row = JSON.parse(line); if (row && typeof row === "object") rows.push(row); } catch { /* a torn or foreign line carries no reply */ }
    }
    const parts: string[] = [];
    let messageId: unknown;
    for (let i = rows.length - 1; i >= 0; i--) {
      const texts = assistantText(rows[i]);
      if (!texts.length) continue;
      const id = rows[i].message?.id;
      if (!parts.length) { messageId = id; parts.unshift(...texts); if (typeof id !== "string") break; continue; }
      if (id !== messageId) break;
      parts.unshift(...texts);
    }
    if (!parts.length) return undefined;
    // Redact before cutting, so the cut can never leave half a secret that no longer matches its shape.
    // Boundary.redact first (labelled values, PINs, passphrases, secret shapes), then the engine pass for emails
    // and phones (ISA 20261015-boundary-primitives, probe 6).
    const text = redactForEngine(redact(parts.join(" ").replace(/\s+/g, " ").trim()), Number.POSITIVE_INFINITY);
    return text ? text.slice(-PREVIOUS_REPLY_CHARS) : undefined;
  } catch { return undefined; }
}
