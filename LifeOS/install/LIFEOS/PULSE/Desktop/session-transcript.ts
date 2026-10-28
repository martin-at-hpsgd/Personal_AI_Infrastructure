// Main-process only: reads Claude Code transcripts from disk. The renderer
// bundle (workspace.ts, built with target:'browser') must never import this
// file; its browser-safe half lives in session-runtime.ts.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getClaudeDir } from "../../TOOLS/Paths";

/** The last `bytes` of a file, read without loading the rest of it. */
function readTail(path: string, size: number, bytes: number): string {
  const length = Math.min(size, bytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8", 0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * Pulse maps each Claude session to its terminal. Its transcript is the source
 * of truth for the served carrier, including real drift from the configured
 * default. This is deliberately a bounded tail read: cards refresh often.
 */
export function claudeModelForTerminal(terminalId: string, claudeDir = getClaudeDir()): string | null {
  try {
    const mappings = join(claudeDir, "LIFEOS", "MEMORY", "STATE", "pulse-sessions");
    const mapping = readdirSync(mappings).find((file) => {
      if (!file.endsWith(".json")) return false;
      try { return JSON.parse(readFileSync(join(mappings, file), "utf8")).terminalId === terminalId; } catch { return false; }
    });
    if (!mapping) return null;
    const sessionId = basename(mapping, ".json");
    const projects = join(claudeDir, "projects");
    for (const project of readdirSync(projects, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const transcript = join(projects, project.name, `${sessionId}.jsonl`);
      if (!existsSync(transcript)) continue;
      const size = statSync(transcript).size;
      const text = readTail(transcript, size, 256 * 1024);
      for (const line of text.split("\n").reverse()) {
        try {
          const row = JSON.parse(line) as { isSidechain?: unknown; message?: { model?: unknown } };
          if (row.isSidechain !== true && typeof row.message?.model === "string" && row.message.model.trim()) return row.message.model.trim();
        } catch { /* the tail can start or end mid-record */ }
      }
    }
  } catch { /* cards remain available while session state is being created */ }
  return null;
}
