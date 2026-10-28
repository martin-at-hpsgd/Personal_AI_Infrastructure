/**
 * transcript-tail.ts — the last complete lines of a transcript, read from a bounded tail.
 *
 * Prompt-time readers want only the recent end of a session (the last reply, the last few turns), but session
 * transcripts reach tens of MB (93 MB seen 2026-10-16), and reading them whole on every prompt held prompts for
 * seconds (native-unblock ISC-18). A missing or unreadable file reads as no lines.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

export function readTranscriptTail(path: string, maxBytes = TRANSCRIPT_TAIL_BYTES): string[] {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return []; }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, size - len + got);
      if (n <= 0) break;
      got += n;
    }
    const lines = buf.subarray(0, got).toString("utf8").split("\n");
    if (len < size) lines.shift(); // the first line was cut by the window
    return lines.filter((l) => l.trim().length > 0);
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}
