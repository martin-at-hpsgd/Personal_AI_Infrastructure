/**
 * transcriptClass.ts — what a Claude Code transcript is (Tex ISA F19, ISC-237, ISC-238).
 *
 * A compaction call (compactor.ts firstTurn through inferenceSummarizer) and a principal text turn (thread.ts
 * prepareTurn) both open with the thread view as one `<chat>` block. What follows the FIRST `</chat>` tells their text
 * apart: a compaction's task header (compactor.ts LEAF_TASK_HEADER / MERGE_TASK_HEADER) or a text turn's `<turn>`
 * block. View lines have every frame tag defanged, so the first `</chat>` is the real close.
 *
 * Text alone is never enough to call a file a compaction, because anyone can paste a leafTask into a session and the
 * lister's output is what a deletion works from. A compaction is a headless one-shot call, so the file must also show
 * that provenance (measured on real compaction transcripts, 2026-10-10):
 *   - every row that names an entrypoint names "sdk-cli", and the user row does name it;
 *   - exactly one user row, and its content is one piece of text (no tool_result user rows);
 *   - no tool use anywhere: assistant content is only text and thinking;
 *   - the text starts with "<chat>\n" and the header follows the first "</chat>" after exactly the one "\n" firstTurn
 *     writes.
 * Every line is parsed as JSON (no substring prefilter). An unparseable line, an unknown content shape, or a read error
 * makes the file a conversation, so a consumer that hides compactions never hides a real session by mistake.
 *
 * The first user line can be megabytes of view, so the file is streamed line by line. A file whose first user text is
 * not compaction-shaped is decided there; a compaction-shaped one is read to the end to check its provenance.
 *
 * ContextSearch (recall) and ThreadCli `compaction-transcripts` (the lister) both decide through this one module.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { LEAF_TASK_HEADER, MERGE_TASK_HEADER } from "./compactor.ts";

export type TranscriptClass = "compaction-leaf" | "compaction-merge" | "text-turn" | "conversation" | "none";

const VIEW_OPEN = "<chat>\n";
const VIEW_CLOSE = "</chat>";
/** compactor.ts firstTurn joins the view and the task with exactly this. */
const TASK_SEPARATOR = "\n";
const TURN_OPEN = "<turn>";
const COMPACTION_ENTRYPOINT = "sdk-cli";
/** Assistant content parts a compaction reply may hold. Anything else (tool_use included) is not a compaction. */
const REPLY_PARTS = new Set(["text", "thinking", "redacted_thinking"]);
const CHUNK = 1 << 20;

/** True for either compaction class. */
export function isCompaction(cls: TranscriptClass): boolean {
  return cls === "compaction-leaf" || cls === "compaction-merge";
}

/**
 * The class a first user message's text claims, from what follows its first `</chat>`. This is the text test only: a
 * compaction class here is a candidate that classifyTranscript still checks for provenance.
 */
export function classifyFirstUserText(text: string): TranscriptClass {
  if (!text.startsWith(VIEW_OPEN)) return "conversation";
  const close = text.indexOf(VIEW_CLOSE);
  if (close < 0) return "conversation";
  const after = text.slice(close + VIEW_CLOSE.length);
  if (after.startsWith(TASK_SEPARATOR + LEAF_TASK_HEADER)) return "compaction-leaf";
  if (after.startsWith(TASK_SEPARATOR + MERGE_TASK_HEADER)) return "compaction-merge";
  // A text turn's frame (thread.ts prepareTurn) joins view and <turn> with one "\n" too; it is never hidden.
  if (after.replace(/^\n/, "").startsWith(TURN_OPEN)) return "text-turn";
  return "conversation";
}

/** The lines of a file, streamed; a final line with no newline is yielded too. Read errors propagate. */
function* fileLines(path: string): Generator<string> {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(CHUNK);
    let pending: Buffer[] = [];
    let position = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, position);
      if (n === 0) break;
      position += n;
      let start = 0;
      for (let nl = buf.indexOf(10, start); nl >= 0 && nl < n; nl = buf.indexOf(10, start)) {
        pending.push(Buffer.from(buf.subarray(start, nl)));
        yield Buffer.concat(pending).toString("utf8");
        pending = [];
        start = nl + 1;
      }
      if (start < n) pending.push(Buffer.from(buf.subarray(start, n)));
    }
    if (pending.length > 0) yield Buffer.concat(pending).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

type Row = { type?: unknown; entrypoint?: unknown; message?: { content?: unknown } };

/** A parsed row, or null for a line that is not a JSON object. */
function parseRow(line: string): Row | null {
  try {
    const row: unknown = JSON.parse(line);
    return typeof row === "object" && row !== null && !Array.isArray(row) ? (row as Row) : null;
  } catch {
    return null;
  }
}

/**
 * A user row's text, or null when its content is not text: a string, or an array of text parts only (joined with a
 * space, as recall reads them). `single` is true when the content is one piece of text.
 */
function userText(row: Row): { text: string; single: boolean } | null {
  const content = row.message?.content;
  if (typeof content === "string") return { text: content, single: true };
  if (!Array.isArray(content) || content.length === 0) return null;
  const texts: string[] = [];
  for (const part of content as Array<{ type?: unknown; text?: unknown } | null>) {
    if (part?.type !== "text" || typeof part.text !== "string") return null;
    texts.push(part.text);
  }
  return { text: texts.join(" "), single: texts.length === 1 };
}

/** Whether an assistant row holds only reply parts (no tool use, no unknown shape). */
function plainReply(row: Row): boolean {
  const content = row.message?.content;
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return (content as Array<{ type?: unknown } | null>).every(part => typeof part?.type === "string" && REPLY_PARTS.has(part.type));
}

/**
 * A transcript's class. A compaction class needs both the compaction text and compaction provenance; a file that
 * claims the text without the provenance is a conversation. Unreadable or unparseable files are conversations, and a
 * file with no user row at all (and nothing unreadable) is "none".
 */
export function classifyTranscript(path: string): TranscriptClass {
  try {
    let candidate: TranscriptClass | undefined;
    // A row naming another entrypoint means this is not a headless call. The first user row's text still decides
    // text-turn vs conversation (neither is ever hidden); it only rules out a compaction.
    let foreign = false;
    for (const line of fileLines(path)) {
      if (line.trim() === "") continue;
      const row = parseRow(line);
      if (row === null) return "conversation";
      if (row.entrypoint !== undefined && row.entrypoint !== COMPACTION_ENTRYPOINT) {
        if (candidate !== undefined) return "conversation";
        foreign = true;
      }
      if (row.type === "user") {
        if (candidate !== undefined) return "conversation"; // a second user row: not a one-shot compaction
        const user = userText(row);
        if (user === null) return "conversation";
        const cls = classifyFirstUserText(user.text);
        if (!isCompaction(cls)) return cls;
        if (foreign || row.entrypoint !== COMPACTION_ENTRYPOINT || !user.single) return "conversation";
        candidate = cls;
        continue;
      }
      if (row.type === "assistant" && !plainReply(row)) return "conversation";
    }
    return candidate ?? "none";
  } catch {
    return "conversation";
  }
}
